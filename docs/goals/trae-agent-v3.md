# Goal：Trae 通道「额度/模型/工具环」在 DSH 闭环（agent v3 路由移植）

**立项**：2026-10-05 ｜ **状态**：M1–M3 完成（分支 feat/trae-agent-v3），发版待用户确认
**完成定义**：在 dsh-tap 的 Trae 通道接入上游 agent 路由 `POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`，使 DSH 内 Trae 订阅达到「模型可流式对话 + 工具环端到端 + 消耗本机订阅积分」闭环；证据先行、离线套件全绿。

## 关键转向（M1 探针发现）

社区两个参照实现（dsh-connect-trae / Trae2api-cn）的「agent 路由」**不是新 function 名**，而是同端点的 `function=solo_work_lite` 面——fn 名扫描（agent_chat/agent_v3/solo_agent_chat/agent/assistant_chat 均 2001 未注册）证伪了「专用 agent function」假设后，由参照源码锁定 solo_work_lite。该面与 inline_chat 同端点但方言不同（历史 tool_calls 键=function_call，踩坑 #68）。

## M1 探针结论（证据 docs/probes/trae-agent-v3-2026-10-04.jsonl，决策门 PASS）

| 臂 | 内容 | 结果 |
|---|---|---|
| A1 | 纯聊天 | 200 SSE，14 事件，finish=stop |
| A2 | tools+auto | 200，出 tool_calls（function_call 键，index 分片） |
| A3 | 两轮工具闭环 | 200，第二轮产出最终回答（首轮 function 键被拒 2001 → 换 function_call 键通过） |
| A4 | 并行调用 | 200，单事件双 tool_calls |
| A5 | reasoning_effort=high | 200 被接受但被忽略（行为同 A2） |
| E1 | 错模型名 | 200 静默容忍（该面宽容） |
| E2 | 坏参数（temperature 字符串） | 200 静默容忍 |
| A6 | kimi-k2.6 / DeepSeek-V4-Flash | 200，provider_model_name 恒 glm-5.2（模型位钉死） |

额度：token_usage 事件带真实计数（prompt/completion/reasoning/cache_read）；pay 池差分对小探测不可见（分辨率 0.01 credit）。

## M2 实装（providers/trae/ + index.js；core/ 零 diff）

- `gateway.js`：`buildChatRequest(payload, sessionId, {fnKey})`；`handleChat` agent 分支（function=solo_work_lite、fnKey=function_call、不回退 chat_v3）
- `errors.js`：码表补 2001/4001/4011/4023/9074；3003 提示补 agent 出路
- `index.js`：`traeChatTransport` 枚举加 `'agent'`；`lib/client.js` 设置卡第三档
- reasoning_effort 照发不虚标；档位注入维持仅 remote 面

## M3 验证

- verify-trae-provider 131→**141** 断言全绿（agent 节 8 断言）；离线十一套件全绿；core/ 零 diff
- 真实端到端（生产网关+真实凭据临时实例）：R1 带 tools → finish_reason=tool_calls + 参数拼回；本地执行 → R2 回传 → 最终回答「当前时间是 2026年10月5日 14:30:00」；meter 记真实模型 glm-5.2
- probe-effort-gaps 三通道 11/11 无缺口；card-accordion 204/0 + md5 跑前后一致

## M4 收尾状态

- docs/rules/gateway-facts.md「agent 面」节、docs/diagnosis-trae-3003.md §13 销案、docs/pitfalls.md #68、AGENTS.md 速查、CHANGELOG 0.20.0、STATE.md——均已写
- **未做**：发版（版本号 + annotated tag + push）——按 goal 红线等用户确认；默认传输档未动（inline/remote/agent 默认值决策留给用户）；M0（装 dsh-connect-trae 对照）跳过。
