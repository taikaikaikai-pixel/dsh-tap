# 规则 05：OAuth 握手

> 状态：**规则成立**——state 生命周期、token 权限边界（R-O5）、refresh 轮换（R-O6）均已收束；仅剩 state 真实 TTL **未解**（需下次交互登录时顺带验证，见 §5）
> 证据：2026-08-19 探测 15 条（无认证只读）+ G2 真实 token 八组矩阵（开发期原始证据未纳入开源快照，结论自包含于本文）

## 1. 现象（上游咒语原文）

- AGENTS.md:25 —「OAuth 设备流：`POST /v2/plugin/auth/state?platform=CLI`（三个 `X-No-*` 头）→ 浏览器打开 authUrl → 轮询 `GET /v2/plugin/auth/token?state=`（`11217`=未完成）→ `GET /v2/plugin/login/account`；刷新 `POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token`）」
- 实现侧（index.js:441-442）：客户端轮询上限 10 分钟、间隔 1s；refresh 在 `expiresAt` 前 60s 触发，`expiresIn` 缺省按 3600s。

## 2. 规则（每条附验证过程）

### R-O1 state 创建：无认证、`X-No-*` 三头是迷信、`platform` 必填但任意

- 创建 `POST /v2/plugin/auth/state?platform=<X>` 无需任何凭据（200 code 0，36 字符 state + authUrl）。
- **咒语破除**：不带三个 `X-No-*` 头照常签发（P-O3 **HIT**）——它们是 CLI 遥测习惯，不是校验项。
- `platform` **必填**（省略 → `400 code 10001 "platform is empty"`）但取值任意（`WORKBUDDY` 照过，P-O4 半 HIT 半推翻：推翻"省略也行"，成立"自由文本"）。与 AGENTS.md:27 的 WorkBuddy 同体系互证。

### R-O2 state 生命周期：pending/无效/过期三态不可区分

- 轮询 `GET /v2/plugin/auth/token?state=` 对**一切未完成的 state**（合法的 pending、纯编造的 bogus、推定已过期的）统一回 `200 code 11217 "login ing"`（P-O1 原预测"bogus 可区分"**MISS**，这是本课题最重要的否定发现）。
- **直接后果**：state 的服务端 TTL **不可从 token 端点观测**（+60s/+240s 均 11217，P-O5 表面 HIT 但对 bogus state 同样成立——该"存活"证据无效，TTL 标未解）；客户端唯一正确策略就是插件现行的**轮询 + 本地超时放弃**（10 分钟）。
- 多 state 并发互不作废：创建 state2 后 state1 仍 11217（P-O2 **HIT**）——无单飞约束；插件 `oauthPending.active` 的单飞是纯客户端选择。

### R-O3 account 端点：pending state → 裸 401

`GET /v2/plugin/login/account?state=<pending>` → **401 nginx HTML 页**（非 JSON 信封，无 code）（P-O6 **HIT**，预测"code ≠ 0"）。即账户信息端点在 token 签发前由前置代理直接拒绝，不走业务码。

### R-O4 refresh 失败形态：响亮失败

`POST /v2/plugin/auth/token/refresh` 带 bogus `X-Refresh-Token` → `401 code 12153 "refresh token failed:10000:token format error"`（P-O7 **HIT**：非 2xx 且业务码非 0，双信号响亮；内层码 10000=token format error）。
插件 `refreshOAuth` 对 `!res.ok` 或 `code!==0` 均返回 undefined → 触发重新登录路径，与该失败形态匹配。

## 3. 对重构的输入

- core 层设备流抽象只需：`createState(platform)` / `pollToken(state)` / `refresh(token)` 三接口；**"11217 永远 ambiguous"是必须写进 core 注释的契约**（轮询放弃策略由 core 提供，provider 只给端点路径与头方言）。
- X-No-* 三头从"必须"降级为 provider 方言默认值（迷信破除的证据在 P-O3）。
- 错误规范化要覆盖两种非 JSON 形态：nginx 裸 401 HTML（account 端点）与 401+JSON 业务码（refresh）。

## 4. 探测边界声明

本轮 15 次调用全部为**未认证公开端点的只读探测**：未创建真实会话、未铸造任何 token、未触碰审核/风控逻辑。bogus token 仅用于观测失败形态。

## 5. 未解（解锁条件明确）

| 问题 | 状态（2026-08-19 晚 G2 解锁） |
|---|---|
| ~~token 权限边界（OAuth token vs `ck_` key 的端点可达矩阵）~~ | **已解（R-O5）** |
| ~~refresh 失效/轮换条件~~ | **已解（R-O6）** |
| **state 真实 TTL** | 仍未解：需用一个跨时 state 完成登录看是否仍可换 token（下次交互登录时可顺带验证——先创建 state、隔天再完成授权） |

### R-O5 token 权限边界：OAuth token 是 `ck_` key 的严格超集

证据：2026-08-19 真实 token 八组矩阵（matrix / quota4 两轮）。
- 五端点矩阵（accounts / config / dosage-notify / agenttool-search / chat）OAuth 与 `ck_` key **完全同可达**（P-T1/P-T2 预注册命中）；OAuth 下 chat 响应头同样零额度字段（P-T6 命中，R-Q1 认证不变）。
- **`/billing/meter/*` 计费路径族 OAuth-only**：get-user-resource 用 `ck_` key → 401 nginx 裸页（P-QP12）；用 OAuth Bearer → 200 code 0 数值额度（详见 quota-signals.md R-Q7）。
- 结论：数值额度能力绑定 OAuth 模式——插件 api-key 模式无法显示真实剩余额度（诚实标注的 UI 含义）。

### R-O6 refresh 轮换：**不互相作废**（实测推翻预注册）

证据：同上（--set refresh，真实 token，成功后已按 refreshOAuth 同逻辑回写 auth 文件）。
- P-RR1 HIT：真实 refresh → 200 code 0 + 新 accessToken/refreshToken，`expiresIn=5184000`（**60 天**），响应键集 `{accessToken,expiresIn,refreshExpiresIn,refreshToken,tokenType,notBeforePolicy,sessionState,scope,domain}`。
- P-RR2 **MISS 推翻**：旧 refresh token 复跑 **仍 200 code 0**（又签发一套新令牌）——refresh 轮换**不作废旧 refresh token**（至少在观测窗口内；长期作废条件未测）。
- P-RR3 HIT：旧 access token 在 refresh 后仍可用（/v2/accounts 200）——access 也不随 refresh 作废。
- 附带发现：响应字段名是 `refreshExpiresIn`（秒），插件 `refreshOAuth` 读的是 `refreshExpiresAt`——该字段永远 undefined（良性潜伏字段名 bug，无分支消费它；记录待修）。

## 6. 复跑路径

原始探测脚本（core 创建/轮询/bogus/并发/头/platform/refresh 形态、ttl +60s/+240s 阶梯、跨会话 state 复检、G2 真实 token 集合 matrix|quota|quota2..7|refresh）为开发期一次性工具，未纳入开源快照；本文结论自包含。
