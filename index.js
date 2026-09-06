/**
 * dsh-tap — composition root.
 *
 * Three layers:
 *
 * 1. cordis.patch.yml — static config: the codebuddy provider route on the
 *    `llm-pi-ai` row (pointed at the loopback bridge below, so the main
 *    chat path shares this module's credential resolution), the default
 *    model on `agent-default-model`, the provider pins on the `web` row,
 *    and the entry-list `insert` that makes the loader run this module at all.
 * 2. This module — composition + runtime registration. The provider-agnostic
 *    machinery lives in core/ (json-store / rotation / usage-meter / bridge);
 *    every CodeBuddy gateway fact lives in providers/codebuddy/ (headers,
 *    error codes, OAuth flow, catalog/quota dialect, agenttool, images) —
 *    adjudicated per-field by docs/rules/*.md. This file wires them together:
 *    backs dsh's stock `web_search` / `web_fetch` tools with the gateway's
 *    /agenttool endpoints, and runs the loopback stream bridge for tools that
 *    need classic non-streaming OpenAI JSON (the gateway is stream-only,
 *    error 11101). The bridge owns ALL credential resolution (OAuth or API
 *    key) — callers (llm-pi-ai's chat path included) send a sentinel
 *    Authorization the bridge replaces per request. It also meters every
 *    billed request (usage.credit + cache counters →
 *    ~/.dsh/codebuddy-plugin-usage.json) for the settings card.
 * 3. lib/client.js — browser half: a settings card in Settings → 插件配置.
 *
 * 官方缝使用说明（红线：能用 ctx.credentials / ctx.llm / ctx.web 的地方不自建）：
 * - ctx.web：已用（搜索/抓取后端经 registerSearchProvider/registerFetchProvider）。
 * - ctx.credentials：不能用——主聊天经 patch 指向本地桥，pi-ai 侧只认静态哨兵
 *   Authorization（机制见 docs/pitfalls.md #11）；每请求的多 Key 轮询/冷却/failover
 *   与 OAuth 刷新必须在桥内完成，宿主凭据缝无法覆盖这条路径，故凭据解析自建于此。
 * - ctx.llm：未用——桥是传输层代理不是模型提供方，模型清单走 cordis.patch.yml。
 *
 * Config surface (Settings → 插件配置 → CodeBuddy, file-backed in
 * ~/.dsh/codebuddy-plugin.json): login mode (multiple API keys with an
 * active selection, or CodeBuddy browser OAuth), gateway baseURL, search
 * and fetch knobs, and the stream bridge switch/port. Values apply live.
 *
 * Credentials:
 * - api-key mode: the active entry of `apiKeys` (fallback: the legacy
 *   `apiKeyEnv` env/credentials.yaml reference).
 * - oauth mode: tokens from the browser handshake (state → login → token
 *   polling → account), stored separately in ~/.dsh/codebuddy-plugin-auth.json
 *   so the settings GET never carries secrets; access tokens auto-refresh
 *   via the refresh token with a single-flight lock.
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import z from '@deepseek-ai/schemastery'

import { readJson, writeJson, resolveEnvKey } from './core/json-store.js'
import { KeyRotator } from './core/rotation.js'
import { createUsageMeter } from './core/usage-meter.js'
import { createBridge } from './core/bridge.js'
import { createCodeBuddyProvider } from './providers/codebuddy/index.js'
import { CREDENTIAL_UNAVAILABLE_MESSAGE } from './providers/codebuddy/errors.js'
import { createTraeProvider } from './providers/trae/index.js'
import { TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE } from './providers/trae/errors.js'
import { PROVIDER_ID_RE, createOpenAICompatProvider } from './providers/openai-compat.js'
import { scanLocalCredentials, readImportCredential } from './local-scan.js'
import arkProvider from './providers/ark/index.js'
import bailianProvider from './providers/bailian/index.js'
import iflowProvider from './providers/iflow/index.js'
import qwenProvider from './providers/qwen/index.js'

export const name = 'dsh-tap'

/** web providers via ctx.web; the settings route rides ctx.webServer when present. */
export const inject = ['web']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SETTINGS_PATH = join(DSH_HOME, 'codebuddy-plugin.json')
const AUTH_PATH = join(DSH_HOME, 'codebuddy-plugin-auth.json')
const TRAE_AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const DSH_SETTINGS_PATH = join(DSH_HOME, 'settings.yaml')
const DSH_CREDENTIALS_PATH = join(DSH_HOME, '.credentials.yaml')
const PATCH_FILE = join(dirname(fileURLToPath(import.meta.url)), 'cordis.patch.yml')

/**
 * Optional settings. Schema defaults apply when neither the composition
 * entry nor the settings file sets a field.
 */
export const Config = z.object({
  authMode: z.union([z.const('api-key'), z.const('oauth')]).default('api-key'),
  apiKeyEnv: z.string().role('credential-ref').default('CODEBUDDY_API_KEY'),
  apiKeys: z.array(z.object({
    name: z.string(),
    key: z.string().role('secret'),
  })).default([]),
  activeApiKey: z.string(),
  searchEnabled: z.boolean().default(true),
  baseURL: z.string().default('https://copilot.tencent.com'),
  searchMaxResults: z.number().step(1).min(1).max(20).default(5),
  fetchBodyCap: z.number().step(1000).min(1000).default(200000),
  bridgeEnabled: z.boolean().default(true),
  bridgePort: z.number().step(1).min(1).max(65535).default(3901),
  sessionHeadersEnabled: z.boolean().default(true),
  sessionHeaderFormat: z.union([z.const('openai'), z.const('openrouter')]).default('openai'),
  maxConcurrentPerSession: z.number().step(1).min(1).max(100).default(4),
  imageGenEnabled: z.boolean().default(true),
  imageGenModel: z.string().default('hunyuan-image-v3.0-art'),
  keyCooldownMs: z.number().step(100).min(100).default(60000),
  // G3 估算档：api-key 模式下用户手填的总额度（credit），卡片显示
  // 「手填总额 − 本插件计量累计」并标注"估算"；0 = 未设置。OAuth 模式不用
  // （真实数值来自 /billing/meter/get-user-resource，quota-signals.md R-Q7）。
  quotaTotalManual: z.number().min(0).default(0),
  // ---- TraeWork CN（Trae 订阅额度通道，v0.8.x）----
  // 默认关闭：开启后同步本机 state.vscdb 模型目录到选择器（providers.trae），
  // 并在 traeBridgePort 上启动 OpenAI↔Trae 翻译网关；主聊天经 patch 的 trae
  // 路由（哨兵 Authorization）走该网关消耗 Trae 订阅额度。
  traeEnabled: z.boolean().default(false),
  traeAuthBaseURL: z.string().default('https://api.trae.cn'),
  traeChatBaseURL: z.string().default('https://trae-api-cn.mchost.guru'),
  traeLoginHost: z.string().default('https://www.trae.cn'),
  traeBridgePort: z.number().step(1).min(1).max(65535).default(3902),
  // 聊天传输：inline（默认，llm_utils_chat+inline_chat——模型恒为账户默认，
  // 原生 tools，耗 IDE 额度池）| remote（chat_sessions——模型选择真实生效，
  // 不支持 tools，每请求起云端沙箱 agent，耗 work 额度池）。2026-08-24 探测
  // 定论见 providers/trae/remote.js 文件头。
  traeChatTransport: z.union([z.const('inline'), z.const('remote')]).default('inline'),
  // inline 上游首字节护栏（毫秒）：边缘/本地代理"收下请求不回应"时快速失败，
  // 避免用户请求无限挂死（2026-08-24 故障取证 docs/diagnosis-trae-3003.md §8）。
  // 仅约束响应头到达前；SSE 长流在头到达后不受影响。
  upstreamFirstByteTimeoutMs: z.number().step(1).min(1000).max(300_000).default(45_000),
})

/** Field metadata the settings card renders (labels live client-side). */
export const SETTINGS_FIELDS = [
  { key: 'authMode', kind: 'select' },
  { key: 'apiKeyEnv', kind: 'text' },
  { key: 'apiKeys', kind: 'keys' },
  { key: 'activeApiKey', kind: 'text' },
  { key: 'searchEnabled', kind: 'boolean' },
  { key: 'baseURL', kind: 'text' },
  { key: 'searchMaxResults', kind: 'number' },
  { key: 'fetchBodyCap', kind: 'number' },
  { key: 'bridgeEnabled', kind: 'boolean' },
  { key: 'bridgePort', kind: 'number' },
  { key: 'sessionHeadersEnabled', kind: 'boolean' },
  { key: 'sessionHeaderFormat', kind: 'select' },
  { key: 'maxConcurrentPerSession', kind: 'number' },
  { key: 'imageGenEnabled', kind: 'boolean' },
  { key: 'imageGenModel', kind: 'text' },
  { key: 'keyCooldownMs', kind: 'number' },
  { key: 'quotaTotalManual', kind: 'number' },
  { key: 'traeEnabled', kind: 'boolean' },
  { key: 'traeAuthBaseURL', kind: 'text' },
  { key: 'traeChatBaseURL', kind: 'text' },
  { key: 'traeLoginHost', kind: 'text' },
  { key: 'traeBridgePort', kind: 'number' },
  { key: 'traeChatTransport', kind: 'select' },
  { key: 'upstreamFirstByteTimeoutMs', kind: 'number' },
]

/**
 * Hostnames that count as "this machine" for the local-only HTTP surfaces
 * (bridge Host gate, settings-route guard, plaintext-http baseURLs).
 * `::1` (bare) is accepted for raw Host values; a URL-parsed IPv6 hostname
 * keeps its brackets (`[::1]`).
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Parse a Host header (may carry a port) into a bare hostname, or null. */
function hostHeaderHostname(host) {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/** True when the URL hostname is loopback (plaintext http allowance). */
function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/** Validate a baseURL candidate before it can reach a provider. */
function validateBaseURL(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('baseURL 必须是绝对 http(s) 地址')
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol !== 'http:') {
    throw new Error('baseURL 必须使用 http 或 https')
  }
  // 安全审计 [29]：明文 http 仅限回环——本插件的本地桥都绑 127.0.0.1；
  // 指向远程明文端点会把 Bearer 凭据裸奔上网络。https 恒可。
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `baseURL 明文 http 仅允许回环地址（127.0.0.1/localhost/::1），收到 ${parsed.hostname}——远程上游必须使用 https`,
    )
  }
}

const readFileLayer = () => readJson(SETTINGS_PATH)
const writeFileLayer = (section) => writeJson(SETTINGS_PATH, section)
const readAuth = () => readJson(AUTH_PATH)
const writeAuth = (v) => writeJson(AUTH_PATH, v)

// ---------------------------------------------------------------------------
// Model management: the patch supplies a static 18-model base; the user's
// enable/disable state (and catalog additions) live in the settings file as
// `modelState`, and the effective list is mirrored into ~/.dsh/settings.yaml
// under llm-pi-ai.providers.codebuddy.models — the settings-driven override
// the model picker honors on the next request (no restart).
// ---------------------------------------------------------------------------

/** Parse the static model profiles from cordis.patch.yml (single source of truth). */
function readStaticModels() {
  try {
    const rows = YAML.parse(readFileSync(PATCH_FILE, 'utf8'))
    const row = Array.isArray(rows) ? rows.find((r) => r?.id === 'llm-pi-ai') : null
    const models = row?.config?.providers?.codebuddy?.models
    return Array.isArray(models) ? models.filter((m) => typeof m?.id === 'string') : []
  } catch {
    return []
  }
}

function readModelState() {
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
function assertSafeModelId(id) {
  const unsafe = /(?:^|[.[\]])+(?:__proto__|constructor|prototype)(?:$|[.[\]])+/.test(id)
  if (unsafe) {
    throw new Error(`非法模型 id（保留键 ${JSON.stringify(id)} 拒绝写入）`)
  }
}

/** Effective models = static base + enabled catalog extras − disabled ids. */
/**
 * G4 动态目录：启动时（及设置卡手动刷新）从 /v3/config 同步的模型清单。
 * null = 未同步或同步失败（离线兜底 = 静态清单，computeEffectiveModels 回落）。
 * 实例状态：模块作用域每插件实例一份（踩坑 #20 纪律同 rotator/meter）。
 */
let dynamicCatalog = null // { profiles: [...], fetchedAt, count }

/** 目录条目 → 模型 profile（目录只给尺寸/图像/默认档位，不给档位清单）。 */
function catalogToProfile(m) {
  const p = { id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id }
  if (m.maxInputTokens != null) p.contextWindow = m.maxInputTokens
  if (m.maxOutputTokens != null) p.maxTokens = m.maxOutputTokens
  if (m.images === true) p.input = ['text', 'image']
  return p
}

/**
 * 动态基清单 = 目录 ∪ 静态：目录条目刷新同名静态条目的名称/尺寸/图像能力
 * （静态的 reasoningEfforts 档位表保留——目录没有该信息）；纯静态 id 保留
 * （目录与可路由性三方互斥，routing.md R-R3：deepseek-v3 不在目录但可用，
 * 而 agent-default-model 钉的正是它——盲从目录会把默认模型弄丢）。
 */
function computeBaseModels() {
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

function computeEffectiveModels() {
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

/**
 * Mirror the effective model list into ~/.dsh/settings.yaml under
 * llm-pi-ai.providers.codebuddy.models (the settings-driven override over the
 * patch layer). Uses a comment-preserving YAML document edit. When the state
 * is pristine (nothing disabled, no extras) AND no dynamic catalog is synced,
 * the override is REMOVED instead — a stale settings list would shadow future
 * patch updates. G4: a synced dynamic catalog intentionally keeps the override
 * non-pristine (the list follows the gateway, refreshed every boot).
 */
function syncModelsToDshSettings() {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_SETTINGS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  const state = readModelState()
  const pristine = Object.keys(state.disabled).length === 0
    && Object.keys(state.extra).length === 0
    && Object.keys(state.overrides ?? {}).length === 0
    && dynamicCatalog == null
  const path = ['llm-pi-ai', 'providers', 'codebuddy', 'models']
  if (pristine) {
    if (!doc.getIn(path)) return false
    doc.deleteIn(path)
    writeFileSync(DSH_SETTINGS_PATH, String(doc))
    return true
  }
  const next = YAML.parse(YAML.stringify(computeEffectiveModels()))
  const current = doc.getIn(path)
  // Defensive (0.8.7): an empty effective list must never be mirrored —
  // llm-pi-ai (dsh 0.1.1-rc.2+) rejects it at apply time. setModelEnabled
  // guards the last model already; this fallback drops the override (the
  // patch static list then serves) instead of poisoning the namespace.
  if (next.length === 0) {
    if (!doc.getIn(path)) return false
    doc.deleteIn(path)
    writeFileSync(DSH_SETTINGS_PATH, String(doc))
    return true
  }
  if (YAML.stringify(current ?? null) === YAML.stringify(next)) return false
  doc.setIn(path, next)
  writeFileSync(DSH_SETTINGS_PATH, String(doc))
  return true
}

/** Apply one enable/disable toggle and sync the effective list. */
function setModelEnabled({ id, enabled, profile }) {
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
  syncModelsToDshSettings()
  return state
}

/**
 * G5：设置/清除单模型上下文与输出上限覆盖值。字段值为 null = 清除该字段
 * 覆盖（回目录/静态基值）。覆盖值必须是正整数，且不得超过基清单（目录或
 * 静态 profile）给定的该模型实际上限；基清单无尺寸信息时不设上限。
 * 覆盖经 computeEffectiveModels 即时重铺 settings.yaml，下次请求生效。
 */
function setModelLimits({ id, contextWindow, maxTokens }) {
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
  syncModelsToDshSettings()
  return state
}

/**
 * G4：从 /v3/config 同步模型清单（启动自动 + 设置卡手动刷新共用，单飞）。
 * 成功：dynamicCatalog 换新并重铺 settings.yaml 镜像（选择器跟网关走）。
 * 失败：已有动态目录时保留（重铺它，选择器不掉模型）；否则回落静态清单
 * 并按纯净态纪律清理镜像——任何失败都不让选择器变空。
 */
let modelSyncInFlight = null
function syncModelsFromGateway(resolveNow) {
  if (modelSyncInFlight) return modelSyncInFlight
  modelSyncInFlight = (async () => {
    try {
      const catalog = await provider.catalog.fetchModelCatalog(resolveNow)
      const profiles = catalog.models.map(catalogToProfile)
      if (!profiles.length) throw new Error('网关目录为空（保持现有清单）')
      dynamicCatalog = { profiles, fetchedAt: catalog.fetchedAt, count: profiles.length }
      syncModelsToDshSettings()
      return { ok: true, fetchedAt: dynamicCatalog.fetchedAt, count: dynamicCatalog.count, source: 'gateway' }
    } catch (err) {
      // kept=false → dynamicCatalog 为 null，sync 落静态清单 + 纯净态纪律；
      // kept=true  → 以旧动态目录重铺（选择器不因一次拉取失败掉模型）。
      const kept = dynamicCatalog != null
      syncModelsToDshSettings()
      return { ok: false, error: err?.message ?? String(err), kept, source: kept ? 'gateway-stale' : 'static' }
    } finally {
      modelSyncInFlight = null
    }
  })()
  return modelSyncInFlight
}

// ---------------------------------------------------------------------------
// G6 多服务商注册表：key 型 OpenAI 兼容上游（火山 ark / 阿里百炼 / 自定义）。
// 机制与官方 CustomProviderCard 相同：provider 块写 settings.yaml 的
// llm-pi-ai.providers.<id>（chokidar 热加载、原地换路由，免重启），key 写
// ~/.dsh/.credentials.yaml 的 <ID>_API_KEY（凭据缝每请求活解析，免重启）。
// 插件文件层只存登记册 managedProviders（无 secret）；key 永不回传浏览器。
// 纪律：写块前必过 validateProviderSpec + 实测 GET /models——llm-pi-ai
// 命名空间解析失败会整域冻结（dsh-settings publish catch），坏块连坐
// codebuddy 路由。
// ---------------------------------------------------------------------------

const PROVIDER_PRESETS = [arkProvider, bailianProvider, iflowProvider, qwenProvider]

function readManagedProviders() {
  const list = readFileLayer().managedProviders
  if (!Array.isArray(list)) return []
  return list.filter((p) => p && typeof p.id === 'string' && typeof p.keyRef === 'string')
}

function writeManagedProviders(list) {
  const layer = readFileLayer()
  if (list.length) layer.managedProviders = list
  else delete layer.managedProviders
  writeFileLayer(layer)
}

/** ~/.dsh/.credentials.yaml 写入（dsh-credentials-local 要求文件 0600）。 */
function writeCredential(ref, value) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_CREDENTIALS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  doc.set(ref, value)
  writeFileSync(DSH_CREDENTIALS_PATH, String(doc))
  chmodSync(DSH_CREDENTIALS_PATH, 0o600)
}

function deleteCredential(ref) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_CREDENTIALS_PATH, 'utf8'))
  } catch {
    return
  }
  if (doc.delete(ref)) writeFileSync(DSH_CREDENTIALS_PATH, String(doc))
}

function readSettingsProviders() {
  try {
    return YAML.parse(readFileSync(DSH_SETTINGS_PATH, 'utf8'))?.['llm-pi-ai']?.providers ?? {}
  } catch {
    return {}
  }
}

/** 写/删（block=null）llm-pi-ai.providers.<id>，注释保留的 YAML 文档编辑。 */
function writeProviderBlock(id, block) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_SETTINGS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  const path = ['llm-pi-ai', 'providers', id]
  if (block === null) {
    if (!doc.getIn(path)) return
    doc.deleteIn(path)
  } else {
    doc.setIn(path, YAML.parse(YAML.stringify(block)))
  }
  writeFileSync(DSH_SETTINGS_PATH, String(doc))
}

/**
 * 添加上游：本地校验 → 实测 GET /models（验 key 兼拿目录）→ 写凭据 →
 * 写 provider 块 → 登记。任何一步失败都不留半成品（凭据先写是因为
 * 可服务性校验不查凭据，块后写保证热加载看到的是完整配置）。
 */
async function addExtraProvider({ preset, id, baseURL, displayName, apiKey }) {
  let adapter
  let presetId = null
  if (preset != null) {
    const found = PROVIDER_PRESETS.find((p) => p.id === preset)
    if (!found) throw new Error(`未知 preset：${preset}`)
    adapter = found
    presetId = found.id
  } else {
    if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
      throw new Error('id 必须小写字母/数字开头（小写字母、数字、中划线）')
    }
    if (typeof baseURL !== 'string') throw new Error('需要 baseURL')
    validateBaseURL(baseURL)
    adapter = createOpenAICompatProvider({
      id,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : id,
      baseURL: baseURL.replace(/\/+$/, ''),
    })
  }
  const pid = adapter.id
  if (pid === 'codebuddy') throw new Error('codebuddy 是本插件保留路由')
  if (readManagedProviders().some((p) => p.id === pid)) throw new Error(`${pid} 已在注册表里`)
  if (readSettingsProviders()[pid]) throw new Error(`settings.yaml 已存在 ${pid} 提供商（先手动清理或换 id）`)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('需要 API Key')
  const key = apiKey.trim()
  // 实测目录：key/URL 错误在这里就炸，不落任何文件。
  const models = await adapter.fetchModels(key)
  writeCredential(adapter.keyRef, key)
  writeProviderBlock(pid, adapter.modelBlock(models))
  writeManagedProviders(readManagedProviders().concat([{
    id: pid,
    displayName: adapter.displayName,
    baseURL: adapter.baseURL,
    preset: presetId ?? 'custom',
    keyRef: adapter.keyRef,
    addedAt: Date.now(),
  }]))
  return { id: pid, modelCount: models.length }
}

/** 移除上游：删块 + 删凭据 + 出登记册（外部已删块也照常清理）。 */
function removeExtraProvider(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  writeProviderBlock(id, null)
  deleteCredential(entry.keyRef)
  writeManagedProviders(readManagedProviders().filter((p) => p.id !== id))
}

/** 重新拉取模型清单（key 从 .credentials.yaml 活解析）。 */
async function refreshExtraProviderModels(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  const key = resolveEnvKey(entry.keyRef, DSH_CREDENTIALS_PATH)
  if (!key) throw new Error(`凭据 ${entry.keyRef} 不在环境或 .credentials.yaml 里`)
  // preset 条目带上 fallbackModels：无 /models 的上游刷新 = 探针复验 + 沿用兜底清单。
  const presetHit = PROVIDER_PRESETS.find((p) => p.id === entry.preset)
  const adapter = createOpenAICompatProvider({ ...entry, fallbackModels: presetHit?.fallbackModels })
  const models = await adapter.fetchModels(key)
  writeProviderBlock(id, adapter.modelBlock(models))
  return { id, modelCount: models.length }
}

/** 设置卡视图：登记册 × settings.yaml 实况对账（外部删块 → 自动出册）。 */
function extraProvidersView() {
  const providers = readSettingsProviders()
  const stale = []
  const list = []
  for (const p of readManagedProviders()) {
    const block = providers[p.id]
    if (!block) {
      stale.push(p.id)
      continue
    }
    const key = resolveEnvKey(p.keyRef, DSH_CREDENTIALS_PATH)
    list.push({
      id: p.id,
      displayName: typeof block.displayName === 'string' ? block.displayName : p.displayName,
      baseURL: typeof block.baseURL === 'string' ? block.baseURL : p.baseURL,
      preset: p.preset,
      keyRef: p.keyRef,
      maskedKey: key ? maskKey(key) : null,
      modelCount: Array.isArray(block.models) ? block.models.length : 0,
    })
  }
  if (stale.length) {
    writeManagedProviders(readManagedProviders().filter((p) => !stale.includes(p.id)))
  }
  return list
}

// ---------------------------------------------------------------------------
// Credential composition (core rotation engine + provider OAuth flow).
// api-key mode: apiKeys list > legacy env ref; ≥2 keys round-robin with
// cooldown failover. OAuth: single candidate, never rotated.
// ---------------------------------------------------------------------------

/** Legacy single-key path: process env, then ~/.dsh/.credentials.yaml. */
const envKey = (envName) => resolveEnvKey(envName, join(DSH_HOME, '.credentials.yaml'))

const rotator = new KeyRotator()
const meter = createUsageMeter({ path: join(DSH_HOME, 'codebuddy-plugin-usage.json') })

/**
 * The provider instance for this module instance. `withKeyRotation` /
 * `resolveCredential` are late-bound arrows over the hoisted function
 * declarations below — the provider needs them for outbound calls, they need
 * the provider for the OAuth branch; this is the deliberate cycle break.
 */
const provider = createCodeBuddyProvider({
  meter,
  readAuth,
  writeAuth,
  envKey,
  withKeyRotation: (settings, attempt) => withKeyRotation(settings, attempt),
  resolveCredential: (settings) => resolveCredential(settings),
  dshHome: DSH_HOME,
})

export const makeSearchProvider = provider.makeSearchProvider

/**
 * Resolve the credential every outbound call should use (no rotation —
 * the catalog/quota dialect endpoints authenticate by raw key).
 * @returns {Promise<{authorization: string, headers: Record<string,string>} | null>}
 */
async function resolveCredential(settings) {
  const s = settings()
  if (s.authMode === 'oauth') return provider.oauth.resolveOAuthCredential(s)
  // api-key mode: the active list entry wins, legacy env ref is the fallback.
  const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
  const key = active?.key ?? envKey(s.apiKeyEnv)
  if (!key) return null
  return { authorization: `Bearer ${key}`, headers: {} }
}

/**
 * Credential candidates for one outbound call, in try order.
 * OAuth: zero or one candidate (rotation deliberately not applied).
 * api-key: 0 keys → the legacy env ref (single candidate); 1 key → that key;
 * ≥2 keys → every key exactly once, non-cooling first in round-robin order,
 * cooling keys appended as last resort.
 */
async function resolveCredentialCandidates(settings) {
  const s = settings()
  if (s.authMode === 'oauth') {
    const single = await provider.oauth.resolveOAuthCredential(s)
    return single ? [{ ...single, keyName: null }] : []
  }
  const keys = (s.apiKeys ?? []).filter((k) => typeof k?.key === 'string' && k.key.length > 0)
  if (keys.length === 0) {
    const env = envKey(s.apiKeyEnv)
    return env ? [{ authorization: `Bearer ${env}`, headers: {}, keyName: null }] : []
  }
  if (keys.length === 1) {
    return [{ authorization: `Bearer ${keys[0].key}`, headers: {}, keyName: keys[0].name }]
  }
  return rotator.ordered(keys)
}

/**
 * Run `attempt(cred)` over the rotation candidates with failover (see
 * core/rotation.js). The empty-candidate error is flagged
 * `credentialUnavailable` so the bridge/provider layers recognize it without
 * matching on the message text (the text itself stays for users).
 */
async function withKeyRotation(settings, attempt) {
  const candidates = await resolveCredentialCandidates(settings)
  const emptyError = new Error(CREDENTIAL_UNAVAILABLE_MESSAGE)
  emptyError.credentialUnavailable = true
  return rotator.run(candidates, attempt, {
    cooldownMs: settings().keyCooldownMs,
    emptyError,
  })
}

// ---------------------------------------------------------------------------
// TraeWork CN 通道（v0.8.x）：第二上游 = OAuth 订阅额度 + 私有协议翻译网关。
// 凭据只有 OAuth 一支（Trae 订阅跟账号走）；设备密钥自持（providers/trae/
// oauth.js）。模型目录来自本机 state.vscdb（提取器纯函数复用），镜像进
// settings.yaml 的 llm-pi-ai.providers.trae.models——patch 层只带路由不带
// 模型，清单永远由镜像独占（无"陈旧遮蔽"问题，纯净态=删镜像路径）。
// ---------------------------------------------------------------------------

const readTraeAuth = () => readJson(TRAE_AUTH_PATH)
const writeTraeAuth = (v) => writeJson(TRAE_AUTH_PATH, v)

const traeRuntime = { running: false, port: null, lastError: null }

/** Trae 凭据候选（OAuth 单候选，无轮换）；空候选错误带稳定标记。 */
async function withTraeCredentials(settingsFn, attempt) {
  const s = settingsFn()
  let cred = null
  try {
    cred = await traeProvider.oauth.resolveTraeCredential(s)
  } catch (err) {
    const e = new Error(`trae credential error: ${err?.message ?? err}`)
    e.credentialUnavailable = true
    return { cred: null, res: null, err: e }
  }
  if (!cred) {
    const e = new Error(TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE)
    e.credentialUnavailable = true
    return { cred: null, res: null, err: e }
  }
  try {
    const res = await attempt(cred)
    return { cred, res, err: null }
  } catch (err) {
    return { cred, res: null, err }
  }
}

// 迟绑定：网关需要"本代"的 settings 解析函数；apply() 每代重设该模块级
// 变量（与 codebuddy 侧 hoisted 函数的迟绑定等价，形态不同只因工厂签名）。
let traeSettingsFn = () => ({ traeEnabled: false })

const traeProvider = createTraeProvider({
  readAuth: readTraeAuth,
  writeAuth: writeTraeAuth,
  settings: () => traeSettingsFn(),
  withCredentials: (attempt) => withTraeCredentials(() => traeSettingsFn(), attempt),
  meter,
  runtime: traeRuntime,
  forensics: { logPath: () => process.env.TRAE_BRIDGE_LOG },
})

function readTraeModelState() {
  const state = readFileLayer().traeModelState
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { disabled: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
  }
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
 *     隐藏通道，chokidar 热加载免重启）。无 patch 基线即无回落，删块即干净。
 * 升级注意：<=0.8.5 写的 trae 块只带 models 路径（其余字段靠 patch 深合并），
 * 重启前须先清掉旧块（见 cordis.patch.yml 的 UPGRADE NOTE）。
 */
function syncTraeModelsToDshSettings() {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_SETTINGS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  const s = Config({ ...readFileLayer() }) // entry 侧无 trae 字段，schema 默认补齐
  const view = traeProvider.catalogView()
  const disabled = readTraeModelState().disabled
  const models = s.traeEnabled === true && view
    ? view.profiles.filter((p) => !disabled[p.id])
    : null
  const path = ['llm-pi-ai', 'providers', 'trae']
  if (!models || models.length === 0) {
    if (!doc.getIn(path)) return false
    doc.deleteIn(path)
    writeFileSync(DSH_SETTINGS_PATH, String(doc))
    return true
  }
  const block = {
    displayName: 'TraeWork CN',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${s.traeBridgePort}/v1`,
    headers: { Authorization: 'Bearer dsh-trae-bridge' },
    models: YAML.parse(YAML.stringify(models)),
  }
  const current = doc.getIn(path)
  if (YAML.stringify(current ?? null) === YAML.stringify(block)) return false
  doc.setIn(path, YAML.parse(YAML.stringify(block)))
  writeFileSync(DSH_SETTINGS_PATH, String(doc))
  return true
}

/**
 * 安全审计 [18]：state.vscdb 路径纵深防御（CSRF 已被 settings 路由本地门
 * 挡住，这里是第二道）。规则：绝对路径、规范化后不含 .. 段、扩展名限
 * .db/.vscdb。不校验存在性——不存在的路径沿用既有同步错误路径报错。
 */
function isSafeStateDbPath(p) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return false
  const normalized = normalize(p)
  if (normalized.split(/[\\/]/).includes('..')) return false
  const ext = extname(normalized).toLowerCase()
  return ext === '.db' || ext === '.vscdb'
}

function setTraeModelEnabled({ id, enabled }) {
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
  syncTraeModelsToDshSettings()
  return state
}

// ---------------------------------------------------------------------------
// Bridge runtime state (module-level, shared across apply() generations —
// production runs one plugin instance per process, so last-apply-wins is
// correct; scripts/verify-bridge.mjs §10 pins the semantics).
// ---------------------------------------------------------------------------

const bridgeRuntime = { running: false, port: null, lastError: null }

// ---------------------------------------------------------------------------
// Settings route consumed by the Web UI card.
// ---------------------------------------------------------------------------

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Only same-origin writes: POST mutates settings or credentials. */
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 安全审计 [6]+[7]：/dsh-tap/settings 是本地特权面（读 OAuth 状态/桥端口/
 * 目录，POST 改设置与凭据）。GET 与 POST 一体设防，统一判定不做分支复制：
 *  - Host 门：Host 头必须解析为回环 hostname——防 DNS rebinding（攻击域
 *    解析到 127.0.0.1 后借浏览器直读）与 LAN 直连。代价：经 LAN IP 访问
 *    设置卡被拒，属有意收紧。
 *  - Origin 门：带 Origin 头时其 host:port 必须与 Host 一致——浏览器跨站
 *    请求必带 Origin，不一致即跨站伪造。
 * Returns null to proceed, else the refusal reason (送 403 响应体).
 */
function localGuardFailure(req) {
  const host = req.headers.host
  const hostname = typeof host === 'string' ? hostHeaderHostname(host) : null
  if (!hostname || !isLoopbackHostname(hostname)) {
    return `本接口仅限本机访问：Host 必须是回环地址（127.0.0.1/localhost/::1），收到 ${host ?? '(缺失)'}`
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originMatches = false
    try {
      originMatches = new URL(origin).host === host
    } catch {
      originMatches = false
    }
    if (!originMatches) return `Origin 与 Host 不一致（疑似跨站请求）：${origin}`
  }
  return null
}

/** Mask a key for display: first 4 and last 4 characters. */
function maskKey(key) {
  if (typeof key !== 'string' || key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * File layer safe to ship to the browser: plaintext apiKeys[].key masked away.
 * Same policy as the GET view — f9aeeaa covered GET only; the four POST
 * responses that also carried the raw file layer regressed it. The card
 * consumes `user` solely for top-level field presence (overriddenFor →
 * hasOwnProperty), never nested key material — masking here is lossless.
 */
function maskedUserLayer(user) {
  return Array.isArray(user.apiKeys)
    ? { ...user, apiKeys: user.apiKeys.map((k) => ({ ...k, key: maskKey(k.key) })) }
    : user
}

/** The GET view: resolved settings with secrets masked, plus OAuth status. */
function settingsView(resolveNow) {
  const s = resolveNow()
  const user = readFileLayer()
  const state = readModelState()
  return {
    value: {
      ...s,
      apiKeys: (s.apiKeys ?? []).map((k) => ({ name: k.name, masked: maskKey(k.key) })),
    },
    // The raw file layer carries plaintext apiKeys[].key — never ship it to
    // the browser (the card only checks top-level field presence).
    user: maskedUserLayer(user),
    fields: SETTINGS_FIELDS,
    oauth: provider.oauth.oauthStatus(),
    bridge: {
      running: bridgeRuntime.running,
      port: bridgeRuntime.port,
      lastError: bridgeRuntime.lastError,
    },
    trae: {
      oauth: traeProvider.credentialView(),
      bridge: {
        running: traeRuntime.running,
        port: traeRuntime.port,
        lastError: traeRuntime.lastError,
      },
      models: {
        disabled: Object.keys(readTraeModelState().disabled),
        sync: traeProvider.catalogView()
          ? { at: traeProvider.catalogView().at, count: traeProvider.catalogView().count, candidate: traeProvider.catalogView().candidate }
          : null,
      },
    },
    models: {
      staticIds: readStaticModels().map((m) => m.id),
      disabled: Object.keys(state.disabled),
      extraIds: Object.keys(state.extra),
      // G5：每模型覆盖值（contextWindow/maxTokens），设置卡据此显示与校验。
      overrides: state.overrides ?? {},
      effectiveCount: computeEffectiveModels().length,
      // G4：选择器真实内容——设置卡勾选状态的唯一权威（动态目录启用后
      // 目录模型默认在内，不在 extra 里，不能靠 disabled/extra 反推）。
      effectiveIds: computeEffectiveModels().map((m) => m.id),
      // G4 动态目录同步状态：null = 静态兜底（未同步/同步失败且无旧目录）
      sync: dynamicCatalog
        ? { at: dynamicCatalog.fetchedAt, count: dynamicCatalog.count, source: 'gateway' }
        : null,
    },
  }
}

/**
 * Route contract:
 *   GET                                                    → settingsView
 *   POST {patch: {...}}                                     → merge & apply
 *   POST {action:'oauth-start'}                             → {authUrl}
 *   POST {action:'oauth-status'}                            → oauthStatus()
 *   POST {action:'oauth-logout'}                            → clears tokens
 *   POST {action:'model-list'}                              → gateway catalog
 *   POST {action:'model-sync'}                              → G4 resync /v3/config → mirror
 *   POST {action:'provider-list'|'provider-add'|'provider-remove'|'provider-refresh'}
 *                                                           → G6 extra OpenAI-compat providers
 *   POST {action:'usage'}                                   → usage meter + bridge state + quota snapshot
 */
function registerSettingsRoute(ctx, entryConfig, resolveNow, applyLive) {
  ctx.inject(['webServer'], (wsctx) => {
    wsctx.webServer.register({
      kind: 'exact',
      path: '/dsh-tap/settings',
      handler: (request, response) => {
        // 安全审计 [6]+[7]：GET 与 POST 都先过本地门（回环 Host + Origin 一致）。
        const guardFail = localGuardFailure(request)
        if (guardFail) {
          sendJSON(response, 403, { ok: false, error: guardFail })
          return
        }
        if (request.method === 'GET') {
          sendJSON(response, 200, settingsView(resolveNow))
          return
        }
        if (request.method !== 'POST' || !sameOrigin(request)) {
          sendJSON(response, request.method === 'POST' ? 403 : 405, { ok: false })
          return
        }
        // Buffer 收集 + 一次解码（踩坑 #28，同 core/bridge.js）：
        // provider displayName 等中文经逐分片隐式解码同样会损坏。
        const chunks = []
        request.on('data', (c) => {
          chunks.push(c)
        })
        request.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body?.action === 'oauth-start') {
              provider.oauth.startOAuth(resolveNow().baseURL)
                .then((r) => sendJSON(response, 200, { ok: true, authUrl: r.authUrl }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'oauth-status') {
              sendJSON(response, 200, { ok: true, oauth: provider.oauth.oauthStatus() })
              return
            }
            if (body?.action === 'model-list') {
              provider.catalog.fetchModelCatalog(resolveNow)
                .then((catalog) => {
                  // G5：ceilings = 基清单∪extra 的实际上限（校验上限与 title）；
                  // profiles = ceilings 应用覆盖后的有效值（输入框显示值），
                  // 覆盖所有已知 id（含禁用行——禁用不清覆盖值）。
                  const ceilings = {}
                  for (const m of computeBaseModels()) {
                    ceilings[m.id] = { contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null }
                  }
                  for (const [id, p] of Object.entries(readModelState().extra)) {
                    if (!ceilings[id] && p) ceilings[id] = { contextWindow: p.contextWindow ?? null, maxTokens: p.maxTokens ?? null }
                  }
                  const overrides = readModelState().overrides
                  const profiles = {}
                  for (const [id, c] of Object.entries(ceilings)) {
                    const o = overrides[id] || {}
                    profiles[id] = {
                      contextWindow: o.contextWindow != null ? o.contextWindow : c.contextWindow,
                      maxTokens: o.maxTokens != null ? o.maxTokens : c.maxTokens,
                    }
                  }
                  sendJSON(response, 200, {
                    ok: true,
                    catalog,
                    staticIds: readStaticModels().map((m) => m.id),
                    // G4：选择器真实内容（勾选语义 = 在不在选择器里）
                    effectiveIds: computeEffectiveModels().map((m) => m.id),
                    profiles,
                    ceilings,
                    // id → reasoning tier keys from cordis.patch.yml (e.g.
                    // ["off","low","medium","high","max"]); the card renders
                    // these on static rows.
                    staticEfforts: Object.fromEntries(
                      readStaticModels()
                        .filter((m) => m.reasoningEfforts && typeof m.reasoningEfforts === 'object')
                        .map((m) => [m.id, Object.keys(m.reasoningEfforts)]),
                    ),
                    state: readModelState(),
                  })
                })
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            // G4：手动刷新——重新同步 /v3/config 并重铺 settings.yaml 镜像。
            if (body?.action === 'model-sync') {
              syncModelsFromGateway(resolveNow)
                .then((r) => sendJSON(response, 200, { ok: true, sync: r, models: settingsView(resolveNow).models }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            // G6：多服务商注册表（key 型 OpenAI 兼容上游）。
            if (body?.action === 'provider-list') {
              sendJSON(response, 200, {
                ok: true,
                providers: extraProvidersView(),
                presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, displayName: p.displayName, baseURL: p.baseURL })),
              })
              return
            }
            if (body?.action === 'provider-add') {
              addExtraProvider(body)
                .then((r) => sendJSON(response, 200, { ok: true, added: r, providers: extraProvidersView() }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'provider-remove') {
              try {
                if (typeof body.id !== 'string') throw new Error('provider-remove 需要 id')
                removeExtraProvider(body.id)
                sendJSON(response, 200, { ok: true, providers: extraProvidersView() })
              } catch (err) {
                sendJSON(response, 400, { ok: false, error: err.message })
              }
              return
            }
            if (body?.action === 'provider-refresh') {
              if (typeof body.id !== 'string') {
                sendJSON(response, 400, { ok: false, error: 'provider-refresh 需要 id' })
                return
              }
              refreshExtraProviderModels(body.id)
                .then((r) => sendJSON(response, 200, { ok: true, refreshed: r, providers: extraProvidersView() }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            // G7：本机登录态检测。扫描只读、findings 不含 secret；
            // 导入是用户确认后的显式动作（设置卡"一键导入"按钮）。
            if (body?.action === 'credential-scan') {
              sendJSON(response, 200, { ok: true, findings: scanLocalCredentials() })
              return
            }
            if (body?.action === 'credential-import') {
              let spec
              try {
                spec = readImportCredential(scanLocalCredentials(), body?.source)
              } catch (err) {
                sendJSON(response, 400, { ok: false, error: err.message })
                return
              }
              // 命中同名 preset（同 id 同 baseURL）走 preset 通道——拿到
              // fallbackModels 等先验；否则按自定义上游严格校验（必须有 /models）。
              const presetHit = PROVIDER_PRESETS.find((p) => p.id === spec.id && p.baseURL === spec.baseURL)
              addExtraProvider(presetHit
                ? { preset: presetHit.id, apiKey: spec.apiKey }
                : { id: spec.id, baseURL: spec.baseURL, displayName: spec.displayName, apiKey: spec.apiKey })
                .then((r) => sendJSON(response, 200, { ok: true, added: r, providers: extraProvidersView(), findings: scanLocalCredentials() }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'oauth-logout') {
              provider.oauth.logout()
              sendJSON(response, 200, { ok: true, oauth: provider.oauth.oauthStatus() })
              return
            }
            // ---- TraeWork CN 通道（v0.8.x）----
            if (body?.action === 'trae-oauth-start') {
              traeProvider.oauth.startOAuth(resolveNow())
                .then((r) => sendJSON(response, 200, { ok: true, authUrl: r.authUrl }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'trae-oauth-status') {
              sendJSON(response, 200, { ok: true, trae: traeProvider.credentialView() })
              return
            }
            if (body?.action === 'trae-oauth-logout') {
              traeProvider.oauth.logout()
              sendJSON(response, 200, { ok: true, trae: traeProvider.credentialView() })
              return
            }
            if (body?.action === 'trae-model-sync') {
              // 安全审计 [18] 纵深防御：dbPath 是读文件的调用方输入——必须
              // 绝对路径、规范化后无 .. 段、扩展名限 .db/.vscdb。不存在的
              // 路径不在此预检，交给既有同步错误路径（502 + 原因）。
              const dbPath = body?.dbPath
              if (dbPath !== undefined && !isSafeStateDbPath(dbPath)) {
                throw new Error('dbPath 必须是绝对路径、不含 .. 段且以 .db/.vscdb 结尾')
              }
              traeProvider.syncCatalog(typeof dbPath === 'string' ? { dbPath } : {})
                .then((r) => {
                  syncTraeModelsToDshSettings()
                  sendJSON(response, 200, { ok: r.ok, sync: r, trae: settingsView(resolveNow).trae })
                })
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'trae-model-list') {
              sendJSON(response, 200, {
                ok: true,
                view: traeProvider.catalogView(),
                disabled: Object.keys(readTraeModelState().disabled),
              })
              return
            }
            if (body?.action === 'usage') {
              provider.catalog.quotaSnapshot(resolveNow)
                .then((quota) => sendJSON(response, 200, {
                  ok: true,
                  usage: meter.view(),
                  bridge: {
                    enabled: resolveNow().bridgeEnabled === true,
                    running: bridgeRuntime.running,
                    port: bridgeRuntime.port,
                    lastError: bridgeRuntime.lastError,
                  },
                  quota,
                }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            const patch = body?.patch
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              throw new Error('body must be {patch} or {action}')
            }
            const nextUser = { ...readFileLayer() }
            // Key-list operations run against the stored raw list — the card
            // only ever sees masked keys, so adds/removes must resolve here.
            if (patch.apiKeysAdd !== undefined) {
              const entry = patch.apiKeysAdd
              if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string'
                || typeof entry.key !== 'string' || !entry.name.trim() || !entry.key.trim()) {
                throw new Error('apiKeysAdd 需要 {name, key}')
              }
              const name = entry.name.trim()
              const key = entry.key.trim()
              const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
              nextUser.apiKeys = list.filter((k) => k?.name !== name).concat([{ name, key }])
              if (!nextUser.activeApiKey) nextUser.activeApiKey = name
            }
            if (patch.apiKeysRemove !== undefined) {
              if (typeof patch.apiKeysRemove !== 'string') throw new Error('apiKeysRemove 需要名称字符串')
              const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
              nextUser.apiKeys = list.filter((k) => k?.name !== patch.apiKeysRemove)
              if (nextUser.activeApiKey === patch.apiKeysRemove) delete nextUser.activeApiKey
            }
            if (patch.modelSetEnabled !== undefined) {
              // Runs against modelState inside setModelEnabled; re-read the
              // layer afterwards so apiKeys edits above are not clobbered.
              const withKeys = { ...nextUser }
              setModelEnabled(patch.modelSetEnabled)
              const after = readFileLayer()
              delete withKeys.modelState
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: maskedUserLayer(after),
                models: settingsView(resolveNow).models,
              })
              applyLive()
              return
            }
            if (patch.modelSetLimits !== undefined) {
              // G5：同 modelSetEnabled 的层叠纪律——setModelLimits 内部自写
              // modelState，事后重读层并把本请求里的 apiKeys 改动合回。
              const withKeys = { ...nextUser }
              setModelLimits(patch.modelSetLimits)
              const after = readFileLayer()
              delete withKeys.modelState
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: maskedUserLayer(after),
                models: settingsView(resolveNow).models,
              })
              applyLive()
              return
            }
            if (patch.traeModelSetEnabled !== undefined) {
              const withKeys = { ...nextUser }
              setTraeModelEnabled(patch.traeModelSetEnabled)
              const after = readFileLayer()
              delete withKeys.traeModelState
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: maskedUserLayer(after),
                trae: settingsView(resolveNow).trae,
              })
              applyLive()
              return
            }
            for (const [key, value] of Object.entries(patch)) {
              if (key === 'apiKeysAdd' || key === 'apiKeysRemove') continue
              // Whitelist by SETTINGS_FIELDS, not Config({}) keys: fields
              // without a schema default (activeApiKey) vanish from a bare
              // Config({}) resolution and were silently dropped here.
              if (!SETTINGS_FIELDS.some((f) => f.key === key)) continue
              if (value === null) delete nextUser[key]
              else nextUser[key] = value
            }
            // Validate through the schema before persisting.
            const candidate = Config({ ...entryConfig, ...nextUser })
            validateBaseURL(candidate.baseURL)
            for (const f of ['traeAuthBaseURL', 'traeChatBaseURL', 'traeLoginHost']) {
              validateBaseURL(candidate[f])
            }
            const resolved = candidate
            if (resolved.activeApiKey && !resolved.apiKeys.some((k) => k.name === resolved.activeApiKey)) {
              throw new Error('activeApiKey 不在 apiKeys 列表中')
            }
            writeFileLayer(nextUser)
            applyLive()
            sendJSON(response, 200, { ok: true, value: settingsView(resolveNow).value, user: maskedUserLayer(nextUser) })
          } catch (err) {
            sendJSON(response, 400, { ok: false, error: err.message })
          }
        })
      },
    })
  })
}

export function apply(ctx, config = {}) {
  // entry < file; schema defaults fill the rest. Live-resolved per read.
  const resolveNow = () => Config({ ...config, ...readFileLayer() })

  // Web providers ride the searchEnabled switch: disposing unregisters from
  // ctx.web, re-enabling registers fresh instances. While disabled the
  // seam's pinned id (patch: web.searchProvider=codebuddy) reports
  // CONFIGURED_MISSING — intended: the switch means "this feature is off".
  let disposeSearch = null
  let disposeFetch = null
  const syncProviders = () => {
    const enabled = resolveNow().searchEnabled === true
    if (!enabled) {
      if (disposeSearch) { disposeSearch(); disposeSearch = null }
      if (disposeFetch) { disposeFetch(); disposeFetch = null }
      return
    }
    if (disposeSearch && disposeFetch) return
    disposeSearch = ctx.web.registerSearchProvider(provider.makeSearchProvider(resolveNow))
    disposeFetch = ctx.web.registerFetchProvider(provider.makeFetchProvider(resolveNow))
  }

  // Image generation tool on the tools seam: registered while
  // imageGenEnabled, disposed when switched off. `tools` resolves lazily via
  // ctx.inject (same pattern as the webServer route) so the plugin still
  // loads in compositions without the tools service.
  let toolsCtx = null
  let disposeImageTool = null
  const syncImageTool = () => {
    if (!toolsCtx) return
    const enabled = resolveNow().imageGenEnabled === true
    if (!enabled) {
      if (disposeImageTool) { disposeImageTool(); disposeImageTool = null }
      return
    }
    if (disposeImageTool) return
    try {
      disposeImageTool = toolsCtx.tools.register(provider.makeImageGenTool(resolveNow))
      process.stderr.write('[dsh-tap] image_generate tool registered\n')
    } catch (err) {
      disposeImageTool = null
      process.stderr.write(`[dsh-tap] image_generate register failed: ${err?.message ?? err}\n`)
    }
  }
  ctx.inject(['tools'], (tctx) => { toolsCtx = tctx; syncImageTool() })

  // Settings namespace claim for Settings → 插件配置: dsh ≥ 0.1.0-rc.7
  // dispatches `settings.plugin.item` cards keyed by a namespace the Host
  // serves (api-proxy `settings.describe`, allowlist removed in rc.7), so the
  // browser-half card (registered under the same key) only renders when this
  // registration lands. Reads/writes still go through our own webServer route
  // + file layer — the seam is only the dispatch claim. Lazy inject:
  // compositions without the settings service skip it (rc.6 dispatched cards
  // unconditionally, so the card still renders there). Registration is an
  // effect on this fiber — plugin dispose unregisters the namespace.
  ctx.inject(['settings'], (sctx) => {
    try {
      sctx.settings.register('dsh-tap', Config)
    } catch (err) {
      process.stderr.write(`[dsh-tap] settings namespace register failed: ${err?.message ?? err}\n`)
    }
  })

  // Bridge lifecycle: running state keyed by the port it listens on.
  // bridgeRuntime mirrors reality for the settings view (listen is async —
  // `running` flips on the server's 'listening' event, failures land in
  // lastError via its 'error' event instead of crashing the process).
  //
  // One createBridge instance per apply(): it captures this apply's
  // resolveNow (the entry config differs per apply); bridgeRuntime stays
  // module-shared. The forensic env var NAMES stay here in the composition
  // root — core/bridge.js only receives the path getters.
  const bridge = createBridge({
    settings: resolveNow,
    provider,
    withCredentials: (attempt) => withKeyRotation(resolveNow, attempt),
    meter,
    forensics: {
      logPath: () => process.env.CODEBUDDY_BRIDGE_LOG,
      dumpDir: () => process.env.CODEBUDDY_BRIDGE_DUMP,
    },
    runtime: bridgeRuntime,
  })
  let stopBridge = null
  let runningPort = null
  const syncBridge = () => {
    const s = resolveNow()
    if (s.bridgeEnabled !== true) {
      if (stopBridge) {
        stopBridge()
        stopBridge = null
        runningPort = null
      }
      bridgeRuntime.running = false
      bridgeRuntime.port = null
      bridgeRuntime.lastError = null
      return
    }
    if (stopBridge && runningPort === s.bridgePort) return
    if (stopBridge) stopBridge()
    runningPort = s.bridgePort
    bridgeRuntime.running = false
    bridgeRuntime.port = s.bridgePort
    bridgeRuntime.lastError = null
    stopBridge = bridge.listen(runningPort)
  }
  const applyLive = () => {
    syncProviders()
    syncImageTool()
    syncBridge()
    syncTraeBridge()
  }

  // TraeWork CN 通道生命周期：迟绑定本代 settings；启用时起翻译网关、
  // 尝试目录同步（静默失败——state.vscdb 不在本机时 Trae 分区只是空转）；
  // 禁用时停网关并按纯净态纪律撤掉 providers.trae.models 镜像。
  traeSettingsFn = resolveNow
  let stopTraeBridge = null
  let traeRunningPort = null
  const syncTraeBridge = () => {
    const s = resolveNow()
    if (s.traeEnabled !== true) {
      if (stopTraeBridge) {
        stopTraeBridge()
        stopTraeBridge = null
        traeRunningPort = null
      }
      traeRuntime.running = false
      traeRuntime.port = null
      traeRuntime.lastError = null
      syncTraeModelsToDshSettings()
      return
    }
    if (stopTraeBridge && traeRunningPort === s.traeBridgePort) return
    if (stopTraeBridge) stopTraeBridge()
    traeRunningPort = s.traeBridgePort
    traeRuntime.running = false
    traeRuntime.port = s.traeBridgePort
    traeRuntime.lastError = null
    stopTraeBridge = traeProvider.gateway.listen(traeRunningPort)
    traeProvider.syncCatalog().then((r) => {
      if (r.ok) {
        syncTraeModelsToDshSettings()
        process.stderr.write(`[dsh-tap] trae catalog synced (${r.count} models)\n`)
      } else if (traeProvider.catalogView()) {
        syncTraeModelsToDshSettings()
      }
    })
  }

  applyLive()
  registerSettingsRoute(ctx, config, resolveNow, applyLive)
  // Keep the settings.yaml model mirror in step with modelState across
  // restarts (no-op when the feature was never used).
  const state = readModelState()
  if (Object.keys(state.disabled).length > 0 || Object.keys(state.extra).length > 0) {
    syncModelsToDshSettings()
  }
  // G4：启动时自动从 /v3/config 同步模型清单；失败无感回落静态清单
  // （syncModelsFromGateway 内部已兜住一切异常，这里只记一行日志）。
  syncModelsFromGateway(resolveNow).then((r) => {
    process.stderr.write(r.ok
      ? `[dsh-tap] model catalog synced from gateway (${r.count} models)\n`
      : `[dsh-tap] model catalog sync failed (${r.error}) — ${r.kept ? 'keeping last synced list' : 'static fallback'}\n`)
  })
  ctx.on('dispose', () => {
    if (stopBridge) stopBridge()
    if (stopTraeBridge) stopTraeBridge()
    if (disposeSearch) disposeSearch()
    if (disposeFetch) disposeFetch()
    if (disposeImageTool) disposeImageTool()
    meter.dispose()
  })
}
