/**
 * providers/codebuddy/oauth.js — CodeBuddy 浏览器 OAuth 设备流。
 *
 * 流程（与官方 CLI 对齐；规则化结论见 docs/rules/oauth-handshake.md，
 * 证据 docs/probes/oauth-2026-08-19.jsonl，15 条）：
 *   POST /v2/plugin/auth/state?platform=CLI  → {state, authUrl}   （创建无认证；
 *        X-No-* 三头实测是迷信——P-O3：不携带也 200；platform 必填但任意值皆可）
 *   GET  /v2/plugin/auth/token?state=…       → 11217 pending，0 → tokens
 *        （核心否定发现：pending/bogus/过期一律 11217，三态不可区分，state TTL 不可观测）
 *   GET  /v2/plugin/login/account?state=…    → {uid, nickname, …}
 *   POST /v2/plugin/auth/token/refresh       → 刷新（bogus refresh → 401+12153）
 *
 * 实例状态（refresh 单飞锁、poll 代际号、pending 视图、relogin 粘性信号）
 * 在本工厂闭包内——组合根每个插件模块实例创建一个 provider 实例，隔离语义
 * 与重构前模块全局一致。
 */

const AUTH_PENDING_CODE = 11217 // ERROR_CODES[11217]：三态同码，勿当"未完成"以外含义用
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_POLL_INTERVAL_MS = 1000

// 授权页允许的站点族：CodeBuddy（copilot.tencent.com）与 WorkBuddy
// （www.workbuddy.cn）同账户体系（docs/rules/gateway-facts.md）；codebuddy.cn
// 依据 docs/probes/oauth-token-2026-08-19.jsonl 的账户 domain 证据一并放行。
const LOGIN_SITE_SUFFIXES = ['tencent.com', 'workbuddy.cn', 'codebuddy.cn']
const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]'

/**
 * 授权页出宿主前的门禁：authUrl 由上游响应原样给出，浏览器侧直送
 * window.open / location.href（lib/client.js 两个汇）。上游被劫持/投毒时
 * 必须在此响亮失败，而不是把用户导去钓鱼页或 javascript: 串：
 *   - scheme 一律 https（authUrl 与 baseURL 双双回环时例外——离线 verify
 *     的 mock 上游走 http://127.0.0.1）；
 *   - host 必须是发起 auth/state 的 baseURL 本身或官方登录站点族（子域放行，
 *     兼容代理转发不改写 body 的部署）。
 */
function assertSafeAuthUrl(authUrl, baseURL) {
  let parsed
  try { parsed = new URL(String(authUrl)) } catch { throw new Error('authUrl 不是合法 URL') }
  let base
  try { base = new URL(baseURL) } catch { throw new Error('baseURL 不是合法 URL') }
  const loopbackPair = isLoopbackHost(parsed.hostname) && isLoopbackHost(base.hostname)
  if (parsed.protocol !== 'https:' && !loopbackPair) {
    throw new Error(`authUrl 必须使用 https（收到 ${parsed.protocol}//）`)
  }
  const hostOk = parsed.hostname === base.hostname || loopbackPair
    || LOGIN_SITE_SUFFIXES.some((s) => parsed.hostname === s || parsed.hostname.endsWith(`.${s}`))
  if (!hostOk) {
    throw new Error(`authUrl 域名 ${parsed.hostname} 不在预期登录域（${base.hostname} 或 ${LOGIN_SITE_SUFFIXES.join(' / ')} 站点族）`)
  }
}

/**
 * @param {{ readAuth: () => object, writeAuth: (v: object) => void }} deps
 *   令牌存储 IO（组合根绑定到 ~/.dsh/codebuddy-plugin-auth.json；令牌永不
 *   回传浏览器——oauthStatus() 只出视图字段）。
 */
export function createOAuth({ readAuth, writeAuth }) {
  let refreshInFlight = null
  // 进行中的 poll 代际号：logout 令其失效（poll 循环每步复查），logout 后
  // 浏览器才完成的授权不再被写回——旧实现 while 只看 deadline，logout 后
  // 10 分钟内授权仍会被重新登进。
  let pollGeneration = 0
  // 令牌存储代际号：logout 令其失效。refresh 的落盘是读-改-写（拿到新令牌后
  // writeAuth({...readAuth(), auth})——与 logout 的整体覆写竞态时，在飞刷新
  // 会把已登出的令牌写回（登出失效）。刷新落盘前比对代际，过期即丢弃结果。
  let storeGeneration = 0
  // refresh 实败（refreshOAuth 返回 undefined）的粘性信号：accessToken 还在
  // 但聊天已全 503 时，oauthStatus 必须暴露"需重新登录"而不是只报已登录。
  // 下次 refresh 成功自愈；logout 清除。
  let reloginNeeded = false
  const oauthPending = { active: false, authUrl: '', error: '' }

  /**
   * Exchange the refresh token for a fresh access token (single-flight).
   * Mirrors the official CLI: Bearer <old access>, X-Refresh-Token, plus the
   * identity headers. Returns the updated auth store or undefined on refusal.
   */
  async function refreshOAuth(baseURL, auth) {
    if (refreshInFlight) return refreshInFlight
    const generation = storeGeneration
    refreshInFlight = (async () => {
      try {
        const headers = {
          Accept: 'application/json',
          Authorization: `Bearer ${auth.accessToken}`,
          'X-Domain': auth.domain ?? '',
          'X-Refresh-Token': auth.refreshToken ?? '',
        }
        if (auth.uid) headers['X-User-Id'] = auth.uid
        if (auth.enterpriseId) headers['X-Enterprise-Id'] = auth.enterpriseId
        const res = await fetch(`${baseURL}/v2/plugin/auth/token/refresh`, {
          method: 'POST',
          headers,
        })
        if (!res.ok) { reloginNeeded = true; return undefined }
        const body = await res.json().catch(() => null)
        if (!body || body.code !== 0 || !body.data?.accessToken) { reloginNeeded = true; return undefined }
        // logout 竞态守卫：代际在飞期间已变（用户点了退出）→ 丢弃刷新结果
        if (generation !== storeGeneration) return undefined
        const store = readAuth()
        store.auth = {
          accessToken: body.data.accessToken,
          expiresAt: Date.now() + (body.data.expiresIn ?? 3600) * 1000,
          refreshToken: body.data.refreshToken ?? auth.refreshToken,
          refreshExpiresAt: body.data.refreshExpiresAt != null
            ? Date.now() + body.data.refreshExpiresAt * 1000
            : auth.refreshExpiresAt,
          domain: body.data.domain ?? auth.domain,
        }
        writeAuth(store)
        reloginNeeded = false // 刷新成功自愈
        return store.auth
      } catch {
        reloginNeeded = true
        return undefined
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  /** OAuth credential branch, shared by every outbound flavor. */
  async function resolveOAuthCredential(s) {
    const store = readAuth()
    const auth = store.auth
    if (!auth?.accessToken) return null
    let current = auth
    if (auth.expiresAt && auth.expiresAt - Date.now() < 60_000) {
      const refreshed = await refreshOAuth(s.baseURL, auth)
      if (!refreshed) return null
      current = refreshed
    }
    const headers = { 'X-Domain': current.domain ?? '' }
    if (store.account?.uid) headers['X-User-Id'] = store.account.uid
    if (store.account?.enterpriseId) headers['X-Enterprise-Id'] = store.account.enterpriseId
    return { authorization: `Bearer ${current.accessToken}`, headers }
  }

  async function startOAuth(baseURL) {
    if (oauthPending.active) return { started: true, authUrl: oauthPending.authUrl }
    const res = await fetch(`${baseURL}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        // X-No-* 三头：实测迷信（oauth-handshake.md P-O3，不携带也 200），
        // 为零行为变更保留，不作为能力依赖。
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
      },
    })
    if (!res.ok) throw new Error(`auth state HTTP ${res.status}`)
    const body = await res.json()
    if (body.code !== 0 || !body.data?.state) {
      throw new Error(`auth state error: ${body.code} ${body.msg ?? ''}`)
    }
    const { state, authUrl } = body.data
    // 门禁在置位 oauthPending 之前：拒绝时 pending 不激活（oauthStatus 不再
    // 外泄该 URL），组合根 oauth-start 的 catch 回 502 + 错误信息。缓存的
    // oauthPending.authUrl（上方早退分支与 oauthStatus 视图）因此必已过检
    // ——浏览器的两个导航汇（window.open / location.href）被同一单点覆盖。
    assertSafeAuthUrl(authUrl, baseURL)
    oauthPending.active = true
    oauthPending.authUrl = authUrl
    oauthPending.error = ''

    const poll = async () => {
      const gen = pollGeneration
      // 代际守卫：logout（或新一轮 start）后本 poll 已失效——循环每步复查，
      // 拿到令牌写回前再复查一次，logout 后完成的授权绝不落盘。
      const alive = () => gen === pollGeneration && oauthPending.active
      const deadline = Date.now() + LOGIN_TIMEOUT_MS
      try {
        while (alive() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS))
          if (!alive()) return
          let response
          try {
            response = await fetch(`${baseURL}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
              headers: { Accept: 'application/json', 'X-No-Authorization': 'true' },
            })
          } catch {
            continue
          }
          if (!response.ok) continue
          const body = await response.json().catch(() => null)
          if (!body) continue
          if (body.code === AUTH_PENDING_CODE) continue
          if (body.code !== 0 || !body.data?.accessToken) {
            oauthPending.error = `登录失败：${body.code} ${body.msg ?? ''}`
            return
          }
          const token = body.data
          if (!alive()) return // 令牌在飞期间用户已退出
          // Fetch the account facts before persisting.
          let account = {}
          try {
            const accRes = await fetch(`${baseURL}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token.accessToken}`,
                'X-No-User-Id': 'true',
                'X-No-Enterprise-Id': 'true',
                'X-Domain': token.domain ?? '',
              },
            })
            const accBody = await accRes.json().catch(() => null)
            if (accBody?.code === 0 && accBody.data) account = accBody.data
          } catch {
            // account facts are best-effort; tokens alone still work
          }
          if (!alive()) return // 账户信息在飞期间用户已退出
          writeAuth({
            auth: {
              accessToken: token.accessToken,
              expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
              refreshToken: token.refreshToken,
              refreshExpiresAt: token.refreshExpiresAt != null
                ? Date.now() + token.refreshExpiresAt * 1000
                : undefined,
              domain: token.domain,
            },
            account,
          })
          reloginNeeded = false // 新登录落成，旧的 refresh 失败信号作废
          return
        }
        if (alive()) oauthPending.error = '登录超时（10 分钟未完成）'
      } finally {
        // 只清自己这一代的 pending：代际已过时（logout 后用户可能又开始了
        // 新一轮登录），老 poll 不得动新 poll 的状态。
        if (gen === pollGeneration) oauthPending.active = false
      }
    }
    // Fire-and-forget, but never unhandled: writeAuth (json-store) throws
    // synchronously on ENOSPC/EACCES/EROFS, and an unhandled rejection here
    // would take the whole dsh process down (Node ≥15 default).
    poll().catch((err) => {
      oauthPending.error = String(err?.message ?? err)
    })
    return { started: true, authUrl }
  }

  /** OAuth view for the card — tokens never leave the host. */
  function oauthStatus() {
    const store = readAuth()
    const auth = store.auth
    // 需重新登录信号：refresh 令牌本身已过期（refreshExpiresAt 存了就要查），
    // 或最近一次 refresh 实败。accessToken 还在 ≠ 可用——此时聊天全 503，
    // signedIn 照常报（令牌确实在），needsRelogin 单独暴露给 UI。
    const refreshExpired = typeof auth?.refreshExpiresAt === 'number' && auth.refreshExpiresAt <= Date.now()
    return {
      pending: oauthPending.active,
      authUrl: oauthPending.active ? oauthPending.authUrl : '',
      error: oauthPending.error,
      signedIn: Boolean(auth?.accessToken),
      needsRelogin: Boolean(auth?.accessToken) && (refreshExpired || reloginNeeded),
      account: store.account?.nickname ? {
        nickname: store.account.nickname,
        uid: store.account.uid,
        enterpriseName: store.account.enterpriseName ?? '',
      } : null,
      accessTokenExpiresAt: auth?.expiresAt ?? null,
    }
  }

  function logout() {
    pollGeneration++ // 终止进行中的 poll：代际失效，授权晚到也不落盘
    storeGeneration++ // 终止在飞 refresh：其落盘前的代际校验必然失败
    writeAuth({})
    reloginNeeded = false
    oauthPending.active = false
    oauthPending.error = ''
  }

  return { resolveOAuthCredential, startOAuth, oauthStatus, logout }
}
