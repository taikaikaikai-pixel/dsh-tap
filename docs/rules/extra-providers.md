# 多服务商（G6/G7 key 型上游）实测事实

> 裁判对象：`providers/openai-compat.js` 共享骨架与 `providers/<name>/` preset。
> 变更这些文件前先读本表；新实测追加，勿凭记忆改。

## 端点实测矩阵（2026-08-19，无 key/假 key 只读探测）

| 上游 | baseURL | GET /models | POST /chat/completions（假 key） | 结论 |
|---|---|---|---|---|
| 火山 ark | `https://ark.cn-beijing.volces.com/api/v3` | 401（端点存在） | — | 标准 OpenAI 目录，GET /models 验 key 即可 |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 401（端点存在） | — | 同上 |
| Qwen Code | `https://portal.qwen.ai/v1` | **404（无此路由）** | 标准 401 `invalid_api_key` | **无目录端点**；标准认证拒绝 |

## 端点实测矩阵（2026-09-11 复测 + 新候选，假 key 只读探测）

| 上游 | baseURL | GET /models | POST /chat/completions（假 key） | 结论 |
|---|---|---|---|---|
| 火山 ark | 同上 | 401 AuthenticationError | — | 端点健在，**保留** |
| 阿里百炼 | 同上 | 401 invalid_api_key | — | 端点健在，**保留** |
| Qwen Code | 同上 | 404（不变） | 标准 401 invalid_api_key | 端点健在、探针可验 key；E-P5 停服只影响 OAuth 存量 token，不影响 key 通道，**保守保留** |
| DeepSeek 官方 | `https://api.deepseek.com/v1` | 401 authentication_error | — | 标准目录，**新增 preset** |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | 401（令牌已过期或验证不正确） | — | 标准目录，**新增 preset** |
| Moonshot AI | `https://api.moonshot.cn/v1` | 401 invalid_authentication_error | — | 标准目录，**新增 preset** |
| OpenRouter | `https://openrouter.ai/api/v1` | **200（公开目录：任意/无 key 都返回全量 437 条）** | 401 `User not found.` | 目录不能验 key → staticCatalog + 探针，**新增 preset** |

## 规则

- **E-P1 双通道验 key**：有 /models 的上游走 GET /models（同时拿目录）；404（`MODELS_ENDPOINT_404`）且 preset 声明 `fallbackModels` 时回落 `probeChatKey`——POST /chat/completions 最小探针（`max_tokens:1`，耗量可忽略，仅导入时用户确认后跑一次）。证据：本表矩阵 + `scripts/verify-providers.mjs`。
- **E-P2 认证失败分类**：HTTP 401/403，或 body 命中 `/invalid[_ ]?(api[_ ]?key|access token)|unauthorized|"status"\s*:\s*"?434/i` → key 无效；其余一切响应（含模型错误类 4xx）视为 key 有效（服务器拒绝的是请求内容）。假阳性风险可接受：探针只发 1 token。
- **E-P3 自定义上游严格**：无 fallbackModels 的 custom 条目 /models 404 原样报错——自定义 URL 的正确性由用户负责。
- **E-P4 无目录上游的模型清单 = preset 兜底表**：清单项错了会在聊天时显性报错；"刷新模型"对 preset 条目重跑同一逻辑（上游日后补上 /models 会自动回到真实目录）。
- **E-P5 Qwen OAuth 免费额度已停服**：官方文档载 2026-04-15 起 Qwen OAuth free tier 停发，存量 token "may continue working briefly"——本机 `~/.qwen/oauth_creds.json` 的 token 大概率已失效，导入时探针会如实拒绝（已实测假 key 401）。Coding Plan（`sk-sp-` key）是**另一端点** `coding.dashscope.aliyuncs.com/v1`（国际站 coding-intl），模型面 qwen3.5/3.6/3.7-plus、qwen3-coder-plus/next、glm-5/4.7、kimi-k2.5、MiniMax-M2.5——若用户持有可作新 preset。
- **E-P6（历史）iFlow 心流 2026-09 停服，preset 已移除**：其搜索 API（platform.iflow.cn/api/search/*）与 LLM 端点曾并存同 key 体系，从未接入；本行仅作历史留存。
- **E-P7 公开目录上游（OpenRouter）走 staticCatalog**：/models 对任意 key 都 200 且全量 437 条——既不能验 key 也不宜全量进选择器。preset 声明 `staticCatalog: true` 后 fetchModels 不调 /models：chat 探针验 key（E-P2 分类），清单恒吃 `fallbackModels` 内置精选表（2026-09-11 当日目录实况选取各厂商旗舰，探针用首项）。目录漂移靠版本更新内置表；刷新模型重跑同一逻辑。回归：verify-providers 第 9 节。
- **E-P8 思考档位声明（`modelEfforts`，0.19.0）**：preset 可声明 `modelEfforts: { '<模型 id>': { <档位>: <线值> } }`，`providerBlock` 写入时按模型 id 合并进条目的 `reasoningEfforts`，宿主输入框的「推理等级」据此出档；`provider-refresh` / `provider-test` 经共用接缝 `rebuildAdapterForEntry` 重建 adapter 时带上该字段 ⇒ **刷新不丢声明**（0.19.0 修：此前 refresh 裸调 `createOpenAICompatProvider` 漏传声明字段，每次刷新洗掉档位表；add 路写块用 preset adapter 原对象、闭包自带声明，本就不丢——refresh/add 两路都传）。配套 `reasoningCompat: true` 才写 `compat.supportsReasoningEffort`（缺它 pi-ai 出站不会把选中档位写成 `reasoning_effort` = 出档但不生效）。两条纪律：a) **逐条要有实测/厂商文档依据**——`/models` 目录**不发布**档位信息，这份表只能靠探测或厂商文档，不能批量臆造（踩坑 #42）；没验证过的 provider 保持不声明 = 不出档，而不是摆假档位；b) **拼写逐上游不同**（OpenAI 官方 `low/medium/high`、OpenRouter 走 `reasoning:{effort}` 另一方言）——本层只透传，不做拼写映射，需要换 `thinkingFormat` 的上游另给 compat。回归：verify-providers 第 7c–7e、10 节。

## 落点速查

- 骨架与探针：`providers/openai-compat.js`（fetchOpenAIModels / probeChatKey / createOpenAICompatProvider / rebuildAdapterForEntry（test/refresh 共用重建接缝），staticCatalog 形态见 E-P7；档位透传见 E-P8）
- preset：ark / bailian / deepseek / bigmodel / moonshot / openrouter / qwen（`providers/<name>/index.js`；fallbackModels 仅 qwen、openrouter 声明，openrouter 兼 staticCatalog）
- 编排：index.js `PROVIDER_PRESETS` / `addExtraProvider` / `refreshExtraProviderModels`（preset 条目刷新时合并 fallbackModels/staticCatalog/modelEfforts/reasoningCompat）/ `credential-import`（finding 同 id 同 baseURL 命中 preset 通道）
- 离线回归：`scripts/verify-providers.mjs`（24 断言）；E2E：step29（mock 上游全链路；step30 扫描展示脚本在 dsh-ui-test 重建丢失后未恢复，勿凭本文引用）
