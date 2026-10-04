#!/usr/bin/env node
/**
 * probe-trae-transport-outage.mjs — inline 3003 持续故障下的主聊天出路探测。
 *
 * 背景（docs/diagnosis-trae-3003.md 2026-10-04 补记 + 用户复报「还是不能用」）：
 * inline_chat 面全臂 3003（scene thinking=disabled × 模型默认档 high，服务端行为），
 * dsh 主聊天带 agent 工具表 ⇒ 网关不自动降级；remote 面（chat_sessions）不支持
 * OpenAI tools（remote-no-tools 400）。主聊天是否两头堵，取决于 chat_v3 面对带
 * tools 请求的行为——本探针三臂各一发实测：
 *   [R]  remote 面（chat_sessions）baseline：纯文本会话当前可用性
 *   [C2] chat_v3 无 tools：信封/鉴权健康性对照（[C] 臂重试）
 *   [C3] chat_v3 + tools：**主聊天出路判定**——若正常出回答/工具调用，放开网关
 *        3003 降级的 !hasTools 限制即可救主聊天（改派模型诚实披露）
 *
 * 用法：node scripts/probe-trae-transport-outage.mjs [--model glm-5.3]
 * 纪律：raw 面臂间隔 ≥20s（4011 限流）；证据 → docs/probes/trae-transport-outage-<ts>.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { buildChatRequest, traeOutboundHeaders } from '../providers/trae/gateway.js'
import {
  createRemoteSession, openRemoteEvents, stopRemoteSession, createRemoteEventParser,
} from '../providers/trae/remote.js'
import { readJson } from '../core/json-store.js'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const MODEL = argOf('--model', 'glm-5.3')
const PROMPT = '只回复两个字：成功'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const MCHOST = 'https://trae-api-cn.mchost.guru'
const SETTINGS = { traeAuthBaseURL: 'https://api.trae.cn', traeChatBaseURL: MCHOST, traeLoginHost: 'https://www.trae.cn' }

const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: (v) => { /* 探针不写回 */ } })
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
// [R] remote 面（chat_sessions）baseline

async function remoteArm() {
  let sessionId = null
  let messageId = null
  const out = { arm: 'R', transport: 'remote(chat_sessions)' }
  const t0 = Date.now()
  try {
    const created = await createRemoteSession(MCHOST, token, MODEL, [{ role: 'user', content: PROMPT }])
    sessionId = created.sessionId
    messageId = created.messageId
    out.createHttp = 200
    const evResp = await openRemoteEvents(MCHOST, token, sessionId, messageId)
    const raw = await evResp.text()
    out.eventsHttp = evResp.status
    const parser = createRemoteEventParser()
    let visible = ''
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      if (s.startsWith('event:')) { parser.lastEventName = s.slice(6).trim(); continue }
      if (s.startsWith('id:') || s.startsWith(':')) continue
      if (!s.startsWith('data:')) continue
      const dataStr = s.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(dataStr) } catch { continue }
      const ev = parser.handle(parser.lastEventName, chunk)
      if (ev.error) out.error = JSON.stringify(ev.error).slice(0, 300)
      if (typeof ev.text === 'string') visible += ev.text
    }
    out.textChars = visible.length
    out.textHead = visible.slice(0, 40)
    out.actualModel = parser.actualModel()
    out.bytes = raw.length
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 300)
  } finally {
    if (sessionId) await stopRemoteSession(MCHOST, token, sessionId, messageId).catch(() => {})
  }
  out.ms = Date.now() - t0
  return out
}

// ---------------------------------------------------------------------------
// raw 面（llm_utils_chat）chat_v3 臂

function parseRawSse(raw) {
  const events = []
  let lastEvt = null
  for (const l of raw.split('\n')) {
    if (!l.startsWith('data:')) { if (l.trim().startsWith('event:')) lastEvt = l.trim().slice(6).trim(); continue }
    try {
      const j = JSON.parse(l.slice(5).trim())
      const evName = (typeof j.event === 'string' && j.event) ? j.event : lastEvt
      events.push({ ev: evName ?? null, code: j.code, message: j.message, providerModel: j.provider_model_name, hasToolCalls: Array.isArray(j.tool_calls) && j.tool_calls.length > 0 })
    } catch { /* 非 JSON data 忽略 */ }
  }
  return events
}

async function chatV3Arm(label, withTools) {
  const payload = { model: MODEL, stream: true, messages: [{ role: 'user', content: PROMPT }] }
  if (withTools) {
    payload.tools = [{
      type: 'function',
      function: { name: 'get_current_time', description: '获取当前时间', parameters: { type: 'object', properties: {} } },
    }]
    payload.tool_choice = 'auto'
  }
  const { body, requestId } = buildChatRequest(payload, `outage-${label}`)
  body.function = 'chat_v3'
  const out = { arm: label, fn: 'chat_v3', tools: withTools ? 1 : 0 }
  const t0 = Date.now()
  try {
    const resp = await fetch(`${MCHOST}/api/agent/v3/llm_utils_chat`, {
      method: 'POST', headers: ideHeaders(requestId), body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    })
    const raw = await resp.text()
    out.status = resp.status
    out.rawBytes = raw.length
    const events = parseRawSse(raw)
    out.errors = events.filter((e) => e.code != null && e.ev === 'error').slice(0, 2)
    out.providerModels = [...new Set(events.map((e) => e.providerModel).filter(Boolean))]
    out.hasText = events.some((e) => e.ev === 'output' || (e.message != null && !e.code))
    out.hasToolCalls = events.some((e) => e.hasToolCalls)
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 200)
  }
  out.ms = Date.now() - t0
  return out
}

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evidence = {
  at: new Date().toISOString(), model: MODEL, prompt: PROMPT,
  note: 'inline 3003 持续故障下的传输出路探测；判读见 docs/diagnosis-trae-3003.md',
  accountUidMasked: uid.slice(0, 3) + '***',
  arms: [],
}

console.log('[R] remote 面 baseline')
const r = await remoteArm()
evidence.arms.push(r)
console.log(JSON.stringify(r))

await sleep(20_000)
console.log('[C2] chat_v3 无 tools（对照）')
const c2 = await chatV3Arm('C2', false)
evidence.arms.push(c2)
console.log(JSON.stringify(c2))

await sleep(20_000)
console.log('[C3] chat_v3 + tools（主聊天出路判定）')
const c3 = await chatV3Arm('C3', true)
evidence.arms.push(c3)
console.log(JSON.stringify(c3))

const outPath = join(process.cwd(), 'docs/probes', `trae-transport-outage-${Date.now()}.json`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n')
console.log(`证据 → ${outPath}`)
