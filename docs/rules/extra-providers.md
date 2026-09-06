# 多服务商（G6/G7 key 型上游）实测事实

> 裁判对象：`providers/openai-compat.js` 共享骨架与 `providers/<name>/` preset。
> 变更这些文件前先读本表；新实测追加，勿凭记忆改。

## 端点实测矩阵（2026-08-19，无 key/假 key 只读探测）

| 上游 | baseURL | GET /models | POST /chat/completions（假 key） | 结论 |
|---|---|---|---|---|
| 火山 ark | `https://ark.cn-beijing.volces.com/api/v3` | 401（端点存在） | — | 标准 OpenAI 目录，GET /models 验 key 即可 |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 401（端点存在） | — | 同上 |
| iFlow 心流 | `https://apis.iflow.cn/v1` | **404（无此路由，与是否带认证无关）** | HTTP 200 + `{"status":"434","msg":"Invalid apiKey…"}` | **无目录端点**；认证方言是 200 包 434 |
| Qwen Code | `https://portal.qwen.ai/v1` | **404（无此路由）** | 标准 401 `invalid_api_key` | **无目录端点**；标准认证拒绝 |

## 规则

- **E-P1 双通道验 key**：有 /models 的上游走 GET /models（同时拿目录）；404（`MODELS_ENDPOINT_404`）且 preset 声明 `fallbackModels` 时回落 `probeChatKey`——POST /chat/completions 最小探针（`max_tokens:1`，耗量可忽略，仅导入时用户确认后跑一次）。证据：本表矩阵 + `scripts/verify-providers.mjs`。
- **E-P2 认证失败分类**：HTTP 401/403，或 body 命中 `/invalid[_ ]?(api[_ ]?key|access token)|unauthorized|"status"\s*:\s*"?434/i` → key 无效；其余一切响应（含模型错误类 4xx）视为 key 有效（服务器拒绝的是请求内容）。假阳性风险可接受：探针只发 1 token。
- **E-P3 自定义上游严格**：无 fallbackModels 的 custom 条目 /models 404 原样报错——自定义 URL 的正确性由用户负责。
- **E-P4 无目录上游的模型清单 = preset 兜底表**：清单项错了会在聊天时显性报错；"刷新模型"对 preset 条目重跑同一逻辑（上游日后补上 /models 会自动回到真实目录）。iflow 清单来自公开用户配置实例（qwen3-coder-plus 等多源交叉），非官方文档。
- **E-P5 Qwen OAuth 免费额度已停服**：官方文档载 2026-04-15 起 Qwen OAuth free tier 停发，存量 token "may continue working briefly"——本机 `~/.qwen/oauth_creds.json` 的 token 大概率已失效，导入时探针会如实拒绝（已实测假 key 401）。Coding Plan（`sk-sp-` key）是**另一端点** `coding.dashscope.aliyuncs.com/v1`（国际站 coding-intl），模型面 qwen3.5/3.6/3.7-plus、qwen3-coder-plus/next、glm-5/4.7、kimi-k2.5、MiniMax-M2.5——若用户持有可作新 preset。
- **E-P6 iFlow 搜索 API 是另一域名另一形态**：`platform.iflow.cn/api/search/*`（webSearch/imageSearch/webFetch）与 LLM 端点 `apis.iflow.cn/v1` 并存，同 key 体系；v0.8 未接入搜索面。

## 落点速查

- 骨架与探针：`providers/openai-compat.js`（fetchOpenAIModels / probeChatKey / createOpenAICompatProvider）
- preset：ark / bailian / iflow / qwen（`providers/<name>/index.js`，fallbackModels 仅 iflow、qwen 声明）
- 编排：index.js `PROVIDER_PRESETS` / `addExtraProvider` / `refreshExtraProviderModels`（preset 条目刷新时合并 fallbackModels）/ `credential-import`（finding 同 id 同 baseURL 命中 preset 通道）
- 离线回归：`scripts/verify-providers.mjs`（13 断言）；E2E：step29（mock 上游全链路）、step30（扫描展示）
