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
 *  14. G8 per-model reasoning_effort injection (effortByModel level → wire
 *      value; caller-set wins, off/table-less/unknown inject nothing)
 *  15. cancellation & guardrails: mid-stream client disconnect aborts the
 *      upstream fetch; a queued waiter whose caller hung up never fires
 *      upstream and the aborted holder's slot is really released; bodies
 *      past 32MB get a real 413 JSON (was: silent req.destroy); aggregated
 *      non-streaming responses carry the captured usage (was: always {});
 *      a silent upstream fails fast with 502 + first-byte reason
 *      (upstreamFirstByteTimeoutMs, symmetric with the trae gateway)
 *  16. OAuth state machine: logout() terminates an in-flight poll
 *      (generation guard — a post-logout authorization never signs back
 *      in; uninterrupted poll still completes); a failed refresh and an
 *      expired refreshExpiresAt both surface needsRelogin in oauthStatus
 *  18. outbound tool pairing + visibility normalization
 *      (providers/tool-pairing.js invariants now also on the CodeBuddy
 *      bridge, 踩坑 #63 / #39 / #41): orphan tool messages get an
 *      assistant stub, content:null / missing-key messages become '',
 *      a well-formed history is byte-identical (no-op), and the
 *      developer→system rewrite + reasoning_effort injection still fire
 *      in the same request
 *  19. protocol surfaces mounted on the bridge (CodeBuddy is the DEFAULT
 *      channel — the local-client protocols must not be Trae/Qoder-only):
 *      POST /v1/messages + /v1/responses are answered by the protocol
 *      surfaces through the bridge's own internal chat face (translated
 *      payload on the bridge chat path, session affinity carried over),
 *      streaming event sequences for both faces, non-streaming protocol
 *      JSON aggregation, the bridge Host/Origin gates and the 413 body
 *      ceiling covering the new faces, and byte-identical passthrough on
 *      the existing /v2/chat/completions route (surfaces declined)
 *  20. harness-identity neutralization in system prompts (2026-10-21
 *      gateway content-fingerprint gate, same code 11128 as the developer
 *      role gate but a distinct surface — HTTP 400 + displayMsg/displayTips/
 *      actions): the bridge rewrites the DSH kernel's fixed identity opener
 *      `You are an AI agent powered by DeepSeek Harness.` → `...assistant...`
 *      in system messages on the way out (semantically equivalent, community-
 *      tested 400→200); non-matching system content is byte-identical, and
 *      the existing developer→system rewrite still fires in the same request
 *
 * Usage: node scripts/verify-bridge.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge } from '../core/bridge.js'
import { createProtocolSurfaces } from '../providers/protocols/index.js'
import { invokeInternalChat } from '../providers/protocols/chat-capture.js'
import { makeMockCtx, disposeAll } from './lib/mock-ctx.mjs'

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
// [15] 取消传播用：model 'hang' = 永远不出响应头（首字节超时/排队 waiter 用
// 例）；model 'drip' = 发一块后沉默（流式中途断连用例）。两者记录桥何时
// 丢弃上游连接（res close 且 writableEnded=false = 对端中止，不是正常完成）。
const hangCloses = []
// [16] OAuth 状态机用：token 轮询在 pending（11217）与 success（发令牌）间
// 切换，refresh 在 ok 与 fail（401+12153，对齐 bogus refresh 实测）间切换。
let oauthTokenMode = 'pending'
let oauthRefreshMode = 'ok'
// [17] 目录思考强度声明：'off' = /v3/config 500（启动同步失败，静态兜底——
// 与前面各节的既有前提一致）；'on' = 发目录 fixture（含新形态 supportedEfforts
// 与 legacy 形态各一条，用于锁定档位表的来源与优先级）。
let catalogMode = 'off'
const CATALOG_FIXTURE = {
  models: [
    {
      id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', maxInputTokens: 1000000, maxOutputTokens: 32000, supportsImages: true,
      reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] },
    },
    {
      id: 'hy4-preview', name: 'Hunyuan Hy4 Preview', maxInputTokens: 1000000, maxOutputTokens: 64000, supportsImages: true,
      reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['high'] },
    },
    {
      id: 'mock-legacy', name: 'Mock Legacy Model', maxInputTokens: 200000, maxOutputTokens: 48000,
      reasoning: { effort: 'medium', summary: 'auto' },
    },
  ],
  agents: [{ name: 'cli', models: ['glm-5.3-flash', 'hy4-preview', 'mock-legacy'] }],
}
const upstream = createServer((req, res) => {
  // [17] 目录端点（GET，无 body）：开闸才发目录，否则 500 走静态兜底。
  if (req.url.startsWith('/v3/config')) {
    if (catalogMode !== 'on') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"code":1,"msg":"catalog unavailable"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: CATALOG_FIXTURE }))
    return
  }
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
  // [16] OAuth 设备流后续端点：refresh 必须先于 token 匹配（前缀包含关系）。
  if (req.url.startsWith('/v2/plugin/auth/token/refresh')) {
    res.writeHead(oauthRefreshMode === 'fail' ? 401 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(oauthRefreshMode === 'fail'
      ? { code: 12153, msg: 'invalid refresh token' }
      : { code: 0, data: { accessToken: 'at-refreshed', expiresIn: 3600, refreshToken: 'rt-new', domain: '' } }))
    return
  }
  if (req.url.startsWith('/v2/plugin/auth/token')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(oauthTokenMode === 'success'
      ? { code: 0, data: { accessToken: 'at-polled', expiresIn: 3600, refreshToken: 'rt-polled', refreshExpiresAt: 30 * 86400, domain: '' } }
      : { code: 11217, msg: 'pending' }))
    return
  }
  if (req.url.startsWith('/v2/plugin/login/account')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { uid: 'u-verify', nickname: 'verify-account' } }))
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
        // [15] 挂起模式：bridge 侧中止/超时时连接被丢弃，res close 为证。
        if (parsed?.model === 'hang' || parsed?.model === 'drip') {
          res.on('close', () => { hangCloses.push({ model: parsed.model, at: Date.now(), writableEnded: res.writableEnded }) })
          if (parsed.model === 'hang') return // 永远不出响应头
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"id":"mock","choices":[{"index":0,"delta":{"content":"partial "}}]}\n\n')
          return // 一块之后沉默
        }
        if (parsed?.model === 'zh-split') {
          // [19] 跨分片多字节（踩坑 #28 同族）：SSE 帧含中文，且第一块**切在多字节
          // 字符内部**——桥的 SSE 中继写 Uint8Array，捕获式 res 若逐分片解码就会
          // 把它损坏成 U+FFFD。两块之间留 30ms，保证桥侧 reader 分两次拿到。
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const first = `data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: { content: '中文' } }] })}\n\n`
          const bytes = Buffer.from(first, 'utf8')
          const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1 // 落在 3 字节字符内部
          res.write(bytes.subarray(0, cut))
          setTimeout(() => {
            res.write(bytes.subarray(cut))
            res.end([
              `data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}`,
              '',
              'data: [DONE]',
              '',
              '',
            ].join('\n'))
          }, 30)
          return
        }
        if (parsed?.model === 'upstream-400') {
          // [19] 错误面：内部 chat 面非 200（上游 JSON 错误体）→ 协议面必须
          // 保留真实状态码 + 原因 + 内部 code（踩坑 #7），不能变成 200 空流。
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 11102, msg: 'model [x] service info not found' }))
          return
        }
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

/**
 * 原生 socket 请求：[19] 的安全门断言要伪造 Host/Origin，而 undici 的 fetch
 * 不允许设置这两个头（Fetch 规范的 forbidden header names）。响应必须被消费
 * （踩坑 #29：不消费的 socket 永不派发 close，断言自己挂死）。
 */
function rawHttp({ port, method = 'POST', path, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const head = [
      `${method} ${path} HTTP/1.1`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')
    const sock = connect(port, '127.0.0.1', () => sock.write(head + body))
    let raw = ''
    sock.on('data', (d) => { raw += d.toString('utf8') })
    sock.on('error', reject)
    sock.on('close', () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)
      const sep = raw.indexOf('\r\n\r\n')
      resolve({ status, text: sep >= 0 ? raw.slice(sep + 4) : '' })
    })
  })
}

/** SSE 文本 → [{event, data}]（两个协议面都用具名事件）。 */
function parseSseEvents(text) {
  const frames = []
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue
    let event = null
    let data = null
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim()
        try { data = JSON.parse(raw) } catch { data = raw }
      }
    }
    if (event) frames.push({ event, data })
  }
  return frames
}

async function main() {
  const upstreamPort = await freePort()
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r))
  const bridgePort = await freePort()

  const { apply } = await import(new URL('../index.js', import.meta.url).href)
  // Route registrations are captured so the settings route can be driven
  // in-process (the usage view is asserted through it, like the card does).
  const routes = {}
  const effects = []
  const ctx = makeMockCtx({ routes, effects })
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
    const ctx2 = makeMockCtx({ routes: routes2, effects })
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

  // ------------------------------------------------- 14. G8 思考强度注入
  //   文件层 effortByModel 只存档位名；桥出站按静态清单 reasoningEfforts 表
  //   注入线值——调用方显式携带不覆盖、off（线值 null）不注入、无表模型与
  //   非法档位不注入。
  console.log('\n[14] G8 per-model reasoning_effort injection')
  {
    const layerPath = join(process.env.DSH_HOME, 'codebuddy-plugin.json')
    const writeLayer = (obj) => writeFileSync(layerPath, JSON.stringify(obj) + '\n')

    writeLayer({ effortByModel: { 'deepseek-v4-pro': 'high' } })
    let before = arrivals.length
    await chat({ model: 'deepseek-v4-pro', stream: false, messages: [] })
    check('effortByModel high → reasoning_effort injected upstream',
      arrivals.slice(before).some((a) => a.raw.includes('"reasoning_effort":"high"')))

    before = arrivals.length
    await chat({ model: 'deepseek-v4-pro', stream: false, reasoning_effort: 'low', messages: [] })
    check('caller-set reasoning_effort never overridden',
      arrivals.slice(before).some((a) => a.raw.includes('"reasoning_effort":"low"'))
        && !arrivals.slice(before).some((a) => a.raw.includes('"reasoning_effort":"high"')))

    writeLayer({ effortByModel: { 'deepseek-v4-pro': 'off' } })
    before = arrivals.length
    await chat({ model: 'deepseek-v4-pro', stream: false, messages: [] })
    check('off (wire null) injects nothing',
      !arrivals.slice(before).some((a) => a.raw.includes('reasoning_effort')))

    writeLayer({ effortByModel: { 'deepseek-v3': 'high', 'deepseek-v4-pro': 'bogus' } })
    before = arrivals.length
    await chat({ model: 'deepseek-v3', stream: false, messages: [] })
    await chat({ model: 'deepseek-v4-pro', stream: false, messages: [] })
    check('table-less model and unknown level both inject nothing',
      !arrivals.slice(before).some((a) => a.raw.includes('reasoning_effort')))

    writeLayer({})
  }

  // ------------------------- 15. 取消传播 / 413 / 聚合 usage / 首字节超时
  //   a) 流式中途客户端断连 → 桥中止上游 fetch（mock 'drip'：一块后沉默，
  //      上游连接被丢弃以 res close 且 writableEnded=false 为证）。
  //   b) 排队 waiter 断连后不被唤醒发上游；占用者中止后槽位真正归还
  //      （新请求能完成——旧实现槽位随挂死请求永久泄漏）。
  //   c) 请求体超 32MB → 413 JSON（旧行为 req.destroy()：客户端只见连接
  //      被重置，拿不到任何状态码）。
  //   d) 非流式聚合回传流里抓到的 usage（旧行为恒 {}）。
  //   e) 上游收下不出头 → 首字节超时快速 502（与 trae 侧护栏对称）。
  console.log('\n[15] cancellation propagation / 413 / aggregated usage / first-byte timeout')
  {
    // 15a. 流式中途断连
    const hangBefore = hangCloses.length
    const ac1 = new AbortController()
    const res1 = await fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'drip', stream: true, messages: [] }),
      signal: ac1.signal,
    })
    const reader1 = res1.body.getReader()
    await withTimeout(reader1.read(), 3000) // 第一块到达 = 流已建立
    ac1.abort()
    await reader1.read().catch(() => {}) // 客户端读取侧收尾
    let abortedUpstream = false
    for (let i = 0; i < 30 && !abortedUpstream; i++) {
      await sleep(100)
      abortedUpstream = hangCloses.slice(hangBefore).some((c) => c.model === 'drip' && c.writableEnded === false)
    }
    check('mid-stream client disconnect aborts the upstream fetch', abortedUpstream,
      JSON.stringify(hangCloses.slice(hangBefore)))

    // 15b. 排队 waiter 不泄漏
    setLimit(1)
    arrivals.length = 0
    const sessQ = { 'X-Session-ID': 'sess-Q' }
    const ac2 = new AbortController() // R1：'hang' 占住唯一槽位
    const r1p = fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessQ },
      body: JSON.stringify({ model: 'hang', stream: true, messages: [] }),
      signal: ac2.signal,
    }).then((r) => r.text()).catch(() => 'aborted')
    for (let i = 0; i < 40 && !arrivals.some((a) => a.sessionId === 'sess-Q'); i++) await sleep(50)
    check('holder request reached upstream (the one slot is occupied)',
      arrivals.filter((a) => a.sessionId === 'sess-Q').length === 1, JSON.stringify(arrivals.length))
    const ac3 = new AbortController() // R2：排队后断连
    const r2p = fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessQ },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [] }),
      signal: ac3.signal,
    }).then((r) => r.text()).catch(() => 'aborted')
    await sleep(150) // 足够进队列
    ac3.abort()
    await r2p
    await sleep(400) // 若被错误唤醒，早已发到上游
    check('queued waiter never fires upstream after its caller disconnects',
      arrivals.filter((a) => a.sessionId === 'sess-Q').length === 1,
      JSON.stringify(arrivals.map((a) => a.sessionId)))
    ac2.abort() // R1 断连 → 槽位归还
    await r1p
    const r3 = await withTimeout(chat({ model: 'm1', stream: true, messages: [] }, sessQ).then((r) => r.text()), 4000)
    check('limiter slot released after the aborted holder (fresh same-session request completes)',
      r3 !== 'TIMEOUT')
    setLimit(2)

    // 15c. 超上限 → 413（旧行为 req.destroy()：调用方只见连接被重置，拿不到任何
    //      状态码）。**不再真推 33MiB**：`createBridge` 的 bodyLimitBytes 可注入
    //      （默认仍 32MiB、文案逐字节不变），此处起一个 1KiB 上限的专用桥——
    //      毫秒级、且避开「边推边收」收尾窗口里偶发的对端 RST（实测该窗口下
    //      裸 ECONNRESET 会偶发逃逸成未处理异常，Windows 上约 1/10~1/20 概率）。
    {
      const limitPort = await freePort()
      const limitRuntime = { running: false, port: null, lastError: null }
      const limitBridge = createBridge({
        settings: () => ({ baseURL: `http://127.0.0.1:${upstreamPort}`, maxConcurrentPerSession: 2 }),
        provider: {
          bridgeHeaders: () => ({}),
          transformChatPayload: () => {},
          extractUsage: (c) => c.usage ?? null,
          extractStreamError: (c) => (c.error ? c : null),
          bridgeResponseId: 'dsh-codebuddy-stream-bridge',
          logHeaderNames: [],
          sentinelAuth: 'Bearer dsh-codebuddy-bridge',
          texts: { credentialUnavailable: 'credential unavailable' },
        },
        withCredentials: (attempt) => attempt({ authorization: 'Bearer ck_bridge_test_key', headers: {} }),
        meter: { record: () => {} },
        forensics: { logPath: () => undefined, dumpDir: () => undefined },
        runtime: limitRuntime,
        bodyLimitBytes: 1024,
      })
      const stopLimit = limitBridge.listen(limitPort)
      await sleep(200)
      const over = await fetch(`http://127.0.0.1:${limitPort}/v2/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(4096) }),
      })
      const overJson = await over.json().catch(() => null)
      check('body past the limit gets a real 413 JSON (was: silent req.destroy)',
        over.status === 413 && /too large/.test(overJson?.error?.message ?? ''), `HTTP ${over.status}`)
      check('413 response carries Connection: close',
        (over.headers.get('connection') ?? '').toLowerCase() === 'close',
        String(over.headers.get('connection')))
      await stopLimit()
    }

    // 15d. 聚合 usage 回传
    const resU = await chat({ model: 'm1', stream: false, messages: [] })
    const jsonU = await resU.json().catch(() => null)
    check('aggregated chat.completion carries the captured usage (was: always {})',
      jsonU?.usage?.total_tokens === 5 && jsonU?.usage?.credit === 0.01, JSON.stringify(jsonU?.usage))

    // 15e. 首字节超时（层文件压到 schema 下限 1000ms；'hang' 永远不出头）
    writeFileSync(join(process.env.DSH_HOME, 'codebuddy-plugin.json'),
      JSON.stringify({ maxConcurrentPerSession: 2, upstreamFirstByteTimeoutMs: 1000 }) + '\n')
    const t0 = Date.now()
    const resT = await chat({ model: 'hang', stream: true, messages: [] })
    const msT = Date.now() - t0
    const jsonT = await resT.json().catch(() => null)
    check('silent upstream fails fast with 502 + first-byte reason (default window is 45s)',
      resT.status === 502 && /first-byte timeout/.test(jsonT?.error?.message ?? '') && msT < 5000,
      `HTTP ${resT.status} in ${msT}ms: ${JSON.stringify(jsonT)}`)
    setLimit(2) // 恢复层文件（顺带清掉临时超时档）
  }

  // --------------------------------------------- 16. OAuth 状态机回归
  //   a) logout() 终止进行中的 poll（代际失效）：logout 后浏览器才完成的授权
  //      不得写回令牌库（旧实现 while 只看 deadline——logout 后 10 分钟内
  //      授权完成会被重新登进）。附正例对照：未打断的 poll 正常登录。
  //   b) refresh 实败（/token/refresh 401）→ oauthStatus 暴露 needsRelogin
  //      （旧实现 signedIn 只看 accessToken 在不在：UI 显示已登录、聊天
  //      全 503 而无从察觉）。
  //   c) refreshExpiresAt 已过期（此前存了从不检查的字段）→ 无需 refresh
  //      尝试即暴露 needsRelogin。
  console.log('\n[16] OAuth state machine: logout kills the poll; refresh failure surfaces needsRelogin')
  {
    const authFile = join(process.env.DSH_HOME, 'codebuddy-plugin-auth.json')
    const readAuthFile = () => { try { return JSON.parse(readFileSync(authFile, 'utf8')) } catch { return {} } }

    // 16a. logout 终止 poll
    let res = await callRoute(routes, { action: 'oauth-start' })
    check('oauth-start activates pending', res.status === 200 && res.json?.ok === true)
    res = await callRoute(routes, { action: 'oauth-status' })
    check('pending after start', res.json?.oauth?.pending === true, JSON.stringify(res.json?.oauth))
    res = await callRoute(routes, { action: 'oauth-logout' })
    check('logout clears pending immediately', res.json?.oauth?.pending === false)
    oauthTokenMode = 'success' // 浏览器在 logout 之后才完成授权
    await sleep(2600) // >2 个轮询周期：poll 若没死早已写入令牌
    res = await callRoute(routes, { action: 'oauth-status' })
    check('authorization landing after logout never signs back in',
      res.json?.oauth?.signedIn === false && !readAuthFile()?.auth?.accessToken,
      JSON.stringify({ oauth: res.json?.oauth, file: readAuthFile() }))

    // 正例对照：未被 logout 打断的 poll 正常完成登录
    res = await callRoute(routes, { action: 'oauth-start' })
    check('restart after logout works (pending again)', res.status === 200 && res.json?.ok === true)
    let signed = false
    for (let i = 0; i < 40 && !signed; i++) { await sleep(200); signed = Boolean(readAuthFile()?.auth?.accessToken) }
    check('uninterrupted poll completes login (control)', signed)
    res = await callRoute(routes, { action: 'oauth-status' })
    check('control login visible in status, needsRelogin false',
      res.json?.oauth?.signedIn === true && res.json?.oauth?.needsRelogin === false, JSON.stringify(res.json?.oauth))
    res = await callRoute(routes, { action: 'oauth-logout' })
    oauthTokenMode = 'pending'
    check('control cleanup: signed out again', res.json?.oauth?.signedIn === false)

    // 16b. refresh 实败 → needsRelogin
    await callRoute(routes, { patch: { authMode: 'oauth' } })
    writeFileSync(authFile, JSON.stringify({
      auth: { accessToken: 'at-expired', expiresAt: Date.now() - 1000, refreshToken: 'rt-bogus', refreshExpiresAt: Date.now() + 86400_000, domain: '' },
      account: { uid: 'u-verify', nickname: 'verify' },
    }) + '\n')
    oauthRefreshMode = 'fail'
    res = await callRoute(routes, { action: 'oauth-status' })
    check('before any refresh attempt: signedIn true, needsRelogin false',
      res.json?.oauth?.signedIn === true && res.json?.oauth?.needsRelogin === false, JSON.stringify(res.json?.oauth))
    const chatRes = await chat({ model: 'm1', stream: true, messages: [] })
    await chatRes.text()
    check('chat with an unrefreshable token → 503 credential unavailable', chatRes.status === 503, `got ${chatRes.status}`)
    res = await callRoute(routes, { action: 'oauth-status' })
    check('refresh failure exposed as needsRelogin (signedIn stays literally true)',
      res.json?.oauth?.needsRelogin === true && res.json?.oauth?.signedIn === true, JSON.stringify(res.json?.oauth))

    // 16c. refreshExpiresAt 过期（先 logout 清掉 16b 的粘性信号以隔离路径）
    await callRoute(routes, { action: 'oauth-logout' })
    writeFileSync(authFile, JSON.stringify({
      auth: { accessToken: 'at-live', expiresAt: Date.now() + 3600_000, refreshToken: 'rt', refreshExpiresAt: Date.now() - 1000, domain: '' },
    }) + '\n')
    res = await callRoute(routes, { action: 'oauth-status' })
    check('expired refreshExpiresAt alone surfaces needsRelogin (no attempt needed)',
      res.json?.oauth?.needsRelogin === true && res.json?.oauth?.signedIn === true, JSON.stringify(res.json?.oauth))

    // 收尾：登出并复原模式（本测试自建的层/令牌不向后传染）
    await callRoute(routes, { action: 'oauth-logout' })
    await callRoute(routes, { patch: { authMode: null } })
    oauthRefreshMode = 'ok'
    res = await callRoute(routes, { action: 'oauth-status' })
    check('cleanup: signed out, mode restored, signal cleared',
      res.json?.oauth?.signedIn === false && res.json?.oauth?.needsRelogin === false, JSON.stringify(res.json?.oauth))
  }

  // ------------------------------------- 17. 目录声明的思考档位（2026-09-22）
  //   网关 /v3/config 自 2026-09 起对新模型发能力清单
  //   （supportedEfforts/canDisableThinking/defaultEffort）。契约：
  //   a) 档位表 = 目录声明优先、静态 reasoningEfforts 兜底（legacy 形态不出表）；
  //   b) 档位表进 settings.yaml 镜像的 models 条目（宿主 Effort 选择器据此出档）；
  //   c) 桥出站按同一张表注入；未声明档位/无表模型不注入；
  //   d) 没有实测"关思考"拼写 → 不出 off（canDisableThinking 也不凭空造线值）。
  console.log('\n[17] catalog-declared reasoning tiers → model-list / mirror / bridge injection')
  {
    const layerPath = join(process.env.DSH_HOME, 'codebuddy-plugin.json')
    const writeLayer = (obj) => writeFileSync(layerPath, JSON.stringify(obj) + '\n')

    let res = await callRoute(routes, { action: 'model-list' })
    check('before sync (catalog unreachable): model-list reports the failure, publishes no tiers',
      res.status === 502 && res.json?.efforts === undefined, `${res.status} ${JSON.stringify(res.json?.error)}`)

    catalogMode = 'on'
    res = await callRoute(routes, { action: 'model-sync' })
    check('model-sync pulls the catalog (3 models)', res.json?.sync?.ok === true && res.json?.sync?.count === 3,
      JSON.stringify(res.json?.sync))

    res = await callRoute(routes, { action: 'model-list' })
    const listed = res.json
    const flash = (listed?.catalog?.models ?? []).find((m) => m.id === 'glm-5.3-flash')
    check('catalog entry carries the effort declaration verbatim',
      JSON.stringify(flash?.supportedEfforts) === '["low","high","max"]'
        && flash?.canDisableThinking === true && flash?.defaultEffort === 'high' && flash?.reasoningEffort === 'high',
      JSON.stringify(flash))
    check('declared tiers → efforts map (low/high/max, no off without a proven wire)',
      JSON.stringify(listed?.efforts?.['glm-5.3-flash']) === '["low","high","max"]',
      JSON.stringify(listed?.efforts?.['glm-5.3-flash']))
    check('single-tier declaration survives (hy4-preview → ["high"])',
      JSON.stringify(listed?.efforts?.['hy4-preview']) === '["high"]',
      JSON.stringify(listed?.efforts?.['hy4-preview']))
    check('legacy declaration (no supportedEfforts) yields no tier row',
      listed?.efforts?.['mock-legacy'] === undefined, JSON.stringify(listed?.efforts?.['mock-legacy']))
    check('static-only rows keep their patch table (auto stays table-less)',
      listed?.efforts?.['auto'] === undefined && Array.isArray(listed?.efforts?.['hy3-preview']))
    check('static table still governs models the catalog does not declare (deepseek-v4-pro)',
      JSON.stringify(listed?.efforts?.['deepseek-v4-pro']) === '["low","medium","high","max"]',
      JSON.stringify(listed?.efforts?.['deepseek-v4-pro']))

    // 宿主 Effort 选择器的数据源 = settings.yaml 镜像里的 reasoningEfforts。
    const mirror = readFileSync(join(process.env.DSH_HOME, 'settings.yaml'), 'utf8')
    check('mirror carries reasoningEfforts for the catalog model (host Effort picker)',
      /glm-5\.3-flash[\s\S]{0,400}?reasoningEfforts/.test(mirror)
        && /reasoningEfforts:[\s\S]{0,200}?high: high/.test(mirror), mirror.slice(0, 0))

    writeLayer({ effortByModel: { 'glm-5.3-flash': 'max' } })
    let before = arrivals.length
    await chat({ model: 'glm-5.3-flash', stream: false, messages: [] })
    check('catalog tier max → reasoning_effort injected upstream',
      arrivals.slice(before).some((a) => a.raw.includes('"reasoning_effort":"max"')),
      arrivals.slice(before).map((a) => a.raw).join(' | ').slice(0, 200))

    writeLayer({ effortByModel: { 'glm-5.3-flash': 'medium', 'hy4-preview': 'high', 'mock-legacy': 'high' } })
    before = arrivals.length
    await chat({ model: 'glm-5.3-flash', stream: false, messages: [] })
    await chat({ model: 'hy4-preview', stream: false, messages: [] })
    await chat({ model: 'mock-legacy', stream: false, messages: [] })
    const tail = arrivals.slice(before)
    check('undeclared level (medium) injects nothing',
      !tail[0].raw.includes('reasoning_effort'), tail[0].raw.slice(0, 160))
    check('declared single tier still injects (hy4-preview high)',
      tail[1].raw.includes('"reasoning_effort":"high"'), tail[1].raw.slice(0, 160))
    check('legacy catalog model without a table injects nothing',
      !tail[2].raw.includes('reasoning_effort'), tail[2].raw.slice(0, 160))

    writeLayer({ effortByModel: { 'glm-5.3-flash': 'off' } })
    before = arrivals.length
    await chat({ model: 'glm-5.3-flash', stream: false, messages: [] })
    check('off is not a declared tier → injects nothing (no invented disable wire)',
      !arrivals.slice(before).some((a) => a.raw.includes('reasoning_effort')))

    // 收尾：关闸并清层（本节之后没有其它断言，仍保持测试自净的纪律）。
    catalogMode = 'off'
    writeLayer({})
  }

  // ------------------- 18. 出站 tool 配对 + 可见性体检（CodeBuddy 桥接入锁）
  //   providers/tool-pairing.js 的不变量（踩坑 #39/#41）此前只接在 Qoder/Trae
  //   两个翻译网关上，CodeBuddy 桥漏接（#63 成对审计；research-eco-comparison
  //   §4 P0-1）。本节锁四件事：a) 孤儿 tool → 补 assistant 桩；b) content:null /
  //   缺键 → 可见性归一为 ''；c) 良构历史逐字节不变（防"修出问题"）；d) 同一
  //   请求里 developer→system 与档位注入照旧（既有行为不回归）。
  console.log('\n[18] outbound tool pairing + visibility normalization')
  {
    const layerPath = join(process.env.DSH_HOME, 'codebuddy-plugin.json')
    const writeLayer = (obj) => writeFileSync(layerPath, JSON.stringify(obj) + '\n')

    // a) 孤儿 tool（宿主丢掉了 stopReason=error/aborted 的 assistant，只留下它的
    //    toolResult）→ 必须补一条仅含该 tool_call 的 assistant 桩，结果原样保留。
    let before = arrivals.length
    let res = await chat({ model: 'm1', stream: true, messages: [
      { role: 'user', content: 'ping' },
      { role: 'tool', tool_call_id: 'call_orphan_1', name: 'get_current_time', content: '12:00' },
    ] })
    await res.text()
    let fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('orphan tool message gets a synthesized assistant stub (id + tool name kept)',
      fwd?.messages?.[1]?.role === 'assistant'
        && fwd.messages[1].tool_calls?.[0]?.id === 'call_orphan_1'
        && fwd.messages[1].tool_calls?.[0]?.function?.name === 'get_current_time'
        && fwd.messages[1].content === ''
        && fwd.messages[2]?.role === 'tool' && fwd.messages[2].tool_call_id === 'call_orphan_1'
        && fwd.messages[2].content === '12:00',
      JSON.stringify(fwd?.messages))
    check('stub uses the OpenAI dialect the pairing checker reads (role/content/tool_calls)',
      JSON.stringify(Object.keys(fwd?.messages?.[1] ?? {})) === JSON.stringify(['role', 'content', 'tool_calls']),
      JSON.stringify(Object.keys(fwd?.messages?.[1] ?? {})))

    // b) content:null / 缺键 → ''（#41 主因：严格上游把 null 载体当"不存在"）
    before = arrivals.length
    res = await chat({ model: 'm1', stream: true, messages: [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_c1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_c1', content: null },
    ] })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('content:null assistant + tool become "" (visibility normalization)',
      fwd?.messages?.[1]?.content === '' && fwd?.messages?.[2]?.content === '',
      JSON.stringify(fwd?.messages))

    before = arrivals.length
    res = await chat({ model: 'm1', stream: true, messages: [
      { role: 'user', content: 'ping' },
      { role: 'assistant', tool_calls: [{ id: 'call_m1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_m1' },
    ] })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('missing content key becomes an explicit "" key on both carriers',
      fwd?.messages?.[1]?.content === '' && 'content' in (fwd?.messages?.[1] ?? {})
        && fwd?.messages?.[2]?.content === '' && 'content' in (fwd?.messages?.[2] ?? {}),
      JSON.stringify(fwd?.messages))

    // c) 良构历史 no-op：出站字节必须与入站**逐字节**相同（多改一个字节就是回归）
    const wellFormed = [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: '现在几点？' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'get_current_time', arguments: '{"tz":"UTC"}' } }] },
      { role: 'tool', tool_call_id: 'call_ok', content: '12:00' },
      { role: 'assistant', content: '现在是 12:00。' },
      { role: 'user', content: '谢谢' },
    ]
    const wellFormedBody = { model: 'm1', stream: true, messages: wellFormed }
    before = arrivals.length
    res = await chat(wellFormedBody)
    await res.text()
    check('well-formed history is byte-identical upstream (no-op, nothing "repaired")',
      arrivals[before]?.raw === JSON.stringify(wellFormedBody),
      `${arrivals[before]?.raw?.length} vs ${JSON.stringify(wellFormedBody).length} bytes`)

    // d) 既有行为不回归：同一请求里 developer→system 与档位注入照旧生效
    writeLayer({ effortByModel: { 'deepseek-v4-pro': 'high' } })
    before = arrivals.length
    res = await chat({ model: 'deepseek-v4-pro', stream: true, messages: [
      { role: 'developer', content: 'You are a test agent.' },
      { role: 'user', content: 'ping' },
      { role: 'tool', tool_call_id: 'call_d1', content: 'r' },
    ] })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('developer→system rewrite still applies alongside the pairing repair',
      fwd?.messages?.[0]?.role === 'system' && fwd.messages.every((m) => m.role !== 'developer'),
      JSON.stringify(fwd?.messages?.map((m) => m.role)))
    check('reasoning_effort injection still applies alongside the pairing repair',
      fwd?.reasoning_effort === 'high', JSON.stringify(fwd?.reasoning_effort))
    check('orphan tool repaired in the same request as the other rewrites',
      fwd?.messages?.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_d1'),
      JSON.stringify(fwd?.messages))

    writeLayer({}) // 自净：本节之后不再有断言，也不给别的节留状态
  }

  // ------------------- 19. 桥挂载点：两个本机客户端协议面（默认主通道）
  //   CodeBuddy 是**默认主通道**：`/v1/messages`（Anthropic Messages）与
  //   `/v1/responses`（OpenAI Responses）此前只挂在 Trae/Qoder 的翻译网关上，
  //   只有 CodeBuddy 凭据的用户完全拿不到。本节锁桥侧挂载点：
  //   a) 两面经**桥**被协议面处理——内部 chat 面走桥自己的 chat 路径
  //      （cordis.patch.yml 的 /v2 + /chat/completions），且出站体是翻译后的
  //      OpenAI chat payload，不是被 proxyUpstream 原样转发的协议体；
  //   b) 两面各一条正常流式响应的事件序列；
  //   c) 非流式（stream:false）得到协议化聚合 JSON（内部面仍恒流式）；
  //   d) 桥的 Host 门与 Origin 门对新面同样生效（403）；
  //   e) 413 收体上限对新面同样生效；
  //   f) 既有 /v2/chat/completions 通用转发零回归（良构请求逐字节不变）。
  console.log('\n[19] protocol surfaces mounted on the bridge (Anthropic Messages / OpenAI Responses)')
  {
    const layerPath = join(process.env.DSH_HOME, 'codebuddy-plugin.json')
    const writeLayer = (obj) => writeFileSync(layerPath, JSON.stringify(obj) + '\n')
    // 会话亲和：协议面的入站头必须原样到达内部 chat 面（桥按 session_id 亲和）。
    writeLayer({ maxConcurrentPerSession: 2, sessionHeadersEnabled: true, sessionHeaderFormat: 'openai' })

    // 合成 chat 路径的**证据链**（不猜）：cordis.patch.yml:84 把 codebuddy 路由
    // 指到 http://127.0.0.1:3901/v2 ⇒ 入站 chat 路径 = <该路径>/chat/completions；
    // core/bridge.js 的 isChat 判据是 endsWith('/chat/completions')、转发用
    // `${s.baseURL}${req.url}`（s.baseURL 是上游根，不含 /v2）。这条对账把
    // index.js 的 CODEBUDDY_CHAT_PATH 常量与 patch 钉在一起。
    const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const routeBase = patchText.match(/baseURL:\s*http:\/\/127\.0\.0\.1:3901(\/[^\s]+)/)?.[1] ?? null
    check('cordis.patch.yml pins the codebuddy route base at /v2', routeBase === '/v2', String(routeBase))
    const chatPath = `${routeBase}/chat/completions`

    // ---------------------------------------------------- a) + b) Anthropic
    let before = arrivals.length
    const aRes = await fetch(`${bridge}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': 'sess-proto' },
      body: JSON.stringify({
        model: 'glm-5.3', system: 'be brief', max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    })
    const aText = await aRes.text()
    check('anthropic via bridge: 200 + text/event-stream',
      aRes.status === 200 && (aRes.headers.get('content-type') ?? '').includes('text/event-stream'),
      `HTTP ${aRes.status} ${aRes.headers.get('content-type')}`)
    check('anthropic via bridge: protocol event stream (not the proxied upstream SSE)',
      aText.includes('event: message_start') && !aText.includes('"id":"mock"'), aText.slice(0, 80))
    const aUp = arrivals[before]
    check('anthropic via bridge: drove the bridge internal chat face on the bridge chat path',
      aUp?.path === chatPath, `${aUp?.path} vs ${chatPath}`)
    const aUpBody = JSON.parse(aUp?.raw ?? 'null')
    check('anthropic via bridge: upstream body is the translated OpenAI chat payload',
      aUpBody?.model === 'glm-5.3' && aUpBody?.stream === true
        && aUpBody?.messages?.[0]?.role === 'system' && aUpBody.messages[0].content === 'be brief'
        && aUpBody?.messages?.[1]?.content === 'hi',
      JSON.stringify(aUpBody?.messages))
    check('anthropic via bridge: session affinity header reached the internal chat face',
      aUp?.sessionId === 'sess-proto' && aUp?.clientRequestId === 'sess-proto',
      JSON.stringify({ s: aUp?.sessionId, c: aUp?.clientRequestId }))
    const aFrames = parseSseEvents(aText)
    check('anthropic via bridge: streamed event sequence',
      JSON.stringify(aFrames.map((f) => f.event)) === JSON.stringify([
        'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop',
      ]), JSON.stringify(aFrames.map((f) => f.event)))
    check('anthropic via bridge: text deltas carry the upstream content',
      aFrames.filter((f) => f.event === 'content_block_delta').map((f) => f.data.delta.text).join('') === 'hello world',
      JSON.stringify(aFrames.filter((f) => f.event === 'content_block_delta').map((f) => f.data.delta)))

    // ---------------------------------------------------- a) + b) Responses
    before = arrivals.length
    const rRes = await fetch(`${bridge}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', input: 'hi', stream: true }),
    })
    const rText = await rRes.text()
    check('responses via bridge: 200 + text/event-stream',
      rRes.status === 200 && (rRes.headers.get('content-type') ?? '').includes('text/event-stream'),
      `HTTP ${rRes.status} ${rRes.headers.get('content-type')}`)
    check('responses via bridge: protocol event stream (not the proxied upstream SSE)',
      rText.includes('event: response.created') && !rText.includes('"id":"mock"'), rText.slice(0, 80))
    const rUp = arrivals[before]
    check('responses via bridge: drove the bridge internal chat face on the bridge chat path',
      rUp?.path === chatPath, `${rUp?.path} vs ${chatPath}`)
    check('responses via bridge: upstream body is the translated OpenAI chat payload',
      JSON.parse(rUp?.raw ?? 'null')?.messages?.[0]?.content === 'hi'
        && JSON.parse(rUp?.raw ?? 'null')?.stream === true,
      JSON.stringify(JSON.parse(rUp?.raw ?? 'null')?.messages))
    const rFrames = parseSseEvents(rText)
    check('responses via bridge: streamed event sequence',
      JSON.stringify(rFrames.map((f) => f.event)) === JSON.stringify([
        'response.created', 'response.in_progress', 'response.output_item.added',
        'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
        'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
        'response.completed',
      ]), JSON.stringify(rFrames.map((f) => f.event)))
    check('responses via bridge: sequence_number 单调连续',
      JSON.stringify(rFrames.map((f) => f.data.sequence_number)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      JSON.stringify(rFrames.map((f) => f.data.sequence_number)))
    check('responses via bridge: output_text.done carries the aggregated text',
      rFrames.find((f) => f.event === 'response.output_text.done')?.data.text === 'hello world',
      JSON.stringify(rFrames.find((f) => f.event === 'response.output_text.done')?.data))

    // ------------------- 跨分片多字节（踩坑 #28 同族，锁捕获式 res 的流式解码）
    before = arrivals.length
    const zhRes = await fetch(`${bridge}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'zh-split', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const zhText = await zhRes.text()
    const zhFrames = parseSseEvents(zhText)
    check('multibyte text split mid-character across upstream chunks arrives intact',
      zhFrames.filter((f) => f.event === 'content_block_delta').map((f) => f.data.delta.text).join('') === '中文'
        && !zhText.includes('\uFFFD'),
      JSON.stringify(zhText.slice(0, 160)))

    // ---------------------------------------------------- c) 非流式聚合
    before = arrivals.length
    const aPlainRes = await fetch(`${bridge}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    const aPlain = await aPlainRes.json().catch(() => null)
    check('anthropic non-stream via bridge: protocol JSON aggregation',
      aPlainRes.status === 200 && aPlain?.type === 'message' && aPlain?.role === 'assistant'
        && aPlain?.content?.[0]?.text === 'hello world' && aPlain?.stop_reason === 'end_turn'
        && aPlain?.usage?.input_tokens === 3 && aPlain?.usage?.output_tokens === 2,
      JSON.stringify(aPlain))
    check('anthropic non-stream: internal face still forced to stream (upstream is stream-only)',
      JSON.parse(arrivals[before]?.raw ?? 'null')?.stream === true)

    before = arrivals.length
    const rPlainRes = await fetch(`${bridge}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', input: 'hi', stream: false }),
    })
    const rPlain = await rPlainRes.json().catch(() => null)
    check('responses non-stream via bridge: protocol JSON aggregation',
      rPlainRes.status === 200 && rPlain?.object === 'response' && rPlain?.status === 'completed'
        && rPlain?.output_text === 'hello world'
        && JSON.stringify(rPlain?.usage) === JSON.stringify({ input_tokens: 3, output_tokens: 2, total_tokens: 5 }),
      JSON.stringify(rPlain))

    // ---------------- 错误面成对审计（踩坑 #63）：两个新面各自映射上游错误
    before = arrivals.length
    const aErrRes = await fetch(`${bridge}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'upstream-400', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const aErr = await aErrRes.json().catch(() => null)
    check('anthropic via bridge: upstream 400 → protocol error envelope (status + reason + code)',
      aErrRes.status === 400 && aErr?.type === 'error' && aErr?.error?.type === 'invalid_request_error'
        && /service info not found/.test(aErr.error.message) && /11102/.test(aErr.error.message),
      JSON.stringify(aErr))
    const rErrRes = await fetch(`${bridge}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'upstream-400', input: 'hi', stream: true }),
    })
    const rErr = await rErrRes.json().catch(() => null)
    // 数字码方言保真（2026-10-19 已修）：CodeBuddy 上游的码是**数字**（11102…），
    // 而协议信封的 code 是字符串字段。原先 surface.js 的 internalCode 只认字符串
    // ⇒ Responses 信封落成 `code: null`，机器可读的码丢掉（原因仍在 message）。
    // 现由 `normalizeCode()` 归一：字符串原样、有限非零数字转字符串、`0`（上游
    // 成功哨兵）不当作码。此处锁新行为；判别力见 verify-protocols §9 的
    // `status-400-numeric` 场景（关掉数字分支恰两条「码保留」断言变红）。
    check('responses via bridge: upstream 400 → protocol error envelope (status + reason + numeric code normalized)',
      rErrRes.status === 400 && rErr?.error?.type === 'invalid_request_error'
        && /service info not found/.test(rErr.error.message) && rErr?.error?.code === '11102',
      JSON.stringify(rErr))
    check('failed protocol requests still reached the bridge internal chat face (not short-circuited)',
      arrivals.slice(before).filter((a) => a.path === chatPath).length === 2,
      JSON.stringify(arrivals.slice(before).map((a) => a.path)))

    // ---------------------------------------------------- d) Host/Origin 双门
    const gateBefore = arrivals.length
    const evilHost = await rawHttp({
      port: bridgePort, path: '/v1/messages',
      headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' }, body: '{}',
    })
    check('anthropic face: non-loopback Host → 403 (bridge Host gate)',
      evilHost.status === 403 && /loopback-only/.test(evilHost.text),
      `HTTP ${evilHost.status} ${evilHost.text.slice(0, 60)}`)
    const evilOrigin = await rawHttp({
      port: bridgePort, path: '/v1/responses',
      headers: { Host: `127.0.0.1:${bridgePort}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' },
      body: '{}',
    })
    check('responses face: cross-site Origin → 403 (bridge Origin gate)',
      evilOrigin.status === 403 && /cross-origin/.test(evilOrigin.text),
      `HTTP ${evilOrigin.status} ${evilOrigin.text.slice(0, 60)}`)
    check('gated protocol requests never reached upstream', arrivals.length === gateBefore,
      `arrivals ${gateBefore} → ${arrivals.length}`)
    const goodOrigin = await rawHttp({
      port: bridgePort, path: '/v1/messages',
      headers: { Host: `127.0.0.1:${bridgePort}`, Origin: `http://127.0.0.1:${bridgePort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    check('same-origin Origin passes both gates on the new face (positive control)',
      goodOrigin.status === 200 && /event: message_start/.test(goodOrigin.text), `HTTP ${goodOrigin.status}`)

    // ---------------------------------------------------- e) 413 对新面生效
    // 与 [15c] 同法：注入 1KiB 上限的专用桥（默认仍 32MiB、文案逐字节不变），
    // 但这次挂上**同一份共享装配**——证明新面在桥挂载点上同样受收体上限约束。
    {
      const limitPort = await freePort()
      const limitRuntime = { running: false, port: null, lastError: null }
      let limitBridge = null
      const limitSurfaces = createProtocolSurfaces({
        invokeChat: (req, res, chatPayload, sink) => invokeInternalChat({
          handleChat: (r, captureRes, rawBody) => limitBridge.handleChat(r, captureRes, rawBody),
          req, res, chatPayload, sink,
        }),
      })
      limitBridge = createBridge({
        settings: () => ({ baseURL: `http://127.0.0.1:${upstreamPort}`, maxConcurrentPerSession: 2 }),
        provider: {
          bridgeHeaders: () => ({}),
          transformChatPayload: () => {},
          extractUsage: (c) => c.usage ?? null,
          extractStreamError: (c) => (c.error ? c : null),
          bridgeResponseId: 'dsh-codebuddy-stream-bridge',
          logHeaderNames: [],
          sentinelAuth: 'Bearer dsh-codebuddy-bridge',
          texts: { credentialUnavailable: 'credential unavailable' },
        },
        withCredentials: (attempt) => attempt({ authorization: 'Bearer ck_bridge_test_key', headers: {} }),
        meter: { record: () => {} },
        forensics: { logPath: () => undefined, dumpDir: () => undefined },
        runtime: limitRuntime,
        bodyLimitBytes: 1024,
        protocolSurfaces: limitSurfaces,
        chatPath,
      })
      const stopLimit = limitBridge.listen(limitPort)
      await sleep(200)
      // 体量超限、但请求体本身是**合法**的协议请求：413 只可能来自收体上限。
      for (const [label, path, body] of [
        ['anthropic', '/v1/messages', { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'x'.repeat(4096) }] }],
        ['responses', '/v1/responses', { model: 'm', input: 'x'.repeat(4096) }],
      ]) {
        const over = await fetch(`http://127.0.0.1:${limitPort}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        const overJson = await over.json().catch(() => null)
        check(`${label} face past the body limit gets a real 413 JSON`,
          over.status === 413 && /too large/.test(overJson?.error?.message ?? ''), `HTTP ${over.status}`)
      }
      await stopLimit()
    }

    // ------------------------------- f) 既有通用转发零回归（逐字节不变）
    const wellFormed = { model: 'm1', stream: true, messages: [{ role: 'user', content: '现在几点？' }] }
    before = arrivals.length
    const plainText = await (await chat(wellFormed)).text()
    check('existing /v2/chat/completions body is byte-identical upstream (surfaces declined)',
      arrivals[before]?.raw === JSON.stringify(wellFormed),
      `${arrivals[before]?.raw?.length} vs ${JSON.stringify(wellFormed).length} bytes`)
    check('existing /v2/chat/completions still relays the upstream SSE verbatim',
      plainText.includes('"id":"mock"') && plainText.includes('[DONE]'), plainText.slice(0, 60))

    writeLayer({}) // 自净：本节之后不再有断言，也不给别的节留状态
  }

  // --------------------------------------------- 20. harness-identity neutralization
  //   2026-10-21 起，网关在通道校验层新增一道 system 消息**内容指纹**校验：
  //   命中 DSH 内核固定身份首句完整短语 `You are an AI agent powered by
  //   DeepSeek Harness.` 即 HTTP 400 / 11128（同码但形态不同于 §9 的 developer
  //   角色门——多出 displayMsg/displayTips/actions，displayTips 文案"可能不是
  //   官方客户端发出的"是误导，x-user-id 正常回显，凭据有效）。触发词是完整
  //   短语，单词 DeepSeek/Harness 单独不触发。桥在出站前对命中的 system 内容
  //   做等价中和（agent→assistant，语义不变，社区实测 400→200）。来源：
  //   docs/rules/content-moderation.md §R-M4；社区实测 Issue #560 / #87。
  console.log('\n[20] harness-identity phrase in system prompts is neutralized upstream')
  {
    const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'
    const NEUTRAL = 'You are an AI assistant powered by DeepSeek Harness.'

    // a) 命中完整短语 → 出站中和为 assistant
    let before = arrivals.length
    let res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: PHRASE },
        { role: 'user', content: 'ping' },
      ],
    }, { authorization: 'Bearer dsh-codebuddy-bridge' })
    await res.text()
    let fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('identity phrase in system[0] is neutralized agent→assistant',
      fwd?.messages?.[0]?.role === 'system'
        && fwd?.messages?.[0]?.content === NEUTRAL,
      JSON.stringify(fwd?.messages?.[0]))
    check('no literal identity phrase survives in any system message',
      (fwd?.messages ?? []).filter((m) => m.role === 'system')
        .every((m) => typeof m.content !== 'string' || !m.content.includes(PHRASE)),
      JSON.stringify(fwd?.messages?.map((m) => m.role + ':' + (m.content ?? '').slice(0, 30))))

    // b) 短语嵌在更长 system 文本里 → 只替换命中处，其余逐字节不变
    const surrounding = 'Follow the repo conventions. ' + PHRASE + ' Be concise.'
    before = arrivals.length
    res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: surrounding },
        { role: 'user', content: 'ping' },
      ],
    })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('phrase embedded in longer system text: only the phrase is swapped, rest intact',
      fwd?.messages?.[0]?.content === 'Follow the repo conventions. ' + NEUTRAL + ' Be concise.',
      JSON.stringify(fwd?.messages?.[0]?.content))

    // c) 不含短语的 system 内容 → 逐字节不变（no-op，不误伤）
    const innocent = 'You are a helpful assistant. DeepSeek Harness rocks.'
    before = arrivals.length
    res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: innocent },
        { role: 'user', content: 'ping' },
      ],
    })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('system content without the exact phrase is byte-identical (no false positive)',
      fwd?.messages?.[0]?.content === innocent,
      JSON.stringify(fwd?.messages?.[0]?.content))

    // d) 既有 developer→system 重写与身份中和在同一请求里都生效
    before = arrivals.length
    res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'developer', content: PHRASE },
        { role: 'user', content: 'ping' },
      ],
    })
    await res.text()
    fwd = JSON.parse(arrivals[before]?.raw ?? 'null')
    check('developer→system rewrite + identity neutralization both apply in one request',
      fwd?.messages?.[0]?.role === 'system'
        && fwd.messages.every((m) => m.role !== 'developer')
        && fwd?.messages?.[0]?.content === NEUTRAL,
      JSON.stringify(fwd?.messages?.map((m) => m.role + ':' + (m.content ?? '').slice(0, 30))))
  }

  await disposeAll(effects) // apply() 的 teardown：关掉本进程起的桥，别把端口留到进程退出
  console.log(failures === 0 ? '\nall bridge checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`verify-bridge crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
