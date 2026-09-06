# Changelog

## 0.9.4 (2026-09-04)

- **安全审计 30 项确认发现全闭环**（0.9.3 修 3 项，本轮 3 子代理并行修复 25 项 + 2 项记录性接受；发现清单 .audit-27.md 本地留存，不入库）：

  - **providers/trae/gateway.js**：本地翻译网关入站 Host 门（非回环 Host 先 req.resume() 丢体再 403，防 LAN/跨网直连与 DNS rebinding）；SSE reroute 注释行插值清洗（\[\r\n]+ 折叠为单空格，防帧注入）

  - **providers/trae/oauth.js**：三处 finish() HTML 页插值（登录失败 errCode/error\_msg、token 交换 error、异常 message）加 esc() 全转义（& 首位防双转义；pending.error 走 JSON→React 文本节点，保持原文）；deviceId 从 Math.random 换 node:crypto randomInt（16 位首位非零语义不变，无模偏差）

  - **core/bridge.js**：createServer handler 入口 Host 门（provider 无关 hostIsLoopback helper，core 纯净性保持）；回环绑定核实已在位（127.0.0.1）

  - **core/json-store.js**：全部落盘文件 writeFileSync 0600 + 既有文件 chmod 补齐（Windows ENOTSUP 静默忽略）——token/ECDSA 设备私钥/插件文件层/计量统一收紧；resolveEnvKey 删 `new RegExp(拼 envName)` 改逐行字符串解析（regex 注入根除，名字段语义逐点对齐）

  - **index.js**：/dsh-tap/settings GET+POST 统一 localGuardFailure 门（Host 非回环 403——**LAN IP 访问设置卡自此被拒，有意收紧**；带 Origin 时与 Host 不一致 403）；validateBaseURL http 仅回环 hostname 放行（**LAN 明文 http 上游自此拒绝**，错误带原因）；trae dbPath 门（绝对路径 + 无 .. 段 + .db/.vscdb 扩展名）；模型 id 黑名单守卫（__proto__/constructor/prototype 及 `x.constructor` 型子路径，覆盖 setModelEnabled/setModelLimits/setTraeModelEnabled 三条 POST 写入通路）

  - **开发期探测证据脱敏**：原始探测证据（个人/账户标识约 273 处）未纳入开源快照；`CODEBUDDY_ENTERPRISE_ID` 等企业标识均改环境变量注入；docs/rules/trae-surface.md 同源 PII 一并脱敏

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

  - **活文档全量跟随**：README/AGENTS/LICENSE/pitfalls/trae-surface；CHANGELOG 与诊断文档里的历史记载刻意保留原名（记录当时事实）

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

  - 回归：verify-bridge / verify-core-generic / verify-rotation / verify-providers / verify-trae-provider（81 断言）全绿；浏览器 step20（20，基线补 TraeWork CN 分区）/ step22（22）/ step31-trae（12，断言更新为"禁用=块删除"语义）全过；端到端实测——dsh 0.1.1-rc.2 冷启动无 llm-pi-ai 报错、trae 整块自动重铺、禁用↔启用热切换（块删/重铺）、全禁用防护触发、真实三会话联调（跨会话缓存命中 24192 tok）

## 0.8.6 (2026-08-24)

- **逆向漏项重审（round 9）**：用户质疑"trae 3003 是不是逆向漏了什么"驱动；官方客户端当日网络日志取证（`%APPDATA%/TRAE SOLO CN/logs/aha_log/networkservice-*.alaudalog` AALG 容器 zlib 解流）：

  - **结论：逆向无漏**——官方 llm\_utils\_chat 与插件同端点/同认证；官方主聊天走 remote 通道（当日 chat\_sessions 提及 576 次 vs llm\_utils\_chat 20 次），官方自己在事故期也不依赖 inline 面；两域名（trae-api-cn / 官方 307 重定向目标 api5-normal.mchost.guru）同信封实测均 3003 → 域名非解药

  - **官方头组提取 + 逐头二分实测**：version-code 用当日构建号 20260811（插件 20260401）、TTNet 头组、x-request-pin/x-requested-at 等；除 pin 对外**均不改变 3003 行为**

  - **⚠️ x-request-pin 是官方签名校验**：服务端见 pin 头即强制 base64 校验——外部复刻者无官方密钥无法生成合法 pin（官方日志原值直接复用也 400 base64 decode failed）；**插件绝不能伪造 pin**，否则必 400

  - **1005 套餐门纠偏**：同信封同 token 同内容 chat\_v3 曾短暂 1005（extra:{"plan":1}，三模型全中），数分钟内自愈回 200——**单次 1005 不可作账号级套餐判定**（内容二分证伪）；故障期服务端在该域名下有多重不稳定（3003 持续/1005 闪断/base64 波动/超时）

  - **落地增强**：gateway inline 出站 `redirect:'follow'`（跟随官方 307 重定向对齐链路）+ 补 3 个无害指纹头（request-traffic-type/package-type/x-lgw-req-sdk-type）；不伪造 pin 头对

  - 回归：verify-trae-provider 81 断言全绿；实弹验证新头组稳定 200（改派 seed-code-lite）。完整证据链 docs/diagnosis-trae-3003.md §10

## 0.8.5 (2026-08-24)

- **"trae 3003 all models failed / PI\_AI\_ERROR" 故障定位 + 错误面加固**（用户实测报告驱动；证据链 docs/diagnosis-trae-3003.md）：

  - **根因=Trae 服务端 inline\_chat 面模型解析层故障，非插件缺陷**：同凭据同信封对照实验——inline\_chat 对一切 model 名（含默认 kimi-k2.6、含不带 model 字段）一律 SSE error 3003 且无 timing\_cost（服务端未走到选模一步）；chat\_v3 同信封完整对话成功；额度双池充足；4011 限流文案可辨。当日服务端三阶段时变：静默改派任意模型 → 仅非默认模型硬 3003（§5.1）→ 全模型 3003

  - **次要发现**：remote create\_session 间歇性**裸文本 404**（TLB 节点路由漂移，与头组/体无关，分钟级自愈）；高频探测触发边缘 WAF 空体 403（含无凭据请求）；991502 solo\_agent\_parallel\_limit 并发门（僵尸会话占位只能等 TTL）；remote 模型清单默认位变更（solo\_agent\_remote 默认=Doubao-Seed-Code 等）印证服务端当日在大改模型注册表

  - **errors.js**：码表新增 3003/991502 语义；`formatTraeErrorMessage` 对已知码追加可操作处置提示（3003 → 指引切 remote 通道/等服务端恢复）

  - **gateway.js**：三处错误文案统一走 formatTraeErrorMessage——用户再遇 3003 时错误信息可直接自助

  - **remote.js**：createRemoteSession 对裸文本 404/403（边缘漂移指纹，业务拒绝恒为 JSON）自动短退避重试一次（创建失败不产生会话，幂等安全）；持续失败报文带自愈指引

  - 回归：verify-trae-provider 新增 4 断言（mock 云端 3003 → 提示透传 / 首次裸 404 重试成功 / 持续 404 文案带指引 / formatTraeErrorMessage 单元），77 断言全绿；verify:bridge / verify:core / verify:providers / verify:trae / verify-rotation 全绿

  - 规范化诊断脚本（额度池只读查询 + A/B/C/R 对照实验，间隔 ≥20s 纪律）未纳入开源快照，诊断结论完整记录于 docs/diagnosis-trae-3003.md

## 0.8.4 (2026-08-24)

- **修复"登录态有问题"：聊天协议全面校准到真实线上形态**（用户实测报告驱动；无凭据探测 + Trae2api-cn（github.com/autumnsentiment/Trae2api-cn，生产级参照）+ 带凭据联调三源校准）：

  - **登录一直是真的**——实测令牌有效（GetUserInfo 返回完整账号、账号有 500 credits 包）；"假登录"的体感来自聊天信封不对导致的失败链

  - **请求信封重写**：`{messages[content 为 {type,text} 块数组], model, function:"inline_chat", request_id, session_id, stream:true}` + 生成参数/工具透传；三头同 JWT（+x-ide-token）+ `x-app-id`（product.json UUID，≠OAuth client\_id——用错 TCC record not found）+ 数字 version-code + x-request-id/x-uid + 空 UA；设备指纹头与登录上报一致

  - **SSE 语法落实**：metadata/timing\_cost/output/token\_usage/done 事件；**response/reasoning\_content 是累计快照**——createTraeStreamParser 前缀差分（直接当增量会大面积重复）；排队（request\_wait\_in\_queue/position）提示一次；工具调用（tool\_calls/tool\_call\_info）按 id 累积转 OpenAI tool\_call 流

  - **模型改派诚实披露**：服务端按 function/套餐改派模型（inline\_chat→kimi-k2.6，与请求 model 无关；真值源 timing\_cost.provider\_model\_name）——网关以 SSE 注释行 `: trae-reroute` 告知（不污染调用方历史）、计量记真实模型、非流式 message.note 标注

  - 账号昵称字段修正（ScreenName）；联调脚本同步校准（--chat 用真实信封）

  - 回归：verify-trae-provider **51 断言**（mock 云端说真实语法：累计快照/事件名/改派/排队/工具）；**真实端到端实测通过**——dsh 网关路径流式（皮亚诺公理回答、usage 61 tok）与非流式（"成功了"+served-by note）双绿

  - 已知限制存档（trae-cloud-api.md §5.1）：限流 4011 紧（联调间隔 ≥20s）；/api/ide/v1/chat 老端点 4023 拒现代模型名；remote 协议（真手动模型选择）是 agent 形态、留作后续课题

- **Trae remote 传输：模型切换真实生效**（2026-08-24 下午，用户诉求"可以切换模型"驱动；探测矩阵定论）：

  - **raw 面模型路由被 function 位钉死（终局证伪）**：inline\_chat 只服务账户默认模型，非默认 model 名一律 3003 "all models failed"（custom\_model 无效；当日上午的静默改派为服务端时变行为，两态兼容）；chat\_v3/solo\_agent\_lite 恒 seed-code-lite、solo\_work\_lite 恒 glm-5.2——任意 model 名都 200 但 timing\_cost 证实改派

  - **新传输** **`providers/trae/remote.js`**：remote 会话协议（`POST /api/remote/v1/chat_sessions`：initial\_message.model\_name + `model_selection_strategy:"manual"` + agent\_type solo\_agent\_remote + content 空数组/历史扁平化进 query → `GET …/events` SSE → stop 善后）；事件解析器 createRemoteEventParser（plan\_item 按 id 分槽累计差分：thought=正文/reasoning\_content=思考；finish 工具 params.summary 兜底去重补发；model\_config/done.model\_info 双源确认真实模型；token\_usage→usage；queuing 提示一次）；glm-5.3 真线实测路由+自报双重确认

  - **网关接线**：设置 `traeChatTransport`（inline 默认 / remote）逐请求分发；remote 模式耗 **work 额度池**且不支持 OpenAI tools（远端 agent 自持工具）——带 tools 请求明确 400 remote-no-tools 不静默降级；计量记 model\_config 真实模型

  - **额度双池实证**：`ide_user_ent_usage` 按 available\_endpoint 分池（0=IDE/raw、1=work/remote）；3 次 remote 会话后 work 池 +9.4 credits、IDE 池不动；Free 账号 kimi-k3 触发 error 1005 套餐门（message 空 + data.plan，errors.js 空 message 按码表回填语义）

  - 设置卡 TraeWork CN 分区新增"聊天传输"选择行；回归 verify-trae-provider **73 断言**（mock remote 云端：创建体/web 头组/事件流翻译/聚合/tools 拒绝/stop 善后 + 解析器边界单测）

## 0.8.3 (2026-08-23)

- **v0.8.1→0.8.3 直达：TraeWork CN 订阅额度通道**（目标"从 dsh 消耗 Trae 订阅额度"；本轮三个里程碑按 CHANGELOG 三条目推进，一次交付）

  - **联调与取证基建**：真实设备流登录 + 登录后立即 DeviceProof 刷新自证（令牌只打掩码）；经网关请求构造器直打真实 `llm_utils_chat` 校准信封/事件语法；`--sig der|raw` DeviceProof 签名编码切换；`TRAE_BRIDGE_LOG` 网关取证日志

  - **协议事实归档**：无凭据在线探测（mchost 聊天网关 401/1001、ExchangeToken 双路径 10101 两层、GetUserInfo 20310）+ harness.dll 协议面提取（agent/v3 路由族、llm\_utils\_chat 信封字段、双认证头组、BYOK 直连证据）+ 本地 harness 备选架构存档（懒启动/加密 DB/run\_helper，未采用的原因）+ trae2api 历史协议交叉证据；逐条标注置信度，联调路径单点化（buildChatRequest / parseTraeEvent），校准结论内联在 providers/trae/ 各模块文件头

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

- **v0.8 Goal 落地：额度可见 + 模型动态化 + 多服务商凭据中心**：

  - **G1/G2 OAuth 真实登录 + token×端点矩阵**：真实浏览器登录落地（`authMode:"oauth"`）；八组真实 token 探测确立——token 权限 = `ck_` key 严格超集（`/billing/meter/*` 为 OAuth-only）；**找到数值剩余额度 API** `/billing/meter/get-user-resource`（CapacityRemainPrecise/资源包明细，两域名同构、Bearer 直达，推翻"plan API 走 cookie 体系进不去"旧结论，quota-signals.md R-Q7）；refresh 轮换不作废旧令牌（R-O6，expiresIn 60 天）；修复 `refreshOAuth` 读错字段名（refreshExpiresAt→refreshExpiresIn，良性）

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

  - `providers/codebuddy/`（薄适配器）：`headers.js`（CLIENT\_HEADERS 逐字段规则/迷信判定——ua-validation.md §3：仅 UA 的 `codebuddy/含点版本段` 是规则，余皆迷信但为零行为变更保留）、`errors.js`（网关错误码语义表 11101/12403/14401/14407/11102/11103/11128/10001/11217/12153，逐条引规则文档）、`oauth.js`（设备流 + 单飞刷新，X-No-\* 迷信头标注）、`catalog.js`（/v3/config 目录 + /v2/accounts + dosage 额度方言）、`agenttool.js`（search/webfetch；**删除实测死路径** `data?.usage` 计量——quota-signals.md R-Q2 实证 agenttool 响应体无计量字段）、`images.js`（生图工具；images 响应 usage 未经证伪，计量路径保留）

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

- 额度信号在线探测（accounts/dosage-notify/chat 响应头扫描）；同日实测确认 **WorkBuddy OAuth 与 CodeBuddy 同构**（`www.workbuddy.cn/v2/plugin/auth/state` 返回同形态 `{state, authUrl}`，product.json `internalDomain` 互含）——额度共享无需单独通道

- verify-bridge 回归扩到 42 项断言（新增第 8 节用量计量：16 请求×0.01 credit 逐数断言 totals/today/recent/turns/落盘格式；第 9 节 EADDRINUSE：占端口后第二实例进程存活、路由仍答、桥状态报 EADDRINUSE、第一实例照常服务）；新增浏览器回归 step25（分区存在/顺序、额度文案、桥状态行、经桥注入真实小请求后轮询自动刷新计数、21s 静默窗轮询 ≥2 次）

## 0.7.1 (2026-08-18)

- **设置卡迁移 dsh 原生 UI 资源**（不改宿主、不改第三方包）：require 平台 seed 模块 `dsh-client-ui-primitives`（Button/Input/图标），require 失败 try/catch 回落原生元素，卡片永不白屏；样式按宿主协议注入单个 `<style data-plugin data-plugin-css>`（cbc- 前缀类）——宿主没有全局可复用 class（全是 CSS Modules hash 类名），数值对齐第一方 PluginCard（radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16）；全部颜色走 `--dsw-alias-*` tokens，深色主题经 `body[data-ds-dark-theme]` alias 变量自动跟随。注意 `--dsw-alias-accent`/`--dsw-alias-label-error` **不存在**（写了永远走 fallback），用 `state-business-primary`/`state-error-primary`

- **健壮性**：设置路由 GET/POST 容忍非 JSON 响应——报"设置服务返回了非 JSON（HTTP N）"，不再把解析失败误报成"（网络）"

- **浏览器回归目录迁移** `/tmp/dsh-ui-test/` → 仓库外持久目录 `dsh-ui-test/`（/tmp 被系统清空，step9/12/16b/17/18/23 随之丢失）；重建 step20（20 断言）/step22（22）/step24（8）并抽出共享 `_helpers.js`（打开卡片、请求计数、Key 清理、模式切换、`normalizeField`），新增 shot-card/shot-dark 截图脚本；step20/22/24 全绿，verify-bridge 30 项保持全绿

- 测试码新踩坑（已写进 `_helpers.js` 注释）：`page.evaluate` 返回 DOM 元素恒解析为 undefined——存在性断言的 `!!` 必须在 evaluate **内部**；setInput 与 blur 必须分两个任务（同任务 commit 闭包读到旧草稿、静默不保存）；涉及"重置"的断言先 `normalizeField` 归一化——中断的 run 会留覆盖层，重置回的是 schema 默认值而非 run 起始值

- 缓存排查工具链（诊断"命中率只有 40%"）：网关缓存对照探测（可经桥对照、reasoning effort 分档）与两会话同 prompt 缓存复刻，配合桥日志；桥新增 `CODEBUDDY_BRIDGE_DUMP=<dir>` 请求体明文落盘开关（仅本地诊断用，默认关）。结论存档于 AGENTS.md 缓存实测表：链路无责，glm 系缓存条目秒级失效、v3 无缓存

## 0.7.0 (2026-08-17)

- **设置卡流畅度与信息完善**（浏览器回归 step22 锁）：

  - 修复 Enter 保存走两趟 POST+GET：TextField/NumberField 的 Enter 原先先 `commit()` 再 `blur()`，blur 又触发一次 commit；现 Enter 只 blur，提交统一走 onBlur——一次保存严格 1 POST + 1 GET

  - 回归断言：保存不重拉模型目录、不卸载分区组件（滚动位置/未提交草稿/勾选状态跨保存保留）

  - 模型行显示思考档位：静态模型按 cordis.patch.yml `reasoningEfforts` 键名列出（如 `off/low/medium/high/max`），目录新增模型按目录 `reasoning.effort` 显示默认档（`思考:high`）；model-list 响应新增 `staticEfforts` 映射与逐模型 `reasoningEffort`

  - Key 列表排序：使用中置顶，其余按名称字典序（仅展示层，不动存储顺序）

- **修复"设为当前使用"从未生效**：patch 循环用 `hasOwnProperty(Config({}), key)` 做白名单，而 schemastery 对无默认值字段（`activeApiKey`）不物化——切换活跃 Key 的写入被静默丢弃。白名单改查 `SETTINGS_FIELDS`

- **修复搜索/抓取全灭回归**（"搜索报错"根因）：`makeSearchProvider`/`makeFetchProvider` 把**解析后的对象**传给期望 settings 函数的 `callAgentTool`，每次 web\_search/web\_fetch 都抛 `TypeError: settings is not a function`——无网关 code 的"模糊错误"即此。修为传函数；UI 端到端 web\_search 实测恢复

- **错误信息硬化**（callAgentTool）：网络错误带 undici cause 链（ECONNRESET/terminated 等真因，不再是裸 `fetch failed`）；HTTP 错误体是 JSON 时直接嵌入网关 `code`/`msg`（实测：坏 Key → `HTTP 401 {"message":"invalid_format"}`，坏 URL → `HTTP 403 code 15018: url rejected by SSRF safety check…`）

- **识图慢测量结论：插件侧无病理性开销**。延迟测量（mock/真实网关，逐次落盘 + min/p50/p95/max）：mock 下桥聚合/透传开销 ≈5ms、provider 开销 ≈1ms；真实网关 20 次：识图 e2e p50 2.5s ≈ 上游 TTFB p50 2.7s（慢在模型生成，聚合只是等到流尾，不追加耗时），搜索 p50 307ms。真实搜索 20/20 成功

- step20 回归脚本修复两处自身问题：删除 Key 的选择器按 innerText 包含匹配会命中祖先 div、误删其余 Key（已改精确行匹配，此前曾因此清空 apiKeys）；OAuth 区断言改为先切模式再断言，消除起始状态依赖

- **CodeBuddy 生图接入** **`image_generate`** **工具**（ctx.tools 缝，不重复造轮子）：探测发现网关有 OpenAI 形态端点 `POST /v2/images/generations`——`hunyuan-image-v3.0-art` 实测出图（\~22s/张，plain UA 即可，CLI UA 非必需）；dsh 已有 tools 注册缝，工具经 `ctx.inject(['tools'])` 懒注册，随 `imageGenEnabled` 开关注册/注销。schema 必须给**最终 JSON Schema**（defineTool 简写转换器在宿主包内，插件不可 import）。生成图落盘执行上下文工作区（无工作区字段时回退 `$DSH_HOME/generated-images/`）

- **视频/3D 端点探测存档（停止规则）**：`/v2/videos/generations`、`/v2/3d/generations` 路由存在但当前账号一律 14407 `route config not found`（无可用模型），官方 CLI 包内亦无对应客户端调用——证据与结论落盘后不接入

- 设置卡新增"图像生成"分区（开关 + 模型字段），E2E 验证（step23）：agent 真实调用 `image_generate` 画出指定图形并落盘

- **多 Key 轮询**（仅 api-key 模式，OAuth 路径不动）：`apiKeys≥2` 时逐请求轮询；遇 401/403/429/5xx/网络错误在**同一请求内** failover 到下一把，调用方无感（桥 500 failover 后仍 200 SSE）；失败 Key 进冷却（`keyCooldownMs`，默认 60s，设置卡可配），冷却结束自动回到轮换；冷却中其余 Key 全失败时冷却 Key 兜底。统一收口 `withKeyRotation()`，覆盖全部三条出站路径（agenttool 搜索/抓取、流式桥、image\_generate）；单 Key 与环境变量回落行为不变（不重试、不轮换）；单选"使用中"现在仅决定模型目录拉取用的 Key

- 新增 `scripts/verify-rotation.mjs`：离线回归（mock 网关按 Authorization 分 Key 行为表 ok/401/429/500/断连），25 项断言覆盖轮询顺序、请求内 failover、冷却跳过、到期自动恢复、全失败原样报错、单 Key 不轮换、env 回落、OAuth 不轮换、桥路径同样轮换且 failover 透明

- **设置卡视觉打磨**：模型行改单行对齐布局（ctx 缩写 `1000k/50k` 不换行、思考档位完整显示、名称/档位 ellipsis+tooltip 兜底）；"退出登录"从裸红字链改为描边危险按钮；分区说明段落去掉 142px 缩进改全宽（不再挤成窄栏）；分区标题去 `uppercase`（对中文无效）加强层级；会话头格式 select 加宽到 200 完整显示选项；Key 添加表单与列表左对齐。step22 修复起始模式假设（OAuth 起始时 Key 表单不存在直接崩）——先归一化到 api-key、收尾复原

## 0.6.1 (2026-08-17)

- **桥新增请求取证日志**（诊断"重复提问/缓存/额度"用）：设 `CODEBUDDY_BRIDGE_LOG=<jsonl 路径>` 后，桥对每个请求记录入站特征（头集合、body/消息/系统提示哈希、末条用户消息 60 字符预览、session-title/compaction 标记分类）与出站结果（状态、排队等待、首字节/总耗时、上游 usage 含 `prompt_cache_hit_tokens`/`credit`）。不落消息明文，Authorization 只记分类（sentinel/caller-set）；默认关闭

- 经 dsh web 回环 RPC（session.create/session.prompt）制造受控主聊天流量（多轮/逐字重发/子代理派生），供桥日志分类

- 网关缓存对照探测（anon / 会话亲和头 / prompt\_cache\_key / 两者 × 连发），模型/分组/重复次数可调

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

