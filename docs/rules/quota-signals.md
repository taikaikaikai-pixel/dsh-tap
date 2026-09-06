# 规则 04：额度信号地图

> 状态：**规则成立**（额度耗尽错误码不可安全观测，标未解——见 §4）
> **2026-08-19 晚重大修订**：数值剩余额度 API **已找到**（R-Q7）——`/billing/meter/get-user-resource`
> 等控制台计费路径族接受 OAuth Bearer token（两域名同构），旧结论"数字剩余额度无
> CLI/api-key 可达 API"对 **OAuth token 不成立**（对 `ck_` key 仍成立：401）。
> 证据：2026-08-19 额度信号地图探测 9 条 + G2 真实 token 八组矩阵（matrix/quota/quota2/values/quota3–7/refresh）+ 2026-08-18 存量三端点探测（开发期原始证据未纳入开源快照，结论自包含于本文）

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

原始探测脚本（8 臂全端点额度信号扫描、存量三端点探测、G2 token×端点矩阵与 quota/quota2..7/refresh 轮次）为开发期一次性工具，未纳入开源快照；本文结论按规则编号（R-Q1..R-Q7）自包含。
