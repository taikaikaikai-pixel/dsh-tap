/**
 * providers/qoder/oauth.js — Qoder CN 浏览器设备流（OAuth 订阅额度跟账号走）。
 *
 * 流程（证据：@qodercn-ai/qoderclicn 1.1.57 bundle 反混淆 + 2026-09-19 无凭据探测，
 * 见 docs/reverse/qoder-cn.md）：
 *   1. 本地生成 PKCE：verifier = 43–128 字符（charset A-Za-z0-9-._~），
 *      challenge = base64url(SHA256(verifier))；nonce = UUID；machine_id 自持持久化。
 *   2. 授权页 = <loginHost>/device/selectAccounts?challenge=&challenge_method=S256
 *      &nonce=&machine_id=&client_id=<prod uuid>
 *      （实测无 cookie → 302 <loginHost>/users/sign-in?oauth_callback=…；
 *        qoder.cn 与 qoder.com.cn 双域同构）
 *   3. 轮询 GET <openapi>/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
 *      - **404 = 未完成**（bundle 契约 `markErrorStatus: s=>404!==s.status`；实测
 *        未登录/未注册 challenge 同为 404 {"errorCode":"NotFound"}）
 *      - 缺参 = 400 精确业务码（DeviceTokenNonceRequired / DeviceTokenVerifierRequired）
 *      - 间隔 1s、上限 5 分钟（bundle 常量 _Ai=1e3 / G$a=3e5）
 *      - 完成 = 200 {token, refresh_token, expires_at, refresh_token_expires_at}
 *   4. 刷新 POST <openapi>/api/v1/deviceToken/refresh {refresh_token, machine_id}
 *      → {device_token, refresh_token, expires_at, refresh_token_expires_at}
 *      **refresh_token 前缀强制 drt-**（实测 bogus → DeviceRefreshTokenPrefixInvalid）
 *   5. 出站认证 = `Authorization: Bearer <token>`（无自研签名；签名只存在于
 *      /algo COSY 面，本通道不走那一面）
 *
 * 与 codebuddy/trae 两路的形态差异：
 *   - 没有本地回环回调服务（不像 Trae 的 /authorize）——授权在服务端完成，
 *     我们只轮询，故无回调页 XSS 面；
 *   - 没有多 Key 轮换，单账号；
 *   - poll 的"未完成"是 404 而非业务码，因此**不能**把 404 当失败。
 *
 * 实例状态（refresh 单飞锁、poll 代际、pending 视图、relogin 粘性信号）全在
 * 本工厂闭包内（踩坑 #20）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_INTERVAL_MS = 1000
const REFRESH_LEAD_MS = 60_000

/** bundle 常量：prod 与 dev 两个 client_id，本通道用 prod 形态。 */
export const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/** 授权页允许的站点族：Qoder CN 官方域 + 回环（离线 mock 上游用）。 */
const LOGIN_SITE_SUFFIXES = ['qoder.cn', 'qoder.com.cn']
const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]'

const VERIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** PKCE 参数形态对齐官方 CLI：长度 43–128 随机，S256 挑战。 */
export function createPkce() {
  const len = 43 + Math.floor(Math.random() * 86)
  const bytes = randomBytes(len)
  let verifier = ''
  for (let i = 0; i < len; i++) verifier += VERIFIER_CHARSET[bytes[i] % VERIFIER_CHARSET.length]
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url')
  return { verifier, challenge }
}

/** 机器标识：48 位 hex（与官方长 hex 形态同类，随机自持，跨登录稳定）。 */
export function createMachineId() {
  return randomBytes(24).toString('hex')
}

/**
 * 有效期归一。2026-09-19 真实响应实证：poll 同时给 `expires_at`（**ISO 字符串**
 * 或数字秒）与 `expires_in`（相对秒），refresh 给 `expires_at`/`expires_in`。
 * 规则对齐 bundle 的 L4()??tIe()：纯数字串按 epoch（秒/毫秒分档）否则按 ISO 解析，
 * 再否则视为相对秒。无法判定返回 null。
 */
export function normalizeExpiry(value, now = Date.now()) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    if (n > 1e12) return n // 绝对毫秒
    if (n > 1e9) return n * 1000 // 绝对秒
    return now + n * 1000 // 相对秒
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * 授权 URL 出宿主前的门禁。
 *
 * 与 codebuddy 的 assertSafeAuthUrl 的**关键差异**：那边 authUrl 来自上游响应，
 * 故"与 baseURL 同域"是一条有效判据；这里 URL 的 host 直接来自用户设置
 * （qoderLoginHost），同域判据等于不设防（任何 https 域都能自证通过——
 * verify [5] 实测抓到这一点）。因此本门禁**不认同域**，只认：
 *   - scheme = https（回环对回环例外，供离线 mock 上游）；
 *   - host ∈ Qoder 官方站点族（qoder.cn / qoder.com.cn）或回环。
 */
function assertSafeAuthUrl(authUrl) {
  let parsed
  try { parsed = new URL(String(authUrl)) } catch { throw new Error('authUrl 不是合法 URL') }
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`authUrl 必须使用 https（收到 ${parsed.protocol}//）`)
  }
  const hostOk = isLoopbackHost(parsed.hostname)
    || LOGIN_SITE_SUFFIXES.some((s) => parsed.hostname === s || parsed.hostname.endsWith(`.${s}`))
  if (!hostOk) {
    throw new Error(`authUrl 域名 ${parsed.hostname} 不在 Qoder 官方登录站点族（${LOGIN_SITE_SUFFIXES.join(' / ')}）`)
  }
}

/** 基址前置校验：手改的设置文件可能是 javascript: / 非法 URL，必须响亮拒绝。 */
function assertLoginBase(loginHost) {
  let parsed
  try { parsed = new URL(String(loginHost)) } catch { throw new Error('qoderLoginHost 不是合法 URL') }
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`qoderLoginHost 必须使用 https（收到 ${parsed.protocol}//）`)
  }
  return parsed
}

/** poll/refresh 两形态的令牌体归一（poll 给 token，refresh 给 device_token）。 */
function tokenFrom(body, now = Date.now()) {
  const access = body?.token ?? body?.device_token ?? body?.access_token
  if (typeof access !== 'string' || !access) return null
  const refresh = body.refresh_token ?? body.refreshToken
  return {
    accessToken: access,
    // 缺字段返回 undefined（不是 null）：refresh 响应常只换 access 不带
    // refresh_token，调用方据此沿用旧值——写 null 会断掉后续续期。
    ...(refresh != null ? { refreshToken: refresh } : {}),
    expiresAt: normalizeExpiry(body.expires_at ?? body.expire_time ?? body.expires_in ?? body.expiresIn, now) ?? (now + 3600_000),
    refreshExpiresAt: normalizeExpiry(body.refresh_token_expires_at ?? body.refresh_token_expire_time ?? body.refresh_token_expires_in, now),
  }
}

/**
 * @param {{ readAuth: () => object, writeAuth: (v: object) => void }} deps
 *   令牌存储 IO（组合根绑定 ~/.dsh/qoder-plugin-auth.json；令牌与 machine_id
 *   永不回传浏览器——oauthStatus() 只出视图字段）。
 */
export function createQoderOAuth({ readAuth, writeAuth }) {
  let refreshInFlight = null
  let pollGeneration = 0
  // 令牌存储代际号：logout 令其失效。refresh 落盘是读-改-写（writeAuth
  // ({...readAuth(), auth: {...}})）——与 logout 的整体覆写竞态时，在飞刷新
  // 会把已登出的令牌写回（登出失效）。落盘前比对代际，过期即丢弃结果。
  let storeGeneration = 0
  let reloginNeeded = false
  const pending = { active: false, authUrl: '', error: '' }

  /** 机器标识幂等自持：首次使用生成并落盘，之后所有登录/刷新复用一个。 */
  function ensureMachineId() {
    const store = readAuth()
    if (typeof store.machine?.machineId === 'string' && store.machine.machineId) return store.machine.machineId
    const machineId = createMachineId()
    writeAuth({ ...store, machine: { machineId } })
    return machineId
  }

  /** 出站 URL 拼装（openapi 面）。 */
  const api = (s, path) => `${String(s.qoderOpenapiBaseURL).replace(/\/+$/, '')}${path}`

  /** 刷新（单飞；失败返回 undefined 不抛，并置 reloginNeeded）。 */
  async function refreshOAuth(s) {
    if (refreshInFlight) return refreshInFlight
    const generation = storeGeneration
    refreshInFlight = (async () => {
      try {
        const store = readAuth()
        const auth = store.auth
        if (!auth?.refreshToken) { reloginNeeded = true; return undefined }
        const res = await fetch(api(s, '/api/v1/deviceToken/refresh'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refresh_token: auth.refreshToken, machine_id: store.machine?.machineId ?? '' }),
        })
        if (!res.ok) { reloginNeeded = true; return undefined }
        const body = await res.json().catch(() => null)
        const next = tokenFrom(body)
        if (!next) { reloginNeeded = true; return undefined }
        // logout 竞态守卫：代际在飞期间已变（用户点了退出）→ 丢弃刷新结果
        if (generation !== storeGeneration) return undefined
        // 缺字段一律沿用旧值（refresh 响应常只轮换 access token）。
        const merged = {
          ...readAuth(),
          auth: {
            accessToken: next.accessToken,
            refreshToken: next.refreshToken ?? auth.refreshToken ?? null,
            expiresAt: next.expiresAt,
            refreshExpiresAt: next.refreshExpiresAt ?? auth.refreshExpiresAt ?? null,
            loginMethod: auth.loginMethod ?? 'browser',
          },
        }
        writeAuth(merged)
        reloginNeeded = false
        return merged.auth
      } catch {
        reloginNeeded = true
        return undefined
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  /** 每次出站共用：临期自动刷新；返回 {authorization, machineId, uid} 或 null。
   *  expiresAt 缺失视为临期而非永不过期——拿着未知新鲜度的凭据出门，上游 401
   *  远不如本地一次清晰刷新（有 refreshToken 时）。 */
  async function resolveQoderCredential(s) {
    const store = readAuth()
    const auth = store.auth
    if (!auth?.accessToken) return null
    let current = auth
    const stale = !auth.expiresAt || auth.expiresAt - Date.now() < REFRESH_LEAD_MS
    if (auth.refreshToken && stale) {
      const refreshed = await refreshOAuth(s)
      if (!refreshed) return null
      current = refreshed
    }
    return {
      authorization: `Bearer ${current.accessToken}`,
      machineId: store.machine?.machineId ?? null,
      uid: store.account?.uid ?? null,
    }
  }

  /** 组装授权页 URL（不发请求——设备流的 challenge 在客户端生成）。 */
  function buildAuthUrl(s, machineId) {
    const { verifier, challenge } = createPkce()
    const nonce = randomUUID()
    const params = new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      nonce,
      machine_id: machineId,
      client_id: s.qoderClientId || QODER_CLIENT_ID,
    })
    // URL 解析构造：基址带尾斜杠/尾路径时仍以 /device/selectAccounts 为准。
    const authUrl = new URL(`/device/selectAccounts?${params.toString()}`, s.qoderLoginHost).toString()
    return { authUrl, verifier, nonce }
  }

  /**
   * 启动登录：置 pending → 返回授权页 URL → 后台轮询直到出令牌/超时。
   * @returns {Promise<{started:true, authUrl:string}>}
   */
  async function startOAuth(s) {
    if (pending.active) return { started: true, authUrl: pending.authUrl }

    // 基址校验置于 machine_id 生成之前：非法设置不产生任何写入、不激活 pending。
    assertLoginBase(s.qoderLoginHost)
    const machineId = ensureMachineId()
    const { authUrl, verifier, nonce } = buildAuthUrl(s, machineId)
    // 门禁置于置位之前：拒绝时 pending 不激活，不外泄未过检的 URL。
    assertSafeAuthUrl(authUrl)

    pending.active = true
    pending.authUrl = authUrl
    pending.error = ''

    const poll = async () => {
      const gen = pollGeneration
      const alive = () => gen === pollGeneration && pending.active
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      try {
        while (alive() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS))
          if (!alive()) return
          let res
          try {
            const q = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' })
            res = await fetch(`${api(s, '/api/v1/deviceToken/poll')}?${q}`, { headers: { Accept: 'application/json' } })
          } catch {
            continue // 网络抖动：继续等，不当失败
          }
          // 404 = 未完成（bundle 契约）。绝不与"失败"混同。
          if (res.status === 404) continue
          const body = await res.json().catch(() => null)
          if (!res.ok) {
            const code = body?.errorCode ?? `HTTP ${res.status}`
            pending.error = `登录失败：${code} ${body?.errorMessage ?? ''}`.trim()
            return
          }
          const auth = tokenFrom(body)
          if (!auth) continue // 200 但无令牌：形态异常，继续观察到超时
          if (!alive()) return // 令牌在飞期间已 logout
          const account = await fetchAccount(s, auth.accessToken)
          if (!alive()) return
          writeAuth({
            ...readAuth(),
            auth: { ...auth, loginMethod: 'browser' },
            ...(account ? { account } : {}),
          })
          reloginNeeded = false
          return
        }
        if (alive()) pending.error = '登录超时（5 分钟未完成授权）'
      } finally {
        if (gen === pollGeneration) pending.active = false
      }
    }
    // fire-and-forget 必须 .catch 落地（踩坑 #33：unhandledRejection 崩宿主）。
    poll().catch((err) => { pending.error = String(err?.message ?? err) })
    return { started: true, authUrl }
  }

  /** 账号信息尽力而为（失败不影响登录成立）。 */
  async function fetchAccount(s, accessToken) {
    try {
      const res = await fetch(api(s, '/api/v1/userinfo'), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      })
      const body = await res.json().catch(() => null)
      if (!body || typeof body !== 'object') return null
      const uid = body.uid ?? body.user_id ?? body.id ?? null
      const nickname = body.name ?? body.username ?? body.user_name ?? null
      if (!uid && !nickname) return null
      return {
        uid: uid != null ? String(uid) : null,
        nickname,
        email: body.email ?? null,
        organizationId: body.organization_id ?? body.orgId ?? null,
      }
    } catch {
      return null
    }
  }

  /** 视图（令牌/machine_id 永不出宿主）。 */
  function oauthStatus() {
    const store = readAuth()
    const auth = store.auth
    const refreshExpired = typeof auth?.refreshExpiresAt === 'number' && auth.refreshExpiresAt > 0
      && auth.refreshExpiresAt <= Date.now()
    return {
      pending: pending.active,
      authUrl: pending.active ? pending.authUrl : '',
      error: pending.error,
      signedIn: Boolean(auth?.accessToken),
      needsRelogin: Boolean(auth?.accessToken) && (refreshExpired || reloginNeeded),
      account: store.account?.nickname || store.account?.uid
        ? { nickname: store.account.nickname, uid: store.account.uid }
        : null,
      accessTokenExpiresAt: auth?.expiresAt ?? null,
      refreshExpiresAt: auth?.refreshExpiresAt ?? null,
      hasMachineId: Boolean(store.machine?.machineId),
    }
  }

  function logout() {
    pollGeneration++ // 令在飞 poll 失效：logout 后才完成的授权不落盘
    storeGeneration++ // 令在飞 refresh 失效：其落盘前的代际校验必然失败
    pending.active = false
    pending.error = ''
    reloginNeeded = false
    const store = readAuth()
    writeAuth({ machine: store.machine }) // 机器标识保留，令牌与账号清除
  }

  return {
    startOAuth,
    resolveQoderCredential,
    refreshOAuth,
    oauthStatus,
    logout,
    ensureMachineId,
  }
}
