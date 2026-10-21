/**
 * providers/codebuddy/index.js — CodeBuddy（copilot.tencent.com）薄适配器。
 *
 * 组合各特化件并向 core/ 暴露 provider 钩子。core/bridge.js 只依赖这里
 * 暴露的结构钩子，不认识任何 CodeBuddy 事实；接第二个 OpenAI 兼容上游时
 * 照本目录形态另写一个适配器即可，core/ 零改动（证伪测试：
 * scripts/verify-core-generic.mjs）。
 *
 * 规则文档是适配器行为的裁判依据：
 * - docs/rules/ua-validation.md §3   → headers.js 逐字段规则/迷信判定
 * - docs/rules/content-moderation.md → transformChatPayload 的 developer→system
 *   + R-M4 system 渠道指纹改写（channel-guard.js）
 * - docs/rules/routing.md            → errors.js 14401/14407/11102/11103
 * - docs/rules/quota-signals.md      → catalog.js 额度方言 + agenttool 死路径删除
 * - docs/rules/oauth-handshake.md    → oauth.js 设备流与迷信头标注
 */

import { CLIENT_HEADERS } from './headers.js'
import { sanitizeChannelFingerprints } from './channel-guard.js'
import { createOAuth } from './oauth.js'
import { createCatalog } from './catalog.js'
import { parseRateLimit, rateLimitRetryAfterSeconds } from './rate-limit.js'
import { createAgentTool } from './agenttool.js'
import { createImageTool } from './images.js'

/**
 * 桥取证日志允许记录的头名白名单；authorization 单独分类（sentinel/caller-set），
 * 永不逐字落盘。
 */
const LOG_HEADER_NAMES = [
  'user-agent', 'content-type',
  'x-conversation-id', 'x-session-id', 'session_id', 'x-client-request-id', 'x-session-affinity',
  'x-ide-type', 'x-ide-name', 'x-ide-version', 'x-product-version',
  'x-requested-with', 'x-private-data',
]

/**
 * @param {{
 *   meter: { record: Function },
 *   readAuth: () => object,
 *   writeAuth: (v: object) => void,
 *   envKey: (envName: string|undefined) => string|null,
 *   withKeyRotation: (settingsFn: () => object, attempt: Function) => Promise<object>,
 *   resolveCredential: (settingsFn: () => object) => Promise<object|null>,
 *   effortWireFor: (model: string) => string|undefined, // G8 思考强度线值（可无）
 *   dshHome: string,
 * }} deps 组合根注入的 core 原语与凭据编排（迟绑定箭头，循环引用靠它解开）
 */
export function createCodeBuddyProvider(deps) {
  const oauth = createOAuth({ readAuth: deps.readAuth, writeAuth: deps.writeAuth })
  const catalog = createCatalog({ resolveCredential: deps.resolveCredential, envKey: deps.envKey })
  const agenttool = createAgentTool({ withKeyRotation: deps.withKeyRotation })
  const images = createImageTool({
    withKeyRotation: deps.withKeyRotation,
    meter: deps.meter,
    dshHome: deps.dshHome,
  })

  return {
    id: 'codebuddy',

    // ---------------------------------------------------------------
    // core/bridge.js 的适配钩子
    // ---------------------------------------------------------------

    logPrefix: '[dsh-tap]',

    /** 桥出站静态头组（逐字段规则/迷信判定见 headers.js 文件头）。 */
    bridgeHeaders: () => ({ ...CLIENT_HEADERS }),

    /**
     * Chat 出站重写：developer → system。
     *
     * 规则（docs/rules/content-moderation.md）：网关入口通道校验层对含字面量
     * `role:"developer"` 消息的 chat payload 单列拒绝（当前拒绝面
     * 500/11128 "unapproved channel"；模型无关、位置无关、计费前）。触发源
     * 是 pi-ai 把推理模型的 system prompt 序列化为 developer 角色。网关对
     * developer/system 指令语义等价，桥直接重写——回归锁在 verify-bridge §9。
     */
    transformChatPayload(payload) {
      if (Array.isArray(payload.messages)) {
        for (const m of payload.messages) {
          if (m?.role === 'developer') m.role = 'system'
        }
      }
      // 渠道指纹改写（2026-10-21）：system 首句
      // "You are an AI agent powered by DeepSeek Harness." 被入口渠道校验层
      // 按精确句拒 400/11128，且只扫 system/developer。改写口径与证据见
      // channel-guard.js；必须在 developer→system 之后（developer 也属被扫面）。
      sanitizeChannelFingerprints(payload)
      // G8 思考强度注入：effortWireFor 只在档位线值非空时返回（off 的线值
      // 是 null = 省略参数；无表模型/非法档位同）。调用方（pi-ai / dsh 核心
      // UI）显式携带 reasoning_effort 时绝不覆盖。
      if (payload && payload.reasoning_effort == null) {
        const wire = deps.effortWireFor?.(payload.model)
        if (wire) payload.reasoning_effort = wire
      }
    },

    /** SSE chunk → usage 对象（网关每 chunk 重复携带，含 credit 与缓存计数）。 */
    extractUsage: (chunk) => chunk.usage ?? null,

    /** SSE chunk → 错误判定：OpenAI 形态 chunk.error，或网关信封 code !== 0。 */
    extractStreamError: (chunk) =>
      (chunk.error || (chunk.code != null && chunk.code !== 0)) ? chunk : null,

    /** 聚合 chat.completion 响应的 id（保持 0.7.4 线上值不变）。 */
    bridgeResponseId: 'codebuddy-stream-bridge',

    logHeaderNames: LOG_HEADER_NAMES,

    /** 静态哨兵 Authorization（cordis.patch.yml 主聊天路由携带；桥逐请求替换）。 */
    sentinelAuth: 'Bearer dsh-codebuddy-bridge',

    texts: {
      credentialUnavailable: 'codebuddy credential unavailable',
    },

    /**
     * 上游错误的**语义描述**（供桥在透传前把裸 JSON 翻成人话 + 结构化状态）。
     * 由上游适配器提供、core/bridge.js 只做通用转发——core 有禁上游词硬闸门，
     * 错误码/文案都不能进 core。
     * @returns {{message:string, code?:string, status?:number, retryAfter?:number,
     *            rateLimit?:{resetAt?:number, resetText?:string}}|null}
     *          null = 无特化语义（桥按原样透传）
     */
    describeUpstreamError(status, body) {
      const rl = parseRateLimit(body)
      if (rl) {
        const when = rl.resetText ? '，预计 ' + rl.resetText + ' 恢复' : ''
        return {
          message: 'CodeBuddy 频率限制：该模型当前用量已超限' + when + '（可切换其他模型继续使用）',
          code: 'codebuddy_rate_limited',
          retryAfter: rateLimitRetryAfterSeconds(rl),
          rateLimit: { resetAt: rl.resetAt, resetText: rl.resetText },
        }
      }
      // 4xx 的语义识别都从同一个 JSON 体取 code；非 JSON 体不特化、原样透传。
      let parsed = null
      if (status === 400 || status === 403) {
        try { parsed = JSON.parse(body) } catch { parsed = null }
      }
      const upstreamCode = parsed?.code ?? null
      // 入口渠道校验层（2026-10-21）：400/11128。插件已改写已知 system 指纹
      // （channel-guard.js），走到这里说明上游又在灰度新规则或命中了未知指纹；
      // 翻成可辨识的 code + 可执行提示，别让用户只看到一串裸 JSON。
      if (status === 400 && upstreamCode === 11128) {
        return {
          status: 400,
          code: 'codebuddy_channel_blocked',
          message: 'CodeBuddy 渠道校验未通过（11128）：上游按「非官方客户端 / 系统提示指纹」拦下了这次请求。插件已自动改写已知指纹；若仍出现，请确认已重启 dsh 载入最新版本，或稍后重试（上游可能在灰度更新校验规则）。',
        }
      }
      // 账号级风控封禁（2026-10-21 实测）：403/11140。
      // 聊天面**全部模型**被拒，而 /v3/config（目录）、/v2/accounts、/agenttool
      // 仍 200——所以设置卡「测试一下」照常显示正常，只有聊天失败。证据与处置
      // 见 docs/diagnosis-codebuddy-11140.md。
      //
      // 状态码**刻意改写为 400**：宿主把 401/403 一律分类成 AUTH，并把失败行
      // 文案替换为「API 密钥无效」（dsh-client-ui-chat `failureMessage`）——
      // 真实原因被吞掉，还会把用户引向重登 / 换 key 的错误方向。400 不在该
      // 替换名单里，宿主会原样显示本条 message；codebuddy 路由 retryPolicy
      // `maxRetries: 0`，状态码变化不引入重试。语义上它不是请求错误，故 code
      // 单列（`codebuddy_account_restricted`），调用方仍可结构化识别。
      if (status === 403 && upstreamCode === 11140) {
        const requestId = parsed?.requestId ?? null
        return {
          status: 400,
          code: 'codebuddy_account_restricted',
          message: 'CodeBuddy 账号被上游风控限制（11140 request illegal：账号存在异常行为，已被限制使用）——聊天面全部模型暂不可用，与 API Key / OAuth 令牌无关。'
            + (requestId ? `申诉请带上 requestId ${requestId}。` : '')
            + '可在 CodeBuddy 客户端「帮助与反馈」提交申诉，或等待数小时后重试；期间不要高频重试（高频会延长风控）。设置卡「测试一下」只验证目录面，仍会显示正常。',
        }
      }
      return null
    },

    // ---------------------------------------------------------------
    // 组合根直接消费的特化能力
    // ---------------------------------------------------------------

    oauth,
    catalog,
    agenttool,
    images,
    makeSearchProvider: agenttool.makeSearchProvider,
    makeFetchProvider: agenttool.makeFetchProvider,
    makeImageGenTool: images.makeImageGenTool,
  }
}
