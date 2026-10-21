# 诊断：CodeBuddy 全模型报「API 密钥无效」，但设置卡「测试一下」正常

> 结论日期 2026-10-21（本机 dsh desktop + dsh-tap 0.21.0，CN 站 `copilot.tencent.com`）。**一句话**：不是密钥、不是 OAuth 令牌、不是插件 bug——上游对**聊天面**返回 `HTTP 403 / code 11140 "request illegal"`（`displayMsg.zh`：「账号存在异常行为，已被限制使用」），而设置卡「测试一下」只打**目录面** `GET /v3/config`（仍 200）。dsh 把 401/403 一律归类为 `AUTH`，并把失败行文案固定替换成「API 密钥无效」——用户看到的提示与真实原因无关。
>
> 插件侧处置（0.21.1）：`describeUpstreamError` 把 `403/11140` 翻成 `400 + codebuddy_account_restricted`（真实原因 + requestId + 申诉指引）；回归 `verify-bridge [20]`。

## 1. 现象（用户视角）

- 设置卡 → CodeBuddy → **「测试一下」显示正常**（`目录 N 个模型`）。
- 任何 CodeBuddy 模型聊天都失败，界面显示 **「API 密钥无效」**。
- 同机 Qoder 通道正常（所以不是网络/宿主问题）。

## 2. 判定链（同一令牌、同一台机器、同一天）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 桥直连 `POST 127.0.0.1:3901/v2/chat/completions`（glm-5.3-flash / glm-5.3 / deepseek-v4-pro / hy3 / hunyuan-chat，5 个模型） | **全部 HTTP 403**：`{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"},"displayTips":{"zh":"…如需申诉请提交反馈"}}` |
| 2 | 用同一 OAuth 令牌**直连上游**，4 种 UA / 客户端头形态（插件形态、官方 CLI 形态、只带 UA、完全不带 UA） | 全部 403/11140 → **与客户端指纹无关**（对比：11128 才与 system 内容有关，见 §4） |
| 3 | 同令牌 `GET /v2/accounts` | **200**（账号可读，未被整体封禁） |
| 4 | 同令牌 `GET /v3/config`（设置卡测试的真实端点） | **200** → 所以「测试正常」 |
| 5 | 同令牌 `POST /agenttool/v1/search` | 可达（400 只是参数形态错）→ 非聊天面未受影响 |
| 6 | 用 refresh token 换**新** access token 再打聊天面 | **仍 403/11140** → 刷新令牌、退出重登都救不了 |
| 7 | 时间线 | 2026-10-21 09:32（UTC+8）真实 payload 端到端回放仍 **200**；11:12 起恒 403；14:19 复测**仍 403**（≥3 小时未自解） |

结论：**账号级风控封禁，命中面是聊天（chat completions）**；目录/账户/agenttool 都不在封禁面内。

## 3. 为什么设置卡测试是绿的

`POST /dsh-tap/settings {action:'credential-test', channel:'codebuddy'}` → `provider.catalog.fetchModelCatalog()` → `GET /v3/config`（`index.js` 的路由分支）。目录端点只验证「凭据能换来目录」，**不验证聊天面是否被风控**。这是设计上限，不是实现缺陷：目录面零额度消耗，测试本该如此；教训写进 §7。

## 4. 为什么 UI 说「API 密钥无效」

dsh 前端（`dsh-client-ui-chat`）的失败文案：

```js
function failureMessage(message, code, t) {
  …
  return code === "AUTH" ? t("message.failure.auth") : message
}
```

而 `AUTH` 的分类规则是 **HTTP 401/403 或 `authentication_error`/`permission_error`**（`classifyPiAiError` 及其同族实现）。上游 403 一到宿主就变成 `AUTH` ⇒ 真实原因被替换成「API 密钥无效」。**官方 CodeBuddy CLI 自己**也把 11140 归进 auth 族（`@tencent-ai/codebuddy-code` 2.170.0 静态表：`11140 → {category:"auth", subcategory:"auth_forbidden"}`），所以这个归类不是 dsh 独有的误判，而是上游语义本身长得像鉴权失败。

插件 0.21.1 的处置：把 `403/11140` 的**出口状态码改成 400**（`status: 400` 是适配器显式声明，桥按描述回写），并给出独立 `code: codebuddy_account_restricted` + 可执行文案。理由：400 不在宿主 AUTH 替换名单里，真实原因能原样到达聊天界面；codebuddy 路由 `retryPolicy.maxRetries = 0`，状态码变化不会引入重试。**不动 403 的原始语义判断**——该分支只在 `status === 403 && body.code === 11140` 时命中，其他 403 仍原样透传（回归断言覆盖）。

## 5. 上游侧怎么处理（唯一有效路径）

1. **申诉**：错误体自带 `requestId`（Trace ID），把它连同账号信息提交给 CodeBuddy 官方——客户端「帮助与反馈 / 提交工单」，或邮件 `codebuddy@tencent.com`（服务协议里的支持邮箱）。
2. **等**：内容安全/频率类风控通常 2–4 小时自解；但本次 ≥3 小时仍未解，说明不是「分钟级冷却」。
3. **换网络自测一次**（手机热点），排除 IP 风控；顺便确认没有多台设备/多个客户端同时登录同一账号。
4. **不要做的事**：重装、清缓存、换 API Key、退出重登、刷新令牌——§2 第 6 条已实测无效；更不要高频重试，风控会因持续请求继续收紧。
5. 期间切到其他通道（Qoder / Trae / key 型服务商）继续工作。

## 6. 插件侧改动（0.21.1，含回归）

| 文件 | 改动 |
|---|---|
| `providers/codebuddy/index.js` | `describeUpstreamError` 新增 `403/11140` 分支：`status: 400`、`code: 'codebuddy_account_restricted'`、文案含真实原因 + requestId + 申诉指引；其余 403 原样透传 |
| `providers/codebuddy/errors.js` | 收录 `11140`（含边界：目录/账户/agenttool 仍 200；刷新令牌无效）；注明官方 CLI 的 auth 族同码（11141/11142/17271–17276）未线上实测、不入表 |
| `scripts/verify-bridge.mjs` | `[20]` 增 4 条适配器断言 + 3×2 条端到端断言（stream true/false：400 + 结构化 code + requestId + 申诉文案 + 不误当限流）+ 403 其他码/非 JSON 不误翻 |

## 7. 探针 / 联调纪律（本次的代价换来的）

> 本次封禁的时间窗与当天 09:29–09:35 的渠道指纹探测（A/D 臂**故意**打 11128）+ 端到端真实 payload 回放高度重合；虽无法证明因果，但「对拒绝面反复探测」是上游风控最典型的触发特征。纪律见 `docs/pitfalls.md` #73 与 `wiki/09-run-and-test.md`。

- **串行 + 间隔**：同一上游的 4xx 语义探测串行发，两次之间 ≥20s；**一轮探测 ≤3 发**。
- **一次判定即停手**：命中拒绝后记录响应体（code/msg/requestId）就停，别「再发两发确认」——每次重发都可能计入风控。
- **只打目标面**：健康检查要打**用户实际使用的面**（这里 = chat completions）。目录面 200 不能推出聊天面可用。
- **封禁期零请求**：一旦看到 11140，停止一切上游请求（包括设置卡同步、模型测试、探针），先申诉/等待。
- **真实 payload 回放是双刃剑**：排查 11128 时必须用它（手搓 payload 会漏判），但它同时是最像「非常规客户端」的流量——一轮打通即停，不要集群重放。

## 8. 复跑

```sh
# 离线：403/11140 → 400 + 结构化 code（不访问上游）
node scripts/verify-bridge.mjs

# 线上（解封后应回 200 SSE；封禁期只跑一次，别循环）
curl -sS -i http://127.0.0.1:3901/v2/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dsh-codebuddy-bridge' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```
