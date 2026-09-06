# 规则 01：UA 校验（12403）

> 状态：**规则成立**（主路径）；宽松路径的出现条件**未解**（见 §6）
> 证据：2026-08-19 探测记录 74 条（含每轮预注册预测与 HIT/MISS 判定；开发期原始证据未纳入开源快照，结论自包含于本文）

## 1. 现象（上游咒语原文）

- AGENTS.md:22 —「`/agenttool/v1/search`、`/agenttool/v1/webfetch`：UA 必须是 CLI 形态（如 `CLI/unknown CodeBuddy/2.136.0`，`CodeBuddyCode/1.0` 被拒 12403）」
- README.md:159 —「`GET /v3/config`…UA 必须形如 `CLI/unknown CodeBuddy/2.136.0`，否则报 12403」
- index.js:551 —「/agenttool rejected the /v2 client UA with error 12403 ("check ua")」
- cordis.patch.yml:29 —「e.g. "CLI/unknown CodeBuddy/2.136.0" — the /v2 client UA is rejected with error 12403」

咒语形态：一个**必须逐字长这样的字符串**。本课题把它拆成了可证伪的字段规则。

## 2. 规则（每条附验证过程）

### R-A：/v3/config 的 UA 门 = 子串正则，不是全串比对

**规则**：UA 通过 ⟺ 其中包含匹配 `/codebuddy\/[^a-z\s]*\./i` 的子串——即 `codebuddy` 产品 token（**大小写不敏感**）后紧跟一段**不含 ASCII 字母、不含空格**且**至少含一个字面点号**的"版本"前缀；点号之后是什么不再检查；token 在 UA 中的位置不限。

**验证链**（全部实测，括号内为该轮 HIT/MISS）：

| 规则迭代 | 内容 | 结局 |
|---|---|---|
| H1 | 需要 `CodeBuddy/<semver>` token，其余装饰 | 被 `codebuddy/2.136.0`（小写通过）推翻 |
| R1 | 不区分大小写子串 `codebuddy/` | 被 `X/y CODEBUDDY/1`（12403）推翻 |
| R1′ | 白名单两种大小写 | 被 `Codebuddy/1.0`、`codeBuddy/1.0`、`CODEBUDDY/2.136.0` 全通过推翻 |
| R2/R3 | 版本长度 ≥2 / ≥3 | 被 `CodeBuddy/111`（3 字符仍 12403）、`CodeBuddy/abcd`（4 字符仍 12403）推翻 |
| R6 | 双正则析取（CLI 形 ∨ semver token） | 被 `CLI/unknown CodeBuddy/abcd`（12403）推翻 |
| R7/R8 | `/codebuddy\/\d+\.\d+/i` → `/codebuddy\/\d+\./i` | 被 `CodeBuddy/.5`（点前无数字仍通过）推翻 |
| R9/R10 | 首字符类 `[\d.]` / `[\d.-]` | 被 `-.5`、`+.5`、`_.5` 通过推翻 |
| **R11→R-A** | `/codebuddy\/[^a-z\s]*\./i` | **12 条预注册预测 11 条 HIT**（见下） |

R-A 的预注册预测命中记录（未观测行为 → 实测）：
- `CodeBuddy/.` → 200 **HIT**；`CodeBuddy/..` → 200 **HIT**（孤立点号即合法）
- `CodeBuddy/x.` → 12403 **HIT**（字母打头、点后无内容才构成拒因）
- `CodeBuddy/汉.5` → 不可测（HTTP 头为 ByteString，非 ASCII 无法发送，证据记 n/a）
- `CodeBuddy/ .` → 12403 **HIT**（空格断版本段）
- `CodeBuddy/ab.1`、`CodeBuddy/a1.2` → 12403 **HIT**（点前含字母即拒）
- `CodeBuddy/1.0` 控制 → 200 **HIT**
- `CodeBuddy/v1.2`、`CodeBuddy/1a.2`、`CodeBuddy/x.5`、`CodeBuddy/Z.9` → 12403（实测，反向锁定"点前禁字母"）

### R-B：触发 12403 的最小变异

**规则**：从现网 UA `CLI/unknown CodeBuddy/2.136.0` 出发，**单字符替换**第一个版本数字为任意 ASCII 字母（如 `CodeBuddy/x.136.0`）即触发 12403；没有任何单字符删除能触发（`2.136.0` 删首字符得 `.136.0` 仍合法，删一个点仍有另一个点）。校验器唯一检查的字段是 UA 中的 `codebuddy/<非字母非空格且含点>` token；`CLI/unknown` 前缀、`X-IDE-*`、`X-Product`、`X-Requested-With` 均不参与校验（`no-xproduct` 200；`ide-other`、`case-cli-lower`、`suffix-added` 全 200）。

拒绝面：`HTTP 400` + `{"code":12403,"msg":"check ua, get coding copilot version error"}`。

### R-C：端点作用域 —— 咒语的作用域是错的

- **`/v3/config`：有 UA 门**（本规则全部证据所在）。
- **`/v2/chat/completions`：无 UA 门**。真实字节证据：线上桥曾以 `user-agent: deepseek-harness/0.1.0-rc.6` 成功；探测补证 `Garbage/0.0` + `stream:true` → 200 SSE 流（`predict-chat-stream-garbage-ua` HIT）。
- **`/agenttool/v1/search`：当前无 UA 门**（api-key 认证下）。咒语称 `CodeBuddyCode/1.0` 在此被 12403，实测 `CodeBuddyCode/1.0`、`Garbage/0.0`、`CodeBuddy/ab` **全部 200 并返回搜索结果**（`predict-agenttool-*` 三条）。咒语描述的是历史行为或 OAuth 路径行为——本插件使用的 api-key 直调路径上该门不存在。

## 3. 对 CLIENT_HEADERS 的裁判（重构依据）

| 字段 | 判定 | 依据 |
|---|---|---|
| `User-Agent: CLI/unknown CodeBuddy/2.136.0` | **部分是规则**：仅需含 `codebuddy/` + 含点的非字母版本段；`CLI/unknown` 前缀与具体版本号**是迷信** | R-A 全部证据 |
| `X-IDE-Type/Name/Version`、`X-Product-Version` | **对校验是迷信**（是否参与遥测/路由 = 课题 3 待查） | `no-xproduct`、矩阵伴随头组 |
| `X-Product: SaaS` | 同上，/v3/config 不查 | `no-xproduct` 200 |
| `X-Requested-With` | /v3/config、/agenttool 均不查 | 矩阵未携带仍 200（探测脚本只发了 Accept/Auth/x-api-key/UA） |

## 4. 红线条目核对

- 咒语未入库：每条结论上方附验证链；"宽松路径"问不动 → §6 标未解。
- 真实字节基准：/v2 无 UA 门的结论以 `bridge-flash-ab-2026-08-18.jsonl` 抓包为基准；探测变异本身是受控实验而非对照基准。
- 低速率：74 次请求，间隔 1.5–2s，单账号，全部只读（chat 臂 `max_tokens=1`，search 臂 `max_results:1`）。

## 5. 现象 → 规则的可复跑路径

原始探测脚本（17 变异 + 2 chat 臂；predict1..12 逐轮预注册预测）为开发期一次性工具，未纳入开源快照；本文结论按轮次编号自包含。

## 6. 未解

- **宽松路径（flapping）**：严格规则之外，少数请求间歇放行非标版本（`CLI/unknown CodeBuddy/abc`、`CodeBuddy/a.1`、`CodeBuddy/abc` 各通过一次；`a.1` 复测 4/4 拒、`abc` 复测 2 拒 1 放）。放行条件（节点哈希 / 灰度 / 时间窗）未能从黑盒确定。工程结论：**按严格规则构造 UA，不把宽松路径当能力依赖**。
- 字母打头版本中 `a.1` 曾通过一次：若未来复现稳定，需重开本课题（脚本预测集可直接扩展）。
