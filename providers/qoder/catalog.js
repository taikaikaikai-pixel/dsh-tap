/**
 * providers/qoder/catalog.js — Qoder CN 模型目录（/algo/api/v2/model/list）。
 *
 * 2026-09-20 实测：签名 GET 返回明文 JSON（即便带 Encode=1——服务端对该
 * 端点不加密；密文时走 cosy.decrypt 兜底）。条目取 `.chat` 数组：
 *   { key, display_name, format, source, enable, is_vl, is_reasoning,
 *     max_input_tokens, context_config: { "<档>": { token_count, is_default } },
 *     thinking_config: { disabled: {...}, enabled: { efforts: { "<档>": {...} } } } }
 * 只收 format==='openai' 且 enable!==false 的条目（实测 14 个全满足）。
 * contextWindow 取 context_config 默认档（无则 max_input_tokens）；
 * 目录不发布输出上限——maxTokens 取 32768 保守默认（可在 settings 镜像后手调）。
 * 思考强度取 thinking_config 的逐模型能力声明（见 qoderReasoningEfforts）——
 * 投影进 profile.reasoningEfforts，宿主 Model/Effort 选择器据此出档（同
 * CodeBuddy 侧 catalogReasoningEfforts 的分层：目录声明 → 镜像 → 宿主选择器）。
 */

/**
 * thinking_config → dsh `reasoningEfforts` 档位表（键 = 档位名，值 = 出站线值）。
 *
 * 2026-10-04 实测（14 模型全量目录，证据 docs/probes/qoder-thinking-config-*.json）：
 *   { disabled: {...}, enabled: { efforts: { "<档>": { is_default? } }, is_default? } }
 * - `disabled` 在场 = 该模型**声明**支持关思考 → `off: null`。null = 省略参数
 *   （与网关 prefs 的 off 语义、codebuddy 侧 off 档同一条线），不是发 "off"
 *   拼写——档位拼写的接受面逐模型不一致，不臆造（踩坑 #42）。
 * - `enabled.efforts` 的键 = 可选档位，线值照抄档位名（与设置卡 prefs 的既有
 *   拼写同源；网关只做"未带时补默认"，不翻译）。
 * - 无 thinking_config、或 enabled 里没有命名档位（如 qmodel/qmodel_latest 只有
 *   一个开关）→ 返回 null：llm-pi-ai 拒绝"只有 off"的档位表，且没有强度可选时
 *   不该在宿主选择器里摆一个空档位。
 * @param {object} entry 目录原始条目
 * @returns {Record<string, string|null>|null} 档位表或 null
 */
export function qoderReasoningEfforts(entry) {
  const tc = entry?.thinking_config
  if (!tc || typeof tc !== 'object') return null
  const enabled = tc.enabled && typeof tc.enabled === 'object' ? tc.enabled : null
  const efforts = enabled?.efforts && typeof enabled.efforts === 'object' ? enabled.efforts : null
  const levels = efforts
    ? Object.keys(efforts).filter((k) => typeof k === 'string' && k)
    : []
  if (!levels.length) return null
  const table = {}
  if (tc.disabled && typeof tc.disabled === 'object') table.off = null
  for (const level of levels) table[level] = level
  return table
}

/** 目录条目 → dsh profile。 */
export function projectQoderModel(entry) {
  if (!entry || typeof entry.key !== 'string' || !entry.key) return null
  const ctxVariants = entry.context_config && typeof entry.context_config === 'object'
    ? Object.values(entry.context_config)
    : []
  const defaultVariant = ctxVariants.find((v) => v?.is_default) ?? ctxVariants[0] ?? null
  const contextWindow = Number.isFinite(defaultVariant?.token_count)
    ? defaultVariant.token_count
    : (Number.isFinite(entry.max_input_tokens) ? entry.max_input_tokens : 128000)
  const reasoningEfforts = qoderReasoningEfforts(entry)
  return {
    id: entry.key,
    name: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.key,
    contextWindow,
    maxTokens: 32768,
    input: entry.is_vl === true ? ['text', 'image'] : ['text'],
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
  }
}

/**
 * 目录条目 → 上下文变体清单 [{name, tokenCount, isDefault}]（context_config
 * 变体表，实测 Qwen3.8-Max：200K 默认/400K/1M）。无变体/全非法 → []——
 * 设置卡据此隐藏该模型的上下文选择。
 */
export function projectQoderVariants(entry) {
  const ctx = entry?.context_config
  if (!ctx || typeof ctx !== 'object') return []
  return Object.entries(ctx)
    .filter(([, v]) => v && Number.isFinite(v.token_count))
    .map(([name, v]) => ({ name, tokenCount: v.token_count, isDefault: v.is_default === true }))
}

/**
 * 选中变体 → profile.contextWindow 覆盖（未选/变体名已不在目录 → 原样）。
 * 纯函数单点：镜像（syncQoderModelsToDshSettings）与回归断言共用。
 */
export function applyQoderContextVariant(profile, variantName, variants) {
  if (!variantName || !Array.isArray(variants)) return profile
  const hit = variants.find((v) => v && v.name === variantName && Number.isFinite(v.tokenCount))
  if (!hit) return profile
  return { ...profile, contextWindow: hit.tokenCount }
}

/**
 * 拉取目录 → { profiles, sources, variants, raw }。明文/密文两态自适应。
 * @param {object} cosy  createCosyRuntime 实例
 * @param {object} cred  { accessToken, machineId, uid }
 * @param {string} inferBaseURL  例 https://gateway.qoder.com.cn
 */
export async function fetchQoderCatalog(cosy, cred, inferBaseURL) {
  const base = String(inferBaseURL ?? '').replace(/\/+$/, '')
  const req = await cosy.prepareGet(cred, { endpoint: base, path: '/api/v2/model/list?Encode=1' })
  const res = await fetch(req.url, { headers: req.headers })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`qoder 目录 HTTP ${res.status}：${text.slice(0, 120)}`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = JSON.parse(cosy.decrypt(text))
  }
  const chat = Array.isArray(body?.chat) ? body.chat : []
  const entries = chat.filter((e) => e && e.format === 'openai' && e.enable !== false)
  const profiles = entries.map(projectQoderModel).filter(Boolean)
  if (!profiles.length) throw new Error('qoder 目录为空（chat 数组无可用 openai 条目）')
  // X-Model-Source 头取数（全部实测条目为 "system"，但保留逐条目映射以防分化）
  const sources = {}
  for (const e of entries) sources[e.key] = typeof e.source === 'string' && e.source ? e.source : 'system'
  // 上下文变体清单逐模型保留（不进 profiles——镜像块形状不变，见 index.js 镜像纪律）
  const variants = {}
  for (const e of entries) variants[e.key] = projectQoderVariants(e)
  // 原始条目按键索引（网关出站信封的 model_config 需要 is_vl/is_reasoning/
  // max_input_tokens 等未投影字段，2026-09-22 用量归因信封对齐官方客户端）
  const byKey = {}
  for (const e of entries) byKey[e.key] = e
  return { profiles, sources, variants, entries: byKey, raw: body }
}
