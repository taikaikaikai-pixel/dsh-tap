/**
 * providers/trae/remote.js — Trae remote 会话传输（chat_sessions 协议）。
 *
 * 存在理由（2026-08-24 探测定论）：
 * raw llm_utils_chat 的模型路由被 function 位钉死——inline_chat 恒走账户默认
 * 模型（非默认模型名一律 3003 "all models failed"），solo_agent_lite 恒
 * seed-code-lite、solo_work_lite 恒 glm-5.2、chat_v3 恒 seed-code-lite；
 * model/custom_model 字段均被忽略。**唯一真实的模型选择机制是 remote 会话
 * 协议**：POST /api/remote/v1/chat_sessions 的 initial_message.model_name +
 * model_selection_strategy:"manual"（solo_agent_remote 组全部模型可选，
 * model_config/done 事件的 config_name 双重证实）。
 *
 * 代价（诚实标注）：每请求起一个云端沙箱 agent（25k 系统提示，跨会话有前缀
 * 缓存），消耗 **work 额度池**（available_endpoint=1；raw 通道消耗 IDE 池
 * endpoint=0）；并发受套餐 solo_agent_parallel_limit 限制（超额排队，
 * queuing/notification 事件）；dsh 侧 OpenAI 工具无法原生传递（远端 agent
 * 自持有工具，参照实现用 XML 提示模拟——本传输 v1 不做，带 tools 的请求
 * 由网关侧明确拒绝）。
 *
 * 事件语法（2026-08-24 真实流校准）：
 *   metadata / heartbeat / status_changed / platform_timing / timing_events → 忽略
 *   queuing / notification → 排队提示
 *   model_config {config_name} → 实际路由模型（真值源）
 *   plan_item {id, thought, reasoning_content, tool_call_info} → thought 为可见
 *     文本、reasoning_content 为思考，**均为累计快照**（按 id 分槽前缀差分）；
 *     tool_call_info.name==="finish" 时 params.summary 为最终答复
 *   token_usage {prompt_tokens, completion_tokens, total_tokens, ...} → usage
 *   done {status:"completed", user_message_context.model_info.config_name} → 终结
 *   error → 错误
 * 参照：github.com/autumnsentiment/Trae2api-cn（trae_remote_client.py / sse.py）。
 */

const DEFAULT_REMOTE_ORIGIN = 'https://solo.trae.cn'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

/** remote 面请求头（Web 客户端形态；与 raw IDE 头组完全不同的指纹）。 */
export function remoteWebHeaders(token, { stream = true } = {}) {
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'Content-Type': 'application/json',
    'X-Trae-Client-Type': 'web',
    'X-Preferenced-Language': 'zh-CN',
    'x-user-region': 'CN',
    Origin: DEFAULT_REMOTE_ORIGIN,
    Referer: DEFAULT_REMOTE_ORIGIN + '/',
    'User-Agent': WEB_UA,
    Accept: stream ? 'text/event-stream' : 'application/json',
  }
}

/** OpenAI content（字符串或分段数组）→ 纯文本。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

/**
 * OpenAI messages → remote query 字符串（JSON 数组包一个 text 块）。
 * 多轮历史带角色标记扁平化（镜像参照 flatten_query）：[System]/[Assistant]/
 * [Client Tool Call]/[Client Tool Result]——remote 会话每请求新建，历史只能
 * 以文本形式随 query 携带。
 */
export function flattenQuery(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role ?? 'user')
    const content = contentToText(m.content)
    if (role === 'system' || role === 'developer') {
      if (content) parts.push(`[System]\n${content}`)
      continue
    }
    if (role === 'assistant') {
      const segs = []
      if (content) segs.push(content)
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = c?.function ?? {}
        const id = c?.id ?? 'unknown'
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
        segs.push(`[Client Tool Call: ${id} ${fn.name ?? 'unknown'}]\nArguments: ${args}`)
      }
      if (segs.length) parts.push('[Assistant]\n' + segs.join('\n\n'))
      continue
    }
    if (role === 'tool') {
      const id = m.tool_call_id ?? 'unknown'
      const name = m.name ?? 'tool'
      parts.push(`[Client Tool Result: ${id} ${name}]\n${content}`)
      continue
    }
    if (content) parts.push(content)
  }
  return JSON.stringify([{ type: 'text', data: { content: parts.join('\n\n') } }])
}

function commonParams() {
  return JSON.stringify({
    language: 'zh-cn', app_language: 'zh-CN', quality: 'stable',
    app_version: '1.0.0.1229', web_id: '', user_identity: 'Free',
    is_freshman: '0', biz_user_id: '', user_unique_id: '',
    scope: 'marscode-cn', tenant: 'marscode', region: 'cn', aiRegion: 'cn',
    is_privacy_mode: 0, privacy_mode: 'off', solo_chat_mode: 'code',
  })
}

/** chat_sessions 创建体（9router 变体：content 空数组，query 承载全部）。 */
export function buildRemoteCreateBody(model, messages) {
  return {
    mode: 'code',
    environment_id: 'default',
    initial_message: {
      chat_session_id: '',
      content: [],
      query: flattenQuery(messages),
      model_name: model,
      agent_type: 'solo_agent_remote',
      model_selection_strategy: 'manual',
      common_params: commonParams(),
    },
    env: 'remote',
    auto_create_project: false,
    origin: 'web',
  }
}

/** 创建 remote 会话。返回 {sessionId, messageId}；失败抛带 HTTP/业务码的 Error。
 *  边缘韧性（2026-08-24 故障取证，docs/diagnosis-trae-3003.md）：TLB/nginx 存在
 *  节点间路由表漂移——同一时刻带凭据请求可能命中缺 /api/remote/v1 路由的节点，
 *  返回**裸文本 404 "Not Found"（或 WAF 空体 403）**，而业务级错误恒为 JSON。
 *  对这两种"裸非 JSON 拒绝"做一次短退避重试（创建失败不产生会话，幂等安全）。 */
const EDGE_RETRY_DELAY_MS = 900
const isEdgeSkewReject = (status, text) =>
  (status === 404 || status === 403) && !text.trimStart().startsWith('{')

/** create 会话是短请求（非流式 JSON），必须限时——边缘/本地代理死态时快速
 *  失败而非无限挂起（2026-08-24 本地代理抽风实测）。测试可用 opts.timeoutMs 调短。 */
const CREATE_TIMEOUT_MS = 20_000

export async function createRemoteSession(baseURL, token, model, messages, { timeoutMs } = {}) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : CREATE_TIMEOUT_MS
  const attemptOnce = async () => {
    const resp = await fetch(`${baseURL}/api/remote/v1/chat_sessions`, {
      method: 'POST',
      headers: remoteWebHeaders(token, { stream: false }),
      body: JSON.stringify(buildRemoteCreateBody(model, messages)),
      signal: AbortSignal.timeout(limit),
    })
    return { resp, text: await resp.text() }
  }
  let resp
  let text
  try {
    ;({ resp, text } = await attemptOnce())
    if (isEdgeSkewReject(resp.status, text)) {
      await new Promise((r) => setTimeout(r, EDGE_RETRY_DELAY_MS))
      ;({ resp, text } = await attemptOnce())
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || /timeout|timed?\s?out/i.test(String(e?.message ?? ''))) {
      throw new Error(`trae remote create_session 超时（${limit}ms 无响应）——边缘/WAF 拦截或本地代理异常；可稍后重试或改用 inline 通道`)
    }
    throw e
  }
  if (resp.status >= 400) {
    const skew = isEdgeSkewReject(resp.status, text)
    const err = new Error(`trae remote create_session [${resp.status}]: ${text.slice(0, 300)}${skew ? '（边缘节点路由漂移/WAF 拦截，通常数分钟内自愈；可稍后重试或改用 inline 通道）' : ''}`)
    err.status = resp.status
    throw err
  }
  let data
  try { data = JSON.parse(text) } catch {
    throw new Error(`trae remote create_session: non-json response: ${text.slice(0, 200)}`)
  }
  if (data.code != null && data.code !== 0 && !data.data) {
    const err = new Error(`trae remote create_session: ${data.code} ${data.message ?? ''}`.trim())
    err.code = data.code
    throw err
  }
  const payload = data.data ?? data
  const sessionId = String(payload.chat_session_id ?? '')
  const messageId = String(payload.message_id ?? '')
  if (!sessionId || !messageId) throw new Error('trae remote create_session: missing chat_session_id/message_id')
  return { sessionId, messageId }
}

/** 拉取事件流（调用方负责读 response.body 到 EOF）。 */
export async function openRemoteEvents(baseURL, token, sessionId, messageId) {
  const resp = await fetch(
    `${baseURL}/api/remote/v1/chat_sessions/${sessionId}/events?reply_to_message_id=${messageId}`,
    { headers: remoteWebHeaders(token) },
  )
  if (resp.status >= 400) {
    const text = await resp.text().catch(() => '')
    const err = new Error(`trae remote events [${resp.status}]: ${text.slice(0, 300)}`)
    err.status = resp.status
    throw err
  }
  return resp
}

/** 终止会话（best-effort，绝不抛出）。 */
export async function stopRemoteSession(baseURL, token, sessionId, messageId) {
  if (!sessionId || !messageId) return
  try {
    await fetch(`${baseURL}/api/remote/v1/chat_sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: remoteWebHeaders(token, { stream: false }),
      body: JSON.stringify({ chat_session_id: sessionId, user_message_id: messageId }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* best-effort */ }
}

/** 累计快照 → 增量（前缀扩展，否则回退公共前缀——镜像 Trae2api-cn
 *  ProtocolTextAccumulator）。实现唯一归此文件；gateway.js import 并 re-export。 */
export function cumulativeDelta(previous, current) {
  if (typeof current !== 'string' || current === '') return ''
  if (typeof previous !== 'string' || previous === '') return current
  if (current.startsWith(previous)) return current.slice(previous.length)
  if (previous.startsWith(current)) return ''
  let i = 0
  const limit = Math.min(previous.length, current.length)
  while (i < limit && previous[i] === current[i]) i += 1
  return current.slice(i)
}

/** 去尾部空白（finish summary 覆盖判定用）。 */
function rstripEnd(s) {
  return typeof s === 'string' ? s.replace(/\s+$/, '') : ''
}

/**
 * remote 事件流解析器。吃 (eventName, dataObj)，产 {text?, reasoning?, usage?,
 * actualModel?, queue?, finish?, error?}。文本语义：
 * - 每个 plan_item id 一槽，thought=可见文本、reasoning_content=思考（累计快照差分）
 * - finish 工具调用的 params.summary=最终答复：流结束时若可见文本未覆盖则补发
 * - done/EOF 终结；finish_reason 恒 'stop'
 */
export function createRemoteEventParser() {
  const state = {
    slots: new Map(), // planItemId -> {thought, reasoning}
    order: [],
    finalSummary: '',
    usage: null,
    actualModel: null,
    done: false,
    queueSeen: false,
  }
  const streamedAll = () => state.order.map((id) => state.slots.get(id)?.thought ?? '').join('')
  /** finish summary 兜底：可见文本为空→补全文；未以 summary 结尾→追加。 */
  const summaryTail = () => {
    const full = streamedAll()
    if (!state.finalSummary) return ''
    if (!full.trim()) return state.finalSummary
    if (!rstripEnd(full).endsWith(rstripEnd(state.finalSummary))) return '\n\n' + state.finalSummary
    return ''
  }

  return {
    isDone: () => state.done,
    usage: () => state.usage,
    actualModel: () => state.actualModel,
    /** 非流式聚合用的最终可见文本（finish summary 兜底）。 */
    finalText: () => streamedAll() + summaryTail(),
    handle(eventName, obj) {
      if (!obj || typeof obj !== 'object') return {}
      const event = typeof obj.event === 'string' && obj.event ? obj.event : eventName
      if (event === 'error') {
        state.done = true
        return { error: obj }
      }
      if (event === 'model_config') {
        if (typeof obj.config_name === 'string' && obj.config_name) state.actualModel = obj.config_name
        return {}
      }
      if (event === 'token_usage') {
        const u = obj.usage ?? obj
        const num = (k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? u[k] : null)
        const usage = {
          prompt_tokens: num('prompt_tokens'),
          completion_tokens: num('completion_tokens'),
          total_tokens: num('total_tokens'),
        }
        if (usage.total_tokens != null || usage.prompt_tokens != null) state.usage = usage
        return {}
      }
      if (event === 'queuing' || event === 'notification') {
        if (!state.queueSeen) {
          state.queueSeen = true
          return { queue: true }
        }
        return {}
      }
      if (event === 'done') {
        state.done = true
        const info = obj.user_message_context?.model_info
        if (!state.actualModel && typeof info?.config_name === 'string' && info.config_name) {
          state.actualModel = info.config_name
        }
        const tail = summaryTail()
        return tail ? { text: tail, finish: 'stop' } : { finish: 'stop' }
      }
      if (event !== 'plan_item') return {}
      const out = {}
      const tci = obj.tool_call_info
      if (tci && typeof tci === 'object' && tci.name === 'finish') {
        const summary = tci.params?.summary
        if (typeof summary === 'string' && summary) state.finalSummary = summary
      }
      const id = typeof obj.id === 'string' && obj.id ? obj.id : '(anon)'
      if (!state.slots.has(id)) {
        state.slots.set(id, { thought: '', reasoning: '' })
        state.order.push(id)
      }
      const slot = state.slots.get(id)
      const thoughtSnap = typeof obj.thought === 'string' ? obj.thought : ''
      const reasoningSnap = typeof obj.reasoning_content === 'string' ? obj.reasoning_content : ''
      const td = cumulativeDelta(slot.thought, thoughtSnap)
      const rd = cumulativeDelta(slot.reasoning, reasoningSnap)
      if (thoughtSnap) slot.thought = thoughtSnap
      if (reasoningSnap) slot.reasoning = reasoningSnap
      if (td) out.text = td
      if (rd) out.reasoning = rd
      return out
    },
  }
}
