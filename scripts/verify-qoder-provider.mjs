#!/usr/bin/env node
/**
 * verify-qoder-provider.mjs — Qoder CN 通道离线回归（mock 上游，断言响应完成）。
 *
 * 锁定的契约（证据 docs/reverse/qoder-cn.md）：
 *   [1] PKCE 形态：verifier 长度 43–128、charset 合法、challenge = base64url(SHA256)
 *   [2] normalizeExpiry 三形态（相对秒 / 绝对秒 / 绝对毫秒）
 *   [3] tokenFrom 双形态（poll 给 token，refresh 给 device_token）
 *   [4] 设备流快乐路径：404 pending ×N → 200 出令牌 → 落盘 + 账户信息
 *   [5] 授权 URL 形态 + 出宿主门禁（非 https / 域外 / javascript: 一律拒）
 *   [6] refresh 成功回写；失败置 needsRelogin
 *   [7] 临期自动刷新（resolveQoderCredential 内联）
 *   [8] logout 代际守卫：在飞 poll 拿到的迟到令牌不落盘
 *   [9] machine_id 自持且跨登录复用
 *   [10] 视图绝不外泄令牌与 machine_id
 *   [11] 轮询期网络抖动不判失败
 *   [15] 目录投影：context_config 变体表 → variants 清单 + contextWindow 覆盖纯函数
 *   [16] 出站补默认：prefs.effort（off=省略参数）+ profile.maxTokens，不覆盖客户端
 *   [17] qoderModelSetPrefs 全链路：文件层 → 镜像 → GET 契约（DSH_HOME 隔离起真组合根）
 */

import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  createQoderOAuth, createPkce, createMachineId, normalizeExpiry, QODER_CLIENT_ID,
} from '../providers/qoder/oauth.js'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── mock 上游 ──────────────────────────────────────────────────────────────
const mock = {
  pollScript: [],      // 每项：{status, body} 或 'netfail'
  pollHits: 0,
  refreshReply: null,  // {status, body}
  refreshHits: 0,
  refreshBodySeen: null,
  userinfo: null,      // {status, body}
  userinfoHits: 0,
  lastPollQuery: null,
}
const handlers = {
  'GET /api/v1/deviceToken/poll': (req, res, q) => {
    mock.pollHits++
    mock.lastPollQuery = Object.fromEntries(q)
    const step = mock.pollScript[Math.min(mock.pollHits - 1, mock.pollScript.length - 1)]
    if (step === 'netfail') { req.socket.destroy(); return }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body))
  },
  'POST /api/v1/deviceToken/refresh': async (req, res) => {
    mock.refreshHits++
    const raw = Buffer.concat(await collect(req)).toString('utf8')
    try { mock.refreshBodySeen = JSON.parse(raw) } catch { mock.refreshBodySeen = raw }
    const step = mock.refreshReply ?? { status: 200, body: { device_token: 'dt-new' } }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(step.body))
  },
  'GET /api/v1/userinfo': (req, res) => {
    mock.userinfoHits++
    const step = mock.userinfo ?? { status: 200, body: { uid: 'u-1', name: 'tester', email: 't@e.cn' } }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(step.body))
  },
}
const collect = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(chunks))
})
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const h = handlers[`${req.method} ${url.pathname}`]
  if (!h) { res.writeHead(404); res.end('{}'); return }
  Promise.resolve(h(req, res, url.searchParams)).catch(() => { res.writeHead(500); res.end() })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const SETTINGS = {
  qoderOpenapiBaseURL: BASE,
  qoderLoginHost: BASE,
  qoderClientId: QODER_CLIENT_ID,
}

// 文件层（真实 store，避免 mock 掉原子写纪律）
const { readJson, writeJson } = await import('../core/json-store.js')
const dir = mkdtempSync(join(tmpdir(), 'qoder-verify-'))
const AUTH_PATH = join(dir, 'qoder-plugin-auth.json')
let store = {}
const readAuth = () => store
const writeAuth = (v) => { store = v; writeJson(AUTH_PATH, v) }
const oauth = createQoderOAuth({ readAuth, writeAuth })

// ── [1] PKCE ───────────────────────────────────────────────────────────────
console.log('\n[1] PKCE 形态')
{
  const charset = /^[A-Za-z0-9\-._~]+$/
  let good = true, lenOk = true
  for (let i = 0; i < 60; i++) {
    const { verifier, challenge } = createPkce()
    if (verifier.length < 43 || verifier.length > 128) lenOk = false
    if (!charset.test(verifier)) good = false
    if (!/^[A-Za-z0-9_-]+$/.test(challenge)) good = false
    const expect = createHash('sha256').update(verifier).digest().toString('base64url')
    if (challenge !== expect) good = false
  }
  ok(lenOk, 'verifier 长度恒在 43–128')
  ok(good, 'charset 合法且 challenge=S256(verifier)')
  ok(new Set(Array.from({ length: 40 }, () => createPkce().verifier)).size === 40, 'verifier 逐次随机')
  ok(/^[0-9a-f]{48}$/.test(createMachineId()), 'machine_id = 48 hex')
}

// ── [2] 有效期归一 ─────────────────────────────────────────────────────────
console.log('\n[2] normalizeExpiry 三形态')
{
  const now = 1_700_000_000_000
  ok(normalizeExpiry(3600, now) === now + 3_600_000, '相对秒 → now+δ')
  ok(normalizeExpiry(1_700_001_000, now) === 1_700_001_000_000, '绝对秒 → ms')
  ok(normalizeExpiry(now + 5000, now) === now + 5000, '绝对毫秒原样')
  ok(normalizeExpiry('1700001000', now) === 1_700_001_000_000, '字符串数值也收')
  ok(normalizeExpiry(0, now) === null && normalizeExpiry(null, now) === null && normalizeExpiry('x', now) === null, '非法值 → null')
  // 2026-09-19 实测：expires_at 是 ISO 字符串（早先按数字解 → NaN → 落 0，令"永不过期
  // 但立即该刷新"，真实登录联调才暴露）
  ok(normalizeExpiry('2026-09-19T13:00:00Z') === Date.parse('2026-09-19T13:00:00Z'), 'ISO 字符串 → epoch ms')
  ok(normalizeExpiry('2026-09-19T13:00:00.000Z') === Date.parse('2026-09-19T13:00:00Z'), '带毫秒 ISO 也收')
  ok(normalizeExpiry('2026-09-19T13:00:00Z', now) > now, 'ISO 解析不再退化为 0')
}

// ── [5] 授权 URL 与门禁 ────────────────────────────────────────────────────
console.log('\n[5] 授权 URL 形态与出宿主门禁')
{
  const verdicts = []
  for (const host of ['https://evil.example', 'http://x.cn/', 'javascript:alert(1)', 'not a url', 'https://qoder.cn.evil.example']) {
    // startOAuth 是 async：门禁失败以 rejection 呈现（组合根 await + catch）。
    let r = '未拒'
    try { await createQoderOAuth({ readAuth, writeAuth }).startOAuth({ ...SETTINGS, qoderLoginHost: host }) }
    catch (e) { r = /必须使用 https|不在 Qoder 官方登录站点族|合法 URL/.test(e.message) ? '拒' : '意外:' + e.message }
    verdicts.push(`${host}:${r}`)
  }
  ok(verdicts.every((x) => x.endsWith('拒')), `门禁拒绝越域/非法基址/后缀伪装域（${verdicts.join(' | ')}）`)

  // 官方站点族必须放行（收紧不得把自己人挡掉）
  for (const host of ['https://qoder.cn', 'https://qoder.com.cn']) {
    const o = createQoderOAuth({ readAuth, writeAuth })
    const { authUrl } = await o.startOAuth({ ...SETTINGS, qoderLoginHost: host, qoderOpenapiBaseURL: BASE })
    ok(new URL(authUrl).origin === host, `官方域放行：${host}`)
    await o.logout()
  }
  // 门禁失败时不留副作用：不激活 pending、不写 machine_id
  {
    const o = createQoderOAuth({ readAuth: () => ({}), writeAuth: () => { throw new Error('不应发生写入') } })
    let threw = false
    try { await o.startOAuth({ ...SETTINGS, qoderLoginHost: 'https://evil.example' }) } catch { threw = true }
    ok(threw && o.oauthStatus().pending === false, '越域拒绝时不激活 pending 且不写盘')
  }

  mock.pollScript = [{ status: 404, body: { errorCode: 'NotFound' } }]
  const { authUrl } = await oauth.startOAuth(SETTINGS)
  const u = new URL(authUrl)
  ok(u.pathname === '/device/selectAccounts', '授权页路径 /device/selectAccounts')
  ok(u.searchParams.get('challenge_method') === 'S256', 'challenge_method=S256')
  ok(u.searchParams.get('client_id') === QODER_CLIENT_ID, 'client_id = prod uuid')
  ok(/^[A-Za-z0-9_-]{43,128}$/.test(u.searchParams.get('challenge')), 'challenge 为 b64url')
  ok(u.searchParams.get('machine_id')?.length === 48, 'machine_id 带上')
  await oauth.logout()
}

// ── [4][9] 设备流快乐路径 + machine_id 复用 ────────────────────────────────
console.log('\n[4] 设备流：404 pending → 200 出令牌；[9] machine_id 复用')
{
  const mid0 = oauth.ensureMachineId()
  mock.pollHits = 0
  mock.userinfoHits = 0
  mock.pollScript = [
    { status: 404, body: { errorCode: 'NotFound', errorMessage: 'Not found' } },
    { status: 404, body: { errorCode: 'NotFound' } },
    { status: 404, body: { errorCode: 'NotFound' } },
    { status: 200, body: { token: 'qt-access-1', refresh_token: 'drt-r-1', expires_at: 3600, refresh_token_expires_at: 86400 } },
  ]
  const { authUrl } = await oauth.startOAuth(SETTINGS)
  ok(oauth.oauthStatus().pending === true, 'pending 置位')
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  const st = oauth.oauthStatus()
  ok(st.signedIn === true, `登录落定（轮询 ${mock.pollHits} 次，authUrl 已给出）`, st.error)
  ok(st.pending === false, 'pending 收敛')
  ok(store.auth.accessToken === 'qt-access-1', 'accessToken 写入')
  ok(store.auth.refreshToken === 'drt-r-1', 'refreshToken 写入（drt- 前缀原样保留）')
  ok(Math.abs(store.auth.expiresAt - (Date.now() + 3_600_000)) < 20_000, 'expiresAt 由相对秒算出')
  ok(store.account?.uid === 'u-1' && store.account.nickname === 'tester', '账户信息拉取并入')
  ok(mock.userinfoHits === 1, 'userinfo 恰好一次')
  ok(mock.lastPollQuery?.challenge_method === 'S256' && /^[0-9a-f-]{36}$/.test(mock.lastPollQuery?.nonce ?? ''), 'poll 带 nonce/challenge_method')
  ok(mock.lastPollQuery?.verifier?.length >= 43, 'poll 带 verifier（授权页只有 challenge，轮询用全量）')
  ok(oauth.ensureMachineId() === mid0, 'machine_id 跨登录稳定')
  ok(new URL(authUrl).searchParams.get('machine_id') === mid0, '授权页 machine_id 与存储一致')
}

// ── [10] 视图不泄密 ─────────────────────────────────────────────────────────
console.log('\n[10] 视图字段脱敏')
{
  const v = oauth.oauthStatus()
  const flat = JSON.stringify(v) + JSON.stringify(Object.keys(v))
  ok(!flat.includes('qt-access-1') && !flat.includes('drt-r-1'), '令牌不在视图内')
  ok(!flat.includes(store.machine.machineId), 'machine_id 不在视图内')
  ok(v.accessTokenExpiresAt > Date.now(), '过期时间以 epoch 出视图')
}

// ── [7] 临期自动刷新 ────────────────────────────────────────────────────────
console.log('\n[7] 临期自动刷新')
{
  store.auth = { ...store.auth, expiresAt: Date.now() + 1000 } // 触发临期
  mock.refreshHits = 0
  mock.refreshReply = { status: 200, body: { device_token: 'qt-access-2', refresh_token: 'drt-r-2', expires_at: 7200 } }
  const cred = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred?.authorization === 'Bearer qt-access-2', '返回新令牌')
  ok(mock.refreshHits === 1, '刷新恰好一次')
  ok(mock.refreshBodySeen?.refresh_token === 'drt-r-2' || mock.refreshBodySeen?.refresh_token === 'drt-r-1', '请求体带 refresh_token')
  ok(/^[0-9a-f]{48}$/.test(mock.refreshBodySeen?.machine_id ?? ''), '请求体带 machine_id')
  ok(store.auth.accessToken === 'qt-access-2' && store.auth.refreshToken === 'drt-r-2', '新令牌对回写')
  ok(cred.uid === 'u-1' && cred.machineId === store.machine.machineId, 'cred 带 uid/machineId（/algo 面备用）')
  // 未临期不再刷新
  const h = mock.refreshHits
  await oauth.resolveQoderCredential(SETTINGS)
  ok(mock.refreshHits === h, '未临期不触发刷新')
}

// ── [6] refresh 失败 → needsRelogin ────────────────────────────────────────
console.log('\n[6] refresh 失败形态')
{
  store.auth = { ...store.auth, expiresAt: Date.now() + 1000 }
  const rExpiryBefore = store.auth.refreshExpiresAt
  mock.refreshReply = { status: 400, body: { errorCode: 'DeviceRefreshTokenPrefixInvalid', errorMessage: 'invalid refresh_token: must start with drt-' } }
  const cred = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred === null, '刷新失败不出凭据')
  ok(oauth.oauthStatus().needsRelogin === true, 'needsRelogin 置位（令牌在但已不可续）')
  mock.refreshReply = { status: 200, body: { device_token: 'qt-access-3', expires_at: 3600 } }
  const cred2 = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred2?.authorization === 'Bearer qt-access-3', '再刷新成功')
  ok(oauth.oauthStatus().needsRelogin === false, '刷新成功自愈')
  ok(store.auth.refreshToken === 'drt-r-2', '响应不带 refresh_token 时沿用旧值')
  ok(store.auth.refreshExpiresAt === rExpiryBefore, '响应不带 refresh 有效期时沿用旧值')
  ok(store.auth.loginMethod === 'browser', 'loginMethod 不被刷新丢弃')
}

// ── [8] logout 代际守卫 ─────────────────────────────────────────────────────
console.log('\n[8] logout 使在飞 poll 失效')
{
  writeAuth({ machine: store.machine }) // 清令牌，保留 machine
  mock.pollScript = [
    { status: 404, body: {} }, { status: 404, body: {} }, { status: 404, body: {} },
    { status: 404, body: {} }, { status: 404, body: {} },
    { status: 200, body: { token: 'late-token', expires_at: 3600 } },
  ]
  mock.pollHits = 0
  await oauth.startOAuth(SETTINGS)
  await sleep(700) // 让它进入轮询中
  await oauth.logout()
  const before = JSON.stringify(store)
  await sleep(2500) // 越过"迟到令牌"那一步
  ok(JSON.stringify(store) === before, 'logout 后迟到令牌未落盘')
  ok(!JSON.stringify(store).includes('late-token'), 'late-token 未进存储')
  ok(oauth.oauthStatus().pending === false, 'logout 后 pending 收敛')
}

// ── [11] 网络抖动容错 ───────────────────────────────────────────────────────
console.log('\n[11] 轮询期网络抖动不判失败')
{
  writeAuth({ machine: store.machine })
  mock.pollHits = 0
  mock.pollScript = ['netfail', 'netfail', { status: 200, body: { token: 'qt-net', expires_at: 3600 } }]
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  const st = oauth.oauthStatus()
  ok(st.signedIn === true, '抖动后仍完成登录')
  ok(st.error === '', `无错误残留（error=${st.error}）`)
  await oauth.logout()
}

// ── 非 JSON 404 与 400 业务码 ───────────────────────────────────────────────
console.log('\n[12] 失败形态：非 JSON / 业务错误码')
{
  writeAuth({ machine: store.machine })
  mock.pollHits = 0
  mock.pollScript = [{ status: 400, body: { errorCode: 'DeviceTokenVerifierRequired', errorMessage: 'verifier is required' } }]
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 30 && oauth.oauthStatus().pending; i++) await sleep(100)
  const st = oauth.oauthStatus()
  ok(st.signedIn === false, '400 不产出登录')
  ok(/DeviceTokenVerifierRequired/.test(st.error), `错误带业务码（${st.error}）`)
  await oauth.logout()

  mock.pollHits = 0
  mock.pollScript = [{ status: 404, body: '<html>nginx</html>' }]
  await oauth.startOAuth(SETTINGS)
  await sleep(1400)
  ok(oauth.oauthStatus().error === '' || oauth.oauthStatus().pending, '裸 HTML 404 不误判为失败')
  await oauth.logout()
}

// ── [13] 真实线缆形态回放锁（2026-09-19 真实登录捕获的 poll 响应键集）────────
console.log('\n[13] 真实 poll 响应形态回放')
{
  // 真机捕获键集：id, token, user_id, code_challenge, code_challenge_method, nonce,
  // expires_at, refresh_token_id, created_at, updated_at, refresh_token,
  // expires_in, refresh_token_expires_in, refresh_token_expires_at
  const real = {
    id: 'dt-abc', token: 'dt-realshape', user_id: '019efdac-1bf3-792a-a63d-1b94c1ea9fb0',
    code_challenge: 'x', code_challenge_method: 'S256', nonce: 'n-1',
    expires_at: new Date(Date.now() + 36e5).toISOString(), refresh_token_id: 'rtr-1',
    created_at: '2026-09-19T11:03:28.128Z', updated_at: '2026-09-19T11:03:28.128Z',
    refresh_token: 'drt-realshape', expires_in: 86400,
    refresh_token_expires_in: 2592000, refresh_token_expires_at: '2026-10-19T11:03:28.128Z',
  }
  writeAuth({ machine: { machineId: 'f'.repeat(48) } })
  mock.pollHits = 0
  mock.pollScript = [{ status: 200, body: real }]
  mock.userinfo = { status: 200, body: { id: real.user_id, name: 'aliyun1985984145' } }
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  ok(store.auth.accessToken === 'dt-realshape', 'dt- 设备令牌入库')
  ok(store.auth.refreshToken === 'drt-realshape', 'drt- 刷新令牌入库')
  ok(store.auth.expiresAt === Date.parse(real.expires_at), 'expires_at(ISO) 正确解析为 epoch', String(store.auth.expiresAt))
  ok(store.auth.expiresAt > Date.now(), '有效期落在未来（旧实现这里会写成 0）')
  ok(store.auth.refreshExpiresAt === Date.parse(real.refresh_token_expires_at), 'refresh_token_expires_at(ISO) 解析')
  ok(oauth.oauthStatus().account?.uid === real.user_id, 'uid 经 userinfo 补全（poll 只给 user_id）')
  ok(oauth.oauthStatus().needsRelogin === false, '新鲜登录不误报需重登')
  mock.userinfo = null
  await oauth.logout()
}

// ── [14] 翻译网关：真实 WASM 签名 + mock infer 上游（2026-09-20 打通的形态锁）──
console.log('\n[14] 翻译网关：COSY 信封 ↔ OpenAI 流式/非流式翻译')
{
  const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
  const { createQoderGateway } = await import('../providers/qoder/gateway.js')
  const { fileURLToPath } = await import('node:url')
  const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers', 'qoder', 'qoder_auth.wasm')

  // mock infer 上游：认 URL 形态（agent_chat_generation），回脚本化 SSE 信封
  let inferScript = 'normal'
  let inferBodySeen = null
  const infer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.endsWith('/algo/api/v2/service/pro/sse/agent_chat_generation')) {
      res.writeHead(404); res.end(); return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      inferBodySeen = Buffer.concat(chunks).toString('utf8')
      if (inferScript === 'http401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"unauthorized"}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (inferScript === 'errorframe') {
        res.end('event:error\ndata:{"stackTrace":[{"methodName":"x"}],"msgInfo":"boom"}\n\n')
        return
      }
      if (inferScript === 'failframe') {
        // 带内失败帧：HTTP 200 信封装业务错误（2026-09-22 实测 qfmodel 上游节点挂）
        res.end('data:' + JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body: '{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}', statusCodeValue: 400, statusCode: 'BAD_REQUEST' }) + '\n\n'
          + 'event:finish\n'
          + 'data:' + JSON.stringify({ firstTokenDuration: 1, totalDuration: 2, serverDuration: 2 }) + '\n\n')
        return
      }
      const chunk = (delta, extra = {}) => JSON.stringify({ choices: [{ delta, index: 0, ...(extra.finish ? { finish_reason: extra.finish } : {}) }], created: 1, id: 'c1', model: 'auto', object: 'chat.completion.chunk' })
      const env = (body) => `data:${JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body, statusCodeValue: 200, statusCode: 'OK' })}\n\n`
      const usageChunk = JSON.stringify({ choices: [], created: 1, id: 'c1', model: 'auto', object: 'chat.completion.chunk', usage: { billable: true, prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 0.5 } })
      res.end(
        env(chunk({ content: '你' }))
        + env(chunk({ content: '好' }, { finish: 'stop' }))
        + env(usageChunk)
        + env('[DONE]')
        + `data:${JSON.stringify({ firstTokenDuration: 1, totalDuration: 2, serverDuration: 2 })}\n\n`,
      )
    })
  })
  await new Promise((r) => infer.listen(0, '127.0.0.1', r))
  const inferOrigin = `http://127.0.0.1:${infer.address().port}`

  const metered = []
  const cosy = createCosyRuntime({ wasmPath })
  const runtime = { running: false, port: null, lastError: null }
  const gateway = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: inferOrigin, maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 5000 }),
    resolveCredential: async () => ({ authorization: 'Bearer dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }),
    cosy,
    meter: { record: (r) => metered.push(r) },
    runtime,
    forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [{ id: 'auto', name: 'Auto' }],
    getModelSource: () => 'system',
  })
  const stopGw = gateway.listen(0)
  for (let i = 0; i < 50 && !runtime.running; i++) await sleep(50)
  ok(runtime.running === true, '网关监听成功')
  const gw = `http://127.0.0.1:${runtime.port}`

  // 流式：信封 chunk 逐帧透传 + [DONE] 收尾 + usage.credits → credit 计量
  const resp = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const sseText = await resp.text()
  ok(resp.status === 200, '流式 200')
  ok(sseText.includes('"content":"你"') && sseText.includes('"content":"好"'), '内容增量逐帧透传')
  ok(sseText.includes('"finish_reason":"stop"'), 'finish_reason 透传')
  ok(sseText.trimEnd().endsWith('data: [DONE]'), '[DONE] 收尾')
  ok(inferBodySeen !== null && inferBodySeen.length > 0, '上游收到加密 body', String(inferBodySeen).slice(0, 40))
  ok(metered.length === 1 && metered[0].usage.credit === 0.5 && metered[0].usage.total_tokens === 12,
    '计量落盘且 credits→credit 归一', JSON.stringify(metered[0]?.usage))

  // 非流式：聚合成单个 chat.completion
  const resp2 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const agg = await resp2.json()
  ok(agg.object === 'chat.completion' && agg.choices[0].message.content === '你好', '非流式聚合正文')
  ok(agg.choices[0].finish_reason === 'stop' && agg.usage.total_tokens === 12, '非流式聚合 finish/usage')

  // 错误帧：流中段 error event → 错误 chunk + [DONE]
  inferScript = 'errorframe'
  const resp3 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const errSse = await resp3.text()
  ok(errSse.includes('"error"') && errSse.trimEnd().endsWith('data: [DONE]'), 'error 帧 → 错误 chunk + [DONE]')

  // 带内失败帧（HTTP 200 信封装业务错误，实测 qfmodel 上游节点挂的形态）→ 绝不静默空响应
  inferScript = 'failframe'
  const respF = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const failSse = await respF.text()
  ok(failSse.includes('qoder upstream error') && failSse.includes('oa_qwen-plus-main') && failSse.trimEnd().endsWith('data: [DONE]'), '带内失败帧 → 流式错误 chunk + [DONE]')
  const respF2 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const failJson = await respF2.json()
  ok(respF2.status === 502 && failJson.error.code === 'qoder_upstream_error' && /oa_qwen-plus-main/.test(failJson.error.message ?? ''),
    '带内失败帧 → 非流式 502 + 上游错误详情')
  inferScript = 'normal'

  // 上游 401 → 状态与错误码透传
  inferScript = 'http401'
  const resp4 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const err401 = await resp4.json()
  ok(resp4.status === 401 && err401.error.code === 'qoder_401', '上游 401 透传')
  inferScript = 'normal'

  // Host 门：非回环 Host 拒绝（fetch 会覆盖伪造 Host——必须原生客户端）
  const resp5 = await new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port: runtime.port, path: '/v1/models', method: 'GET', headers: { Host: 'evil.example.com' } }, (rs) => {
      rs.resume() // 消费响应（踩坑 #29：paused 流永不 close）
      rs.on('end', () => resolve({ status: rs.statusCode }))
    })
    r.on('error', reject)
    r.end()
  })
  ok(resp5.status === 403, 'Host 门拒绝非回环')

  // /v1/models 来自目录
  const resp6 = await fetch(`${gw}/v1/models`)
  const models6 = await resp6.json()
  ok(Array.isArray(models6.data) && models6.data[0]?.id === 'auto', '/v1/models 出目录')

  await stopGw()
  infer.close()
}

// ── [18] 出站 tool 配对 + 可见性体检（sanitizeToolPairing + developer 重写 + 网关接线）
//     根因两次修正：① pi-ai 删 error/aborted 的 assistant 留 toolResult（孤儿 tool）；
//     ② 宿主每个工具轮都发 content:null，严格上游把它当"不存在的消息"（主触发）。
console.log('\n[18] 出站 tool 配对 + 可见性修复（sanitizeToolPairing + 网关接线）')
{
  const { sanitizeToolPairing, createQoderGateway } = await import('../providers/qoder/gateway.js')

  const pairOk = (msgs) => {
    const ids = new Set()
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) ids.add(tc.id)
      else if (m.role === 'tool') { if (!ids.has(m.tool_call_id)) return false }
      else if (m.role === 'assistant') ids.clear()
    }
    return true
  }

  // 纯函数：pi-ai 的真实产物（system,user,tool,user——assistant 被 stopReason=error 删掉）
  const orphan = sanitizeToolPairing([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '现在几点？' },
    { role: 'tool', tool_call_id: 'call_abc123', name: 'get_current_time', content: '2026-09-22 05:00:00 +08:00' },
    { role: 'user', content: '谢谢' },
  ])
  ok(pairOk(orphan.messages) === true, '孤儿 tool → 补 assistant 桩后配对合法')
  ok(orphan.repaired.orphans === 1 && orphan.messages[2]?.role === 'assistant'
    && orphan.messages[2]?.tool_calls?.[0]?.id === 'call_abc123'
    && orphan.messages[2]?.tool_calls?.[0]?.function?.name === 'get_current_time',
  '桩保留 tool_call_id 与工具名', JSON.stringify(orphan.messages[2]))
  ok(orphan.messages[3]?.role === 'tool' && orphan.messages[3]?.tool_call_id === 'call_abc123', '原 tool 结果保留在桩之后')

  // 纯函数：tool_call 无结果 → 补"不可用"结果（同一故障的另一半）
  const missing = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'user', content: '算了' },
  ])
  ok(missing.repaired.synthesized === 1 && missing.messages[2]?.role === 'tool'
    && missing.messages[2]?.tool_call_id === 'call_x' && /unavailable/.test(missing.messages[2]?.content ?? ''),
  'tool_calls 缺结果 → 合成不可用结果', JSON.stringify(missing.messages.map((m) => m.role)))
  ok(pairOk(missing.messages) === true, '合成后配对合法')

  // 纯函数：同 id 的重复结果 → 丢弃（上游会当孤儿 400）
  const dup = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_dup', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_dup', content: 'r1' },
    { role: 'tool', tool_call_id: 'call_dup', content: 'r2' },
  ])
  ok(dup.repaired.duplicates === 1 && dup.messages.filter((m) => m.role === 'tool').length === 1,
    '同 id 重复 tool 结果 → 只留第一个', JSON.stringify(dup.messages.map((m) => m.role)))

  // 纯函数：**主触发形态**——合法工具环但 assistant content:null（宿主对每个工具轮
  // 都这么发，见 providers/tool-pairing.js 文件头 P-A）→ 必须补成 ''，且补完配对仍合法
  const invisible = sanitizeToolPairing([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_n1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_n1', content: 'r' },
  ])
  ok(invisible.repaired.invisible === 1 && invisible.repaired.orphans === 0,
    'assistant content:null → 计入 invisible 修复', JSON.stringify(invisible.repaired))
  ok(invisible.messages[2].content === '' && pairOk(invisible.messages) === true,
    'null 载体补成空串后工具环合法', JSON.stringify(invisible.messages[2]))
  ok(JSON.stringify(Object.keys(invisible.messages[2])) === JSON.stringify(['role', 'content', 'tool_calls']),
    '键序不变（spread 原位覆盖，不产生重排）')

  // 纯函数：tool 结果自身 content:null 同样不可见（上游报"insufficient tool messages"）
  const invisibleTool = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_n2', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_n2', content: null },
  ])
  ok(invisibleTool.messages[2].content === '' && invisibleTool.repaired.invisible === 1,
    'tool 消息 content:null → 补空串', JSON.stringify(invisibleTool.messages[2]))

  // 纯函数：content 缺失（连键都没有）同样归一
  const absent = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [{ id: 'call_n3', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_n3', content: 'r' },
  ])
  ok(absent.messages[1].content === '' && absent.repaired.invisible === 1, 'content 键缺失 → 补空串')

  // 纯函数：修复桩自身必须用 ''——用 null 会把修复变成新的坏体（09-22 首版翻车点）
  const stubShape = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'call_s', content: 'r' },
  ])
  ok(stubShape.messages[1].content === '' && 'content' in stubShape.messages[1],
    '孤儿桩 content 为空串而非 null', JSON.stringify(stubShape.messages[1]))

  // 纯函数：合法（content 为非空串）历史零改动——修复不得碰正常请求
  const clean = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '我查一下', tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_ok', content: 'result' },
  ]
  const untouched = sanitizeToolPairing(clean)
  ok(untouched.repaired.orphans === 0 && untouched.repaired.synthesized === 0
    && untouched.repaired.invisible === 0 && untouched.repaired.duplicates === 0
    && JSON.stringify(untouched.messages) === JSON.stringify(clean), '合法历史逐字节不变')

  // 网关接线：stub cosy（捕获签名前的**明文** body，避开 WASM 密文）
  const signedBodies = []
  const stubCosy = {
    prepareChat: async (_cred, { body, modelKey }) => {
      signedBodies.push({ body: JSON.parse(body), modelKey })
      return { url: 'http://127.0.0.1:1/unused', headers: {}, body: '{}' }
    },
  }
  const metered2 = []
  const runtime2 = { running: false, port: null, lastError: null }
  const gw2 = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: 'https://example.invalid', maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 3000 }),
    resolveCredential: async () => ({ authorization: 'Bearer dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }),
    cosy: stubCosy,
    meter: { record: (r) => metered2.push(r) },
    runtime: runtime2,
    forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [],
    getModelSource: () => 'system',
  })
  const stopGw2 = gw2.listen(0)
  for (let i = 0; i < 50 && !runtime2.running; i++) await sleep(50)
  const call = (messages, stream) => fetch(`http://127.0.0.1:${runtime2.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qmodel', stream, messages }),
  })
  await call([
    { role: 'user', content: '现在几点？' },
    { role: 'tool', tool_call_id: 'call_live_1', name: 'get_current_time', content: '2026-09-22 05:00:00 +08:00' },
  ], false).then((r) => r.text()) // 上游 stub 不可达 → 500/502，但签名前的明文已捕获
  const seen = signedBodies.at(-1)?.body
  ok(seen?.messages?.[1]?.role === 'assistant' && seen?.messages?.[2]?.role === 'tool',
    '网关出站前插入 assistant 桩（明文可见）', JSON.stringify(seen?.messages?.map((m) => m.role)))
  ok(seen?.messages?.[1]?.content === '', '出站桩 content 为 ""（严格上游不认 null 载体）', JSON.stringify(seen?.messages?.[1]?.content))
  ok(seen?.stream === true && seen?.stream_options?.include_usage === true, '强制流式与 usage 语义未被修复流程破坏')
  ok(seen?.model === 'qmodel', 'model 字段原样')

  // 宿主真实出站形态（developer 系统提示 + null content 工具轮）经网关后必须双双纠正
  await call([
    { role: 'developer', content: '你是编码助手' },
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_live_2', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_live_2', content: 'r' },
  ], false).then((r) => r.text())
  const seen2 = signedBodies.at(-1)?.body
  ok(seen2?.messages?.[0]?.role === 'system', 'developer → system 出站重写（明文可见）', JSON.stringify(seen2?.messages?.[0]?.role))
  ok(seen2?.messages?.[2]?.content === '' && seen2?.messages?.[2]?.tool_calls?.[0]?.id === 'call_live_2',
    'null content 工具轮 → 出站补成 ""，tool_calls 原样保留', JSON.stringify(seen2?.messages?.[2]))
  ok(JSON.stringify(seen2?.messages?.map((m) => m.role)) === JSON.stringify(['system', 'user', 'assistant', 'tool']),
    '修复不增删消息（该形态本就配对合法）', JSON.stringify(seen2?.messages?.map((m) => m.role)))

  await stopGw2()
}

// ── [15] 目录投影：明文形态 + 过滤 + sources 映射 ───────────────────────────
console.log('\n[15] 目录投影（fetchQoderCatalog）')
{
  const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
  const { fetchQoderCatalog, applyQoderContextVariant, qoderReasoningEfforts, qoderEffortTiers } = await import('../providers/qoder/catalog.js')
  const { fileURLToPath } = await import('node:url')
  const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers', 'qoder', 'qoder_auth.wasm')
  const cosy = createCosyRuntime({ wasmPath })
  const catServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      chat: [
        { key: 'auto', format: 'openai', source: 'system', enable: true, display_name: 'Auto', is_vl: true, max_input_tokens: 180000 },
        { key: 'qmodel_38max', format: 'openai', source: 'system', enable: true, display_name: 'Qwen3.8-Max', is_vl: true, context_config: { '200K': { token_count: 200000, is_default: true }, '1M': { token_count: 1000000 } }, thinking_config: { disabled: {}, enabled: { efforts: { low: {}, medium: { is_default: true }, xhigh: {} }, is_default: true } } },
        { key: 'disabled-m', format: 'openai', enable: false },
        { key: 'other-fmt', format: 'anthropic', enable: true },
      ],
    }))
  })
  await new Promise((r) => catServer.listen(0, '127.0.0.1', r))
  const catOrigin = `http://127.0.0.1:${catServer.address().port}`
  const cred = { accessToken: 'dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }
  const result = await fetchQoderCatalog(cosy, cred, catOrigin)
  ok(result.profiles.length === 2, 'enable+format 过滤后 2 条', String(result.profiles.length))
  ok(result.profiles[1].contextWindow === 200000, 'contextWindow 取 context_config 默认档')
  ok(result.profiles[0].contextWindow === 180000, '无 context_config 回落 max_input_tokens')
  ok(result.profiles[0].input.includes('image') && result.profiles[1].input.includes('image'), 'is_vl → input 含 image')
  ok(JSON.stringify(result.profiles[1].reasoningEfforts) === JSON.stringify({ off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' }), 'thinking_config → reasoningEfforts（disabled→off:null，efforts 键照抄档位名）')
  ok(result.profiles[0].reasoningEfforts === undefined, '无 thinking_config → 不出档位表（条目形状不变）')
  ok(qoderReasoningEfforts({ key: 'x', thinking_config: { disabled: {}, enabled: { is_default: true } } }) === null, 'enabled 无命名档位 → null（不摆空档位）')
  ok(qoderReasoningEfforts({ key: 'x' }) === null && qoderReasoningEfforts(null) === null, '无 thinking_config / 空条目 → null')
  ok(qoderReasoningEfforts({ key: 'x', thinking_config: { enabled: { efforts: { high: {}, max: { is_default: true } } } } })?.off === undefined, 'enabled 无 disabled → 无 off 档（不臆造关思考）')
  ok(JSON.stringify(result.efforts.qmodel_38max) === JSON.stringify(['off', 'low', 'medium', 'xhigh']), '展示档位清单（设置卡 select 真源）= 线值表的键')
  ok(Array.isArray(result.efforts.auto) && result.efforts.auto.length === 0, '无 thinking_config → 展示档位空数组（不出控件）')
  ok(JSON.stringify(qoderEffortTiers({ key: 'x', thinking_config: { enabled: { efforts: { light: {}, high: {} } } } })) === JSON.stringify(['light', 'high']), '档位拼写照抄目录（Trae/其他上游专有拼写也不改写）')
  ok(result.sources.qmodel_38max === 'system', 'sources 映射保留')
  ok(JSON.stringify(result.variants.qmodel_38max) === JSON.stringify([
    { name: '200K', tokenCount: 200000, isDefault: true },
    { name: '1M', tokenCount: 1000000, isDefault: false },
  ]), 'variants 逐模型清单（name/tokenCount/isDefault）')
  ok(Array.isArray(result.variants.auto) && result.variants.auto.length === 0, '无 context_config → variants 空数组')
  ok(applyQoderContextVariant(result.profiles[1], '1M', result.variants.qmodel_38max).contextWindow === 1000000, '选中变体 → contextWindow 覆盖')
  ok(applyQoderContextVariant(result.profiles[1], '404K', result.variants.qmodel_38max).contextWindow === 200000, '变体名不在目录 → 维持默认档')
  ok(applyQoderContextVariant(result.profiles[1], undefined, result.variants.qmodel_38max) === result.profiles[1], '未选变体 → profile 原样（镜像形状不变）')
  catServer.close()
}

// ── [16] 出站补默认注入：prefs.effort + profile.maxTokens ───────────────────
console.log('\n[16] 网关出站注入：思考强度与输出上限只补默认、不覆盖客户端')
{
  const { createQoderGateway } = await import('../providers/qoder/gateway.js')
  const seen = [] // mock 上游收到的 bodyJson（= prepareChat 的 body 参数）
  const infer = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const env = (body) => `data:${JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body, statusCodeValue: 200, statusCode: 'OK' })}\n\n`
      const chunk = JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: 'stop' }], created: 1, id: 'c1', model: 'auto', object: 'chat.completion.chunk' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(env(chunk) + env('[DONE]'))
    })
  })
  await new Promise((r) => infer.listen(0, '127.0.0.1', r))
  const inferOrigin = `http://127.0.0.1:${infer.address().port}`

  // stub cosy：prepareChat 原样透传 body——真 WASM 会加密 body，mock 看不到
  // 明文；这里要断言的正是 prepareChat 收到的 upstream 组装结果。
  const stubCosy = {
    prepareChat: async (_cred, { endpoint, body }) => ({
      url: `${endpoint}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
      headers: {},
      body,
    }),
  }
  let prefs = {}
  const runtime16 = { running: false, port: null, lastError: null }
  const gateway16 = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: inferOrigin, maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 5000 }),
    resolveCredential: async () => ({ authorization: 'Bearer dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }),
    cosy: stubCosy,
    meter: { record: () => {} },
    runtime: runtime16,
    forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [
      { id: 'auto', name: 'Auto', contextWindow: 180000, maxTokens: 32768, input: ['text', 'image'] },
      { id: 'm1', name: 'M1', contextWindow: 200000, maxTokens: 8192, input: ['text'] },
    ],
    getModelSource: () => 'system',
    getModelPrefs: () => prefs,
  })
  const stopGw16 = gateway16.listen(0)
  for (let i = 0; i < 50 && !runtime16.running; i++) await sleep(50)
  const gw16 = `http://127.0.0.1:${runtime16.port}`
  const chat16 = (payload) => fetch(`${gw16}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'hi' }], ...payload }),
  }).then((r) => r.json())
  const last = () => seen[seen.length - 1]

  prefs = { m1: { effort: 'high' } }
  await chat16({ model: 'm1' })
  ok(last().reasoning_effort === 'high', 'prefs.effort=high → 上游 body 见 reasoning_effort:"high"')
  ok(last().max_completion_tokens === 8192, '客户端未带 → 补 max_completion_tokens=profile.maxTokens')

  await chat16({ model: 'm1', reasoning_effort: 'low' })
  ok(last().reasoning_effort === 'low', '客户端带 effort → 尊重客户端不覆盖')

  prefs = { m1: { effort: 'off' } }
  await chat16({ model: 'm1' })
  ok(!('reasoning_effort' in last()), "effort='off' → 省略参数（不发 'off' 线值）")

  prefs = {}
  await chat16({ model: 'm1' })
  ok(!('reasoning_effort' in last()), '未设 prefs → 不注入 reasoning_effort')
  ok(last().max_completion_tokens === 8192, '无 prefs 但有目录 profile → 仍补 max_completion_tokens')

  await chat16({ model: 'auto' })
  ok(last().max_completion_tokens === 32768, 'auto 目录 profile → 补 max_completion_tokens=32768')

  await chat16({ model: 'm1', max_tokens: 500 })
  ok(last().max_tokens === 500 && !('max_completion_tokens' in last()), '客户端带 max_tokens → 透传且不补 max_completion_tokens')

  await chat16({ model: 'ghost' })
  ok(!('max_completion_tokens' in last()) && !('reasoning_effort' in last()), '目录外模型 → 双不注入')

  await stopGw16()
  infer.close()
}

// ── [17] 组合根端到端：prefs 文件层 → 镜像 → GET 契约（DSH_HOME 隔离沙箱）────
console.log('\n[17] qoderModelSetPrefs 全链路：apply() 起真组合根，mock 目录上游')
{
  const { readFileSync, existsSync } = await import('node:fs')
  const YAML = (await import('yaml')).default
  const { readJson } = await import('../core/json-store.js')

  // DSH_HOME 必须在 import('../index.js') 之前落点（路径常量模块加载时固化）
  const dir17 = mkdtempSync(join(tmpdir(), 'qoder-e2e-'))
  process.env.DSH_HOME = dir17
  // 预置已登录凭据（远有效期 → 不触发 refresh）
  writeJson(join(dir17, 'qoder-plugin-auth.json'), {
    auth: { accessToken: 'dt-e2e', refreshToken: 'drt-e2e', expiresAt: Date.now() + 3_600_000, loginMethod: 'browser' },
    machine: { machineId: 'a'.repeat(48) },
    account: { uid: 'u-e2e' },
  })
  const cat = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/api/v2/model/list')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        chat: [
          { key: 'auto', format: 'openai', source: 'system', enable: true, display_name: 'Auto', is_vl: true, max_input_tokens: 180000 },
          { key: 'qmodel_38max', format: 'openai', source: 'system', enable: true, display_name: 'Qwen3.8-Max', is_vl: true, context_config: { '200K': { token_count: 200000, is_default: true }, '1M': { token_count: 1000000 } }, thinking_config: { disabled: {}, enabled: { efforts: { low: {}, medium: { is_default: true }, xhigh: {} }, is_default: true } } },
        ],
      }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => cat.listen(0, '127.0.0.1', r))
  const catOrigin = `http://127.0.0.1:${cat.address().port}`

  // 空闲端口给翻译网关（qoderBridgePort 必须 ≥1）
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const gwPort = probe.address().port
  await new Promise((r) => probe.close(r))

  // 生产形态：启用开关与网关参数走文件层——镜像函数按文件层解析
  // qoderEnabled（Config({...readFileLayer()})），不经 apply 的 entry config
  writeJson(join(dir17, 'codebuddy-plugin.json'), {
    qoderEnabled: true,
    qoderBridgePort: gwPort,
    qoderInferBaseURL: catOrigin,
  })

  let routeHandler = null
  let disposeFn = null
  const tap = await import('../index.js')
  tap.apply({
    inject: (services, cb) => {
      if (services.includes('webServer')) cb({ webServer: { register: (route) => { routeHandler = route.handler } } })
      // tools/settings 注入不回调：对应同步空转，不影响本块断言面
    },
    on: (event, cb) => { if (event === 'dispose') disposeFn = cb },
  }, {
    bridgeEnabled: false,   // 不起 codebuddy 桥
    searchEnabled: false,   // 不注册 web 搜索/抓取 provider
    imageGenEnabled: false,
    traeEnabled: false,
    baseURL: catOrigin,     // codebuddy 侧启动同步也指向 mock（404 快速失败）
  })
  ok(typeof routeHandler === 'function', 'apply() 注册 /dsh-tap/settings 路由')

  const ui = createServer((req, res) => routeHandler(req, res))
  await new Promise((r) => ui.listen(0, '127.0.0.1', r))
  const uiOrigin = `http://127.0.0.1:${ui.address().port}`
  const call = async (method, body) => {
    const res = await fetch(`${uiOrigin}/dsh-tap/settings`, {
      method,
      headers: { 'content-type': 'application/json', origin: uiOrigin },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  // 等 apply() 里 syncQoderBridge 的目录同步落镜：catalogState 与镜像写在
  // 同一 then 链，但视图 sync 标志先于镜像可见——以镜像文件落盘为准
  const SETTINGS_YAML = join(dir17, 'settings.yaml')
  const FILE_LAYER = join(dir17, 'codebuddy-plugin.json')
  let g = null
  for (let i = 0; i < 100; i++) {
    g = (await call('GET')).json
    if (g?.qoder?.models?.sync && existsSync(SETTINGS_YAML)) break
    await sleep(100)
  }
  ok(g?.qoder?.models?.sync?.count === 2 && existsSync(SETTINGS_YAML), '目录同步并镜像落盘（2 模型）', JSON.stringify(g?.qoder?.models?.sync))
  ok(JSON.stringify(g.qoder.models.variants.qmodel_38max) === JSON.stringify([
    { name: '200K', tokenCount: 200000, isDefault: true },
    { name: '1M', tokenCount: 1000000, isDefault: false },
  ]), 'GET 契约：qoder.models.variants 逐模型清单')
  ok(Array.isArray(g.qoder.models.variants.auto) && g.qoder.models.variants.auto.length === 0, 'GET 契约：无变体模型 → 空数组')
  ok(JSON.stringify(g.qoder.models.efforts.qmodel_38max) === JSON.stringify(['off', 'low', 'medium', 'xhigh']), 'GET 契约：qoder.models.efforts 逐模型档位（设置卡 select 真源）')
  ok(Array.isArray(g.qoder.models.efforts.auto) && g.qoder.models.efforts.auto.length === 0, 'GET 契约：目录未声明命名档位 → 空数组（不出控件）')
  ok(JSON.stringify(g.qoder.models.modelPrefs) === '{}', 'GET 契约：初始 modelPrefs 为空字典')
  ok(!JSON.stringify(g).includes('dt-e2e'), 'GET 响应脱敏：access token 不进设置视图（审计 [26] 同纪律）')

  let doc = YAML.parse(readFileSync(SETTINGS_YAML, 'utf8'))
  let block = doc['llm-pi-ai'].providers.qoder
  ok(block.models.length === 2, '镜像块铺 2 模型')
  ok(JSON.stringify(Object.keys(block.models.find((m) => m.id === 'qmodel_38max')).sort()) === JSON.stringify(['contextWindow', 'id', 'input', 'maxTokens', 'name', 'reasoningEfforts']), '镜像条目形状：variants 不进 settings.yaml，档位表进 reasoningEfforts')
  ok(JSON.stringify(block.models.find((m) => m.id === 'qmodel_38max').reasoningEfforts) === JSON.stringify({ off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' }), '镜像带目录声明的档位表（宿主 Model/Effort 选择器数据源）')
  ok(JSON.stringify(block.compat) === JSON.stringify({ thinkingFormat: 'openai', supportsReasoningEffort: true }), '镜像块声明 compat（pi-ai 才会把选中档位写成 reasoning_effort）')
  ok(block.models.find((m) => m.id === 'qmodel_38max').contextWindow === 200000, '未选变体 → contextWindow 维持目录默认档')

  let r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'xhigh', contextVariant: '1M' } } } })
  ok(r.status === 200 && r.json.ok === true, 'qoderModelSetPrefs → 200 ok（目录声明的档位 xhigh）')
  ok(JSON.stringify(readJson(FILE_LAYER).qoderModelPrefs) === JSON.stringify({ qmodel_38max: { effort: 'xhigh', contextVariant: '1M' } }), '写文件层 qoderModelPrefs（只存已设置键）')
  doc = YAML.parse(readFileSync(SETTINGS_YAML, 'utf8'))
  ok(doc['llm-pi-ai'].providers.qoder.models.find((m) => m.id === 'qmodel_38max').contextWindow === 1000000, '镜像 contextWindow = 选中变体 token_count')
  ok(r.json.qoder.models.modelPrefs.qmodel_38max.contextVariant === '1M', 'POST 响应回带 qoder 区读侧一致')

  const yamlBefore = readFileSync(SETTINGS_YAML, 'utf8')
  const layerBefore = readFileSync(FILE_LAYER, 'utf8')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'xhigh', contextVariant: '1M' } } } })
  ok(r.json.ok === true, '重复提交同值 → ok')
  ok(readFileSync(SETTINGS_YAML, 'utf8') === yamlBefore && readFileSync(FILE_LAYER, 'utf8') === layerBefore, '幂等：settings.yaml 与文件层逐字节不变')

  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'off' } } } })
  ok(r.json.ok === true && JSON.stringify(readJson(FILE_LAYER).qoderModelPrefs) === JSON.stringify({ qmodel_38max: { effort: 'off' } }), 'prefs 完整替换：contextVariant 被清掉')
  doc = YAML.parse(readFileSync(SETTINGS_YAML, 'utf8'))
  ok(doc['llm-pi-ai'].providers.qoder.models.find((m) => m.id === 'qmodel_38max').contextWindow === 200000, '变体清掉 → 镜像回落目录默认档')

  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: {} } } })
  ok(r.json.ok === true && JSON.stringify(readJson(FILE_LAYER).qoderModelPrefs ?? {}) === '{}', '空 prefs = 删记录回默认')

  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'ultra' } } } })
  ok(r.status === 400 && /effort 档位必须是该模型目录声明的/.test(r.json?.error ?? ''), '非法档位 → 400 且报错列出该模型自己的档位表')
  ok(/off\/low\/medium\/xhigh/.test(r.json?.error ?? ''), '错误消息里的档位表 = 目录声明（不是固定五档）')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'max' } } } })
  ok(r.status === 400, '目录未声明的档位（max）新设被拒（存量兼容不放行新值）')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { contextVariant: '404K' } } } })
  ok(r.status === 400 && /没有名为/.test(r.json?.error ?? ''), '未知变体名 → 400 带原因')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'ghost', prefs: { effort: 'high' } } } })
  ok(r.status === 400 && /不在 Qoder 目录里/.test(r.json?.error ?? ''), '目录外模型 → 400 带原因')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'auto', prefs: { contextVariant: '200K' } } } })
  ok(r.status === 400, '无变体模型拒收 contextVariant')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'auto', prefs: { effort: 'low' } } } })
  ok(r.status === 400 && /未声明思考档位/.test(r.json?.error ?? ''), '目录未声明档位的模型：effort 拒收（不出控件也不收写入）')

  // R3 存量兼容：旧版本写下的、目录未声明的档位（如 max）不静默丢，且可随全量
  // 期望态重发（只改上下文长度不该被判非法）。
  writeJson(FILE_LAYER, { ...readJson(FILE_LAYER), qoderModelPrefs: { qmodel_38max: { effort: 'max' } } })
  g = (await call('GET')).json
  ok(g.qoder.models.modelPrefs.qmodel_38max?.effort === 'max', 'R3：存量未声明档位读侧保留（不静默丢）')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'max', contextVariant: '1M' } } } })
  ok(r.status === 200 && r.json.ok === true, 'R3：存量值可随全量期望态重发（不被判非法）')
  r = await call('POST', { patch: { qoderModelSetPrefs: { id: 'qmodel_38max', prefs: { effort: 'medium', contextVariant: '1M' } } } })
  ok(r.status === 200 && readJson(FILE_LAYER).qoderModelPrefs.qmodel_38max.effort === 'medium', 'R3：改成目录声明档位正常（存量值不锁死）')

  if (disposeFn) disposeFn()
  ui.close()
  cat.close()
}

// ── [19] 用量归因：出站信封归因字段 + 收尾 business/finish 与 tracking 上报 ──
// （2026-09-22 逆向：裸 OpenAI body 不落入官方用量统计；官方客户端每轮结束
// 补两条 COSY 签名上报。证据 docs/probes/qoder-attribution-*.json）
console.log('\n[19] 用量归因信封与收尾上报（官方客户端同构）')
{
  const { createQoderGateway } = await import('../providers/qoder/gateway.js')
  const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
  const upstreamBodies = []
  const reportCalls = [] // { path, mode, body }
  const infer19 = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const path = req.url.split('?')[0]
      if (path.endsWith('/agent_chat_generation')) {
        upstreamBodies.length // no-op
        const env = (body) => `data:${JSON.stringify({ headers: {}, body, statusCodeValue: 200, statusCode: 'OK' })}\n\n`
        const chunk = JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: 'stop' }], created: 1, id: 'c1', model: 'qmodel_38max', object: 'chat.completion.chunk' })
        const usageFrame = JSON.stringify({ choices: [], created: 1, id: 'c1', model: 'qmodel_38max', object: 'chat.completion.chunk', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, credits: 0.001 } })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(env(chunk) + env(usageFrame) + env('[DONE]'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('success')
    })
  })
  await new Promise((r) => infer19.listen(0, '127.0.0.1', r))
  const origin19 = `http://127.0.0.1:${infer19.address().port}`
  const stubCosy19 = {
    prepareChat: async (_cred, { endpoint, body }) => {
      upstreamBodies.push(JSON.parse(body)) // 签名前明文
      return { url: `${endpoint}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, headers: {}, body }
    },
    prepareSigned: async (_cred, { path, mode, body }) => {
      reportCalls.push({ path, mode, body })
      return { url: `${origin19}${path}`, headers: {}, body }
    },
  }
  const runtime19 = { running: false, port: null, lastError: null }
  const gw19 = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: origin19, maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 5000 }),
    resolveCredential: async () => ({ authorization: 'Bearer dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }),
    cosy: stubCosy19,
    meter: { record: () => {} },
    runtime: runtime19,
    forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [{ id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 200000, maxTokens: 32768, input: ['text', 'image'] }],
    getCatalogEntry: (id) => (id === 'qmodel_38max' ? { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_vl: true, is_reasoning: false, max_input_tokens: 262144, source: 'system' } : null),
    getModelSource: () => 'system',
  })
  const stopGw19 = gw19.listen(0)
  for (let i = 0; i < 50 && !runtime19.running; i++) await sleep(50)
  const call19 = (sid) => fetch(`http://127.0.0.1:${runtime19.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': sid },
    body: JSON.stringify({ model: 'qmodel_38max', stream: true, messages: [{ role: 'user', content: '归因信封测试 prompt' }] }),
  }).then((r) => r.text())
  await call19('sess-a')
  await call19('sess-a')
  await call19('sess-b')
  // 上报是 fire-and-forget，等它们落地
  for (let i = 0; i < 40 && reportCalls.length < 6; i++) await sleep(50)

  const env1 = upstreamBodies[0]
  ok(isUuid(env1?.session_id) && isUuid(env1?.request_id) && isUuid(env1?.request_set_id), '信封携带 UUID 形态 session_id/request_id/request_set_id')
  ok(env1?.chat_record_id === env1?.request_id, 'chat_record_id = request_id')
  ok(env1?.chat_task === 'FREE_INPUT' && env1?.source === 1 && env1?.version === '3' && env1?.is_reply === true && env1?.is_retry === false, 'chat_task/source:1/version:"3"/is_reply 恒值对齐')
  ok(env1?.agent_id === 'agent_common' && env1?.task_id === 'common' && env1?.session_type === 'qoderclicn', 'agent_id/task_id/session_type 对齐官方 CLI')
  ok(env1?.model_config?.key === 'qmodel_38max' && env1?.model_config?.display_name === 'Qwen3.8-Max' && env1?.model_config?.max_input_tokens === 262144 && env1?.model_config?.is_vl === true, 'model_config 取自目录原始条目')
  ok(env1?.business?.id === env1?.request_set_id && env1?.business?.stage === 'processing' && env1?.business?.product === 'cli', 'business 块 id=request_set_id、stage=processing')
  ok(env1?.chat_context?.text === '归因信封测试 prompt', 'chat_context.text = 最后一条 user 文本')
  ok(upstreamBodies[1]?.session_id === env1.session_id && upstreamBodies[2]?.session_id !== env1.session_id, 'session_id 按 dsh 会话稳定、跨会话区分')

  const finish = reportCalls.filter((c) => c.path.includes('business/finish'))
  const track = reportCalls.filter((c) => c.path.includes('/api/v1/tracking'))
  ok(finish.length === 3 && finish.every((c) => c.mode === 'auth'), '每次完成发 business/finish（prepareRequest mode auth）')
  ok(track.length === 3 && track.every((c) => c.mode === 'sign'), '每次完成发 tracking（mode sign）')
  const f0 = JSON.parse(JSON.parse(finish[0].body).payload)
  ok(f0.event_type === 'BUSINESS_FINISH' && f0.event_data.business.id === env1.request_set_id && f0.event_data.session_id === env1.session_id && f0.event_data.business.stage === 'complete', 'BUSINESS_FINISH join key 与信封同源、stage=complete')
  const t0 = JSON.parse(track[0].body)[0]
  const item0 = t0?.event_data?.items?.[0] ?? {}
  ok(t0?.event_type === 'qodercli-back-flow-agent-query-finish' && t0.business_id === env1.request_set_id && item0.total_credits === 0.001 && item0.total_input_tokens === 10 && item0.actual_model === 'qmodel_38max', 'tracking 聚合 usage.credits/tokens，business_id 同源')

  await stopGw19()
  infer19.close()
}

server.close()
console.log(`\n=== verify-qoder-provider: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
