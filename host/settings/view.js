/**
 * host/settings/view.js — **设置卡视图**（GET 响应的唯一产地；0.25.0 从 index.js 拆出）。
 *
 * 一次 GET 要回答四件事：当前设置（value）、宿主实况对账（host：镜像漂移/入口缺失/
 * web 钉选）、三通道运行态（bridge.state + 端口/错误/瞬时态）、模型视图
 * （静态/目录/有效清单/覆盖）。全部只读、**零上游调用**——`?probe=*` 是它的两个轻量版。
 *
 * 纪律：视图里每个字段都要有确定的消费点（卡片/胶囊），不产"以后可能用得上"的
 * 字段；`user` 走脱敏，密钥永不出现（踩坑 #26）。
 */

import { readFileSync } from 'node:fs'

import YAML from 'yaml'

import { PATCH_FILE, Config, readFileLayer, hostConfig } from '../config.js'
import { UNROUTABLE_MODELS } from '../../providers/codebuddy/catalog.js'
import { provider, traeProvider, qoderProvider } from '../providers/instances.js'
import { bridgeRuntime, traeRuntime, qoderRuntime } from '../runtime.js'
import { extraProvidersView } from '../providers/registry.js'
import { readMirrorState } from '../models/mirror.js'
import {
  readQoderModelState, readQoderModelPrefs, readTraeModelState, readTraeModelPrefs,
} from '../models/channels.js'
import {
  computeEffectiveModels, readStaticModels, readModelState, creditsView,
  readManualCredits, getDynamicCatalog,
} from '../models/state.js'
import { maskKey, maskedUserLayer } from '../redact.js'

export function patchEntryIds() {
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
export function hostReconcileView(webService) {
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

/**
 * 网关运行态的结构化词汇（客户端只读这个词，不再解析中文文案）：
 *   'off'        = 该通道未启用（用户关掉开关）
 *   'pending'    = 已启用但还没监听上（'listening' 事件尚未到 / 端口被占前的窗口）
 *   'listening'  = 正在服务
 *   'error'      = 监听失败（端口占用等，lastError 有值）
 * 客户端「保存后补拉」只认 pending：既不再靠 /未监听/ 正则（改一句文案就静默
 * 失掉自愈链），也不会在 error 态无限重启。
 */
export function bridgeStateOf({ enabled, running, lastError }) {
  if (enabled !== true) return 'off'
  if (running === true) return 'listening'
  return lastError ? 'error' : 'pending'
}

/** The GET view: resolved settings with secrets masked, plus OAuth status. */
export function settingsView(resolveNow) {
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
    // 宿主镜像台账（三通道最近一次写 profile 的结果）：镜像失败只进 stderr 时
    // 卡片照样显示「已保存 ✓」，用户无从察觉宿主侧没更新。卡片据此出 warn 芯片。
    mirror: readMirrorState(),
    // 手填积分倍率（读侧已归一化）：官方无倍率的模型由用户自己标，仅展示用。
    manualCredits: readManualCredits(),
    // 展示用合并表（官方优先、手填兜底）：设置卡与输入框模型选择器共读这一份。
    credits: creditsView(),
    oauth: provider.oauth.oauthStatus(),
    bridge: {
      running: bridgeRuntime.running,
      port: bridgeRuntime.port,
      lastError: bridgeRuntime.lastError,
      // 最近一次上游限流态（429/6004）：带模型、恢复时刻。供设置卡显示真实状态，
      // 而不是让用户对着一串裸 JSON 猜。零值 = 未限流。
      rateLimit: bridgeRuntime.rateLimit ?? null,
      state: bridgeStateOf({ enabled: s.bridgeEnabled === true, running: bridgeRuntime.running, lastError: bridgeRuntime.lastError }),
    },
    trae: {
      oauth: traeProvider.credentialView(),
      bridge: {
        running: traeRuntime.running,
        port: traeRuntime.port,
        lastError: traeRuntime.lastError,
        state: bridgeStateOf({ enabled: s.traeEnabled === true, running: traeRuntime.running, lastError: traeRuntime.lastError }),
      },
      models: {
        disabled: Object.keys(readTraeModelState().disabled),
        // 逐模型偏好读侧（UI 契约 traeModelSetPrefs 的镜像；只含已设置键）+
        // 目录声明的逐模型档位表（设置卡 select 选项真源，G3）。
        modelPrefs: readTraeModelPrefs(),
        efforts: traeProvider.catalogView()?.efforts ?? {},
        sync: traeProvider.syncView(),
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
      sync: (() => {
        const catalog = getDynamicCatalog()
        return catalog
          ? {
            at: catalog.fetchedAt, count: catalog.count, source: 'gateway',
            routable: catalog.profiles.filter((p) => !UNROUTABLE_MODELS[p.id]).length,
          }
          : null
      })(),
    },
    qoder: {
      oauth: qoderProvider.credentialView(),
      bridge: {
        running: qoderRuntime.running,
        port: qoderRuntime.port,
        lastError: qoderRuntime.lastError,
        // 最近一次上游排队态（10605）：带模型/队列类型/重试间隔。
        // 与 codebuddy 的 rateLimit 同构——都是"上游此刻不可用"的真实状态。
        queue: qoderRuntime.queue ?? null,
        state: bridgeStateOf({ enabled: s.qoderEnabled === true, running: qoderRuntime.running, lastError: qoderRuntime.lastError }),
      },
      models: {
        disabled: Object.keys(readQoderModelState().disabled),
        // 逐模型偏好读侧（UI 契约 qoderModelSetPrefs 的镜像；只含已设置键，
        // 无 effort 键 = 不注入、无 contextVariant 键 = 目录默认档）。
        modelPrefs: readQoderModelPrefs(),
        // 每模型上下文变体清单（目录 context_config；无变体 = []，UI 据此隐藏
        // 该模型的上下文选择）。
        variants: qoderProvider.catalogView()?.variants ?? {},
        // 每模型**目录声明的思考档位**（thinking_config → qoderEffortTiers；
        // 未声明命名档位 = []）。设置卡 select 的选项真源——与宿主「推理等级」
        // 同一份声明，UI 不再用固定表（0.19.0）。
        efforts: qoderProvider.catalogView()?.efforts ?? {},
        sync: qoderProvider.catalogView()
          ? { at: qoderProvider.catalogView().at, count: qoderProvider.catalogView().count }
          : null,
      },
    },
  }
}
