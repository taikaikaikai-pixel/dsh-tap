# 11 — 加一条通道（channel）

> 本文是 0.26.0 通道契约的**操作手册**。契约代码：[providers/channel.js](../providers/channel.js)；
> 三条通道的描述符在 [host/channels/](../host/channels)；闸门 `scripts/verify-channel-contract.mjs`。
> 加通道前先读 [02-composition-root.md](02-composition-root.md) 的依赖方向与 [03-core-layer.md](03-core-layer.md) 的 core 边界。

## 1. 先判断：这真的是"一条通道"吗

通道 = **一个上游 + 一个本机网关 + 一套模型清单 + 一张设置卡区块**。满足下面任意两条才按本文做：

- 需要本地端口（翻译网关 / 流式桥），dsh 经该端口发请求；
- 有自己的凭据形态（OAuth 设备流 / key 列表 / 本机 IDE 数据库）；
- 有自己的模型清单来源与宿主镜像目标（`llm-pi-ai.providers.<id>.models`）；
- 需要独立开关与端口设置。

只是"多一个 baseURL + key"的上游 → 走 [extra-providers.md](../docs/rules/extra-providers.md) 的 preset 路线，**不要**加通道。

## 2. 十二步

| # | 改哪里 | 做什么 | 验收 |
|---|--------|--------|------|
| 1 | `providers/<id>/` | 上游事实：headers / errors / oauth / catalog / gateway。core 不许出现上游词 | `verify-core-generic` 绿 |
| 2 | `providers/<id>/index.js` | 导出 `create<Id>Provider(deps)`，deps 含 settings/meter/runtime/凭据钩子 | 工厂可被 standalone 构造 |
| 3 | `host/config.js` | 加配置字段（`<id>Enabled`、`<id>BridgePort`、baseURL…）+ `SETTINGS_FIELDS` 条目 | `Config({})` 有默认值 |
| 4 | `host/runtime.js` | 加运行态台账（`{running, port, lastError}`） | — |
| 5 | `host/providers/instances.js` | 创建 provider 单例（凭据解析、settings 迟绑定 `settingsRef.<id>`） | `prefsRef`/`settingsRef` 装配完成 |
| 6 | `host/models/channels.js`（或 state） | 模型状态/启停/偏好 + 镜像写者（`sync<Id>ModelsToDshSettings`） | 镜像块能落盘 |
| 7 | `host/channels/<id>.js` | **描述符**：`defineChannel({id,label,settings,runtime,listen,quota?,catalogSync?,onDisabled?,onStarted?,block?})` | `verify-channel-contract` 绿 |
| 8 | `host/channels/index.js` | 登记进 `createChannels()` 与 `CHANNEL_IDS` | 清单顺序 = 设置卡区块顺序 |
| 9 | `host/settings/view.js` | 视图片段（GET 里 `trae: {oauth, bridge, models}` 这种分层的形状由本通道自己定） | `verify-route-contract` 的键集合更新（**契约变更要改 CHANGELOG**） |
| 10 | `lib/client.js` | `BLOCK_DEFS` 加一条（`gateway`/`control`/`diag` 字段声明差异）+ `BLOCK_SECTIONS` + 分区渲染组件 | `verify-picker-badge` / `verify-client-logic` 绿 |
| 11 | `quota-view.js` | 有额度面就加适配器（normalizer），并在 `buildQuotaView` 里登记 | `verify-quota-view` 绿 |
| 12 | 文档 | `wiki/0X-provider-<id>.md` + 事实表（`docs/rules/`）+ 新坑/新事实 + CHANGELOG | `verify-agents-md` 绿 |

## 3. 描述符长什么样

```js
export const fooChannel = defineChannel({
  id: 'foo',                                 // 小写字母开头；= settings 前缀 = quota 键 = 客户端 data-block
  label: 'Foo CN',                           // 设置卡区块标题
  settings: { enabled: 'fooEnabled', port: 'fooBridgePort' },
  runtime: fooRuntime,                       // host/runtime.js 的台账
  listen: (port) => fooProvider.gateway.listen(port),
  quota: ({ fresh }) => fooProvider.quota.snapshot({ fresh }),   // 可选
  catalogSync: () => fooProvider.syncCatalog(),                  // 可选
  catalogView: () => fooProvider.catalogView(),                  // 可选
  onDisabled: () => { syncFooModelsToDshSettings() },             // 可选：禁用时撤镜像
  onStarted: () => fooProvider.syncCatalog().then(/* 同步后重铺镜像 */), // 可选
  block: { gateway: true, control: { kind: 'switch', field: 'fooEnabled' } },
})
```

**必填**：`id` / `label` / `settings` / `runtime` / `listen`。其余可选：没有额度面就不写 `quota`（`quota-all` 自动跳过该通道），没有目录就不写 `catalogSync`。

## 4. 三条通道各自的"特殊处"（别照抄错）

| 通道 | 特殊处 | 原因 |
|------|--------|------|
| codebuddy | 描述符是**工厂** `createCodebuddyChannel({ bridge })` | 桥实例按 apply 每代创建（要捕获本代 settings）；其余两条是常量 |
| codebuddy | 无 `catalogSync`/`onStarted` | 目录是模型清单真源，由组合根在 apply 尾部单独跑（失败回落静态清单，与起停解耦） |
| trae | `catalogSync` 来自本机 `state.vscdb` | 未安装 IDE 时同步必然失败 → `onStarted` 必须静默、有旧目录就重铺 |
| qoder | 目录走网关目录 + 镜像要带 `compat` | 出档必须 `supportsReasoningEffort` 才写成 `reasoning_effort`（踩坑 #64/#66） |

## 5. 加完之后必须跑

```sh
node scripts/verify-channel-contract.mjs   # 契约/清单/客户端/额度四方对账
node scripts/verify-route-contract.mjs     # GET 视图与 action 契约（改形状要同步改期望）
node scripts/verify-host-split.mjs         # 依赖方向与模块登记表
npm run verify                             # 全量离线
node scripts/probe-effort-gaps.mjs         # 有档位声明时：宿主侧对账（需活实例）
```

重启宿主后在设置卡里确认：区块出现、开关能起停网关、端口被占时状态行给出真实原因、「重试监听」有效、主界面额度胶囊（若有额度面）出现。

## 6. 常见错法

- **在组合根/动作/客户端写死通道名**：`verify-channel-contract` 会红（"加通道只加文件"是这个契约的唯一验收口径）。
- **`listen` 里自己写 Host/Origin 门**：门只在 `core/http-surface.js`（踩坑 #80）。
- **镜像写空清单**：llm-pi-ai 会拒整层（踩坑 #6 的纯净态纪律：没有覆盖就删路径，不写空表）。
- **把瞬时状态挂进一次性拉取通道**：见踩坑 #69（陈旧徽标即谎言）。
