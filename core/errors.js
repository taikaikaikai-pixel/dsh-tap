/**
 * core/errors.js — 宿主半错误**出口契约**的唯一实现（provider 无关）。
 *
 * 为什么单独一份：改造前宿主半有 33 处 `err?.message ?? err` 各自拼兜底文案，
 * 于是同一类失败在桥、两个网关、设置路由、宿主配置层说五种话，其中几处会把
 * 上游返回的整段 HTML/JSON 体直接灌进用户可见的错误行。本模块只做三件事，
 * 且永不 throw（err 可能是字符串、null、或 getter 抛错的怪对象）：
 *
 *   1. 取一条**可读**消息：优先 err.message，非字符串/空则回落 fallback；
 *      折叠换行、截断超长（默认 400 字，防上游把整页 HTML 塞进徽标）。
 *   2. 定一个**机器可判的 code**：err.code（如 `EADDRINUSE`）优先，其次
 *      err.kind（`core/fetch-guard.js` 的超时/取消/网络分类），否则 `internal`。
 *   3. 定一个 **kind**：`timeout` / `aborted` / `network` / `internal`，
 *      给需要分支的调用方（取消不要报 500、超时文案已含秒数）。
 *
 * 边界：只收敛**兜底位**（500 响应、lastError、sync.error）。上游语义翻译
 * （错误码表、特化文案）仍在各 provider 的 errors.js——那是协议事实，不是
 * 格式化重复。
 */

const KINDS = new Set(['timeout', 'aborted', 'network'])

/**
 * @param {unknown} err
 * @param {{ fallback?: string, maxLen?: number }} [options]
 * @returns {{ message: string, code: string, kind: 'timeout'|'aborted'|'network'|'internal' }}
 */
export function describeError(err, { fallback = 'unexpected error', maxLen = 400 } = {}) {
  let kind = 'internal'
  let code = ''
  let raw = ''

  try {
    if (err && typeof err === 'object') {
      const k = /** @type {{ kind?: unknown }} */ (err).kind
      if (typeof k === 'string' && KINDS.has(k)) kind = k
      if (kind === 'internal' && /** @type {{ name?: unknown }} */ (err).name === 'AbortError') kind = 'aborted'
      const c = /** @type {{ code?: unknown }} */ (err).code
      if (typeof c === 'string' && c !== '') code = c
      const m = /** @type {{ message?: unknown }} */ (err).message
      if (typeof m === 'string') raw = m
    } else if (typeof err === 'string') {
      raw = err
    }
  } catch {
    // err 是敌意对象（getter 抛错）：退回 fallback，绝不把异常抛给响应路径。
    raw = ''
    kind = 'internal'
    code = ''
  }

  let message = raw.replace(/\s+/g, ' ').trim()
  if (message === '') message = String(fallback ?? 'unexpected error')
  if (message.length > maxLen) message = `${message.slice(0, maxLen)}…`

  return { message, code: code === '' ? (kind === 'internal' ? 'internal' : kind) : code, kind }
}
