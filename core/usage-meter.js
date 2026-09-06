/**
 * core/usage-meter.js — provider-agnostic usage metering store.
 *
 * The upstream reports per-request billing on every chat SSE stream; the
 * bridge scans for it ALWAYS and accumulates into a JSON file so a settings
 * card can show live consumption. Tokens/credits only — never message
 * content. Metering must never break the data path: every failure is
 * swallowed, writes debounced.
 *
 * The recorded usage contract is the OpenAI-style SSE usage object plus an
 * optional provider `credit` cost field:
 *   { prompt_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens,
 *     completion_tokens, credit }
 * Providers whose usage objects lack a field simply record 0 for it.
 *
 * Extracted from index.js during the core/providers split. Instance state
 * lives on the meter object (created once per plugin module instance by the
 * composition root) — not on this module.
 */

import { readJson, writeJson } from './json-store.js'

const USAGE_RECENT_CAP = 100
const USAGE_DAYS_CAP = 31
const USAGE_FLUSH_MS = 5000
/** Two requests further apart than this belong to different (approximate) turns. */
const TURN_GAP_MS = 45_000

/** Local-day key (YYYY-MM-DD) — the display groups by the user's day. */
function dayKey(ts) {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function normalizeUsageStore(raw) {
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  store.since = typeof store.since === 'number' ? store.since : Date.now()
  store.totalCredit = typeof store.totalCredit === 'number' ? store.totalCredit : 0
  store.totalRequests = typeof store.totalRequests === 'number' ? store.totalRequests : 0
  store.days = store.days && typeof store.days === 'object' && !Array.isArray(store.days) ? store.days : {}
  store.recent = Array.isArray(store.recent) ? store.recent.slice(-USAGE_RECENT_CAP) : []
  return store
}

const roundCredit = (n) => Math.round(n * 10000) / 10000

/**
 * Group recent requests into approximate turns: entries closer than
 * TURN_GAP_MS merge into one row (a title call lands in the turn that
 * triggered it; tool-loop steps are seconds apart by construction). The
 * bridge cannot see the host's turn boundaries (no session ids on the
 * wire), so this is a disclosed approximation.
 */
function groupTurns(recent) {
  const turns = []
  for (const r of recent) {
    const last = turns[turns.length - 1]
    if (last && r.ts - last.end <= TURN_GAP_MS) {
      last.end = r.ts
      last.requests += 1
      last.credit = roundCredit(last.credit + r.credit)
      last.prompt += r.prompt
      last.hit += r.hit
      last.miss += r.miss
      last.completion += r.completion ?? 0
      if (r.model && !last.models.includes(r.model)) last.models.push(r.model)
      if (!last.kinds.includes(r.kind)) last.kinds.push(r.kind)
    } else {
      turns.push({
        start: r.ts,
        end: r.ts,
        requests: 1,
        credit: r.credit,
        prompt: r.prompt,
        hit: r.hit,
        miss: r.miss,
        completion: r.completion ?? 0,
        models: r.model ? [r.model] : [],
        kinds: [r.kind],
      })
    }
  }
  return turns
}

/**
 * @param {{ path: string }} options persistence target
 * @returns {{ record: Function, view: Function, dispose: Function }}
 */
export function createUsageMeter({ path }) {
  const store = normalizeUsageStore(readJson(path))
  let flushTimer = null

  function flush() {
    try {
      writeJson(path, store)
    } catch {
      // persistence is best-effort
    }
  }

  /** Debounced: a tool-loop burst produces one write, not one per request. */
  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, USAGE_FLUSH_MS)
    flushTimer.unref?.()
  }

  /**
   * Record one billed request. `usage` is the upstream's SSE usage object;
   * only requests that actually produced one are recorded (failed/error
   * responses carry no billing signal).
   * kind: chat | title | compaction | image | search | fetch.
   */
  function record({ ts, kind, model, usage }) {
    if (!usage || typeof usage !== 'object') return
    try {
      const credit = typeof usage.credit === 'number' && Number.isFinite(usage.credit) ? usage.credit : 0
      const entry = {
        ts,
        kind,
        model: typeof model === 'string' ? model : null,
        prompt: usage.prompt_tokens ?? 0,
        hit: usage.prompt_cache_hit_tokens ?? 0,
        miss: usage.prompt_cache_miss_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        credit,
      }
      store.totalCredit = roundCredit(store.totalCredit + credit)
      store.totalRequests += 1
      const day = dayKey(ts)
      const bucket = store.days[day] ?? { credit: 0, requests: 0 }
      bucket.credit = roundCredit(bucket.credit + credit)
      bucket.requests += 1
      store.days[day] = bucket
      const dayKeys = Object.keys(store.days).sort()
      while (dayKeys.length > USAGE_DAYS_CAP) delete store.days[dayKeys.shift()]
      store.recent.push(entry)
      if (store.recent.length > USAGE_RECENT_CAP) {
        store.recent = store.recent.slice(-USAGE_RECENT_CAP)
      }
      scheduleFlush()
    } catch {
      // metering is best-effort
    }
  }

  /** The usage-view payload: totals + approximate turns + exact recent rows. */
  function view() {
    const today = store.days[dayKey(Date.now())] ?? { credit: 0, requests: 0 }
    return {
      since: store.since,
      totalCredit: store.totalCredit,
      totalRequests: store.totalRequests,
      today: { day: dayKey(Date.now()), credit: today.credit, requests: today.requests },
      recent: store.recent.slice(-20).reverse(),
      turns: groupTurns(store.recent).slice(-10).reverse(),
      turnGapMs: TURN_GAP_MS,
    }
  }

  function dispose() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  }

  return { record, view, dispose }
}
