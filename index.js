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
import { createBridge } from './core/bridge.js'
import { isLoopbackHostname, localGuardFailure } from './core/net-guard.js'
import { sendJSON, readBody, createChannelRuntime } from './core/http-surface.js'
import { describeError } from './core/errors.js'
import { UNROUTABLE_MODELS } from './providers/codebuddy/catalog.js'
import { scanLocalCredentials, readImportCredential } from './local-scan.js'
import { createHostConfigLayer } from './host-config.js'
import { normalizeCredits, mergeCredits, CREDIT_CHANNELS } from './credits.js'
import { buildQuotaView } from './quota-view.js'
import {
  Config, SETTINGS_FIELDS, readFileLayer, resolveBridgePorts,
  currentProfileDirName, hostConfig, settingsRef,
} from './host/config.js'
import {
  effortWireFor, setExtraCreditsSource,
} from './host/models/state.js'
import { registerSettingsRoute } from './host/settings/route.js'
import { createChannels } from './host/channels/index.js'
import { bridgeRuntime, traeRuntime, qoderRuntime } from './host/runtime.js'
import {
  provider, meter, traeProvider, qoderProvider,
  prefsRef, withKeyRotation, wireRef,
} from './host/providers/instances.js'
import {
  syncModelsFromGateway,
} from './host/models/mirror.js'
import {
  syncQoderModelsToDshSettings, syncTraeModelsToDshSettings, readQoderModelPrefs, readTraeModelPrefs,
} from './host/models/channels.js'

export { Config, SETTINGS_FIELDS } from './host/config.js'
export { makeSearchProvider } from './host/providers/instances.js'

export const name = 'dsh-tap'

/** web providers via ctx.web; the settings route rides ctx.webServer when present. */
export const inject = ['web']


// ---------------------------------------------------------------------------
// 迟绑定槽（模块级单例 ↔ apply 代际之间的桥；被依赖模块不许反向 import）
// ---------------------------------------------------------------------------

// 逐模型思考档位偏好与线值：读侧在 host/models（state/channels），provider 单例
// 在 host/providers——两边都不许 import 对方，故由组合根在装配时填指针。
prefsRef.qoder = readQoderModelPrefs
prefsRef.trae = readTraeModelPrefs
wireRef.effort = effortWireFor
// 官方倍率：qoder 目录自带逐模型 price_factor；状态层不反向 import provider 单例。
setExtraCreditsSource(() => ({ qoder: qoderProvider.catalogView()?.credits ?? {} }))

export function apply(ctx, config = {}) {
  // entry < file; schema defaults fill the rest. Live-resolved per read.
  // 端口分流：三端口有效值由 resolveBridgePorts 收口（运行时宿主信号现读，
  // 不缓存），文件层显式端口值优先于分流默认。
  const resolveNow = () => {
    const file = readFileLayer()
    return Config({ ...config, ...file, ...resolveBridgePorts(config, file, currentProfileDirName()) })
  }
  settingsRef.effective = resolveNow

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
      process.stderr.write(`[dsh-tap] image_generate register failed: ${describeError(err).message}\n`)
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
    channel: 'codebuddy', // 用量按通道归属（core/ 不认识上游，名字只能在组合根给）
    withCredentials: (attempt) => withKeyRotation(resolveNow, attempt),
    meter,
    forensics: {
      logPath: () => process.env.CODEBUDDY_BRIDGE_LOG,
      dumpDir: () => process.env.CODEBUDDY_BRIDGE_DUMP,
    },
    runtime: bridgeRuntime,
  })
  // 通道生命周期：**按清单迭代**（0.26.0）。每条通道只声明 settings 键、runtime
  // 台账与 listen 工厂，起停/清态/wedge 自愈仍由 core/http-surface.js 的
  // createChannelRuntime 一处实现——加通道不再改这三段装配代码。
  settingsRef.trae = resolveNow
  settingsRef.qoder = resolveNow
  const channels = createChannels({ bridge })
  const live = {}
  for (const ch of channels) {
    live[ch.id] = createChannelRuntime({
      runtime: ch.runtime,
      listen: ch.listen,
      stateOf: () => {
        const s = resolveNow()
        return { enabled: s[ch.settings.enabled] === true, port: s[ch.settings.port] }
      },
      onDisabled: ch.onDisabled ?? null,
      onStarted: ch.onStarted ?? null,
    })
  }

  const applyLive = () => {
    syncProviders()
    syncImageTool()
    for (const ctl of Object.values(live)) ctl.sync()
  }

  // P2-3：设置卡「重试监听」的服务端落点——enabled 限定的定点重跑。retry() 就是
  // wedge 自愈那条路（lastError 置位 ⇒ 不早退、重新 listen）；未启用返回 false
  // 且什么都不做（禁用分支会撤镜像 → 写宿主层 → profile 重载，踩坑 #44）。
  const retryGateway = (channel) => (live[channel] ? live[channel].retry() : false)

  applyLive()
  registerSettingsRoute(ctx, { resolveNow, applyLive, retryGateway, entryConfig: config, channels })
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
    for (const ctl of Object.values(live)) ctl.stop()
    if (disposeSearch) disposeSearch()
    if (disposeFetch) disposeFetch()
    if (disposeImageTool) disposeImageTool()
    hostConfig.dispose()
    meter.dispose()
  })
}
