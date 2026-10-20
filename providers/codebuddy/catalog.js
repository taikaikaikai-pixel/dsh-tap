/**
 * providers/codebuddy/catalog.js — CodeBuddy 网关的目录与额度端点方言。
 *
 * - GET /v3/config：网关自有模型目录（官方 CLI 同款）。方言：UA 必须过
 *   12403 门（规则见 headers.js 注释与 docs/rules/ua-validation.md），
 *   API key 另需 x-api-key 头，OAuth 走 Authorization；`X-Product: SaaS`
 *   实测迷信（ua-validation.md §3 no-xproduct 臂 200），为零行为变更保留。
 * - GET /v2/accounts + POST /v2/billing/meter/get-dosage-notify：凭据可达的
 *   额度侧信号（docs/rules/quota-signals.md）。**所有端点响应头零额度信号**
 *   （P-Q1/P-Q4 实测）。额度账户级与 WorkBuddy 共享（同一
 *   Tencent-Cloud.coding-copilot 认证域）。
 * - POST /billing/meter/get-user-resource：**数值剩余额度**（R-Q7，2026-08-19
 *   G2 发现）——控制台计费路径族，**OAuth Bearer 专属**（`ck_` key 401），
 *   返回资源包列表（CapacityRemain/Precise 总量口径、CycleCapacity* 周期口径、
 *   TotalDosage）。api-key 模式跳过该调用，卡片回落估算档。
 */

import { USER_AGENT } from './headers.js'

/**
 * 「目录在列 ≠ /v2 可路由」的已知死条目（恒 11102 service info not found，
 * 踩坑 #42 同族）。判定证据：docs/probes/codebuddy-efforts-matrix-2026-09-22.json
 * （六臂全 11102）+ docs/probes/routing-2026-08-19.jsonl；2026-09-26 复核
 * hy4-preview-x 已离开目录（集合保留——重现即再置灰）。
 * 用途 = 设置卡「可路由 M」计数 + 行置灰徽标；**不改**镜像/选择器行为
 * （ transparency only，移除是另一个决策）。上游修复后从表里删 id 即可。
 */
export const UNROUTABLE_MODELS = {
  'glm-4.6v': '目录在列但 /v2/chat/completions 恒 11102 service info not found',
  'kimi-k2-thinking': '目录在列但 /v2/chat/completions 恒 11102 service info not found',
  'minimax-m2.5': '目录在列但 /v2/chat/completions 恒 11102 service info not found',
  'hy4-preview-x': '目录在列但 /v2/chat/completions 恒 11102 service info not found',
}

/**
 * 目录积分倍率 `credits`（如 `"x0.51 credits"`）→ 数字 token 字符串（`"0.51"`）。
 * 只做**原样提取**：不换算式、不排序、不补缺失值——展示层负责拼 `x`，故保留
 * 原始 token 而不是 Number()，避免 `x0.00` 被格式化成 `x0`。
 * docs/rules/quota-signals.md R-Q4 已证它是**相对展示倍率**（与实测 credit/1k
 * 不成线性），唯一硬映射是 `x0.00` ⟺ 实测零计费；因此不可当单价表使用。
 * @param {unknown} raw
 * @returns {string|null} null = 目录未声明或形态不可解析
 */
export function parseCredits(raw) {
  if (typeof raw !== 'string') return null
  const m = /x\s*(\d+(?:\.\d+)?)/i.exec(raw)
  return m ? m[1] : null
}

/**
 * @param {{ resolveCredential: (settingsFn: () => object) => Promise<object|null>,
 *           envKey: (envName: string|undefined) => string|null }} deps
 */
export function createCatalog({ resolveCredential, envKey }) {
  /** 目录端点的认证方言：Authorization + api-key 模式另带 x-api-key。 */
  async function dialectHeaders(settingsFn) {
    const s = settingsFn()
    const cred = await resolveCredential(settingsFn)
    if (!cred) return null
    const headers = {
      Accept: 'application/json',
      Authorization: cred.authorization,
      'User-Agent': USER_AGENT,
      'X-Product': 'SaaS', // 迷信（见文件头注释），零行为变更保留
    }
    if (s.authMode !== 'oauth') {
      const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
      const raw = active?.key ?? envKey(s.apiKeyEnv)
      if (raw) headers['x-api-key'] = raw
    }
    return headers
  }

  /** Fetch the gateway's own model catalog (GET /v3/config). */
  async function fetchModelCatalog(settingsFn) {
    const headers = await dialectHeaders(settingsFn)
    if (!headers) throw new Error('凭据不可用：请先在登录区配置 API Key 或完成 OAuth 登录')
    const res = await fetch(`${settingsFn().baseURL}/v3/config`, { headers })
    if (!res.ok) throw new Error(`模型目录 HTTP ${res.status}`)
    const body = await res.json()
    if (body?.code !== 0) throw new Error(`模型目录错误：${body?.code} ${body?.msg ?? ''}`)
    const data = body.data ?? {}
    const cliEnabled = new Set(
      (data.agents ?? []).find((a) => a.name === 'cli')?.models ?? [],
    )
    const models = (data.models ?? [])
      .filter((m) => typeof m?.id === 'string')
      .map((m) => {
        // 思考强度声明两代形态（2026-09-22 实测）：
        //   legacy {"effort":"high","summary":"auto"} —— 只给默认档；
        //   current {"canDisableThinking":true,"defaultEffort":"high",
        //            "supportedEfforts":["low","high","max"]} —— 给能力清单。
        // 后者是档位表的权威来源（无需探测即可驱动选择器与出站线值）。
        const reasoning = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null
        const supported = Array.isArray(reasoning?.supportedEfforts)
          ? reasoning.supportedEfforts.filter((s) => typeof s === 'string' && s)
          : null
        const defaultEffort = typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort
          ? reasoning.defaultEffort
          : null
        return {
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          maxInputTokens: m.maxInputTokens ?? null,
          maxOutputTokens: m.maxOutputTokens ?? null,
          images: m.supportsImages === true,
          cli: cliEnabled.has(m.id),
          // 积分倍率（展示口径，parseCredits 上方注释为裁判）；缺省 = null，卡片不出徽标。
          credits: parseCredits(m.credits),
          reasoning: !!reasoning && (reasoning.effort != null || defaultEffort != null
            || supported != null || typeof reasoning.canDisableThinking === 'boolean'),
          // 目录标注的**默认**档（legacy 的 effort 或新形态的 defaultEffort）——
          // 卡片把它当"未设置时的既有档位"展示，不是档位清单。
          reasoningEffort: typeof reasoning?.effort === 'string' && reasoning.effort
            ? reasoning.effort
            : defaultEffort,
          defaultEffort,
          supportedEfforts: supported,
          canDisableThinking: typeof reasoning?.canDisableThinking === 'boolean'
            ? reasoning.canDisableThinking
            : null,
        }
      })
    return { models, fetchedAt: Date.now() }
  }

  /**
   * Quota-side signals the plugin credentials can actually reach. Cached 60s;
   * never throws. OAuth 模式追加数值剩余额度（/billing/meter/get-user-resource，
   * quota-signals.md R-Q7）；api-key 模式该路径族 401（OAuth-only），
   * numericQuota=false，卡片应手填总额度做估算档。
   */
  let quotaCache = { at: 0, value: null }

  /** get-user-resource 的数值字段带 Precise 字符串变体；统一取数值。 */
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  async function fetchResourceQuota(s, headers) {
    const res = await fetch(`${s.baseURL}/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await res.json().catch(() => null)
    const data = body?.code === 0 ? body.data?.Response?.Data ?? null : null
    if (!data) return { resource: null, resourceError: `code ${body?.code ?? `http ${res.status}`}` }
    const packs = (data.Accounts ?? []).map((a) => ({
      name: a.PackageName ?? '',
      size: num(a.CapacitySizePrecise ?? a.CapacitySize),
      remain: num(a.CapacityRemainPrecise ?? a.CapacityRemain),
      cycleSize: num(a.CycleCapacitySizePrecise ?? a.CycleCapacitySize),
      cycleRemain: num(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain),
      cycleUsed: num(a.CycleCapacityUsedPrecise ?? a.CycleCapacityUsed),
      cycleStart: a.CycleStartTime ?? '',
      cycleEnd: a.CycleEndTime ?? '',
    }))
    const sum = (k) => Math.round(packs.reduce((acc, p) => acc + (p[k] ?? 0), 0) * 100) / 100
    return {
      resource: {
        // TotalDosage = Σ 总量口径剩余（实测吻合，取整）；cycle* 为当前周期口径
        totalRemain: num(data.TotalDosage),
        cycleRemain: sum('cycleRemain'),
        cycleUsed: sum('cycleUsed'),
        cycleSize: sum('cycleSize'),
        packs,
      },
      resourceError: null,
    }
  }

  async function fetchQuotaSnapshot(settingsFn) {
    const s = settingsFn()
    const cred = await resolveCredential(settingsFn)
    if (!cred) return { error: '凭据不可用：请先配置 API Key 或完成 OAuth 登录' }
    const headers = {
      Accept: 'application/json',
      Authorization: cred.authorization,
      ...cred.headers,
      'User-Agent': USER_AGENT,
      'X-Product': 'SaaS',
    }
    // Same dialect as fetchModelCatalog: api-key mode also carries the raw key
    // in x-api-key (the gateway authenticates these routes by it).
    if (s.authMode !== 'oauth') {
      const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
      const raw = active?.key ?? envKey(s.apiKeyEnv)
      if (raw) headers['x-api-key'] = raw
    }
    const readJsonBody = (r) => r.json().catch(() => null)
    const oauthMode = s.authMode === 'oauth'
    const [accBody, dosageBody, resourcePart] = await Promise.all([
      fetch(`${s.baseURL}/v2/accounts`, { headers }).then(readJsonBody, () => null),
      fetch(`${s.baseURL}/v2/billing/meter/get-dosage-notify`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      }).then(readJsonBody, () => null),
      // 数值额度：OAuth-only（R-Q7）；api-key 模式不浪费一次 401。
      oauthMode
        ? fetchResourceQuota(s, headers).catch(() => ({ resource: null, resourceError: 'network' }))
        : Promise.resolve({ resource: null, resourceError: null }),
    ])
    const accounts = accBody?.code === 0 ? accBody.data?.accounts ?? [] : null
    // The "current" account is the one flagged lastLogin (observed live), else first.
    const current = accounts?.find((a) => a?.lastLogin === true) ?? accounts?.[0] ?? null
    const dosage = dosageBody?.code === 0 ? dosageBody.data ?? null : null
    return {
      account: current ? {
        nickname: current.nickname ?? '',
        type: current.type ?? '',
        enterpriseName: current.enterpriseName ?? '',
        pluginEnabled: current.pluginEnabled === true,
      } : null,
      accountsError: accBody?.code === 0 ? null : `code ${accBody?.code ?? 'http'}`,
      dosage: dosage ? {
        code: dosage.dosageNotifyCode ?? 0,
        text: dosage.dosageNotifyZh || dosage.dosageNotifyEn || '',
        skipUrl: dosage.skipUrl ?? '',
      } : null,
      dosageError: dosageBody?.code === 0 ? null : `code ${dosageBody?.code ?? 'http'}`,
      numericQuota: oauthMode,
      resource: resourcePart.resource,
      resourceError: resourcePart.resourceError,
      fetchedAt: Date.now(),
    }
  }

  function quotaSnapshot(settingsFn) {
    if (quotaCache.value && Date.now() - quotaCache.at < 60_000) {
      return Promise.resolve(quotaCache.value)
    }
    return fetchQuotaSnapshot(settingsFn)
      .catch((err) => ({ error: err?.message ?? String(err) }))
      .then((value) => {
        quotaCache = { at: Date.now(), value }
        return value
      })
  }

  return { fetchModelCatalog, quotaSnapshot }
}
