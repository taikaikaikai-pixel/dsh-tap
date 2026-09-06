/**
 * providers/trae/oauth.js — TraeWork CN OAuth 设备流（自持设备密钥）。
 *
 * 流程（2026-08-23 无凭据实测校准；规则化结论见 docs/rules/oauth-handshake.md）：
 *   1. 本地回环服务 127.0.0.1:<随机端口>，唯一端点 GET /authorize；
 *   2. 授权页 URL = <loginHost>/authorization?…&code_challenge=S256…（PKCE）；
 *   3. 浏览器完成登录后 302 回 /authorize?userInfo=…&authCodeInfo=…（JSON 字符串
 *      内嵌 AuthCode）；
 *   4. POST <authBase>/trae/api/v3/oauth/ExchangeToken（AuthCode 模式）：
 *      {ClientID, AuthCode, CodeVerifier, DeviceInfo{…DevicePublicKey}, IDEVersion}
 *      → Result.{Token, RefreshToken, TokenExpireAt, TokenExpireDuration, RefreshExpireAt}；
 *   5. 刷新 = 同端点 RefreshToken 模式 + DeviceProof{Signature,Timestamp,Nonce}：
 *      签名串逐行拼接 "POST\n/trae/api/v3/oauth/ExchangeToken\n<ClientID>\n
 *      <RefreshToken>\n<Timestamp>\n<Nonce>"，ECDSA P-256/SHA-256。
 *
 * 关键设计：设备密钥对由**本插件生成并持有**（首次登录时创建 P-256 PKCS#8，
 * 存 ~/.dsh/trae-plugin-auth.json），DeviceInfo.DevicePublicKey 上报公钥——因此
 * refresh 的 DeviceProof 签名完全可自控，不依赖官方 IDE 的安全存储（traework-cn.md
 * 关键判断 #5 只针对"偷 IDE 的 refresh token"路线，本路线不受其限制）。
 *
 * 实测锚点（2026-08-23，无凭据探测）：
 *   - ExchangeToken 双路径均存活；假 ClientID → 400 code 10101 "Invalid client."；
 *     真实 ClientID + 假 AuthCode → 400 code 10101 "无效参数：{__Message.field}."；
 *   - GetUserInfo 无 token → 401 code 20310 "The user is not logged in,"；
 *   - 错误信封均为火山系 ResponseMetadata.Error{Code,Message,StandardCode}。
 *
 * 实例状态（refresh 单飞锁、pending 回环服务句柄）在本工厂闭包内（踩坑 #20 纪律）。
 */

import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, randomInt, randomUUID, sign, createPrivateKey } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLIENT_ID_SOLO_LITE = 'en1oxy7wnw8j9n' // SOLO Lite 分支默认（traework-cn.md §3）
const CLIENT_ID_TRAE = 'ono9krqynydwx5' // 普通 TRAE 分支默认
const PLATFORM_CODE = 'SOLO_PC'
const IDE_VERSION = '0.1.52'
const PLUGIN_VERSION = '2.3.73734'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** 秒级时间戳与毫秒级并存于线上响应（doc 示例是秒），统一归一到毫秒。 */
function normalizeExpiry(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value > 1e12 ? value : value * 1000
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

/** HTML 转义（审计 [10]/[15]/[21]/[24]）：登录回调页以 text/html 应答，所有
 *  来自 URL query / 上游响应的插值必须先转义，杜绝回环页上的脚本注入。 */
function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 从设备身份生成出站 DeviceInfo（公钥用 SPKI base64，私钥永不出存储）。 */
function deviceInfoFrom(device) {
  return {
    DeviceID: device.deviceId,
    MachineID: device.machineId,
    PlatformCode: PLATFORM_CODE,
    DeviceType: 'PC',
    DeviceName: device.deviceName,
    DeviceModel: device.deviceModel,
    ClientVersion: IDE_VERSION,
    DevicePublicKey: device.devicePublicKey,
    DeviceBrand: device.deviceBrand,
    DeviceCPU: device.deviceCpu,
    OSInfo: device.osInfo,
    OSVersion: device.osVersion,
  }
}

/** 解析 ExchangeToken 响应（成功 Result / 失败 ResponseMetadata.Error）。 */
function parseExchangeResult(body) {
  if (!body || typeof body !== 'object') return { error: '响应不是 JSON 对象' }
  if (body.Result?.Token) {
    const r = body.Result
    return {
      token: r.Token,
      refreshToken: r.RefreshToken ?? null,
      expiresAt: normalizeExpiry(r.TokenExpireAt),
      refreshExpiresAt: normalizeExpiry(r.RefreshExpireAt),
    }
  }
  const err = body.ResponseMetadata?.Error
  if (err) return { error: `ExchangeToken ${err.Code}：${err.Message}` }
  return { error: `ExchangeToken 响应缺少 Result.Token` }
}

/**
 * @param {{
 *   readAuth: () => object, writeAuth: (v: object) => void,
 * }} deps 令牌存储 IO（组合根绑定 ~/.dsh/trae-plugin-auth.json；令牌与设备
 *   私钥永不回传浏览器——oauthStatus() 只出视图字段）。
 */
export function createTraeOAuth({ readAuth, writeAuth }) {
  let refreshInFlight = null
  const pending = { active: false, authUrl: '', error: '' , closeServer: null }

  /** 首次使用时生成并持久化设备身份 + P-256 密钥对（幂等）。 */
  function ensureDevice(store) {
    if (store.device?.privateKeyPem && store.device?.clientId) return store.device
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const device = {
      clientId: CLIENT_ID_SOLO_LITE,
      // 设备标识形态对齐官方日志：十进制设备 id + 64 hex 机器 id。16 位、
      // 首位非零——node:crypto 随机（审计 [16]：Math.random 可预测，凭据栈禁用）。
      deviceId: Array.from({ length: 16 }, (_, i) => randomInt(i === 0 ? 1 : 0, 10)).join(''),
      machineId: randomBytes(32).toString('hex'),
      deviceName: 'DESKTOP-' + randomBytes(4).toString('hex').toUpperCase(),
      deviceModel: 'PC',
      deviceBrand: 'volcengine',
      deviceCpu: 'AMD64',
      osInfo: 'Windows',
      osVersion: '10.0.26100',
      devicePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      // DeviceProof 签名编码：DER（node:crypto 原生）；若线上校验要求 IEEE-P1363
      // 裸签名，改为 'raw'（DER→r||s 转换在 signDeviceProof 内）。
      signatureFormat: 'der',
    }
    const next = { ...store, device }
    writeAuth(next)
    return device
  }

  function derToRaw(der) {
    // SEQUENCE(r INTEGER, s INTEGER) → 32+32 大端拼接
    let offset = 2
    if (der[1] & 0x80) offset += der[1] & 0x7f
    const readInt = () => {
      const len = der[offset + 1]
      offset += 2
      const bytes = der.subarray(offset, offset + len)
      offset += len
      // 去掉前导 0x00，左填充到 32 字节
      const stripped = bytes[0] === 0 ? bytes.subarray(1) : bytes
      return Buffer.concat([Buffer.alloc(32 - stripped.length), stripped])
    }
    return Buffer.concat([readInt(), readInt()])
  }

  function signDeviceProof(device, refreshToken, timestamp, nonce) {
    const stringToSign = ['POST', '/trae/api/v3/oauth/ExchangeToken', device.clientId, refreshToken, String(timestamp), nonce].join('\n')
    const key = createPrivateKey(device.privateKeyPem)
    const der = sign('sha256', Buffer.from(stringToSign, 'utf8'), key)
    const sig = device.signatureFormat === 'raw' ? derToRaw(der) : der
    return sig.toString('base64')
  }

  /** RefreshToken 模式换新 token（单飞；失败返回 undefined 不抛）。 */
  async function refreshOAuth(s, auth) {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      try {
        const store = readAuth()
        const device = ensureDevice(store)
        const timestamp = Math.floor(Date.now() / 1000)
        const nonce = randomBytes(16).toString('hex')
        const body = {
          ClientID: device.clientId,
          ClientSecret: '',
          RefreshToken: auth.refreshToken,
          DeviceInfo: deviceInfoFrom(device),
          DeviceProof: {
            Signature: signDeviceProof(device, auth.refreshToken, timestamp, nonce),
            Timestamp: timestamp,
            Nonce: nonce,
          },
          IDEVersion: IDE_VERSION,
        }
        const res = await fetch(`${s.traeAuthBaseURL}/trae/api/v3/oauth/ExchangeToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        })
        const parsed = parseExchangeResult(await res.json().catch(() => null))
        if (parsed.error) return undefined
        const next = {
          accessToken: parsed.token,
          expiresAt: parsed.expiresAt ?? (Date.now() + 3600_000),
          refreshToken: parsed.refreshToken ?? auth.refreshToken,
          refreshExpiresAt: parsed.refreshExpiresAt ?? auth.refreshExpiresAt ?? null,
        }
        writeAuth({ ...readAuth(), auth: next })
        return next
      } catch {
        return undefined
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  /** 每次出站共用的凭据分支：临期自动刷新，双头形态（Cloud-IDE-JWT + x-cloudide-token）。 */
  async function resolveTraeCredential(s) {
    const store = readAuth()
    const auth = store.auth
    if (!auth?.accessToken) return null
    let current = auth
    if (auth.refreshToken && auth.expiresAt && auth.expiresAt - Date.now() < 60_000) {
      const refreshed = await refreshOAuth(s, auth)
      if (!refreshed) return null
      current = refreshed
    }
    return {
      authorization: `Cloud-IDE-JWT ${current.accessToken}`,
      headers: { 'x-cloudide-token': current.accessToken, 'X-User-Region': 'CN' },
    }
  }

  /**
   * 启动登录：开回环回调服务 → 返回授权页 URL。浏览器 302 回 /authorize 后，
   * 回调内完成 AuthCode→Token 交换与账号信息拉取，然后关闭服务。
   */
  async function startOAuth(s) {
    if (pending.active) return { started: true, authUrl: pending.authUrl }

    // 基址前置校验（开回环服务之前）：traeLoginHost 保存侧已过 validateBaseURL
    // （组合根），但手改设置文件仍可能塞进 javascript: 之类非法值——在此响亮
    // 失败，而不是拼出可执行授权页 URL 直送浏览器导航。与 codebuddy 的
    // assertSafeAuthUrl 不同：本 URL 的 host 来自本地用户设置而非上游响应，
    // 故只做基址校验、不做站点族校验。校验置于 listen 之前：失败时不遗留
    // 回环监听句柄。
    let loginBase
    try {
      loginBase = new URL(s.traeLoginHost)
    } catch {
      throw new Error('traeLoginHost 不是合法 URL')
    }
    if (loginBase.protocol !== 'http:' && loginBase.protocol !== 'https:') {
      throw new Error('traeLoginHost 必须使用 http 或 https')
    }

    const store = readAuth()
    const device = ensureDevice(store)
    const codeVerifier = b64url(randomBytes(48))
    const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())
    const traceId = randomUUID()

    const server = createServer((req, res) => { handleCallback(req, res) })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = server.address().port
    const callbackUrl = `http://127.0.0.1:${port}/authorize`

    const params = new URLSearchParams({
      login_version: '1',
      auth_from: 'solo',
      login_channel: 'native_ide',
      plugin_version: PLUGIN_VERSION,
      auth_type: 'local',
      client_id: device.clientId,
      redirect: '0',
      login_trace_id: traceId,
      auth_callback_url: callbackUrl,
      machine_id: device.machineId,
      device_id: device.deviceId,
      x_device_id: device.deviceId,
      x_machine_id: device.machineId,
      x_device_brand: device.deviceBrand,
      x_device_type: device.osInfo,
      x_os_version: device.osVersion,
      x_app_version: IDE_VERSION,
      x_app_type: 'stable',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      hide_saas_login: 'true',
    })
    // URL 解析构造：合法 http(s) 基址 + 路径绝对引用恒可解析；基址带尾路径或
    // 尾斜杠时以 /authorization 为准（旧字符串拼接会产出 `//authorization`
    // 双斜杠或把基址路径串进授权页路径）。
    const authUrl = new URL(`/authorization?${params.toString()}`, loginBase).toString()

    pending.active = true
    pending.authUrl = authUrl
    pending.error = ''
    pending.closeServer = () => {
      try { server.closeAllConnections?.(); server.close() } catch { /* best-effort */ }
      pending.closeServer = null
    }
    const timer = setTimeout(() => {
      if (pending.active) pending.error = '登录超时（10 分钟未完成回调）'
      pending.active = false
      pending.closeServer?.()
    }, LOGIN_TIMEOUT_MS)
    timer.unref?.()

    /** 回调处理：解析 query → 交换 token → 拉账号 → 落盘 → 应答成功页。 */
    async function handleCallback(req, res) {
      const finish = (html, logErr) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        clearTimeout(timer)
        pending.active = false
        pending.closeServer?.()
        if (logErr) pending.error = logErr
      }
      try {
        const url = new URL(req.url, callbackUrl)
        if (url.pathname !== '/authorize') {
          finish('<h3>404</h3>')
          return
        }
        const q = url.searchParams
        const errCode = q.get('error_code')
        if (errCode) {
          const errMsg = q.get('error_msg') ?? ''
          // query 是外部输入：进 text/html 前一律转义（审计 [10]/[15]/[21]/[24]）。
          // pending.error 是 JSON 状态视图字段（设置卡按 React 文本节点渲染），
          // 保持原文不双转义。
          finish(`<h3>登录失败</h3><p>${esc(errCode)} ${esc(errMsg)}</p>`,
            `登录失败：${errCode} ${errMsg}`)
          return
        }
        let authCode = null
        try {
          const info = JSON.parse(q.get('authCodeInfo') ?? 'null')
          authCode = info?.AuthCode ?? info?.authCode ?? null
        } catch { /* not JSON */ }
        if (!authCode) {
          finish('<h3>回调缺少 AuthCode</h3>', '回调缺少 AuthCode')
          return
        }
        const body = {
          ClientID: device.clientId,
          AuthCode: authCode,
          CodeVerifier: codeVerifier,
          DeviceInfo: deviceInfoFrom(device),
          IDEVersion: IDE_VERSION,
        }
        const res2 = await fetch(`${s.traeAuthBaseURL}/trae/api/v3/oauth/ExchangeToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        })
        const parsed = parseExchangeResult(await res2.json().catch(() => null))
        if (parsed.error) {
          finish(`<h3>Token 交换失败</h3><p>${esc(parsed.error)}</p>`, parsed.error)
          return
        }
        const auth = {
          accessToken: parsed.token,
          expiresAt: parsed.expiresAt ?? (Date.now() + 3600_000),
          refreshToken: parsed.refreshToken,
          refreshExpiresAt: parsed.refreshExpiresAt ?? null,
        }
        // 账号信息尽力而为（GetUserInfo，双头形态）。
        let account = {}
        try {
          const acc = await fetch(`${s.traeAuthBaseURL}/cloudide/api/v3/trae/GetUserInfo`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Cloud-IDE-JWT ${auth.accessToken}`,
              'x-cloudide-token': auth.accessToken,
              'X-User-Region': 'CN',
            },
          })
          const accBody = await acc.json().catch(() => null)
          const r = accBody?.Result
          if (r && typeof r === 'object') {
            account = {
              // 2026-08-24 实测：GetUserInfo 的昵称字段是 ScreenName。
              nickname: r.ScreenName ?? r.Name ?? r.Nickname ?? r.UserName ?? r.DisplayName ?? null,
              uid: r.UserId ?? r.UserID ?? r.Uid ?? null,
              email: r.Email ?? null,
            }
          }
        } catch { /* best-effort */ }
        writeAuth({ ...readAuth(), auth, account })
        finish('<h3>登录成功</h3><p>可以回到 dsh 设置卡继续。</p>')
      } catch (err) {
        const errMsg = String(err?.message ?? err)
        finish(`<h3>登录处理异常</h3><p>${esc(errMsg)}</p>`, errMsg)
      }
    }

    return { started: true, authUrl }
  }

  /** 视图（令牌/私钥永不出宿主）。 */
  function oauthStatus() {
    const store = readAuth()
    const auth = store.auth
    const acct = store.account ?? {}
    return {
      pending: pending.active,
      authUrl: pending.active ? pending.authUrl : '',
      error: pending.error,
      signedIn: Boolean(auth?.accessToken),
      account: acct.nickname || acct.uid ? { nickname: acct.nickname, uid: acct.uid } : null,
      accessTokenExpiresAt: auth?.expiresAt ?? null,
      refreshExpiresAt: auth?.refreshExpiresAt ?? null,
      signatureFormat: store.device?.signatureFormat ?? null,
    }
  }

  function logout() {
    if (pending.closeServer) { pending.closeServer(); }
    pending.active = false
    pending.error = ''
    // 设备身份保留（clientId/密钥对与该账号的设备注册绑定，重登录可复用；
    // 只清令牌与账号）。
    const store = readAuth()
    writeAuth({ device: store.device })
  }

  /** 供联调探测切换签名编码（der/raw）。 */
  function setSignatureFormat(format) {
    if (format !== 'der' && format !== 'raw') throw new Error('signatureFormat 只支持 der|raw')
    const store = readAuth()
    if (store.device) {
      store.device.signatureFormat = format
      writeAuth(store)
    }
    return format
  }

  return { resolveTraeCredential, startOAuth, oauthStatus, logout, setSignatureFormat }
}
