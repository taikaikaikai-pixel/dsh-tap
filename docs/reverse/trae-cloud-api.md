# Trae 云端 API 实测档案（v0.8.x 接入依据）

> 日期：2026-08-23
> 方法：GitHub 社区逆向（linqiu919/trae2api，2025-06 停更）提供历史参照 → 本机
> 二进制 strings 提取当前协议面 → **无凭据在线探测**校准错误信封与端点存活。
> §1–§4 全程未使用任何真实凭据；带凭据联调由 `scripts/probe-trae-live.mjs` 承担
> ——**2026-08-23/24 已执行完毕**（§2 已校准段、§5 对照表；生产级交叉参照
> github.com/autumnsentiment/Trae2api-cn 的 raw client）。

## 0. 一句话结论

TraeWork CN 的聊天面是**任务制私有 RPC**（`/api/agent/v3/*`，SSE），网关在
`trae-api-cn.mchost.guru`；OAuth 换/刷令牌在 `api.trae.cn`
（`/trae/api/v3/oauth/ExchangeToken`，火山系 ResponseMetadata 信封）。
插件侧用**自持 ECDSA P-256 设备密钥**走完整设备流，refresh 的 DeviceProof
由自己签名——不依赖、不提取官方 IDE 的任何凭据。

## 1. 无凭据在线探测（2026-08-23，curl 直打）

| 端点 | 结果 | 结论 |
|---|---|---|
| `POST api.trae.cn/trae/api/v3/oauth/ExchangeToken`（假 ClientID） | 400 `ResponseMetadata.Error{Code:"10101", Message:"Invalid client.", StandardCode:"040004"}` | 端点存活；client 校验层 |
| 同上（真实 ClientID `en1oxy7wnw8j9n` + 假 AuthCode） | 400 `Code:"10101"`, `Message:"无效参数：{__Message.field}."` | client 过了校验层；线上模板变量未渲染（可当指纹） |
| `POST api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`（旧路径） | 400 同上 | **旧路径仍存活**（trae2api 时代的刷新路径没死，但当前客户端走新路径） |
| `POST api.trae.cn/cloudide/api/v3/trae/GetUserInfo`（无 token） | 401 `Code:"20310"`, `Message:"The user is not logged in,"` | cloudide 面信封确认 |
| `POST trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（无 token） | **401** `{"code":1001,"message":"We're sorry, but we are not able to authenticate you…"}` | **聊天网关在 mchost**；1001 = 统一未认证码 |
| `POST trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（无 token） | 401 同上 | 工具型一次性聊天端点存活 |
| `POST api.trae.cn/api/agent/v3/*`、`api.trae.com.cn/api/agent/v3/*` | 404（TLB nginx） | agent 面不在 api.trae.cn |

两种错误信封并存：mchost 面 `{code, message}`；api.trae.cn 面火山系
`ResponseMetadata.Error`。`providers/trae/errors.js` 的 normalizeTraeError
两者都吃 + 裸非 JSON 容忍。

## 2. 二进制协议面提取（harness.dll / ai_agent.dll strings）

- 云端路由族（harness.dll，`TTNetConfig` 邻域）：
  `/api/agent/v3/`：`create_agent_task`、`commit_toolcall_result`、`interrupt`、
  `resume_agent_task`、`get_resume_agent_task_status`、`query_history_state`、
  `sync_history_state`、`compact`、`llm_utils_chat`、`workflow/start`、
  `workflow/commit_toolcall`、`use_fast_request`、`generate_summary`、
  `dsl/logs/subscribe`、`dsl/templates`、`dsl/render/resources`。
  → 官方 SOLO 的 agent 环 = create_task → SSE 事件 → commit_toolcall 循环；
  **`llm_utils_chat` 是工具型一次性聊天**（title.rs / video.rs / telemetry 用它），
  是 dsh provider 场景（纯 LLM 调用）的正确目标。
- llm_utils_chat 请求信封（**2026-08-23/24 带凭据联调已校准**，证据
  docs/probes/trae-chat-live-*.json）：
  - 体：`{messages, model, function, request_id, session_id, stream:true}`；
    `messages[].content` 必须是 `{type:"text",text}` 块数组（字符串 → 400/4001
    "cannot unmarshal string …LLMRawMessageContent"）；`function` 必填——缺则
    SSE error 2001 "function is empty, cannot resolve model by usage="，
    实用值 `inline_chat`；`scene_params` 若带必须是 string（内嵌 JSON）。
  - 头（绑定层逐项实测收敛）：`x-app-id` = product.json 固定 appId
    `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`（**≠ OAuth client_id**；缺省 4001
    "expr_path=app_id"）；version-code 类头必须是**数字串**（'0.1.52' 判 missing，
    实测 `20260401` 过）；三头同 JWT（`Authorization: Cloud-IDE-JWT` +
    `X-Cloudide-Token` + `x-ide-token`）+ 设备指纹头组 + `x-request-id`。
  - **`model` 字段不被路由**：inline_chat 函数位由服务端解析到账户当前默认
    模型（两次实测 `provider_model_name` 均为 `kimi-k2.6`，与请求的
    glm-5.3 / DeepSeek-V4-Pro 无关）——dsh 侧多模型清单实为同一出口。
  - SSE 事件语法（实测）：`metadata` / `timing_cost`（含 provider_model_name）
    / `output`（data.response、data.reasoning_content）/ `token_usage`
    （计数在 data 顶层：prompt/completion/total + cache_read_input_tokens）
    / `done`（finish_reason）；错误走 `event:error` data{code,message}。
    2026-08-23 实测 response 为逐段增量；解析器按 Trae2api-cn 生产参照做
    累计快照前缀差分（两形态兼容），单点 createTraeStreamParser。
  - 工具调用（2026-08-24 实测，trae-chat-live-tools-*.json）：请求侧
    `tools[].function.parameters` 必须**序列化为字符串**（Go string 型，
    对象直发 4001 "cannot unmarshal object …parameters of type string"）；
    响应侧 `output.tool_calls[i]` 的键是 **`function_call`**（非 function），
    `arguments` 为**增量片段**、续片 id/name 为空按 `index` 归属拼接；
    带工具调用时 `done` 仍发 `finish_reason:"stop"`——网关映射为 OpenAI
    语义的 `tool_calls`，否则客户端不触发工具循环。
- 认证头两套并存（harness.dll）：`authorization` + `x-ide-token`（ide_token 语义）
  与 `x-cloudide-token`；设备头组：`x-app-id`、`x-ide-version-code`、
  `x-app-version-code`、`x-user-region`、`x-tt-env`、`x-use-ppe`、`x-env-lane`、
  `request-traffic-type`、`x-device-id`、`x-machine-id`、`x-os-version`、
  `x-device-cpu`、`x-device-brand`、`x-web-id`。插件侧先发双头 + 已知设备头，
  联调后按 401 形态收敛。
- 自定义 provider 直连：二进制里有 `deepseek/anthropic/openrouter/gemini/aws/xai`
  前缀 + `/v1/chat/completions` 组合 + `ak/sk` 字段——BYOK 条目由 harness 直连
  第三方（与 state.vscdb 目录里 `deepseek//…` 条目带 ak/sk 互证），
  这就是目录映射时排除 BYOK 条目的原因。
- **2026-10-11 函数级复核**（Ghidra 12.1.4 静态分析当前安装版 2026-09-20，
  harness.dll sha256 `cbb5887e…7bddaf`；证据 docs/probes/
  trae-harness-apiv3-xref-2026-10-11.txt + trae-harness-route-ctors-decompile-2026-10-11.txt）：
  二进制里存的是**无前导斜杠**的 `api/agent/v3/…` 连续字符串池（前导斜杠运行时
  拼接，拿 `/api/agent` 当 needle 会 0 命中）；主路由族 16 条由 `FUN_18625cc60`
  统一构造（alloc+字节拷贝，Rust 物，`harness\cloud-api\src\` 源路径残留），
  调用方 `FUN_18625d8f0` 即 TTNetConfig 构建器，内嵌 appId `6eefa01c-…` 获二进制
  实证。**协议面主体未漂移**，且多出本节原清单没有的端点：
  `generated_skill/{list,get,dismiss,restore}_pending` 族（`FUN_1861cc5c0`）、
  `custom_model_connectivity_check`、`api/ide/v1/{agents/runs,intent_detect,
  query_rewrite,fast_apply,model_list,…}` 族。同日在 ai_agent.dll（sha256
  `642c88a6…8ccf77`）复证：同一路由池，构造函数为 `FUN_186822b3e`（主族）/
  `FUN_1859234d4`（generated_skill 族，邻域含权限门禁串 `Agent access is not
  permitted`）/ `FUN_1868232e3`（connectivity_check+ide/v1），证据
  docs/probes/trae-ai-agent-apiv3-xref-2026-10-11.txt——两 DLL 同源 Rust crate
  双编译，协议面跨二进制一致。

## 3. 本地 harness（备选架构，存档未采用）

- 官方 Rust harness 是**本地服务器**：`resources/app/modules/ai-agent`，
  meta.json 固定 `socket.port: 40005`；axum 路由 `/api/v1/chat/{initialize,
  start_chat,subscribe_events,append_msg,…}`（harness\server\src\modules 证据），
  Electron 侧驱动。
- **懒启动**：IDE 常驻不等于 harness 常驻（2026-08-23 实测 IDE 13 进程、
  40005 无监听）；启动器是 `x64/run_helper.exe`（目录里没有 start.bat 引用的
  ai-agent.exe），裸拉无参即退——参数/握手未知。
- harness 数据库 `ModularData/ai-agent/database.db` **加密**（harness\storage-db
  \src\connection\encryption.rs，node:sqlite 报 "file is not a database"），
  令牌不落 state.vscdb（只有 `mcpOAuth` 一个无关键），Windows 凭据管理器无
  Trae 条目 → 令牌只在内存/加密存储。
- 结论：harness 驱动路线需要本地 RPC schema + 认证注入方式两个未知数，
  且无法自主触发懒启动；**直连云端路线（已采用）只需要一次用户登录**。

## 4. 历史参照（GitHub：linqiu919/trae2api，2025-06 停更）

- 旧协议：`POST {base}/api/ide/v1/chat` + TraeRequest 信封（user_input/
  intent_name="general_qa_intent"/variables/context_resolvers/chat_history/
  session_id/conversation_id/current_turn/valid_turns/multi_media/model_name/
  last_llm_response_info/is_preset/provider）+ `x-ide-token` 头。
- 旧刷新：`POST /cloudide/api/v3/trae/oauth/ExchangeToken`
  `{ClientID, RefreshToken, ClientSecret:"-", UserID}`（**无 DeviceProof**）。
  2026-08 客户端已演进为 DeviceProof 签名（traework-cn.md §6）；旧路径虽
  存活（§1），请求体已不满足当前客户端形态。
- 旧域名 `a0ai-api-sg.byteintlapi.com` 是国际版；CN 走 mchost/api.trae.cn。
- 旧 TraeRequest 信封字段与当前 llm_utils_chat 信封部分重合（messages/
  session_id/conversation_id/model_name），是 buildChatRequest 的交叉证据。

## 5. 插件实现 ↔ 证据对照

| 实现点 | 证据来源 | 置信度 |
|---|---|---|
| OAuth 设备流全流程 | traework-cn.md §3–§6（静态逆向原文） | 高 |
| PKCE/设备密钥自持 | 同上（"私钥为首次登录/设备注册时生成"→ 自注册同理） | 高 |
| ExchangeToken 端点/信封 | §1 无凭据实测（10101 两层） | 高 |
| 聊天网关域名+端点 | §1 401/1001 实测 + 二进制路由族 | 高 |
| llm_utils_chat 请求信封 | §2 带凭据联调（4001/2001 逐字段收敛）+ Trae2api-cn 生产参照 | **高（已联调）** |
| SSE 事件语法 | §2 实测事件流（metadata/timing_cost/output/token_usage/done） | **高（已联调）** |
| 双认证头形态 | traework-cn.md §7 + 二进制双头组 + §2 三头实测 | 高 |

联调状态：**2026-08-23/24 已完成**（`--chat` 真实对话成功，证据
docs/probes/trae-chat-live-*.json；verify-trae-provider 50 断言锁形态）。
再校准路径（上游改协议时重跑）：
```sh
node scripts/probe-trae-live.mjs --login      # 浏览器登录 + DeviceProof 刷新自证
node scripts/probe-trae-live.mjs --chat "你好" # 真实对话，原始证据落 docs/probes/
```
若 401：先试 `--sig raw`（DER→IEEE-P1363）；信封/事件语法改动单点在
providers/trae/gateway.js（buildChatRequest / createTraeStreamParser）。

### 5.1 模型路由与限制（2026-08-24 带凭据实测，重要）

- **raw 面（llm_utils_chat）的模型路由被 function 位钉死，model 字段不被路由**。
  2026-08-24 终局探测矩阵（证据 docs/probes/trae-model-routing[234]-*.json）：
  - `function=inline_chat`：只服务**账户默认模型**（本账号=kimi-k2.6）；任何
    其他 model 名（kimi-k3 / glm-5.3 / DeepSeek-V4-Flash-Official）一律 SSE
    error `3003 "all models failed"`；附加 custom_model 对象无效（同样 3003）。
    早间该面曾对非默认模型静默改派 kimi-k2.6（200 成功），当日下午起变为
    硬错误 3003——**服务端行为有时变性**，两态都要兼容。
    **08-24 当日再恶化（~09:39 UTC 起）**：3003 扩大到一切 model 名（含默认
    kimi-k2.6、含不带 model 字段），失败流无 timing_cost——服务端未走到选模
    成功一步；同信封同凭据 chat_v3 正常对话，额度池充足 → 判定 inline 面模型
    解析层服务端故障。完整证据链与对照实验见 **docs/diagnosis-trae-3003.md**
    （证据 docs/probes/trae-3003-diagnosis-*.json）。
  - `function=chat_v3` / `solo_agent_lite`：任意 model 名（包括
    `"not-a-model"`）都 200，但 timing_cost 证实恒为
    `seed-code-lite-dev-0602-v1-part1`；`solo_work_lite` 恒 `glm-5.2`。
  - 真值源 = timing_cost 事件的 `provider_model_name`。网关对策：解析
    timing_cost，改派时以 SSE 注释行 `: trae-reroute requested=… actual=…`
    告知（OpenAI 解析器忽略、不污染调用方会话历史），计量/日志记真实模型。
- **官方客户端同窗口的网络日志（round 9 取证，2026-08-24）**：
  官方 IDE 的 llm_utils_chat 请求**不直连 trae-api-cn 而是 307 内部重定向到
  `api5-normal.mchost.guru`**（当日全天 586 次 307 全部落到该域；TTNet 域名
  调度 x-net-sdk-domain-dispatch）。但实测两域名同信封同 3003 —— **域名非解药**。
  官方请求头组含插件未发的指纹头（version-code 用当日构建号 `20260811`、
  `x-app-version:"default"`、`x-bridge-transport:"aha"`、`x-request-pin`、
  `x-requested-at`、`request-traffic-type:"prod"`、`user-agent:"TraeClient/TTNet"`、
  `x-lgw-req-sdk-type:"3"`）；逐头二分加回均无行为差异 → 头组差异非 3003 根因。
  官方聊天主通道走 remote（当日 `chat_sessions` 提及 576 次 vs `llm_utils_chat`
  20 次），官方自己在事故期**也不依赖 inline 面** —— 与插件建议"切 remote"一致。
  ⚠️ 官方日志的 307 记录显示 `status:"SUCCESS"`/`code:200` 是**链路层成功**（响应体
  被 TTNet 吞掉、未落盘），不可作为"官方绕过 3003"的证明；客户端实际体验是否撞
  3003 无法从该日志判定（chat_sessions 才走官方主 UI）。
- **临时波动警示**：同信封同 token 同内容，chat_v3 曾短暂返回 1005 套餐门
  （`extra:{"plan":1}`，kimi/glm/DeepSeek 三模型全中），数分钟内自愈回 200 ——
  1005 不只出现在 remote 面 kimi-k3，raw 面也曾全模型闪过；**单次 1005 不能
  当作账号级套餐判定**，需重试/交叉验证（round 9 实测，见 diagnosis-trae-3003.md §10）。

- **唯一真实的模型选择机制 = remote 会话协议**（已落地为网关 remote 传输，
  providers/trae/remote.js）：`POST {base}/api/remote/v1/chat_sessions`
  （initial_message.`model_name` + `model_selection_strategy:"manual"` +
  `agent_type:"solo_agent_remote"`，content 空数组、历史扁平化进 query）
  → `GET /chat_sessions/{id}/events?reply_to_message_id=…` SSE → stop。
  `model_config` 事件与 done 的 `user_message_context.model_info.config_name`
  双重证实路由到请求模型（glm-5.3 / kimi-k2.6 实测），且模型自报一致。
  - 事件语法：plan_item（thought=可见文本、reasoning_content=思考，**累计
    快照**按 id 分槽前缀差分；tool_call_info.name==="finish" 的 params.summary
    为最终答复）/ model_config / token_usage / done；heartbeat、
    status_changed、platform_timing、timing_events、session_* 忽略；
    queuing/notification = 排队（并发受套餐 solo_agent_parallel_limit 限）。
  - 代价：每请求起云端沙箱 agent（约 25k 系统提示，跨会话前缀缓存命中
    25.4k/25.4k），**消耗 work 额度池**；OpenAI tools 无法传递（远端 agent
    自持工具），网关对带 tools 的请求返回 400 remote-no-tools。
  - 套餐门：error 事件 `1005`（message 空、data.plan 携带档位）——Free 账号
    请求 kimi-k3 命中（model_config 显示路由成功但 LLM 调用被拒）；glm-5.3 /
    kimi-k2.6 / DeepSeek 系可服务。
  - 并发门：业务 429 `991502 reason:solo_agent_parallel_limit`——只创建会话不
    消费事件流的僵尸会话同样占位；stop 端点对未运行会话回 409 "chat session
    is not running"，只能等沙箱 TTL 自灭（08-24 实测，diagnosis-trae-3003.md §3）。
  - **边缘层指纹（08-24 故障取证）**：TLB/nginx 节点路由漂移时 create_session
    返回**裸文本** `404 Not Found`（text/plain；WAF 拦截则为空体 403），而
    业务级拒绝恒为 JSON 信封、无凭据探测同路径稳定 401 JSON `{code:1001}`。
    remote.js 已对裸 404/403 自动重试一次。详见 docs/diagnosis-trae-3003.md §3。
- **额度双池实测**（2026-08-24，docs/probes/trae-credits-*.json）：
  `POST api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`（body
  `{"require_usage":true,"req_source":0|1|2}`，Cloud-IDE-JWT + x-device-*
  头组）→ `user_entitlement_pack_list[]`，按
  `entitlement_base_info.available_endpoint` 分池：**0=IDE 通用池（raw
  inline_chat 消耗）、1=work 池（remote chat_sessions 消耗）**；限额在
  `quota.credits_limit`，用量在 `usage.credits_amount`。实测对照：3 次 remote
  会话后 work 池 +9.4 credits（1764.2→1773.6），IDE 池不动（0.58）。
- **限流 4011 很紧**（raw 面）：短时连续探测即触发（"requests have exceeded
  the rate limit"）；联调时请求间隔 ≥20s。remote 面无 4011，但有排队。
- **/api/ide/v1/chat（老端点）存活但拒现代模型**：老 TraeRequest 信封被接受
  （user_input/intent_name/model_name…），但 model_name 校验 4023 "the model is
  unknown"（glm-5.3 / glm-5.2 均拒）——本账号该端点注册表不含现代 preset 名，
  不作为模型选择通道。`/api/ide/v1/get_model_list` 两域名均 404（2026-08-24）。
- GetUserInfo 的昵称字段是 **ScreenName**（Name/Nickname 均为空）。

## 6. 免责声明

同 traework-cn.md：仅用于本机软件互操作研究与调试；接口属厂商未公开协议，
可能随时变更；不得绕过鉴权、滥用配额或访问未授权数据。
