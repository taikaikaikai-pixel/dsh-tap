# Goal：桥端口按宿主环境分流（web UI 线 / 桌面 GUI 线）

> 执行模式：长任务 goal。本文只定义**角色、意图、边界与验收**；实现路径由执行 agent 在边界内自主决定。
> goal 写法参照 GitHub 官方 agentic-workflows 范式（`githubnext/agentics`）+ 本仓库 desktop-adaptation.md 同构：
> **角色定位 + 意图/为什么 + 分阶段意图（非逐行指令）+ 已验证事实 + 未知数（探测先行）+ 产出契约 + 边界 + 裁判纪律**。
> 必读裁判依据：`AGENTS.md`（全部踩坑）+ `docs/rules/*.md` + `host-config.js` 头注释 + `docs/goals/desktop-adaptation.md`（desktop 接入全案）。
> 进展记录：每完成一个 G 项，在 `docs/rules/STATE.md` 追加一段。
> 状态：**已落地（G3–G7 一轮完成，0.16.0）**（2026-10-03：desktop Qoder 3913 / Trae 3912 独立监听、web 3902/3903 不变，机制证据 docs/probes/port-split-2026-10-03.json、G5 共存端到端证据 docs/probes/coexist-e2e-port-split-2026-10-03.json——desktop 经 3913 真实聊天、关 web 后桌面独立成立、web 重启两线各自持桥零 EADDRINUSE；G6 离线九套件全 PASS；G7 文档四件套同日收尾）。
> 驱动：用户要求"window 版本的适配，版本控制分 web ui 还有 Gui"；0.15.1 已修诊断口径（借桥不再报成故障），本 goal 消除借桥本身。

## 角色与使命（why）

你是 dsh-tap 的**宿主分流负责人**。现状：desktop（Electron GUI，:19387）与 web（:3090）是**两个进程、共享同一份配置** `~/.dsh/codebuddy-plugin.json`，桥端口写死（`bridgePort:3901`/`traeBridgePort:3902`/`qoderBridgePort:3903`）。两实例同跑时先占方持有桥、后到者 `EADDRINUSE` 退避、聊天路由先占方——**桌面 GUI 的 Qoder/Trae 可用性绑死在 web 实例在线**（用户关掉 web，桌面这两条通道就瘫）。

你的使命：让桥端口**按宿主环境分流**——web 线与桌面 GUI 线各自独立监听、互不借桥，桌面成为能独立站立的应用。这是 0.15.x desktop 适配的自然延伸（从"装得上/看得见/用得了"到"独立得了"）。

## 意图（要达成什么，而非怎么做）

1. **桌面独立**：desktop 的 Qoder/Trae 网关监听自己的端口（**3902→3912、3903→3913**），不再借 web 的桥；web 线端口不变（3901/3902/3903）。
2. **互不干扰**：web 与 desktop 同跑，各自持有各自桥，零 EADDRINUSE、零借桥；一方关停不影响另一方通道可用。
3. **CodeBuddy 桥 3901 暂不动**（主聊天入口，分流动到默认模型路由，面最大风险最高；验证 Qoder/Trae 分流成立后再议是否纳入）。
4. **零回归**：web 线行为与端口完全不变；desktop 既有适配（0.15.x 落地）不破。

## 已验证事实（立项前实测，2026-10-03，出处标注）

| 事实 | 出处 |
|---|---|
| 三端口字段：`bridgePort` 默认 3901（index.js:108）、`traeBridgePort` 3902（:136）、`qoderBridgePort` 3903（:155），schema 可编辑 | `index.js:108/:136/:155` |
| 镜像 baseURL **跟随端口**：qoder `http://127.0.0.1:${qoderBridgePort}/v1`（:982）、trae 同构（:1083）——改端口重铺镜像即热生效 | `index.js:982/:1083` |
| 桥启停按 `s.<port>` 对账：`apply()` 读 `s.bridgePort/traeBridgePort/qoderBridgePort` 决定 listen（:1954/:1992/:2029），EADDRINUSE 落 `lastError` 不炸 | `index.js:1954/:1992/:2029` |
| `localAllowedOrigins` 字段已落地（0.15.0）：通用白名单，`localGuardFailure`/`sameOrigin` 消费，desktop 文件层 `["dsh-app://app"]` 三连实测 200/200/403 | `index.js:116/:1404`、CHANGELOG 0.15.0 |
| 共享配置根：`DSH_HOME = process.env.DSH_HOME ?? ~/.dsh`（:82），web/desktop 共用 ⇒ **"按宿主不同端口"不能写进这份共享配置**（两进程读同一份仍撞） | `index.js:82` |
| desktop 宿主 = Electron 专管，`dsh --profile desktop` 被 CLI 拒（`rejectElectronProfile`，bin.js:36）；host 进程命令行含 `dsh-desktop-host/lib/index.js` 与 desktop profile 目录 | dsh bin.js:36、desktop 端到端证据 |
| 借桥实证：web(:3090, PID 26028) 先占 3901/3903，desktop 桥 EADDRINUSE 让位、聊天路由先占方 | `docs/probes/desktop-e2e-2026-10-03.json`、STATE.md |

## 核心设计约束（必须想清再动手）

**配置文件共享 ⇒ 端口必须按"运行时宿主"解析，不是按配置写死。** 两个进程读同一份 `codebuddy-plugin.json`，若分流值写进配置，两进程读到同一份还是会撞端口。故端口解析 = 进程启动时判定"我是谁（web 还是 desktop）"，再决定监听哪个端口。**"我是谁"的可靠信号是本 goal 第一未知数（U1）**——候选（须实测哪个可靠，勿凭记忆选）：

| 候选信号 | 依据 | 风险 |
|---|---|---|
| profile 目录/名 | desktop host 命令行含 `…\profiles\desktop`；web 实例跑 `profiles\web` | 插件进程能否读到自身 profile 名待证 |
| 宿主注入的环境变量 | desktop host 可能注入标识（Electron/ELECTRON_RUN_AS_NODE 等） | 未实测是否存在稳定变量 |
| 进程命令行 | host 命令行含 `dsh-desktop-host/lib/index.js` | 依赖宿主实现细节，脆 |
| 运行时 Origin | 设置路由见过 `dsh-app://app`（desktop）vs 浏览器 Origin（web） | 只在请求时有，启动期 listen 时无 |

**原则**：分流逻辑收进**组合根的端口解析处**（index.js 读取 `s.<port>` 的单一入口），归一为一个"解析有效端口"的函数；宿主差异按 desktop-adaptation 同款纪律收口，**不撒 `if (desktop)` 分支**（§4a 静态守卫口径延续）。

## 顶层未知数（探测先行，勿凭记忆动手）

| # | 未知数 | 决定什么 |
|---|---|---|
| U1 | 插件进程可靠区分"我是 web 还是 desktop"的信号（见上表四候选） | 端口解析机制是否可行、怎么写 |
| U2 | 分流转置后，desktop 的镜像 baseURL（:982/:1083）是否自动跟随 3912/3913，还是需显式重铺 | 镜像写回步骤 |
| U3 | desktop 的 Origin 白名单是否需随新端口调整（`dsh-app://app` 已 allowlist；3912/3913 的 Host 回环门是否照常） | Origin 白名单改动面 |
| U4 | 用户已有配置（`qoderBridgePort:3903` 等）如何迁移：web 读 3903、desktop 读 3913 的共存语义 | 迁移与兼容 |

## 产出契约（每阶段必须交付什么）

- **G1 侦察报告**：回答 U1——实测出可靠的宿主区分信号（给出证据：desktop/web 两进程各自的信号取值）；U2/U3/U4 一并探明。**只读**，证据落 `docs/probes/`。
- **G2 分流方案**：端口解析机制（归一函数 + 信号判定）+ 迁移语义 + Origin 白名单 + 镜像写回改动点；经一次**独立评审**（换人、读过相关代码）再实施。
- **G3 端口解析落地**：归一"解析有效端口"函数，desktop 进程监听 3912/3913、web 进程仍 3902/3903；index.js 无 desktop 特化分支（§4a 口径）。
- **G4 Origin 白名单 + 镜像写回**：desktop 新端口的镜像 baseURL 正确（3912/3913），Origin 门对新端口照常；`?probe=host-config` 在两实例各自全绿。
- **G5 共存端到端**：web 与 desktop **同跑**，各自持有各自桥（netstat 实证 3902/3903 与 3912/3913 分属两进程），零 EADDRINUSE；desktop 独立（关掉 web 后 desktop 的 Qoder/Trae 仍可用）；桌面 Qoder 真实聊天出正文。
- **G6 回归**：离线套件全绿（含 `verify-desktop-acceptance`，如需为其补"分流端口"断言则同步）；`dsh-ui-test/` 全绿、零真实写入对账；诊断卡在分流后不再出现"另一实例代管"（因不再借桥）。
- **G7 文档收尾**：wiki/AGENTS.md（守预算闸门）/CHANGELOG/STATE.md；端口分流语义写入设置卡 HelpNote 或 wiki；release 打 annotated tag 推送。

## 边界（非目标）

- **不分 CodeBuddy 桥 3901**（主聊天入口；验证 Qoder/Trae 分流成立后再单独立项）。
- 不改 desktop patch 里用户手写块；不动 `core/`、`providers/` 上游事实层。
- 不做"配置真正按 profile 隔离"（那是更大的架构改动；本 goal 只做"端口按运行时宿主解析"）。
- 不追 web 线任何行为变化——web 端口与默认值**完全不变**。

## 裁判纪律（执行 agent 必须遵守）

- **勿凭记忆改**：宿主信号以 G1 实测为准，不猜；网关行为以 docs/rules/*.md 为准。
- **写入永不 reject**（踩坑 #33）；**零真实写入**（回归 md5 对账）。
- **index.js 无 desktop 特化分支**（§4a 静态守卫延续，分流归一函数收口）。
- **真实探测红线**：单账号、1.5s+ 间隔、只读优先、证据落 docs/probes/。
- **遇阻升级而非伪造**：宿主信号判定不可靠就如实上报，不硬选。
- **分支纪律**：长期分支只有 main；release 当场打 annotated tag 推送；永不 rebase 已推送历史。

## 验收标准

1. **端口分流**：desktop 进程的 Qoder/Trae 网关监听 3912/3913，web 进程仍 3902/3903；`netstat` 实证两实例各自持有各自端口。
2. **零借桥**：web 与 desktop 同跑零 EADDRINUSE；诊断卡 Qoder/Trae 行显示"运行中 127.0.0.1:391x"（desktop 侧），不再出现"另一实例代管"。
3. **桌面独立**：关掉 web 实例后，desktop 的 Qoder/Trae 仍监听且真实聊天出正文。
4. **Origin + 镜像**：desktop 新端口的镜像 baseURL 正确（`?probe=host-config` providerIds/baseURL 对平），Origin 门对新端口照常（陌生 Origin 403、白名单放行）。
5. **零回归**：web 线端口与行为完全不变；离线套件 + `dsh-ui-test/` 全绿、零真实写入；index.js 无 desktop 特化分支（§4a 绿）。
6. **文档四件套**更新到位，release 打 tag 推送。
