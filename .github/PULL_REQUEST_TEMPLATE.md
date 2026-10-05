<!-- 改动落在哪一层？（静态配置 cordis.patch.yml / 组合根 index.js + host-config.js / 凭据边缘层 core/ / 上游适配器 providers/codebuddy|trae|qoder/ / 多服务商 providers/openai-compat.js 等 / 浏览器半 lib/client.js / 文档） -->

## 改动内容

<!-- 一段话说明改了什么、为什么（对应哪个 issue/现象） -->

## 验证

- [ ] 离线套件通过（`verify:bridge` `verify:rotation` `verify:core` `verify:providers` `verify:host-config`，按改动面选）
- [ ] 通道改动跑过 `verify:trae-provider` / `verify:qoder`
- [ ] 改 `lib/client.js` 跑过浏览器回归（`.agents/skills/dsh-ui-regression/`）

## 文档纪律

- [ ] 新增实测网关事实 → `docs/rules/gateway-facts.md`（或对应专题）
- [ ] 新增踩坑 → `docs/pitfalls.md` 新编号 + AGENTS.md 踩坑速查标签
- [ ] 面向使用者的新功能 → README 对应章节

## 风险与回滚

<!-- 哪些既有行为会受影响；出问题怎么退 -->
