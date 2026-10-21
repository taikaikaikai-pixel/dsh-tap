#!/usr/bin/env node
/**
 * verify-route-contract.mjs — `/dsh-tap/settings` 的**行为契约**（0.25.0 组合根拆分的前置闸门）。
 *
 * 为什么先立它再拆代码：`index.js` 要从 2517 行拆成组合根 + `host/**`，拆分过程中
 * 最容易出的事故不是"编译不过"，而是**响应形状悄悄变了**——少一个字段、状态码
 * 从 400 变 502、某个 action 的 ok 语义翻转，浏览器半边只会在某个冷门路径上表现
 * 成 `undefined`。所以先把这个路由现在**实际**吐的东西逐条锁死（28 个 action +
 * GET 视图的每一层键集合 + 7 类 patch + 5 类拒绝面），再动代码；拆完这套断言
 * 必须原样通过，不允许改期望值（除非是**有意的**契约变更，那就同时改 CHANGELOG）。
 *
 * 离线：临时 DSH_HOME，所有上游基址指向 `127.0.0.1:1`（必然 ECONNREFUSED，秒回，
 * 不触达任何真实上游）。零凭据、零真实写入（临时目录随进程丢弃）。
 *
 * 跑法：node scripts/verify-route-contract.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker, httpRequest } from './lib/harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ok, section, finish } = createChecker('verify-route-contract')

// 临时 DSH_HOME + 指向「必然拒绝连接」的本机端口：任何真实上游调用都会立刻失败，
// 于是每个 action 都有一条**确定**的失败形状可锁（不依赖网络与凭据）。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-route-contract-'))
process.env.DSH_HOME = HOME
const DEAD = 'http://127.0.0.1:1'
writeFileSync(join(HOME, 'codebuddy-plugin.json'), JSON.stringify({
  baseURL: DEAD,
  traeAuthBaseURL: DEAD, traeChatBaseURL: DEAD, traeLoginHost: DEAD,
  qoderLoginHost: DEAD, qoderOpenapiBaseURL: DEAD, qoderInferBaseURL: DEAD,
}) + '\n')

const { apply } = await import('../index.js')
const routes = {}
const ctx = {
  inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes[r.path] = r.handler } } }),
  web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
  on: () => {},
}
apply(ctx, {
  bridgeEnabled: false, traeEnabled: false, qoderEnabled: false,
  bridgePort: 3997, traeBridgePort: 3998, qoderBridgePort: 3999,
})
const handler = routes['/dsh-tap/settings']
if (typeof handler !== 'function') {
  console.error('FAIL 路由未注册：/dsh-tap/settings（apply 契约已变）')
  process.exit(1)
}
const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const post = async (body) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await httpRequest(port, {
    method: 'POST', path: '/dsh-tap/settings',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    body: raw,
  })
  let json = null
  try { json = JSON.parse(r.text) } catch { /* 非 JSON */ }
  return { status: r.status, json, text: r.text }
}
const get = async (qs = '', headers = {}) => {
  const r = await httpRequest(port, { path: `/dsh-tap/settings${qs}`, headers: { host: `127.0.0.1:${port}`, ...headers } })
  let json = null
  try { json = JSON.parse(r.text) } catch { /* 非 JSON */ }
  return { status: r.status, json, text: r.text }
}
const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : null)
const sameKeys = (a, b) => Array.isArray(a) && a.length === b.length && a.every((k, i) => k === b[i])

// ---------------------------------------------------------------------------
// 期望表：键集合 = 2026-10-21 拆分前实测（当天 28 个 action 的真实形态）。
// ⚠️ 改这里 = 改对外契约：必须同时更新 CHANGELOG 与客户端消费点。
// ---------------------------------------------------------------------------
const ACTIONS = {
  'oauth-start': { status: 502, ok: false, keys: ['error', 'ok'] },
  'oauth-status': { status: 200, ok: true, keys: ['oauth', 'ok'] },
  'model-list': { status: 502, ok: false, keys: ['error', 'ok'] },
  'model-sync': { status: 200, ok: true, keys: ['models', 'ok', 'sync'] },
  'provider-list': { status: 200, ok: true, keys: ['ok', 'presets', 'providers'] },
  'provider-add': { status: 502, ok: false, keys: ['error', 'ok'] },
  'provider-remove': { status: 400, ok: false, keys: ['error', 'ok'] },
  'provider-refresh': { status: 400, ok: false, keys: ['error', 'ok'] },
  'provider-test': { status: 400, ok: false, keys: ['error', 'ok'] },
  'credential-test': { status: 400, ok: false, keys: ['error', 'ok'] },
  'credential-scan': { status: 200, ok: true, keys: ['findings', 'ok'] },
  'credential-import': { status: 400, ok: false, keys: ['error', 'ok'] },
  'oauth-logout': { status: 200, ok: true, keys: ['oauth', 'ok'] },
  'trae-oauth-start': { status: 200, ok: true, keys: ['authUrl', 'ok'] },
  'trae-oauth-status': { status: 200, ok: true, keys: ['ok', 'trae'] },
  'trae-oauth-logout': { status: 200, ok: true, keys: ['ok', 'trae'] },
  'trae-model-sync': { status: 200, ok: false, keys: ['ok', 'sync', 'trae'] },
  'trae-model-list': { status: 200, ok: true, keys: ['disabled', 'ok', 'view'] },
  'trae-quota': { status: 200, ok: true, keys: ['ok', 'quota'] },
  'qoder-oauth-start': { status: 200, ok: true, keys: ['authUrl', 'ok'] },
  'qoder-oauth-status': { status: 200, ok: true, keys: ['ok', 'qoder'] },
  'qoder-oauth-logout': { status: 200, ok: true, keys: ['ok', 'qoder'] },
  'qoder-model-sync': { status: 200, ok: false, keys: ['ok', 'qoder', 'sync'] },
  'qoder-model-list': { status: 200, ok: true, keys: ['disabled', 'ok', 'view'] },
  'qoder-quota': { status: 200, ok: true, keys: ['ok', 'quota'] },
  'usage': { status: 200, ok: true, keys: ['bridge', 'ok', 'qoderQuota', 'quota', 'usage'] },
  'quota-all': { status: 200, ok: true, keys: ['enabled', 'ok', 'quota'] },
  'gateway-retry': { status: 400, ok: false, keys: ['error', 'ok'] },
}

// ---------------------------------------------------------------------------
section('1. 28 个 action 的状态码 / ok 语义 / 顶层键集合')
for (const [action, want] of Object.entries(ACTIONS)) {
  const r = await post({ action })
  const keys = keysOf(r.json)
  const fine = r.status === want.status && r.json?.ok === want.ok && sameKeys(keys, want.keys)
  ok(`action:${action} → ${want.status} ok=${want.ok} keys=${want.keys.join(',')}`, fine,
    `got ${r.status} ok=${r.json?.ok} keys=${keys?.join(',')} ${r.json?.error ?? ''}`)
  // 例外：两个 model-sync 的失败原因在 `sync.error` 里（sync 是这个动作的产物本身），
  // 顶层仍是 `{ok:false}`——这是既有契约，拆分必须原样保留。
  if (r.json?.ok === false && !['trae-model-sync', 'qoder-model-sync'].includes(action)) {
    ok(`action:${action} 失败时 error 是非空字符串`, typeof r.json.error === 'string' && r.json.error.length > 0)
  }
}

// ---------------------------------------------------------------------------
section('2. GET 视图的每一层键集合（浏览器半的契约）')
{
  const view = await get()
  const top = ['bridge', 'credits', 'host', 'manualCredits', 'mirror', 'models', 'oauth', 'qoder', 'trae', 'user', 'value']
  ok('顶层键集合', sameKeys(keysOf(view.json), top), JSON.stringify(keysOf(view.json)))
  const nested = {
    value: ['apiKeyEnv', 'apiKeys', 'authMode', 'baseURL', 'bridgeEnabled', 'bridgePort', 'effortByModel',
      'fetchBodyCap', 'imageGenEnabled', 'imageGenModel', 'keyCooldownMs', 'localAllowedOrigins',
      'maxConcurrentPerSession', 'qoderBridgePort', 'qoderClientId', 'qoderEnabled',
      'qoderInferBaseURL', 'qoderLoginHost', 'qoderOpenapiBaseURL', 'quotaDockEnabled', 'quotaTotalManual',
      'searchEnabled', 'searchMaxResults', 'sessionHeaderFormat', 'sessionHeadersEnabled',
      'traeAuthBaseURL', 'traeBridgePort', 'traeChatBaseURL', 'traeChatTransport', 'traeEnabled',
      'traeLoginHost', 'upstreamFirstByteTimeoutMs'],
    // ⚠️ `value`/`user` 是**文件层镜像**：modelState / apiKeys 这类键只在文件层真写过
    // 之后才出现（这里是「刚启动、零 patch」的纯净态）。
    user: ['baseURL', 'qoderInferBaseURL', 'qoderLoginHost', 'qoderOpenapiBaseURL',
      'traeAuthBaseURL', 'traeChatBaseURL', 'traeLoginHost'],
    mirror: ['codebuddy', 'qoder', 'trae'],
    manualCredits: ['codebuddy', 'qoder', 'trae'],
    credits: ['codebuddy', 'qoder', 'trae'],
    oauth: ['accessTokenExpiresAt', 'account', 'authUrl', 'error', 'needsRelogin', 'pending', 'signedIn'],
    bridge: ['lastError', 'port', 'rateLimit', 'running', 'state'],
    trae: ['bridge', 'models', 'oauth'],
    models: ['disabled', 'effectiveCount', 'effectiveIds', 'extraIds', 'overrides', 'staticIds', 'sync'],
    qoder: ['bridge', 'models', 'oauth'],
    host: ['channels', 'drift', 'missingEntries', 'mode', 'servicePresent', 'webPin'],
  }
  for (const [k, want] of Object.entries(nested)) {
    ok(`view.${k} 键集合`, sameKeys(keysOf(view.json?.[k]), want),
      `got ${JSON.stringify(keysOf(view.json?.[k]))} want ${JSON.stringify(want)}`)
  }
  ok('bridge.state 是四词之一（结构化状态，踩坑 #77）',
    ['off', 'pending', 'listening', 'error'].includes(view.json?.bridge?.state), String(view.json?.bridge?.state))
  ok('GET 不回传 OAuth 令牌（只见状态与过期时刻）',
    !/accessToken|refreshToken/.test(view.text.replace(/accessTokenExpiresAt/g, '')))
  ok('GET 的 apiKeys[].key 已脱敏（首4…末4）', (view.json?.value?.apiKeys ?? []).every((k) => /…/.test(String(k.key))))
}

// ---------------------------------------------------------------------------
section('3. patch 分支的响应形状与落库语义')
{
  const r1 = await post({ patch: { quotaTotalManual: 42 } })
  ok('patch:quotaTotalManual → 200 {ok,user,value} 且生效',
    r1.status === 200 && sameKeys(keysOf(r1.json), ['ok', 'user', 'value']) && r1.json?.value?.quotaTotalManual === 42,
    `${r1.status} ${JSON.stringify(r1.json?.value?.quotaTotalManual)}`)

  const r2 = await post({ patch: { modelSetEnabled: { id: 'deepseek-v3', enabled: false } } })
  ok('patch:modelSetEnabled → 200 {ok,user,value,models}，effectiveIds 少一个',
    r2.status === 200 && sameKeys(keysOf(r2.json), ['models', 'ok', 'user', 'value'])
    && Array.isArray(r2.json?.models?.effectiveIds)
    && !r2.json.models.effectiveIds.includes('deepseek-v3'), `${r2.status} ${r2.json?.error ?? ''}`)

  const r3 = await post({ patch: { modelSetLimits: { id: 'deepseek-v3', contextWindow: 100000, maxTokens: 8000 } } })
  ok('patch:modelSetLimits → 200 且 overrides 记住覆盖值',
    r3.status === 200 && r3.json?.models?.overrides?.['deepseek-v3']?.contextWindow === 100000,
    `${r3.status} ${JSON.stringify(r3.json?.models?.overrides?.['deepseek-v3'])}`)

  const r4 = await post({ patch: { apiKeysAdd: { name: 'contract-k1', key: 'ck_contract_0001' } } })
  ok('patch:apiKeysAdd → 200 且回传脱敏 key',
    r4.status === 200 && (r4.json?.user?.apiKeys ?? []).some((k) => k.name === 'contract-k1' && /…/.test(k.key)),
    `${r4.status} ${JSON.stringify(r4.json?.user?.apiKeys)}`)
  const r5 = await post({ patch: { apiKeysRemove: 'contract-k1' } })
  ok('patch:apiKeysRemove → 200 且条目消失',
    r5.status === 200 && !(r5.json?.user?.apiKeys ?? []).some((k) => k.name === 'contract-k1'), String(r5.status))

  const r6 = await post({ patch: { manualCreditsSet: { channel: 'codebuddy', id: 'glm-5.3', value: 'x2' } } })
  ok('patch:manualCreditsSet 非数字 → 400（拒绝编造倍率）',
    r6.status === 400 && /倍率/.test(r6.json?.error ?? ''), `${r6.status} ${r6.json?.error}`)

  for (const [branch, id] of [['traeModelSetEnabled', 'x'], ['qoderModelSetEnabled', 'x']]) {
    const r = await post({ patch: { [branch]: { id, enabled: false } } })
    ok(`patch:${branch} 未知目录 id → 400（先同步目录）`,
      r.status === 400 && /不在 .*目录里/.test(r.json?.error ?? ''), `${r.status} ${r.json?.error}`)
  }
}

// ---------------------------------------------------------------------------
section('4. 拒绝面与探针端点')
{
  const bad = await post({})
  ok('空对象 → 400 + 「body must be {patch} or {action}」',
    bad.status === 400 && /body must be/.test(bad.json?.error ?? ''), bad.text.slice(0, 80))
  ok('拒绝面信封是设置面契约 {ok:false,error:string}（踩坑 #79）',
    bad.json?.ok === false && typeof bad.json?.error === 'string')

  const badJson = await post('not json')
  ok('坏 JSON → 400', badJson.status === 400, String(badJson.status))

  const put = await httpRequest(port, { method: 'PUT', path: '/dsh-tap/settings', headers: { host: `127.0.0.1:${port}` } })
  ok('非 GET/POST → 405', put.status === 405, String(put.status))

  const cross = await post({ action: 'oauth-status' }).then(() => httpRequest(port, {
    method: 'POST', path: '/dsh-tap/settings',
    headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}',
  }))
  ok('跨站 Origin → 403 + 中文原因', cross.status === 403 && /Origin 与 Host 不一致/.test(cross.text), `${cross.status}`)

  const lanHost = await httpRequest(port, { path: '/dsh-tap/settings', headers: { host: '10.0.0.2:3901' } })
  ok('非回环 Host → 403 + 「仅限本机访问」', lanHost.status === 403 && /仅限本机访问/.test(lanHost.text), `${lanHost.status}`)

  const big = 'x'.repeat(1024 * 1024 + 64)
  const over = await post({ patch: { junk: big } })
  ok('超 1MiB → 413 + 中文原因', over.status === 413 && /请求体过大/.test(over.json?.error ?? ''), `${over.status}`)

  const rt = await get('?probe=runtime')
  ok('?probe=runtime 键集合 = {ok,queue,rateLimit}',
    rt.status === 200 && sameKeys(keysOf(rt.json), ['ok', 'queue', 'rateLimit']), JSON.stringify(keysOf(rt.json)))
  const hc = await get('?probe=host-config')
  ok('?probe=host-config 键集合 = {ok,probe}', hc.status === 200 && sameKeys(keysOf(hc.json), ['ok', 'probe']))
}

await new Promise((r) => server.close(r))
finish()
