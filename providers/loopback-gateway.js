/**
 * providers/loopback-gateway.js — 订阅型通道（TraeWork CN / Qoder CN）共用的
 * 「回环 OpenAI 兼容网关」骨架。
 *
 * 两条通道的网关此前各自内联了同一份 ~65 行服务器代码，逐字节同形：Host 门 +
 * Origin 门 → 缓冲收体（超限 413）→ POST /chat/completions 交翻译层 / GET
 * /models 出目录 / 其余 404 → listen 失败落 runtime.lastError 绝不崩宿主 →
 * stop 关连接。差异只有三处：模型清单来源、stderr 的「哪个分区」尾注、以及
 * 翻译层入口本身。抽到一处，**安全门只有一份实现**——踩坑 #63（同类防护跨子面
 * 成对审计，单侧覆盖断点即缺陷）在这类复制粘贴的门口最容易被咬到。
 *
 * 安全语义（逐条与抽取前一致，改动即改协议面）：
 *   - Host 门：回环端口本机任意进程/页面都能连，Host 白名单把表面收紧到回环
 *     主机名（防 DNS rebinding 把公网域名解析到 127.0.0.1）。
 *   - Origin 门：浏览器跨站请求（含 sendBeacon 的 text/plain 免预检形态）恒带
 *     Origin，其 host:port 必须与 Host 一致，否则即借浏览器烧额度。**无 Origin
 *     放行**：本机 fetch/curl 与剥 Origin 的壳转发都不带该头，Host 门仍把守回环。
 *   - 收体一次解码（踩坑 #28）：逐分片隐式 utf8 解码会把跨分片多字节字符损坏成
 *     3×U+FFFD，译文上行带乱码。超上限（默认 32MiB）答 413 且 Connection: close，
 *     不静默 reset——调用方要拿到真实状态码，而未帧完的上传体不能污染 keep-alive。
 *
 * 协议面（2026-10-18 新增，复用而非重写）：同一份骨架上再挂两个**本机客户端
 * 协议面**——`POST /v1/messages`（Anthropic Messages）与 `POST /v1/responses`
 * （OpenAI Responses）。两者都不新起服务器、不重写上游流水线：请求翻译成内部
 * OpenAI chat payload 后经 `providers/protocols/chat-capture.js` 驱动**同一个
 * `handleChat`**（凭据收口/并发闸/首字节护栏/tool 配对体检/计量/取证全部原样
 * 复用），内部 SSE 再翻译回各自协议的事件序列。Host/Origin 双门、收体上限、
 * 413 对这些面同样生效（同一条前置分支）。装配在
 * `providers/protocols/index.js`——与 CodeBuddy 桥（core/bridge.js，:3901）
 * 挂的是**同一份**（全仓唯一一份，踩坑 #63）。
 */

import { createServer } from 'node:http'

import { hostIsLoopback, originMatchesHost } from '../core/net-guards.js'
import { invokeInternalChat } from './protocols/chat-capture.js'
import { createProtocolSurfaces } from './protocols/index.js'

/** 入站请求体上限；超过即答 413（与 core/bridge.js 同 32MiB 口径）。 */
const BODY_LIMIT_BYTES = 32 * 1024 * 1024

/**
 * 建一个回环网关服务器（尚未 listen）。
 *
 * @param {object} deps
 * @param {{ running: boolean, port: number|null, lastError: string|null }} deps.runtime
 *   生命周期镜像，设置卡按它显示网关状态。
 * @param {string} deps.logPrefix stderr 前缀，如 '[dsh-tap/trae]'。
 * @param {string} deps.unavailableNote 监听失败尾注，如 '（Trae 分区其余功能不受影响）'。
 * @param {() => string[]} deps.listModelIds GET /models 的模型 id 清单。
 * @param {(req, res, rawBody) => Promise<void>} deps.handleChat 翻译层入口。
 * @param {number} [deps.bodyLimitBytes] 入站请求体上限（默认 32MiB）——可注入
 *   只为让回归能在毫秒级、零 RST 风险的体量上锁住超限分支。
 * @returns {{ listen: (port: number) => () => Promise<void> }}
 */
export function createLoopbackGateway({
  runtime, logPrefix, unavailableNote, listModelIds, handleChat, bodyLimitBytes = BODY_LIMIT_BYTES,
}) {
  // 协议面：两个本机客户端协议面共用本通道的 handleChat（见文件头「协议面」节）。
  // 装配在 providers/protocols/index.js —— 全仓唯一一份，CodeBuddy 桥
  // （core/bridge.js）挂的是同一份，不是复制品（踩坑 #63 成对审计）。
  // 未实现字段/事件的如实披露走 stderr（不静默丢弃，踩坑 #7 同族）。
  const note = (message) => { process.stderr.write(`${logPrefix} protocols: ${message}\n`) }
  const invokeChat = (req, res, chatPayload, sink) => invokeInternalChat({ handleChat, req, res, chatPayload, sink })
  const surfaces = createProtocolSurfaces({ invokeChat, note })

  function listen(port) {
    const server = createServer((req, res) => {
      // Host 门 + Origin 门：Host 必须回环（防 DNS rebinding / LAN 直连），
      // 带 Origin 时其 host:port 必须与 Host 一致（防跨站借浏览器烧额度）。
      // 先 resume 丢弃未读请求体再应答，保证 403 完整送达后连接正常收尾。
      if (!hostIsLoopback(req.headers.host) || !originMatchesHost(req)) {
        req.resume()
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'forbidden: loopback host + same-origin required' } }))
        return
      }
      // Buffer 收集 + 一次解码（踩坑 #28，同 core/bridge.js）。
      const chunks = []
      let received = 0
      let oversize = false
      req.on('data', (c) => {
        if (oversize) return
        chunks.push(c)
        received += c.length
        if (received > bodyLimitBytes) {
          oversize = true
          chunks.length = 0
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({
            error: { message: `request body too large (limit ${Math.round(bodyLimitBytes / 1048576)}MiB)` },
          }))
        }
      })
      req.on('end', () => {
        if (oversize) return
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const path = req.url?.split('?')[0] ?? ''
        const fail500 = (err) => {
          // 响应必须收尾（半截挂死的连接比 500 更糟）；原因一律带上（踩坑 #7）。
          process.stderr.write(`${logPrefix} protocol surface failed: ${err?.stack ?? err}\n`)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: `protocol surface failed: ${err?.message ?? err}` } }))
            return
          }
          try { res.end() } catch { /* 已断开 */ }
        }
        try {
          if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
            handleChat(req, res, rawBody).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end() } })
            return
          }
          // 协议面（Anthropic Messages / OpenAI Responses）：路由判据由共享装配
          // 持有（`surfaces.paths` 是唯一真源），命中即由协议面自己写响应——
          // 流式 SSE / 非流式 JSON 由请求体 stream 决定。
          if (req.method === 'POST' && surfaces.paths.includes(path)) {
            surfaces.handle(req, res, rawBody).catch(fail500)
            return
          }
          if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              object: 'list',
              data: listModelIds().map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000) })),
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
      runtime.running = false
      runtime.lastError = err?.code ?? String(err?.message ?? err)
      process.stderr.write(`${logPrefix} gateway :${port} unavailable: ${runtime.lastError}${unavailableNote}\n`)
    })
    // 连接级 error 兜底（踩坑 #17 同族：监听失败不崩宿主，此处是连接失败）：
    // 超限应答后响应侧立刻收尾（Connection: close），而调用方可能仍在推上传体
    // ——对端 RST 时连接 socket 会抛**裸** ECONNRESET（无 req/res 归属），http
    // 服务器在连接收尾时又会摘掉自己的 error 监听，事件随即无接收者 → 未处理
    // 异常炸掉整个宿主进程（本轮实测到过，但触发依赖时序，不可按需复现；属该
    // 形状服务器的固有窗口，非本通道特有）。本监听挂在 connection 上且永不摘除：
    // 连接级故障只该终结这条连接。
    server.on('connection', (socket) => { socket.on('error', () => {}) })
    server.on('listening', () => {
      // port=0（临时端口，测试用）时回填实际端口。
      runtime.port = server.address()?.port ?? port
      runtime.running = true
      runtime.lastError = null
    })
    server.listen(port, '127.0.0.1')
    return () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { listen }
}
