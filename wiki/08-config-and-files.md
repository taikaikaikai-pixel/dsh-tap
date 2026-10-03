# 08 — 配置面、磁盘文件与数据流

## 磁盘文件清单（默认 `~/.dsh/`，可用 `DSH_HOME` 重定向）

| 文件 | 读写方 | 内容 | 权限/安全 |
|------|--------|------|-----------|
| `codebuddy-plugin.json` | 插件读写 | 设置文件层：全部用户设置 + `modelState`（disabled/extra/overrides）+ `traeModelState` + `qoderModelState` + `managedProviders` 登记册 | 无 secret（apiKeys 有 key 明文，仅本机） |
| `codebuddy-plugin-auth.json` | oauth.js 读写 | CodeBuddy OAuth 令牌 + 账号信息 | **永不回传浏览器** |
| `trae-plugin-auth.json` | trae/oauth.js 读写 | Trae OAuth 令牌 + 账号 + **设备身份（P-256 私钥 PKCS#8）** | 私钥永不出存储；视图只出 `signatureFormat` |
| `qoder-plugin-auth.json` | qoder/oauth.js 读写 | Qoder OAuth 令牌（`dt-`/`drt-`）+ 账号 + **machine_id** | 令牌与 machine_id 永不回传浏览器；0600 + tmp+rename 原子写 |
| `codebuddy-plugin-usage.json` | usage-meter | 用量累计（totalCredit/days/recent，三通道共用一张表） | 5s 去抖写盘 |
| `settings.yaml` | dsh 宿主（插件代写） | `llm-pi-ai.providers.codebuddy.models` 镜像 / `providers.trae` **整块** / `providers.qoder` **整块** / `providers.<extraId>` 块——chokidar 热加载，**免重启** | 注释保留的文档编辑（yaml 库 parseDocument/setIn/deleteIn） |
| `.credentials.yaml` | 插件代写（dsh 约定） | 多服务商 key（`<ID>_API_KEY`）、`CODEBUDDY_API_KEY` 兜底 | **必须 0600**，写后 chmod |
| `generated-images/` | images.js | 无会话工作区时的生图落盘 | — |

## 配置优先级

```text
文件层（~/.dsh/codebuddy-plugin.json） > 组合入口（cordis entry config） > schema 默认值
```

每次读取活解析：`resolveNow = () => Config({ ...config, ...readFileLayer() })`——设置卡保存后**下一次读取即生效**，配合 `applyLive()`（起停桥/网关/注册表）实现免重启。

## 模型可见性数据流（四条镜像规则）

### 1. CodeBuddy（纯净态纪律）

```mermaid
flowchart TB
    STATIC["静态 23 模型<br/>cordis.patch.yml（单一事实源）"] --> UNION["computeBaseModels()"]
    DYN["动态目录 /v3/config<br/>（启动 + 手动同步，失败回落静态）"] -->|成功| UNION
    UNION --> APPLY["− disabled（modelState.disabled）<br/>+ extra（目录新增且启用）<br/>+ overrides（contextWindow / maxTokens）"]
    APPLY --> EFF["computeEffectiveModels()"]
    EFF --> PR{"纯净态?<br/>无 disabled / extra / overrides<br/>且未同步目录"}
    PR -->|是| DEL{"settings.yaml 已有覆盖层?"}
    DEL -->|否| NOOP["无操作（patch 基线直接生效）"]
    DEL -->|是| RM["删除覆盖层路径<br/>（避免陈旧清单遮蔽 patch 更新）"]
    PR -->|否| DIFF{"镜像内容有变化?"}
    DIFF -->|否| NOOP2["无操作"]
    DIFF -->|是| W["铺新清单到 llm-pi-ai.providers.codebuddy.models<br/>（chokidar 热加载 → 选择器即时刷新）"]
```

- **纯净态**（无 disabled/extra/overrides 且未同步目录）→ **删除**覆盖层路径——陈旧的 settings 清单会遮蔽插件更新的静态模型。
- 动态目录存活期间**恒铺**（镜像内容每次启动随网关刷新，不算"陈旧"）。
- 基清单内的启停只动 `disabled`；目录新增模型禁用只删 `extra`（不写 disabled——否则状态永远非纯净）。

### 2. Trae（路由存在性管理，踩坑 #25 终版）

> 0.8.7 / dsh 0.1.1-rc.2 适配后的现行语义。旧版（≤0.8.5）"恒铺 models 路径 + 空数组遮蔽 patch 静态基线"已失效——llm-pi-ai 现在对非目录路由的**空 models 清单在 apply 时直接 throw**（连坐整棵 llm-pi-ai 纤维，主聊天全挂）。现行策略：patch **不带** trae 静态基线，`providers.trae` 路由的完整定义由镜像独占。

```mermaid
flowchart TB
    T(["syncTraeModelsToDshSettings()"]) --> C{"traeEnabled 且目录已同步<br/>且非全部禁用?"}
    C -->|是| REAL["铺完整块 providers.trae<br/>displayName / api / baseURL（跟 traeBridgePort）<br/>headers（哨兵 Bearer dsh-trae-bridge） / models"]
    C -->|否| DEL["删除 providers.trae 整块"]
    REAL --> ON["选择器显示 trae 模型<br/>（chokidar 热加载，改端口重铺即热生效）"]
    DEL --> OFF["路由消失，选择器隐藏通道<br/>（无 patch 基线即无回落，删块即干净）"]
```

升级注意：≤0.8.5 写入的旧 trae 块只带 models 路径（缺 baseURL 等字段），dsh 升到 0.1.1-rc.2 后首次启动前须手动清理，否则 llm-pi-ai 先于插件报错（详见 [CHANGELOG](../CHANGELOG.md) 0.8.7 迁移说明）。

### 3. Qoder（路由存在性管理，同 Trae 纪律，v0.9.8）

`syncQoderModelsToDshSettings()` 与 Trae 完全同构：patch **不带** qoder 静态基线，`providers.qoder` 路由完整定义由镜像独占——启用 + 目录已同步 + 非全部禁用 → 铺完整块（displayName `Qoder CN` / api / baseURL 跟随 `qoderBridgePort` / headers 哨兵 `Bearer dsh-qoder-bridge` / models 剔除 disabled）；禁用 / 未同步 / 全禁用 → 删整块。改端口重铺即热生效。

### 4. 多服务商（整块代写）

```mermaid
flowchart LR
    ADD(["设置卡添加上游"]) --> V["校验（id 正则 / baseURL / 保留路由）"]
    V --> PROBE["实测 GET /models 验 key 拿目录<br/>（404 → probeChatKey + fallbackModels）"]
    PROBE -->|失败| CLEAN["抛错——不落任何文件"]
    PROBE -->|成功| KC["key 写 .credentials.yaml<br/>（&lt;ID&gt;_API_KEY，chmod 0600）"]
    KC --> PB["provider 块写 settings.yaml<br/>（llm-pi-ai.providers.&lt;id&gt;）"]
    PB --> REG["登记册写文件层 managedProviders"]
    REG --> LIVE2["免重启生效：路由块 chokidar 热加载<br/>key 每请求活解析"]
```

凭据缝每请求活解析 key（env > credentials.yaml），路由块 chokidar 热加载——全程免重启。

## 密钥安全边界

| 边界 | 规则 |
|------|------|
| 浏览器 ↔ 宿主 | GET 只回 `maskKey`（首 4 + 尾 4）；OAuth 令牌/设备私钥**永不**出现在任何响应 |
| 文件 | `.credentials.yaml` 写后 chmod 0600；OAuth 令牌单独文件（settings GET 的 `user` 字段来自设置文件层，天然不含令牌） |
| 取证日志 | `CODEBUDDY_BRIDGE_LOG` 不落明文消息文本（哈希 + 60 字符预览）；authorization 分类 sentinel/caller-set 不逐字落盘。`CODEBUDDY_BRIDGE_DUMP` 是唯一明文落点（本地诊断，慎开） |
| 导入 | local-scan 的 findings 只含路径/类型/过期元数据；真值只在用户确认导入那一刻读取 |

## 端口与路由总表

| 端口 | 进程 | 路由 | 说明 |
|------|------|------|------|
| 3901（bridgePort） | core 桥 | `/v2/*` 透传；`/chat/completions` 特化 | CodeBuddy 主聊天 + agenttool 透传；仅 127.0.0.1；**不分流**，web/desktop 先占方持有、后到借桥 |
| 3902（traeBridgePort） | Trae 翻译网关 | `POST /v1/chat/completions`；`GET /v1/models` | OpenAI↔Trae 协议翻译；仅 127.0.0.1；web 线端口 |
| 3903（qoderBridgePort） | Qoder 翻译网关 | `POST /v1/chat/completions`；`GET /v1/models` | OpenAI↔COSY 加密信封翻译；仅 127.0.0.1；Host 门；web 线端口 |
| 3912 / 3913 | desktop 宿主 Trae / Qoder 翻译网关 | 同 3902 / 3903 | **0.16.0 分流**：非默认 profile（desktop）trae/qoder = 默认+10，与 web 各持各桥零借桥 |
| 3080 | dsh web | `/dsh-tap/settings` | 设置卡自有路由（ctx.webServer） |

改 3901 端口必须同时改 `cordis.patch.yml` 的 baseURL（或反之），否则主聊天断（设置卡有明示）。

**端口按宿主分流（0.16.0，goal docs/goals/bridge-port-host-split.md）**：web 与 desktop 是两进程、共享同一份 `~/.dsh/codebuddy-plugin.json`——分流端口**不持久化进共享文件层**（写进去两进程读同一份仍撞），每进程按自身宿主信号现读现算。归一函数 `resolveBridgePorts`（index.js，三端口有效值唯一出处）：默认 profile（目录名 `web`）或信号不可用 → 偏移 0（与既有行为逐位一致）；其余宿主 profile（如 `desktop`）→ trae/qoder 翻译网关分流到默认+10（3902→3912、3903→3913）。镜像 baseURL 跟随同源解析重铺（desktop patch qoder = `http://127.0.0.1:3913/v1`），改端口重铺即热生效。分流语义/「显式」判定/信号链路全表见 docs/rules/gateway-facts.md「桥端口按宿主 profile 分流」节。

## 环境变量

| 变量 | 作用 |
|------|------|
| `DSH_HOME` | 重定向 `~/.dsh`（测试隔离用） |
| `CODEBUDDY_API_KEY` | 单 Key 兜底（env 优先于 credentials.yaml） |
| `CODEBUDDY_BRIDGE_LOG` | 桥取证日志 JSONL 路径（不落明文） |
| `CODEBUDDY_BRIDGE_DUMP` | 请求体明文落盘目录（仅本地诊断，慎开） |
| `TRAE_BRIDGE_LOG` | Trae 网关取证日志路径 |
| `QODER_GATEWAY_LOG` | Qoder 网关取证日志路径 |
| `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` | 临时切回其他 web 后端（覆盖 patch 钉选） |
