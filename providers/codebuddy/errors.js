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
   *  两张脸——① 字面量 role:"developer" 单列拒绝（2026-08-18 由 200/content_filter
   *  变迁为 500/11128）；② system 消息精确句指纹（DSH 首句，2026-10-21 为
   *  400/11128，出站改写见 channel-guard.js）。docs/rules/content-moderation.md */
  11128: 'unapproved channel',
  /** 账号级风控封禁（HTTP 403，"request illegal"）：聊天面**全部模型**被拒，
   *  body 带 `displayMsg.zh`「账号存在异常行为，已被限制使用」与申诉提示。
   *  边界：/v3/config（目录）、/v2/accounts、/agenttool 仍 200——所以设置卡
   *  「测试一下」照常显示正常，只有聊天失败。刷新 access token / 重新登录
   *  **无效**（已实测新令牌同拒）；只能带 requestId 申诉或等风控自解。
   *  2026-10-21 实测。桥把它翻成 400 + `codebuddy_account_restricted`
   *  （宿主对 401/403 恒显示「API 密钥无效」，会掩盖真实原因）。
   *  证据与处置：docs/diagnosis-codebuddy-11140.md */
  11140: 'account restricted (risk control)',
  /** 缺少必填参数（OAuth state 创建省略 platform 时观测）。docs/rules/oauth-handshake.md */
  10001: 'missing required parameter',
  /** OAuth token 轮询未完成——pending/bogus/过期三态同码，不可区分。docs/rules/oauth-handshake.md */
  11217: 'oauth state not ready (indistinguishable)',
  /** refresh token 无效（HTTP 401 伴随）。docs/rules/oauth-handshake.md */
  12153: 'refresh token invalid',
  /** reasoning_effort 档位拼写不被该模型接受（extError.code =
   *  invalid_reasoning_effort）。2026-09-22 实测：deepseek-v4-pro 拒绝
   *  off/disabled/auto（11150），同一拼写在 glm-5.3-flash 上被静默接受——
   *  档位表只列实测/目录声明过的拼写。证据 docs/probes/codebuddy-efforts-*.json */
  11150: 'invalid_reasoning_effort',
}

/*
 * 未入表的同族码说明：官方 CLI（`@tencent-ai/codebuddy-code` 2.170.0）的
 * 静态分类表把 11140 / 11141 / 11142 与 17271–17276 一并归入 auth 族
 * （11140 / 11142 = auth_forbidden，11141 = model_behavior_error）。其中只有
 * 11140 在本仓线上实测过；其余号码未观测到真实响应，按本文件纪律
 * **不入表、不写语义**，等实测再补。
 */

/**
 * 凭据不可用错误（组合根在候选为空时抛出；各出站路径凭 message 识别并
 * 原样透传，不包装成网络错误）。文案保持与 0.7.4 一致——调用方与设置卡
 * 均按此串匹配。
 */
export const CREDENTIAL_UNAVAILABLE_MESSAGE = 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）'
