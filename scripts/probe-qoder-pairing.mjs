#!/usr/bin/env node
/**
 * Qoder CN — tool 配对不变量差分实验（踩坑 #39 复发调查）
 *
 * --offline  用宿主真实序列化器（@earendil-works/pi-ai convertMessages）跑 8 种
 *            真实会话形态 → 打印出站 messages 序列 → 用严格校验器判违规 →
 *            再判 sanitizeToolPairing 修复后是否仍违规（不花额度）。
 * --live     把 offline 产出的**真实报文**打到真实上游严格模型家族：
 *            direct = 绕过修复（阳性对照），gw = 经本机 :3903 生产网关（含修复）。
 *
 * 用法：
 *   node scripts/probe-qoder-pairing.mjs --offline
 *   node scripts/probe-qoder-pairing.mjs --live --model dmodel
 *   node scripts/probe-qoder-pairing.mjs --live --gw-port 3903
 * 证据落 docs/probes/qoder-pairing-<ts>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'qoder-plugin-auth.json')
const PROBES_DIR = join(ROOT, 'docs', 'probes')
const INFER = process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn'
const PI_AI = process.env.PI_AI_PATH
  ?? 'C:/Users/<user>/dev/dsh-launcher/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'

const args = process.argv.slice(2)
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const LIVE = args.includes('--live')
const LIVE_MODEL = val('--model', 'dmodel')
const GW_PORT = Number(val('--gw-port', '3903'))

const { sanitizeToolPairing } = await import('../providers/tool-pairing.js')
const { convertMessages } = await import(pathToFileURL(PI_AI).href)

// ── 宿主侧真实 model 对象（settings.yaml llm-pi-ai.providers.qoder 的投影）──
// 注意 reasoning:false——现网 qoder 模型条目**不声明** reasoning，故 pi-ai 把 system
// prompt 序列化成 role:"system"（若为 true 会变 role:"developer"，那是另一条独立
// 故障：上游在反序列化阶段整请求拒绝，见 probe-qoder-null-content.mjs 的 E 组）。
const MODEL = {
  id: LIVE_MODEL, name: 'probe', provider: 'qoder', api: 'openai-completions',
  baseUrl: `http://127.0.0.1:${GW_PORT}/v1`, reasoning: false,
  input: ['text', 'image'], contextWindow: 200000, maxTokens: 32768,
}
const TOOLS = [{
  type: 'function', function: {
    name: 'read', description: '读文件',
    parameters: { type: 'object', properties: { f: { type: 'number' } }, required: ['f'] },
  },
}]
const sysPrompt = 'You are a coding agent. Use tools when helpful.'

/**
 * pi-ai detectCompat() 对本 provider 的解析结果（provider="qoder" 不在任何
 * isNonStandard 名单里、baseUrl 是回环地址 → 判定为"标准 OpenAI 面"）。
 * getCompat 未导出，这里按 detectCompat 源码逐字段复刻（openai-completions.js
 * :1234-1318），保证 offline 重放与宿主真实出站一致。
 */
const COMPAT = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: 'max_completion_tokens',
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: 'openai',
  openRouterRouting: {},
  vercelGatewayRouting: {},
  chatTemplateKwargs: {},
  chatTemplateArgs: {},
  zaiToolStream: false,
  supportsThinkingTokenBudget: false,
  thinkingTokenBudgetField: undefined,
  supportsStrictMode: true,
  supportsOpenAIGrammarTools: false,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: false,
  deferredToolsMode: undefined,
  sessionAffinityFormat: 'openai',
  supportsLongCacheRetention: true,
}

const tc = (id, name, a) => ({ type: 'toolCall', id, name, arguments: a })
const asst = (content, stopReason) => ({
  role: 'assistant', content, stopReason, provider: MODEL.provider, api: MODEL.api, model: MODEL.id,
})
const tr = (toolCallId, toolName, text) => ({
  role: 'toolResult', toolCallId, toolName, isError: false,
  content: [{ type: 'text', text }], timestamp: Date.now(),
})
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** 8 种 dsh 真实可能产生的历史形态。 */
const TRANSCRIPTS = {
  normal_tool_round: [
    user('读一下文件'),
    asst([tc('call_A', 'read', { f: 1 })], 'tool_calls'),
    tr('call_A', 'read', 'file content'),
    asst([{ type: 'text', text: '内容如上' }], 'stop'),
  ],
  aborted_carrier: [
    user('读一下文件'),
    asst([{ type: 'thinking', thinking: '我要读文件' }, tc('call_B', 'read', { f: 2 })], 'aborted'),
    tr('call_B', 'read', 'b content'),
    user('继续'),
  ],
  error_carrier: [
    user('读一下文件'),
    asst([tc('call_E', 'read', { f: 5 })], 'error'),
    tr('call_E', 'read', 'e content'),
    user('再来'),
  ],
  mixed_multi_turn: [
    user('step1'),
    asst([tc('call_A', 'read', { f: 1 })], 'tool_calls'),
    tr('call_A', 'read', 'ok'),
    asst([tc('call_B', 'read', { f: 2 })], 'aborted'),
    tr('call_B', 'read', 'ran anyway'),
    asst([tc('call_C', 'read', { f: 3 })], 'tool_calls'),
    tr('call_C', 'read', 'hits'),
    asst([{ type: 'text', text: '完成' }], 'stop'),
    user('next'),
  ],
  parallel_partial: [
    user('parallel'),
    asst([tc('call_A', 'read', { f: 1 }), tc('call_B', 'read', { f: 2 })], 'tool_calls'),
    tr('call_A', 'read', 'only A'),
    user('换个问题'),
  ],
  aborted_no_result: [
    user('x'), asst([tc('call_B', 'read', { f: 1 })], 'aborted'), user('重来'),
  ],
  two_aborted_carriers: [
    user('x'),
    asst([tc('call_B', 'read', { f: 1 })], 'aborted'), tr('call_B', 'read', 'b'),
    asst([tc('call_C', 'read', { f: 2 })], 'aborted'), tr('call_C', 'read', 'c'),
    user('继续'),
  ],
  duplicate_result: [
    user('x'),
    asst([tc('call_B', 'read', { f: 1 })], 'aborted'), tr('call_B', 'read', 'first'), tr('call_B', 'read', 'second'),
    user('继续'),
  ],
}

/**
 * 严格校验器（模拟上游 OpenAI 兼容面那条规则的最严读法）
 *   flat          : role:tool 的 id 必须出现在更早某条 assistant.tool_calls
 *   strict-group  : 且必须紧跟声明它的 assistant，该 assistant 的每个 call 都要有结果
 */
function validate(messages, mode) {
  const problems = []
  const seen = new Set()
  let open = null
  const close = (i) => {
    if (open) {
      for (const id of open.ids) if (!open.answered.has(id)) problems.push(`L${i}: tool_call ${id} 声明了却无结果`)
      open = null
    }
  }
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      close(i)
      const ids = (m.tool_calls ?? []).map((c) => c.id)
      for (const id of ids) seen.add(id)
      if (ids.length) open = { ids: new Set(ids), answered: new Set() }
      return
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id
      if (!seen.has(id)) problems.push(`L${i}: 孤儿 tool ${id}（更早历史没有声明它的 assistant）`)
      else if (mode === 'strict-group' && (!open || !open.ids.has(id))) problems.push(`L${i}: tool ${id} 未紧跟声明它的 assistant`)
      if (open?.ids.has(id)) open.answered.add(id)
      return
    }
    close(i)
  })
  close(messages.length)
  return problems
}

const seq = (ms) => ms.map((m) => (m.role === 'assistant'
  ? `assistant${(m.tool_calls ?? []).length ? `[${m.tool_calls.map((c) => c.id).join('+')}]` : ''}`
  : m.role === 'tool' ? `tool[${m.tool_call_id}]` : m.role)).join(' ')

const evidence = { ts: new Date().toISOString(), piAi: PI_AI, model: MODEL, gwPort: GW_PORT, cases: [] }
const built = {}

for (const [name, messages] of Object.entries(TRANSCRIPTS)) {
  const params = convertMessages(MODEL, { systemPrompt: sysPrompt, tools: TOOLS, messages }, COMPAT, {}) ?? []
  const pair = sanitizeToolPairing(params)
  const before = { flat: validate(params, 'flat'), group: validate(params, 'strict-group') }
  const after = { flat: validate(pair.messages, 'flat'), group: validate(pair.messages, 'strict-group') }
  built[name] = { raw: params, fixed: pair.messages }
  evidence.cases.push({ name, sequenceBefore: seq(params), sequenceAfter: seq(pair.messages), repaired: pair.repaired, violationsBefore: before, violationsAfter: after, stillBroken: after.flat.length + after.group.length > 0, rawMessages: params, fixedMessages: pair.messages })
  console.log(`\n### ${name}`)
  console.log('  出站序列  :', seq(params))
  console.log('  修复后序列:', seq(pair.messages), JSON.stringify(pair.repaired))
  console.log('  修复前违规:', before.flat.length ? before.flat : 'none')
  console.log('  修复后违规:', after.flat.length || after.group.length ? { ...after } : 'none', after.flat.length + after.group.length > 0 ? '  <<< 仍有违规' : '')
}
console.log(`\n总计 ${evidence.cases.length} 形态，修复后仍违规 ${evidence.cases.filter((c) => c.stillBroken).length}`)

if (!LIVE) {
  mkdirSync(PROBES_DIR, { recursive: true })
  const out = join(PROBES_DIR, `qoder-pairing-${Date.now()}.json`)
  writeFileSync(out, JSON.stringify(evidence, null, 2))
  console.log('证据 →', out)
  process.exit(0)
}

// ══════════════════ LIVE：真实上游（严格模型家族）══════════════════
const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const store = readJson(AUTH_PATH)
const cred = { accessToken: store?.auth?.accessToken, machineId: store?.machine?.machineId, uid: store?.account?.uid }
if (!cred.accessToken) { console.error('未登录：先跑 scripts/probe-qoder-live.mjs --login'); process.exit(1) }

const wrap = (messages, extra = {}) => ({ model: LIVE_MODEL, stream: true, stream_options: { include_usage: true }, messages, tools: TOOLS, tool_choice: 'auto', ...extra })

function record(label, note, status, raw) {
  const flat = raw.replace(/\\{2,}"$/gm, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const errHit = flat.match(/\{"code":"provider_error".{0,300}/) ?? flat.match(/\{"code":"\d+","message":"\[FAIL\][^"]{0,200}"/) ?? flat.match(/"error":\s*\{[^{}]{0,300}/)
  const hasText = /"content":"[^"]/.test(flat)
  const done = raw.includes('[DONE]')
  const verdict = errHit ? `ERROR ${errHit[0].slice(0, 180)}` : (hasText ? 'OK 有正文' : (done ? 'OK 空正文(有 DONE)' : '?? 无正文无 DONE'))
  console.log(`  ${label.padEnd(36)} ${status} → ${verdict}${note ? `   [${note}]` : ''}`)
  evidence.live.push({ label, note, status, verdict, errHit: errHit?.[0] ?? null, raw: raw.slice(0, 8000) })
}

/** 直连签名：绕过生产网关的修复（阳性对照）。 */
async function direct(label, bodyObj, note) {
  const signed = await cosy.prepareChat(cred, { endpoint: INFER, body: JSON.stringify(bodyObj), modelKey: LIVE_MODEL, modelSource: 'system' })
  const r = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: signed.body })
  record(label, note, `HTTP ${r.status}`, await r.text())
}

/** 经生产网关 :3903（含 sanitizeToolPairing + 归因信封）。 */
async function gw(label, bodyObj, note) {
  try {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
    })
    record(label, note, `HTTP ${r.status}`, await r.text())
    return true
  } catch (e) {
    console.log(`  ${label.padEnd(36)} 网关 :${GW_PORT} 不可用（${e.message}）——该例跳过`)
    evidence.live.push({ label, note, skipped: String(e.message) })
    return false
  }
}

evidence.live = []
console.log(`\n──────── LIVE model=${LIVE_MODEL} 网关=:${GW_PORT} ────────`)

// A. 阳性对照：同一份坏体，直连（不修）应当 400
await direct('A1_raw_orphan_direct', wrap(built.aborted_carrier.raw), 'pi-ai 裸出站（孤儿 tool）')
await direct('A2_raw_two_orphans_direct', wrap(built.two_aborted_carriers.raw), '两条连续孤儿 tool')

// B. 生产路径：同一份坏体经网关（修复后应当 200）
await gw('B1_gateway_aborted_carrier', wrap(built.aborted_carrier.raw), '网关修复孤儿→补桩')
await gw('B2_gateway_mixed_multi_turn', wrap(built.mixed_multi_turn.raw), '多轮混合（孤儿夹在合法环中）')
await gw('B3_gateway_two_aborted', wrap(built.two_aborted_carriers.raw), '连续两孤儿')
await gw('B4_gateway_dup_result', wrap(built.duplicate_result.raw), '同 id 重复结果')
await gw('B5_gateway_normal_round', wrap(built.normal_tool_round.raw), '对照：本就合法')

// C. 修复桩形态直连（我们补出来的东西严格上游收不收）
await direct('C1_stub_content_null', wrap([{ role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_s1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_s1', content: '(tool result unavailable: previous attempt was interrupted)' }]), '桩：assistant content:null')
await direct('C2_stub_content_empty', wrap([{ role: 'user', content: '读文件' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_s2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_s2', content: '(unavailable)' }]), '桩：assistant content:""')
await direct('C3_valid_pair', wrap([{ role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_ok', type: 'function', function: { name: 'read', arguments: '{"f":1}' } }] },
  { role: 'tool', tool_call_id: 'call_ok', content: 'file body' }]), '对照：合法工具环')
// D. 顺序读法：orphan 桩插在"合法环中间"后，前一条 tool 的结果被推到最后
await direct('D1_group_order_edge', wrap([
  { role: 'user', content: 'q' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'read', arguments: '{"f":1}' } }] },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_B', content: 'B 的结果' },
  { role: 'tool', tool_call_id: 'call_A', content: 'A 的结果' },
]), 'assistant[A] assistant[B] tool[B] tool[A]（A 的结果不在紧跟组内）')
// E. developer 角色（pi-ai 对 reasoning 模型把 system 序列化成 developer）
await direct('E1_developer_role', wrap([{ role: 'developer', content: '你是编码助手' }, { role: 'user', content: '只回复：收到' }]), 'role:developer 是否被接受')
await direct('E2_system_role', wrap([{ role: 'system', content: '你是编码助手' }, { role: 'user', content: '只回复：收到' }]), 'role:system 对照')
// F. 只有 assistant.tool_calls 没结果 / tool 结果无 tools 数组
await direct('F1_calls_without_result', wrap([{ role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_Z', type: 'function', function: { name: 'read', arguments: '{}' } }] }]), 'tool_calls 缺结果')
await direct('F2_pair_without_tools_array', { model: LIVE_MODEL, stream: true, stream_options: { include_usage: true }, messages: [
  { role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_Y', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_Y', content: 'body' }] }, '合法配对但请求不带 tools 数组')

mkdirSync(PROBES_DIR, { recursive: true })
const outLive = join(PROBES_DIR, `qoder-pairing-${Date.now()}.json`)
writeFileSync(outLive, JSON.stringify(evidence, null, 2))
console.log('\n证据 →', outLive)
process.exit(0)
