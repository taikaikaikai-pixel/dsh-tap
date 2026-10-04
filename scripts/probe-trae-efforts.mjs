#!/usr/bin/env node
/**
 * probe-trae-efforts.mjs — Trae 通道 `reasoning_effort` 方言判定（真实上游，小额）。
 *
 * 为什么需要它：Trae 路由的 `compat` 一直没开（cordis.patch.yml:369-371 注明
 * "reasoning_effort dialect unverified"），所以该通道在宿主「推理等级」里从不出档。
 * 目录（state.vscdb / 远端模型表）其实**声明了逐模型档位**
 * （`reasoning_effort_config.options`，实测 Doubao-Seed-2.1-Pro = ["light","high"]，
 * default_level "high"），只要方言可用就能同 Qoder 一样自动出档。
 *
 * 判据（踩坑 #42 纪律）：自适应思考下推理长度是非单调弱信号 ⇒ 必须**多臂多采样**，
 * 只有"每个重复都落在基线的同一侧"才判 DIRECTION-CONSISTENT；否则 INCONCLUSIVE，
 * 不下结论、不改出站。
 *
 * 用法：
 *   node scripts/probe-trae-efforts.mjs [--model <id>] [--levels light,high]
 *        [--repeat 2] [--prompt "…"]
 * 证据 → docs/probes/trae-efforts-<ts>.json（不含任何令牌）
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { buildChatRequest, createTraeStreamParser, TRAE_APP_ID, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE } from '../providers/trae/gateway.js'
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
const MODEL = argOf('--model', 'Doubao-Seed-2.1-Pro')
const LEVELS = String(argOf('--levels', 'light,high')).split(',').map((s) => s.trim()).filter(Boolean)
const REPEAT = Number(argOf('--repeat', '2')) || 2
const PROMPT = argOf('--prompt', '一个笼子里有鸡和兔共 10 只，脚共 28 只。鸡兔各几只？只给最终数字。')

const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: () => {} })
const cred = await oauth.resolveTraeCredential(SETTINGS)
if (!cred) {
  console.error('未登录 Trae（先跑 node scripts/probe-trae-live.mjs --login）')
  process.exit(2)
}
const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
const authStore = readJson(AUTH_PATH)

async function arm(label, level) {
  const payload = {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: PROMPT }],
    ...(level === undefined ? {} : { reasoning_effort: level }),
  }
  const { body, requestId } = buildChatRequest(payload, 'probe-efforts')
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
  })
  const raw = await res.text()
  const parser = createTraeStreamParser()
  let reasoning = ''
  let text = ''
  let inband = null
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const data = s.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(data) } catch { continue }
    const ev = parser.handle(null, chunk)
    if (ev.error) inband = ev.error
    if (typeof ev.reasoning === 'string') reasoning += ev.reasoning
    if (typeof ev.text === 'string') text += ev.text
  }
  const usage = parser.usage()
  return {
    arm: label,
    level: level ?? null,
    http: res.status,
    reasoningChars: reasoning.length,
    textChars: text.length,
    reasoningHead: reasoning.slice(0, 40),
    providerModel: parser.providerModel(),
    finish: parser.finish(),
    usage,
    inband,
    bytes: raw.length,
    rawHead: raw.slice(0, 700),
  }
}

console.log(`model=${MODEL} levels=${JSON.stringify(LEVELS)} repeat=${REPEAT}`)
const arms = []
for (let i = 0; i < REPEAT; i++) {
  arms.push(await arm(`baseline#${i + 1}`, undefined))
  for (const level of LEVELS) arms.push(await arm(`${level}#${i + 1}`, level))
}

console.log('\narm                 http  reasoning  text  providerModel         finish  inband')
for (const a of arms) {
  console.log(`${a.arm.padEnd(18)} ${String(a.http).padEnd(5)} ${String(a.reasoningChars).padStart(9)} ${String(a.textChars).padStart(5)}  ${String(a.providerModel ?? '-').padEnd(20)} ${String(a.finish ?? '-').padEnd(7)} ${a.inband ? JSON.stringify(a.inband).slice(0, 60) : ''}`)
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const baseVals = arms.filter((a) => a.level === null).map((a) => a.reasoningChars)
const baseMean = mean(baseVals)
console.log(`\nbaseline reasoning 均值 ${Math.round(baseMean)}（n=${baseVals.length}）`)
const verdicts = {}
for (const level of LEVELS) {
  const vals = arms.filter((a) => a.level === level).map((a) => a.reasoningChars)
  const m = mean(vals)
  const allAbove = vals.every((v) => v > baseMean)
  const allBelow = vals.every((v) => v < baseMean)
  const verdict = allAbove || allBelow ? 'DIRECTION-CONSISTENT' : 'INCONCLUSIVE'
  verdicts[level] = { vals, mean: Math.round(m), verdict }
  console.log(`  ${level.padEnd(8)} 均值 ${String(Math.round(m)).padStart(5)} 各次 ${JSON.stringify(vals)} → ${verdict}`)
}

mkdirSync('docs/probes', { recursive: true })
const out = `docs/probes/trae-efforts-${Date.now()}.json`
writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(),
  model: MODEL, levels: LEVELS, repeat: REPEAT, prompt: PROMPT,
  baselineMean: Math.round(baseMean), verdicts, arms,
}, null, 2))
console.log('\n证据 →', out)
console.log('判读纪律：DIRECTION-CONSISTENT 才说明该档位**可能**改变上游思考量；INCONCLUSIVE 不下结论（自适应非单调 + 小样本）。')
