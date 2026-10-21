# 诊断：Qoder CN 的 Qwen3.8-Flash（`qfmodel`）为什么在 Qoder 里能用、在 dsh 里不能用

> 结论日期 2026-09-22（Windows 侧 dsh-tap）。**一句话**：不是 dsh/插件的请求形态问题——`qfmodel` 的上游后端节点 `oa_qwen-plus-main` 在 **04:21:38–04:21:51 之间进入持久失败**，此后**任何客户端**（包括 Qoder 官方客户端自己的签名器/元数据/请求体/版本号）都拿不到正文；"在 Qoder 里能用"是**04:21:38 之前的旧印象**。
>
> 复测（幂等，节点恢复即翻绿）：`node scripts/probe-qoder-flash-confirm.mjs`

## 0. ⚠️ 2026-10-20 更正：根因不是"上游节点持久故障"，而是**缺归因信封**

上面的结论（"上游节点 `oa_qwen-plus-main` 持久失败、任何客户端都拿不到正文"）**已被 A/B 对照推翻**。复现（正确账号 `acct-A…`，`qfmodel`，同 prompt / max_tokens=8，各 3 次）：

| 请求形态 | 成功 | 失败 |
|---|---|---|
| **裸 OpenAI 体**（只有 model/messages/stream） | 0 / 3 | 3 / 3（`[FAIL]node:oa_qwen-plus-main msg:Execution failed: null`） |
| **补齐官方归因信封**（`request_id`/`request_set_id`/`chat_record_id`/`session_id`/`chat_task`/`chat_context`/`is_reply`/`source`/`version`/`agent_id`/`task_id`/`session_type`/`aliyun_user_type`/`model_config`/`business`） | **3 / 3** | 0 / 3 |

**即**：`oa_qwen-plus-main` 不是"对任何请求都抛 NPE 的死节点"，而是**裸请求（无归因信封）被路由到的降级/异常节点**；带信封即被正常路由，稳定出正文（实测响应 5156 字节、内容完整）。插件自 0.9.9 起出站**已带完整信封**，所以插件路径本身不受影响——**"在 dsh 里用不了"的现象来自裸体探针/裸体客户端，不是插件缺陷，也不是上游死了**。
**教训**：`probe-qoder-flash-confirm.mjs` 这类探针发的是裸体，它的红/绿**不能**用来判定 qfmodel 是否可用。要复测必须带信封。

---

## 1. 两条报错分别是什么

| 报错 | 归属 | 机制 |
|---|---|---|
| `{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}` | **上游侧**（Qoder 后端节点内部异常） | qfmodel 被路由到推理节点 `oa_qwen-plus-main`，该节点对任何请求抛 `Execution failed: null`（形似 Java 侧 NPE）；HTTP 仍是 200，错误藏在 SSE 信封的 body 里（"带内失败帧"） |
| `{"code":"provider_error","message":"Error in upstream response","request_id":"…","details":"{…\"Messages with role 'tool' must be a response to a preceding message with 'tool_calls'…}"}` | **宿主侧真 bug，插件已修**（踩坑 #41 为主因、#39 为次因） | 严格家族（dmodel/kmodel/mmodel）的配对校验器把 **`content` 为 `null`/缺键的消息当"不存在"**：宿主 pi-ai 对**每个纯工具轮**都发 `{role:'assistant',content:null,tool_calls:[…]}`（openai-completions.js:961），声明因此蒸发、其后的 `role:"tool"` 被判孤儿 → 400。次因：pi-ai 还会丢弃 `stopReason=error/aborted` 的 assistant 却保留其 tool 结果（#39），产出真孤儿。首版修复补的桩自己也是 `content:null`，所以"修完仍报同一条错"；0.9.9 起网关出站做可见性归一（null/缺键 → `''`）+ developer→system，实测四形态全部 400 → 200（证据 docs/probes/qoder-null-content-*.json） |

## 2. qfmodel：为什么能断定是上游侧（逐变量排除）

**基准**：最小合法体 = `{model:"qfmodel", stream:true, stream_options:{include_usage:true}, messages:[{role:"user",content:"只回复两个字：收到"}]}`，打 `POST gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation`（COSY 签名 + 加密 body）。**同一账号、同一线缆路径**，同批请求里 `qmodel_38max`（Qwen3.8-Max）与 `q37fmodel`（Qwen3.7-Flash）稳定出正文。

| # | 假设 | 判定 | 判别证据 |
|---|---|---|---|
| 1 | 模型 key 猜错 | **否** | Qoder 客户端自己的日志打印 `model_config={"key":"qfmodel","display_name":"Qwen3.8-Flash",…,"source":"system"}`——客户端发的就是 `qfmodel`；两处 bundle 内**零硬编码模型 key**（key 全部来自服务端目录）。11 个臆造 key 全部被静默改派 auto（响应 `model:"auto"` + `billable:false`，踩坑 #37）→ 只有 `qfmodel` 会打到真实节点 |
| 2 | 请求体字段差异 | **否** | 复刻客户端 agent 形态（system 提示 + 3~26 个工具 schema + `tool_choice` + `max_tokens` + `temperature`，899B vs 对照 904B）仍失败；另扫 `enable_thinking`/`reasoning_effort`/`scene`+`agent_id`/`stream:false`/`context_window`(1M·200K·1048576·驼峰)/`thinking_config`/空 messages——全部同样失败 |
| 3 | 头/客户端元数据差异 | **否** | 用**官方 `QoderContext` 类**（wasm 原实现）签同一 body，扫 9 组 clientMetadata（含与客户端 fallback 逐字节一致的组合）——全部同样失败；`Cosy-ClientType` 无论传 `'qoder'`/`5`/缺省，wasm 恒出 **`5`**（已在插件侧对齐，见 §4） |
| 4 | 版本闸门 / 静默降级 | **否** | 客户端 bundle 里 `minimal_version`/`minimalVersion`/`999.999.999` **零命中**（客户端从不读该字段，目录里的 `minimal_version:{vsc:"999.999.999"}` 是死数据）；把 `cosyVersion` 从 1.1.40 扫到 999.999.999，错误一字不变 → 服务端也没有版本闸门 |
| 5 | 节点本身坏了 | **是** | `oa_qwen-plus-main` **只被 qfmodel 指名**；同样的坏体（孤儿 tool）打到 `qmodel`/`qmodel_38max`/`q37fmodel` 分别回 70/52/162 个 chunk 的正文——Qwen 节点族活着，只有 Flash 的节点指派坏了 |
| + | 客户端有重试/降级 | **否** | 客户端 `contractMaxAttempts=3` 只覆盖传输层重试；三次都是 200，环内不换模型 |

**路由是头驱动的**（对将来排错有用）：`X-Model-Key: qfmodel` + body `model:"auto"` → 仍失败；`X-Model-Key: auto` + body `model:"qfmodel"` → **成功**。即服务端按 `X-Model-Key`（= `prepareChat` 传的 `modelKey`）选节点，body 里的 `model` 字段不决定路由。插件正是用 `prepareChat(..., {modelKey: model})` 生成该头，行为与官方一致。

## 3. 时间线（"在 Qoder 里能用"是被推翻的前提）

| 时刻（+08） | 事件 | 证据 |
|---|---|---|
| 09-18 / 09-19 | Flash 在 Qoder 客户端**真实可用**：客户端 transcript 里累计 **754 条** `qfmodel` assistant 消息（完整 agent 环：thinking + tool_use + 正文） | `docs/probes/qoder-qfmodel-client-timeline.txt` |
| **04:21:38** | 客户端最后一次成功：assistant 正文 `"你好！有什么需要帮忙的尽管说。…当前分支是 v0.8.3…"`（`runtime-config model=qfmodel`） | `~/.qoder-cn/projects/…/f3ec00b4-…jsonl` |
| **04:21:51** | **同一客户端**的下一次运行：`model_config{"key":"qfmodel"}` → POST 同一端点 → `status=200 duration=3322ms` → `model.response.completed … output_tokens=0`、**不写 assistant 消息**（即同一条带内失败） | 原始日志：`~/.qoder-cn/logs/runs/2026-09-22T04-21-51-583+08-00-q2evm7-p26840/qodercli.log`（本机，含会话数据不入库）；本次复核落盘 `docs/probes/qoder-qfmodel-final-confirm.json` |
| ~04:31 | dsh 侧首次复现同样报错（用户报障） | — |
| 04:33–05:12 | 本轮 13 次复测（差分矩阵 + 确认探针）**全部失败**，对照模型全绿 | `docs/probes/qoder-matrix-*.json`、`docs/probes/qoder-flash-confirm-*.json` |

→ 节点在 04:21:38–04:21:51 之间坏掉并持续。**用户"Qoder 里能用"的印象来自坏掉之前的体验**；坏掉之后官方客户端同样不能用（客户端表现为"回合结束但没有回复"，因为 HTTP 200，它不会弹错误）。

## 4. 插件侧本轮实际修了什么（都不改变"Flash 属上游故障"的结论）

1. **出站 tool 配对 + 可见性体检**（`providers/tool-pairing.js`，踩坑 #39 → #41）：第一版只修"孤儿 tool"，且在**容错家族 qmodel** 上验证 → 上线后同一条 `provider_error` 照旧。第二版（0.9.9）用单变量差分定出真因：严格家族的校验器把 `content:null`/缺键的消息**当不存在**，而宿主对每个纯工具轮都发 `content:null`，首版补的桩也是 `content:null`（修复自身即坏体）。修法 = 可见性归一（assistant/tool 的 null/缺键 content → `''`，桩用 `''`）+ 孤儿补桩 + 缺结果合成 + 重复结果丢弃，另加出站 developer→system 折叠。**修复前/后对比实测（真实 dmodel 上游，用当前代码起的临时网关）**：`A_call_content_null` / `B_orphan_plain` / `B_orphan_stub_null` / `C_tool_content_null` 四形态全部 400 → 200 出正文；`""`/文本/纯聊天对照行为不变。两个翻译网关（Qoder :3903、Trae :3902）共用该体检。复现与差分：`node scripts/probe-qoder-pairing.mjs --offline`（宿主真实序列化器，不花额度）、`node scripts/probe-qoder-null-content.mjs --models dmodel --gw-local`。
2. **带内失败帧上抛**（0.9.9 早前提交）：HTTP 200 里的业务错误不再被静默吞，流式给错误 chunk + `[DONE]`、非流式 502 `qoder_upstream_error` 带上游详情——这正是 Flash 故障的**可读表现**。
3. **`Cosy-ClientType` 头保真**：官方 wasm 恒出 `5`，插件旧值 `'qoder'` 会在所有请求上留下第三方客户端指纹；已改为 `5`（与模型可用性无关，两种值下 Flash 都失败）。

## 5. 未解与下一步

- **未解**：节点内部为什么失败（`Execution failed: null` 形似 Java NPE）、Flash 的节点指派是部署错误还是压根没上线、Qoder 是否另有 Flash 的服务端别名节点。三项都在服务端，客户端不可观测。
- **下一步**：节点恢复后跑 `node scripts/probe-qoder-flash-confirm.mjs`（3×Flash + 2×对照，自动落证据）；确认恢复再跑 `node scripts/probe-qoder-matrix.mjs --suite flash` 复核全矩阵。
- **不建议**：在网关目录里把 qfmodel 摘掉"避免选到坏模型"——目录是上游状态的实时镜像，摘除会把**临时**故障固化成配置（且节点恢复后需人工加回）；现有行为（选择器保留 + 可读 502 + 探测脚本可复核）更诚实。

## 6. 证据索引

| 文件 | 内容 |
|---|---|
| `docs/probes/qoder-matrix-1790022926057.json` | qfmodel 变量矩阵（baseline/effort/max_tokens/tools/多轮/source） |
| `docs/probes/qoder-matrix-1790023075879.json` | 模型家族 × 孤儿 tool 拒绝面（dmodel/kmodel/mmodel 400，auto/qmodel/gmodel 容忍） |
| `docs/probes/qoder-matrix-1790023159490.json` | 修复策略验证（孤儿补桩 / 缺结果合成 / 重复结果） |
| `docs/probes/qoder-flash-confirm-*.json` | 3×Flash + 2×对照 的当前状态确认（可反复跑） |
| `docs/probes/qoder-qfmodel-node-map.json` | 节点归属图 + 头驱动路由证明（`X-Model-Key` 决定路由） |
| `docs/probes/qoder-qfmodel-key-sweep.json` | 11 个候选 key 的静默改派对照 |
| `docs/probes/qoder-qfmodel-agentshape.json` | agent 形态 body 复刻对照 |
| `docs/probes/qoder-qfmodel-clientmeta-sweep.json` | 官方 `QoderContext` × 9 组 clientMetadata |
| `docs/probes/qoder-qfmodel-minimal-version-scan.txt` | 客户端 bundle 无 `minimal_version` 读取点 |
| `docs/probes/qoder-qfmodel-client-timeline.txt` | 客户端 754 条 Flash 消息 + 最后成功时刻（transcript 扫描产物，含时间戳与正文摘录） |
| `docs/probes/qoder-qfmodel-final-confirm.json` | 子探测复核（第一次确认 0/3，含原始 SSE 字节） |
