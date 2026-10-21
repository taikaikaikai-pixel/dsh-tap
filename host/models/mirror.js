/**
 * host/models/mirror.js — **镜像**：把有效模型清单写进宿主配置层（0.25.0 从 index.js 拆出）。
 *
 * 三条镜像面（codebuddy/trae/qoder 各一块 `llm-pi-ai.providers.<id>.models`）与
 * 两个写者（启用/禁用模型、目录同步）都在这里。设计要点：
 *
 *  - **纯净态纪律**：没有任何 disabled/extra/overrides 且无动态目录时，镜像块要
 *    *删除*而不是写空表——陈旧覆盖会遮蔽 patch 层的后续更新（踩坑 #6）；
 *  - **空清单绝不落盘**：llm-pi-ai 对空 models 直接拒绝整层，选择器会整个消失；
 *  - **成败记账**（`mirrorState` → GET 的 `mirror` 字段）：镜像失败以前只有 stderr
 *    一行，卡片照样显示「已保存 ✓」（踩坑 #66 的复发面，0.23.0 起可见）。
 */

import { describeError } from '../../core/errors.js'
import { Config, readFileLayer, writeFileLayer, hostConfig, settingsRef } from '../config.js'
import {
  readModelState, computeBaseModels, computeEffectiveModels, readStaticModels,
  catalogToProfile, creditsFromCatalog, setOfficialCredits, getDynamicCatalog, setDynamicCatalog,
  assertSafeModelId,
} from './state.js'
import { provider, NO_CHANNEL_RETRY_POLICY } from '../providers/instances.js'
import { writeProviderBlock } from '../providers/registry.js'

export const mirrorState = { codebuddy: null, qoder: null, trae: null }

/** @returns {{codebuddy: object|null, qoder: object|null, trae: object|null}} */
export function readMirrorState() {
  return { ...mirrorState }
}

/** 跑一次镜像并记账；镜像本身不抛（实现内部已 catch），失败只改台账。 */
export async function trackMirror(channel, run) {
  let result
  try {
    result = await run()
  } catch (err) {
    mirrorState[channel] = { ok: false, at: Date.now(), error: describeError(err, { fallback: 'mirror failed' }).message }
    throw err
  }
  if (result && result.ok === false) {
    mirrorState[channel] = { ok: false, at: Date.now(), error: String(result.error ?? 'unknown') }
  } else {
    mirrorState[channel] = { ok: true, at: Date.now(), error: null }
  }
  return result
}

export async function syncModelsToDshSettings() {
  return trackMirror('codebuddy', () => syncModelsToDshSettingsImpl())
}

/**
 * Mirror the effective model list into the host config layer under
 * llm-pi-ai.providers.codebuddy.models (the user-layer override over the
 * patch layer). dsh 0.1.7+ 走 Settings forms（volatile 字段，写 profile
 * patch 即时生效）；旧宿主走注释保留的 settings.yaml 文档编辑。
 * When the state is pristine (nothing disabled, no extras) AND no dynamic
 * catalog is synced, the override is REMOVED instead — a stale override would
 * shadow future patch updates. G4: a synced dynamic catalog intentionally keeps
 * the override non-pristine (the list follows the gateway, refreshed every boot).
 */
export async function syncModelsToDshSettingsImpl() {
  try {
    const state = readModelState()
    const pristine = Object.keys(state.disabled).length === 0
      && Object.keys(state.extra).length === 0
      && Object.keys(state.overrides ?? {}).length === 0
      && getDynamicCatalog() == null
    const path = ['providers', 'codebuddy', 'models']
    // retryPolicy 与 models 同批写：桌面宿主 profile 的用户层 codebuddy 块是
    // hand-placed 完整块（踩坑 #54），bundle patch 的 retryPolicy 进不去；
    // 写用户层才是两条 profile 都可靠的落点。maxRetries:0 ⇒ 不重试。
    const retryOp = { op: 'set', path: ['providers', 'codebuddy', 'retryPolicy'], value: NO_CHANNEL_RETRY_POLICY }
    if (pristine) return await hostConfig.applyOps([retryOp, { op: 'unset', path }])
    const next = computeEffectiveModels()
    // Defensive (0.8.7): an empty effective list must never be mirrored —
    // llm-pi-ai (dsh 0.1.1-rc.2+) rejects it at apply time. setModelEnabled
    // guards the last model already; this fallback drops the override (the
    // patch static list then serves) instead of poisoning the namespace.
    if (next.length === 0) return await hostConfig.applyOps([retryOp, { op: 'unset', path }])
    return await hostConfig.applyOps([retryOp, { op: 'set', path, value: next }])
  } catch (err) {
    const d = describeError(err, { fallback: 'model mirror failed' })
    process.stderr.write(`[dsh-tap] model mirror failed: ${d.message}\n`)
    return { ok: false, error: d.message }
  }
}

/** Apply one enable/disable toggle and sync the effective list. */
export async function setModelEnabled({ id, enabled, profile }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('modelSetEnabled 需要 id')
  assertSafeModelId(id)
  const layer = readFileLayer()
  const state = readModelState()
  // G4：基清单 = 静态 ∪ 动态目录。基清单内的模型启停只动 disabled 标记，
  // 不写 extra（否则状态永远非纯净，且与动态基重复）。
  const isBase = computeBaseModels().some((m) => m.id === id)
  if (enabled) {
    delete state.disabled[id]
    if (!isBase) {
      if (!profile || typeof profile !== 'object') {
        throw new Error('启用目录新增模型需要 profile（来自模型列表条目）')
      }
      // 宿主 models[] schema 要求 contextWindow/maxTokens 为正整数。目录没声明时
      // 客户端此前用 262144/32768 编造——那是把"不知道"写成两个权威数字落进宿主
      // 路由。这里做第二道校验：缺值或非正整数一律拒绝，绝不代填。
      for (const key of ['contextWindow', 'maxTokens']) {
        const v = profile[key]
        if (!Number.isInteger(v) || v <= 0) {
          throw new Error(`启用该模型需要确定的正整数 ${key}（目录未声明时不得编造上限）`)
        }
      }
      state.extra[id] = profile
    }
  } else {
    // Guard (0.8.7): disabling the LAST effective model would mirror an
    // empty models list into settings.yaml, which llm-pi-ai (dsh 0.1.1-rc.2+)
    // rejects at apply time — taking down the whole llm-pi-ai fiber and
    // with it the main chat. Keep at least one servable model.
    const effective = computeEffectiveModels()
    if (effective.length <= 1 && effective.some((m) => m.id === id)) {
      throw new Error('不能禁用最后一个模型：dsh 0.1.1-rc.2 起 llm-pi-ai 拒绝空模型清单（整域不可用）')
    }
    // Base ids need an explicit disabled mark; a catalog extra simply
    // drops out of the extras map — marking it disabled would keep the
    // state non-pristine (and the settings override) forever.
    if (isBase) state.disabled[id] = true
    delete state.extra[id]
  }
  layer.modelState = state
  writeFileLayer(layer)
  await syncModelsToDshSettings()
  return state
}

/**
 * G5：设置/清除单模型上下文与输出上限覆盖值。字段值为 null = 清除该字段
 * 覆盖（回目录/静态基值）。覆盖值必须是正整数，且不得超过基清单（目录或
 * 静态 profile）给定的该模型实际上限；基清单无尺寸信息时不设上限。
 * 覆盖经 computeEffectiveModels 即时重铺 settings.yaml，下次请求生效。
 */
export async function setModelLimits({ id, contextWindow, maxTokens }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('modelSetLimits 需要 id')
  assertSafeModelId(id)
  const base = computeBaseModels().find((m) => m.id === id)
    ?? readModelState().extra[id]
    ?? null
  const check = (v, ceiling, label) => {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${label}必须是正整数`)
    if (ceiling != null && v > ceiling) {
      throw new Error(`${label}超出该模型实际上限 ${ceiling}`)
    }
    return v
  }
  const layer = readFileLayer()
  const state = readModelState()
  const o = { ...(state.overrides[id] || {}) }
  if (contextWindow === null) delete o.contextWindow
  else if (contextWindow !== undefined) o.contextWindow = check(contextWindow, base?.contextWindow, '上下文长度')
  if (maxTokens === null) delete o.maxTokens
  else if (maxTokens !== undefined) o.maxTokens = check(maxTokens, base?.maxTokens, '输出上限')
  if (Object.keys(o).length) state.overrides[id] = o
  else delete state.overrides[id]
  layer.modelState = state
  writeFileLayer(layer)
  await syncModelsToDshSettings()
  return state
}

/**
 * G4：从 /v3/config 同步模型清单（启动自动 + 设置卡手动刷新共用，单飞）。
 * 成功：dynamicCatalog 换新并重铺 settings.yaml 镜像（选择器跟网关走）。
 * 失败：已有动态目录时保留（重铺它，选择器不掉模型）；否则回落静态清单
 * 并按纯净态纪律清理镜像——任何失败都不让选择器变空。
 */
export let modelSyncInFlight = null
export function syncModelsFromGateway(resolveNow) {
  if (modelSyncInFlight) return modelSyncInFlight
  modelSyncInFlight = (async () => {
    try {
      const catalog = await provider.catalog.fetchModelCatalog(resolveNow)
      const profiles = catalog.models.map(catalogToProfile)
      if (!profiles.length) throw new Error('网关目录为空（保持现有清单）')
      setDynamicCatalog({ profiles, fetchedAt: catalog.fetchedAt, count: profiles.length })
      // 官方倍率只喂展示通道（设置卡 + 输入框选择器），不进 profiles/镜像。
      setOfficialCredits(creditsFromCatalog(catalog.models))
      await syncModelsToDshSettings()
      const synced = getDynamicCatalog()
      return { ok: true, fetchedAt: synced.fetchedAt, count: synced.count, source: 'gateway' }
    } catch (err) {
      // kept=false → dynamicCatalog 为 null，sync 落静态清单 + 纯净态纪律；
      // kept=true  → 以旧动态目录重铺（选择器不因一次拉取失败掉模型）。
      const kept = getDynamicCatalog() != null
      await syncModelsToDshSettings()
      return { ok: false, error: err?.message ?? String(err), kept, source: kept ? 'gateway-stale' : 'static' }
    } finally {
      modelSyncInFlight = null
    }
  })()
  return modelSyncInFlight
}

// ---------------------------------------------------------------------------
// G6 多服务商注册表：key 型 OpenAI 兼容上游（preset 见下 + 自定义）。
// 机制与官方 CustomProviderCard 相同：provider 块写**宿主配置层**的
// llm-pi-ai.providers.<id>（dsh 0.1.7+ = Settings forms seam，落 profile 的
// cordis.patch.yml 即时生效；≤0.1.6 = ~/.dsh/settings.yaml，chokidar 热加载），
// 选路细节全在 host-config.js；key 写 ~/.dsh/.credentials.yaml 的
// <ID>_API_KEY（凭据缝每请求活解析，免重启）。
// 插件文件层只存登记册 managedProviders（无 secret）；key 永不回传浏览器。
// 纪律：写块前必过 validateProviderSpec + 实测 GET /models——llm-pi-ai
// 命名空间解析失败会整域冻结（dsh-settings publish catch），坏块连坐
// codebuddy 路由。
// ---------------------------------------------------------------------------
