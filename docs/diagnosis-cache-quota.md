# 诊断报告：后端重复提问与缓存命中/额度消耗

日期：2026-08-17 ｜ 环境：dsh 0.1.0-rc.6（web profile）+ dsh-codebuddy-plugin 0.6.0 ｜ 网关：copilot.tencent.com
方法：桥内新增取证日志（`CODEBUDDY_BRIDGE_LOG`，本文 §1.2）+ 受控流量 + 网关对照探测 + 83 个历史会话日志挖掘 + dsh rc.3↔rc.6 代码对比。
预算遵守：真实网关调用共 48 次（上限 50），探测 `max_tokens=16`，主聊天回答按 prompt 约束为 ≤20 token。

**原始数据**：桥取证日志、探测 JSONL、`~/.dsh/sessions/**/session.jsonl.zstd`（会话事件）均为开发期原始证据，未纳入开源快照；本文结论自包含。

## TL;DR

1. **"同一提问多次出现在后端"的主因不是 bug，是 agent 架构**：每个工具循环 step 都重发全量历史（历史实测 3275 steps / 540 turns ≈ **6.1 次/turn**）；其上是标题生成（每会话 1 次、内嵌首问全文）与子代理派生（独立会话、全量历史）。dsh-llm-retry 重试机制存在且请求体逐字节相同，但 codebuddy 路径 83 会话 0 实例。
2. **网关缓存是按内容寻址的自动前缀缓存，与会话头/prompt_cache_key 无关**——对照实验全等价。**但按模型分策略：deepseek-v4-pro 缓存工作，deepseek-v3 在 ≤16.3k tokens 全部 0 命中**。插件默认模型是 deepseek-v3——"缓存命中率下降"的首要解释。
3. **额度（credit）实测**：v4-pro 未命中 ≈0.26 credit/1k tokens，命中 ≈0.011（约 1/24）；v3 ≈0.03/1k 且无缓存折扣。一轮 15.8k token 的 turn：全 miss 4.08 credit vs 全命中 0.17。
4. **v0.7"请求指纹→稳定会话映射"对缓存恢复无收益**（缓存本就不靠会话亲和），不建议以此为目标立项；杠杆在模型选择。

---

## 1. 重复提问甄别

### 1.1 全局事实：dsh 对 LLM 的出站调用点只有 3 处

全量 grep `llm.stream(` 证实（/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/ 下）：

- `dsh-agent-loop/lib/index.js:616` — 主循环 step（含重试重发）
- `dsh-session-title-llm/lib/index.js:228` — 会话标题
- `dsh-compaction-basic/lib/index.js:301` — 压缩摘要

主循环每个 step 调 `session.deriveMessages()` 重发**全量历史**（`dsh-agent-loop/lib/index.js:613`；投影规则 `dsh-session/lib/index.js:278-287`）。历史 83 会话实测：3275 step / 540 turn ≈ **6.1 次请求/用户 turn**——一次提问触发 N 个工具轮次，就有 N+1 次含该提问全文的请求。这是"后端多次相同提问"的最大来源，属架构行为而非异常。

### 1.2 取证手段：桥内请求日志（本次新增）

`index.js` 的桥在 `CODEBUDDY_BRIDGE_LOG=<path>` 时每请求落一条 JSONL：入站（头特征、body/消息/系统提示哈希、末条用户消息预览 60 字符、marker 分类）+ 出站（状态、排队/首字节/总耗时、上游 usage 含缓存计数）。不落消息明文；Authorization 只记 `sentinel`/`caller-set` 分类。回归锁在 `scripts/verify-bridge.mjs` 第 7 节。

marker 分类规则（对照 dsh 源码验证）：系统提示以 `Create a concise title for an AI coding-assistant session` 开头 → `session-title`（dsh-session-title-llm/lib/index.js:147-154）；末条 user 以 `You are now acting as a compaction engine` 开头 → `compaction`（dsh-compaction-basic/lib/index.js:218-253）。

### 1.3 受控流量捕获（/tmp/diag/bridge.jsonl）

受控流量经 dsh web RPC 驱动：会话 A 三轮短问答、会话 B 逐字重发 A 的首问、会话 C 要求派生子代理。10 个 chat 请求全记录（模型 deepseek-v4-pro，用户此前在设置页选定的模型）：

| seq | 间隔 | msgs | bytes | bodySha | marker | prompt_tokens | hit | miss | credit |
|-----|------|------|-------|---------|--------|-------|------|-------|--------|
| 1 | — | 2 | 665 | 7bb6f7b9 | session-title | 113 | 0 | 113 | 0.03 |
| 2 | +26ms | 5 | 64356 | 2da804c8 | — | 15807 | 0 | 15807 | 4.07 |
| 3 | +6.3s | 7 | 64432 | 1b02fc16 | — | 15820 | 4864 | 10956 | 2.88 |
| 4 | +3.8s | 9 | 64589 | 1bab4e0f | — | 15831 | 15744 | 87 | 0.16 |
| 5 | +3.0s | 5 | 64356 | **2da804c8** | — | 15807 | 15744 | 63 | 0.18 |
| 6 | +2ms | 2 | 665 | **7bb6f7b9** | session-title | 113 | 0 | 113 | 0.03 |
| 7 | +5.7s | 2 | 711 | e73a0bcb | session-title | 135 | 0 | 135 | 0.05 |
| 8 | +1ms | 5 | 64398 | 0e25a15d | — | 15829 | 4352 | 11477 | 3.19 |
| 9 | +6.1s | 5 | 64763 | 95b38492 | — | 15818 | **0** | 15818 | 4.08 |
| 10 | +3.0s | 7 | 65347 | 5dbfd366 | — | 15972 | 15744 | 228 | 0.27 |

注：seq1 比主请求 seq2 早 26ms 到达——标题调用在主请求路由确定后立即发出（dsh-session-title/lib/index.js:316-352）。

### 1.4 六类候选来源逐项结论

| 候选 | 结论 | 证据 |
|------|------|------|
| **dsh-llm-retry 重试** | 机制确认存在；**codebuddy 路径排除为观察期内来源** | 机制：默认 maxRetries=2、可重试码 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT、退避 500ms 起（dsh-llm/lib/index.js:356-366）；重试重建请求体**逐字节相同、线上无标记**（agent-loop 回到 buildRequest，失败 chunk 不投影进消息，dsh-session/lib/index.js:278-287；SDK 内重试 maxRetries=0，dsh-llm-pi-ai/lib/index.js:666）。实例：历史 83 会话仅 1 起 2 次，**在 qianwenai provider**（TRANSPORT "stream ended before terminal event"，session-5f800970 seq52-57）；codebuddy 路径 0 起；本次捕获 10 请求无任何相同 bodySha 的亚秒级重复 |
| **会话标题生成** | **确认** | 桥日志 seq1/6/7 marker=session-title：system+user 形状与 dsh-session-title-llm/lib/index.js:147-158 完全一致，maxTokens=64，模型同主聊天；每会话首条用户消息后 1 次（first-prompt 提供者）。**用户首问全文内嵌标题 prompt**（≤4096B），即在网关出现第二次。历史 75/83 会话有 title-llm-request。seq6 与 seq1 逐字节相同（跨会话同首问 → 同标题请求）。单次 0.03-0.05 credit |
| **压缩摘要** | 机制确认存在；低频，非当前重复主因 | 触发：≥80% contextWindow 自动（thresholdRatio，dsh-compaction-basic/lib/index.js:13）、CONTEXT_WINDOW_EXCEEDED 溢出、手动 /compact。请求=全量历史+压缩指令，每次压缩 1 次 LLM 调用（pre-step 路径最多 2 次，:71）。历史 2 起：手动 /compact 成功（10.4s）；自动触发一次因 glm-4.6 返回 400 失败（session-21f564ae）。本次捕获未触发（上下文远未及阈值） |
| **手动重发** | **确认** | 会话 B 首问与 A 首问逐字节相同（seq5 bodySha==seq2 的 2da804c8，间隔 3s）；第二次 99.6% 缓存命中，credit 4.07→0.18。同一文本的跨会话重发在网关侧就是一次完整新请求 |
| **子代理调用** | **确认** | 会话 C 经 subagent 工具派生子会话 83dd6d24（session 事件：`origin:"subagent"`、`parentSession:session-4c2e6533…`、delegationDepth:1）。桥日志 seq9=子会话首请求（5 msgs、与父**同系统提示** sysSha 879617fd、但 0 命中——15.8k tokens 全量重新计费 4.08 credit）；seq10=父会话 step2。子代理继承父 provider/model 但用独立会话（dsh-subagent/lib/index.js:779-792），其每个 step 同样全量重发 |
| **其他** | 见下 | ① **工具循环步**（最大放大器，见 §1.1，6.1 次/turn）；② goal 轮驱动/定时任务注入新 turn（dsh-goal-round-driver/lib/index.js:11-18、dsh-schedule/lib/index.js:825-835）：机制确认，历史 27 起 goal/change，本次未触发；③ dsh-time-context 每 step 追加时间戳消息：**默认 profile 未加载**（dsh-base/dsh-web-app/dsh-headless patch 均无），排除；④ dsh-repeat-tool-reminder 只改后续请求内容、不产生额外请求，排除 |

**附带风险提示**：默认可重试码含 `EMPTY_RESPONSE`——网关若返回 200 但空内容（如 content_filter 收尾），dsh 会静默重发同一请求体最多 2 次，桥上表现为"一模一样又问了一遍"。本次未观察到实例，列为隐患。

## 2. 缓存机制实测（受控探测）

### 2.1 缓存信号可观测性

网关 SSE 每 chunk 带 usage，末chunk含完整字段：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `prompt_cache_write_tokens` / `credit`（单次计费额度）。实测有效的命中字段是 `prompt_cache_hit_tokens`（= `prompt_tokens_details.cached_tokens`；Anthropic 方言字段恒 0）。**缓存行为可观测，无需依赖延迟推断。**

### 2.2 对照实验（同 payload 连发，各 arm 独立 nonce 防串扰）

| 实验 | 模型 | prompt tokens | 结果 |
|------|------|------|------|
| run1：anon/session/cachekey/session+cachekey ×3 | deepseek-v3 | ~883-958 | **12 次全 0 命中** |
| run2：同上 | deepseek-v3 | ~2611-2830 | **12 次全 0 命中** |
| run4：anon ×2 | deepseek-v3 | 16300 | **0 命中**（#2 仍 miss 16300） |
| run3：anon ×3、session ×3 | deepseek-v4-pro | 2684 | 两臂 #1 miss、#2/#3 均 hit 2560，**完全相同** |
| run5：anon ×2、session ×2 | deepseek-v4-pro | 15859 | 两臂 #2 均 hit 15744、credit 均 4.08→0.17，**完全相同** |

结论：

- **C1 缓存按内容寻址、自动生效**，不需要会话亲和头（openai 三头）也不需要 `prompt_cache_key`；两者对命中**零影响**（2.6k 与 15.8k 两档、anon/session 完全等价）。
- **C2 缓存策略按模型分**：deepseek-v4-pro 缓存工作（阈值 ≤2684 tokens，粒度 128 tokens——命中值皆为 128 倍数）；**deepseek-v3 在 883/2611/16300 tokens 三档全部 0 命中**——v3 路径上缓存对该账号不可用。插件默认模型 `agent-default-model` 恰为 deepseek-v3（cordis.patch.yml:266-269）。
- **C3 命中可用性在 15.8k 规模存在网关内部波动**：真实流量样本命中 0/4864/15744/15744/4352/0/15744（seq2-10），非单调；而受控连发（run5）第二次即稳定全命中——波动与并发/后端调度有关，**亲和头无法消除**（run5 对照）。
- 延迟信号与之一致但噪声大（v4-pro 15.8k：miss ttfb 2653ms vs hit 2453ms；2.6k 档 2313→1903ms），仅作旁证，不作结论依据。

### 2.3 dsh 主聊天出站画像（桥日志实证，seq2）

- 头：`user-agent: deepseek-harness/0.1.0-rc.6 (+…)`（dsh attribution 强制覆盖静态 UA）、`x-ide-*/x-product-version/x-requested-with/x-private-data`（patch 静态头）、`authorization: 哨兵`（桥替换为真实凭据）。**无任何会话亲和头（sessionIn=null）、无 prompt_cache_key**——dsh 内部虽每步设 `sessionId: session.id`（dsh-agent-loop/lib/index.js:734），但 pi-ai 的亲和开关被 dsh-llm-pi-ai 的 compat 白名单剥除（白名单仅 thinkingFormat/supportsReasoningEffort，dsh-llm-pi-ai/lib/index.js:1334-1337），永不上线。
- 体：`stream:true` + `stream_options.include_usage`、全量 messages、40 个工具、reasoning_effort=max、max_tokens=50000。系统提示 17589B（≈4.3k tokens）+ 工具为主体；**系统提示哈希跨会话/子代理恒定**（879617fd），前缀结构稳定。
- 放大系数：每 turn ≈ 6.1 次全量请求（§1.1）。

## 3. 额度消耗归因

### 3.1 credit 单价（实测拟合）

| 模型 | 未命中 | 命中 | 证据 |
|------|--------|------|------|
| deepseek-v4-pro | ≈0.26 credit/1k tok | ≈0.01 credit/1k tok（两组拟合 1/24–1/29） | 15859 tok 全 miss=4.08；15744 hit+115 miss=0.17（run5）；2684 档 0.70→0.06（run3）；15807 全 miss=4.07（seq2） |
| deepseek-v3 | ≈0.03 credit/1k tok | —（无缓存可用） | 883→0.03、2611→0.08、16300→0.47（run1/2/4） |

v4-pro 单价约为 v3 的 9 倍，但缓存命中部分再打 ~96% 折扣；v3 便宜但每轮全价。

### 3.2 全量上下文重发与额度页的关系

额度页消耗 = Σ credit（逐请求）。一轮 turn 的输入 ≈ 系统提示+工具（本机 ≈15.7k tokens）+ 累积历史；**每个 step 全量重发**（§1.1）。因此：

- 无缓存（v3，或命中失效时）：10-turn 会话输入成本随历史近似线性→累计近似二次增长。本机规模：每 turn ≈ 15.8k×6.1 steps×0.26/1k ≈ **25 credit/turn**（v4-pro 全 miss）。
- 稳命中（v4-pro）：同规模 hit 部分按 ~1/24 计价，seq4 实测整轮仅 0.16 credit（vs 全 miss 4.07）。
- dsh 侧记账与网关一致：session.list 投影 `tokenUsage` 累计值与桥日志逐数吻合（26763=15807+10956；20608=4864+15744），**dsh 无额外放大**。
- 标题/压缩/子代理为附加项：标题每会话 1 次约 0.03-0.05 credit；子代理首请求全量 miss（本次 4.08）。

## 4. 旧版 dsh 对比（rc.3 ↔ rc.6）

npm 拉取 @deepseek-ai/*@0.1.0-rc.3 逐包对比：请求路径上 6 个关键包中 5 个逐字节相同（dsh-agent-loop、dsh-llm-retry、dsh-time-context、dsh-session-title-llm、dsh-compaction-basic）；唯一差异在 dsh-llm-pi-ai：rc.6 对带思考开关的模型强制 `supportsDeveloperRole:false`（rc.6 lib/index.js:1080）——思考模型的系统提示角色由 rc.3 自动检测的 `developer` 改回 `system`。该差异一次性、版本内恒定，**不构成持续的缓存 miss 机制**。亲和头/prompt_cache_key/重试参数/压缩阈值/标题形状两版全同。**结论：排除"dsh 升级导致缓存命中率下降"**（逐包 diff，/tmp/dsh-old/）。

## 5. v0.7 可行性结论：桥内"请求指纹→稳定会话映射"

- **对缓存命中：收益 ≈ 0，不建议以此立项。** 缓存按内容寻址（C1），会话亲和头对命中零影响（run3/run5 对照，含 15.8k dsh 真实规模）。指纹映射无法恢复"本就不缺的东西"；观察到的命中波动（C3）是网关内部行为，亲和头不能消除。
- **输入可缓存占比**（若模型有缓存）：本机实测连续 turn 命中 15744/15807 = **99.6%**；下限为系统提示+工具 ≈4.3k+ tokens（命中波动时观察到的部分命中 4352/4864 即该量级）。可缓存性瓶颈不在 dsh 前缀稳定性（sysSha 恒定），而在**模型是否享受缓存策略**。
- 真正的杠杆（按收益排序）：① 默认/推荐模型切换到缓存可用的模型（v4-pro 实测命中折扣 ~24x；v3 无任何折扣）；② 命中波动属网关侧，插件不可控，但桥日志现已可长期观测命中率（`CODEBUDDY_BRIDGE_LOG`），可据此向网关方反馈；③ 指纹映射仅对 SessionLimiter 并发公平/网关会话分析有残余价值，不值得单独版本。

## 6. 不可观测边界（诚实声明）

- 网关**为什么** v3 不缓存、命中波动的后端原因（分片/复制/淘汰策略）不可从客户端观测；本文只断言可观测行为（usage 字段 + 对照实验）。
- 额度页本身的口径（credit 与页面数值的映射、日结/周期）未验证；本文 credit 全部取自响应 usage 字段实测。
- 标题/压缩请求是否享受缓存对总额度影响可忽略（≤135 tokens/次），未单独探测。
- 子代理首请求 0 命中观察到 1 次（seq9）；系统提示与父相同，miss 原因（新会话路由到冷后端 vs 其他）不可进一步区分，但其计费后果已实测。

## 7. 补遗（2026-08-18）：大上下文真实会话命中率劣化归因（"36%" 事件）

用户报告：同模型 v4-flash、high、极简模式，插件路径 25 步聚合命中 36%，DeepSeek 原生路径 90%+，且"没有做会话管理之前命中合理"。定位与结论如下。

### 7.1 用户会话复核

- 会话 f52c817f：codebuddy / deepseek-v4-flash / high，web 研究任务（web_fetch 大页面），25 步，**平均上下文 ≈55.5k tokens**，dsh 记录口径聚合命中 **34.7%**——即用户所见 36%。
- UI 口径（dsh-client-ui-conversation/lib/client.js:2777-2788）：`cacheHit% = ΣcacheRead / (Σuncached + ΣcacheRead + ΣcacheWrite)`，projection 来自 dsh-token-meter（uncachedInputTokens=usage.inputTokens）。两条路径记录口径一致，无插件侧记账差异。
- 逐步形态：cacheRead **吸附于历史快照尺寸**（7424 出现 3 次、32768=恰好 32k、34304、46336），coverage（cacheRead/上一步 prompt）在 21%→100%→20% 间非单调跳动；t1.13 coverage 100% 证明 46k 大前缀可写可读，下一步又回落到 12.4k 化石快照——**网关在 40k+ 规模对真实增长内容的缓存条目保留/驱逐不稳定**。

### 7.2 对照实验（v4-flash high、**直连网关不经插件**，2026-08-18 探测）

| 实验 | 条件 | 结果 |
|------|------|------|
| scale 连发 | 8k/16k/24k 同 prompt 各 4 发 | 复发 99.1–99.7%（阈值扫描另见 cache-flash-thresh：412 tok 起即缓存） |
| gap | 16k，间隔 20s×3 + 60s×1 | 全部 99.7%——TTL ≥60s 无影响 |
| grow | 20k→108k，+10k/轮，15s 间隔 | **coverage≈100%**，观测 hit% 与增长稀释上限逐点吻合（如 24011/35965=66.7% 实测 66.6%）；末轮原样重发 100% |

→ 网关**有能力**在 108k 规模全量缓存增长前缀；用户会话的劣化不由尺寸本身决定，取决于网关内部状态/内容/负载。同一现象此前已在 15.8k 档以直连探测记录（C3），本次把"波动"上限推进到 40k+ 真实内容。

### 7.3 插件链路无责（逐项排除）

- 桥逐字节透明（2.6k 档直连==经桥，命中一致）；usage 数字是网关 SSE 自报，链路无法改写。
- 会话管理（v0.5.5）对主聊天**不注入任何头**（dsh 出站无 session id，亲和开关被适配器剥除，§2.3）；SessionLimiter 只排队不动内容。"没有会话管理时命中合理"的印象与版本无关——v0.5.5 前后请求内容零变化。
- 受控 A/B（极简 preset、同任务、小上下文 2–4.5k）：插件 15 步 agg **92.3%** vs 原生 16 步 **97.3%**（dsh 记录口径）——插件路径在小中上下文健康。
- 用户的原生对照实为 **api.deepseek.com（另一套后端）且 avg ctx 仅 22k**，非同后端同规模；原生亦有 0 命中记录（85969bee，16k，[0,0]）。

### 7.4 实务建议

命中率的主导变量是**后端 × 上下文规模**：≤5k 各缓存模型稳定 95%+；codebuddy 网关 40k+ 真实增长内容当前不可靠（v4-flash 实测 agg 35%）；**v4-pro 在 99k 规模 215 步真实编码会话 agg 93.1%**（cbfaa68e）仍可用；glm-5.1/5.2 秒级失效、v3 恒 0。超大上下文且缓存敏感的场景优先 v4-pro 或 DeepSeek 官方 API。插件侧无可修项。

## 8. 补遗更正（2026-09-03）：§7 与 C3 的"网关侧不稳定"归因已被推翻

> 全量重判见 **docs/diagnosis-cache-decline.md**（证据链完整）。本节只记录对本报告结论的影响。

- §7.1/§7.4 与 §2.2 C3 的"网关内部波动 / 40k+ 真实内容条目保留不稳 / 吸附历史快照"**全部重判为桥缺陷**：`core/bridge.js` 用 `rawBody += c` 逐 TCP 分片隐式 utf8 解码，跨分片中文字符→3×U+FFFD 且损坏位置逐请求随机——出站前缀逐请求漂移，内容寻址缓存忠实地把损坏点当命中边界（hit 值与 dump 分叉字节数定量对应）。上述观察全部取自经桥流量，因此被污染；直连网关受控探测（24 发全 99.3%、16k/32k TTL ≥600s、增长前缀+空闲全命中）证明网关 v4-flash 缓存稳定。
- §7.2 的直连对照实验（合成内容 grow 至 108k ~100%）本身不经桥，结论不变；§7.3"桥逐字节透明（2.6k 档）"成立但**有边界**——单分片体透明，大体量中文体在分片切断多字节字符时不透明。
- §7.4"插件侧无可修项"**作废**：主修 = 桥 body 组装改 `Buffer.concat` 一次解码（见 diagnosis-cache-decline.md §6，含同型缺陷 3 处与回归用例建议）。
- §5"指纹映射无收益"结论不变（缓存按内容寻址的前提未被推翻，反而加强）。

## 附：复现

```sh
CODEBUDDY_BRIDGE_LOG=/tmp/diag/bridge.jsonl dsh web   # 开取证日志
# 受控流量：经 dsh web RPC 驱动多轮/重发会话（约 10 次小调用）
# 网关对照探测：anon / session / cachekey / session+cachekey 分组 × 连发（模型/重复可调）
node scripts/verify-bridge.mjs                         # 离线回归（含日志断言）
```
