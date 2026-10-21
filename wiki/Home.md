# dsh-tap — Code Wiki 首页

> 当前版本：**0.26.0**（优化计划四批：0.23.0 可靠性（上游超时纪律/路由护栏/额度卡自愈/结构化状态，踩坑 #75–#78）、0.24.0 统一性（回环门 6→1、本机 HTTP 面 3→1、监听生命周期 3→1、错误出口契约、`npm run verify` 改离线聚合，踩坑 #79–#81）、0.25.0 可维护性（组合根 2517→290 行拆成 `host/**` 12 模块、先立路由契约再拆、发布完整性闸门，踩坑 #82–#83）、0.26.0 可扩展性（通道契约与清单驱动装配，加通道 = 一个描述符 + 一处登记，踩坑 #84）；详见 [CHANGELOG.md](../CHANGELOG.md) 与 [wiki/02](02-composition-root.md)（文件地图）/[wiki/11](11-add-a-channel.md)（加通道）。上一段历史：0.10.0 设置卡 4 区块手风琴换代、0.9.10 适配 dsh 0.1.7-alpha.2 配置持久化改向、0.9.7/0.9.8 补齐 Qoder 叙事）

## 项目是什么

把腾讯 **CodeBuddy 网关**（`copilot.tencent.com`）接入 **DeepSeek Harness（dsh）** 的插件包，同时内置第二上游 **TraeWork CN 订阅额度通道**（v0.8.x 起）与第三上游 **Qoder CN 通道**（v0.9.7/0.9.8 起，设备流 OAuth + COSY WASM 签名 + OpenAI↔加密信封翻译网关 :3903）。纯 ESM，Node ≥ 22，运行时仅两个依赖（`@deepseek-ai/schemastery`、`yaml`）。

核心能力一览：

| 能力 | 载体 | 说明 |
|------|------|------|
| 18+ 模型接入（可运行时增删） | `cordis.patch.yml` + 模型镜像 | DeepSeek / GLM / Kimi / MiniMax / 混元 / auto；目录动态同步（`/v3/config`） |
| 主聊天统一凭据入口 | 流式桥 `:3901`（`core/bridge.js`） | OAuth 或多 Key 轮询；出站重写 developer→system |
| `web_search` / `web_fetch` 后端 | `providers/codebuddy/agenttool.js` | dsh 原生工具的 CodeBuddy `/agenttool` 实现 |
| `image_generate` 生图工具 | `providers/codebuddy/images.js` | 混元生图 `/v2/images/generations` |
| TraeWork CN 通道 | `providers/trae/`（翻译网关 `:3902`） | OAuth 订阅额度 + OpenAI↔Trae 协议翻译 + state.vscdb 目录 |
| Qoder CN 通道 | `providers/qoder/`（翻译网关 `:3903`） | PKCE 设备流 OAuth + COSY WASM 签名 + 签名目录 + 加密信封翻译（0.9.7/0.9.8） |
| 多服务商注册表 | `providers/openai-compat.js` + presets | key 型 OpenAI 兼容上游（Ark/百炼/DeepSeek/智谱/Moonshot/OpenRouter/Qwen/自定义），免重启热加载 |
| Web UI 设置卡 | `lib/client.js` | 设置 → 插件配置 → CodeBuddy（八个功能分区） |

## 文档导航

| 文档 | 内容 |
|------|------|
| [01-architecture.md](01-architecture.md) | 整体架构、分层职责、主聊天/设置/模型镜像三条数据流、dsh 宿主缝 |
| [02-composition-root.md](02-composition-root.md) | `index.js` 组合根：apply 生命周期、Config schema、模型管理、凭据编排、设置路由契约 |
| [03-core-layer.md](03-core-layer.md) | `core/` 凭据边缘层：bridge / rotation / json-store / usage-meter 逐模块 API |
| [04-provider-codebuddy.md](04-provider-codebuddy.md) | CodeBuddy 适配器：headers / errors / oauth / catalog / agenttool / images |
| [05-provider-trae.md](05-provider-trae.md) | Trae 通道：自持设备密钥 OAuth、目录提取、翻译网关、remote 传输、错误码表 |
| [06-provider-openai-compat.md](06-provider-openai-compat.md) | 多服务商骨架、七个 preset、本机凭据扫描导入 |
| [07-web-client.md](07-web-client.md) | 浏览器半设置卡：模块格式、分区结构、UI 资源复用 |
| [08-config-and-files.md](08-config-and-files.md) | 配置面、磁盘文件落点、优先级、密钥安全边界 |
| [09-run-and-test.md](09-run-and-test.md) | 运行方式、验证/探测脚本全集、环境变量、浏览器回归 |
| [10-provider-qoder.md](10-provider-qoder.md) | Qoder CN 通道：PKCE 设备流、COSY WASM 签名、签名目录、翻译网关 :3903 |

## 仓库目录树

```text
dsh-tap/
├── index.js                  # 组合根：Config/schema、模型管理、凭据编排、设置路由、apply 生命周期
├── cordis.patch.yml          # 静态配置：llm-pi-ai 路由（指向本地桥）+ 模型基线 + 默认模型 + web 钉选
├── local-scan.js             # G7 本机登录态只读扫描 + 确认后导入
├── core/                     # 凭据边缘层（provider 无关，静态扫描锁纯净）
│   ├── bridge.js             #   流式桥：会话归因 / 并发闸 / SSE 聚合 / 取证
│   ├── rotation.js           #   KeyRotator：多 Key 轮询 / 冷却 / failover
│   ├── json-store.js         #   JSON 文件读写 + env/credentials.yaml 凭据解析
│   └── usage-meter.js        #   用量计量存储（credit/token 累计、轮次聚类）
├── providers/
│   ├── codebuddy/            # CodeBuddy 上游适配器（headers/errors/oauth/catalog/agenttool/images）
│   ├── trae/                 # TraeWork CN 适配器（oauth/catalog/gateway/remote/errors）
│   ├── qoder/                # Qoder CN 适配器（oauth/cosy/catalog/gateway + qoder_auth.wasm）
│   ├── openai-compat.js      # key 型 OpenAI 兼容上游共享骨架
│   ├── ark/ bailian/ deepseek/ bigmodel/ moonshot/ openrouter/ qwen/   # 七个 preset
├── lib/client.js             # 浏览器半：设置卡（React.createElement，无构建步骤）
├── scripts/                  # 验证（verify-*）/ 探测（probe-*）/ 测量（measure-*）脚本
└── docs/                     # 规则裁判文档（rules/）、逆向档案（reverse/）、探测证据（probes/）
```

## 快速上手

```sh
# 1. 起 dsh 测试服务（默认 3080 端口；插件随 dsh 启动自动加载）
dsh web

# 2. 离线回归（不需要网络与凭据）
node scripts/verify-bridge.mjs          # 桥回归（30 项断言）
node scripts/verify-core-generic.mjs    # core/ 通用性证伪（静态扫描 + 第二上游全链路）
node scripts/verify-rotation.mjs        # 多 Key 轮询回归
node scripts/verify-providers.mjs       # 多服务商骨架回归
node scripts/verify-trae-provider.mjs   # Trae 通道回归（81 断言）
node scripts/verify-qoder-provider.mjs  # Qoder CN 通道回归（83 断言）

# 3. 登录（设置卡 → 插件配置 → CodeBuddy，或 CLI 探测脚本）
node scripts/verify-models.mjs --list   # 离线自检模型解析
```

详细内容见 [09-run-and-test.md](09-run-and-test.md)。

## 关键工程纪律（改代码前必读）

1. **core/ 禁止出现任何 CodeBuddy/Trae/Qoder 特化**——`verify-core-generic.mjs` 静态扫描锁；上游事实只能放 `providers/`。
2. **共享层的运行状态必须是实例状态**——core/ 与 providers/ 一律导出工厂/类（`new KeyRotator()`、`createBridge()`），实例在 `index.js` 模块作用域创建（隔离语义见 [docs/pitfalls.md](../docs/pitfalls.md) #20）。
3. **listen 失败绝不崩宿主**——桥/网关绑端口前必须挂 `server.on('error')` 降级为 `runtime.lastError`（踩坑 #17）。
4. **令牌与 key 永不回传浏览器**——设置卡 GET 只回脱敏视图；OAuth 令牌单独存文件。
5. **改配置层（patch）要重启 dsh；设置卡/镜像层免重启热生效**。
6. 完整踩坑清单（27 条，含代价）见 [docs/pitfalls.md](../docs/pitfalls.md)（自 AGENTS.md 迁出，编号不变）。
