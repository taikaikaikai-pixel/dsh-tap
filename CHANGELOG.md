# Changelog

## 0.17.0 (2026-10-03)

- **风险清单全量核实与修复**（8 项高/中危 + 9 项低危逐条实锤后修复；新坑 **#57–#63**；离线九套件全绿）：
  - **高危 1 — Qoder COSY `decrypt()` ABI 调用错误**（cosy.js）：wasm 类型段实报 `decrypt_server_response` 为 retptr-first 三参（`(i32,i32,i32)→()`，与同文件 `generate_runtime_auth_fields` 同型），旧胶水只传 2 参——wasm 把结果槽写进输入串线性内存、ret 恒 `undefined`，`catch{}` 吞掉 ⇒ `rt.decrypt(任意输入)` 恒原样返回，catalog.js 的「Encode=1 密文兜底」实为死路（上游回密文即 `JSON.parse` SyntaxError，目录同步静默失败）。修复 = 栈槽协议：`sp=__wbindgen_add_to_stack_pointer(-16); decrypt_server_response(sp,ptr,len)`，读槽 `[rptr,rlen,eptr,elen]`，errLen 非零抛 `takeObject(eptr)`，成功 `getString` 后 `__wbindgen_export4` 还内存。实测修复后 plaintext 正确 round-trip、3 参栈槽调用能取到 wasm 真实输出槽。
  - **高危 2 — Qoder WASM 对象从不释放**（cosy.js）：导出表确有 `__wbg_requestresult_free`/`__wbg_qodercontext_free` 但胶水全文未调——每次 `prepareChat/Get/Signed` 泄漏一个 RequestResult（≈3KB/次，8 万次签名 +245MB），凭据轮换还泄漏旧 QoderContext，`global.gc()` 不回收（字节在 wasm 线性内存，V8 GC 管不着）。修复 = 双 free 纪律：RequestResult/QoderContext 加幂等 `free()`（`if(ptr) __wbg_*_free(ptr); ptr=0`），三个签名出口统一经 `drain()` 消费即释，`ensureContext` 轮换时先建后 free 旧上下文（失败保留旧上下文）。
  - **中危 3 — Qoder 网关双重 release**（qoder/gateway.js）：流内错误帧路径先显式 `release()` 再 `return`，finally 又 release 一次——并发上限被击穿（limit=4 实际变 6）。修复 = 删分支内显式 release，统一由 finally 兜。
  - **中危 4 — Trae 3003 回退内容重发**（trae/gateway.js）：遇 3003 换 chat_v3 在同一 HTTP 响应上从头再发，旧代码只挡 writeHead 重不挡内容重——首 attempt 的角色/排队/文本帧全部重复下发。修复 = 跨 attempt 维护「可见内容离手」信号 `streamStarted`，首个可见帧离手后置真，此后 3003 按终局错误下发不再回退；角色 chunk 延迟到首个可见帧随头发出（不能 attempt 开头预发，否则回退永远走不到）；响应头在进入 SSE 循环前先 writeHead（不算可见内容），避免 reroute 注释行抢在 writeHead 前落地炸「Cannot write headers after they are sent」。
  - **中危 5 — Trae 单事件多 tool_calls 只下发最后一个**（trae/gateway.js）：`out.toolCall` 在循环内被反复覆盖，`parallel_tool_calls` 在出站白名单里但并行调用静默丢帧。修复 = 改数组 `out.toolCalls` 逐个产出，消费端逐帧下发；verify-trae-provider 补「单事件多 tool_calls 全量下发」断言。
  - **中危 6 — Trae remote 传输无首字节护栏**（remote.js）：`openRemoteEvents` 的 fetch 无 signal（createSession 有 20s、stop 有 10s，唯独它没有），边缘「收下不回应」时请求永久挂起、并发槽不释放。修复 = 首字节护栏只约束「连上却不出响应头」窗口（AbortController + 手动计时，非 `AbortSignal.timeout`——后者会约束整条 SSE 长流把正常长会话误杀），响应头到达即解绑。
  - **中危 7 — 三本地网关无 Origin 校验**（qoder/gateway.js + trae/gateway.js + core/bridge.js）：只验 Host 头回环——恶意网页 `navigator.sendBeacon`（text/plain 免 CORS 预检、浏览器自动带正确 Host）即可驱动网关烧用户 Trae/Qoder/CodeBuddy 额度，响应读不到但副作用已发生。修复 = 补 Origin 门（index.js `localGuardFailure` 同口径）：浏览器跨站请求恒带 Origin，其 host:port 必须与 Host 完全一致才放行；**无 Origin 放行**（本机 fetch/curl 与剥 Origin 的壳转发均不带该头，Host 门仍把守回环，与 #56 同语义）。bridge.js 导出 `originMatchesHost` 供三处复用。
  - **中危 8 — 登出/刷新竞态复活已登出令牌**（trae/qoder/codebuddy 三 oauth 模块）：刷新落盘是 `writeAuth({...readAuth(), auth: next})` 读-改-写，与 logout 的整体覆写竞态——刷新在飞时点登出，刷新完成把令牌写回。修复 = 存储代际守卫：模块级 `storeGeneration`，logout 递增，refresh 启动记代际、落盘前比对，过期即丢弃结果（内存模型实测：守卫后 refresh 返 undefined、logout 后 store 保持空）。
  - **低危一批**：rotation.js 首字节超时被当「调用方取消」不冷却不故障转移——改用 bridge 的 `clientDisconnected` 标记区分，仅真客户端断开豁免冷却；qoder/trae 网关错误路径不取消上游 reader + 全文无 `res.on('close')` 客户端断开传播——qoder 网关补 reader cancel + close 传播（trae 经 `forEachSseEvent` 循环退出自然收尾）；qoder/trae 网关超 32MB 静默 `req.destroy()` 改答 413（与 core/bridge.js 同口径）；trae quota memoize 补单飞（并发 snapshot 共享在飞请求）+ `x-uid` 只在值非有限数字时丢弃（账号 uid 是字符串语义，不再误拦 `u-001` 这类合法值）；qoder `syncCatalog` 补单飞（并发共享在飞 Promise，与 codebuddy 侧口径对齐）；trae/qoder `resolveCredential` 的 expiresAt 缺失视为临期而非永不过期（有 refreshToken 时强制刷新，不再拿未知新鲜度凭据出门）。
  - **client.js 设置卡四项**：登出/删 Key 等 4 处 mutating POST 不查 `res.ok`（4xx/5xx 静默刷新用户误以为已退出/已删）——补齐 HTTP 错误分支；toggleModel 重建本地状态丢 `unroutable` 字段——拷贝清单补回，「不可路由」徽标与「可路由 M 个」计数不再失真；OAuth 弹窗被拦完全静默——`window.open` 返回 null 时 `setErr` 提示用户允许弹窗。
  - **回归**：`verify-models`（23 模型）/ `verify-bridge` / `verify-rotation` / `verify-core-generic` / `verify-providers` / `verify-trae-provider`（90 断言，含新增多 tool_calls）/ `verify-qoder-provider`（154 断言）/ `verify-host-config`（36）/ `verify-desktop-acceptance`（12 ok）/ `verify-agents-md` 全 PASS。

## 0.16.0 (2026-10-03)

- **桥端口按运行时宿主 profile 分流——desktop Qoder/Trae 独立监听 3913/3912，web 线 3902/3903 逐位不变**（goal `docs/goals/bridge-port-host-split.md` G3–G7 一轮落地；功能换代：端口按宿主分流；新坑 **#55**；机制证据 `docs/probes/port-split-2026-10-03.json`、共存端到端证据 `docs/probes/coexist-e2e-port-split-2026-10-03.json`）：
  - **机制**：共享文件层 `codebuddy-plugin.json` 被 web/desktop 两进程共读——分流端口**不持久化**（写进去两边读同一份仍撞），每进程按自身宿主信号现读现算。新增模块级归一函数 `resolveBridgePorts`（三端口有效值唯一出处）+ 信号源 `currentProfileDirName`（每次现读 `hostConfig.probe().documentPath` 的 profile 目录名，**永不缓存**——settings 服务经 ctx.inject 异步注入，缓存会把启动竞态烙成永久错分）。默认 profile（`web`）或信号不可用 → 偏移 0（= 既有行为逐位一致）；其余宿主 profile → trae/qoder +10（3902→3912、3903→3913）。CodeBuddy 桥 3901 本期不动（goal 边界）。
  - **「显式」判定收口**（踩坑 #55）：cordis 给 apply 的 entry config 恒含 `Config({})` 的 schema 默认端口（活 desktop 实测 entryPortKeys=`[bridgePort,traeBridgePort,traeChatTransport,qoderBridgePort]`）——entry ≠ 用户显式，若把 entry 无差别当显式，schema 默认会压过分流偏移（分流失效）。故：entry 端口值**偏离 schema 默认**才算显式（verify-* 套件随机空闲口 ≠ 默认 → 采信，否则桥绑 3901 撞真实实例）；文件层显式恒采信（设置卡 commit 才落键，含等于默认的值）；cordis 默认 entry 落回分流/文件层。
  - **listen/镜像同源**：镜像两函数（syncQoder/syncTraeModelsToDshSettings）从 `Config({...readFileLayer()})` 切到模块级出口 `effectiveSettingsFn`（apply 内赋值的 resolveNow）——listen 端口与镜像 baseURL 同源同一次解析，根除「listen 3913 镜像写 3903」双路径漂移。sync*Bridge / 设置卡回显零改动（只读 `s.<port>`）。
  - **web 位级不变承诺**：web 的 documentPath 目录名 = `web`（实测 `...\profiles\web\cordis.patch.yml`）→ shift=0 → 产出与今日逐位一致；信号不可用同。共享文件层实测无三端口键、零真实写入。
  - **设置卡观感语义**（写入 gateway-facts 免当 bug 报）：desktop 端口字段显示 3912/3913 但 `overridden()` 判 false（文件层无该键）→ 无「已覆盖」标记；删键/重置 = 回到分流值 391x 而非 3902——语义自洽。
  - **验收（G6）**：`node --check`；`verify-desktop-acceptance --structural` exit 0（§4a/§4b 零 desktop 字样 + 新增 §4a+ 收口加固断言全绿；B 组加 §4c/§4d desktop 镜像端口=3913/3912 断言、C 组补 §4e 活体补采 SKIP）；`verify-bridge`/`verify-rotation`/`verify-providers`/`verify-trae`/`verify-qoder`/`verify-host-config`/`verify-core-generic`/`verify-agents-md` 全 PASS。
  - **活体 G3/G4（机制）**：desktop Qoder 监听 3913（PID 28088，`running:true lastError:null`）、Trae 启用实测监听 3912、web 仍 3901/3903（PID 3400）——netstat 实证两实例各持各端口零 EADDRINUSE，诊断卡不再出现「另一实例代管」；desktop patch qoder 镜像 baseURL 重铺为 3913（`docs/probes/port-split-2026-10-03.json`）。
  - **活体 G5（共存端到端，`docs/probes/coexist-e2e-port-split-2026-10-03.json`）**：web(:3090) 与 desktop(:19387) 同跑各持各桥——①desktop 经 :3913 真实聊天 `qfmodel` 出正文「成功」`finish_reason=stop`（11 chunks / 1.354s）；②**桌面独立**：`taskkill` web 进程后 desktop Qoder :3913 仍自持、再聊出「独立」（CONTENT-OK），web 已死 CONNECTION-REFUSED；③web 重启后 :3903 自持可用（出「共存」），终态 netstat 3090/3901/3903→web 新 PID 12904、3913/19387→desktop 28088 未动。baseURL 对平：web patch qoder=`…:3903/v1`、desktop patch qoder=`…:3913/v1`；CodeBuddy 桥 3901 仍由 web 先占 desktop 借桥（goal 边界，与分流无关）。双实例 `traeEnabled=false`，3902/3912 未监听、Trae 独立性本期不适用如实标注。
  - **回退即 revert**：resolveNow 两行 + 归一函数 + 镜像两行切换，共享层无写入无残留；desktop patch 的 391x 镜像块由 sync* 以旧端口整块重铺自动修正。
  - **G7 文档收尾**：goal 文档状态转「已落地」、STATE.md goal 节同步、wiki/02 desktop 共存节与 wiki/08 端口总表补 3912/3913 分流口径、AGENTS.md 踩坑速查加 `#55`（守预算闸门，`verify-agents-md` 绿）、CHANGELOG 本节定稿 0.16.0。
- **真 GUI 实测补记（computer-use 首轮真实壳内操作，三个被探针漏掉的缺陷当场爆出并修复）**：
  - **壳内 POST 全 403（用户报障截图实爆）**：真实桌面壳点「重试监听」→「重试失败（HTTP 403）」。根因 = 壳 `forwardWebRequest`（asar main.js:7469-7474）转发时**剥掉 origin 头**（`["host","origin","cookie","sec-fetch-site"].delete`），而 `sameOrigin` 对 `origin===undefined` 恒拒 ⇒ **桌面壳内所有 POST（保存/重试监听/登录）自 0.15.0 起全是 403**——0.15.0 的「三连 200/200/403」是 curl 模拟（带 Origin 头直打），真壳请求从未实测。修复 = `sameOrigin` 放行无 Origin 的 POST（威胁模型：浏览器跨站 POST 恒带 Origin 不受影响；无 Origin = 壳转发/非浏览器客户端，回环 Host 门兜底；与 GET 侧 `localGuardFailure` 的无-Origin-放行语义自洽；非浏览器客户端本可伪造任意 Origin，此门对它们无约束力）。
  - **启动时序竞态实爆（评审预言命中）**：真实重启桌面后 desktop 解析回 **3903**（撞 web EADDRINUSE）——首轮 `sync*Bridge` listen 跑在 settings 服务注入前，`documentPath` 未就绪 → 信号 null → 落 default；探针验证时实例恰好时序对，真实重启必踩。修复 = `currentProfileDirName` 两级信号：① **process.argv 自证**（host 进程把 profile 目录作位置参数传入自身 argv，启动期可用零时序依赖）② documentPath 兜底。离线单测 desktop→`desktop` / web→`null` / 套件→`null`；活体重启后 3913 LISTENING（host 同进程）。
  - **CodeBuddy 头芯片补「·另一实例代管」**：0.15.1 只补了 Trae/Qoder 芯片，CodeBuddy 行（用户截图同款位置）漏了——同步补齐，`[B2]` 预言机 codebuddy 分支镜像同款逻辑。
  - **GUI 验收（computer-use，AX 树取证）**：壳内设置卡 `Qoder CN 运行中`（3913）、`CodeBuddy … 桥未监听 :3901·另一实例代管`（goal 边界内共享桥如实标注）、点「重试监听」无 403 横幅——壳内 POST 路径修复闭环。

## 0.15.1 (2026-10-03)

- **诊断口径修复：EADDRINUSE 共存不再报成故障**（用户报障：桌面 GUI 诊断卡显示 Qoder「网关未监听 :3903 / lastError EADDRINUSE」）。真因 = web 实例(:3090)先占 3901/3903、桌面网关退避让位、聊天路由先占方桥（凭据同源功能等价，desktop 端到端证据已实测）——功能正常，是诊断卡把良性 EADDRINUSE 报成了错。`lib/client.js` 沿用 CodeBuddy 桥 `:1391` 已有口径（"若占用者是另一个 dsh 实例，其桥仍会代管本实例流量"），补齐 Qoder/Trae 半边：头芯片未监听文案追加「·另一实例代管」（EADDRINUSE 专属）、Qoder/Trae 网关状态行带同款说明、「复制诊断」聚合文本同步——三处仅在 `lastError === "EADDRINUSE"` 严格等值时触发，`mock-eaddrinuse` 等其他失败文案不变。
- **回归**：`card-accordion.js` 新增 `[B6]`（4 断言：真 EADDRINUSE mock ⇒ 头芯片追加 + Qoder 网关行代管说明正向锁，踩坑 #50——此前套件无此锁，删掉追加照样全绿）；`[B2]` 状态行预言机同步镜像 client.js 的 EADDRINUSE 分支（逐字全等口径不变）。全套 **204 通过 / 0 失败**（基线 200 + [B6] 4），零真实写入 md5 对账一致（`c5cff30c…`）。

## 0.15.0 (2026-10-03)

- **desktop profile 接入落地**（goal `docs/goals/desktop-adaptation.md` G3–G7 一轮完成；实施实录见 goal 文档「实施实测」节与 STATE.md 同日节）：
  - **装载**：desktop 自带 CLI `plugin --profile desktop add <repo>` 一次到位——`dependencies.dsh-tap=link:` 与 `dsh.profile.bundles` 两落点自动写好，link 实落 `profiles/desktop/node_modules/`；`verify-desktop-acceptance.mjs` §1c FAIL→ok（**9 ok / 0 FAIL**），三手写块（volces / agent-default-model / ui-settings-account）与 2026-10-01 注释逐行原样（diff 备份实证）
  - **活体（0.2.0-rc.2 asar 内嵌宿主）**：`?probe=host-config` = `mode=forms` / `formsWritable=true` / `legacySettingsPath` 指向 `%USERPROFILE%\.dsh`（DSH_HOME 未漂移）⇒ **host-config.js 零改动**（能力探测选路自动命中，未写版本号分支）；凭据/桥端口与 web profile 全共享，web（:3090）与桌面实例并存、桥端口先占方持有（EADDRINUSE 落 lastError 不炸，聊天路由先占方桥）
  - **新坑 #54**：桌面组合树不合并 bundle patch 的 codebuddy 块，镜像只写 `providers.codebuddy.models` 子路径被 0.2.0 llm-pi-ai 校验拒（`needs an api` ⇒ mutate 回滚）——接入 = 往 desktop patch 手放完整 provider 块（web 用户层同构先例）；修复后 `lastError=null`、`providerIds=[volces,qoder,codebuddy]`
  - **Origin 门兜底**：`Origin: dsh-app://app` 的本地特权面请求实测 403（方案风险 3 命中）⇒ index.js 新增通用 `localAllowedOrigins` 配置字段（**默认空 = 行为不变**，零 desktop 字样，§4a/§4b 静态守卫保持绿）+ `localGuardFailure`/`sameOrigin` 两门消费（完整串精确匹配，Host 回环门不变）；desktop 侧文件层建议值 `["dsh-app://app"]`，落地后三连实测 200 / 200 / 陌生 Origin 403
  - **端到端**：CodeBuddy 桥 `glm-5.3-flash` 真实聊天 `content:"成功"` + `finish_reason:"stop"`；Qoder :3903 流式正文在途；Trae 按用户设置禁用未测
  - **回归**：离线九套件全绿（models 23 / host-config 36 / trae 89 / qoder 154 / desktop-acceptance / agents-md 预算…）+ `dsh-ui-test/` card-accordion **200** + qoder-slot-check **13** + qoder-tab-phase2 **11**，零真实写入 md5 对账一致；desktop patch 首启镜像写回前已备份（`cordis.patch.yml.pre-dsh-tap-20261003.bak`）
  - **活体验证收尾（段内补记，零代码改动；发版后 08:35 端到端探针，证据 `docs/probes/desktop-e2e-2026-10-03.json`）**：desktop 活实例四项全绿 `{"mounted":true,"cfg":true,"e2e":true,"verifyOk":true}`——①mounted：Electron 壳 + host :19387（0.2.0-rc.2 asar 内嵌）真实挂载；②cfg：§1c `?probe=host-config` 活实例全绿（`formsWritable=true`、`documentPath=…profiles\desktop\cordis.patch.yml`、`applies=live`、`providerIds=[volces,qoder,codebuddy]`，宿主对账 codebuddy 29/29 + qoder 14/14、`drift=[]`、web 钉选 ok）；③e2e：**双通道真实聊天 CONTENT-OK**——桥 :3901 `glm-5.3-flash` 与 Qoder :3903 `qfmodel` 首增量"成功"+`finish_reason=stop`（上条"Qoder 流式正文在途"就此闭合），Trae 按用户设置禁用如实标注不代开；④verifyOk：`verify-desktop-acceptance` = **9 ok / 0 FAIL / 3 SKIP**，验收 C 组 §1c/§2 由本探针补跑（§3 壳内设置卡回归仍未验）。共存纪律实证：web(:3090) 先占 3901+3903，desktop 桥 EADDRINUSE 让位不炸、聊天路由先占方桥；零真实写入 md5 跑前=跑后=`c5cff30c…`

## 0.14.0 (2026-09-27)

- **设置卡四族收敛：命中面 / 状态行可读性 / 保存播报 / Trae·Qoder 同构行抽组件**（纯 `lib/client.js` 前端 + 回归套件 +1 断言；新坑 **#53**）：
  - **命中面（WCAG 2.2 SC 2.5.8）**：区块头启用开关 16×16 → `label.cbc-checkhit` 包裹（`display:inline-flex;padding:4px;margin:-4px`），命中实测 31×30、开关 x 与行高逐像素不变（负 margin 对冲 padding，flex 里仍按 16px 占位）；input 自身 padding 被 Chrome `appearance:checkbox` 忽略且把框挪 7px（tmp-geom-probe.js padOnInput 证伪）。label 不对落在控件自身的 click 二次转发 ⇒ 不引入 #27 双 change（[C3]「恰 1 次 POST」在跑）。`card-accordion.js` 补命中面锁 1 条（退回裸 checkbox 即红；坐标锁锁不住这条——裸框与包裹态坐标逐像素相同）
  - **状态行可读性**：三段拼接此前整行灰、只出一个最差色点；warn/err 段现在自带色（`.cbc-seg-warn/err`，token 与 `.cbc-dot` 同名同值，深色主题自动跟随），点仍取最差（worstTone 不变）；分隔符是裸文本节点 " · "，`textContent` 与 `join(" · ")` 逐字全等——[B2] 预言机逐字全等断言不受影响
  - **保存播报（族3 收尾）**：「已保存 ✓」可见占位仍走 visibility 切换（宽度恒定契约是 P3-7 的依赖，不动），播报职责移到流外 sr-only `role=status`（`.cbc-srlive`，absolute 1px clip）：文本 "" ⇄ "已保存 ✓" 进出 DOM 才会被 live region 播报，且不参与 flex 布局——宽度契约零风险
  - **同构行抽组件**：`SyncBar`（三家模型组操作条）/ `SubModelRow`（Trae·Qoder 模型行外壳；Qoder 思考强度/上下文 select 走 Fragment extra）/ `ChannelLoginRow`（登录行外壳；Qoder 重开登录页/测一下走 extra），全部模块级定义（组件身份稳定防失焦纪律）；DOM 树与抽取前逐字节同形，套件按 .cbc-* 结构断言零改动
  - **验证**：`node --check`；`tmp-geom-probe.js` 两击 Δx=0、跨行 Δ=0、命中 31×30、cbX/行高不变；`card-accordion.js` 199 → **200 断言全绿**；`qoder-tab-phase2` 11 / `qoder-slot-check` 13 / `qoder-prefs-check` 37 复跑全绿。零真实写入：`~/.dsh/codebuddy-plugin.json` md5 跑前跑后恒为 `7127964e…`
- **设置卡「本机凭据」行只渲染可导入项**（纯 `lib/client.js` 渲染过滤，扫描器与 `credential-scan`/`credential-import` 路由保留）：此前行内罗列全部命中，而探测器里 4/5 结构性不可导入（登录态在 keyring/内存、凭据不可见、方言未接入——永远不会有按钮），唯一可导入的 Qwen OAuth 免费额度 2026-04-15 已停服——不可导入命中是无操作的纯解释文案，罗列即噪音。过滤后无可导入项时整行自动隐藏，将来新增可导入探测器自动出现。回归面：`card-accordion.js` 的 credential-scan mock 恒为 `findings: []`（[F1]/[F4] 只统计扫描调用次数与时机），断言零改动
- **docs：AGENTS.md 膨胀治理**（docs-only，零代码改动；新坑 **#52**）——184 行 / 34,323 B → **82 行 / 8,234 B**（预算 ≤150 行 / ≤12KB），任务态知识迁入项目 skill，体积与引用完整性由 linter 在 CI 锁死：
  - **分流瘦身**：项目定位压 3 行（沿革本就在 CHANGELOG）；三层架构表每格压成「文件 + 一句话职责 + 裁判文档链接」（host-config.js 职责补入 wiki/02——此前全仓只有 STATE.md 覆盖，两处 ≤0.1.6 时代的 settings.yaml 写路径口径同批修正）；网关事实速查 40 行压成 5 条通则 + gateway-facts.md 指针；踩坑速查 51 条长句压成「编号 + 标签」超短表（全本仍在 docs/pitfalls.md，纪律改为动手前 grep 编号）；常用命令留 top 12 无注释，probe 脚本用法注释迁 wiki/09（补 8 个 Qoder/CodeBuddy probe 行）
  - **任务态知识 skill 化**：浏览器回归大段落整体迁入 `.agents/skills/dsh-ui-regression/`（agentskills.io 规范 frontmatter，description 含触发词）；wiki/09 同名节改为指针，顺带消除 wiki 停留 129 而实际 197 的断言口径漂移
  - **CI 上锁**（.github/workflows/node.js.yml）：硬闸门 `agents-md lint --check --threshold 0 --max-lines 150 --max-bytes 12000 --fail-on-placeholder`（PyPI `agent-context-md`，支持手写 AGENTS.md；`--threshold 0` 因为质量评分面向英文模板结构、对中文薄索引恒 0 分——只用行数/字节/占位符硬闸门，评分不参与）+ `asamarts/alint@v0.16.1`（`agent-context@v1` 规则集：存在性/陈旧引用/stub/膨胀守卫，`.alint.yml`，github 注解 + fail-on-warning）；本地零依赖预算检查 `scripts/verify-agents-md.mjs`（行数/字节/引用路径存在 + 踩坑编号连续性对账）同入 CI
  - **新增** `/agents-md-audit` 斜杠命令（`.agents/commands/`）：定期对账 AGENTS.md 与构建/测试/CI 实况
  - 头注纪律同步更新：docs/pitfalls.md 与 docs/rules/gateway-facts.md 的「在 AGENTS.md 加一行」旧口径改为新分流规则

## 0.13.0 (2026-09-26)

- **设置卡 P3：打磨——冷启动引导 + 头部开关误触缓解**（goal 驱动，判定表 `docs/goals/settings-card-ux-redesign.md` §4；纯 `lib/client.js` 前端改动，后端契约零变化）
  - **P3-6 冷启动引导**（提交 `52ed8d5`）：首次被采纳的 GET 视图里三通道均无凭据（CodeBuddy 按 authMode 看 `oauth.signedIn`/`activeApiKey`，Trae/Qoder 看各自 `oauth.signedIn`）⇒ 自动展开 CodeBuddy 区块一次——`useRef` 守卫，同一挂载内只引导一次（用户手动收起后不被后续 load 撬开）、**不引入持久化状态**；任一通道有凭据即保持默认全收
  - **P3-7 头部开关误触缓解**（提交 `6ec82ba`，设计文档 §8 风险表首选方案）：Trae/Qoder 区块头启用开关**收起态**第一次点击只进确认态——0 POST、就地提示「再点一次确认启用/停用」（`.cbc-headconfirm`，warn 色）、受控 checkbox 弹回原态；4s 窗内第二次点击才落盘，超时自动复位（沿用 askConfirm 模式）。**展开态直切不确认**——用户正看着分区内容，误触面不同。回退方案「开关移入展开区第一行」不启用。title/aria-label 随确认态切换
  - **验证**：`card-accordion.js` 187 → **197 断言全绿**（新增 `[L1]`×8 冷启动引导：无凭据自动展开+其余三区仍收 / 手动收起+再次保存后不重复引导 / 有凭据对照默认全收 / 两 mock 通道无 pageerror 无告警；`[C3]` 重写为确认语义 ×7：收起态首击 0 POST+提示+弹回 / 4s 窗内二击恰 1 POST 且 patch 单字段 / 4s 超时自动复位 / 展开态直切恰 1 POST）。**RED 实测**：撤掉 P3-6 产品代码复跑，恰 `[L1]` 两条红、其余 193 全绿（`logs/card-accordion-p36-red.log`）；`[C3]` 首条断言与产品代码因果直连（无确认逻辑时首击即 POST ⇒ 必红）。`qoder-slot-check` 13 / `qoder-tab-phase2` 11 / `qoder-prefs-check` 37 复跑全绿（phase2 只读开关状态不点击，不受确认语义影响）；离线七套件 + `verify-models.mjs --list`（23 模型）复跑全绿。零真实写入：`~/.dsh/codebuddy-plugin.json` md5 跑前跑后恒为 `7127964e…`。**成本口径**：两项均零新增上游调用（确认态与引导判定都是纯客户端，数据来自既有 GET 视图）

## 0.12.0 (2026-09-26)

- **设置卡 P2：既有能力 UI 化——状态行就地动作 + 模型口径透明 + 凭据主动验证**（goal 驱动，判定表与落点 `docs/goals/settings-card-ux-redesign.md` §4；后端全部走既有 POST action 模式，脱敏纪律不破）
  - **P2-3 状态行可操作化**（提交 `a993be4`）：仅 warn/err 态的通道区块头尾部出两个就地动作，正常态零动作零噪音。**重试监听** = 新 POST action `gateway-retry`（channel 限定三通道；服务端 enabled 限定点重跑对应 `sync*`——wedge 自愈路径本身就是重试语义；禁用通道跳过，避免连带镜像撤铺写宿主层），客户端复用踩坑 #45 的退避补拉。**复制诊断** = 纯客户端从 GET 视图聚合 running/端口/lastError/最近同步时间写剪贴板（视图本就脱敏，零请求增量）。`BlockHead` 增 actions 槽（独立交互元素，不嵌套展开 button）
  - **P2-4 模型口径透明**（提交 `54f3668`）：`providers/codebuddy/catalog.js` 导出 `UNROUTABLE_MODELS`（id→原因，唯一真源；证据 = codebuddy-efforts-matrix-2026-09-22 六臂全 11102 + routing-2026-08-19；`hy4-preview-x` 2026-09-26 复核已离开目录，集合保留防重现）。model-list 响应带 `unroutable` 表、GET 视图 `models.sync` 增 `routable` 计数；同步行/列表底行口径「目录 N · 可路由 M」；死条目行置灰 +「不可路由」徽标（title 带原因），勾选框未启用时禁用（防加死模型）、已启用保留可勾掉（出清通道）——不改镜像/选择器行为，transparency only。实测对账：目录 31 · 可路由 28，glm-4.6v 在选且死、另两枚已禁用，两态皆有
  - **P2-5 凭据主动验证「测一下」**（提交 `d2d2228`）：新 POST action `credential-test`（channel=codebuddy|qoder）与 `provider-test`（id）；**验证结论即响应本体**（`available` 布尔，恒 200——验证失败不是路由故障）。CodeBuddy 走目录面 GET /v3/config（零额度消耗）；Qoder 走签名目录 GET（catalog 面 /algo，**非聊天面** `prepareInferRequest`）；key 型服务商走 `testExtraProvider`——与 refresh 同路径活解析 key、/models 或 probeChatKey 探针，只读不写块。三处落点就地显示「✓ 可用（目录 N 个模型）」/「✗ 具体错误」，不进全局横幅。实测：codebuddy ✓（目录 31）、qoder ✓（目录 14）、参数错误 400、未注册 provider available:false
  - **新坑 #51**：CDP `overridePermissions` 授 `clipboard-read` 会把同族 `clipboard-write` 一并显式 deny，之后连可信点击的瞬时激活都救不回 `writeText`（恒 NotAllowedError）；完全不授权反而正常。「复制诊断」的剪贴板断言因此 = 零授权 + `page.click` 可信点击 + writeText 间谍（`window.__clip`）读回（套件 [I1] 段注释锁定"别改回 overridePermissions"）
  - **验证**：`card-accordion.js` 160 → **187 断言全绿**（新增 `[I1]`×9 warn 头就地动作 / `[J1]`×8 目录·可路由口径与置灰 / `[K1]`×10 测一下三通道与参数错误；`mockInstaller` 的 responses 支持 action|channel 细分键）；`qoder-slot-check` 13 / `qoder-tab-phase2` 11 / `qoder-prefs-check` 37 复跑全绿；离线七套件（verify-bridge / rotation / core-generic / providers / trae / qoder / host-config）+ `verify-models.mjs --list`（23 模型）复跑全绿；真实实例 `gateway-retry` 三态实测（ok / 400 / disabled-skip）。零真实写入：`~/.dsh/codebuddy-plugin.json` md5 跑前跑后恒为 `7127964e…`。**成本口径**：「测一下」每次点击 = 一次真实上游只读（codebuddy 目录面零额度；qoder 签名目录只读；key 型为 /models 或 1-token 探针），不点不发；重试监听零上游调用（只重跑本地 listen）；复制诊断零请求

## 0.11.0 (2026-09-26)

- **设置卡 P1：补「看不见的事实」——宿主实况对账 + 跨通道余额落点**（goal 驱动，判定表与落点 `docs/goals/settings-card-ux-redesign.md` §4；两项全程只读，零真实写入纪律不破）
  - **宿主实况对账**（「通用」区块第三分区，数据 = GET 视图新增 `host` 字段，本分区自身不发请求）：①配置层模式行（forms/legacy + settings 服务在位性）；②三通道镜像对账——codebuddy 期望 = 有效清单长度、trae/qoder 期望 = 启用且已同步时的启用数（否则应为「无镜像」），实际 = `hostConfig` 读到的宿主配置层 provider 块模型数（块缺席 = null），不一致即漂移；③patch 条目对账——settings 命名空间条目（llm-pi-ai / agent-default-model）对 `describe` 的 allNamespaces 查存在性；④**web 钉选对账 = 效果级直查** web 服务实例的 `searchProviderId`/`fetchProviderId`（dsh-web 构造时把 config 钉选落实例字段，patch 行被跳过则 undefined——比命名空间在场更接近用户可感知事实）。漂移 ⇒ 所属区块头状态行尾部追加「宿主漂移」+ tone 只升不降；对账分区逐行落 warn。数据源全部运行时可得（host-config 读取 + 服务实例字段），**不跑 `dsh --dump-config`**（每次 GET 起子进程太重；id→模块名的权威映射仍是离线手册动作，HelpNote 注明）——这是踩坑 #43/#49 类静默失效（上游改模块名 ⇒ patch 条目整条跳过、退出码仍 0）在卡上的第一个可见出口
  - **跨通道余额**：Trae/Qoder 凭据组各加「余额」行，POST action `trae-quota` / `qoder-quota`（过既有本地门 + sameOrigin）。Trae 走 `POST {traeAuthBaseURL}/trae/api/v2/pay/ide_user_ent_usage`（`{require_usage:true, req_source:0}` 一次取全部包；按 `available_endpoint` 分 IDE/work 双池）；Qoder 走 `GET {qoderOpenapiBaseURL}/api/v2/quota/usage`（openapi 明文面裸 Bearer，**不走 COSY 签名**——签名是聊天/目录面的口径）。采样纪律沿用通用区块头口径：**不周期轮询**、展开/收起边界各采一次、登录态翻转重采、provider 内 60s memoize（`providers/trae/quota.js` / `providers/qoder/quota.js`，永不 throw）；取不到/未登录显示「—（原因）」，**绝不编造数值**。消耗账本保持跨通道单账（usage-meter 不动）
  - **新坑 #50**（重拍基线逐张看图抓到，断言全绿抓不到）：首版把 `allNamespaces` 当 patch 条目的全量预言机，而它只覆盖注册了 settings 命名空间的条目——健康的 `web` 钉选行永远缺席 ⇒「缺失：web」常驻假 warn。修为按条目性质双路预言机（见上④）；`[R1]` 的"warn 数 === drift 数"不变量只罩通道行、罩不住 entries 行，正是漏网路径
  - **验证**：`card-accordion.js` 129 → **160 断言全绿**（新增 `[R1]`×3 对账行与 host 字段逐字对齐 / `[R2]`×5 通道漂移就地 warn / `[R3]`×8 余额读数与采样纪律（展开恰采 1、收起再 +1、3s 不轮询）/ `[R4]`×6 未登录零请求 +「—（未登录）」不编造 / `[R5]`×7 web 钉选漂移：头部落点 + webpin 行带实际值 + 两路口径分离）；`qoder-slot-check` 13 / `qoder-tab-phase2` 11 / `qoder-prefs-check` 37 复跑全绿；离线七套件全绿；`shots-baseline` 10 张重拍 0 失败（逐张看图，宿主实况分区全绿点）。真实只读联调：`qoder-quota` 回真实 `addOnQuota` 读数、`trae-quota` 本机未登录如实回 `{error:"未登录"}`。md5 对账 `~/.dsh/codebuddy-plugin.json` 每轮跑前跑后一致（`7127964e…`）。**成本口径**：设置卡每次展开 trae/qoder 区块至多触发一次真实上游只读（各自的配额端点，60s memoize 收敛），对账分区零请求；零写入 ≠ 零上游只读（设计文档 §0 已知限制 e 同口径）
- **仓库基建收尾随本版出货**（原 Unreleased 段，无插件代码变更）：git 拓扑收敛（0.8.3–0.10.1 开发线经 merge（`6bd8f31`）回流默认分支 `main`（此前 `origin/main` 停在 v0.7.4 时代、落后 85 提交）；分支 `v0.8.3`（本地+远端）删除；补齐标签 `v0.7.4` / `v0.9.0`–`v0.10.1`（0.9.7/0.9.8 同提交 `240b48f`；0.8.x 的发布提交已被历史改写吞掉、无可打点，跳过）。repo 级提交身份切换为 `taikaikaikai-pixel` noreply 地址）；CI 修复（`.github/workflows/node.js.yml` 从 GitHub 模板默认值改为项目实况——Node 22 单档、`npm ci` + 八个离线 verify 脚本，原模板跑的 `npm test` 不存在；本地预跑 8/8 exit 0）；防复发纪律入文档（STATE.md「分支拓扑」节重写为单线单分支现状 + 三条纪律；AGENTS.md 维护纪律加 Git 一行）

## 0.10.1 (2026-09-26)

- **设置卡手风琴的终审/复审修复三连**（`79452a1` + `ef4d417` + `7326ac4`，均为 `lib/client.js` + 回归套件）：通用区块头收起时重采 + `load` 代次标记 + 吞错补因；保存后补拉链读最新采纳态 + 收起重采回归锁；退避链**启动点**同样改读最新采纳态（补上 R1 只改续跑点的对称缺口，消除 A2 自引入的假「未监听」停摆路径）+ 补 `[B5]` 常驻回归锁（兼作 A2 请求代次门的时序锁）。`card-accordion.js` 129 断言全绿。
- **README 重写**：三上游对照表、23 模型静态清单改为 `verify-models.mjs --list` 现跑口径（旧表停在 2026-08-16 的 18 条）、安装地址修正为 git remote 实际仓库、宿主配置层写入路径改为 `host-config.js` 选路口径（0.1.7+ profile patch / ≤0.1.6 settings.yaml）、补验证套件表与文档地图；`package.json` description 同步更新为三上游口径。
- **docs**：踩坑 #49 入本（上游模块改名让 profile patch 条目静默失效，dsh 0.1.7-rc.2 实录）；Qoder 用量计数器只读基线证据落盘。
- **杂项**：`.zcodeignore` 入库（ZCode 工具排除规则，防护段与 `.gitignore` 同源）。

## 0.10.0 (2026-09-23)

- **设置卡交互模型换代：8 标签页 → 4 区块通道手风琴**（驱动 = 用户"这个项目的前端页面的交互，有点麻烦。不够简单"；痛点定位轮结论 = **找不到、太散**；设计与逐条证据 `docs/goals/settings-card-ux-redesign.md`，实施计划 `docs/goals/settings-card-ux-redesign-plan.md`。**后端契约零变化**——GET/POST `/dsh-tap/settings` 的全部 action 与响应结构不动、槽位双注册不动；纯 `lib/client.js` 重写）
  - **顶层 4 区块、固定顺序、默认全收**：`BLOCK_DEFS` = CodeBuddy → TraeWork CN → Qoder CN → 通用；首屏即四条状态行（= 总览）。归类原则"谁提供归谁"（工具组只在 CodeBuddy——搜索/抓取/生图都走它的网关；两家订阅通道只有 凭据/模型/网关/高级）
  - **状态展示从三处收敛为单一真源**：删 0.9.11 的三层补偿机制（折叠态三芯片 / 展开态注意条 / 标签徽标 `tabBadge`）与整套 tablist（`role="tab"`、roving tabIndex、←/→ 方向键与相关断言）。区块头状态行直接沿用 `buildChips` 的判定口径与文案，`tone` = 该区块最差的一枚芯片（`worstTone`）⇒ **warn/err 就地出现在所属区块头**，不展开也读得到；旧槽（≤0.1.5）折叠态只留**按需单枚**「n 项需处理」芯片（`attentionCount`），全绿不出现
  - **展开才挂载、收起不卸载**：`openBlocks`/`mountedBlocks` 两张表 + `hidden`——草稿、滚动位置、已拉目录跨收起与保存保留（语义平移自原懒挂载纪律）；重活保持惰性（三家 model-list 在所属区块首次展开才拉）
  - **区块内五分组 + 工程项折叠**：`凭据 → 模型 → [工具] → 网关 → 高级`（标题类 `cbc-group-title`）；域名族 / `baseURL` / `qoderClientId` / 端口与超时等纯工程项收进 `details.cbc-adv`（summary「高级」），与 `details.cbc-help`（`HelpNote`「使用说明」）分工——两者都是原生 `<details>`、零 JS 状态。`PanelBoundary` 粒度从"每标签"改为**每分区**（模型组塌落不影响同区块的凭据组）
  - **三家模型组同构**：CodeBuddy 原「刷新列表 + 立即同步」两按钮合并为单按钮「同步目录」（一次点按顺序 `model-sync` → `model-list`，两侧失败原因仍分别可见）；操作条 `.cbc-syncbar` = 同步按钮 + 上次同步状态 + 筛选框同行，筛选谓词 `matchesModelFilter` 三家共享（只过滤渲染、不发请求）
  - **Trae/Qoder 启用开关上移到区块头**（收起态一眼可看可启停，展开区不再重复）；区块头是 `div.cbc-acc-head` + 两个**彼此独立**的交互元素（展开 `button.cbc-acc-toggle` 与右侧开关），不构成嵌套交互。键盘/ARIA：区块头是普通 button（`aria-expanded`，挂载后才给 `aria-controls`）
  - **通用区块头挂载取样**：「额度 / 服务商数」不在 GET 视图里 ⇒ 卡片挂载时各做一次 `action:'usage'` 与 `provider-list`（取到前显示 `额度 — · 服务商 —`）；**取样口径两句分明**（本条原写「一次性、不轮询」，那句被下游读成「永不更新」并据此拒掉一个真缺陷，终审改判 ⇒ 见下方 A1）：**① 不做周期轮询**（成本：头部四行常驻，定时打 usage 等于每次开卡多付一份上游额度只读）**② 「通用」区块由展开转收起时重采一次**（时效：头部是"状态单一真源"的载体，只采挂载那一刻会停在"打开页面那一瞬"的快照）；**api-key 模式不编数字**（`generalSummary` 三分支：OAuth 有值→真实周期余量、OAuth 声明了却读失败→`额度 —`、api-key→`额度 估算（累计 x）`）；用量 10s 轮询**严格随「通用」区块展开**启停；`credential-scan` **不上移**（扫本机文件，仍在通用区块首次挂载才做）
  - **保存反馈**落**触发该次保存的区块头**（`save(patch, blockId)` → `saved={block,at}`，「已保存 ✓」flash 常驻占位、`visibility` 切换，不挤压同行 checkbox）；0.9.11 的硬修复清单逐条迁移不丢：`settleGateways` 1s/2s/4s 退避补拉（踩坑 #45）、`fetchWithTimeout`、`pickComponent` 图标候选表（#44③）、幽灵输入双路径、同值去重 + 失败销账（#27/#32）、字段编辑器模块级定义、catch 带 `e.message`、Key 只回脱敏（#26）、失焦即保存
  - **两条反复（教训比结果值钱，如实记）**：① 键盘激活补丁 `48329a7` 加了又撤回 `4dd9f52`——起因是回归锁照 brief 用 `dispatchEvent` 派发**不可信** keydown，测出"区块头 Enter 不翻转"的 **harness 伪缺陷**，产品侧白白复制了一遍浏览器默认行为；改 `page.keyboard.press` 后当轮 115/115 绿 ⇒ 踩坑 **#46**。② 浅色主题下**未勾选的原生 checkbox/radio 呈深色实心块**（看着像已开启，而通道开关正处在区块头收起态第一眼位置）——宿主在 html/body 无条件声明 `color-scheme:dark` 且该属性不继承，插件零声明即跟随；由截图基线**人工看图**发现（断言全绿）、`a421d35` 把配色显式绑到宿主主题属性上 ⇒ 踩坑 **#47**（附带事实：`prefers-color-scheme` 媒体仿真对本宿主零效果，三种仿真截图 md5 互等）。另记 **#48**：`page.screenshot({fullPage:true})` 在本宿主是**空操作**（产出恒 1440×900；"尺寸对 ≠ 内容在"），截图基线因此改走元素句柄 + 逐张看图 + fit 机器核对
  - **回归资产换代**：`card-regression.js`（8 标签时代 28 断言）退役删除，存活断言逐条移植进 **`card-accordion.js`**（处置表落在套件头部注释，才是长期凭据）；其余五个脚本 + `shots-baseline.js` + `debug-inputs.js` 全换区块驱动；`shots/` 里 31 张误导性产物**移动**归档（不是删除，可逆）到 `shots/_archive-2026-09-23/`
  - **跨分支终审修复（0.10.0 段内补记，同版本代码改动；不新开版本号）**：终审判 **With fixes** = 0 Critical / 3 Important / 若干 Minor，本批把裁定的 3 条产品改动 + 5 条套件改动 + 5 条文档改动一次收完
    - **A1 通用区块头取样在「展开→收起」边界重采一次**（终审 Important 1）：取样体从 `deps: []` 的 effect 里抽成 `sampleGeneralHead()`，触发点 = ①挂载 ②`general` 由开转关那一刻（`useRef` 记前值 + deps `[!!openBlocks.general]`）。此前头部是**页面加载瞬间的快照**而它正下方的展开区每 10s 轮询 ⇒ 用户加/删服务商或聊了一小时后，"首屏即总览 / 区块头 = 状态单一真源"这一卖点自己会撒谎。**仍不做周期轮询**（成本）；Task 6 曾以"spec §3 明写一次性、不轮询"驳回同一发现，终审改判为**计划缺陷**（措辞把"不做周期请求"写成了"永不更新"），spec §3 已改成两句分明
    - **A2 `load()` 加请求代次标记**（终审 Important 2，踩坑 #45 的**另一半**）：`loadGenRef` 自增领号，回包时非最新代次整包丢弃，**失败分支同受此门约束**（陈旧请求的报错不该盖住新态）。根因：上一轮只补了"`listening` 事件异步翻转 ⇒ 采样时机"，漏了"并发 GET 乱序落地"——`save` 的 `.then` 必跟 `load()`，两次 POST 落在同一 GET 往返窗口（实测 ~1.0–1.3s）时先发后回的旧响应会覆掉新响应，UI 停在旧值且主视图无轮询自救；本轮"四区块可同时展开 + 每分区各持一个 `saveIn(block)`"让 1 秒内并发保存成为**正常操作路径**
    - **A3 `fetchTlist`/`fetchQlist` 的空 `catch` 补因**（终审 Minor，违踩坑 #7）：`/* 目录未同步等——分组不显示 */` 是全文件唯一真吞错，"拉取失败"与"确实没有目录"在 UI 上不可区分 ⇒ 走**该分区已有的**错误出口 `setErr`（`Trae/Qoder 模型目录读取失败：<e.message>`，兜底「（网络）」），不新增第三种错误展示层；`!res.ok`（目录未同步的**已知**空态）仍在上面正常 return，两种态保持可辨
    - **B1–B5 套件 117 → 118**（`dsh-ui-test/`，不进 git）：`[C2]` 由只读 trae 改 `["trae","qoder"].forEach`（终审 Important 3——缺 Qoder 半边时，有人在 `QoderSection` 恢复一行「启用通道」也全绿；**能红已实测**：临时加该行 ⇒ 恰 `[C2] qoder` 一条 FAIL、其余 117 全绿，撤销后 118/118）；`[B2]` 预言机由 `indexOf` 包含式改**全行等值**（parked 采纳，一行、严格更强、零新增脆弱性；三区块实测逐字等值成立）；`[H6]` 暗色基线改为**由套件建立前提**（属性缺席先 `setAttribute` 再读基线，宿主切浅色不再假红）；`acc-task4-groups.png` **改名** `acc-task4-groups-viewport.png` 并注明它是视口图（`fullPage` 本宿主是空操作，#48）+ 套件头写明视口分叉口径（本套件 1440×900 / `shots-baseline.js` 1440×3000，**不改**套件视口尺寸）；`[D1]` 与 `[F7]` 的"一级标题"谓词抽成共享 `firstLevelTitles`（消除两处选择器分叉，期望序列逐字未变）
    - **C1–C5 文档更正**：spec §3 取样措辞（不轮询 ≠ 永不更新）+ §3 硬修复清单补第 12 条「**写后读必须带请求代次**」+ §0 已知限制补「每次打开插件管理器多 **1 次上游额度只读**（`quotaSnapshot` 60s memoize）⇒ 零真实写入 ≠ 零额外上游调用」；`docs/pitfalls.md` **#45 末尾追加半句**（代次这一半，不新增编号以免与已发布的 #46/#47/#48 抢号）；`wiki/01-architecture.md` 模型镜像基清单 **18 → 23**（同批 `wiki/08` 已改的漏项）；`docs/rules/STATE.md` 待办①「八标签交互需实测一轮」**销账**（八标签已随 0.10.0 退役，挂着已完成的任务最害人）；`package.json` description 改为**不含模型条数**的措辞（避免下次目录换代再漂）
    - **终审残余修复 R1–R3（同段补记，第二批改动）**
      - **R1 `settleGateways` 的补拉链改读「最新采纳态」而非回调参数**：A2 的代次门让被更新的请求抢过时 `load()` 返回 `null`，而 `gatewayPending(null)` 恒假 ⇒ **补拉那一次只要被抢先（另一次保存、或分区经 `props.reload` 发起的 `load()`）退避链就地停摆**，踩坑 #45 的自愈保护被悄悄削弱（代价 = 假「未监听」永久驻留）。上一轮把这申报成"有意的行为变化"，控制方裁定**推翻**——"另一种写法恰好覆盖"不等于"链会自己走完"。修法 = `dataRef` 与 `loadGenRef` 同区、**只在采纳分支写**，补回调改判 `gatewayPending(dataRef.current)`
      - **R1 证据（一次性 mock 探针，跑完即删）**：让第 2 次 GET 迟到 3s，期间插一发**不 kick 新链**的 `reload()`（Trae「同步目录」）并被采纳 ⇒ 补拉包被作废。改前：`gets` 停在 **3**、区块头永久「网关未监听 :3902」、日志 `dsh-ui-test/logs/r1-probe-red.log`；改后：链照旧走完 1s/2s/4s 三轮、`gets=5`、GET **解析序** `1,3,2,4,5`（物证 #2 确被 #3 抢先）、最终采纳「运行中」，日志 `logs/r1-probe-green.log`
      - **R2 `[F9]` 收起边界重采的正向锁**（套件 118 → **119**）：A1 此前只有 `[F5]` 的"收起后不再轮询"反向锁，**删掉重采代码套件照样全绿**。新断言 = 收起前基线与收起点击**合进同一次 evaluate**（读计数与 click 之间不给 10s 周期轮询插队的机会），收起后 1.5s 的 `usage` 必须恰为 `preCollapse + 1`（0 = 重采被回退、≥2 = 轮询没停或采两遍）；`[F3]` 与 `[F5]` 两条"不做周期轮询"的锁一字未放宽。**RED 实测**：注掉 `lib/client.js:596` 的重采分支 ⇒ 恰 `[F9]` 一条红（`preCollapse:3 / usageBefore:3`）其余 118 全绿，恢复后 119/119（`logs/residual-r2-red.log` / `logs/residual-green.log`）
      - **R3 断言数同步**（上一轮报告自曝的残余，那三处不在其 `git add` 清单里）：`AGENTS.md`、`wiki/07-web-client.md`、`wiki/09-run-and-test.md`、`docs/rules/STATE.md`、`docs/goals/settings-card-ux-redesign.md` §0/§0 已知限制、`docs/goals/settings-card-ux-redesign-plan.md` 数字口径 → 统一 **119**，算式重写为「静态 `check(` 站点 116 + `[B2]` 循环多跑 2 + `[C2]` 循环多跑 1」；**保留**各处"117 → 118"的迁移记录（既成事实）。*（该数到复审修复轮再统一为 **129**，见下面「复审修复」条——各处"当时实况"按本项目口径不改写）*
      - 后端 `index.js` / `core/` / `providers/` / `scripts/` 本轮**零改动**；`lib/client.js` 净 +8/−2 行
    - **复审修复（第 1–5 条，同段补记，第三批改动）**——复审裁定 A/B/C/R 全部 ADDRESSED，未闭合的是一处**行为回归** + 一处**测试面债务**
      - **P1 `settleGateways` 的启动点仍读被 A2 作废的回调参数**：R1 只改了对称两点中的**续跑点**（退避回调），`save` 的 `.then` 那一处仍是 `gatewayPending(d)`。可追踪的停摆路径：保存返回 → 启动点发出本次 GET（实测往返 1.0–1.3s）→ 窗口内任一**非保存路径**触发 `load()`（卡片重开 / OAuth poll / 同步目录）→ 竞争包先回并被采纳（读到的还是 pre-listening 的 `running:false`）→ 本次包迟到被作废、返回 `null` → `gatewayPending(null)` 恒假 ⇒ **退避链一次都没启动**，症状与 #45 完全一致（假「未监听」常驻到用户收起再展开或再保存）。这是 **A2 自身引入的行为回退**（A2 之前成功路径永远返回 `d`，该站点不可能停摆），不是既有缺陷。修法 = 与续跑点对称改判 `dataRef.current`，并把"两个判定点都读最新采纳态"写进代次门那段注释
      - **P2 给这条路径补常驻回归锁 `[B5]`**（套件 119 → **129**）：R1 的证据只剩两份 prose 日志（一次性探针已删），复审独立核过现状**零锁**——`mockInstaller` 无 GET 延迟能力、`[B4]` 是单链无竞争场景 ⇒ 把那一行回退成 `d` 套件照样全绿。新能力：spec 加 `getDelay: {nth, ms}`（按单调 `seq` 计，不受 `post.resetGets` 影响）+ `getStaleMarker`（给被点名的那发 GET 打只有它带的水印）+ `getSettle.target`，mock 侧记 `order`/`times` ⇒ 乱序与迟到都是可断言事实。`[B5]` 场景：Trae 区块头 pre-listening「网关未监听 :3902」→ 头部开关保存（本次 GET 迟到 5s）→ 700ms 后点 Trae「同步目录」走 `props.reload()`（**非保存路径**的 `load()`）→ 断言①解析序 `1,3,2,4,5` 且 `gets===5` 且第二轮补拉按 2s 节奏、②终态区块头「运行中」（假未监听被自愈）、③迟到包独带的水印「模型 4242 个」始终不落进 DOM（**这条同时是 A2 代次门的锁**——该门至今无任何时序用例）
      - **RED 实测两段**：把 P1 那一行回退成 `gatewayPending(d)` ⇒ **127 通过 / 2 失败**，红点恰为 `[B5]` 的①②（`gets` 停在 3、头部永久「网关未监听 :3902」），其余 127 条含全部旧断言全绿（`logs/residual2-red.log`）；把 A2 的代次门短路成 `false` ⇒ **128 通过 / 1 失败**，红点恰为③（头部显出「模型 4242 个」）——两条 RED 各打一个靶子（`logs/residual2-red-gate.log`）
      - **P3 `[F9]` 注释去夸大**：原写"读与 click 合进同一次 evaluate 把窗口压到 React 提交那一拍"，实际只关掉了 **读→click** 的间隙，**click→1.5s 采样**之间照样可能被 10s 周期 tick 落进来（那就是 `preCollapse + 2` ⇒ 假红）；改为如实描述 + 记复审实测的相位余量 ~6.7s，并写明"要修的是 tick 的相位，不是放宽 `=== +1`"。**未**放宽 `[F9]` 等值判定、**未**动 `[F3]`/`[F5]`
      - **P4/P5 文档与报告自述**：`wiki/07` §交互 6 与 CHANGELOG 0.10.0 的取样条仍写「一次性、不轮询」（正是让 Task 6 拒掉真缺陷的那句，且与同文件"收起边界重采恰一次"自相矛盾）⇒ 改成与 spec §3 一致的两句分明口径；`plan.md` 的 §3 硬修复清单 **11 → 12 条**（C2 补的那条）并把两条锁的落点写清；`final-fix-report.md` 三处已失效自述就地加指针（"这是有意的"两处被 R1 推翻、探针"保留"已删），**原文保留不改**以凭判断演变
      - 本轮同样是 `lib/client.js` + 套件 + 文档，后端与 `scripts/` **零改动**（净 +8/−3 行）；离线套件未复跑（改动面与它们正交，不声称复跑）
  - **验证**：`card-accordion.js` **129 通过 / 0 失败 / exit 0**（静态 `check(` 站点 126 + `[B2]` 的 forEach 多跑 2 次 + `[C2]` 的 forEach 多跑 1 次；四段口径——迁移期 117、跨分支终审轮 118、残余修复轮补 `[F9]` 后 119、复审修复轮补 `[B5]`（10 条）后 **129**。A1 落地后 `[F1]/[F3]/[F4]/[F5]` 四条时序断言逐条复跑未破，收起边界的重采另有 `[F9]` 正向锁 + 一次性线缆探针双物证；踩坑 #45 现在两枚锁 `[B4]`+`[B5]`，`[B5]` 同时锁 A2 请求代次门，两段 RED（回退启动点 / 关掉代次门）各自实测能红）；`qoder-slot-check.js` **13/13**；`qoder-tab-phase2.js` **11/11**；`qoder-prefs-check.js` **37 通过 / 0 失败 / 跳过 0**（静态 39 站点，2 条在未触发分支；该脚本真实写盘，基线从实况读 + 收尾复原到实况）；`qoder-e2e.js` 8 断言**未跑**（会真实发消息消耗用户额度，控制方裁定跳过）；`shots-baseline.js` **10 张元素级基线**（明/暗 × 总览 + 四区块）0 处失败（实测尺寸 960×275 / 926×1371 / 926×423 / 926×622 / 926×1157，逐张人工看过）；`debug-inputs.js` 实跑 exit 0。**零真实写入纪律**：`~/.dsh/codebuddy-plugin.json` 的 md5 在每轮跑前/跑后恒为 `7127964e84619be3ef21ea371516f575`。测试实例为用户 launcher 托管的 `:3090`（本流程未启停 dsh、未占端口）。**离线七套件全绿（退出码全 0，2026-09-23 复跑）**：`verify:bridge`（107 个 ok 行，末行 `all bridge checks passed`）/ `verify:core`（末行 `core/ generality proven…`，27 ok）/ `verify:providers`（末行 `all green`）/ `verify:trae-provider` **89** / `verify:qoder` **154** / `verify:host-config` **36** / `verify-models.mjs --list`（**23 模型**）；另跑 `verify:rotation`（24 ok）亦绿。**`npm run verify`（在线 18 模型真实探测）本轮未跑**：它会向网关发 18 次真实请求消耗用户额度，而本轮是纯前端改动、离线七套件已覆盖"误改宿主半"的风险——按裁定跳过，**不声称通过**

## 0.9.11 (2026-09-23)

- **设置卡前端刷新（轮 1：简洁/健壮/信息展示/美观/功能）**：基线截图（dsh-ui-test `shots-baseline.js`，8 标签全拍）→ 逐条改 → 复拍对照 → `qoder-slot-check.js` 10/10 回归绿
  - **状态条改"注意条"**：原展开态常驻 7 枚芯片与标签徽标完全重复 → 只浮出 warn/err 需处理态（可点击直跳分区），全绿时整条消失；常态状态唯一承载处 = 标签徽标（补 `工具 n/2` 徽标；**修复 trae/qoder 启用但网关未监听仍显示中性/ok 的口径**——统一 warn「未监听」，注意条芯片带端口）
  - **健壮性三件**：①`fetchWithTimeout`（GET 20s / POST 30s，AbortError 换带原因错误——设置服务挂起不再永久"正在读取"）；②`PanelBoundary` 分区级渲染错误隔离（class 组件 + `getDerivedStateFromError`，单标签塌落出 fallback+重试按钮换 key 重挂载，不拖垮整卡）；③save / startOAuthFlow / 用量 pull 的 catch 不再吞 `e.message`（超时原因可见，踩坑 #7 纪律扩展）
  - **额度与用量**：手动「刷新」按钮 + 「更新于 HH:MM:SS · 本页可见时每 10 秒自动刷新」时间戳（pull 提组件级经 ref 持有，interval 与按钮同入口）；token/请求数千分位（`fmtNum`）；轮次行命中率 title 带原始命中/未命中计数
  - **模型页**：行内上限输入改幽灵态（`cbc-ghost`：常态无边框、hover/focus 显边框、去数字步进器）+ aria-label（上下文/输出上限）；滚动区 300→400px；筛选时组标题显示「筛选命中 N（可用 x / 未启用 y）」
  - **标签栏键盘导航**：←/→ 切标签并移动焦点（role=tablist 的 WAI-ARIA 约定）
- **设置卡前端刷新（轮 2：降噪折叠 + 浅色核验 + 回归套件重建）**
  - **HelpNote 折叠说明**：>60 字的背景说明（登录 Key 轮换/额度口径/模型同步/生图/服务商/Trae/Qoder/桥 共 10 处）收进 `details.cbc-help`（summary「使用说明」+ ▸/▾ 伪元素标记），每标签少一堵小字墙；短的就地点提示（模型组勾选语义、OAuth 覆盖范围、空态、baseURL 一行）保持直显。信息一次点击可达，`qoder-slot-check` 依赖的文案均不在折叠内
  - **幽灵输入修正（宿主原语 DOM 实测）**：dsh 0.1.7 的 `Input` 原语把 className 落在 **wrapper span**（边框也在 wrapper）、内层 input 只带 CSS-module 类——轮 1 的 `:focus` 规则永远不命中（焦点在内层）、spinner 伪元素选择器也落空。补 `:focus-within` 与 `.cbc-ghost input::-webkit-*-spin-button` 双路径（wrapper/原生兜底都覆盖）；aria-label 透传正常（校准回归选择器的依据）
  - **回归套件重建** `dsh-ui-test/card-regression.js`（**16 断言**，替代丢失的 step20/22 等）：PM 列卡/summary、8 标签齐全、**注意条仅 warn/err**、面板懒挂载+hidden 切换、模型筛选（组标题计数+行全匹配）、幽灵输入存在、**HelpNote 折叠/展开/再收起**、用量刷新按钮+「更新于 HH:MM:SS」时间戳、ArrowRight 键盘导航、浅色主题渲染、无 dsh-tap pageerror；浅色/暗色/筛选态截图落 shots/
  - **验证**：card-regression 16/16 + qoder-slot-check 10/10 双绿；浅色主题截图核验（幽灵输入/注意条/徽标/HelpNote 全部正常）
- **设置卡前端刷新（轮 3：提交前代码审查 → 逐条修 → 断言补强）**：审查工作区 diff（vs `d02794f`）判「修完再提交」，无 Critical，四条 Important 全收
  - **标签栏 ARIA 补齐**：轮 1 声称的「WAI-ARIA tablist 约定」当时只实现了一半——全文件零 `tabIndex`、无 `aria-controls`/`role="tabpanel"`，8 个标签全在 Tab 序里（键盘用户要按 8 次才穿过标签栏），且 ←/→ 从 `activeTab` 起算而非当前聚焦标签（聚焦到非活跃标签再按 → 会从别处跳）。补 roving tabIndex（活跃 0 / 其余 -1）+ `id`/`aria-controls` ↔ `role="tabpanel"`/`aria-labelledby` 双向引用（懒挂载未挂载的分区不留空引用）+ 方向键改从聚焦标签的 `data-tab` 起算
  - **假「未监听」永久驻留 → 保存后退避补拉**（**踩坑 #45 新记**）：POST 响应是 `applyLive()` 之后**同步**返回的，而 `runtime.running` 由 `'listening'` 事件**异步**翻转（index.js:1656 + providers/trae/gateway.js:756）⇒ 紧随的 GET 可能采样到 pre-listening 窗口；主视图没有轮询（只有 usage 分区自己 10s 轮询），这枚 warn 会挂到用户收起再展开。`load()` 改为回传视图，保存后若仍有「未监听」芯片按 1s/2s/4s 补拉三次（卸载清 timer）；真失败（EADDRINUSE 等）用尽后停手，warn 如实留下
  - **catch 带原因收全**：轮 1 只改了 save / startOAuthFlow / 用量 pull 三处，其余 **10 处**（模型列表、三家目录同步、provider-list、Key 增删、三处登出）在超时后仍只报「（网络）」= 踩坑 #7 原样复现，一并改成 `e.message` 优先
  - **同口径小修**：Qoder 未监听芯片补端口（轮 1「注意条芯片带端口」对 Qoder 不成立，Trae 早有）；`PanelBoundary` 补 `componentDidCatch` 把堆栈送 console（fallback 只显示 message）；`常態`→`常态` 用字统一
  - **断言补强 16→28**：`[3]` 注意条改**独立预言机**双向对齐（直接从 GET 视图算应有的 warn/err 集合再逐条比；旧写法在 `.cbc-strip` 缺席时 `[].every()` 恒真 = 空洞通过，漏显漏报都测不出）、`[9]` 补焦点跟随 + roving tabIndex + tabpanel 双向引用 + **方向键从聚焦处起算**（旧实现此处必红）、新增 `[12]`「启用+未监听 → warn 芯片带端口」正向回归与 `[14]`「保存后退避补拉自愈」——两组都 mock GET/POST，**零真实写入**（跑前跑后 `~/.dsh/codebuddy-plugin.json` 哈希一致）
  - **验证**：card-regression **28/28** + qoder-slot-check **10/10**；离线全绿（verify-bridge / verify-core-generic / verify-providers / verify-trae-provider 89 / verify-qoder-provider 154 / verify-host-config 36 / verify-models --list 23 条）
  - 审查列出、**本轮有意未收**的 Minor（留后）：轮询不感知 `document.hidden`（「本页可见」实指本卡标签选中，非浏览器标签页）、`fmtNum` 对 ≥3 位小数分组错误（当前调用点全是整数）、首次 pull 失败后时间戳仍停在「正在读取…」、超时护栏只到响应头（`r.text()` 阶段不设防）、滚动区 400px 是内联魔数而 `.cbc-scrollbox` 仍写 300、`pullRef.current` 在 render 体内赋值（latest-ref 惯用法，并发渲染语义上不纯）

## 0.9.10 (2026-09-23)

- **适配 dsh 0.1.7-alpha.2：配置持久化从 `settings.yaml` 迁到 profile 的 cordis patch**（用户"更新 deepseek harness，注意插件"驱动；0.1.6-alpha.2 → 0.1.7-alpha.2，逐包 diff 全插件接触面 + 隔离实例实测后再动日常实例）
  - **上游事实盘点**（`npm pack` 逐包 diff，17 个接触面子包）：`@deepseek-ai/dsh-settings-file` **被删除**（0.1.7-alpha.2 已 404），`settings` 服务改由 `dsh-settings` 提供，形态从"命名空间注册 + settings.yaml 热重载文档"变为"**profile entry 的 volatile 字段表单**"——`register(ns, schema)` 消失，新增 `configure({auto}, fiber)`（页面策略）+ `describe/update/replace/mutate(ns=entry id, …, expectedRevision)`；新增 `dsh-config-editor`（`ctx.configEditor.edit()`，写落 `profileContext.patchPath`，与 profile 变更/HMR 串行化）；`dsh-base` 的 patch 里 `settings`/`config-editor` 两行都带 `disabled: !!js "!ctx.get('profileContext')"`。`dsh-llm-pi-ai` 的 `providers` 改成 `.volatile()`（⇒ 可表单编辑），`settingsNs` 改为 `ctx.fiber.entry?.options.id ?? NS`，新增 `directoryEntries()`/`assertServiceable()`。**零破坏**的接触面：`dsh-client-ui-slots`（仅版本号，`plugins.item` 槽仍在，另新增 `plugins.detail.*`/`plugins.bundle.activation` 四个槽）、`dsh-launch-environment`（仅版本号 ⇒ 哨兵 Authorization 机制不动）、`dsh-credentials(-local)`（仅版本号 ⇒ `.credentials.yaml` 写路径不动）、`dsh-base` 的三个 patch 行 id（`llm-pi-ai`/`agent-default-model`/`web`）不变；`dsh-package-manifest` 纯增量（新增 `icon`、本地化 `title/description`、`bundle.patch` 可为**数组**）
  - **实测（隔离 DSH_HOME，升级前）**：首启即把 `~/.dsh/settings.yaml` **一次性导入 profile patch 后改名 `settings.yaml.imported`**；隔离环境（无本插件）下 `llm-pi-ai` 段被整段拒绝——因为该段的 `codebuddy: {models:…}` 缺 `api`/`baseURL`，而基座路由由本插件的 patch 提供 ⇒ **判定"段是否可导入"依赖插件在场**，隔离结论不可外推（真实 profile 下导入成功，patch 1.6KB → 12KB，`providers` 含 codebuddy/kimi-coding/qoder）
  - **新增 `host-config.js`**：宿主配置层的**能力选路通道**，把两代宿主差异收在一处——0.1.7+ 走 forms seam（`mutate(NS, ops, expectedRevision)`，写前比对同值不写、`SETTINGS_CONFLICT` 重读 revision 重试 ≤3 次、`writable===false` 降级为结果对象），≤0.1.6 回退注释保留的 `settings.yaml` 文档编辑；上层只产出 `ops`（`set`/`unset` + 相对 `llm-pi-ai` 配置根的路径）。写入**永不 reject**（踩坑 #33），失败落 `lastError` 并回传 `{ok:false,error}`。`attach(ctx)` 按能力自选：有 `configure` → `configure({auto:false}, fiber)`（本插件自带设置卡，宿主不再按 Config schema 自动生成页面，pi-ai 自己也这么做）；只有 `register` → `register('dsh-tap', Config)`（旧 `settings.plugin.item` 派发所需）
  - **index.js 四个 writer 全部改产出 ops**：`syncModelsToDshSettings`（`providers.codebuddy.models`）、`writeProviderBlock`（`providers.<id>`，G6 多服务商）、`syncTraeModelsToDshSettings` / `syncQoderModelsToDshSettings`（整块铺/删 = 路由存在性管理，踩坑 #25）；`readSettingsProviders()` 改读 `describe()` 的 live value（新宿主）或 settings.yaml（旧宿主）。index.js 里**再无一处直写 `settings.yaml`**（只剩 `.credentials.yaml`，其宿主侧代码未变）
  - **诊断入口**：`GET /dsh-tap/settings?probe=host-config`（同过本地门）报选路/可写性/`documentPath`/entry 可见性/revision/`autoGenerate`/有效 provider 清单/全部命名空间/attach 与 last 错误——升级排查不必再猜
  - **部署侧两处必修**（否则刷屏或断链）：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 删掉 0.1.7 已移除的 `@deepseek-ai/dsh-experimental-agent-team-web-profile`（每次启动刷 `dsh: skipping profile bundle …cannot resolve`）；升级后跑 `dsh-launcher/repair-profile-links.js`（本次删断链 72 条含 `dsh-settings-file`、补缺链 43 条含 `dsh-config-editor`/`dsh-client-ui-primitives`/`dsh-client-ui-slots`/`dsh-plugin-manager`）。另：`dsh-launcher/package.json` 声明的 `stop.js`/`start.js` **实际不存在**（托盘 tray.js 才是编排者），升级前必须按命令行杀进程，否则旧进程带着已替换的 node_modules 继续跑 = 混版半态
  - **客户端图标命名换代**（实测发现，非 diff 可见）：0.1.7 的 `dsh-client-ui-primitives` 把带尺寸数字后缀的图标名**全部废掉**——`IconChevronDownOutline14` / `IconRefreshOutline14` 在 265 个导出里 0 命中，改为 `IconChevronDownOutline{Regular,Medium,Artwork}` 尺寸变体（基础名 `IconChevronDownOutline` 也**不导出**）。原代码按名取用会静默拿到 `null` 退原生兜底（图标降级、无报错）。修复 = `pickComponent([候选名…])` 按序解析，两代宿主都拿到原生图标；`Button`/`Input` 名字未变
  - **修复：写入撞 `SETTINGS_CONFLICT` 的真根因 = 缓存了会被替换的服务实例**（实测 stderr `settings namespace "llm-pi-ai" changed since it was read (expected revision 5, now 6)`，三次重试全败）：0.1.7 每次写 profile patch 都触发重载，Settings 服务实例**可能被替换**（上游 README 明写 "a late-loading or replaced Settings service picks the policy up"），而 cordis 的 `ctx.settings` 是**实时 getter**——缓存实例引用等于拿着陈旧 revision 反复撞墙。修复 = `host-config.js` 保存注入的子上下文、每次操作经 `svc()` **活取**，重试轮数 3→4，服务消失时返回 `SETTINGS_SERVICE_GONE` 而不是静默
  - **修复：启动期镜像被自己打回残缺清单（28 → 16）**：apply() 里"跨重启保持镜像"的那次写入发生在**目录同步之前**，此刻 `dynamicCatalog == null`，有效清单只含静态基线（16 条），会把宿主里上一次同步成功的完整清单（28 条）覆盖掉；叠加"写入→profile 重载→插件 re-apply→再写一次"的循环，最终停在残缺那份（用户可见后果 = 选择器少 12 个网关目录模型）。修复 = **删掉这次冗余写入**（`syncModelsFromGateway` 的成功/失败两条路本来都会写）+ 同步路径内的两次镜像写入改 `await`。实测：`codebuddy.models` 启动即 28 = `effectiveCount`、`model catalog synced` 每次启动 2→1 次、`SETTINGS_CONFLICT` 归零
  - **验证**：新增 `scripts/verify-host-config.mjs`（**36 断言**，`npm run verify:host-config`：forms 选路/configure 归属 fiber/命名空间=entry id/expectedRevision/同值不写/深路径/冲突重试/不可写降级/非冲突错不 reject/probe/dispose + **宿主替换服务实例后仍能写（A21–A24，锁上面第一条修复）** + legacy 回退的注释保留与同值不写 + 无 settings 服务仍可用）；存量六套件回归绿（verify-bridge / verify-core-generic / verify-rotation / verify-providers / verify-trae-provider 89 / verify-qoder-provider 154）。**真实实例端到端**（Windows :3090，dsh 0.1.7-alpha.2）`verify-017.mjs` **18 PASS / 0 FAIL**：桥聊天 `deepseek-v3.2` 回"可以" + `finish_reason=stop`、codebuddy+qoder OAuth 均 signedIn、桥 3901/翻译网关 3903 在听（trae 3902 未启用）、`probe=host-config` 全绿（`mode=forms`、`writable=true`、`documentPath=…\profiles\web\cordis.patch.yml`、`entryNs=llm-pi-ai applies=live`、`autoGenerate=false`、`providerIds=[codebuddy,kimi-coding,qoder]`、无 attach/last 错误）。**浏览器回归**（dsh-ui-test，puppeteer + 系统 Chrome）：`qoder-slot-check.js` **10/10**（Plugin Manager 列卡 / summary 行 / page 视图标签栏 / Qoder CN 标签 / 已登录态 / 折叠组）、`qoder-prefs-check.js` **30/30**（含"镜像生效 contextWindow=1000000"与"回默认回落 200000"两条**经 UI 触发新 seam 写入**的断言；探针的镜像读取路径同步改为 profile patch，两代宿主都读得到）。profile patch 被镜像实时改写并反映用户 prefs（qfmodel ctx=1000000 / dfmodel ctx=400000）。WSL 侧全局 dsh 同步升到 0.1.7-alpha.2（`npm i -g` 41s；profile 无残留 bundle 引用；启动冒烟：settings.yaml 同样被导入改名、patch 217→3950 字节含 llm-pi-ai、桥 3901 EADDRINUSE 优雅降级、无锁残留）
  - **已知行为（非缺陷）**：启动期仍会因我们自己的写入触发一次 profile 重载，故 `model catalog synced` 每次启动出现 2 次；两轮写的是同一份完整清单且同值不写，终态正确、零冲突。另观察到宿主侧页面错误 `list slot "conversation.chat.turnTail" requires options.id`——不属本插件（我们的槽是 `plugins.item`），未追

## 0.9.9（未单独发版，内容随 0.9.10 出货，2026-09-22）

- **更新：CodeBuddy 通道「模型思考强度」对齐网关声明 + 162 臂实测**（用户报"对 codebuddy 途径进行模型思考强度更新"）：网关 `/v3/config` 的 `reasoning` 已出现**新形态声明** `{supportedEfforts, canDisableThinking, defaultEffort}`（旧形态只给默认档 `effort`），插件此前只读默认档、目录模型的档位一律为空。
  - **目录声明驱动档位表**：`providers/codebuddy/catalog.js` 全量解析声明；`index.js catalogReasoningEfforts()` 把 `supportedEfforts` 映射成档位表（键=档位名、值=出站线值），经 `catalogToProfile` 挂进 profile，`computeBaseModels` 合并时**目录声明优先、patch 静态表兜底**；合并结果既进 settings.yaml 镜像（**宿主 Model/Effort 选择器从此对目录模型出档**：glm-5.3-flash / kimi-k2.8-preview → Low/High/Max，hy4-preview → High）也进设置卡的档位 select（`model-list` 新增 `efforts` 字段 = 静态 ∪ 目录统一视图）
  - **实测三定论**（新探针 `scripts/probe-codebuddy-efforts.mjs`，162+24 臂，证据 docs/probes/codebuddy-efforts-\*-2026-09-22.json，决策表 `--summarize`）：①误拼档位有专用错误码 **11150** `invalid_reasoning_effort`（deepseek-v4-pro 显式发 `off`/`disabled`/`auto` 全 11150，而**同一拼写在 glm-5.3-flash 上被静默接受** ⇒ 拼写接受面逐模型不一致，档位表只列实测/目录声明过的拼写）；②**"关思考"没有可靠拼写**——canDisableThinking=true 的两个模型**省略参数照常思考**（reason≈1.2k），`off`/`disabled`/`auto` 被接受但推理量不变，`minimal`/`none` 两模型表现不一致（glm-5.3-flash≈0 / kimi-k2.8-preview≈140，基线≈1k）⇒ 插件**不出 off 档、不臆造线值**（宿主 `Off` 只会映射成"省略参数"，对它们就是假开关）；③`off` 档语义 = 省略参数，**仅在该模型"省略即不思考"时才是真开关**
  - **静态清单刷新**：`hy3` / `hy3-preview` **撤销 off 档**（2026-09-22 六臂每臂都出 ~510–625 字推理，08-16 的"省略参数无 reasoning_content"结论已过期）；**补上 deepseek-v3.2 的档位表**（旧清单漏列，实测 low/medium/high/max 各出 147–248 字推理）；新增可路由且档位有效的目录模型 `deepseek-v4.1-flash` / `deepseek-v3-2-volc` / `glm-5.3` / `glm-5.0-turbo` / `hy3-x`（glm-5.3、hy3-x 无 off——省略即思考）；尺寸对齐目录（deepseek-v4-pro maxTokens 50000→128000、glm-5.2 48000→64000、minimax-m3 128000→64000）；静态清单 18 → **23 个模型**
  - **目录有 ≠ /v2 可路由**（routing.md R-R3 再证）：`glm-4.6v` / `kimi-k2-thinking` / `minimax-m2.5` / `hy4-preview-x` 在目录里齐全但六臂全部 `11102 service info not found` ⇒ 刻意不进静态清单（否则选择器出一个永远失败的模型）
  - **UI/守卫**：设置卡档位 select 的 `off` 仅在**线值非空**（真开关）时渲染，`off` 线值为 null（= 省略参数 = 默认态）者不进选项；桥出站注入改查合并表，未声明档位/无表模型一律不注入（脏档位永不上线）
  - **验证**：verify-bridge 新增 **[17] 14 断言**（mock `/v3/config` 带闸门，目录声明→档位表→settings.yaml 镜像→桥出站注入全链 + 三个负例），全套绿、exit 0；**真实上游全链路联调** `scripts/probe-codebuddy-tier-wiring.mjs`（临时 DSH_HOME + 本地捕获代理打真实网关）**12 断言全绿**——真实目录 31 模型同步、档位表与声明一致、镜像带 `reasoningEfforts`、真实 chat 出站体带注入的 `reasoning_effort:"max"` 且上游 200，负例不注入（证据 docs/probes/codebuddy-tier-wiring-2026-09-22.json）；verify-core-generic / verify-rotation / verify-providers / verify-trae-provider(89) / verify-qoder-provider(154) 全绿；`verify-models.mjs --list/--sync` 正常解析 23 模型

- **修复：Qoder CN 通道 `provider_error … "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"` 的真根因 = 上游把 `content:null` 的消息当"不存在"**（2026-09-22 用户复发报障后单变量差分定案，推翻同日早前的 #39 结论；踩坑 #41）：同一条**结构合法**的工具环只切 assistant 的 `content` 一个字段——`null`/缺键在 **dmodel/kmodel/mmodel 一律 400**（文案三家各一：dmodel `Messages with role 'tool' must be a response…`、kmodel `Invalid request: tool_call_id is not found`、mmodel `invalid params, tool result's tool id(…) not found (2013)`），`""`/非空文本三家**全绿**；`role:"tool"` 自身 `content:null` 另报 `An assistant message with 'tool_calls' must be followed by tool messages…`。宿主 `@earendil-works/pi-ai` 的 `convertMessages`（openai-completions.js:961）在 `compat.requiresAssistantAfterToolResult=false`（自定义 provider 的 detectCompat 默认）下把**每个纯工具轮**都序列化成 `{role:'assistant',content:null,tool_calls:[…]}` → dsh 在严格家族上**第一次调工具就必炸**，与是否发生过中断无关；而 0.9.9 早前那版修复补孤儿时插的桩自己就是 `content:null` → **修完仍报同一条错**（实测 `B_orphan_stub_null` ❌ / `B_orphan_stub_empty` ✅，经生产网关 B1–B5 全红）
  - `providers/tool-pairing.js`：新增**可见性归一**——assistant / tool 消息 `content` 为 `null`/缺键 → `''`（OpenAI 方言里语义等价，严格上游只认非 null），孤儿桩改用 `''`；`repaired.invisible` 计数入取证摘要（`describeRepair`）。配对三条规则（孤儿补桩 / 缺结果合成 / 重复结果丢弃）不变，合法非空历史仍逐字节不变
  - `providers/qoder/gateway.js`：出站 **developer→system 折叠**——实测 `role:"developer"` 在上游**反序列化阶段**整请求拒绝（dmodel：details `Failed to deserialize the JSON body...`，换 `system` 立即 200）；pi-ai 对 reasoning 模型会把 system prompt 序列化成 developer（qoder 不在其 isNonStandard 名单 ⇒ 探测默认 `supportsDeveloperRole=true`），本插件模型条目未声明 `reasoning` 故现网未触发，属潜在雷（同 codebuddy 桥策略）
  - **为什么官方 Qoder CN 从不报**（本机取证）：105 份官方 transcript 的 `tool_use`/`tool_result` **孤儿 result 恒 0**（计数不等时缺的永远是"结果"而非"声明"）；按 `message.id` 归并的 **879 个工具回合里 93.3% 带非空 thinking、52.8% 带非空 text，裸 tool_use（≈`content:null`）仅 2.73%**；252 份 `qodercli.log` 显示官方同样在客户端重放全量历史（`request_message_count` 涨到 **457**）却**零条** `provider_error`/配对 400 ⇒ 差异不在端点与服务端校验，而在客户端历史构造纪律
  - **实测验证**：用当前代码起临时网关打真实上游 dmodel——`A_call_content_null` / `B_orphan_plain` / `B_orphan_stub_null` / `C_tool_content_null` 四形态**全部由 400 → 200 正常出正文**（同批直连未修复体仍 400，阳性对照成立）；新增探针 `scripts/probe-qoder-null-content.mjs`（单变量差分矩阵，`--gw-local` 用工作区代码起网关做前后对比）与 `scripts/probe-qoder-pairing.mjs`（用**真实 pi-ai `convertMessages`** 离线复现 8 种会话形态的出站序列 + 严格校验器判违规），证据 docs/probes/qoder-null-content-\*.json + qoder-pairing-\*.json
  - verify-qoder-provider 144 → **154 断言**全绿（[18] 扩为"配对 + 可见性"：null/缺键 content 归一、桩用空串、键序不变、网关明文捕获 developer→system 与 null→""）；verify-trae-provider 89 / verify-core-generic / verify-bridge 回归绿

- **修复：Qoder CN 通道用量不落入官方统计**（2026-09-22 用户报障："在 qoder cn 的用量统计中没有显示，没有像在 qoder 中使用一样统计"）：**两段式真相**（臂 1-9 梯度 + 大额双臂实验 + 官方 GUI 对照，证据 docs/probes/qoder-attribution-arm9-*.json 等）：①**额度扣减其实一直在发生**——`quota/usage` 的 `addOnQuota.used` 对裸 OpenAI body 也实时入账（~45s），早前"不扣费"判断是整数取整读数吞掉 0.002 级小额探测的假象（官方 GUI 聊天同样 ~1 分钟 192→197）；②**统计视图**（热力图/汇总/网页明细）是延迟批处理且需要官方归因链——为此翻译网关出站对齐官方客户端全形态（bundle `A6e`/`g4i`/`aPl` 原文逆向）：聊天 body 明文补归因信封（`request_id`/`request_set_id`/`chat_record_id`/`session_id`（dsh 会话→UUID 稳定映射）/`chat_task`/`chat_context`/`source:1`/`version:"3"`/`agent_id`/`task_id`/`session_type:"qoderclicn"`/`model_config`（目录原始条目全字段含 price_factor/promotion）+ `business` 块（id=request_set_id、stage:processing））；每轮结束 fire-and-forget 两条 COSY 签名上报：`business/finish`（BUSINESS_FINISH，mode auth）+ `/api/v1/tracking`（back-flow 聚合 total_credits/tokens，mode sign）——与官方同语义，失败不影响主链路；新增 `cosy.prepareSigned`（prepareRequest 直通 auth/sign 两模式）与 `fetchQoderCatalog` 的 `entries` 原始条目索引。真实上游回归：qmodel_38max/dfmodel（DeepSeek-Flash，即用户报的 dsfl4.1 路径）/gmodel 三家族带信封 200 正常出正文。verify-qoder 132 → **144 断言**全绿（新增 [19] 12 断言）；判别脚本 `probe-qoder-quota.mjs`（计数器差分）/ `probe-qoder-attribution*.mjs`（梯度臂 1-9）入仓。统计视图层的入库延迟窗口以 cron 长窗口复测收尾
- **修复：Qoder 翻译网关出站 `messages` 的 tool 配对不变量**（第二类 `provider_error` 根因，2026-09-22 差分矩阵定位）：宿主侧 `@earendil-works/pi-ai` 的 `transform-messages.js` 会把 `stopReason=error/aborted` 的 assistant 消息**整条丢弃、却保留它产出的 toolResult**，`convertMessages` 于是产出 `[system,user,tool,user]`——孤儿 `role:"tool"` 无前置 `assistant.tool_calls`；上游 OpenAI 兼容面严格校验（**按模型家族分裂**：dmodel/kmodel/mmodel 直接 400，auto/qmodel/gmodel 静默容忍）→ 表现为 `qoder upstream error: {"code":"provider_error", …, "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"}`
  - 新增 `providers/tool-pairing.js`（两网关共用的纯函数）：孤儿 tool 结果 → 补一条仅含该 tool_call 的 assistant 桩（保上下文，实测上游放行）；assistant 声明了却没结果的 tool_call → 补"不可用"结果；同 id 重复结果 → 丢弃；合法历史**逐字节不变**。修复在签名/加密之前，`reasoning_effort`/`max_completion_tokens` 补默认与计量路径不受影响；取证日志出站行加 `repaired=orphans=N synthesized=M duplicates=K`。**Trae 翻译网关同接入**（`buildChatRequest` 出站同样过体检——两个网关都可能收到宿主半修的序列化产物；verify-trae-provider 相应断言更新为"孤儿 tool 先补 assistant 桩"）
  - **实测验证**：修复后的网关起在临时端口打真实 Qoder 上游——"孤儿 tool"复现体由 400 变 200 正常出文本（同一请求未修复时必报 provider_error），两条对照（完整工具环 / tool_calls 缺结果）行为不变；证据 docs/probes/qoder-matrix-1790023075879.json + 1790023159490.json。**（当日修正：该验证跑在容错家族 `qmodel` 上，严格家族 dmodel/kmodel/mmodel 未复测，且补桩用的 `content:null` 本身就是坏体——真根因与最终修复见本节首条，踩坑 #41）**
- **Qwen3.8-Flash（qfmodel）根因定案 = 上游推理节点故障（"Qoder 里能用"前提被推翻）**：完整诊断见 **docs/diagnosis-qoder-flash.md**。要点：①模型 key 正确（Qoder 客户端自己的日志打印 `model_config{"key":"qfmodel",…,"source":"system"}`；两处 bundle 零硬编码 key）；②请求体/头/版本号**逐一排除**——用官方 `QoderContext` 原实现 + 9 组 clientMetadata + 客户端 agent 体（system+工具+max_tokens）+ `cosyVersion` 1.1.40→999.999.999 全扫，错误一字不变；③`oa_qwen-plus-main` **只被 qfmodel 指名**（同坏体在 qmodel/qmodel_38max/q37fmodel 上正常出正文），且路由由 `X-Model-Key` 头决定（头=qfmodel/体=auto 仍失败，头=auto/体=qfmodel 成功）；④**时间线**：客户端 transcript 里 09-18/09-19 累计 754 条 qfmodel assistant 消息（真实可用），最后成功 **04:21:38**，13 秒后同一客户端 `output_tokens=0` 无 assistant 输出，04:31 起 dsh 复现并持续（05:12 仍 0/3）→ 节点在 04:21:38–04:21:51 之间进入持久失败；⑤客户端不读 `minimal_version`（bundle 零命中），无版本闸门。新增确认探针 `scripts/probe-qoder-flash-confirm.mjs`（3×Flash + 2×对照，节点恢复即翻绿）
- **修复：`Cosy-ClientType` 头保真度**（与官方 wasm 逐头 diff 定案）：`Cosy-ClientType` 恒为 **5**（官方 wasm 对 `client_type:'qoder'`/`5`/缺省一律出 5，现网客户端线缆值也是 5）；我方旧值 `'qoder'` 让所有请求带第三方客户端指纹，已修为 `5`。与模型可用性无关（两种值下 qfmodel 都失败），属身份保真
- **修复：Qoder 翻译网关"带内失败帧"静默吞**（实测根因案例 = Qwen3.8-Flash"用不了"）：上游会在 HTTP 200 的 SSE 信封装业务错误对象（无 choices/usage、有 code/message，实测形态 `{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}`）——旧解析器按普通帧吞掉，流式空响应/非流式挂死。现识别上抛：流式 = 错误 chunk + [DONE]，非流式 = 502 `qoder_upstream_error` 带上游详情（gateway.js 解析器 + handleChat 错误路径；verify-qoder [14] +2 断言锁形态）
- **根因定界：Qwen3.8-Flash（qfmodel）属上游侧故障**——其上游后端节点 `oa_qwen-plus-main` 执行失败（连续 3 次复测一致，证据 docs/probes/qoder-chat-live-1790007\*.json），待上游修复；插件侧已把故障表现为可读错误。附带探测教训入踩坑 #37：臆造 key `qmodel_38flash` 被上游**静默改派 auto**（响应 model 字段 + billable:false 是哨兵），诊断必须用真实目录 key
- **新增：Qoder 目录模型逐模型「思考强度」「上下文长度」调节**（控件仿 Qoder 官方客户端）：文件层 `qoderModelPrefs`（{[id]:{effort?,contextVariant?}}，完整替换语义；档位 off/low/medium/high/max，off = 不注入参数）；镜像时按所选目录 `context_config` 变体写 profile.contextWindow（未选维持目录默认档）；网关"补默认"注入——payload 未带 reasoning_effort 时注入 prefs.effort、未带 max_tokens 系时注入 profile.maxTokens（**客户端带值绝不覆盖**）；契约：GET `qoder.models.modelPrefs/variants`、patch action `qoderModelSetPrefs`（严格校验，400 带中文原因）；设置卡 Qoder 区每行两个 select（思考强度恒出、上下文长度仅 variants 非空渲染），useRef 同值去抖 + 失败销账（踩坑 #27/#32 纪律）
- **测试基建两修**（均预存问题、与本次功能无关）：verify-qoder 真机形态 fixture `expires_at` 写死 2026-09-20 的时间炸弹改 `now+1h`（踩坑 #38）；verify-core-generic 0600 权限位断言在 win32 不可观测改平台分支（代码仍传 0o600）
- **验证**：verify-qoder-provider 122 → **132 断言**全绿（新增 [18] tool 配对修复 10 断言：纯函数四态 + 网关接线明文捕获）；verify-trae-provider **89 断言**全绿（含更新后的出站体检断言）；差分矩阵探针 4 个 suite 真实上游取证（docs/probes/qoder-matrix-\*.json ×4）；浏览器 `dsh-ui-test/qoder-prefs-check.js` **30 断言**全绿（渲染/变体条件/持久化往返/完整替换语义/镜像生效/回默认/去抖/跨标签保留）；verify-bridge / verify-core-generic / verify-providers / verify-rotation 回归绿（exit 0）

## 0.9.8 (2026-09-20)

- **Qoder CN 通道聊天面全线打通（设计文档 §5e）**：推翻"OpenAI 面裸 Bearer"设想——真实形态是 `QoderContext.prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)` 签名 + WASM 加密 body，POST 到 region 发现服务给出的 infer 节点（CN = `gateway.qoder.com.cn`）的 `/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`；响应为 SSE 信封（`data:{body:"<标准 OpenAI chunk JSON>"}`、body="[DONE]"、尾帧计时、event:error 异常帧）。矩阵实测：单轮/多轮/模型切换（auto/qmodel_38max）/OpenAI tools 流式全通，usage 带 credits 计量
- **WASM 签名运行时入插件**：`providers/qoder/qoder_auth.wasm`（官方 CLI bundle 内嵌 base64 原字节，298KB）+ `providers/qoder/cosy.js`（手写 wasm-bindgen ABI 胶水——heap 表/字符串传递/栈指针返回槽，不复制 bundle 文本；运行时实例单例 + 凭据快照变化重建上下文）
- **`providers/qoder/{catalog,gateway,index}.js`**：签名目录（明文/密文两态，`.chat[]` 投影 profile，contextWindow 取 context_config 默认档）+ 翻译网关（:3903，信封拆转 + 非流式聚合 + 首字节护栏 + Host 门 + usage.credits→credit 计量）+ 工厂组装
- **组合根接线**：Config `qoderEnabled`/`qoderBridgePort`/`qoderInferBaseURL`；`providers.qoder` 镜像整块铺/删（路由存在性管理，同 trae 踩坑 #25）；路由 `qoder-model-sync`/`qoder-model-list`/patch `qoderModelSetEnabled`；启用自动同步目录；设置卡 Qoder CN 区升级为完整通道面板（登录/启用/目录同步/模型启停/端口/连接域名）
- **验证**：verify-qoder-provider 65 → **83 断言**（新增 [14] 网关翻译：流式逐帧/聚合/计量归一/错误帧/401 透传/Host 门//v1/models；[15] 目录投影五断言）全绿，verify-providers/rotation/bridge 回归绿；dsh 0.1.6-alpha.2 真实实例端到端：选择器出 Qoder CN 组 → 选 Qwen3.8-Max → 哨兵词回显（网关计量日志坐实）；probe-qoder-live --chat 改走 cosy 签名路径（旧 api2-v2 裸 Bearer 形态废弃）

## 0.9.7 (2026-09-19)

- **Qoder CN 通道 Phase 1：设备流 OAuth 登录接入组合根**（providers/qoder/oauth.js 早入库，本批接线，功能对齐 CodeBuddy/Trae 登录区）：Config 新增 `qoderLoginHost` / `qoderOpenapiBaseURL` / `qoderClientId`（默认官方 prod 值）+ SETTINGS_FIELDS 白名单 + baseURL 校验（明文 http 仅回环）；`createQoderOAuth` 实例绑 `~/.dsh/qoder-plugin-auth.json`；路由 `qoder-oauth-start` / `-status` / `-logout`；GET 视图加 `qoder.oauth`（令牌与 machine_id 永不出宿主）。设置卡新增第 8 标签「Qoder CN」：登录（浏览器授权）/ 退出（二次确认）/ 状态行（pending 3s 轮询收敛、needsRelogin 引导重登）/ 高级连接折叠组；状态条与标签徽标加 Qoder 芯片。**仅登录**——聊天面与模型目录待 COSY WASM 签名打通（docs/goals/qoder-cn-provider-design.md §5b），不进选择器、不起桥

- **dsh 0.1.6 设置卡迁移**（踩坑 #34）：0.1.6 拆除 `settings.plugin.item` 槽（插件配置 UI 迁入 Plugin Manager 的 `plugins.item`），旧槽名上 `slots.inject` 静默等待 → 升级后卡片"消失且零报错"（dshmarket 同受害）。修复：双槽注册（`plugins.item` 新槽 + 旧槽回退，哪个声明走哪个）；卡片按 owner props `view` 分形——`summary` 渲染一行简介、`page` 渲染完整表单（新增 `embedded` 模式：常开、不画自有折叠头部，页面自带标题/返回 crumb）；package.json `dsh.client.inject` 删掉 0.1.6 已不存在的 `@deepseek-ai/dsh-client-runtime`

- **验证**：verify-qoder-provider 65 / verify-providers / verify-rotation / verify-bridge 离线全绿；dsh 0.1.6-alpha.2 真实实例端到端——GET /dsh-tap/settings 含 `qoder.oauth`（signedIn:true，脱敏）、`qoder-oauth-start` 出合法授权 URL（qoder.cn/device/selectAccounts，S256 参数齐）、pending 超时自愈且存量令牌不动；浏览器探针（dsh-ui-test/qoder-slot-check.js，Windows 侧 harness 重建）10/10——Plugin Manager 列卡 / summary 行 / 点开 page 视图标签栏 / Qoder CN 标签 / 已登录状态

## 0.9.6 (2026-09-11)

- **移除 iFlow preset**（2026-09 停服）：providers/iflow/、PROVIDER_PRESETS、local-scan 探测器、verify-providers 断言同步移除；openai-compat 骨架的 status:434 认证方言识别保留（历史 iFlow 形态，对任何同形态上游仍有效）；docs/rules/extra-providers.md 矩阵删行、E-P6 转历史留存。用户 settings.yaml 里已存在的 iflow 块不动

- **逐模型思考强度设置（G8）**：模型行对声明了 `reasoningEfforts` 的静态模型出档位 select（off 线值为 null = 省略参数，不进选项）；选定值存新字段 `effortByModel`（文件层，dict），桥出站经 codebuddy 适配器 `transformChatPayload` 对**未显式携带** `reasoning_effort` 的请求注入线值（调用方自带档位不覆盖；无表模型/非法档位不注入；表 Map 懒构建一次）。回归锁：verify-bridge §14 四断言（注入/不覆盖/off 不注入/无表不注入）+ step22 B 段七断言（select 选项表/设档持久化往返）

- **服务商标签页交互重设计**：全局单 busy 改为行级 `busyId`（忙碌行的按钮显示"验证中…/刷新中…/删除中…"）；添加/刷新/删除成功给行内反馈（"已添加 X（N 个模型）"等 `p.cbc-status`，失败仍走全局横幅）；删除改**二次确认**（第一次点击按钮变"确认删除"，4 秒不确认自动复位——删除连同凭据一起清、不可逆）。step29 扩到 13 断言覆盖新交互

- **Trae 启停组同步后不自刷**：fetchTlist 只在挂载时拉取，开启通道/目录同步完成后清单不更新（冷启动服务器上 step31-trae #10 必现超时；热目录实例掩盖了它）——新增随 `sync.at`/`traeEnabled` 变化重拉的 effect

## 0.9.5 (2026-09-11)

- **服务商页重构 + dsh 0.1.5 适配**：

  - **多服务商扩容 4 → 8 preset**：新增 DeepSeek 官方（`api.deepseek.com/v1`）、智谱 BigModel（`open.bigmodel.cn/api/paas/v4`）、Moonshot AI（`api.moonshot.cn/v1`）、OpenRouter（`openrouter.ai/api/v1`）；存量 4 家（ark/百炼/iflow/qwen）2026-09-11 假 key 复测全部健在、按保守原则保留（证据矩阵追加到 docs/rules/extra-providers.md）

  - **openai-compat 骨架新增 `staticCatalog`**：OpenRouter 的 /models 是公开目录（任意/无 key 都 200、全量 437 条）——既不能验 key 也不宜全量进选择器；`staticCatalog: true` 的 preset 不调 /models，走 chat 探针验 key + `fallbackModels` 内置精选清单（10 个各厂旗舰，按当日目录实况选取），规则 E-P7；`refreshExtraProviderModels` 同步透传

  - **设置卡文案同步**：空态提示改"从下拉选预设或自定义添加"（不再硬编码两家），底部 hint 补"无目录/公开目录走聊天探针"

  - **dsh 0.1.5 适配**（踩坑 #30）：设置卡注册改经 `slots.inject("settings.plugin.item", …)` 等槽位运行时声明——直接 register 抢跑导致卡片静默消失；UI 回归 harness 支持 `DSH_WEB_TOKEN`（0.1.5 新增 web 入口 token 闸，`_helpers.js` ENTRY）；step29 的 `llm.providers` → `llm/listProviders`（payload 须 `{args:{}}`，返回 `[{id,name}]` 仅 active）

  - 回归：verify-providers 17 断言（8d/9a-c 新增）、verify-core-generic、verify-models --list、step29 10 断言、step20 22 断言、step22 22 断言全绿

- **深度审计一轮（四路并行只读审计，发现清单 .audit-28.md 本地留存不入库）——9 项必须修复全部落地 + 前端精简去重**：

  - 后端：codebuddy OAuth 轮询 `poll().catch` 落地（`writeAuth` 同步抛曾穿透成 unhandledRejection 直接崩宿主进程，踩坑 #33）；**全部状态文件改原子写**（json-store 新增 `writeTextAtomic` tmp+rename——截断的 settings.yaml 往往仍是合法 YAML，静默丢配置比炸更糟；0600 随新 inode 天然生效，踩坑 #31）；桥/Trae 网关停-起竞态 wedge 自愈（"已在目标态"早退条件计入 `lastError` 失败态，listen 失败后下一次 apply 自动重试，踩坑 #33）

  - 前端：toggleModel 局部 setData 补回 `profiles`/`ceilings`（勾选模型后行内上限输入框显示曾退化回目录原值）；checkbox 同值去重表 4 个失败分支销账（失败后该模型同向操作曾被永久吞掉，踩坑 #32）；收起卡片不再多打一趟 GET（mount + 展开边沿才拉取）；四处 POST 补 `.catch`（oauth-logout / apiKeysRemove / apiKeysAdd / trae-oauth-logout，踩坑 #7 纪律补齐）

  - 精简去重：TextField/NumberField 逐行拷贝合并为 numeric 变体委托（-20 行）；CodeBuddy/Trae 两处 OAuth 启动流程复制粘贴提取共享 `startOAuthFlow`（-25 行）；面板顶部与标签栏活动页重复的 h4 标题删除（测试 harness `_helpers.js` 同步改 `data-tab` 定位，BASE 支持 `DSH_WEB_BASE` 环境变量）；`.cbc-chip` 属性双写改 `:where()` 零特异性；GET /settings 视图删客户端从不消费的 `fields`

  - 文档：README 服务商清单补到 8 家（含 OpenRouter staticCatalog 形态）、wiki/01/02/06/07 失同步补齐、踩坑 #31-#33 入档、.gitignore 泛化 `.audit-*.md`

  - 回归：六个离线套件全绿（verify-models --list / verify-bridge / verify-rotation / verify-core-generic / verify-providers 17 断言 / verify-trae-provider 89 断言）；浏览器 step22 22/22 全过（思考档位徽标 / 严格 1 POST+1 GET / 组件不卸载 / Key 排序），step20 17/19（2 项失败为本机环境态——无 OAuth 登录态、动态目录同步无可用凭据，与代码无关）

## 0.9.4 (2026-09-04)

- **安全审计 30 项确认发现全闭环**（0.9.3 修 3 项，本轮 3 子代理并行修复 25 项 + 2 项记录性接受；发现清单 .audit-27.md 本地留存，不入库）：

  - **providers/trae/gateway.js**：本地翻译网关入站 Host 门（非回环 Host 先 req.resume() 丢体再 403，防 LAN/跨网直连与 DNS rebinding）；SSE reroute 注释行插值清洗（\[\r\n]+ 折叠为单空格，防帧注入）

  - **providers/trae/oauth.js**：三处 finish() HTML 页插值（登录失败 errCode/error\_msg、token 交换 error、异常 message）加 esc() 全转义（& 首位防双转义；pending.error 走 JSON→React 文本节点，保持原文）；deviceId 从 Math.random 换 node:crypto randomInt（16 位首位非零语义不变，无模偏差）

  - **core/bridge.js**：createServer handler 入口 Host 门（provider 无关 hostIsLoopback helper，core 纯净性保持）；回环绑定核实已在位（127.0.0.1）

  - **core/json-store.js**：全部落盘文件 writeFileSync 0600 + 既有文件 chmod 补齐（Windows ENOTSUP 静默忽略）——token/ECDSA 设备私钥/插件文件层/计量统一收紧；resolveEnvKey 删 `new RegExp(拼 envName)` 改逐行字符串解析（regex 注入根除，名字段语义逐点对齐）

  - **index.js**：/dsh-tap/settings GET+POST 统一 localGuardFailure 门（Host 非回环 403——**LAN IP 访问设置卡自此被拒，有意收紧**；带 Origin 时与 Host 不一致 403）；validateBaseURL http 仅回环 hostname 放行（**LAN 明文 http 上游自此拒绝**，错误带原因）；trae dbPath 门（绝对路径 + 无 .. 段 + .db/.vscdb 扩展名）；模型 id 黑名单守卫（__proto__/constructor/prototype 及 `x.constructor` 型子路径，覆盖 setModelEnabled/setModelLimits/setTraeModelEnabled 三条 POST 写入通路）

  - **docs/probes 证据脱敏**：17 文件约 273 处个人/账户标识（uid/uin/enterpriseId 族/手机号/user\_id×85/IP/geo via 头/Windows 用户名）原位替换 `<redacted:字段>`，JSON/JSONL 逐行校验合法；scripts/probe-oauth.mjs 硬编码 enterpriseId 改 `CODEBUDDY_ENTERPRISE_ID` 环境变量注入；docs/rules/trae-surface.md 同源 PII 一并脱敏

  - **.gitignore**：追加 .env\*/\*.pem/\*.key/codebuddy-plugin\*.json/\*plugin-auth.json（覆盖 trae 令牌+设备私钥）/.credentials\*/.claude/ 等 9 行

  - **记录性接受（不改，CHANGELOG 留痕）**：git 历史含旧版未脱敏证据——重写已推送历史需 force-push，代价大于收益，脱敏止于 HEAD；package-lock 源 registry.npmmirror.com 为国内镜像环境选择，sha512 完整性已钉

  - **回归锁**：verify-trae-provider +5（Host 门 403 与 \[::1] 放行——新增 rawRequest 原生客户端防 fetch 伪造 Host / SSE 注入帧清洗 / XSS 实体化 / deviceId 形态收紧，84 → **89**）；verify-bridge 新 **\[13]** 节 +14（桥与 settings 的 Host 门、跨站 Origin 403、回环 GET 仍 200、dbPath 三态、原型污染拒收、明文 http 非回环 400、拒绝不落盘）；verify-core-generic 新 **\[R7]** 节 +6（usage 文件 0600、resolveEnvKey 普通/带引号/元字符名/缺席名四态）

  - 回归：verify-bridge（13 用例）/ verify-trae-provider（89）/ verify-core-generic / verify-providers / verify-rotation / verify-models --list（18 模型）全绿

## 0.9.3 (2026-09-04)

- **全仓库安全审计落地三补丁**（7 维度并行审查 + 逐发现对抗验证：secrets-history / network-surface / credentials / injection / web-ui-xss / supply-chain-config，确认项 30、证伪 0；用户"把 3 个修复补丁直接打上，做好记录"驱动）：

  - **补丁 1（index.js）**：设置路由四个 POST 响应（apiKeysAdd 走通用 patch、modelSetEnabled / modelSetLimits / traeModelSetEnabled 走层叠重读）曾把**原始文件层（含明文 apiKey）整块回传浏览器**——GET 视图 f9aeeaa（踩坑 #26）已脱敏，POST 漏网。提取 `maskedUserLayer()` 统一四处置位；设置卡只消费 `user` 的顶层字段存在性（overriddenFor → hasOwnProperty），脱敏无损

  - **补丁 2（providers/codebuddy/oauth.js）**：新增 `assertSafeAuthUrl` 出宿主门禁——上游响应给出的 authUrl 直送浏览器两个导航汇（lib/client.js 的 window\.open / location.href），上游被劫持/投毒时可把用户导向钓鱼页或 `javascript:` 串。门禁在置位 oauthPending **之前**：拒绝时 pending 不激活（oauthStatus 不再外泄该 URL）、组合根 oauth-start 的 catch 回 502 + 原因。规则：scheme 一律 https（authUrl 与 baseURL 双双回环时例外——离线 verify 的 mock 上游走 127.0.0.1）；host 必须是发起 auth/state 的 baseURL 本身或官方登录站点族（tencent.com / workbuddy.cn / codebuddy.cn 子域放行，依据 docs/rules/gateway-facts.md 账户体系 + oauth-token 探针的 domain 证据）

  - **补丁 3（providers/trae/oauth.js）**：`traeLoginHost` 基址前置校验（保存侧 validateBaseURL 之外的第二道）——手改设置文件塞进 `javascript:` 之类非法值时在**开回环服务之前**响亮失败（不留监听句柄），而非拼出可执行授权页 URL 直送浏览器；authUrl 构造从字符串拼接改 `new URL('/authorization?…', loginBase)` 路径绝对引用，杜绝基址带尾路径/尾斜杠时的 `//authorization` 双斜杠与路径串联

  - **回归锁**：verify-bridge 新增 **\[12]**（mock 网关补可投毒的 `/v2/plugin/auth/state`）：三条 POST 路径断言响应内明文 key 全脱敏 + 投毒 authUrl（钓鱼域 / javascript:）502 拒绝且 oauth-status 无外泄 + 回环对正例放行；verify-trae-provider 新增 3 断言（javascript: scheme 门 / 非法 URL 解析门 / URL 解析构造——路径绝对引用无双斜杠，81 → **84**）

  - 回归：verify-bridge（12 用例含新 \[12]）/ verify-trae-provider（84）/ verify-core-generic / verify-providers / verify-rotation / verify-models --list（18 模型）全绿

## 0.9.2 (2026-09-03)

- **修复 v4-flash"经桥缓存命中率下降快"根因：桥逐分片隐式 utf8 解码损坏出站前缀**（踩坑 #28，完整证据链与机制分析 docs/diagnosis-cache-decline.md）：

  - **根因**：`core/bridge.js` listen() 的 `rawBody += c` 对每个 TCP 分片独立隐式 utf8 解码——跨分片的多字节中文字符被替换成 3×U+FFFD，分片边界逐请求随机 → 出站前缀逐请求漂移 → 网关内容寻址缓存只能命中到损坏点（诊断 hit 值与 dump 分叉字节数定量对应）。网关缓存本身无罪（直连 24 发全 99.3%、TTL ≥600s）；附带后果是模型收到的中文上下文本身带乱码（正确性问题，不只是计费）

  - **主修**：listen() 改 `chunks.push(c)` 收集 Buffer 分片 + `Buffer.concat(chunks).toString('utf8')` 一次解码；32MB 请求体上限从字符串长度改累计字节数判定

  - **同型修复**：`providers/trae/gateway.js` listen() 与 `index.js` `/dsh-tap/settings` 设置路由的 `raw += c` 同改（Trae 通道译文上行中文、设置路由 provider displayName 中文同受此坑威胁）

  - **回归锁**：verify-bridge 新增 **\[10] 多分片中文体完好性**用例——mock 网关自身改 Buffer 收集（否则分片用例的损坏源是 mock 而不是被测桥），原生 socket 按 1/2/5/1300/7000/12000 切点写体、切点故意落在多字节序列中间，断言 mock 收到的字节与整块发送逐字节一致（无 U+FFFD、无漂移）；callRoute 改 emit Buffer 分片（真实 webServer 喂 Buffer）；socket 请求带 `Connection: close`。存量 mock 单块写 body 正是本坑漏网 8 个版本的原因

  - **新坑 #29**（修 \[10] 时翻出）：原生 socket 测试客户端不挂 `data` 监听 = paused 流——服务端 FIN 后 `close` 永不派发，\[10] 首跑挂死即此（取证日志证明请求完整过桥、上游 200，被测物无罪）；socket 客户端必须消费响应（空监听器即可）

  - **预期收益**（诊断 §6，未做线上 A/B 复测）：消除逐请求前缀漂移，插件路径命中率回到基线形态（轮内 ≈92–99%、短空闲轮首全命中、TTL ≥600s），与官方路径的差距坍缩到网关 per-model 策略本身；同时消除发给模型的 FFFD 乱码

  - 回归：verify-bridge（11 用例含新 \[10]）/ verify-trae-provider（81，覆盖 trae gateway 改动）/ verify-core-generic / verify-providers / verify-rotation / verify-models --list（18 模型）全绿

## 0.9.1 (2026-09-03)

- **设置卡交互重设计（用户"重新思考交互逻辑，每个卡片和功能最直观展示"驱动；lib/client.js 全量重写，路由契约零变化）**：

  - **三层信息架构**取代"单卡展开 = 九分区 3000px 长滚动墙"：① 折叠态头部常显 3 枚状态芯片（登录 / 模型数 / 流式桥，数据来自挂载即拉的 GET 视图）——不展开即可读卡；② 展开态顶部 6 枚可点击状态芯片（登录/模型/桥/搜索/生图/Trae），点击直跳所属分区；③ 横向标签栏 7 分区（登录 / 模型 / 额度与用量 / 工具 / 服务商 / TraeWork CN / 桥与高级，工具 = 搜索抓取 + 图像生成合并，桥与高级 = 流式桥 + 网关地址合并）

  - **标签懒挂载、隐藏不卸载**：分区首次访问才 mount，此后保持挂载（display:none）——草稿、滚动位置、已拉目录跨标签切换与保存保留（step22 DOM 标记法证明）；usage 10s 轮询仅分区可见期间运行，切走即停

  - **额度与用量重做**：hero 大数字 + 周期进度条（cycleRemain/cycleSize）+ 总量口径副行；资源包按名称聚合（×N + 合计余量 + 最早周期至，>4 包默认聚合、明细可展开）；今日/累计统计卡；api-key 模式手填估算档不变

  - **补齐两处后端已支持但 UI 缺失的设置点**：`upstreamFirstByteTimeoutMs`（Trae inline 首字节护栏，0.8.x 引入却无处可改）；Trae 逐模型启停（`trae-model-list` + `traeModelSetEnabled`，全禁 = 整块路由移除的提示就地展示）

  - **修两个真 bug**：踩坑 #27 的去抖表每渲染重建（去抖从不生效）——改为 **useRef 同值去重**（重复 change 事件携带与上次已发送相同的目标态；不用时间窗，勾选往返 POST+reload 可以快过任何时间窗）；Trae 登录异步 window\.open 会被弹窗拦截器吃掉——改为与 CodeBuddy 一致的同步开窗再导航

  - **保存反馈**：成功保存后标签栏右侧"已保存 ✓"短提示（1.8s 自愈）；卡名随 0.9.0 更名改为 dsh-tap（槽位 label 同步）

  - 回归：dsh-ui-test 全套重建适配（\_helpers 换 /dsh-tap/settings 新路由 + tab() 驱动；step20 22 断言 / step22 22 / step24 7 / step25 13（新增未激活不轮询 + 切走即停两条）/ step26 8 / step27 4 / step28 9 / step29 10（移除已删 provider-efforts 路由的陈旧断言）/ step31-trae 19（新增 Trae 模型启停往返 + 连接域名折叠组））= **114 断言全绿**；verify-models --list / verify-bridge / verify-rotation / verify-core-generic / verify-providers / verify-trae-provider（81）全绿

  - package.json 版本号从 0.8.7 对齐到 0.9.1（0.9.0 更名时漏 bump）

## 0.9.0 (2026-08-29)

- **更名 dsh-codebuddy-plugin → dsh-tap**（用户“功能驳杂/名字绑定厂商”驱动；新名按功能命名——把订阅额度“接出来”的水龙头，厂商名会腐烂、tap 永远是真的；npm 可注册）：

  - **运行时标识四处联动**：package.json name、index.js \export const name（插件注册名）、设置路由 /dsh-codebuddy-plugin/settings\ → /dsh-tap/settings（index.js webServer 路由 + lib/client.js ROUTE + \settings.register\ 命名空间 + 槽位 id/key/data-plugin 属性 + verify-bridge 路由断言）、cordis.patch.yml \insert\ 入口 id/name；日志前缀 \[dsh-tap]、\[dsh-tap/trae]\ 同步

  - **活文档全量跟随**：README/AGENTS/LICENSE/pitfalls/wiki/trae-surface；CHANGELOG 与诊断文档里的历史记载刻意保留原名（记录当时事实）

  - **刻意不动**：\~/.dsh/codebuddy-plugin.json\ 等存储文件名（保用户数据兼容免迁移）、\Bearer dsh-codebuddy-bridge\ 哨兵（内部管道值，patch 与桥两侧一致即可，与插件名无关）

  - **升级必读（破坏性）**：本机需 \dsh plugin rm dsh-codebuddy-plugin\ → \dd\ 新包名后**重启 dsh 进程**（踩坑 #8）；GitHub 仓库改名走 Settings→Rename（旧 URL 自动重定向）

  - 回归：verify-bridge / verify-trae-provider（81）/ verify-core-generic / verify-providers / verify-rotation 全绿

## 0.8.7 (2026-08-28)

- **适配 dsh 0.1.0-rc.8 / 0.1.1-rc.1 / 0.1.1-rc.2**（用户"dsh 更新了"驱动；逐包 npm pack diff rc.7→0.1.1-rc.2 全插件接触面）：

  - **上游事实盘点**：`@earendil-works/pi-ai` 保持 0.82.1（wire 协议层零变化——哨兵 Authorization、developer→system 重写、requestHeaders 剥除、缓存行为全部不动）；dsh-settings / dsh-launch-environment / dsh-base 的 cordis.patch.yml lib 零变化；浏览器半（dsh-client-ui-slots/settings/runtime、api-proxy settings RPC）逐字节级 diff 判定零破坏，rc.7 keyed 槽位兼容写法继续有效；`dsh-client-ui-primitives` 恢复真实 CSS（正向）

  - **破坏点 =** **`dsh-llm-pi-ai`** **适配层重写（+813 行 catalog 物化）**：非目录路由的**空 models 清单在 apply 时直接 throw**（"resolves no models"），热加载路径被 onChange 拒绝并保持旧路由注册——踩坑 #25 的"空数组遮蔽"策略彻底失效；profile schema 收紧（空 baseURL/displayName 报错、`provider`/`maxRetries` 旧字段 reject、reasoningEfforts 空 dict 报错；现有 patch 形态兼容）、provider id 须小写中划线（codebuddy/trae 合法）、compat 门控表显式化（thinkingFormat/supportsReasoningEffort 仍可配，会话亲和字段仍 withhold）

  - **Trae 通道改"路由存在性管理"**：patch 删除 24 模型静态基线，镜像 `syncTraeModelsToDshSettings` 从"恒铺 models 路径 + 空数组遮蔽"改为**整块铺/删**——启用+已同步铺完整块（displayName/api/baseURL/headers/models；baseURL 跟随 traeBridgePort，改端口重铺即热生效），禁用/未同步/全禁用删 `providers.trae` 整块（路由消失、选择器隐藏、免重启；无 patch 基线即无回落）

  - **codebuddy 全禁用防护**：`setModelEnabled` 拒绝禁用最后一个有效模型（空清单会令 llm-pi-ai 整域拒绝解析、主聊天全挂）；`syncModelsToDshSettings` 防御性兜底（effective 为空时删镜像路径回落 patch 静态清单而非铺空数组）

  - **迁移（升级必读）**：dsh 升到 0.1.1-rc.2 后首次启动前须清理 settings.yaml 里 ≤0.8.5 形态的 `llm-pi-ai.providers.trae` 块（只带 models 路径、缺 baseURL，llm-pi-ai 会先于插件炸掉）；同类手写残块（如仅 apiKeyEnv 的 kimi-coding）同样致命——本机迁移已处理并备份 `settings.yaml.bak-086-migration`

  - 回归：verify-bridge / verify-core-generic / verify-rotation / verify-providers / verify-trae-provider（81 断言）全绿；浏览器 step20（20，基线补 TraeWork CN 分区）/ step22（22）/ step31-trae（12，断言更新为"禁用=块删除"语义）全过；端到端实测——dsh 0.1.1-rc.2 冷启动无 llm-pi-ai 报错、trae 整块自动重铺、禁用↔启用热切换（块删/重铺）、全禁用防护触发、capture-traffic 真实三会话（跨会话缓存命中 24192 tok）

## 0.8.6 (2026-08-24)

- **逆向漏项重审（round 9）**：用户质疑"trae 3003 是不是逆向漏了什么"驱动；官方客户端当日网络日志取证（`%APPDATA%/TRAE SOLO CN/logs/aha_log/networkservice-*.alaudalog` AALG 容器 zlib 解流）：

  - **结论：逆向无漏**——官方 llm\_utils\_chat 与插件同端点/同认证；官方主聊天走 remote 通道（当日 chat\_sessions 提及 576 次 vs llm\_utils\_chat 20 次），官方自己在事故期也不依赖 inline 面；两域名（trae-api-cn / 官方 307 重定向目标 api5-normal.mchost.guru）同信封实测均 3003 → 域名非解药

  - **官方头组提取 + 逐头二分实测**：version-code 用当日构建号 20260811（插件 20260401）、TTNet 头组、x-request-pin/x-requested-at 等；除 pin 对外**均不改变 3003 行为**

  - **⚠️ x-request-pin 是官方签名校验**：服务端见 pin 头即强制 base64 校验——外部复刻者无官方密钥无法生成合法 pin（官方日志原值直接复用也 400 base64 decode failed）；**插件绝不能伪造 pin**，否则必 400

  - **1005 套餐门纠偏**：同信封同 token 同内容 chat\_v3 曾短暂 1005（extra:{"plan":1}，三模型全中），数分钟内自愈回 200——**单次 1005 不可作账号级套餐判定**（内容二分证伪）；故障期服务端在该域名下有多重不稳定（3003 持续/1005 闪断/base64 波动/超时）

  - **落地增强**：gateway inline 出站 `redirect:'follow'`（跟随官方 307 重定向对齐链路）+ 补 3 个无害指纹头（request-traffic-type/package-type/x-lgw-req-sdk-type）；不伪造 pin 头对

  - 回归：verify-trae-provider 81 断言全绿；实弹验证新头组稳定 200（改派 seed-code-lite）。完整证据链 docs/diagnosis-trae-3003.md §10 + docs/reverse/trae-cloud-api.md §5.1

## 0.8.5 (2026-08-24)

- **"trae 3003 all models failed / PI\_AI\_ERROR" 故障定位 + 错误面加固**（用户实测报告驱动；证据链 docs/diagnosis-trae-3003.md，对照实验证据 docs/probes/trae-3003-diagnosis-\*.json）：

  - **根因=Trae 服务端 inline\_chat 面模型解析层故障，非插件缺陷**：同凭据同信封对照实验——inline\_chat 对一切 model 名（含默认 kimi-k2.6、含不带 model 字段）一律 SSE error 3003 且无 timing\_cost（服务端未走到选模一步）；chat\_v3 同信封完整对话成功；额度双池充足；4011 限流文案可辨。当日服务端三阶段时变：静默改派任意模型 → 仅非默认模型硬 3003（§5.1）→ 全模型 3003

  - **次要发现**：remote create\_session 间歇性**裸文本 404**（TLB 节点路由漂移，与头组/体无关，分钟级自愈）；高频探测触发边缘 WAF 空体 403（含无凭据请求）；991502 solo\_agent\_parallel\_limit 并发门（僵尸会话占位只能等 TTL）；remote 模型清单默认位变更（solo\_agent\_remote 默认=Doubao-Seed-Code 等）印证服务端当日在大改模型注册表

  - **errors.js**：码表新增 3003/991502 语义；`formatTraeErrorMessage` 对已知码追加可操作处置提示（3003 → 指引切 remote 通道/等服务端恢复）

  - **gateway.js**：三处错误文案统一走 formatTraeErrorMessage——用户再遇 3003 时错误信息可直接自助

  - **remote.js**：createRemoteSession 对裸文本 404/403（边缘漂移指纹，业务拒绝恒为 JSON）自动短退避重试一次（创建失败不产生会话，幂等安全）；持续失败报文带自愈指引

  - 回归：verify-trae-provider 新增 4 断言（mock 云端 3003 → 提示透传 / 首次裸 404 重试成功 / 持续 404 文案带指引 / formatTraeErrorMessage 单元），77 断言全绿；verify:bridge / verify:core / verify:providers / verify:trae / verify-rotation 全绿

  - 规范化诊断脚本 `scripts/probe-trae-3003-diagnosis.mjs`（额度池只读查询 + A/B/C/R 对照实验，间隔 ≥20s 纪律）

## 0.8.4 (2026-08-24)

- **修复"登录态有问题"：聊天协议全面校准到真实线上形态**（用户实测报告驱动；无凭据探测 + Trae2api-cn（github.com/autumnsentiment/Trae2api-cn，生产级参照）+ 带凭据联调三源校准）：

  - **登录一直是真的**——实测令牌有效（GetUserInfo 返回完整账号、账号有 500 credits 包）；"假登录"的体感来自聊天信封不对导致的失败链

  - **请求信封重写**：`{messages[content 为 {type,text} 块数组], model, function:"inline_chat", request_id, session_id, stream:true}` + 生成参数/工具透传；三头同 JWT（+x-ide-token）+ `x-app-id`（product.json UUID，≠OAuth client\_id——用错 TCC record not found）+ 数字 version-code + x-request-id/x-uid + 空 UA；设备指纹头与登录上报一致

  - **SSE 语法落实**：metadata/timing\_cost/output/token\_usage/done 事件；**response/reasoning\_content 是累计快照**——createTraeStreamParser 前缀差分（直接当增量会大面积重复）；排队（request\_wait\_in\_queue/position）提示一次；工具调用（tool\_calls/tool\_call\_info）按 id 累积转 OpenAI tool\_call 流

  - **模型改派诚实披露**：服务端按 function/套餐改派模型（inline\_chat→kimi-k2.6，与请求 model 无关；真值源 timing\_cost.provider\_model\_name）——网关以 SSE 注释行 `: trae-reroute` 告知（不污染调用方历史）、计量记真实模型、非流式 message.note 标注

  - 账号昵称字段修正（ScreenName）；probe-trae-live.mjs 同步校准（--chat 用真实信封）

  - 回归：verify-trae-provider **51 断言**（mock 云端说真实语法：累计快照/事件名/改派/排队/工具）；**真实端到端实测通过**——dsh 网关路径流式（皮亚诺公理回答、usage 61 tok）与非流式（"成功了"+served-by note）双绿

  - 已知限制存档（trae-cloud-api.md §5.1）：限流 4011 紧（联调间隔 ≥20s）；/api/ide/v1/chat 老端点 4023 拒现代模型名；remote 协议（真手动模型选择）是 agent 形态、留作后续课题

- **Trae remote 传输：模型切换真实生效**（2026-08-24 下午，用户诉求"可以切换模型"驱动；探测矩阵 docs/probes/trae-model-routing\[234]-\*.json 定论）：

  - **raw 面模型路由被 function 位钉死（终局证伪）**：inline\_chat 只服务账户默认模型，非默认 model 名一律 3003 "all models failed"（custom\_model 无效；当日上午的静默改派为服务端时变行为，两态兼容）；chat\_v3/solo\_agent\_lite 恒 seed-code-lite、solo\_work\_lite 恒 glm-5.2——任意 model 名都 200 但 timing\_cost 证实改派

  - **新传输** **`providers/trae/remote.js`**：remote 会话协议（`POST /api/remote/v1/chat_sessions`：initial\_message.model\_name + `model_selection_strategy:"manual"` + agent\_type solo\_agent\_remote + content 空数组/历史扁平化进 query → `GET …/events` SSE → stop 善后）；事件解析器 createRemoteEventParser（plan\_item 按 id 分槽累计差分：thought=正文/reasoning\_content=思考；finish 工具 params.summary 兜底去重补发；model\_config/done.model\_info 双源确认真实模型；token\_usage→usage；queuing 提示一次）；glm-5.3 真线实测路由+自报双重确认

  - **网关接线**：设置 `traeChatTransport`（inline 默认 / remote）逐请求分发；remote 模式耗 **work 额度池**且不支持 OpenAI tools（远端 agent 自持工具）——带 tools 请求明确 400 remote-no-tools 不静默降级；计量记 model\_config 真实模型

  - **额度双池实证**：`ide_user_ent_usage` 按 available\_endpoint 分池（0=IDE/raw、1=work/remote）；3 次 remote 会话后 work 池 +9.4 credits、IDE 池不动；Free 账号 kimi-k3 触发 error 1005 套餐门（message 空 + data.plan，errors.js 空 message 按码表回填语义）

  - 设置卡 TraeWork CN 分区新增"聊天传输"选择行；回归 verify-trae-provider **73 断言**（mock remote 云端：创建体/web 头组/事件流翻译/聚合/tools 拒绝/stop 善后 + 解析器边界单测）

## 0.8.3 (2026-08-23)

- **v0.8.1→0.8.3 直达：TraeWork CN 订阅额度通道**（目标"从 dsh 消耗 Trae 订阅额度"；本轮三个里程碑按 CHANGELOG 三条目推进，一次交付）

  - **联调与取证基建**：`scripts/probe-trae-live.mjs`——`--login`（真实设备流 + 登录后立即 DeviceProof 刷新自证，令牌只打掩码）／`--chat`（经网关请求构造器直打真实 `llm_utils_chat`，原始响应落 `docs/probes/trae-chat-live-*.json` 供信封/事件语法校准）／`--sig der|raw`（DeviceProof 签名编码切换，应对线上校验形态）；`TRAE_BRIDGE_LOG` 网关取证日志

  - **证据归档** **`docs/reverse/trae-cloud-api.md`**：无凭据在线探测（mchost 聊天网关 401/1001、ExchangeToken 双路径 10101 两层、GetUserInfo 20310）+ harness.dll 协议面提取（agent/v3 路由族、llm\_utils\_chat 信封字段、双认证头组、BYOK 直连证据）+ 本地 harness 备选架构存档（懒启动/加密 DB/run\_helper，未采用的原因）+ trae2api 历史协议交叉证据；逐条标注置信度，联调路径单点化（buildChatRequest / parseTraeEvent）

  - 回归：verify:trae-provider 43 断言、verify:trae 49 断言、verify:bridge / verify:core / verify:providers / verify-rotation 全绿

## 0.8.2 (2026-08-23)

- **Trae 聊天桥（OpenAI↔Trae 翻译网关）**：`providers/trae/gateway.js`——127.0.0.1:3902（`traeBridgePort`）本地网关，`POST /v1/chat/completions` 接 OpenAI 方言，出站转 `/api/agent/v3/llm_utils_chat`（信封=buildChatRequest），SSE 互转（parseTraeEvent 容错字段发现：增量/用量/结束/错误四态）→ OpenAI chunk 流或聚合 chat.completion；`GET /v1/models` 回已同步目录（dsh 内置"获取可用模型"在本通道可用）；复用 core 的 SessionLimiter（会话并发闸）与 usage-meter（Trae 用量进同一张用量视图）；上游 401/1001、凭据不可用 503、坏 payload 400 全结构化映射；listen 失败降级不炸宿主（踩坑 #17 纪律）

- **patch 路由**：`cordis.patch.yml` 的 llm-pi-ai.providers 新增 `trae`（openai-completions → `http://127.0.0.1:3902/v1`，哨兵 `Authorization: Bearer dsh-trae-bridge`——机制同 codebuddy 路由，踩坑 #11）；**必须带静态模型基线**（24 个，目录快照生成）——实测 pi-ai 对无 models 的 patch provider 直接拒绝加载整棵插件树；可见性由镜像恒铺管理：禁用/未同步=空数组（实测 pi-ai 接受），启用+同步=有效清单

- **组合根接线**：apply() 内 `traeSettingsFn` 迟绑定 + `syncTraeBridge` 生命周期（启用起网关+自动目录同步，禁用停网关+撤镜像，热加载免重启）；`trae-model-sync`/`trae-model-list`/`traeModelSetEnabled` 设置路由

## 0.8.1 (2026-08-23)

- **Trae OAuth 凭据边缘（自持设备密钥）**：`providers/trae/oauth.js`——完整设备流（PKCE S256 + 自生成 P-256 密钥对 + DeviceInfo.DevicePublicKey 上报 → `POST api.trae.cn/trae/api/v3/oauth/ExchangeToken` AuthCode 模式）；本地回环 `/authorize` 回调服务（随机端口，10 分钟超时）；refresh = RefreshToken 模式 + DeviceProof（`POST\n/trae/api/v3/oauth/ExchangeToken\n<ClientID>\n<RefreshToken>\n<Timestamp>\n<Nonce>` 逐行签名，ECDSA P-256/SHA-256，DER 默认可切 raw）——**刷新完全自控，不依赖官方 IDE 安全存储**（traework-cn.md 判断 #5 只否定"偷 IDE token"路线）；单飞刷新、令牌/私钥只存 `~/.dsh/trae-plugin-auth.json` 永不回传浏览器

- **本地模型目录接入**：`providers/trae/catalog.js` 复用提取器纯函数（state.vscdb → 归一化目录 → dsh profiles：排除 BYOK/禁用条目，ctx 回落 max 数组，multimodal→input）；镜像进 `settings.yaml` 的 `llm-pi-ai.providers.trae.models`（启用+已同步才铺，禁用即删路径——选择器里 Trae 模型整体热增删）

- **设置卡 TraeWork CN 分区**：启用开关（含网关运行状态）、OAuth 登录/登出/账号视图、目录同步按钮（候选指纹+计数）、端口与三个域名配置；`providers/trae/errors.js` 错误信封规范化（mchost `{code}` / 火山 ResponseMetadata / 裸非 JSON 三态）

- **离线回归** **`scripts/verify-trae-provider.mjs`（43 断言）**：mock api.trae.cn 全设备流（PKCE 可验证、**mock 用我们注册的公钥验 DeviceProof 签名**——自持密钥链路端到端证通）、目录 fixture 映射、mock 云端 SSE 的翻译网关全路径

## 0.8.0 (2026-08-20)

- **v0.8 Goal 落地：额度可见 + 模型动态化 + 多服务商凭据中心**（目标与验收见 `docs/goals/v0.8-额度可见-模型动态化-多服务商.md`，逐 G 项进展见 `docs/rules/STATE.md`）：

  - **G1/G2 OAuth 真实登录 + token×端点矩阵**：真实浏览器登录落地（`authMode:"oauth"`）；八组真实 token 探测（证据 `docs/probes/oauth-token-2026-08-19.jsonl`）确立——token 权限 = `ck_` key 严格超集（`/billing/meter/*` 为 OAuth-only）；**找到数值剩余额度 API** `/billing/meter/get-user-resource`（CapacityRemainPrecise/资源包明细，两域名同构、Bearer 直达，推翻"plan API 走 cookie 体系进不去"旧结论，quota-signals.md R-Q7）；refresh 轮换不作废旧令牌（R-O6，expiresIn 60 天）；修复 `refreshOAuth` 读错字段名（refreshExpiresAt→refreshExpiresIn，良性）

  - **G3 额度卡片**：设置卡"额度与用量"分区——OAuth 模式显示**真实剩余额度**（`fetchQuotaSnapshot`：numericQuota + resource{totalRemain/cycleRemain/packs}，60s 缓存不阻塞主链路）；api-key 模式为手填总额度（`quotaTotalManual`）− 计量累计的**估算**档并标注；轮次行加 token 拆解（prompt/缓存命中/输出）

  - **G4 模型动态化**：模型清单默认跟 `/v3/config` 走——`dynamicCatalog` + `computeBaseModels()`（目录∪静态并集，纯静态 id 保留——目录≠可路由）+ `syncModelsFromGateway()` 单飞（启动自动 + 设置卡手动刷新，失败保留旧目录或回落静态，**选择器绝不变空**）；勾选语义唯一权威 = 服务端 `effectiveIds`；有动态目录时镜像恒铺（踩坑 #6 纪律修订）

  - **G5 上下文长度组件**：每模型 ctx/输出上限行内可调——`modelState.overrides` + `setModelLimits`（服务端权威校验，null 回基值，不得超基清单上限）→ `computeEffectiveModels` 应用覆盖即时重铺镜像；model-list 响应加 `profiles`/`ceilings`；`LimitInput` 组件身份稳定防失焦

  - **G6 多服务商注册表**：设置卡"服务商"分区——预设（火山 ark / 阿里百炼）或自定义 OpenAI 兼容上游，实测 GET /models 验 key → 写 settings.yaml + `~/.dsh/.credentials.yaml`（0600）→ **免重启热加载进选择器**（chokidar watch + 原地换路由）；删除连块带凭据清；`providers/openai-compat.js` 共享骨架 + `providers/ark`/`providers/bailian` preset，core/ 零改动；坏 provider 块毒化实测 → 写块前本地校验 + 实测目录是硬纪律

  - **G7 本机登录态检测**：只读扫描器 `local-scan.js`（findings 只带路径/类型/元数据、绝无 secret）+ `credential-scan`/`credential-import` 路由 + 设置卡"本机凭据"行（一键导入/原因标注/去重）；iFlow、Qwen Code 命中可导入；探测发现 iFlow/portal.qwen.ai 均无 GET /models → openai-compat 新增 `probeChatKey`（chat 探针验 key + `fallbackModels` 兜底，规则 E-P1/P2 见 docs/rules/extra-providers.md），iflow/qwen 升为正式 preset；导入动作留待用户逐个确认

- 回归：`npm run verify` 18/18、verify:bridge / verify:core / verify:providers / verify-rotation 全绿；浏览器回归 step20–30 全绿（新增 step26 数值额度区块 / step27 目录同步 / step28 上下文长度 / step29 服务商 / step30 凭据扫描）

- 已知网关侧问题（非本插件）：`/v2/accounts` 持续 500→524 故障，step25 走降级分支

## 0.7.5 (2026-08-19)

- **架构重构：index.js（约 1863 行单文件）拆为 core/ + providers/codebuddy/ 两层，index.js 降为组合根**（零行为变更；每个字段/端点的去留由同日完成的六课题规则文档裁判，见 docs/rules/）：

  - `core/`（provider 无关，证伪扫描保证零上游特化）：`json-store.js`（JSON 文件层 + env/credentials.yaml 解析）、`rotation.js`（`KeyRotator` 多凭据轮询/冷却/failover——模块状态改为**实例状态**，见踩坑 #20）、`usage-meter.js`（usage 计量存储/轮次聚类）、`bridge.js`（流式桥：会话归因注入、每会话 FIFO 并发闸、SSE→chat.completion 聚合、取证日志/dump；上游特化全部经 provider 钩子注入：bridgeHeaders / transformChatPayload / extractUsage / extractStreamError / bridgeResponseId / logHeaderNames / sentinelAuth / texts / logPrefix）

  - `providers/codebuddy/`（薄适配器）：`headers.js`（CLIENT\_HEADERS 逐字段规则/迷信判定——ua-validation.md §3：仅 UA 的 `codebuddy/含点版本段` 是规则，余皆迷信但为零行为变更保留）、`errors.js`（网关错误码语义表 11101/12403/14401/14407/11102/11103/11128/10001/11217/12153，逐条引规则文档）、`oauth.js`（设备流 + 单飞刷新，X-No-\* 迷信头标注）、`catalog.js`（/v3/config 目录 + /v2/accounts + dosage 额度方言）、`agenttool.js`（search/webfetch；**删除实测死路径** `data?.usage` 计量——quota-signals.md R-Q2 实证 agenttool 响应体无计量字段，STATE.md 课题 4 放行）、`images.js`（生图工具；images 响应 usage 未经证伪，计量路径保留）

  - `index.js` 组合根：Config/SETTINGS\_FIELDS、模型管理（patch 解析 + settings.yaml 镜像）、凭据编排（core 轮转引擎 + provider OAuth 分支，迟绑定箭头解开双向依赖）、设置路由、apply 生命周期；**对外导出契约不变**（apply/Config/name/inject/makeSearchProvider/makeFetchProvider/makeImageGenTool/computeEffectiveModels/syncModelsToDshSettings/SETTINGS\_PATH/AUTH\_PATH/SETTINGS\_FIELDS）

- **新增证伪测试** **`scripts/verify-core-generic.mjs`**（完成标准 2）：S 面静态扫描 core/ 四个模块零 provider 特化 token（上游域名/错误码/供应商头名）、零 providers/ 引用；R 面用内联 `mock-openai` 适配器 + mock OpenAI 兼容上游经 core/ 全链路驱动第二上游——聚合、SSE 透传、会话头注入、双 Key 500 failover + 冷却跳过、无 credit 字段的 OpenAI usage 计量（记 0）、**developer 角色原样透传**（证明 developer→system 重写归适配器所有，verify-bridge §9 锁另一半）

- 回归：verify 18/18 在线、verify:bridge 44 断言、verify-rotation 25 断言、verify-core-generic 全绿

## 0.7.4 (2026-08-19)

- **修复主聊天 content\_filter（0.7.3"附带发现"之谜破解）**：pi-ai 的 openai-completions 序列化器对推理模型把 system prompt 写成 `role:"developer"`（`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`，本地桥 URL 不在非标准名单内 → supportsDeveloperRole=true）；2026-08-18 \~16:24 UTC 起网关内容审核对**含 developer 角色消息**的 payload 一律 `finish_reason: content_filter`，同字节 payload 仅改回 `system` 即放行（经 CODEBUDDY\_BRIDGE\_DUMP 抓取真实请求 + 逐字段 bisect 实证：developer→system 翻转即通，max\_completion\_tokens/store/strict/x-stainless 头组均无关）。0.7.3 猜的"x-stainless 头组/序列化顺序"证伪——OpenAI SDK 6.26.0 全保真回放也通过。这同时解释了"逐字节等价 curl 全过"：回放脚本一直手写的是 `system`。修复落点在桥：chat 请求出站前把 messages 里的 `developer` 角色重写为 `system`（网关对两者指令语义等价）。回归锁在 verify-bridge 第 9 节；真实 dsh 路径（3080 RPC 起会话）v4-flash 实测恢复 `stop`。**启示**："逐字节等价"的对比基准若靠手写重建而非抓包，差异字段会被重建过程悄悄抹掉——取证一律以 dump/抓包的真实字节为准。

## 0.7.3 (2026-08-19)

- **适配 dsh 0.1.0-rc.7**（唯一破坏性变化）：`settings.plugin.item` 槽位从 `kind:'list'`（`{id, order}`，tab 无条件渲染全部注册卡片）改为 `kind:'keyed'`（`{key}`）——tab 现在从 api-proxy `settings.describe` 读 Host 服务的命名空间清单，按命名空间逐个派发 `renderSlot(…, {entryKey: ns})`；rc.6 的硬编码白名单（`WEB_SETTINGS_NAMESPACES`）与 `settings-not-exposed` 错误码同步删除，官方注释"让插件经 `settings.register()` 自曝配置面"的 deferred work 在 rc.7 落地

  - 宿主半（index.js）：`ctx.inject(['settings'])` 懒注册命名空间 `dsh-codebuddy-plugin`（`settings.register(ns, Config)`）——只作派发声明，读写仍走自有 webServer 路由 + 文件层；注册是本 fiber 的 effect，dispose 自动注销；失败降级 stderr 告警不炸宿主

  - 浏览器半（lib/client.js）：槽位注册加 `key: "dsh-codebuddy-plugin"`；保留 `id/order/label`——rc.6 的 list 槽位只校验 `id`、rc.7 的 keyed 槽位只校验 `key`，多余字段两边都忽略，**同一份代码两版通吃**

  - 其余 rc.7 变化与本插件无关（逐包 diff 实证）：pi-ai replay 封套 v1→v2 内部化、`supportsDeveloperRole` 系死字段删除（rc.6 无人消费）、dsh-base patch 格式未动、`dsh-client-ui-primitives` 仅新增 `useDismissOnOutsidePointer`（Button/Input/图标不变）、`schemastery 3.18.1`/`yaml 2.9.0` 不变

  - 回归：verify-bridge 42 断言、verify-rotation、step20/22/24/25（20/22/8/12）在 rc.7 全绿；`settings.describe` 实证返回 `dsh-codebuddy-plugin`；主聊天会话（deepseek-v3）经桥端到端实测通过

- **附带发现（网关侧，与本插件/rc.7 无关；已在 0.7.4 破解并修复）**：2026-08-18 16:24 UTC 起，dsh 会话形态请求（v4-flash/v4-pro、任意 effort、任意 cwd、任意用户 prompt）遭网关内容审核 `finish_reason: content_filter`（"您当前输入的信息存在敏感内容"）。0.7.4 查明真因：pi-ai 对推理模型把 system prompt 序列化为 `role:"developer"`，网关审核自该时点起拒绝 developer 角色；桥已出站重写为 `system`。本节其余推测（x-stainless 头组等）作废。

## 0.7.2 (2026-08-18)

- **修复桥 EADDRINUSE 崩溃**：3901 被占用时（典型场景：第二个 dsh 实例——连 `dsh web --help` 都会加载插件并抢绑桥端口）`server.listen` 的 unhandled 'error' 事件曾令整个 dsh 进程崩溃。现 `startBridge` 挂 error/listening 监听：降级为 stderr 告警 + 模块级 `bridgeRuntime{running,port,lastError}` 状态，设置卡"额度与用量"分区可见桥状态（占用者是另一个 dsh 实例时其桥仍代管流量，主聊天不断）。回归锁在 verify-bridge 第 9 节

- **新增"额度与用量"设置卡分区**（登录区与模型区之间，10s 轮询实时刷新）：

  - 消耗量（精确）：桥对每个 chat 请求的 SSE usage **恒开扫描**（此前仅 `CODEBUDDY_BRIDGE_LOG` 开启时），逐请求记录 `{ts, kind(chat/title/compaction/image/search/fetch), model, prompt/hit/miss/completion tokens, credit}`；搜索/抓取/生图直连路径响应带 `usage.credit` 时同样入账（best-effort）。持久化 `~/.dsh/codebuddy-plugin-usage.json`（累计/按日 31 天/最近 100 条，写盘 5s 防抖 + dispose flush，计量永不阻断数据路径）

  - 最近轮次：桥看不到 dsh 的 turn 边界（主聊天无会话头上行），按 >45s 间隔把 recent 聚类成近似轮次（标题/压缩调用并入触发它的轮），UI 明示近似口径

  - 剩余额度（账户侧，与 WorkBuddy 账户级共用）：展示 `/v2/accounts` 套餐类型/企业名 + `get-dosage-notify` 低额告警文案（服务端 60s 缓存）。**网关无数字剩余额度 API**——CLI/api-key 面端点全集无 quota 查询、响应头无 quota 字段、用户中心 plan API 走浏览器 cookie 体系；卡片明示并以链接指向 codebuddy.cn/profile/plan

  - 路由新增 `POST {action:'usage'}`（用量视图 + 桥状态 + 额度快照）；`settingsView` 增 `bridge` 字段

- 新增 `scripts/probe-quota.mjs`：额度信号在线探测（accounts/dosage-notify/chat 响应头扫描），证据落盘 `docs/probes/quota-2026-08-18.json`；同日实测确认 **WorkBuddy OAuth 与 CodeBuddy 同构**（`www.workbuddy.cn/v2/plugin/auth/state` 返回同形态 `{state, authUrl}`，product.json `internalDomain` 互含）——额度共享无需单独通道

- verify-bridge 回归扩到 42 项断言（新增第 8 节用量计量：16 请求×0.01 credit 逐数断言 totals/today/recent/turns/落盘格式；第 9 节 EADDRINUSE：占端口后第二实例进程存活、路由仍答、桥状态报 EADDRINUSE、第一实例照常服务）；新增浏览器回归 step25（分区存在/顺序、额度文案、桥状态行、经桥注入真实小请求后轮询自动刷新计数、21s 静默窗轮询 ≥2 次）

## 0.7.1 (2026-08-18)

- **设置卡迁移 dsh 原生 UI 资源**（不改宿主、不改第三方包）：require 平台 seed 模块 `dsh-client-ui-primitives`（Button/Input/图标），require 失败 try/catch 回落原生元素，卡片永不白屏；样式按宿主协议注入单个 `<style data-plugin data-plugin-css>`（cbc- 前缀类）——宿主没有全局可复用 class（全是 CSS Modules hash 类名），数值对齐第一方 PluginCard（radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16）；全部颜色走 `--dsw-alias-*` tokens，深色主题经 `body[data-ds-dark-theme]` alias 变量自动跟随。注意 `--dsw-alias-accent`/`--dsw-alias-label-error` **不存在**（写了永远走 fallback），用 `state-business-primary`/`state-error-primary`

- **健壮性**：设置路由 GET/POST 容忍非 JSON 响应——报"设置服务返回了非 JSON（HTTP N）"，不再把解析失败误报成"（网络）"

- **浏览器回归目录迁移** `/tmp/dsh-ui-test/` → 仓库外持久目录 `dsh-ui-test/`（/tmp 被系统清空，step9/12/16b/17/18/23 随之丢失）；重建 step20（20 断言）/step22（22）/step24（8）并抽出共享 `_helpers.js`（打开卡片、请求计数、Key 清理、模式切换、`normalizeField`），新增 shot-card/shot-dark 截图脚本；step20/22/24 全绿，verify-bridge 30 项保持全绿

- 测试码新踩坑（已写进 `_helpers.js` 注释）：`page.evaluate` 返回 DOM 元素恒解析为 undefined——存在性断言的 `!!` 必须在 evaluate **内部**；setInput 与 blur 必须分两个任务（同任务 commit 闭包读到旧草稿、静默不保存）；涉及"重置"的断言先 `normalizeField` 归一化——中断的 run 会留覆盖层，重置回的是 schema 默认值而非 run 起始值

- 缓存排查工具链（诊断"命中率只有 40%"）：probe-cache.mjs 新增 `--base`（可经桥对照探测）与 `--effort`；新增 capture-cache.mjs（两会话同 prompt 复刻，配合桥日志）；桥新增 `CODEBUDDY_BRIDGE_DUMP=<dir>` 请求体明文落盘开关（仅本地诊断用，默认关）。结论存档于 AGENTS.md 缓存实测表：链路无责，glm 系缓存条目秒级失效、v3 无缓存

## 0.7.0 (2026-08-17)

- **设置卡流畅度与信息完善**（浏览器回归 step22 锁）：

  - 修复 Enter 保存走两趟 POST+GET：TextField/NumberField 的 Enter 原先先 `commit()` 再 `blur()`，blur 又触发一次 commit；现 Enter 只 blur，提交统一走 onBlur——一次保存严格 1 POST + 1 GET

  - 回归断言：保存不重拉模型目录、不卸载分区组件（滚动位置/未提交草稿/勾选状态跨保存保留）

  - 模型行显示思考档位：静态模型按 cordis.patch.yml `reasoningEfforts` 键名列出（如 `off/low/medium/high/max`），目录新增模型按目录 `reasoning.effort` 显示默认档（`思考:high`）；model-list 响应新增 `staticEfforts` 映射与逐模型 `reasoningEffort`

  - Key 列表排序：使用中置顶，其余按名称字典序（仅展示层，不动存储顺序）

- **修复"设为当前使用"从未生效**：patch 循环用 `hasOwnProperty(Config({}), key)` 做白名单，而 schemastery 对无默认值字段（`activeApiKey`）不物化——切换活跃 Key 的写入被静默丢弃。白名单改查 `SETTINGS_FIELDS`

- **修复搜索/抓取全灭回归**（"搜索报错"根因）：`makeSearchProvider`/`makeFetchProvider` 把**解析后的对象**传给期望 settings 函数的 `callAgentTool`，每次 web\_search/web\_fetch 都抛 `TypeError: settings is not a function`——无网关 code 的"模糊错误"即此。修为传函数；UI 端到端 web\_search 实测恢复

- **错误信息硬化**（callAgentTool）：网络错误带 undici cause 链（ECONNRESET/terminated 等真因，不再是裸 `fetch failed`）；HTTP 错误体是 JSON 时直接嵌入网关 `code`/`msg`（实测：坏 Key → `HTTP 401 {"message":"invalid_format"}`，坏 URL → `HTTP 403 code 15018: url rejected by SSRF safety check…`）

- **识图慢测量结论：插件侧无病理性开销**。新增 `scripts/measure-latency.mjs`（--mock/--real，逐次 JSONL 落盘 + min/p50/p95/max）：mock 下桥聚合/透传开销 ≈5ms、provider 开销 ≈1ms；真实网关 20 次：识图 e2e p50 2.5s ≈ 上游 TTFB p50 2.7s（慢在模型生成，聚合只是等到流尾，不追加耗时），搜索 p50 307ms。真实搜索 20/20 成功

- step20 回归脚本修复两处自身问题：删除 Key 的选择器按 innerText 包含匹配会命中祖先 div、误删其余 Key（已改精确行匹配，此前曾因此清空 apiKeys）；OAuth 区断言改为先切模式再断言，消除起始状态依赖

- **CodeBuddy 生图接入** **`image_generate`** **工具**（ctx.tools 缝，不重复造轮子）：探测（`scripts/probe-media.mjs`，证据落盘 docs/probes/media-2026-08-17.json）发现网关有 OpenAI 形态端点 `POST /v2/images/generations`——`hunyuan-image-v3.0-art` 实测出图（\~22s/张，plain UA 即可，CLI UA 非必需）；dsh 已有 tools 注册缝，工具经 `ctx.inject(['tools'])` 懒注册，随 `imageGenEnabled` 开关注册/注销。schema 必须给**最终 JSON Schema**（defineTool 简写转换器在宿主包内，插件不可 import）。生成图落盘执行上下文工作区（无工作区字段时回退 `$DSH_HOME/generated-images/`）

- **视频/3D 端点探测存档（停止规则）**：`/v2/videos/generations`、`/v2/3d/generations` 路由存在但当前账号一律 14407 `route config not found`（无可用模型），官方 CLI 包内亦无对应客户端调用——证据与结论落盘后不接入

- 设置卡新增"图像生成"分区（开关 + 模型字段），E2E 验证（step23）：agent 真实调用 `image_generate` 画出指定图形并落盘

- **多 Key 轮询**（仅 api-key 模式，OAuth 路径不动）：`apiKeys≥2` 时逐请求轮询；遇 401/403/429/5xx/网络错误在**同一请求内** failover 到下一把，调用方无感（桥 500 failover 后仍 200 SSE）；失败 Key 进冷却（`keyCooldownMs`，默认 60s，设置卡可配），冷却结束自动回到轮换；冷却中其余 Key 全失败时冷却 Key 兜底。统一收口 `withKeyRotation()`，覆盖全部三条出站路径（agenttool 搜索/抓取、流式桥、image\_generate）；单 Key 与环境变量回落行为不变（不重试、不轮换）；单选"使用中"现在仅决定模型目录拉取用的 Key

- 新增 `scripts/verify-rotation.mjs`：离线回归（mock 网关按 Authorization 分 Key 行为表 ok/401/429/500/断连），25 项断言覆盖轮询顺序、请求内 failover、冷却跳过、到期自动恢复、全失败原样报错、单 Key 不轮换、env 回落、OAuth 不轮换、桥路径同样轮换且 failover 透明

- **设置卡视觉打磨**：模型行改单行对齐布局（ctx 缩写 `1000k/50k` 不换行、思考档位完整显示、名称/档位 ellipsis+tooltip 兜底）；"退出登录"从裸红字链改为描边危险按钮；分区说明段落去掉 142px 缩进改全宽（不再挤成窄栏）；分区标题去 `uppercase`（对中文无效）加强层级；会话头格式 select 加宽到 200 完整显示选项；Key 添加表单与列表左对齐。step22 修复起始模式假设（OAuth 起始时 Key 表单不存在直接崩）——先归一化到 api-key、收尾复原

## 0.6.1 (2026-08-17)

- **桥新增请求取证日志**（诊断"重复提问/缓存/额度"用）：设 `CODEBUDDY_BRIDGE_LOG=<jsonl 路径>` 后，桥对每个请求记录入站特征（头集合、body/消息/系统提示哈希、末条用户消息 60 字符预览、session-title/compaction 标记分类）与出站结果（状态、排队等待、首字节/总耗时、上游 usage 含 `prompt_cache_hit_tokens`/`credit`）。不落消息明文，Authorization 只记分类（sentinel/caller-set）；默认关闭

- 新增 `scripts/capture-traffic.mjs`：经 dsh web 回环 RPC（session.create/session.prompt）制造受控主聊天流量（多轮/逐字重发/子代理派生），供桥日志分类

- 新增 `scripts/probe-cache.mjs`：网关缓存对照探测（anon / 会话亲和头 / prompt\_cache\_key / 两者 × 连发），`--model/--arms/--repeat/--calls` 可调

- **诊断结论存档**（docs/diagnosis-cache-quota.md，全部有实测证据）：网关缓存按内容寻址、与会话头/cache key 无关，但按模型分策略（deepseek-v4-pro 有缓存折扣 \~24x，deepseek-v3 全程 0 命中）；"同一提问多次到后端"主因是工具循环全量重发（≈6.1 请求/turn）+ 标题生成 + 子代理，而非重试；v0.7 指纹→会话映射对缓存无收益，否决

- verify-bridge 回归扩到 30 项断言（新增第 7 节取证日志覆盖）

## 0.6.0 (2026-08-17)

- **主聊天路径改经流式桥，OAuth 覆盖模型对话**：`llm-pi-ai` 的 codebuddy `baseURL` 从直连网关改为指向 `http://127.0.0.1:3901/v2`——所有模型请求（对话、搜索、抓取、识图）现在统一由桥按设置卡的登录方式解析凭据（OAuth 令牌或当前 API Key）。此前 OAuth 只覆盖搜索/抓取/桥，主聊天仍走 `CODEBUDDY_API_KEY` 环境引用，"登录了 OAuth 却没用上"即此因

- 实现：patch 不再声明 `apiKeyEnv`（命名了却不存在会 `MISSING_CREDENTIAL`），改为静态 `Authorization: Bearer dsh-codebuddy-bridge` **哨兵头**——pi-ai 只要求"key 或 Authorization 头"（`getClientApiKey` 见头即放行），且 OpenAI SDK 的 `defaultHeaders` 覆盖其 `authHeaders`，线上发出的就是哨兵；桥逐请求替换为真实凭据，哨兵从不出宿主机。（备选"插件运行时写 process.env 哨兵"不可行：dsh 的 launch-environment 是启动时不可变快照）

- 后果请注意：**桥成为主聊天的关键路径**——禁用桥（或改 `bridgePort` 与 patch 不一致）主聊天即断，设置卡已加明示；会话归因/并发管理暂仍只对自带会话 id 的调用方生效（dsh 出站不带会话头，按请求指纹做稳定会话映射留作下一步）

## 0.5.6 (2026-08-17)

- **修复 SessionLimiter 死锁**：`release()` 在计数减到 0 且队列非空时直接返回、从不唤醒排队请求——`maxConcurrentPerSession=1` 下同会话第二个请求永久挂起（连接不返回、队列泄漏）。改为每次释放先取队首唤醒并恢复计数

- **恢复非流式聚合**（0.5.5 回归）：v0.5.5 重构时删掉了"非流式入站 → 聚合成 `chat.completion` JSON"分支，describe-image 等经典调用方拿到的是原样透传的 SSE。现按入站 `stream` 分叉：`stream:true` 透传 SSE，否则（`false` 或缺省）聚合 JSON；路径透传与 A/B 能力不变

- **修复会话头"保留"实为丢弃**：桥重建出站头集合，旧实现发现调用方已设某会话头就整体跳过注入，导致调用方的头根本到不了上游。改为逐头处理：已设置的保留原值，缺失的按会话 id 补全

- 新增 `scripts/verify-bridge.mjs`：离线端到端回归（mock 网关 + 真实桥），覆盖聚合/透传/会话头注入与保留/FIFO 波次完成/limit=1 死锁回归/无会话 id 不限流/agenttool 透传，全部断言**响应完成**而非首字节

- **设置卡重构**（UI 与配置逻辑修正）：

  - 登录区提为**第一区**（一切功能的前提）；概览行改实时数据——可用模型数取宿主 `effectiveCount`，不再硬编码 18

  - 错误横幅修复：成功操作即自动清除、可手动关闭（旧版错误挂顶永不消失）

  - 修 OAuth"登录 CodeBuddy 账号"点了没反应：`window.open` 移回点击事件的同步路径（fetch 回调里异步开窗必被弹窗拦截）；pending 状态改"重新打开登录页"按钮，不再平铺超长 authUrl

  - 模型区展开即自动拉取目录（不再要先找到按钮），列表按"当前可用 / 未启用"分组，勾选语义统一为"是否出现在对话选择器"

  - 找回 0.5.1 丢失的"恢复默认"：字段被文件层覆盖时行内出现"重置"按钮（写 null 删覆盖）

  - TextField/NumberField 草稿随服务端回值同步（保存被规范化后不再困住旧草稿）；"兜底引用名"更名"环境变量引用"

## 0.5.5 (2026-08-17)

- 流式桥升级为**智能代理**（透传 + 会话管理）：`chat/completions` 之外的请求直接透传（`/agenttool/*` 等不再只走专用路径），桥成为统一的网关出口

- **会话归因（A）**：带会话 id 的请求（`X-Conversation-ID`/`X-Session-ID`/`session_id`/请求体 `conversation_id`/`session_id`）自动注入网关会话头——openai 格式 `session_id/x-client-request-id/x-session-affinity` 或 openrouter 格式 `x-session-id`（可选）；调用方已设置时保留。调研存档：llm-pi-ai 的 compat 是白名单（只透传 thinkingFormat/supportsReasoningEffort），pi-ai 内部的会话亲和开关经适配器被剥除，故纯补丁不可行、落在运行时

- **并发管理（B）**：`maxConcurrentPerSession`（默认 4）按会话 id 限制并发，同会话超额请求 FIFO 排队；无会话 id 的请求不限流

- 设置卡流式桥区新增三项：会话归因注入开关、会话头格式选择、每会话并发上限

## 0.5.4 (2026-08-17)

- 模型管理升级为**运行时逐模型启停**：模型列表按当前登录凭据（Key/OAuth）拉取网关目录，每个模型可勾选启用/禁用，勾选即写入 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.codebuddy.models` 覆盖层——对话模型选择器实时刷新（下次请求生效，无需重启）

- 目录中不在插件静态清单的模型（如 glm-4.7、kimi-k2-thinking）可勾选启用，上下文/输出上限/图片输入按目录数据生成条目

- 状态归零（无禁用、无新增）时自动**删除** settings 覆盖层，让配置补丁层重新接管（避免陈旧清单遮蔽插件更新的静态模型）

- 新增 `yaml` 依赖（注释保留的 settings.yaml 文档编辑）；补丁静态清单保持单一事实源（cordis.patch.yml 解析）

- 修复：禁用"目录新增"模型时误写入 disabled 导致覆盖层永不清除

## 0.5.3 (2026-08-17)

- 设置卡按插件功能重构为五区：**模型 / 网络搜索与抓取 / 流式桥 / 登录 / 高级**，顶部新增功能概览行（模型数 · 搜索后端 · 流式桥状态）

- 新增"**获取模型列表**"按钮：实时拉取网关自有目录 `/v3/config`，展示 23 个模型的上下文/输出上限与 图片/CLI/思考 徽标（配置补丁静态清单之外的增删一目了然）

- 网络搜索与抓取新增**一键开关**（`searchEnabled`）：禁用即从 `ctx.web` 注销 codebuddy 后端（web\_search/web\_fetch 报 provider 未注册），开启即时重新注册

- 流式桥一键开关行为不变（禁用即停监听，实测端口随之关闭）

## 0.5.2 (2026-08-17)

- 设置卡 UI 重构为三段式布局（登录 / 网络 / 流式桥），行式字段、分组标题、即时保存

- 登录方式可选：**API Key** 或 **OAuth 登录**（浏览器扫码/账号登录，流程逆向自官方 CLI 并实测：`/v2/plugin/auth/state` 握手 → 浏览器登录 → 轮询 token → 拉取账号；令牌存 `~/.dsh/codebuddy-plugin-auth.json`，到期前自动用 refresh token 续期，单飞锁防并发刷新）

- **多 Key 管理**：设置卡内添加/删除多个 CodeBuddy Key（名称 + 脱敏显示 `ck_a…5678`，原始 Key 不出宿主），单选切换当前使用；未选中时回落到兜底引用名

- 凭据解析统一收口 `resolveCredential()`：agenttool 搜索/抓取、流式桥全部按当前模式取凭据；桥不再透传调用方 Authorization（OAuth 模式下 describe-image 等工具也能用）

- 路由新增 action：`oauth-start` / `oauth-status` / `oauth-logout`，patch 新增 `apiKeysAdd` / `apiKeysRemove`

## 0.5.1 (2026-08-17)

- Web UI"插件配置"页新增 CodeBuddy 设置卡（客户端半 `lib/client.js`，注册 `settings.plugin.item` slot）：六个可选设置，修改即保存、立即生效，覆盖项可一键"恢复默认"

- 设置持久化于 `~/.dsh/codebuddy-plugin.json`（文件层 > 组合配置 > schema 默认值），宿主侧经 `GET/POST /dsh-codebuddy-plugin/settings` 路由读写（同源校验 + schemastery 校验）

- 运行时全面改读活配置：搜索默认条数、抓取正文上限、凭据引用名、网关地址即时生效；流式桥随端口/开关变更自动重启（实测 3901→3902 热迁移）

- 调研结论存档：dsh 组合的两份 `settings` 服务实例使官方命名空间机制对 bundle 入口插件不可达，故采用自建路由（与 dsh-html-visualizer 同模式）

## 0.5.0 (2026-08-17)

- 新增运行时层（index.js，零 npm 依赖）：把 CodeBuddy 网关的 `/agenttool/v1/search` 与 `/agenttool/v1/webfetch` 注册为 dsh `ctx.web` 的 codebuddy 后端，原生 `web_search` / `web_fetch` 工具直接走 CodeBuddy（同一 `CODEBUDDY_API_KEY`，无需 OAuth）

- 补丁新增 `insert` 入口（cordis 入口列表注册，否则 JS 不会被加载——此前纯配置 bundle 不需要）与 `web` 行钉选 `searchProvider/fetchProvider: codebuddy`

- 内置本地流式桥（`127.0.0.1:3901`，`DSH_CODEBUDDY_BRIDGE_PORT` 可改）：网关仅支持流式（非流式报 11101），桥把经典非流式 OpenAI 请求转为流式转发并聚合回标准 JSON，使 describe-image 等工具可以走 CodeBuddy 识图

- 识图端到端实测：Web UI 贴图 → describe-image → 流式桥 → codebuddy/glm-5v-turbo → 正确回答"红色"；web\_search 端到端实测通过

## 0.4.0 (2026-08-16)

- 12 个非 DeepSeek 模型新增可调思考强度（reasoningEfforts），档位经 `--efforts` 逐一实测：glm-5.1 / 5.2 / 5v-turbo、kimi-k2.5 / 2.6、minimax-m3、hy3 / hy3-preview 提供 off~~max（off = 不传参，实测无思考）；kimi-k2.7 / k3 / k3-1、minimax-m2.7 提供 low~~max（默认即思考，不提供 off）

- `verify-models.mjs` 新增 `--efforts [id...]`：逐档探测模型接受度与 reasoning/content 长度，默认探测补丁中未配档位的模型

## 0.3.0 (2026-08-16)

- 模型参数与网关自有目录 `GET /v3/config` 对齐（如 deepseek-v4-pro 上下文/输出 1048576/131072 → 1000000/50000；glm-5.2 上下文 262144 → 1000000；minimax-m3 → 512000/128000）

- 新增 `kimi-k3-1` 与 `glm-5v-turbo`（均实测可用）

- 按目录 `supportsImages` 为 12 个模型声明 `input: [text, image]`

- `verify-models.mjs` 新增 `--sync` 模式：拉取 `/v3/config` 目录，报告参数漂移/目录外旧 id/可纳入的新模型，并生成修正后的 YAML 条目

- README 记录"获取可用模型"失效原因与 `/v3/config` 的认证/UA 要求

## 0.2.0 (2026-08-16)

- README / package.json 同步为实际的 16 个模型（DeepSeek、GLM、Kimi、MiniMax、混元、auto），修正 contextWindow / maxTokens 数值

- 新增模型可用性校验脚本 `scripts/verify-models.mjs`（`npm run verify`，支持 `--list` 离线自检）

- 新增 LICENSE（MIT）与 CHANGELOG

- 初始化 git 仓库（自 Windows 副本迁移）

## 0.1.0 (2026-08-13)

- 初始版本：注册 CodeBuddy provider（`openai-completions`，stream-only，端点 `copilot.tencent.com/v2`），提供 16 个模型，默认模型 `deepseek-v3`

