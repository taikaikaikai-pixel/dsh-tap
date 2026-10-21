# 规则 04：额度信号地图

> 状态：**规则成立**（额度耗尽错误码不可安全观测，标未解——见 §4）
> **2026-08-19 晚重大修订**：数值剩余额度 API **已找到**（R-Q7）——`/billing/meter/get-user-resource`
> 等控制台计费路径族接受 OAuth Bearer token（两域名同构），旧结论"数字剩余额度无
> CLI/api-key 可达 API"对 **OAuth token 不成立**（对 `ck_` key 仍成立：401）。
> 证据：`docs/probes/quota-map-2026-08-19.jsonl`（9 条）+ `docs/probes/oauth-token-2026-08-19.jsonl`
> （G2 矩阵 matrix/quota/quota2/values/quota3–7/refresh 八组）+ 存量 `quota-2026-08-18.json`
> 脚本：`scripts/probe-quota2.mjs`、`scripts/probe-oauth.mjs --set matrix|quota|quota2|values|quota3|quota4|quota5|quota6|quota7|refresh`（可复跑）

## 1. 现象（上游咒语原文）

- AGENTS.md:26 —「额度信号盘点：`GET /v2/accounts` 账户元数据；`POST /v2/billing/meter/get-dosage-notify` 低额告警源，健康时返回空文案；**数字剩余额度无 CLI/api-key 可达 API**——chat 响应头无 quota 字段……计费只有每请求 `usage.credit` 自报」

咒语是一份**点状清单**；本课题把它升级为**全端点 × 全响应头 × 响应体字段**的完整否定/肯定地图。

## 2. 规则（每条附验证过程）

### R-Q1 响应头：全网关零额度信号

**规则**：任何端点、任何响应形态（成功/错误）的响应头都不携带额度信息。
**验证**：chat 存量 12 头全枚举无 quota（quota-2026-08-18.json）；本轮 P-Q1a/accounts、P-Q1b/config、P-Q1c/dosage 三端点 **0 quota 头 HIT**；P-Q4 错误信封（12403）同样 **0 quota 头 HIT**。现存响应头全集：cache-control/connection/content-type/date/eo-*/server/traceid/x-request-id/x-user-id/x-waf-uuid 等传输与追踪头。

### R-Q2 agenttool 响应体：无计量字段

**规则**：`/agenttool/v1/search` 与 `/agenttool/v1/webfetch` 的响应体都**没有** usage/credit 字段（深度键名扫描全文）。
**验证**：P-Q2a search 无 usage **HIT**（预注册）；P-Q2b webfetch 原预测"有 usage"（由 index.js:653 `data?.usage` 条件记录推断）**MISS**——实测 `{url,title,content}` 全文无任何计量字段。推翻已记录；附带结论：**插件 webfetch 的 usage 记录是死路径**（重构时可删，注释标注本证据）。

### R-Q3 dosage-notify：无参接口，健康形态固定

**规则**：`POST /v2/billing/meter/get-dosage-notify` 忽略请求参数；健康时恒返回 `{dosageNotifyCode:0, dosageNotifyZh:"", dosageNotifyEn:"", skipUrl:""}`。
**验证**：P-Q3 携带 `{threshold:100, level:"high"}` 返回与 `{}` 完全同形 **HIT**（预注册）。非健康形态（告警文案/ dosageNotifyCode 非 0）当前账号无法诱发——见 §4。

### R-Q4 /v3/config 的 `models[].credits`：展示倍率，不是费率表

**规则**：目录每个模型带字符串字段 `credits: "xN.NN credits"`（本账号实测：v4-pro x0.51、v4-flash x0.17、v3-2-volc x0.29、glm-5.2 x0.79、kimi-k2.6 x0.52、hy3 x0.00）。它是**相对展示倍率**：与实测 credit/1k tokens 不成线性（glm-5.2 倍率最高 0.79，实测 0.171 credit/1k 却低于 v4-pro 的 0.257）；唯一成立的硬映射是 **x0.00 ⟺ 实测零计费**。
**验证**：倍率字段本轮发现于 P-Q1b 的体扫描；**P-Q5 预注册命中**——读 `hy3 = x0.00` 后预测"hy3 微调用 usage.credit === 0"，实测 200 / credit=0 / 16 tokens ✓。
**推翻记录**："credits 是每 1k token 费率"假设被实测单价对比推翻（非线性）。
**展示落地（0.21.0）**：设置卡 CodeBuddy 模型行显示 `xN.NN` 徽标（宿主官方 `Tag` 原语，`x0.00` 用 success 调）。提取层 = `providers/codebuddy/catalog.js` 的 `parseCredits()`：**只原样取 token，不换算、不排序、不补缺失值**；缺 `credits` 的条目不出徽标。展示层**不得**把它当单价表做成本推算——本规则的非线性结论是硬约束。
**手填兜底（0.21.0）**：官方目录没标倍率的模型（Trae/Qoder 全量、CodeBuddy 缺字段条目）允许用户在设置卡逐模型手填，存文件层 `manualCredits`（按通道隔离）。这份值是**用户断言、不是网关事实**，与 R-Q4 的官方倍率共用同一展示位置但语义不同：**官方值优先、手填只在官方缺位时渲染，且两者都只用于展示，禁止进入任何计费/额度推算**。归一化口径唯一真源 = `credits.js`（`parseCredits` / `normalizeCredits`）。
**选择器同源（0.21.0）**：主界面输入框的模型按钮/菜单也显示同一枚徽标，实现是 **CSS `::after` 装饰**——给 `<style data-plugin-css="dsh-tap-credits">` 铺 `[data-provider-id][data-model-id]::after` 规则（官方 README 认可的三处标签扩展点），**不注册 `conversation.input.model.label` 槽**（早期曾用 `priority: -1` 接管，因会顶掉 DeepSeek 账号与 key 型服务商上的官方装饰而废弃）。数据 = 服务端 `creditsView()` 产出的合并表（`mergeCredits`：官方压手填），与设置卡同源同口径；**该表只走展示通道，不进 profiles/镜像**（踩坑 #12 的 schema 白名单会静默丢键）。**限流/排队徽标的 trigger 锚点例外（0.21.0，踩坑 #72）**：输入框模型按钮的模型名盒是截断盒（`text-overflow:ellipsis` + `overflow:hidden`）且按钮 `max-width:min(360px,45cqw)`，挂在名字 span 上的行内 `::after` 会被整枚裁掉 ⇒ trigger 里改挂到 `button[aria-haspopup="menu"]` 自身（flex item，`order:1`），label 盒里的同一枚用 `content:none` 关掉；trigger 用短文案（`限流 · 11:42` / `排队`），菜单与选项仍是全文。

### R-Q5 计费正信号：仅 chat SSE 的 usage.credit

唯一按请求计费自报字段仍是 chat SSE 末 chunk 的 `usage.credit`（存量诊断 §3.1 单价拟合）；agenttool 无（R-Q2）、媒体端点响应无计量字段（media 证据体扫描：url/data 结构）。**额度信息到此为止，没有更多来源。**

### R-Q6 端点存在性附记

`GET /v2/report` → `404 page not found`（Go 风格措辞），与路由层 `404 Route Not Found`（课题 3 R-R1）是**两套 404 实现**——可作网关服务边界的指纹。

### R-Q7 数值剩余额度 API 已找到：`/billing/meter/*` 控制台计费路径族（OAuth Bearer 可达）

**规则**：数值剩余额度存在于控制台用户中心（www.codebuddy.cn/profile/plan SPA）背后的
`/billing/meter/*` 路径族，且**接受 OAuth Bearer token**——在 copilot.tencent.com 与
www.codebuddy.cn **两域名同构可达**（实测逐路径 200 code 0 完全一致）。`ck_` key 被拒
（401 nginx 裸页）——该路径族是 **OAuth-only**。发现链：SPA HTML →
`download.codebuddy.cn/web/usercenter/<hash>/assets/*.js`（公开静态资源）→
config chunk 内的路径字面量（`un.post("/billing/meter/get-user-resource",e)` 等）。

| 端点（全部 POST，JSON body） | 认证 | 数据 |
|---|---|---|
| `/billing/meter/get-user-resource` `{}` | OAuth Bearer | **数值剩余额度主源**：`Response.Data.{TotalCount,TotalDosage,Accounts[]}`；每个资源包带 `PackageName`、`CapacitySize/Remain/Used`、`CapacityRemainPrecise`（亚 credit 精度字符串）、`CycleCapacity*`（周期视图）、`CycleStart/EndTime` |
| `/billing/meter/check-gift-claimed` `{}` | OAuth Bearer | 赠品包状态：`{claimed,claimed_at,active,credit_num,validity_period,start_time,end_time}`（本账号：1500 credits 已领、active） |
| `/billing/meter/compensation-status` `{}` | OAuth Bearer | 补偿包状态（本账号：1000 credits 未领、active:false、已过期） |
| `/billing/meter/get-enterprise-user-usage` `{}` + `X-Enterprise-Id: <enterpriseId>` | OAuth Bearer | 套餐视图：`{credit,limitNum,cycleStartTime,cycleEndTime,cycleResetTime}`——控制台套餐页 credit/limitNum 字段的数据源（本账号企业：limitNum 2000、credit 0） |
| `/billing/meter/get-user-daily-usage` `{startTime,endTime,pageNum,pageSize}` + `X-Enterprise-Id` | OAuth Bearer | 按日用量 `{total,data[]}` |
| `/billing/meter/get-user-request-usage` `{startTime,endTime,timezone,pageSize,version:2,pageToken}` + `X-Enterprise-Id` | OAuth Bearer | 按请求用量（requestId + credit 列，控制台"用量"页表格源） |

**参数纪律**：
- daily/request-usage 的 `X-Enterprise-Id` 为**必填作用域头**：省略 → `400 10001 invalid params`；
  个人上下文 = 字面量 `"personal"`（控制台 sessionStorage `profile-enterpriseId` 的缺省值），
  也可传账户 uid；企业上下文 = 真实 enterpriseId。
- endTime 允许未来时刻（`今天 23:59:59` 不报错）；日期格式 `YYYY-MM-DD HH:mm:ss`。
- 未解疑点：personal 作用域本月 daily/request 均 `{total:0,data:[]}`，与资源包实测消耗
  （赠送包 CycleCapacityUsed 533.27）矛盾——用量明细表可能只记企业线或有延迟，标**存疑**，
  不作为插件数据源（插件自有 usage-meter 覆盖该需求）。

**预注册命中/推翻**：P-QP1（copilot 猜测路径全 404）HIT；P-QP2（workbuddy 镜像）HIT；
P-QP3 HIT；P-QP4/P-QP5（"控制台 API 拒绝 Bearer"）**MISS 推翻**——`/billing/meter/*` 与
`/console/accounts` 接受 Bearer；P-QP6（同路径在网关域 404）**MISS 推翻**——网关域同样服务
该路径族（网关路径族不止 /v2、/v3、/agenttool）；P-QP7 HIT。
`/cgi/v2/user/getInfo` 在两域名均 404（cookie 包装器属于别的宿主），控制台 cookie 体系
本身仍未触（按红线不碰）。

**对旧结论的修订**：AGENTS.md「数字剩余额度无 CLI/api-key 可达 API」与本文 §3 旧表
「数值剩余额度——任何端点都没有」**对 OAuth token 作废**；对 `ck_` key 依然成立
（quota4-resource-ck-key → 401）。插件在 OAuth 模式下可显示真实剩余额度。

### R-Q8 Qoder CN 目录的 `price_factor`：官方逐模型倍率（2026-10 新增）

**规则**：`GET /algo/api/v2/model/list`（COSY 签名）的 `chat[]` 条目新增 `price_factor`（数值 = 逐模型倍率），与 CodeBuddy `/v3/config` 的 `credits` 同义，属**官方标注的倍率**。限免/促销条目另带 `original_price_factor`（原价倍率）与 `is_free:true`。
**实测**（2026-10-20，证据 `docs/probes/qoder-price-factor-2026-10-20.json`）：14 条 chat 条目里 `price_factor` 取值为 0 / 0.1 / 0.5 / 0.6 / 0.8 / 1.4；**只有两个 `enable:true` 的现售条目**（`qfmodel`、`dfmodel`）为 `0` + `original_price_factor:0.1` + `is_free:true`。同次实测该账号 `enable:false` 的条目达 12 条（Auto / Qwen3.8-Max / DeepSeek-V4-Pro / GLM / Kimi / MiniMax 等），即目录里能进选择器的只有两个免费档模型——这是**账号侧可见集**，不是插件过滤造成的。
**与已证结论的一致性**：`qfmodel` 免费档「帧 `billable:false`、不耗 credits」在 2026-09 就实测过（docs/diagnosis-qoder-flash.md 同族），与 `price_factor:0` 吻合——这是该字段**唯一被交叉验证**的语义点。其余数值（0.1/0.5/1.4 …）与实测 credit 消耗是否线性**未验证**，故与 R-Q4 同一纪律：**只展示、不换算、不当单价表**。
**落地**：`providers/qoder/catalog.js` 投影 `credits` 表（`credits.js` 的 `creditTokenFromNumber`：0 → `"0.00"`，其余保留至多两位小数），经 `catalogView()` 出到 `index.js` 的 `creditsView()` 合并表（官方压手填）；**不进 profiles/镜像**（踩坑 #12 的 schema 白名单）。设置卡 Qoder 模型行与输入框模型选择器的装饰随之自动生效。

### R-Q9 Qoder 排队降级（10605）会被按 `auto` 计费——`usage.credits` 离群值的真实成因

**根因（2026-10-20 定位；用户提供的控制台明细是决定性证据）**：那几笔离群值**不是上游乱发数字**，而是**真的按 `auto` 模型计费了**——控制台明细里同一时段的 496.18 / 44.57 / 48.30 三笔，模型列全部是 **`Auto`**（正常请求记的是 `DeepSeek-Flash`）。因果链：
1. 指定模型此刻进上游队列——实测 `POST model=dfmodel` → 上游 403 + `{"code":"10605","isQueued":true,"modelKey":"dfmodel","queueType":"p3","serviceAvailable":false,"retryAfterSeconds":30}`；
2. 旧网关把它归一成 **502** 抛给宿主，宿主 pi-ai 随即**立刻重发**；
3. 重发请求被上游按**降级模型 `auto`** 处理并按 auto 的倍率扣费（auto 的 `price_factor` = 0.5，dfmodel = 0，量级差与实测吻合）。

**规则**：Qoder 聊天 SSE 末帧的 `usage.credits` 在**正常**情况下是可用的每轮计费量（本机 100 轮实测 1e-6~3e-6 credit/token），但**排队降级时回传的是按 `auto` 计费的数字**——实测同一会话内 prompt 仅增长 6%（43.4 万 → 46 万 token），单轮 credit 却从 `0.54` 跳到 `496.18`（≈1.08e-3 credit/token，**比正常量级高 900 倍**），随后两轮 `44.6` / `48.3` 同样离群。同期官方配额面为 `isQuotaExceeded:true`、`userQuota` 全 0、`addOnQuota` 字段整个消失。
**处置（0.21.0）**：`core/usage-meter.js` 按 `credit > max(2, prompt_tokens × 1e-5)` 打 `suspect` 标注——**只标注、不改写历史**：可疑值不进逐通道合计，单独计入 `suspectCredit/suspectRequests` 并在设置卡提示；全局 `totalCredit` 保持原样（不静默篡改用户已看过的数字）。阈值依据 = 正常量级实测上限（3e-6）留 3 倍余量，并对短对话设 2 credit 下限防误伤。
**修法（0.21.0，初版 + 补全）**：`providers/qoder/gateway.js` 识别 10605 队列信封（多层转义下钻找 `isQueued`/`serviceAvailable` 特征键），回 **429 + `Retry-After`** + `code: qoder_model_queued`，让宿主走**退避**而不是立刻重发；网关侧绝不自行重发。
**关键前提（0.21.0 实测修正）**：① **上游对业务失败也回 HTTP 200**——错误装在 SSE 信封的 `body` 里（`statusCodeValue`），所以队列识别必须同时挂在「非 2xx」与「流内 `ev.error`」两条路径，只写在 `!upstreamResp.ok` 里对主聊天（流式）**永远不触发**；② 旧代码在开始读流**之前**就 `writeHead(200)`，导致流内错误无法回 4xx——已改为「首个有效 chunk 才写头」（`ensureStreamHead`）。
`verify-qoder-provider` 由 `[18b]`(6) + `[18c]`(3) + `[18d]`(3) 共 12 条断言锁定。
**仍存疑**：为何重发会精确落到 `auto`（上游按可用性路由，还是 10605 后的既定降级策略）未定；但「立刻重发 = 触发降级计费」这条因果已被控制台明细证实，故按最坏情况设防。

### R-Q10 Qoder 响应的 `model` 字段恒回 `auto`——**不能当路由证据**（2026-10-20 更正）

**规则**：Qoder infer 面的成功响应里，chunk/响应的 `model` 字段**恒为 `"auto"`**，与请求指定的模型无关。但它**不代表请求被路由到 Auto**——用 `price_factor` 做判别可证明计费确实跟着请求模型走。
**实测（正确账号 `acct-A…`，同一 prompt / max_tokens=8，证据见本节表）**：

| 请求模型 | price_factor | prompt/completion | credit | credit/1k tokens |
|---|---|---|---|---|
| `mmodel` | 0.1 | 204 / 18 | 0.002193 | 0.0099 |
| `dmodel` | 0.5 | 98 / 17 | 0.029797 | 0.2591 |
| `kmodel_latest` | 1.4 | 87 / 47 | 0.150252 | 1.1213 |

credit 随请求模型的 `price_factor` 单调放大（跨度约 100 倍）⇒ **路由与计费都按指定模型**，`model:"auto"` 只是回显标签。
**推论**：`usage.credits` 的绝对值必须结合**请求的是哪个模型**才能判读；早期把它当作"离群值/上游乱发数字"（R-Q9 v1 的表述）是**读错**——当时缺的是"请求模型"这一维。R-Q9 的 10605 队列因果链仍然成立（有队列信封实证），但"数值不可信"的说法作废。
**另注（已更正）**：`qfmodel` / `dfmodel` 的 `[FAIL]node:oa_qwen-plus-main` 失败**不是上游节点持久故障**——A/B 实测（同账号、同模型、各 3 次）：**裸 OpenAI 体 0/3 成功**，**补齐官方归因信封后 3/3 成功**。即该失败是"裸请求被路由到降级节点"，插件出站自 0.9.9 起就带完整信封，故插件路径不受影响。详见 docs/diagnosis-qoder-flash.md §0。

### R-Q11 CodeBuddy 限流态（429 / code 6004）：带确定性重置时刻，必须展示而非裸传

**规则**：模型级频率限制回 **HTTP 429** + `{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-21 11:42:24 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"…"}`。语义三要素齐全：① 是**限流**不是故障；② 有**确定重置时刻**（UTC+8）；③ 官方明示**可切换其他模型**。
**实测（2026-10-20）**：同一会话里 `deepseek-v4.1-flash` 限流（429/6004），而 `deepseek-v4-pro` / `glm-5.3-flash` / `step-5-preview` / `default` 全部 200 ⇒ **限流是按模型的账号级配额**，不是通道整体故障。
**为何必须专门处理**：桥此前原样透传裸 JSON，用户看到的是 `{"code":6004,...}`，既不知道是限流、也不知道何时恢复、更不知道可以换模型。且 429 若按普通错误处理，宿主 pi-ai 会**连发**，继续撞限流。
**落地（0.21.0）**：`providers/codebuddy/rate-limit.js` 解析该形态（含从文案归算 resetAt）；`provider.describeUpstreamError()` 提供语义、`core/bridge.js` 只做通用转发（core 禁上游词闸门）；桥双路径回 429 + `Retry-After` + `code:codebuddy_rate_limited`；`runtime.rateLimit` 下发到设置卡（区块头 + 模型行徽标 + 恢复时刻）。
**重试策略（0.21.0）**：限流有明确重置点，重试只会继续撞墙 ⇒ CodeBuddy provider 的 `retryPolicy` 设为 `{mode:'normal', maxRetries:0}`（不重试），429 直接落到 turn-error 显示"限流 + 恢复时刻 + 可换模型"。Qoder 侧只有排队 10605 重试（30s 一次），额度 `[EXCEED_QUOTA]` 的 429 消息带 `usage limit exceeded` 让宿主分类成 `QUOTA`（非 retryable），两者不会被混为一谈（踩坑 #71）。

## 3. 额度信号完整地图（结论表）

| 端点 | 响应头额度信号 | 响应体额度信号 |
|---|---|---|
| POST /v2/chat/completions | 无 | `usage.credit`（每请求计费）、`usage.prompt_cache_*`（缓存计费依据） |
| GET /v2/accounts | 无 | 账户元数据（plan type、enterprise；**无数值额度**）。注意：2026-08-19 观测到该端点网关侧持续故障（午后 500 APISIX 错误页 → 傍晚 524 origin timeout，OAuth token 有效、其余计费端点同时段正常），插件侧按 `accountsError` 降级展示 |
| GET /console/accounts | 无 | 同 /v2/accounts（OAuth Bearer 可达，两域名同构） |
| POST /v2/billing/meter/get-dosage-notify | 无 | 低额告警文案（健康时空；无参） |
| POST /billing/meter/get-user-resource | 无 | **数值剩余额度**（资源包 CapacityRemain/Precise、TotalDosage；OAuth-only） |
| POST /billing/meter/check-gift-claimed、/compensation-status | 无 | 赠品/补偿包 credit_num 与状态（OAuth-only） |
| POST /billing/meter/get-enterprise-user-usage | 无 | 套餐 credit/limitNum/周期（OAuth-only，需 X-Enterprise-Id） |
| POST /billing/meter/get-user-daily-usage、/get-user-request-usage | 无 | 用量明细（OAuth-only，需 X-Enterprise-Id 作用域；personal 实测空，存疑） |
| GET /v3/config | 无 | `models[].credits` 展示倍率（x0.00=零计费已验证） |
| Qoder `GET /algo/api/v2/model/list` | 无 | `chat[].price_factor` 逐模型倍率（R-Q8）；`original_price_factor`/`is_free` 仅限免条目 |
| Qoder `GET /api/v2/quota/usage` | 无 | `userQuota`/`addOnQuota`（total/used/remaining，整数计数器，实时）；耗尽时 addOnQuota 字段消失（R-Q9 同次观测） |
| Qoder 聊天 SSE | 无 | `usage.credits`（每轮计费量；**耗尽/限额时出现非计费语义离群值**，R-Q9） |
| /agenttool/v1/search、/webfetch | 无 | 无 |
| /v2/images/generations | 无 | 无（media 证据） |
| 错误信封（12403 等） | 无 | 无 |
| 数值剩余额度 | — | **OAuth token：`/billing/meter/get-user-resource` 可达**；`ck_` key：任何端点都没有（401） |

## 4. 未解（诚实标注）

- **额度耗尽/超额错误码**：诱发需要真实耗尽账号额度，违反只读/低速率红线，**标未解**。存量已知告警源仅 dosage-notify 的文案字段。
- 告警形态下 dosageNotifyCode 的取值集（健康时恒 0）未观测。
- ~~网页控制台 plan API（cookie 体系）按红线不碰~~ → 2026-08-19 修订：数值数据**不再需要** cookie 体系（R-Q7，OAuth Bearer 直达）；cookie 包装器（/cgi/v2/*）本身仍不碰。
- credits 倍率的精确定价口径（相对哪个基准、是否含输出折算）不可从客户端确定。
- daily/request-usage 在 personal 作用域返回空但与实测消耗矛盾（R-Q7 存疑条）——用量明细表的记账范围/延迟未解。
- get-user-resource 的 `CapacityRemain`（整包剩余）与 `CycleCapacityRemain`（周期剩余）的扣减顺序、多包优先级（哪个包先扣）未测。

## 5. 复跑路径

```bash
node scripts/probe-quota2.mjs    # 8 臂全端点额度信号扫描
node scripts/probe-quota.mjs     # 存量三端点探测
node scripts/probe-oauth.mjs --set matrix   # G2：token×端点矩阵（五端点×双凭据）
node scripts/probe-oauth.mjs --set quota    # G2：两域名猜测路径 + workbuddy 镜像 + 控制台候选
node scripts/probe-oauth.mjs --set quota2   # G2：控制台真实只读路径（SPA 逆向）
node scripts/probe-oauth.mjs --set quota3   # G2：/billing/meter/get-* 首测
node scripts/probe-oauth.mjs --set quota4   # G2：参数形态 + 企业用法 + ck_ key 边界
node scripts/probe-oauth.mjs --set quota5|quota6|quota7   # 作用域头判别与值捕获
node scripts/probe-oauth.mjs --set refresh  # G2：真实 refresh 轮换（回写 auth 文件）
```
