#!/usr/bin/env node
/**
 * probe-trae-agent-v3.mjs — Trae agent 面（llm_utils_chat 的 agent_v3 function 家族）
 * 真实凭据探针（M1：证据先于代码）。
 *
 * 背景（docs/diagnosis-trae-3003.md §12 + 本 goal 立项）：inline_chat 面 3003 已
 * 6 周未愈（scene 级故障），remote 面（chat_sessions）架构性拒绝 OpenAI tools
 * （remote-no-tools）。社区两个独立实现（dsh-connect-trae / Trae2api-cn）主张
 * llm_utils_chat 存在「agent 用法」：接受 OpenAI 风格 tools、返回结构化
 * tool_calls、工具由调用端本地执行。按踩坑 #22，一切以本探针实测为准。
 *
 * 臂位（≥6，expect 预注册；--arms 子集跑）：
 *   A1 纯聊天（无 tools）                    —— 决策门臂 1
 *   A2 tools + tool_choice=auto（提示触发工具）—— 决策门臂 2 前置
 *   A3 两轮工具闭环（assistant tool_calls + role:tool 回传 → 最终回答）—— 决策门臂 2
 *   A4 并行调用提示（期望 0..N 个 tool_calls，如实记录）
 *   A5 reasoning_effort 字段注入（对照 A2 同工具；记录是否被忽略/拒绝）
 *   E1 错模型名（不存在的模型 id）
 *   E2 坏参数形态（temperature 字符串）
 *   Q  额度差分观测（payload 级提示，默认跳过）：A1 前后各读一次
 *      ide_user_ent_usage，比对 IDE 池 used 增量（<0.01 分辨率不可见则如实记录）
 *
 * 用法：
 *   node scripts/probe-trae-agent-v3.mjs [--fn agent_chat] [--model glm-5.3]
 *     [--arms A1,A2,A3] [--sweep] [--quota] [--raw]
 *   --sweep：只跑 FN_SWEEP 候选 function 名扫描（每候选一发 A1 形态，间隔 3s），
 *     用于定位「agent 用法」的真实 function 值（2001=no function config 即否决）。
 * 决策门（goal 明文）：A1 与 A3 任一失败（含 3003）→ 停止实装，goal 以前提被证伪
 *   收束。脚本报答案在末尾 GATE 行给出。
 *
 * 纪律：臂间隔 ≥2s（raw 面历史 4011 限流阈 20s 的保守化：本探针臂数少、并发恒 1）；
 * 单账号（~/.dsh/trae-plugin-auth.json）；写操作为零（除 Q 臂只读额度接口）；
 * 证据落 docs/probes/trae-agent-v3-<date>.jsonl；token 永不落盘（JSONL 无凭据字段）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { buildChatRequest, traeOutboundHeaders } from '../providers/trae/gateway.js'
import { readJson } from '../core/json-store.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const FN = argOf('--fn', 'solo_work_lite')
const MODEL = argOf('--model', 'glm-5.3')
const ARMS = new Set(argOf('--arms', 'A1,A2,A3,A4,A5,E1,E2').split(',').map((s) => s.trim()))
const WITH_QUOTA = args.includes('--quota')
const DUMP_RAW = args.includes('--raw')
const SWEEP = args.includes('--sweep')
const SWEEP2 = args.includes('--sweep2')
const SWEEP_MODELS = args.includes('--sweep-models')
// function 位候选扫描清单（--sweep）：2001=no function config 即否决该名字。
// 依据：历史实测 inline_chat/chat_v3/solo_agent_lite/solo_work_lite 均注册
// （docs/reverse/trae-cloud-api.md §5.1）；社区实现主张的 agent 用法 function 名
// 未公开钉死（踩坑 #22：以实测为准）。
const FN_SWEEP = ['agent_chat', 'agent_v3', 'solo_agent_chat', 'agent', 'chat', 'solo_agent', 'assistant_chat']
// sweep 第二轮（--sweep2）：chat 是注册 function（4023=模型未知而非 2001=function 未注册），
// 对它补目录真实模型名 + tools 两发，判定「chat 即 agent 用法」假设。
const FN_SWEEP2 = ['chat', 'chat_v3']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const MCHOST = 'https://trae-api-cn.mchost.guru'
const SETTINGS = { traeAuthBaseURL: 'https://api.trae.cn', traeChatBaseURL: MCHOST, traeLoginHost: 'https://www.trae.cn' }

const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: () => { /* 探针不写回 */ } })
const cred = await oauth.resolveTraeCredential(SETTINGS)
if (!cred) { console.error('未登录 Trae（先跑 node scripts/probe-trae-live.mjs --login）'); process.exit(2) }
const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
const authStore = readJson(AUTH_PATH)
const device = authStore.device ?? {}
const uid = String(authStore.account?.uid ?? '')
const ideHeaders = (requestId) => ({
  ...traeOutboundHeaders(device, uid ? Number(uid) : undefined, requestId),
  Authorization: `Cloud-IDE-JWT ${token}`,
  'X-Cloudide-Token': token,
})

// ---------------------------------------------------------------------------
// SSE 帧摘要（原文可选 --raw 落盘；默认只落结构化摘要，token 与长文本不进证据）

function summarizeSse(raw) {
  const events = []
  let lastEvt = null
  for (const l of raw.split('\n')) {
    const t = l.trim()
    if (!t) continue
    if (t.startsWith('event:')) { lastEvt = t.slice(6).trim(); continue }
    if (!t.startsWith('data:')) continue
    const data = t.slice(5).trim()
    if (data === '[DONE]') { events.push({ ev: lastEvt ?? null, done: true }); continue }
    let j
    try { j = JSON.parse(data) } catch { events.push({ ev: lastEvt ?? null, nonJson: data.slice(0, 80) }); continue }
    const ev = (typeof j.event === 'string' && j.event) ? j.event : lastEvt
    const rec = { ev: ev ?? null }
    if (j.code != null) rec.code = j.code
    if (typeof j.message === 'string') rec.message = j.message.slice(0, 200)
    if (typeof j.provider_model_name === 'string') rec.providerModel = j.provider_model_name
    if (typeof j.response === 'string') rec.responseLen = j.response.length
    if (typeof j.reasoning_content === 'string') rec.reasoningLen = j.reasoning_content.length
    if (Array.isArray(j.tool_calls)) rec.toolCalls = j.tool_calls.map((c) => ({
      index: c.index, id: c.id, hasFnCall: Boolean(c.function_call), hasFn: Boolean(c.function),
      name: c.function_call?.name ?? c.function?.name,
      argsLen: String(c.function_call?.arguments ?? c.function?.arguments ?? '').length,
    }))
    if (j.tool_call_info && typeof j.tool_call_info === 'object') {
      rec.toolCallInfo = { name: j.tool_call_info.name, id: j.tool_call_info.tool_call_id ?? j.tool_call_info.id }
    }
    if (j.finish_reason) rec.finish = j.finish_reason
    // token_usage 事件形态（dsh-connect-trae sse.ts 全字段表）：顶层即计数
    if (ev === 'token_usage') {
      rec.usage = {
        prompt_tokens: j.prompt_tokens, completion_tokens: j.completion_tokens,
        total_tokens: j.total_tokens, reasoning_tokens: j.reasoning_tokens,
        cache_read_input_tokens: j.cache_read_input_tokens,
      }
    }
    events.push(rec)
  }
  return events
}

/** 从摘要重建可见文本（response 为累计快照时取最后一帧）。 */
function finalTextOf(events) {
  let t = ''
  for (const e of events) if (typeof e.responseLen === 'number') t = e // 只取长度不足以重建文本；真值由 --raw 提供
  return null // 摘要模式不重建文本（文本含模型输出，证据只记长度与事件形态）
}

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function postLlmUtilsChat(payload, { fn, fnKey, timeoutMs = 120_000 } = {}) {
  const { body, requestId } = buildChatRequest(payload, `agentv3-${Date.now().toString(36)}`, { fnKey })
  body.function = fn
  const t0 = Date.now()
  const resp = await fetch(`${MCHOST}/api/agent/v3/llm_utils_chat`, {
    method: 'POST',
    headers: ideHeaders(requestId),
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await resp.text()
  return { status: resp.status, raw, ms: Date.now() - t0, sentBody: body }
}

const TOOL_GET_TIME = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: '获取当前时间。当用户询问时间、日期时必须调用。',
    parameters: { type: 'object', properties: {} },
  },
}

// expect 预注册（跑前钉死，跑后对照）
const EXPECT = {
  A1: '若 function 有效：HTTP 200 + SSE 文本事件 + done；若 fn 未知：响亮错误（码入证据）',
  A2: '接受 tools 不 400；若支持工具则出 tool_calls 事件或文本回答',
  A3: '第二轮（带 role:tool）不报错且产出最终文本回答',
  A4: '并行提示：0..N 个 tool_calls（如实记录，N≥2 即证实并行）',
  A5: 'reasoning_effort 被接受（不报错）或被忽略（行为同 A2）；若 400 则证实该面拒此字段',
  E1: '错模型名：业务错误码（预期 3003/4001/4011 家族之一）',
  E2: '坏参数：HTTP 4xx 或 SSE error（预期 4001 unmarshal 家族）',
}

const arms = []

async function runArm(label, fn, payload, { expect, fnKey, timeoutMs } = {}) {
  const out = { arm: label, fn, expect, at: new Date().toISOString() }
  try {
    const r = await postLlmUtilsChat(payload, { fn, fnKey, timeoutMs })
    out.http = r.status
    out.ms = r.ms
    out.sentBodyShape = {
      model: r.sentBody.model, function: r.sentBody.function,
      messages: r.sentBody.messages.length,
      roles: r.sentBody.messages.map((m) => m.role),
      assistantToolCallKey: r.sentBody.messages.find((m) => m.role === 'assistant')?.tool_calls?.[0]
        ? Object.keys(r.sentBody.messages.find((m) => m.role === 'assistant').tool_calls[0]).join('+') : null,
      tools: Array.isArray(r.sentBody.tools) ? r.sentBody.tools.length : 0,
      tool_choice: r.sentBody.tool_choice ?? null,
      reasoning_effort: r.sentBody.reasoning_effort ?? null,
    }
    const events = summarizeSse(r.raw)
    out.sseBytes = r.raw.length
    out.eventCount = events.length
    out.errors = events.filter((e) => e.code != null).slice(0, 3)
    out.finishReasons = [...new Set(events.map((e) => e.finish ?? e.stopReason).filter(Boolean))]
    out.providerModels = [...new Set(events.map((e) => e.providerModel).filter(Boolean))]
    out.toolCallEvents = events.filter((e) => e.toolCalls || e.toolCallInfo).slice(0, 6)
    out.maxResponseLen = Math.max(0, ...events.map((e) => e.responseLen ?? 0))
    out.usage = events.map((e) => e.usage).filter(Boolean).at(-1) ?? null
    out.eventNames = [...new Set(events.map((e) => e.ev).filter(Boolean))]
    if (DUMP_RAW) out.rawSse = r.raw.slice(0, 20_000)
    out.ok = out.http === 200 && out.errors.length === 0
  } catch (err) {
    out.ok = false
    out.error = String(err?.message ?? err).slice(0, 300)
  }
  arms.push(out)
  console.log(`[${label}] http=${out.http ?? '-'} ok=${out.ok} events=${out.eventCount ?? 0} errors=${JSON.stringify(out.errors ?? out.error ?? null)}`)
  return out
}

// ---------------------------------------------------------------------------

console.log(`fn=${FN} model=${MODEL} arms=${[...ARMS].join(',')}${SWEEP ? ' SWEEP=' + FN_SWEEP.join('/') : ''}`)
console.log('expect（预注册）:', JSON.stringify(EXPECT))

if (SWEEP) {
  for (const fn of FN_SWEEP) {
    await runArm(`sweep:${fn}`, fn, {
      model: MODEL, stream: true,
      messages: [{ role: 'user', content: '只回复两个字：成功' }],
    }, { expect: 'function 名注册判定：2001=no function config 即否决', timeoutMs: 60_000 })
    await sleep(3_000)
  }
  const date0 = new Date().toISOString().slice(0, 10)
  const sweepPath = join(process.cwd(), 'docs/probes', `trae-agent-v3-fnsweep-${date0}.jsonl`)
  mkdirSync(dirname(sweepPath), { recursive: true })
  writeFileSync(sweepPath, arms.map((a) => JSON.stringify(a)).join('\n') + '\n')
  console.log(`证据 → ${sweepPath}`)
  process.exit(0)
}

let quotaBefore = null
async function quotaSnapshot(tag) {
  const resp = await fetch(`${SETTINGS.traeAuthBaseURL}/trae/api/v2/pay/ide_user_ent_usage`, {
    method: 'POST',
    headers: ideHeaders(`quota-${tag}`),
    body: JSON.stringify({ require_usage: true, req_source: 0 }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await resp.json().catch(() => null)
  const packs = body?.user_entitlement_pack_list
  if (!Array.isArray(packs)) return { tag, error: `code ${body?.code ?? `http ${resp.status}`}` }
  const mk = () => ({ limit: 0, used: 0 })
  const pools = { ide: mk(), work: mk() }
  for (const p of packs) {
    const ep = p?.entitlement_base_info?.available_endpoint
    const pool = ep === 1 ? pools.work : ep === 0 ? pools.ide : null
    if (!pool) continue
    pool.limit += p?.entitlement_base_info?.quota?.credits_limit ?? 0
    pool.used += p?.usage?.credits_amount ?? 0
  }
  const r = (n) => Math.round(n * 1000) / 1000
  return { tag, ideUsed: r(pools.ide.used), ideLimit: pools.ide.limit, workUsed: r(pools.work.used), workLimit: pools.work.limit }
}

if (WITH_QUOTA) quotaBefore = await quotaSnapshot('before')

if (SWEEP2) {
  for (const fn of FN_SWEEP2) {
    await runArm(`sweep2:${fn}:plain`, fn, {
      model: MODEL, stream: true,
      messages: [{ role: 'user', content: '只回复两个字：成功' }],
    }, { expect: '已注册 function + 真实模型名：期望 200 出文本', timeoutMs: 90_000 })
    await sleep(3_000)
    await runArm(`sweep2:${fn}:tools`, fn, {
      model: MODEL, stream: true, tool_choice: 'auto',
      messages: [{ role: 'user', content: '现在几点？请调用 get_current_time 工具获取。' }],
      tools: [TOOL_GET_TIME],
    }, { expect: '带 tools：接受且出 tool_calls 即证实工具面', timeoutMs: 90_000 })
    await sleep(3_000)
  }
  const date0 = new Date().toISOString().slice(0, 10)
  const p = join(process.cwd(), 'docs/probes', `trae-agent-v3-fnsweep2-${date0}.jsonl`)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, arms.map((a) => JSON.stringify(a)).join('\n') + '\n')
  console.log(`证据 → ${p}`)
  process.exit(0)
}

if (ARMS.has('A1')) {
  await runArm('A1', FN, {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: '只回复两个字：成功' }],
  }, { expect: EXPECT.A1 })
  await sleep(2_000)
}

let a2 = null
if (ARMS.has('A2')) {
  a2 = await runArm('A2', FN, {
    model: MODEL, stream: true, tool_choice: 'auto',
    messages: [{ role: 'user', content: '现在几点？请调用 get_current_time 工具获取。' }],
    tools: [TOOL_GET_TIME],
  }, { expect: EXPECT.A2 })
  await sleep(2_000)
}

if (ARMS.has('A3')) {
  // 两轮闭环（Trae2api-cn 参照形态）：assistant 历史消息的 tool_calls 用
  // **function_call 键**（与该面 SSE 出站的 tool_calls[i].function_call 同构——
  // 2026-10-05 A3 臂实测：OpenAI 风格 function 键被 proto 层拒绝「required
  // field Name is not set」，说明该面把 function_call.Name 映射到 proto 字段）。
  // tool_calls 形态以 A2 实测为准（A2 若未出 tool_calls，则构造等价形态——
  // 该臂目的是验证「role:tool 回传被接受且产出最终回答」这一协议面）。
  const callId = a2?.toolCallEvents?.[0]?.toolCalls?.[0]?.id
    ?? a2?.toolCallEvents?.[0]?.toolCallInfo?.id
    ?? 'call_probe_time_1'
  const callName = a2?.toolCallEvents?.[0]?.toolCalls?.[0]?.name
    ?? a2?.toolCallEvents?.[0]?.toolCallInfo?.name
    ?? 'get_current_time'
  await runArm('A3', FN, {
    model: MODEL, stream: true, tool_choice: 'auto',
    messages: [
      { role: 'user', content: '现在几点？请调用 get_current_time 工具获取。' },
      { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: callName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: callId, name: callName, content: '2026-10-05 14:30:00 CST' },
    ],
    tools: [TOOL_GET_TIME],
  }, { expect: EXPECT.A3, fnKey: 'function_call' })
  await sleep(2_000)
}

if (ARMS.has('A4')) {
  await runArm('A4', FN, {
    model: MODEL, stream: true, tool_choice: 'auto',
    messages: [{ role: 'user', content: '请同时调用两次 get_current_time（并行），然后告诉我时间。' }],
    tools: [TOOL_GET_TIME],
  }, { expect: EXPECT.A4 })
  await sleep(2_000)
}

if (ARMS.has('A5')) {
  await runArm('A5', FN, {
    model: MODEL, stream: true, tool_choice: 'auto', reasoning_effort: 'high',
    messages: [{ role: 'user', content: '现在几点？请调用 get_current_time 工具获取。' }],
    tools: [TOOL_GET_TIME],
  }, { expect: EXPECT.A5 })
  await sleep(2_000)
}

if (ARMS.has('E1')) {
  await runArm('E1', FN, {
    model: 'no-such-model-agentv3-probe', stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }, { expect: EXPECT.E1 })
  await sleep(2_000)
}

if (ARMS.has('E2')) {
  await runArm('E2', FN, {
    model: MODEL, stream: true, temperature: 'hot',
    messages: [{ role: 'user', content: 'hi' }],
  }, { expect: EXPECT.E2 })
}

let quotaAfter = null
if (WITH_QUOTA) { await sleep(2_000); quotaAfter = await quotaSnapshot('after') }

// M1 轮次 A6：多模型对照（单发/模型，证明 agent 面模型路由非钉死）。
// 历史事实：raw 面「模型路由被 function 位钉死」（trae-cloud-api.md §5.1，
// solo_work_lite 恒 glm-5.2）；timing_cost.provider_model_name 是唯一真值源。
if (ARMS.has('A6')) {
  for (const m of ['kimi-k2.6', 'DeepSeek-V4-Flash']) {
    await runArm(`A6:${m}`, FN, {
      model: m, stream: true,
      messages: [{ role: 'user', content: '只回复两个字：成功' }],
    }, { expect: 'provider_model_name 跟随请求模型即证实真路由；钉死则恒 glm-5.2' })
    await sleep(2_000)
  }
}

// ---------------------------------------------------------------------------

const gate = {
  A1: arms.find((a) => a.arm === 'A1'),
  A3: arms.find((a) => a.arm === 'A3'),
}
const gatePass = (gate.A1 ? gate.A1.ok : null) && (gate.A3 ? gate.A3.ok : null)

const evidence = {
  probe: 'trae-agent-v3',
  at: new Date().toISOString(),
  fn: FN,
  model: MODEL,
  accountUidMasked: uid.slice(0, 3) + '***',
  expect: EXPECT,
  arms,
  quota: WITH_QUOTA ? {
    before: quotaBefore, after: quotaAfter,
    deltaIde: quotaBefore?.ideUsed != null && quotaAfter?.ideUsed != null ? Math.round((quotaAfter.ideUsed - quotaBefore.ideUsed) * 1000) / 1000 : null,
    deltaWork: quotaBefore?.workUsed != null && quotaAfter?.workUsed != null ? Math.round((quotaAfter.workUsed - quotaBefore.workUsed) * 1000) / 1000 : null,
  } : undefined,
  gate: gatePass == null ? 'SKIPPED（A1/A3 未跑）' : gatePass ? 'PASS（A1 与 A3 均成功）' : 'FAIL（决策门臂失败，停止实装）',
}

const date = new Date().toISOString().slice(0, 10)
const outPath = join(process.cwd(), 'docs/probes', `trae-agent-v3-${date}.jsonl`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, arms.map((a) => JSON.stringify(a)).join('\n') + '\n' + JSON.stringify({ summary: evidence.gate, quota: evidence.quota ?? null }) + '\n')
console.log(`GATE: ${evidence.gate}`)
console.log(`证据 → ${outPath}`)
