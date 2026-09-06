/**
 * providers/codebuddy/headers.js — CodeBuddy 网关的客户端头组。
 *
 * 每个字段的"规则/迷信"判定均以实测为准（docs/rules/ua-validation.md §3，
 * 74 条 UA 变体探测证据）：
 *
 * | 字段 | 判定 |
 * |---|---|
 * | User-Agent 中的 `CodeBuddy/2.136.0` 段 | **部分是规则**：/v3/config 的 UA 门只做子串匹配 `/codebuddy\/[^a-z\s]*\./i`（大小写不敏感、版本段只需含点、数值不查）；`CLI/unknown` 前缀与具体版本号是迷信。/v2/chat 与 /agenttool 当前实测无 UA 门。 |
 * | X-IDE-Type / X-IDE-Name / X-IDE-Version / X-Product-Version | **对校验是迷信**（变体矩阵里缺失不影响任何端点的 200） |
 * | X-Requested-With / X-Private-Data | **迷信**（探测脚本只发 Accept/Auth/x-api-key/UA 仍全通） |
 * | X-Product: SaaS（仅目录/额度端点携带） | **迷信**（no-xproduct 臂 200） |
 *
 * 工程立场：严格按已证规则构造 UA；其余字段标注为迷信但**原样保留**——
 * 本次重构以零行为变更为纪律，是否参与遥测/路由未证伪（见 ua-validation.md §6），
 * 不作为能力依赖，也不贸然下线。
 */

/**
 * 规则成分：`CodeBuddy/x.y` 段（/v3/config UA 门的唯一检查对象）。
 * 完整串照抄官方 CLI 形态，前缀与版本号均为已证迷信。
 * 历史注：AGENTS.md 曾记录 "/agenttool UA 必须是 CLI 形态（12403）"——2026-08-19
 * 复测 /agenttool 已无 UA 门（ua-validation.md §2 R-B），该记录已过时。
 */
export const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'

/** 桥与 agenttool 出站的静态头组；规则成分仅 UA 一段，其余为保留的迷信。 */
export const CLIENT_HEADERS = {
  'User-Agent': USER_AGENT,
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': '2.133.1',
  'X-Product-Version': '2.133.1',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Private-Data': 'false',
}
