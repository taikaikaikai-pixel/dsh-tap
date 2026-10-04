# 07 — 浏览器半 lib/client.js（设置卡）

> 文件：[lib/client.js](../lib/client.js)（~136KB / 2298 行，无构建步骤：手写 `React.createElement`）。宿主经 `package.json` 的 `exports["./client"]` + `dsh.client.manifest` 加载。

## 模块格式

```js
window.__ModuleLoader__.load({
  id: "dsh-tap",
  factory: (require) => {
    const react = require("react")
    // ... 组件定义与注册 ...
  },
})
```

- 包声明：`dsh.client.inject = ['@deepseek-ai/dsh-client-ui-slots']`，platform web（`@deepseek-ai/dsh-client-runtime` 自 dsh 0.1.6 起不存在，已从 inject 列表删掉，踩坑 #34）。
- 注册卡：**双槽注册**——dsh ≥ 0.1.6 卡片在 Plugin Manager 的 `plugins.item` 槽（boot 即声明，owner props `{view:'summary'|'page'}`：summary = 标题下一行简介、page = 完整表单，页面自带标题与返回 crumb ⇒ 卡片以 `embedded` 常开且不画自己的折叠头部）；≤0.1.5 回退设置页的 `settings.plugin.item` 槽。两槽都经 `slots.inject(槽名, () => slots.register({ name, id, order, label, inject }, Entry))` **等声明落地再注册**（现注册字段是 `id:"dsh-tap"` + `label` + `order:60`，`key` 是 rc.7 keyed 槽遗产、当前代码已不带）——`slots.inject` 对未声明槽是静默等待，直接 `register` 抢跑会**静默不出现且零报错**（踩坑 #30/#34）。旧槽路径的渲染前提另有宿主半 `settings.register('dsh-tap', Config)` 命名空间声明（见 [02](02-composition-root.md)）。

## 卡片结构（通道手风琴，0.10.0 重设计）

顶层 = **4 个可展开区块**，顺序固定（`BLOCK_DEFS`）：**CodeBuddy → TraeWork CN → Qoder CN → 通用**，默认全部收起——首屏就是四条状态行（即总览）。设计依据与字段落点全表在 `docs/goals/settings-card-ux-redesign.md`（§3/§4/§5）。

1. **区块头 = 状态的单一真源**（`BlockHead` / `blockStatus`）：状态点 `Dot` + 区块名 + 一行状态文字。判定口径与文案直接沿用 `buildChips`，每个区块取自己那几枚芯片拼成一行、`tone` = 其中最差的一枚（`worstTone`）⇒ **warn/err 就地出现在所属区块头**，不展开也读得到。0.9.11 的三层状态补偿机制（折叠态三芯片 / 展开态注意条 / 标签徽标 `tabBadge`）随标签栏一并删除。
2. **旧槽折叠态**（≤0.1.5 `settings.plugin.item`）：卡片头只留标题 + 一行简介，外加**按需单枚**芯片「n 项需处理」（`attentionCount` 数 warn/err），全绿时不出现。dsh ≥ 0.1.6 的 Plugin Manager `page` 视图（`embedded`）根本没有卡片头，进去直接就是四区块。
3. **展开才挂载、收起不卸载**：`openBlocks` / `mountedBlocks` 两张状态表——首次展开才渲染该区块的分区，之后收起只置 `hidden`（DOM 与组件状态都留着）：草稿、滚动位置、已拉目录跨收起与保存保留。重活因此保持惰性（`model-list` / `trae-model-list` / `qoder-model-list` 在所属区块首次展开才拉）。
4. **区块内固定分组**（三家同构，标题类 `cbc-group-title`）：`凭据 → 模型 → [工具] → 网关 → 高级`——只有 CodeBuddy 多一个「工具」组（搜索/抓取、生图，都走 CodeBuddy 网关）。模型组三家共用一条操作条 `.cbc-syncbar`：单按钮「同步目录」+ 上次同步状态文字 + 筛选框同行（筛选谓词 `matchesModelFilter` 三家共享，只过滤渲染、不发请求）。
5. **两种 `<details>` 的分工**：`details.cbc-adv`（summary「高级」）= 纯工程项（域名族 / `baseURL` / `qoderClientId` / 认证与聊天域…）；`details.cbc-help`（`HelpNote`，summary「使用说明」）= >60 字的背景说明。两者都是原生 `<details>`、零 JS 状态、父组件重渲染不复位；短的就地点提示直显、不进折叠。
6. **通用区块头取样**：「额度 / 服务商数」不在 GET 视图里 ⇒ 卡片挂载时各做一次 `action:'usage'` 与 `provider-list`（取到前显示 `额度 — · 服务商 —`）。**取样口径两句分明（spec §3 终审措辞更正——旧写法「一次性、不轮询」会被下游读成「永不更新」）**：① **不做周期轮询**（头部四行常驻，定时打 usage = 每次开卡都多付一份上游额度只读，成本考虑）② **「通用」区块由展开转收起时重采一次**（`sampleGeneralHead()` + `useRef` 记前值、deps `[!!openBlocks.general]`；头部是"区块头 = 状态单一真源"的载体，只采挂载那一刻会让它停在"打开页面那一瞬"的快照、与正下方每 10s 轮询的正文自相矛盾；展开时不采——正文自己会拉）。**api-key 模式不编数字**：`quota.numericQuota` 为假（数值额度是 OAuth 专享）时落「额度 估算（累计 x）」分支，OAuth 声明了数值额度却读取失败（`resourceError`）时只显 `额度 —`（`generalSummary` 三分支）。用量 10s 轮询**严格随区块展开启停**（`sectionProps.usage.active = !!openBlocks.general`）；`credential-scan` **不上移**——仍在通用区块首次挂载才做（它会扫本机文件，不该每次开卡都触发）。
7. **保存反馈落点**：`save(patch, blockId)` → `saved = {block, at}`，「已保存 ✓」flash（`cbc-saveflash`）出现在**触发该次保存的区块头**，1.8s 自愈；它是常驻占位、用 `visibility` 切换，所以出现/消失不会挤压同行 checkbox 的水平位置。
8. **宿主实况对账 + 跨通道余额（0.11.0 P1）**：通用区块第三分区「宿主实况」渲染 GET 视图的 `host` 字段（本分区自身零请求）——配置层模式 / 三通道镜像（期望=插件镜像纪律、实际=host-config 读宿主配置层）/ patch 条目（settings 命名空间条目对 allNamespaces）/ web 钉选（效果级直查 `ctx.web.searchProviderId/fetchProviderId`，原因见踩坑 #50：allNamespaces 对非 settings 条目是假预言机）；漂移 ⇒ 区块头尾部「宿主漂移」+ tone 只升不降。Trae/Qoder 凭据组各加「余额」行（`trae-quota`/`qoder-quota` action）：展开/收起边界各采一次、登录翻转重采、不周期轮询、provider 内 60s memoize、取不到/未登录显示「—（原因）」绝不编造数值。
9. **状态行就地动作 + 模型口径透明 + 凭据「测一下」（0.12.0 P2）**：① warn/err 态的通道区块头尾部出就地动作（`BlockHead` 的 actions 槽，独立交互元素不嵌套展开 button）——「重试监听」（POST action `gateway-retry`，服务端 enabled 限定点重跑对应 sync*，禁用通道跳过防连带镜像撤铺；客户端复用踩坑 #45 退避补拉）与「复制诊断」（纯客户端从 GET 视图聚合 running/端口/lastError/同步时间写剪贴板，零请求增量；视图本就脱敏）；正常态零动作。② 模型组同步行/列表底行口径「目录 N · 可路由 M」（GET `models.sync.routable` + model-list 带 `unroutable` 表，唯一真源 = `providers/codebuddy/catalog.js` 的 `UNROUTABLE_MODELS`）；恒 11102 死条目行置灰 +「不可路由」徽标，勾选框未启用时禁用、已启用保留可勾掉（transparency only，不改镜像/选择器行为）。③ 凭据组「测一下」：POST action `credential-test`（codebuddy=目录面 GET /v3/config 零额度、qoder=签名目录 GET /algo 非聊天面）与 `provider-test`（key 型走 `testExtraProvider`，/models 或 probeChatKey 探针，只读不写块）；响应恒 200 `{ok,available,detail|error}`（验证失败不是路由故障），结果就地显示「✓ 可用」/「✗ 具体错误」，不进全局横幅。
10. **冷启动引导 + 头部开关确认（0.13.0 P3）**：① 首次被采纳的 GET 视图里三通道均无凭据（codebuddy 按 authMode 看 `oauth.signedIn`/`activeApiKey`，trae/qoder 看各自 `oauth.signedIn`）⇒ 自动展开 CodeBuddy 区块一次——`useRef` 守卫，同一挂载内不重复（手动收起后不被后续 load 撬开）、不持久化；任一通道有凭据即默认全收。② Trae/Qoder 头部启用开关**收起态**第一次点击只进确认态（就地提示「再点一次确认启用/停用」`.cbc-headconfirm` + 受控框弹回原态 + 4s 超时复位，沿用 askConfirm 模式），**展开态**直切不确认（设计文档 §8 风险表首选方案）。

| 区块 | 分区（`BLOCK_SECTIONS`） | 展开后内容 |
|---|---|---|
| CodeBuddy | `login` / `models` / `tools` / `bridge` | 凭据（登录方式、多 Key 管理与脱敏列表、env 引用、失败冷却）、模型（同步目录 + 筛选 + 逐模型启停 + ctx/输出幽灵输入 + 思考档位 select）、工具（搜索与抓取开关/条数/正文上限、生图开关/模型）、网关（流式桥开关、端口、会话头归因、会话头格式、每会话并发上限）、高级（`baseURL`） |
| TraeWork CN | `trae` | 凭据（OAuth 登录/登出 + 令牌状态行 + **余额行**（IDE/work 双池，0.11.0））、模型（同步目录 + 筛选 + 逐模型启停）、网关（:3902 端口、聊天传输、首字节超时）、高级（认证 / 聊天 / 登录域）。**启用开关只在区块头** |
| Qoder CN | `qoder` | 凭据（设备流登录/登出，pending 3s 轮询收敛、needsRelogin 引导重登 + **余额行**（附加/订阅配额，0.11.0））、模型（同步目录 + 筛选 + 启停 + 思考强度/上下文变体两个 select——**思考档位选项来自服务端 `qoder.models.efforts`（= 目录逐模型声明），无声明不出控件**，0.19.0）、网关（:3903 端口）、高级（登录域 / OpenAPI / infer / client_id）。**启用开关只在区块头** |
| 通用 | `usage` / `providers` / `hostrecon` | 额度与用量（hero 大数字 + 周期进度条、资源包聚合、今日/累计统计卡、轮次表、手动「刷新」与时间戳）、服务商（preset/自定义添加、刷新模型、删除、本机凭据扫描导入）、宿主实况（0.11.0：镜像/web 钉选对账，自身零请求） |

除上表外每个 schema 字段都有落点：`keyCooldownMs` 在 CodeBuddy·凭据、`quotaTotalManual` 在通用·额度与用量（api-key 估算语境）。

## 请求契约（与组合根设置路由对齐）

```text
GET  /dsh-tap/settings
     → { value（脱敏）, user, oauth, bridge, trae, qoder, models }
POST { patch: {...} }            → 保存（合并 + 校验 + 热生效）
POST { action: 'oauth-start' | 'oauth-status' | 'oauth-logout'
       | 'model-list' | 'model-sync'
       | 'provider-list' | 'provider-add' | 'provider-remove' | 'provider-refresh'
       | 'credential-scan' | 'credential-import'
       | 'trae-oauth-*' | 'trae-model-sync' | 'trae-model-list'
       | 'qoder-oauth-*' | 'qoder-model-sync' | 'qoder-model-list'
       | 'usage' }
```

## UI 资源复用（0.7.1 原生化）

- **平台 primitives**：`require('@deepseek-ai/dsh-client-ui-primitives')`（Button/Input/图标），try/catch 失败回落原生元素——卡片不白屏（`CbcButton` 等适配组件内部封装）。
- **设计 tokens**：全部颜色走 `--dsw-alias-*` CSS 变量（深色主题经 `body[data-ds-dark-theme]` 自动跟随）。**注意两个不存在的名字**：`--dsw-alias-accent` / `--dsw-alias-label-error`——正确名是 `state-business-primary` / `state-error-primary`。
- **原生控件面板色必须显式绑宿主主题属性**（0.10.0）：`color-scheme` 的 used value 由 html/body 向上传播，而宿主无条件写 `dark` ⇒ 插件不自己声明就跟不上浅色，浅色主题下未勾选的 checkbox/radio 会呈**深色实心块**（看起来像已开启，踩坑 #47）。卡片根按 `body[data-ds-dark-theme]` 在位/缺席分别钉 `dark`/`light`。
- **注入样式**：单个 `<style data-plugin="dsh-tap" data-plugin-css="…">` 块，类名 `cbc-` 前缀（与第一方同协议，模块加载器可按插件归因/热清理）。外壳数值抄第一方 PluginCard：radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16。

## React 与结构纪律（踩坑 #4/#5/#16/#27）

1. 所有 hooks 必须在任何条件 return 之前调用；`useSyncExternalStore(scope.subscribe, ...)` 必须传绑定包装（裸方法引用丢 `this`）。
2. 受控 checkbox 可能双 change——**useRef 同值去重**（重复事件携带与上次已发送相同的目标态；不用时间窗——勾选往返 POST+reload 可以快过任何时间窗，0.9.1 实踩）；保存严格 1 POST + 1 GET（Enter 双提交已修）。
3. 脚本派发的原生 blur 不触发 React onBlur——用真实 `input.blur()`；setInput 与 blur 分两个任务（同任务内 commit 闭包读到旧草稿会静默不保存）。
4. 字段编辑器组件必须在**模块级**定义——组件身份随父重渲染变化会导致输入失焦。
5. 区块首次展开才挂载，之后**隐藏不卸载**（`hidden`）——组件状态（草稿/目录数据/滚动位置）跨收起与保存保留；挂载即拉数据的分区（model-list 等）不会因收起再展开而重复请求。
6. **区块头是 `div.cbc-acc-head` + 两个彼此独立的交互元素**：占满剩余宽度的展开 `button.cbc-acc-toggle`（`aria-expanded` + 挂载后才给 `aria-controls`）与右侧 `.cbc-acc-ctl` 里的通道启用开关。**不要把启用开关嵌进那个 button**——嵌套交互元素在 HTML 里不合法、浏览器会把它拆出可点击区域，键盘/AT 语义也跟着塌。

## 健壮性护栏（0.9.11）

1. **`fetchWithTimeout`**：GET 20s / POST 30s，AbortController 超时后把 AbortError 换成带时长的中文错误——设置服务挂起不再永久停在"正在读取"。全部 fetch 走它（成功/失败两条路径都 `clearTimeout`）。注意护栏只到响应头，`r.text()` 阶段不设防。
2. **`PanelBoundary`**：**分区级**渲染错误隔离（class 组件 + `getDerivedStateFromError`）——粒度是区块内的分区，模型组塌落不影响同区块的凭据组；出 fallback + 「重试」按钮（换 `key` 强制重挂载子树），`componentDidCatch` 把堆栈进 console（fallback 只显示 message，踩坑 #7）。
3. **错误提示带原因**：save / OAuth / 用量 pull / 目录同步 / Key 增删 / 登出等 catch 一律 `e.message` 优先，"（网络）"只是兜底。
4. **保存后的网关退避补拉**（`settleGateways`，踩坑 #45）：POST 响应同步返回，而 `runtime.running` 由 `'listening'` 事件异步翻转 ⇒ 紧随的 GET 可能读到假「未监听」；主视图没有轮询，不补拉就永久驻留。保存后若仍有「未监听」芯片，按 1s/2s/4s 补拉三次，真失败则用尽后停手、warn 如实留下。
5. **`HelpNote`**：>60 字的背景说明折进原生 `details.cbc-help`（summary「使用说明」），零 JS 状态、父组件重渲染不复位；短的就地点提示保持直显。
6. **幽灵输入 `cbc-ghost`**（模型行上限）：常态无边框、hover/focus 显边框、去数字步进器。宿主 `Input` 原语把 className 落在 **wrapper span**、内层 input 只带 CSS-module 类 ⇒ 规则必须同时写 `:focus-within`（wrapper）与 `.cbc-ghost input::-webkit-*-spin-button`（内层）双路径。

## 改 UI 后的回归（0.10.0 手风琴口径）

文案/结构改动先 grep 回归脚本的选择器（一律 `.cbc-*` 类 + 行内单元格精确匹配，踩坑 #16），再跑 `dsh-ui-test/`（**仓库外**本地目录，puppeteer-core + 系统 Chrome，不进仓库）。

**驱动方式**（旧文档说的 `window.__cbc.tab('分区名')` 钩子**从未存在**——`lib/client.js` 与全部脚本零命中，已作废）：

```
驱动 = 点 `.cbc-acc-toggle[data-block=<id>]` 展开区块，再查 `.cbc-acc-body[data-block=<id>]` 内的行/控件。
（querySelector 能点中 hidden 的 DOM，但那不是真实用户路径；收起 ≠ 卸载，所以展开后再查是稳的。）
选择器清单：.cbc-acc[data-block] / .cbc-acc.cbc-open / .cbc-acc-toggle / .cbc-acc-title /
.cbc-acc-status / .cbc-acc-body / .cbc-acc-head input.cbc-check[data-field] / .cbc-syncbar /
details.cbc-adv（高级组）/ details.cbc-help（使用说明）。
区块 id = codebuddy | trae | qoder | general；body 元素 id = cbc-block-<id>（aria-controls 指它）。
```

**套件**（断言数是 2026-09-23 实测）：

| 脚本 | 覆盖 | 实测 |
|---|---|---|
| `card-accordion.js` | **设置卡唯一回归套件**（接替 2026-09-23 退役的 `card-regression.js`）：四区块顺序/默认全收、状态行**独立预言机**双向对齐、展开才挂载与收起保留、多开独立、头部开关 1 POST、无注意条无徽标、挂载取样与收起边界重采恰一次与收起停轮询、键盘可达（可信按键）、浅色与 `color-scheme`、mock GET/POST 通道（含踩坑 #45 退避补拉两枚锁：`[B4]` 续跑自愈 / `[B5]` 补拉链**启动点**在竞争包作废时照旧启动，后者兼作 A2 请求代次门的时序锁） | **129 通过 / 0 失败**（静态 `check(` 站点 126 + `[B2]` 的 forEach 多跑 2 次 + `[C2]` 的 forEach 多跑 1 次） |
| `qoder-slot-check.js` | 槽迁移 + Qoder CN 区块（入口必须点卡片 `cardTitle` 按钮，不是侧栏会话树同名行） | 13 / 13 |
| `qoder-tab-phase2.js` | Qoder CN 区块：头部开关 / 目录同步条 / 模型启停组 / 端口行 / `details.cbc-adv` 真查元素 | 11 / 11 |
| `qoder-prefs-check.js` | Qoder 模型行思考强度 + 上下文变体 select（含镜像生效与快照式复原） | 37 通过 / 0 失败 / 跳过 0（静态 39 站点，2 条在未触发分支）；**真实写盘**级 |
| `qoder-e2e.js` | Qoder 通道端到端（选择器出模→发消息→收回复） | 8 条，**未跑**——会真实发消息消耗用户额度 |
| `shots-baseline.js` | 明/暗 × （总览 + 四区块）**元素级**基线 | 10 张 / 0 失败 |
| `debug-dom.js` / `debug-inputs.js` | 宿主原语真实 DOM dump（选择器校准，踩坑 #44③ 的判别手法） | `debug-inputs.js` 实跑 exit 0 |

**跑法**：需要一个在跑的 dsh web 实例——本机现由 `dsh-launcher` 托管（dsh 入口 `/c/Users/21613/dev/dsh-launcher/node_modules/.bin/dsh`，`dsh web` 默认 3080；当前实例在 **3090**，token 见启动行）。profile `~/.dsh/profiles/web` 已 link 本仓库 ⇒ 改 `lib/client.js` **刷新页面即生效**（不必重启；测浏览器半建议 `--disable-http-cache`）。每个脚本收 `argv[2]` = 带 `?token=` 的完整 URL（0.1.5 起 token 闸，踩坑 #30）。每轮把原始输出 tee 到 `dsh-ui-test/logs/`、日志首行回显完整 URL。**测试服务由用户侧 launcher 管理，回归轮次不启停它、不占端口。**

**零真实写入纪律**：套件里走 mock 的通道不写真实设置；走真实视图的脚本（prefs-check）基线从 GET 实况读取、收尾复原到实况（不是"复原到空"），跑前跑后对 `~/.dsh/codebuddy-plugin.json` 取 md5 对账。

**截图口径**（踩坑 #48）：`page.screenshot({fullPage:true})` 在本宿主是**空操作**（卡片在内层 overflow 容器里、`document.scrollHeight` === 视口高），产物恒 1440×900——"尺寸对 ≠ 内容在"。区块级基线一律走元素句柄 `handle.screenshot()` + **逐张看图**，脚本另核对「最近滚动祖先的 client 区是否整个包住该元素」。
