/**
 * core/http-surface.js — 本机 HTTP 面的**唯一脚手架**（provider 无关）。
 *
 * 改造前本插件有 3 份手写的 `createServer` 脚手架（流式桥 / 两个翻译网关），
 * 每份各自实现：Host+Origin 门 → 403、请求体累积 → 413、路由分发 → 404、
 * 兜底 → 500、`server.on('error')` → `runtime.lastError`、`stop()` 收连接。
 * 六处共同语义的代码抄了三遍，于是三处细节各不相同：
 *   - 403 只有桥回 text/plain，两家回 JSON（调用方解析方式因通道而异）；
 *   - 403 前只有两家 `req.resume()` 排空请求体；
 *   - 413 上限文案一处写数字、两处写 `32MiB`；
 *   - 500 只有桥回纯文本、两家回 JSON 但文案前缀各写；
 *   - 只有两家在 `listening` 事件里回填 `runtime.port`（`port:0` 时桥的实
 *     际端口永远是 0 —— 测试与「重试监听」都读不到真实端口）。
 * 本模块把「本机 HTTP 面」的响应出口与服务器生命周期收成一份，三个通道
 * 只保留自己的**处理逻辑**（SSE/翻译/转发），不碰门、不动包体纪律。
 *
 * 边界（改这里前先读）：
 *   - 只服务**本机回环**面：绑定 127.0.0.1，Host/Origin 门一律来自
 *     `core/net-guard.js`（本文件不再出现回环字面量判定）。
 *   - 不改业务语义：handler 拿到的 body 与旧代码完全一致（Buffer 收集后
 *     一次 utf8 解码，踩坑 #28）。
 *   - 错误信封只走两条契约（踩坑 #79）：本机 HTTP 面（OpenAI 形）用
 *     `{ error: { message, code } }`；设置路由（宿主 UI 形）用
 *     `{ ok:false, error:string }`，各用一个出口，不许合并。
 */

import { createServer } from 'node:http'
import { describeError } from './errors.js'
import { localGuardFailure } from './net-guard.js'

/** 请求体上限默认值：聊天面可带 base64 图，32MiB（与旧 core/bridge.js 一致）。 */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

/** 超限后等客户端把这一轮上传发完的上限；超时即收尾（防止死连接占住 socket）。 */
export const OVERSIZE_GRACE_MS = 30000

/** 拒绝面唯一文案（三家网关现在逐字一致；调用方按 code 分支，不解析这句话）。 */
export const GUARD_REFUSAL_MESSAGE = 'forbidden: loopback host + same-origin required'

/**
 * 单一响应出口，**幂等**：已应答/已销毁/已发头的连接直接丢弃这次写入。
 *
 * 为什么必须有这道守卫：异步副作用（目录同步、镜像写入、applyLive）抛错时，
 * 兜底分支会落到 catch 再写一次响应 ⇒ `ERR_HTTP_HEADERS_SENT` 抛在 async
 * 回调里 = 未处理拒绝 = 宿主进程退出——一条请求打死 dsh。写失败同样只记
 * stderr，不向上抛。
 *
 * @returns {boolean} 这次写入是否真的发出去了（false = 已经应答过）
 */
export function sendJSON(res, status, payload, extraHeaders = null) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders ?? {}),
    })
    res.end(JSON.stringify(payload))
    return true
  } catch (err) {
    process.stderr.write(`[dsh-tap] response write failed: ${err?.message ?? err}\n`)
    return false
  }
}

/**
 * OpenAI 形错误信封（dsh/pi-ai 读 `error.message`）。
 * @param {{ message: string, code?: string }} shape
 */
export function sendError(res, status, { message, code } = {}, extraHeaders = null) {
  const body = { error: { message: String(message ?? 'internal error') } }
  if (typeof code === 'string' && code !== '') body.error.code = code
  return sendJSON(res, status, body, extraHeaders)
}

/** 500 兜底：已发头（SSE 在途）时只收尾连接，不二次写头。 */
export function failInternal(res, err, fallback = 'internal error') {
  if (!res || res.destroyed || res.writableEnded) return false
  if (res.headersSent) {
    try { res.end() } catch { /* 连接已断 */ }
    return false
  }
  const d = describeError(err, { fallback })
  return sendError(res, 500, { message: d.message, code: d.code })
}

/**
 * 请求体读取：Buffer 收集 + **一次** utf8 解码（踩坑 #28——逐分片隐式解码
 * 会把跨 TCP 分片的多字节字符损坏成 3×U+FFFD）。
 *
 * 超限的时序（2026-10 实测，别改回去）：**先排空这一轮上传，再回 413**。
 * 旧写法在收到第 32MiB 的瞬间 `res.end()`，Node 随即销毁 socket；客户端此时
 * 还在写剩下的字节，RST 会把它已收到的响应缓冲一起抹掉——最终只看到
 * «连接被重置»，拿不到状态码（verify-bridge §15c 曾因此间歇性失败）。
 * 排空期间不再缓冲（内存上限仍是 maxBytes），graceMs 后强制收尾，防死连接。
 *
 * 客户端中止：`aborted`/`error` 都 resolve null（`end` 永不触发，不清理会
 * 把请求对象与闭包一直挂着）。
 *
 * @returns {Promise<string|null>} null = 已应答/已中止，调用方必须直接返回
 */
export function readBody(req, res, { maxBytes = DEFAULT_MAX_BODY_BYTES, onOversize, graceMs = OVERSIZE_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    let received = 0
    let oversize = false
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const answerOversize = () => {
      if (done) return
      try { onOversize?.(res, maxBytes) } catch (err) {
        process.stderr.write(`[dsh-tap] oversize responder failed: ${err?.message ?? err}\n`)
      }
      finish(null)
    }
    req.on('data', (chunk) => {
      if (done) return
      if (oversize) return // 排空：不再缓冲，也不再计数
      chunks.push(chunk)
      received += chunk.length
      if (received > maxBytes) {
        oversize = true
        chunks.length = 0
        const timer = setTimeout(() => {
          answerOversize()
          try { req.destroy?.() } catch { /* 已断 */ }
        }, graceMs)
        timer.unref?.()
        const settle = () => {
          clearTimeout(timer)
          answerOversize()
        }
        req.once('end', settle)
        req.once('aborted', settle)
        req.once('error', settle)
      }
    })
    req.on('end', () => {
      if (done || oversize) return
      finish(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('aborted', () => finish(null))
    req.on('error', () => finish(null))
  })
}

/** 413 应答（三网关统一形态）：Connection: close 因为未消费的上传余量不能进 keep-alive。 */
function respondOversize(res, limit) {
  sendError(
    res,
    413,
    { message: `request body too large (limit ${limit} bytes)`, code: 'body_too_large' },
    { Connection: 'close' },
  )
}

/**
 * 本机回环服务器工厂。
 *
 * @param {{
 *   runtime?: { running: boolean, port: number|null, lastError: string|null }|null,
 *   logPrefix?: string,
 *   label?: string,                  // stderr 里的面名：'bridge' / 'gateway'
 *   unavailableNote?: string,        // stderr 尾注（各通道自述影响面）
 *   maxBodyBytes?: number,
 *   routes?: Record<string, Function>|null,  // 'METHOD /path' → handler(req,res,body,path)
 *   onRequest?: Function|null,       // 兜底处理器（桥的"全路径转发"形态）
 * }} options
 * @returns {{ listen: (port: number) => (() => Promise<void>) }}
 */
export function createLoopbackServer({
  runtime = null,
  logPrefix = '[dsh-tap]',
  label = 'gateway',
  unavailableNote = '',
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  routes = null,
  onRequest = null,
} = {}) {
  const handlerFor = (port) => (req, res) => {
    // 门在**读 body 之前**：拒绝面不消耗上传带宽，也不让凭证面看到任何字节。
    // 先 resume 排空再应答——客户端可能还在传，不排空会让 403 与上传互撞。
    const refusal = localGuardFailure(req)
    if (refusal) {
      req.resume()
      sendError(res, 403, { message: GUARD_REFUSAL_MESSAGE, code: 'forbidden' })
      return
    }
    void readBody(req, res, { maxBytes: maxBodyBytes, onOversize: respondOversize }).then((body) => {
      if (body === null) return // 已应答（413）或客户端已中止
      const path = req.url?.split('?')[0] ?? ''
      const run = routes ? routes[`${req.method} ${path}`] : onRequest
      if (typeof run !== 'function') {
        sendError(res, 404, { message: `no route: ${req.method} ${path}`, code: 'not_found' })
        return
      }
      let out
      try {
        out = run(req, res, body, path)
      } catch (err) {
        failInternal(res, err, `${label} handler error`)
        return
      }
      if (out && typeof out.catch === 'function') {
        out.catch((err) => failInternal(res, err, `${label} handler error`))
      }
    })
  }

  return {
    /**
     * @param {number} port
     * @returns {() => Promise<void>} stop 函数（关服务 + 收连接）
     */
    listen(port) {
      const server = createServer(handlerFor(port))
      // listen 失败绝不能打死宿主：未处理的 'error' 事件会直接掀翻进程。
      // 失败只落 runtime.lastError（EADDRINUSE 通常意味着另一个实例还占着
      // 端口并在正常服务——路由指向端口，不指向进程）。
      server.on('error', (err) => {
        const reason = err?.code ?? describeError(err, { fallback: 'listen failed' }).message
        if (runtime) {
          runtime.running = false
          runtime.lastError = reason
        }
        process.stderr.write(`${logPrefix} ${label} :${port} unavailable: ${reason}${unavailableNote}\n`)
      })
      server.on('listening', () => {
        if (!runtime) return
        // port:0（临时端口，测试/共存用）时回填实际端口——旧实现里桥没回填，
        // runtime.port 恒为 0，卡片的端口显示与重试语义都读不到真值。
        runtime.port = server.address()?.port ?? port
        runtime.running = true
        runtime.lastError = null
      })
      server.listen(port, '127.0.0.1')
      return () =>
        new Promise((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        })
    },
  }
}

/**
 * 两个翻译网关共用的 OpenAI 兼容路由表（形状与改造前逐字一致）。
 *
 * @param {{ handleChat: Function, modelIds: () => string[] }} deps
 */
export function openAICompatRoutes({ handleChat, modelIds }) {
  const listModels = (req, res) => {
    const ids = modelIds() ?? []
    sendJSON(res, 200, {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000) })),
    })
  }
  return {
    'POST /v1/chat/completions': handleChat,
    'POST /chat/completions': handleChat,
    'GET /v1/models': listModels,
    'GET /models': listModels,
  }
}

/**
 * 通道监听生命周期：enabled/port 变化时起停服务器，并守住三条既有语义。
 *
 * 1. 禁用 ⇒ 停服务 + 清 runtime + `onDisabled()`（撤镜像；写宿主层会触发
 *    profile 重载，所以 `retry()` 在禁用时**不**调用它，踩坑 #44）。
 * 2. 启用且同端口无 lastError ⇒ 早退（幂等，设置保存不该反复重启网关）。
 * 3. **wedge 自愈**：lastError 置位说明其实没在听（EADDRINUSE 竞态 / 前一次
 *    stop 未生效）⇒ 不早退，重新 listen——这正是"重试监听"的语义本体。
 *
 * @param {{
 *   runtime: { running: boolean, port: number|null, lastError: string|null },
 *   listen: (port: number) => (() => Promise<void>),
 *   stateOf: () => { enabled: boolean, port: number },
 *   onDisabled?: () => void,
 *   onStarted?: () => void,
 * }} deps
 */
export function createChannelRuntime({ runtime, listen, stateOf, onDisabled = null, onStarted = null }) {
  let stopFn = null
  let runningPort = null

  const stopNow = () => {
    if (stopFn) {
      const fn = stopFn
      stopFn = null
      try { Promise.resolve(fn()).catch(() => {}) } catch { /* 已关 */ }
    }
    runningPort = null
  }

  const sync = () => {
    const state = stateOf() ?? {}
    if (state.enabled !== true) {
      stopNow()
      if (runtime) {
        runtime.running = false
        runtime.port = null
        runtime.lastError = null
      }
      try { onDisabled?.() } catch (err) {
        process.stderr.write(`[dsh-tap] channel onDisabled failed: ${describeError(err).message}\n`)
      }
      return
    }
    const port = state.port
    if (stopFn && runningPort === port && !(runtime && runtime.lastError)) return
    stopNow()
    runningPort = port
    if (runtime) {
      runtime.running = false
      runtime.port = port
      runtime.lastError = null
    }
    stopFn = listen(port)
    // 目录同步是 fire-and-forget：失败只影响镜像新鲜度，不能把监听带倒；
    // 也不许留未处理拒绝（旧实现里一家有 catch、一家没有）。
    try {
      const out = onStarted?.()
      if (out && typeof out.catch === 'function') out.catch(() => {})
    } catch { /* 同上 */ }
  }

  return {
    sync,
    /** @returns {boolean} false = 该通道未启用，什么都没做（调用方据此回 retried:false） */
    retry() {
      if (stateOf()?.enabled !== true) return false
      sync()
      return true
    },
    stop: stopNow,
    /** 实际生效端口（测试与共存诊断用） */
    port: () => runningPort,
  }
}
