---
name: dsh-ui-regression
description: >
  dsh-tap 设置卡的浏览器回归全套知识（套件在仓库外 dsh-ui-test/）：套件清单与
  断言基线、手风琴区块驱动口径、测试实例与 token、零真实写入纪律。当需要在
  dsh-tap 仓库跑 UI 回归 / 设置卡回归 / 浏览器测试 / puppeteer 套件
  （card-accordion、qoder-slot-check、qoder-tab-phase2、qoder-prefs-check、
  shots-baseline），或改了 lib/client.js 需要验证设置卡渲染与交互时使用。
  触发词：UI 回归、设置卡回归、浏览器测试、前端回归、card-accordion、
  dsh-ui-test、截图基线、跑一遍设置卡。
license: MIT
---

# dsh-tap 浏览器回归

套件 = puppeteer-core + 系统 Chrome，位于**仓库外**本地目录 `dsh-ui-test/`（不进仓库）。
每轮 tee 原始输出到 `dsh-ui-test/logs/` 且日志首行回显完整 URL。

## 测试实例与 token

- 测试服务由用户侧 **dsh-launcher 托管在 :3090**（token 见启动行，或读
  `dsh-launcher/native-web-3090.log` 的启动行）；**回归轮次不启停它、不占端口**。
- **token 随重启轮换**——旧 token 会拿到鉴权页、套件全红，这是 token 过期不是
  产品缺陷，先从日志取新 token 再下结论（0.1.5 起 web 入口 token 闸，踩坑 #30）。
- 跑法：`node <脚本>.js "http://127.0.0.1:3090/?token=..."`（脚本 `argv[2]` 收完整 URL）。
- profile 已 link 本仓库 ⇒ 改 `lib/client.js` **刷新页面即生效**，建议
  `--disable-http-cache` 防浏览器缓存。

## 设置卡入口

插件管理器**「官方」区**的 dsh-tap 卡片（「已安装」区的同名卡进的是宿主原生详情页，
不嵌设置卡）。`qoder-slot-check.js` 入口必须点卡片 `cardTitle` 按钮，而非侧栏会话树
同名行。

## 驱动口径（0.10.0 手风琴结构）

- 展开区块 = 点 `.cbc-acc-toggle[data-block=<id>]`，再查 `.cbc-acc-body[data-block=<id>]`
  （旧文档的 `window.__cbc.tab()` 钩子**从未存在**，勿按名引用）。
- 选择器一律按 `.cbc-*` 类与行内单元格**精确匹配**（踩坑 #16；已丢失的 step20 曾因
  模糊匹配误删 Key）。改 UI 文案/结构后先 grep 脚本里的旧选择器。
- 键盘断言用 `page.keyboard.press(...)` **可信按键**，`dispatchEvent(KeyboardEvent)`
  是 harness 伪缺陷（踩坑 #46）。
- 浅色不变式走摘 `body[data-ds-dark-theme]` 属性路径；`prefers-color-scheme` 仿真零效果
  （踩坑 #47）。
- `page.screenshot({fullPage:true})` 在本宿主是空操作——截图基线走元素句柄 + 逐张看图
  （踩坑 #48）。
- 剪贴板断言 = 零授权 + `page.click` 可信点击 + writeText 间谍读回；**别用
  `overridePermissions`**（会把 write 侧一并 deny，踩坑 #51）。

## 零真实写入纪律

跑前跑后对 `~/.dsh/codebuddy-plugin.json` 取 md5 对账（必须一致）。例外：
`qoder-prefs-check.js` 是真实写盘级——基线从实况读、收尾复原到实况。

## 套件清单与断言基线

| 脚本 | 基线 | 覆盖 |
|------|------|------|
| `card-accordion.js` | **200 断言**（静态 `check(` 站点 197 + `[B2]` 循环多跑 2 次 + `[C2]` 多跑 1 次） | **设置卡唯一套件**：四区块顺序与默认全收（无凭据冷启动自动展开 CodeBuddy，`[L1]`）/ 状态行**独立预言机**双向对齐（直接从 GET 视图算应有片段，避免 `.cbc-acc-status` 缺席时 `[].every()` 恒真的空洞通过）/ 展开才挂载+收起保留（草稿/滚动）/ 多开独立 / 头部开关**收起态确认一次**（0 POST→提示→4s 窗内二击恰 1 POST；展开态直切，`[C3]` P3-7）+ **两击坐标锁与跨行同坐标（`[C3-geom]`）+ 命中面 ≥24×24（`[C3]` SC 2.5.8 锁）**/ 无注意条无徽标 / 通用区块挂载取样 + **收起边界重采恰一次（`[F9]`）** + 收起停轮询 / 键盘可达（`[G1]` 可信按键）/ 浅色与 `color-scheme`（`[H6]`）/ 无 tablist 残留 / 无 pageerror·dsh-tap 告警 / mock GET-POST 通道：启用+未监听 warn 落区块头带端口、保存后 1s/2s/4s 退避补拉自愈（踩坑 #45，`[B4]` after 断言 `posts === prePosts + 1`）、补拉链**启动点**在竞争包作废时照旧启动 + A2 请求代次门时序锁（`[B5]`：迟到 GET 独带水印「模型 4242 个」不得落 DOM）/ `[R]` 宿主对账 + 余额行（踩坑 #50 预言机口径）/ `[I]` warn 头就地动作（重试监听/复制诊断）/ `[J]` 「目录 N · 可路由 M」+ 恒 11102 置灰 / `[K]` 凭据「测一下」 |
| `qoder-slot-check.js` | **13 断言** | 槽迁移（Plugin Manager `plugins.item`）+ Qoder CN 区块 |
| `qoder-tab-phase2.js` | **11 断言** | Qoder CN 区块：头部开关 / `.cbc-syncbar` 同步条 / 模型启停组 / 端口行 / `details.cbc-adv` 真查元素 |
| `qoder-prefs-check.js` | **37 通过**（静态 39 站点，2 条在未触发分支） | Qoder 模型行思考强度/上下文 select；**真实写盘级**（基线从实况读 + 收尾复原） |
| `qoder-e2e.js` | 8 断言 | Qoder 端到端发消息——**真实消耗额度，不默认跑** |
| `shots-baseline.js` | **10 张元素级基线**（明/暗 × 总览+四区块） | 截图基线；`fullPage` 空操作故元素句柄（踩坑 #48） |
| `debug-dom.js` / `debug-inputs.js` | — | 宿主原语真实 DOM dump，选择器校准用（踩坑 #44③ 的判别手法） |

断言数沿革（各轮当时实况，别拿某一轮改别处口径）：迁移期 117 → 终审 118 →
残余修复 119 → 复审修复 129 → 0.12.0 加 `[I]/[J]/[K]` 187 → 0.13.0 加 `[L1]`+`[C3]`
重写 197 → P3-7 `[C3-geom]` 坐标锁 2 条 199 → SC 2.5.8 命中面锁 1 条（坑 #53）200。
RED 实测记录与各轮日志见 `dsh-ui-test/logs/`。

## 沿革与失联资产

2026-08-18 从 `/tmp/dsh-ui-test/` 迁来（/tmp 被系统清空）；2026-09-03 随标签页重设计
重建；2026-09-23 随 0.10.0 手风琴换代，`card-accordion.js` 成唯一设置卡套件、老
`card-regression.js` 同日退役删除。**step 系列与 `_helpers.js` 已在多轮重建中丢失，
勿按名引用**。

## 相关踩坑（细节 grep docs/pitfalls.md 对应编号）

#16 puppeteer 三坑 · #30 token 闸 · #45 写完≠生效完（`[B4]`/`[B5]`）· #46 可信按键 ·
#47 主题属性驱动 · #48 fullPage 空操作 · #50 预言机覆盖率（`[R]`）· #51 剪贴板权限（`[I1]`）·
#53 checkbox 命中面（`[C3]` 命中面锁 + tmp-geom-probe.js）
