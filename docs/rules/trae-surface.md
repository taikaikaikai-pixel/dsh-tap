# TRAE API 面 / OAuth / 插件 侦察规则文档

> 日期：2026-08-19
> 方法：dsh-tap 同款逆向方法论 —— 现象 → 假设 → 探测 → 规则 → 预测验证
> 目标：把 TRAE（字节火山系）API 面、OAuth、插件体系摸成白箱，供未来做 provider/自动化接入
> 主线来源：TRAE 官方日志 + 本地配置 + 实际 HTTP 探测

---

## 0. 一句话结论

TRAE（TRAE SOLO CN / trae.cn）是字节火山系的 Electron IDE，与 CodeBuddy（腾讯 copilot.tencent.com）不是同一套后端：

- 认证：字节账号体系（手机号登录，内部用 Supabase OAuth 服务）
- API 面：api.trae.cn + api.trae.com.cn + trae-api-cn.mchost.guru 三个域名，专用协议（非 OpenAI 兼容）
- 插件：trae-remote-official registry 的 16 个官方插件，全部本地 ~/.trae-cn/plugins/
- MCP：支持本地集成模式（solo_design_lite / dev_agent / browser_use），无远程 HTTP MCP
- Skills：本地 skills + builtin skills + 远端 skill market

CodeBuddy 那套规则（UA/缓存/路由/额度）对 TRAE 不直接适用，但方法论完全可迁移——本文档就是 TRAE 版的第一份侦察基线。

---

## 1. 主机事实（侦察基线）

### 1.1 安装与数据目录

| 项 | 路径 | 说明 |
|---|---|---|
| 可执行文件 | AppData\Local\Programs\TRAE SOLO CN\TRAE SOLO CN.exe | Electron，214MB |
| 资源 | ...\resources\app | 未打包 asar（只有 node_modules.asar），源码可读 |
| 数据目录 | AppData\Roaming\TRAE SOLO CN\ | 配置、日志、会话存储 |
| 用户数据 | %USERPROFILE%\.trae-cn\ | 插件、skills、mcps、extensions、plugin-config 都在这 |
| 日志 | AppData\Roaming\TRAE SOLO CN\logs\<timestamp>\main.log | 主日志，含全部 API 调用 |
| 构建 | version 2.3.71801 / app 0.1.51 / vscode 1.107.1 | 2026-08-14 构建 |

### 1.2 本地服务端口（运行时）

| 端口 | 用途 |
|---|---|
| 17788 | Supabase OAuth 本地服务（回调 /callback） |
| 51000 | ckg 本地嵌入服务（local_embedding） |
| 8644 / 9097 / 9900 | 其他本地网络服务 |

### 1.3 关键事实

- TRAE 使用 ttnet（火山网络库）做 HTTP，带 ttnet fetch 日志前缀
- 用户已登录（手机号 <redacted:phone>，用户 ID <redacted:userId>，LastLoginType=sms，注册 2025-08-09）
- token 有效期：expiredAt=2026-08-29、refreshExpiredAt=2027-02-11、tokenReleaseAt=2026-08-15，JWT refresh 被禁用

---

## 2. API 面（已实测）

### 2.1 域名三件套

| 域名 | 归属 | 典型端点 |
|---|---|---|
| api.trae.cn | 主 API | pay、ug、GetThirdPartyToken、cloudide GetUserInfo |
| api.trae.com.cn | 扩展/icube | extensions skill/list、icube user/native/config/notifications |
| trae-api-cn.mchost.guru | 远端技能 market | /api/remote/v1/skills |

### 2.2 已抓到的完整端点清单（启动时自动调用）

| 端点 | 需要认证? | 响应 | 说明 |
|---|---|---|---|
| api.trae.cn/ | 否 | 404 | 根路径无内容 |
| api.trae.cn/trae/api/v2/ug/checkin_credits/status | 是 | 200 JSON，未认证时 code:1001 | 签到积分状态 |
| api.trae.cn/trae/api/v2/pay/ide_user_pay_status | 是 | 200 JSON（code 1001 变体） | 套餐/付费状态 |
| api.trae.cn/trae/api/v2/pay/ide_user_ent_usage | 是 | 200 | 企业用量 |
| api.trae.cn/trae/api/v3/GetThirdPartyToken | 是 | 404 未带参数；正常调用 3 次（feishu/lark） | 三方 token 获取 |
| api.trae.cn/cloudide/api/v3/trae/GetUserInfo | 是（x-cloudide-token） | ResponseMetadata+Result | 用户信息 |
| api.trae.com.cn/extensions/api/-/skill/list | 否 | 200 JSON | 技能市场列表（公开） |
| trae-api-cn.mchost.guru/api/remote/v1/skills | 是 | 401 未认证 | 远端技能 |
| api.trae.com.cn/icube/api/v1/user | 未知 | 404 | icube 用户 |
| api.trae.com.cn/icube/api/v1/native/config/query | 混合 | 带 mid/did/uid 参数 | 动态配置 |
| api.trae.com.cn/icube/api/v1/notifications/count | 混合 | 200 | 通知数 |
| api.trae.com.cn/icube/api/v1/package/check_update | 否 | — | 更新检查 |

> 错误码规律（已实测）：未认证错误统一为 code: 1001 + 英文 apologize 文案，与 CodeBuddy 的 12403/11101/11102/14407 完全不同。

### 2.3 认证头

- x-cloudide-token: <token> 用于 cloudide API（日志确认）
- 其他端点带 x-cloudide-token / 可能还有 ttnet 特有头
- GetUserInfo 请求头：Content-Type: application/json + x-cloudide-token

---

## 3. OAuth（Supabase 服务，已实测触发）

### 3.1 架构

用户点击登录/扫码
  -> TRAE 启动本地 SupabaseOAuthLocalServer (127.0.0.1:17788)
  -> 浏览器/回调端点 http://127.0.0.1:17788/callback?code=XXX&state=YYY
  -> 服务解析 code/state -> 换 token -> 写文件

### 3.2 已实测行为

| 探测 | 结果 | 结论 |
|---|---|---|
| GET /callback（无参数） | 400 | 端点存在，缺参数 |
| GET /callback?code=test123&state=xyz | 500 + Failed to write supabase token to file | 完整链路被触发：接受参数->尝试换 token->写盘失败（假 code） |
| GET /oauth /auth /health | 404 | 只有 /callback 一个公开端点 |
| token 保存路径 | AppData\Roaming\TRAE SOLO CN\User\supabase-token.json | 日志明确，当前文件不存在（token 存在别处/unset） |

### 3.3 规则（已确立）

1. 本地 OAuth 服务端口固定 17788（可被占用则换端口，日志会打 Found available port）
2. /callback 是唯一公开暴露端点，接受 code + state 参数
3. 认证 token 主存储不在 supabase-token.json（文件不存在但应用正常工作）-> 存在 Windows 凭据或内存
4. JWT refresh 禁用 -> token 到期（8-29）后需重新登录，refreshToken 无自动续期
5. GetThirdPartyToken 启动时 fetch 3 次（feishu/lark），响应非数组则告警 Result is not an array（不影响主功能）

> 未解（需真登录一次才可测）：token 在 GetUserInfo/其他 API 间的复用、refresh 轮换的真实条件、state 生命周期真实 TTL。

---

## 4. 插件体系（已完整侦察）

### 4.1 插件来源

- 只装官方 registry：trae-remote-official（display: Remote Official Plugins）
- 安装清单：~/.trae-cn/installed-plugins.json（含 marketplace、page、plugin 详情）
- 启用配置：~/.trae-cn/plugin-config.json

### 4.2 16 个官方插件（全清单，本地实装）

| 插件 | 版本 | 用户启用 | 说明 |
|---|---|---|---|
| browser | 1.0.3 | 是 | 浏览器控制 |
| build-web-apps | 0.1.2 | 是 | Web 应用构建 |
| build-web-data-visualization | 0.1.21 | 否 | 数据可视化 |
| frontend-design | 0.0.0 | 否 | 前端设计 |
| github | 0.1.2 | 是 | GitHub |
| ip-strategy | 0.1.2 | 否 | IP 策略 |
| lark | 1.0.3 | 否 | 飞书 |
| personal-workbench | 0.1.0 | 否 | 个人工作台 |
| product-lifecycle-workbench | 0.2.1 | 否 | 产品生命周期 |
| seedance | 1.0.1 | 是 | 即梦视频 |
| seedream | 1.0.1 | 是 | 即梦图片 |
| staff-engineer-mode | 2.1.0 | 否 | 员工工程师模式 |
| stark | 0.7.2 | 是 | 智能体协调 |
| story-craft | 0.1.1 | 否 | 故事创作 |
| web-app-development | 0.1.1 | 是 | Web 应用开发 |
| whiteboard | 0.2.0 | 是 | 白板 |

### 4.3 插件安装位置

~/.trae-cn/plugins/trae-remote-official/<name>/<version>/

每个插件含 manifest_json（name/version/i18n/interface/capabilities）、connector_json、mcp_servers_json、skills_json。

### 4.4 MCP 系统（已实测）

TRAE 的 MCP 是本地集成模式，三个 profile：

| profile | 来源 | 发现 |
|---|---|---|
| solo_design_lite | dsh-tap 项目 | integrated_code_mode（V8 沙箱 Exec） + GitHub server |
| dev_agent | 规则动乱项目 | mcp_Blender（Blender 3D/混元 3D/Hyper3D 全套工具） |
| browser_use | 习惯项目 | GitHub server |

- 每个 MCP server 有 SERVER_METADATA.json（只含 server_name）+ tools/*.json（完整工具 schema）
- 工具 JSON 只有 schema 无实际端点 -> 本地集成 MCP，不带网络 API
- integrated_code_mode 的 Exec 是核心：V8 沙箱，无 console/fetch/require/process/fs/network，只有 tools/text/exit/ALL_TOOLS

### 4.5 Skills

| 类别 | 位置 | 内容 |
|---|---|---|
| 本地 skills | ~/.trae-cn/skills/ | algorithmic-art、defuddle、flux-best-practices、json-canvas、obsidian-*、prompt-images、shadcn、study-habits、write-xiaohongshu、xiaohongshu-note-analyzer、zhihu-publisher |
| builtin skills | ~/.trae-cn/builtin_skills/ | TRAE-dynamic-ui、TRAE-security-review、_shared |
| 远端 skill market | api.trae.com.cn/extensions/api/-/skill/list | 未认证 200，公开 |

skill 开关：~/.trae-cn/skill-config.json（disabledSkills 60+ 个，含 lark-* 全家、visualization 全家）

---

## 5. 与 CodeBuddy 规则的关系（方法论迁移）

| CodeBuddy 课题 | TRAE 对应 | 结论 |
|---|---|---|
| UA 校验（/v3/config） | 无 UA 门 | 不适用 |
| 提示缓存（按内容寻址） | 未测（TRAE 有自己的 ttnet 缓存体系） | 待探索 |
| 路由配置（14407） | 错误码完全不同（1001 vs 14407） | 重做 |
| 额度信号（pay/usage） | 有 pay/usage 端点（ide_user_pay_status / ent_usage） | 高度相关，下一步重点 |
| OAuth 握手 | Supabase 本地服务 + /callback，与 CodeBuddy 网页授权不同 | 方法论同，实现重做 |
| 内容审核 | 未测 | 待探索 |

### 迁移规则（铁律）

1. 先把 CodeBuddy 的 docs/rules/ 视为方法论模板，不是数据源
2. 对 TRAE 所有"必须长这样"的结论，必须重新验证（每个端点真实探测）
3. 错误码/头名/域名不通用，逐项重测
4. OAuth 研究注意：只理解不绕过（沿用红线）

---

## 6. 未解清单（下一步探测计划）

- [ ] api.trae.cn 各端点的完整认证方案（x-cloudide-token 从哪来、哪些端点共用）
- [ ] pay/usage 端点的认证响应展开（额度信号的迁移重点）
- [ ] TRAE 的 ttnet 缓存体系（是否有类似按内容寻址）
- [ ] Supabase OAuth 的真实 code 交换（需一次真实登录）
- [ ] token 的 refresh 轮换真实行为（JWT refresh disabled 是否恒真）
- [ ] 插件 market API：api.trae.com.cn/extensions/api/-/skill/list 的完整清单（未认证可取）
- [ ] installed-plugins.json 的 marketplace 分页（page_size 16，下一页在哪）