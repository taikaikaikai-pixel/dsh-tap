/**
 * providers/trae/quota.js — TraeWork CN 双额度池余额只读快照（设置卡用）。
 *
 * 端点：POST {traeAuthBaseURL}/trae/api/v2/pay/ide_user_ent_usage。
 * 实测口径（docs/probes/trae-credits-2026-08-24T07-16-51.json）：
 *   - req_source=0 一次调用即返回全部资源包（req_source=1 只回 endpoint=0 子集），
 *     故只发一发；按 entitlement_base_info.available_endpoint 分池
 *     （0=IDE 池/raw 面消耗、1=work 池/remote 面消耗，docs/reverse/trae-cloud-api.md）。
 *   - 头组 = traeOutboundHeaders（设备指纹与登录上报一致）+ 凭证三头
 *     （Authorization: Cloud-IDE-JWT / X-Cloudide-Token / x-ide-token）。
 * 成本纪律：60s memoize（与 codebuddy quotaSnapshot 同口径）；永不 throw——
 * 失败回 { error }，调用方（设置卡）据此显示「—」，绝不编造数值。
 */

import { traeOutboundHeaders } from './gateway.js'

export function createTraeQuota({ settings, readAuth, oauth }) {
  let cache = { at: 0, value: null }
  // 单飞：并发 snapshot 共享同一在飞请求，不重复打上游。
  let inFlight = null

  async function fetchSnapshot() {
    const s = settings()
    const cred = await oauth.resolveTraeCredential(s)
    if (!cred) return { error: '未登录', fetchedAt: Date.now() }
    const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
    const store = readAuth()
    const uid = store?.account?.uid
    const headers = {
      ...traeOutboundHeaders(store?.device ?? null, uid, crypto.randomUUID()),
      Authorization: `Cloud-IDE-JWT ${token}`,
      'X-Cloudide-Token': token,
      'x-ide-token': token,
    }
    const res = await fetch(`${s.traeAuthBaseURL}/trae/api/v2/pay/ide_user_ent_usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ require_usage: true, req_source: 0 }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => null)
    const packs = body?.user_entitlement_pack_list
    if (!res.ok || !Array.isArray(packs)) {
      return { error: `code ${body?.code ?? `http ${res.status}`}`, fetchedAt: Date.now() }
    }
    const sum = { ide: { limit: 0, used: 0 }, work: { limit: 0, used: 0 } }
    for (const p of packs) {
      const ep = p?.entitlement_base_info?.available_endpoint
      const pool = ep === 1 ? sum.work : ep === 0 ? sum.ide : null
      if (!pool) continue
      const limit = p?.entitlement_base_info?.quota?.credits_limit
      const used = p?.usage?.credits_amount
      if (typeof limit === 'number') pool.limit += limit
      if (typeof used === 'number') pool.used += used
    }
    const round = (n) => Math.round(n * 100) / 100
    const pack = (pool) => ({ limit: round(pool.limit), used: round(pool.used), remain: round(pool.limit - pool.used) })
    return { pools: { ide: pack(sum.ide), work: pack(sum.work) }, fetchedAt: Date.now() }
  }

  function snapshot() {
    if (cache.value && Date.now() - cache.at < 60_000) return Promise.resolve(cache.value)
    if (inFlight) return inFlight
    inFlight = fetchSnapshot()
      .catch((err) => ({ error: err?.message ?? String(err), fetchedAt: Date.now() }))
      .then((value) => {
        cache = { at: Date.now(), value }
        return value
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  return { snapshot }
}
