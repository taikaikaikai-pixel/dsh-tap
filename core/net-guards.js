/**
 * core/net-guards.js — 回环面的共用判定（provider 无关）。
 *
 * 为什么要有这个模块：本插件的所有本地面（各上游的本地流式桥、两条订阅通道
 * 的翻译网关、`/dsh-tap/settings` 设置路由、各 OAuth 授权页门禁、baseURL
 * 明文校验）都要回答同一个问题——「这个 Host/Origin/hostname 是不是回环」。
 * 此前六处各写一份（core/bridge、两个 provider 的 gateway、两个 provider 的
 * oauth、index.js），其中三份是四元素白名单、三份是三元素子集。**同一道安全门
 * 的多份副本就是多份漂移面**：踩坑 #63（同类防护跨子面成对审计，单侧覆盖断点
 * 即缺陷）——改一处漏一处即留下缺口，且不会有任何测试报警。收成一份，改即全改。
 *
 * 白名单含 `::1` 与 `[::1]` 两种写法：裸 Host 值可能给 `::1`；而 `new URL()`
 * 解析出的 IPv6 hostname 保留方括号（即 `[::1]`）——两个入口形态都要覆盖。
 *
 * 本模块必须保持 provider 无关（scripts/verify-core-generic.mjs 静态扫描）。
 */

/** 回环主机名白名单。 */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 裸 hostname 是否回环（调用方已自行解析，如 `new URL(x).hostname`）。 */
export function hostnameIsLoopback(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * Host 头是否指向回环。Host 值可带端口，故用 URL 解析出 hostname 再比对；
 * 解析失败（空值/畸形）一律拒绝。
 */
export function hostIsLoopback(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return false
  }
}

/**
 * Origin 门：浏览器跨站请求（含无预检的 `navigator.sendBeacon` text/plain
 * 形态）恒带 Origin，其 host:port 必须与 Host 头完全一致，否则即借浏览器烧
 * 用户上游额度的 CSRF。**无 Origin 放行**：本机 fetch/curl 与剥掉 Origin 的
 * 宿主壳转发都不带该头，且 Host 门仍把守回环；非浏览器客户端本来就能伪造
 * Origin，这道门对它们不构成约束（踩坑 #61）。
 */
export function originMatchesHost(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}
