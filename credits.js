/**
 * credits.js — 积分倍率 token 的归一化口径（provider 无关，可离线测）。
 *
 * 放在仓库根（与 local-scan.js / host-config.js 同级）而非 core/：core/ 是
 * 「凭据边缘层」，且有 `verify-core-generic` 的四模块 + 禁上游词硬闸门；
 * 本文件是纯展示口径的格式转换，不碰凭据，故不进 core。
 *
 * 两个来源、一套 token 形态：
 *   - **官方目录**：CodeBuddy `/v3/config` 的 `models[].credits`
 *     （字符串 `"x0.51 credits"`，见 docs/rules/quota-signals.md R-Q4）——
 *     经 `parseCredits` 取出数字 token；
 *   - **用户手填**：官方没标注倍率的模型（Trae/Qoder 全量、CodeBuddy 缺字段
 *     条目）由用户在设置卡里填——经 `normalizeCredits` 校验归一。
 *
 * 两者都只产出「数字 token 字符串」（`"0.51"`），展示层统一拼 `x`。刻意保留
 * 字符串而非 Number：`x0.00` 必须原样显示，被 Number() 抹成 `0` 就丢了
 * 「官方标注为零计费」这个唯一被实测证实的语义。
 *
 * 本文件**只做格式**，不做定价换算——R-Q4 已证该倍率与实测 credit/1k 不成线性。
 */

/** 手填倍率的上界（纯防御：拦手滑多打几位，不代表任何计价事实）。 */
export const CREDITS_MAX = 999

/**
 * 官方目录 `credits` → 数字 token。
 * @param {unknown} raw 形如 `"x0.51 credits"`
 * @returns {string|null} null = 目录未声明或形态不可解析
 */
export function parseCredits(raw) {
  if (typeof raw !== 'string') return null
  const m = /x\s*(\d+(?:\.\d+)?)/i.exec(raw)
  return m ? m[1] : null
}

/**
 * 用户手填 → 数字 token（归一化：去空白、保留原小数位）。
 * @param {unknown} input 输入框原文 / 数字 / null
 * @returns {string|null} null = 清除该模型的记录
 * @throws {Error} 形态非法或超上界（调用方转 400 就地提示）
 */
export function normalizeCredits(input) {
  if (input === null || input === undefined) return null
  const v = String(input).trim()
  if (v === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error('倍率必须是数字（最多两位小数）')
  if (Number(v) > CREDITS_MAX) throw new Error(`倍率不能大于 ${CREDITS_MAX}`)
  return v
}

/** 本插件拥有倍率语义的通道（= 宿主里的 provider id，验证见 providers/*\/index.js）。 */
export const CREDIT_CHANNELS = ['codebuddy', 'trae', 'qoder']

/**
 * 数值倍率 → 展示 token（Qoder 目录的 `price_factor` 就是这种形态，2026-10 起官方提供）。
 *
 * 与 `parseCredits` 的差别：那边上游给的是字符串（`"x0.51 credits"`），这边是数字。
 * 统一产出 token 字符串，展示层照旧拼 `x`。**零值一律归成 `"0.00"`**——展示层用
 * `token === "0.00"` 判定「零计费/免费」绿调，别的写法会静默丢掉这个语义。
 *
 * @param {unknown} n 如 0 / 0.5 / 1.4
 * @returns {string|null} null = 不是有效数字（不编造）
 */
export function creditTokenFromNumber(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return null
  if (v === 0) return '0.00'
  return String(Number(v.toFixed(2)))
}

/** 只认 plain object，其余一律当空表（防御手改文件塞进数组/字符串）。 */
const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * 官方目录倍率 ∪ 手填倍率 → 浏览器半可直接查的单表。
 *
 * 优先级：**官方盖手填**（PRD：官方有标注就以官方为准、手填只补空缺）。
 * 实现靠对象展开顺序——手填先铺、官方后盖。
 * 非本插件通道不出现在结果里，故浏览器半查不到就自然不渲染徽标。
 *
 * @param {object} official { codebuddy: { id: token } }
 * @param {object} manual   { codebuddy|trae|qoder: { id: token } }
 * @returns {{codebuddy: object, trae: object, qoder: object}}
 */
export function mergeCredits(official, manual) {
  const off = asMap(official)
  const man = asMap(manual)
  const out = {}
  for (const channel of CREDIT_CHANNELS) {
    out[channel] = { ...asMap(man[channel]), ...asMap(off[channel]) }
  }
  return out
}
