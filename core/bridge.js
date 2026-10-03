/**
 * core/bridge.js — provider-agnostic stream bridge: a smart loopback proxy
 * and the single credential owner.
 *
 * The host's LLM route points at this bridge, so the main chat path crosses
 * it too. It passes any request path through to the upstream, and on POST
 * /chat/completions it can (a) inject session-attribution headers from the
 * incoming session id, (b) cap concurrent in-flight requests per session id
 * (excess queue, FIFO), and (c) aggregate the upstream SSE stream into
 * classic non-streaming OpenAI JSON for callers that need it.
 *
 * Generic transport guardrails (no provider specifics involved):
 *   - client hangup (res 'close' before completion) aborts the queued wait,
 *     the upstream fetch and the SSE relay, and frees the limiter slot;
 *   - every upstream attempt carries a first-byte timer
 *     (`settings.upstreamFirstByteTimeoutMs`, default 45s) that fails fast
 *     when the peer connects but never sends response headers — the timer
 *     clears on headers, so long SSE streams are unaffected;
 *   - an inbound body past 32MB is answered 413, not silently destroyed;
 *   - aggregated chat.completion JSON carries the captured usage object.
 *
 * Everything upstream-specific is injected through the `provider` adapter:
 *   bridgeHeaders()          static outbound headers for proxied calls
 *   transformChatPayload(p)  in-place rewrite of a parsed chat payload
 *   extractUsage(chunk)      usage object from a parsed SSE chunk, or null
 *   extractStreamError(chunk)  truthy when a parsed SSE chunk is an error
 *   bridgeResponseId         `id` for aggregated chat.completion JSON
 *   logHeaderNames           header names the forensic log may record
 *   sentinelAuth             the static sentinel Authorization value callers
 *                            use (classified in logs, never logged verbatim)
 *   texts.credentialUnavailable  error text for the no-credential response
 *   logPrefix              stderr prefix for bridge lifecycle warnings
 *
 * Credentials are always resolved host-side through the injected
 * `withCredentials(attempt)` runner (the composition root's rotation);
 * the caller's Authorization is never forwarded.
 *
 * Extracted from index.js during the core/providers split. This file must
 * not mention any concrete upstream by name — that is the falsifiable
 * generality contract (scripts/verify-core-generic.mjs enforces it).
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Loopback Host gate ([8]+[26] hardening): the bridge carries the user's live
// credential, so it must only answer callers that reached it the intended way
// — a same-machine client addressing the loopback bind directly. A non-loopback
// Host header (DNS-rebinding name, LAN-spoofed Host) is refused before any
// body byte is read or proxied.
// ---------------------------------------------------------------------------

/** Hostnames a same-machine caller may present in Host (::1 bare for raw
 * Host values; URL-parsed IPv6 keeps its brackets). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Inbound request-body ceiling; past it the caller gets a real 413. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** True when the Host header (may carry a port) names the loopback. */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || !host) return false
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

/**
 * Origin gate: a browser cross-site request (including a no-preflight
 * `navigator.sendBeacon` with a text/plain body) always carries Origin — its
 * host:port must equal the Host header or the request is a drive-by CSRF that
 * would burn the user's upstream quota. A missing Origin passes: same-machine
 * fetch/curl and shell-forwarded in-app requests carry no Origin; the Host
 * gate above still confines those to loopback. Non-browser clients can forge
 * any Origin anyway, so this gate adds no constraint for them.
 */
export function originMatchesHost(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Session attribution
// ---------------------------------------------------------------------------

const SESSION_HEADER_SETS = {
  openai: ['session_id', 'x-client-request-id', 'x-session-affinity'],
  openrouter: ['x-session-id'],
}

/** Extract the session id from headers or a body hint, in precedence order. */
export function extractSessionId(headers, payload) {
  const candidates = [
    headers['x-conversation-id'],
    headers['x-session-id'],
    headers['session_id'],
    headers['x-client-request-id'],
    headers['x-session-affinity'],
    payload?.conversation_id,
    payload?.session_id,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return null
}

/**
 * Per-session concurrency governor: per-id in-flight counters with FIFO
 * waiting queues. acquire() resolves once this call may proceed.
 *
 * An optional AbortSignal covers the queued wait: when it fires while the
 * call is still waiting, the waiter is removed from the queue and the
 * promise rejects with signal.reason — a caller that went away must never
 * be woken to fire upstream. A call that already holds its slot is
 * unaffected (its release still comes from the caller's finally).
 */
export class SessionLimiter {
  constructor() {
    this.inflight = new Map()
    this.queues = new Map()
  }
  acquire(id, limit, signal) {
    if (id === null) return Promise.resolve(() => {})
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    const running = this.inflight.get(id) ?? 0
    if (running < limit) {
      this.inflight.set(id, running + 1)
      return Promise.resolve(() => this.release(id))
    }
    return new Promise((resolve, reject) => {
      const q = this.queues.get(id) ?? []
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(() => this.release(id))
      }
      const onAbort = () => {
        const idx = q.indexOf(waiter)
        if (idx >= 0) q.splice(idx, 1)
        if (q.length === 0) this.queues.delete(id)
        reject(signal.reason ?? new Error('aborted'))
      }
      q.push(waiter)
      this.queues.set(id, q)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  release(id) {
    const running = (this.inflight.get(id) ?? 0) - 1
    const q = this.queues.get(id) ?? []
    // One release frees exactly one slot; hand it to the oldest waiter.
    // The woken call inherits the slot, so the in-flight count is restored
    // BEFORE its callback runs (it will release again when done).
    const next = q.shift()
    if (next !== undefined) {
      this.inflight.set(id, running + 1)
      next()
    } else if (running <= 0) {
      this.inflight.delete(id)
    } else {
      this.inflight.set(id, running)
    }
    if (q.length === 0) this.queues.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Request forensics (opt-in) + payload classification helpers
// ---------------------------------------------------------------------------

const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Pick the whitelisted headers worth recording; authorization is classified. */
function pickLogHeaders(headers, logHeaderNames, sentinelAuth) {
  const out = {}
  for (const name of logHeaderNames) {
    const value = headers[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  const auth = headers.authorization
  if (typeof auth === 'string' && auth.length > 0) {
    out.authorization = auth === sentinelAuth ? 'sentinel' : 'caller-set'
  }
  return out
}

/** Text of one chat message, whether content is a string or typed parts. */
function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
}

/**
 * Classify a chat payload by its prompt shape — the host's auxiliary LLM
 * calls (session title, compaction) reuse the main route and are
 * recognizable only by their prompt text (verified against the host's
 * session-title / compaction sources). Host-specific, upstream-agnostic.
 */
function detectPayloadMarker(messages) {
  const first = messages[0]
  if (first?.role === 'system'
    && messageText(first).startsWith('Create a concise title for an AI coding-assistant session')) {
    return 'session-title'
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    if (messageText(messages[i]).startsWith('You are now acting as a compaction engine')) {
      return 'compaction'
    }
    break
  }
  return null
}

/** Metering kind for a parsed chat payload: the host's auxiliary calls
 * (title, compaction) get their own kinds so the usage view can tell them
 * apart. */
function chatUsageKind(payload) {
  const marker = detectPayloadMarker(Array.isArray(payload?.messages) ? payload.messages : [])
  return marker === 'session-title' ? 'title' : marker === 'compaction' ? 'compaction' : 'chat'
}

/** Hash-and-shape summary of a parsed chat payload (no message text logged). */
function summarizeChatPayload(rawBody, payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const sysText = messages[0]?.role === 'system' ? messageText(messages[0]) : ''
  let lastUserText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserText = messageText(messages[i])
      break
    }
  }
  return {
    model: typeof payload.model === 'string' ? payload.model : null,
    stream: payload.stream === true,
    msgs: messages.length,
    bytes: rawBody.length,
    bodySha: sha16(rawBody),
    msgsSha: sha16(JSON.stringify(payload.messages ?? null)),
    sysSha: sysText.length > 0 ? sha16(sysText) : null,
    sysBytes: sysText.length,
    lastUserSha: lastUserText.length > 0 ? sha16(lastUserText) : null,
    lastUserPreview: lastUserText.replace(/\s+/g, ' ').slice(0, 60),
    marker: detectPayloadMarker(messages),
    maxTokens: payload.max_tokens ?? payload.max_completion_tokens ?? null,
    reasoningEffort: payload.reasoning_effort ?? null,
    tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
    promptCacheKey: typeof payload.prompt_cache_key === 'string' ? payload.prompt_cache_key : null,
  }
}

// ---------------------------------------------------------------------------
// The bridge factory
// ---------------------------------------------------------------------------

/**
 * @param {() => object} settings live-resolved settings (needs baseURL,
 *   sessionHeadersEnabled, sessionHeaderFormat, maxConcurrentPerSession;
 *   upstreamFirstByteTimeoutMs optional, default 45000)
 * @param {object} provider upstream adapter (hooks listed at the top)
 * @param {(attempt: (cred: object) => Promise<Response>) => Promise<{cred: object|null, res: Response|null, err: Error|null}>} withCredentials
 *   credential-owning runner from the composition root
 * @param {{ record: Function }} meter usage meter (core/usage-meter)
 * @param {{ logPath: () => string|undefined, dumpDir: () => string|undefined }} forensics
 *   opt-in forensic sinks; payload text is never logged — only hashes and a
 *   short preview. The dump sink writes inbound chat bodies verbatim
 *   (local-only, opt-in). Diagnostics must never break the bridge.
 * @param {{ running: boolean, port: number|null, lastError: string|null }} runtime
 *   shared runtime-state object mutated by listen() (owned by the
 *   composition root so several apply() generations report one reality).
 */
export function createBridge({ settings, provider, withCredentials, meter, forensics, runtime }) {
  const limiter = new SessionLimiter()
  let logSeq = 0
  let dumpSeq = 0

  function bridgeLog(record) {
    const path = forensics.logPath()
    if (!path) return
    try {
      appendFileSync(path, JSON.stringify(record) + '\n')
    } catch {
      // logging is best-effort
    }
  }

  /** Full-body dump for cache/prompt forensics: plaintext by design —
   * local-only, opt-in. */
  function bridgeDump(rawBody) {
    const dir = forensics.dumpDir()
    if (!dir) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `req-${String(++dumpSeq).padStart(4, '0')}-${Date.now()}.json`), rawBody)
    } catch {
      // dump is best-effort
    }
  }

  /**
   * Aggregate one streamed upstream chat completion into a classic
   * chat.completion JSON for non-streaming callers. The bridge always
   * speaks SSE upstream and translates back here.
   */
  async function aggregateChatCompletion(upstream, res, model, tap = null) {
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '')
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      res.end(errBody)
      return
    }
    let content = ''
    let finishReason = null
    let buf = ''
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          const usage = provider.extractUsage(chunk)
          if (tap && usage) tap.usage = usage
          if (provider.extractStreamError(chunk)) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(data)
            return
          }
          const choice = chunk.choices?.[0]
          if (choice?.delta?.content) content += choice.delta.content
          if (choice?.finish_reason) finishReason = choice.finish_reason
        } catch {
          // incomplete JSON inside a complete SSE line — skip
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: provider.bridgeResponseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: finishReason ?? 'stop',
          },
        ],
        // The caller asked for classic JSON — give it the usage the stream
        // carried ({} only when the upstream truly sent none).
        usage: tap?.usage ?? {},
      }),
    )
  }

  /**
   * Proxy one request upstream. Passes through non-chat paths verbatim; on
   * POST /chat/completions injects session headers (from the incoming
   * session id, unless the caller already set one) and gates per-session
   * concurrency. Inbound stream:true gets the SSE passed through; anything
   * else (classic non-streaming callers) gets the stream aggregated into a
   * chat.completion JSON.
   */
  async function proxyUpstream(req, res, rawBody) {
    const s = settings()
    const isChat = req.url?.endsWith('/chat/completions') === true
    const logId = forensics.logPath() ? ++logSeq : 0
    const t0 = Date.now()

    // Client-disconnect propagation: when the caller goes away before the
    // response completed, abort everything downstream — the queued wait, the
    // upstream fetch, and the SSE relay — and free the limiter slot (finally
    // below). The signal is res 'close' with writableEnded === false: since
    // Node 16, req 'close' fires on EVERY fully-received request body, so it
    // cannot tell a hangup from a normal request; res 'close' can.
    // Abort reasons carry name 'AbortError' so the rotation engine treats
    // them as caller-side (no cooldown, no failover to the next key).
    const clientAbort = new AbortController()
    const onClientClose = () => {
      if (res.writableEnded) return
      const err = new Error('client disconnected')
      err.name = 'AbortError'
      err.clientDisconnected = true
      clientAbort.abort(err)
    }
    res.on('close', onClientClose)

    // Parse the body only for chat (the session hint may live there); other
    // paths pass the bytes through untouched.
    let payload = null
    if (isChat && rawBody.length > 0) {
      try { payload = JSON.parse(rawBody) } catch { payload = null }
    }

    const sessionId = isChat ? extractSessionId(req.headers, payload) : null
    if (logId) {
      bridgeLog({
        seq: logId,
        dir: 'in',
        ts: t0,
        method: req.method,
        path: req.url,
        hdr: pickLogHeaders(req.headers, provider.logHeaderNames, provider.sentinelAuth),
        chat: payload ? summarizeChatPayload(rawBody, payload) : null,
        bytes: payload ? undefined : rawBody.length,
        bodySha: payload ? undefined : sha16(rawBody),
        sessionIn: sessionId,
      })
    }
    if (isChat && payload !== null) bridgeDump(rawBody)
    const outHeaders = {
      'Content-Type': 'application/json',
      ...provider.bridgeHeaders(),
    }
    // Session attribution: per header, a value the caller already set wins;
    // missing headers are filled with the extracted session id. (The bridge
    // rebuilds the header set from scratch — an all-or-nothing "preserve"
    // would silently DROP the caller's headers instead of forwarding them.)
    const sessionOut = {}
    if (isChat && s.sessionHeadersEnabled === true && sessionId !== null) {
      const names = SESSION_HEADER_SETS[s.sessionHeaderFormat] ?? SESSION_HEADER_SETS.openai
      for (const name of names) {
        const existing = req.headers[name]
        outHeaders[name] = typeof existing === 'string' && existing.length > 0 ? existing : sessionId
        sessionOut[name] = outHeaders[name]
      }
    }

    let body = rawBody
    // Only an explicit stream:true passes SSE through; classic non-streaming
    // callers (stream:false or absent — the OpenAI default) get aggregation,
    // which requires speaking SSE upstream regardless of the inbound flag.
    const aggregate = isChat && payload !== null && payload.stream !== true
    if (isChat && payload !== null) {
      payload.stream = true
      // Adapter hook: upstream-specific payload normalization (e.g. role
      // rewrites the upstream's entry layer demands). Runs on the way out,
      // after the stream flag is forced, before re-serialization.
      provider.transformChatPayload(payload)
      body = JSON.stringify(payload)
    }

    /** Outcome record shared by every exit path below. */
    const logOut = (extra) => {
      if (!logId) return
      bridgeLog({
        seq: logId,
        dir: 'out',
        ts: Date.now(),
        ms: Date.now() - t0,
        ...(Object.keys(sessionOut).length > 0 ? { sessionOut } : {}),
        ...extra,
      })
    }

    // Concurrency gate only applies to chat (LLM calls). A caller that hangs
    // up while queued rejects out of the wait and never reaches the upstream.
    let release
    try {
      release = isChat ? await limiter.acquire(sessionId, s.maxConcurrentPerSession, clientAbort.signal) : () => {}
    } catch {
      logOut({ waitMs: Date.now() - t0, clientGone: true })
      return
    }
    if (clientAbort.signal.aborted) {
      // Woken in the same tick the caller disconnected: hand the slot back.
      release()
      logOut({ waitMs: Date.now() - t0, clientGone: true })
      return
    }
    const waitMs = Date.now() - t0
    // Header names the current credential candidate contributed; removed
    // before the next attempt so a stale identity header from a prior
    // candidate never leaks across failovers.
    let credHeaderNames = []
    try {
      // First-byte guardrail: if the upstream connects but never sends
      // response headers, fail fast instead of hanging the caller forever.
      // The timer clears the moment headers arrive (fetch resolves), so a
      // long SSE stream is unaffected. Per attempt, so a failover retry gets
      // its own window.
      const firstByteMs = Number(s.upstreamFirstByteTimeoutMs) > 0 ? Number(s.upstreamFirstByteTimeoutMs) : 45_000
      const { cred, res: upstream0, err } = await withCredentials((c) => {
        outHeaders.Authorization = c.authorization
        for (const name of credHeaderNames) delete outHeaders[name]
        credHeaderNames = Object.keys(c.headers ?? {})
        Object.assign(outHeaders, c.headers)
        const attemptAbort = new AbortController()
        const firstByteTimer = setTimeout(() => {
          const err = new Error(`upstream sent no response headers within ${firstByteMs}ms (first-byte timeout)`)
          err.name = 'AbortError'
          err.firstByteTimeout = true
          attemptAbort.abort(err)
        }, firstByteMs)
        return fetch(`${s.baseURL}${req.url}`, {
          method: req.method,
          headers: outHeaders,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          signal: AbortSignal.any([clientAbort.signal, attemptAbort.signal]),
        }).finally(() => clearTimeout(firstByteTimer))
      })
      if (!cred || err) {
        if (err?.clientDisconnected === true) {
          // The caller hung up mid-handshake — nobody left to answer.
          logOut({ waitMs, clientGone: true })
          return
        }
        // No credential at all (503) or every candidate failed at the network
        // layer (502) — the caller gets a classic JSON error either way. The
        // composition root flags its empty-candidate error with
        // `credentialUnavailable` so the bridge needs no provider strings.
        const isCred = err?.credentialUnavailable === true
        const status = isCred ? 503 : 502
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: isCred ? provider.texts.credentialUnavailable : `upstream unreachable: ${err?.message ?? 'unknown'}` } }))
        logOut({ status, waitMs, err: err?.message ?? 'credential unavailable' })
        return
      }
      const upstream = upstream0
      const ttfbMs = Date.now() - t0
      if (aggregate) {
        const tap = { usage: null }
        await aggregateChatCompletion(upstream, res, payload.model, tap)
        if (tap.usage) meter.record({ ts: t0, kind: chatUsageKind(payload), model: payload.model ?? null, usage: tap.usage })
        logOut({ status: upstream.status, waitMs, ttfbMs, aggregated: true, usage: tap?.usage ?? null, keyName: cred.keyName ?? undefined })
        return
      }
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
      if (upstream.body === null) {
        res.end()
        logOut({ status: upstream.status, waitMs, ttfbMs })
        return
      }
      // Tee chat SSE bytes through a line scanner that keeps the last usage
      // object (the upstream may repeat usage on every chunk). Always on for
      // chat: the usage meter feeds the settings card; the forensic log
      // reuses the same scan when enabled.
      const reader = upstream.body.getReader()
      const decoder = isChat ? new TextDecoder() : null
      let scanBuf = ''
      let usage = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (decoder) {
          scanBuf += decoder.decode(value, { stream: true })
          let nl
          while ((nl = scanBuf.indexOf('\n')) >= 0) {
            const line = scanBuf.slice(0, nl).trim()
            scanBuf = scanBuf.slice(nl + 1)
            if (!line.startsWith('data:') || !line.includes('"usage"')) continue
            try {
              const chunk = JSON.parse(line.slice(5).trim())
              const u = provider.extractUsage(chunk)
              if (u) usage = u
            } catch {
              // incomplete JSON inside a complete SSE line — skip
            }
          }
        }
        if (!res.write(value)) {
          // Backpressure wait — but a hangup never drains; close wins the
          // race and the aborted check below unwinds the loop instead of
          // hanging on a dead socket (and writing to it).
          await new Promise((resolve) => {
            res.once('drain', resolve)
            res.once('close', resolve)
          })
        }
        if (clientAbort.signal.aborted) throw clientAbort.signal.reason
      }
      res.end()
      if (usage && isChat && payload) {
        meter.record({ ts: t0, kind: chatUsageKind(payload), model: payload.model ?? null, usage })
      }
      logOut({ status: upstream.status, waitMs, ttfbMs, usage })
    } catch (err) {
      if (err?.clientDisconnected === true) {
        // Caller hung up mid-stream: upstream is aborted, the slot frees in
        // the finally, and res is already gone — nothing left to write.
        logOut({ waitMs, clientGone: true })
        return
      }
      logOut({ err: String(err?.message ?? err) })
      throw err
    } finally {
      release()
    }
  }

  /**
   * Listen on 127.0.0.1 only. A listen failure must NEVER crash the host:
   * an unhandled 'error' event on the server used to take the whole process
   * down — failures land in runtime.lastError instead (EADDRINUSE typically
   * means another instance already holds the port and still serves traffic,
   * since routes point at the port, not the process).
   *
   * @param {number} port
   * @returns {() => Promise<void>} stop function
   */
  function listen(port) {
    const server = createServer((req, res) => {
      // Host gate ([8]+[26]): the bind is loopback-only, but the Host header
      // is still caller-controlled — a rebinding DNS name or a spoofed Host
      // must not reach the credential-bearing proxy. Refuse before reading
      // the body or dispatching anywhere. The Origin gate complements it: a
      // browser cross-site drive-by (sendBeacon/text-plain, no preflight)
      // reaches the loopback bind with a browser-correct Host, and would
      // silently burn upstream quota unless its Origin is rejected here.
      if (!hostIsLoopback(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bridge: loopback-only (Host must be 127.0.0.1/localhost/::1)')
        return
      }
      if (!originMatchesHost(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bridge: cross-origin refused (Origin must match Host)')
        return
      }
      // Bytes must be collected and decoded ONCE (踩坑 #28): implicit
      // per-chunk utf8 decoding (`rawBody += c`) corrupts any multibyte
      // character straddling a TCP chunk boundary into 3×U+FFFD at a
      // per-request random position — the outbound prefix drifts and the
      // gateway's content-addressed prompt cache can only hit up to the
      // corruption point.
      const chunks = []
      let received = 0
      let oversize = false
      req.on('data', (c) => {
        if (oversize) return // already answered 413; drain and drop the rest
        chunks.push(c)
        received += c.length
        if (received > MAX_BODY_BYTES) {
          oversize = true
          chunks.length = 0
          // Answer, don't destroy: a bare req.destroy() left the caller with
          // a reset connection and no status. Connection: close because the
          // unframed remainder of the upload must not poison keep-alive.
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ error: { message: `request body too large (limit ${MAX_BODY_BYTES} bytes)` } }))
        }
      })
      req.on('end', () => {
        if (oversize) return
        const rawBody = Buffer.concat(chunks).toString('utf8')
        proxyUpstream(req, res, rawBody).catch((err) => {
          if (res.destroyed || res.writableEnded) return // caller already gone
          if (!res.headersSent) res.writeHead(500)
          res.end(`stream bridge error: ${err.message}`)
        })
      })
    })
    server.on('error', (err) => {
      runtime.running = false
      runtime.lastError = err?.code ?? String(err?.message ?? err)
      process.stderr.write(`${provider.logPrefix} bridge :${port} unavailable: ${runtime.lastError}（插件其余功能不受影响；若占用者是另一个 dsh 实例，其桥仍会代管本实例流量）\n`)
    })
    server.on('listening', () => {
      runtime.running = true
      runtime.lastError = null
    })
    server.listen(port, '127.0.0.1')
    return () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
  }

  return { listen }
}
