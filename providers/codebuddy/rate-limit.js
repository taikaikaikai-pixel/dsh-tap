/**
 * providers/codebuddy/rate-limit.js — 网关限流态（429 / code 6004）解析。
 *
 * 实测错误体（2026-10-20，deepseek-v4.1-flash）：
 *   HTTP 429  {"code":6004,
 *              "msg":"您的使用量已超出频率限制，将在 2026-10-21 11:42:24 UTC+8 重置，
 *                     您也可以切换其他模型继续使用。",
 *              "requestId":"…"}
 *
 * 语义：**账号/模型级速率限制**，带明确重置时刻（UTC+8），且文案明示
 * 「可切换其他模型继续使用」——即可恢复时间点是确定的、可展示的。
 * 这不是插件缺陷，也不该被当成瞬时错误重试（重试只会继续撞限流）。
 *
 * 用途：把这条状态解析成结构化字段，供设置卡在模型行上显示
 * 「限流中 · 预计 10-21 11:42 (UTC+8) 恢复」，而不是让用户看到一段裸 JSON。
 * 放 providers/codebuddy/ 而非 core/：core/ 有禁上游词硬闸门（见
 * verify-core-generic），错误码与文案都带上游特征。
 */

/** 限流错误码（实测）。 */
export const RATE_LIMIT_CODE = 6004

/**
 * 从错误响应体解析限流态。
 * @param {unknown} rawBody 上游错误响应体（JSON 字符串或已解析对象）
 * @returns {{limited:boolean, resetAt?:number, resetText?:string, code?:number,
 *            message?:string, requestId?:string}|null}
 *          null = 不是限流态（调用方按普通错误处理）
 */
export function parseRateLimit(rawBody) {
  let obj = rawBody
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.code !== RATE_LIMIT_CODE) return null
  const msg = typeof obj.msg === 'string' ? obj.msg : ''
  return {
    limited: true,
    code: RATE_LIMIT_CODE,
    message: msg,
    requestId: typeof obj.requestId === 'string' ? obj.requestId : undefined,
    // 文案里的重置时刻：「将在 2026-10-21 11:42:24 UTC+8 重置」
    ...parseResetAt(msg),
  }
}

/**
 * 从文案里抽重置时刻。时区恒为 UTC+8（官方文案固定写法）。
 * 抽不到就只回 message，**不编造时间**。
 */
function parseResetAt(msg) {
  const m = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}:\d{2})\s*UTC\+8/.exec(msg)
  if (!m) return {}
  // UTC+8 → 本地 epoch：减去 8 小时偏移
  const asUtc = Date.parse(`${m[1]}T${pad(m[2])}Z`) - 8 * 3600 * 1000
  if (!Number.isFinite(asUtc)) return {}
  return {
    resetAt: asUtc,
    resetText: `${m[1]} ${m[2]} (UTC+8)`,
  }
}

const pad = (t) => (/^\d:\d\d:\d\d$/.test(t) ? `0${t}` : t)

/**
 * 给调用方的统一出口：是不是限流、还要等多久（毫秒）。
 * 供桥决定是否回 429 + Retry-After（让宿主退避而不是连发）。
 */
export function rateLimitRetryAfterSeconds(parsed) {
  if (!parsed?.limited || !Number.isFinite(parsed.resetAt)) return null
  const ms = parsed.resetAt - Date.now()
  if (ms <= 0) return null // 已过重置点：当普通错误，让下一轮自然成功
  return Math.max(1, Math.ceil(ms / 1000))
}
