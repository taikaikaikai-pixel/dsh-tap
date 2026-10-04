#!/usr/bin/env node
/**
 * probe-trae-thinking-scene.mjs — G3：找能把 thinking 置 enabled 的 scene/参数组合。
 *
 * 背景（docs/diagnosis-trae-3003.md 2026-10-04 补记 + gateway-facts Trae 节）：
 * inline_chat 面把 thinking 置 disabled、模型默认档 high ⇒ 组合非法恒 3003；
 * chat_v3 请求体没有 effort/thinking 字段。而官方客户端 bundle
 *（@byted-icube/solo-lite 551.*.mjs / ai-modules-chat index.mjs）证实：
 * 官方在 remote 通道消息体的 `custom_model` 对象里携带 `reasoning_effort`
 *（旧名 `reasoning_effort_level` 由版本门切换），取值来自逐模型档位存储
 * `AI.agent.model.reasoning_effort_level_by_agent_model_v2`。
 *
 * 本探针分两段（真实上游，小额）：
 *   P1 remote 通道（chat_sessions）：baseline / custom_model.reasoning_effort ∈
 *      {light, high, extra_high} × --repeat 采样，看 reasoning_content 是否响应档位
 *      （踩坑 #42：多臂多采样，DIRECTION-CONSISTENT 才算数）。
 *   P2 raw 面（llm_utils_chat）场景/字段枚举（单发）：thinking:{type:enabled} /
 *      thinking_enable:true / scene_params 内嵌 effort / function=solo_agent_lite
 *      带 effort ——任一臂出 reasoning_content 即候选。
 *
 * 用法：node scripts/probe-trae-thinking-scene.mjs [--model glm-5.3] [--repeat 2]
 *       [--skip-p2]
 * 证据 → docs/probes/trae-thinking-scene-<ts>.json（不含令牌）
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import {
  buildChatRequest, createTraeStreamParser,
  TRAE_APP_ID, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE,
} from '../providers/trae/gateway.js'
import {
  createRemoteSession, openRemoteEvents,
  stopRemoteSession, createRemoteEventParser,
} from '../providers/trae/remote.js'
import { readJson } from '../core/json-store.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const SETTINGS = {
  traeAuthBaseURL: process.env.TRAE_AUTH_BASE ?? 'https://api.trae.cn',
  traeChatBaseURL: process.env.TRAE_CHAT_BASE ?? 'https://trae-api-cn.mchost.guru',
  traeLoginHost: process.env.TRAE_LOGIN_HOST ?? 'https://www.trae.cn',
}

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt
}
const MODEL = argOf('--model', 'glm-5.3')
const REPEAT = Number(argOf('--repeat', '2')) || 2
const SKIP_P2 = args.includes('--skip-p2')
const PROMPT = '一个笼子里有鸡和兔共 10 只，脚共 28 只。鸡兔各几只？只给最终数字。'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: () => {} })
const cred = await oauth.resolveTraeCredential(SETTINGS)
if (!cred) {
  console.error('未登录 Trae（先跑 node scripts/probe-trae-live.mjs --login）')
  process.exit(2)
}
const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
const authStore = readJson(AUTH_PATH)

// ---------------------------------------------------------------------------
// P1：remote 通道，custom_model.reasoning_effort（官方 bundle 证实的线缆字段）

async function remoteArm(label, level) {
  let sessionId = null
  let messageId = null
  const out = { arm: label, level: level ?? null }
  try {
    // 走生产路径（createRemoteSession 内部 = buildRemoteCreateBody + custom_model
    // 注入）——门控证据必须覆盖实际出站的代码路径，不手搭信封。
    const created = await createRemoteSession(SETTINGS.traeChatBaseURL, token, MODEL, [{ role: 'user', content: PROMPT }], { reasoningEffort: level })
    sessionId = created.sessionId
    messageId = created.messageId
    out.createHttp = 200
    const evResp = await openRemoteEvents(SETTINGS.traeChatBaseURL, token, sessionId, messageId)
    const raw = await evResp.text()
    out.eventsHttp = evResp.status
    const parser = createRemoteEventParser()
    let reasoning = ''
    let visible = ''
    let lastEventName = null
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) { lastEventName = null; continue }
      if (s.startsWith('event:')) { lastEventName = s.slice(6).trim(); continue }
      if (s.startsWith('id:') || s.startsWith(':')) continue
      if (!s.startsWith('data:')) continue
      const dataStr = s.slice(5).trim()
      if (!dataStr) continue
      if (dataStr === '[DONE]') { parser.handle('done', {}); continue }
      let chunk
      try { chunk = JSON.parse(dataStr) } catch { continue }
      const ev = parser.handle(lastEventName, chunk)
      if (ev.error) out.error = JSON.stringify(ev.error).slice(0, 200)
      if (typeof ev.reasoning === 'string') reasoning += ev.reasoning
      if (typeof ev.text === 'string') visible += ev.text
    }
    out.reasoningChars = reasoning.length
    out.textChars = visible.length
    out.actualModel = parser.actualModel()
    out.usage = parser.usage()
    out.bytes = raw.length
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 200)
  } finally {
    if (sessionId) await stopRemoteSession(SETTINGS.traeChatBaseURL, token, sessionId, messageId)
  }
  return out
}

// ---------------------------------------------------------------------------
// P2：raw 面（llm_utils_chat）scene/字段枚举（单发）

async function rawArm(label, { fn, extraBody }) {
  const payload = {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: PROMPT }],
  }
  const { body, requestId } = buildChatRequest(payload, 'probe-thinking-scene')
  if (fn) body.function = fn
  Object.assign(body, extraBody ?? {})
  const out = { arm: label, function: body.function }
  try {
    const res = await fetch(`${SETTINGS.traeChatBaseURL}/api/agent/v3/llm_utils_chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Cloud-IDE-JWT ${token}`,
        'X-Cloudide-Token': token,
        'x-ide-token': token,
        'x-app-id': TRAE_APP_ID,
        'x-ide-version': TRAE_IDE_VERSION,
        'x-ide-version-code': TRAE_IDE_VERSION_CODE,
        'x-request-id': requestId,
        ...(authStore.account?.uid ? { 'x-uid': String(authStore.account.uid) } : {}),
        ...(authStore.device?.deviceId ? { 'x-device-id': authStore.device.deviceId } : {}),
        ...(authStore.device?.machineId ? { 'x-machine-id': authStore.device.machineId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const raw = await res.text()
    out.http = res.status
    const parser = createTraeStreamParser()
    let reasoning = ''
    let visible = ''
    let lastEventName = null
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) { lastEventName = null; continue }
      if (s.startsWith('event:')) { lastEventName = s.slice(6).trim(); continue }
      if (!s.startsWith('data:')) continue
      const dataStr = s.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(dataStr) } catch { continue }
      const ev = parser.handle(lastEventName, chunk)
      if (ev.error) out.inband = JSON.stringify(ev.error).slice(0, 200)
      if (typeof ev.reasoning === 'string') reasoning += ev.reasoning
      if (typeof ev.text === 'string') visible += ev.text
    }
    out.reasoningChars = reasoning.length
    out.textChars = visible.length
    out.providerModel = parser.providerModel()
    out.rawHead = raw.slice(0, 400)
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 200)
  }
  return out
}

// ---------------------------------------------------------------------------

console.log(`model=${MODEL} repeat=${REPEAT} skipP2=${SKIP_P2}`)
const evidence = { at: new Date().toISOString(), model: MODEL, repeat: REPEAT, prompt: PROMPT, p1: [], p2: [] }

console.log('== P1 remote custom_model.reasoning_effort ==')
const LEVELS = ['light', 'high', 'extra_high']
for (let i = 0; i < REPEAT; i++) {
  evidence.p1.push(await remoteArm(`baseline#${i + 1}`, undefined))
  console.log(`  baseline#${i + 1} done`)
  for (const level of LEVELS) {
    evidence.p1.push(await remoteArm(`${level}#${i + 1}`, level))
    console.log(`  ${level}#${i + 1} done`)
    await sleep(3000) // remote 无 4011 但有排队/并发门，节奏克制
  }
}

console.log('\narm                 create  events  reasoning  text  actualModel           error')
for (const a of evidence.p1) {
  console.log(`${a.arm.padEnd(18)} ${String(a.createHttp ?? '-').padStart(6)} ${String(a.eventsHttp ?? '-').padStart(7)} ${String(a.reasoningChars ?? '-').padStart(9)} ${String(a.textChars ?? '-').padStart(5)}  ${String(a.actualModel ?? '-').padEnd(20)} ${(a.error ?? '').slice(0, 60)}`)
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const baseVals = evidence.p1.filter((a) => a.level === null && a.reasoningChars != null).map((a) => a.reasoningChars)
const baseMean = mean(baseVals)
console.log(`\nbaseline reasoning 均值 ${Math.round(baseMean)}（n=${baseVals.length}）`)
evidence.verdicts = {}
for (const level of LEVELS) {
  const vals = evidence.p1.filter((a) => a.level === level && a.reasoningChars != null).map((a) => a.reasoningChars)
  const m = mean(vals)
  const verdict = vals.length && (vals.every((v) => v > baseMean) || vals.every((v) => v < baseMean)) ? 'DIRECTION-CONSISTENT' : 'INCONCLUSIVE'
  evidence.verdicts[level] = { vals, mean: Math.round(m), verdict }
  console.log(`  ${level.padEnd(10)} 均值 ${String(Math.round(m)).padStart(6)} 各次 ${JSON.stringify(vals)} → ${verdict}`)
}

if (!SKIP_P2) {
  console.log('\n== P2 raw 面 scene/字段枚举（单发）==')
  const p2Arms = [
    ['inline+thinking.type=enabled', { fn: 'inline_chat', extraBody: { thinking: { type: 'enabled' } } }],
    ['inline+thinking_enable', { fn: 'inline_chat', extraBody: { thinking_enable: true } }],
    ['inline+scene_params.effort', { fn: 'inline_chat', extraBody: { scene_params: JSON.stringify({ reasoning_effort: 'light' }) } }],
    ['solo_agent_lite+effort', { fn: 'solo_agent_lite', extraBody: { reasoning_effort: 'light' } }],
    ['chat_v3+effort', { fn: 'chat_v3', extraBody: { reasoning_effort: 'light' } }],
  ]
  for (const [label, opts] of p2Arms) {
    evidence.p2.push(await rawArm(label, opts))
    console.log(`  ${label} done`)
    await sleep(20_000) // raw 面 4011 紧：联调间隔 ≥20s
  }
  console.log('\narm                          fn                http  reasoning  text  providerModel         inband/error')
  for (const a of evidence.p2) {
    console.log(`${a.arm.padEnd(28)} ${String(a.function ?? '-').padEnd(16)} ${String(a.http ?? '-').padStart(5)} ${String(a.reasoningChars ?? '-').padStart(9)} ${String(a.textChars ?? '-').padStart(5)}  ${String(a.providerModel ?? '-').padEnd(20)} ${((a.inband ?? a.error) ?? '').slice(0, 60)}`)
  }
}

mkdirSync('docs/probes', { recursive: true })
const outPath = `docs/probes/trae-thinking-scene-${Date.now()}.json`
writeFileSync(outPath, JSON.stringify(evidence, null, 2))
console.log('\n证据 →', outPath)
console.log('判读纪律：P1 DIRECTION-CONSISTENT 才说明档位**可能**被线上承认；P2 任一臂出 reasoning_content 即候选 scene。INCONCLUSIVE 不改出站（#42）。')
