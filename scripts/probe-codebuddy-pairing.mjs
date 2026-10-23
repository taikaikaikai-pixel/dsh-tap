#!/usr/bin/env node
/**
 * probe-codebuddy-pairing.mjs — CodeBuddy 网关「工具史配对 / 坏历史」实测探针。
 *
 * 目的（docs/research-eco-comparison.md §4 P0-1）：外部生态（workbuddy2api-hub
 * 的 README）自述 CodeBuddy 上游有 `11148` 工具史坏历史错误、并为它做"工具调用
 * 配对自愈"——**本仓库从未复现过该码**。按踩坑 #22（外部/逆向自述不是协议真相）
 * 与 #41（单变量差分）纪律，本探针用同一段工具环只切一个变量，实测
 * copilot.tencent.com 对「孤儿 tool 消息」与「content 不可见」两种坏体的真实反应：
 *
 *   - 复现 11148 / 任何配对类拒绝 → CodeBuddy 侧确需 providers/tool-pairing.js 的
 *     体检（桥接入即修此面）；
 *   - 全臂 200 且无带内错误 → 当前网关宽容，桥接入属**防御性**（良构历史 no-op）。
 *
 * 关键纪律：本探针**故意发未修复的坏体**。桥接入体检后不会再发出这种体，要复现
 * 网关自己的拒绝面必须绕过桥直连上游——这正是"网关到底拒不拒"的唯一判据。
 * 对照臂 A（合法工具环、content 全为 ''）就是"修复后"的形态，A vs B–F 即差分；
 * 正例臂 G/H 把 B/E 的坏体喂给**桥里那条真实的** sanitizeToolPairing 再发一次，
 * 把"坏体被拒 → 修复体通过"的因果链闭合（不是手写一个像样的体自证）。
 *
 * 臂（预注册判定见 EXPECT）：
 *   A_baseline_empty   合法工具环、assistant/tool content 均为 ""      （对照臂）
 *   B_orphan_tool      孤儿 tool（无前置 assistant.tool_calls）        （#39 形态）
 *   C_assistant_null   assistant content:null + tool_calls + 结果      （#41 主因形态）
 *   D_tool_null        assistant content:"" + tool_calls + 结果 null   （#41 载体形态）
 *   E_missing_result   assistant 声明 tool_call 但无结果、紧接 user    （配对缺口）
 *   F_missing_key      assistant/tool 的 content **键缺失**            （#41 缺键形态）
 *   G_repaired_orphan  B 的坏体经 **真实修复件** providers/tool-pairing.js
 *                      sanitizeToolPairing 处理后（正例臂：坏体 → 修复体 → 200）
 *   H_repaired_missing E 的坏体经同一修复件处理后（正例臂）
 *
 * 纪律：单账号（凭据按 env → ~/.dsh/.credentials.yaml → ~/.dsh/codebuddy-plugin-auth.json
 * 取第一个可用者）、间隔 ≥1500ms（--interval 低于此值被抬回，不接受更密的发问）、
 * max_tokens 压到最小、只发回答本问题所必需的请求（该问题只有 chat 面能回答，
 * 故这里必须 POST——不是可以走只读端点却偷懒发 chat）。
 *
 * 证据落盘：docs/probes/codebuddy-pairing-<YYYY-MM-DD>.json（含预注册 expect 与判定；
 * 令牌永不落盘，只记凭据来源与长度）。
 *
 * 用法：
 *   node scripts/probe-codebuddy-pairing.mjs
 *   node scripts/probe-codebuddy-pairing.mjs --models deepseek-v4-pro
 *   node scripts/probe-codebuddy-pairing.mjs --interval 2000 --out docs/probes/xxx.json
 *
 * 原因出口（踩坑 #67：发现空结果必须配原因，不许静默返回空）：
 *   - 无可用凭据        → 打印 SKIP 原因 + 写证据 + exit 1
 *   - 网关不可达        → 打印网络错误原文 + 写证据 + exit 1
 *   - 凭据被上游拒绝    → 打印 HTTP 401/403 原文 + 写证据 + exit 1
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_HEADERS } from '../providers/codebuddy/headers.js'
import { sanitizeToolPairing } from '../providers/tool-pairing.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = 'https://copilot.tencent.com'
const CHAT_PATH = '/v2/chat/completions'
const MIN_INTERVAL_MS = 1500

const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const INTERVAL = Math.max(MIN_INTERVAL_MS, Number(argValue('--interval') ?? MIN_INTERVAL_MS) || MIN_INTERVAL_MS)
const OUT = argValue('--out') ?? join(ROOT, 'docs', 'probes', `codebuddy-pairing-${new Date().toISOString().slice(0, 10)}.json`)
const MODELS = (argValue('--models') ?? 'deepseek-v4-pro,glm-5.3-flash').split(',').map((s) => s.trim()).filter(Boolean)

/** 预注册预期（跑前写死，跑后逐条判定命中/推翻；判定逻辑见 summarize()）。 */
const EXPECT = {
  P1: 'A_baseline_empty（合法工具环、content 全 ""）→ HTTP 200 且无带内错误（对照臂必须绿，否则本探针的差分无意义）',
  P2: 'B_orphan_tool（孤儿 tool）→ 复现外部自述的 11148 或任何配对类拒绝文案；若 200 → 当前网关对孤儿 tool 宽容，11148 属外部自述未复现',
  P3: 'C_assistant_null / F_missing_key（assistant content 不可见）→ 与 B 同面：拒绝则证明 #41 主因在 CodeBuddy 同样成立，200 则不成立',
  P4: 'D_tool_null（仅 tool 结果 content 不可见）→ 拒否面独立于 C（#41 记录 tool 自身 null 有另一条报错文案）',
  P5: 'E_missing_result（tool_call 无结果）→ 拒否面独立于孤儿面（配对缺口的另一半）',
  P6: '外部自述码表里的 6004/402 不属本课题（冷却/计费面），本探针不为其背书；只记实测出现的码',
  P7: 'G_repaired_orphan / H_repaired_missing（B/E 的坏体经真实 sanitizeToolPairing 处理后）→ 200：证明接入桥的修复件确实消除 11148，而不只是"看着像能修"',
}

// ── 工具环素材：所有臂共用同一个工具声明与同一条 tool_call id 语义，唯一变量
//    就是被切的那个字段（#41 的单变量差分纪律）。
const TOOL = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: 'Return the current time for a timezone.',
    parameters: { type: 'object', properties: { tz: { type: 'string' } }, required: [] },
  },
}
const toolCall = (id) => ({
  id,
  type: 'function',
  function: { name: 'get_current_time', arguments: '{"tz":"UTC"}' },
})

/** 坏体素材：每条只改一个变量，其余逐字节相同。 */
const MSG = {
  baselineEmpty: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: '', tool_calls: [toolCall('call_probe_1')] },
    { role: 'tool', tool_call_id: 'call_probe_1', content: '12:00' },
  ],
  orphanTool: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'tool', tool_call_id: 'call_probe_1', name: 'get_current_time', content: '12:00' },
  ],
  assistantNull: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: null, tool_calls: [toolCall('call_probe_1')] },
    { role: 'tool', tool_call_id: 'call_probe_1', content: '12:00' },
  ],
  toolNull: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: '', tool_calls: [toolCall('call_probe_1')] },
    { role: 'tool', tool_call_id: 'call_probe_1', content: null },
  ],
  missingResult: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', content: '', tool_calls: [toolCall('call_probe_1')] },
    { role: 'user', content: '算了，直接回答。' },
  ],
  missingKey: () => [
    { role: 'user', content: '现在几点？' },
    { role: 'assistant', tool_calls: [toolCall('call_probe_1')] },
    { role: 'tool', tool_call_id: 'call_probe_1' },
  ],
}

/** 走桥里那条**真实**修复路径（providers/tool-pairing.js），不是手写近似体。 */
const repaired = (messages) => sanitizeToolPairing(messages).messages

const ARMS = [
  { arm: 'A_baseline_empty', note: '对照臂 = 修复后形态（合法工具环，content 全 ""）', messages: MSG.baselineEmpty },
  { arm: 'B_orphan_tool', note: '孤儿 tool（#39：宿主丢 assistant、留 toolResult）', messages: MSG.orphanTool },
  { arm: 'C_assistant_null', note: '#41 主因：assistant content:null 载体', messages: MSG.assistantNull },
  { arm: 'D_tool_null', note: '#41 载体形态：tool 结果 content:null', messages: MSG.toolNull },
  { arm: 'E_missing_result', note: '配对缺口：tool_call 无结果，紧接 user', messages: MSG.missingResult },
  { arm: 'F_missing_key', note: '#41 缺键形态：assistant/tool 的 content 键缺失', messages: MSG.missingKey },
  { arm: 'G_repaired_orphan', note: '正例臂：B 的坏体经真实 sanitizeToolPairing 修复', messages: () => repaired(MSG.orphanTool()) },
  { arm: 'H_repaired_missing', note: '正例臂：E 的坏体经真实 sanitizeToolPairing 修复', messages: () => repaired(MSG.missingResult()) },
]

/**
 * 凭据解析（与插件同序）：env → .credentials.yaml（ck_ key）→ OAuth 令牌库。
 * 只返回来源与令牌，令牌永不落盘/打印。
 */
function loadCredential() {
  if (process.env.CODEBUDDY_API_KEY) {
    return { kind: 'env:CODEBUDDY_API_KEY', token: process.env.CODEBUDDY_API_KEY }
  }
  const credFile = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return { kind: 'file:~/.dsh/.credentials.yaml', token: m[1] }
  }
  const authFile = join(homedir(), '.dsh', 'codebuddy-plugin-auth.json')
  if (existsSync(authFile)) {
    try {
      const a = JSON.parse(readFileSync(authFile, 'utf8'))
      const t = a?.auth?.accessToken
      if (typeof t === 'string' && t) return { kind: 'file:~/.dsh/codebuddy-plugin-auth.json (oauth)', token: t }
    } catch { /* 落到原因出口 */ }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 判定一条响应/错误文案是否属"工具配对"拒绝面。 */
const PAIRING_TEXT = /tool_calls?|tool result|tool_call_id|tool id|preceding message|pairing|配对/i

/**
 * 单臂单发：流式聚合 + 抓带内错误码。返回可落盘的证据对象（不含令牌）。
 * 非 SSE 响应（JSON 错误体）也解析，避免把"HTTP 200 + JSON 错误信封"记成成功。
 */
async function probeArm(model, arm, token) {
  const started = Date.now()
  const body = {
    model,
    messages: arm.messages(),
    tools: [TOOL],
    max_tokens: 32,
    stream: true,
  }
  let res
  try {
    res = await fetch(`${BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { arm: arm.arm, note: arm.note, networkError: `network: ${err.message}`, ms: Date.now() - started }
  }
  const ctype = res.headers.get('content-type') ?? ''
  if (!res.ok || !ctype.includes('text/event-stream')) {
    const text = await res.text().catch(() => '')
    let code = null
    let msg = null
    try {
      const j = JSON.parse(text)
      code = j?.code ?? j?.error?.code ?? null
      msg = j?.msg ?? j?.message ?? j?.error?.message ?? null
    } catch { /* 非 JSON：原文入 msg */ }
    return {
      arm: arm.arm,
      note: arm.note,
      http: res.status,
      code,
      msg: (msg ?? text).slice(0, 300),
      ms: Date.now() - started,
    }
  }
  // SSE：抓带内错误帧 + 收尾统计
  let buf = ''
  let code = null
  let msg = null
  let finish = null
  let contentChars = 0
  let chunks = 0
  const dec = new TextDecoder()
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let j
        try { j = JSON.parse(payload) } catch { continue }
        chunks++
        if (j.error || (j.code != null && j.code !== 0)) {
          code = j.code ?? j.error?.code ?? code
          msg = j.msg ?? j.message ?? j.error?.message ?? msg
        }
        const ch = j.choices?.[0]
        if (ch?.delta?.content) contentChars += ch.delta.content.length
        if (ch?.finish_reason) finish = ch.finish_reason
      }
    }
  } catch {
    // 部分流也是证据（网络中断时保留已抓到的帧）
  }
  return { arm: arm.arm, note: arm.note, http: res.status, code, msg: msg ? String(msg).slice(0, 300) : null, finish, contentChars, chunks, ms: Date.now() - started }
}

/** 汇总判定：预注册 expect 的命中/推翻 + 是否复现 11148。 */
function summarize(arms) {
  const bad = arms.filter((a) => a.networkError || a.code != null || (a.http ?? 200) >= 400 || PAIRING_TEXT.test(a.msg ?? ''))
  // 按臂名取**所有模型的**同名臂（多模型时不能只留最后一个：判定要覆盖每个模型）
  const at = (name) => arms.filter((a) => a.arm === name)
  const allOk = (list) => list.length > 0 && list.every((a) => !a.networkError && a.code == null && (a.http ?? 200) < 400)
  const code11148 = arms.filter((a) => a.code === 11148)
  const pairingRejected = bad.filter((a) => PAIRING_TEXT.test(a.msg ?? '') || a.code === 11148)
  const baselineArms = at('A_baseline_empty')
  const baselineOk = allOk(baselineArms)
  const repairedArms = [...at('G_repaired_orphan'), ...at('H_repaired_missing')]
  const repairedControlOk = allOk(repairedArms)
  return {
    baselineOk,
    repairedControlOk,
    repairedControlArms: repairedArms.map((a) => `${a.arm}@${a.model}: HTTP ${a.http}${a.code != null ? ` code=${a.code}` : ''}`),
    reproduced11148: code11148.length > 0,
    reproduced11148Arms: code11148.map((a) => `${a.arm}@${a.model ?? '?'}`),
    pairingRejectedArms: pairingRejected.map((a) => `${a.arm}@${a.model ?? '?'}`),
    otherErrorArms: bad.filter((a) => !pairingRejected.includes(a)).map((a) => `${a.arm}@${a.model ?? '?'}: ${a.code ?? a.http ?? 'net'} ${(a.msg ?? a.networkError ?? '').slice(0, 80)}`),
    conclusion: code11148.length
      ? `复现 11148（${code11148.length} 臂）——CodeBuddy 上游确会以该码拒绝坏工具史；`
        + (repairedControlOk ? '同一坏体经 sanitizeToolPairing 修复后 G/H 全 200 → 桥接入实测消除该拒绝' : '但修复后正例臂 G/H 未全绿 → 修复有效性未证（见 otherErrorArms）')
      : pairingRejected.length
        ? `未复现 11148，但出现配对类拒绝（${pairingRejected.length} 臂）——拒绝面存在、码不同`
        : baselineOk
          ? '未复现 11148：A–H 全臂未被网关拒绝 → 当前 CodeBuddy 网关对坏工具史宽容，桥接入属防御性修复'
          : '未复现 11148，且对照臂 A 未成立 → 本探针差分无效（见 otherErrorArms）',
  }
}

function writeEvidence(payload) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(payload, null, 2))
}

/** 原因出口：打印原因 + 写证据 + exit 1（绝不静默返回空结果，踩坑 #67）。 */
function reasonExit(reason, extra = {}) {
  const payload = {
    probe: 'codebuddy-pairing',
    base: BASE,
    path: CHAT_PATH,
    finishedAt: new Date().toISOString(),
    expect: EXPECT,
    ...extra,
    exit: { ok: false, reason },
  }
  writeEvidence(payload)
  console.error(`\nSKIP/FAIL: ${reason}`)
  console.error(`原因已写入证据：${OUT}`)
  process.exit(1)
}

const cred = loadCredential()
if (!cred) {
  reasonExit('no usable credential: CODEBUDDY_API_KEY (env) / ~/.dsh/.credentials.yaml / ~/.dsh/codebuddy-plugin-auth.json 全部不可用')
}

console.log(`== CodeBuddy 工具史配对探针 ==`)
console.log(`base=${BASE}${CHAT_PATH} models=${MODELS.join(',')} arms=${ARMS.length} interval=${INTERVAL}ms`)
console.log(`credential=${cred.kind} len=${cred.token.length}（令牌不落盘）\n`)

const startedAt = new Date().toISOString()
const arms = []
let unreachable = null
for (const model of MODELS) {
  for (const arm of ARMS) {
    process.stdout.write(`${model.padEnd(18)} ${arm.arm.padEnd(20)}`)
    const r = await probeArm(model, arm, cred.token)
    if (r.networkError) {
      console.log(` ✗ ${r.networkError}`)
      if (!unreachable) unreachable = r.networkError
    } else {
      const codeTxt = r.code != null ? ` code=${r.code}` : ''
      const msgTxt = r.msg ? ` ⚠${r.msg}` : ''
      console.log(` HTTP ${r.http}${codeTxt} finish=${r.finish ?? '-'} content=${r.contentChars ?? '-'} ${r.ms}ms${msgTxt}`)
    }
    arms.push({ model, ...r })
    await sleep(INTERVAL)
  }
}

const verdict = summarize(arms)
const credentialRejected = arms.length > 0 && arms.every((a) => a.http === 401 || a.http === 403)
const allNetwork = arms.length > 0 && arms.every((a) => a.networkError)

if (allNetwork || (unreachable && arms.every((a) => a.networkError))) {
  reasonExit(`gateway unreachable: ${unreachable}`, { startedAt, credential: { kind: cred.kind, len: cred.token.length }, intervalMs: INTERVAL, models: MODELS, arms })
}
if (credentialRejected) {
  reasonExit(`credential rejected by upstream (HTTP 401/403 on every arm)`, { startedAt, credential: { kind: cred.kind, len: cred.token.length }, intervalMs: INTERVAL, models: MODELS, arms })
}

console.log(`\n判定：`)
console.log(`  对照臂 A（合法工具环）：${verdict.baselineOk ? '绿（差分有效）' : '未成立（差分无效，先看 otherErrorArms）'}`)
console.log(`  11148 复现：${verdict.reproduced11148 ? `是 → ${verdict.reproduced11148Arms.join(', ')}` : '否'}`)
console.log(`  修复正例臂 G/H（真实 sanitizeToolPairing）：${verdict.repairedControlOk ? '全绿' : '未全绿'}`)
console.log(`  配对类拒绝：${verdict.pairingRejectedArms.length ? verdict.pairingRejectedArms.join(', ') : '无'}`)
if (verdict.otherErrorArms.length) console.log(`  其他错误：${verdict.otherErrorArms.join(' | ')}`)
console.log(`  结论：${verdict.conclusion}`)

writeEvidence({
  probe: 'codebuddy-pairing',
  base: BASE,
  path: CHAT_PATH,
  startedAt,
  finishedAt: new Date().toISOString(),
  credential: { kind: cred.kind, len: cred.token.length },
  intervalMs: INTERVAL,
  models: MODELS,
  expect: EXPECT,
  arms,
  verdict,
  exit: { ok: true },
})
console.log(`\n证据落盘：${OUT}（${arms.length} 臂）`)
