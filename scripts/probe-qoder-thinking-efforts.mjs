#!/usr/bin/env node
/**
 * probe-qoder-thinking-efforts.mjs — Qoder 本地翻译网关（OpenAI 兼容 /v1）
 * reasoning_effort 档位单调性实测：显式 effort 各档 × N 采样，聚合 reasoning
 * 字符数 / completion tokens，按档位语义序打单调性判定。
 *
 * 为什么需要：0.18.0/0.19.0 记录在案的未定论——6 臂单采样非单调、disabled 臂仍
 * 出 619 字推理 ⇒ 按踩坑 #42（能力声明 ≠ 线值）没敢下结论。本探针把那次取证
 * 升级为「显式档位 × 多采样聚合」，一条命令出 MONOTONIC / INCONCLUSIVE。
 *
 * 臂设计（变量干净优先）：
 *   - 臂 = **显式 reasoning_effort**。网关对客户端已带的 effort 透传不覆盖
 *     （providers/qoder/gateway.js：仅 payload 未带时才注入该模型 prefs 的
 *     effort），显式带参即绕开 prefs 注入，baseline 不被存量 max 污染。
 *   - off 臂跳过：openai 方言 off = 省略参数，省略会触发网关注入 prefs effort，
 *     变量不干净。off 档是否真能关思考不在本探针范围（历史 disabled 臂实测
 *     仍出推理），报告按「off 未测」处理。
 *   - 各模型跑哪些档 = 目录声明快照（DECLARED_TIERS，真源 providers/qoder/
 *     catalog.js qoderReasoningEfforts；2026-10-04 全量目录实测，见
 *     docs/probes/qoder-thinking-config-*.json，可用
 *     `node scripts/probe-qoder-thinking-config.mjs` 重取）减 off，按语义序
 *     off<low<medium<high<xhigh<max 排序后做相邻对单调性检查。
 *
 * 判据（踩坑 #42 纪律：多采样、非单调不下结论）：
 *   每臂 --repeat（默认 3）次同题同 prompt → 聚合 reasoningChars min/mean/max
 *   与 completionTokens min/mean/max；按档位语义序检查**均值单调不减**——
 *     任一相邻对下降   → INCONCLUSIVE（#42：非单调，不下结论）
 *     任一臂有样本报错 → INCONCLUSIVE（错误原样落证据）
 *     全部不减        → MONOTONIC（若各档均值全等，额外标注 flat）
 *
 * 用法：
 *   node scripts/probe-qoder-thinking-efforts.mjs                  # 默认 qmodel_38max+dmodel ×3 repeat（15 次）
 *   node scripts/probe-qoder-thinking-efforts.mjs --models dmodel  # 只跑一个模型
 *   node scripts/probe-qoder-thinking-efforts.mjs --repeat 5       # 每臂 5 次采样
 *   node scripts/probe-qoder-thinking-efforts.mjs --endpoint http://127.0.0.1:3903/v1
 *   node scripts/probe-qoder-thinking-efforts.mjs --help
 *
 * 额度账：总调用 = Σ(每模型档位臂数) × --repeat；默认 2 模型（3+2 臂）× 3 = 15
 * 次，硬闸 ≤ 30 次超出即拒跑。max_tokens 钳 1024。走的是 Qoder 订阅额度
 * （免费输入面），每臂样本真实入账。
 *
 * 凭据：无需配置——鉴权走本地网关固定 token（Authorization: Bearer dsh-qoder-bridge，
 * 网关仅监听 127.0.0.1 回环），Qoder 侧凭据由桌面端 OAuth 会话提供。
 * 证据 → docs/probes/qoder-efforts-<ts>.json（含 endpoint/模型/臂/逐样本原始 usage）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENDPOINT_DFLT = process.env.QODER_BRIDGE_ENDPOINT ?? 'http://127.0.0.1:3913/v1'
const BRIDGE_TOKEN = 'dsh-qoder-bridge'
const MAX_TOKENS = 1024
const MAX_TOTAL_CALLS = 30
const CALL_TIMEOUT_MS = 180_000
const PROMPT = '一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？只给最终数字。'

/** 目录声明档位静态快照（DECLARED_TIERS，来源见头注释）。目录改版后重取。 */
const DECLARED_TIERS = {
  qmodel_38max: ['off', 'low', 'medium', 'xhigh'],
  qfmodel: ['off', 'low', 'medium', 'xhigh'],
  dmodel: ['off', 'high', 'max'],
  gm51model: ['off', 'high', 'max'],
  gmodel: ['high', 'low', 'max'],
  kmodel: ['high', 'low', 'max'],
  kmodel_latest: ['high', 'low', 'max'],
}
/** 档位语义序（只用于排序做单调性检查；各家族内部顺序均成立）。 */
const TIER_RANK = { off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const ENDPOINT = String(argOf('--endpoint', ENDPOINT_DFLT)).replace(/\/+$/, '')
const MODELS = String(argOf('--models', 'qmodel_38max,dmodel')).split(',').map((s) => s.trim()).filter(Boolean)
const REPEAT = Number(argOf('--repeat', '3'))

const USAGE = `probe-qoder-thinking-efforts.mjs — Qoder 本地网关 reasoning_effort 档位单调性实测

用法：node scripts/probe-qoder-thinking-efforts.mjs [选项]

臂 = 显式 reasoning_effort（透传不覆盖，绕开 prefs 注入）；off 臂跳过（openai 方言
off = 省略参数，会触发 prefs 注入，变量不干净）。各模型档位取目录声明快照减 off。
判据：每臂多采样聚合，档位语义序上检查 reasoning 字符数均值单调不减——
非单调 = INCONCLUSIVE（踩坑 #42）；单调 = MONOTONIC。

  --models a,b       指定模型（默认 qmodel_38max,dmodel；可选 qfmodel/gm51model/gmodel/kmodel/kmodel_latest）
  --repeat N         每臂采样 N 次并聚合 min/mean/max（默认 3）
  --endpoint URL     本地 Qoder 网关（默认 http://127.0.0.1:3913/v1，或环境变量 QODER_BRIDGE_ENDPOINT）
  --help             本帮助

总额度硬闸 30 次上游调用；max_tokens 钳 1024；同题同 prompt 顺序采样。
证据 → docs/probes/qoder-efforts-<ts>.json。`

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

if (!Number.isInteger(REPEAT) || REPEAT < 1) {
  console.error(`--repeat 必须是 ≥1 的整数，收到：${argOf('--repeat', '3')}`)
  process.exit(2)
}

// 每模型的臂 = 目录声明减 off，按语义序排（含 off 时注明跳过原因）。
function armsOf(model) {
  const tiers = DECLARED_TIERS[model]
  if (!tiers) return { error: `DECLARED_TIERS 无该模型的声明快照（已知：${Object.keys(DECLARED_TIERS).join(', ')}）` }
  const run = tiers.filter((t) => t !== 'off')
  const unsortable = run.filter((t) => !(t in TIER_RANK))
  if (unsortable.length) return { error: `档位拼写无法排序：${unsortable.join(',')}（TIER_RANK 需扩充）` }
  run.sort((a, b) => TIER_RANK[a] - TIER_RANK[b])
  return { arms: run, skippedOff: tiers.includes('off') }
}

const plan = MODELS.map((model) => ({ model, ...armsOf(model) }))
const badPlan = plan.filter((p) => p.error)
if (badPlan.length) {
  for (const p of badPlan) console.error(`${p.model}: ${p.error}`)
  process.exit(2)
}
const totalCalls = plan.reduce((n, p) => n + p.arms.length * REPEAT, 0)
console.log('额度账：')
for (const p of plan) console.log(`  ${p.model}: ${p.arms.join(' < ')} 共 ${p.arms.length} 臂 × ${REPEAT} repeat = ${p.arms.length * REPEAT} 次`)
console.log(`合计 ${totalCalls} 次（硬闸 ${MAX_TOTAL_CALLS}）${plan.some((p) => p.skippedOff) ? '；off 臂跳过（省略参数会触发 prefs 注入，变量不干净）' : ''}`)
if (totalCalls > MAX_TOTAL_CALLS) {
  console.error(`超出硬闸：${totalCalls} > ${MAX_TOTAL_CALLS} 次上游调用，拒跑。请减模型/臂或调低 --repeat。`)
  process.exit(2)
}

// 预检：本地 GET /v1/models 免费且不烧上游额度（网关本地路由），验证可达 + 目录在位。
async function preflight() {
  let res
  try {
    res = await fetch(`${ENDPOINT}/models`, { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` }, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new Error(`网关不可达 ${ENDPOINT}/models：${err?.cause?.code ?? err?.message ?? err}`)
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep text */ }
  if (!res.ok || !Array.isArray(json?.data)) {
    throw new Error(`预检失败 HTTP ${res.status}：${text.slice(0, 300)}`)
  }
  return json.data.map((m) => m?.id).filter(Boolean)
}

let catalogIds
try {
  catalogIds = await preflight()
} catch (err) {
  console.error(String(err?.message ?? err))
  process.exit(2)
}
console.log(`预检 OK：${ENDPOINT}（目录 ${catalogIds.length} 个模型）`)
const missing = plan.filter((p) => !catalogIds.includes(p.model))
if (missing.length) {
  console.error(`模型不在网关目录里：${missing.map((p) => p.model).join(', ')}（目录有：${catalogIds.join(', ')}）`)
  process.exit(2)
}

async function call(model, effort) {
  let res
  try {
    res = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        reasoning_effort: effort,
        messages: [{ role: 'user', content: PROMPT }],
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch (err) {
    return { status: 0, reasoningChars: 0, textChars: 0, completionTokens: null, usage: null, error: { code: 'fetch_failed', message: String(err?.cause?.code ?? err?.message ?? err) } }
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep text */ }
  const msg = json?.choices?.[0]?.message ?? null
  return {
    status: res.status,
    reasoningChars: typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0,
    textChars: typeof msg?.content === 'string' ? msg.content.length : 0,
    completionTokens: Number.isFinite(json?.usage?.completion_tokens) ? json.usage.completion_tokens : null,
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    usage: json?.usage ?? null,
    error: json?.error
      ? { code: json.error.code ?? null, message: String(json.error.message ?? '').slice(0, 200) }
      : (res.ok ? null : { code: `http_${res.status}`, message: text.slice(0, 200) }),
  }
}

// 每臂聚合：保留全部逐样本原始数据，标量归并（min/mean/max，同 probe-ark-thinking
// 的 aggregateArm 思路）。completionTokens 逐样本可能为 null，只对数值聚合。
function aggregateArm(samples) {
  const stat = (pick) => {
    const vs = samples.map(pick).filter((v) => Number.isFinite(v))
    if (!vs.length) return null
    return { min: Math.min(...vs), mean: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10, max: Math.max(...vs) }
  }
  const statuses = [...new Set(samples.map((s) => s.status))]
  const errors = [...new Set(samples.filter((s) => s.error).map((s) => JSON.stringify(s.error)))].map((s) => JSON.parse(s))
  return {
    runs: samples.length,
    status: statuses.length === 1 ? statuses[0] : statuses,
    reasoningChars: stat((s) => s.reasoningChars),
    completionTokens: stat((s) => s.completionTokens),
    error: errors.length ? errors : null,
    samples,
  }
}

const fmt = (a) => `http=${JSON.stringify(a.status)} ×${a.runs} reasoning=min ${a.reasoningChars?.min ?? '—'}/mean ${a.reasoningChars?.mean ?? '—'}/max ${a.reasoningChars?.max ?? '—'} completion=min ${a.completionTokens?.min ?? '—'}/mean ${a.completionTokens?.mean ?? '—'}/max ${a.completionTokens?.max ?? '—'}${a.error ? ` error=${JSON.stringify(a.error)}` : ''}`

// 单调性判定（#42）：先看臂级错误，再看档位语义序上均值是否单调不减。
function judge(armNames, arms) {
  const bad = armNames.filter((a) => arms[a].error)
  if (bad.length) return { verdict: 'INCONCLUSIVE', reason: `臂报错：${bad.join(',')}（错误原文见证据 samples）` }
  const means = armNames.map((a) => arms[a].reasoningChars?.mean)
  if (means.some((v) => !Number.isFinite(v))) return { verdict: 'INCONCLUSIVE', reason: 'usage/reasoning 缺失，无法聚合' }
  for (let i = 1; i < means.length; i++) {
    if (means[i] < means[i - 1]) return { verdict: 'INCONCLUSIVE', reason: `非单调（#42）：${armNames[i - 1]} mean ${means[i - 1]} → ${armNames[i]} mean ${means[i]} 下降，不下结论` }
  }
  const flat = new Set(means).size === 1
  return { verdict: 'MONOTONIC', reason: flat ? '均值随档位单调不减（全平：各档观测相等，未见档位差异）' : '均值随档位单调不减' }
}

const report = []
for (const { model, arms: armNames, skippedOff } of plan) {
  const arms = {}
  for (const arm of armNames) {
    const samples = []
    for (let i = 0; i < REPEAT; i++) samples.push(await call(model, arm))
    arms[arm] = aggregateArm(samples)
  }
  const { verdict, reason } = judge(armNames, arms)
  report.push({
    model,
    declaredTiers: DECLARED_TIERS[model],
    armsRun: armNames,
    offSkipped: skippedOff || undefined,
    verdict,
    verdictReason: reason,
    arms,
  })
  console.log(`\n### ${model} → ${verdict}（${reason}）`)
  for (const arm of armNames) console.log(`  ${arm.padEnd(7)}: ${fmt(arms[arm])}`)
}

mkdirSync(join(ROOT, 'docs', 'probes'), { recursive: true })
const out = join(ROOT, 'docs', 'probes', `qoder-efforts-${Date.now()}.json`)
writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(),
  endpoint: ENDPOINT,
  purpose: 'reasoning_effort 档位单调性实测（0.18.0/0.19.0 未定论的复核：显式档位 × 多采样）',
  prompt: PROMPT,
  maxTokens: MAX_TOKENS,
  repeat: REPEAT,
  armDesign: '臂 = 显式 reasoning_effort（网关透传不覆盖，绕开 prefs 注入）；off 臂跳过（省略参数会触发 prefs 注入）',
  declaredTiersSource: 'providers/qoder/catalog.js qoderReasoningEfforts 的 2026-10-04 目录快照（docs/probes/qoder-thinking-config-*.json）',
  verdictRule: '档位语义序（off<low<medium<high<xhigh<max）上 reasoningChars 均值单调不减 → MONOTONIC；任一下降或臂报错 → INCONCLUSIVE（踩坑 #42）',
  models: report,
}, null, 2))
console.log('\n证据 →', out)
