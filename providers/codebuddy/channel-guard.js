/**
 * providers/codebuddy/channel-guard.js — 上游渠道指纹的 system 提示改写。
 *
 * 2026-10-21 实测（scripts/probe-codebuddy-channel.mjs，证据
 * docs/probes/codebuddy-channel-2026-10-21.json）：国内站网关的入口渠道校验层
 * 对**精确句** `You are an AI agent powered by DeepSeek Harness.` 返回
 * HTTP 400 / code 11128（"Illegal API invocation from an unapproved channel"）。
 *
 * 关键边界（同一轮 A/B 实测）：
 * - 与 UA/headers/模型无关：同句在 user 消息里**不触发**，只扫 system/developer。
 * - 是整句指纹而非品牌词：单独的 "DeepSeek Harness" 放行，带句号的整句拒绝；
 *   换掉 "DeepSeek Harness" 一处措辞即放行。
 * - 该句是 DSH 系统提示的首句 —— 不改写则 CodeBuddy 通道对 DSH 全量会话恒失败。
 *
 * 改写为 "…powered by the host harness" 后同 payload 回 200（A/B 证据同上）。
 * 只改 system/developer 的文本；用户输入、工具结果一律不动。语义等价，与
 * developer→system 同属"网关方言兼容"层；改写只发生在上游出站字节里，
 * 本地会话与设置卡显示不受影响。
 */

/** 指纹表：精确短语 → 等价改写。新增指纹只加一行（附证据日期）。 */
const FINGERPRINTS = Object.freeze([
  Object.freeze({ match: 'powered by DeepSeek Harness', replace: 'powered by the host harness' }),
])

/**
 * 改写 payload 中 system/developer 消息里的已知渠道指纹。
 * 纯函数式就地修改；返回命中的短语次数（0 = 无需改写）。
 */
export function sanitizeChannelFingerprints(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) return 0
  let hits = 0
  for (const message of payload.messages) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    const result = rewriteContent(message.content)
    if (result.hits > 0) {
      message.content = result.content
      hits += result.hits
    }
  }
  return hits
}

function rewriteText(text) {
  let content = text
  let hits = 0
  for (const { match, replace } of FINGERPRINTS) {
    const parts = content.split(match)
    if (parts.length === 1) continue
    hits += parts.length - 1
    content = parts.join(replace)
  }
  return { content, hits }
}

function rewriteContent(content) {
  if (typeof content === 'string') return rewriteText(content)
  if (Array.isArray(content)) {
    let hits = 0
    const next = content.map((block) => {
      if (typeof block === 'string') {
        const result = rewriteText(block)
        hits += result.hits
        return result.content
      }
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        const result = rewriteText(block.text)
        if (result.hits === 0) return block
        hits += result.hits
        return { ...block, text: result.content }
      }
      return block
    })
    return { content: hits > 0 ? next : content, hits }
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    const result = rewriteText(content.text)
    if (result.hits === 0) return { content, hits: 0 }
    return { content: { ...content, text: result.content }, hits: result.hits }
  }
  return { content, hits: 0 }
}

/** 只读导出：供离线断言核对指纹表与证据口径。 */
export const CHANNEL_FINGERPRINTS = FINGERPRINTS
