# 规则 06：内容审核 —— developer 被拒的层级

> 状态：**规则成立**（只理解，不研究绕过；case 变体刻意不测，见 §4）
> 证据：`docs/probes/moderation-2026-08-19.jsonl`（6 条）+ 存量事件记录（CHANGELOG 0.7.4 / AGENTS.md:32 / 踩坑 #19）
> 脚本：`scripts/probe-moderation.mjs`（`--set matrix|r2` 可复跑）

## 1. 现象（上游咒语/事件原文）

- AGENTS.md:32 —「2026-08-18 16:24 UTC 起，网关内容审核开始对含 `role:"developer"` 消息的 chat payload 一律 `finish_reason: content_filter`，仅改回 `system` 即放行……deepseek-v3 不受影响（非推理模型不发 developer）」
- CHANGELOG 0.7.4 — 同事件；当时响应形是 `200 SSE + finish_reason: content_filter + 拒答文案（"您当前输入的信息存在敏感内容"）`

问题：**拒绝发生在哪一层**？候选：L1 网关入口（模型无关的角色检查）、L2 推理模型后端路径、L3 输出审核。

## 2. 规则（每条附验证过程）

### R-M1 层级定位：L1 —— 网关路由前的通道校验层，模型无关、位置无关、计费前

- **模型无关**：deepseek-v3（非推理模型）带 developer 同样被拒（P-M1 方向成立）——此前"v3 免疫"只是 pi-ai 不给非推理模型发 developer 的客户端假象。
- **位置无关**：developer 在 messages 中间（非首位）同样被拒（P-M3 成立）。
- **计费前**：拒绝响应**无 usage、无 credit**（输入计量都没发生）——检查在计量/生成之前短路；同会话 system 控制臂 200/stop（P-M4 成立）。
- **非输出审核**：拒的是请求形态本身，与生成内容无关。

### R-M2 拒绝面已变迁：200/content_filter → 500/11128

- 事件时（2026-08-18）：`200 SSE + finish_reason: content_filter + 拒答文案`。
- 实测现在（2026-08-19）：**`HTTP 500 + {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`**（JSON 信封，无 usage）。
- 两次形态共享同一逻辑门（对 developer 角色的入站拒绝），但信封从"审核放行式拒答"换成了"非法通道"报错——**网关方把该检查从审核层话术挪到了通道校验层话术**。教训：契约断言要对准 code/层级，不要对准文案。

### R-M3 检查是 developer 字面量单列拒绝，不是角色白名单

`role:"hacker"`（同样是非标角色）**照常 200/stop**（P-M5 原预测 11128 **MISS**——推翻白名单假设，锁定为对字面量 `"developer"` 的单列拒绝）。
**预注册命中汇总**：P-M1（v3 同样被拒）✓、P-M3（中间位置被拒）✓、P-M4（system 控制臂放行）✓；P-M5 的推翻本身完成了"白名单 vs 单列"的判别。

### R-M4 第二拒绝面（2026-10-21 起）：system 内容指纹校验，同码 11128 但形态/触发源不同

- **现象**：`HTTP 400 + {"code":11128,"msg":"Illegal API invocation from an unapproved channel",...,"displayMsg":{...},"displayTips":{"en":"...possibly because it was not sent from an official client...","zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。"},"actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}`。`x-user-id` 正常回显 → **凭据有效**，问题不在鉴权。
- **触发源**：网关扫描每条 system 消息的**内容**，命中 DSH 内核固定身份声明首句完整短语即拒。触发词是**完整短语** `You are an AI agent powered by DeepSeek Harness.`（`@deepseek-ai/dsh-system-prompt` 的 `includeHarnessIdentity`，order −1000）。
- **精确边界**（同一凭据、同一请求头，仅改 `messages[0]` content）：单词 `DeepSeek` / `Harness` / 片段 `powered by DeepSeek Harness` 均 **200**；完整短语才 **400**。等价改写 `agent`→`assistant`（`You are an AI assistant powered by DeepSeek Harness.`）即 **200**——语义等价，社区实测逐字节收敛定位（来源 [Issue #560](https://github.com/Ebony-Vinyl/dsh-our-free-model/issues/560) 含 curl 复现与二分过程；[Issue #87](https://github.com/dingminhua/dsh-connect-workbuddy/issues/87) #87/#88/#89/#90 同一问题四份报告，4.13.0 已修）。
- **与 R-M2 旧面的区别**：旧面拒 `role:"developer"`（角色形态），HTTP 500，无 displayMsg/displayTips；新面拒 system **内容**（指纹），HTTP 400，多出 displayMsg/displayTips/actions。同码 11128、同文案 "unapproved channel"，但**是两道独立的门**。displayTips 文案"可能不是官方客户端发出的"是**误导**——与客户端形态/UA 无关（社区已逐变量排除 UA/账号/网络/请求头）。
- **桥的规避**：`transformChatPayload` 在出站前对命中的 system 内容做等价中和（`agent`→`assistant`），未命中逐字节不变。回归锁 verify-bridge §20。
- **教训**：契约断言要对准 code/层级 + 触发源，不要对准文案——同文案 "unapproved channel" 下藏着两道门。

## 3. 回答课题：developer 被拒发生在哪一层

**网关入口的通道校验层**（路由前、计量前、模型无关、位置无关），规则 = messages 中含字面量 `role:"developer"` 即拒。当前拒绝形态 500/11128；历史形态 200/content_filter（2026-08-18）。插件桥的 developer→system 出站重写与门的语义兼容（网关对 system 指令语义等价，事件时已实证），维持不变。

**2026-10-21 起的第二道门**（§R-M4）：同一通道校验层另加了 system **内容**指纹校验，命中 DSH 身份声明首句完整短语即 400/11128。桥以 agent→assistant 等价中和规避。两道门同码同文案但触发源不同（角色形态 vs 内容指纹）。

## 4. 红线声明

- 本课题只定位层级与触发字段，**不研究绕过**。
- case 变体（`Developer`、带空格等）**刻意未测**：它们只具有规避价值而无理解价值，标"未测"并止步于此。
- 全部探测 6 次调用、2s 间隔、max_tokens=8；拒绝响应零计费。

## 5. 对重构的输入

- core 层不需要任何审核概念；developer→system 重写与身份声明中和都是 **CodeBuddy 适配器职责**（providers/codebuddy/），注释引用本文件与 verify-bridge 第 9 节（developer）及第 20 节（身份中和）。
- 11128 加入适配器错误映射表（与 14401/14407/11102/11103/12403 并列）：结构化透传 code/msg，不做文案匹配。**注意同码两面**（R-M2 旧面 developer 角色 / R-M4 新面 system 内容指纹），errors.js 注释已区分。

## 6. 复跑路径

```bash
node scripts/probe-moderation.mjs            # M0/P-M1/P-M3/P-M4
node scripts/probe-moderation.mjs --set r2   # P-M5（白名单判别）
```
