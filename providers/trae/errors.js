/**
 * providers/trae/errors.js — Trae 云端错误码表。
 *
 * 语义参照表，不是触发逻辑。每条以探测证据为准（2026-08-23 无凭据实测 +
 * docs/rules/trae-surface.md §2.2）：
 *   - 聊天网关（trae-api-cn.mchost.guru/api/agent/v3/*）未认证 → 401 + {code:1001}
 *   - ExchangeToken（api.trae.cn，火山系 ResponseMetadata.Error 信封）：
 *     假 ClientID → 400 code 10101 "Invalid client."；
 *     真 ClientID + 假 AuthCode → 400 code 10101 "无效参数：{__Message.field}."
 *   - cloudide 面（api.trae.cn/cloudide/…）未登录 → 401 code 20310
 */

export const TRAE_ERROR_CODES = {
  /** 聊天网关统一未认证码（mchost /api/agent/v3/*）。 */
  1001: 'chat gateway authentication failed',
  /** remote 会话（/api/remote/v1/*）：套餐/权益不足——message 为空、data.plan 携带
   *  所需档位（2026-08-24 实测：Free 账号请求 kimi-k3 命中，glm-5.3 可正常服务）。 */
  1005: 'remote session entitlement/plan gate',
  /** raw 面（llm_utils_chat）：function 未注册/参数 proto 反序列化失败。
   *  2026-10-05 探针实测两形态：「no function config found for appId=…,
   *  function=<名>」（function 名未注册）与「LLMUtilsChat ChatStream failed: …
   *  read field 8 'Messages' error … required field Name is not set」（历史
   *  assistant.tool_calls 误用 OpenAI function 键，该面要求 function_call）。 */
  2001: 'function 未注册或请求体 proto 形态错误',
  /** raw 面（llm_utils_chat）模型解析失败：服务端把请求模型在注册表里全部试挂后
   *  放弃。2026-08-24 实测该码已从"仅非默认模型"扩大到"一切 model 名（含默认、
   *  含不带 model 字段）"——inline_chat 面服务端故障（docs/diagnosis-trae-3003.md）。 */
  3003: 'all models failed（服务端 inline_chat 面模型解析失败）',
  /** raw 面 4001：参数形态/绑定错误（app_id 缺失、parameters 未序列化等）。 */
  4001: 'raw 面参数绑定失败（expr_path/类型不匹配）',
  /** raw 面 4011：限流或「该 function 拒绝此模型」（message 恒谎称 rate limit——
   *  dsh-connect-trae 实测：solo_agent 函数调任何模型都回 4011）。 */
  4011: 'rate limit 或 function 不服务该模型（message 文案不可尽信）',
  /** raw 面（llm_utils_chat function=chat）：模型名未知（2026-10-05 fn 扫描实测；
   *  与 2001 的区别：chat 是已注册 function，进入模型路由层后才报模型未知）。 */
  4023: 'model unknown（chat function 已注册但模型名不被路由）',
  /** create_agent_task 面：config 注册表为空（2026-08-24 实测，docs/diagnosis-trae-3003.md §11）。 */
  9074: 'agent task config item is empty（solo_agent_lite 注册表为空）',
  /** remote 会话并发门：solo_agent_parallel_limit 用满（僵尸会话占位时也触发，
   *  2026-08-24 实测；会话随沙箱 TTL 自灭，或用 stop 端点善后）。 */
  991502: 'solo agent parallel limit reached',
  /** OAuth/ExchangeToken 面：client 或参数无效（ResponseMetadata 信封）。 */
  10101: 'oauth exchange invalid client/params',
  /** cloudide 面：未登录（GetUserInfo 等带 x-cloudide-token 的端点）。 */
  20310: 'cloudide not logged in',
}

/** 已知错误码的可操作处置提示（追加在透传消息之后，帮助用户自助而非只看裸码）。 */
const TRAE_ERROR_HINTS = {
  3003: '（Trae 服务端 inline 通道当前对该模型名返回此错——非凭据/配额问题；可在插件设置卡把「聊天传输」切为 remote（纯文本会话、真实模型路由、耗 work 额度池；注意 remote 不支持 dsh 工具环）或切为 agent（solo_work_lite，2026-10-05 探针证实支持工具环+并行调用，模型位钉死 glm-5.2）。详见 docs/diagnosis-trae-3003.md）',
  2001: '（function 未注册或请求体 proto 形态错误：若消息含 assistant.tool_calls，该面要求 function_call 键而非 OpenAI function 键）',
  4023: '（模型名不被该 function 路由——chat function 已注册但模型注册表无此项；可用模型名见设置卡「同步目录」）',
  991502: '（remote 并发额度被存活会话占满：等待沙箱 TTL 自灭或在 Trae 端停止会话后重试）',
}

/** 网关统一错误文案：`trae <code> <message>` + 已知码的处置提示。 */
export function formatTraeErrorMessage(code, message) {
  const base = `trae ${code ?? ''} ${message ?? ''}`.replace(/\s+/g, ' ').trim()
  return code != null && TRAE_ERROR_HINTS[code] ? `${base} ${TRAE_ERROR_HINTS[code]}` : base
}

/**
 * 把云端错误响应规范化为 { status, code, message }（信封两种：mchost 的
 * {code,message} 与火山系 ResponseMetadata.Error）。非 JSON/空体容忍为
 * "unknown"——网关层崩溃时出现过裸 500（codebuddy images 家族同款教训）。
 * message 为空时按码表回填语义（remote error 事件实测 message:"" + data.plan）。
 */
export function normalizeTraeError(status, body) {
  const withFallback = (code, message) => ({
    status,
    code: code ?? null,
    message: message || (code != null && TRAE_ERROR_CODES[code] ? TRAE_ERROR_CODES[code] : message ?? ''),
  })
  if (body && typeof body === 'object') {
    const volc = body.ResponseMetadata?.Error
    if (volc) return withFallback(volc.Code, volc.Message ?? '')
    if (body.code != null || body.message != null) {
      return withFallback(body.code ?? null, body.message ?? '')
    }
  }
  return { status, code: null, message: typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${status}` }
}

/** 凭据不可用（组合根候选为空时匹配的稳定文案）。 */
export const TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE = 'Trae 凭据不可用（先在插件配置卡的 TraeWork CN 分区登录）'
