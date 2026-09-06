# 规则 03：路由分配维度（14407）

> 状态：**规则成立**（账号/套餐维度单账号不可变，标未解——见 §5）
> 证据：2026-08-19 探测记录 19 条（3 轮矩阵 + 每轮 catalog 锚点）+ 2026-08-17 媒体端点存量锚点（开发期原始证据未纳入开源快照，结论自包含于本文）

## 1. 现象（上游咒语原文）

- AGENTS.md:24 —「`/v2/videos/generations`、`/v2/3d/generations` 路由存在但当前账号一律 14407 `route config not found`（无可用模型）」
- CHANGELOG.md:50 — 同咒，作"停止规则"存档

咒语把 14407 当作"端点不可用"的整体判断。实测它是一个**分层路由结构里某一层的失败码**。

## 2. 规则（每条附验证过程；预测均为预注册后实测）

### R-R1 第一层：路径路由

未知路径 → `404 "Route Not Found"`（纯文本、无 JSON 信封、与业务码无关）。
**预注册命中**：P6 `/v2/foo/generations` → 404 ✓。

### R-R2 第二层：家族模型注册表（14401/14407 的真身）

注册表查找以 **(家族, 模型名)** 为键；未命中时报错码**按家族分**，消息**逐字回显模型名**（含空串）：

| 家族 | 端点 | 未命中码 | 消息模板 |
|---|---|---|---|
| image | /v2/images/generations | **14401** | `Create image failed with error: Image model [<echo>] route config not found` |
| video | /v2/videos/generations | **14407** | `Create video failed with error: Video model [<echo>] route config not found`（另有兜底变体，见 R-R4） |
| 3d | /v2/3d/generations | **14407** | `Create 3d failed with error: 3d model [<echo>] route config not found` |

**预注册命中**：C1（images 省略 model → 14401 回显空串）✓、C2（video + 全新假名 `no-such-video-model` → 14407 逐字回显）✓、C3（3d 省略 model → 14407 回显空串）✓。
**推翻记录**：原假设"14407 是通用码"被 P2 推翻（image 家族用 14401）——咒语里的 14407 只是 video/3d 家族的号码。

### R-R3 chat 家族：独立注册表 + 11102，且**与 /v3/config、cli 清单均不等价**

- chat 模型未命中 → `400 + 11102 "model [<echo>] service info not found"`（措辞与媒体家族不同）。
- chat 注册表 **不等于** 账号目录（/v3/config 24 模型）：`deepseek-v3` 不在目录却每日可用；`glm-5.0` 在目录却 11102；目录内部 id `deepseek-v3-2-volc` 也能路由（200）。
- **不等于 cli 启用清单**（12 个）：`kimi-k2.5` 不在 cli 清单照样 200。

**预注册命中**：C4（全新假名 `no-such-model-abc` → 11102 逐字回显）✓、C5（kimi-k2.5 非 cli 清单 → 200）✓。
**推翻记录**：C6 预测 volc 内部 id 11102 → 实测 200；C7 预测 hunyuan-chat 后端不支持 → 实测 200。chat 注册表比任何可见清单都宽，**客户端无可用的"可路由模型"权威清单**（catalog/cli/deepseek-v3 案例三方互斥）。

### R-R4 第三层：后端派发（模型已知、家族不支持）

模型在全局可解析但其后端不支持该家族时，错误按家族分信封：

| 家族 | HTTP | code | 消息 |
|---|---|---|---|
| chat | 500 | 11103 | `Backend [<name>] is not supported` |
| 3d | 400 | 11103 | `Backend [<name>] is not supported for 3d generation` |
| video | 400 | **14407** | `unsupported video params`（14407 兼作 video 家族兜底码） |
| image | 500 | — | **无 JSON 信封**（空 body 崩溃） |

**预注册命中**：D2（images + kimi-k2.6 → 裸 500 无信封，全新模型复现 P3）✓、D3（chat + 图像模型 → 500/11103 复测稳定）✓、E1（video + kimi-k2.6 → 400/14407 "unsupported video params" 兜底复现）✓。
**推翻记录**：D1 预测 video 走 11103 → 实测 14407 兜底，修正规程后由 E1 锁定。

## 3. 回答课题：路由按什么维度分配

可观测维度（单账号）：
1. **路径**（家族端点是否存在）→ 404 层
2. **(家族 × 模型名)** 注册表 → 14401/14407/11102 层
3. **模型 → 后端映射 × 后端支持的家族集** → 11103/14407 兜底/裸 500 层

咒语的"当前账号一律 14407"在此框架内的准确表述：**本账号（及全局）没有名为 hunyuan-video-t2v / hunyuan-3d 的模型注册项**；/v3/config 中也没有任何 video/3d 家族模型，与"该账号无媒体家族（除 image）可用模型"一致。

## 4. 对重构的输入

- 薄适配器侧错误映射表：14401/14407/11102/11103 皆为**客户端可结构化解析**的业务码（msg 含模型名回显），core 层只需透传 code/msg，不做字符串匹配。
- 图像家族裸 500 无信封——core 层的错误规范化要容忍"非 JSON 500"。

## 5. 未解（诚实标注）

- **账号/套餐维度不可证伪**：单账号无法变异；目录（/v3/config）是账号级证据，但目录成员资格与可路由性三方互斥（R-R3），故"路由是否按账号套餐分配"标**未解**。
- `auto` 模型的路由分解（分配到哪个实体模型、按什么信号）未测——属课题 3 延伸，需 dump 对比 auto 与显式模型的响应头/延迟分布。
- images 家族裸 500 是网关崩溃还是刻意，不可进一步区分。

## 6. 复跑路径

原始探测脚本（矩阵 P1–P6 + X1、确认轮 C1–C8、信封轮 D1–D3、兜底轮 E1）为开发期一次性工具，未纳入开源快照；本文结论按轮次编号自包含。
