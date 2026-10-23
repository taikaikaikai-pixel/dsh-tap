/**
 * providers/protocols/surface.js — 两个协议面（Anthropic Messages / OpenAI Responses）
 * 共用的**生命周期驱动器**。
 *
 * 两个协议面的差异只有三件：请求→内部 chat 的映射、内部 chunk→协议事件的翻译、
 * 错误信封的语法。其余生命周期逐字节同形，抽到这里只写一份：
 *
 *   1. 入站校验（parseRequest 返回 error 即 400 协议化错误）；
 *   2. 恒以 `stream:true` 驱动内部 chat 面（CodeBuddy/上游只支持流式——非流式
 *      协议面必须由我们聚合流式响应后回吐标准 JSON，同 core/bridge.js 先例）；
 *   3. **提交纪律（踩坑 #60）**：`writeHead` 与首个用户可见内容分步——内部 chunk
 *      先入队，直到 translator 标出「本批含用户可见内容」（由各协议面定义：文本
 *      增量等；角色帧/工具调用声明不算）才 writeHead(200, text/event-stream) 并
 *      冲刷队列。此前若内部面回非 200
 *      （未登录 503、入站 400 等）或流出错，可以**干净地**改答协议化 JSON 错误，
 *      不会出现「头已发出去、内容一个字没有」的半截流。注释行/角色帧不是用户
 *      可见内容，不计入提交判据。
 *   4. 非流式：同一 translator 收完流后由 result() 产出协议原生 JSON（不另写聚合器）。
 */

/** 统一 SSE 帧编码：两个协议面都用具名事件（`event:` 行 + data JSON 带 type）。 */
export function encodeSseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** 直接写 JSON 响应；头已发出时只能收尾（不再抛 "headers already sent"）。 */
export function sendJson(res, status, body) {
  if (res.headersSent) {
    try { res.end() } catch { /* 已断开 */ }
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 内部面错误体里的原因（踩坑 #7：错误必须带原因，不许只给状态码）。 */
function internalMessage(status, body, streamError) {
  if (streamError?.message) return `upstream error: ${streamError.message}`
  const text = String(body ?? '').trim()
  if (text) {
    try {
      const parsed = JSON.parse(text)
      const msg = parsed?.error?.message ?? parsed?.message
      if (typeof msg === 'string' && msg) return `internal chat surface HTTP ${status}: ${msg}`
    } catch { /* 非 JSON，下面截断 */ }
    return `internal chat surface HTTP ${status}: ${text.slice(0, 300)}`
  }
  return `internal chat surface HTTP ${status}`
}

/** 错误码归一：协议信封的 `code` 是字符串字段，而三条通道的码方言不同——
 *  Trae/Qoder 是字符串，**CodeBuddy 是数字**（11102/11148…，见
 *  providers/codebuddy/errors.js）。不归一就会在数字码通道上落成 `code: null`，
 *  机器可读的码丢掉（原因仍在 message，但踩坑 #7 的"错误带原因"应含码）。
 *  `0` 是上游成功哨兵（providers/codebuddy/index.js 的 extractStreamError 以
 *  `code !== 0` 判错），出现在错误路径上不当作码。
 * 导出给协议面复用（Responses 的流内 error 事件同一条码方言）。 */
export function normalizeCode(code) {
  if (typeof code === 'string' && code) return code
  if (typeof code === 'number' && Number.isFinite(code) && code !== 0) return String(code)
  return undefined
}

function internalCode(body, streamError) {
  if (streamError?.code) return normalizeCode(streamError.code)
  try {
    const parsed = JSON.parse(String(body ?? ''))
    return normalizeCode(parsed?.error?.code ?? parsed?.code)
  } catch { /* ignore */ }
  return undefined
}

/**
 * @param {object} deps
 * @param {(req, res, chatPayload, sink) => Promise<void>} deps.invokeChat 驱动内部 chat 面
 *   （res 是真实响应，仅用于客户端断连传播；协议面自己写响应）
 * @param {(payload: any) => {chat: object, stream?: boolean, unsupported?: string[]}|{error: object}} deps.parseRequest
 * @param {(args: {model: string}) => object} deps.createTranslator
 *   push(chunk)→{events, visible} / finish()→events / error(err)→event / result()→JSON
 * @param {(err: {status?: number, message: string, code?: string}) => {status: number, body: object}} deps.protocolError
 * @param {(note: string) => void} [deps.note] 未实现字段的如实披露出口（stderr）
 */
export function createProtocolSurface({ invokeChat, parseRequest, createTranslator, protocolError, note = () => {} }) {
  return async function handleProtocol(req, res, rawBody) {
    let payload = null
    try { payload = JSON.parse(rawBody) } catch { payload = null }
    const parsed = parseRequest(payload)
    if (parsed.error) {
      const mapped = protocolError(parsed.error)
      sendJson(res, mapped.status, mapped.body)
      return
    }
    const wantStream = parsed.stream === true
    if (Array.isArray(parsed.unsupported) && parsed.unsupported.length) {
      note(`request fields accepted but not mapped: ${parsed.unsupported.join(', ')}`)
    }
    const translator = createTranslator({ model: parsed.chat.model })

    const queue = []
    let committed = false
    let internalStatus = 200
    let internalBody = ''
    let streamError = null

    const commit = () => {
      if (committed) return // 幂等：finish 事件带 visible 时已提交，收尾处不得二次 writeHead
      committed = true
      if (!wantStream) return
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      for (const event of queue) res.write(encodeSseEvent(event))
      queue.length = 0
    }
    const emit = (events, visible = false) => {
      if (!Array.isArray(events) || events.length === 0) return
      if (!wantStream) return // 非流式：只要 translator 的终态 result()，事件本身丢弃
      if (!committed && visible) commit()
      if (committed) { for (const event of events) res.write(encodeSseEvent(event)) } else { queue.push(...events) }
    }

    await invokeChat(req, res, parsed.chat, {
      onHead: (info) => { if (typeof info?.status === 'number') internalStatus = info.status },
      onChunk: (chunk) => {
        const step = translator.push(chunk)
        if (step) emit(step.events, step.visible === true)
      },
      onError: (err) => { streamError = err ?? { message: 'unknown upstream error' } },
      onDone: () => {},
      onEnd: (info) => {
        if (info && typeof info.status === 'number') internalStatus = info.status
        internalBody = info?.body ?? ''
      },
    })

    // 内部面非 200 且尚无用户可见内容 → 干净的协议化错误（保留真实状态与原因）。
    if (internalStatus !== 200 && !committed) {
      const mapped = protocolError({
        status: internalStatus,
        message: internalMessage(internalStatus, internalBody, streamError),
        code: internalCode(internalBody, streamError),
      })
      sendJson(res, mapped.status, mapped.body)
      return
    }
    if (streamError && !committed) {
      const mapped = protocolError({
        status: 502,
        message: `upstream stream error: ${streamError.message ?? String(streamError)}`,
        code: normalizeCode(streamError.code),
      })
      sendJson(res, mapped.status, mapped.body)
      return
    }
    if (streamError) {
      // 已提交（流中途出错）：按协议语法下发错误事件并收尾。
      emit([translator.error(streamError)], true)
      commit()
      res.end()
      return
    }
    emit(translator.finish(), true)
    if (wantStream) {
      commit()
      res.end()
      return
    }
    sendJson(res, 200, translator.result())
  }
}
