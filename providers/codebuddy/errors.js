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
  /** 入口通道校验层拒绝（"Illegal API invocation from an unapproved channel"）。
   *  同码 11128 有**两个拒绝面**，触发源与形态不同（docs/rules/content-moderation.md）：
   *  - 旧面（2026-08-19 起）：字面量 `role:"developer"` 单列拒绝，HTTP 500，
   *    JSON 信封无 displayMsg/displayTips。桥以 developer→system 出站重写规避。
   *  - 新面（2026-10-21 起）：system 消息**内容指纹**校验，命中 DSH 内核固定
   *    身份声明首句完整短语 `You are an AI agent powered by DeepSeek Harness.`
   *    即拒，HTTP 400，响应体多出 displayMsg/displayTips/actions 字段，
   *    displayTips 文案"可能不是官方客户端发出的"是误导（x-user-id 正常回显，
   *    凭据有效）。桥以 agent→assistant 等价中和规避（语义不变，社区实测
   *    400→200）。触发词是完整短语，单词 DeepSeek/Harness 单独不触发。 */
  11128: 'unapproved channel',
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
  /** 工具史配对失败：assistant.tool_calls 与 tool 结果对不上——孤儿 tool（无前置
   *  tool_calls）或声明了 tool_call 却没结果。**2026-10-18 本仓库实测复现**：
   *  坏体直连 /v2/chat/completions 在 deepseek-v4-pro 上 HTTP 400 + 本码，msg
   *  逐字为 'tool calls and tool results do not match, please start a new
   *  conversation and retry'；同一坏体经 providers/tool-pairing.js 修复后 200
   *  （对照臂绿）。**glm-5.3-flash 对同一坏体静默 200**——拒绝面按模型家族分裂
   *  （同 #41 教训 d："在容错家族上验证等于没验证"）。码名最初来自外部生态自述
   *  （workbuddy2api-hub README"修 code 11148 坏历史"，
   *  docs/research-eco-comparison.md §4 P0-1），现由本仓库证据落地（踩坑 #22：
   *  外部自述不采信，以实测为准）。证据 docs/probes/codebuddy-pairing-2026-10-18.json，
   *  可复跑 scripts/probe-codebuddy-pairing.mjs。 */
  11148: 'tool calls and tool results do not match',
}

/**
 * 凭据不可用错误（组合根在候选为空时抛出；各出站路径凭 message 识别并
 * 原样透传，不包装成网络错误）。文案保持与 0.7.4 一致——调用方与设置卡
 * 均按此串匹配。
 */
export const CREDENTIAL_UNAVAILABLE_MESSAGE = 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）'
