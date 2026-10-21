/**
 * providers/qoder/index.js — Qoder CN（qoder.cn）薄适配器工厂。
 *
 * 与 providers/trae/ 同构：本目录收敛全部 Qoder 上游事实——
 *   oauth.js    设备流（PKCE S256，poll 404=未完成，refresh drt- 前缀）
 *   cosy.js     COSY WASM 签名运行时（手写胶水 + 官方 wasm 字节）
 *   catalog.js  /algo/api/v2/model/list 目录（签名 GET，明文/密文两态）
 *   gateway.js  OpenAI ↔ COSY SSE 翻译网关（:3903 默认）
 *
 * 规则/证据文档：docs/goals/qoder-cn-provider-design.md（2026-09-20 修订：
 * 聊天面 = prepareInferRequest → agent_chat_generation，OpenAI 面
 * api2-v2.qoder.sh 对本账号 401 不可用，不要再走）。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createQoderOAuth } from './oauth.js'
import { createCosyRuntime } from './cosy.js'
import { fetchQoderCatalog } from './catalog.js'
import { createQoderGateway } from './gateway.js'
import { createQoderQuota } from './quota.js'

export const QODER_PROVIDER_ID = 'qoder'

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'qoder_auth.wasm')

/**
 * @param {{
 *   readAuth: () => object,
 *   writeAuth: (v: object) => void,
 *   settings: () => object,
 *   meter: { record: Function },
 *   runtime: { running: boolean, port: number|null, lastError: string|null },
 *   forensics?: { logPath: () => string|undefined },
 *   getModelPrefs?: () => object,  // { [id]: { effort?, contextVariant? } } 出站补默认
 * }} deps
 */
/**
 * 目录原始条目 → 每模型勋章位（与 CodeBuddy 模型行的 插件/CLI/图/思考 同构）。
 * 映射依据（2026-10-20 实测 14 条 chat 条目字段全集：
 * key/format/source/enable/display_name/is_vl/is_reasoning/is_default/
 * price_factor/max_input_tokens/is_sensitive/context_config）：
 *   - cli   : source === 'system'（官方 CLI 线缆可达；非 system 的 BYOK 面不算）
 *   - image : is_vl === true
 *   - think : is_reasoning === true
 *   - free  : price_factor === 0（R-Q8：x0.00 ⟺ 零计费，已被 qfmodel 实测交叉验证）
 *   - 新    : is_new === true（目录促销位；缺省不显示）
 * 只下发布尔，缺字段一律 false（不编造）。
 */
export function qoderBadges(entries) {
  const out = {}
  for (const [key, e] of Object.entries(entries ?? {})) {
    if (!e || typeof e !== 'object') continue
    out[key] = {
      cli: e.source === 'system',
      image: e.is_vl === true,
      think: e.is_reasoning === true,
      free: e.price_factor === 0,
      fresh: e.is_new === true,
    }
  }
  return out
}

export function createQoderProvider(deps) {
  const oauth = createQoderOAuth({ readAuth: deps.readAuth, writeAuth: deps.writeAuth })
  const cosy = createCosyRuntime({ wasmPath: WASM_PATH })

  // 目录实例状态（模块作用域每插件实例一份，踩坑 #20 纪律）。
  let catalogState = null // { profiles, sources, variants, fetchedAt }
  // 单飞：并发 syncCatalog 共享同一在飞请求——并发时互相完整覆盖 catalogState
  // 不损坏但浪费上游请求；codebuddy 侧在组合根单飞（index.js），口径对齐于此。
  let syncInFlight = null

  const provider = {
    id: QODER_PROVIDER_ID,
    oauth,
    cosy,

    /**
     * 从网关同步目录（单飞：并发调用共享同一在飞 Promise）。返回
     * {ok, count|error, kept}；未登录时报 ok:false 且不清旧目录。
     */
    async syncCatalog() {
      if (syncInFlight) return syncInFlight
      const run = (async () => {
        const s = deps.settings()
        let cred
        try {
          cred = await oauth.resolveQoderCredential(s)
        } catch (err) {
          return { ok: false, error: err?.message ?? String(err), kept: catalogState != null }
        }
        if (!cred) return { ok: false, error: '未登录（先完成 Qoder 浏览器授权）', kept: catalogState != null }
        try {
          const accessToken = String(cred.authorization).replace(/^Bearer\s+/, '')
          const result = await fetchQoderCatalog(cosy, { accessToken, machineId: cred.machineId, uid: cred.uid }, s.qoderInferBaseURL)
          catalogState = { profiles: result.profiles, sources: result.sources, variants: result.variants, efforts: result.efforts, credits: result.credits, entries: result.entries, fetchedAt: Date.now() }
          return { ok: true, count: result.profiles.length, fetchedAt: catalogState.fetchedAt }
        } catch (err) {
          return { ok: false, error: err?.message ?? String(err), kept: catalogState != null }
        }
      })()
      syncInFlight = run
      try {
        return await run
      } finally {
        if (syncInFlight === run) syncInFlight = null
      }
    },

    catalogView() {
      return catalogState
        ? {
            at: catalogState.fetchedAt,
            count: catalogState.profiles.length,
            profiles: catalogState.profiles,
            variants: catalogState.variants,
            efforts: catalogState.efforts,
            credits: catalogState.credits ?? {},
            // 展示用勋章位（与 CodeBuddy 模型行同构）：**只下发布尔**，
            // 不把原始目录条目整个塞给浏览器（含 max_input_tokens/is_sensitive 等无关字段）。
            // 语义映射见 badges 构造处注释。
            badges: qoderBadges(catalogState.entries),
          }
        : null
    },

    /** 凭据视图（设置卡）。 */
    credentialView() {
      return oauth.oauthStatus()
    },

    /** 账户配额只读快照（60s memoize，永不 throw）。 */
    quota: createQoderQuota({ settings: deps.settings, oauth }),
  }

  const gateway = createQoderGateway({
    settings: deps.settings,
    resolveCredential: (s) => oauth.resolveQoderCredential(s),
    cosy,
    meter: deps.meter,
    runtime: deps.runtime,
    forensics: deps.forensics,
    getCatalogProfiles: () => catalogState?.profiles ?? null,
    getCatalogEntry: (id) => catalogState?.entries?.[id] ?? null,
    getModelSource: (id) => catalogState?.sources?.[id] ?? 'system',
    getModelPrefs: deps.getModelPrefs ?? (() => ({})),
  })
  provider.gateway = gateway

  return provider
}
