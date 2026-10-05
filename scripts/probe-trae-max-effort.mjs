/**
 * 探测 Trae remote 通道是否接受 reasoning_effort=max 拼写。
 *
 * 目录只声明了 light/high/extra_high，但上游（trae-api-cn.mchost.guru）可能
 * 也接受 max（CodeBuddy 侧的拼写）。本脚本用本地存储的 Trae OAuth token，
 * 向 remote 会话端点发 reasoning_effort=max 的创建请求，看是否 200 + 正常事件流。
 *
 * 用法：node scripts/probe-trae-max-effort.mjs
 *   --model deepseek-v4.1-flash  （默认）
 *   --base https://trae-api-cn.mchost.guru
 *   --effort max  （可重复，默认 max + extra_high 对照）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = arr[i + 1]
    if (v && !v.startsWith('--')) { acc.push([k, v]); arr.splice(i + 1, 1) }
    else acc.push([k, 'true'])
  }
  return acc
}, []))

const MODEL = args.model || 'deepseek-v4.1-flash'
const BASE = args.base || 'https://trae-api-cn.mchost.guru'
const EFFORTS = args.effort
  ? [args.effort].flat()
  : ['max', 'extra_high'] // max = 待测；extra_high = 对照

const authPath = join(homedir(), '.dsh', 'trae-plugin-auth.json')
const authStore = JSON.parse(readFileSync(authPath, 'utf8'))
const token = authStore.auth?.accessToken
if (!token) { console.error('NO_TOKEN'); process.exit(1) }

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const headers = (stream) => ({
  Authorization: `Cloud-IDE-JWT ${token}`,
  'Content-Type': 'application/json',
  'X-Trae-Client-Type': 'web',
  'X-Preferenced-Language': 'zh-CN',
  'x-user-region': 'CN',
  Origin: 'https://solo.trae.cn',
  Referer: 'https://solo.trae.cn/',
  'User-Agent': WEB_UA,
  Accept: stream ? 'text/event-stream' : 'application/json',
})

const commonParams = JSON.stringify({
  language: 'zh-cn', app_language: 'zh-CN', quality: 'stable',
  app_version: '1.0.0.1229', web_id: '', user_identity: 'Free',
  is_freshman: '0', biz_user_id: '', user_unique_id: '',
  scope: 'marscode-cn', tenant: 'marscode', region: 'cn', aiRegion: 'cn',
  is_privacy_mode: 0, privacy_mode: 'off', solo_chat_mode: 'code',
})

function buildBody(model, effort) {
  const im = {
    chat_session_id: '', content: [],
    query: JSON.stringify([{ type: 'text', data: { content: '一个笼子里有鸡和兔共 10 只，脚共 28 只。鸡兔各几只？只给最终数字。' } }]),
    model_name: model, agent_type: 'solo_agent_remote',
    model_selection_strategy: 'manual', common_params: commonParams,
  }
  if (effort) {
    im.custom_model = {
      model_name: model, config_name: model, config_source: 1,
      is_preset: true, use_remote_service: true, multimodal: false,
      reasoning_effort: effort,
    }
  }
  return { mode: 'code', environment_id: 'default', initial_message: im, env: 'remote', auto_create_project: false, origin: 'web' }
}

async function probe(effort) {
  const label = effort || 'none(omit)'
  const t0 = Date.now()
  try {
    // 1. create session
    const createResp = await fetch(`${BASE}/api/remote/v1/chat_sessions`, {
      method: 'POST', headers: headers(false),
      body: JSON.stringify(buildBody(MODEL, effort)),
      signal: AbortSignal.timeout(20_000),
    })
    const createText = await createResp.text()
    if (createResp.status >= 400) {
      return { effort: label, createHttp: createResp.status, createBody: createText.slice(0, 300), ms: Date.now() - t0 }
    }
    let data
    try { data = JSON.parse(createText) } catch {
      return { effort: label, createHttp: createResp.status, error: 'non-json create', ms: Date.now() - t0 }
    }
    if (data.code != null && data.code !== 0 && !data.data) {
      return { effort: label, createHttp: createResp.status, bizCode: data.code, bizMsg: data.message, ms: Date.now() - t0 }
    }
    const payload = data.data ?? data
    const sessionId = String(payload.chat_session_id ?? '')
    const messageId = String(payload.message_id ?? '')
    if (!sessionId || !messageId) {
      return { effort: label, createHttp: createResp.status, error: 'missing session/message id', ms: Date.now() - t0 }
    }

    // 2. open events, read entire stream to EOF (like probe-trae-thinking-scene)
    const eventsResp = await fetch(
      `${BASE}/api/remote/v1/chat_sessions/${sessionId}/events?reply_to_message_id=${messageId}`,
      { headers: headers(true) },
    )
    if (eventsResp.status >= 400) {
      const evText = await eventsResp.text().catch(() => '')
      return { effort: label, createHttp: 200, eventsHttp: eventsResp.status, eventsBody: evText.slice(0, 300), ms: Date.now() - t0 }
    }
    const raw = await eventsResp.text()
    let reasoningChars = 0, textChars = 0, actualModel = null, finish = null, bytes = raw.length
    const eventTypes = {}
    let eventSamples = null
    let lastEventName = null
    // also capture raw SSE lines for debugging
    let rawLines = []
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) { lastEventName = null; continue }
      if (s.startsWith('event:')) { lastEventName = s.slice(6).trim(); continue }
      if (s.startsWith('id:') || s.startsWith(':')) continue
      if (!s.startsWith('data:')) continue
      const dataStr = s.slice(5).trim()
      if (!dataStr) continue
      if (dataStr === '[DONE]') { finish = finish || 'done'; continue }
      let ev
      try { ev = JSON.parse(dataStr) } catch { continue }
      // use .event field (production parser way) or SSE event: line
      const eventName = (typeof ev.event === 'string' && ev.event) ? ev.event : lastEventName
      const et = eventName || (ev.model_config ? 'model_config'
        : ev.plan_item ? 'plan_item'
        : ev.done ? 'done'
        : ev.error ? 'error'
        : 'other')
      eventTypes[et] = (eventTypes[et] || 0) + 1
      if (!eventSamples) eventSamples = []
      if (eventSamples.length < 8) eventSamples.push({ event: eventName || null, data: dataStr.slice(0, 250) })
      if (rawLines.length < 30) rawLines.push(s.slice(0, 200))
      if (eventName === 'model_config' || ev.model_config) {
        if (typeof ev.config_name === 'string') actualModel = ev.config_name
      }
      if (eventName === 'plan_item' || ev.plan_item) {
        const pi = ev.plan_item || ev
        if (typeof pi.reasoning_content === 'string') reasoningChars += pi.reasoning_content.length
        if (typeof pi.thought === 'string') textChars += pi.thought.length
        if (pi.tool_call_info?.name === 'finish') {
          finish = 'finish'
          const sp = pi.tool_call_info?.params?.summary
          if (typeof sp === 'string') textChars += sp.length
        }
      }
      if (eventName === 'done' || ev.done) finish = finish || 'done'
      if (eventName === 'error' || ev.error) { return { effort: label, createHttp: 200, eventsHttp: 200, streamError: ev.error || ev, eventTypes, eventSamples, rawLines, ms: Date.now() - t0 } }
    }
    return { effort: label, createHttp: 200, eventsHttp: 200, reasoningChars, textChars, actualModel, finish, bytes, eventTypes, eventSamples, rawLines, ms: Date.now() - t0 }
  } catch (e) {
    return { effort: label, error: e?.message ?? String(e), ms: Date.now() - t0 }
  }
}

console.log(`Trae max-effort probe: model=${MODEL} base=${BASE} efforts=${EFFORTS.join(',')}`)
const results = []
for (let i = 0; i < EFFORTS.length; i++) {
  if (i > 0) { console.log('  (waiting 10s for session slot...)'); await new Promise(r => setTimeout(r, 10_000)) }
  const r = await probe(EFFORTS[i])
  results.push(r)
  console.log(JSON.stringify(r))
}
console.log('\n--- summary ---')
for (const r of results) {
  const ok = r.createHttp === 200 && r.eventsHttp === 200 && !r.streamError && !r.error
  const verdict = ok
    ? (r.reasoningChars > 0 ? `ACCEPTED (reasoning ${r.reasoningChars} chars)` : 'ACCEPTED (no reasoning)')
    : `REJECTED (${r.error || r.bizCode || r.createHttp})`
  console.log(`  ${r.effort}: ${verdict}`)
}
