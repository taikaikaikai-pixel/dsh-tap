/**
 * host/settings/actions.js — 设置路由的 **28 个 action**（0.25.0 从 index.js 拆出）。
 *
 * 表驱动：`createActions(deps)` 返回 `{ action: (body, reply) => Promise|void }`，
 * 路由只做 `ACTIONS[body.action]?.(body, reply)`。每个动作的**函数体与拆分前逐字
 * 相同**（只把 `sendJSON(response, …)` 改成 `reply(…)`）——这样契约闸门
 * `verify-route-contract.mjs` 的 28 条断言在拆分前后是同一份期望值。
 *
 * 约定：
 *  - `reply(status, payload)` = 设置面的唯一出口（`{ok,…}` 信封，踩坑 #79）；
 *  - 需要"本代设置"的动作经 `deps.resolveNow()` 现读（不缓存，见 config.js）；
 *  - 异步动作必须 `await`（路由会 await 后再收尾）；fire-and-forget 的
 *    `.then/.catch` 保持原样（它们自带 reply）。
 */

import { describeError } from '../../core/errors.js'
import { buildQuotaView } from '../../quota-view.js'
import { Config, SETTINGS_FIELDS, readFileLayer, hostConfig } from '../config.js'
import { UNROUTABLE_MODELS } from '../../providers/codebuddy/catalog.js'
import { scanLocalCredentials, readImportCredential } from '../../local-scan.js'
import { provider, traeProvider, qoderProvider, meter } from '../providers/instances.js'
import {
  PROVIDER_PRESETS, extraProvidersView, addExtraProvider, removeExtraProvider,
  testExtraProvider, refreshExtraProviderModels,
} from '../providers/registry.js'
import { syncModelsFromGateway, setModelEnabled, setModelLimits } from '../models/mirror.js'
import {
  syncQoderModelsToDshSettings, syncTraeModelsToDshSettings,
  readQoderModelState, readTraeModelState, isSafeStateDbPath,
  setQoderModelEnabled, setQoderModelPrefs, setTraeModelEnabled, setTraeModelPrefs,
  qoderEffortScope, qoderDeclaredTiers, traeDeclaredTiers, readQoderModelPrefs, readTraeModelPrefs,
} from '../models/channels.js'
import {
  readStaticModels, readModelState, computeBaseModels, computeEffectiveModels,
  effortTiersFor, creditsFromCatalog, setOfficialCredits, readManualCredits, setManualCredits,
  catalogToProfile,
} from '../models/state.js'
import { bridgeRuntime, qoderRuntime } from '../runtime.js'
import { settingsView } from './view.js'

/**
 * @param {{ resolveNow: () => object, applyLive: () => void, retryGateway: (ch: string) => boolean }} deps
 */
export function createActions({ resolveNow, applyLive, retryGateway, channels }) {
  return {
    'oauth-start': async (body, reply) => {
            provider.oauth.startOAuth(resolveNow().baseURL)
              .then((r) => reply(200, { ok: true, authUrl: r.authUrl }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'oauth-status': async (body, reply) => {
            reply(200, { ok: true, oauth: provider.oauth.oauthStatus() })
            return
    },
    'model-list': async (body, reply) => {
            provider.catalog.fetchModelCatalog(resolveNow)
              .then((catalog) => {
                // 卡片每次拉列表都刷新一次官方倍率（与启动同步同一份内存真源）：
                // 输入框选择器的徽标靠它，不然同步失败后只有手填值可见。
                setOfficialCredits(creditsFromCatalog(catalog.models))
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
                reply(200, {
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
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'model-sync': async (body, reply) => {
            syncModelsFromGateway(resolveNow)
              .then((r) => reply(200, { ok: true, sync: r, models: settingsView(resolveNow).models }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'provider-list': async (body, reply) => {
            reply(200, {
              ok: true,
              providers: extraProvidersView(),
              presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, displayName: p.displayName, baseURL: p.baseURL })),
            })
            return
    },
    'provider-add': async (body, reply) => {
            addExtraProvider(body)
              .then((r) => reply(200, { ok: true, added: r, providers: extraProvidersView() }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'provider-remove': async (body, reply) => {
            try {
              if (typeof body.id !== 'string') throw new Error('provider-remove 需要 id')
              await removeExtraProvider(body.id)
              reply(200, { ok: true, providers: extraProvidersView() })
            } catch (err) {
              reply(400, { ok: false, error: describeError(err).message })
            }
            return
    },
    'provider-refresh': async (body, reply) => {
            if (typeof body.id !== 'string') {
              reply(400, { ok: false, error: 'provider-refresh 需要 id' })
              return
            }
            refreshExtraProviderModels(body.id)
              .then((r) => reply(200, { ok: true, refreshed: r, providers: extraProvidersView() }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'provider-test': async (body, reply) => {
            if (typeof body.id !== 'string') {
              reply(400, { ok: false, error: 'provider-test 需要 id' })
              return
            }
            testExtraProvider(body.id)
              .then((r) => reply(200, { ok: true, available: true, detail: `目录 ${r.modelCount} 个模型` }))
              .catch((err) => reply(200, { ok: true, available: false, error: describeError(err).message }))
            return
    },
    'credential-test': async (body, reply) => {
            const ch = body?.channel
            if (ch === 'codebuddy') {
              provider.catalog.fetchModelCatalog(resolveNow)
                .then((c) => reply(200, { ok: true, available: true, detail: `目录 ${c.models.length} 个模型` }))
                .catch((err) => reply(200, { ok: true, available: false, error: describeError(err).message }))
              return
            }
            if (ch === 'qoder') {
              qoderProvider.syncCatalog()
                .then((r) => reply(200, r.ok
                  ? { ok: true, available: true, detail: `目录 ${r.count} 个模型` }
                  : { ok: true, available: false, error: r.error }))
                .catch((err) => reply(200, { ok: true, available: false, error: describeError(err).message }))
              return
            }
            reply(400, { ok: false, error: 'credential-test 需要 channel: codebuddy|qoder' })
            return
    },
    'credential-scan': async (body, reply) => {
            reply(200, { ok: true, findings: scanLocalCredentials() })
            return
    },
    'credential-import': async (body, reply) => {
            let spec
            try {
              spec = readImportCredential(scanLocalCredentials(), body?.source)
            } catch (err) {
              reply(400, { ok: false, error: describeError(err).message })
              return
            }
            // 命中同名 preset（同 id 同 baseURL）走 preset 通道——拿到
            // fallbackModels 等先验；否则按自定义上游严格校验（必须有 /models）。
            const presetHit = PROVIDER_PRESETS.find((p) => p.id === spec.id && p.baseURL === spec.baseURL)
            addExtraProvider(presetHit
              ? { preset: presetHit.id, apiKey: spec.apiKey }
              : { id: spec.id, baseURL: spec.baseURL, displayName: spec.displayName, apiKey: spec.apiKey })
              .then((r) => reply(200, { ok: true, added: r, providers: extraProvidersView(), findings: scanLocalCredentials() }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'oauth-logout': async (body, reply) => {
            provider.oauth.logout()
            reply(200, { ok: true, oauth: provider.oauth.oauthStatus() })
            return
    },
    'trae-oauth-start': async (body, reply) => {
            traeProvider.oauth.startOAuth(resolveNow())
              .then((r) => reply(200, { ok: true, authUrl: r.authUrl }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'trae-oauth-status': async (body, reply) => {
            reply(200, { ok: true, trae: traeProvider.credentialView() })
            return
    },
    'trae-oauth-logout': async (body, reply) => {
            traeProvider.oauth.logout()
            reply(200, { ok: true, trae: traeProvider.credentialView() })
            return
    },
    'trae-model-sync': async (body, reply) => {
            // 安全审计 [18] 纵深防御：dbPath 是读文件的调用方输入——必须
            // 绝对路径、规范化后无 .. 段、扩展名限 .db/.vscdb。不存在的
            // 路径不在此预检，交给既有同步错误路径（502 + 原因）。
            const dbPath = body?.dbPath
            if (dbPath !== undefined && !isSafeStateDbPath(dbPath)) {
              throw new Error('dbPath 必须是绝对路径、不含 .. 段且以 .db/.vscdb 结尾')
            }
            traeProvider.syncCatalog(typeof dbPath === 'string' ? { dbPath } : {})
              .then(async (r) => {
                // 与 qoder 同一条守卫：目录同步失败且没有既有目录时**不重铺镜像**
                // ——syncTraeModelsToDshSettings 在 catalogView() 为 null 时会
                // `unset providers.trae`，等于一次失败的「同步目录」把选择器里的
                // Trae 路由整块抹掉。有旧目录才允许重铺（保留旧清单）。
                if (r.ok || traeProvider.catalogView()) await syncTraeModelsToDshSettings()
                reply(200, { ok: r.ok, sync: r, trae: settingsView(resolveNow).trae })
              })
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'trae-model-list': async (body, reply) => {
            reply(200, {
              ok: true,
              view: traeProvider.catalogView(),
              disabled: Object.keys(readTraeModelState().disabled),
            })
            return
    },
    'trae-quota': async (body, reply) => {
            traeProvider.quota.snapshot()
              .then((quota) => reply(200, { ok: true, quota }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'qoder-oauth-start': async (body, reply) => {
            qoderProvider.oauth.startOAuth(resolveNow())
              .then((r) => reply(200, { ok: true, authUrl: r.authUrl }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'qoder-oauth-status': async (body, reply) => {
            reply(200, { ok: true, qoder: qoderProvider.credentialView() })
            return
    },
    'qoder-oauth-logout': async (body, reply) => {
            qoderProvider.oauth.logout()
            reply(200, { ok: true, qoder: qoderProvider.credentialView() })
            return
    },
    'qoder-model-sync': async (body, reply) => {
            qoderProvider.syncCatalog()
              .then((r) => {
                if (r.ok || qoderProvider.catalogView()) syncQoderModelsToDshSettings()
                reply(200, { ok: r.ok, sync: r, qoder: settingsView(resolveNow).qoder })
              })
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'qoder-model-list': async (body, reply) => {
            reply(200, {
              ok: true,
              view: qoderProvider.catalogView(),
              disabled: Object.keys(readQoderModelState().disabled),
            })
            return
    },
    'qoder-quota': async (body, reply) => {
            qoderProvider.quota.snapshot()
              .then((quota) => reply(200, { ok: true, quota }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'usage': async (body, reply) => {
            // 并行取两侧额度：CodeBuddy（billing/meter）与 Qoder（quota/usage 官方计数器）。
            // 两者都自带 60s memoize、永不 throw —— 失败只让对应那一行显示「—」。
            Promise.all([
              provider.catalog.quotaSnapshot(resolveNow),
              qoderProvider.quota.snapshot().catch(() => null),
            ])
              .then(([quota, qoderQuota]) => reply(200, {
                ok: true,
                usage: meter.view(),
                bridge: {
                  enabled: resolveNow().bridgeEnabled === true,
                  running: bridgeRuntime.running,
                  port: bridgeRuntime.port,
                  lastError: bridgeRuntime.lastError,
                },
                quota,
                qoderQuota,
              }))
              .catch((err) => reply(502, { ok: false, error: describeError(err).message }))
            return
    },
    'quota-all': async (body, reply) => {
      // 按通道清单并发取额度：每条通道只提供 `quota({fresh})`，归一化与合计口径
      // 在 quota-view.js（加通道 = 加一个适配器，不改这里）。
      const fresh = body?.fresh === true
      const snaps = await Promise.all(channels.map((ch) => (typeof ch.quota === 'function'
        ? Promise.resolve(ch.quota({ fresh, resolveNow })).catch(() => null)
        : Promise.resolve(null))))
      const byChannel = Object.fromEntries(channels.map((ch, i) => [ch.id, snaps[i]]))
      reply(200, {
        ok: true,
        enabled: resolveNow().quotaDockEnabled !== false,
        quota: buildQuotaView({
          channels: byChannel,
          meter: meter.view(),
          manualTotal: resolveNow().quotaTotalManual,
          noQuotaProviders: extraProvidersView().length,
        }),
      })
    },

    'gateway-retry': async (body, reply) => {
      const ch = body?.channel
      // 通道 id 清单来自组合根的清单：加通道自动被接受，不用改这里。
      if (!channels.some((c) => c.id === ch)) {
        throw new Error(`gateway-retry 需要 channel: ${channels.map((c) => c.id).join('|')}`)
      }
      reply(200, { ok: true, retried: retryGateway(ch) })
    },
  }
}
