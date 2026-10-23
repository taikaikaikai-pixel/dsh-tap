# 生态调研：CodeBuddy / Trae / Qoder 的 GitHub 同类实现对比（2026-10-05 快照）

> **文档定位**：带日期的快照式调研，不是活文档——上游生态变化快，引用时注意时效。本文不替代 docs/rules/ 的实测裁判：凡本仓库未亲自探测过的外部项目事实，一律标注来源与（未验证）级别，**不得**据此改出站行为（踩坑 #22：逆向/转述不是协议真相）。
> **来源标注**：仓库元数据（stars/语言/最近推送）全部来自 `api.github.com` 搜索与 repos 端点，查询日 2026-10-05；实现细节来自各仓库 README 页深读（含子 agent 并行调研），逐条附仓库 URL。本仓库自身事实引用 `wiki/`、`docs/rules/` 与 `docs/pitfalls.md`。
> **方法与覆盖**：关键词 `codebuddy` / `qoder` / `trae api` / `trae2api` / `workbuddy` / `cursor2api` / `kiro2api` 等 10+ 组（api.github.com search ≈7 次 + 仓库页/README 深读 24 个，另列名约 55 个）。环境限制如实记录：`github.com` HTML 页在本机间歇超时、`raw.githubusercontent.com` DNS 不通——改走 api.github.com 与代理后完成；`ithtelab/workbuddy-manager` 的 README 解码失败，仅列名；`HEXUXIU/M365-Copilot2API` 页面两次超时未核实（来自流派调研子 agent）。

## 1. 全景：四个流派与本项目落位

| 流派 | 形态 | 代表 | 与 dsh-tap 的关系 |
|---|---|---|---|
| **协议翻译派**（2api） | 独立 OpenAI/Anthropic 兼容服务器，自持凭据直连上游 | workbuddy2api-panel（Go）、workbuddy2api-hub、codebuddy2api、Trae2api-cn、agent2api | 同题不同宿主：他们服务任意 OpenAI 客户端，我们服务 dsh 宿主（桥+翻译网关内嵌插件） |
| **CLI 包装派** | 把官方 CLI 当子进程/文本协议包一层 | qoder-proxy、cli2api（Qoder 走"每账号独立 Node 进程+HOME"） | 绕过签名/加密问题；代价是文本层工具调用模拟（qoder-proxy 自述 tool_calls 靠 prompt 模拟+输出解析） |
| **账号管理派** | 桌面端多账号切换/额度监控/保活，通常不出 API | cockpit-tools（18.6k★）、TraeWorkAssistant、workbuddy-switch、WorkDaddy | 互补不竞争；其"额度监控/唤醒任务"经验可借鉴 |
| **组合编排派** | 在上层把多个 CLI harness 编排成多 agent | harness-mix（内嵌 dsh 0.1.2-rc.1 + Qoder/CodeBuddy/Trae 共 18 harness） | 证明了 dsh 已有第三方集成者；与本项目零冲突 |

**互补性实证**：workbuddy2api-hub 明确支持以"标准 OpenAI 客户端"身份接入 **DSH（DeepSeek Harness）**（来源：[workbuddy2api-hub README](https://github.com/ardeyouxipianyi/workbuddy2api-hub)）——即 dsh 用户可以经本插件的多服务商注册表把这类网关挂成自定义 preset，两条路线可拼接。

## 2. 分上游细节

### 2.1 CodeBuddy / WorkBuddy（同账户体系，本仓库 CodeBuddy 通道同源）

总表（来源：api.github.com `q=codebuddy&sort=stars`，2026-10-05）：

| 仓库 | 语言 | ★ | 最近推送 | 深读 |
|---|---|---|---|---|
| [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools) | Rust | 18.6k | 2026-10-01 | 部分（README 乱码，功能面已确认） |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | Go | 1.9k | 2026-10-05 | ✓ |
| [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) | JS | 1.7k | 2026-10-01 | 列名 |
| [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch) | Rust | 1.0k | 2026-10-04 | 列名 |
| [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) | Python | 774 | 2026-10-05 | 列名（README 解码失败） |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | Python | 629 | 2026-09-29 | ✓ |
| [ShouZhuo0413/codebuddy2api](https://github.com/ShouZhuo0413/codebuddy2api) | Python | 330 | 2026-09-30 | ✓ |
| [emo-xiaoyu/harness-mix](https://github.com/emo-xiaoyu/harness-mix) | TS | 280 | 2026-10-02 | ✓ |
| [CangShui/workbuddy-gateway](https://github.com/CangShui/workbuddy-gateway) / [lovingfish/workbuddy-cliproxy](https://github.com/lovingfish/workbuddy-cliproxy) | Go | 211/193 | 2026-10/07 | 列名 |

**workbuddy2api-panel**（本上游最成熟实现，来源同上）：

- **认证**：与本项目完全同款的设备流（`plugin/auth/state?platform=CLI` → `token?state=` 轮询 → `login/account`；`token/refresh` 刷新，0600 原子写回）——**第三方独立重走并与我们逐端点一致**，交叉验证了 `docs/rules/oauth-handshake.md` 的路线。
- **多账号池调度**（我们完全没有的一层）：积分快过期加权 ×3、按实测成本分 tier 0/1/2、加权随机、Top-5 候选防惊群、闲置补偿权重、单账号在途租约上限。
- **分级冷却**：429 软冷却 600s 起指数退避封顶 2h；`code 6004` 模型级冷却到上游重置墙钟（切模型豁免）；402 硬冷却至次日 04:00；404 固定 60s；连败熔断；`12153` 连续 3 次才禁用（这些码值系该项目自述，本仓库 errors.js 未收录——按 #22 纪律不直接采信）。
- **模型目录**：动态拉取 + 1h 缓存 + 5min 负缓存；`max_output_tokens` 四级查找链（上游目录 → 内置知识表 → model.json → models.dev）；`probe_max_tokens.py` 实测上游**静默钳制**的真实输出上限。
- **风控/审核规避**：出站 UA 对齐官方三段式 `WorkBuddy/<ver> WorkBuddy/<ver> CLI/<ver>`；`prompt.mode` 三档（custom/append/passthrough），passthrough 被拦时换 Degraded 中性提示词同请求重试一次、`ErrContentBlocked` 不罚号；请求体黑名单指纹字段清洗；"11128 反探测改写"。
- **额度**：余额 5 分钟后台刷新、credit_floor 停接收费模型；定时任务：签到 [9,21]、活跃上报 [10]、猫猫旅行、token 保活 [22]；成长任务 17/18 可纯 API 完成（按任务构造 CLI/桌面/Web 三类客户端指纹走 `/v2/report`；唯一做不了的是需真实捐款回执的 Expert_Philanthropy）。
- **兼容面**：仅 OpenAI（`/v1/chat/completions`、`/v1/models`、`/status`、`/healthz`）。
- **谱系**：自述上游原仓库 Sliverkiss/workbuddy2api 已删库，本仓库为独立维护的增强 fork——**生态高波动性的直接证据**。

**workbuddy2api-hub**：

- **关键事件**：桌面端自 2026-09-24 起 accessToken/refreshToken 改**加密存储（`$wbEncrypted` 信封）**，"读本地桌面凭据"路线整体死亡，导入后一切请求 401（来源：其 README）。⇒ **本仓库自持 OAuth 设备流的路线得到反向验证**：不依赖官方客户端凭据存储的方案才是可长期存活的。
- token 保活：每日 22:00 扫描，剩余寿命 <2h 自动 refresh。
- 模型目录：`GET /v3/config` 取 `agents[cli].models`（**与我们同端点**），回落链"远端 → 桌面端缓存 → 窄端点 → 内置快照"；过滤档位别名与 `-sg`/`-x` 变体、同名只留 0.00 倍率档。
- 双区域路由（CN `codebuddy.cn` / 国际 `www.workbuddy.ai`）+ 每账号独立代理槽；保留积分阈值（低于不再接单，避免上游发短信提醒）；每日 token 限额；429 时出站身份 WB/VSC/CLI 轮转（默认关）。
- **工具史自愈**：自述"工具调用配对自愈（修 code 11148 坏历史）"——**本仓库 2026-10-05 快照时尚未实测过该错误码**（当时只有其 README 自述，按 #22 不采信）；**2026-10-18 已实测复现**（含模型家族分裂，见 §4 P0-1），证据 `docs/probes/codebuddy-pairing-2026-10-18.json`。其与我们 #39/#41 的 tool 配对问题同类（见 §4 改进 P0）。
- 其他：`derive_id` 设备指纹派生（UID+盐单向哈希，同账号稳定、跨账号阻断关联）；修正 `X-Product: SaaS`（自创 `X-Product: WorkBuddy` 是错的——与我们 headers.js "X-Product: SaaS 保留" 的判定一致）；`prompt_cache_key` 注入开关（默认关）；DSH 作为标准 OpenAI 客户端接入 + DeepSeek `reasoning_content` 双写 `reasoning` 字段。

**codebuddy2api**：读本地桌面客户端凭据文件（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` 等）+ 可选管理端浏览器授权；多账号轮转/冷却/额度规避/每日签到（admin/pool.py）；兼容面最全（OpenAI chat + Codex `/v1/responses` + Anthropic `/v1/messages` + `/v1/models`）；FastAPI + Docker 一键脚本；**审核规避**：`--desensitize` 模式（压缩运行时提示词、剥工具描述、零宽字符脱敏高危词）+ 被拦后压缩模式重试。其桌面凭据读取路线已被上述 $wbEncrypted 事件判定过时。

**harness-mix**：Codex Desktop 的 sidecar，编排 18 个 CLI harness（Antigravity/Codex/Claude Code/**dsh 0.1.2-rc.1**/Qoder/CodeBuddy/Trae/Kimi Code 等）；不碰任何凭据（各 CLI 原生登录）；诚实能力矩阵（未验证项标 🟡）。属组合编排派，证明 dsh 本身已被第三方生态收纳。

### 2.2 Trae（来源：调研子 agent 逐仓库核实，2026-10-05）

| 仓库 | ★ | 定位 |
|---|---|---|
| [bytedance/trae-agent](https://github.com/bytedance/trae-agent) | 12.1k | **官方唯一开源产物**（CLI SWE agent，MIT）；走标准 API，不含订阅协议逆向 |
| [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | 33 | CN 四通路反代，最活跃（2026-10-05 仍在推） |
| [laojichao/trae-local-api](https://github.com/laojichao/trae-local-api) | 55 | **tc 凭据加密格式破解**：`0x74 0x63` 头 → 双 SHA-512+XOR 盐派生 AES-128-CBC key/IV（src/trae-decrypt.js） |
| [connectedGraph/trae2api-web](https://github.com/connectedGraph/trae2api-web) | 33 | Web OAuth 闭环（本地 :18080 回调）、24h 预刷新、信用降序选号 |
| [smart-open/TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant) | 212 | Trae/WorkBuddy/CodeBuddy/Qoder 四上游账号管理 + 三协议网关（Rust/Tauri） |
| [A-23187/trae-api](https://github.com/A-23187/trae-api) 等 trae2api 同名系 ≥7 个 | — | 国际版 token 抓取/反代，多数已停维护或归档 |

要点：

- **上游域名两份独立逆向交叉一致**：CN `trae-api-cn.mchost.guru` / SG `a0ai-api-sg.byteintlapi.com`（Trae2api-cn 与 trae-local-api 各自确认）——与 `docs/reverse/traework-cn.md` 的结论互证；SG 域名是我们未覆盖的国际版入口。
- **Trae2api-cn 的 remote 面与我们同构**：`POST /api/remote/v1/chat_sessions` 建会话 → GET `…/{id}/events` 读 SSE（`src/trae_remote_client.py`）；另有 `/api/ide/v2/llm_raw_chat` raw 面与 agent 面，**四通路自动回退**。
- **风控自愈**：签到 9074 风控 → 自动换设备 ID + 指数退避；信用优先多账号轮询 + 每账号并发槽 + **无重放策略防双计费**。
- **SSE 心跳注释**防网关断连（Trae2api-cn 实践，与流派调研 antigravity2api 一致）。
- 认证三路线并存：本地凭据解密（tc AES）、Web OAuth 本地回环、MITM 自签 CA 抓 JWT（TraeWorkAssistant）——本仓库"自持设备密钥 + 回环回调"属同代方案且无 MITM 侵入性。

### 2.3 Qoder（来源：api.github.com `q=qoder&sort=stars` + 逐仓库深读，2026-10-05）

| 仓库 | 语言 | ★ | 定位 |
|---|---|---|---|
| [itandelin/qoder-free](https://github.com/itandelin/qoder-free) | Python | 414 | **身份重置工具**（machineid/telemetry/trust tokens/硬件指纹全清）——灰产向，反证"machine_id 是风控向量" |
| [caigee-cmd/cli2api](https://github.com/caigee-cmd/cli2api) | Go | 326 | 多上游（Qoder 国双版/WorkBuddy 国双版/Trae CN Work）SQLite 多账号路由；**Qoder 适配 = 每账号独立 Node 进程 + HOME**（包装官方 CLI），自述 Qoder CN/WorkBuddy/Trae 适配"真账号验收仍未完成" |
| [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) | Rust | 223 | 多供应商本地网关（Tauri 桌面端）：workbuddy（CN `copilot.tencent.com`/国际 `www.workbuddy.ai`）、**qoder（国际 `api3.qoder.sh` / CN `gateway.qoder.com.cn`——"COSY 自签名头（不是 Bearer）· 信封式 SSE（自有编码与签名）"）**、catpaw、autoclaw、cline；全局账号队列 + 429 降级 + 出网代理 + 出站指纹脱敏 |
| [avaritiachaos/qoder-proxy](https://github.com/avaritiachaos/qoder-proxy) | JS | 206 | **CLI 包装派**：spawn `qoderclicn`/`qodercli`，OpenAI/Anthropic 请求转 CLI 文本调用；tool_calls 靠 prompt 指令+输出解析模拟；CN 后端用 Personal Access Token |
| [okky-x0f/qoder-creator](https://github.com/okky-x0f/qoder-creator) | Python | 199 | Pro 试用+credits 自动领取（灰产向，列名） |

要点：

- **COSY 签名的第二实现存在**：agent2api（Rust）自述对 Qoder 双区做"COSY 自签名头 + 信封式 SSE"——说明 COSY 签名可脱离官方 wasm 独立实现（细节在其源码，本仓库未核）（未验证：仅其 README 自述）。其 **CN 端点 `gateway.qoder.com.cn` 与我们 `wiki/10-provider-qoder.md` 的 infer 节点结论一致**，国际版 `api3.qoder.sh` 是新情报（我们只测过 `api2-v2.qoder.sh` 的 OpenAI 面 401）。
- **安全姿态互证**：qoder-proxy 的本地防线 = 仅监听 127.0.0.1 + **Host 头非 loopback 一律拒（防 DNS rebinding）** + 浏览器跨源默认拒绝 + 显式 `ALLOWED_ORIGINS` 白名单 + 可选 `PROXY_API_KEY` + 日志脱敏（来源：其 README）——与本仓库 #61（Host+Origin 双门、无-Origin 放行）同构，但**多一层"本机进程也得持钥匙"的考量**（详见 §4 P1）。
- 本仓库在 Qoder 上是生态里**唯一已实证的进程内 WASM 签名实现**（`qoder_auth.wasm` 官方原字节 + 手写胶水，wiki/10）；其余路线要么包 CLI、要么未验收、要么（agent2api）自述独立实现但未核。

### 2.4 同流派成熟项目（来源：调研子 agent，2026-10-05）

| 项目 | 上游 | ★ | 值得看的点 |
|---|---|---|---|
| [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) | GitHub Copilot | 4139 | 单 token 但带 GET /usage + 用量仪表盘 |
| [7836246/cursor2api](https://github.com/7836246/cursor2api) | Cursor Web | 1894 | tool_calls 增量流式 + 参数 128 字节分块续写 + 参数自愈；SSE 日志实时推送网页台 |
| [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) | Copilot+多上游 | 1068 | 三协议（chat/Responses/messages）多上游 + Electron GUI |
| [liuw1535/antigravity2api-nodejs](https://github.com/liuw1535/antigravity2api-nodejs) | Antigravity | 813 | 四协议 + 三策略账号池（round_robin/quota_exhausted/request_count）+ 403 自动摘除 |
| [caidaoli/kiro2api](https://github.com/caidaoli/kiro2api) | Kiro | 637 | 顺序轮换 + 故障转移 + 刷新并发控制 |
| [wisdgod/cursor-api](https://github.com/wisdgod/cursor-api) | Cursor | 692 | token 池 + 额度解析；**已归档**——上游官方化风险的样本 |
| [zhu327/gemini-openai-proxy](https://github.com/zhu327/gemini-openai-proxy) | Gemini | 723 | **自述已被官方兼容端点取代**——翻译网关生命周期的终局样本 |
| [linqiu919/augment2api](https://github.com/linqiu919/augment2api) | Augment | 191 | Redis token 池 + 401 禁用/503 换 tenant/单 token 限速 |

流派共性（成熟项目标配）：账号池默认化（池+可插拔策略+失败分级处置）、额度信号结构化（剩余/上限/重置时间 → 查询端点+UI）、三协议暴露、`/v1/models` 动态化、Web 管理台、结构化可观测（request_id/耗时入日志）、token 级限速与 SSE 心跳、Docker 健康检查、测试随仓库。

## 3. 逐维度对比：dsh-tap vs 生态规范

| 维度 | 生态主流 | dsh-tap 现状 | 判定 |
|---|---|---|---|
| 认证 | 三路线并存：读桌面凭据（已死，见 §2.1 hub）/ 包 CLI / 自实现 OAuth | **全通道进程内 OAuth**：CodeBuddy 设备流、Trae 自持 P-256 设备密钥+PKCE 回环、Qoder PKCE 纯轮询+machine_id 自持 | **领先**。$wbEncrypted 事件证明这是唯一不受官方客户端改动牵连的路线 |
| 账号池 | 标配：多账号+可插拔策略+失败分级冷却+代理槽 | 单账号 OAuth；轮转仅在 api-key 模式（core/rotation） | **最大欠账**（§4 P2，轻量版即可） |
| 流式翻译 | SSE 白名单重建、tool_calls 状态机、心跳注释、thinking 双格式 | 桥透传 + 网关逐帧解析；累计快照差分（Trae）；信封拆封（Qoder）；首字节护栏 45s | **持平偏强**（差分/拆封的正确性有实测锁定）；缺心跳注释（P1） |
| 模型目录 | 动态拉取+缓存+多级回落 | `/v3/config` + UNROUTABLE_MODELS 真源；state.vscdb；签名 model/list；"目录有≠可路由"纪律 | **领先**（生态无人处理死条目；panel 的 max_output_tokens 四级链值得抄，P1） |
| 额度 | 结构化+后台刷新+低额停接 | 三上游各自只读余额面（60s memoize、永不 throw、采样纪律） | 持平；缺"低额→行为联动"（属账号池课题） |
| 签到/成长任务 | 普遍自动化（panel 17/18 任务） | 无 | **建议不做**（§4 明确反对项） |
| 审核处理 | 重试/换提示词/脱敏/指纹清洗 | developer→system 重写（实测定案）；无重试策略 | 差异点：我们改的是**协议正确性**，他们做的是**内容规避**。中性提示词重试可做（P2），零宽字符类不做 |
| 兼容面 | OpenAI+Anthropic+Responses 三协议是头部标配 | 面向 dsh 宿主的 OpenAI 方言；trae/qoder 网关带 GET /v1/models；**2026-10-18 起 `POST /v1/messages`（Anthropic Messages）与 `POST /v1/responses`（OpenAI Responses）三通道齐备——CodeBuddy 桥 :3901 + Trae :3902 + Qoder :3903**（两面共享 `providers/protocols/` 的唯一装配 `createProtocolSurfaces`；桥侧经 `core/bridge.js` 新增的 **provider 无关通用接缝** `protocolSurfaces` / `chatPath` 在 `proxyUpstream` 之前分流，被拒即原路转发；未新起 HTTP 服务器；未做真实客户端联调、未实现项已如实列出） | 原为**刻意收窄**（宿主插件定位）；2026-10-18 以「不新起服务器」的收窄口径补上两面，并把挂载点从两条订阅网关扩到默认主通道 :3901（§4 不做清单已同步修订） |
| 安全 | 回环+可选 key+日志脱敏 | Host+Origin 双门、令牌不出宿主、0600 原子写、脱敏视图 | **同构且更强**；缺网关可选共享密钥（P1） |
| 部署/运维 | Docker/单二进制/管理台 | dsh 插件形态（无独立部署）；设置卡=管理台 | 定位不同，非欠账 |
| 可观测 | request_id+耗时+网页日志台 | 取证日志（env 开关）+ usage-meter 分组视图 | 差距小；缺耗时/请求级视图（P2） |
| 证据纪律 | 无可比（生态普遍 README 自述+代码） | docs/rules 每条带探针证据+预注册预测；诚实披露改派/INCONCLUSIVE | **独一档**，是本项目最不可替代的资产 |
| 工具史体检 | hub 对 CodeBuddy 自述 11148 自愈；我们 Qoder/Trae 有 sanitizeToolPairing | **三面齐备**：CodeBuddy 桥 2026-10-18 接入（`providers/codebuddy/index.js` 的 `transformChatPayload` 调 `providers/tool-pairing.js:50`），Qoder/Trae 更早已接 | **欠账已还**（§4 P0-1 已完成；11148 已实测复现，拒绝面按模型家族分裂） |

## 4. 改进建议（按优先级；每条给证据与落点）

### P0 — 直接可落地、有外部证据激活

1. **【已完成 2026-10-18】把 `sanitizeToolPairing` 接入 CodeBuddy 透传桥**。**历史证据链（当时的定性）**：workbuddy2api-hub 自述为 CodeBuddy 上游修 `11148` 工具史坏历史（来源：其 README，当时**未验证**，按 #22 不采信）；本仓库 STATE.md 2026-09-22 会话已留待办"CodeBuddy 透传桥未接入该体检……若日后换严格上游需同样接入"；pitfalls **#63（同类防护跨子面成对审计）** 正是这一缺口的名字。原定行动"先按 #22 纪律用孤儿体实测 `copilot.tencent.com` 是否复现 11148（扩 `scripts/probe-*.mjs`），复现则接入体检并把 11148 收进 `providers/codebuddy/errors.js`"已按序执行完毕：①**接入**——`providers/codebuddy/index.js` 的 `transformChatPayload` 已调用 `sanitizeToolPairing`（`providers/tool-pairing.js:50`），与 developer→system 重写、档位注入共存；②**收码**——`providers/codebuddy/errors.js` 收录 `11148 = tool calls and tool results do not match`；③**实测复现（2026-10-18）**——deepseek-v4-pro 上「孤儿 tool」与「声明了 tool_call 却没结果」→ HTTP 400 / code=11148，原文 `tool calls and tool results do not match, please start a new conversation and retry`，同一坏体经真实修复件后 200；**glm-5.3-flash 对全部坏体静默 200 ⇒ 拒绝面按模型家族分裂**；`content:null` / 缺键在本上游**未复现** #41 的不可见问题。证据 `docs/probes/codebuddy-pairing-2026-10-18.json`（16 臂）、探针 `scripts/probe-codebuddy-pairing.mjs`（8 臂 × 2 模型，1500ms 间隔，单账号）、断言 `scripts/verify-bridge.mjs` 新增 §18（8 条，套件共 **116 断言全绿**）。**边界如实标注**：探针只覆盖 2 个模型，其余 21 个未测；外部自述的 6004/402 仍未考证（#22 不采信）。
2. **调研结论沉淀为风险登记**：把"读桌面凭据派已死（$wbEncrypted）"写进 `docs/rules/oauth-handshake.md` 的一句话背景（防止未来有人提议改回凭据文件读取）；把 Trae SG 域名、Qoder 国际版 `api3.qoder.sh` 记入对应 reverse 文档的"未验证情报"节。

### P1 — 小改动、明确收益

3. **翻译网关/桥加可选共享密钥**（schema 布尔/密钥字段，默认关=行为不变）：qoder-proxy 的教训——"回环挡外网，挡不住本机进程；不设 key 时本机任何进程都能消耗你的额度"（来源：其 README 安全节）。落点：`core/bridge.js` + 两个 gateway 的入站门，与哨兵 Authorization 共存（带 key 校验时哨兵请求放行）。补 verify 断言。
4. **SSE 心跳注释**：上游静默期（Trae remote 排队、Qoder 首字节护栏窗口内）向入站发 `: keepalive` 注释行，防中间层掐空闲连接。判据安全：注释行不是用户可见内容，不违反 #60；Trae2api-cn 与 antigravity2api 均有同款实践。
5. **maxTokens 知识表回落链**：Qoder 目录不发布输出上限（现取 32768 保守默认）。借鉴 panel 四级链：目录 → 公共知识表（models.dev）→ 探针实测 → 保守默认；把"实测钳制"探针（panel 有 `probe_max_tokens.py` 同款思路）纳入既有 probe 纪律。

### P2 — 中成本、先立 goal 再动手

6. **轻量多账号 failover**（不是全功能池）：每通道可选第二 OAuth 账号，主账号 401/429/额度耗尽时切换并按码分级冷却（冷却分级参考 panel 的 429/6004/402/404/12153 表——**采信前需本仓库逐码实测**）。core/rotation 的轮询/冷却骨架可复用（需把它从"key 列表"泛化为"凭据列表"，注意 verify-core-generic 的 provider 无关纪律）。quota.js 的只读余额面现成可做 credit_floor。
7. **可选的 token 保活**（hub 每日 22:00 对寿命 <2h 令牌刷新的同款）：解决"长期不用→refresh 令牌静默过期"。默认关；与"零真实写入/采样纪律"不冲突（auth 维护≠业务流量），但要在设置卡如实标注。
8. **可观测性补齐**：usage 视图加逐请求耗时与 request_id（流派共性 [6][2]）；取证日志已有骨架，成本主要在设置卡展示。

### 明确的"不做"清单（与项目纪律冲突，记录在案防反复）

- **签到/成长任务/抽奖自动化**：生态普遍做（panel 17/18 任务、Trae2api-cn 签到风控自愈），但那是"账号行为自动化 vs 风控"的猫鼠游戏（9074 换设备 ID、指纹伪造）；本仓库的"自持稳定设备身份 + 诚实披露 + 零真实写入采样纪律"恰是**风控友好**的长期存活形态，自毁优势。
- **身份重置/硬件指纹伪造类**（qoder-free、qoder-creator 同类）：永不集成。
- **独立多协议部署（Anthropic/Responses 面）**：与 dsh 宿主插件定位冲突，生态已有成熟专项（panel/hub/cli2api）；如真有需求，走多服务商 preset 指向这些网关即可，不重复造。**（2026-10-18 修订：本条仍禁"独立部署形态"；但两面已以收窄口径落地——长在既有回环网关上、不新起 HTTP 服务器、不引入独立部署，经主控确认；见 `providers/protocols/` 与 `scripts/verify-protocols.mjs`。同日补记：**两面已接上 CodeBuddy 桥 `:3901`（三通道齐备）**，桥侧接缝是 provider 无关的通用件，仍不构成独立部署。）**
- **审核规避的深水区**（零宽字符脱敏、指纹清洗、prompt 整体替换）：只做"中性提示词重试"级别的透明策略（P2 再议），并如实披露。

### 观察清单（不动手，定期看）

- **上游官方化风险**：gemini-openai-proxy 被官方兼容端点取代、wisdgod/cursor-api 归档——若 CodeBuddy/Qoder/Trae 任一家发官方 OpenAI 兼容 API，对应翻译网关即生命周期终点；本仓库"协议事实与代码分离"的结构已为此做好准备。
- **多区域**：Trae SG（`a0ai-api-sg.byteintlapi.com`）、WorkBuddy 国际版（`www.workbuddy.ai`）、Qoder 国际版（`api3.qoder.sh`）均为未验证情报，接入属产品决策。
- **官方开源动态**：bytedance/trae-agent（12.1k★）说明官方开源的是 agent 框架而非订阅协议；Qoder 侧 `QoderAI/better-harness` 组织名疑似相关但未核实（未验证）。

## 5. 对比后的能力结论（一句话版）

本项目在**证据纪律、认证路线韧性、目录真实性、诚实披露**四项上是生态最强档；在**账号池、网关鉴权、流式心跳、maxTokens 精度**四项上低于生态标配或存在被外部证据激活的已知欠账（其中 CodeBuddy 工具史体检这条 P0 已于 2026-10-18 实测复现并接入，见 §4 P0-1）；签到自动化属刻意不做的定位选择，建议维持；独立多协议部署原属刻意不做，2026-10-18 以「长在既有回环网关、不新起服务器」的收窄口径落地两面，并同日接上 CodeBuddy 桥 `:3901`（三通道齐备；见 §4「不做」清单修订注）。

## 6. 来源清单

- 搜索元数据：`api.github.com/search/repositories`（q=codebuddy / qoder / trae api / cursor2api / kiro2api 等），查询日 2026-10-05。
- 深读仓库（README 页/子 agent 核实）：§2 各表内链接 + [codebuddy2api](https://github.com/ShouZhuo0413/codebuddy2api)、[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)、[workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)、[harness-mix](https://github.com/emo-xiaoyu/harness-mix)、[cli2api](https://github.com/caigee-cmd/cli2api)、[qoder-proxy](https://github.com/avaritiachaos/qoder-proxy)、[qoder-free](https://github.com/itandelin/qoder-free)、[agent2api](https://github.com/aimod-cc/agent2api)、[Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn)、[trae-local-api](https://github.com/laojichao/trae-local-api)、[trae2api-web](https://github.com/connectedGraph/trae2api-web)、[TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant)、[trae-agent](https://github.com/bytedance/trae-agent)、[copilot-api](https://github.com/ericc-ch/copilot-api)、[cursor2api](https://github.com/7836246/cursor2api)、[antigravity2api-nodejs](https://github.com/liuw1535/antigravity2api-nodejs)、[kiro2api](https://github.com/caidaoli/kiro2api)、[augment2api](https://github.com/linqiu919/augment2api)。
- 本仓库事实：`AGENTS.md`、`docs/rules/gateway-facts.md`、`docs/rules/STATE.md`、`wiki/01/04/05/10`、`docs/pitfalls.md`（#22/#39/#41/#60/#61/#63/#66）。
