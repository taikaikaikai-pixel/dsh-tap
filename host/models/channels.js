/**
 * host/models/channels.js — qoder/trae 两条订阅通道的**模型状态与偏好**
 * （0.25.0 从 index.js 拆出；codebuddy 的模型状态在 state.js）。
 *
 * 每个通道一套：目录视图（来自 provider 的 catalogView）→ 用户启停（disabled）→
 * 思考档位偏好（prefs）→ 逐模型镜像（sync*ModelsToDshSettingsImpl）。三件事必须
 * 同源：卡片里的档位 select、出站注入、宿主镜像里的 `reasoningEfforts` 用的是
 * 同一份目录声明（踩坑 #64/#66 的回归面）。
 */

import { isAbsolute, normalize, extname } from 'node:path'

import YAML from 'yaml'

import { Config, readFileLayer, writeFileLayer, hostConfig, settingsRef } from '../config.js'
import { describeError } from '../../core/errors.js'
import { assertSafeModelId } from './state.js'
import { trackMirror } from './mirror.js'
import { traeProvider, qoderProvider, QUEUE_RETRY_POLICY, NO_CHANNEL_RETRY_POLICY } from '../providers/instances.js'
import { applyQoderContextVariant } from '../../providers/qoder/catalog.js'
import { writeProviderBlock } from '../providers/registry.js'

export function readQoderModelState() {
  const state = readFileLayer().qoderModelState
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { disabled: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
  }
}

// 逐模型偏好：{ [id]: { effort?, contextVariant? } }，与 qoderModelState 并列的
// 独立文件层键（其形状是 disabled 集合字典，与 prefs 记录不对称，故不扩它）。
// 只存已设置的键、空记录不落盘（= 默认）。effort 的**真源是目录逐模型声明**
// （providers/qoder/catalog.js 的 qoderEffortTiers ← thinking_config.enabled.efforts
// ∪ disabled→off）；contextVariant 是目录 context_config 变体名，镜像时换成
// contextWindow（applyQoderContextVariant）。
//
// QODER_EFFORT_LEVELS 不再是 UI/校验真源，只作**存量兼容网**（R3）：0.17 及以前
// 写下的、目录未声明的拼写（如 qmodel_38max 的 max）读侧保留、不静默丢；目录未
// 同步的启动窗口内也仍认这五个拼写。新写入一律以目录声明为准（qoderEffortScope）。
export const QODER_EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max']

/** 目录为该模型声明的档位（未同步 / 未声明命名档位 → []）。 */
export function qoderDeclaredTiers(id) {
  const tiers = qoderProvider.catalogView()?.efforts?.[id]
  return Array.isArray(tiers) ? tiers : []
}

/**
 * 写入校验的允许集 = 目录声明 ∪ {该模型当前存量值}。
 * 含存量值是为 R3：UI 提交的是**全量期望态**（effort + contextVariant 一起发），
 * 若目录不再声明存量档位（如 max），只改上下文长度也会被误判非法。新设一个
 * 目录未声明的档位仍然拒（允许集里没有它）。
 */
export function qoderEffortScope(id) {
  const declared = qoderDeclaredTiers(id)
  const stored = readQoderModelPrefs()[id]?.effort
  return stored ? [...new Set([...declared, stored])] : declared
}

export function readQoderModelPrefs() {
  const raw = readFileLayer().qoderModelPrefs
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const rec = {}
    // 读侧保留规则：非空字符串且（目录声明了它 ∪ 旧固定表认得它）。前者覆盖
    // xhigh 这类上游专有拼写，后者是存量兼容网（R3）；两者之外的手改垃圾丢弃。
    if (typeof v.effort === 'string' && v.effort
      && (qoderDeclaredTiers(id).includes(v.effort) || QODER_EFFORT_LEVELS.includes(v.effort))) {
      rec.effort = v.effort
    }
    if (typeof v.contextVariant === 'string' && v.contextVariant) rec.contextVariant = v.contextVariant
    if (Object.keys(rec).length) out[id] = rec
  }
  return out
}

/** 镜像 providers.qoder **整块**（路由存在性管理，同 trae 镜像纪律）。 */
export async function syncQoderModelsToDshSettingsImpl() {
  try {
    // 端口同源：经 effectiveSettingsFn（apply 内赋值的 resolveNow）解析，
    // 未赋值窗口回退纯文件层默认（shift=0）语义。
    const s = settingsRef.effective ? settingsRef.effective() : Config({ ...readFileLayer() })
    const view = qoderProvider.catalogView()
    const disabled = readQoderModelState().disabled
    const prefs = readQoderModelPrefs()
    const models = s.qoderEnabled === true && view
      ? view.profiles
          .filter((p) => !disabled[p.id])
          .map((p) => applyQoderContextVariant(p, prefs[p.id]?.contextVariant, view.variants?.[p.id]))
      : null
    const path = ['providers', 'qoder']
    if (!models || models.length === 0) return await hostConfig.applyOps([{ op: 'unset', path }])
    const block = {
      displayName: 'Qoder CN',
      api: 'openai-completions',
      baseURL: `http://127.0.0.1:${s.qoderBridgePort}/v1`,
      headers: { Authorization: 'Bearer dsh-qoder-bridge' },
      // 宿主 Model/Effort 选择器要出档，路由必须声明 supportsReasoningEffort——
      // pi-ai 的 openai-completions 出站只在 compat.supportsReasoningEffort 为真时
      // 才把选中档位写成 reasoning_effort（同 codebuddy 路由的 compat 形状）；
      // thinkingFormat 显式钉 openai，免得 pi-ai 从 127.0.0.1 的 URL 猜成别的方言
      // （codebuddy 侧踩过：猜错会发 thinking 而不是 reasoning_effort）。
      // 档位表由 catalog 投影进 models[].reasoningEfforts（见 qoderReasoningEfforts）。
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
      // 排队态（10605）30s 一重试，直到排队结束；其它失败不重试（见
      // QUEUE_RETRY_POLICY 注释）。配额耗尽在 gateway 消息里带
      // "usage limit exceeded"，宿主分类为 QUOTA（不在 retryableCodes）。
      retryPolicy: QUEUE_RETRY_POLICY,
      models: YAML.parse(YAML.stringify(models)),
    }
    return await hostConfig.applyOps([{ op: 'set', path, value: block }])
  } catch (err) {
    const d = describeError(err, { fallback: 'qoder mirror failed' })
    process.stderr.write(`[dsh-tap] qoder mirror failed: ${d.message}\n`)
    return { ok: false, error: d.message }
  }
}

export async function setQoderModelEnabled({ id, enabled }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('qoderModelSetEnabled 需要 id')
  assertSafeModelId(id)
  const view = qoderProvider.catalogView()
  if (!view || !view.profiles.some((p) => p.id === id)) throw new Error(`${id} 不在 Qoder 目录里（先同步目录）`)
  const layer = readFileLayer()
  const state = readQoderModelState()
  if (enabled) delete state.disabled[id]
  else state.disabled[id] = true
  layer.qoderModelState = state
  writeFileLayer(layer)
  await syncQoderModelsToDshSettings()
  return state
}

/**
 * qoderModelSetPrefs 写路径（UI 契约：patch.qoderModelSetPrefs = { id, prefs }）。
 * prefs 是该模型记录的**完整替换**——只存已设置的键，空对象 = 删记录回默认。
 * effort 校验按**该模型的目录声明**（qoderDeclaredTiers）∪ 其存量值（R3 兼容）；
 * contextVariant 必须命中该模型目录变体（无变体模型拒收）。
 */
export async function setQoderModelPrefs({ id, prefs }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('qoderModelSetPrefs 需要 id')
  assertSafeModelId(id)
  const view = qoderProvider.catalogView()
  if (!view || !view.profiles.some((p) => p.id === id)) throw new Error(`${id} 不在 Qoder 目录里（先同步目录）`)
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('qoderModelSetPrefs 需要 prefs 对象')
  const unknown = Object.keys(prefs).filter((k) => k !== 'effort' && k !== 'contextVariant')
  if (unknown.length) throw new Error(`prefs 不支持的键：${unknown.join(', ')}`)
  const rec = {}
  if (prefs.effort !== undefined) {
    const declared = qoderDeclaredTiers(id)
    if (!qoderEffortScope(id).includes(prefs.effort)) {
      throw new Error(declared.length
        ? `effort 档位必须是该模型目录声明的 ${declared.join('/')} 之一`
        : `该模型目录未声明思考档位，effort 只能清除不能新设`)
    }
    rec.effort = prefs.effort
  }
  if (prefs.contextVariant !== undefined) {
    const variants = view.variants?.[id] ?? []
    if (!variants.some((v) => v?.name === prefs.contextVariant)) {
      throw new Error(`${id} 没有名为 ${prefs.contextVariant} 的上下文变体`)
    }
    rec.contextVariant = prefs.contextVariant
  }
  const state = readQoderModelPrefs()
  if (Object.keys(rec).length) state[id] = rec
  else delete state[id]
  const layer = readFileLayer()
  layer.qoderModelPrefs = state
  writeFileLayer(layer)
  await syncQoderModelsToDshSettings()
  return state
}

export function readTraeModelState() {
  const state = readFileLayer().traeModelState
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { disabled: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
  }
}

/** 目录为该模型声明的档位（未同步 / 未声明 → []）。 */
export function traeDeclaredTiers(id) {
  const tiers = traeProvider.catalogView()?.efforts?.[id]
  return Array.isArray(tiers) ? tiers : []
}

/**
 * Trae 逐模型 prefs（goal: trae-work-cn-repair G3）。目前只有 effort 一个键。
 * 读侧保留规则：目录已同步时只认声明档位；未同步窗口（启动竞态）读不出声明，
 * 存量值原样保留——同步完成后的下次读写自然按声明过滤。
 */
export function readTraeModelPrefs() {
  const raw = readFileLayer().traeModelPrefs
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const synced = traeProvider.catalogView() != null
  const out = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    if (typeof v.effort !== 'string' || !v.effort) continue
    if (synced && !traeDeclaredTiers(id).includes(v.effort)) continue
    out[id] = { effort: v.effort }
  }
  return out
}

/**
 * traeModelSetPrefs 写路径（UI 契约：patch.traeModelSetPrefs = { id, prefs }）。
 * 允许集 = 目录声明 ∪ {该模型当前存量值}（同 qoder R3：UI 发全量期望态，存量
 * 值即使目录不再声明也不能误判非法）；空 prefs = 删记录回默认。
 */
export async function setTraeModelPrefs({ id, prefs } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('traeModelSetPrefs 需要 id')
  assertSafeModelId(id)
  const view = traeProvider.catalogView()
  if (!view || !view.profiles.some((p) => p.id === id)) throw new Error(`${id} 不在 Trae 目录里（先同步目录）`)
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('traeModelSetPrefs 需要 prefs 对象')
  const unknown = Object.keys(prefs).filter((k) => k !== 'effort')
  if (unknown.length) throw new Error(`prefs 不支持的键：${unknown.join(', ')}`)
  if (prefs.effort !== undefined) {
    const stored = readTraeModelPrefs()[id]?.effort
    const allowed = [...new Set([...traeDeclaredTiers(id), ...(stored ? [stored] : [])])]
    if (!allowed.length) throw new Error(`${id} 目录未声明思考档位（不支持逐模型调节）`)
    if (typeof prefs.effort !== 'string' || !allowed.includes(prefs.effort)) {
      throw new Error(`effort 必须是该模型目录声明的档位（${allowed.join('/')}）`)
    }
  }
  const layer = readFileLayer()
  const state = layer.traeModelPrefs && typeof layer.traeModelPrefs === 'object' && !Array.isArray(layer.traeModelPrefs)
    ? { ...layer.traeModelPrefs } : {}
  const rec = {}
  if (prefs.effort !== undefined) rec.effort = prefs.effort
  if (Object.keys(rec).length) state[id] = rec
  else delete state[id]
  layer.traeModelPrefs = state
  writeFileLayer(layer)
  await syncTraeModelsToDshSettings()
}

/**
 * 镜像 providers.trae **整块**（0.8.7 / dsh 0.1.1-rc.2 适配，取代"恒铺
 * models 路径 + 空数组遮蔽"）：llm-pi-ai 收紧了目录校验——非目录路由的空
 * models 清单在 apply 时直接 throw（连坐整棵 llm-pi-ai 纤维，主聊天全挂），
 * 热加载路径也被 onChange 拒绝并保持旧值，"空数组遮蔽"彻底失效（踩坑 #25
 * 修订）。新策略 = **路由存在性管理**：patch 不再带 trae 静态基线，镜像独占
 * 该路由的完整定义——
 *   启用+已同步 → 铺完整块（displayName/api/baseURL/headers/models），
 *     baseURL 跟随 traeBridgePort（改端口重铺镜像即热生效，优于旧 patch 静态式）；
 *   禁用/未同步/全部模型禁用 → 删除 providers.trae 整块（路由消失，选择器
 *     隐藏通道，免重启：0.1.7+ 经 forms seam 落 profile patch 即时生效，
 *     ≤0.1.6 靠 settings.yaml 的 chokidar 热加载）。无 patch 基线即无回落，
 *     删块即干净。
 * 升级注意：<=0.8.5 写的 trae 块只带 models 路径（其余字段靠 patch 深合并），
 * 重启前须先清掉旧块（见 cordis.patch.yml 的 UPGRADE NOTE）。
 */
export async function syncTraeModelsToDshSettingsImpl() {
  try {
    // 端口同源 effectiveSettingsFn（镜像与 listen 一次解析；注释「entry 侧无
    // trae 字段，schema 默认补齐」指纯文件层路径，resolveNow 本身已含 entry 层）。
    const s = settingsRef.effective ? settingsRef.effective() : Config({ ...readFileLayer() })
    const view = traeProvider.catalogView()
    const disabled = readTraeModelState().disabled
    const models = s.traeEnabled === true && view
      ? view.profiles.filter((p) => !disabled[p.id])
      : null
    const path = ['providers', 'trae']
    if (!models || models.length === 0) return await hostConfig.applyOps([{ op: 'unset', path }])
    const block = {
      displayName: 'TraeWork CN',
      api: 'openai-completions',
      baseURL: `http://127.0.0.1:${s.traeBridgePort}/v1`,
      headers: { Authorization: 'Bearer dsh-trae-bridge' },
      // 宿主 Model/Effort 选择器出档的两前提（同 qoder 镜像纪律，踩坑 #64）：
      // 路由声明 compat.supportsReasoningEffort（否则 pi-ai 出站不写
      // reasoning_effort）+ 档位表已投影进 models[].reasoningEfforts
      //（catalogToProfiles 从目录 reasoning_effort_config 投影）。
      // thinkingFormat 钉 openai 防 pi-ai 从 127.0.0.1 猜方言。
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
      // Trae 没有排队态：任何失败直接结束（不重试），由宿主 turn-error 显示文本。
      retryPolicy: NO_CHANNEL_RETRY_POLICY,
      models: YAML.parse(YAML.stringify(models)),
    }
    return await hostConfig.applyOps([{ op: 'set', path, value: block }])
  } catch (err) {
    const d = describeError(err, { fallback: 'trae mirror failed' })
    process.stderr.write(`[dsh-tap] trae mirror failed: ${d.message}\n`)
    return { ok: false, error: d.message }
  }
}

/**
 * 安全审计 [18]：state.vscdb 路径纵深防御（CSRF 已被 settings 路由本地门
 * 挡住，这里是第二道）。规则：绝对路径、规范化后不含 .. 段、扩展名限
 * .db/.vscdb。不校验存在性——不存在的路径沿用既有同步错误路径报错。
 */
export function isSafeStateDbPath(p) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return false
  const normalized = normalize(p)
  if (normalized.split(/[\\/]/).includes('..')) return false
  const ext = extname(normalized).toLowerCase()
  return ext === '.db' || ext === '.vscdb'
}

export async function setTraeModelEnabled({ id, enabled }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('traeModelSetEnabled 需要 id')
  assertSafeModelId(id)
  const view = traeProvider.catalogView()
  if (!view || !view.profiles.some((p) => p.id === id)) throw new Error(`${id} 不在 Trae 目录里（先同步目录）`)
  const layer = readFileLayer()
  const state = readTraeModelState()
  if (enabled) delete state.disabled[id]
  else state.disabled[id] = true
  layer.traeModelState = state
  writeFileLayer(layer)
  await syncTraeModelsToDshSettings()
  return state
}

// ---------------------------------------------------------------------------
// Bridge runtime state (module-level, shared across apply() generations —
// production runs one plugin instance per process, so last-apply-wins is
// correct; scripts/verify-bridge.mjs §10 pins the semantics).
// ---------------------------------------------------------------------------

/** qoder 镜像入口（记账走 mirror.trackMirror，失败落 GET 的 `mirror` 字段）。 */
export async function syncQoderModelsToDshSettings() {
  return trackMirror('qoder', () => syncQoderModelsToDshSettingsImpl())
}

/** trae 镜像入口（同上）。 */
export async function syncTraeModelsToDshSettings() {
  return trackMirror('trae', () => syncTraeModelsToDshSettingsImpl())
}

