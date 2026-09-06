/**
 * providers/codebuddy/errors.js — CodeBuddy 网关错误码表。
 *
 * 每条含义均以探测证据为准（docs/rules/ 下对应规则文档，可复跑脚本在
 * scripts/）。这里是**语义参照表**，不是触发逻辑——代码路径按位置内联
 * 引用，禁止把表项当作"必须长这样"的咒语使用。
 */

export const ERROR_CODES = {
  /** /v2/chat/completions 仅流式：非流式请求报此码。证据：AGENTS.md 网关事实节。 */
  11101: 'chat requires stream:true',
  /** UA 门（"check ua"）：/v3/config 检查 UA 含 codebuddy/ + 含点版本段。docs/rules/ua-validation.md */
  12403: 'user-agent gate',
  /** 路由注册表层：image 家族模型未注册（消息逐字回显模型名）。docs/rules/routing.md */
  14401: 'image model not routed',
  /** 路由配置缺失：video/3d 家族注册表层 + video 后端派发层兜底。docs/rules/routing.md */
  14407: 'route config not found',
  /** 路由注册表层：chat 家族模型未注册（"service info not found"）。docs/rules/routing.md */
  11102: 'service info not found',
  /** chat 后端派发层兜底。docs/rules/routing.md */
  11103: 'backend dispatch failure',
  /** 入口通道校验层拒绝（"Illegal API invocation from an unapproved channel"）：
   *  字面量 role:"developer" 单列拒绝的当前拒绝面（2026-08-18 由 200/content_filter
   *  变迁为 500/11128）。docs/rules/content-moderation.md */
  11128: 'unapproved channel',
  /** 缺少必填参数（OAuth state 创建省略 platform 时观测）。docs/rules/oauth-handshake.md */
  10001: 'missing required parameter',
  /** OAuth token 轮询未完成——pending/bogus/过期三态同码，不可区分。docs/rules/oauth-handshake.md */
  11217: 'oauth state not ready (indistinguishable)',
  /** refresh token 无效（HTTP 401 伴随）。docs/rules/oauth-handshake.md */
  12153: 'refresh token invalid',
}

/**
 * 凭据不可用错误（组合根在候选为空时抛出；各出站路径凭 message 识别并
 * 原样透传，不包装成网络错误）。文案保持与 0.7.4 一致——调用方与设置卡
 * 均按此串匹配。
 */
export const CREDENTIAL_UNAVAILABLE_MESSAGE = 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）'
