/**
 * core/net-guard.js — 本机回环面的**唯一判定实现**（provider 无关）。
 *
 * 为什么单独一份：本插件有四个「回环端口即唯一防线」的面——流式桥、两个
 * 翻译网关、以及宿主注入的 `/dsh-tap/settings` 特权路由；另有两条「授权页
 * 出宿主前只许 http 回环」的登录门。此前每个面各写一份 Host/Origin 判定
 * （六份），其中两处把白名单字面量抄成了常量、一处只认不带端口的 hostname、
 * 一处漏了 `[::1]`。这类判定一旦分叉，等于**修了一处、留了五处洞**——
 * 2026-10 审计确认六份实现语义一致只是运气，不是结构。
 *
 * 纪律（踩坑 #80）：本文件是全仓**唯一**允许出现回环主机名白名单的地方。
 * 其余文件一律 import，禁止再写 `'127.0.0.1'` 之类的判定字面量
 * （scripts/verify-gateway-core.mjs 静态扫全仓对账）。
 *
 * 判定语义（六份旧实现中语义最强的交集，逐条被 verify-gateway-core 锁定）：
 *   1. Host 头的 hostname 必须 ∈ 回环白名单（可带端口，URL 解析后比较；
 *      IPv6 经 URL 解析保留方括号，故 `[::1]` 与裸 `::1` 都收）。
 *   2. 无 Origin 放行：本机 fetch/curl 与应用壳转发都剥 Origin；Host 门
 *      已把表面限制在回环。
 *   3. 带 Origin 时其 `host:port` 必须与 Host **完全相等**——浏览器跨站
 *      请求（含 sendBeacon 的 text/plain 免预检形态）恒带 Origin。
 *   4. 例外面（仅设置路由）：`allowedOrigins` 里的完整串精确放行——桌面壳
 *      发 `Origin: dsh-app://app`，不是 http 形态，无法与回环 Host 比对。
 *
 * 本文件**不产出面向用户的文案**：判定结果只有结构化 code，中文/英文措辞
 * 归各面（设置路由说中文，网关说英文 OpenAI 信封）。
 */

/** Host 头里允许出现的回环主机名（裸 `::1` 是宿主直传的原始形态，[::1] 是 URL 解析形态）。 */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 已解析 hostname 是否回环。
 * @param {string} hostname `new URL(...).hostname` 的结果（IPv6 带方括号）
 */
export function isLoopbackHostname(hostname) {
  return typeof hostname === 'string' && LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * Host 头（可带端口，如 `127.0.0.1:3901` / `[::1]:3901`）→ hostname。
 * 解析失败返回 null（调用方一律当拒绝处理，不猜）。
 * @param {string} host
 * @returns {string|null}
 */
export function hostHeaderHostname(host) {
  if (typeof host !== 'string' || host === '') return null
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/** Host 头是否回环（解析失败即 false）。 */
export function isLoopbackHostHeader(host) {
  return isLoopbackHostname(hostHeaderHostname(host))
}

/**
 * Origin 门：无 Origin 放行；有则 host:port 必须与 Host 完全一致。
 * @param {{ headers: Record<string, string|undefined> }} req
 */
export function originMatchesHost(req) {
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

/**
 * 单入口判定：Host 门 + Origin 门（含 allowedOrigins 例外）。
 *
 * @param {{ headers: Record<string, string|undefined> }} req
 * @param {{ allowedOrigins?: string[] }} [options] 精确匹配的 Origin 白名单
 * @returns {null | { code: 'host'|'origin', host: string|null, origin?: string }}
 *   null = 放行；否则给结构化拒绝原因，由各面翻译成自己的 403 报文。
 */
export function localGuardFailure(req, { allowedOrigins = [] } = {}) {
  const host = req.headers?.host
  const hostname = hostHeaderHostname(host)
  if (!hostname || !isLoopbackHostname(hostname)) {
    return { code: 'host', host: host ?? null }
  }
  const origin = req.headers?.origin
  if (origin === undefined) return null
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return null
  if (originMatchesHost(req)) return null
  return { code: 'origin', host: host ?? null, origin }
}
