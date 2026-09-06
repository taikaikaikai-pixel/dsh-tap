/**
 * providers/openai-compat.js — key 型 OpenAI 兼容上游的共享骨架。
 *
 * 一个"适配器实例"= preset（id/displayName/baseURL/keyRef）+ 本模块的
 * 通用行为：GET {baseURL}/models 拉模型清单、组装 llm-pi-ai provider 块。
 * 上游特化（baseURL 方言、模型尺寸表等）放进 providers/<name>/index.js，
 * 本模块与 core/ 一样不得出现具体上游名（静态扫描在 verify-core-generic）。
 */

/** 官方 CustomProviderCard 同款路由 id 规则（dsh-client-ui-settings-models）。 */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 凭据命名惯例：<ROUTE>_API_KEY（大写、非字母数字折 _）。 */
export function keyRefFor(id) {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
}

/**
 * GET {baseURL}/models（OpenAI 标准目录端点），Bearer key 直调。
 * 返回 [{id}]；非 2xx 带上游摘要抛错（添加前先用它验 key）。
 * HTTP 404 单独标记 err.code = 'MODELS_ENDPOINT_404'——部分真实上游
 * （iFlow、portal.qwen.ai 等）根本没有 /models 路由，调用方可回落
 * probeChatKey 验证（preset 声明 fallbackModels 时）。
 */
export async function fetchOpenAIModels(baseURL, apiKey, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(baseURL.replace(/\/+$/, '') + '/models', {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`GET /models ${res.status}: ${text.slice(0, 200)}`)
      if (res.status === 404) err.code = 'MODELS_ENDPOINT_404'
      throw err
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`GET /models 返回非 JSON: ${text.slice(0, 120)}`)
    }
    const rows = Array.isArray(data?.data) ? data.data : []
    const models = rows
      .filter((m) => typeof m?.id === 'string' && m.id)
      .map((m) => ({ id: m.id }))
    if (!models.length) throw new Error('GET /models 返回空清单（key 可能无权限）')
    return models
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 组装 llm-pi-ai provider 块（写 settings.yaml 的形状）。
 * apiKeyEnv 指向 ~/.dsh/.credentials.yaml 里的 keyRef；sizes 不给就吃
 * dsh 默认值（defaultContextWindow 262144 / defaultMaxTokens 32768）。
 */
export function providerBlock(preset, models) {
  return {
    displayName: preset.displayName,
    api: 'openai-completions',
    baseURL: preset.baseURL,
    apiKeyEnv: keyRefFor(preset.id),
    models: models.map((m) => (m.name ? { id: m.id, name: m.name } : { id: m.id })),
  }
}

/**
 * 认证失败的身体特征（各上游方言汇总，2026-08-19 实测）：
 * - 标准：HTTP 401/403，或 body error.code = invalid_api_key 类
 * - iFlow 方言：HTTP 200 + {"status":"434","msg":"Invalid apiKey…"}
 */
const AUTH_FAIL_RE = /invalid[_ ]?(api[_ ]?key|access token)|unauthorized|"status"\s*:\s*"?434/i

/**
 * 无 /models 端点上游的 key 验证：POST /chat/completions 最小探针
 * （max_tokens 1，耗量可忽略；仅导入时用户确认后运行一次）。
 * 认证失败抛错；其余一切响应（含模型错误等 4xx）视为 key 有效——
 * 服务器拒绝的是请求内容而不是凭据。网络错误原样抛出（无法判定）。
 */
export async function probeChatKey(baseURL, apiKey, model, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(baseURL.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (res.status === 401 || res.status === 403 || AUTH_FAIL_RE.test(text.slice(0, 400))) {
      throw new Error(`key 验证失败（上游认证拒绝 ${res.status}）: ${text.slice(0, 160)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 注册表入口：preset + 凭据引用 + 通用行为。 */
export function createOpenAICompatProvider(preset) {
  const fallback = Array.isArray(preset.fallbackModels) ? preset.fallbackModels.filter((m) => typeof m === 'string' && m) : []
  return {
    id: preset.id,
    displayName: preset.displayName,
    baseURL: preset.baseURL,
    keyRef: keyRefFor(preset.id),
    fallbackModels: fallback,
    async fetchModels(apiKey) {
      try {
        return await fetchOpenAIModels(preset.baseURL, apiKey)
      } catch (err) {
        // 上游没有 /models 且 preset 给了兜底清单：chat 探针验 key，清单吃兜底。
        if (err?.code === 'MODELS_ENDPOINT_404' && fallback.length) {
          await probeChatKey(preset.baseURL, apiKey, fallback[0])
          return fallback.map((id) => ({ id }))
        }
        throw err
      }
    },
    modelBlock: (models) => providerBlock({ ...preset }, models),
  }
}
