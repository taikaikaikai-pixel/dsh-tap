/**
 * host/models/state.js — 模型清单与"用户选择"的**状态层**（0.25.0 从 index.js 拆出）。
 *
 * 职责：静态清单（cordis.patch.yml）× 动态目录（/v3/config）× 文件层 modelState
 * （disabled/extra/overrides）⇒ 基清单与有效清单；再加积分倍率、手填倍率、
 * 逐模型思考档位表。**纯计算 + 文件层读写，不碰镜像、不碰网络**（目录抓取在
 * host/models/mirror.js 的 syncModelsFromGateway）。
 *
 * 边界：本模块不 import providers/**，也不 import host/settings/**——它是更下层。
 */

import { readFileSync } from 'node:fs'
import YAML from 'yaml'

import { PATCH_FILE, Config, readFileLayer, writeFileLayer } from '../config.js'
import { CREDIT_CHANNELS, mergeCredits, normalizeCredits } from '../../credits.js'


export function readStaticModels() {
  try {
    const rows = YAML.parse(readFileSync(PATCH_FILE, 'utf8'))
    const row = Array.isArray(rows) ? rows.find((r) => r?.id === 'llm-pi-ai') : null
    const models = row?.config?.providers?.codebuddy?.models
    return Array.isArray(models) ? models.filter((m) => typeof m?.id === 'string') : []
  } catch {
    return []
  }
}

export function readModelState() {
  const layer = readFileLayer()
  const state = layer.modelState
  if (!state || typeof state !== 'object') return { disabled: {}, extra: {}, overrides: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
    extra: state.extra && typeof state.extra === 'object' && !Array.isArray(state.extra)
      ? state.extra : {},
    // G5：每模型上下文/输出上限覆盖值 { [id]: { contextWindow?, maxTokens? } }。
    overrides: state.overrides && typeof state.overrides === 'object' && !Array.isArray(state.overrides)
      ? state.overrides : {},
  }
}

/**
 * 安全审计 [22]：POST 供给的模型 id 会成为对象键（state.extra/overrides[id]）
 * 并镜像进 settings.yaml 的映射键。Object.prototype 关键段一律拒收——
 * `extra['__proto__'] = <object>` 是真实原型污染写入；含这些关键段的
 * “子路径”形式（a.constructor、x[__proto__] 等）同样拒绝。
 */
export function assertSafeModelId(id) {
  const unsafe = /(?:^|[.[\]])+(?:__proto__|constructor|prototype)(?:$|[.[\]])+/.test(id)
  if (unsafe) {
    throw new Error(`非法模型 id（保留键 ${JSON.stringify(id)} 拒绝写入）`)
  }
}

// ---------------------------------------------------------------------------
// 手填积分倍率：官方目录**没有**标注倍率的模型（Trae/Qoder 全量、CodeBuddy
// 缺 `credits` 字段的条目）允许用户逐模型手动标一个，只用于设置卡展示。
// 存文件层 `manualCredits: { codebuddy: {id: token}, trae: {...}, qoder: {...} }`，
// 按 channel 隔离同名 id。**不进宿主配置层、不参与镜像、不参与任何计费推算**
// ——token 口径见 credits.js。
// ---------------------------------------------------------------------------

/**
 * 官方目录倍率（最近一次成功拉到的 /v3/config）：`{ [id]: token }`。
 * 只用于展示（设置卡 + 输入框模型选择器），**不进宿主镜像**——踩坑 #12 的
 * schema 白名单会把不认识的键静默丢掉，故倍率走独立通道（creditsView）。
 * 实例状态：模块作用域每插件实例一份（踩坑 #20 纪律同 rotator/meter）。
 */
let officialCredits = {}
/** 官方倍率（来自 /v3/config 同步与 model-list 刷新）；由镜像层/动作层写。 */
export function setOfficialCredits(map) { officialCredits = map && typeof map === 'object' ? map : {} }

/** 目录条目 → `{ [id]: token }`（未声明/不可解析的条目直接跳过，不编造）。 */
export function creditsFromCatalog(models) {
  const out = {}
  for (const m of models ?? []) {
    if (typeof m?.credits === 'string' && m.credits) out[m.id] = m.credits
  }
  return out
}

/** 浏览器半用的合并表：官方优先、手填补空缺（口径见 credits.js mergeCredits）。 */
/**
 * 非 CodeBuddy 的官方倍率来源（目前只有 qoder：目录 2026-10 起自带逐模型
 * `price_factor`，同步后即有值；未同步/旧目录为空表，回落手填）。
 *
 * 为什么是注册式而不是 import：provider 单例由组合根创建（它要凭据编排与
 * 设置源），状态层是更下层——反向 import 组合根会成环，import provider 实例
 * 模块则让"状态层"要知道 provider 的构造顺序。注册一个取值函数即可。
 */
let extraCreditsSource = () => ({})
export function setExtraCreditsSource(fn) {
  extraCreditsSource = typeof fn === 'function' ? fn : () => ({})
}

export function creditsView() {
  return mergeCredits(
    { codebuddy: officialCredits, ...extraCreditsSource() },
    readManualCredits(),
  )
}

/**
 * 手填倍率读侧：只认三通道 + 合法 token，垃圾值静默丢弃
 * （同 readQoderModelPrefs 的读侧归一化纪律：手改文件不得让卡片炸）。
 */
export function readManualCredits() {
  const out = { codebuddy: {}, trae: {}, qoder: {} }
  const raw = readFileLayer().manualCredits
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const channel of CREDIT_CHANNELS) {
    const map = raw[channel]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [id, value] of Object.entries(map)) {
      try {
        const token = normalizeCredits(value)
        if (token !== null) out[channel][id] = token
      } catch { /* 非法 token：丢弃该条，不连坐整表 */ }
    }
  }
  return out
}

/**
 * manualCreditsSet 写路径（UI 契约：patch.manualCreditsSet = { channel, id, value }）。
 * value 空/null = 删除该模型的记录；非法形态由 normalizeCredits 抛错转 400。
 * **刻意不校验 id 是否在当前目录里**：这是纯展示元数据，目录尚未同步时也应当
 * 允许先标（与 *ModelPrefs 那些必须绑定目录声明档位的 setter 区分开）。
 */
export async function setManualCredits({ channel, id, value } = {}) {
  if (!CREDIT_CHANNELS.includes(channel)) {
    throw new Error('manualCreditsSet 的 channel 必须是 codebuddy / trae / qoder')
  }
  if (typeof id !== 'string' || !id.trim()) throw new Error('manualCreditsSet 需要 id')
  assertSafeModelId(id)
  const token = normalizeCredits(value)
  const all = readManualCredits()
  const rec = { ...all[channel] }
  if (token === null) delete rec[id]
  else rec[id] = token
  const next = { ...all, [channel]: rec }
  const layer = readFileLayer()
  // 纯净态纪律：一条都不剩就删掉整键，别留空壳。
  if (Object.values(next).some((m) => Object.keys(m).length > 0)) layer.manualCredits = next
  else delete layer.manualCredits
  writeFileLayer(layer)
  return next
}

/** Effective models = static base + enabled catalog extras − disabled ids. */
/**
 * G4 动态目录：启动时（及设置卡手动刷新）从 /v3/config 同步的模型清单。
 * null = 未同步或同步失败（离线兜底 = 静态清单，computeEffectiveModels 回落）。
 * 实例状态：模块作用域每插件实例一份（踩坑 #20 纪律同 rotator/meter）。
 */
let dynamicCatalog = null // { profiles: [...], fetchedAt, count }
/** 目录态（同步层写、视图层读）：null = 从未同步成功。 */
export function getDynamicCatalog() { return dynamicCatalog }
export function setDynamicCatalog(next) { dynamicCatalog = next }

/**
 * 思考档位的规范顺序（选择器/卡片展示用；pi-ai 自己按 THINKING_LEVELS 排，
 * 目录声明的键序不必与之一致）。
 */
export const EFFORT_TIER_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const effortRank = (level) => {
  const i = EFFORT_TIER_ORDER.indexOf(level)
  return i === -1 ? EFFORT_TIER_ORDER.length : i
}

/**
 * 目录声明的"关思考"线值——**实测为 null（没有这样的拼写）**，故
 * `canDisableThinking:true` 的模型不出 off 档（不臆造线值）。依据
 * docs/probes/codebuddy-efforts-{disable,offconfirm}-2026-09-22.json：
 * 这类模型**省略参数照常思考**（与 defaultEffort 一致），显式
 * off/disabled/auto 被 200 接受但推理量不变，minimal/none 跨模型不一致
 * （glm-5.3-flash≈0 / kimi-k2.8-preview≈140，基线≈1k）。哪天定论了真正的
 * 关思考线值，把这里改成该拼写即可（表里会自动多出 off 档）。
 */
export const CATALOG_OFF_WIRE = null

/**
 * 目录思考强度声明 → 档位表（键 = 档位名，值 = 出站线值；null = 省略参数）。
 * 只有带 `supportedEfforts` 的新形态声明才产出表——legacy 形态
 * （{"effort":"high"}）只声明默认档，不构成能力清单，档位表继续由
 * cordis.patch.yml 静态清单提供（合并优先级见 computeBaseModels）。
 */
export function catalogReasoningEfforts(m) {
  const supported = Array.isArray(m?.supportedEfforts)
    ? m.supportedEfforts.filter((s) => typeof s === 'string' && s)
    : []
  if (!supported.length) return null
  const table = {}
  if (m.canDisableThinking === true && CATALOG_OFF_WIRE) table.off = CATALOG_OFF_WIRE
  for (const level of [...supported].sort((a, b) => effortRank(a) - effortRank(b))) table[level] = level
  return table
}

/** 目录条目 → 模型 profile（尺寸/图像来自目录；思考档位表见上）。 */
export function catalogToProfile(m) {
  const p = { id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id }
  if (m.maxInputTokens != null) p.contextWindow = m.maxInputTokens
  if (m.maxOutputTokens != null) p.maxTokens = m.maxOutputTokens
  if (m.images === true) p.input = ['text', 'image']
  const efforts = catalogReasoningEfforts(m)
  if (efforts) p.reasoningEfforts = efforts
  return p
}

/**
 * 某模型可用的档位表 = 基清单（静态清单 ∪ 动态目录）里的 reasoningEfforts。
 * 目录声明优先（computeBaseModels 的展开顺序），静态表兜底。
 * 缓存以 dynamicCatalog 引用为键（每次同步换新；静态清单运行期不变）。
 */
let effortTableCache = null
export function effortTableFor(model) {
  if (!effortTableCache || effortTableCache.source !== dynamicCatalog) {
    const map = new Map()
    for (const m of computeBaseModels()) {
      if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') map.set(m.id, m.reasoningEfforts)
    }
    effortTableCache = { source: dynamicCatalog, map }
  }
  return effortTableCache.map.get(model) ?? null
}

/** 档位名 → 展示用清单：过滤掉"off 但线值为空"（那是省略参数 = 默认态）。 */
export function effortTiersFor(model) {
  const table = effortTableFor(model)
  if (!table) return []
  return Object.entries(table)
    .filter(([level, wire]) => (level === 'off' ? typeof wire === 'string' && wire : true))
    .map(([level]) => level)
    .sort((a, b) => effortRank(a) - effortRank(b))
}

/**
 * G8：模型当前该注入的 reasoning_effort 线值。文件层的 effortByModel 只存
 * 档位名，线值查该模型的档位表（静态 reasoningEfforts ∪ 目录声明）——
 * off 的线值可能是 null（= 省略参数，不注入），也可能是显式"关思考"拼写；
 * 无表模型/非法档位同样不注入（UI 之外的写入路径不会把脏档位送上线）。
 */
export function effortWireFor(model) {
  const level = Config({ ...readFileLayer() }).effortByModel[model]
  if (!level) return undefined
  const wire = effortTableFor(model)?.[level]
  return typeof wire === 'string' && wire ? wire : undefined
}

/**
 * 动态基清单 = 目录 ∪ 静态：目录条目刷新同名静态条目的名称/尺寸/图像能力
 * （静态的 reasoningEfforts 档位表保留——目录没有该信息）；纯静态 id 保留
 * （目录与可路由性三方互斥，routing.md R-R3：deepseek-v3 不在目录但可用，
 * 而 agent-default-model 钉的正是它——盲从目录会把默认模型弄丢）。
 */
export function computeBaseModels() {
  if (!dynamicCatalog) return readStaticModels()
  const staticById = new Map(readStaticModels().map((m) => [m.id, m]))
  const seen = new Set()
  const list = []
  for (const p of dynamicCatalog.profiles) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const st = staticById.get(p.id)
    // p（目录）不含 reasoningEfforts 键，展开不会覆盖静态档位表。
    list.push(st ? { ...st, ...p } : p)
  }
  for (const m of readStaticModels()) {
    if (!seen.has(m.id)) list.push(m)
  }
  return list
}

export function computeEffectiveModels() {
  const { disabled, extra, overrides } = readModelState()
  const ids = new Set()
  const list = []
  for (const m of computeBaseModels()) {
    if (disabled[m.id]) continue
    ids.add(m.id)
    list.push(m)
  }
  for (const [id, profile] of Object.entries(extra)) {
    if (disabled[id] || ids.has(id) || !profile?.id) continue
    ids.add(id)
    list.push({ ...profile, id })
  }
  // G5：应用每模型覆盖值（contextWindow/maxTokens），覆盖随镜像即时生效。
  return list.map((m) => {
    const o = overrides[m.id]
    if (!o) return m
    return {
      ...m,
      ...(o.contextWindow != null ? { contextWindow: o.contextWindow } : null),
      ...(o.maxTokens != null ? { maxTokens: o.maxTokens } : null),
    }
  })
}
