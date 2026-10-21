/**
 * host/config.js — 组合根的**配置与路径事实**（0.25.0 从 index.js 拆出）。
 *
 * 这里只放「谁都要读、谁都别改」的东西：DSH 路径、Config schema、设置卡字段表、
 * baseURL 校验、文件层读写、桥端口分流、宿主配置层实例（hostConfig）。
 *
 * 为什么单独一份：拆分前这些定义在 index.js 顶部与中部各一段，`host/**` 的任何
 * 模块（模型状态、镜像、设置视图、路由动作）都要用；留在组合根里就会形成
 * 「模块反向 import 组合根」的环。边界 = **无业务逻辑**，只有解析与 IO 原语。
 */

import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

import { readJson, writeJson } from '../core/json-store.js'
import { isLoopbackHostname } from '../core/net-guard.js'
import { createHostConfigLayer } from '../host-config.js'
import { QODER_CLIENT_ID } from '../providers/qoder/oauth.js'

export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const SETTINGS_PATH = join(DSH_HOME, 'codebuddy-plugin.json')
export const AUTH_PATH = join(DSH_HOME, 'codebuddy-plugin-auth.json')
export const TRAE_AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
export const QODER_AUTH_PATH = join(DSH_HOME, 'qoder-plugin-auth.json')
export const DSH_SETTINGS_PATH = join(DSH_HOME, 'settings.yaml')
export const DSH_CREDENTIALS_PATH = join(DSH_HOME, '.credentials.yaml')
export const PATCH_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cordis.patch.yml')

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
  // 主界面额度卡（v0.22.0）：输入框下方的胶囊显示跨通道合计额度，悬停/点击展开
  // 逐通道明细。数据 = POST /dsh-tap/settings {action:'quota-all'}（只读额度端点，
  // 零额度消耗）。关掉后主界面完全不出现该胶囊（设置卡额度区不受影响）。
  quotaDockEnabled: z.boolean().default(true),
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
  // 聊天传输：agent（默认，2026-10-05 起，llm_utils_chat+solo_work_lite——原生
  // tools + 并行调用 + role:tool 回传闭环（历史 assistant.tool_calls 出站键=
  // function_call）；模型位钉死 glm-5.2（timing_cost 真值源，改派诚实披露）；
  // reasoning_effort 被忽略；耗 IDE 额度池。证据 docs/probes/trae-agent-v3-*.jsonl）
  // | inline（llm_utils_chat+inline_chat——模型恒为账户默认，原生 tools，耗 IDE 池；
  // 2026-08-24 起服务端 3003 故障未愈，docs/diagnosis-trae-3003.md）
  // | remote（chat_sessions——模型选择真实生效，不支持 tools，每请求起云端沙箱
  // agent，耗 work 额度池，providers/trae/remote.js 文件头）。
  // 默认值 inline→agent 的决策（2026-10-05 用户拍板）：主聊天恒带 agent 工具表，
  // inline 故障期对主聊天必炸 3003；agent 面工具环可用（模型钉死已诚实披露）。
  traeChatTransport: z.union([z.const('inline'), z.const('remote'), z.const('agent')]).default('agent'),
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
  { key: 'quotaDockEnabled', kind: 'boolean' },
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
 * 本机回环判定唯一实现：`core/net-guard.js`（踩坑 #80）。本文件只保留
 * 「明文 http 仅限回环」这条 baseURL 校验，Host/Origin 门的判定与文案都不再
 * 自己写——设置路由拿到结构化 code，再翻成中文拒绝原因。
 */

/** Validate a baseURL candidate before it can reach a provider. */
export function validateBaseURL(value) {
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

export const readFileLayer = () => readJson(SETTINGS_PATH)
export const writeFileLayer = (section) => writeJson(SETTINGS_PATH, section)
export const readAuth = () => readJson(AUTH_PATH)
export const writeAuth = (v) => writeJson(AUTH_PATH, v)

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
export function currentProfileDirName() {
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
export function resolveBridgePorts(entryLayer, fileLayer, profileDirName) {
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
 * 迟绑定设置源：`apply()` 内把本代的 `resolveNow` 挂上来——镜像/网关工厂都是
 * 模块级（模块加载期就要拿到 settings 函数），而 resolveNow 只有 apply 时才有。
 * 三通道各一格：effective（决定端口与镜像 baseURL 的那一代）、trae、qoder。
 *
 * 纪律：镜像的端**必须**经 effective 解析（listen 端口与镜像 baseURL 同源同一次
 * 解析，根除双路径漂移）；未赋值（apply 前的理论窗口）回退纯文件层默认语义。
 */
export const settingsRef = {
  effective: null,
  trae: () => ({ traeEnabled: false }),
  qoder: () => ({ qoderEnabled: false }),
}

/**
 * 宿主配置层通道（dsh 0.1.7 起 = Settings forms seam，写落 profile 的
 * cordis.patch.yml；≤0.1.6 回退 ~/.dsh/settings.yaml 文档编辑）。
 * 详见 host-config.js 的头注释——两代宿主的差异全部收在那一处。
 */
export const hostConfig = createHostConfigLayer({
  settingsPath: DSH_SETTINGS_PATH,
  schema: Config,
  log: (m) => process.stderr.write(`${m}\n`),
})
