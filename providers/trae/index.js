/**
 * providers/trae/index.js — TraeWork CN（api.trae.cn / trae-api-cn.mchost.guru）
 * 薄适配器。
 *
 * 与 providers/codebuddy/ 同构：本目录收敛全部 Trae 上游事实（OAuth 设备流、
 * 本地模型目录、云端翻译网关、错误信封），core/ 与组合根通过结构钩子消费。
 * 规则/事实依据：Trae 云 API 与 OAuth 设备流的实测校准结论已内联在各模块文件头。
 *
 * 凭据形态与 codebuddy 的差异：Trae 只有 OAuth 一种模式（订阅额度跟账号走），
 * 没有多 Key 轮换；设备密钥自持（oauth.js 文件头），刷新可自控。
 */

import { createTraeOAuth } from './oauth.js'
import { fetchLocalCatalog } from './catalog.js'
import { createTraeGateway } from './gateway.js'

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
 * }} deps
 */
export function createTraeProvider(deps) {
  const oauth = createTraeOAuth({ readAuth: deps.readAuth, writeAuth: deps.writeAuth })

  // 目录实例状态（模块作用域每插件实例一份，踩坑 #20 纪律）。
  let catalogState = null // { profiles, catalog, fetchedAt, source }

  const provider = {
    id: TRAE_PROVIDER_ID,
    oauth,

    /** 从本机 state.vscdb 同步目录（单飞）。返回 {ok, count|error, kept}。 */
    async syncCatalog({ dbPath } = {}) {
      try {
        const result = fetchLocalCatalog({ dbPath })
        catalogState = result
        return { ok: true, count: result.profiles.length, fetchedAt: result.fetchedAt, source: result.source }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err), kept: catalogState != null }
      }
    },

    catalogView() {
      return catalogState
        ? {
            at: catalogState.fetchedAt,
            count: catalogState.profiles.length,
            candidate: catalogState.source.chosen,
            profiles: catalogState.profiles,
          }
        : null
    },

    /** 已同步目录 id（/models 端点与镜像同步用）。 */
    catalogIds() {
      return catalogState ? catalogState.profiles.map((p) => p.id) : []
    },

    /** 凭据视图（设置卡）。 */
    credentialView() {
      return oauth.oauthStatus()
    },
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
  })
  provider.gateway = gateway

  return provider
}
