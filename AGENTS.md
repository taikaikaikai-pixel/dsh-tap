# AGENTS.md — dsh-tap 开发指南

面向在本仓库工作的 AI 编码 agent（以及未来的你自己）。本文只放"每次都要的"薄索引：定位、架构、通则、命令、文档地图。**所有"为什么"都在下层文档**——网关事实全表 docs/rules/gateway-facts.md、踩坑全本 docs/pitfalls.md、版本史 CHANGELOG.md、模块叙述 wiki/01-architecture.md ~ 10-provider-qoder.md；别凭记忆改，按文末文档地图去读。本文预算 ≤150 行 / ≤12KB，CI 硬闸门锁定（踩坑 #52）。

## 项目是什么

把腾讯 CodeBuddy 网关（`copilot.tencent.com`）接入 DeepSeek Harness（dsh）的插件：23 个模型静态兜底 + `/v3/config` 目录动态同步、本地流式桥、`web_search`/`web_fetch`/`image_generate` 后端、Web UI 设置卡（4 区块通道手风琴）；另两条订阅上游 TraeWork CN（:3902）与 Qoder CN（:3903）翻译网关，加 7 家 key 型 OpenAI 兼容服务商。纯 ESM，Node ≥ 22。版本沿革见 CHANGELOG.md。

## 三层架构（改动时先想清楚落在哪层）

| 层 | 文件 | 职责 | 裁判文档 |
|---|---|---|---|
| 静态配置 | `cordis.patch.yml` | provider 路由指向本地桥 + 模型清单 + web 钉选 + `insert` 入口 | wiki/01-architecture.md |
| 组合根 | `index.js` + `host/**` + `host-config.js` | 入口与 apply 生命周期（≤1200 行）+ `host/`：config/runtime/redact、providers 单例与登记册、models 状态与镜像、**channels 通道描述符清单**、settings 路由/动作/patch/视图（host-config 按宿主版本选路） | wiki/02-composition-root.md + wiki/11-add-a-channel.md |
| 凭据边缘层 | `core/` | **provider 无关**：json-store / rotation / usage-meter / quota-cache / fetch-guard / **net-guard（回环门唯一实现）** / **http-surface（本机 HTTP 面脚手架）** / **errors（错误出口契约）** / bridge；禁止任何 CodeBuddy 特化（verify-core-generic 锁） | wiki/03-core-layer.md |
| 上游适配器 | `providers/codebuddy/` | CodeBuddy 全部网关事实：headers/errors/oauth/catalog/agenttool/images | docs/rules/ + wiki/04-provider-codebuddy.md |
| 上游适配器 | `providers/trae/` | TraeWork CN：自持设备密钥 OAuth / state.vscdb 目录 / 翻译网关 :3902 | docs/reverse/ + wiki/05-provider-trae.md |
| 上游适配器 | `providers/qoder/` | Qoder CN：PKCE 设备流 / COSY WASM 签名 / 加密信封翻译网关 :3903 | docs/goals/qoder-cn-provider-design.md + wiki/10-provider-qoder.md |
| 多服务商 | `providers/openai-compat.js` + `ark`/`bailian`/`deepseek`/`bigmodel`/`moonshot`/`openrouter`/`qwen` | key 型上游共享骨架 + 每上游 preset（热加载免重启） | docs/rules/extra-providers.md + wiki/06-provider-openai-compat.md |
| 浏览器半 | `lib/client.js` | 设置卡（4 区块通道手风琴；宿主 UI 原语 + cbc- 样式；刷新生效注意缓存） | wiki/07-web-client.md |

改动生效方式：静态配置、组合根、core、codebuddy 适配器 = 重启 dsh（desktop 宿主 = 退出并重启桌面应用）；trae/qoder 网关端口域名热生效、patch 路由改动重启；多服务商热加载；浏览器半刷新页面。

设置数据流：设置卡 → `POST /dsh-tap/settings`（自有路由）→ `~/.dsh/codebuddy-plugin.json`（文件层）→ `Config({entry, file})` 活解析。OAuth 令牌单独存 `~/.dsh/*-plugin-auth.json`，**永不回传浏览器**（key 也只回脱敏 `ck_a…5678`）。

## 网关事实通则（全表：docs/rules/gateway-facts.md，改上游行为前必读）

- `/v2/chat/completions` **仅流式**（非流式报 11101）；网关无 `GET /models`（404，dsh 内置"获取可用模型"对本网关永远失效）。
- `/agenttool/v1/*` 与 `/v3/config` 要求 **CLI 形态 UA**（`CodeBuddyCode/1.0` 被拒 12403）。
- pi-ai 会把推理模型的 system prompt 序列化成 `role:"developer"`——桥/翻译网关出站一律重写 developer→system。
- **目录有 ≠ /v2 可路由**：恒 11102 的条目不铺静态清单，`providers/codebuddy/catalog.js` 的 `UNROUTABLE_MODELS` 是唯一真源。
- 严格上游（Qoder dmodel/kmodel/mmodel）把 `content:null`/缺键消息当"不存在"——出站必须做可见性归一 + tool 配对体检（踩坑 #39/#41）。

## 踩坑速查（全本含代价与修复：docs/pitfalls.md；动手前先 grep 对应编号）

`#1` bundle入口insert · `#2` 双settings实例 · `#3` 客户端模块加载 · `#4` hooks规则 · `#5` 合成事件 · `#6` 模型同步纯净态 · `#7` 错误带原因 · `#8` 增删插件重启
`#9` 禁import宿主包 · `#10` 断言响应完成 · `#11` 启动环境快照 · `#12` schema白名单 · `#13` tools最终schema · `#14` 工厂传函数 · `#15` UI原生化 · `#16` puppeteer三坑
`#17` listen挂error · `#18` 槽位keyed化 · `#19` dump真实字节 · `#20` 实例状态非全局 · `#21` 坏块毒化全层 · `#22` 逆向非协议真相 · `#23` 无存量token · `#24` harness懒启动
`#25` 路由存在性管理 · `#26` 响应整体脱敏 · `#27` useRef同值去重 · `#28` 禁逐分片拼接 · `#29` socket必消费 · `#30` 0.1.5三变更 · `#31` 原子写落盘 · `#32` 去重失败销账
`#33` 异步生命周期 · `#34` 0.1.6拆槽 · `#35` curl中文GBK · `#36` wasm头是Map · `#37` 未知key改派 · `#38` fixture禁绝对日期 · `#39` 孤儿tool消息 · `#40` 计数器分辨率
`#41` content:null不可见 · `#42` 能力声明≠线值 · `#43` 0.1.7配置换代 · `#44` 写入即重载 · `#45` 写完≠生效完 · `#46` 可信按键 · `#47` 主题属性驱动 · `#48` fullPage空操作
`#49` 模块改名静默跳过 · `#50` 预言机覆盖率 · `#51` 剪贴板权限 · `#52` 本文无锁增长 · `#53` checkbox命中面走label
`#54` 桌面组合不合并bundle的codebuddy块·接入手放完整块
`#55` cordis传apply的entry恒含schema默认·显式判定须比对默认
`#56` 壳转发剥Origin头·curl模拟≠壳内真实请求·同源门须留无-Origin语义
`#57` wasm retptr-first栈槽错一位静默全废·兜底分支须断言被走过
`#58` wasm堆对象不受GC管·__wbg_*_free不调即无界泄漏·free须幂等
`#59` 并发闸release只在finally一处·分支顺手释放即击穿上限
`#60` SSE重试判据是用户可见内容·writeHead与角色chunk分步
`#61` 回环网关须Host+Origin双门·无-Origin放行（壳转发/非浏览器）
`#62` 令牌刷新读-改-写与logout竞态·存储代际守卫落盘前校验
`#63` 同类防护跨子面成对审计·单侧覆盖断点即缺陷
`#64` 目录有声明≠宿主有入口·档位表须投影进镜像且路由声明compat
`#65` 确定性安全门按通用Web建模误拦回环网关·git门须留豁免通道
`#66` 宿主reasoningEfforts键固定枚举·越界键静默整块拒收·写后读回/lastError
`#67` 环境探测路径勿写死单平台形态·发现空结果须配原因出口
`#68` 同端点不同function面各有出站方言·历史tool_calls键按面实测·proto错念proto字段名
`#69` 瞬时状态挂一次性拉取通道·陈旧徽标即谎言·上游文案勿进CSS
`#70` 渠道校验可拦system精确句·改UA/加头无用·只扫system且整句判定·出站须改写
`#71` 宿主重试只看failure.code·Retry-After被pi-ai丢弃·固定30s须initial=max·429排队/额度同码靠消息分QUOTA
`#72` 装饰挂进截断盒必被裁·trigger徽标换锚点到button·旧锚点content:none成对关·:has降级成对
`#73` 拒绝面高频探测=账号风控封禁（403/11140）·目录面200≠聊天可用·封禁期零请求先申诉
`#74` composer.dock≠input.dock·无会话不渲染·容器无定位须自建锚点
`#75` 瞬时失败别置死闩·`#76` 响应出口须幂等·`#77` 登录态/网关态走结构化字段·`#78` 上游fetch必带超时
`#79` 错误信封有两条契约别合并·`#80` 回环门只留一份实现·`#81` 413须先排空再应答
`#82` `?case=`复制不了依赖模块的单例状态·`#83` 静态闸门别写死文件路径·`#84` 通道扩展点须四方对账

## 常用命令（probe/联调/取证脚本的用法注释见 wiki/09-run-and-test.md）

```sh
dsh web
npm run verify            # 全部离线回归：自动发现 scripts/ 下的 verify- 套件（新增零登记）
npm run verify:live       # 在线模型探测（18 次真实请求，耗额度——CI 与离线闸门都不跑它）
node scripts/verify-gateway-core.mjs   # 只跑本机面：回环门矩阵 / HTTP 脚手架 / 错误契约 / 监听生命周期
node scripts/verify-models.mjs --list  # 只列模型（离线）
CODEBUDDY_BRIDGE_LOG=/tmp/bridge.jsonl dsh web
```

## 浏览器回归

全套知识（套件清单与断言基线 / 区块驱动口径 / 实例与 token / 零真实写入纪律）在项目 skill `.agents/skills/dsh-ui-regression/`——跑 UI 回归前先加载它。

## 文档地图（改哪类代码，先读哪份）

- 改 CodeBuddy 出站行为（headers/UA/错误码/目录/额度/缓存/审核）→ docs/rules/ 对应专题：routing、ua-validation、quota-signals、prompt-cache、content-moderation、dev-role-boundary、oauth-handshake；错误码表在 providers/codebuddy/errors.js
- 接入新的 key 型 OpenAI 兼容上游 → docs/rules/extra-providers.md；加一条**通道**（本机网关+目录+设置卡区块）→ wiki/11-add-a-channel.md
- 改 Trae 通道 → docs/reverse/traework-cn.md + trae-cloud-api.md（目录提取另见 trae-model-catalog.md）；错误码表在 providers/trae/errors.js
- 改 Qoder 通道 → docs/goals/qoder-cn-provider-design.md + wiki/10-provider-qoder.md
- 排查"缓存命中率低/重复提问" → docs/diagnosis-cache-quota.md + docs/diagnosis-cache-decline.md；"trae 3003" → docs/diagnosis-trae-3003.md；Qoder "provider_error / Flash 不可用" → docs/diagnosis-qoder-flash.md；CodeBuddy "API 密钥无效 / 全模型失败" → docs/diagnosis-codebuddy-11140.md
- 跑命令/测试/浏览器回归 → wiki/09-run-and-test.md + skill `.agents/skills/dsh-ui-regression/`
- 要原始实测证据 → docs/probes/（历次探测 JSON/JSONL 落盘）
- 要架构与模块叙述 → wiki/01-architecture.md ~ 10-provider-qoder.md
- 要某版本改了什么 → CHANGELOG.md；要课题交接状态 → docs/rules/STATE.md

## 维护纪律

- 本文是薄索引，不铺长段落：新实测事实 → docs/rules/gateway-facts.md（或对应专题）；新坑 → docs/pitfalls.md 取新编号 + 本文踩坑速查加一个 `#N` 标签；命令/probe 用法 → wiki/09-run-and-test.md；浏览器回归知识 → `.agents/skills/dsh-ui-regression/`。
- 体积与口径由断言锁维护：本地 `node scripts/verify-agents-md.mjs`（行数/字节/引用路径/踩坑编号连续性），CI 双闸门（`agents-md lint` + `alint`，见 .github/workflows/node.js.yml）。**不写会增长的硬编码口径**（如"踩坑 #1–#48"）。
- **上游探针纪律（防风控封禁，代价见踩坑 #73）**：对同一上游的**拒绝面**（4xx 语义探测）串行发、间隔 ≥20s、**单轮 ≤3 发**；命中一次拒绝就停手记录，不"再发几发确认"；看到 11140 封禁则**零请求**、先申诉。健康检查只打用户实际使用的面（目录面 200 ≠ 聊天面可用）。细节见 wiki/09-run-and-test.md。
- 版本历史只写 CHANGELOG.md，不在本文铺章节。
- Git 纪律：长期分支只有 `main`；每次 `chore(release)` 当场打 annotated tag `vX.Y.Z` 并随分支推送；**永不 rebase 已推送历史**（CHANGELOG 引用提交 SHA）。细则见 docs/rules/STATE.md「分支拓扑」。
