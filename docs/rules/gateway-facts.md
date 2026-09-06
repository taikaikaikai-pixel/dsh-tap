# 已验证的网关事实（2026-08 实测，勿凭记忆改）

> 本文是网关事实摘要总表（2026-08-29 自 AGENTS.md 同名章节逐字迁入）。逐字段裁判细节见同目录专题文件：routing.md / ua-validation.md / quota-signals.md / prompt-cache.md / content-moderation.md / dev-role-boundary.md / trae-surface.md / oauth-handshake.md / extra-providers.md；Trae 协议校准结论内联在 providers/trae/ 各模块文件头。新实测事实追加在本文，并在 AGENTS.md「关键网关事实速查」加一行。

- `/v2/chat/completions`：**仅流式**（非流式报 `code 11101`）；`reasoning_effort` 接受 low/medium/high/max，各模型思考量自适应非严格单调

- `/agenttool/v1/search`、`/agenttool/v1/webfetch`：专用搜索/抓取端点，`ck_` Key 直调可用；**UA 必须是 CLI 形态**（如 `CLI/unknown CodeBuddy/2.136.0`，`CodeBuddyCode/1.0` 被拒 12403）

- `/v3/config`：网关自有模型目录（官方 CLI 用），`x-api-key` 头认证（OAuth 用 Authorization），同 UA 要求；响应 `{code, data:{models, agents}}`

- `/v2/images/generations`：OpenAI 形态生图端点，`hunyuan-image-v3.0-art` 实测出图（\~22s/张，plain UA 即可，无需 CLI UA）；`/v2/videos/generations`、`/v2/3d/generations` 路由存在但当前账号一律 14407 `route config not found`（无可用模型，官方 CLI 包内也无对应客户端调用）→ 视频/3D 不接入（2026-08-17 探测定论）

- OAuth 设备流：`POST /v2/plugin/auth/state?platform=CLI`（三个 `X-No-*` 头）→ 浏览器打开 authUrl → 轮询 `GET /v2/plugin/auth/token?state=`（`11217`=未完成）→ `GET /v2/plugin/login/account`；刷新 `POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token`）

- **额度信号盘点**（2026-08-18 探测）：`GET /v2/accounts`（ck\_ Key 直调可用）返回账户元数据（type/enterprise/lastLogin，当前账户=lastLogin:true 条目）；`POST /v2/billing/meter/get-dosage-notify`（官方 CLI BillingService 的低额告警源，ck\_ 可用）健康时返回空文案；chat 响应头无 quota 字段，计费只有每请求 `usage.credit` 自报。**数字剩余额度 API 已找到**（2026-08-19 G2，quota-signals.md R-Q7）：控制台计费路径族 `/billing/meter/get-user-resource` 等接受 **OAuth Bearer**（两域名同构；`ck_` key 401 不进）——`POST {}` 返回资源包列表（`CapacityRemainPrecise`/`CycleCapacity*`/`TotalDosage`，数值剩余额度主源）；`get-enterprise-user-usage`（`X-Enterprise-Id` 头）返回套餐 `credit/limitNum`；daily/request 用量明细需 `X-Enterprise-Id` 作用域（个人=`"personal"` 字面量）。详见 docs/rules/quota-signals.md §R-Q7

- **WorkBuddy 与 CodeBuddy 同账户体系**：`www.workbuddy.cn/v2/plugin/auth/state` 实测返回同形态 `{state, authUrl}`（同一设备流）；官方 CLI product.json 的 `internalDomain` 互含 workbuddy.cn，认证 id 同为 `Tencent-Cloud.coding-copilot` → 额度账户级共享，无需单独通道

- 会话头体系（CLI 使用，v0.5.5 目标）：`X-Conversation-ID / X-Session-ID / X-Conversation-Request-ID / X-Conversation-Message-ID / X-Agent-Type / X-Agent-Intent`

- dsh 内置"获取可用模型"对本网关**永远失效**（无 OpenAI `GET /models`，404）

- **提示缓存按内容寻址、自动生效，与头无关**（2026-08-17 对照实测）：usage 每 chunk 带 `prompt_cache_hit_tokens/prompt_cache_miss_tokens/credit`；会话亲和三头与 `prompt_cache_key` 对命中**零影响**（2.6k/15.8k 两档 anon==session）；命中粒度 128 token。**按模型分策略**：deepseek-v4-pro 缓存工作（阈值 ≤2684 tok），deepseek-v3 在 ≤16.3k tok 全部 0 命中——v3 无缓存折扣。credit 实测单价：v4-pro miss ≈0.26/1k tok、hit ≈1/24；v3 ≈0.03/1k。~~命中可用性在 15.8k 规模有网关内部波动~~（**2026-09-03 重判**：该"波动"来自经桥流量的逐分片解码损坏，非网关内部行为——docs/diagnosis-cache-decline.md §2.4）。详见 docs/diagnosis-cache-quota.md

- **缓存按模型分策略实测表**（2026-08-18 探测）：v4-pro / v4-flash / kimi-k2.7 / hy3 有稳定跨请求前缀缓存（同 prompt 连发命中 95–100%，kimi 全量命中含尾部）；**glm-5.1/5.2 缓存条目秒-分钟级失效**，连发同 prompt 出现 0→83%→83%→0 非单调（4 次综合命中率 ≈41%——"命中率只有 40 多"类现象多源于此，与链路无关）；deepseek-v3 恒 0。**v4-flash 网关缓存本身稳定**：直连同 prompt 连发 24 发全 99.3%（ck_/OAuth 交错）、16k/32k 条目无刷新存活 600s、增长前缀+60s 空闲全命中（2026-09-03 受控探测）；存量"40k+ 真实内容保留不稳/命中波动"**已重判为桥逐分片解码损坏出站前缀**（core/bridge.js `rawBody += c`，跨 TCP 分片的中文字符→3×U+FFFD 且位置逐请求随机——完整证据链与历史重释见 docs/diagnosis-cache-decline.md）。**桥对缓存的"透明"结论有边界**：2.6k 单分片体逐字节透明（存量），大体量中文体在分片切断多字节字符时**不透明**（该缺陷待修复，踩坑 #28）。dsh 每步注入的秒级时间戳只动尾部 ~19 tok（17.5k prompt 跨会话重发命中 99.9%，2026-08-18 实测）

- **内容审核 developer 角色事件**（2026-08-18 16:24 UTC 起，0.7.4 已解）：网关内容审核开始对**含** **`role:"developer"`** **消息**的 chat payload 一律 `finish_reason: content_filter`，仅改回 `system` 即放行。触发源在 pi-ai：openai-completions 序列化器对推理模型把 system prompt 写成 developer 角色（`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`，桥 URL 不在非标准名单 → true）——所以 dsh 会话全挂而官方 CLI/手写回放（手写一直是 `system`）全过，deepseek-v3 不受影响（非推理模型不发 developer）。**修复在桥**：chat 出站前把 `developer` 重写为 `system`（verify-bridge 第 9 节锁回归）。0.7.3 猜的"x-stainless 头组/序列化顺序"已被 OpenAI SDK 6.26.0 全保真回放证伪；教训：等价对比必须用 dump/抓包的真实字节，手写重建会抹掉差异字段。

### TraeWork CN 通道事实（2026-08-23 实测校准）

- 聊天网关在 `trae-api-cn.mchost.guru`：`POST /api/agent/v3/llm_utils_chat`（工具型一次性聊天，dsh provider 的目标）与 `create_agent_task`（官方 agent 环）；未认证一律 401 `{code:1001}`。api.trae.cn / api.trae.com.cn 上**没有** /api/agent/v3（404）

- OAuth 在 `api.trae.cn`：`POST /trae/api/v3/oauth/ExchangeToken`（AuthCode 模式换 token / RefreshToken 模式+DeviceProof 刷新，同一端点）；假 ClientID → 400 code 10101 "Invalid client."，真 ClientID+假 AuthCode → 10101 "无效参数"；错误信封火山系 ResponseMetadata.Error；旧路径 `/cloudide/api/v3/trae/oauth/ExchangeToken` 仍存活但请求体已演进

- 客户端 id：SOLO Lite 分支 `en1oxy7wnw8j9n`、TRAE 分支 `ono9krqynydwx5`；认证双头 `Authorization: Cloud-IDE-JWT <token>` + `x-cloudide-token`（+`X-User-Region: CN`）

- **llm\_utils\_chat 信封与 SSE 语法已带凭据联调打通**（2026-08-23/24 实测）：请求体 `{messages[content 为 {type,text} 块数组——字符串 400/4001], model, function:"inline_chat"（必填，缺则 2001）, request_id, session_id, stream:true}`；头需三头同 JWT（Authorization/X-Cloudide-Token/x-ide-token）+ `x-app-id`（固定 UUID `6eefa01c-…`，**≠OAuth client\_id**）+ 数字串 version-code（'0.1.52' 判 missing，用 20260401）；SSE=metadata/timing\_cost/output(response/reasoning\_content)/token\_usage(顶层计数)/done，解析器按累计快照前缀差分（createTraeStreamParser）。**tools 全链路已联调**（2026-08-24）：请求 `function.parameters` 必须字符串化（Go string 型），响应 `tool_calls[].function_call` 键 + arguments 增量片段按 index 拼接、done 恒 stop 需映射为 OpenAI `tool_calls` 终结。**model 字段不被 inline\_chat 路由**——服务端恒走账户默认模型（实测 provider\_model\_name=kimi-k2.6，与请求值无关）

- **模型改派与其余限制**（2026-08-24 终局探测矩阵定论）：raw 面模型被* ***function 位钉死**——inline\_chat 只服务账户默认模型（非默认 model 名→3003 "all models failed"，custom\_model 无效；早前曾静默改派 kimi-k2.6，服务端行为有时变）；chat\_v3/solo\_agent\_lite 恒 seed-code-lite、solo\_work\_lite 恒 glm-5.2（任意 model 名都 200 但改派）。改派真值源=timing\_cost.provider\_model\_name，网关以 SSE 注释行披露且计量记真实模型。**唯一真实的模型选择 = remote 会话协议**（已落地：providers/trae/remote.js + 网关* *`traeChatTransport`* *设置——chat\_sessions + model\_name/manual 策略，model\_config 事件证实 glm-5.3/kimi-k2.6 真实路由；事件=plan\_item thought/reasoning 累计快照 + finish summary 兜底 + token\_usage + done；耗* ***work 额度池**；不支持 OpenAI tools——带 tools 请求 400 remote-no-tools；Free 账号 kimi-k3 触发 error 1005 套餐门）。**额度双池**：raw 耗 IDE 池（available\_endpoint=0）、remote 耗 work 池（=1）——`POST api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`（req\_source 0/1/2，Cloud-IDE-JWT + x-device-* 头组）按 `entitlement_base_info.available_endpoint` 分池读数（实测 3 次 remote 会话 work 池 +9.4 credits）。限流 4011 紧（raw 面联调间隔 ≥20s；remote 面无 4011 但有排队）；/api/ide/v1/chat 老端点 4023 拒现代模型名；get\_model\_list 两域名 404；GetUserInfo 昵称字段=ScreenName

- 官方本地 harness（:40005 axum，chat/start\_chat/subscribe\_events）**懒启动**且启动参数未知；其数据库加密；令牌不在 state.vscdb/凭据管理器任何可读位置——harness 驱动路线存档未采用

