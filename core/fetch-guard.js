/**
 * core/fetch-guard.js — 上游调用的超时/错误归一（provider 无关，可离线测）。
 *
 * 为什么需要它：host 里 17 处上游 `fetch` 从来没带 abort（额度、目录、登录
 * 轮询/刷新、上报）。Node 的 undici 默认「响应头 300s」——上游连上不回应时，
 * 一次「模型同步 / 额度刷新 / 登录轮询」会把请求挂五分钟：设置卡 20s 先报
 * 「网络」，宿主侧那条请求却还活着；OAuth 轮询循环的 deadline 检查也永远
 * 走不到（它卡在 await 里）。
 *
 * 纪律：**按面分类超时**，不搞一个万能值——目录面可以慢（30s），额度面要快
 * （15s），OAuth 面更快（10s），纯上报（失败也无所谓）最短（8s）。
 *
 * 错误形态：超时/网络失败都归成带 `kind` 的 Error，调用方据此给出可读中文，
 * 而不是把 undici 的英文原文丢给用户。
 *   - `kind: 'timeout'`   → 请求超时（已 abort）
 *   - `kind: 'aborted'`   → 调用方自己的 signal 取消（如客户端断开）
 *   - `kind: 'network'`   → 连接/解析层失败
 */

/** 各面默认超时（毫秒）。改这里 = 改全仓上游成本纪律。 */
export const FETCH_TIMEOUTS = Object.freeze({
  catalog: 30_000,
  quota: 15_000,
  oauth: 10_000,
  report: 8_000,
  default: 15_000,
})

/** 超时后的错误：文案直接面向用户（设置卡会原样显示）。 */
export class FetchTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`请求超时（${Math.round(timeoutMs / 1000)}s 无响应）`)
    this.name = 'FetchTimeoutError'
    this.kind = 'timeout'
    this.timeoutMs = timeoutMs
  }
}

function tagError(err, kind, message) {
  const e = new Error(message)
  e.name = kind === 'aborted' ? 'FetchAbortedError' : 'FetchNetworkError'
  e.kind = kind
  e.cause = err
  return e
}

/**
 * 带超时的 `fetch`。签名与 fetch 兼容，第三参是本模块自己的选项：
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : FETCH_TIMEOUTS.default
  const external = opts.signal ?? init.signal ?? null
  // AbortSignal.timeout 只管到「响应头到达」；body 读取阶段的停顿由调用方的
  // `.json()/.text()` 触发同一个 signal 的 abort（undici 把 signal 绑到 body 流）。
  const timer = AbortSignal.timeout(timeoutMs)
  const signal = external ? AbortSignal.any([external, timer]) : timer
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (timer.aborted) throw new FetchTimeoutError(timeoutMs)
    if (external?.aborted) throw tagError(err, 'aborted', '请求已取消')
    throw tagError(err, 'network', `网络错误：${err?.message ?? String(err)}`)
  }
}
