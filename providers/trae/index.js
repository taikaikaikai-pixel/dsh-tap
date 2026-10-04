/**
 * providers/trae/index.js — TraeWork CN（api.trae.cn / trae-api-cn.mchost.guru）
 * 薄适配器。
 *
 * 与 providers/codebuddy/ 同构：本目录收敛全部 Trae 上游事实（OAuth 设备流、
 * 本地模型目录、云端翻译网关、错误信封），core/ 与组合根通过结构钩子消费。
 * 规则/证据文档：
 *   - docs/reverse/traework-cn.md       → OAuth 与云端面逆向档案
 *   - docs/reverse/trae-cloud-api.md    → 2026-08-23 无凭据探测校准（网关/信封）
 *   - docs/reverse/trae-model-catalog.md → 目录提取安全契约
 *
 * 凭据形态与 codebuddy 的差异：Trae 只有 OAuth 一种模式（订阅额度跟账号走），
 * 没有多 Key 轮换；设备密钥自持（oauth.js 文件头），刷新可自控。
 */

import { createTraeOAuth } from './oauth.js'
import { fetchLocalCatalog } from './catalog.js'
import { createTraeGateway } from './gateway.js'
import { createTraeQuota } from './quota.js'

export const TRAE_PROVIDER_ID = 'trae'

/**
 * @param {{
 *   readAuth: () => object,
 *   writeAuth: (v: object) => void,
 *   settings: () => object,
 *   withCredentials: (attempt: (cred) => Promise<Response>) => Promise<{cred,res,err}>,
 *   meter: { record: Function },
 *   runtime: { running: boolean, port: number|null, lastError: string|null },
 *   forensics?: { logPath: () => string|undefined },
 *   getModelPrefs?: () => object,  // { [id]: { effort? } } remote 出站补默认档位（G3）
 * }} deps
 */
export function createTraeProvider(deps) {
  const oauth = createTraeOAuth({ readAuth: deps.readAuth, writeAuth: deps.writeAuth })

  // 目录实例状态（模块作用域每插件实例一份，踩坑 #20 纪律）。
  let catalogState = null // { profiles, catalog, fetchedAt, source }
  let lastSyncError = null // 最近一次同步失败原因（成功即清空；设置卡模型区显示用）

  const provider = {
    id: TRAE_PROVIDER_ID,
    oauth,

    /** 从本机 state.vscdb 同步目录（单飞）。返回 {ok, count|error, kept}。 */
    async syncCatalog({ dbPath } = {}) {
      try {
        const result = fetchLocalCatalog({ dbPath })
        catalogState = result
        lastSyncError = null
        return { ok: true, count: result.profiles.length, fetchedAt: result.fetchedAt, source: result.source }
      } catch (err) {
        lastSyncError = err?.message ?? String(err)
        return { ok: false, error: lastSyncError, kept: catalogState != null }
      }
    },

    catalogView() {
      return catalogState
        ? {
            at: catalogState.fetchedAt,
            count: catalogState.profiles.length,
            candidate: catalogState.source.chosen,
            profiles: catalogState.profiles,
            // 逐模型目录声明档位（reasoning_effort_config.options 原文拼写，G3）——
            // 设置卡 select 选项与 traeModelSetPrefs 校验的真源（上游词汇；宿主
            // 选择器侧的枚举键映射在 catalogToProfiles 的 reasoningEfforts 里）。
            // 未声明模型不在场。
            efforts: Object.fromEntries(
              (catalogState.catalog?.models ?? [])
                .filter((m) => m.reasoningEffortConfig?.supportThinking === true
                  && Array.isArray(m.reasoningEffortConfig.options) && m.reasoningEffortConfig.options.length)
                .map((m) => [m.id, m.reasoningEffortConfig.options])),
          }
        : null
    },

    /** 设置卡模型区的同步状态：成功 → {at,count,candidate}；失败 → 附 error
     * （有旧清单则连同旧计数一起给 = kept 语义；从未成功过则只有 error）。 */
    syncView() {
      if (!catalogState) return lastSyncError ? { error: lastSyncError } : null
      const view = {
        at: catalogState.fetchedAt,
        count: catalogState.profiles.length,
        candidate: catalogState.source.chosen,
      }
      if (lastSyncError) view.error = lastSyncError
      return view
    },

    /** 已同步目录 id（/models 端点与镜像同步用）。 */
    catalogIds() {
      return catalogState ? catalogState.profiles.map((p) => p.id) : []
    },

    /** 凭据视图（设置卡）。 */
    credentialView() {
      return oauth.oauthStatus()
    },

    /** 双额度池余额只读快照（60s memoize，永不 throw）。 */
    quota: createTraeQuota({ settings: deps.settings, readAuth: deps.readAuth, oauth }),
  }

  const gateway = createTraeGateway({
    settings: deps.settings,
    withCredentials: deps.withCredentials,
    readAuthDevice: () => deps.readAuth().device ?? null,
    readAuthMeta: () => ({ uid: deps.readAuth().account?.uid ?? null }),
    meter: deps.meter,
    runtime: deps.runtime,
    forensics: deps.forensics,
    getCatalogIds: () => provider.catalogIds(),
    getModelPrefs: deps.getModelPrefs ?? (() => ({})),
  })
  provider.gateway = gateway

  return provider
}
