/**
 * providers/protocols/anthropic-messages.js — Anthropic Messages API 协议面。
 *
 * 目标：本机客户端（Claude Code / Anthropic SDK）把 baseURL 指到本通道的回环网关，
 * `POST /v1/messages` 即可用同一上游能力（Trae/Qoder 翻译网关背后的订阅通道）。
 *
 * 两层翻译（复用盘点结论：上游流水线一律走 `invokeChat` → 本通道既有 handleChat，
 * 不重写凭据/并发闸/配对/计量）：
 *   入站 anthropicToChat：system（串或 text 块）→ system 消息；content 块
 *     text/image/tool_use/tool_result → OpenAI text 段 / image_url / assistant
 *     .tool_calls / role:"tool"（tool_result 先于同消息的文本下发，满足 OpenAI
 *     配对顺序）；tools[{name,input_schema}] → OpenAI function 工具；tool_choice
 *     auto/any/tool → auto/required/{function}；max_tokens/temperature/top_p/
 *     stop_sequences/metadata.user_id 逐一映射。
 *   出站 translator：内部 OpenAI chunk → Anthropic SSE 事件序列
 *     message_start → content_block_start → content_block_delta
 *     （text_delta / input_json_delta）→ content_block_stop → message_delta
 *     （stop_reason + usage）→ message_stop；非流式由同一 translator 的 result()
 *     聚合出 Anthropic Message JSON。
 *
 *   工具参数**不逐片转发**：Anthropic 同一时刻只允许一个开块，且块内事件必须
 *   连续（stop 之后不得再出现该 index 的 delta）。并行 tool_calls 的增量在
 *   OpenAI 方言里可以跨索引交错（先 id/name 再陆续补参数），边收边开块会逼出
 *   「关闭上一块后再补它的 delta」的非法序列。故参数按槽缓存，`finish()` 时
 *   按槽顺序整块下发（text 增量仍实时流式）。
 *
 * 未实现（如实标注，不假装兼容）：
 *   - 扩展思考：内部 `reasoning_content` 增量**丢弃**（Anthropic thinking 块要求
 *     服务端签名 signature_delta，客户端无法伪造），不出 thinking/redacted_thinking 块；
 *   - 请求侧 `thinking` / `top_k` / `container` / `mcp_servers` / `service_tier` /
 *     `context_management` 忽略；`document`、`search_result`、未知内容块忽略；
 *   - tool_result 里的 image 块丢弃（只取文本）；
 *   - 服务端工具（web_search 等 Anthropic 托管工具，type 非 custom）不透传；
 *   - `cache_control` 断点不透传（上游缓存按内容寻址，本就与头无关）；
 *   - 不做 token 计数端点（/v1/messages/count_tokens 未实现）。
 */

import { randomUUID } from 'node:crypto'

import { createProtocolSurface } from './surface.js'

/** Anthropic 错误 type ↔ HTTP 状态（状态码按协议惯例，原因一律带在 message 里）。 */
const ERROR_TYPE_BY_STATUS = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'api_error',
  504: 'api_error',
  529: 'overloaded_error',
}

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** Anthropic 错误信封 `{"type":"error","error":{type,message}}`（message 必带原因）。 */
export function anthropicErrorEnvelope({ status = 500, message, code } = {}) {
  const type = ERROR_TYPE_BY_STATUS[status] ?? 'api_error'
  return {
    status,
    body: {
      type: 'error',
      error: { type, message: code ? `${message} [${code}]` : String(message ?? 'unknown error') },
    },
  }
}

/** Anthropic image source → OpenAI image_url（base64 / url 两形态）。 */
function imageUrlOf(source) {
  if (!source || typeof source !== 'object') return null
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' && source.media_type ? source.media_type : 'image/png'
    return `data:${media};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  return null
}

/** Anthropic tool_result.content（串或块数组）→ OpenAI tool 消息正文（只取文本）。 */
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Anthropic Messages 请求 → 内部 OpenAI chat payload。
 * 只做字段映射，不做校验（校验在 parseAnthropicRequest）。
 *
 * @returns {{chat: object, unsupported: string[]}}
 */
export function anthropicToChat(payload) {
  const unsupported = []
  const p = payload && typeof payload === 'object' ? payload : {}
  const messages = []

  if (typeof p.system === 'string' && p.system) {
    messages.push({ role: 'system', content: p.system })
  } else if (Array.isArray(p.system)) {
    const text = p.system
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    if (text) messages.push({ role: 'system', content: text })
    if (p.system.some((b) => b && typeof b === 'object' && b.type && b.type !== 'text')) unsupported.push('system blocks other than text')
  }

  for (const m of Array.isArray(p.messages) ? p.messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) continue
    const parts = []
    const toolCalls = []
    const toolResults = []
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text') {
        if (typeof b.text === 'string' && b.text) parts.push({ type: 'text', text: b.text })
      } else if (b.type === 'image') {
        const url = imageUrlOf(b.source)
        if (url) parts.push({ type: 'image_url', image_url: { url } })
        else unsupported.push('image block with unsupported source')
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: typeof b.id === 'string' && b.id ? b.id : `call_${toolCalls.length}`,
          type: 'function',
          function: { name: String(b.name ?? 'tool'), arguments: JSON.stringify(b.input ?? {}) },
        })
      } else if (b.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
          content: toolResultText(b.content),
        })
      } else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') {
        unsupported.push(`content block "${b.type}"`)
      }
    }
    // tool_result 必须先于同消息的文本（OpenAI 要求 tool 消息紧跟其 tool_calls 声明）。
    for (const tr of toolResults) messages.push(tr)
    const hasImage = parts.some((x) => x.type === 'image_url')
    const text = parts.filter((x) => x.type === 'text').map((x) => x.text).join('')
    if (role === 'assistant') {
      const msg = { role: 'assistant', content: hasImage ? parts : text }
      if (toolCalls.length) msg.tool_calls = toolCalls
      if (hasImage || text || toolCalls.length) messages.push(msg)
      continue
    }
    if (hasImage) messages.push({ role: 'user', content: parts })
    else if (text) messages.push({ role: 'user', content: text })
  }

  const tools = []
  for (const t of Array.isArray(p.tools) ? p.tools : []) {
    if (!t || typeof t !== 'object') continue
    // Anthropic 托管工具（type: web_search_* / computer_* / bash_* 等）无 input_schema，
    // 上游无法承载；只透传 custom（或未标 type）工具。
    if (t.type && t.type !== 'custom') { unsupported.push(`server tool "${t.type}"`); continue }
    if (typeof t.name !== 'string' || !t.name) continue
    tools.push({
      type: 'function',
      function: {
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
      },
    })
  }

  let toolChoice
  const tc = p.tool_choice
  if (tc && typeof tc === 'object') {
    if (tc.type === 'auto') toolChoice = 'auto'
    else if (tc.type === 'any') toolChoice = 'required'
    else if (tc.type === 'none') toolChoice = 'none'
    else if (tc.type === 'tool' && typeof tc.name === 'string' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } }
  }

  const chat = { model: p.model, messages, stream: true }
  if (Number.isFinite(p.max_tokens)) chat.max_tokens = p.max_tokens
  if (Number.isFinite(p.temperature)) chat.temperature = p.temperature
  if (Number.isFinite(p.top_p)) chat.top_p = p.top_p
  if (Array.isArray(p.stop_sequences) && p.stop_sequences.length) chat.stop = p.stop_sequences
  if (tools.length) chat.tools = tools
  if (toolChoice !== undefined) chat.tool_choice = toolChoice
  if (typeof p.metadata?.user_id === 'string' && p.metadata.user_id) chat.user = p.metadata.user_id
  if (Number.isFinite(p.top_k)) unsupported.push('top_k')
  if (p.thinking) unsupported.push('thinking (extended thinking)')
  for (const f of ['container', 'mcp_servers', 'service_tier', 'context_management']) {
    if (p[f] !== undefined) unsupported.push(f)
  }
  return { chat, unsupported }
}

/** 入站校验（Anthropic 惯例：缺 max_tokens / messages 即 400，原因写明）。 */
export function parseAnthropicRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: { status: 400, message: 'body must be a JSON object (Anthropic Messages request)', code: 'invalid_body' } }
  }
  if (typeof payload.model !== 'string' || !payload.model) {
    return { error: { status: 400, message: 'model: required non-empty string', code: 'invalid_model' } }
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { error: { status: 400, message: 'messages: required non-empty array', code: 'invalid_messages' } }
  }
  if (!Number.isFinite(payload.max_tokens) || payload.max_tokens <= 0) {
    return { error: { status: 400, message: 'max_tokens: required positive integer (Anthropic Messages API requires it)', code: 'invalid_max_tokens' } }
  }
  const { chat, unsupported } = anthropicToChat(payload)
  return { chat, stream: payload.stream === true, unsupported }
}

/** OpenAI finish_reason → Anthropic stop_reason。 */
function stopReasonOf(finishReason, hasToolUse) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'refusal'
    case 'stop_sequence': return 'stop_sequence'
    case 'stop': return hasToolUse ? 'tool_use' : 'end_turn'
    default: return hasToolUse ? 'tool_use' : 'end_turn'
  }
}

function parseArgs(text) {
  if (typeof text !== 'string' || !text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/**
 * 有状态翻译器：吃内部 OpenAI chunk，产出 Anthropic SSE 事件。
 *
 * `push(chunk)` → `{events, visible}`：visible 只对**用户可见内容**（text_delta）
 * 为真——message_start / content_block_start 不算（踩坑 #60：提交判据是用户可见
 * 内容，不是头也不是角色帧）；工具参数在 `finish()` 才成块下发，不计入增量可见性。
 * `finish()` 补齐收尾序列；`result()` 聚合非流式 Message；`error()` 出协议错误事件。
 */
export function createAnthropicTranslator({ model }) {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  let started = false
  let blockCounter = 0
  let openBlock = null // { index, kind, block }
  const blockLog = [] // 按开启顺序：{kind:'text', text} | {kind:'tool_use', slot}
  const toolOrder = []
  const toolSlots = new Map() // 内部 tool_calls index → slot
  let finishReason = null
  let inputTokens = 0
  let outputTokens = 0

  const event = (type, payload) => ({ type, ...payload })

  const messageStart = () => event('message_start', {
    message: {
      id, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      // 上游 usage 恒在末帧，开头只能给 0；真实输入 token 随 message_delta 下发。
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })

  const closeOpenBlock = (events) => {
    if (!openBlock) return
    events.push(event('content_block_stop', { index: openBlock.index }))
    openBlock = null
  }

  const openTextBlock = (events) => {
    if (openBlock?.kind === 'text') return
    closeOpenBlock(events)
    const block = { kind: 'text', text: '' }
    const index = blockCounter++
    blockLog.push(block)
    events.push(event('content_block_start', { index, content_block: { type: 'text', text: '' } }))
    openBlock = { index, kind: 'text', block }
  }

  /** tool_use 块的 content_block_start 需要 id+name 齐全，齐了才开块。 */
  const openToolBlock = (events, slot) => {
    closeOpenBlock(events)
    const index = blockCounter++
    slot.blockIndex = index
    const block = { kind: 'tool_use', slot }
    blockLog.push(block)
    events.push(event('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
    }))
    openBlock = { index, kind: 'tool_use', block }
  }

  const flushToolArgs = (events, slot) => {
    if (slot.emitted >= slot.args.length) return
    const partial = slot.args.slice(slot.emitted)
    slot.emitted = slot.args.length
    events.push(event('content_block_delta', { index: slot.blockIndex, delta: { type: 'input_json_delta', partial_json: partial } }))
  }

  const captureUsage = (usage) => {
    if (!usage || typeof usage !== 'object') return
    inputTokens = num(usage.prompt_tokens ?? usage.input_tokens, inputTokens)
    outputTokens = num(usage.completion_tokens ?? usage.output_tokens, outputTokens)
  }

  return {
    id,
    push(chunk) {
      const events = []
      let visible = false
      if (!started) { started = true; events.push(messageStart()) }
      if (!chunk || typeof chunk !== 'object') return { events, visible }
      captureUsage(chunk.usage)
      const choice = chunk.choices?.[0]
      const delta = choice?.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        openTextBlock(events)
        openBlock.block.text += delta.content
        events.push(event('content_block_delta', { index: openBlock.index, delta: { type: 'text_delta', text: delta.content } }))
        visible = true
      }
      // 工具参数按槽缓存：Anthropic 同一时刻只允许一个块开着，必须按槽完整发完
      // 才能开下一个。OpenAI 方言允许交错增量，所以不实时开块，只攒参数。
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = Number.isInteger(tc?.index) ? tc.index : toolOrder.length
        if (!toolOrder.includes(idx)) toolOrder.push(idx)
        const slot = toolSlots.get(idx) ?? { id: '', name: '', args: '', emitted: 0 }
        if (typeof tc?.id === 'string' && tc.id) slot.id = tc.id
        if (typeof tc?.function?.name === 'string' && tc.function.name) slot.name = tc.function.name
        if (typeof tc?.function?.arguments === 'string') slot.args += tc.function.arguments
        toolSlots.set(idx, slot)
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason)
      return { events, visible }
    },

    finish() {
      const events = []
      if (!started) { started = true; events.push(messageStart()) }
      // 参数攒齐后按槽顺序整块下发：openToolBlock 会先关上一槽的块，flush 发完
      // 本槽全部增量，下一轮再关——每个 content block 的事件严格连续。
      for (const idx of toolOrder) {
        const slot = toolSlots.get(idx)
        if (!slot) continue
        if (!slot.id) slot.id = `toolu_${idx}`
        if (!slot.name) slot.name = 'tool'
        openToolBlock(events, slot)
        flushToolArgs(events, slot)
      }
      closeOpenBlock(events)
      const hasToolUse = toolOrder.length > 0
      events.push(event('message_delta', {
        delta: { stop_reason: stopReasonOf(finishReason, hasToolUse), stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }))
      events.push(event('message_stop', {}))
      return events
    },

    error(err) {
      return event('error', {
        error: {
          type: ERROR_TYPE_BY_STATUS[502],
          message: `upstream stream error: ${err?.message ?? String(err)}`,
        },
      })
    },

    /** 非流式聚合：Anthropic Message JSON。 */
    result() {
      const content = []
      for (const block of blockLog) {
        if (block.kind === 'text') {
          if (block.text) content.push({ type: 'text', text: block.text })
          continue
        }
        const slot = block.slot
        content.push({
          type: 'tool_use',
          id: slot.id || 'toolu_unknown',
          name: slot.name || 'tool',
          input: parseArgs(slot.args),
        })
      }
      return {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReasonOf(finishReason, toolOrder.length > 0),
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }
    },
  }
}

/**
 * 建协议面 handler。
 * @param {{ invokeChat: Function, note?: (s: string) => void }} deps
 */
export function createAnthropicMessagesProtocol({ invokeChat, note }) {
  return {
    handle: createProtocolSurface({
      invokeChat,
      parseRequest: parseAnthropicRequest,
      createTranslator: ({ model }) => createAnthropicTranslator({ model }),
      protocolError: anthropicErrorEnvelope,
      note,
    }),
  }
}
