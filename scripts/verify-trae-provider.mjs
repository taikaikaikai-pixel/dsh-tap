#!/usr/bin/env node
/**
 * Offline regression for providers/trae/ (v0.8.x TraeWork CN channel):
 *
 *   1. OAuth device flow against a mock api.trae.cn:
 *      - PKCE (code_challenge == SHA256(code_verifier), S256 method)
 *      - authUrl shape (client_id / auth_callback_url on 127.0.0.1)
 *      - browser callback -> AuthCode exchange -> tokens + account persisted
 *      - refresh path with DeviceProof VERIFIED by the mock using the public
 *        key our flow registered (proves the self-held ECDSA keypair works)
 *      - failure/timeout/logout semantics
 *      - security regression: traeLoginHost base gate (javascript: / invalid
 *        URL rejected BEFORE the loopback listener opens) and authUrl built
 *        via URL parsing (path-absolute /authorization, no // doubling)
 *   2. catalog: fixture state.vscdb -> profiles (BYOK excluded, multimodal,
 *      ctx fallback), syncCatalog/catalogView/catalogIds
 *   3. gateway translation against a mock Trae cloud:
 *      - outbound headers (Cloud-IDE-JWT + x-cloudide-token + region)
 *      - Trae SSE -> OpenAI SSE (stream mode) and aggregation (non-stream)
 *      - usage metering, upstream 401 mapping, credential-unavailable 503,
 *        GET /v1/models from synced catalog
 *   4. provider factory shape
 *
 * No network beyond 127.0.0.1; no real credentials. Usage:
 *   node scripts/verify-trae-provider.mjs
 */

import { createServer, request as httpRequest } from 'node:http'
import { createHash, verify as cryptoVerify, createPublicKey } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { catalogToProfiles } from '../providers/trae/catalog.js'
import { buildChatRequest, createTraeStreamParser, createTraeGateway, cumulativeDelta, TRAE_APP_ID, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE } from '../providers/trae/gateway.js'
import { flattenQuery, buildRemoteCreateBody, createRemoteEventParser, createRemoteSession } from '../providers/trae/remote.js'
import { normalizeTraeError, formatTraeErrorMessage } from '../providers/trae/errors.js'
import { createTraeProvider } from '../providers/trae/index.js'

let failures = 0
let checks = 0
function check(label, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 原生 http 客户端：fetch 的 Host 是 forbidden header 伪造不了——Host 门测试专用。
// 响应必须消费（踩坑 #29：不挂 data 监听流会 paused，'end' 永不派发）。
function rawRequest(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// mock api.trae.cn (OAuth + account)
// ---------------------------------------------------------------------------

function mockTraeAuth() {
  const state = {
    issued: [],           // {token, refreshToken}
    exchanges: [],        // every ExchangeToken request body (for assertions)
    registeredKeys: new Map(), // clientId -> SPKI base64 (from AuthCode exchange)
    userInfoCalls: [],
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      if (req.url === '/trae/api/v3/oauth/ExchangeToken' && req.method === 'POST') {
        state.exchanges.push(body)
        if (body.ClientID !== 'en1oxy7wnw8j9n' && body.ClientID !== 'ono9krqynydwx5') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'Invalid client.' } } }))
          return
        }
        if (body.AuthCode) {
          if (body.AuthCode !== 'test-auth-code') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: '无效参数：{__Message.field}.' } } }))
            return
          }
          if (!body.CodeVerifier || !body.DeviceInfo?.DevicePublicKey) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'missing PKCE/device fields' } } }))
            return
          }
          state.registeredKeys.set(body.ClientID, body.DeviceInfo.DevicePublicKey)
          const out = {
            Token: `tok-${state.issued.length + 1}`,
            RefreshToken: `rt-${state.issued.length + 1}`,
            TokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
            RefreshExpireAt: Math.floor(Date.now() / 1000) + 86400,
          }
          state.issued.push(out)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ Result: out }))
          return
        }
        if (body.RefreshToken) {
          // DeviceProof 验签：用 AuthCode 阶段注册的公钥验证 ECDSA P-256 签名。
          const spki = state.registeredKeys.get(body.ClientID)
          const proof = body.DeviceProof
          if (!spki || !proof) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10102', Message: 'device not registered' } } }))
            return
          }
          const stringToSign = ['POST', '/trae/api/v3/oauth/ExchangeToken', body.ClientID, body.RefreshToken, String(proof.Timestamp), proof.Nonce].join('\n')
          let ok = false
          try {
            ok = cryptoVerify('sha256', Buffer.from(stringToSign, 'utf8'), createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(proof.Signature, 'base64'))
          } catch { ok = false }
          if (!ok) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10103', Message: 'device proof signature invalid' } } }))
            return
          }
          const known = state.issued.some((i) => i.RefreshToken === body.RefreshToken)
          if (!known) {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10104', Message: 'refresh token invalid' } } }))
            return
          }
          const out = {
            Token: `tok-${state.issued.length + 1}`,
            RefreshToken: `rt-${state.issued.length + 1}`,
            TokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
            RefreshExpireAt: Math.floor(Date.now() / 1000) + 86400,
          }
          state.issued.push(out)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ Result: out }))
          return
        }
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'no AuthCode/RefreshToken' } } }))
        return
      }
      if (req.url === '/cloudide/api/v3/trae/GetUserInfo' && req.method === 'POST') {
        state.userInfoCalls.push(req.headers)
        const token = req.headers['x-cloudide-token']
        const latest = state.issued[state.issued.length - 1]
        if (!token || token !== latest?.Token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '20310', Message: 'The user is not logged in,' } } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Result: { Name: '测试用户', UserId: 'u-001' } }))
        return
      }
      res.writeHead(404)
      res.end('nf')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })
  }))
}

// ---------------------------------------------------------------------------
// mock Trae chat cloud (SSE)
// ---------------------------------------------------------------------------

function mockTraeRemote({ authedToken = 'tok-live', failFirstCreates = 0, hangCreate = false } = {}) {
  const state = { creates: [], events: 0, stops: 0 }
  const write = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.headers['authorization'] !== `Cloud-IDE-JWT ${authedToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1001, message: 'auth failed (mock)' }))
        return
      }
      if (req.method === 'POST' && url === '/api/remote/v1/chat_sessions') {
        // hangCreate：接受连接但永不回应（边缘/本地代理死态的真实形态，
        // 2026-08-24 故障取证 docs/diagnosis-trae-3003.md §8）
        if (hangCreate) { state.creates.push({ headers: req.headers, body: null }); return }
        // failFirstCreates：前 N 次 create 回**裸文本 404**（TLB 节点路由漂移的
        // 真实线缆形态，2026-08-24 故障取证 docs/diagnosis-trae-3003.md）
        if (state.creates.length < failFirstCreates) {
          state.creates.push({ headers: req.headers, body: null })
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('Not Found')
          return
        }
        state.creates.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { chat_session_id: 'sess-1', message_id: 'msg-1' }, message: 'success' }))
        return
      }
      if (req.method === 'GET' && url.startsWith('/api/remote/v1/chat_sessions/sess-1/events')) {
        state.events++
        // 事件语法 = 2026-08-24 真实流校准：
        // thought/reasoning_content 累计快照、finish 工具 params.summary、model_config、token_usage、done
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        write(res, 'status_changed', { chat_session_id: 'sess-1', new_status: 3, old_status: 2 })
        write(res, 'metadata', { message_id: 'm2', turn_id: 't2', session_id: 'sess-1', agent_type: 'solo_agent_remote' })
        write(res, 'model_config', { model_name: 'glm-5.3__dev', config_name: 'glm-5.3' })
        write(res, 'plan_item', { id: 'p1', thought: '', reasoning_content: '思', tool_call_info: { id: 'c1', name: '', params: null } })
        write(res, 'plan_item', { id: 'p1', thought: '你好', reasoning_content: '思考', tool_call_info: { id: 'c1', name: '', params: null } })
        write(res, 'plan_item', { id: 'p1', thought: '你好，世界', reasoning_content: '思考', tool_call_info: { id: 'c1', name: '', params: null } })
        write(res, 'token_usage', { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109 })
        write(res, 'plan_item', { id: 'p1', thought: '你好，世界', reasoning_content: '思考', tool_call_info: { id: 'c1', name: 'finish', params: { summary: '你好，世界' } } })
        write(res, 'done', { status: 'completed', user_message_context: { model_info: { config_name: 'glm-5.3' } } })
        res.end()
        return
      }
      if (req.method === 'POST' && url === '/api/remote/v1/chat_sessions/sess-1/stop') {
        state.stops++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })
  }))
}

// mock Trae chat cloud (SSE)
// ---------------------------------------------------------------------------

function mockTraeChat({ authedToken = 'tok-live', status = 200, withTools = false, sseError = null, hang = false, fnError = null, providerModel = 'kimi-k2.6' } = {}) {
  const state = { requests: [] }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      state.requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1001, message: "We're sorry, but we are not able to authenticate you." }))
        return
      }
      const token = req.headers['x-cloudide-token']
      const authz = req.headers['authorization']
      if (token !== authedToken || authz !== `Cloud-IDE-JWT ${authedToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1001, message: 'auth failed (mock)' }))
        return
      }
      // hang：一个字节都不发（比 sseError 更底层的死态——首字节护栏的靶子）
      if (hang) return
      // fnError：仅对指定 function 注入 3003（事故回退测试：inline 坏 / chat_v3 好）
      if (fnError) {
        const fn = (() => { try { return JSON.parse(raw)?.function } catch { return null } })()
        if (fn === fnError) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`event: error\ndata: ${JSON.stringify({ code: 3003, message: 'all models failed', extra: null })}\n\n`)
          res.write('event: done\ndata: {"finish_reason":"stop"}\n\n')
          res.end()
          return
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (sseError) {
        // 真实线缆形态（2026-08-24 inline 面 3003 故障取证）：HTTP 200 SSE 里直接
        // error 事件 + done，无 metadata/timing_cost——服务端连模型都没选出来
        res.write(`event: error\ndata: ${JSON.stringify(sseError)}\n\n`)
        res.write('event: done\n')
        res.write('data: {"finish_reason":"stop"}\n\n')
        res.end()
        return
      }
      if (withTools) {
        // 工具调用真实线缆形态（2026-08-24 带凭据实测）：
        // function_call 键 + arguments 增量片段 + 续片空 id + done 仍 finish_reason:"stop"
        const tcFirst = { index: 0, id: 'get_x_0', type: 'function', function_call: { name: 'get_x', arguments: '{"a":' } }
        const tcNext = { index: 0, id: '', type: '', function_call: { name: '', arguments: '1}' } }
        res.write('event: output\n')
        res.write(`data: ${JSON.stringify({ response: '我来查一下', tool_calls: null })}\n\n`)
        res.write('event: output\n')
        res.write(`data: ${JSON.stringify({ response: '', tool_calls: [tcFirst] })}\n\n`)
        res.write('event: output\n')
        res.write(`data: ${JSON.stringify({ response: '', tool_calls: [tcNext] })}\n\n`)
        res.write('event: token_usage\n')
        res.write(`data: ${JSON.stringify({ prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 })}\n\n`)
        res.write('event: done\n')
        res.write(`data: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
        res.end()
        return
      }
      // 事件语法 = 2026-08-24 带凭据联调校准形态（response/reasoning_content 为累计快照）
      res.write('event: metadata\n')
      res.write(`data: ${JSON.stringify({ model: '', session_id: 's', prompt_completion_id: 0 })}\n\n`)
      res.write('event: timing_cost\n')
      res.write(`data: ${JSON.stringify({ name: 'llm_raw_chat_v2', provider_model_name: providerModel })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好', reasoning_content: null })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好，', reasoning_content: '思' })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好，世界', reasoning_content: '思' })}\n\n`)
      res.write('event: token_usage\n')
      res.write(`data: ${JSON.stringify({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })}\n\n`)
      res.write('event: done\n')
      res.write(`data: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })
  }))
}

// ---------------------------------------------------------------------------
// fixture state.vscdb for the catalog
// ---------------------------------------------------------------------------

function buildCatalogFixture(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const payload = {
    solo_agent_lite: [
      {
        config_name: 'glm-5.3', name: 'glm-5.3', display_name: 'GLM-5.3', provider: '',
        model_type: 'reasoning_model', multimodal: false, prompt_max_tokens: 936000,
        max_tokens: 64000, max_turn: 500, context_window_size: { default: 200000, max: [1000000] },
        is_preset: true, selectable: true, status: true, fee_model_level: 2,
      },
      {
        config_name: 'kimi-k3', name: 'kimi-k3', display_name: 'Kimi-K3', provider: '',
        model_type: 'chat_model', multimodal: true, prompt_max_tokens: 936000,
        max_tokens: 64000, max_turn: 500, context_window_size: { default: null, max: [500000] },
        is_preset: true, selectable: true, status: true,
      },
      {
        config_name: 'deepseek//deepseek-v4-pro', name: 'deepseek//deepseek-v4-pro', display_name: 'DeepSeek-V4-Pro',
        provider: 'deepseek', model_type: 'reasoning_model', multimodal: false, is_preset: false, selectable: true, status: true,
      },
      {
        config_name: 'dead-model', name: 'dead-model', display_name: 'Dead', provider: '',
        multimodal: false, is_preset: true, selectable: false, status: false,
      },
    ],
  }
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('111:AI.agent.model.model_list_map', JSON.stringify(payload))
  db.close()
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'verify-trae-provider-'))
const authPath = join(workDir, 'trae-auth.json')

try {
  // =========================================================================
  console.log('== OAuth 设备流（mock api.trae.cn）==')
  const mock = await mockTraeAuth()
  const settings = {
    traeAuthBaseURL: mock.base,
    traeLoginHost: 'https://login.example.test',
    traeChatBaseURL: 'http://127.0.0.1:1',
  }
  const store = { read: () => JSON.parse(readFileOr(authPath, '{}')) }
  const oauth = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })

  const started = await oauth.startOAuth(settings)
  check('startOAuth 返回授权页 URL', typeof started.authUrl === 'string' && started.authUrl.length > 0)
  const authUrl = new URL(started.authUrl)
  check('授权页路径与 host 正确', authUrl.pathname === '/authorization' && authUrl.hostname === 'login.example.test')
  check('PKCE method=S256 + challenge 存在', authUrl.searchParams.get('code_challenge_method') === 'S256' && (authUrl.searchParams.get('code_challenge') ?? '').length > 20)
  check('client_id 用 SOLO Lite 分支', authUrl.searchParams.get('client_id') === 'en1oxy7wnw8j9n')
  const cb = authUrl.searchParams.get('auth_callback_url')
  check('回调 URL 在 127.0.0.1 且路径 /authorize', cb != null && /^http:\/\/127\.0\.0\.1:\d+\/authorize$/.test(cb))
  check('设备双 id 已上 URL（machine_id/device_id，16 位首位非零——审计 [16] 形态锁）', (authUrl.searchParams.get('machine_id') ?? '').length === 64 && /^[1-9]\d{15}$/.test(authUrl.searchParams.get('device_id') ?? ''))

  // 模拟浏览器 302 回调
  const cbUrl = new URL(cb)
  cbUrl.search = '?' + new URLSearchParams({
    authCodeInfo: JSON.stringify({ AuthCode: 'test-auth-code' }),
    userInfo: JSON.stringify({ name: '测试用户' }),
    consoleHost: mock.base,
  }).toString()
  const cbRes = await fetch(cbUrl)
  check('回调应答 200 成功页', cbRes.status === 200 && (await cbRes.text()).includes('登录成功'))
  await sleep(150) // 回调内后续写入

  const authAfter = store.read()
  check('令牌与刷新令牌落盘', authAfter.auth?.accessToken === 'tok-1' && authAfter.auth?.refreshToken === 'rt-1')
  check('账号信息落盘（GetUserInfo）', authAfter.account?.nickname === '测试用户' && authAfter.account?.uid === 'u-001')
  check('设备私钥持久化（P-256 PKCS8）', typeof authAfter.device?.privateKeyPem === 'string' && authAfter.device.privateKeyPem.includes('PRIVATE KEY'))

  const exchange = mock.state.exchanges[0]
  const challenge = authUrl.searchParams.get('code_challenge')
  const verifierMatch = createHash('sha256').update(exchange.CodeVerifier).digest('base64url') === challenge
  check('PKCE：code_challenge == SHA256(code_verifier)（base64url）', verifierMatch)
  check('DeviceInfo 公钥形态（SPKI base64，P-256 长度档）', typeof exchange.DeviceInfo?.DevicePublicKey === 'string' && exchange.DeviceInfo.DevicePublicKey.length > 100 && exchange.DeviceInfo.PlatformCode === 'SOLO_PC')

  const cred = await oauth.resolveTraeCredential(settings)
  check('resolveTraeCredential 双头形态', cred?.authorization === 'Cloud-IDE-JWT tok-1' && cred?.headers?.['x-cloudide-token'] === 'tok-1' && cred?.headers?.['X-User-Region'] === 'CN')

  // 刷新：把过期时间拨到过去，resolve 应自动走 DeviceProof 刷新并被 mock 验签通过
  const st = store.read()
  st.auth.expiresAt = Date.now() - 1000
  writeFileSync(authPath, JSON.stringify(st))
  const cred2 = await oauth.resolveTraeCredential(settings)
  check('临期自动刷新拿到新令牌（DeviceProof 验签通过）', cred2?.authorization === 'Cloud-IDE-JWT tok-2')
  check('刷新模式请求带 DeviceProof 三件套', (() => {
    const r = mock.state.exchanges[mock.state.exchanges.length - 1]
    return r?.RefreshToken === 'rt-1' && r?.DeviceProof?.Signature && r?.DeviceProof?.Nonce?.length === 32 && Number.isInteger(r?.DeviceProof?.Timestamp)
  })())
  check('oauthStatus 视图（不泄露令牌/私钥）', (() => {
    const v = oauth.oauthStatus()
    const s = JSON.stringify(v)
    return v.signedIn === true && v.account?.nickname === '测试用户' && !s.includes('tok-2') && !s.includes('PRIVATE KEY')
  })())

  // 登出：清令牌、保设备
  oauth.logout()
  const afterLogout = store.read()
  check('登出清令牌保设备身份', afterLogout.auth == null && afterLogout.device?.privateKeyPem != null)

  // 坏 AuthCode 路径
  const oauth2 = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })
  const s2 = await oauth2.startOAuth(settings)
  const cb2 = new URL(new URL(s2.authUrl).searchParams.get('auth_callback_url'))
  cb2.search = '?' + new URLSearchParams({ authCodeInfo: JSON.stringify({ AuthCode: 'bogus' }) }).toString()
  await fetch(cb2)
  await sleep(150)
  check('坏 AuthCode → pending.error 记录、无令牌', oauth2.oauthStatus().error.includes('10101') && !oauth2.oauthStatus().signedIn)

  // XSS 回归锁（审计 [10]/[15]/[21]/[24]）：回调 query 的 error_code/error_msg
  // 是外部输入，进 text/html 失败页前必须转义——不能出现原始 <script>/<img> 标签。
  const oauthX = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })
  const sx = await oauthX.startOAuth(settings)
  const cbX = new URL(new URL(sx.authUrl).searchParams.get('auth_callback_url'))
  cbX.search = '?' + new URLSearchParams({ error_code: '<script>', error_msg: '<img src=x onerror=alert(1)>' }).toString()
  const xssRes = await fetch(cbX)
  const xssBody = await xssRes.text()
  check('登录失败页 XSS 转义：query 参数不进原始 HTML',
    xssRes.status === 200 && xssBody.includes('&lt;script&gt;') && xssBody.includes('&lt;img src=x onerror=alert(1)&gt;')
    && !xssBody.includes('<script>') && !xssBody.includes('<img'))

  // 安全审计回归锁：traeLoginHost 基址门禁 + authUrl 解析构造
  // （providers/trae/oauth.js startOAuth——手改设置文件塞进 javascript: 之类
  // 非法基址时，必须在开回环服务之前响亮失败，而不是拼出可执行授权页 URL
  // 直送浏览器导航；URL 拼接改 new URL() 路径绝对引用，杜绝 //authorization
  // 双斜杠与基址路径串联）。
  const oauth3 = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })
  let gateErr = null
  await oauth3.startOAuth({ ...settings, traeLoginHost: 'javascript:alert(document.domain)' })
    .catch((e) => { gateErr = e.message })
  check('traeLoginHost=javascript: 在 listen 前被拒（scheme 门）',
    gateErr === 'traeLoginHost 必须使用 http 或 https', gateErr)
  let gateErr2 = null
  await oauth3.startOAuth({ ...settings, traeLoginHost: '::not-a-url::' })
    .catch((e) => { gateErr2 = e.message })
  check('traeLoginHost 非法 URL 被拒（解析门）',
    gateErr2 === 'traeLoginHost 不是合法 URL', gateErr2)
  const s3 = await oauth3.startOAuth({ ...settings, traeLoginHost: 'https://login.example.test/prefix/' })
  const u3 = new URL(s3.authUrl)
  check('authUrl 解析构造：路径绝对引用（无 //authorization、无基址路径串联）',
    u3.hostname === 'login.example.test' && u3.pathname === '/authorization'
      && !s3.authUrl.includes('//authorization'),
    s3.authUrl)
  // 收尾：驱动一次坏回调关闭回环服务（不遗留监听句柄）
  const cb3 = new URL(new URL(s3.authUrl).searchParams.get('auth_callback_url'))
  cb3.search = '?' + new URLSearchParams({ authCodeInfo: JSON.stringify({ AuthCode: 'bogus' }) }).toString()
  await fetch(cb3)
  await sleep(150)

  mock.server.closeAllConnections?.()
  mock.server.close()

  // =========================================================================
  console.log('== 目录（fixture state.vscdb）==')
  const dbPath = join(workDir, 'state.vscdb')
  buildCatalogFixture(dbPath)
  const traeRuntime = { running: false, port: null, lastError: null }
  const meterCalls = []
  const traeProvider = createTraeProvider({
    readAuth: () => ({}),
    writeAuth: () => {},
    settings: () => settings,
    withCredentials: async () => ({ cred: null, res: null, err: null }),
    meter: { record: (r) => meterCalls.push(r) },
    runtime: traeRuntime,
  })
  const sync1 = await traeProvider.syncCatalog({ dbPath })
  check('syncCatalog 成功（2 个可路由模型）', sync1.ok === true && sync1.count === 2, JSON.stringify(sync1))
  const view = traeProvider.catalogView()
  const ids = traeProvider.catalogIds()
  check('BYOK 条目被排除（deepseek//…）', !ids.includes('deepseek//deepseek-v4-pro'))
  check('禁用条目被排除（dead-model）', !ids.includes('dead-model'))
  const glm = view.profiles.find((p) => p.id === 'glm-5.3')
  const kimi = view.profiles.find((p) => p.id === 'kimi-k3')
  check('profile 字段映射（ctx/maxTokens/多模态）', glm.contextWindow === 200000 && glm.maxTokens === 64000 && !glm.input && kimi.input[1] === 'image')
  check('ctx 缺失回落 max 数组最大档', kimi.contextWindow === 500000)
  check('目录指纹进 view（不泄露 key）', typeof view.candidate === 'string' && view.candidate.startsWith('sha256:'))

  // catalogToProfiles 纯函数：空目录安全
  check('catalogToProfiles 容忍空输入', catalogToProfiles(null).length === 0 && catalogToProfiles({ models: [] }).length === 0)

  // =========================================================================
  console.log('== 翻译网关（mock Trae 云端 SSE）==')
  const chatMock = await mockTraeChat()
  const gwSettings = () => ({ ...settings, traeChatBaseURL: chatMock.base, maxConcurrentPerSession: 4 })
  const cred3 = { authorization: 'Cloud-IDE-JWT tok-live', headers: { 'x-cloudide-token': 'tok-live', 'X-User-Region': 'CN' } }
  const gateway = createTraeGateway({
    settings: gwSettings,
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => ({ deviceId: '123', machineId: 'abc', deviceBrand: 'b', deviceCpu: 'c', osVersion: 'v' }),
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: (r) => meterCalls.push(r) },
    runtime: traeRuntime,
    getCatalogIds: () => ids,
  })
  const stop = gateway.listen(0)
  await sleep(80) // listening 事件异步回填 runtime.port
  const gwPort = traeRuntime.port
  check('网关监听临时端口', traeRuntime.running === true && gwPort > 0)

  // Host 门回归锁（审计 [9]）：仅回环 Host 可达网关——非回环 Host 403 且不触上游；
  // 白名单放行形态不误伤（fetch 伪造不了 Host，走原生 http 客户端）。
  const evilHost = await rawRequest(gwPort, '/v1/models', { headers: { Host: 'evil.example.com' } })
  check('Host 门：非回环 Host → 403', evilHost.status === 403, `status=${evilHost.status}`)
  const ipv6Host = await rawRequest(gwPort, '/v1/models', { headers: { Host: '[::1]' } })
  check('Host 门：回环白名单 Host（[::1]）正常放行', ipv6Host.status === 200 && (() => { try { return JSON.parse(ipv6Host.body).object === 'list' } catch { return false } })())

  // 流式
  const streamRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }),
  })
  const streamText = await streamRes.text()
  const sseLines = streamText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  let assembled = ''
  let reasoning = ''
  let streamUsage = null
  let sawDone = false
  for (const line of sseLines) {
    if (line === '[DONE]') { sawDone = true; continue }
    const c = JSON.parse(line)
    if (c.choices?.[0]?.delta?.content) assembled += c.choices[0].delta.content
    if (c.choices?.[0]?.delta?.reasoning_content) reasoning += c.choices[0].delta.reasoning_content
    if (c.usage) streamUsage = c.usage
    if (c.choices?.[0]?.finish_reason) check('流式 finish_reason=stop', c.choices[0].finish_reason === 'stop')
  }
  check('流式：SSE 200 且 OpenAI chunk 形态', streamRes.status === 200 && sseLines.length >= 4)
  check('流式：文本增量拼接（你好，世界，无改派通知混入）', assembled === '你好，世界')
  check('流式：reasoning_content 透传不混入正文', reasoning === '思')
  check('流式：usage 进末块 + [DONE] 收尾', streamUsage?.total_tokens === 13 && sawDone)
  check('模型改派：SSE 注释行 + 计量记真实模型（timing_cost.provider_model_name）',
    streamText.includes(': trae-reroute requested=glm-5.3 actual=kimi-k2.6')
    && meterCalls.some((m) => m.model === 'kimi-k2.6' && m.usage?.total_tokens === 13))
  const outbound = chatMock.state.requests[0]
  check('出站头：三头同 JWT + IDE 指纹 + 设备头', outbound.headers['authorization'] === 'Cloud-IDE-JWT tok-live'
    && outbound.headers['x-cloudide-token'] === 'tok-live' && outbound.headers['x-ide-token'] === 'tok-live'
    && outbound.headers['x-app-id'] === TRAE_APP_ID
    && outbound.headers['x-ide-version'] === TRAE_IDE_VERSION && outbound.headers['x-ide-version-code'] === TRAE_IDE_VERSION_CODE
    && typeof outbound.headers['x-request-id'] === 'string'
    && outbound.headers['x-device-id'] === '123' && outbound.headers['x-machine-id'] === 'abc'
    && outbound.headers['x-uid'] === 'u-001')
  check('出站路径 = /api/agent/v3/llm_utils_chat', outbound.url === '/api/agent/v3/llm_utils_chat')
  check('出站信封：model/function/session_id/request_id + content 块化保留 system 角色',
    outbound.body.model === 'glm-5.3' && outbound.body.function === 'inline_chat' && outbound.body.stream === true
    && outbound.body.messages[0].role === 'system'
    && outbound.body.messages[1].content?.[0]?.type === 'text' && outbound.body.messages[1].content[0].text === 'hi'
    && typeof outbound.body.session_id === 'string' && typeof outbound.body.request_id === 'string')

  // 非流式聚合
  const aggRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const agg = await aggRes.json()
  check('非流式：聚合 chat.completion JSON', aggRes.status === 200 && agg.object === 'chat.completion' && agg.choices[0].message.content === '你好，世界' && agg.choices[0].finish_reason === 'stop')

  // /models 端点
  const modelsRes = await fetch(`http://127.0.0.1:${gwPort}/v1/models`)
  const modelsBody = await modelsRes.json()
  check('GET /v1/models 回目录清单', modelsRes.status === 200 && modelsBody.data?.length === 2 && modelsBody.data[0].object === 'model')

  // 上游 401 映射
  const unauthMock = await mockTraeChat({ authedToken: 'wrong' })
  const gwSettings2 = () => ({ ...settings, traeChatBaseURL: unauthMock.base, maxConcurrentPerSession: 4 })
  const rt2 = { running: false, port: null, lastError: null }
  const gateway2 = createTraeGateway({
    settings: gwSettings2,
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    meter: { record: () => {} },
    runtime: rt2,
    getCatalogIds: () => [],
  })
  const stop2 = gateway2.listen(0)
  await sleep(80)
  const errRes = await fetch(`http://127.0.0.1:${rt2.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const errBody = await errRes.json()
  check('上游 401 → 401 + code 透传', errRes.status === 401 && String(errBody.error?.code) === '1001')
  stop2()
  unauthMock.server.closeAllConnections?.()
  unauthMock.server.close()

  // 凭据不可用 → 503
  const rt3 = { running: false, port: null, lastError: null }
  const gateway3 = createTraeGateway({
    settings: gwSettings,
    withCredentials: async () => {
      const e = new Error('Trae 凭据不可用')
      e.credentialUnavailable = true
      return { cred: null, res: null, err: e }
    },
    readAuthDevice: () => null,
    meter: { record: () => {} },
    runtime: rt3,
    getCatalogIds: () => [],
  })
  const stop3 = gateway3.listen(0)
  await sleep(80)
  const noCredRes = await fetch(`http://127.0.0.1:${rt3.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const noCredBody = await noCredRes.json()
  check('凭据不可用 → 503 + 稳定文案', noCredRes.status === 503 && noCredBody.error?.message.includes('Trae 凭据不可用'))
  stop3()

  // 坏 payload
  const badRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  })
  check('坏 payload → 400', badRes.status === 400)

  // 工具调用：真实线缆形态（function_call 键 + arguments 增量片段 + done 映射 tool_calls）
  const toolMock = await mockTraeChat({ authedToken: 'tok-live', withTools: true })
  const rt4 = { running: false, port: null, lastError: null }
  const gateway4 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: toolMock.base, maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    meter: { record: () => {} },
    runtime: rt4,
    getCatalogIds: () => [],
  })
  const stop4 = gateway4.listen(0)
  await sleep(80)
  const tcRes = await fetch(`http://127.0.0.1:${rt4.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: '查一下' }],
      tools: [{ type: 'function', function: { name: 'get_x', parameters: { type: 'object' } } }],
    }),
  })
  const tcText = await tcRes.text()
  const tcLines = tcText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  let tcArgs = ''
  let tcMeta = null
  let tcFinish = null
  for (const line of tcLines) {
    if (line === '[DONE]') continue
    const c = JSON.parse(line)
    const d = c.choices?.[0]?.delta
    if (d?.tool_calls?.[0]) {
      if (d.tool_calls[0].id) tcMeta = d.tool_calls[0]
      tcArgs += d.tool_calls[0].function?.arguments ?? ''
    }
    if (c.choices?.[0]?.finish_reason) tcFinish = c.choices[0].finish_reason
  }
  check('工具调用流式：增量片段拼回完整参数', tcArgs === '{"a":1}' && tcMeta?.id === 'get_x_0' && tcMeta.function?.name === 'get_x')
  check('工具调用流式：finish_reason 映射为 tool_calls', tcFinish === 'tool_calls')
  check('工具调用出站：parameters 已序列化为字符串', typeof toolMock.state.requests[0]?.body?.tools?.[0]?.function?.parameters === 'string')
  const tcAggRes = await fetch(`http://127.0.0.1:${rt4.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '查一下' }] }),
  })
  const tcAgg = await tcAggRes.json()
  check('工具调用非流式：message.tool_calls 聚合 + finish 映射',
    tcAgg.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments === '{"a":1}'
    && tcAgg.choices[0].finish_reason === 'tool_calls')
  stop4()
  toolMock.server.closeAllConnections?.()
  toolMock.server.close()

  check('计量：非流式请求也记录（真实模型口径）', meterCalls.filter((m) => m.usage?.total_tokens === 13).length >= 2)
  stop()
  chatMock.server.closeAllConnections?.()
  chatMock.server.close()

  // SSE 注释行清洗回归锁（审计 [20]）：上游 provider_model_name 带 \r\n 时，
  // reroute 注释行必须折叠为单行——不能在响应流里伪造 SSE 帧。
  const injectMock = await mockTraeChat({ authedToken: 'tok-live', providerModel: 'evil\ndata: {"injected":true}\n\n' })
  const rtInj = { running: false, port: null, lastError: null }
  const gatewayInj = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: injectMock.base, maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: () => {} },
    runtime: rtInj,
    getCatalogIds: () => [],
  })
  const stopInj = gatewayInj.listen(0)
  await sleep(80)
  const injRes = await fetch(`http://127.0.0.1:${rtInj.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const injText = await injRes.text()
  check('SSE 清洗：reroute 注释行折叠换行（注入载荷不成帧）',
    injRes.status === 200 && !injText.includes('{"injected":true}\n')
    && injText.includes(': trae-reroute requested=glm-5.3 actual=evil data: {"injected":true} \n\n'),
    injText.split('\n').find((l) => l.startsWith(': trae-reroute')) ?? '(no reroute line)')
  check('SSE 清洗：流本体不受影响（[DONE] 正常收尾）', injText.includes('data: [DONE]'))
  stopInj()
  injectMock.server.closeAllConnections?.()
  injectMock.server.close()

  // =========================================================================
  console.log('== remote 传输（chat_sessions，mock remote 云端）==')
  const remoteMock = await mockTraeRemote()
  const rt5 = { running: false, port: null, lastError: null }
  const meterRemote = []
  const gateway5 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: remoteMock.base, traeChatTransport: 'remote', maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: (r) => meterRemote.push(r) },
    runtime: rt5,
    getCatalogIds: () => ids,
  })
  const stop5 = gateway5.listen(0)
  await sleep(80)

  // 流式
  const rStream = await fetch(`http://127.0.0.1:${rt5.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3', stream: true,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'prev' }, { role: 'user', content: 'again' }],
    }),
  })
  const rStreamText = await rStream.text()
  const rLines = rStreamText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  let rAssembled = ''
  let rReasoning = ''
  let rUsage = null
  let rFinish = null
  for (const line of rLines) {
    if (line === '[DONE]') continue
    const c = JSON.parse(line)
    if (c.choices?.[0]?.delta?.content) rAssembled += c.choices[0].delta.content
    if (c.choices?.[0]?.delta?.reasoning_content) rReasoning += c.choices[0].delta.reasoning_content
    if (c.usage) rUsage = c.usage
    if (c.choices?.[0]?.finish_reason) rFinish = c.choices[0].finish_reason
  }
  check('remote 流式：SSE 200 + 文本差分拼接（无重复、summary 不追加——thought 已覆盖）',
    rStream.status === 200 && rAssembled === '你好，世界')
  check('remote 流式：reasoning_content 独立透传', rReasoning === '思考')
  check('remote 流式：usage 进末块 + finish=stop', rUsage?.total_tokens === 109 && rFinish === 'stop')
  const rCreate = remoteMock.state.creates[0]
  check('remote 出站：chat_sessions 创建体（model_name 透传 + manual 策略 + query 扁平化角色标记）',
    rCreate.body.initial_message.model_name === 'glm-5.3'
    && rCreate.body.initial_message.model_selection_strategy === 'manual'
    && rCreate.body.initial_message.agent_type === 'solo_agent_remote'
    && rCreate.body.initial_message.content.length === 0
    && rCreate.body.initial_message.query.includes('[System]\\nsys')
    && rCreate.body.initial_message.query.includes('[Assistant]\\nprev')
    && rCreate.body.mode === 'code' && rCreate.body.origin === 'web')
  check('remote 出站：web 头组（Cloud-IDE-JWT + web client 指纹 + Origin）',
    rCreate.headers['authorization'] === 'Cloud-IDE-JWT tok-live'
    && rCreate.headers['x-trae-client-type'] === 'web'
    && rCreate.headers['origin'] === 'https://solo.trae.cn')
  check('remote 计量：记 model_config 的真实模型', meterRemote.some((m) => m.model === 'glm-5.3' && m.usage?.total_tokens === 109))

  // 非流式聚合
  const rAgg = await fetch(`http://127.0.0.1:${rt5.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const rAggBody = await rAgg.json()
  check('remote 非流式：聚合 chat.completion（content 来自 thought 差分）',
    rAgg.status === 200 && rAggBody.choices?.[0]?.message?.content === '你好，世界' && rAggBody.choices[0].finish_reason === 'stop')

  // tools 明确拒绝
  const rTools = await fetch(`http://127.0.0.1:${rt5.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f' } }] }),
  })
  const rToolsBody = await rTools.json()
  check('remote 带 tools → 400 remote-no-tools（不静默降级）', rTools.status === 400 && rToolsBody.error?.code === 'remote-no-tools')

  await sleep(50) // stop_session 是 finally 里的 best-effort
  check('remote 善后：stop_session 已调用', remoteMock.state.stops >= 2)
  stop5()
  remoteMock.server.closeAllConnections?.()
  remoteMock.server.close()

  // remote 单元：flattenQuery / buildRemoteCreateBody / 解析器边界
  const fq = flattenQuery([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1', tool_calls: [{ id: 'c1', function: { name: 'run', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'run', content: 'R1' },
    { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
  ])
  check('flattenQuery：角色标记 + 工具历史文本化',
    fq.includes('[System]\\nS') && fq.includes('[Assistant]\\nA1') && fq.includes('[Client Tool Call: c1 run]')
    && fq.includes('[Client Tool Result: c1 run]\\nR1') && fq.includes('[Assistant]\\nA2'))
  const rbody = buildRemoteCreateBody('kimi-k3', [{ role: 'user', content: 'x' }])
  check('buildRemoteCreateBody：信封形态', rbody.initial_message.model_name === 'kimi-k3'
    && rbody.initial_message.model_selection_strategy === 'manual' && rbody.env === 'remote'
    && typeof rbody.initial_message.common_params === 'string')
  const rp = createRemoteEventParser()
  rp.handle('plan_item', { id: 'p1', thought: '', reasoning_content: 'r', tool_call_info: { name: '', params: null } })
  rp.handle('plan_item', { id: 'p1', thought: '', reasoning_content: 'r', tool_call_info: { name: 'finish', params: { summary: '最终答复' } } })
  const rpDone = rp.handle('done', { status: 'completed', user_message_context: { model_info: { config_name: 'kimi-k3' } } })
  check('remote 解析器：thought 全空时 finish summary 兜底为正文', rpDone.text === '最终答复' && rpDone.finish === 'stop'
    && rp.actualModel() === 'kimi-k3' && rp.finalText() === '最终答复')
  const rp2 = createRemoteEventParser()
  rp2.handle('plan_item', { id: 'p1', thought: '部分', reasoning_content: '', tool_call_info: null })
  rp2.handle('plan_item', { id: 'p1', thought: '部分文本', reasoning_content: '', tool_call_info: { name: 'finish', params: { summary: '部分文本' } } })
  const rp2Done = rp2.handle('done', { status: 'completed' })
  check('remote 解析器：thought 已覆盖 summary 时不重复追加', rp2Done.text === undefined && rp2Done.finish === 'stop' && rp2.finalText() === '部分文本')
  const rp3 = createRemoteEventParser()
  const rp3a = rp3.handle('queuing', { position: 1 })
  const rp3b = rp3.handle('notification', { content: 'x' })
  check('remote 解析器：排队提示只报一次', rp3a.queue === true && Object.keys(rp3b).length === 0)
  const rp4 = createRemoteEventParser()
  const rp4e = rp4.handle('error', { code: 4011, message: 'rate limited' })
  check('remote 解析器：error 事件终结', rp4e.error?.code === 4011 && rp4.isDone())

  // =========================================================================
  console.log('== 单元：信封与事件解析 ==')
  const { body: envBody, requestId: envReqId } = buildChatRequest({
    model: 'm1', max_tokens: 64, temperature: 0.5,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url' }] }],
  }, 'conv-1')
  check('buildChatRequest：content 块化 + function/stream + 生成参数透传',
    envBody.messages[0].content?.length === 1 && envBody.messages[0].content[0].type === 'text' && envBody.messages[0].content[0].text === 'a'
    && envBody.model === 'm1' && envBody.session_id === 'conv-1' && envBody.function === 'inline_chat' && envBody.stream === true
    && envBody.max_tokens === 64 && envBody.temperature === 0.5 && typeof envBody.request_id === 'string' && envReqId === envBody.request_id)
  check('buildChatRequest：默认模型 + tool 角色原生透传',
    buildChatRequest({ messages: [] }, 's').body.model === 'glm-5.3'
    && buildChatRequest({ messages: [{ role: 'tool', tool_call_id: 'c1', content: 'out' }] }, 's').body.messages[0].tool_call_id === 'c1')
  const envTools = buildChatRequest({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
  }, 's')
  check('buildChatRequest：tools.function.parameters 序列化为字符串（Go string 型）',
    typeof envTools.body.tools[0].function.parameters === 'string'
    && JSON.parse(envTools.body.tools[0].function.parameters).type === 'object'
    && envTools.body.tools[0].function.name === 'f')

  // createTraeStreamParser：累计快照差分 / 思考 / 用量 / 排队 / 工具 / 终结
  const p = createTraeStreamParser()
  const pa = p.handle('output', { response: '你好', reasoning_content: '思' })
  const pb = p.handle('output', { response: '你好，世界', reasoning_content: '思考' })
  check('流解析：累计快照前缀差分', pa.text === '你好' && pb.text === '，世界' && pa.reasoning === '思' && pb.reasoning === '考')
  p.handle('token_usage', { prompt_tokens: 16, completion_tokens: 19, total_tokens: 35 })
  check('流解析：token_usage 顶层计数', p.usage()?.total_tokens === 35)
  const pq1 = p.handle('request_wait_in_queue', { position: 2 })
  const pq2 = p.handle('request_wait_in_queue', { position: 2 })
  check('流解析：排队位置变化才报', pq1.queue === 2 && Object.keys(pq2).length === 0)
  const pt = p.handle('output', { response: '你好，世界', tool_call_info: { id: 't1', name: 'fn', params: { a: 1 } } })
  check('流解析：tool_call_info 归一为 OpenAI 工具调用', pt.toolCall?.id === 't1' && pt.toolCall.name === 'fn' && pt.toolCall.argsDelta === '{"a":1}')
  const p2 = createTraeStreamParser()
  const frag1 = { index: 0, id: 'w_0', type: 'function', function_call: { name: 'get_current_weather', arguments: '{"city' } }
  const frag2 = { index: 0, id: '', type: '', function_call: { name: '', arguments: '": "北京"}' } }
  p2.handle('output', { tool_calls: [frag1] })
  const pc2 = p2.handle('output', { tool_calls: [frag2] })
  p2.handle('done', { finish_reason: 'stop' })
  check('流解析：tool_calls 增量片段按 index 拼接（续片空 id 不重复下发）',
    pc2.toolCall?.argsDelta === '": "北京"}' && pc2.toolCall.id === undefined
    && p2.toolCalls()[0].id === 'w_0' && p2.toolCalls()[0].function.arguments === '{"city": "北京"}'
    && p2.finish() === 'tool_calls')
  const pd = createTraeStreamParser()
  const pdOut = pd.handle('done', { finish_reason: 'stop' })
  check('流解析：done 终结语义', pdOut.finish === 'stop' && pd.isDone() === true && pd.finish() === 'stop')
  const pe = createTraeStreamParser().handle('error', { code: 1001, message: 'auth' })
  check('流解析：error 事件归一', pe.error?.code === 1001)
  check('cumulativeDelta：前缀差分/回退/纯增量三态', cumulativeDelta('abc', 'abcdef') === 'def'
    && cumulativeDelta('abc', 'ab') === '' && cumulativeDelta('', 'x') === 'x')
  const nerr = normalizeTraeError(400, { ResponseMetadata: { Error: { Code: '10101', Message: 'Invalid client.' } } })
  check('normalizeTraeError：火山信封/裸码/非 JSON 三态', nerr.code === '10101' && normalizeTraeError(401, { code: 1001 }).code === 1001 && normalizeTraeError(500, null).message === 'HTTP 500')
  check('normalizeTraeError：空 message 按码表回填（remote 1005 套餐门）',
    normalizeTraeError(200, { code: 1005, message: '', data: { plan: 1 } }).message.includes('entitlement'))

  // =========================================================================
  // 2026-08-24 "trae 3003 all models failed / PI_AI_ERROR" 故障定位的回归锁
  // （证据链与结论见 docs/diagnosis-trae-3003.md）
  console.log('== 错误语义与边缘韧性（3003 故障取证回归锁）==')
  check('formatTraeErrorMessage：已知码追加处置提示，未知码原样',
    formatTraeErrorMessage(3003, 'all models failed').includes('聊天传输')
    && formatTraeErrorMessage(9999, 'x') === 'trae 9999 x'
    && formatTraeErrorMessage(null, 'HTTP 403') === 'trae HTTP 403')

  const errMock = await mockTraeChat({ sseError: { code: 3003, message: 'all models failed', extra: null } })
  const rt6 = { running: false, port: null, lastError: null }
  const gateway6 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: errMock.base, maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: () => {} },
    runtime: rt6,
    getCatalogIds: () => ids,
  })
  const stop6 = gateway6.listen(0)
  await sleep(80)
  const eRes = await fetch(`http://127.0.0.1:${rt6.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k2.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const eText = await eRes.text()
  // 流式语义：SSE 头在消费上游前已发（恒 200），错误以流内 error 块 + [DONE] 终结
  const eLine = eText.split('\n').find((l) => l.startsWith('data:') && l.includes('3003'))
  check('inline SSE 3003：code 透传 + 处置提示进错误消息（用户可自助）',
    eRes.status === 200 && eText.includes('data: [DONE]')
    && !!eLine && JSON.parse(eLine.slice(5)).error?.code === 3003
    && String(JSON.parse(eLine.slice(5)).error?.message).includes('remote'))
  stop6()
  errMock.server.closeAllConnections?.()
  errMock.server.close()

  const skewMock = await mockTraeRemote({ failFirstCreates: 1 })
  const rt7 = { running: false, port: null, lastError: null }
  const gateway7 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: skewMock.base, traeChatTransport: 'remote', maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: () => {} },
    runtime: rt7,
    getCatalogIds: () => ids,
  })
  const stop7 = gateway7.listen(0)
  await sleep(80)
  const skRes = await fetch(`http://127.0.0.1:${rt7.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const skBody = await skRes.json()
  check('remote create 首次裸 404（节点漂移）：自动重试一次后成功',
    skRes.status === 200 && skBody.choices?.[0]?.message?.content === '你好，世界' && skewMock.state.creates.length === 2)
  stop7()
  skewMock.server.closeAllConnections?.()
  skewMock.server.close()

  const deadMock = await mockTraeRemote({ failFirstCreates: 99 })
  let deadErr = null
  try { await createRemoteSession(deadMock.base, 'tok-live', 'glm-5.3', [{ role: 'user', content: 'x' }]) } catch (e) { deadErr = e }
  check('remote create 持续裸 404：两次尝试后失败且文案带自愈指引',
    deadMock.state.creates.length === 2 && deadErr?.status === 404 && String(deadErr?.message).includes('边缘节点'))
  deadMock.server.closeAllConnections?.()
  deadMock.server.close()

  // 首字节/整体超时护栏（2026-08-24 本地代理死态实测，docs/diagnosis-trae-3003.md §8）
  const hangMock = await mockTraeChat({ hang: true })
  const rt8 = { running: false, port: null, lastError: null }
  const gateway8 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: hangMock.base, maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 400 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: () => {} },
    runtime: rt8,
    getCatalogIds: () => ids,
  })
  const stop8 = gateway8.listen(0)
  await sleep(80)
  const h0 = Date.now()
  const hRes = await fetch(`http://127.0.0.1:${rt8.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const hMs = Date.now() - h0
  const hBody = await hRes.json()
  check('inline 上游挂死：首字节护栏限时快速失败且文案带自助指引',
    hRes.status === 502 && hMs < 5000 && String(hBody.error?.message).includes('首字节超时') && hBody.error.message.includes('remote'))
  stop8()
  hangMock.server.closeAllConnections?.()
  hangMock.server.close()

  const hangRemote = await mockTraeRemote({ hangCreate: true })
  let hErr = null
  const rh0 = Date.now()
  try { await createRemoteSession(hangRemote.base, 'tok-live', 'glm-5.3', [{ role: 'user', content: 'x' }], { timeoutMs: 300 }) } catch (e) { hErr = e }
  check('remote create 挂死：整体限时失败且文案带指引（不再无限挂起）',
    Date.now() - rh0 < 5000 && !!hErr && /超时/.test(String(hErr?.message)) && String(hErr.message).includes('inline'))
  hangRemote.server.closeAllConnections?.()
  hangRemote.server.close()

  // 事故回退：inline_chat 3003 → 自动降级 chat_v3 出真实文本（诚实披露改派）
  const fbMock = await mockTraeChat({ fnError: 'inline_chat' })
  const rt9 = { running: false, port: null, lastError: null }
  const meterFb = []
  const gateway9 = createTraeGateway({
    settings: () => ({ ...settings, traeChatBaseURL: fbMock.base, maxConcurrentPerSession: 4 }),
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: (r) => meterFb.push(r) },
    runtime: rt9,
    getCatalogIds: () => ids,
  })
  const stop9 = gateway9.listen(0)
  await sleep(80)
  const fRes = await fetch(`http://127.0.0.1:${rt9.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const fBody = await fRes.json()
  check('inline 3003 事故回退：自动降级 chat_v3 拿到真实回答',
    fRes.status === 200 && fBody.choices?.[0]?.message?.content === '你好，世界')
  check('事故回退诚实披露：note 标注真实服务模型 + 计量记真实模型 + 两次上游调用',
    String(fBody.choices?.[0]?.message?.note ?? '').includes('served by kimi-k2.6')
    && String(fBody.choices?.[0]?.message?.note ?? '').includes('requested glm-5.3')
    && meterFb.some((m) => m.model === 'kimi-k2.6')
    && fbMock.state.requests.filter((r) => r.body?.function).length === 2)
  stop9()
  fbMock.server.closeAllConnections?.()
  fbMock.server.close()

} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readFileOr(path, fallback) {
  try { return readFileSync(path, 'utf8') } catch { return fallback }
}

console.log('')
if (failures) {
  console.log(`verify:trae-provider FAILED — ${failures}/${checks} 项断言未通过`)
  process.exit(1)
}
console.log(`verify:trae-provider OK — ${checks} 项断言全部通过`)
