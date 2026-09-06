# 诊断报告：`trae 3003 all models failed`（PI_AI_ERROR）

**日期**：2026-08-24 ｜ **现象报告**：用户经 dsh-codebuddy-plugin 使用 TraeWork CN
模型，报 `trae 3003 all models failed`，宿主以 `PI_AI_ERROR` 包装。
**结论先行**：**Trae 服务端 inline_chat 面的模型解析层故障**（该面对一切 model 名
返回业务错误 `3003 "all models failed"`），不是插件缺陷，与用户凭据/额度无关。

## 1. 错误传播链（每一环都有实证）

```
dsh(pi-ai) ──OpenAI方言──▶ 插件 Trae 网关(127.0.0.1:3902, providers/trae/gateway.js)
   settings: traeEnabled=true, traeChatTransport="inline"(默认), traeChatBaseURL=mchost
   ──POST /api/agent/v3/llm_utils_chat (function=inline_chat)──▶ trae-api-cn.mchost.guru
Trae 云端：HTTP 200 SSE，事件流 = error{"code":3003,"message":"all models failed"} + done
网关映射 → 502 {"error":{"message":"trae 3003 all models failed","code":3003}}
pi-ai 收到非 2xx → 包装为 PI_AI_ERROR 呈现给用户
```

`PI_AI_ERROR` 只是宿主 LLM 层对上游非 2xx 的通用包装；真正的内容是网关透传的
Trae 业务码 3003。

## 2. 根因判定：服务端 inline 面故障

对照实验（同凭据、同头组、同信封 `buildChatRequest`，唯一变量=模型名/function）：

| 实验 | function | model | 结果 |
|---|---|---|---|
| A | inline_chat | glm-5.3（非默认） | SSE error **3003** "all models failed" |
| B | inline_chat | kimi-k2.6（文档记载的账户默认） | SSE error **3003** |
| B' | inline_chat | kimi-k2.7-code / Doubao-Seed-Code / 不带 model 字段 | 均 **3003** |
| C | chat_v3 | glm-5.3 | **200 正常回答**（"成功"），信封/鉴权全链路健康 |

**排除项（逐一证伪）**：
- **非凭据问题**：GetUserInfo 有效、同 JWT 在 chat_v3 面完整走通对话。
- **非配额问题**：`ide_user_ent_usage` 实测 IDE 池（endpoint=0）主包 2000 只用
  0.63 credits；work 池（endpoint=1）1803/2000 且另有十余个 200-credit 包在期。
- **非限流**：raw 面 4011 会显式报 "requests have exceeded the rate limit"，
  且 C 实验紧随 A/B 成功。
- **非信封/头组回归**：同一构造器产出的请求 chat_v3 通过；0.8.4 已用真实端到端
  双绿锁定过信封形态（CHANGELOG 0.8.4）。
- **非插件路由代码缺陷**：网关对 3003 的映射路径（SSE error → 502 结构化错误）
  与 mock 回归一致；失败流里连 `timing_cost` 都没有——服务端根本没走到选模型
  成功的那一步。

**服务端行为三阶段时间线（时变！）**：
1. ≤08-23 深夜 UTC：inline_chat 对任意 model 名返回 200 并静默改派到账户默认
   （带凭据联调实测：glm-5.2/glm-5.3/V4-Pro 全通）。
2. 08-24 ~08:06 UTC：改为硬错——仅非默认模型 3003（证据 `trae-model-routing3-*`，
   即 CHANGELOG 0.8.4 记录的"function 位钉死"）。
3. 08-24 ~09:39–10:05+ UTC：**扩大到一切 model 名（含默认、含缺省 model 字段）**
   （本诊断 A/B/B' 复现三次，跨约 30 分钟）。remote 面同时段出现间歇性边缘故障（§3）。

## 3. 次要发现（同日取证）

- **remote create_session 间歇性裸 404**：`/api/remote/v1/chat_sessions` 在
  TLB/nginx 节点间路由表漂移——带凭据请求命中缺路由节点时返回**裸文本**
  `404 Not Found`（content-type: text/plain）；无凭据探测同路径则稳定 401 JSON
  （业务鉴权层正常）。该 404 与请求头组/体内容无关（逐头逐字段二分均复现/消失
  与节点有关），数分钟窗口后自愈。**业务级拒绝恒为 JSON 信封**——这是判别
  边缘层 vs 应用层的可靠指纹。
- **边缘 WAF 动态拦截**：高频探测触发全路径 403 空体（含无凭据请求），冷却
  数分钟自愈。联调节奏必须克制。
- **991502 并发门**：`solo_agent_parallel_limit` 用满时报业务 429；只创建会话
  不消费事件流的僵尸会话同样占位，只能等沙箱 TTL 自灭（stop 端点对未运行
  会话回 409 "chat session is not running"）。
- remote 模型清单出现新默认位（solo_agent_remote 默认=Doubao-Seed-Code、
  solo_design_remote 默认=kimi-k2.7-code，证据 `trae-remote-models-*`），
  印证服务端当日在大规模调整模型注册表——与 inline 面故障时段吻合。

## 4. 已落地的加固（0.8.5）

1. **errors.js**：码表新增 3003/991502 语义；新导出 `formatTraeErrorMessage`，
   对已知码在透传消息后追加**可操作处置提示**（如 3003 → 建议切 remote 通道）。
2. **gateway.js**：三处错误文案（inline 非 OK 上游 / inline SSE error /
   remote SSE error）统一走 `formatTraeErrorMessage`。
3. **remote.js**：`createRemoteSession` 对**裸文本 404/403（边缘漂移指纹）**
   自动短退避重试一次（创建失败不产生会话，幂等安全）；持续失败时报文带自愈指引。
4. **verify-trae-provider.mjs** 新增 4 断言锁以上形态（77 项断言全绿）：
   mock 云端发 3003 → 网关消息含提示且 code 透传；mock 首次裸 404 → 重试成功；
   持续裸 404 → 文案带指引；formatTraeErrorMessage 单元三态。
5. 规范化诊断脚本（可重跑复现本轮实验）为开发期工具，未纳入开源快照；本报告已自包含实验矩阵与结论。

## 5. 用户侧操作指引

- **立即恢复可用**：设置卡 TraeWork CN 分区把「聊天传输」从 `inline` 切为
  `remote`（真模型路由；注意耗 work 额度池、不支持 OpenAI tools）。
- 或：稍后重试 inline 通道等服务端恢复（该面历史上多次自愈/翻转）。
- 若 remote 报"边缘节点路由漂移"提示：等几分钟再试（TLB 节点自愈）。
- 报 991502：等待存活会话过期或在 Trae 端手动停止会话。

## 6. 第二轮追踪（2026-08-24 ~10:18–10:36 UTC，端到端实测）

服务端故障在诊断后约 2.5 小时仍未自愈，且波及面扩大：

- **inline 面**：kimi-k2.6 持续 3003（09:39 / 10:05 / 10:20 / 10:33 / 10:36 五次采样一致）。
- **remote 面**：create_session 的节点漂移 404 持续间歇（09:46→404、09:52→200、
  10:05→404、10:20→404、10:26→404、10:36→404）。关键旁证：**同窗口内 GET 类
  路由（list/detail）稳定可用、仅 POST create 漂移**——按端点粒度的节点路由
  不稳，进一步支持 TLB 节点表漂移判定（非账号级封禁：无凭据探测同时段可复现
  业务级 401 JSON）。
- **0.8.5 加固已在真实故障中验证**：`createRemoteSession` 的自动重试与"边缘
  节点路由漂移…可稍后重试或改用 inline 通道"指引文案均按设计触发并透传到
  用户可见错误中。
- 当日实践建议更新：两端同时受影响时，**唯一正确动作是退避重试**（本插件网关
  已对 remote create 自动重试一次；调用方层面的长间隔重试同样安全——失败请求
  不产生会话、不耗额度）。

## 7. 第三/四轮追踪（2026-08-24 ~12:47–12:50 UTC）：加固已部署到用户真实路径

- **运行时发现**：本机 dsh web 实例从开发目录加载本插件（进程包装命令可见
  `cd /root/dev/dsh-codebuddy-plugin`）。故障期间运行的两个实例均为旧代码；
  经 `code/restart-dsh.sh` 重启后单实例（3080）加载 **v0.8.5**，3901/3902 桥、
  settings 路由、`GET /v1/models` 目录全部健康。
- **用户真实路径复现 → 修复对照**（同一请求 `POST 127.0.0.1:3902/v1/chat/completions`）：
  - 重启前（旧代码）：`502 {"error":{"message":"trae 3003 all models failed","code":3003}}`
    ——即用户报告的原始形态，pi-ai 包装为 PI_AI_ERROR。
  - 重启后（v0.8.5）：同一错误现在携带完整自助指引——
    `"trae 3003 all models failed （Trae 服务端 inline 通道当前对该模型名返回此错——非凭据/配额问题；…请在插件设置卡把「聊天传输」切为 remote，详见 docs/diagnosis-trae-3003.md）"`
- **事故时长**：inline 面 3003 自 ~08:06 UTC 起持续未自愈（最后一次采样
  12:51 UTC，约 4.8 小时，经运行网关实测）；remote
  create 的节点漂移窗口同样间歇存在（12:49 仍 404，重试+指引按设计触发）。
  两面同时受影响期间，插件侧已无更多可为——错误可读、重试自动、指引明确。
- **运维提示**：插件 JS 层修复需重启 dsh 生效；`traeChatTransport` 等设置项
  为逐请求热读取，切换传输无需重启。
- **操作入口验证（round 5）**：重启后的实例 settings 视图含 `traeChatTransport`
  （当前 inline）/`traeEnabled`/`traeChatBaseURL`——指引中"设置卡切 remote"
  的控件真实可用，闭环成立。

## 8. 第六轮：第三种失败模式（本地代理死态→无限挂起）与超时护栏

- **实测现象**（12:50–12:53 UTC）：网关 POST 偶发**无限挂起**（GET 路由正常、
  进程事件循环正常）。排查：直连 Trae 云端同一信封 385ms 即回（云端无恙）；
  运行实例环境继承了桌面代理 `http_proxy=127.0.0.1:7890` 且 no_proxy 不含
  trae 域——代理对 trae POST 存在"收下请求不回应"的间歇死态。
- **插件缺陷定级**：inline 上游 fetch 与 remote create 此前**均无客户端超时**
  ——任何"连上不出头"的死态都会转化为用户请求无限挂死。属真实健壮性缺陷，
  与本次服务端事故相互独立、但被其放大暴露。
- **修复（0.8.5 追加）**：
  - gateway.js inline 上游 fetch 加**首字节护栏**：响应头 45s 未达即 abort 并
    回结构化错误（文案带自助指引）；头到达后计时即清除，SSE 长流不受影响。
    可经设置 `upstreamFirstByteTimeoutMs`（1000–300000ms）覆盖，默认 45s。
  - remote.js `createRemoteSession` 整体限时 20s（测试可 `{timeoutMs}` 覆盖），
    超时报错带指引；边缘漂移重试逻辑不变。
  - `code/restart-dsh.sh` 启动 dsh 时清除四个代理变量——宿主上游不再依赖
    桌面代理的健康度。
- **回归**：verify-trae-provider 新增 2 断言（mock 零字节挂死 → inline 限时
  502 带指引 / remote create 限时失败带指引），79 项断言全绿。
- **round-7 部署验证**：新代码已在运行实例生效（settings 视图出现
  `upstreamFirstByteTimeoutMs:45000`）；经运行网关实测 POST 365ms 即回
  结构化错误。运维注：重启脚本会 pkill 全部 dsh web——若助手会话自身宿主于
  dsh，重启即中断该会话（本轮两次工具调用中断的直接原因），但 setsid 先行
  脱离，脚本效果不受影响；代理变量的彻底剥离留待宿主侧下次常规重启。

## 9. 第八轮追踪（2026-08-24 ~14:12–14:16 UTC）：事故持续 ~6h；v0.8.5 回退端到端验证 + tools 边界确认为用户可见根因

- **事故仍在持续**：规范化诊断脚本重跑——inline_chat 对 glm-5.3 与账户默认 kimi-k2.6 一律 SSE error 3003（267/616ms，
  无 timing_cost），同信封 chat_v3 正常出文本（改派 seed-code-lite-dev-0602-v1-part1）；双额度池健康（IDE 主包 2000 只用 0.64、work 池 1809.6/2000）。自 ~08:06 起
  未自愈。
- **v0.8.5 自动回退经运行实例端到端验证生效**：对运行网关
  `POST 127.0.0.1:3902/v1/chat/completions` 发无 tools 流式请求（模型名
  DeepSeek-V4-Flash-Official），HTTP 200 真实回答 + `: trae-reroute requested=… actual=seed-code-lite-dev-…`
  注释行——inline 首试 3003 后自动落 chat_v3，改派诚实披露按设计工作。
- **用户仍见裸错误的机制定位**：回退条件含 `!hasTools`（gateway.js:604）——dsh
  主聊天请求恒带 agent 工具表 → 永不回退 → 网关 502 `{code:3003}` → pi-ai 包装
  PI_AI_ERROR。实测复现：带 tools 请求返回
  `"trae 3003 all models failed （Trae 服务端 inline 通道当前对该模型名返回此错——…请把「聊天传输」切为 remote…）"`。
  即：**用户报告的报错形态 = 服务端 inline 面故障 × 带工具请求不静默降级的设计边界**；
  0.8.5 起该错误已携带完整自助指引（旧进程时代看到的是无指引裸文案）。
- **remote create 边缘漂移同窗口间歇存在**（诊断脚本 [R] 步 404 Not Found 裸文本
  ）——此刻切 remote 也可能先撞漂移（自动重试一次已内置），两面同时受影响时唯一
  正确动作仍是退避重试。
- **次要风险复核**：运行实例（21:43 CST 启动）环境仍继承桌面代理变量
  （`http(s)_proxy=127.0.0.1:7890`，no_proxy 不含 trae 域）——restart 脚本的剥离
  修复未及本进程；首字节护栏（45s，已确认在运行代码内）兜住挂死风险，但代理死态
  会表现为 45s 超时而非快速失败。宿主侧下次常规重启可彻底清除。

## 10. 第九轮：逆向漏项重审（2026-08-24 ~14:40–15:10 UTC）——结论：逆向无漏，但补了两条实证 + 一条兼容增强

**用户怀疑**：`trae 3003 all models failed` 会不会是**逆向漏了什么**（字段/端点/版本号）。
重审方法：官方客户端当日网络日志取证 + 二进制头组差异比对 + 两域名/版本号头/逐头二分实测。

**结论先行**：**没有漏**。① 官方客户端当日也用同一端点（llm_utils_chat）、同一
307 重定向目标（api5-normal.mchost.guru）、同一认证形态；② 官方主聊天走 remote
通道（当日 `chat_sessions` 提及 576 次 vs `llm_utils_chat` 20 次），官方自己在
事故期也不依赖 inline 面；③ 实测两域名同信封同为 3003、逐头二分加回官方头组
均无行为差异 → 域名/版本号头/头组**均非** 3003 根因。**逆向没有漏掉"能绕开
3003"的东西**——服务端 inline 面确实故障，与上轮判定一致。

**新增实证**：
- **官方 307 重定向**：官方 llm_utils_chat 请求经 TTNet 内部 307 从
  `trae-api-cn` 落到 `api5-normal.mchost.guru`（当日 586 次 307 全落该域）。
  但 api5-normal 直连实测同样 3003 → 不是"官方连的节点好、插件连的节点坏"。
- **官方头组清单**（从官方网络日志逐头提取，token 已脱敏）：version-code 用
  当日构建号 `20260811`（插件钉死 `20260401`）、`x-app-version:"default"`、
  `x-ide-version:"0.1.52"`、`x-bridge-transport:"aha"`、`x-request-pin` +
  `x-requested-at`（**成对**，缺 `x-request-pin` 会 400 "x-request-pin or
  x-requested-at is empty"）、`request-traffic-type:"prod"`、
  `user-agent:"TraeClient/TTNet"`、`x-lgw-req-sdk-type:"3"`、`x-lscbd-*`、
  `x-net-sdk-domain-dispatch:"1"`、`package-type:"stable_cn"` 等。逐头加回
  二分：**均不改变 3003 行为**；唯一有响应差异的是 `x-request-pin`/
  `x-requested-at` 成对（缺了就 400，与 3003 无关）。
- **官方日志的 SUCCESS 不可作为"官方未撞 3003"的证据**：网络日志只记录链路层
  （307→200），响应体被 TTNet 吞掉不落盘；官方 UI 走 remote 通道，inline 面
  官方自己也不跑。

**关键纠偏（临时波动警示）**：同信封同 token 同内容，chat_v3 曾短暂返回
**1005 套餐门**（`extra:{"plan":1}`，kimi/glm/DeepSeek 三模型全中）——若据此
判定"账号套餐到期"就错了。数分钟内自愈回 200（内容二分证伪：同 `回复成功`
现在 200 成功）。**单次 1005 不可作账号级套餐判定**，需重试交叉验证。这也说明
故障期服务端在该域名下有多重不稳定（3003 持续 / 1005 闪断 / 超时）。

**落地增强（v0.8.6 候选）**：网关 inline 出站**跟随官方 307 重定向**
（fetch redirect:'follow'，官方 TTNet 即此语义），并补齐 `request-traffic-type`/
`package-type`/`x-lgw-req-sdk-type` 三个无害指纹头（实测对响应无影响）。
**不**伪造 `x-request-pin`/`x-requested-at` 对——服务端见 pin 头即强制 base64
校验，外部复刻者无官方密钥无法生成合法 pin，发了必 400 `base64 decode failed`
（round 9 逐格式实测：官方日志原值 89532a712e043c54 直接复用也 400）。
3003 根因仍在服务端 inline 面，无客户端可绕；**切 remote 传输仍是唯一真模型
选择 + 恢复路径**。

## 11. GitHub 调研与可用的工程解法（round 6–7）
- `autumnsentiment/Trae2api-cn`（★10，最后更新 2026-08-20）：生产参照。默认
  `UPSTREAM_MODE=raw` 只直连 `llm_utils_chat`——其协议/信封与本插件完全一致；
  remote 模式同我们 chat_sessions 协议。其回退链含 `/api/ide/v1/chat` 与
  `/api/agent/v3/create_agent_task`（后者参考 laojichao/trae-local-api）。
- `ProjectEio/trae2api`（★12，Go，2026-07）：以 **create_agent_task 为唯一聊
  天端点**，模型用内部 config_name（如 gemini_2.5_flash_premium），带模板渲
  染/mcp 工具表/history_id_list 的完整 IDE agent 协议。
- **结论：无现成"绕过 3003"的社区解**——事故晚于所有社区更新（8-20 后）。

**本轮实测收敛出的可用通道**：
- `create_agent_task` 信封绑定字段已逐字段探明（conversation_id/user_id/
  device_id/agent_type/model_name/config_name/ide_version/user_input）→
  HTTP 200 SSE，但报 `4001 config item is empty`——solo_agent_lite 的模型
  配置注册表同样为空（含 ProjectEio 目录里的老名字），与 inline_chat 同根。
- **chat_v3 是当前唯一活着的面**：同信封实测正常出文本（改派 seed-code-lite，
  timing_cost 可证）。inline_chat 连已知存在的 seed-code-lite 名也 3003 ——
  该面的解析层整体故障，而非注册表缺项。

**落地修复（0.8.5 追加）：inline 3003 事故回退**
- 网关在 inline_chat 遇 SSE error 3003 且请求无 tools 时，自动以 chat_v3 重
  试一次；回答照常返回，改派由既有机制诚实披露（SSE 注释行 / message.note
  / 计量记真实模型），绝不假装请求模型被服务。
- 带 tools 的请求不静默降级（工具语义不可靠），维持原错误透传。
- 回归 +2 断言（81 项全绿）：mock 仅对 inline_chat 注入 3003 → 客户端拿到真
  实文本、note 标注 served-by/requested、两次上游调用、计量记真实模型。
