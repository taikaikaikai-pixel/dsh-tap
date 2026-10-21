/**
 * quota-view.js — 「主界面额度卡」的展示视图：三条订阅通道的额度快照归一化 +
 * 跨通道合计。**纯函数、无 I/O**，可离线单测（scripts/verify-quota-view.mjs）。
 *
 * 为什么归一化在服务端（这里）而不是浏览器半：口径（谁是权威数值、谁只是估算、
 * 什么算"可见"、合计怎么加）必须一处定义、一处被测；浏览器半只负责画。
 *
 * 口径（与 docs/rules/quota-signals.md R-Q12 同步，改这里必须改那节）：
 *   1. 合计**只加** `state==='ok'`、`unit==='credit'`（归一后；上游 `credit`/`credits` 同义）、
 *      `primary!=null` 的通道。
 *      不同厂商的 credit 不可换算，这个合计只是量级参考，不参与任何计费。
 *   2. api-key 档（CodeBuddy 无数值额度接口）用「手填总额 − 本机计量」算估算值，
 *      标 `estimate`：**不混进精确合计**，只在没有精确值时才作为合计展示并带 ≈。
 *   3. 缺字段一律 null，绝不补 0、绝不编数字（设置卡同一条纪律）。
 *   4. 全通道都不可用 ⇒ `visible=false`，主界面不渲染胶囊（纯 key 型用户界面不变）。
 */

export const QUOTA_CHANNEL_ORDER = ['codebuddy', 'trae', 'qoder']

/** 快照超过这个岁数就标 stale（客户端把读数降级成灰字 + 提示）。 */
export const STALE_MS = 5 * 60 * 1000

const isNum = (n) => typeof n === 'number' && Number.isFinite(n)
const r2 = (n) => (isNum(n) ? Math.round(n * 100) / 100 : null)

/**
 * 单位归一：上游对同一个东西有 `"credit"` 与 `"credits"` 两种写法（实测 Qoder 的
 * `/api/v2/quota/usage` 回 `"credits"`，CodeBuddy 的计费口径是 `credit`）。合计
 * 判据必须按语义而不是按字面比较，否则复数写法会被当成"另一种货币"整通道排除
 * （2026-10-21 用户实测「胶囊上没有合计」就是这个：Qoder 2865 没进合计）。
 * 其它单位（如 token）原样保留、照显示但不进合计。
 */
const normalizeUnit = (unit) => {
  if (typeof unit !== 'string' || unit.trim() === '') return 'credit'
  const s = unit.trim()
  return /^credits?$/i.test(s) ? 'credit' : s.toLowerCase()
}

/** 一行额度读数；缺失一律 null（不留 0，0 是真实读数）。 */
function row(label, remain, total, unit = 'credit') {
  return { label, remain: r2(remain), total: r2(total), unit: normalizeUnit(unit) }
}

/** 组装一个通道条目（state 决定徽标与合计参与资格）。 */
function makeChannel({ key, label, state, badge, rows = [], primary = null, unit = 'credit', fetchedAt = null, error = null, note = null, now = Date.now() }) {
  const at = isNum(fetchedAt) ? fetchedAt : null
  return {
    key,
    label,
    state,
    badge,
    rows,
    primary: r2(primary),
    unit: normalizeUnit(unit),
    fetchedAt: at,
    stale: at !== null && now - at > STALE_MS,
    error: error === null || error === undefined ? null : String(error),
    note: note === null || note === undefined ? null : String(note),
  }
}

const degraded = (base, error) => makeChannel({ ...base, state: 'error', badge: '读取失败', error, rows: [], primary: null })

/** 登录态判据**优先是结构化的 `unauth: true`**（0.23.0 起三个额度模块都带）：
 *  文案正则只留作旧版快照的兼容回退——按中文措辞分类意味着上游/文案改一个词，
 *  登录态就被误判成真故障（胶囊出红、还参与可见性）。 */
const SIGNED_OUT_RE = /^(未登录|凭据不可用)/
const unavailable = (base, message) => makeChannel({
  ...base,
  state: 'unavailable',
  badge: '未登录',
  rows: [],
  primary: null,
  note: message || '未登录',
})
/**
 * 快照异常归类：`unauth === true`（结构化）或旧快照的固定措辞 ⇒ unavailable；
 * 其余一律真故障 degraded。
 * @param {object} base 通道基底
 * @param {{error?: string, unauth?: boolean}} snap 额度快照
 */
const fromError = (base, snap) => {
  const message = typeof snap === 'string' ? snap : snap?.error
  const signedOut = (typeof snap === 'object' && snap !== null && snap.unauth === true)
    || SIGNED_OUT_RE.test(String(message))
  return signedOut ? unavailable(base, message) : degraded(base, message)
}

/**
 * CodeBuddy：OAuth = 官方数值额度（R-Q7）；api-key = 该路径族 401 ⇒ 估算档。
 * @param {object|null} snap providers/codebuddy/catalog.js#quotaSnapshot 的返回
 */
function codebuddyChannel(snap, { now, manualTotal, meteredCredit }) {
  const base = { key: 'codebuddy', label: 'CodeBuddy', now }
  if (!snap || typeof snap !== 'object') return degraded(base, '读取失败（无响应）')
  if (snap.error) return fromError(base, snap)
  if (snap.numericQuota === true) {
    const res = snap.resource
    if (!res) return degraded(base, `数值额度读取失败：${snap.resourceError ?? '未知'}`)
    const rows = [
      row('周期剩余', res.cycleRemain, res.cycleSize),
      row('总量剩余', res.totalRemain, null),
    ]
    return makeChannel({
      ...base,
      state: 'ok',
      badge: '官方计数',
      rows,
      primary: isNum(res.cycleRemain) ? res.cycleRemain : res.totalRemain,
      fetchedAt: snap.fetchedAt,
      note: Array.isArray(res.packs) && res.packs.length ? `${res.packs.length} 个资源包` : null,
      now,
    })
  }
  // api-key：网关不开放数值额度（OAuth 专享 401）⇒ 用户手填总额度做估算档。
  const manual = isNum(manualTotal) ? manualTotal : 0
  if (manual > 0) {
    const used = isNum(meteredCredit) ? meteredCredit : 0
    const remain = Math.max(0, manual - used)
    return makeChannel({
      ...base,
      state: 'estimate',
      badge: '估算',
      rows: [row('估算剩余', remain, manual)],
      primary: remain,
      fetchedAt: snap.fetchedAt ?? null,
      note: '手填总额度 − 本机计量（非上游读数）',
      now,
    })
  }
  return makeChannel({
    ...base,
    state: 'unavailable',
    badge: '未登录',
    note: '未登录；api-key 模式可在设置卡手填总额度后按估算显示',
    now,
  })
}

/** TraeWork CN：IDE 池 + work 池（两个资源包池，都是 credit）。 */
function traeChannel(snap, { now }) {
  const base = { key: 'trae', label: 'Trae CN', now }
  if (!snap || typeof snap !== 'object') return degraded(base, '读取失败（无响应）')
  if (snap.error) return fromError(base, snap)
  const pools = snap.pools ?? null
  if (!pools) return degraded(base, '无资源包字段')
  const ide = pools.ide ?? null
  const work = pools.work ?? null
  if (!ide && !work) return degraded(base, '无资源包字段')
  const rows = []
  if (ide) rows.push(row('IDE 池', ide.remain, ide.limit))
  if (work) rows.push(row('work 池', work.remain, work.limit))
  const primary = [ide?.remain, work?.remain].filter(isNum).reduce((a, b) => a + b, 0)
  const empty = (!ide || (!isNum(ide.limit) || ide.limit === 0)) && (!work || (!isNum(work.limit) || work.limit === 0))
  return makeChannel({
    ...base,
    state: 'ok',
    badge: '官方计数',
    rows,
    primary: [ide?.remain, work?.remain].some(isNum) ? primary : null,
    fetchedAt: snap.fetchedAt,
    note: empty ? '无资源包' : null,
    now,
  })
}

/** Qoder CN：订阅配额 + 附加配额（官方实时计数器，耗尽时 addOnQuota 可能整个消失）。 */
function qoderChannel(snap, { now }) {
  const base = { key: 'qoder', label: 'Qoder CN', now }
  if (!snap || typeof snap !== 'object') return degraded(base, '读取失败（无响应）')
  if (snap.error) return fromError(base, snap)
  const user = snap.userQuota ?? null
  const addon = snap.addOnQuota ?? null
  if (!user && !addon) return degraded(base, '无配额字段（上游响应异常）')
  const rows = []
  if (user) rows.push(row('订阅余额', user.remaining, user.total, user.unit ?? 'credit'))
  if (addon) rows.push(row('附加余额', addon.remaining, addon.total, addon.unit ?? 'credit'))
  const primary = [user?.remaining, addon?.remaining].filter(isNum).reduce((a, b) => a + b, 0)
  return makeChannel({
    ...base,
    state: 'ok',
    badge: '官方计数',
    rows,
    primary: [user?.remaining, addon?.remaining].some(isNum) ? primary : null,
    unit: user?.unit ?? addon?.unit ?? 'credit',
    fetchedAt: snap.fetchedAt,
    note: snap.isQuotaExceeded === true ? '配额已耗尽' : null,
    now,
  })
}

/** 合计：精确值优先；没有精确值才回落估算（带 kind 让客户端加 ≈）。 */
export function aggregateTotal(channels) {
  const usable = (c, state) => c && c.state === state && c.unit === 'credit' && isNum(c.primary)
  const exact = channels.filter((c) => usable(c, 'ok'))
  if (exact.length) {
    return { kind: 'exact', credit: r2(exact.reduce((a, c) => a + c.primary, 0)), channelCount: exact.length }
  }
  const est = channels.filter((c) => usable(c, 'estimate'))
  if (est.length) {
    return { kind: 'estimate', credit: r2(est.reduce((a, c) => a + c.primary, 0)), channelCount: est.length }
  }
  return { kind: 'none', credit: null, channelCount: 0 }
}

/** 本机计量（零上游成本的实时读数）：面板里与官方读数并排，不作剩余额度用。 */
function meterView(meter) {
  const byChannel = {}
  const src = meter && meter.byChannel && typeof meter.byChannel === 'object' ? meter.byChannel : {}
  for (const key of QUOTA_CHANNEL_ORDER) {
    const b = src[key]
    byChannel[key] = isNum(b?.credit) ? r2(b.credit) : 0
  }
  return {
    todayCredit: isNum(meter?.today?.credit) ? r2(meter.today.credit) : 0,
    totalCredit: isNum(meter?.totalCredit) ? r2(meter.totalCredit) : 0,
    byChannel,
  }
}

/**
 * @param {object} input
 * @param {object|null} [input.codebuddy] quotaSnapshot 返回
 * @param {object|null} [input.trae] trae quota.snapshot 返回
 * @param {object|null} [input.qoder] qoder quota.snapshot 返回
 * @param {object|null} [input.meter] core/usage-meter 的 view()
 * @param {number} [input.manualTotal] Config.quotaTotalManual
 * @param {number} [input.noQuotaProviders] 无额度接口的 key 型服务商数
 * @param {number} [input.now]
 */
export function buildQuotaView({
  // 两种调用形态：①按通道清单 `channels: { codebuddy, trae, qoder, … }`（组合根用，
  // 加通道只需一个适配器）；②旧的三命名参数（测试与外部调用保持兼容）。
  channels = null,
  codebuddy = null, trae = null, qoder = null,
  meter = null, manualTotal = 0, noQuotaProviders = 0, now = Date.now(),
} = {}) {
  const src = channels ?? { codebuddy, trae, qoder }
  const m = meterView(meter)
  const rows = [
    codebuddyChannel(src.codebuddy ?? null, { now, manualTotal, meteredCredit: m.byChannel.codebuddy }),
    traeChannel(src.trae ?? null, { now }),
    qoderChannel(src.qoder ?? null, { now }),
  ]
  const total = aggregateTotal(rows)
  return {
    updatedAt: now,
    channels: rows,
    total,
    // 有得看（精确/估算）或至少有失败原因要看 ⇒ 主界面出胶囊；否则整枚隐藏。
    visible: total.kind !== 'none' || rows.some((c) => c.state === 'error'),
    meter: m,
    noQuotaProviders: isNum(noQuotaProviders) ? noQuotaProviders : 0,
  }
}
