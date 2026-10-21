# 规则 06：内容/渠道审核 —— developer 角色与 system 指纹

> 状态：**规则成立**（只理解，不研究绕过；case 变体刻意不测，见 §4）
> 证据：`docs/probes/moderation-2026-08-19.jsonl`（6 条）+ 存量事件记录（CHANGELOG 0.7.4 / AGENTS.md:32 / 踩坑 #19）+ `docs/probes/codebuddy-channel-2026-10-21.json`（system 指纹闸门）
> 脚本：`scripts/probe-moderation.mjs`（`--set matrix|r2` 可复跑）+ `scripts/probe-codebuddy-channel.mjs`（2026-10-21 渠道指纹）

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

### R-M4 同一 11128 还有第二张脸：system 提示的精确句指纹（2026-10-21）

同一套"渠道校验层"除角色检查外，还会对 **system 消息里的精确句**做指纹拦截：

- **触发句**：`You are an AI agent powered by DeepSeek Harness.`（DSH 系统提示首句）→ `HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel","displayTips":"可能不是官方客户端发出的"}`（与 R-M2 的 500 形态不同，本轮是 400；共享 code 与"通道"话术）。
- **与 UA/headers/模型无关**：官方 UA `CLI/2.168.2 CodeBuddy/2.168.2` 无效；补 `X-Conversation-ID/Request-ID/Message-ID`（官方 CLI 会话头）无效；glm/hy/kimi/deepseek 多模型一致。
- **扫描面只有 system/developer**：同一句放进 user 消息 → 200。
- **整句判定，不是品牌词表**：去掉句号仍拒；单独 `DeepSeek Harness` 放行；只把 `DeepSeek Harness` 换成 `the host harness` → 200。
- **完整失败 payload 的 A/B**：system + 5 条上下文消息 + 40 个工具 + 历史原样 → 11128；只改 system 这一句 → 200 并出正文（hy3/kimi-k3 复数模型一致）。
- **层级**：仍在网关入口路由前（~200–350ms 返回、无 usage/credit），与 developer 角色拒绝同层不同触发器。

**修复**：`providers/codebuddy/channel-guard.js` 在 `transformChatPayload` 里改写 system/developer 的已知指纹（`powered by DeepSeek Harness` → `powered by the host harness`，语义等价）；只改上游出站字节，不动用户内容。桥把 400/11128 翻成 `codebuddy_channel_blocked` 可执行文案。回归 `verify-bridge [20]`（纯函数/system-user 边界/真实适配器/端到端捕获出站 body/其他 400 不误翻）。

**证据**：`docs/probes/codebuddy-channel-2026-10-21.json`（A 原样 11128 / B 改写 200 / C 放 user 200 / D 无句号 11128）；复跑 `node scripts/probe-codebuddy-channel.mjs`。**踩坑 #70**。

## 3. 回答课题：developer 被拒发生在哪一层

**网关入口的通道校验层**（路由前、计量前、模型无关、位置无关），规则 = messages 中含字面量 `role:"developer"` 即拒。当前拒绝形态 500/11128；历史形态 200/content_filter（2026-08-18）。插件桥的 developer→system 出站重写与门的语义兼容（网关对 system 指令语义等价，事件时已实证），维持不变。

## 4. 红线声明

- 本课题只定位层级与触发字段，**不研究绕过**。
- case 变体（`Developer`、带空格等）**刻意未测**：它们只具有规避价值而无理解价值，标"未测"并止步于此。
- 全部探测 6 次调用、2s 间隔、max_tokens=8；拒绝响应零计费。

## 5. 对重构的输入

- core 层不需要任何审核概念；developer→system 重写是 **CodeBuddy 适配器职责**（providers/codebuddy/），注释引用本文件与 verify-bridge 第 9 节。
- 11128 加入适配器错误映射表（与 14401/14407/11102/11103/12403 并列）：结构化透传 code/msg，不做文案匹配。
- R-M4 的 system 指纹改写同属适配器职责（`providers/codebuddy/channel-guard.js`），只改 system/developer 出站文本；桥对 400/11128 走 `describeUpstreamError` → `codebuddy_channel_blocked`，不把裸 JSON 丢给用户。

## 6. 复跑路径

```bash
node scripts/probe-moderation.mjs            # M0/P-M1/P-M3/P-M4
node scripts/probe-moderation.mjs --set r2   # P-M5（白名单判别）
node scripts/probe-codebuddy-channel.mjs     # R-M4：A 原样 11128 / B 改写 200 / C user 200 / D 无句号 11128
```
