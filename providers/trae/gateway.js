/**
 * providers/trae/gateway.js — OpenAI ↔ Trae 翻译网关（Trae 聊天桥）。
 *
 * 与 core/bridge.js 的分工：core 桥是"透传代理"（上游说 OpenAI 方言）；本网关是
 * "协议翻译器"——Trae 云端说私有方言，请求/响应都要改写。复用 core 原语：
 * SessionLimiter（会话并发闸）与 usage-meter（计量）。
 *
 * 出站协议（2026-08-24 带凭据实测校准；
 * 生产级参照 github.com/autumnsentiment/Trae2api-cn 的 raw client）：
 *   POST {chatBaseURL}/api/agent/v3/llm_utils_chat
 *   头（IDE 指纹全套——缺设备头曾被间歇拒绝）：
 *     Authorization / X-Cloudide-Token / x-ide-token 三头同值（JWT）
 *     x-app-id（product.json appId `6eefa01c-…`，**不是 OAuth client_id**——
 *       用错报 TCC "record not found"）；缺省报 4001 "expr_path=app_id"
 *     x-ide-version 3.3.67 / x-ide-version-code 20260401（数字串，'0.1.52' 会判
 *       missing）/ x-ide-version-type stable
 *     x-device-id / x-machine-id / x-device-brand（设备指纹，与登录上报一致）
 *     x-request-id（每请求 uuid）/ x-uid（账号 uid）/ User-Agent 置空
 *   体：{messages[native], model, function:"inline_chat", request_id, session_id,
 *       stream:true, max_tokens?, tools?[OpenAI 原生], tool_choice?, 生成参数透传}
 *     native message：content 为 [{type:"text",text}] 块数组（字符串直发 400/4001
 *     "cannot unmarshal string …LLMRawMessageContent"）；assistant.tool_calls 与
 *     tool 角色原生透传。function 必填（缺则 2001 "function is empty, cannot
 *     resolve model by usage="）
 *   SSE（事件名在 event: 行或 data.event 字段）：
 *     error → 抛错（1001 未认证 / 4011 限流 / 2001 模型解析失败）
 *     request_wait_in_queue / data.position → 排队提示（位置变化才发）
 *     token_usage → usage（data.usage 或 data 顶层计数）
 *     文本：data.response / data.reasoning_content 为**累计快照**——前缀差分出
 *       增量（不是逐段 delta！直接当增量会大面积重复）；finish_reason 可出现在
 *       中间快照，只有 event:done 或 data.stop_reason 才真正结束
 *     工具调用：data.tool_calls 数组或 data.tool_call_info{name,params,id}
 *
 * 生命周期纪律（踩坑 #17）：listen 失败绝不抛出——降级为 runtime.lastError。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

import { SessionLimiter, extractSessionId } from '../../core/bridge.js'
import { normalizeTraeError, formatTraeErrorMessage, TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE } from './errors.js'
import {
  createRemoteSession, openRemoteEvents, stopRemoteSession, createRemoteEventParser,
  cumulativeDelta,
} from './remote.js'

// re-export：实现唯一归 remote.js；本模块导出面不变（verify 脚本从此导入）。
export { cumulativeDelta }

/** Trae 云端客户端指纹（product.json appId + Trae2api-cn 生产实测值，2026-08-24 校准）。 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
export const TRAE_IDE_VERSION = '3.3.67'
export const TRAE_IDE_VERSION_CODE = '20260401'
const CHAT_PATH = '/api/agent/v3/llm_utils_chat'
const DEFAULT_FUNCTION = 'inline_chat'

/**
 * 出站 IDE 头组（凭证三头由调用处合入）。设备指纹取自 oauth.js 生成的设备
 * 身份（device_id/machine_id 与登录时上报的一致）。
 */
export function traeOutboundHeaders(device, uid, requestId) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Connection: 'keep-alive',
    'x-app-id': TRAE_APP_ID,
    'x-ide-version': TRAE_IDE_VERSION,
    'x-ide-version-code': TRAE_IDE_VERSION_CODE,
    'x-ide-version-type': 'stable',
    'x-device-cpu': 'AMD',
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'x-system-type': 'Windows',
    'x-request-id': requestId,
    'request-traffic-type': 'prod', // 官方头组（2026-08-24 网络日志）；实测对响应无影响，对齐官方链路
    'package-type': 'stable_cn',
    'x-lgw-req-sdk-type': '3',
    // 注意：不发 x-request-pin / x-requested-at——服务端见 pin 头即强制 base64 校验，
    // 外部复刻者无官方密钥无法生成合法 pin，发了必 400 "base64 decode failed"（round 9 实测）。
    'User-Agent': '',
  }
  if (device?.deviceId) h['x-device-id'] = device.deviceId
  if (device?.machineId) h['x-machine-id'] = device.machineId
  if (device?.deviceBrand) h['x-device-brand'] = device.deviceBrand
  if (uid) h['x-uid'] = String(uid)
  return h
}

/** OpenAI content（字符串或分段数组）→ Trae 原生 text 块数组（非文本段折叠丢弃）。 */
function toTextBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const texts = content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => ({ type: 'text', text: p.text }))
    if (texts.length) return texts
  }
  return [{ type: 'text', text: '' }]
}

/** OpenAI 工具调用 → Trae 原生（形态同构，arguments 归一为字符串）。 */
function nativeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return undefined
  const out = []
  for (const c of toolCalls) {
    if (!c || typeof c !== 'object') continue
    const fn = c.function && typeof c.function === 'object' ? c.function : null
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id : `trae-call-${out.length}`,
      type: 'function',
      function: {
        name: String(fn?.name ?? ''),
        arguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
      },
    })
  }
  return out.length ? out : undefined
}

/** OpenAI messages → Trae native messages（content 块化；tool_calls/tool 角色原生）。 */
function toNativeMessages(messages) {
  const out = []
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role ?? 'user')
    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(m.tool_call_id ?? m.toolCallId ?? ''),
        ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
        content: toTextBlocks(m.content),
      })
      continue
    }
    const native = { role, content: toTextBlocks(m.content) }
    const calls = nativeToolCalls(m.tool_calls)
    if (role === 'assistant' && calls) native.tool_calls = calls
    out.push(native)
  }
  return out
}

/** 透传白名单：上游声明接受的生成参数（Trae2api-cn RAW_GENERATION_FIELDS 同源）。 */
const GENERATION_FIELDS = [
  'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'seed',
  'reasoning_effort', 'stream_options', 'response_format', 'service_tier', 'user',
  'logprobs', 'top_logprobs', 'parallel_tool_calls',
]

/** OpenAI 工具定义透传。parameters 必须序列化为字符串——服务端 Go 结构体
 *  `FunctionDefinition.tools.function.parameters` 是 string 型（内嵌 JSON，
 *  与 scene_params 同套路；对象直发 → 4001 "cannot unmarshal object …
 *  parameters of type string"，2026-08-24 dsh 主聊天实测）。 */
function nativeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const out = tools
    .filter((t) => t && typeof t === 'object' && t.function && typeof t.function === 'object')
    .map((t) => {
      const fn = { ...t.function }
      if (fn.parameters != null && typeof fn.parameters !== 'string') fn.parameters = JSON.stringify(fn.parameters)
      return { type: 'function', function: fn }
    })
  return out.length ? out : undefined
}

/**
 * OpenAI chat payload → Trae llm_utils_chat 请求体（2026-08-24 实测校准形态）。
 * 返回 {body, requestId}（requestId 同时用于 x-request-id 头）。
 */
export function buildChatRequest(payload, sessionId) {
  const requestId = randomUUID()
  const body = {
    messages: toNativeMessages(payload.messages),
    model: typeof payload.model === 'string' ? payload.model : 'glm-5.3',
    function: DEFAULT_FUNCTION,
    request_id: requestId,
    session_id: sessionId,
    stream: true,
  }
  const maxTokens = payload.max_tokens ?? payload.max_completion_tokens
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens)
  const tools = nativeTools(payload.tools)
  if (tools) body.tools = tools
  if (payload.tool_choice !== undefined && payload.tool_choice !== null) {
    const named = payload.tool_choice?.type === 'function' ? payload.tool_choice.function?.name : null
    body.tool_choice = named ? 'required' : String(payload.tool_choice)
  }
  for (const f of GENERATION_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null) body[f] = payload[f]
  }
  return { body, requestId }
}

/** usage 字段名宽容映射（snake/camel 都收）。 */
function mapUsage(u) {
  if (!u || typeof u !== 'object') return null
  const num = (...keys) => {
    for (const k of keys) {
      if (typeof u[k] === 'number' && Number.isFinite(u[k])) return u[k]
    }
    return null
  }
  const mapped = {
    prompt_tokens: num('prompt_tokens', 'promptTokens', 'input_tokens'),
    completion_tokens: num('completion_tokens', 'completionTokens', 'output_tokens'),
    total_tokens: num('total_tokens', 'totalTokens'),
  }
  return mapped.total_tokens != null || mapped.prompt_tokens != null || mapped.completion_tokens != null ? mapped : null
}

/**
 * 有状态流解析器：吃 (eventName, dataObj)，产出翻译事件
 * {text?, reasoning?, toolCall?, usage?, queue?, finish?, error?}。
 * 文本累计差分、工具调用按 id 去重累积、done/stop_reason 终结语义均在此。
 */
export function createTraeStreamParser() {
  const state = {
    response: '', reasoning: '', usage: null, finish: null, done: false,
    lastQueuePos: null, toolOrder: [], toolSlots: new Map(),
    providerModel: null,
  }
  return {
    isDone: () => state.done,
    usage: () => state.usage,
    finish: () => state.finish,
    /** 服务端实际使用的模型（timing_cost.provider_model_name；模型改派时以此为准）。 */
    providerModel: () => state.providerModel,
    /** 按 index 序组装完整工具调用（非流式聚合用）。 */
    toolCalls: () => state.toolOrder.map((i) => {
      const s = state.toolSlots.get(i)
      return { id: s.id || `trae-call-${i}`, type: 'function', function: { name: s.name, arguments: s.arguments } }
    }),
    handle(eventName, obj) {
      if (!obj || typeof obj !== 'object') return {}
      const event = typeof obj.event === 'string' && obj.event ? obj.event : eventName
      if (event === 'error') {
        state.done = true
        return { error: normalizeTraeError(200, obj) }
      }
      if (event === 'timing_cost') {
        // timing_cost 携带 provider_model_name = 实际派发的模型（2026-08-24
        // 实测：请求模型可能被 function/套餐默认改派，此字段是唯一真值源）。
        if (typeof obj.provider_model_name === 'string' && obj.provider_model_name) {
          state.providerModel = obj.provider_model_name
        }
        return {}
      }
      if (event === 'metadata') return {}
      if (event === 'request_wait_in_queue' || obj.position != null) {
        const pos = obj.position ?? 0
        if (pos !== state.lastQueuePos) {
          state.lastQueuePos = pos
          return { queue: pos }
        }
        return {}
      }
      if (event === 'token_usage') {
        state.usage = mapUsage(obj.usage ?? obj)
        return {}
      }
      const out = {}
      const reasoningSnap = typeof obj.reasoning_content === 'string' ? obj.reasoning_content : ''
      const responseSnap = typeof obj.response === 'string' ? obj.response : ''
      const rd = cumulativeDelta(state.reasoning, reasoningSnap)
      const td = cumulativeDelta(state.response, responseSnap)
      if (reasoningSnap) state.reasoning = reasoningSnap
      if (responseSnap) state.response = responseSnap
      if (rd) out.reasoning = rd
      if (td) out.text = td
      // 工具调用（2026-08-24 真实线缆形态校准）：tool_calls[i] 的键是
      // **function_call**（非 OpenAI 的 function）；arguments 是**增量片段**，
      // 续片 id/name 为空、按 index 归属。
      // 单条 tool_call_info 为一次性全量形态。两形态都进 slot 按 index 累积。
      const rawCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls.slice() : []
      const info = obj.tool_call_info
      if (info && typeof info === 'object') {
        rawCalls.push({
          id: info.tool_call_id ?? info.id,
          function_call: { name: info.name, arguments: typeof info.params === 'string' ? info.params : JSON.stringify(info.params ?? {}) },
        })
      }
      for (const c of rawCalls) {
        if (!c || typeof c !== 'object') continue
        const fn = (c.function_call && typeof c.function_call === 'object') ? c.function_call
          : (c.function && typeof c.function === 'object' ? c.function : {})
        const idx = Number.isInteger(c.index) ? c.index : state.toolOrder.length
        if (!state.toolOrder.includes(idx)) state.toolOrder.push(idx)
        const slot = state.toolSlots.get(idx) ?? { id: '', name: '', arguments: '' }
        if (typeof c.id === 'string' && c.id) slot.id = c.id
        if (typeof fn.name === 'string' && fn.name) slot.name = fn.name
        let argsDelta = ''
        const frag = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments != null ? JSON.stringify(fn.arguments) : '')
        if (frag) {
          // 增量片段/累计快照两形态兼容：以前缀扩展视为快照替换，否则按片段拼接
          if (slot.arguments && frag.startsWith(slot.arguments)) {
            argsDelta = frag.slice(slot.arguments.length)
            slot.arguments = frag
          } else {
            slot.arguments += frag
            argsDelta = frag
          }
        }
        state.toolSlots.set(idx, slot)
        out.toolCall = {
          index: idx,
          // id/name 只在本事件实际携带时下发（OpenAI 流式约定：续片不重复）
          id: typeof c.id === 'string' && c.id ? slot.id : undefined,
          name: typeof fn.name === 'string' && fn.name ? slot.name : undefined,
          argsDelta,
        }
      }
      if (obj.usage) {
        const u = mapUsage(obj.usage)
        if (u) state.usage = u
      }
      if (obj.finish_reason) state.finish = String(obj.finish_reason)
      if (event === 'done' || obj.stop_reason) {
        state.done = true
        state.finish = String(obj.finish_reason ?? obj.stop_reason ?? state.finish ?? 'stop')
        // 上游带工具调用时 done 仍发 "stop"（2026-08-24 实测）；OpenAI 语义需要
        // tool_calls，否则客户端不会触发工具调用循环。
        if (state.finish === 'stop' && state.toolOrder.length) state.finish = 'tool_calls'
        out.finish = state.finish
      }
      return out
    },
  }
}

/** OpenAI chunk 形态工厂。 */
function oaiChunk(id, model, delta, finishReason = null, usage = null) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  }
  if (usage) chunk.usage = usage
  return chunk
}

/**
 * SSE 逐行扫描骨架（remote/inline 两条事件流共用）：跨 chunk 组行，空行重置
 * 事件名，`event:` 记名，`data:` JSON 解析后交 parser.handle 派发；`[DONE]`
 * 与非 JSON data 行吞掉。cb(ev) 返回真值时中止扫描并透传该值（调用方据此
 * 跳出，如 inline 的 'fallback'/'done'）。仅供本文件内部使用，不进 core/。
 */
async function forEachSseEvent(body, parser, cb) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastEventName = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) { lastEventName = null; continue }
      if (line.startsWith('event:')) { lastEventName = line.slice(6).trim(); continue }
      if (line.startsWith('id:') || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') { parser.handle('done', {}); continue }
      let chunk = null
      try { chunk = JSON.parse(data) } catch { continue }
      const ret = await cb(parser.handle(lastEventName, chunk))
      if (ret) return ret
    }
  }
  return undefined
}

/**
 * Host 门（审计 [9]）：网关无认证，唯一防线是回环端口——但回环端口本机任意
 * 进程/页面（含 DNS rebinding 把公网域名解析到 127.0.0.1 的浏览器请求）都能
 * 连上。Host 白名单把表面收紧到回环主机名：Host 头可带端口，用 URL 解析出
 * hostname 再比对（IPv6 经 URL 解析后 hostname 保留方括号，即 [::1]）；
 * 解析失败一律拒绝。
 */
function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false
  let hostname
  try {
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** SSE 单行值清洗（审计 [20]）：客户端/上游提供的字符串可能含 \r\n，直插
 *  注释行会在响应流里伪造 SSE 帧——换行统一折叠为空格。 */
function sseLineValue(value) {
  return String(value).replace(/[\r\n]+/g, ' ')
}

/**
 * @param {{
 *   settings: () => object,            // 需要 traeChatBaseURL / maxConcurrentPerSession
 *   withCredentials: (attempt: (cred) => Promise<Response>) => Promise<{cred,res,err}>,
 *   readAuthDevice: () => object|null, // 设备身份（出站设备指纹头）
 *   readAuthMeta: () => { uid?: * },   // 账号 uid（x-uid 头）
 *   meter: { record: Function },
 *   runtime: { running, port, lastError },
 *   forensics?: { logPath: () => string|undefined },
 *   getCatalogIds: () => string[],
 * }} deps
 */
export function createTraeGateway(deps) {
  const limiter = new SessionLimiter()
  const logPrefix = '[dsh-tap/trae]'

  function gwLog(record) {
    const path = deps.forensics?.logPath?.()
    if (!path) return
    try {
      appendFileSync(path, JSON.stringify({ gw: 'trae', ...record }) + '\n')
    } catch { /* best-effort */ }
  }

  /**
   * remote 传输（chat_sessions 协议）：唯一真实的模型选择机制（2026-08-24
   * 探测定论，见 remote.js 文件头）。每请求起一个云端沙箱 agent、耗 work
   * 额度池、不支持 OpenAI tools（远端 agent 自持工具，dsh 工具环会断——
   * 带 tools 的请求明确拒绝，不静默降级）。
   */
  async function handleRemoteChat(res, payload, model, wantStream, sessionId, t0) {
    if ((Array.isArray(payload.tools) && payload.tools.length) || payload.tool_choice != null) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'trae remote 通道不支持 tools（模型选择仅对纯文本会话生效；需要 dsh 工具环请用 inline 通道）', code: 'remote-no-tools' } }))
      return
    }
    const s = deps.settings()
    const parser = createRemoteEventParser()
    const id = `trae-remote-${randomUUID().slice(0, 8)}`
    let sessionCreated = null
    let tokenForStop = null
    const release = await limiter.acquire(sessionId, s.maxConcurrentPerSession ?? 4)
    try {
      const { cred, res: eventsResp, err } = await deps.withCredentials(async (c) => {
        const token = String(c.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
        tokenForStop = token
        sessionCreated = await createRemoteSession(s.traeChatBaseURL, token, model, payload.messages)
        return openRemoteEvents(s.traeChatBaseURL, token, sessionCreated.sessionId, sessionCreated.messageId)
      })
      if (!cred || err) {
        const isCred = err?.credentialUnavailable === true
        res.writeHead(isCred ? 503 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: isCred ? TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE : `trae remote: ${err?.message ?? 'unknown'}`, code: err?.code } }))
        return
      }

      if (wantStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify(oaiChunk(id, model, { role: 'assistant' }))}\n\n`)
      }
      const send = (chunk) => {
        if (wantStream) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }

      const interrupted = await forEachSseEvent(eventsResp.body, parser, (ev) => {
        if (ev.error) {
          const parsed = normalizeTraeError(200, ev.error)
          const msg = formatTraeErrorMessage(parsed.code, parsed.message)
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: msg, code: parsed.code } }))
          } else {
            send({ error: { message: msg, code: parsed.code } })
            res.write('data: [DONE]\n\n')
            res.end()
          }
          gwLog({ dir: 'err', transport: 'remote', model, ms: Date.now() - t0, code: parsed.code })
          return 'err'
        }
        if (ev.queue) send(oaiChunk(id, model, { content: '（Trae remote 排队/沙箱准备中…）\n' }))
        if (ev.reasoning) send(oaiChunk(id, model, { reasoning_content: ev.reasoning }))
        if (ev.text) send(oaiChunk(id, model, { content: ev.text }))
      })
      if (interrupted) return
      const usage = parser.usage()
      const actualModel = parser.actualModel() ?? model
      if (wantStream) {
        send(oaiChunk(id, model, {}, 'stop', usage))
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const message = { role: 'assistant', content: parser.finalText() }
        if (parser.actualModel() && parser.actualModel() !== model) {
          message.note = `served by ${parser.actualModel()} (requested ${model})`
        }
        res.end(JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: usage ?? {},
        }))
      }
      if (usage) deps.meter.record({ ts: t0, kind: 'chat', model: actualModel || null, usage })
      gwLog({ dir: 'out', transport: 'remote', model, actualModel, ms: Date.now() - t0, usage })
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      try { res.end(JSON.stringify({ error: { message: `trae remote gateway error: ${err?.message ?? err}` } })) } catch { res.end() }
    } finally {
      release()
      if (sessionCreated && tokenForStop) {
        stopRemoteSession(s.traeChatBaseURL, tokenForStop, sessionCreated.sessionId, sessionCreated.messageId)
      }
    }
  }

  async function handleChat(req, res, rawBody) {
    const s = deps.settings()
    let payload = null
    try { payload = JSON.parse(rawBody) } catch { payload = null }
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid chat payload' } }))
      return
    }
    const model = typeof payload.model === 'string' ? payload.model : ''
    const wantStream = payload.stream === true
    const sessionId = extractSessionId(req.headers, payload) ?? randomUUID()
    const t0 = Date.now()

    // 传输选择：remote（chat_sessions，真模型路由、耗 work 池、无 tools）|
    // inline（默认，llm_utils_chat+inline_chat，模型恒为账户默认、原生 tools）。
    if (s.traeChatTransport === 'remote') {
      await handleRemoteChat(res, payload, model, wantStream, sessionId, t0)
      return
    }

    const release = await limiter.acquire(sessionId, s.maxConcurrentPerSession ?? 4)
    // inline 面事故回退（2026-08-24 实测：服务端故障期 inline_chat 对一切模型名
    // 返回 3003，而同信封 chat_v3 正常出文本）——首次尝试用 inline_chat；遇 3003
    // 且请求无 tools 时自动降级 chat_v3 重试一次。改派由既有机制诚实披露
    // （SSE 注释行 / message.note / 计量记真实模型），绝不假装请求模型被服务。
    const hasTools = (Array.isArray(payload.tools) && payload.tools.length > 0) || payload.tool_choice != null
    let fallbackUsed = false

    async function attemptInline(fnValue) {
      const { body, requestId } = buildChatRequest(payload, sessionId)
      body.function = fnValue
      // 首字节护栏（2026-08-24 故障取证：本地代理/边缘对 POST 偶发"收下请求不
      // 回应"，无超时会令用户请求无限挂死）。fetch 在响应头到达即 resolve，
      // 计时器随即清除——SSE 长流不受影响；仅约束"连上却不出头"的死态。
      const firstByteMs = Number(s.upstreamFirstByteTimeoutMs) > 0 ? Number(s.upstreamFirstByteTimeoutMs) : 45_000
      const { cred, res: upstream0, err } = await deps.withCredentials((c) => {
        const token = String(c.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
        const headers = {
          ...traeOutboundHeaders(deps.readAuthDevice?.(), deps.readAuthMeta?.()?.uid, requestId),
          Authorization: `Cloud-IDE-JWT ${token}`,
          'X-Cloudide-Token': token,
          'x-ide-token': token,
        }
        const inbound = new AbortController()
        const firstByteTimer = setTimeout(
          () => inbound.abort(new Error(`trae 上游 ${firstByteMs}ms 内无响应（首字节超时）——边缘/WAF 拦截或本地代理异常；可稍后重试，需要真实模型选择可切 remote 传输`)),
          firstByteMs,
        )
        return fetch(`${s.traeChatBaseURL}${CHAT_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'follow', // 官方 TTNet 对 llm_utils_chat 307→api5-normal（2026-08-24 日志取证）；跟随重定向对齐官方链路
          signal: inbound.signal,
        }).finally(() => clearTimeout(firstByteTimer))
      })
      if (!cred || err) {
        const isCred = err?.credentialUnavailable === true
        res.writeHead(isCred ? 503 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: isCred ? TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE : `trae upstream unreachable: ${err?.message ?? err?.name ?? 'unknown'}` } }))
        return 'done'
      }
      const upstream = upstream0
      if (!upstream.ok) {
        const parsed = normalizeTraeError(upstream.status, await upstream.json().catch(() => null))
        const status = upstream.status === 401 || upstream.status === 429 ? upstream.status : 502
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: formatTraeErrorMessage(parsed.code, parsed.message), code: parsed.code } }))
        gwLog({ dir: 'err', status: upstream.status, code: parsed.code, model, ms: Date.now() - t0 })
        return 'done'
      }

      const id = `trae-gateway-${randomUUID().slice(0, 8)}`
      let content = ''
      let usage = null
      let finishReason = null
      let rerouteNotified = false
      const parser = createTraeStreamParser()
      // 3003 降级重试发生在同一 HTTP 响应上——首 attempt 已发头时不再重复 writeHead
      if (wantStream && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify(oaiChunk(id, model, { role: 'assistant' }))}\n\n`)
      }
      const send = (chunk) => {
        if (wantStream) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }

      let queueEmitted = false
      const outcome = await forEachSseEvent(upstream.body, parser, (ev) => {
        if (ev.error) {
          // 3003 且尚未降级且无 tools → 换 chat_v3 重试（见上方回退说明）
          if (ev.error.code === 3003 && !fallbackUsed && !hasTools) return 'fallback'
          const msg = formatTraeErrorMessage(ev.error.code, ev.error.message)
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: msg, code: ev.error.code } }))
          } else {
            send({ error: { message: msg, code: ev.error.code } })
            res.write('data: [DONE]\n\n')
            res.end()
          }
          gwLog({ dir: 'err', model, ms: Date.now() - t0, code: ev.error.code, fn: fnValue })
          return 'done'
        }
        if (ev.queue != null && !queueEmitted) {
          queueEmitted = true
          send(oaiChunk(id, model, { content: `（Trae 排队中，位置 ${ev.queue}）\n` }))
        }
        // 模型改派提示（一次）：请求模型 ≠ timing_cost 报告的实际模型时，
        // 以 SSE 注释行告知（OpenAI 解析器忽略、原始流/日志可见——不污染
        // 调用方会话历史），计量/日志用真实模型——绝不假装请求模型被服务。
        const actual = parser.providerModel()
        if (actual && !rerouteNotified && model && actual !== model) {
          rerouteNotified = true
          // 值过 sseLineValue 清洗（审计 [20]）：model/actual 任一方含 \r\n
          // 都会在注释行后伪造 SSE 帧。其余 res.write 全部经 JSON.stringify。
          if (wantStream) res.write(`: trae-reroute requested=${sseLineValue(model)} actual=${sseLineValue(actual)}\n\n`)
        }
        if (ev.reasoning) send(oaiChunk(id, model, { reasoning_content: ev.reasoning }))
        if (ev.text) {
          content += ev.text
          send(oaiChunk(id, model, { content: ev.text }))
        }
        if (ev.toolCall) {
          // OpenAI 流式约定：首片带 id/type/name，续片只带 index+arguments 增量
          const tc = { index: ev.toolCall.index, function: { arguments: ev.toolCall.argsDelta } }
          if (ev.toolCall.id) { tc.id = ev.toolCall.id; tc.type = 'function' }
          if (ev.toolCall.name) tc.function.name = ev.toolCall.name
          send(oaiChunk(id, model, { tool_calls: [tc] }))
        }
      })
      if (outcome) return outcome
      finishReason = parser.finish() ?? 'stop'
      usage = parser.usage()
      const actualModel = parser.providerModel() ?? model
      if (wantStream) {
        send(oaiChunk(id, model, {}, finishReason, usage))
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const message = { role: 'assistant', content }
        const calls = parser.toolCalls()
        if (calls.length) message.tool_calls = calls
        if (parser.providerModel() && parser.providerModel() !== model) {
          message.note = `served by ${parser.providerModel()} (requested ${model})`
        }
        res.end(JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: usage ?? {},
        }))
      }
      if (usage) deps.meter.record({ ts: t0, kind: 'chat', model: actualModel || null, usage })
      gwLog({ dir: 'out', model, actualModel, rerouted: actualModel !== model, ms: Date.now() - t0, bytes: content.length, usage, finishReason, fn: fnValue })
      return 'done'
    }

    try {
      let fnValue = 'inline_chat'
      for (;;) {
        const outcome = await attemptInline(fnValue)
        if (outcome === 'fallback') {
          fallbackUsed = true
          fnValue = 'chat_v3'
          gwLog({ dir: 'fallback', from: 'inline_chat', to: 'chat_v3', model, ms: Date.now() - t0 })
          continue
        }
        break
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      try { res.end(JSON.stringify({ error: { message: `trae gateway error: ${err?.message ?? err}` } })) } catch { res.end() }
    } finally {
      release()
    }
  }

  function listen(port) {
    const server = createServer((req, res) => {
      // Host 门（审计 [9]，listen 目标恒为 127.0.0.1）：非回环 Host → 403。
      // 先 resume 丢弃未读请求体再应答，保证 403 完整送达后连接正常收尾。
      if (!isLoopbackHost(req.headers.host)) {
        req.resume()
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'forbidden: loopback host required' } }))
        return
      }
      // Buffer 收集 + 一次解码（踩坑 #28，同 core/bridge.js）：逐分片隐式
      // utf8 解码会把跨分片多字节字符损坏成 3×U+FFFD，译文上行带乱码。
      const chunks = []
      let received = 0
      req.on('data', (c) => {
        chunks.push(c)
        received += c.length
        if (received > 32 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const path = req.url?.split('?')[0] ?? ''
        try {
          if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
            handleChat(req, res, rawBody).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end() } })
            return
          }
          if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              object: 'list',
              data: (deps.getCatalogIds() ?? []).map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000) })),
            }))
            return
          }
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${path}` } }))
        } catch (err) {
          if (!res.headersSent) res.writeHead(500)
          res.end(String(err?.message ?? err))
        }
      })
    })
    server.on('error', (err) => {
      deps.runtime.running = false
      deps.runtime.lastError = err?.code ?? String(err?.message ?? err)
      process.stderr.write(`${logPrefix} gateway :${port} unavailable: ${deps.runtime.lastError}（Trae 分区其余功能不受影响）\n`)
    })
    server.on('listening', () => {
      // port=0（临时端口，测试用）时回填实际端口。
      deps.runtime.port = server.address()?.port ?? port
      deps.runtime.running = true
      deps.runtime.lastError = null
    })
    server.listen(port, '127.0.0.1')
    return () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { listen, handleChat }
}
