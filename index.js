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

import { chmodSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, isAbsolute, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import z from '@deepseek-ai/schemastery'

import { readJson, writeJson, writeTextAtomic, resolveEnvKey } from './core/json-store.js'
import { KeyRotator } from './core/rotation.js'
import { createUsageMeter } from './core/usage-meter.js'
import { createBridge } from './core/bridge.js'
import { createCodeBuddyProvider } from './providers/codebuddy/index.js'
import { CREDENTIAL_UNAVAILABLE_MESSAGE } from './providers/codebuddy/errors.js'
import { UNROUTABLE_MODELS } from './providers/codebuddy/catalog.js'
import { createTraeProvider } from './providers/trae/index.js'
import { TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE } from './providers/trae/errors.js'
import { PROVIDER_ID_RE, createOpenAICompatProvider } from './providers/openai-compat.js'
import { QODER_CLIENT_ID } from './providers/qoder/oauth.js'
import { createQoderProvider } from './providers/qoder/index.js'
import { applyQoderContextVariant } from './providers/qoder/catalog.js'
import { scanLocalCredentials, readImportCredential } from './local-scan.js'
import { createHostConfigLayer } from './host-config.js'
import arkProvider from './providers/ark/index.js'
import bailianProvider from './providers/bailian/index.js'
import deepseekProvider from './providers/deepseek/index.js'
import bigmodelProvider from './providers/bigmodel/index.js'
import moonshotProvider from './providers/moonshot/index.js'
import openrouterProvider from './providers/openrouter/index.js'
import qwenProvider from './providers/qwen/index.js'

export const name = 'dsh-tap'

/** web providers via ctx.web; the settings route rides ctx.webServer when present. */
export const inject = ['web']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SETTINGS_PATH = join(DSH_HOME, 'codebuddy-plugin.json')
const AUTH_PATH = join(DSH_HOME, 'codebuddy-plugin-auth.json')
const TRAE_AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const QODER_AUTH_PATH = join(DSH_HOME, 'qoder-plugin-auth.json')
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
  // 本地特权面（/dsh-tap/settings）的额外放行 Origin 完整串清单（精确匹配，
  // 非前缀/通配）。宿主壳的页面经壳转发本地请求时，Origin 是壳自己的自定义
  // scheme（host 不等于回环 Host），默认按跨站拒；需要壳内设置卡写入的宿主
  // 把该 scheme 完整串（如壳协议://页面 host）填进来。默认空 = 行为不变。
  localAllowedOrigins: z.array(z.string()).default([]),
  imageGenEnabled: z.boolean().default(true),
  imageGenModel: z.string().default('hunyuan-image-v3.0-art'),
  keyCooldownMs: z.number().step(100).min(100).default(60000),
  // G3 估算档：api-key 模式下用户手填的总额度（credit），卡片显示
  // 「手填总额 − 本插件计量累计」并标注"估算"；0 = 未设置。OAuth 模式不用
  // （真实数值来自 /billing/meter/get-user-resource，quota-signals.md R-Q7）。
  quotaTotalManual: z.number().min(0).default(0),
  // G8 逐模型思考强度：{ [modelId]: 档位名 }。桥出站对未显式携带
  // reasoning_effort 的请求按静态清单的 reasoningEfforts 表注入线值；
  // off 的线值是 null（= 省略参数）或无表模型/非法档位都不注入。
  effortByModel: z.dict(z.string(), z.string()).default({}),
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
  // ---- Qoder CN（第三上游）----
  // 设备流事实见 providers/qoder/oauth.js 文件头与 docs/goals/qoder-cn-provider-design.md。
  // 默认关闭：开启后同步网关模型目录到选择器（providers.qoder），并在
  // qoderBridgePort 上起 OpenAI↔COSY 翻译网关；主聊天经镜像路由（哨兵
  // Authorization）走该网关。qoderClientId 默认官方 prod 值，一般无需改。
  qoderLoginHost: z.string().default('https://qoder.cn'),
  qoderOpenapiBaseURL: z.string().default('https://openapi.qoder.com.cn'),
  qoderClientId: z.string().default(QODER_CLIENT_ID),
  qoderEnabled: z.boolean().default(false),
  qoderBridgePort: z.number().step(1).min(1).max(65535).default(3903),
  // infer 节点（region 发现服务实测 CN = gateway.qoder.com.cn；不是
  // api2-v2.qoder.sh——那个 OpenAI 面对本通道 401，见设计文档 §5b 修订）。
  qoderInferBaseURL: z.string().default('https://gateway.qoder.com.cn'),
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
  { key: 'effortByModel', kind: 'dict' },
  { key: 'traeEnabled', kind: 'boolean' },
  { key: 'traeAuthBaseURL', kind: 'text' },
  { key: 'traeChatBaseURL', kind: 'text' },
  { key: 'traeLoginHost', kind: 'text' },
  { key: 'traeBridgePort', kind: 'number' },
  { key: 'traeChatTransport', kind: 'select' },
  { key: 'upstreamFirstByteTimeoutMs', kind: 'number' },
  { key: 'qoderLoginHost', kind: 'text' },
  { key: 'qoderOpenapiBaseURL', kind: 'text' },
  { key: 'qoderClientId', kind: 'text' },
  { key: 'qoderEnabled', kind: 'boolean' },
  { key: 'qoderBridgePort', kind: 'number' },
  { key: 'qoderInferBaseURL', kind: 'text' },
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
// 桥端口按运行时宿主 profile 分流（goal docs/goals/bridge-port-host-split.md）。
// 共享文件层（codebuddy-plugin.json）被 web/非默认 profile 两进程共读——分流端口
// 写进去两边读到同一份仍会撞，故分流值**不持久化**，每进程按自身宿主信号现读
// 现算。默认 profile（'web'）= schema 默认端口，逐位不变；其余宿主 profile 的
// trae/qoder 翻译网关分流到 默认+10（3902→3912、3903→3913）。CodeBuddy 桥 3901
// 本期不动（goal 边界）。
// ---------------------------------------------------------------------------
const BRIDGE_PORT_DEFAULTS = { bridge: 3901, trae: 3902, qoder: 3903 }
const HOST_BRIDGE_PORT_OFFSET = 10
const DEFAULT_PROFILE_DIR_NAME = 'web'

/**
 * 宿主信号源（两级，皆现读、永不缓存）：
 * ① process.argv 自证——host 进程把 profile 目录作位置参数传入（如
 *    …\.dsh\profiles\<name>），启动期即用，零服务就绪时序依赖（首轮
 *    applyLive 的 sync*Bridge listen 就靠它，等②就绪再 listen 就晚了——
 *    EADDRINUSE 会以默认端口烙进 lastError，重启前不自愈）；
 * ② probe().documentPath（host-config.js 已 try/catch 兜底 null）——settings
 *    服务经 ctx.inject 异步注入，首个 resolveNow 时可能未就绪，只作兜底。
 * **永不缓存**：缓存会把启动竞态烙成永久错分；现读 + 就绪后下一次 sync*
 * 端口对账即自愈。返回小写目录名；两级皆不可用 → null。
 */
function currentProfileDirName() {
  for (const arg of process.argv) {
    const segs = String(arg).split(/[\\/]/)
    const i = segs.indexOf('profiles')
    if (i >= 0 && segs[i + 1]) return segs[i + 1].toLowerCase()
  }
  const docPath = hostConfig.probe().documentPath
  if (typeof docPath !== 'string' || !docPath) return null
  return basename(dirname(docPath)).toLowerCase()
}

/**
 * 三端口有效值的唯一出处。数据驱动：默认 profile（'web'）或信号不可用 →
 * 偏移 0（= 与既有行为逐位一致）；其余宿主 profile → trae/qoder +10。
 * 文件层显式值优先（用户在设置卡显式改过端口就按显式值用）。
 */
function resolveBridgePorts(entryLayer, fileLayer, profileDirName) {
  const shift = profileDirName && profileDirName !== DEFAULT_PROFILE_DIR_NAME ? HOST_BRIDGE_PORT_OFFSET : 0
  const valid = (l, k) => typeof l?.[k] === 'number' && l[k] >= 1 && l[k] <= 65535
  // 「显式」判定（两难收口于此）：
  //  - cordis 给 apply 的 entry 恒含 schema 默认端口（活实例实测 entryPortKeys=
  //    [bridgePort,traeBridgePort,traeChatTransport,qoderBridgePort]=Config({}) 的
  //    number/union 默认键）——把 entry 无差别当显式，schema 默认会压过分流偏移。
  //  - verify-* 套件又靠 entry 传随机空闲口（文件层是独立 tmpdir、无端口键）。
  // 折衷：entry 端口值 **偏离 schema 默认**才算显式（套件随机口 ≠ 默认 → 采信；
  // cordis 的默认 entry = 默认 → 不采信，落到分流/文件层）；文件层显式恒采信
  // （用户真实写入，含 3903 这种等于默认的值——那是用户明确要的）。
  const entryExplicit = (k) => valid(entryLayer, k) && entryLayer[k] !== BRIDGE_PORT_DEFAULTS[{ bridgePort: 'bridge', traeBridgePort: 'trae', qoderBridgePort: 'qoder' }[k]]
  const pick = (k, def, portShift) => entryExplicit(k) ? entryLayer[k]
    : valid(fileLayer, k) ? fileLayer[k]
    : def + portShift
  return {
    bridgePort: pick('bridgePort', BRIDGE_PORT_DEFAULTS.bridge, 0),
    traeBridgePort: pick('traeBridgePort', BRIDGE_PORT_DEFAULTS.trae, shift),
    qoderBridgePort: pick('qoderBridgePort', BRIDGE_PORT_DEFAULTS.qoder, shift),
  }
}

/**
 * 模块级出口：apply() 内赋值为 resolveNow（镜像函数是模块级、拿不到 apply
 * 闭包里的 resolveNow，故开此出口）。镜像两个 sync*ModelsToDshSettings 经它
 * 解析端口——listen 端口与镜像 baseURL 同源同一次解析，根除双路径漂移。
 * 未赋值（apply 前的理论窗口）回退纯文件层默认值语义（shift=0），不炸。
 */
let effectiveSettingsFn = null

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

/**
 * 思考档位的规范顺序（选择器/卡片展示用；pi-ai 自己按 THINKING_LEVELS 排，
 * 目录声明的键序不必与之一致）。
 */
const EFFORT_TIER_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const effortRank = (level) => {
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
const CATALOG_OFF_WIRE = null

/**
 * 目录思考强度声明 → 档位表（键 = 档位名，值 = 出站线值；null = 省略参数）。
 * 只有带 `supportedEfforts` 的新形态声明才产出表——legacy 形态
 * （{"effort":"high"}）只声明默认档，不构成能力清单，档位表继续由
 * cordis.patch.yml 静态清单提供（合并优先级见 computeBaseModels）。
 */
function catalogReasoningEfforts(m) {
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
function catalogToProfile(m) {
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
function effortTableFor(model) {
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
function effortTiersFor(model) {
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
function effortWireFor(model) {
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
 * 宿主配置层通道（dsh 0.1.7 起 = Settings forms seam，写落 profile 的
 * cordis.patch.yml；≤0.1.6 回退 ~/.dsh/settings.yaml 文档编辑）。
 * 详见 host-config.js 的头注释——两代宿主的差异全部收在那一处。
 */
const hostConfig = createHostConfigLayer({
  settingsPath: DSH_SETTINGS_PATH,
  schema: Config,
  log: (m) => process.stderr.write(`${m}\n`),
})

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
async function syncModelsToDshSettings() {
  try {
    const state = readModelState()
    const pristine = Object.keys(state.disabled).length === 0
      && Object.keys(state.extra).length === 0
      && Object.keys(state.overrides ?? {}).length === 0
      && dynamicCatalog == null
    const path = ['providers', 'codebuddy', 'models']
    if (pristine) return await hostConfig.applyOps([{ op: 'unset', path }])
    const next = computeEffectiveModels()
    // Defensive (0.8.7): an empty effective list must never be mirrored —
    // llm-pi-ai (dsh 0.1.1-rc.2+) rejects it at apply time. setModelEnabled
    // guards the last model already; this fallback drops the override (the
    // patch static list then serves) instead of poisoning the namespace.
    if (next.length === 0) return await hostConfig.applyOps([{ op: 'unset', path }])
    return await hostConfig.applyOps([{ op: 'set', path, value: next }])
  } catch (err) {
    process.stderr.write(`[dsh-tap] model mirror failed: ${err?.message ?? err}\n`)
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** Apply one enable/disable toggle and sync the effective list. */
async function setModelEnabled({ id, enabled, profile }) {
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
  await syncModelsToDshSettings()
  return state
}

/**
 * G5：设置/清除单模型上下文与输出上限覆盖值。字段值为 null = 清除该字段
 * 覆盖（回目录/静态基值）。覆盖值必须是正整数，且不得超过基清单（目录或
 * 静态 profile）给定的该模型实际上限；基清单无尺寸信息时不设上限。
 * 覆盖经 computeEffectiveModels 即时重铺 settings.yaml，下次请求生效。
 */
async function setModelLimits({ id, contextWindow, maxTokens }) {
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
let modelSyncInFlight = null
function syncModelsFromGateway(resolveNow) {
  if (modelSyncInFlight) return modelSyncInFlight
  modelSyncInFlight = (async () => {
    try {
      const catalog = await provider.catalog.fetchModelCatalog(resolveNow)
      const profiles = catalog.models.map(catalogToProfile)
      if (!profiles.length) throw new Error('网关目录为空（保持现有清单）')
      dynamicCatalog = { profiles, fetchedAt: catalog.fetchedAt, count: profiles.length }
      await syncModelsToDshSettings()
      return { ok: true, fetchedAt: dynamicCatalog.fetchedAt, count: dynamicCatalog.count, source: 'gateway' }
    } catch (err) {
      // kept=false → dynamicCatalog 为 null，sync 落静态清单 + 纯净态纪律；
      // kept=true  → 以旧动态目录重铺（选择器不因一次拉取失败掉模型）。
      const kept = dynamicCatalog != null
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

const PROVIDER_PRESETS = [
  arkProvider, bailianProvider,
  deepseekProvider, bigmodelProvider, moonshotProvider, openrouterProvider,
  qwenProvider,
]

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
  writeTextAtomic(DSH_CREDENTIALS_PATH, String(doc), 0o600)
  chmodSync(DSH_CREDENTIALS_PATH, 0o600)
}

function deleteCredential(ref) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_CREDENTIALS_PATH, 'utf8'))
  } catch {
    return
  }
  if (doc.delete(ref)) writeTextAtomic(DSH_CREDENTIALS_PATH, String(doc), 0o600)
}

/** 有效 provider 块视图（登记册对账/重名判定）。新宿主读 describe 的 live value。 */
function readSettingsProviders() {
  return hostConfig.readProviders()
}

/**
 * 写/删（block=null）llm-pi-ai.providers.<id>。
 * dsh 0.1.7+ = Settings forms 的 mutate（落 profile patch，即时生效）；
 * ≤0.1.6 = 注释保留的 settings.yaml 文档编辑。
 */
async function writeProviderBlock(id, block) {
  try {
    return await hostConfig.applyOps(block === null
      ? [{ op: 'unset', path: ['providers', id] }]
      : [{ op: 'set', path: ['providers', id], value: block }])
  } catch (err) {
    process.stderr.write(`[dsh-tap] provider block write failed: ${err?.message ?? err}\n`)
    return { ok: false, error: String(err?.message ?? err) }
  }
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
  if (readSettingsProviders()[pid]) throw new Error(`宿主配置层已存在 ${pid} 提供商（先手动清理或换 id）`)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('需要 API Key')
  const key = apiKey.trim()
  // 实测目录：key/URL 错误在这里就炸，不落任何文件。
  const models = await adapter.fetchModels(key)
  writeCredential(adapter.keyRef, key)
  await writeProviderBlock(pid, adapter.modelBlock(models))
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
async function removeExtraProvider(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  await writeProviderBlock(id, null)
  deleteCredential(entry.keyRef)
  writeManagedProviders(readManagedProviders().filter((p) => p.id !== id))
}

/**
 * P2-5「测一下」：只读验证——与 refresh 同一路径解析 key 并实拉目录
 * （/models；无目录/静态目录上游走 probeChatKey 探针），**不写 provider 块**。
 */
async function testExtraProvider(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  const key = resolveEnvKey(entry.keyRef, DSH_CREDENTIALS_PATH)
  if (!key) throw new Error(`凭据 ${entry.keyRef} 不在环境或 .credentials.yaml 里`)
  const presetHit = PROVIDER_PRESETS.find((p) => p.id === entry.preset)
  const adapter = createOpenAICompatProvider({ ...entry, fallbackModels: presetHit?.fallbackModels, staticCatalog: presetHit?.staticCatalog })
  const models = await adapter.fetchModels(key)
  return { id, modelCount: models.length }
}

/** 重新拉取模型清单（key 从 .credentials.yaml 活解析）。 */
async function refreshExtraProviderModels(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  const key = resolveEnvKey(entry.keyRef, DSH_CREDENTIALS_PATH)
  if (!key) throw new Error(`凭据 ${entry.keyRef} 不在环境或 .credentials.yaml 里`)
  // preset 条目带上 fallbackModels/staticCatalog：无 /models 或静态目录的
  // 上游刷新 = 探针复验 + 沿用兜底/内置清单。
  const presetHit = PROVIDER_PRESETS.find((p) => p.id === entry.preset)
  const adapter = createOpenAICompatProvider({ ...entry, fallbackModels: presetHit?.fallbackModels, staticCatalog: presetHit?.staticCatalog })
  const models = await adapter.fetchModels(key)
  await writeProviderBlock(id, adapter.modelBlock(models))
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
  effortWireFor: (model) => effortWireFor(model),
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

// ---------------------------------------------------------------------------
// Qoder CN 通道（2026-09-19 Phase 1 登录；2026-09-20 Phase 2 聊天面打通）：
// 设备流 OAuth（凭据存 ~/.dsh/qoder-plugin-auth.json）+ COSY WASM 签名
// （providers/qoder/cosy.js）+ 翻译网关（OpenAI↔COSY SSE 信封）+ 网关目录
// 镜像 providers.qoder 整块（路由存在性管理，同 trae 踩坑 #25 纪律）。
// ---------------------------------------------------------------------------

const readQoderAuth = () => readJson(QODER_AUTH_PATH)
const writeQoderAuth = (v) => writeJson(QODER_AUTH_PATH, v)

const qoderRuntime = { running: false, port: null, lastError: null }

// 迟绑定：网关/目录需要"本代"的 settings 解析函数；apply() 每代重设。
let qoderSettingsFn = () => ({ qoderEnabled: false })

const qoderProvider = createQoderProvider({
  readAuth: readQoderAuth,
  writeAuth: writeQoderAuth,
  settings: () => qoderSettingsFn(),
  meter,
  runtime: qoderRuntime,
  forensics: { logPath: () => process.env.QODER_GATEWAY_LOG },
  getModelPrefs: () => readQoderModelPrefs(),
})

function readQoderModelState() {
  const state = readFileLayer().qoderModelState
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { disabled: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
  }
}

// 逐模型偏好：{ [id]: { effort?, contextVariant? } }，与 qoderModelState 并列的
// 独立文件层键（其形状是 disabled 集合字典，与 prefs 记录不对称，故不扩它）。
// 只存已设置的键、空记录不落盘（= 默认）。effort 档位拼写 off/low/medium/high/
// max（cordis.patch.yml verified 表）；contextVariant 是目录 context_config 变体名，
// 镜像时换成 contextWindow（applyQoderContextVariant）。
const QODER_EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max']

function readQoderModelPrefs() {
  const raw = readFileLayer().qoderModelPrefs
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const rec = {}
    if (typeof v.effort === 'string' && QODER_EFFORT_LEVELS.includes(v.effort)) rec.effort = v.effort
    if (typeof v.contextVariant === 'string' && v.contextVariant) rec.contextVariant = v.contextVariant
    if (Object.keys(rec).length) out[id] = rec
  }
  return out
}

/** 镜像 providers.qoder **整块**（路由存在性管理，同 trae 镜像纪律）。 */
async function syncQoderModelsToDshSettings() {
  try {
    // 端口同源：经 effectiveSettingsFn（apply 内赋值的 resolveNow）解析，
    // 未赋值窗口回退纯文件层默认（shift=0）语义。
    const s = effectiveSettingsFn ? effectiveSettingsFn() : Config({ ...readFileLayer() })
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
      models: YAML.parse(YAML.stringify(models)),
    }
    return await hostConfig.applyOps([{ op: 'set', path, value: block }])
  } catch (err) {
    process.stderr.write(`[dsh-tap] qoder mirror failed: ${err?.message ?? err}\n`)
    return { ok: false, error: String(err?.message ?? err) }
  }
}

async function setQoderModelEnabled({ id, enabled }) {
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
 * effort 校验档位拼写；contextVariant 必须命中该模型目录变体（无变体模型拒收）。
 */
async function setQoderModelPrefs({ id, prefs }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('qoderModelSetPrefs 需要 id')
  assertSafeModelId(id)
  const view = qoderProvider.catalogView()
  if (!view || !view.profiles.some((p) => p.id === id)) throw new Error(`${id} 不在 Qoder 目录里（先同步目录）`)
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('qoderModelSetPrefs 需要 prefs 对象')
  const unknown = Object.keys(prefs).filter((k) => k !== 'effort' && k !== 'contextVariant')
  if (unknown.length) throw new Error(`prefs 不支持的键：${unknown.join(', ')}`)
  const rec = {}
  if (prefs.effort !== undefined) {
    if (!QODER_EFFORT_LEVELS.includes(prefs.effort)) {
      throw new Error(`effort 档位必须是 ${QODER_EFFORT_LEVELS.join('/')} 之一`)
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
 *     隐藏通道，免重启：0.1.7+ 经 forms seam 落 profile patch 即时生效，
 *     ≤0.1.6 靠 settings.yaml 的 chokidar 热加载）。无 patch 基线即无回落，
 *     删块即干净。
 * 升级注意：<=0.8.5 写的 trae 块只带 models 路径（其余字段靠 patch 深合并），
 * 重启前须先清掉旧块（见 cordis.patch.yml 的 UPGRADE NOTE）。
 */
async function syncTraeModelsToDshSettings() {
  try {
    // 端口同源 effectiveSettingsFn（镜像与 listen 一次解析；注释「entry 侧无
    // trae 字段，schema 默认补齐」指纯文件层路径，resolveNow 本身已含 entry 层）。
    const s = effectiveSettingsFn ? effectiveSettingsFn() : Config({ ...readFileLayer() })
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
      models: YAML.parse(YAML.stringify(models)),
    }
    return await hostConfig.applyOps([{ op: 'set', path, value: block }])
  } catch (err) {
    process.stderr.write(`[dsh-tap] trae mirror failed: ${err?.message ?? err}\n`)
    return { ok: false, error: String(err?.message ?? err) }
  }
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

async function setTraeModelEnabled({ id, enabled }) {
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

const bridgeRuntime = { running: false, port: null, lastError: null }

// ---------------------------------------------------------------------------
// Settings route consumed by the Web UI card.
// ---------------------------------------------------------------------------

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Only same-origin writes: POST mutates settings or credentials.
 * allowedOrigins：额外放行的 Origin 完整串（精确匹配，非前缀/通配）。
 * 无 Origin 的 POST 放行：应用壳把页面请求转发到本机 Host 时会剥掉 Origin
 * 头（自定义 scheme 的 Origin host 与回环 Host 不同形，壳侧按自有名单校验
 * 后转发），故壳内写入恒无 Origin——与 GET 侧 localGuardFailure 的「无
 * Origin 放行」同语义。浏览器发起的跨站 POST 恒带 Origin，不受影响；回环
 * Host 门（防 DNS rebinding / LAN 直连）不受影响；非浏览器客户端本就可
 * 伪造任意 Origin 头，此门对它们无额外约束力。 */
function sameOrigin(req, allowedOrigins = []) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (host === undefined) return false
  if (origin === undefined) return true
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return true
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
function localGuardFailure(req, allowedOrigins = []) {
  const host = req.headers.host
  const hostname = typeof host === 'string' ? hostHeaderHostname(host) : null
  if (!hostname || !isLoopbackHostname(hostname)) {
    return `本接口仅限本机访问：Host 必须是回环地址（127.0.0.1/localhost/::1），收到 ${host ?? '(缺失)'}`
  }
  const origin = req.headers.origin
  if (origin !== undefined && !(Array.isArray(allowedOrigins) && allowedOrigins.includes(origin))) {
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

/** cordis.patch.yml 顶层 patch 行的 entry id 清单（insert 行除外）——宿主实况对账的期望集合。 */
function patchEntryIds() {
  try {
    const rows = YAML.parse(readFileSync(PATCH_FILE, 'utf8'))
    return Array.isArray(rows) ? rows.map((r) => r?.id).filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * 宿主实况对账（设置卡只读显示；踩坑 #43/#49 类静默失效的可见信号）：
 * 期望态 = 插件自己的镜像纪律（codebuddy 有效清单长度 / trae·qoder 路由存在性）；
 * 实际态 = hostConfig 读到的宿主配置层合成结果（forms = describe live value，
 * legacy = settings.yaml）。上游把模块改名时 patch 条目被整条跳过、退出码仍 0，
 * 运行时表现就是我们的镜像块从 describe 里消失或条目数对不上——这里把它算出来。
 * id→模块名的权威映射仍是离线的 `dsh --dump-config`（bundle 清单段），这里只做
 * 运行时可得的等价判定（describe 命名空间存在性 + provider 块计数）。
 *
 * patch 条目对账按条目性质分两路（2026-09-26 误报修正——「缺失：web」常驻假 warn）：
 * allNamespaces 只覆盖**注册了 settings 命名空间**的条目；健康的 `web` 钉选行
 * 从来不在其中，拿它当全量预言机就是常驻假 warn（用户会对 warn 脱敏）。
 * - settings 条目（llm-pi-ai / agent-default-model）→ allNamespaces 存在性；
 * - `web` 钉选 → 运行时效果直查：web 服务实例的 searchProviderId/fetchProviderId
 *   公开字段（dsh-web 构造时从 config 落实例字段）。patch 行被跳过 ⇒ config 缺省
 *   ⇒ 两字段 undefined——这是效果级判定，比命名空间在场更接近"用户可感知的事实"。
 */
function hostReconcileView(webService) {
  const s = Config({ ...readFileLayer() })
  const out = {
    mode: hostConfig.mode(),
    servicePresent: hostConfig.servicePresent(),
    missingEntries: null, // forms 模式限定；legacy 无 describe 可查
    webPin: null,
    channels: {},
    drift: [],
  }
  let providers = {}
  try { providers = hostConfig.readProviders() ?? {} } catch { providers = {} }
  if (out.mode === 'forms' && out.servicePresent) {
    try {
      const ns = hostConfig.probe().allNamespaces
      if (Array.isArray(ns)) {
        const have = new Set(ns)
        out.missingEntries = patchEntryIds().filter((id) => !have.has(id) && id !== 'web')
      }
    } catch { out.missingEntries = null }
  }
  // web 钉选行：效果级直查（见 docstring）。searchEnabled=false 时我们的 provider
  // 被注销，但钉选字段仍在（pin 是 config，不是注册状态）——两种状态下都能判。
  // 注意 webPin 不进 drift[]：drift 是通道形状（channel/expected/actual 模型数），
  // 区块头与对账分区分别直读 webPin.ok，避免污染通道行的 warn 不变量。
  try {
    const sp = webService?.()?.searchProviderId
    const fp = webService?.()?.fetchProviderId
    if (sp !== undefined || fp !== undefined || webService?.()) {
      out.webPin = { searchProvider: sp ?? null, fetchProvider: fp ?? null, ok: sp === 'codebuddy' && fp === 'codebuddy' }
    }
  } catch { out.webPin = null }
  // actual = 宿主层 provider 块的 models 数；块不存在 = null（路由缺席）。
  const actualOf = (id) => {
    const block = providers?.[id]
    if (!block || typeof block !== 'object') return null
    return Array.isArray(block.models) ? block.models.length : 0
  }
  const record = (channel, expected, actual, inferred) => {
    out.channels[channel] = { expected, actual, ...(inferred ? { inferred: true } : null) }
    const drifted = expected == null ? actual != null : actual == null || actual !== expected
    if (drifted) out.drift.push({ channel, expected, actual })
  }
  // codebuddy：恒应有路由；期望 = 有效清单长度。legacy 模式下镜像缺席时
  // settings.yaml 读不到 patch 静态基线（它由 bundle patch 层提供），回退静态数
  // 并标 inferred——别把"读不到"误报成漂移。
  const cbActualRaw = actualOf('codebuddy')
  const cbInferred = cbActualRaw == null && out.mode !== 'forms'
  record('codebuddy', computeEffectiveModels().length, cbActualRaw ?? (cbInferred ? readStaticModels().length : null), cbInferred)
  // trae/qoder：路由存在性管理（镜像独占整块）——期望 = 启用且已同步且 ≥1 个
  // 启用模型时的启用数，否则 null（不应存在镜像块）。
  const traeView = traeProvider.catalogView()
  const traeExpected = s.traeEnabled === true && traeView
    ? traeView.profiles.filter((p) => !readTraeModelState().disabled[p.id]).length || null
    : null
  record('trae', traeExpected, actualOf('trae'))
  const qoderView = qoderProvider.catalogView()
  const qoderExpected = s.qoderEnabled === true && qoderView
    ? qoderView.profiles.filter((p) => !readQoderModelState().disabled[p.id]).length || null
    : null
  record('qoder', qoderExpected, actualOf('qoder'))
  return out
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
      // G4 动态目录同步状态：null = 静态兜底（未同步/同步失败且无旧目录）。
      // P2-4：routable = 目录数 − 已知不可路由（恒 11102）在列数。
      sync: dynamicCatalog
        ? {
          at: dynamicCatalog.fetchedAt, count: dynamicCatalog.count, source: 'gateway',
          routable: dynamicCatalog.profiles.filter((p) => !UNROUTABLE_MODELS[p.id]).length,
        }
        : null,
    },
    qoder: {
      oauth: qoderProvider.credentialView(),
      bridge: {
        running: qoderRuntime.running,
        port: qoderRuntime.port,
        lastError: qoderRuntime.lastError,
      },
      models: {
        disabled: Object.keys(readQoderModelState().disabled),
        // 逐模型偏好读侧（UI 契约 qoderModelSetPrefs 的镜像；只含已设置键，
        // 无 effort 键 = 不注入、无 contextVariant 键 = 目录默认档）。
        modelPrefs: readQoderModelPrefs(),
        // 每模型上下文变体清单（目录 context_config；无变体 = []，UI 据此隐藏
        // 该模型的上下文选择）。
        variants: qoderProvider.catalogView()?.variants ?? {},
        sync: qoderProvider.catalogView()
          ? { at: qoderProvider.catalogView().at, count: qoderProvider.catalogView().count }
          : null,
      },
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
 *   POST {action:'qoder-oauth-start'|'qoder-oauth-status'|'qoder-oauth-logout'}
 *                                                           → Qoder CN 设备流（Phase 1 仅登录）
 *   POST {patch:{qoderModelSetEnabled:{id,enabled}}}        → Qoder 逐模型启停 → 镜像
 *   POST {patch:{qoderModelSetPrefs:{id,prefs}}}            → Qoder 逐模型思考强度/上下文
 *                                                             变体（prefs 完整替换；{}
 *                                                             = 删记录回默认）→ 镜像
 *   POST {action:'model-list'}                              → gateway catalog
 *   POST {action:'model-sync'}                              → G4 resync /v3/config → mirror
 *   POST {action:'provider-list'|'provider-add'|'provider-remove'|'provider-refresh'}
 *                                                           → G6 extra OpenAI-compat providers
 *   POST {action:'provider-test'|'credential-test'}         → P2-5「测一下」凭据主动验证
 *                                                             （available 布尔即结论，恒 200）
 *   POST {action:'trae-oauth-*'|'trae-model-*'|'trae-quota'（双池余额只读）}
 *   POST {action:'qoder-oauth-*'|'qoder-model-*'|'qoder-quota'（配额只读）}
 *   POST {action:'usage'}                                   → usage meter + bridge state + quota snapshot
 *   POST {action:'gateway-retry', channel}                  → P2-3 区块头「重试监听」：
 *                                                             重跑该通道 sync*（enabled 限定，见路由处注释）
 *   GET  响应另带 host = 宿主实况对账（镜像漂移检测，只读）
 */
function registerSettingsRoute(ctx, entryConfig, resolveNow, applyLive, retryGateway) {
  ctx.inject(['webServer'], (wsctx) => {
    wsctx.webServer.register({
      kind: 'exact',
      path: '/dsh-tap/settings',
      handler: (request, response) => {
        // 安全审计 [6]+[7]：GET 与 POST 都先过本地门（回环 Host + Origin 一致；
        // localAllowedOrigins 是壳内自定义 scheme Origin 的例外登记，精确匹配）。
        const allowedOrigins = resolveNow().localAllowedOrigins ?? []
        const guardFail = localGuardFailure(request, allowedOrigins)
        if (guardFail) {
          sendJSON(response, 403, { ok: false, error: guardFail })
          return
        }
        if (request.method === 'GET') {
          // 升级排查用：?probe=host-config 报宿主配置层实况（选路/可写性/
          // entry 是否可见/revision/有效 provider 清单），同过本地门。
          const probe = new URL(request.url, 'http://127.0.0.1').searchParams.get('probe')
          if (probe === 'host-config') {
            sendJSON(response, 200, { ok: true, probe: hostConfig.probe() })
            return
          }
          // host = 宿主实况对账（只读；P1）。只挂主 GET——POST 响应的局部视图
          // 不带它，免得每次保存都多跑一遍 describe。
          sendJSON(response, 200, { ...settingsView(resolveNow), host: hostReconcileView(() => ctx.web) })
          return
        }
        if (request.method !== 'POST' || !sameOrigin(request, allowedOrigins)) {
          sendJSON(response, request.method === 'POST' ? 403 : 405, { ok: false })
          return
        }
        // Buffer 收集 + 一次解码（踩坑 #28，同 core/bridge.js）：
        // provider displayName 等中文经逐分片隐式解码同样会损坏。
        const chunks = []
        request.on('data', (c) => {
          chunks.push(c)
        })
        request.on('end', async () => {
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
                    // P2-4：已知不可路由条目（目录在列但 /v2 恒 11102）——
                    // 列表置灰+徽标与「可路由 M」计数的数据源。
                    unroutable: UNROUTABLE_MODELS,
                    profiles,
                    ceilings,
                    // id → 档位名清单，卡片据此给任意行出档位 select。
                    // `efforts` = 基清单（patch 静态 reasoningEfforts ∪ 目录
                    // supportedEfforts 声明）——目录声明优先；"off 但线值为空"
                    // （= 省略参数 = 默认态）不进清单。`staticEfforts` 保留为
                    // patch 静态表视图（旧契约）。
                    efforts: Object.fromEntries(
                      computeBaseModels()
                        .map((m) => [m.id, effortTiersFor(m.id)])
                        .filter(([, tiers]) => tiers.length > 0),
                    ),
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
                await removeExtraProvider(body.id)
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
            // P2-5「测一下」：凭据主动验证。验证结论就是响应本体（available
            // 布尔），失败不是路由故障——恒 200（参数错误除外）。
            if (body?.action === 'provider-test') {
              if (typeof body.id !== 'string') {
                sendJSON(response, 400, { ok: false, error: 'provider-test 需要 id' })
                return
              }
              testExtraProvider(body.id)
                .then((r) => sendJSON(response, 200, { ok: true, available: true, detail: `目录 ${r.modelCount} 个模型` }))
                .catch((err) => sendJSON(response, 200, { ok: true, available: false, error: err.message }))
              return
            }
            // CodeBuddy = 目录面 GET /v3/config（零额度消耗）；Qoder = 签名目录
            // GET（catalog 面 /algo，不是聊天面 prepareInferRequest）。Trae 不在本批。
            if (body?.action === 'credential-test') {
              const ch = body?.channel
              if (ch === 'codebuddy') {
                provider.catalog.fetchModelCatalog(resolveNow)
                  .then((c) => sendJSON(response, 200, { ok: true, available: true, detail: `目录 ${c.models.length} 个模型` }))
                  .catch((err) => sendJSON(response, 200, { ok: true, available: false, error: err.message }))
                return
              }
              if (ch === 'qoder') {
                qoderProvider.syncCatalog()
                  .then((r) => sendJSON(response, 200, r.ok
                    ? { ok: true, available: true, detail: `目录 ${r.count} 个模型` }
                    : { ok: true, available: false, error: r.error }))
                  .catch((err) => sendJSON(response, 200, { ok: true, available: false, error: err.message }))
                return
              }
              sendJSON(response, 400, { ok: false, error: 'credential-test 需要 channel: codebuddy|qoder' })
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
            // P1-2：跨通道余额只读快照（上游只读、零写入；60s memoize 在 provider 内）。
            if (body?.action === 'trae-quota') {
              traeProvider.quota.snapshot()
                .then((quota) => sendJSON(response, 200, { ok: true, quota }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            // ---- Qoder CN 通道 ----
            if (body?.action === 'qoder-oauth-start') {
              qoderProvider.oauth.startOAuth(resolveNow())
                .then((r) => sendJSON(response, 200, { ok: true, authUrl: r.authUrl }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'qoder-oauth-status') {
              sendJSON(response, 200, { ok: true, qoder: qoderProvider.credentialView() })
              return
            }
            if (body?.action === 'qoder-oauth-logout') {
              qoderProvider.oauth.logout()
              sendJSON(response, 200, { ok: true, qoder: qoderProvider.credentialView() })
              return
            }
            if (body?.action === 'qoder-model-sync') {
              qoderProvider.syncCatalog()
                .then((r) => {
                  if (r.ok || qoderProvider.catalogView()) syncQoderModelsToDshSettings()
                  sendJSON(response, 200, { ok: r.ok, sync: r, qoder: settingsView(resolveNow).qoder })
                })
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'qoder-model-list') {
              sendJSON(response, 200, {
                ok: true,
                view: qoderProvider.catalogView(),
                disabled: Object.keys(readQoderModelState().disabled),
              })
              return
            }
            // P1-2：同 trae-quota（openapi 明文面裸 Bearer，零写入）。
            if (body?.action === 'qoder-quota') {
              qoderProvider.quota.snapshot()
                .then((quota) => sendJSON(response, 200, { ok: true, quota }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
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
            // P2-3：区块头「重试监听」。只对已启用通道重跑对应 sync*——禁用分支
            // 会顺带撤镜像（写宿主层 ⇒ profile 重载，踩坑 #44），一次重试不该写配置。
            // 响应立即返回：running 由 'listening' 事件异步翻转，客户端走退避补拉自愈。
            if (body?.action === 'gateway-retry') {
              const ch = body?.channel
              if (ch !== 'codebuddy' && ch !== 'trae' && ch !== 'qoder') {
                throw new Error('gateway-retry 需要 channel: codebuddy|trae|qoder')
              }
              sendJSON(response, 200, { ok: true, retried: retryGateway(ch) })
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
              await setModelEnabled(patch.modelSetEnabled)
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
              await setModelLimits(patch.modelSetLimits)
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
              await setTraeModelEnabled(patch.traeModelSetEnabled)
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
            if (patch.qoderModelSetEnabled !== undefined) {
              const withKeys = { ...nextUser }
              await setQoderModelEnabled(patch.qoderModelSetEnabled)
              const after = readFileLayer()
              delete withKeys.qoderModelState
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: maskedUserLayer(after),
                qoder: settingsView(resolveNow).qoder,
              })
              applyLive()
              return
            }
            if (patch.qoderModelSetPrefs !== undefined) {
              // 同 qoderModelSetEnabled 的层叠纪律：setQoderModelPrefs 内部自写
              // qoderModelPrefs，事后重读层并把本请求里的 apiKeys 改动合回。
              const withKeys = { ...nextUser }
              await setQoderModelPrefs(patch.qoderModelSetPrefs)
              const after = readFileLayer()
              delete withKeys.qoderModelPrefs
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: maskedUserLayer(after),
                qoder: settingsView(resolveNow).qoder,
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
            for (const f of ['traeAuthBaseURL', 'traeChatBaseURL', 'traeLoginHost', 'qoderLoginHost', 'qoderOpenapiBaseURL', 'qoderInferBaseURL']) {
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
  // 端口分流：三端口有效值由 resolveBridgePorts 收口（运行时宿主信号现读，
  // 不缓存），文件层显式端口值优先于分流默认。
  const resolveNow = () => {
    const file = readFileLayer()
    return Config({ ...config, ...file, ...resolveBridgePorts(config, file, currentProfileDirName()) })
  }
  effectiveSettingsFn = resolveNow

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

  // 宿主配置层挂载（dsh 0.1.7 起 settings 服务换了形态，见 host-config.js）：
  // - 0.1.7+：configure({auto:false}) 声明"本插件自带设置卡页面"，宿主不再按
  //   Config schema 自动生成一个页面；模型镜像/路由存在性经 mutate 落 profile patch。
  // - ≤0.1.6：register('dsh-tap', Config) 声明命名空间——旧 `settings.plugin.item`
  //   卡片派发按 Host 服务的命名空间清单走（api-proxy `settings.describe`），
  //   不注册卡片就不出现（踩坑 #30）。
  // 两条路由都由 host-config 按能力自选；读写仍走我们自己的 webServer 路由 +
  // 文件层，seam 只承担"宿主配置层"这一段。
  hostConfig.attach(ctx)

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
    // A wedged listener (EADDRINUSE race with a previous stop, or another
    // instance holding the port) leaves lastError set — do NOT early-return
    // then, or the bridge stays down until restart; fall through and retry.
    if (stopBridge && runningPort === s.bridgePort && !bridgeRuntime.lastError) return
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
    syncQoderBridge()
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
    // Same wedge self-heal as syncBridge above: lastError set = not actually
    // listening, retry instead of early-returning.
    if (stopTraeBridge && traeRunningPort === s.traeBridgePort && !traeRuntime.lastError) return
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

  // Qoder CN 通道生命周期：启用时起翻译网关并同步网关目录（失败静默——
  // 未登录/网络故障时 Qoder 分区只是空转）；禁用时停网关并撤 providers.qoder
  // 镜像（路由存在性管理）。wedge 自愈同 syncBridge：lastError 置位不早退。
  qoderSettingsFn = resolveNow
  let stopQoderBridge = null
  let qoderRunningPort = null
  const syncQoderBridge = () => {
    const s = resolveNow()
    if (s.qoderEnabled !== true) {
      if (stopQoderBridge) {
        stopQoderBridge()
        stopQoderBridge = null
        qoderRunningPort = null
      }
      qoderRuntime.running = false
      qoderRuntime.port = null
      qoderRuntime.lastError = null
      syncQoderModelsToDshSettings()
      return
    }
    if (stopQoderBridge && qoderRunningPort === s.qoderBridgePort && !qoderRuntime.lastError) return
    if (stopQoderBridge) stopQoderBridge()
    qoderRunningPort = s.qoderBridgePort
    qoderRuntime.running = false
    qoderRuntime.port = s.qoderBridgePort
    qoderRuntime.lastError = null
    stopQoderBridge = qoderProvider.gateway.listen(qoderRunningPort)
    qoderProvider.syncCatalog().then((r) => {
      if (r.ok) {
        syncQoderModelsToDshSettings()
        process.stderr.write(`[dsh-tap] qoder catalog synced (${r.count} models)\n`)
      } else if (qoderProvider.catalogView()) {
        syncQoderModelsToDshSettings()
      }
    }).catch(() => {})
  }

  // P2-3：设置卡「重试监听」动作的服务端落点——enabled 限定的定点重跑。
  // 三个 sync* 的 wedge 自愈路径（lastError 置位 ⇒ 不早退、重新 listen）就是重试
  // 语义本身；未启用通道返回 false 并跳过——sync* 的禁用分支会触发镜像撤铺
  // （写宿主层 ⇒ profile 重载，踩坑 #44），一次「重试」不该顺带写配置。
  const retryGateway = (channel) => {
    const s = resolveNow()
    if (channel === 'codebuddy' && s.bridgeEnabled === true) { syncBridge(); return true }
    if (channel === 'trae' && s.traeEnabled === true) { syncTraeBridge(); return true }
    if (channel === 'qoder' && s.qoderEnabled === true) { syncQoderBridge(); return true }
    return false
  }

  applyLive()
  registerSettingsRoute(ctx, config, resolveNow, applyLive, retryGateway)
  // 镜像写入统一交给下面 syncModelsFromGateway 的收尾（成功/失败两条路都会写），
  // **此处不再先铺一次**：那一刻 dynamicCatalog 还是 null，有效清单只含静态基线，
  // 会把宿主里上一次同步成功的完整清单打回残缺态（实测 28 → 16）；且 dsh 0.1.7
  // 起每次写入都会触发 profile patch 重载 → 插件 re-apply → boot 再走一遍，
  // 两次写入互相覆盖，最终停在残缺的那份（踩坑 #43 同批）。
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
    if (stopQoderBridge) stopQoderBridge()
    if (disposeSearch) disposeSearch()
    if (disposeFetch) disposeFetch()
    if (disposeImageTool) disposeImageTool()
    hostConfig.dispose()
    meter.dispose()
  })
}
