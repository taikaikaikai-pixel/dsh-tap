/**
 * providers/protocols/openai-responses.js — OpenAI Responses API 协议面。
 *
 * 目标：本机客户端（OpenAI SDK 的 `responses.create`）把 baseURL 指到本通道的回环
 * 网关，`POST /v1/responses` 即可用同一上游能力。
 *
 * 两层翻译（同 anthropic-messages.js：上游流水线一律走 `invokeChat` → 本通道既有
 * handleChat，凭据/并发闸/配对/计量一处不重写）：
 *   入站 responsesToChat：instructions → system 消息；input 串/items
 *     （message{input_text,output_text,input_image}、function_call、
 *     function_call_output）→ OpenAI messages（function_call 合并进同一条
 *     assistant.tool_calls，function_call_output → role:"tool"）；扁平工具定义
 *     {type:'function',name,parameters} → OpenAI 嵌套 function；max_output_tokens →
 *     max_tokens；text.format → response_format；reasoning.effort → reasoning_effort。
 *   出站 translator：内部 OpenAI chunk → Responses SSE 事件序列
 *     response.created → response.in_progress → response.output_item.added →
 *     response.content_part.added → response.output_text.delta → … →
 *     response.output_text.done → response.content_part.done →
 *     response.output_item.done → response.completed（截断时 response.incomplete）；
 *     函数调用走 response.function_call_arguments.delta/.done。非流式由同一
 *     translator 的 result() 聚合出 Response 对象。
 *
 * 未实现（如实标注，不假装兼容）：
 *   - 有状态面：`store` / `previous_response_id` / `include` / `background` /
 *     `truncation` / `metadata` / `prompt`(模板) 全部不支持——本面是无状态翻译，
 *     每次请求自带完整 input；带 previous_response_id 的请求明确 400 报错（不静默丢历史）；
 *   - 推理摘要：内部 `reasoning_content` 增量丢弃，不出
 *     response.reasoning_summary_text.delta（该事件要求服务端摘要对象）；
 *   - 非 function 工具（web_search / file_search / computer_use / code_interpreter /
 *     mcp）不透传；`tool_choice` 的 allowed_tools 形态不支持；
 *   - `input` 里的 reasoning / item_reference 项忽略；`input_image` 之外的
 *     多模态项（input_file / input_audio）忽略；
 *   - 事件面不完整：response.in_progress 之外的中间态事件
 *     （response.queued / response.output_text.annotation.added /
 *     response.refusal.delta 等）不发；response 对象只填核心字段，
 *     省略 max_output_tokens/instructions/tools 等回显字段（置 null/空）。
 */

import { randomUUID } from 'node:crypto'

import { createProtocolSurface, normalizeCode } from './surface.js'

/** Responses 错误 type ↔ HTTP 状态（OpenAI 风格信封 `{"error":{message,type,param,code}}`）。 */
const ERROR_TYPE_BY_STATUS = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'server_error',
  503: 'server_error',
  504: 'server_error',
}

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** Responses 错误信封（message 必带原因，踩坑 #7）。 */
export function responsesErrorEnvelope({ status = 500, message, code } = {}) {
  const type = ERROR_TYPE_BY_STATUS[status] ?? 'server_error'
  return {
    status,
    body: {
      error: {
        message: String(message ?? 'unknown error'),
        type,
        param: null,
        code: code ?? (status === 413 ? 'request_too_large' : null),
      },
    },
  }
}

/** Responses content（串或 parts 数组）→ OpenAI content（文本串 / 多模态 parts）。 */
function responsesContentToChat(content, unsupported) {
  if (typeof content === 'string') return { text: content, parts: null }
  if (!Array.isArray(content)) return { text: '', parts: null }
  const texts = []
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = part.type
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      if (typeof part.text === 'string' && part.text) { texts.push(part.text); parts.push({ type: 'text', text: part.text }) }
    } else if (type === 'input_image' || type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } })
      else unsupported.push('input_image without resolvable url')
    } else if (type === 'refusal') {
      unsupported.push('content part "refusal"')
    } else if (type) {
      unsupported.push(`content part "${type}"`)
    }
  }
  const hasImage = parts.some((x) => x.type === 'image_url')
  return { text: texts.join('\n'), parts: hasImage ? parts : null }
}

/**
 * Responses 请求 → 内部 OpenAI chat payload。
 * @returns {{chat: object, unsupported: string[]}}
 */
export function responsesToChat(payload) {
  const unsupported = []
  const p = payload && typeof payload === 'object' ? payload : {}
  const messages = []

  if (typeof p.instructions === 'string' && p.instructions) messages.push({ role: 'system', content: p.instructions })

  const input = p.input
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    // 相邻 function_call 项合并进同一条 assistant（OpenAI 侧 tool_calls 语义）。
    let pendingAssistant = null
    const flushAssistant = () => { if (pendingAssistant) { messages.push(pendingAssistant); pendingAssistant = null } }
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      const type = item.type ?? 'message'
      if (type === 'message') {
        flushAssistant()
        const role = item.role === 'assistant' ? 'assistant' : (item.role === 'system' || item.role === 'developer') ? 'system' : 'user'
        const { text, parts } = responsesContentToChat(item.content, unsupported)
        if (parts) messages.push({ role, content: parts })
        else if (text) messages.push({ role, content: text })
      } else if (type === 'function_call') {
        const call = {
          id: typeof item.call_id === 'string' && item.call_id ? item.call_id : (typeof item.id === 'string' && item.id ? item.id : `call_${messages.length}_${unsupported.length}`),
          type: 'function',
          function: {
            name: String(item.name ?? 'tool'),
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }
        if (pendingAssistant) pendingAssistant.tool_calls.push(call)
        else pendingAssistant = { role: 'assistant', content: '', tool_calls: [call] }
      } else if (type === 'function_call_output') {
        flushAssistant()
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: output })
      } else if (type === 'reasoning') {
        // 上一轮推理项：上游无对应载体，丢弃（不影响配对）。
      } else if (type === 'item_reference') {
        unsupported.push('input item "item_reference"')
      } else {
        unsupported.push(`input item "${type}"`)
      }
    }
    flushAssistant()
  }

  const tools = []
  for (const t of Array.isArray(p.tools) ? p.tools : []) {
    if (!t || typeof t !== 'object') continue
    if (t.type !== 'function') { unsupported.push(`tool "${t.type}"`); continue }
    const fn = t.function && typeof t.function === 'object' ? t.function : t
    if (typeof fn.name !== 'string' || !fn.name) continue
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      },
    })
  }

  let toolChoice
  const tc = p.tool_choice
  if (typeof tc === 'string') toolChoice = tc
  else if (tc && typeof tc === 'object' && tc.type === 'function' && typeof tc.name === 'string' && tc.name) {
    toolChoice = { type: 'function', function: { name: tc.name } }
  } else if (tc && typeof tc === 'object') {
    unsupported.push(`tool_choice "${tc.type}"`)
  }

  const chat = { model: p.model, messages, stream: true }
  if (Number.isFinite(p.max_output_tokens)) chat.max_tokens = p.max_output_tokens
  if (Number.isFinite(p.temperature)) chat.temperature = p.temperature
  if (Number.isFinite(p.top_p)) chat.top_p = p.top_p
  if (typeof p.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = p.parallel_tool_calls
  if (tools.length) chat.tools = tools
  if (toolChoice !== undefined) chat.tool_choice = toolChoice
  const effort = p.reasoning?.effort
  if (typeof effort === 'string' && effort) chat.reasoning_effort = effort
  else if (p.reasoning?.effort !== undefined) unsupported.push('reasoning.effort (non-string)')
  const format = p.text?.format
  if (format && typeof format === 'object') {
    if (format.type === 'json_schema') {
      chat.response_format = {
        type: 'json_schema',
        json_schema: {
          name: typeof format.name === 'string' && format.name ? format.name : 'response',
          schema: format.schema && typeof format.schema === 'object' ? format.schema : {},
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      }
    } else if (format.type === 'json_object') {
      chat.response_format = { type: 'json_object' }
    } else if (format.type && format.type !== 'text') {
      unsupported.push(`text.format "${format.type}"`)
    }
  }
  for (const f of ['store', 'previous_response_id', 'include', 'background', 'truncation', 'metadata', 'prompt', 'max_tool_calls', 'context_management', 'service_tier']) {
    if (p[f] !== undefined && p[f] !== null) unsupported.push(f)
  }
  return { chat, unsupported }
}

/** 入站校验：缺 model/input 即 400，原因写明（有状态面明确拒绝而非静默丢历史）。 */
export function parseResponsesRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: { status: 400, message: 'body must be a JSON object (Responses request)', code: 'invalid_body' } }
  }
  if (typeof payload.model !== 'string' || !payload.model) {
    return { error: { status: 400, message: 'model: required non-empty string', code: 'invalid_model' } }
  }
  const hasInput = typeof payload.input === 'string' ? payload.input.length > 0 : Array.isArray(payload.input) && payload.input.length > 0
  if (!hasInput) {
    if (payload.previous_response_id) {
      return { error: { status: 400, message: 'previous_response_id: this loopback surface is stateless — resend the full input (stateful Responses chaining is not implemented)', code: 'unsupported_previous_response_id' } }
    }
    return { error: { status: 400, message: 'input: required non-empty string or item array', code: 'invalid_input' } }
  }
  const { chat, unsupported } = responsesToChat(payload)
  return { chat, stream: payload.stream === true, unsupported }
}

const rid = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`

/**
 * 有状态翻译器：内部 OpenAI chunk → Responses SSE 事件。
 * `visible` 只在 output_text.delta / function_call_arguments.delta 时为真（踩坑 #60）。
 */
export function createResponsesTranslator({ model }) {
  const responseId = rid('resp')
  const createdAt = Math.floor(Date.now() / 1000)
  let created = false
  let sequence = 0
  let outputIndex = 0
  let textItem = null
  const outputLog = [] // {kind:'message', item} | {kind:'function_call', slot}
  const toolOrder = []
  const toolSlots = new Map()
  let finishReason = null
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

  const event = (type, payload) => ({ type, ...payload, sequence_number: sequence++ })

  const status = () => (finishReason === 'length' ? 'incomplete' : 'completed')

  const outputItems = () => outputLog.map((entry) => (entry.kind === 'message'
    ? {
      id: entry.item.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: entry.item.text ? [{ type: 'output_text', text: entry.item.text, annotations: [] }] : [],
    }
    : {
      id: entry.slot.itemId,
      type: 'function_call',
      status: 'completed',
      call_id: entry.slot.callId,
      name: entry.slot.name,
      arguments: entry.slot.args,
    }))

  const responseObject = () => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: status(),
    model,
    output: outputItems(),
    output_text: textItem?.text ?? '',
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    },
    error: null,
    incomplete_details: status() === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: null,
    tools: [],
    top_p: null,
    max_output_tokens: null,
    previous_response_id: null,
    store: false,
    truncation: 'disabled',
    user: null,
  })

  const ensureCreated = (events) => {
    if (created) return
    created = true
    events.push(event('response.created', { response: { ...responseObject(), status: 'in_progress', output: [], output_text: '' } }))
    events.push(event('response.in_progress', { response: { ...responseObject(), status: 'in_progress', output: [], output_text: '' } }))
  }

  const openToolItem = (events, slot) => {
    slot.added = true
    slot.itemId = rid('fc')
    slot.outputIndex = outputIndex++
    outputLog.push({ kind: 'function_call', slot })
    events.push(event('response.output_item.added', {
      output_index: slot.outputIndex,
      item: { id: slot.itemId, type: 'function_call', status: 'in_progress', call_id: slot.callId, name: slot.name, arguments: '' },
    }))
  }

  const flushToolArgs = (events, slot) => {
    if (!slot.added || slot.emitted >= slot.args.length) return
    const delta = slot.args.slice(slot.emitted)
    slot.emitted = slot.args.length
    events.push(event('response.function_call_arguments.delta', { item_id: slot.itemId, output_index: slot.outputIndex, delta }))
  }

  return {
    id: responseId,
    push(chunk) {
      const events = []
      let visible = false
      ensureCreated(events)
      if (!chunk || typeof chunk !== 'object') return { events, visible }
      const u = chunk.usage
      if (u && typeof u === 'object') {
        usage.input_tokens = num(u.prompt_tokens ?? u.input_tokens, usage.input_tokens)
        usage.output_tokens = num(u.completion_tokens ?? u.output_tokens, usage.output_tokens)
        usage.total_tokens = num(u.total_tokens, usage.input_tokens + usage.output_tokens)
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        if (!textItem) {
          textItem = { id: rid('msg'), text: '', outputIndex: outputIndex++ }
          outputLog.push({ kind: 'message', item: textItem })
          events.push(event('response.output_item.added', {
            output_index: textItem.outputIndex,
            item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          }))
          events.push(event('response.content_part.added', {
            item_id: textItem.id, output_index: textItem.outputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }))
        }
        textItem.text += delta.content
        events.push(event('response.output_text.delta', {
          item_id: textItem.id,
          output_index: textItem.outputIndex,
          content_index: 0,
          delta: delta.content,
        }))
        visible = true
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = Number.isInteger(tc?.index) ? tc.index : toolOrder.length
        if (!toolOrder.includes(idx)) toolOrder.push(idx)
        const slot = toolSlots.get(idx) ?? { itemId: null, outputIndex: null, callId: '', name: '', args: '', emitted: 0, added: false }
        if (typeof tc?.id === 'string' && tc.id) slot.callId = tc.id
        if (typeof tc?.function?.name === 'string' && tc.function.name) slot.name = tc.function.name
        if (typeof tc?.function?.arguments === 'string') slot.args += tc.function.arguments
        if (!slot.added && slot.name) {
          if (!slot.callId) slot.callId = `call_${idx}`
          openToolItem(events, slot)
          flushToolArgs(events, slot)
          visible = true
        } else if (slot.added) {
          flushToolArgs(events, slot)
          visible = true
        }
        toolSlots.set(idx, slot)
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason)
      return { events, visible }
    },

    finish() {
      const events = []
      ensureCreated(events)
      if (textItem) {
        events.push(event('response.output_text.done', {
          item_id: textItem.id, output_index: textItem.outputIndex ?? 0, content_index: 0, text: textItem.text,
        }))
        events.push(event('response.content_part.done', {
          item_id: textItem.id, output_index: textItem.outputIndex ?? 0, content_index: 0,
          part: { type: 'output_text', text: textItem.text, annotations: [] },
        }))
        events.push(event('response.output_item.done', {
          output_index: textItem.outputIndex ?? 0,
          item: { id: textItem.id, type: 'message', status: 'completed', role: 'assistant', content: textItem.text ? [{ type: 'output_text', text: textItem.text, annotations: [] }] : [] },
        }))
      }
      for (const idx of toolOrder) {
        const slot = toolSlots.get(idx)
        if (!slot) continue
        if (!slot.added) {
          if (!slot.name) slot.name = 'tool'
          if (!slot.callId) slot.callId = `call_${idx}`
          openToolItem(events, slot)
        }
        flushToolArgs(events, slot)
        events.push(event('response.function_call_arguments.done', { item_id: slot.itemId, output_index: slot.outputIndex, arguments: slot.args }))
        events.push(event('response.output_item.done', {
          output_index: slot.outputIndex,
          item: { id: slot.itemId, type: 'function_call', status: 'completed', call_id: slot.callId, name: slot.name, arguments: slot.args },
        }))
      }
      // 终止事件必须与 status 一致：截断（max_output_tokens）的协议终态是
      // `response.incomplete`，不是 `response.completed`。
      const terminal = status() === 'incomplete' ? 'response.incomplete' : 'response.completed'
      events.push(event(terminal, { response: responseObject() }))
      return events
    },

    error(err) {
      return event('error', {
        // 码方言归一（surface.js 同一实现）：CodeBuddy 数字码 → 字符串。
        code: normalizeCode(err?.code) ?? 'server_error',
        message: `upstream stream error: ${err?.message ?? String(err)}`,
        param: null,
      })
    },

    result: responseObject,
  }
}

/**
 * 建协议面 handler。
 * @param {{ invokeChat: Function, note?: (s: string) => void }} deps
 */
export function createOpenAIResponsesProtocol({ invokeChat, note }) {
  return {
    handle: createProtocolSurface({
      invokeChat,
      parseRequest: parseResponsesRequest,
      createTranslator: ({ model }) => createResponsesTranslator({ model }),
      protocolError: responsesErrorEnvelope,
      note,
    }),
  }
}
