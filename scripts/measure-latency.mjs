#!/usr/bin/env node
/**
 * Latency measurement + error reproduction for 识图 (bridge aggregation) and
 * /agenttool search — item 2 tooling. Repeatable by construction: fixed
 * payloads, fixed iteration count, every iteration appended as JSONL.
 *
 * Paths measured:
 *   vision-aggregate : POST {bridge}/v2/chat/completions, stream absent, with
 *                      image content — the describe-image shape; the caller
 *                      waits for the FULL upstream stream (bridge aggregates).
 *   vision-stream    : same payload with stream:true — TTFB/total split
 *                      separates upstream generation time from bridge work.
 *   search           : makeSearchProvider().search() — the production
 *                      /agenttool/v1/search code path (credentials included).
 *   search-direct    : (mock mode) raw fetch to the gateway, bypassing the
 *                      provider — isolates provider-side overhead.
 *
 * Modes:
 *   --mock  (default) mock gateway + the real bridge on ephemeral ports.
 *           No credentials needed; quantifies bridge/provider overhead
 *           against a controlled upstream delay.
 *   --real  live gateway: search resolves the key from
 *           ~/.dsh/codebuddy-plugin.json; vision goes through the already
 *           running dsh bridge (--bridge-port, default 3901).
 *
 * Options: --iters N (20) · --out PATH (/tmp/codebuddy-latency.jsonl)
 *          --bridge-port N (3901) · --model ID · --query STR
 *          --upstream-delay MS (mock, 300) · --stream-drip MS (mock, 25)
 *
 * Records: {ts, mode, path, iter, ok, ms, ttfbMs?, bytesIn, status, err?}.
 * Summary (min/p50/p95/max per path) is printed and appended to the file.
 */

import { createServer } from 'node:http'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeMockCtx, disposeAll } from './lib/mock-ctx.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ------------------------------------------------------------------ args
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const MODE = args.includes('--real') ? 'real' : 'mock'
const ITERS = Number(opt('iters', 20))
const OUT = opt('out', '/tmp/codebuddy-latency.jsonl')
const BRIDGE_PORT = Number(opt('bridge-port', 3901))
const UPSTREAM_DELAY = Number(opt('upstream-delay', 300))
const STREAM_DRIP = Number(opt('stream-drip', 25))
const QUERY = opt('query', '腾讯 CodeBuddy 是什么')
const MODEL = opt('model', MODE === 'real' ? 'deepseek-v4-flash' : 'm1')

// 1x1 red PNG — valid image, tiny upload.
const RED_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const records = []
function record(rec) {
  records.push(rec)
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
}

// ------------------------------------------------------------------ mock gateway
function startMockGateway() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url.endsWith('/chat/completions')) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunks = ['a red ', 'dot on ', 'a white ', 'background.']
          let i = 0
          const drip = () => {
            if (i < chunks.length) {
              res.write(`data: {"id":"mock","choices":[{"index":0,"delta":{"content":${JSON.stringify(chunks[i++])}}}]}\n\n`)
              setTimeout(drip, STREAM_DRIP)
            } else {
              res.end('data: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\ndata: [DONE]\n\n')
            }
          }
          drip()
        }, UPSTREAM_DELAY)
        return
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, results: [{ url: 'https://example.com', title: 'x', snippet: 'y' }] }))
      }, UPSTREAM_DELAY)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

// ------------------------------------------------------------------ probes
function visionPayload(stream) {
  return {
    model: MODEL,
    ...(stream ? { stream: true } : {}),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in one short sentence.' },
          { type: 'image_url', image_url: { url: RED_PNG_DATA_URL } },
        ],
      },
    ],
  }
}

async function probeVision(bridgeBase, stream, iter) {
  const t0 = Date.now()
  let ttfbMs = null
  try {
    const res = await fetch(`${bridgeBase}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visionPayload(stream)),
    })
    ttfbMs = Date.now() - t0
    const text = await res.text()
    const ms = Date.now() - t0
    const ok = res.status === 200 && (stream ? text.includes('[DONE]') : text.includes('chat.completion'))
    record({
      ts: t0, mode: MODE, path: stream ? 'vision-stream' : 'vision-aggregate',
      iter, ok, ms, ttfbMs, bytesIn: text.length, status: res.status,
      ...(ok ? {} : { err: text.slice(0, 300) }),
    })
  } catch (err) {
    record({ ts: t0, mode: MODE, path: stream ? 'vision-stream' : 'vision-aggregate', iter, ok: false, ms: Date.now() - t0, err: String(err?.message ?? err) })
  }
}

async function probeSearch(searchFn, iter, path = 'search') {
  const t0 = Date.now()
  try {
    const out = await searchFn()
    record({ ts: t0, mode: MODE, path, iter, ok: true, ms: Date.now() - t0, bytesIn: JSON.stringify(out).length, status: 200 })
  } catch (err) {
    // The error text IS the evidence: keep it verbatim (gateway code/msg or
    // the network-layer cause chain).
    record({ ts: t0, mode: MODE, path, iter, ok: false, ms: Date.now() - t0, err: String(err?.message ?? err) })
  }
}

// ------------------------------------------------------------------ stats
function summarize(pathFilter) {
  const rows = records.filter((r) => r.path === pathFilter)
  const oks = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
  const fails = rows.filter((r) => !r.ok)
  const pct = (p) => (oks.length ? oks[Math.min(oks.length - 1, Math.floor((p / 100) * oks.length))] : null)
  const ttfbs = rows.filter((r) => r.ok && r.ttfbMs != null).map((r) => r.ttfbMs).sort((a, b) => a - b)
  const line = {
    kind: 'summary', mode: MODE, path: pathFilter, n: rows.length, failed: fails.length,
    min: oks[0] ?? null, p50: pct(50), p95: pct(95), max: oks[oks.length - 1] ?? null,
    ttfbP50: ttfbs.length ? ttfbs[Math.floor(ttfbs.length / 2)] : null,
  }
  appendFileSync(OUT, JSON.stringify(line) + '\n')
  console.log(`  ${pathFilter.padEnd(18)} n=${String(line.n).padStart(3)} fail=${line.failed} min=${line.min} p50=${line.p50} p95=${line.p95} max=${line.max}${line.ttfbP50 != null ? ` ttfbP50=${line.ttfbP50}` : ''}`)
  for (const f of fails.slice(0, 5)) console.log(`    fail#${f.iter} ${f.ms}ms :: ${f.err}`)
}

// ------------------------------------------------------------------ main
async function main() {
  // Env must be set BEFORE importing index.js — it captures DSH_HOME at
  // module load (verify-bridge.mjs does the same).
  if (MODE === 'mock') {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-latency-'))
    process.env.CODEBUDDY_API_KEY = 'ck_latency_test_key'
  }
  const { apply, Config, makeSearchProvider } = await import(new URL('../index.js', import.meta.url).href)
  const AUTH_MODE_OVERRIDE = opt('auth-mode', null) // real mode: e.g. --auth-mode api-key

  if (MODE === 'mock') {
    const { server, port: gwPort } = await startMockGateway()
    const bridgePort = await freePort()
    const effects = []
    const ctx = makeMockCtx({ effects })
    apply(ctx, { baseURL: `http://127.0.0.1:${gwPort}`, bridgePort })
    await sleep(250)
    const bridgeBase = `http://127.0.0.1:${bridgePort}`
    const settings = () => Config({ baseURL: `http://127.0.0.1:${gwPort}` })
    const provider = makeSearchProvider(settings)

    console.log(`[mock] upstream delay ${UPSTREAM_DELAY}ms + drip ${STREAM_DRIP}ms/chunk, ${ITERS} iters per path`)
    for (let i = 0; i < ITERS; i++) {
      await probeVision(bridgeBase, false, i)
      await probeVision(bridgeBase, true, i)
      await probeSearch(() => provider.search({ query: QUERY }), i)
      await probeSearch(
        () => fetch(`http://127.0.0.1:${gwPort}/agenttool/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ck_latency_test_key' },
          body: JSON.stringify({ query: QUERY, type: 'text2text', max_results: 5 }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }),
        i,
        'search-direct',
      )
    }
    server.close()
    await disposeAll(effects) // apply() 的 teardown：关掉本进程起的桥
  } else {
    // real: vision through the running dsh bridge, search direct to gateway
    const settingsFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codebuddy-plugin.json')
    const settings = () => Config({
      ...JSON.parse(readFileSync(settingsFile, 'utf8')),
      ...(AUTH_MODE_OVERRIDE ? { authMode: AUTH_MODE_OVERRIDE } : {}),
    })
    const provider = makeSearchProvider(settings)
    const bridgeBase = `http://127.0.0.1:${BRIDGE_PORT}`
    console.log(`[real] bridge :${BRIDGE_PORT}, model ${MODEL}, ${ITERS} iters per path`)
    for (let i = 0; i < ITERS; i++) {
      await probeVision(bridgeBase, false, i)
      await probeVision(bridgeBase, true, i)
      await probeSearch(() => provider.search({ query: QUERY }), i)
    }
  }

  console.log('\nsummary (ms):')
  summarize('vision-aggregate')
  summarize('vision-stream')
  summarize('search')
  if (MODE === 'mock') summarize('search-direct')
  const totalFails = records.filter((r) => !r.ok).length
  console.log(`\n${records.length} records → ${OUT} (${totalFails} failures)`)
  process.exit(0)
}

main().catch((err) => {
  console.error(`measure-latency crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
