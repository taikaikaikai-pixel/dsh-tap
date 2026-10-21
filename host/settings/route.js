/**
 * host/settings/route.js — `/dsh-tap/settings` 的**外壳**（0.25.0 从 index.js 拆出）。
 *
 * 只做四件事：本地门 → GET 视图/探针 → POST 包体（readBody，1MiB 上限）→
 * 分发到 actions 表或 patch 分支。28 个动作在 actions.js、patch 语义在 patch.js、
 * 视图在 view.js——本文件保持 ≤120 行，加东西前先想清楚该落在哪个文件。
 *
 * 安全与形态约束（都有闸门）：
 *  - Host/Origin 门在入口一处（core/net-guard，踩坑 #80）；Origin 判定不再重复；
 *  - 信封走设置面契约 `{ok:false,error:"中文"}`（踩坑 #79），出口只有 `reply`；
 *  - 包体先排空再应答 413（踩坑 #81），否则客户端收到 RST 而不是状态码；
 *  - 已应答后的异常只记日志，绝不二次写响应（踩坑 #76）。
 */

import { localGuardFailure } from '../../core/net-guard.js'
import { readBody, sendJSON } from '../../core/http-surface.js'
import { describeError } from '../../core/errors.js'
import { hostConfig } from '../config.js'
import { bridgeRuntime, qoderRuntime } from '../runtime.js'
import { createActions } from './actions.js'
import { createPatchHandler } from './patch.js'
import { hostReconcileView, settingsView } from './view.js'

/** 设置面请求体上限：最大合法请求是 apiKeysAdd / provider-add 的几 KB。 */
const MAX_SETTINGS_BODY_BYTES = 1024 * 1024

/**
 * 403 文案：**判定**在 core/net-guard.js（六份实现收成一份，踩坑 #80），
 * **措辞**留在本面——网关面回英文 OpenAI 信封，这里回设置卡能直接显示的中文。
 *
 * @param {{ code: 'host'|'origin', host: string|null, origin?: string }} refusal
 */
function guardRefusalMessage(refusal) {
  if (refusal.code === 'host') {
    return `本接口仅限本机访问：Host 必须是回环地址（127.0.0.1/localhost/::1），收到 ${refusal.host ?? '(缺失)'}`
  }
  return `Origin 与 Host 不一致（疑似跨站请求）：${refusal.origin}`
}

/** @param {{ resolveNow: () => object, applyLive: () => void, retryGateway: (ch: string) => boolean }} deps */
export function registerSettingsRoute(ctx, deps) {
  const { resolveNow } = deps
  const ACTIONS = createActions(deps)
  const applyPatch = createPatchHandler(deps)

  ctx.inject(['webServer'], (wsctx) => {
    wsctx.webServer.register({
      kind: 'exact',
      path: '/dsh-tap/settings',
      handler: (request, response) => {
        const reply = (status, payload, extraHeaders = null) => sendJSON(response, status, payload, extraHeaders)
        // 本地特权面：GET 与 POST 同一道门（Host 回环 + Origin 一致；
        // localAllowedOrigins 是壳内自定义 scheme 的例外登记，精确匹配）。
        const refusal = localGuardFailure(request, { allowedOrigins: resolveNow().localAllowedOrigins ?? [] })
        if (refusal) {
          reply(403, { ok: false, error: guardRefusalMessage(refusal) })
          return
        }
        if (request.method === 'GET') {
          const probe = new URL(request.url, 'http://127.0.0.1').searchParams.get('probe')
          if (probe === 'host-config') {
            reply(200, { ok: true, probe: hostConfig.probe() })
            return
          }
          if (probe === 'runtime') {
            reply(200, { ok: true, rateLimit: bridgeRuntime.rateLimit ?? null, queue: qoderRuntime.queue ?? null })
            return
          }
          // host = 宿主实况对账（只读）。只挂主 GET——POST 不带它，免得每次保存多跑一遍 describe。
          reply(200, { ...settingsView(resolveNow), host: hostReconcileView(() => ctx.web) })
          return
        }
        if (request.method !== 'POST') {
          reply(405, { ok: false })
          return
        }
        // Buffer 收集 + 一次解码（踩坑 #28）与 aborted/error 收口都在 readBody；
        // 超限先排空这一轮上传再回 413（踩坑 #81）。
        void readBody(request, response, {
          maxBytes: MAX_SETTINGS_BODY_BYTES,
          onOversize: (res, limit) => {
            sendJSON(res, 413, { ok: false, error: `请求体过大（上限 ${limit} 字节）` }, { Connection: 'close' })
          },
        }).then(async (rawText) => {
          if (rawText === null) return // 已应答（413）或客户端已中止
          try {
            const body = JSON.parse(rawText)
            if (body?.action !== undefined) {
              const fn = ACTIONS[body.action]
              if (typeof fn === 'function') {
                await fn(body, reply)
                return
              }
            }
            await applyPatch(body ?? {}, reply)
          } catch (err) {
            const d = describeError(err, { fallback: '设置未能保存' })
            if (!reply(400, { ok: false, error: d.message })) {
              process.stderr.write(`[dsh-tap] settings handler error after response: ${d.message}\n`)
            }
          }
        })
      },
    })
  })
}
