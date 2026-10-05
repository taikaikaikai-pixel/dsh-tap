# dsh-tap

[![Node.js CI](https://github.com/taikaikaikai-pixel/dsh-tap/actions/workflows/node.js.yml/badge.svg)](https://github.com/taikaikaikai-pixel/dsh-tap/actions/workflows/node.js.yml)
[![Release](https://img.shields.io/github/v/tag/taikaikaikai-pixel/dsh-tap?sort=semver&label=release)](https://github.com/taikaikaikai-pixel/dsh-tap/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-blue)

DeepSeek Harness（dsh）的**非官方上游插件包**：把三个模型上游接入 dsh 的对话模型选择器与工具链，并自带 Web UI 设置卡。纯 ESM、无构建步骤，Node ≥ 22。

| 上游 | 版本 | 凭据方式 | 本地网关 | 模型目录来源 |
|------|------|----------|----------|--------------|
| **CodeBuddy**（腾讯 `copilot.tencent.com`，默认通道） | v0.1.0 起 | OAuth（推荐）或 API Key（多把 Key 逐请求轮询 + 失败冷却） | 流式桥 `127.0.0.1:3901` | 网关 `/v3/config` 动态同步 + 静态兜底清单 |
| **TraeWork CN**（字节 TRAE SOLO CN 订阅额度） | v0.8.x 起 | 自持 ECDSA P-256 设备密钥的 OAuth 设备流 | OpenAI↔Trae 翻译网关 `127.0.0.1:3902` | 本机 state.vscdb 只读提取 |
| **Qoder CN**（阿里 qoder.cn 订阅额度） | v0.9.7/0.9.8 起 | PKCE S256 设备流 OAuth | OpenAI↔COSY 加密信封翻译网关 `127.0.0.1:3903` | 签名 `GET /algo/api/v2/model/list` |

另含 **key 型 OpenAI 兼容上游注册表**：预设火山引擎 Ark、阿里云百炼、DeepSeek、智谱 BigModel、Moonshot AI、OpenRouter、Qwen Code 7 家，或自定义（id + baseURL）+ API Key，模型统一进对话选择器、免重启。

## 快速开始

### 安装

```sh
# 本地路径安装（把本插件装进 web profile）
dsh plugin --profile web add /path/to/dsh-tap

# 或从 GitHub 安装
dsh plugin --profile web add github:taikaikaikai-pixel/dsh-tap
```

安装后重启 `dsh` 进程生效。dsh ≥ 0.1.6 在侧栏「插件」→ Plugin Manager → dsh-tap 打开设置卡；更旧宿主在 Settings → 插件配置 → dsh-tap。

### 凭据

- **CodeBuddy**：设置卡 CodeBuddy 区块「凭据」组切换登录方式。**OAuth 登录**（推荐）= 浏览器完成官方登录页授权，无需任何环境变量，令牌自动续期；**API Key** = 卡内添加一把或多把 Key（多把自动轮询 + 失败冷却），或写 `~/.dsh/.credentials.yaml` 的 `CODEBUDDY_API_KEY` / 同名环境变量兜底。
- **TraeWork CN**：启用通道（区块头开关）→「凭据」组登录（浏览器授权一次）→ 模型自动出现。
- **Qoder CN**：「凭据」组登录（浏览器授权）→ 区块头启用通道 → 模型自动出现。

三家凭据分别存 `~/.dsh/codebuddy-plugin-auth.json`、`~/.dsh/trae-plugin-auth.json`、`~/.dsh/qoder-plugin-auth.json`，永不回传浏览器；API Key 只回脱敏显示（`ck_a…5678`）。

### 默认行为

装好即生效：静态补丁把 CodeBuddy provider 路由指向本地流式桥（默认模型 `deepseek-v3`）、`web_search`/`web_fetch` 钉选 CodeBuddy 后端、注册 `image_generate` 生图工具；三家目录在启用/登录后自动同步进选择器。所有主聊天与工具请求经本地网关统一收口凭据，调用方不自带密钥。

## 模型

**清单默认动态化**：CodeBuddy 通道启动时自动从网关 `GET /v3/config` 同步目录（目录新模型自动出现），网关不可达时无感回落下表静态清单，选择器绝不变空；设置卡各通道「模型」组可手动「同步目录」、逐模型启停、行内调节上下文/输出上限。

静态兜底清单 **23 个模型**（2026-09-22 按网关目录对齐尺寸；下表为该快照，运行时以目录同步结果为准）：

| 模型 | 厂商 | contextWindow | maxTokens | 图片 |
|------|------|---------------|-----------|------|
| deepseek-v3 | DeepSeek | 131072 | 32768 | — |
| deepseek-v3.2 | DeepSeek | 131072 | 32768 | — |
| deepseek-r1 | DeepSeek | 131072 | 32768 | — |
| deepseek-v4-pro | DeepSeek | 1000000 | 128000 | ✔ |
| deepseek-v4-flash | DeepSeek | 1000000 | 50000 | ✔ |
| deepseek-v4.1-flash | DeepSeek | 1000000 | 128000 | ✔ |
| deepseek-v3-2-volc | DeepSeek | 96000 | 32000 | — |
| glm-5.1 | 智谱 | 200000 | 48000 | ✔ |
| glm-5.2 | 智谱 | 1000000 | 64000 | ✔ |
| glm-5.3 | 智谱 | 1000000 | 64000 | ✔ |
| glm-5.0-turbo | 智谱 | 200000 | 48000 | — |
| glm-5v-turbo | 智谱 | 200000 | 64000 | ✔ |
| kimi-k2.5 | Moonshot | 164000 | 32000 | ✔ |
| kimi-k2.6 | Moonshot | 256000 | 32000 | ✔ |
| kimi-k2.7 | Moonshot | 256000 | 32000 | ✔ |
| kimi-k3 | Moonshot | 262144 | 32768 | — |
| kimi-k3-1 | Moonshot | 1000000 | 32000 | ✔ |
| minimax-m2.7 | MiniMax | 200000 | 48000 | ✔ |
| minimax-m3 | MiniMax | 512000 | 64000 | ✔ |
| hy3 | 腾讯混元 | 192000 | 64000 | ✔ |
| hy3-x | 腾讯混元 | 192000 | 64000 | ✔ |
| hy3-preview | 腾讯混元 | 262144 | 32768 | — |
| auto | 自动路由 | 262144 | 32768 | — |

**思考强度**：逐模型行内下拉（存 `effortByModel`，出站注入 `reasoning_effort`，请求方显式携带时不覆盖）。档位来源 = 网关目录新形态能力清单（`supportedEfforts`/`canDisableThinking`）∪ 静态实测表（2026-09-22 162 臂复测，证据 `docs/probes/codebuddy-efforts-matrix-2026-09-22.json`）。`off` 档只在"省略参数即不思考"的真开关模型上出现——`canDisableThinking:true` 不等于存在可靠的关思考拼写，插件不臆造线值。TraeWork CN / Qoder CN 通道的档位由各自目录**逐模型声明**驱动（设置卡与宿主「推理等级」同一真源）；Trae 声明了 extra_high 的模型另有 `max` 上位档（目录不声明但上游实测接受，2026-10-05 探针）。多采样复证结论：**档位入口不报错 ≠ 高档位一定思考更多**，不应把档位当强度旋钮用。

注意：**dsh 内置的"获取可用模型"对本网关永远无效**——CodeBuddy 网关没有 OpenAI 风格的 `GET /models`（404）。目录里存在 ≠ `/v2` 可路由（`glm-4.6v`/`kimi-k2-thinking`/`minimax-m2.5`/`hy4-preview-x` 恒报 11102，刻意不进静态清单）。

## 工具

### 网络搜索与网页抓取

dsh 原生 `web_search` / `web_fetch` 被接到 CodeBuddy 网关的 `/agenttool` 端点（与官方 CLI 同源，索引较新），凭据复用 CodeBuddy 登录态。补丁已钉选 codebuddy 后端，无需配置；临时切回其他后端可设 `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER`。

| 设置 | 默认 | 说明 |
|------|------|------|
| 一键开关 `searchEnabled` | 开 | 禁用即注销 codebuddy 后端，开启即时恢复 |
| 搜索默认条数 `searchMaxResults` | 5 | `web_search` 未指定时（1–20） |
| 抓取正文上限 `fetchBodyCap` | 200000 | `web_fetch` 返回正文字符上限 |

### 图像生成

`image_generate` 按提示词出图（约 20 秒/张，模型 `hunyuan-image-v3.0-art`，走 `/v2/images/generations`），PNG 落盘会话工作区（无工作区时 `~/.dsh/generated-images/`）。开关 `imageGenEnabled`（默认开）。

### 识图（describe-image）

标注"图片 ✔"的模型接受 `image_url` 输入。装了 `@linxin666/dsh-web-ui-all` 时，Web UI 贴图会经 describe-image 工具走视觉端点——该工具发非流式请求，而 CodeBuddy 网关只支持流式（非流式报 11101），流式桥为此把非流式请求转流式再聚合成标准 JSON。在 dsh 侧配置（dsh ≤ 0.1.6 写 `~/.dsh/settings.yaml`；0.1.7+ 写 profile 的 cordis patch）：

```yaml
describe-image:
  baseURL: http://127.0.0.1:3901/v2
  model: glm-5v-turbo
  apiKeyEnv: CODEBUDDY_API_KEY
  apiStyle: chat-completions
```

## 设置卡

v0.10.0 起是**四区块通道手风琴**：`CodeBuddy → TraeWork CN → Qoder CN → 通用`，默认全部收起，首屏即四条状态行（登录态 / 模型数 / 网关端口 / 额度与服务商数；warn/err 就地出现在所属区块头，不展开也读得到）。展开后按 `凭据 → 模型 → [工具] → 网关 → 高级` 分组（只有 CodeBuddy 有「工具」组），修改即保存、立即生效。展开才挂载、收起不卸载——草稿与已拉目录跨收起保留。

设置持久化在 `~/.dsh/codebuddy-plugin.json`（优先级：该文件 > 插件组合配置 > 默认值）。模型启停/上限等宿主侧写入经 `host-config.js` 按宿主版本选路：**dsh 0.1.7+ 写 profile 的 cordis patch**（Settings forms seam），**≤0.1.6 写 `~/.dsh/settings.yaml`**。

### 登录与凭据（CodeBuddy）

- **API Key 模式**：多把 Key 逐请求轮询，遇 401/403/429/5xx/网络错误自动在同一请求内换下一把，失败 Key 冷却 `keyCooldownMs`（默认 60000ms）后自动回到轮换；单选仅决定目录拉取用的 Key，全不选时回落环境变量引用。
- **OAuth 模式**：浏览器完成 `copilot.tencent.com/login` 授权，插件轮询握手（约 10 分钟超时），完成后显示账号昵称与令牌到期时间，到期前自动续期。流程与官方 CLI 一致。

### TraeWork CN 通道：聊天传输档

启用并登录后，设置卡 TraeWork CN 区块可切换**聊天传输**（逐请求热读取，改档免重启）：

| 传输 | 状态 | 工具环 | 说明 |
|------|------|--------|------|
| **agent**（默认） | 可用 | ✔ 含并行调用 | 走 `llm_utils_chat` 的 `solo_work_lite` 面。如实标注：模型位钉死 glm-5.2（选择器里的模型名可发出但实际由 glm-5.2 服务）、reasoning_effort 不生效、消耗 IDE 额度 |
| remote | 可用 | ✘ | 纯文本对话；思考档位在该面生效（light/high/extra_high，extra_high 模型另有 max） |
| inline | **服务端 3003 故障中**（2026-08 起未愈） | — | 纯文本也不可用，插件侧无解；详见 `docs/diagnosis-trae-3003.md` |

### 服务商注册表（通用区块）

- 添加时先实测 `GET /models` 验证 key 并拉目录；无 `/models` 的上游自动改用最小 chat 探针 + 内置清单兜底；公开目录型（OpenRouter）走 chat 探针验 key + 静态精选目录。
- provider 块落宿主配置层（同上选路），key 落 `~/.dsh/.credentials.yaml`（权限 0600，只回脱敏显示）；每行可"刷新模型"与"删除"（连同凭据一起清）。
- **本机凭据扫描**：只读扫描本机已装 agent 工具的登录态文件，检测到可导入的即提示"一键导入"（不可导入的命中不罗列）——逐个确认的显式动作，扫描绝不回传任何 secret 值。

### 额度与用量（通用区块）

展开时 10s 轮询、收起即停：

- **消耗量（精确）**：桥对每个请求的网关 `usage.credit` 恒开计量（搜索/抓取/生图同样入账），持久化在 `~/.dsh/codebuddy-plugin-usage.json`；展示今日/累计 credit 与请求数、最近轮次（含缓存命中率）。
- **账户额度信号**：套餐类型与企业名（`GET /v2/accounts`）、额度不足告警文案（`get-dosage-notify`）。
- **数字剩余额度（OAuth 模式）**：`/billing/meter/get-user-resource`（每分钟缓存）；api-key 模式不开放，改显"手填总额 − 本插件计量累计"的估算值并标注。
- **网关状态**：运行中 / 端口占用（EADDRINUSE）/ 已禁用。

### 流式桥（CodeBuddy 网关）

| 设置 | 默认 | 说明 |
|------|------|------|
| 启用 `bridgeEnabled` | 开 | **禁用即停本地监听，主聊天随之中断** |
| 端口 `bridgePort` | 3901 | 须与 cordis.patch.yml 的 baseURL 端口一致，否则主聊天断 |
| 会话归因注入 `sessionHeadersEnabled` | 开 | 按入站会话 id 补全会话头；调用方已设置的头保留原值 |
| 会话头格式 `sessionHeaderFormat` | openai | `openai` 或 `openrouter` |
| 每会话并发上限 `maxConcurrentPerSession` | 4 | 同会话超额 FIFO 排队；无会话 id 不限流 |

桥在 127.0.0.1 是统一出口与**唯一凭据入口**：流式入站透传 SSE、非流式入站聚合为标准 JSON，其余路径（如 `/agenttool/*`）原样透传。端口被占用时只告警不崩溃。Trae/Qoder 翻译网关同理：启用通道即起在 3902/3903（`traeBridgePort`/`qoderBridgePort` 可调），禁用/退出即停。

## 开发与验证

### 校验套件（除 `npm run verify` 外全部离线、mock 上游；断言数以各脚本自身输出为准）

| 命令 | 覆盖 |
|------|------|
| `node scripts/verify-models.mjs --list` | 离线自检模型解析（当前 23 条） |
| `node scripts/verify-models.mjs --sync` / `--efforts [id…]` | 在线目录漂移对比 / 档位探测（消耗额度） |
| `npm run verify` | 在线逐模型真实探测（消耗额度） |
| `npm run verify:bridge` | 流式桥端到端（mock 网关，断言响应完成） |
| `npm run verify:rotation` | 多 Key 轮询 / 冷却 / failover |
| `npm run verify:core` | `core/` provider 无关性证伪（静态纯净扫描 + 第二上游全链路） |
| `npm run verify:providers` | 多服务商骨架（/models 404 兜底 + 认证方言 + 档位声明透传） |
| `npm run verify:trae` | Trae 目录提取（vscdb 发现 / 归一 / 投影） |
| `npm run verify:trae-provider` | Trae 通道全链路（目录/档位/传输档/额度/prefs 路由） |
| `npm run verify:qoder` | Qoder 通道全链路（目录/信封/工具环/prefs 路由） |
| `npm run verify:host-config` | 宿主配置层选路 / 冲突重试 / 降级 |
| `npm run verify:desktop-acceptance` | 桌面端组合验收（`--structural` 为结构模式） |
| `node scripts/verify-agents-md.mjs` | 文档闸门（AGENTS.md 预算 / 引用存在 / 踩坑编号连续） |

联调探针：换机器或上游协议变动后，`node scripts/probe-trae-live.mjs --login` 再 `--chat "你好"`、`node scripts/probe-qoder-live.mjs --login` 再 `--chat "你好"` 校准（证据落 `docs/probes/`）。Qoder 专项差分探针见 `scripts/probe-qoder-*.mjs`。

诊断入口：`GET /dsh-tap/settings?probe=host-config` 报宿主配置层选路 / 可写性 / revision / 有效 provider 清单——升级后排查不必猜。

### 架构与文档地图

三层（静态补丁 → 组合根 → 凭据边缘层 + 各上游适配器 + 浏览器半）的职责边界与改动生效方式见 **AGENTS.md**；深入叙述：

| 要什么 | 去哪 |
|--------|------|
| 网关事实全表（headers/错误码/目录/额度/缓存） | `docs/rules/gateway-facts.md`（+ 同目录各专题） |
| 踩坑全本（每条含代价与修复，编号连续性由 CI 锁定） | `docs/pitfalls.md` |
| Trae / Qoder 协议逆向与设计依据 | `docs/reverse/`、`docs/goals/` |
| 原始实测证据 | `docs/probes/` |
| 架构与各上游模块叙述 | `wiki/01-architecture.md` ~ `10-provider-qoder.md` |
| 版本史与发版记录 | `CHANGELOG.md`、[Releases](https://github.com/taikaikaikai-pixel/dsh-tap/releases) |

## 排查与已知问题

| 症状 | 先看 |
|------|------|
| Trae 通道报 3003 / inline 传输不可用 | `docs/diagnosis-trae-3003.md`（服务端故障，切 agent 传输档绕行） |
| 缓存命中率低 / 疑似重复提问多扣额度 | `docs/diagnosis-cache-quota.md`、`docs/diagnosis-cache-decline.md` |
| Qoder 报 provider_error / Flash 不可用 | `docs/diagnosis-qoder-flash.md` |
| 升级后模型/档位行为异常 | `GET /dsh-tap/settings?probe=host-config` 看宿主配置层选路与 lastError |

其余问题请到 [Issues](https://github.com/taikaikaikai-pixel/dsh-tap/issues) 反馈，附 `?probe=host-config` 输出与复现步骤。

## 卸载

```sh
dsh plugin --profile web rm dsh-tap
```

## 免责声明

- 本项目是**非官方的第三方开源插件**，与腾讯（CodeBuddy / WorkBuddy）、字节（Trae / TRAE SOLO）、阿里（Qoder）、DeepSeek 及各模型厂商**无任何隶属、赞助或背书关系**；相关名称与商标归其各自权利人所有。
- 本项目按 MIT 协议**"原样"提供，不附带任何明示或默示担保**（包括但不限于适销性、特定用途适用性与不侵权担保）。使用者须自行承担使用风险。
- 使用者应确保其使用方式符合各上游平台（CodeBuddy、TraeWork、Qoder）的服务条款及相关规则；因使用本插件导致的账号限制、额度扣减、服务中断或任何直接或间接损失，作者不承担任何责任。
- 各网关接口均为未公开的内部形态，**可能随时变更或失效**，本项目不承诺持续可用。
- 凭据（API Key / OAuth 令牌）仅存储于使用者本机 `~/.dsh/` 目录，请妥善保管，切勿提交到任何公开仓库。

## 许可

MIT
