#!/usr/bin/env node
/**
 * Falsification test for the core/providers split (completion criterion 2):
 * a SECOND OpenAI-compatible upstream is wired up using ONLY core/
 * primitives plus a plain adapter object defined inline below. core/ is
 * imported but never modified; providers/codebuddy is NOT imported at all.
 *
 * Two proof surfaces:
 *
 *   S. Static purity: every core/*.js file is scanned for CodeBuddy-specific
 *      tokens (upstream hostnames, gateway error codes, vendor header names,
 *      provider names) and for imports of providers/* — any hit means
 *      provider specifics leaked into the shared layer.
 *
 *   R. Runtime generality: a mock OpenAI-compatible upstream + the inline
 *      `mock-openai` adapter are driven through core's bridge, rotation
 *      engine, and usage meter, asserting:
 *        1. non-streaming inbound → aggregated chat.completion JSON
 *        2. stream:true inbound → SSE passthrough
 *        3. session-attribution header injection (generic feature)
 *        4. multi-key rotation with 500 failover + cooldown skip
 *        5. usage metering works with plain OpenAI usage (no `credit`
 *           field → recorded as 0)
 *        6. developer-role messages pass through UNCHANGED — the
 *           developer→system rewrite is owned by the codebuddy adapter,
 *           not by core (verify-bridge.mjs §9 locks the other half)
 *        7. credential-file discipline: json-store writes land 0600, and
 *           resolveEnvKey parses credentials lines without building a
 *           RegExp from the settings-controlled name (no regex injection)
 *
 * Usage: node scripts/verify-core-generic.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KeyRotator } from '../core/rotation.js'
import { createUsageMeter } from '../core/usage-meter.js'
import { createBridge } from '../core/bridge.js'
import { resolveEnvKey } from '../core/json-store.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

// ------------------------------------------------------- S. core static purity
console.log('\n[S] core/ static purity')
{
  const coreDir = join(ROOT, 'core')
  const files = readdirSync(coreDir).filter((f) => f.endsWith('.js'))
  check('core/ has the expected four modules', files.length === 4, files.join(','))
  // Upstream/vendor specifics that must never appear in core/.
  const forbidden = /\bcodebuddy\b|copilot\.tencent|tencent|12403|14401|14407|11101|11102|11103|11128|11217|12153|10001|x-ide-|x-product-version|x-private-data|dsh-codebuddy-bridge/i
  for (const f of files) {
    const text = readFileSync(join(coreDir, f), 'utf8')
    const hit = text.match(forbidden)
    check(`core/${f} carries no provider-specific token`, !hit, hit?.[0])
    check(`core/${f} never imports providers/*`,
      !/from\s+['"][^'"]*providers\//.test(text) && !/import\s*\(\s*['"][^'"]*providers\//.test(text))
  }
}

// --------------------------------------- R. second-upstream runtime generality

// A minimal mock OpenAI-compatible upstream: speaks SSE, carries classic
// OpenAI usage (no vendor `credit` field), tok_1 fails 500 on demand.
const behavior = new Map() // token → 'ok' | 'status:NNN'
const arrivals = []
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* non-JSON */ }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    arrivals.push({ path: req.url, raw, parsed, token, sessionId: req.headers['session_id'] ?? null })
    const b = behavior.get(token) ?? 'ok'
    if (b.startsWith('status:')) {
      res.writeHead(Number(b.slice(7)), { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock ${b}` } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end([
      'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"hej "}}]}',
      '',
      'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"da"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
})

/**
 * The second upstream's adapter — everything core/ needs, nothing more.
 * Written here, inline, against the hook contract documented in
 * core/bridge.js: if core/ had hidden CodeBuddy coupling, this object could
 * not drive it.
 */
const mockProvider = {
  id: 'mock-openai',
  logPrefix: '[mock-openai]',
  bridgeHeaders: () => ({ 'User-Agent': 'mock-openai-cli/1.0' }),
  // This upstream has no role restriction: passthrough. Proves the
  // developer→system rewrite lives in the codebuddy adapter, not in core.
  transformChatPayload: () => {},
  extractUsage: (chunk) => chunk.usage ?? null,
  extractStreamError: (chunk) => (chunk.error ? chunk : null),
  bridgeResponseId: 'mock-openai-stream-bridge',
  logHeaderNames: ['user-agent', 'content-type'],
  sentinelAuth: 'Bearer mock-sentinel',
  texts: { credentialUnavailable: 'mock-openai credential unavailable' },
}

async function main() {
  const upstreamPort = await freePort()
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r))
  const baseURL = `http://127.0.0.1:${upstreamPort}`

  const tmp = mkdtempSync(join(tmpdir(), 'core-generic-test-'))
  const meter = createUsageMeter({ path: join(tmp, 'usage.json') })
  // `let`: R4 swaps in a fresh rotator to pin the cursor deterministically.
  let rotator = new KeyRotator()
  const KEYS = [
    { name: 'k1', key: 'tok_1' },
    { name: 'k2', key: 'tok_2' },
  ]
  const withCredentials = (attempt) => {
    const emptyError = new Error('mock credential unavailable')
    emptyError.credentialUnavailable = true
    return rotator.run(rotator.ordered(KEYS), attempt, { cooldownMs: 400, emptyError })
  }

  const runtime = { running: false, port: null, lastError: null }
  const bridge = createBridge({
    settings: () => ({
      baseURL,
      sessionHeadersEnabled: true,
      sessionHeaderFormat: 'openai',
      maxConcurrentPerSession: 4,
    }),
    provider: mockProvider,
    withCredentials,
    meter,
    forensics: { logPath: () => undefined, dumpDir: () => undefined },
    runtime,
  })
  const bridgePort = await freePort()
  const stop = bridge.listen(bridgePort)
  await sleep(200)

  const chat = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  console.log('\n[R1] non-streaming inbound → aggregated chat.completion JSON')
  {
    const res = await chat({ model: 'm1', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const json = await res.json().catch(() => null)
    check('status 200 + chat.completion shape', res.status === 200 && json?.object === 'chat.completion')
    check('content aggregated', json?.choices?.[0]?.message?.content === 'hej da',
      JSON.stringify(json?.choices?.[0]?.message))
    check('response id comes from the adapter', json?.id === 'mock-openai-stream-bridge', json?.id)
  }

  console.log('\n[R2] stream:true inbound → SSE passthrough')
  {
    const res = await chat({ model: 'm1', stream: true, messages: [] })
    const text = await res.text()
    check('event-stream with [DONE]',
      (res.headers.get('content-type') ?? '').includes('text/event-stream') && text.includes('[DONE]'))
  }

  console.log('\n[R3] session-attribution headers injected (generic feature)')
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-X' })).text()
    check('session_id injected from X-Session-ID', arrivals[before]?.sessionId === 'sess-X',
      arrivals[before]?.sessionId)
  }

  console.log('\n[R4] rotation: 500 failover + cooldown skip')
  {
    // Fresh rotator → cursor pinned at tok_1, so the first attempt order is
    // deterministic regardless of how many requests ran above.
    rotator = new KeyRotator()
    behavior.set('tok_1', 'status:500')
    arrivals.length = 0
    const r = await chat({ model: 'm1', stream: true, messages: [] })
    await r.text()
    check('caller still gets 200 after tok_1 500', r.status === 200)
    check('tok_1 failed, tok_2 completed (failover inside one request)',
      JSON.stringify(arrivals.map((a) => a.token)) === JSON.stringify(['tok_1', 'tok_2']),
      JSON.stringify(arrivals.map((a) => a.token)))
    arrivals.length = 0
    const r2 = await chat({ model: 'm1', stream: true, messages: [] })
    await r2.text()
    check('cooling tok_1 skipped on the next request',
      arrivals.length === 1 && arrivals[0].token === 'tok_2', JSON.stringify(arrivals.map((a) => a.token)))
    behavior.delete('tok_1')
  }

  console.log('\n[R5] usage metering with plain OpenAI usage (no credit → 0)')
  {
    const v = meter.view()
    // R1(1) + R2(1) + R3(1) + R4(2) = 5 billed chat requests
    check('every chat request metered', v.totalRequests === 5, `got ${v.totalRequests}`)
    check('credit recorded as 0 when the upstream has no credit field', v.totalCredit === 0)
    check('tokens recorded', v.recent[0]?.prompt === 5 && v.recent[0]?.completion === 2,
      JSON.stringify(v.recent[0]))
  }

  console.log('\n[R6] developer role passes through UNCHANGED (rewrite is adapter-owned)')
  {
    const before = arrivals.length
    await (await chat({
      model: 'm1',
      stream: true,
      messages: [{ role: 'developer', content: 'be nice' }, { role: 'user', content: 'ping' }],
    })).text()
    const forwarded = arrivals[before]?.parsed
    check('developer role preserved verbatim for this upstream',
      forwarded?.messages?.[0]?.role === 'developer',
      JSON.stringify(forwarded?.messages?.map((m) => m.role)))
  }

  await stop()
  meter.dispose()
  await new Promise((r) => upstream.close(r))

  console.log('\n[R7] json-store: 0600 credential files + injection-free key resolution')
  {
    // [11]+[13]: these files carry tokens/keys — the usage store is flushed
    // through writeJson on dispose(), so the mode is observable here.
    const st = statSync(join(tmp, 'usage.json'))
    check('json-store file mode is 0600', (st.mode & 0o777) === 0o600,
      `mode ${(st.mode & 0o777).toString(8)}`)

    // [17]: the credentials file is parsed line-wise, never with a RegExp
    // built from envName (settings-controlled free text). Prefixed names so
    // a like-named process env var can never shadow the file values.
    const credPath = join(tmp, 'creds.yaml')
    writeFileSync(credPath, [
      '# dsh flat credentials file',
      'VCG_PLAIN: sk-plain-value',
      'VCG_QUOTED: "sk-quoted-value"',
      'VCG_OTHER: not-mine',
      '',
    ].join('\n'))
    check('plain name resolves its file value', resolveEnvKey('VCG_PLAIN', credPath) === 'sk-plain-value',
      String(resolveEnvKey('VCG_PLAIN', credPath)))
    check('double-quoted value is dequoted', resolveEnvKey('VCG_QUOTED', credPath) === 'sk-quoted-value')
    check('regex metachar name resolves null (no injection)',
      resolveEnvKey('.*)|(', credPath) === null)
    check('metachar name does NOT leak another line\'s value',
      resolveEnvKey('.*)|(', credPath) !== 'not-mine')
    check('absent name resolves null', resolveEnvKey('VCG_ABSENT', credPath) === null)
  }

  console.log(failures === 0
    ? '\ncore/ generality proven: second OpenAI-compatible upstream wired with zero core/ changes'
    : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`verify-core-generic crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
