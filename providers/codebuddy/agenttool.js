/**
 * providers/codebuddy/agenttool.js — CodeBuddy /agenttool 后端：
 * dsh 原生 web_search / web_fetch 工具的网关实现。
 *
 * 端点方言：POST JSON，信封 {code, msg, data/results}；错误以 JSON code/msg
 * 返回（探测证据见 docs/rules/）。UA 头组历史上被 12403 拒过，2026-08-19
 * 复测已无 UA 门（docs/rules/ua-validation.md §2）——头组按零行为变更保留。
 *
 * 计量说明（docs/rules/quota-signals.md R-Q2）：探测
 * 实测 agenttool search/webfetch 响应体**无计量字段**——重构前 search/fetch
 * 里 `if (data?.usage) recordUsage(...)` 是死路径，本次删除，不重建。
 */

import { USER_AGENT } from './headers.js'
import { CREDENTIAL_UNAVAILABLE_MESSAGE } from './errors.js'

/**
 * @param {{ withKeyRotation: (settingsFn: () => object, attempt: Function) => Promise<object> }} deps
 */
export function createAgentTool({ withKeyRotation }) {
  async function callAgentTool(settings, path, payload, signal) {
    const { res, err } = await withKeyRotation(settings, (cred) => fetch(`${settings().baseURL}${path}`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: cred.authorization,
        ...cred.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    }))
    if (err) {
      if (err.message === CREDENTIAL_UNAVAILABLE_MESSAGE) throw err
      if (signal?.aborted) throw err
      // undici hides the real reason in err.cause (ECONNRESET, terminated,
      // certificate errors …) — a bare "fetch failed" is undebuggable.
      const causes = []
      for (let e = err; e; e = e.cause) causes.push(e.code ?? e.message ?? String(e))
      throw new Error(`CodeBuddy agenttool ${path} network error: ${causes.join(' ← ')}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // The gateway answers errors as JSON with code/msg — surface both.
      let codeMsg = ''
      try { const j = JSON.parse(body); if (j?.code != null) codeMsg = ` code ${j.code}: ${j.msg ?? ''}` } catch { /* not JSON */ }
      throw new Error(`CodeBuddy agenttool ${path} HTTP ${res.status}${codeMsg || ` ${body.slice(0, 160)}`}`)
    }
    const data = await res.json().catch(() => null)
    if (data && data.code != null && data.code !== 0) {
      throw new Error(`CodeBuddy agenttool ${path} error ${data.code}: ${data.msg ?? ''}`)
    }
    return data
  }

  /** Search backend: POST /agenttool/v1/search {query, type, max_results}. */
  function makeSearchProvider(settings) {
    return {
      id: 'codebuddy',
      available() {
        return true // cheap check only; real failures surface per request
      },
      async search(request, signal) {
        const s = settings()
        const data = await callAgentTool(
          settings,
          '/agenttool/v1/search',
          {
            query: request.query,
            type: 'text2text',
            max_results: request.maxResults ?? s.searchMaxResults,
          },
          signal,
        )
        const results = Array.isArray(data?.results) ? data.results : []
        return {
          sources: results
            .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
            .map((r) => ({
              url: r.url,
              ...(typeof r.title === 'string' && r.title.length > 0 ? { title: r.title } : {}),
              ...(typeof r.snippet === 'string' && r.snippet.length > 0 ? { snippet: r.snippet } : {}),
            })),
          // The seam itself truncates to maxResults; we already passed it
          // through as max_results, so nothing extra was cut here.
          truncated: false,
        }
      },
    }
  }

  /**
   * Fetch backend: POST /agenttool/v1/webfetch {url} → {url, title, content}.
   * The endpoint answers with decoded content or a JSON error, never the
   * target page's HTTP status, so a successful call reports statusCode 200
   * and the body is classified as text.
   */
  function makeFetchProvider(settings) {
    return {
      id: 'codebuddy',
      available() {
        return true
      },
      async fetch(request, signal) {
        const s = settings()
        const data = await callAgentTool(settings, '/agenttool/v1/webfetch', { url: request.url }, signal)
        const content = typeof data?.content === 'string' ? data.content : ''
        const cap = s.fetchBodyCap
        return {
          url: typeof data?.url === 'string' && data.url.length > 0 ? data.url : request.url,
          statusCode: 200,
          body: { kind: 'text', content: content.slice(0, cap) },
          truncated: content.length > cap,
        }
      },
    }
  }

  return { makeSearchProvider, makeFetchProvider }
}
