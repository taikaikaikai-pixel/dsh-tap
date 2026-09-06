# dsh-tap

CodeBuddy（`copilot.tencent.com`）插件包，为 DeepSeek Harness（dsh）提供：**模型清单跟随网关目录动态同步**（DeepSeek、智谱 GLM、Moonshot Kimi、MiniMax、腾讯混元、auto 自动路由，多数支持可调思考强度与图片输入），**CodeBuddy 网络搜索 / 网页抓取后端**（接入 dsh 原生 `web_search` / `web_fetch` 工具），**`image_generate` 生图工具**（混元生图后端），以及 **key 型 OpenAI 兼容上游注册表**（火山引擎 Ark、阿里云百炼等，模型统一进选择器）；v0.8.3 起内置 **TraeWork CN 订阅额度通道**（自持设备密钥的 OAuth + 本地 OpenAI↔Trae 翻译网关 + 本机目录同步，详见下节）。

## 特性

- **配置层**（`cordis.patch.yml`）：`llm-pi-ai` 的 codebuddy provider 路由、默认模型、`web` 行的 provider 钉选
- **运行时层**（`index.js`，零依赖）：把网关 `/agenttool/v1/search`、`/agenttool/v1/webfetch` 注册进 `ctx.web`，把 `image_generate` 注册进 `ctx.tools`，并运行 127.0.0.1 流式桥——所有请求（含主聊天）的统一凭据入口，OAuth 或 API Key 任选（api-key 模式多 Key 自动轮询 + 失败冷却）
- **协议**：OpenAI Chat Completions（`openai-completions`），流式（stream-only）
- **端点**：`https://copilot.tencent.com/v2`（经本地桥转发）
- **默认模型**：`deepseek-v3`
- **凭据**：设置卡"登录"区选择 OAuth（浏览器授权，推荐）或 API Key（卡内管理 / 环境变量兜底），插件文件不含密钥

## 模型列表

下表是插件静态兜底清单（2026-08-16 实测全部可用，全部支持 tool_calls；参数与网关自有目录 `GET /v3/config` 核对）。**v0.8 起清单默认动态化**：启动时自动从 `/v3/config` 同步网关目录并入对话选择器（目录新模型自动出现，同名静态条目尺寸随目录刷新），静态清单只在网关不可达时兜底；设置卡"模型"分区可手动再同步、逐模型启停、逐模型调节上下文/输出上限。

| 模型 | 厂商 | contextWindow | maxTokens | reasoningEfforts | 图片 |
|------|------|---------------|-----------|------------------|------|
| deepseek-v3 | DeepSeek | 131072 | 32768 | — | — |
| deepseek-v3.2 | DeepSeek | 131072 | 32768 | — | — |
| deepseek-r1 | DeepSeek | 131072 | 32768 | low / medium / high / max | — |
| deepseek-v4-pro | DeepSeek | 1000000 | 50000 | off / low / medium / high / max | ✔ |
| deepseek-v4-flash | DeepSeek | 1000000 | 50000 | off / low / medium / high / max | ✔ |
| glm-5.1 | 智谱 | 200000 | 48000 | off / low / medium / high / max | ✔ |
| glm-5.2 | 智谱 | 1000000 | 48000 | off / low / medium / high / max | ✔ |
| glm-5v-turbo | 智谱 | 200000 | 64000 | off / low / medium / high / max | ✔ |
| kimi-k2.5 | Moonshot | 164000 | 32000 | off / low / medium / high / max | ✔ |
| kimi-k2.6 | Moonshot | 256000 | 32000 | off / low / medium / high / max | ✔ |
| kimi-k2.7 | Moonshot | 256000 | 32000 | low / medium / high / max | ✔ |
| kimi-k3 | Moonshot | 262144 | 32768 | low / medium / high / max | — |
| kimi-k3-1 | Moonshot | 1000000 | 32000 | low / medium / high / max | ✔ |
| minimax-m2.7 | MiniMax | 200000 | 48000 | low / medium / high / max | ✔ |
| minimax-m3 | MiniMax | 512000 | 128000 | off / low / medium / high / max | ✔ |
| hy3 | 腾讯混元 | 192000 | 64000 | off / low / medium / high / max | ✔ |
| hy3-preview | 腾讯混元 | 262144 | 32768 | off / low / medium / high / max | — |
| auto | 自动路由 | 262144 | 32768 | — | — |

思考强度档位 2026-08-16 经 `--efforts` 逐一实测：所有列出的模型均接受对应档位且无报错；标注 `off` 的模型不传参数时实测无思考输出，未标注 `off` 的模型默认即思考。各档位的思考长度由模型自适应决定，非严格递增。

目录已不列出、但 `/v2` 端点仍正常服务的旧 id（deepseek-v3 / v3.2 / r1、kimi-k3、hy3-preview、auto）继续保留，参数按各模型官方规格。

## TraeWork CN 订阅额度通道（v0.8.3）

把字节 TraeWork CN / TRAE SOLO CN 的订阅额度接成 dsh 的第二上游（provider id `trae`）：

- **凭据**：插件用**自持 ECDSA P-256 设备密钥**走完整 OAuth 设备流（浏览器授权一次），refresh 的 DeviceProof 由自己签名——不读取、不提取官方 IDE 的任何凭据；令牌只存 `~/.dsh/trae-plugin-auth.json`
- **翻译网关**：`127.0.0.1:3902`（`traeBridgePort` 可调）把 OpenAI Chat Completions 翻译成 Trae 云端协议（`trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`，SSE 互转），dsh 主聊天选择 trae 模型即走此通道
- **模型目录**：从本机 TRAE SOLO CN 的缓存数据库（state.vscdb）只读提取（24 个 preset 模型：DeepSeek-V4、GLM-5.x、Kimi-K3、Doubao-Seed、Qwen3.8 等），启用通道自动同步进选择器；提取器带敏感字段 scrub（安全契约见 `scripts/trae-model-catalog.mjs` 文件头）
- **使用**：设置卡 → 插件配置 → CodeBuddy → `TraeWork CN（订阅额度）` 分区：启用通道 → 登录（浏览器授权）→ 模型自动出现在选择器
- **首次联调**：聊天信封/SSE 语法来自二进制逆向（置信度中），实测校准结论内联在 `providers/trae/` 各模块文件头
- 回归：`npm run verify:trae-provider`（43 断言，mock 全链路）+ 浏览器 step31（12 断言）

## 网络搜索与网页抓取

dsh 原生的 `web_search` / `web_fetch` 工具会被本插件接到 CodeBuddy 网关的 `/agenttool` 端点上（与官方 CLI 同源，索引较新），凭据复用 `CODEBUDDY_API_KEY`。安装后无需额外配置——补丁已在 `web` 行钉选 codebuddy 后端；如需临时切回，设置环境变量 `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` 为其他 provider id。

## 图片输入（识图）

两种用法：

1. **原生图片输入**：上表标注"图片 ✔"的 12 个模型接受 `image_url` 输入（base64 data URL 或公网 URL），已实测可用。
2. **Web UI 贴图 + describe-image 工具**（装了 `@linxin666/dsh-web-ui-all` 时）：浏览器端会把贴图重写为 describe-image 引用，由该工具调用视觉端点。CodeBuddy 网关**只支持流式**（非流式报 11101），而 describe-image 发经典非流式请求——本插件在 `127.0.0.1:3901` 内置了一个**流式桥**（接收非流式请求 → 转流式发给网关 → 聚合成标准 JSON 返回）。在 `~/.dsh/settings.yaml` 配置即可启用：

```yaml
describe-image:
  baseURL: http://127.0.0.1:3901/v2
  model: glm-5v-turbo
  apiKeyEnv: CODEBUDDY_API_KEY
  apiStyle: chat-completions
```

桥只监听回环地址，端口在设置卡「流式桥」分区修改（`bridgePort`，默认 3901）。`chat/completions` 之外的路径（如 `/agenttool/*`）原样透传。

## 可选设置（Settings → 插件配置 → CodeBuddy）

设置卡按插件功能分九区，顶部有功能概览行，修改即保存、立即生效。设置持久化在 `~/.dsh/codebuddy-plugin.json`，优先级：该文件 > 插件组合配置 > 默认值。

### 模型

模型清单**默认跟网关目录走**：启动时自动同步 `/v3/config`（设置卡"目录同步"行可手动再同步，显示上次同步时间与目录规模）；网关拉不到时无感回落静态清单，选择器绝不变空。列表中每个模型：

- **勾选启用/禁用**：勾选状态 = 是否出现在对话模型选择器（写入 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.codebuddy.models` 覆盖层，下次请求生效，无需重启）
- **行内调节上下文/输出上限**：ctx 与输出两栏可直接改（覆盖值存 `modelState.overrides`），不得超过目录给定的该模型实际上限；清空输入框即恢复目录默认
- 徽标区分来源（"插件"静态 / "目录"网关）与能力（CLI / 图 / 思考档位）

### 服务商

key 型 OpenAI 兼容上游注册表（v0.8 新增）：预设**火山引擎 Ark**、**阿里云百炼**、**iFlow 心流**、**Qwen Code**，或自定义（id + baseURL）+ API Key。

- 添加时会先实测 `GET /models` 验证 key 并拉取目录，模型写进选择器**免重启**（provider 块落 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.<id>`，key 落 `~/.dsh/.credentials.yaml` 的 `<ID>_API_KEY`，文件权限 0600，只回脱敏显示）
- 无 `/models` 端点的上游（iFlow、Qwen Code）自动改用最小 chat 探针验 key + 内置模型清单兜底
- 每行可"刷新模型"（重拉目录）与"删除"（连同凭据一起清）
- **本机凭据**行（v0.8 G7）：只读扫描本机已安装 agent 工具（iFlow、Qwen Code 等）的登录态/凭据文件，检测到即提示"一键导入"——导入是逐个确认的显式动作，扫描绝不回传任何 secret 值

### 网络搜索与抓取

| 设置 | 默认 | 说明 |
|------|------|------|
| 一键开关 `searchEnabled` | 开 | 禁用即从 `ctx.web` 注销 codebuddy 后端（web_search/web_fetch 将报 provider 未注册），开启即时恢复 |
| 搜索默认条数 `searchMaxResults` | 5 | `web_search` 未指定时（1–20） |
| 抓取正文上限 `fetchBodyCap` | 200000 | `web_fetch` 返回正文字符上限 |

### 图像生成

| 设置 | 默认 | 说明 |
|------|------|------|
| 一键开关 `imageGenEnabled` | 开 | 注册/注销 `image_generate` 工具（dsh 原生 tools 缝） |
| 生图模型 `imageGenModel` | hunyuan-image-v3.0-art | 网关 `/v2/images/generations` 的模型 |

`image_generate` 按提示词出图（约 20 秒/张），PNG 落盘会话工作区（无工作区时 `~/.dsh/generated-images/`），结果返回本地路径与源 URL。

### 流式桥（智能代理 + 凭据收口）

| 设置 | 默认 | 说明 |
|------|------|------|
| 启用 `bridgeEnabled` | 开 | 一键开关；**禁用即停本地监听，主聊天随之中断**（模型请求经由此桥） |
| 端口 `bridgePort` | 3901 | 修改后自动重启监听；须与 `cordis.patch.yml` 的 baseURL 端口一致，否则主聊天断 |
| 会话归因注入 `sessionHeadersEnabled` | 开 | 按入站会话 id（`X-Conversation-ID`/`X-Session-ID` 等头或请求体）注入网关会话头；逐头处理——调用方已设置的头保留原值，缺失的头按会话 id 补全 |
| 会话头格式 `sessionHeaderFormat` | openai | `openai`（session_id/x-client-request-id/x-session-affinity）或 `openrouter`（x-session-id） |
| 每会话并发上限 `maxConcurrentPerSession` | 4 | 同会话超额请求 FIFO 排队；无会话 id 不限流 |

桥在 127.0.0.1 作为统一网关出口与**唯一凭据入口**：主聊天（`llm-pi-ai` 的 codebuddy 路由即指向此桥）、describe-image、tools 的请求都由桥按登录方式（OAuth/Key）解析凭据，调用方发的哨兵 Authorization 从不出宿主机。chat/completions 走会话归因 + 并发管理，流式入站（`stream:true`）透传 SSE、非流式入站（`stream:false` 或缺省）聚合为标准 `chat.completion` JSON；其余路径（如 `/agenttool/*`）直接透传。端口被占用时（如另一个 dsh 实例已在运行）插件只告警不崩溃，桥状态在"额度与用量"分区可见。

### 额度与用量

实时（分区打开时 10s 轮询）显示：

- **消耗量（精确）**：桥对每个 chat 请求的网关 `usage.credit` 恒开计量（搜索/抓取/生图路径同样入账），持久化在 `~/.dsh/codebuddy-plugin-usage.json`；展示今日/累计 credit 与请求数、最近轮次（按 >45s 间隔聚类的近似口径，含缓存命中率）
- **账户额度信号**：套餐类型与企业名（`GET /v2/accounts`）、额度不足时网关的告警文案（`get-dosage-notify`，官方 CLI 同源）。额度是账户级的，与 WorkBuddy 共用
- **数字剩余额度（OAuth 模式）**：`/billing/meter/get-user-resource` 实测可用（资源包逐条 + 本周期/总量口径剩余，每分钟缓存）；api-key 模式该 API 不开放（OAuth 专享），卡片改显「手填总额 − 本插件计量累计」的**估算**值并标注（规则 docs/rules/quota-signals.md R-Q7）
- **桥状态**：运行中 / 端口占用（EADDRINUSE）/ 已禁用

### 登录

- **登录方式**：`API Key`（默认）或 `OAuth 登录`
- **API Key 模式**：可添加多个 Key（名称 + key，卡内脱敏显示）；**多把 Key 逐请求轮询**，遇 401/403/429/5xx/网络错误自动在同一请求内换下一把，失败 Key 冷却 `keyCooldownMs`（默认 60000ms，可配）后自动回到轮换；单选仅决定模型目录拉取用的 Key，一个都不选时回落到"环境变量引用"（环境变量或 `~/.dsh/.credentials.yaml`，默认 `CODEBUDDY_API_KEY`）
- **OAuth 模式**：点击"登录 CodeBuddy 账号"会打开官方登录页（`copilot.tencent.com/login`），插件轮询握手结果（约 10 分钟超时），完成后显示账号昵称与令牌到期时间；令牌存 `~/.dsh/codebuddy-plugin-auth.json`（设置接口永不回传），到期前自动用 refresh token 续期。流程与官方 CLI 一致（`/v2/plugin/auth/state` → 浏览器登录 → `/v2/plugin/auth/token` 轮询 → `/v2/plugin/login/account`）

### 高级

网关地址 `baseURL`（默认 `https://copilot.tencent.com`，http/https 绝对地址），一般无需修改。

实现说明：设置卡走插件自建的 `GET/POST /dsh-tap/settings` 路由而非 dsh 官方 settings 命名空间——当前 dsh 组合存在两份 `settings` 服务实例（bundle 入口侧与 Web 客户端连接侧互不相通），命名空间注册对设置页不可见；这与 dsh-html-visualizer 自建设置路由是同一原因。

## 安装

```sh
# 进入任意工作目录，把本插件安装到 web profile
dsh plugin --profile web add /path/to/dsh-tap
```

或直接从 GitHub 安装（纯 ESM、无构建步骤，git 源检出即用）：

```sh
dsh plugin --profile web add github:taikaikaikai-pixel/dsh-tap
```

或通过 npm 包名安装（发布后）：

```sh
dsh plugin --profile web add dsh-tap
```

安装后重启 Web UI（或重启 `dsh` 进程）生效。

## 凭据配置

两种方式（设置卡"登录"区切换）：

- **OAuth 登录**（推荐）：浏览器完成官方登录页授权即可，无需任何环境变量；令牌自动续期，覆盖模型对话、搜索、抓取、识图全部路径。
- **API Key**：设置卡内添加一个或多个 Key（多把自动轮询 + 失败冷却）；或在 `~/.dsh/.credentials.yaml` 写入 `CODEBUDDY_API_KEY: "ck_你的key"`（或同名环境变量）作为兜底引用。

所有请求（含主聊天）都经 `127.0.0.1:3901` 的流式桥统一取凭据——桥按上述登录方式解析，调用方不自带密钥。

## 维护：校验与同步模型

注意：**dsh 内置的"获取可用模型"对本网关无效**——网关没有 OpenAI 风格的 `GET /models` 端点（404），模型清单只能手工维护或用下面的脚本同步。网关自有目录在 `GET /v3/config`（`x-api-key` 认证，UA 必须形如 `CLI/unknown CodeBuddy/2.136.0`，否则报 12403）。

```sh
# 离线：仅列出本地配置的模型，自检 YAML 是否解析正常
node scripts/verify-models.mjs --list

# 在线：逐个模型发最小请求，报告可用性（未知 id 报错 11102）
node scripts/verify-models.mjs
# 或
npm run verify

# 在线：拉取 /v3/config 目录，对比参数漂移并生成修正后的 YAML 条目
node scripts/verify-models.mjs --sync

# 在线：探测模型接受哪些 reasoning_effort 档位及思考量变化
node scripts/verify-models.mjs --efforts [模型id ...]

# 离线：流式桥端到端回归（mock 网关，断言聚合/透传/会话头/并发排队完成）
node scripts/verify-bridge.mjs
# 或
npm run verify:bridge
```

## 卸载

```sh
dsh plugin --profile web rm dsh-tap
```

## 免责声明

- 本项目是**非官方的第三方开源插件**，与腾讯（CodeBuddy / WorkBuddy）、DeepSeek 及各模型厂商**无任何隶属、赞助或背书关系**；相关名称与商标归其各自权利人所有。
- 本项目按 MIT 协议**"原样"提供，不附带任何明示或默示担保**（包括但不限于适销性、特定用途适用性与不侵权担保）。使用者须自行承担使用风险。
- 使用者应确保其使用方式符合 [CodeBuddy 服务条款](https://www.codebuddy.cn/) 及相关平台规则；因使用本插件导致的账号限制、额度扣减、服务中断或任何直接或间接损失，作者不承担任何责任。
- 网关接口为未公开的内部形态，**可能随时变更或失效**，本项目不承诺持续可用。
- 凭据（API Key / OAuth 令牌）仅存储于使用者本机 `~/.dsh/` 目录，请妥善保管，切勿提交到任何公开仓库。

## 许可

MIT
