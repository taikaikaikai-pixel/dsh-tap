/**
 * providers/qoder/gateway.js — OpenAI ↔ Qoder COSY 翻译网关（Qoder 聊天桥）。
 *
 * 定位同 providers/trae/gateway.js：core/bridge.js 是透传代理（上游说 OpenAI
 * 方言），本网关是协议翻译器——Qoder 聊天面的线缆形态是 COSY 签名 + WASM 加密
 * body + SSE 信封（证据与设计文档见 docs/goals/qoder-cn-provider-design.md
 * §5b 与 2026-09-20 探测）：
 *
 *   出站：POST {inferBaseURL}/algo/api/v2/service/pro/sse/agent_chat_generation
 *         ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 *         （URL/头/body 全由 cosy.prepareChat 产出，签名绑定 URL 不可手改）；
 *         body 明文 = OpenAI 白名单字段 + 官方客户端用量归因信封（request_id/
 *         request_set_id/session_id/chat_task/version:"3"/source:1/agent_id/
 *         task_id/session_type/model_config/business 块——2026-09-22 逆向：
 *         配额扣减与形态无关（裸 body 也实时入账），统计视图由归因链驱动）；
 *         每轮结束补 business/finish + /api/v1/tracking 两条 COSY 签名上报
 *         （best-effort，官方客户端同语义，证据 docs/probes/qoder-attribution-*.json）
 *   入站 SSE：data:{headers, body, statusCodeValue} 信封——body 是**字符串**，
 *         内容为标准 OpenAI chat.completion.chunk 的 JSON 或 "[DONE]"；
 *         尾帧 {firstTokenDuration,totalDuration,serverDuration} 无 body 忽略；
 *         event:error + data:{stackTrace…} 为服务端异常（如 body 非合法 JSON）；
 *         带内失败帧 = HTTP 200 信封里 body 是业务错误对象（无 choices/usage、
 *         有 code/message，实测形态 {"code":"400","message":"[FAIL]node:…
 *         msg:Execution failed: null"}）——同等当错误上抛，不静默空响应。
 *         翻译 = 拆信封把 inner chunk 原样下发（增量/tool_calls/finish/usage
 *         全是标准 OpenAI 形态，2026-09-20 矩阵实测）；usage.credits →
 *         usage.credit 进计量（usage-meter 契约）。
 *
 * 非流式入站：聚合成单个 chat.completion（内部仍走上游流式）。
 * 生命周期纪律（踩坑 #17）：listen 失败降级 runtime.lastError，绝不抛出。
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

import { SessionLimiter, extractSessionId } from '../../core/bridge.js'
import { sanitizeToolPairing, describeRepair } from '../tool-pairing.js'
import { QODER_COSY_VERSION } from './cosy.js'
import { randomUUID } from 'node:crypto'

/** 上游接受的 OpenAI 字段白名单（dsh/pi-ai 可能附带私有扩展，不透传）。 */
const CHAT_FIELDS = [
  'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens',
  'max_completion_tokens', 'stop', 'reasoning_effort', 'presence_penalty',
  'frequency_penalty', 'response_format', 'seed', 'user', 'parallel_tool_calls',
]

// 出站 messages 的 tool 配对不变量修复：实现与根因见 providers/tool-pairing.js
// （踩坑 #39）。本模块重新导出，保持既有 import 路径与回归断言可用。
export { sanitizeToolPairing }

/** Host 门（同 trae gateway）：回环端口是唯一防线，Host 必须回环。 */
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

/**
 * Origin 门（与 Host 门互补，index.js localGuardFailure 同口径）：浏览器
 * 跨站请求（含 navigator.sendBeacon）恒带 Origin——host:port 必须与 Host
 * 完全一致才放行，否则即借浏览器烧额度的 CSRF。无 Origin 放行：本机
 * fetch/curl 与剥 Origin 的壳转发均不带该头，Host 门仍把守回环。
 */
function isLoopbackOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Qoder SSE 信封解析器：吃原始 data 文本行，产出翻译事件
 * { chunk?, usage?, done?, error? }。inner chunk 是标准 OpenAI 形态，
 * 透传前只在需要计量时把 usage.credits 归一为 usage.credit。
 */
export function createQoderEnvelopeParser() {
  const state = { usage: null, done: false }
  return {
    isDone: () => state.done,
    usage: () => state.usage,
    /**
     * @param {string|null} eventName SSE event: 行值
     * @param {string} dataText data: 行原文
     */
    handle(eventName, dataText) {
      if (eventName === 'error') {
        state.done = true
        return { error: dataText.slice(0, 400) }
      }
      let frame
      try { frame = JSON.parse(dataText) } catch { return {} }
      if (!frame || typeof frame !== 'object') return {}
      if (typeof frame.body !== 'string') return {} // 尾帧计时统计等
      if (frame.body === '[DONE]') {
        state.done = true
        return { done: true }
      }
      let chunk
      try { chunk = JSON.parse(frame.body) } catch {
        state.done = true
        return { error: frame.body.slice(0, 400) }
      }
      // 带内失败帧：HTTP 200 信封装业务错误（无 choices/usage、有 code/message，
      // 实测 2026-09-22 qfmodel 上游节点挂：{"code":"400","message":"[FAIL]node:…"}）
      if (!Array.isArray(chunk.choices) && !chunk.usage && (chunk.code !== undefined || typeof chunk.message === 'string')) {
        state.done = true
        return { error: frame.body.slice(0, 400) }
      }
      if (chunk.usage && typeof chunk.usage === 'object') {
        const u = chunk.usage
        state.usage = {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
          credit: typeof u.credits === 'number' ? u.credits : 0,
        }
      }
      return { chunk }
    },
  }
}

/**
 * @param {{
 *   settings: () => object,      // qoderInferBaseURL / maxConcurrentPerSession / upstreamFirstByteTimeoutMs
 *   resolveCredential: (s: object) => Promise<{authorization, machineId, uid}|null>,
 *   cosy: object,                // createCosyRuntime 实例
 *   meter: { record: Function },
 *   runtime: { running, port, lastError },
 *   forensics?: { logPath: () => string|undefined },
 *   getCatalogProfiles: () => Array|null,  // /v1/models 端点
 *   getCatalogEntry?: (id: string) => object|null, // 目录原始条目（model_config 取数）
 *   getModelSource: (id: string) => string, // X-Model-Source（目录 sources 映射）
 *   getModelPrefs?: () => object, // { [id]: { effort?, contextVariant? } } 出站补默认
 * }} deps
 */
export function createQoderGateway(deps) {
  const limiter = new SessionLimiter()
  const logPrefix = '[dsh-tap/qoder]'
  // dsh 会话标识 → 官方形态 session_id（UUID）：映射为实例状态（踩坑 #20），
  // 同一 dsh 会话跨请求稳定，与官方 CLI 会话语义对齐。
  const sessionUuids = new Map()
  function qoderSessionId(dshSessionId) {
    const key = String(dshSessionId)
    let v = sessionUuids.get(key)
    if (!v) {
      v = randomUUID()
      if (sessionUuids.size >= 5000) sessionUuids.clear()
      sessionUuids.set(key, v)
    }
    return v
  }

  function gwLog(record) {
    const path = deps.forensics?.logPath?.()
    if (!path) return
    try {
      appendFileSync(path, JSON.stringify({ gw: 'qoder', ...record }) + '\n')
    } catch { /* best-effort */ }
  }

  function modelSourceOf(model) {
    return deps.getModelSource?.(model) ?? 'system'
  }

  /** 最后一条 user 消息的纯文本（content 字符串或多模态 parts 拼接）。 */
  function lastUserTextOf(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
      }
      return ''
    }
    return ''
  }

  /**
   * 用量归因上报（2026-09-22 逆向定案后接入，与官方客户端逐字段同构）：
   * 配额扣减（quota/usage 的 addOnQuota.used）对裸 OpenAI body 也实时入账
   * （臂 9 大额双臂实证）；但**统计视图**（credits-heatmap/credits-summary/
   * 网页明细）是延迟批处理且由官方归因链驱动——官方客户端每轮业务结束
   * 补两条 COSY 签名上报（bundle g4i/aPl 原文）：
   *   1. POST {infer}/api/v2/service/business/finish?Encode=1（mode auth）
   *      —— BUSINESS_FINISH 事件，business.id = request_set_id 为 join key；
   *   2. POST {infer}/api/v1/tracking（mode sign）—— back-flow 事件，
   *      聚合 total_credits/tokens（best-effort 语义，官方同样 fire-and-forget）。
   * best-effort：任何失败都不影响主链路（调用侧 .catch 落地，踩坑 #33）。
   */
  async function reportUsage({ cred, endpoint, sessionId, requestSetId, stage, promptName, usage, model, ms }) {
    const now = Date.now()
    const uid = cred.uid ?? ''
    const mid = cred.machineId ?? ''
    const inner = {
      event_time: now, event_type: 'BUSINESS_FINISH',
      mid, aid: '', rid: randomUUID(), oid: '', yid: '', uid,
      event_data: {
        session_id: sessionId,
        business: { product: 'cli', version: QODER_COSY_VERSION, type: 'agent', id: requestSetId, end_at: now, stage, name: promptName },
      },
    }
    const finishBody = JSON.stringify({ payload: JSON.stringify(inner), encodeVersion: '1' })
    const finish = await deps.cosy.prepareSigned(cred, { endpoint, path: '/api/v2/service/business/finish?Encode=1', method: 'POST', mode: 'auth', body: finishBody })
    await fetch(finish.url, { method: 'POST', headers: { ...finish.headers, 'Content-Type': 'application/json' }, body: finish.body })
    if (!usage) return
    const envelope = [{
      uuid: randomUUID(),
      event_type: 'qodercli-back-flow-agent-query-finish',
      event_time: now,
      uid, oid: '', mid, aid: '',
      os_arch: process.arch, os_version: '',
      ide_type: 'CLI', ide_version: QODER_COSY_VERSION, cluster_env: '',
      business_id: requestSetId, git_remote: '',
      event_data: {
        items: [{
          schema_version: 2, session_id: sessionId, task_id: requestSetId,
          request_set_id: requestSetId, prompt_id: randomUUID(),
          entry: 'cli', product: 'cli', client_type: '5', cli_version: QODER_COSY_VERSION, os_type: process.platform,
          query_callback: 'end', terminal_reason: stage, business_state_final: stage,
          duration_ms: ms, loop_iteration_count: 1,
          model_request_count: 1, model_request_success_count: stage === 'complete' ? 1 : 0, actual_model: model,
          total_input_tokens: usage.prompt_tokens ?? 0, total_output_tokens: usage.completion_tokens ?? 0,
          total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_thinking_tokens: 0,
          total_credits: usage.credit ?? 0, total_original_credits: usage.credit ?? 0,
          average_ttft_ms: 0, delivery_mode: 'best_effort_background',
        }],
      },
    }]
    const track = await deps.cosy.prepareSigned(cred, { endpoint, path: '/api/v1/tracking', method: 'POST', mode: 'sign', body: JSON.stringify(envelope) })
    await fetch(track.url, { method: 'POST', headers: { ...track.headers, 'Content-Type': 'application/json' }, body: track.body })
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
    const model = typeof payload.model === 'string' && payload.model ? payload.model : 'auto'
    const wantStream = payload.stream === true
    const sessionId = extractSessionId(req.headers, payload) ?? randomUUID()
    const t0 = Date.now()

    const release = await limiter.acquire(sessionId, s.maxConcurrentPerSession ?? 4)
    try {
      const cred = await deps.resolveCredential(s)
      if (!cred) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Qoder 未登录：请先在设置卡 Qoder CN 页完成浏览器授权', code: 'qoder_credential_unavailable' } }))
        return
      }
      const accessToken = String(cred.authorization ?? '').replace(/^Bearer\s+/, '')

      // 出站体：白名单透传 + 强制流式（usage 必带）
      const upstream = { model, stream: true, stream_options: { include_usage: true } }
      for (const f of CHAT_FIELDS) {
        if (payload[f] !== undefined && payload[f] !== null) upstream[f] = payload[f]
      }
      // developer → system：宿主 pi-ai 对带 reasoning 的模型把 system prompt 序列化成
      // `role:"developer"`（docs/rules/dev-role-boundary.md 同族），而 Qoder 上游在
      // **反序列化阶段**就整请求拒绝（2026-09-22 实测 dmodel：details 内层
      // "Failed to deserialize the JSON body..."，HTTP 200 信封带内错误）。两者指令
      // 语义等价，出站折叠为 system（同 codebuddy 桥 transformChatPayload 的策略）。
      // 只换 role、不原地改调用方对象。
      upstream.messages = upstream.messages.map((m) => (m && m.role === 'developer' ? { ...m, role: 'system' } : m))
      // tool 配对 + 可见性体检（真根因见 providers/tool-pairing.js 头注释：严格上游
      // 把 content 为 null 的 assistant/tool 消息从配对校验里当不存在，宿主对**每一个**
      // 工具回合都发 content:null → 该家族上工具必 400）。只动 messages。
      const pair = sanitizeToolPairing(upstream.messages)
      upstream.messages = pair.messages
      const repairedNote = describeRepair(pair.repaired)
      // 出站补默认（客户端已带的绝不覆盖）：
      //  - reasoning_effort：prefs.effort 已设且非 off——off 的语义是"省略参数"
      //    （同 cordis.patch.yml codebuddy 侧 verified 行为），不是发 'off' 线值；
      //  - max_completion_tokens：目录 profile.maxTokens 是输出上限的牙齿，payload
      //    未带 max_tokens 系时注入。只补默认，不碰白名单/计量路径。
      const prefs = deps.getModelPrefs?.() ?? {}
      const effort = prefs[model]?.effort
      if (upstream.reasoning_effort === undefined && effort !== undefined && effort !== 'off') {
        upstream.reasoning_effort = effort
      }
      if (upstream.max_tokens === undefined && upstream.max_completion_tokens === undefined) {
        const profile = (deps.getCatalogProfiles() ?? []).find((p) => p.id === model)
        if (Number.isFinite(profile?.maxTokens)) upstream.max_completion_tokens = profile.maxTokens
      }
      const endpoint = String(s.qoderInferBaseURL ?? '').replace(/\/+$/, '')
      // ── 官方客户端用量归因信封（2026-09-22 逆向：配额扣减对裸 body 也实时
      // 入账，但统计视图——热力图/汇总/明细——由归因链驱动；官方 A6e 信封的
      // 归因字段 + business 块逐字段对齐，business.id = request_set_id 与收尾
      // business/finish 上报同源）──
      const promptText = lastUserTextOf(upstream.messages)
      const requestId = randomUUID()
      const requestSetId = randomUUID()
      const qSessionId = qoderSessionId(sessionId)
      const catEntry = deps.getCatalogEntry?.(model) ?? null
      upstream.request_id = requestId
      upstream.request_set_id = requestSetId
      upstream.chat_record_id = requestId
      upstream.session_id = qSessionId
      upstream.chat_task = 'FREE_INPUT'
      upstream.chat_context = {
        text: promptText, features: [],
        extra: { context: [], modelConfig: { key: model, is_reasoning: catEntry?.is_reasoning === true }, originalContent: promptText },
        chatPrompt: '', imageUrls: null,
      }
      upstream.is_reply = true
      upstream.is_retry = false
      upstream.source = 1
      upstream.version = '3'
      upstream.agent_id = 'agent_common'
      upstream.task_id = 'common'
      upstream.session_type = 'qoderclicn'
      upstream.aliyun_user_type = ''
      upstream.model_config = {
        key: model, display_name: typeof catEntry?.display_name === 'string' ? catEntry.display_name : model,
        model: '', format: 'openai',
        is_vl: catEntry?.is_vl === true, is_reasoning: catEntry?.is_reasoning === true,
        api_key: '', url: '', source: modelSourceOf(model),
        max_input_tokens: Number.isFinite(catEntry?.max_input_tokens) ? catEntry.max_input_tokens : 128000,
      }
      upstream.business = {
        product: 'cli', version: QODER_COSY_VERSION, type: 'agent',
        id: requestSetId, name: promptText.slice(0, 10), begin_at: t0, stage: 'processing',
      }
      const report = (stage, usage) => reportUsage({
        cred: { accessToken, machineId: cred.machineId, uid: cred.uid },
        endpoint, sessionId: qSessionId, requestSetId, stage,
        promptName: upstream.business.name, usage, model, ms: Date.now() - t0,
      }).catch(() => { /* best-effort：上报失败不影响主链路（官方同语义） */ })
      const bodyJson = JSON.stringify(upstream)

      const signed = await deps.cosy.prepareChat(
        { accessToken, machineId: cred.machineId, uid: cred.uid },
        { endpoint, body: bodyJson, modelKey: model, modelSource: modelSourceOf(model) },
      )

      // 首字节护栏（同 trae gateway：边缘"收下不回应"时快速失败）
      const firstByteMs = Number(s.upstreamFirstByteTimeoutMs) > 0 ? Number(s.upstreamFirstByteTimeoutMs) : 45_000
      const inbound = new AbortController()
      const firstByteTimer = setTimeout(
        () => inbound.abort(new Error(`qoder 上游 ${firstByteMs}ms 内无响应（首字节超时）`)),
        firstByteMs,
      )
      const upstreamResp = await fetch(signed.url, {
        method: 'POST',
        headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: signed.body,
        signal: inbound.signal,
      }).finally(() => clearTimeout(firstByteTimer))

      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => '')
        const status = upstreamResp.status === 401 || upstreamResp.status === 429 ? upstreamResp.status : 502
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `qoder upstream HTTP ${upstreamResp.status}: ${text.slice(0, 200)}`, code: `qoder_${upstreamResp.status}` } }))
        gwLog({ dir: 'err', status: upstreamResp.status, model, ms: Date.now() - t0 })
        report('error', null)
        return
      }

      const id = `qoder-${randomUUID().slice(0, 8)}`
      const parser = createQoderEnvelopeParser()
      let content = ''
      let reasoning = ''
      let finishReason = null
      const toolSlots = new Map()
      const toolOrder = []

      if (wantStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      }
      const send = (chunk) => {
        if (wantStream) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      const emitError = (message) => {
        if (!wantStream) return
        send({ error: { message } })
        res.write('data: [DONE]\n\n')
        res.end()
      }

      // 逐行扫描信封（Buffer 边界安全：TextDecoder stream 模式）
      const reader = upstreamResp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastEvent = null
      // 客户端断连传播：res 关闭（且未正常结束）时取消上游流，不白烧配额。
      let clientGone = false
      const onClose = () => {
        if (res.writableEnded) return
        clientGone = true
        reader.cancel().catch(() => {})
      }
      res.on('close', onClose)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) { lastEvent = null; continue }
            if (line.startsWith('event:')) { lastEvent = line.slice(6).trim(); continue }
            if (!line.startsWith('data:')) continue
            const ev = parser.handle(lastEvent, line.slice(5).trim())
            if (ev.error) {
              gwLog({ dir: 'err', model, ms: Date.now() - t0, note: 'stream-error-frame', repaired: repairedNote })
              report('error', null)
              if (wantStream) {
                emitError(`qoder upstream error: ${ev.error}`)
              } else {
                res.writeHead(502, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: { message: `qoder upstream error: ${ev.error}`, code: 'qoder_upstream_error' } }))
              }
              return
            }
            if (!ev.chunk) continue
            const chunk = ev.chunk
            const choice = chunk.choices?.[0]
            if (choice?.delta?.content) content += choice.delta.content
            if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content
            for (const tc of choice?.delta?.tool_calls ?? []) {
              const idx = Number.isInteger(tc?.index) ? tc.index : 0
              if (!toolOrder.includes(idx)) toolOrder.push(idx)
              const slot = toolSlots.get(idx) ?? { id: '', name: '', arguments: '' }
              if (tc.id) slot.id = tc.id
              if (tc.function?.name) slot.name = tc.function.name
              if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments
              toolSlots.set(idx, slot)
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason
            if (wantStream) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        }
      } finally {
        res.off('close', onClose)
        // 正常跑完时流已 EOF，cancel 是 no-op；提前 return 时取消残留 undici 连接。
        if (!clientGone) reader.cancel().catch(() => {})
      }

      const usage = parser.usage()
      if (wantStream) {
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const message = { role: 'assistant', content }
        if (reasoning) message.reasoning_content = reasoning
        const calls = toolOrder.map((i) => {
          const slot = toolSlots.get(i)
          return { id: slot.id || `qoder-call-${i}`, type: 'function', function: { name: slot.name, arguments: slot.arguments } }
        })
        if (calls.length) message.tool_calls = calls
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
          usage: usage ?? {},
        }))
      }
      if (usage) deps.meter.record({ ts: t0, kind: 'chat', model, usage })
      gwLog({ dir: 'out', model, ms: Date.now() - t0, bytes: content.length, usage, finishReason, repaired: repairedNote })
      report('complete', usage ?? null)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        try { res.end(JSON.stringify({ error: { message: `qoder gateway error: ${err?.message ?? err}` } })) } catch { res.end() }
      } else {
        try { res.end() } catch { /* already closed */ }
      }
    } finally {
      release()
    }
  }

  function listen(port) {
    const server = createServer((req, res) => {
      // Host 门 + Origin 门：Host 必须回环（防 DNS rebinding / LAN 直连），
      // 带 Origin 时其 host:port 必须与 Host 一致（防跨站借浏览器烧额度）。
      if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req)) {
        req.resume()
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'forbidden: loopback host + same-origin required' } }))
        return
      }
      // Buffer 收集 + 一次解码（踩坑 #28）；超 32MB 答 413（同 core/bridge.js），
      // 不静默 reset——调用方能拿到真实状态码。
      const chunks = []
      let received = 0
      let oversize = false
      req.on('data', (c) => {
        if (oversize) return
        chunks.push(c)
        received += c.length
        if (received > 32 * 1024 * 1024) {
          oversize = true
          chunks.length = 0
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ error: { message: 'request body too large (limit 32MiB)' } }))
        }
      })
      req.on('end', () => {
        if (oversize) return
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
              data: (deps.getCatalogProfiles() ?? []).map((p) => ({ id: p.id, object: 'model', created: Math.floor(Date.now() / 1000) })),
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
      process.stderr.write(`${logPrefix} gateway :${port} unavailable: ${deps.runtime.lastError}（Qoder 分区其余功能不受影响）\n`)
    })
    server.on('listening', () => {
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
