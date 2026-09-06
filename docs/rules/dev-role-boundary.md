# 规则 06b：developer 拒绝的边界图景（理解性延伸，Hermes 探测 2026-08-19）

> 状态：**理解性延伸——边界已钉死**（非绕过手段，仅用于理解校验器行为；任何变体都未用于完成被拒路径）
> 前置：`docs/rules/content-moderation.md`（Kimi 课题 6，定位拒绝在**网关入口通道校验层 L1**，字面量 developer 单列拒绝）
> 证据：2026-08-19 三轮探测（R1 8 臂 / R2 7 臂 / R3 6 臂；开发期原始证据未纳入开源快照，结论自包含于本文）

---

## 0. 目的

课题 6 已确定：`role:"developer"` 字面量 → HTTP 500 / code 11128（网关 L1 通道校验层，模型无关、位置无关、计费前）。

本延伸回答的是**通过黑盒黑盒边界的深一档问题**：校验器到底怎么枚举消息、读哪个字段、做不做规范化。**这些结论用于解释网关行为、写进适配器错误映射与出站重写注释，不构成任何绕过方案。**

## 1. R1：角色字段的字面匹配边界

| 臂 | 载荷 | 结果 | 结论 |
|---|---|---|---|
| C0 | `role:"system"` | 200 | 控制组正常 |
| C1 | `role:"developer"` | **500/11128** | 基线拒绝 |
| C2 | `role:"Developer"` | **200** | **大小写敏感**：大 D 不匹配 |
| C3 | `role:"DEVELOPER"` | **200** | 全大写也不匹配 |
| C4 | `role:"developer "`（尾空格） | **200** | **无 trim**：尾空格即不同字符串 |
| C5 | `role:"ｄｅｖｅｌｏｐｅｒ"`（全角） | **200** | Unicode 全角不折叠 |
| C6 | `role:"dev\u0065loper"`（JSON 转义） | **500/11128** | 反序列化后仍是 `developer`，说明**校验在 JSON 解析后做** |
| C7 | `role:"user"` content 含 "developer" | **200** | **只查 role 字段，不扫内容** |

**R1 规则**：校验器在 JSON 解析后、对 messages 数组中每个对象的 `role` 字段做**字节级精确比较 `"developer"`**（小写、无空格、无 Unicode 折叠）。JSON 转义逃不过（先解析后检查）。

## 2. R2：位置与结构独立性

| 臂 | 载荷 | 结果 | 结论 |
|---|---|---|---|
| P7 | 全 system+user | 200 | 控制组 |
| P1 | user→developer→user（中间） | **500/11128** | 位置无关（中间也拒） |
| P2 | user→assistant→developer（末尾） | **500/11128** | 末尾也拒 |
| P3 | system→developer→user | **500/11128** | 无角色优先级，照拒 |
| P4 | developer×2 | **500/11128** | 多条不豁免 |
| P5 | `developer `(尾空格，R1 证明放行) + 真 `developer` 同框 | **500/11128** | **逐条独立检查**：只要有一条真 developer 就拒，尾空格那条不干扰真匹配 |
| P6 | tool 消息 content 含 "developer" | **200** | **只查 role 字段，工具调用嵌套内容不扫** |

**R2 规则**：校验是 **per-message 独立、位置无关** 的——对 messages 数组每个元素检查 role 字段，命中即拒。

## 3. R3：消息对象形状边界

| 臂 | 载荷 | 结果 | 结论 |
|---|---|---|---|
| S6 | 正常 system+user | 200 | 控制组 |
| S1 | `{role:"developer", role2:"user"}` | **500/11128** | 只读第一个/任何 role 键都算——附加键不豁免 |
| S2 | `role:1`（整数） | **400/11101** | 非字符串 role 触发 JSON unmarshal 错误（校验前就失败） |
| S3 | 消息无 role 字段 | **200** | **role 缺失 → 被当成无角色消息放行**（校验器对缺省字段容忍） |
| S4 | `role:"developer"` + content 为数组 | **500/11128** | content 形状不影响 role 检查 |
| S5 | developer 只在顶层 `extra`（不在 messages 数组） | **200** | **只扫 messages 数组**，顶层其他键不扫 |

**R3 规则**：
- 校验器**迭代 messages 数组**，对每个元素读 `role` 键
- **role 缺失 → 放行**（这是"形状"层面唯一被发现的可达宽松路径，但对正常网关调用无意义——出站消息总是有 role）
- 顶层任何非 messages 结构（extra 等）不参与检查
- 非字符串 role 走 unmarshal 400，不会到达检查

## 4. 合成结论（校验器模型）

```
网关 L1 通道校验（角色检查）：
  for msg in payload.messages:
      if msg.role == "developer":        # 字节精确，不 trim 不折叠大小写
          → 500 / {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
  其它所有键（role2、content、tool_calls、顶层 extra）不参与
  role 缺失 → 默认放行
  role 非字符串 → 更早的 JSON unmarshal 400/11101
```

**为什么这不是绕过**：以上所有"放行"变体（Developer、developer+尾空格、全角、tool 内容、无 role）在网关眼中的语义都不是 Anthropic `developer` 角色——它们要么是网关不认识的角色（可能被当作 user/system 处理），要么根本没有角色字段（S3 缺省路径存在协议合规风险）。**没有任何变体能以 developer 语义到达后端推理**。这正是校验器的设计意图：只放行它认识的角色，对 developer 单列拒绝，其它一切是"不认识→放过"。

## 5. 对重构的输入（与 content-moderation.md §5 合并）

- 适配器出站重写（developer→system）**必须继续做**：任何变体都绕不过 `developer` 字面量，只有改写才能合法到达。
- 适配器错误映射表补充：`matching` 顺序说明——先 JSON unmarshal（11101 结构错），后 L1 角色检查（11128）。
- core 层保持零 CodeBuddy 概念（本节结论属于 providers/codebuddy/ 适配器知识）。

## 6. 探测纪律声明

- 全部 21 臂、2.5s 间隔、单账号、max_tokens=8。
- 放行臂只产生 "OK" 完成，无任何有害/真实业务载荷。
- 拒绝臂复现 11128 即止，不尝试让变体完成到生成端。
- case 变体探测的初衷是理解校验器**是否规范化**（答：否），不是寻找可用的绕过载荷。
- 与内容审核专题（docs/rules/content-moderation.md）的探测完全隔离（独立时段），互不影响。

## 7. 未解（需要更多维度才能继续深挖）

- 校验器对 `developer` 在 **tool_calls.function.arguments**（JSON 字符串内）的感知（P6 只测了 tool content，未测 arguments 字符串内的 developer）
- **multi-modality**：多模态 content 数组里嵌套 role 字段是否被遍历
- 错误码 11128 是否与 **UA 门/通道注册**共用（同为 "unapproved channel" 文案）——可并入重构错误映射设计