# 贡献指南

感谢关注 dsh-tap。提交前请花一分钟读完本页——大部分打回都源于没做这几步。

## 环境

- Node ≥ 22（纯 ESM，无构建步骤），首次克隆后 `npm ci`。
- 本插件是 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)的插件，联调需要装好 dsh。

## 改代码前必读

- **[AGENTS.md](AGENTS.md)** —— 三层架构（静态配置 / 组合根 / 凭据边缘层 + 上游适配器 + 浏览器半）、改动生效方式、文档地图。改动前先想清楚落在哪层。
- 动上游出站行为（headers/UA/错误码/目录/额度）前，先 grep **docs/rules/gateway-facts.md** 与对应专题；动手前按编号查 **docs/pitfalls.md** 是否已有同款坑。
- `core/` 层禁止任何 CodeBuddy/Trae/Qoder 特化（`scripts/verify-core-generic.mjs` 会证伪）。

## 验证

| 场景 | 命令 |
|------|------|
| 大部分改动 | `npm run verify:bridge` `verify:rotation` `verify:core` `verify:providers` `verify:host-config`（离线、mock 上游） |
| Trae / Qoder 通道 | `npm run verify:trae-provider` `verify:qoder` |
| 改了 `lib/client.js` | 浏览器回归，先加载 `.agents/skills/dsh-ui-regression/` |
| 模型清单/档位 | `node scripts/verify-models.mjs --list`（离线）；`--sync`/`--efforts` 在线消耗额度 |

`npm run verify` 逐模型真实探测、消耗真实额度，仅在必要时本地跑；CI 只跑离线套件（`.github/workflows/node.js.yml`）。

## 提交约定

- 长期分支只有 `main`；commit message 用 conventional commits（`feat:`/`fix:`/`docs:`/`chore:`…）。
- 发版由维护者执行：`chore(release)` 提交当场打 annotated tag `vX.Y.Z` 并随分支推送；**永不 rebase 已推送历史**（CHANGELOG 引用提交 SHA）。
- 新增实测网关事实 → `docs/rules/`；新增踩坑 → `docs/pitfalls.md` 取新编号并在 AGENTS.md 踩坑速查加标签；AGENTS.md 本身体积有 CI 硬闸门，保持薄索引不铺长段落。

## 反馈 Bug

用 [issue 模板](https://github.com/taikaikaikai-pixel/dsh-tap/issues/new?template=bug_report.yml)提交，附上 `GET /dsh-tap/settings?probe=host-config` 的输出与复现步骤——排查入口见 README「排查与已知问题」。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
