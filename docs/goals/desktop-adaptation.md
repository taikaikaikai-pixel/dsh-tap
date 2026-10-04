# Goal：dsh-tap 适配 dsh 桌面版（desktop profile）

> 执行模式：**workflow 驱动的长任务 goal**。本文是 goal 的唯一真源——定义角色、意图、边界与产出契约；
> 执行由一个 dynamic-workflow 承载（阶段化子代理 + 确定性闸门），实现路径由执行子代理在边界内自主决定。
> goal 输入写法参照 GitHub 官方 agentic-workflows 范式（`githubnext/agentics` 的 `daily-repo-goals.md`）：
> **角色定位 + 意图/为什么 + 分阶段意图（非逐行指令）+ 发现优先级准则 + 产出契约 + 边界**——把判断力留给模型。
> 必读裁判依据：`AGENTS.md`（全部踩坑）+ `docs/rules/*.md`（网关实测事实，勿凭记忆改）+ `host-config.js` 头注释（0.1.7 配置换代全案）。
> 进展记录：每完成一个 G 项，在 `docs/rules/STATE.md` 追加一段（沿用既有格式）。
> 状态：**G3–G6 已落地（2026-10-03 接入实施，见文末「实施实测」节）；G7 文档收尾同日完成。**

## 角色与使命（why）

你是 dsh-tap 的**桌面版适配负责人**。仓库现状：插件只在 web profile（`:3090` 那套 Web UI）跑通并全量回归；本机已存在 desktop profile 但**没有安装 dsh-tap**。你的使命是让插件在桌面版里**装得上、看得见、用得了**，且 web 侧零回归。

这不是一次机械执行——desktop 侧的启动方式、UI 壳形态、宿主基座版本**都是未知数**，需要你以探测先行、证据落盘的方式边测边定。仓库的裁判纪律（勿凭记忆改、写入永不 reject、零真实写入）在桌面侧同样生效。

## 意图（要达成什么，而非怎么做）

1. **装得上**：desktop profile 能装载 dsh-tap，且不破坏其现有手写块（Ark / agent-default-model / ui-settings-account 等，并存不接管）。
2. **看得见**：设置卡在 desktop UI 壳内正常渲染与交互（4 区块手风琴全量可用）。
3. **用得了**：三通道（CodeBuddy / Trae / Qoder）与多服务商在 desktop 实例真实可用。
4. **零回归**：web 侧七个离线套件 + `dsh-ui-test/` 全绿；新增宿主差异全部收进 `host-config.js` 选路 / UI 候选兜底，index.js 无 desktop 特化分支。

## 已验证事实（立项前实测，2026-10-03，出处标注）

| 事实 | 出处 |
|---|---|
| desktop profile 已存在：`~/.dsh/profiles/desktop/{package.json, cordis.patch.yml, cordis.yml, pnpm-workspace.yaml}`；bundles = `dsh-base` + `dsh-web-app` + `agent-team-profile`，**dependencies 为空、无 dsh-tap** | 本机文件系统 |
| desktop patch 已有用户手写块：Ark(volces, anthropic-messages, 7 模型)、`agent-default-model → deepseek-account/deepseek-flash`、ui-settings-account；**与 codebuddy 块零交集** | `desktop/cordis.patch.yml`（providers 键实测枚举 = 仅 `volces`） |
| ~~desktop 运行时 = `dsh-base@0.1.7-rc.2`（共享 `~/.dsh/profiles/node_modules/`，pnpm hoisted）~~ **已被 recon 推翻（2026-10-03）**：宿主子进程从 asar 跑 `dsh-base@0.2.0-rc.2`；`profiles/node_modules` 的 0.1.7-rc.2 属 web 侧。seam 同代性不能凭版本号外推，须活体验证——`?probe=host-config` 实测 `mode=forms`、`formsWritable=true`，同代成立 | recon（宿主进程探查）+ 活体 probe（2026-10-03） |
| 插件 bundle patch 静态钉选路由 + `insert` 入口，UI 双槽注册（`plugins.item` + 旧槽回退），由 `host-config.js` 按宿主能力选路 | `cordis.patch.yml` / `index.js` / `host-config.js` |
| npm 上的 `dsh@1.0.1` 是 2016 年同名无关包（"A shell written in JavaScript"），与 deepseek 的 dsh 无关——**别被 dist-tag 误导** | npm registry 元数据（2026-10-03 查） |
| 本机 Node = v24.19.0（≥22 满足） | `node --version` |

## 后续补记（2026-10-04）：volces 路由补 `reasoningEfforts`（宿主「推理等级」入口）

用户报「输入框里有些模型没有思考强度」——宿主 composer 模型菜单的「推理等级」**只由模型条目的 `reasoningEfforts` 决定**（pi-ai `resolveModelReasoning` → `reasoningInfo` → `reasoning.efforts[]`；完整投影链与判据见踩坑 #64）。desktop patch 的 volces 路由原有 7 个模型里只有 `deepseek-v4.1-flash`/`ark-code-latest` 声明了档位；2026-10-04 用 Ark `/api/plan/v1/messages` 逐模型实测后补齐其余 5 个：

| 模型 | 实测（baseline / enabled / disabled） | 补的声明 |
|---|---|---|
| `glm-5.3-flash`、`glm-5.3` | 思考默认开；`thinking:{type:enabled,budget_tokens}` 接受；**`thinking:{type:disabled}` 400 `InvalidParameter`**（"thinking.type `disabled` is not supported by this model"） | `low/medium/high/max`（**无 off**） |
| `kimi-k3`、`doubao-seed-evolving`、`doubao-seed-2.1-lite` | 思考默认开；`enabled` 接受；`disabled` 200 且 thinking 块为空（真关思考） | `off:null` + `low/medium/high/max` |

- **`off` 必须逐模型裁**：pi-ai 对 anthropic 方言的 off 线值就是发 `thinking:{type:disabled}`（`anthropic-messages.js:902`）——给拒 disabled 的模型声明 off 等于摆一个必然 400 的档位；`off` 键缺省时 `map.off` 为 null、不发 disabled，退化为"不带 thinking 参数"= 上游默认（照常思考），安全。
- **边界（未定论）**：Ark 侧档位映射 pi-ai 预算表（low 2048 / medium 8192 / high 16384 / max 夹到 high），而这些模型是**自适应思考**——2 采样/档位下多数看不到单调差异（`glm-5.3` 2048→1713 / 16384→2219 有；`glm-5.3-flash`、`kimi-k3`、`doubao-seed-2.1-lite` 无）⇒ 档位更像"上限"而非"强度旋钮"；`disabled` 是硬效果。
- 备份 `cordis.patch.yml.pre-effort-20261004.bak`；生效 = **重启桌面应用**（profile patch 属启动期加载）。补齐后 volces 7/7 出档。

## 顶层未知数（探测先行，勿凭记忆动手）

| # | 未知数 | 决定什么 |
|---|---|---|
| U1 | desktop 怎么启动（命令/参数/端口）；UI 是 Electron 原生壳还是浏览器开 web 套 | 联调与回归驱动方式 |
| U2 | desktop UI 壳是否消费 `plugins.item` 槽（Plugin Manager 卡片落点是否同 web） | 设置卡可见性与 UI 适配面 |
| U3 | 宿主基座版本是否完全等于 web 侧（seam 行为 / 图标导出 / UI 原语是否一致） | host-config 是否需新增选路分支 |
| U4 | 把 dsh-tap 接入 desktop 的正路（dependencies 加 `link:` + bundles 追加，还是另有机制） | 接入步骤与持久化 |
| U5 | 凭据/桥端口在 desktop 下是否与 web 冲突（`:3901/:3902/:3903`、共享 `~/.dsh/*-plugin-auth.json`） | 共存纪律 |

## 产出契约（每个阶段必须交付什么）

- **G1 侦察报告**：回答 U1–U3；desktop 启动方式 + UI 壳形态 + 接触面子包逐包 diff 结论；证据落 `docs/probes/desktop-baseline-<日期>.json|md`。**只读**，不改任何文件。
- **G2 适配方案**：基于 G1 事实给出 U4/U5 的接入与共存方案，标注改动点与风险。方案须经一次**独立评审**（换人复审，读过相关代码）再实施。
- **G3 接入落地**：desktop profile 装载 dsh-tap，patch 落点正确，现有手写块完好。
- **G4 组合根适配**：`attach(ctx)` 与 `host-config.js` 在 desktop 正确选路；`?probe=host-config` 全绿。
- **G5 端到端**：三通道真实可用（CodeBuddy 桥聊天出正文为基线）。
- **G6 回归**：`npm run verify` + 七离线套件绿；`dsh-ui-test/` 按 desktop 壳形态适配后绿（零真实写入对账）。
- **G7 文档收尾**：wiki / AGENTS.md（守 ≤150 行/≤12KB 闸门）/ CHANGELOG / STATE.md 更新；release 打 annotated tag 推送。

## 边界（非目标）

- 不改 desktop patch 里用户手写块（并存，不接管）。
- 不做 desktop 专属新功能（托盘、原生通知）——本 goal 只做适配。
- 不动 `core/`、`providers/` 上游事实层（除非 G5 实测发现 desktop 特有行为，且归位到适配层）。
- 不追 web 侧既有已知限制（旧槽无宿主实测等，见 settings-card-ux-redesign.md §0）。

## 裁判纪律（执行子代理必须遵守）

- **勿凭记忆改**：网关行为以 `docs/rules/*.md` 为准；动手前 grep 对应踩坑编号。
- **写入永不 reject**（踩坑 #33）：fire-and-forget 必须落地，失败记 `lastError`。
- **零真实写入**：回归跑前跑后 `~/.dsh/codebuddy-plugin.json` 哈希对账；真实网关探测遵守探测红线（1.5s+ 间隔、单账号、只读优先、证据落 `docs/probes/`）。
- **遇阻升级而非伪造**：闸门过不去、指令互相矛盾、或需要只有用户才知道的事实时，明确上报，不要绕过或编造通过。
- **分支纪律**：长期分支只有 `main`；`chore(release)` 当场打 annotated tag 并推送；**永不 rebase 已推送历史**（STATE.md「分支拓扑」）。

## 验收标准

**可执行验收锚点**：`node scripts/verify-desktop-acceptance.mjs` 把下列标准逐条变成机器可判断言（CI 硬闸门）。A 组离线结构性不变量任何环境可跑；B 组桌面环境断言有 desktop profile 才跑；C 组活实例断言由探针/GUI 套件承担、脚本诚实标 SKIP 不伪造。

1. desktop 实例 `?probe=host-config` 全绿，设置卡可见可用。
2. 三通道 desktop 下真实可用（G5 口径），多服务商热加载生效。
3. web 侧零回归：七离线套件 + `dsh-ui-test/` 全绿（含零真实写入对账）。
4. 宿主差异全部收进 `host-config.js` 选路 / UI 候选兜底，index.js 无 desktop 特化分支。
5. 文档四件套更新到位，release 打 tag 推送。

## 实施实测（2026-10-03，G3–G6 接入落地，出处 = 当日活体命令与输出）

| G 项 | 结果 | 关键事实（全部当日实测） |
|---|---|---|
| G3 接入 | **落地** | desktop CLI（`resources/runtime/cli/bin/dsh.cmd`，ELECTRON_RUN_AS_NODE shim）`plugin --profile desktop add C:/Users/21613/dev/dsh-tap`：`dependencies.dsh-tap = link:…` 与 `dsh.profile.bundles` 追加**两落点均自动写好**（无需手工补）；link 实落 `profiles/desktop/node_modules/dsh-tap`（symlink → 仓库，`realpathSync` 实证），非根 hoist |
| G4 活体 | **全绿** | 冷启动后 `?probe=host-config`：`mode=forms`、`formsWritable=true`、`applies=live`、`allNamespaces` 含 `llm-pi-ai`、`legacySettingsPath=C:\Users\21613\.dsh\settings.yaml`（**DSH_HOME 未漂移**）、`attachError=null`。0.2.0-rc.2 的 settings seam 仍是 configure/describe/mutate 形态 ⇒ **host-config.js 零改动**（预写分支=凭记忆改，未发生） |
| G4 排障 | **新发现** | 首启 `providerIds=[volces,qoder]`、`lastError=ERR: llm-pi-ai: provider "codebuddy" model "default" needs an api`——**bundle patch（仓库 cordis.patch.yml）的 codebuddy 块未合并进桌面组合树**，镜像 `syncModelsToDshSettings` 只 set `providers.codebuddy.models` 子路径 ⇒ 合并树中 codebuddy 路由无 `api` ⇒ 0.2.0-rc.2 的 llm-pi-ai 校验拒绝、mutate 回滚（qoder 整块带 api 所以过了）。修复 = 按 web 用户层同构先例**手放 codebuddy 完整块**到 desktop patch（装机步骤，见 pitfalls #54），重启后 `lastError=null`、`providerIds=[volces,qoder,codebuddy]` |
| G4 Origin 门 | **实测命中→兜底落地** | 带-Origin 的 GET（零写入，守卫对 GET/POST 一体设防）：`Origin: dsh-app://app` → **403**（同源对照 200、无 Origin 200）。按方案风险 3 兜底级实施：index.js 通用 `localAllowedOrigins` 配置字段（默认空 = 行为不变，零 desktop 字样，过 §4a/§4b）+ `localGuardFailure`/`sameOrigin` 两门消费（精确匹配，Host 回环门不变）；desktop 侧文件层写入 `["dsh-app://app"]` 后三连 = 200/200/陌生 Origin 403。**注意**：壳内是否真的透传 `dsh-app://app` Origin 未实测（需壳内页面发起）——若不透传则无 Origin 本就放行，allowlist 冗余但无害 |
| G5 端到端 | **两通道出正文** | CodeBuddy 桥（经 :3901，先占方为 web 实例进程）`glm-5.3-flash` 真实聊天 `content:"成功"` + `finish_reason:"stop"`；Qoder 网关（:3903）`qfmodel` 流式 reasoning 正文在途。Trae 按用户设置 `traeEnabled=false` 保持禁用，未测（不代开）。OAuth 壳内 `window.open` 行为未实测（当前 OAuth 已登录、无握手需求） |
| G6 回归 | **全绿** | 离线九套件（models/host-config 36/core-generic/rotation/providers/trae 89/qoder 154/desktop-acceptance **9 ok·0 FAIL**/agents-md 预算）+ `dsh-ui-test/`：card-accordion **200**、qoder-slot-check **13**、qoder-tab-phase2 **11** 全绿，`~/.dsh/codebuddy-plugin.json` md5 跑前跑后恒 `c5cff30c…`。UI 套件跑在 :3090（web 实例，`lib/client.js` 本轮未改） |

共存实测：web 实例（`dsh web --port 3090`）与桌面实例并存，桥端口 3901/3903 由**先起方**持有（当日 web 先占），后起实例桥 EADDRINUSE 落 lastError 不炸、聊天路由到先占方桥（凭据同源功能等价）——与 G2 方案共存纪律 ② 预言一致。凭据/镜像文件全共享，`codebuddy-plugin.json` 全程只有一次预期内写入（`localAllowedOrigins` 字段，字段级 diff 归因）。三手写块（volces/agent-default-model/ui-settings-account）与 2026-10-01 注释逐行原样（diff 备份实证）。
