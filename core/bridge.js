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
 * Cancellation is generic and lives here, not in any adapter: a caller that
 * disconnects mid-request aborts the upstream fetch / SSE read (one
 * AbortController per inbound request), a waiter still queued in the
 * SessionLimiter is dropped without ever being sent upstream, and the
 * per-session slot is released on every exit path. An outbound first-byte
 * guard (`settings().upstreamFirstByteTimeoutMs`, default 45 s) bounds the
 * "connection accepted, headers never arrive" hang; it only covers the time
 * until response headers — a long SSE stream is never cut by it.
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

/** True when the Host header (may carry a port) names the loopback. */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || !host) return false
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname)
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
 */
export class SessionLimiter {
  constructor() {
    this.inflight = new Map()
    this.queues = new Map()
  }
  /**
   * @param {string|null} id session id (null = ungated)
   * @param {number} limit max in-flight per id
   * @param {AbortSignal} [signal] optional caller-side cancellation: a waiter
   *   whose signal aborts while queued is removed from the queue and the
   *   promise rejects with `signal.reason` — it never inherits a slot, so a
   *   disconnected caller can never be "woken up" and sent upstream later.
   */
  acquire(id, limit, signal) {
    if (id === null) return Promise.resolve(() => {})
    if (signal?.aborted) return Promise.reject(signal.reason)
    const running = this.inflight.get(id) ?? 0
    if (running < limit) {
      this.inflight.set(id, running + 1)
      return Promise.resolve(() => this.release(id))
    }
    return new Promise((resolve, reject) => {
      const q = this.queues.get(id) ?? []
      const onAbort = () => {
        const idx = q.indexOf(waiter)
        if (idx >= 0) q.splice(idx, 1)
        if (q.length === 0 && this.queues.get(id) === q) this.queues.delete(id)
        reject(signal.reason)
      }
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(() => this.release(id))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      q.push(waiter)
      this.queues.set(id, q)
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
// Inbound limits / cancellation helpers
// ---------------------------------------------------------------------------

/** Inbound body cap: a larger request is answered 413 (never silently
 * destroyed — the caller must see why it got nothing). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024

/** Default outbound first-byte guard when the setting is absent/invalid. */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 45_000

/** Abort reason for the first-byte guard. `name` is deliberately NOT
 * 'AbortError' (that name means "the caller went away" to the credential
 * runner — no cooldown, no failover); a hang is a network-layer failure of
 * this candidate and may fail over like any other. */
function firstByteTimeoutError(ms) {
  const err = new Error(`upstream sent no response headers within ${ms}ms (first-byte timeout)`)
  err.name = 'TimeoutError'
  err.firstByteTimeout = true
  return err
}

/** True when `err` is the caller-side abort (the inbound signal fired). */
function isInboundAbort(err, signal) {
  return signal.aborted && (err === signal.reason || err?.name === 'AbortError')
}

/**
 * Write one chunk to the client; when the socket is back-pressured wait for
 * 'drain' — but never past the client going away (a plain `once('drain')`
 * on a destroyed response never fires and would pin the session slot).
 */
function writeToClient(res, value, signal) {
  if (res.write(value)) return Promise.resolve()
  if (res.destroyed || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
    signal.addEventListener('abort', done, { once: true })
  })
}

// ---------------------------------------------------------------------------
// The bridge factory
// ---------------------------------------------------------------------------

/**
 * @param {() => object} settings live-resolved settings (needs baseURL,
 *   sessionHeadersEnabled, sessionHeaderFormat, maxConcurrentPerSession;
 *   optional upstreamFirstByteTimeoutMs, default 45 000)
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
  async function aggregateChatCompletion(upstream, res, model, tap = null, signal = null) {
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
      // A caller-side abort surfaces here as a rejected read (the fetch
      // carries the inbound signal); it propagates to proxyUpstream, which
      // classifies it — nothing is written to a client that is gone.
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw signal.reason
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
        // The last usage object the stream carried (the tap the caller
        // meters with) — classic non-streaming callers read it from here.
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
  async function proxyUpstream(req, res, rawBody, inbound) {
    const s = settings()
    const signal = inbound.signal
    const isChat = req.url?.endsWith('/chat/completions') === true
    const logId = forensics.logPath() ? ++logSeq : 0
    const t0 = Date.now()

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

    // Concurrency gate only applies to chat (LLM calls). A caller that
    // disconnects while queued is dropped here (rejects with the abort
    // reason) — it never takes a slot and is never sent upstream.
    let release = () => {}
    if (isChat) {
      try {
        release = await limiter.acquire(sessionId, s.maxConcurrentPerSession, signal)
      } catch (err) {
        logOut({ err: 'client disconnected while queued', queuedMs: Date.now() - t0 })
        return
      }
    }
    const waitMs = Date.now() - t0
    // Header names the current credential candidate contributed; removed
    // before the next attempt so a stale identity header from a prior
    // candidate never leaks across failovers.
    let credHeaderNames = []
    const firstByteMs = Number(s.upstreamFirstByteTimeoutMs) > 0
      ? Number(s.upstreamFirstByteTimeoutMs)
      : DEFAULT_FIRST_BYTE_TIMEOUT_MS
    try {
      if (signal.aborted) throw signal.reason
      const { cred, res: upstream0, err } = await withCredentials((c) => {
        outHeaders.Authorization = c.authorization
        for (const name of credHeaderNames) delete outHeaders[name]
        credHeaderNames = Object.keys(c.headers ?? {})
        Object.assign(outHeaders, c.headers)
        // Per-attempt signal: the inbound abort (client gone) plus a
        // first-byte guard that only runs until response headers arrive —
        // fetch resolves on headers, so the timer is cleared before any
        // SSE body streaming and a long stream is never cut by it.
        const attempt = new AbortController()
        const onInbound = () => attempt.abort(signal.reason)
        if (signal.aborted) onInbound()
        else signal.addEventListener('abort', onInbound, { once: true })
        const timer = setTimeout(() => attempt.abort(firstByteTimeoutError(firstByteMs)), firstByteMs)
        return fetch(`${s.baseURL}${req.url}`, {
          method: req.method,
          headers: outHeaders,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          signal: attempt.signal,
        }).finally(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onInbound)
          // Keep the inbound abort wired to the response body for the
          // stream phase: aborting the fetch controller after headers
          // cancels the body reader (rejects the pending read upstream).
          if (!signal.aborted) signal.addEventListener('abort', onInbound, { once: true })
        })
      })
      if (isInboundAbort(err, signal)) {
        logOut({ waitMs, err: 'client disconnected before upstream responded' })
        return
      }
      if (!cred || err) {
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
        await aggregateChatCompletion(upstream, res, payload.model, tap, signal)
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
        // Client gone → the inbound signal already aborted the upstream
        // fetch, so this read rejects with the abort reason (classified in
        // the catch below); the upstream socket is released, not drained.
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted) throw signal.reason
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
        await writeToClient(res, value, signal)
      }
      res.end()
      if (usage && isChat && payload) {
        meter.record({ ts: t0, kind: chatUsageKind(payload), model: payload.model ?? null, usage })
      }
      logOut({ status: upstream.status, waitMs, ttfbMs, usage })
    } catch (err) {
      if (isInboundAbort(err, signal)) {
        // Caller went away mid-flight: upstream aborted, nothing to answer.
        logOut({ waitMs, err: 'client disconnected mid-stream', aborted: true })
        return
      }
      logOut({ err: String(err?.message ?? err) })
      throw err
    } finally {
      // Every exit path — normal end, upstream error, client abort, first-
      // byte timeout — frees the per-session slot exactly once.
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
      // the body or dispatching anywhere.
      if (!hostIsLoopback(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bridge: loopback-only (Host must be 127.0.0.1/localhost/::1)')
        return
      }
      // Bytes must be collected and decoded ONCE (踩坑 #28): implicit
      // per-chunk utf8 decoding (`rawBody += c`) corrupts any multibyte
      // character straddling a TCP chunk boundary into 3×U+FFFD at a
      // per-request random position — the outbound prefix drifts and the
      // gateway's content-addressed prompt cache can only hit up to the
      // corruption point.
      // One controller per inbound request: the client disconnecting
      // (socket closed before the response finished) aborts everything
      // downstream — queued waiter, upstream fetch, SSE read loop.
      const inbound = new AbortController()
      const abortReason = () => {
        const err = new Error('client disconnected')
        err.name = 'AbortError'
        return err
      }
      res.on('close', () => {
        if (!res.writableFinished && !inbound.signal.aborted) inbound.abort(abortReason())
      })
      const chunks = []
      let received = 0
      let tooLarge = false
      req.on('data', (c) => {
        if (tooLarge) return
        chunks.push(c)
        received += c.length
        if (received > MAX_REQUEST_BODY_BYTES) {
          // Answer 413 instead of a bare socket reset: the caller sees WHY.
          // The remaining upload is discarded (data listener stays attached
          // so the stream keeps flowing); Connection: close ends it early.
          tooLarge = true
          chunks.length = 0
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ error: { message: `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`, type: 'payload_too_large' } }))
        }
      })
      req.on('error', () => {
        // Client reset mid-upload: 'close' handles the abort; nothing to do.
      })
      req.on('end', () => {
        if (tooLarge) return
        const rawBody = Buffer.concat(chunks).toString('utf8')
        proxyUpstream(req, res, rawBody, inbound).catch((err) => {
          if (res.destroyed) return
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
