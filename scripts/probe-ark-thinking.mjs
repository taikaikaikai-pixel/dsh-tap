#!/usr/bin/env node
/**
 * probe-ark-thinking.mjs — 火山 Ark `/api/plan`（anthropic 方言）逐模型思考面实测，
 * 并**产出可直接用的 `reasoningEfforts` 声明**（新模型进 Ark 后不必再手工分析）。
 *
 * 为什么需要：宿主输入框的「推理等级」只由模型条目的 `reasoningEfforts` 决定
 * （踩坑 #64），而 Ark 的 plan 端点**不发布目录/能力声明**（无 GET /models），
 * 所以这张表只能靠实测。手工做过一次（2026-10-04，见 docs/goals/desktop-adaptation.md），
 * 本脚本把那次分析固化成一条命令。
 *
 * 判据（默认**省额度两臂**；`--full-matrix` 才是旧三臂全矩阵）：
 *   baseline  = 不带 thinking        → 有 thinking 块 = 该模型默认思考
 *   enabled   = thinking{type:enabled, budget_tokens} → 200 = 接受显式档位
 *   disabled  = thinking{type:disabled} → 200 且无 thinking 块 = **支持真关思考**（仅 --full-matrix）
 *                                          → 声明里给 `off: null`（= 省略参数… 注意
 *                                          见下方 off 语义说明）；400 = 不给 off 档
 *
 * 省额度默认（2026-10-04 起；此前一次 7 模型全量把 volces 额度打光）：每模型只跑
 * baseline+enabled 两臂，disabled 不跑 → off 视为「未测」，档位表不含 off（不臆造档位，
 * 踩坑 #42）；`--write` 遇 patch 里已有 off 档（此前 --full-matrix 实测写入）会保留不覆盖。
 * off 的新证/否证只能靠 `--full-matrix`。
 *
 * off 语义（踩坑 #64）：pi-ai 对 anthropic 方言的 off 线值就是发
 * `thinking:{type:disabled}`，所以**只有 disabled 被接受的模型才声明 off**；
 * 不声明 off 的模型"默认档" = 不带 thinking 参数 = 上游默认（照常思考），安全。
 *
 * 用法：
 *   node scripts/probe-ark-thinking.mjs                       # 省额度默认：baseline+enabled 两臂
 *   node scripts/probe-ark-thinking.mjs --full-matrix         # 旧行为：三臂全矩阵（可证 off）
 *   node scripts/probe-ark-thinking.mjs --models a,b,c        # 指定模型
 *   node scripts/probe-ark-thinking.mjs --emit yaml           # 打印可粘贴的 reasoningEfforts 块
 *   node scripts/probe-ark-thinking.mjs --write <patch.yml>   # 直接写进 profile patch（留 .bak）
 *   node scripts/probe-ark-thinking.mjs --levels low,medium,high,max   # 档位拼写（只影响声明，不加调用量）
 *   node scripts/probe-ark-thinking.mjs --repeat 3            # 每臂 3 次并聚合（min/mean/max），默认 1
 *   node scripts/probe-ark-thinking.mjs --from <证据.json>    # 复用证据，不打上游只 emit/write
 *
 * 额度账：每模型上游调用 = 两臂（默认）或三臂（--full-matrix）× --repeat；7 模型默认 14 次。
 *
 * 凭据：`~/.dsh/.credentials.yaml` 的 `refs.VOLCES_API_KEY`（或环境变量 VOLCES_API_KEY）。
 * 证据 → docs/probes/ark-thinking-<ts>.json
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML, { isScalar } from 'yaml'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ENDPOINT = process.env.ARK_PLAN_ENDPOINT ?? 'https://ark.cn-beijing.volces.com/api/plan/v1/messages'
const DEFAULT_MODELS = ['deepseek-v4.1-flash', 'ark-code-latest', 'glm-5.3-flash', 'glm-5.3', 'kimi-k3', 'doubao-seed-evolving', 'doubao-seed-2.1-lite']
const PROMPT = '一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？只给最终数字。'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const MODELS = String(argOf('--models', DEFAULT_MODELS.join(','))).split(',').map((s) => s.trim()).filter(Boolean)
const LEVELS = String(argOf('--levels', 'low,medium,high,max')).split(',').map((s) => s.trim()).filter(Boolean)
const EMIT = args.includes('--emit')
const WRITE = argOf('--write', null)
const REPEAT = Number(argOf('--repeat', '1')) || 1
const FULL_MATRIX = args.includes('--full-matrix')

const USAGE = `probe-ark-thinking.mjs — Ark /api/plan 逐模型思考面实测 → reasoningEfforts 声明

用法：node scripts/probe-ark-thinking.mjs [选项]

默认省额度模式：每模型只跑 baseline（不带 thinking）+ enabled（thinking enabled 默认 budget）
两臂；disabled 臂不跑 → off 档视为「未测」，档位表不含 off（不臆造），--write 会保留
patch 里已有的 off 档。只有 --full-matrix 才跑 disabled 臂、才能下 off 结论。

  --full-matrix        恢复全矩阵：baseline/enabled/disabled 三臂 × --repeat
  --models a,b,c       指定模型（默认静态清单 7 个）
  --levels a,b,c       档位拼写，只影响产出的声明拼写，不影响上游调用次数（默认 low,medium,high,max）
  --repeat N           每臂重复 N 次并聚合（thinkingChars 给 min/mean/max，状态/错误归并）；默认 1
  --emit               打印可粘贴的 reasoningEfforts 块
  --write <patch.yml>  直接写进 profile patch 的 volces.models（留 .bak）
  --from <证据.json>   复用既有证据文件，不打上游，只做 emit/write
  --help               本帮助

凭据：~/.dsh/.credentials.yaml 的 refs.VOLCES_API_KEY（或环境变量 VOLCES_API_KEY）。
证据 → docs/probes/ark-thinking-<ts>.json。
额度账：每模型上游调用 = 两臂（默认）或三臂（--full-matrix）× --repeat；7 模型默认 14 次。`

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

function apiKey() {
  if (process.env.VOLCES_API_KEY) return process.env.VOLCES_API_KEY
  const p = join(DSH_HOME, '.credentials.yaml')
  if (!existsSync(p)) return null
  const doc = YAML.parse(readFileSync(p, 'utf8'))
  return doc?.refs?.VOLCES_API_KEY ?? null
}

const key = apiKey()
if (!key) {
  console.error(`未找到凭据：环境变量 VOLCES_API_KEY 或 ${join(DSH_HOME, '.credentials.yaml')} 的 refs.VOLCES_API_KEY`)
  process.exit(2)
}

async function call(model, thinking) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: PROMPT }],
      ...(thinking === undefined ? {} : { thinking }),
    }),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep text */ }
  const blocks = Array.isArray(json?.content) ? json.content : []
  return {
    status: res.status,
    blockTypes: blocks.map((b) => b?.type).filter(Boolean),
    thinkingChars: blocks.filter((b) => b?.type === 'thinking').reduce((n, b) => n + String(b.thinking ?? '').length, 0),
    textChars: blocks.filter((b) => b?.type === 'text').reduce((n, b) => n + String(b.text ?? '').length, 0),
    usage: json?.usage ?? null,
    error: json?.error ? { code: json.error.code, message: String(json.error.message ?? '').slice(0, 160) } : (res.ok ? null : text.slice(0, 160)),
  }
}

// --repeat>1 时每臂聚合：保留全部样本，标量字段归并（thinkingChars/textChars 给 min/mean/max，
// status/error 去重）。此前循环每轮直接覆盖 arms 只留最后一次，多打的样本纯烧配额——本次修复。
// runs===1 时保持旧标量形状，证据文件向后兼容。
function aggregateArm(samples) {
  if (samples.length === 1) return { runs: 1, ...samples[0], samples }
  const stat = (f) => {
    const vs = samples.map(f)
    return { min: Math.min(...vs), mean: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10, max: Math.max(...vs) }
  }
  const statuses = [...new Set(samples.map((s) => s.status))]
  const errors = [...new Set(samples.filter((s) => s.error).map((s) => JSON.stringify(s.error)))].map((s) => JSON.parse(s))
  return {
    runs: samples.length,
    status: statuses.length === 1 ? statuses[0] : statuses,
    thinkingChars: stat((s) => s.thinkingChars),
    textChars: stat((s) => s.textChars),
    error: errors.length ? errors : null,
    samples,
  }
}

function fmtArm(a) {
  if (a.runs === 1) {
    return `http=${a.status} blocks=${JSON.stringify(a.blockTypes)} thinking=${a.thinkingChars}${a.error ? ` ${JSON.stringify(a.error)}` : ''}`
  }
  return `http=${JSON.stringify(a.status)} ×${a.runs} thinking=min ${a.thinkingChars.min}/mean ${a.thinkingChars.mean}/max ${a.thinkingChars.max}${a.error ? ` errors=${JSON.stringify(a.error)}` : ''}`
}

const report = []
const FROM = argOf('--from', null)
if (FROM) {
  // 复用既有证据（探一次、写多次）：不再打上游，只做 emit/write。
  const ev = JSON.parse(readFileSync(FROM, 'utf8'))
  report.push(...(ev.models ?? []))
  console.log(`复用证据 ${FROM}（${report.length} 个模型，本次不打上游）`)
} else {
  const ARM_DEFS = FULL_MATRIX
    ? [
        ['baseline', undefined],
        ['enabled', { type: 'enabled', budget_tokens: 2048 }],
        ['disabled', { type: 'disabled' }],
      ]
    : [
        ['baseline', undefined],
        ['enabled', { type: 'enabled', budget_tokens: 2048 }],
      ]
  console.log(
    `${FULL_MATRIX ? '全矩阵' : '省额度（默认）'}：${MODELS.length} 模型 × ${ARM_DEFS.length} 臂 × ${REPEAT} repeat = ${MODELS.length * ARM_DEFS.length * REPEAT} 次上游调用` +
      (FULL_MATRIX ? '' : '（disabled 臂不跑；需要 off 结论请加 --full-matrix）'),
  )
  for (const model of MODELS) {
    const arms = {}
    for (const [name, thinking] of ARM_DEFS) {
      const samples = []
      for (let i = 0; i < REPEAT; i++) samples.push(await call(model, thinking))
      arms[name] = aggregateArm(samples)
    }
    const { baseline, enabled, disabled } = arms
    const thinksByDefault = baseline.samples.some((s) => s.thinkingChars > 0 || s.blockTypes.includes('thinking'))
    const acceptsEnabled = enabled.samples.every((s) => s.status === 200)
    // off 只在 full-matrix 实测 disabled 后才能下结论；省额度模式记 null（未测），不臆造（踩坑 #42）。
    const offAccepted = disabled
      ? disabled.samples.every((s) => s.status === 200) && Math.max(...disabled.samples.map((s) => s.thinkingChars)) === 0
      : null
    // 档位表：接受 enabled 才谈档位；off 只在 disabled 实测被接受时给（未测不给）。
    const table = acceptsEnabled
      ? { ...(offAccepted ? { off: null } : {}), ...Object.fromEntries(LEVELS.map((l) => [l, l])) }
      : null
    report.push({ model, mode: FULL_MATRIX ? 'full-matrix' : 'eco', thinksByDefault, acceptsEnabled, offAccepted, table, arms })
    const verdict = !acceptsEnabled
      ? 'ENABLED-REJECTED（不出档）'
      : offAccepted === null
        ? 'OK（off 未测：省额度默认不跑 disabled 臂，--full-matrix 可证 off）'
        : offAccepted ? 'OK（含 off）' : 'OK（无 off：上游拒 disabled）'
    console.log(`\n### ${model} → ${verdict}`)
    console.log(`  baseline : ${fmtArm(baseline)}`)
    console.log(`  enabled  : ${fmtArm(enabled)}`)
    if (disabled) console.log(`  disabled : ${fmtArm(disabled)}`)
    console.log(`  → reasoningEfforts: ${table ? JSON.stringify(table) : '（不出）'}`)
  }
}

if (EMIT) {
  console.log('\n--- 可粘贴的声明（按模型填进 profile patch 的对应条目）---')
  for (const r of report) {
    if (!r.table) { console.log(`# ${r.model}: 不出档（上游拒 enabled）`); continue }
    console.log(`# ${r.model}${r.offAccepted === null ? '（off 未测：省额度默认不测 disabled；--full-matrix 可证 off）' : ''}`)
    console.log('reasoningEfforts:')
    for (const [k, v] of Object.entries(r.table)) console.log(v === null ? `  ${k}: null` : `  ${k}: ${v}`)
  }
}

if (WRITE) {
  const doc = YAML.parseDocument(readFileSync(WRITE, 'utf8'))
  const entry = (doc.contents?.items ?? []).find((it) => it.get?.('id') === 'llm-pi-ai')
  const providers = entry?.get?.('config')?.get?.('providers')
  const volces = providers?.get?.('volces')
  const models = volces?.get?.('models')
  if (!models?.items) {
    console.error(`写入失败：${WRITE} 里找不到 llm-pi-ai.config.providers.volces.models`)
    process.exit(1)
  }
  let changed = 0
  for (const r of report) {
    if (!r.table) continue
    const item = models.items.find((m) => m.get?.('id') === r.model)
    if (!item) { console.log(`  跳过 ${r.model}（patch 里没有这个模型条目）`); continue }
    let table = r.table
    if (r.offAccepted === null) {
      // off 未测（省额度默认）：patch 里已有 off 档（此前 --full-matrix 实测写入）则保留，不臆造也不抹掉。
      // 注意 yaml 的 map.get() 对 `off: null` 返回 undefined（`?? undefined` 把 null 归并了），
      // 不能用 get 读；要从 Pair 原始节点读值。
      const prev = item.get?.('reasoningEfforts')
      const offPair = prev?.items?.find?.((it) => (isScalar(it.key) ? it.key.value : it.key) === 'off')
      if (offPair) {
        table = { off: isScalar(offPair.value) ? offPair.value.value : offPair.value, ...table }
        console.log(`  ${r.model}: 保留既有 off 档（本次未测 disabled 臂）`)
      }
    }
    item.set('reasoningEfforts', table)
    changed += 1
  }
  if (!changed) { console.error('没有任何条目被更新（模型 id 对不上？）'); process.exit(1) }
  copyFileSync(WRITE, `${WRITE}.pre-ark-probe.bak`)
  writeFileSync(WRITE, String(doc))
  console.log(`\n已写入 ${changed} 个模型的 reasoningEfforts → ${WRITE}（备份 ${WRITE}.pre-ark-probe.bak）`)
  console.log('生效：重启 dsh / 桌面应用（profile patch 属启动期加载）。')
}

mkdirSync('docs/probes', { recursive: true })
const out = `docs/probes/ark-thinking-${Date.now()}.json`
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), endpoint: ENDPOINT, mode: FULL_MATRIX ? 'full-matrix' : 'eco', repeat: REPEAT, levels: LEVELS, prompt: PROMPT, models: report }, null, 2))
console.log('\n证据 →', out)
