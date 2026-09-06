/**
 * core/rotation.js — provider-agnostic multi-credential rotation engine.
 *
 * Policy: requests round-robin across the key list; a key that answers a
 * failover status (401/403/429/5xx) or drops the connection is
 * cooled for cooldownMs, then rejoins on its own. Cooling keys are appended
 * as last resort when every fresh key is unavailable.
 *
 * INSTANCE state (cooldown map + round-robin cursor) lives on the KeyRotator
 * object, NOT on the module — the composition root creates one instance per
 * plugin module instance, so test harnesses that import the plugin twice
 * (scripts/verify-rotation.mjs ?case=provider / ?case=bridge) keep the same
 * isolation the old module-global state provided.
 *
 * Extracted from index.js during the core/providers split. This file knows
 * nothing about any specific upstream: the "no credential" error for the
 * empty-candidate case is injected by the caller (`emptyError`).
 */

/** Statuses that fail a request over to the next key. */
function isFailoverStatus(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

export class KeyRotator {
  constructor() {
    /** keyName → cooldown-until epoch ms. */
    this.cooldowns = new Map()
    /** Round-robin cursor (advanced once per ordered() call). */
    this.cursor = 0
  }

  markCooling(name, cooldownMs) {
    this.cooldowns.set(name, Date.now() + cooldownMs)
  }

  /**
   * Order key entries for one outbound call: every key exactly once,
   * non-cooling first in round-robin order, cooling keys appended as last
   * resort. 0/1-key cases are handled by the caller (no rotation state is
   * touched for them — the cursor must not advance).
   *
   * @param {Array<{name: string, key: string}>} keys
   * @returns {Array<{authorization: string, headers: {}, keyName: string}>}
   */
  ordered(keys) {
    const now = Date.now()
    const n = keys.length
    const start = this.cursor % n
    this.cursor = (this.cursor + 1) % n
    const rotated = Array.from({ length: n }, (_, i) => keys[(start + i) % n])
    const fresh = rotated.filter((k) => (this.cooldowns.get(k.name) ?? 0) <= now)
    const cooling = rotated.filter((k) => (this.cooldowns.get(k.name) ?? 0) > now)
    return [...fresh, ...cooling].map((k) => ({
      authorization: `Bearer ${k.key}`,
      headers: {},
      keyName: k.name,
    }))
  }

  /**
   * Run `attempt(cred)` over the candidates with failover: a candidate that
   * throws a network error or answers a failover status is cooled and the
   * next candidate takes over. The LAST candidate's response/error is
   * returned as-is (no retry). `attempt(cred)` must return the fetch
   * Response (body unconsumed on error statuses — it is cancelled before
   * failing over) or throw.
   *
   * Resolves { cred, res, err }: exactly one of res/err is set.
   *
   * @param {Array<{authorization: string, headers: Record<string,string>, keyName: string|null}>} candidates
   * @param {(cred: object) => Promise<Response>} attempt
   * @param {{ cooldownMs: number, emptyError: Error }} options
   */
  async run(candidates, attempt, { cooldownMs, emptyError }) {
    if (candidates.length === 0) return { cred: null, res: null, err: emptyError }
    let lastErr = null
    for (let i = 0; i < candidates.length; i++) {
      const cred = candidates[i]
      const isLast = i === candidates.length - 1
      let res
      try {
        res = await attempt(cred)
      } catch (err) {
        // Caller-side aborts are not the key's fault: no cooldown, no failover.
        if (err?.name === 'AbortError') return { cred, res: null, err }
        // Network-layer failure: cool the key and fail over (unless last).
        if (cred.keyName) this.markCooling(cred.keyName, cooldownMs)
        lastErr = err
        if (isLast) return { cred, res: null, err }
        continue
      }
      if (!isLast && isFailoverStatus(res.status)) {
        if (cred.keyName) this.markCooling(cred.keyName, cooldownMs)
        await res.body?.cancel().catch(() => {})
        lastErr = null
        continue
      }
      return { cred, res, err: null }
    }
    return { cred: null, res: null, err: lastErr }
  }
}
