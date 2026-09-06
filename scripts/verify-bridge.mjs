#!/usr/bin/env node
/**
 * Offline regression for the stream bridge (index.js): spins a mock gateway
 * plus the real bridge on loopback and asserts end-to-end behavior. Every
 * assertion waits for the response to FINISH (connection end), never just
 * the first byte — a queued request that hangs looks exactly like a slow
 * one until you demand completion.
 *
 * Covered:
 *   1. non-streaming inbound (stream:false / absent) → aggregated
 *      chat.completion JSON (the gateway is stream-only, error 11101)
 *   2. stream:true inbound → SSE passed through verbatim
 *   3. session-attribution headers: injected from the incoming session id,
 *      preserved when the caller already set one, absent otherwise
 *   4. per-session FIFO concurrency: excess requests queue and COMPLETE in
 *      waves (regression: release() once stranded the queue →永久挂起)
 *   5. no session id → no gating, all requests run concurrently
 *   6. non-chat paths (/agenttool/*) pass through untouched
 *   7. CODEBUDDY_BRIDGE_LOG forensics (hash-only in/out records)
 *   8. usage metering: every chat request's usage.credit is accumulated into
 *      codebuddy-plugin-usage.json and served via action:'usage'
 *   9. developer-role messages are rewritten to system on the way out
 *      (regression: gateway moderation content_filter on developer role)
 *  10. chunked multibyte integrity: a body split so chunk boundaries fall
 *      inside multibyte chars arrives byte-identical upstream
 *      (regression 踩坑 #28: per-chunk implicit utf8 decoding corrupted
 *      chars into 3×U+FFFD and drifted the outbound prefix every request)
 *  11. bridge listen EADDRINUSE degrades to a warning, never crashes
 *      (regression: an unhandled 'error' event took the whole process down)
 *  12. settings POST responses mask plaintext apiKeys (regression: four POST
 *      paths shipped the raw file layer — GET was masked in f9aeeaa, POST
 *      was not), and oauth-start rejects an upstream-poisoned authUrl
 *      before oauthPending activates (https + login-site-family gate;
 *      loopback mock pairs pass)
 *  13. loopback gates + input guards (audit [6][7][8][18][22][29]):
 *      bridge Host gate 403s non-loopback Host before proxying (loopback
 *      names still pass), the settings route is Host/Origin-guarded on GET
 *      as well as POST, trae-model-sync dbPath is path/extension-checked,
 *      __proto__-family model ids are rejected, and plaintext http
 *      baseURLs outside loopback fail validation without persisting
 *
 * Usage: node scripts/verify-bridge.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const UPSTREAM_LATENCY_MS = 250

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
process.env.CODEBUDDY_API_KEY = 'ck_bridge_test_key'
process.env.CODEBUDDY_BRIDGE_LOG = join(process.env.DSH_HOME, 'bridge-log.jsonl')

// ---------------------------------------------------------------- mock gateway

const arrivals = [] // {path, stream, headers, at} in upstream-arrival order
// [12] oauth-start 门禁用：auth/state 响应里的 authUrl（null → 回环默认值，
// 即通过门禁的正例；置为投毒值即负例）。
let oauthStateAuthUrl = null
const upstream = createServer((req, res) => {
  // OAuth 设备流第一步（安全审计回归锁 [12]）：authUrl 可投毒。
  if (req.url.startsWith('/v2/plugin/auth/state')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      code: 0,
      data: {
        state: 'st-verify',
        authUrl: oauthStateAuthUrl ?? `http://127.0.0.1:${upstream.address()?.port}/authorize`,
      },
    }))
    return
  }
  // Buffer 收集 + 一次解码：mock 自身不能带踩坑 #28 的缺陷，否则分片
  // 用例的损坏源是 mock 而不是被测桥，断言就测不到真东西。
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* non-JSON body */ }
    arrivals.push({
      path: req.url,
      raw,
      stream: parsed?.stream ?? null,
      sessionId: req.headers['session_id'] ?? null,
      clientRequestId: req.headers['x-client-request-id'] ?? null,
      affinity: req.headers['x-session-affinity'] ?? null,
      authorization: req.headers.authorization ?? null,
      at: Date.now(),
    })
    setTimeout(() => {
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end([
          'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"hello "}}]}',
          '',
          'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"world"}}]}',
          '',
          'data: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":3,"credit":0.01}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, results: [{ url: 'https://example.com' }] }))
      }
    }, UPSTREAM_LATENCY_MS)
  })
})

// ---------------------------------------------------------------- test harness

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ephemeral port: bind 0, read it, release. */
async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

async function main() {
  const upstreamPort = await freePort()
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r))
  const bridgePort = await freePort()

  const { apply } = await import(new URL('../index.js', import.meta.url).href)
  // Route registrations are captured so the settings route can be driven
  // in-process (the usage view is asserted through it, like the card does).
  const routes = {}
  const ctx = {
    inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes[r.path] = r.handler } } }),
    web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
    on: () => {},
  }
  apply(ctx, {
    baseURL: `http://127.0.0.1:${upstreamPort}`,
    bridgePort,
    maxConcurrentPerSession: 2,
  })
  await sleep(200) // let the bridge bind

  const bridge = `http://127.0.0.1:${bridgePort}`
  const setLimit = (n) =>
    writeFileSync(
      join(process.env.DSH_HOME, 'codebuddy-plugin.json'),
      JSON.stringify({ maxConcurrentPerSession: n }) + '\n',
    )
  const chat = (body, headers = {}) =>
    fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  /** Race a promise against a hard timeout; resolves 'TIMEOUT' instead of rejecting. */
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')])

  /** Drive a captured settings-route handler with a mock req/res pair. */
  const callRoute = (routesMap, body, headerOverrides = {}) => new Promise((resolve, reject) => {
    const handler = routesMap['/dsh-tap/settings']
    if (!handler) return reject(new Error('settings route not registered'))
    const req = new EventEmitter()
    req.method = body ? 'POST' : 'GET'
    // sameOrigin() gate: origin host must match the Host header.
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headerOverrides }
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(b) {
        let json = null
        try { json = JSON.parse(b) } catch { /* non-JSON */ }
        resolve({ status: this.status, json })
      },
    }
    handler(req, res)
    if (body) {
      // 真实 webServer 喂 Buffer 分片；设置路由已按踩坑 #28 改为
      // Buffer.concat 后一次解码，emit 字符串会令其直接抛错。
      const bytes = Buffer.from(JSON.stringify(body))
      req.emit('data', bytes.subarray(0, 5))
      req.emit('data', bytes.subarray(5))
      req.emit('end')
    }
  })

  // ---------------------------------------------------------- 1. aggregation
  console.log('\n[1] non-streaming inbound → aggregated chat.completion JSON')
  {
    const before = arrivals.length
    const res = await chat({ model: 'm1', stream: false, messages: [] })
    const text = await res.text() // reading to END proves the connection closed
    let json = null
    try { json = JSON.parse(text) } catch { /* SSE is not JSON */ }
    check('status 200', res.status === 200, `got ${res.status}`)
    check('response is a chat.completion, not SSE', json?.object === 'chat.completion', text.slice(0, 80))
    check('content aggregated from stream chunks', json?.choices?.[0]?.message?.content === 'hello world',
      JSON.stringify(json?.choices?.[0]?.message))
    check('finish_reason preserved', json?.choices?.[0]?.finish_reason === 'stop')
    check('upstream was forced to stream', arrivals[before]?.stream === true)
  }
  {
    const res = await chat({ model: 'm1', messages: [] }) // stream absent = OpenAI default false
    const json = await res.json().catch(() => null)
    check('stream absent also aggregates', json?.object === 'chat.completion')
  }

  // ---------------------------------------------------------- 2. SSE passthrough
  console.log('\n[2] stream:true inbound → SSE passed through')
  {
    const res = await chat({ model: 'm1', stream: true, messages: [] })
    const text = await res.text()
    check('content-type is event-stream', (res.headers.get('content-type') ?? '').includes('text/event-stream'))
    check('body is SSE with [DONE]', text.includes('data:') && text.includes('[DONE]'))
  }

  // ---------------------------------------------------------- 3. session headers
  console.log('\n[3] session-attribution headers')
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-A' })).text()
    const a = arrivals[before]
    check('injected from X-Session-ID', a?.sessionId === 'sess-A' && a?.clientRequestId === 'sess-A' && a?.affinity === 'sess-A',
      JSON.stringify({ s: a?.sessionId, c: a?.clientRequestId, a: a?.affinity }))
  }
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-B', session_id: 'caller-set' })).text()
    const a = arrivals[before]
    check('caller-set value wins per header (no overwrite, no drop)', a?.sessionId === 'caller-set', `got ${a?.sessionId}`)
    check('missing headers filled with the extracted id', a?.clientRequestId === 'sess-B' && a?.affinity === 'sess-B',
      JSON.stringify({ c: a?.clientRequestId, a: a?.affinity }))
  }
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] })).text()
    const a = arrivals[before]
    check('no session id → nothing injected', a?.sessionId === null && a?.clientRequestId === null)
    check('host-side credential, caller auth never forwarded', a?.authorization === 'Bearer ck_bridge_test_key',
      a?.authorization ?? 'none')
  }

  // ---------------------------------------------------------- 4. FIFO limiter
  console.log('\n[4] per-session concurrency: excess queues and COMPLETES in waves')
  {
    setLimit(2)
    arrivals.length = 0
    const t0 = Date.now()
    const mk = async (name) => {
      const res = await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-C' })
      await res.text() // completion, not first byte
      return { name, ms: Date.now() - t0 }
    }
    const results = await withTimeout(Promise.all([mk('R1'), mk('R2'), mk('R3'), mk('R4')]), 5000)
    check('all four requests COMPLETE (no stranded queue)', results !== 'TIMEOUT')
    if (results !== 'TIMEOUT') {
      const wave1 = results.filter((r) => r.ms < UPSTREAM_LATENCY_MS * 1.8).length
      const wave2 = results.filter((r) => r.ms >= UPSTREAM_LATENCY_MS * 1.8).length
      check('two waves of two', wave1 === 2 && wave2 === 2, JSON.stringify(results))
      check('upstream saw exactly four, all tagged sess-C',
        arrivals.length === 4 && arrivals.every((a) => a.sessionId === 'sess-C'))
    }
  }
  {
    // The exact historical deadlock: limit=1, second request hung forever.
    setLimit(1)
    const t0 = Date.now()
    const mk = async (name) => {
      const res = await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-D' })
      await res.text()
      return { name, ms: Date.now() - t0 }
    }
    const p1 = mk('R1')
    await sleep(50)
    const p2 = mk('R2')
    const r2 = await withTimeout(p2, 4000)
    check('limit=1: queued request completes after the first (deadlock regression)', r2 !== 'TIMEOUT')
    if (r2 !== 'TIMEOUT') {
      const r1 = await p1
      check('limit=1: strictly serialized', r2.ms > r1.ms && r2.ms >= UPSTREAM_LATENCY_MS * 1.8,
        JSON.stringify([r1, r2]))
    }
    setLimit(2)
  }

  // ---------------------------------------------------------- 5. no session id
  console.log('\n[5] no session id → no gating')
  {
    arrivals.length = 0
    const t0 = Date.now()
    const mk = async () => {
      const res = await chat({ model: 'm1', stream: true, messages: [] })
      await res.text()
      return Date.now() - t0
    }
    const times = await withTimeout(Promise.all([mk(), mk(), mk()]), 4000)
    check('three anonymous requests all complete concurrently',
      times !== 'TIMEOUT' && times.every((ms) => ms < UPSTREAM_LATENCY_MS * 1.8), JSON.stringify(times))
  }

  // ---------------------------------------------------------- 6. path passthrough
  console.log('\n[6] non-chat paths pass through untouched')
  {
    const before = arrivals.length
    const res = await fetch(`${bridge}/agenttool/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    const json = await res.json().catch(() => null)
    const a = arrivals[before]
    check('agenttool response verbatim', json?.code === 0 && json?.results?.[0]?.url === 'https://example.com')
    check('no session headers on non-chat paths', a?.sessionId === null && a?.clientRequestId === null)
    check('body bytes forwarded untouched', a?.raw === JSON.stringify({ query: 'x' }))
  }

  // ---------------------------------------------------------- 7. request forensics log
  console.log('\n[7] CODEBUDDY_BRIDGE_LOG forensics')
  {
    // A title-shaped payload must be classified by its prompt marker.
    const before = arrivals.length
    await (await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: 'Create a concise title for an AI coding-assistant session from the supplied human messages.' },
        { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"hi"}]' },
      ],
    }, { authorization: 'Bearer dsh-codebuddy-bridge' })).text()
    check('title-shaped request reached upstream', arrivals.length === before + 1)

    const records = (await import('node:fs')).readFileSync(process.env.CODEBUDDY_BRIDGE_LOG, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const ins = records.filter((r) => r.dir === 'in' && r.path === '/v2/chat/completions')
    const outs = records.filter((r) => r.dir === 'out')
    const inSeqs = new Set(records.filter((r) => r.dir === 'in').map((r) => r.seq))
    check('every chat request logged in+out', ins.length > 0
      && ins.every((r) => outs.some((o) => o.seq === r.seq))
      && outs.every((o) => inSeqs.has(o.seq)),
      `in=${ins.length} out=${outs.length}`)
    check('in records carry body hash + shape, no message text',
      ins.every((r) => r.chat?.bodySha && r.chat.msgsSha && !JSON.stringify(r).includes('hello world')))
    check('usage captured from the SSE stream',
      outs.some((r) => r.usage?.prompt_tokens === 3 && r.usage?.total_tokens === 5),
      JSON.stringify(outs[0]?.usage))
    const title = ins.find((r) => r.chat?.marker === 'session-title')
    check('title marker classified', Boolean(title))
    check('sentinel authorization classified, never logged verbatim',
      title?.hdr?.authorization === 'sentinel')
    check('session id logged with injected outbound headers',
      ins.some((r) => r.sessionIn === 'sess-C')
        && outs.some((r) => r.sessionOut?.session_id === 'sess-C'))
    check('non-chat path logged with raw body hash',
      records.some((r) => r.dir === 'in' && r.path === '/agenttool/v1/search' && r.bodySha))
  }

  // ---------------------------------------------------------- 8. usage metering
  console.log('\n[8] usage metering → action:usage')
  {
    // Chat requests so far: 2 aggregated + 14 SSE = 16, mock credit 0.01 each
    // (15 plain chat + 1 title from section 7).
    const res = await callRoute(routes, { action: 'usage' })
    check('usage action answers ok', res.status === 200 && res.json?.ok === true,
      `HTTP ${res.status}`)
    const u = res.json?.usage
    check('every billed chat request metered', u?.totalRequests === 16, `got ${u?.totalRequests}`)
    check('credit accumulated (16 × 0.01)', u?.totalCredit === 0.16, `got ${u?.totalCredit}`)
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    check('today bucket matches', u?.today?.day === day && u?.today?.requests === 16)
    check('recent rows newest-first, title kind classified',
      u?.recent?.length === 16 && u.recent[0]?.kind === 'title' && u.recent[0]?.credit === 0.01
        && u.recent[0]?.hit === 0 && u.recent[0]?.miss === 3,
      JSON.stringify(u?.recent?.[0]))
    check('turns gap-grouped into one row (all requests <45s apart)',
      u?.turns?.length === 1 && u.turns[0]?.requests === 16
        && u.turns[0]?.kinds?.includes('chat') && u.turns[0]?.kinds?.includes('title'),
      JSON.stringify(u?.turns))
    check('bridge state exposed in usage view',
      res.json?.bridge?.running === true && res.json?.bridge?.port === bridgePort
        && res.json?.bridge?.lastError === null)
    check('quota snapshot present (mock upstream → nulls, no throw)',
      typeof res.json?.quota?.fetchedAt === 'number')
    // Debounced persistence: the file appears within a few seconds.
    const { readFileSync, existsSync } = await import('node:fs')
    const usagePath = join(process.env.DSH_HOME, 'codebuddy-plugin-usage.json')
    let persisted = null
    for (let i = 0; i < 16 && !persisted; i++) {
      if (existsSync(usagePath)) {
        try { persisted = JSON.parse(readFileSync(usagePath, 'utf8')) } catch { /* mid-write */ }
      }
      if (!persisted) await sleep(500)
    }
    check('usage.json persisted with totals + day bucket + recent rows',
      persisted?.totalRequests === 16 && persisted?.days?.[day]?.requests === 16
        && Array.isArray(persisted?.recent) && persisted.recent.length === 16)
  }

  // --------------------------------------------- 9. developer-role rewrite
  // pi-ai serializes the system prompt as role "developer" for reasoning
  // models; since 2026-08-18 the gateway's moderation answers such payloads
  // with finish_reason=content_filter. The bridge rewrites developer→system.
  console.log('\n[9] developer-role messages rewrite to system upstream')
  {
    const before = arrivals.length
    const res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'developer', content: 'You are a test agent.' },
        { role: 'user', content: 'ping' },
      ],
    }, { authorization: 'Bearer dsh-codebuddy-bridge' })
    await res.text()
    const a = arrivals[before]
    const forwarded = JSON.parse(a?.raw ?? 'null')
    check('request reached upstream', Boolean(a))
    check('developer role rewritten to system',
      forwarded?.messages?.[0]?.role === 'system'
        && forwarded?.messages?.[0]?.content === 'You are a test agent.'
        && forwarded?.messages?.every((m) => m.role !== 'developer'),
      JSON.stringify(forwarded?.messages?.map((m) => m.role)))
  }

  // -------------------------------------- 10. chunked multibyte integrity
  // 踩坑 #28 回归锁：TCP 分片落在多字节中文字符中间时，逐分片隐式 utf8
  // 解码（旧 `rawBody += c`）会把它替换成 3×U+FFFD，出站前缀逐请求漂移，
  // 网关内容寻址缓存只能命中到损坏点（v4-flash"缓存命中率下降快"根因，
  // 证据链 docs/diagnosis-cache-decline.md）。fetch 无法控制分片边界，所以
  // 用原生 socket 把同一请求体按几种切法各写一遍，断言 mock 网关收到的
  // 字节与整块发送逐字节一致。
  console.log('\n[10] chunked multibyte body arrives intact')
  {
    const filler = '前缀稳定。'.repeat(400) // 3-byte chars × 400
    const body = JSON.stringify({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: filler },
        { role: 'user', content: `读取）这）些）中）文）括）号）并回答：${filler}` },
      ],
    })
    const writeChunked = (chunks) =>
      new Promise((resolve, reject) => {
        const sock = connect(bridgePort, '127.0.0.1', () => {
          sock.write('POST /v2/chat/completions HTTP/1.1\r\n')
          sock.write(`Host: 127.0.0.1:${bridgePort}\r\n`)
          sock.write('Content-Type: application/json\r\n')
          sock.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`)
          sock.write('Connection: close\r\n')
          sock.write('\r\n')
          for (const c of chunks) sock.write(c)
        })
        // Consume the response: without a 'data' listener the socket stays
        // paused, the FIN is never read, and 'close' never fires (the test
        // itself then hangs — not the bridge).
        sock.on('data', () => {})
        sock.on('error', reject)
        sock.on('close', () => resolve())
      })
    const bytes = Buffer.from(body)
    // 切点 1/2/5 故意落在多字节序列中间；最后一段留大块保证走多分片。
    const splitAt = [1, 2, 5, 1300, 7000, 12000]
    const chunks = []
    let prev = 0
    for (const at of splitAt) {
      chunks.push(bytes.subarray(prev, at))
      prev = at
    }
    chunks.push(bytes.subarray(prev))
    const before = arrivals.length
    await writeChunked(chunks)
    // 桥转发 + mock 网关 250ms 延迟后才会记录该请求
    for (let i = 0; i < 40 && arrivals.length < before + 1; i++) await sleep(100)
    const a = arrivals[before]
    check('chunked request reached upstream', Boolean(a))
    check('body bytes identical to whole-write (no U+FFFD, no drift)',
      a?.raw === body && !a?.raw.includes('\uFFFD'),
      `len ${a?.raw?.length} vs ${body.length}, FFFD count ${(a?.raw?.match(/\uFFFD/g) ?? []).length}`)
    check('multibyte chars all intact', (a?.raw.match(/）/g) ?? []).length === (body.match(/）/g) ?? []).length)
  }

  // ---------------------------------------------------------- 10. EADDRINUSE
  console.log('\n[11] bridge listen EADDRINUSE degrades, never crashes')
  {
    const squatter = createServer()
    await new Promise((r) => squatter.listen(0, '127.0.0.1', r))
    const occupiedPort = squatter.address().port
    // A second apply() on the occupied port stands in for the second dsh
    // process (bridgeRuntime is per-process module state; production runs one
    // plugin instance per process, so last-apply-wins is correct here).
    const routes2 = {}
    const ctx2 = {
      inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes2[r.path] = r.handler } } }),
      web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
      on: () => {},
    }
    apply(ctx2, { baseURL: `http://127.0.0.1:${upstreamPort}`, bridgePort: occupiedPort })
    await sleep(300)
    // Reaching this line at all is half the regression: the process survived.
    const res = await callRoute(routes2, { action: 'usage' })
    check('occupied port: process alive, route still answers', res.status === 200 && res.json?.ok === true)
    check('bridge state reports EADDRINUSE and not running',
      res.json?.bridge?.running === false && res.json?.bridge?.lastError === 'EADDRINUSE'
        && res.json?.bridge?.port === occupiedPort,
      JSON.stringify(res.json?.bridge))
    const stillUp = await withTimeout(chat({ model: 'm1', stream: true, messages: [] }).then((r) => r.text()), 3000)
    check('first bridge keeps serving afterwards', stillUp !== 'TIMEOUT' && stillUp.includes('[DONE]'))
    await new Promise((r) => squatter.close(r))
  }

  // ------------------------------------------- 12. POST masking + authUrl gate
  // 安全审计回归锁（两补丁）：
  //   a) index.js maskedUserLayer——四个 POST 响应（apiKeysAdd 走通用 patch、
  //      modelSetEnabled / modelSetLimits 走层叠重读；traeModelSetEnabled 同型，
  //      无 Trae 目录时不可驱动，形状与另两条层叠路径逐字相同）曾原样回传
  //      文件层——明文 apiKey 下发浏览器（GET 视图 f9aeeaa 已脱敏，POST 漏网）。
  //   b) providers/codebuddy/oauth.js assertSafeAuthUrl——上游投毒 authUrl
  //      （钓鱼域 / javascript: 串）在置位 oauthPending 之前响亮失败，
  //      oauthStatus 不外泄该 URL，组合根 oauth-start 回 502。
  console.log('\n[12] settings POST responses mask keys; oauth-start gates authUrl')
  {
    const PLAIN = 'ck_secret_plaintext_2f9b5678'
    const MASKED = 'ck_s…5678' // maskKey：首 4 … 尾 4

    // 12a. 通用 patch 路径（apiKeysAdd）
    let res = await callRoute(routes, { patch: { apiKeysAdd: { name: 'verify-mask', key: PLAIN } } })
    const added = Array.isArray(res.json?.user?.apiKeys)
      && res.json.user.apiKeys.find((k) => k?.name === 'verify-mask')
    check('apiKeysAdd response ships masked key only',
      res.json?.ok === true && added?.key === MASKED, JSON.stringify(added))
    check('plaintext key absent from entire POST response', !JSON.stringify(res.json).includes(PLAIN))

    // 12b. modelSetEnabled 层叠路径
    res = await callRoute(routes, { patch: { modelSetEnabled: { id: 'deepseek-v3', enabled: false } } })
    check('modelSetEnabled response ships masked key only',
      res.json?.ok === true
        && res.json?.user?.apiKeys?.some((k) => k?.name === 'verify-mask' && k?.key === MASKED)
        && !JSON.stringify(res.json).includes(PLAIN),
      JSON.stringify(res.json?.user?.apiKeys))

    // 12c. modelSetLimits 层叠路径
    res = await callRoute(routes, { patch: { modelSetLimits: { id: 'deepseek-v3', contextWindow: 65536 } } })
    check('modelSetLimits response ships masked key only',
      res.json?.ok === true
        && res.json?.user?.apiKeys?.some((k) => k?.name === 'verify-mask' && k?.key === MASKED)
        && !JSON.stringify(res.json).includes(PLAIN))

    // 12d. oauth-start：上游投毒 authUrl（https 但钓鱼域）→ 502，pending 不激活
    oauthStateAuthUrl = 'https://evil.example.com/authorize'
    res = await callRoute(routes, { action: 'oauth-start' })
    check('poisoned authUrl (foreign host) rejected with 502 + reason',
      res.status === 502 && res.json?.ok === false
        && /evil\.example\.com/.test(res.json?.error ?? ''),
      `HTTP ${res.status} ${JSON.stringify(res.json)}`)
    res = await callRoute(routes, { action: 'oauth-status' })
    check('rejected start leaves no pending authUrl leak',
      res.json?.oauth?.pending === false && res.json?.oauth?.authUrl === ''
        && !JSON.stringify(res.json).includes('evil.example.com'))

    // 12e. oauth-start：javascript: 串（scheme 门）
    oauthStateAuthUrl = 'javascript:alert(document.domain)'
    res = await callRoute(routes, { action: 'oauth-start' })
    check('javascript: authUrl rejected (scheme gate)',
      res.status === 502 && /https/.test(res.json?.error ?? ''),
      `HTTP ${res.status} ${JSON.stringify(res.json)}`)

    // 12f. 正例：回环对（mock baseURL 与 authUrl 同为 127.0.0.1）放行
    oauthStateAuthUrl = null
    res = await callRoute(routes, { action: 'oauth-start' })
    check('loopback pair passes the gate (200 + authUrl)',
      res.status === 200 && res.json?.ok === true
        && /^http:\/\/127\.0\.0\.1:\d+\/authorize$/.test(res.json?.authUrl ?? ''),
      `HTTP ${res.status} ${res.json?.authUrl}`)
  }

  // ---------------------------------------------- 13. loopback gates + guards
  // 安全审计回归锁（[6][7][8][18][22][29]）：
  //   a) core/bridge.js Host 门——桥携带活凭据，非回环 Host（DNS rebinding/
  //      伪造）在读 body/转发之前 403；回环名（localhost）照常代理。
  //   b) index.js settings 路由本地门——GET（[7]：此前完全裸奔）与 POST 都
  //      先过回环 Host + Origin 一致判定。
  //   c) trae-model-sync dbPath 纵深防御、modelSetEnabled 原型键黑名单、
  //      validateBaseURL 明文 http 仅限回环（拒绝不落盘）。
  console.log('\n[13] loopback Host gates + input guards')
  {
    // 13a. bridge：伪造 Host 拒绝（fetch 不允许自定义 Host 头，走原生 socket）
    const rawRequest = (hostLine) => new Promise((resolve, reject) => {
      const sock = connect(bridgePort, '127.0.0.1', () => {
        sock.write(`GET /v2/models HTTP/1.1\r\n${hostLine}Connection: close\r\n\r\n`)
      })
      let head = ''
      sock.on('data', (d) => { head += d.toString('utf8') })
      sock.on('error', reject)
      sock.on('close', () => resolve(head))
    })
    const arrivalsBefore = arrivals.length
    const evil = await rawRequest('Host: evil.example.com\r\n')
    check('bridge refuses non-loopback Host with 403',
      /HTTP\/1\.1 403/.test(evil), evil.split('\r\n')[0] || '(no response)')
    check('refused request never proxied upstream', arrivals.length === arrivalsBefore,
      `arrivals ${arrivalsBefore} → ${arrivals.length}`)
    const ok = await rawRequest(`Host: localhost:${bridgePort}\r\n`)
    check('loopback Host (localhost) still proxied',
      /HTTP\/1\.1 200/.test(ok), ok.split('\r\n')[0] || '(no response)')

    // 13b. settings 路由：GET 与 POST 一体设防
    let res = await callRoute(routes, null, { host: '192.168.1.5:3080' })
    check('settings GET with LAN Host → 403', res.status === 403, `HTTP ${res.status}`)
    res = await callRoute(routes, null, { host: 'attacker.example:3080' })
    check('settings GET with rebinding Host → 403', res.status === 403, `HTTP ${res.status}`)
    res = await callRoute(routes, null, { origin: 'http://evil.example:3080' })
    check('settings with cross-site Origin → 403', res.status === 403, `HTTP ${res.status}`)
    res = await callRoute(routes, null)
    check('loopback GET still answers 200', res.status === 200 && res.json?.value != null,
      `HTTP ${res.status}`)

    // 13c. 输入门：dbPath 路径防御
    res = await callRoute(routes, { action: 'trae-model-sync', dbPath: '../../etc/passwd' })
    check('trae-model-sync relative dbPath → 400 + reason',
      res.status === 400 && /dbPath/.test(res.json?.error ?? ''), JSON.stringify(res.json))
    res = await callRoute(routes, { action: 'trae-model-sync', dbPath: '/tmp/secret.txt' })
    check('trae-model-sync non-.db/.vscdb extension → 400', res.status === 400, `HTTP ${res.status}`)
    res = await callRoute(routes, { action: 'trae-model-sync', dbPath: '/tmp/no-such-state.vscdb' })
    check('valid-shaped dbPath falls through to the normal sync error path',
      res.status === 200 && res.json?.ok === false, `HTTP ${res.status} ok=${res.json?.ok}`)

    // 13c. 原型污染键与明文 http baseURL
    res = await callRoute(routes, { patch: { modelSetEnabled: { id: '__proto__', enabled: true, profile: {} } } })
    check('modelSetEnabled rejects __proto__ id → 400', res.status === 400, `HTTP ${res.status}`)
    res = await callRoute(routes, { patch: { modelSetEnabled: { id: 'x.constructor', enabled: true, profile: {} } } })
    check('modelSetEnabled rejects prototype-segment id → 400', res.status === 400, `HTTP ${res.status}`)
    res = await callRoute(routes, { patch: { baseURL: 'http://attacker.example/v2' } })
    check('plaintext http to non-loopback baseURL → 400 (validateBaseURL)',
      res.status === 400 && /回环/.test(res.json?.error ?? ''), JSON.stringify(res.json))
    res = await callRoute(routes, null)
    check('rejected patches persisted nothing (baseURL unchanged)',
      res.json?.value?.baseURL === `http://127.0.0.1:${upstreamPort}`, res.json?.value?.baseURL)
  }

  console.log(failures === 0 ? '\nall bridge checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`verify-bridge crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
