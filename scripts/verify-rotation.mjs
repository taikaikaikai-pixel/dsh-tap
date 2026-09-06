#!/usr/bin/env node
/**
 * Offline regression for multi-key rotation (api-key mode only): mock gateway
 * keyed by the Authorization bearer token + the real plugin code, asserting
 *
 *   A. provider path (callAgentTool via makeSearchProvider):
 *      1. round-robin order across apiKeys (alpha→bravo→charlie→alpha…)
 *      2. 429 on the first-tried key → failover inside the SAME request
 *      3. failed key is skipped while cooling
 *      4. cooled key rejoins the rotation after keyCooldownMs
 *      5. dropped connection (network error) → failover + cooldown
 *      6. all keys failing → last candidate's response surfaced as-is (HTTP 429)
 *      7. single key → no rotation, 401 reported verbatim
 *      8. zero keys → legacy env ref still works
 *      9. oauth mode without a token store → single-candidate path, no rotation
 *   B. bridge chat path (real bridge via apply()):
 *      rotation order, 500 failover transparent to the caller (still 200 SSE),
 *      cooldown skip, rejoin after cooldown.
 *
 * Module state (keyCursor/keyCooldowns) is module-global, so the two parts
 * import index.js as DISTINCT instances (?case=…) to stay independent.
 *
 * Usage: node scripts/verify-rotation.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const COOLDOWN_MS = 500

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-rotation-test-'))

const KEYS = [
  { name: 'alpha', key: 'ck_alpha' },
  { name: 'bravo', key: 'ck_bravo' },
  { name: 'charlie', key: 'ck_charlie' },
]

// ---------------------------------------------------------------- mock gateway

/** token → 'ok' | 'status:NNN' | 'drop' (destroy the socket = network error). */
const behavior = new Map()
const arrivals = [] // {path, auth, at} in upstream-arrival order
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    arrivals.push({ path: req.url, auth: token, at: Date.now() })
    const b = behavior.get(token) ?? 'ok'
    if (b === 'drop') {
      req.socket.destroy()
      return
    }
    if (b.startsWith('status:')) {
      const status = Number(b.slice(7))
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 15000 + status, msg: `mock ${status}` }))
      return
    }
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end([
        'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"hi"}}]}',
        '',
        'data: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, results: [{ url: 'https://example.com' }] }))
    }
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
const auths = () => arrivals.map((a) => a.auth)

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
  const baseURL = `http://127.0.0.1:${upstreamPort}`

  // ============================================================== A. provider path
  console.log('\n[A] callAgentTool rotation (makeSearchProvider → withKeyRotation)')
  const modA = await import(`${pathToFileURL(join(ROOT, 'index.js')).href}?case=provider`)
  // Mutable settings bag: the provider reads it fresh on every call.
  const bag = {
    authMode: 'api-key',
    baseURL,
    apiKeys: KEYS,
    activeApiKey: undefined,
    apiKeyEnv: undefined,
    keyCooldownMs: COOLDOWN_MS,
  }
  const provider = modA.makeSearchProvider(() => bag)
  const search = () => provider.search({ query: 'q' })

  console.log('\n[A1] round-robin order')
  {
    arrivals.length = 0
    await search()
    await search()
    await search()
    await search()
    check('alpha→bravo→charlie→alpha',
      JSON.stringify(auths()) === JSON.stringify(['ck_alpha', 'ck_bravo', 'ck_charlie', 'ck_alpha']),
      JSON.stringify(auths()))
  }

  console.log('\n[A2] 429 on first-tried key → failover inside the same request')
  {
    behavior.set('ck_bravo', 'status:429')
    arrivals.length = 0
    const data = await search() // cursor at bravo: bravo 429 → charlie takes over
    check('request still succeeds', data?.sources?.length === 1, JSON.stringify(data))
    check('bravo hit once, charlie completed it',
      JSON.stringify(auths()) === JSON.stringify(['ck_bravo', 'ck_charlie']), JSON.stringify(auths()))
  }

  console.log('\n[A3] cooling key skipped while others are healthy')
  {
    arrivals.length = 0
    await search() // cursor at charlie; bravo cooling → not even tried
    check('only charlie called', JSON.stringify(auths()) === JSON.stringify(['ck_charlie']), JSON.stringify(auths()))
  }

  console.log('\n[A4] cooled key rejoins after keyCooldownMs')
  {
    behavior.set('ck_bravo', 'ok')
    await sleep(COOLDOWN_MS + 150)
    arrivals.length = 0
    await search()
    await search()
    await search()
    check('full rotation restored incl. bravo',
      JSON.stringify(auths()) === JSON.stringify(['ck_alpha', 'ck_bravo', 'ck_charlie']), JSON.stringify(auths()))
  }

  console.log('\n[A5] dropped connection → failover + cooldown')
  {
    behavior.set('ck_alpha', 'drop')
    arrivals.length = 0
    const data = await search() // cursor at alpha: socket dies → bravo completes
    check('request still succeeds', data?.sources?.length === 1, JSON.stringify(data))
    check('alpha dropped, bravo completed it',
      JSON.stringify(auths()) === JSON.stringify(['ck_alpha', 'ck_bravo']), JSON.stringify(auths()))
    arrivals.length = 0
    await search() // alpha now cooling → skipped
    check('dropped key skipped while cooling',
      JSON.stringify(auths()) === JSON.stringify(['ck_bravo']), JSON.stringify(auths()))
  }

  console.log('\n[A6] every key failing → last candidate surfaced as-is')
  {
    behavior.set('ck_alpha', 'status:429')
    behavior.set('ck_bravo', 'status:429')
    behavior.set('ck_charlie', 'status:429')
    await sleep(COOLDOWN_MS + 150) // clear alpha's cooldown: all three get tried
    arrivals.length = 0
    let err = null
    await search().catch((e) => { err = e })
    check('search rejects with the gateway status', err?.message.includes('HTTP 429') === true, err?.message)
    check('gateway code/msg embedded in the error', err?.message.includes('code 15429') === true, err?.message)
    check('each key tried exactly once',
      arrivals.length === 3 && new Set(auths()).size === 3, JSON.stringify(auths()))
  }

  console.log('\n[A7] single key → no rotation, 401 verbatim')
  {
    bag.apiKeys = [KEYS[0]]
    behavior.set('ck_alpha', 'status:401')
    behavior.set('ck_bravo', 'ok')
    behavior.set('ck_charlie', 'ok')
    arrivals.length = 0
    let err = null
    await search().catch((e) => { err = e })
    check('401 reported verbatim', err?.message.includes('HTTP 401') === true, err?.message)
    check('exactly one upstream attempt (no retry, no rotation)',
      arrivals.length === 1 && arrivals[0].auth === 'ck_alpha', JSON.stringify(auths()))
  }

  console.log('\n[A8] zero keys → legacy env ref')
  {
    bag.apiKeys = []
    bag.apiKeyEnv = 'CB_ROT_ENV'
    process.env.CB_ROT_ENV = 'ck_env_fallback'
    arrivals.length = 0
    const data = await search()
    check('request succeeds via env key', data?.sources?.length === 1, JSON.stringify(data))
    check('env key used', JSON.stringify(auths()) === JSON.stringify(['ck_env_fallback']), JSON.stringify(auths()))
    delete process.env.CB_ROT_ENV
  }

  console.log('\n[A9] oauth mode → single-candidate path, never rotated')
  {
    bag.authMode = 'oauth' // fresh DSH_HOME: no token store → no candidate
    arrivals.length = 0
    let err = null
    await search().catch((e) => { err = e })
    check('no usable credential reported', err?.message.includes('凭据不可用') === true, err?.message)
    check('no upstream attempt at all', arrivals.length === 0, JSON.stringify(auths()))
    bag.authMode = 'api-key'
  }

  // ============================================================== B. bridge chat path
  console.log('\n[B] bridge /v2/chat/completions rotation')
  behavior.clear()
  const modB = await import(`${pathToFileURL(join(ROOT, 'index.js')).href}?case=bridge`)
  const bridgePort = await freePort()
  const ctx = {
    inject: (_deps, cb) => cb({ webServer: { register() {} }, tools: { register: () => () => {} } }),
    web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
    on: () => {},
  }
  modB.apply(ctx, {
    baseURL,
    bridgePort,
    authMode: 'api-key',
    apiKeys: KEYS,
    keyCooldownMs: COOLDOWN_MS,
  })
  await sleep(200) // let the bridge bind
  const bridge = `http://127.0.0.1:${bridgePort}`
  const chat = async () => {
    const res = await fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [] }),
    })
    const text = await res.text() // read to END — completion, not first byte
    return { status: res.status, text }
  }

  console.log('\n[B1] round-robin order on the chat path')
  {
    arrivals.length = 0
    await chat()
    await chat()
    await chat()
    check('alpha→bravo→charlie',
      JSON.stringify(auths()) === JSON.stringify(['ck_alpha', 'ck_bravo', 'ck_charlie']), JSON.stringify(auths()))
  }

  console.log('\n[B2] 500 failover is transparent to the caller')
  {
    behavior.set('ck_alpha', 'status:500')
    arrivals.length = 0
    const r = await chat() // cursor at alpha: 500 → cooled → bravo completes
    check('caller still gets 200', r.status === 200, `got ${r.status}`)
    check('caller still gets the SSE stream', r.text.includes('data:') && r.text.includes('[DONE]'))
    check('alpha hit once, bravo completed it',
      JSON.stringify(auths()) === JSON.stringify(['ck_alpha', 'ck_bravo']), JSON.stringify(auths()))
  }

  console.log('\n[B3] cooling key skipped on the bridge too')
  {
    arrivals.length = 0
    const r = await chat()
    check('request succeeds', r.status === 200)
    check('only bravo called', JSON.stringify(auths()) === JSON.stringify(['ck_bravo']), JSON.stringify(auths()))
  }

  console.log('\n[B4] cooled key rejoins after keyCooldownMs')
  {
    behavior.set('ck_alpha', 'ok')
    await sleep(COOLDOWN_MS + 150)
    arrivals.length = 0
    await chat() // cursor at charlie
    await chat() // cursor back at alpha — must succeed again
    check('alpha rejoined the rotation',
      JSON.stringify(auths()) === JSON.stringify(['ck_charlie', 'ck_alpha']), JSON.stringify(auths()))
  }

  console.log(failures === 0 ? '\nall rotation checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`verify-rotation crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
