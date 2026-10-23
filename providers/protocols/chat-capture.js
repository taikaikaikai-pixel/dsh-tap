/**
 * providers/protocols/chat-capture.js — 协议面复用「本通道内部 OpenAI chat 面」的接缝。
 *
 * 存在理由（尽量少造重复轮子）：`providers/loopback-gateway.js` 建的两条翻译网关
 * （Trae :3902 / Qoder :3903）已经各自拥有一整条**内部 OpenAI chat 面**——
 * `handleChat(req, res, rawBody)` 收标准 chat payload、走凭据/并发闸/首字节护栏/
 * tool 配对体检/计量/取证，出标准 OpenAI SSE（或聚合 JSON）。新增的 Anthropic
 * Messages 与 OpenAI Responses 两个协议面**不应该重写这条流水线**，只应把
 * 「协议请求 → 内部 chat payload」与「内部 chunk → 协议事件」两层翻译叠在上面。
 *
 * 做法：给 `handleChat` 一个**捕获式 res**（不进真实 socket），把它的 SSE 帧
 * 解析成内部 chunk 交给协议面；真实响应由协议面自己按各自的事件语法写。
 * 这样凭据收口、并发闸、body limit、客户端断连、tool 配对、计量全部原样复用，
 * 一处都不用复制。
 *
 * 纪律：
 *   - 捕获式 res 必须实现 handleChat 实际用到的面（writeHead/write/end/on/off/
 *     headersSent/writableEnded）——两个网关的 handleChat 只用这些；缺面即抛，
 *     不会静默半通。
 *   - **写进来的 chunk 可能是字节**：Trae/Qoder 的 handleChat 写字符串，而
 *     `core/bridge.js` 的 SSE 中继写 `Uint8Array`（undici 的 reader 原样字节）。
 *     字节必须过**流式 TextDecoder** 一次解码——`String(uint8)` 会展开成
 *     "100,97,116,97…" 数字串（一个 `data:` 帧都认不出来 ⇒ 协议面下发空流、
 *     零报错），而逐分片 `toString` 又会把跨分片的多字节字符损坏成 U+FFFD
 *     （踩坑 #28 同族）。
 *   - 真实 res 关闭（客户端断开）→ 向捕获 res 派发 'close'，让 handleChat 的
 *     「客户端断连取消上游」逻辑照常生效（不白烧额度）。
 *   - 非 SSE 响应体（handleChat 的错误 JSON）只累积到 `_body`（有界），SSE 流
 *     逐行消费不留全文，避免长流内存增长。
 */

import { EventEmitter } from 'node:events'

/**
 * 捕获式 res：形状对齐 node:http ServerResponse 中 handleChat 真正用到的子集。
 * 收到 `data:` 帧按内部 OpenAI 契约派发给 sink：
 *   onHead({status, headers}) / onChunk(openAiChunk) / onError(errorObject) /
 *   onDone()（[DONE] 帧）/ onEnd({status, headers, body})。
 */
export class CaptureResponse extends EventEmitter {
  constructor(sink) {
    super()
    this._sink = sink
    this.statusCode = 200
    this.headers = {}
    this.headersSent = false
    this.writableEnded = false
    this.destroyed = false
    this._buf = ''
    this._body = []
    // 流式解码器：handleChat 可能写 Uint8Array（core/bridge.js 的 SSE 中继），
    // 跨分片的多字节字符必须由同一个解码器续接（见文件头纪律）。
    this._decoder = new TextDecoder()
  }

  writeHead(status, headers) {
    this.statusCode = status
    this.headersSent = true
    if (headers && typeof headers === 'object') Object.assign(this.headers, headers)
    this._sink.onHead?.({ status, headers: this.headers })
    return this
  }

  setHeader(name, value) { this.headers[name] = value; return this }
  getHeader(name) { return this.headers[name] }
  removeHeader(name) { delete this.headers[name] }
  flushHeaders() { this.headersSent = true }

  write(chunk) {
    this._feed(this._text(chunk))
    return true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null && chunk !== '') this._feed(this._text(chunk))
    // 冲刷解码器：跨分片多字节字符的尾巴（若有）在这里补齐，否则尾部一个字符
    // 会静默丢掉——只在字节路径上有意义，字符串路径解码器恒空。
    this._feed(this._decoder.decode())
    if (this.writableEnded) return this
    this.writableEnded = true
    this._sink.onEnd?.({ status: this.statusCode, headers: this.headers, body: this._body.join('') })
    return this
  }

  /**
   * 一次解码（踩坑 #28 同族）：字符串原样，字节过流式 TextDecoder。
   * `String(uint8array)` 得到的是 "100,97,…" 数字串，SSE 行扫描会一帧都认不出来。
   */
  _text(chunk) {
    if (typeof chunk === 'string') return chunk
    if (chunk === null || chunk === undefined) return ''
    if (chunk instanceof Uint8Array) return this._decoder.decode(chunk, { stream: true })
    return String(chunk)
  }

  get _isSse() {
    const ct = this.headers['Content-Type'] ?? this.headers['content-type'] ?? ''
    return String(ct).includes('event-stream')
  }

  _feed(text) {
    // 非 SSE 体（错误 JSON 等）：只留一份有界副本供错误归因，不做行扫描。
    if (!this._isSse) {
      if (this._body.length < 8) this._body.push(text.slice(0, 2000))
      return
    }
    this._buf += text
    let nl
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim()
      this._buf = this._buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue // 注释行（如 trae-reroute 披露）不是用户可见内容
      const data = line.slice(5).trim()
      if (data === '[DONE]') { this._sink.onDone?.(); continue }
      let chunk = null
      try { chunk = JSON.parse(data) } catch { continue }
      if (chunk && typeof chunk === 'object' && chunk.error) this._sink.onError?.(chunk.error)
      else this._sink.onChunk?.(chunk)
    }
  }
}

/**
 * 驱动本通道的内部 OpenAI chat 面，把结果喂给 sink。协议面只经此入口触达上游。
 *
 * @param {object} deps
 * @param {(req, res, rawBody) => Promise<void>} deps.handleChat 本通道翻译层入口
 * @param {import('node:http').IncomingMessage} deps.req 原始请求（会话亲和头原样可见）
 * @param {import('node:http').ServerResponse} deps.res 真实响应（只用来监听客户端断连）
 * @param {object} deps.chatPayload 内部 OpenAI chat payload（stream 恒为 true）
 * @param {object} deps.sink 见 CaptureResponse
 */
export async function invokeInternalChat({ handleChat, req, res, chatPayload, sink }) {
  const capture = new CaptureResponse(sink)
  // 客户端断连传播：真实 res 关闭且未正常结束 → 让 handleChat 的 onClose 取消上游。
  const onClientClose = () => { if (!capture.writableEnded) capture.emit('close') }
  res.on('close', onClientClose)
  try {
    await handleChat(req, capture, JSON.stringify(chatPayload))
  } catch (err) {
    // handleChat 自己已把大多数失败写成响应；这里是最后兜底，仍要带上原因（踩坑 #7）。
    sink.onError?.({ message: `internal chat surface failed: ${err?.message ?? err}`, code: 'internal_error' })
  } finally {
    res.off('close', onClientClose)
    // handleChat 异常退出且从未 end()：补一次收尾，否则协议面永远等不到流结束。
    if (!capture.writableEnded) capture.end()
  }
}
