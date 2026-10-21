/**
 * core/quota-cache.js — 额度快照的**通用**记忆化（provider 无关，可离线测）。
 *
 * 各订阅通道的额度快照共用同一条成本纪律：60s memoize，让设置卡与主界面额度卡
 * 能轮询而不打爆上游；并发读者共享同一在飞请求。这两条以前每个适配器各写一遍
 * （三份复制），差异只会在改动时漂移，故收到这里 —— 与 rotation/json-store 同级，
 * 禁止任何上游名词（verify-core-generic 静态扫描本目录）。
 *
 * 两条额外硬规则（对所有调用方一致）：
 *   - `read({ fresh: true })` 越过 TTL，但**每个 forceFloorMs（默认 15s）只放行一次**。
 *     悬停、双标签页、点刷新连击都靠这条吸收：用户点开就要新数，但不能变成上游洪峰。
 *   - `load()` 抛错**不写缓存**（踩坑 #21：坏块毒化会让之后每个读者都拿到同一次失败，
 *     且永不自愈）。调用方通常把错误归一成 `{ error }` 再交给这里；真抛出来也安全。
 */

/**
 * @param {object} options
 * @param {() => Promise<any>} options.load 打上游取快照（可自行 catch 成 { error }）。
 * @param {number} [options.ttlMs] 常规 TTL，默认 60s（与设置卡既有口径一致）。
 * @param {number} [options.forceFloorMs] fresh 强制刷新的地板，默认 15s。
 * @param {() => number} [options.now] 可注入时钟（测试用）。
 * @returns {{ read: (opts?: {fresh?: boolean}) => Promise<any>, peek: () => any, reset: () => void }}
 */
export function createQuotaCache({ load, ttlMs = 60_000, forceFloorMs = 15_000, now = Date.now } = {}) {
  if (typeof load !== 'function') throw new TypeError('createQuotaCache 需要 load 函数')
  let cached = { at: 0, value: null }
  let inFlight = null

  /**
   * 取快照。窗口 = fresh 走地板、常规走 TTL；窗口内直接复用，否则打一发（单飞）。
   * 注意新鲜度的判据是 **最近一次成功** 的 at —— 失败不会推进 at，所以失败后的
   * 下一次读取仍会重试（配合"不缓存错误"）。
   */
  function read({ fresh = false } = {}) {
    if (cached.value !== null) {
      const window = fresh ? forceFloorMs : ttlMs
      if (now() - cached.at < window) return Promise.resolve(cached.value)
    }
    if (inFlight) return inFlight
    inFlight = Promise.resolve()
      .then(load)
      .then((value) => {
        cached = { at: now(), value }
        return value
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    read,
    /** 已缓存的快照（无则 null）：给"先渲染旧值再刷新"的场景用。 */
    peek: () => cached.value,
    /** 丢弃缓存（凭据变更/登出时由调用方决定是否使用）。 */
    reset: () => {
      cached = { at: 0, value: null }
    },
  }
}
