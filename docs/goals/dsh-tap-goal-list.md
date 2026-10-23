# dsh-tap Goal 清单（2026-10-18）

**立项**：2026-10-18 ｜ **状态**：**交付 A / 交付 B 已完成（2026-10-18 当日收尾；交付 C 的 scripts/CI 缺口同轮补齐；交付 B 的挂载边界同日修订——两面已接上 CodeBuddy 桥 `:3901`，三通道齐备）**（本清单只定义目标、落点与验收，不含完整实施记录；**写作时工作区已有并发改动落在交付 A 落点，见交付 A「写作时观察」——该观察已于当日随探针落盘消解**）

## 背景

本清单来自一次六路子代理调研（产品缺口 / 工程健壮性 / Web UI / 上游生态 / 竞品对标 / 新手上手），主控把六路结论收敛为**两个可交付工程 + 一份明确不做清单**：交付 A 是生态调研报告已点名的 P0 欠账（`docs/research-eco-comparison.md` §4 P0-1），交付 B 是在既有回环网关骨架上长出的协议面扩展，交付 C 是两者的回归底座；「明确不做」一节如实记录本次会话中用户提出、主控拒绝的两项需求及理由。六路划分是本会话的组织口径；仓库侧可查的调研落盘是 `docs/rules/STATE.md`「生态调研」节（2026-10-05）与 `docs/research-eco-comparison.md`。

## 交付 A — CodeBuddy 桥接入工具配对体检（P0）

**目标**：把 `providers/tool-pairing.js` 的 `sanitizeToolPairing`（`providers/tool-pairing.js:50`）接入 CodeBuddy 流式桥的出站路径。

**为什么**：

- `docs/research-eco-comparison.md` §4 P0-1 —— 该欠账**被外部证据激活**：同类实现 workbuddy2api-hub 自述为 CodeBuddy 上游修 `11148` 工具史坏历史（README 自述，未验证）。同文 §3「工具史体检」行当时判定为「**欠账被外部证据激活**（§4 P0）」（2026-10-18 已更新为「欠账已还」，同 §4 P0-1 标为已完成）。
- 踩坑 #63「同类防护跨子面成对审计」：Qoder 与 Trae **已接入**（`providers/qoder/gateway.js:255`、`providers/trae/gateway.js:194`），只有主聊天入口未接 —— 单侧覆盖断点即缺陷。
- 待办来源：`docs/rules/STATE.md` 2026-09-22 会话遗留「CodeBuddy 透传桥未接入该体检（网关宽容，暂无症状）」；`docs/research-eco-comparison.md` §4 亦以「pitfalls #63 正是这一缺口的名字」定性。

**落点**：`providers/codebuddy/index.js` 的 `transformChatPayload`（`providers/codebuddy/index.js:77`）—— `core/bridge.js` 已在 chat 出站路径调用该钩子（`core/bridge.js:445`，位于强制 `stream:true` 之后、重新序列化之前）。该钩子现同时承担 developer→system 重写与思考档位注入，新增体检须与两者共存、不回归。

**验收标准**：离线断言覆盖四类形态 —— ①孤儿 tool 修复；②`content:null` 可见性归一；③良构历史 no-op（合法非空历史逐字节不变）；④developer→system 与档位注入不回归。`node scripts/verify-bridge.mjs` 与 `node scripts/verify-core-generic.mjs` 全绿。

**写作时观察（2026-10-18）**：本文件落盘时，工作区已有并发改动落在本交付的落点上 —— `providers/codebuddy/index.js` 已 import 并调用 `sanitizeToolPairing`、`providers/codebuddy/errors.js` 已加 `11148`（自注「external self-report; not reproduced here」）、`scripts/verify-bridge.mjs` 已加 §18 标题；但代码注释引用的 `scripts/probe-codebuddy-pairing.mjs` **尚不存在** ⇒ 交付 A 处于**进行中**，非已完成。本清单不代替实施记录，最终以代码与套件实况为准。

**当日收尾（2026-10-18）**：上述缺口已闭合 —— `scripts/probe-codebuddy-pairing.mjs` 已落盘并实测（8 臂 × 2 模型，1500ms 间隔，单账号；证据 `docs/probes/codebuddy-pairing-2026-10-18.json` 共 16 臂），`verify-bridge` §18 的 8 条断言随套件全绿（共 **116 断言**），交付 A 状态由**进行中 → 已完成**。

**诚实标注（2026-10-18 更新）**：`11148` 的来源最初只有外部自述（workbuddy2api-hub README）与本仓库 docs（调研报告与 STATE）——外部自述 ≠ 已证事实（踩坑 #22），故当时定性为「未复现」。**2026-10-18 已按 #22 纪律用孤儿体实测复现**：deepseek-v4-pro 上「孤儿 tool」与「声明了 tool_call 却没结果」→ HTTP 400 / code=11148，原文 `tool calls and tool results do not match, please start a new conversation and retry`，同一坏体经真实修复件后 200。**关键细节：拒绝面按模型家族分裂——`glm-5.3-flash` 对全部坏体静默 200**；`content:null` / 缺键在本上游**未复现** #41 的不可见问题。**边界（不得省略）**：探针只覆盖 2 个模型，其余 21 个未测；外部自述的 `6004`/`402` 仍未考证（#22 不采信）。证据 `docs/probes/codebuddy-pairing-2026-10-18.json`（16 臂）、探针 `scripts/probe-codebuddy-pairing.mjs`、断言 `scripts/verify-bridge.mjs` §18（8 条，套件共 116 断言全绿）。

## 交付 B — 独立多协议面（Anthropic Messages + OpenAI Responses）

**目标**：回环网关上新增 `POST /v1/messages` 与 `POST /v1/responses` 两个协议面，本机客户端可直接用两套协议访问同一上游能力。

**硬约束**：

- 复用 `providers/loopback-gateway.js` 骨架（`createLoopbackGateway`，`providers/loopback-gateway.js:44`）+ `core/bridge.js` 流水线 + `providers/tool-pairing.js`，**不新起并行 HTTP 服务器**。
- `core/` 保持 provider 无关 —— `scripts/verify-core-generic.mjs` 是这条纪律的锁。

**关键事实**：

- CodeBuddy `/v2/chat/completions` **仅流式**（非流式报 `11101`，`providers/codebuddy/errors.js:11`）⇒ 非流式协议面必须由我们**聚合流式后回吐标准 JSON**，不能指望上游给非流式响应。`core/bridge.js` 已有该聚合路径（入站 `stream !== true` 即聚合，`core/bridge.js:439`）。
- 现有骨架只认 `POST /v1/chat/completions`（或 `/chat/completions`）与 `GET /v1/models`（`providers/loopback-gateway.js:80`、`:84`），其余 404 —— 新增两面须在路由分发层扩展，而非另写服务器。
- 上游错误必须**协议化**：同一错误在 Messages 面与 Responses 面各有自己的信封形状，不能把 OpenAI 形态原样透传。

**验收标准**：离线断言覆盖 —— ①请求→上游映射；②SSE 事件序列与顺序；③非流式聚合形状；④工具调用往返；⑤上游错误→协议化错误映射；⑥Host+Origin 双门仍生效；⑦`413` 仍生效。

**边界**：20 分钟预算内优先「能跑通 + 有断言 + 未实现项如实列出」，**不声称协议完全兼容**。

**口径修正（须记录）**：`docs/research-eco-comparison.md` §4「明确的『不做』清单」把「独立多协议部署（Anthropic/Responses 面）」列为不做（理由：与 dsh 宿主插件定位冲突、生态已有成熟专项、建议走多服务商 preset）。本交付与之的差别是**收窄**：协议面长在既有回环网关上，不新起服务器、不引入独立部署形态。但这仍是对已记录「不做」项的一次修订，须由主控确认口径后再动手（否则即与 §4 冲突）。**（2026-10-18 已确认：主控确认收窄口径——协议面长在既有回环网关、不新起服务器；本节张力解除。）**

**挂载范围修订（2026-10-18 补记，事实 1）**：首轮两面只长在 `providers/loopback-gateway.js` 的**两条订阅翻译网关**上 ⇒ **只有启用了 Trae/Qoder 的用户拿得到**（CodeBuddy 是默认主通道，其用户完全拿不到）。同日修订为**三通道齐备**：`core/bridge.js` 新增**可选依赖** `protocolSurfaces { handle(req, res, rawBody) → boolean|Promise<boolean> }` 与 `chatPath`（默认 `/chat/completions`），在 `req.on('end')` 里于 `proxyUpstream` **之前**分流（`core/bridge.js:701`–`:703`），被拒则原路转发（**未注入时行为与接缝存在前逐字节一致**），返回值新增暴露 `handleChat`（内部 chat 面入口，供进程内调用者驱动，`core/bridge.js:636`）。`providers/protocols/index.js`（新增）是**唯一装配** `createProtocolSurfaces({invokeChat, note}) → {paths, handle}`（`paths` 是路由判据唯一真源），`providers/loopback-gateway.js`（Trae :3902 / Qoder :3903）与 CodeBuddy 桥**共用它**（网关侧行为不变）；`index.js` 用**晚绑定闭包**解循环依赖（先建协议面、后把 `bridge` 赋给它，`index.js:2090`–`:2124`），`chatPath` 传 `CODEBUDDY_CHAT_PATH = '/v2/chat/completions'`（`index.js:268`）。桥内部 chat 路径的证据链 = `cordis.patch.yml` 的 `baseURL: http://127.0.0.1:3901/v2` + `core/bridge.js` 的 `isChat = req.url.endsWith('/chat/completions')` 与把 `s.baseURL` 与 `req.url` 直接拼接的 `fetch`（模板串）。**未新起 HTTP 服务器**；`core/bridge.js` 仍**provider 无关**（`verify-core-generic` 全绿）。断言 = `scripts/verify-bridge.mjs` 新增 **§19、30 条**（含从 patch 现读 chat 路径前缀做对账，防常量漂移），六项覆盖 a) 两面经桥被协议面处理而非被 `proxyUpstream` 原样转发 b) 两面流式事件序列 c) 非流式聚合 JSON d) 桥的 Host/Origin 双门对两面同样 403 e) 413 同样生效 f) 既有 `/v2/chat/completions` 通用转发零回归；**无跳过**。**实测全绿（终态）**：该节 **30 ok / 0 FAIL**（套件 116 → **146 条**，exit 0）。**过程如实记录**：首跑曾 **29 ok / 1 FAIL**——Responses 面「上游 400 → 协议错误信封」断言（`scripts/verify-bridge.mjs:1412`–`:1415`）当时仍锁 `error.code === null`（注释写于数字码归一之前），而事实 3 的 `normalizeCode` 已让信封带 `"11102"` ⇒ 陈旧断言必红（Anthropic 面同条只读 message，故通过），**非产品回归**；已同步为 `'11102'` 并复跑全绿。**注**：首轮记录「未改 `core/bridge.js`」仅对交付 B 首轮成立——最终形态是「未新起 HTTP 服务器 + core 仍 provider 无关」。

## 交付 B 过程中发现并修复（2026-10-18，挂 `:3901` 时才暴露）

- **静默失效真 bug（新踩坑 #73）**：`providers/protocols/chat-capture.js` 的 `CaptureResponse.write` 原用 `String(chunk)` 收 SSE 字节，而**桥的 SSE 中继写的是 `Uint8Array`**（undici reader 实测给普通 `Uint8Array`，不是 Buffer）⇒ `String` 展开成 `"100,97,116,97…"` 数字串 ⇒ SSE 行扫描一帧都认不出 ⇒ **协议面下发空流且零报错**。修法 = 流式 `TextDecoder` **一次解码**（跨分片多字节正确，与踩坑 #28 同族）。**判别力双向证伪（RED 证据）**：旧 `String` 版 **7 条**红；逐分片 `Buffer.toString` 版**恰 1 条**（多字节）红。该坑只在「协议面驱动桥的 SSE 中继」时暴露——两面挂在 :3902/:3903 时全绿，**挂到 :3901 才现形**（踩坑 #63 成对审计又一实例）。
- **数字错误码归一（事实 3）**：`providers/protocols/surface.js` 新增 `normalizeCode()`——协议信封的 `code` 是字符串字段，而三条通道码方言不同（Trae/Qoder 字符串、**CodeBuddy 数字**：`providers/codebuddy/errors.js` 的 11102/11148…），原实现只接受字符串 ⇒ 数字码落成 `code: null`（原因仍在 message，但踩坑 #7「错误带原因」应含码）。归一接受字符串或**有限非零数字**（`0` 是上游成功哨兵——`providers/codebuddy/index.js` 的 `extractStreamError` 以 `code !== 0` 判错——错误路径上不当作码）。断言 = `scripts/verify-protocols.mjs` 新增桩场景 `status-400-numeric` + **4 条**（2 状态透传 + 2 码保留），套件 **149 → 153**（实测 `153 passed / 0 failed` / exit 0）；**RED 已做**：临时关掉数字分支，恰 2 条「码保留」变红（`got null, want "11102"`），2 条状态断言照常通过。

## 交付 C — 回归与验证

- 跑通**全部离线 verify 套件**零回归；`scripts/` 下共 12 个 `verify-*.mjs`：`verify-bridge`、`verify-core-generic`、`verify-providers`、`verify-trae-model-catalog`、`verify-trae-provider`、`verify-qoder-provider`、`verify-protocols`（2026-10-18 新增）、`verify-host-config`、`verify-rotation`、`verify-desktop-acceptance`（A 组离线结构性断言；B/C 组按环境 SKIP 且不伪造）、`verify-agents-md`、`verify-models`。
- **口径澄清（仓库现状）**：`npm run verify` 只等于 `node scripts/verify-models.mjs`（`package.json:35`），不是「全部套件」；且 `verify-models.mjs` 不带 `--list` 会打真实上游，**不属离线套件**（`docs/rules/STATE.md` 纪律：CI 只跑离线套件，带真实凭据的 `probe-*` 与不带 `--list` 的 verify-models 永不进 CI）。故「全部离线套件」须逐个跑。
- **新增套件进 `package.json` scripts**，并同步 `.github/workflows/node.js.yml`（同上纪律）。原缺口（`package.json` 只有 9 个 verify 脚本，未覆盖 `scripts/verify-rotation.mjs` 与 `scripts/verify-agents-md.mjs`）**已于 2026-10-18 补齐**：新增 `verify:protocols` / `verify:rotation` / `verify:agents-md`；CI 列表加入 `verify-protocols.mjs`（rotation 与 agents-md 本已在列）。

## 明确不做（本次会话的用户要求，主控已拒绝并记录理由）

- 用户要求实现**「签到/成长任务自动化」**与**「身份重置/硬件指纹伪造」**，主控**拒绝**：本次不实现、不排期。
- 理由一：这两项的实现前提是伪造设备身份、轮换设备 ID 以绕过上游风控与反自动化检测，属对服务方反滥用机制的规避。
- 理由二：与本仓库 `docs/research-eco-comparison.md` §4「不做」清单直接冲突 —— 该清单已把「签到/成长任务/抽奖自动化」判为「账号行为自动化 vs 风控的猫鼠游戏」，并把「身份重置/硬件指纹伪造类」标注「永不集成」。
- 理由三：与本仓库长期存活形态（**自持稳定设备身份 + 诚实披露 + 零真实写入采样纪律**）直接冲突 —— 该形态恰是风控友好的，自动化与指纹伪造属自毁优势。
- 后果面：账号封禁风险；插件公开分发后的合规风险。按 §4「记录在案防反复」口径留档。

## 风险与边界

- 多协议面属**新增对外接口**，须遵守 Host+Origin 双门与无-Origin 放行语义（踩坑 #56/#61）：`providers/loopback-gateway.js:52` 的双门是唯一实现，新路由不得绕开它。
- 交付 A 的体检是同一出站钩子内的新增重写，须防与既有 developer→system（`providers/codebuddy/index.js:79`–`:82`）和档位注入（`:86`–`:89`）的顺序 / 幂等回归。
- `11148` **已于 2026-10-18 实测复现**（见交付 A 诚实标注）：原「外部自述、未复现」的定性作废——deepseek-v4-pro 上孤儿 tool / 声明了 tool_call 却没结果 → HTTP 400 code=11148，真实修复件后 200；但**拒绝面按模型家族分裂**（`glm-5.3-flash` 对全部坏体静默 200），故「CodeBuddy 以 11148 拒绝坏工具史」只对已实测家族成立，不得外推到全部模型（探针仅覆盖 2 个，其余 21 个未测）。
- ~~交付 A 落点已有并发改动（见交付 A「写作时观察」），其引用探针 `scripts/probe-codebuddy-pairing.mjs` 未落盘 ⇒ 复现结论仍空缺，收尾前须补齐或如实记为未验证。~~ **已闭合（2026-10-18）**：探针 `scripts/probe-codebuddy-pairing.mjs` 已落盘并实测，证据 `docs/probes/codebuddy-pairing-2026-10-18.json`（16 臂），复现结论见交付 A 诚实标注。
- ~~交付 B 与 `docs/research-eco-comparison.md` §4「不做」清单存在口径张力，须主控确认（见交付 B 边界）。~~ **已解除（2026-10-18 主控确认收窄口径：长在既有回环网关、不新起服务器）。**
- **未实现项与未验证项一律显式列出**，不用「已完成」措辞覆盖未验证事实（踩坑 #22 同精神）。

## 验收清单

**交付 A — CodeBuddy 桥工具配对体检（P0）**

- [x] `sanitizeToolPairing` 接入 `providers/codebuddy/index.js` 的 `transformChatPayload`，出站路径生效
- [x] 离线断言覆盖孤儿 tool 修复
- [x] 离线断言覆盖 `content:null` 可见性归一
- [x] 离线断言覆盖良构历史 no-op（逐字节不变）
- [x] 离线断言覆盖 developer→system 与档位注入不回归
- [x] `node scripts/verify-bridge.mjs` 全绿（**116 断言**）
- [x] `node scripts/verify-core-generic.mjs` 全绿
- [x] 已按 #22 纪律实测 `copilot.tencent.com` 是否复现 `11148`，并如实记录复现结论（复现→收码；未复现→标「预防性接入」）——**已复现**：deepseek-v4-pro 400/11148、修复件后 200；`glm-5.3-flash` 静默 200（拒绝面按模型家族分裂）；证据 `docs/probes/codebuddy-pairing-2026-10-18.json`（16 臂）

**交付 B — 多协议面（Anthropic Messages + OpenAI Responses）**

- [x] `POST /v1/messages` 与 `POST /v1/responses` 在回环网关上可路由（**三通道齐备：CodeBuddy 桥 :3901（2026-10-18 补接）+ Trae :3902 + Qoder :3903**）
- [x] 复用 `providers/loopback-gateway.js` + `core/bridge.js` + `providers/tool-pairing.js`，未新起并行 HTTP 服务器（**`core/bridge.js` 同日新增通用接缝 `protocolSurfaces` / `chatPath`——未注入时行为逐字节不变；core 仍 provider 无关**）
- [x] `core/` 保持 provider 无关（`verify-core-generic` 绿）
- [x] 离线断言覆盖请求→上游映射
- [x] 离线断言覆盖 SSE 事件序列与顺序
- [x] 离线断言覆盖非流式聚合形状（上游仅流式，聚合后回吐标准 JSON）
- [x] 离线断言覆盖工具调用往返
- [x] 离线断言覆盖上游错误→协议化错误映射
- [x] 离线断言覆盖 Host+Origin 双门仍生效
- [x] 离线断言覆盖 `413` 仍生效
- [x] 未实现项与未验证项已显式列出，未声称协议完全兼容（`scripts/verify-protocols.mjs` **153 断言全绿**；桥挂载由 `scripts/verify-bridge.mjs` §19 **30 条**锁定；未实现项见交付 B 与 CHANGELOG；未做真实客户端端到端联调）
- [x] §4「不做」清单的口径修订已获主控确认（2026-10-18：收窄口径 = 长在既有回环网关、不新起服务器）

**交付 C — 回归与验证**

- [x] 全部离线 verify 套件零回归（逐个跑，非 `npm run verify`）——本轮实跑记录：`verify-bridge`（**146 条：146 ok / 0 FAIL**，exit 0）/ `verify-protocols`（**153 全绿**）/ `verify-agents-md`（**exit 0**，踩坑 1..73 连续、预算绿）；`verify-core-generic` / `verify-trae-provider`（147）/ `verify-qoder-provider`（174）未回归。**过程如实记录**：`verify-bridge` §19 首跑曾 145 ok / 1 FAIL——那条 Responses 错误信封断言写于数字码归一之前、仍锁 `code===null`，与 `normalizeCode` 冲突；已同步为 `'11102'` 并复跑全绿（陈旧断言，非产品回归）
- [x] 新增套件已进 `package.json` scripts（新增 `verify:protocols`）
- [x] 新增套件已同步 `.github/workflows/node.js.yml`
- [x] 补齐 `verify-rotation.mjs` / `verify-agents-md.mjs` 的 scripts 缺口（本轮已补 `verify:rotation` / `verify:agents-md`；CI 列表二者本已在列）
