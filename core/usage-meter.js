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

/**
 * 单轮 credit 的**健全性上限**（credit / prompt_token）。
 *
 * 正常量级实测 1e-6 ~ 3e-6（2026-10-20 本机 100 条 Qoder 轮次：0.4 credit / 40 万 prompt）。
 * 出现过同会话内 496 credit / 46 万 prompt（≈1.08e-3，比正常高 900 倍）的离群值——
 * 上游配额耗尽/限额时可能回传非计费语义的数字（见 docs/rules/quota-signals.md R-Q9）。
 * 这里只做**标注**（entry.suspect），不改写历史合计：明细里排除并单独提示，
 * 总量保持原样，绝不静默篡改用户已经看过的数字。
 */
const SUSPECT_CREDIT_PER_TOKEN = 1e-5
/** 小 prompt 的保护下限：低于这个 credit 的轮次一律不怀疑（避免误伤短对话）。 */
const SUSPECT_MIN_CREDIT = 2

function isSuspectCredit(credit, prompt) {
  if (!Number.isFinite(credit) || credit <= 0) return false
  return credit > Math.max(SUSPECT_MIN_CREDIT, (Number(prompt) || 0) * SUSPECT_CREDIT_PER_TOKEN)
}

/** 通道清单（组合根/各 gateway 传入；未传 = 早期记录，归 unknown，不猜）。 */
const CHANNEL_UNKNOWN = 'unknown'

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
  // 逐通道累计。**刻意不从历史 recent 反推**：老记录没有 channel 字段，按 model id
  // 猜通道正是我们要避免的（同一个 model id 可能在两个上游目录里同时存在）。
  // 因此这里只保证形状合法，累计从本版起算，UI 明确标注「自本版起」。
  store.byChannel = store.byChannel && typeof store.byChannel === 'object' && !Array.isArray(store.byChannel)
    ? store.byChannel : {}
  return store
}

/** 逐通道桶的合法形状（累计 + 今日 + 疑似异常分开计）。 */
function normalizeChannelBucket(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    credit: typeof b.credit === 'number' ? b.credit : 0,
    requests: typeof b.requests === 'number' ? b.requests : 0,
    suspectCredit: typeof b.suspectCredit === 'number' ? b.suspectCredit : 0,
    suspectRequests: typeof b.suspectRequests === 'number' ? b.suspectRequests : 0,
    days: b.days && typeof b.days === 'object' && !Array.isArray(b.days) ? b.days : {},
  }
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
   * channel: 由调用方注入的通道标识（自由字符串）——本模块不认识任何上游，
   * 缺省归 `unknown`，不按 model id 猜（同 id 可能跨通道复用）。
   */
  function record({ ts, kind, model, usage, channel }) {
    if (!usage || typeof usage !== 'object') return
    try {
      const credit = typeof usage.credit === 'number' && Number.isFinite(usage.credit) ? usage.credit : 0
      const prompt = usage.prompt_tokens ?? 0
      const suspect = isSuspectCredit(credit, prompt)
      const ch = typeof channel === 'string' && channel ? channel : CHANNEL_UNKNOWN
      const entry = {
        ts,
        kind,
        channel: ch,
        model: typeof model === 'string' ? model : null,
        prompt,
        hit: usage.prompt_cache_hit_tokens ?? 0,
        miss: usage.prompt_cache_miss_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        credit,
      }
      if (suspect) entry.suspect = true
      store.totalCredit = roundCredit(store.totalCredit + credit)
      store.totalRequests += 1
      const day = dayKey(ts)
      const bucket = store.days[day] ?? { credit: 0, requests: 0 }
      bucket.credit = roundCredit(bucket.credit + credit)
      bucket.requests += 1
      store.days[day] = bucket
      const dayKeys = Object.keys(store.days).sort()
      while (dayKeys.length > USAGE_DAYS_CAP) delete store.days[dayKeys.shift()]
      // 逐通道累计：可疑值不进 credit/requests（明细里单独提示），总量照旧含它。
      const cb = normalizeChannelBucket(store.byChannel[ch])
      if (suspect) {
        cb.suspectCredit = roundCredit(cb.suspectCredit + credit)
        cb.suspectRequests += 1
      } else {
        cb.credit = roundCredit(cb.credit + credit)
        cb.requests += 1
        const cday = cb.days[day] ?? { credit: 0, requests: 0 }
        cday.credit = roundCredit(cday.credit + credit)
        cday.requests += 1
        cb.days[day] = cday
        const cKeys = Object.keys(cb.days).sort()
        while (cKeys.length > USAGE_DAYS_CAP) delete cb.days[cKeys.shift()]
      }
      store.byChannel[ch] = cb
      store.recent.push(entry)
      if (store.recent.length > USAGE_RECENT_CAP) {
        store.recent = store.recent.slice(-USAGE_RECENT_CAP)
      }
      scheduleFlush()
    } catch {
      // metering is best-effort
    }
  }

  /** The usage-view payload: totals + per-channel split + approximate turns + exact recent rows. */
  function view() {
    const day = dayKey(Date.now())
    const today = store.days[day] ?? { credit: 0, requests: 0 }
    // 逐通道：credit/requests 已剔除可疑值；suspect* 单独给，UI 据此提示而不改总数。
    const byChannel = {}
    for (const [ch, rawBucket] of Object.entries(store.byChannel ?? {})) {
      const b = normalizeChannelBucket(rawBucket)
      const cday = b.days[day] ?? { credit: 0, requests: 0 }
      byChannel[ch] = {
        credit: b.credit,
        requests: b.requests,
        today: { credit: cday.credit, requests: cday.requests },
        suspectCredit: b.suspectCredit,
        suspectRequests: b.suspectRequests,
      }
    }
    return {
      since: store.since,
      totalCredit: store.totalCredit,
      totalRequests: store.totalRequests,
      today: { day, credit: today.credit, requests: today.requests },
      byChannel,
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
