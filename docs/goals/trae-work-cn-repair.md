# Goal：TraeWork CN 通道修复与档位出档

> 执行模式：长任务 goal。本文只定义**角色、意图、边界与验收**；实现路径由执行 agent 在边界内自主决定。
> 写法同构 `bridge-port-host-split.md`：角色定位 + 意图/为什么 + 分阶段意图（非逐行指令）+ 已验证事实 + 未知数（探测先行）+ 产出契约 + 边界。
> 必读裁判依据：`AGENTS.md`（全部踩坑）+ `docs/rules/*.md` + `docs/reverse/traework-cn.md` + `docs/reverse/trae-cloud-api.md` + `docs/reverse/trae-model-catalog.md` + `docs/diagnosis-trae-3003.md`。
> 进展记录：每完成一个 G 项，在 `docs/rules/STATE.md` 追加一段。
> 状态：**立项（2026-10-04）**。驱动：用户在 dsh 设置卡点 Trae「同步目录」拿不到模型列表；实测根因 = vscdb 发现路径写死 WSL 格式（`/mnt/c/Users`），Windows 桌面端扫不到；且 `trae-model-sync` 失败时错误原因没浮到 UI（只显示泛化「未同步」）。

## 角色与使命（why）

你是 dsh-tap 的 **Trae 通道修复负责人**。现状：TraeWork CN 通道的 OAuth/凭据/网关转发链路在 0.19.0 已全通（设置卡显示「已登录 · 用户82411632597 · IDE 池 2432.75/2800」），但**模型目录同步在本机桌面端跑不通**——`POST /dsh-tap/settings` 的 `trae-model-sync` 返回 `ok:false`，错误原文「未发现 TRAE SOLO CN 的 state.vscdb（需要 --db 或本机安装）」，而 `state.vscdb` 实际存在于 `C:\Users\21613\AppData\Roaming\TRAE SOLO CN\User\globalStorage\state.vscdb`。

你的使命：让 Trae 通道在桌面端**同步得到目录、出得了档位**——从「装得上/登录得上」到「模型列表能拉下来、思考档位能选」。

## 已验证事实（立项前实测，出处标注）

| 事实 | 出处 |
|---|---|
| vscdb 存在 | `C:\Users\21613\AppData\Roaming\TRAE SOLO CN\User\globalStorage\state.vscdb`（文件系统直查） |
| 发现逻辑写死 WSL 路径 | `scripts/trae-model-catalog.mjs:37` `DEFAULT_USERS_ROOT = '/mnt/c/Users'`；`discoverStateDbs()` 扫 `/mnt/c/Users/*/AppData/Roaming/{TRAE SOLO CN,TraeWork CN}/User/globalStorage/`（:172-194）——Windows 原生进程里 `/mnt/c` 不存在 |
| 桌面 dsh 是 Windows 原生进程 | `process.platform === 'win32'`，`os.homedir()` = `C:\Users\21613`，无 `/mnt/c` |
| `trae-model-sync` 失败但 UI 不显示原因 | 子代理实测：POST 200，响应 `{"ok":false,"sync":{"ok":false,"error":"未发现…","kept":false}}`，DOM 仍显示泛化「未同步」 |
| Trae 档位方言全臂 3003 | `docs/rules/gateway-facts.md` Trae 节（2026-10-04）：`inline_chat` scene 把 thinking 置 disabled、模型默认档 high，组合非法；`chat_v3` 路径请求体根本没有 effort/thinking 字段——**档位出档的前提是先找到能传 thinking 的 scene** |
| 手风琴收放正常 | 子代理实测：可信点击后 aria-expanded/class/hidden 三态同步翻转，无 bug |

## 分阶段意图（非逐行指令）

1. **G1 修 vscdb 发现**：`discoverStateDbs()` 在 Windows 原生进程下也能找到本机 `state.vscdb`——按 `process.platform` 分支（win32 扫 `os.homedir()/AppData/Roaming/{产品目录}/User/globalStorage/`，WSL 保持 `/mnt/c/Users`），或统一用 `os.homedir()` + 平台感知拼接。验收：`trae-model-sync` 在桌面端返回 `ok:true` + 模型数 > 0。
2. **G2 错误浮到 UI**：`trae-model-sync` 失败时把 `sync.error` 显示在 Trae 区块的模型区（替换或追加到「未同步」文案），别让用户点了个寂寞。验收：模拟 vscdb 不存在（临时改名）→ UI 显示「未发现 state.vscdb」；恢复后 → 正常同步。
3. **G3 档位出档（探针门控）**：前提 = 找到能把 thinking 置 enabled 的 scene/参数组合（gateway-facts 已立项的后续课题）。方法：抓 Trae 官方客户端自己的请求看它用什么组合，或枚举 scene。找到 → `catalogToProfiles` 把 `reasoningEffortOptions` 写成 `reasoningEfforts` + index.js 镜像块补 compat + Trae 卡按 B3 同规则出档；找不到 → 文档写死「Trae 思考不可控」销案。验收：找到则 Trae 模型在宿主选择器出档位；找不到则 `gateway-facts.md` 记录终局结论。
4. **G4 回归零破**：离线九套件 + `verify-trae-provider` 全绿；`probe-effort-gaps` 跑通无缺口；浏览器回归 `card-accordion` 200 断言不破。

## 产出契约

- 代码：`providers/trae/catalog.js` / `scripts/trae-model-catalog.mjs` / `lib/client.js` / `index.js` 的最小改动；新探针（若 G3 找到 scene）落 `scripts/probe-trae-*.mjs`。
- 文档：`docs/rules/STATE.md` 追加 G 项进展；`gateway-facts.md` Trae 节按结论更新；`docs/pitfalls.md` 若踩新坑取新编号。
- 验证：G1/G2 桌面端实测（设置卡 Trae 区块同步出模型列表）；G3 探针证据落 `docs/probes/`；G4 全量回归。

## 边界

- **不碰 OAuth/凭据链路**（0.19.0 已全通，本轮不动）。
- **不臆造档位拼写**（踩坑 #42）——G3 找不到 scene 就销案，不硬编。
- **vscdb 只读**——`copySqliteForRead` 纪律保留，绝不写回原文件。
- **零真实写入纪律**：改 `lib/client.js` 后跑 `card-accordion` 前对 `~/.dsh/codebuddy-plugin.json` 取 md5 对账。
