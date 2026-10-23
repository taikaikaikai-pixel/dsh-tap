/**
 * providers/protocols/index.js — 两个本机客户端协议面（Anthropic Messages /
 * OpenAI Responses）的**共享装配：全仓唯一一份**。
 *
 * 存在理由（踩坑 #63 的成对审计纪律）：这两个面此前只在
 * `providers/loopback-gateway.js`（Trae :3902 / Qoder :3903 的翻译网关）上装配，
 * 于是**只有启用了 Trae/Qoder 的用户**才拿到 `/v1/messages` 与 `/v1/responses`；
 * CodeBuddy 是默认主通道，它的桥（core/bridge.js，:3901）必须挂同一对协议面。
 * 若在桥侧再抄一份 `createXxxProtocol({invokeChat, note})` 的装配，两个挂载点的
 * 路由判据、未实现字段披露、错误兜底就会各走各的——正是 #63 说的「单侧覆盖即
 * 断点」。所以装配抽到这里，两个挂载点各自只提供**自己那条内部 chat 面**的
 * `invokeChat`：
 *
 *   - 翻译网关（loopback-gateway）：`invokeChat` = chat-capture 驱动本通道的
 *     `handleChat`（Trae/Qoder 翻译层）；
 *   - CodeBuddy 桥（core/bridge.js）：`invokeChat` = chat-capture 驱动桥暴露的
 *     `handleChat`（内部 OpenAI chat 面，见 core/bridge.js 的 `handleChat`）。
 *
 * 接缝形状刻意做成**通用**的：core/ 只看到 `{ handle(req, res, rawBody) →
 * Promise<boolean> }`——「你处理了吗」；core 里不出现任何协议名/上游名（纪律由
 * scripts/verify-core-generic.mjs 静态锁）。路由判据（method + path）留在本文件，
 * 是 `paths` 的唯一真源。
 *
 * 纪律（与两个协议面本体一致）：
 *   - 命中即由协议面**自己**写响应，`handle` 返回 true；未命中返回 false 且
 *     **一个字节都不写**，调用方按原路继续（桥继续走通用转发，网关继续走
 *     models/404 分支）——未命中的请求行为逐字节不变。
 *   - 协议面抛错不吞（踩坑 #7：错误必须带原因），向调用方 reject，由调用方按各自
 *     的兜底回答 500；桥与网关的兜底都把原因写进响应体与 stderr。
 */

import { createAnthropicMessagesProtocol } from './anthropic-messages.js'
import { createOpenAIResponsesProtocol } from './openai-responses.js'

/** 两个协议面的入站路径（POST-only）。全仓唯一真源，见 `paths`。 */
const ANTHROPIC_PATH = '/v1/messages'
const RESPONSES_PATH = '/v1/responses'

/**
 * 建两个协议面的共享装配。
 *
 * @param {object} deps
 * @param {(req, res, chatPayload, sink) => Promise<void>} deps.invokeChat 驱动
 *   **本挂载点自己的**内部 OpenAI chat 面（两个挂载点各给一条，见文件头）。
 * @param {(message: string) => void} [deps.note] 未实现字段的如实披露出口（stderr）。
 * @returns {{ paths: string[], handle: (req, res, rawBody) => Promise<boolean> }}
 */
export function createProtocolSurfaces({ invokeChat, note = () => {} }) {
  const anthropic = createAnthropicMessagesProtocol({ invokeChat, note })
  const responses = createOpenAIResponsesProtocol({ invokeChat, note })

  return {
    // 调用方可以只问「这条路径归你吗」再决定是否 await（网关的同步路由分支
    // 就是这么用的），避免为了一个布尔值把整条路由改成续延式。
    paths: [ANTHROPIC_PATH, RESPONSES_PATH],

    /**
     * 命中即由协议面写响应并返回 true；未命中返回 false 且不写任何字节。
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} rawBody 已一次解码的请求体（踩坑 #28）
     * @returns {Promise<boolean>}
     */
    async handle(req, res, rawBody) {
      if (req.method !== 'POST') return false
      const path = req.url?.split('?')[0] ?? ''
      const surface = path === ANTHROPIC_PATH ? anthropic : path === RESPONSES_PATH ? responses : null
      if (!surface) return false
      await surface.handle(req, res, rawBody)
      return true
    },
  }
}
