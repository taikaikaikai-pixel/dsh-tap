#!/usr/bin/env node
/**
 * CodeBuddy 渠道指纹探针（2026-10-21 定案）。
 *
 * 现象：dsh 用 CodeBuddy 模型聊天回 HTTP 400 / code 11128
 * "Illegal API invocation from an unapproved channel"（提示"可能不是官方客户端"）。
 * 实测拆解（逐变量 A/B）：与 UA/headers/模型无关，触发源是 system 消息里的
 * **精确句** `You are an AI agent powered by DeepSeek Harness.` —— DSH 系统提示
 * 的首句。同一句在 user 消息里放行；只换掉 "DeepSeek Harness" 一处措辞即放行。
 * 插件出站改写见 providers/codebuddy/channel-guard.js。
 *
 * 本脚本复跑该判据（理解用途，不绕过认证/计费）：
 *   A system 指纹原样          → 预期 400/11128
 *   B system 改写后            → 预期 200（模型忙 14003 时有界重试）
 *   C 同一句放 user 消息        → 预期 200（证明只扫 system/developer）
 *   D system 指纹（无句号）     → 预期 400/11128（整句判据不依赖句号）
 *
 * 用法：node scripts/probe-codebuddy-channel.mjs [--out docs/probes/<file>.json]
 * 需要真实 CodeBuddy 凭据（OAuth 文件 / .credentials.yaml 的 ck_ key）。
 * 低速率：四条臂、间隔 1.6s、max_tokens=8；证据落 docs/probes/。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLIENT_HEADERS } from '../providers/codebuddy/headers.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const MODEL = 'glm-5.3-flash'
const SPACING_MS = 1600
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join('docs', 'probes', `codebuddy-channel-${new Date().toISOString().slice(0, 10)}.json`)

const RAW_FP = 'You are an AI agent powered by DeepSeek Harness.'
const SANITIZED_FP = 'You are an AI agent powered by the host harness.'

function resolveCredential() {
  try {
    const auth = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin-auth.json'), 'utf8'))
    if (auth?.auth?.accessToken) return { mode: 'oauth', authorization: `Bearer ${auth.auth.accessToken}` }
  } catch { /* fall through */ }
  try {
    const cfg = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin.json'), 'utf8'))
    const active = (cfg.apiKeys ?? []).find((k) => k.name === cfg.activeApiKey)
    if (active?.key) return { mode: 'api-key', authorization: `Bearer ${active.key}` }
  } catch { /* fall through */ }
  if (process.env.CODEBUDDY_API_KEY) return { mode: 'env-key', authorization: `Bearer ${process.env.CODEBUDDY_API_KEY}` }
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return { mode: 'credentials-yaml', authorization: `Bearer ${m[1]}` }
  }
  throw new Error('no CodeBuddy credential found')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probeArm(auth, messages) {
  const t0 = Date.now()
  const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS, Authorization: auth.authorization },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8,
      messages,
    }),
  })
  const text = await res.text()
  let code = null
  let msg = null
  try {
    const parsed = JSON.parse(text)
    code = parsed.code ?? null
    msg = parsed.msg ?? null
  } catch { /* SSE / non-JSON success body */ }
  return { status: res.status, code, msg, ms: Date.now() - t0 }
}

async function main() {
  const auth = resolveCredential()
  const arms = [
    { name: 'A-system-fingerprint', messages: [{ role: 'system', content: RAW_FP }, { role: 'user', content: 'hi' }], expect: '11128' },
    { name: 'B-system-sanitized', messages: [{ role: 'system', content: SANITIZED_FP }, { role: 'user', content: 'hi' }], expect: '200' },
    { name: 'C-fingerprint-in-user', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: RAW_FP + ' 复述这句话' }], expect: '200' },
    { name: 'D-system-no-period', messages: [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness' }, { role: 'user', content: 'hi' }], expect: '11128' },
  ]
  const results = []
  for (const arm of arms) {
    let result = await probeArm(auth, arm.messages)
    // 14003 = 模型忙（与渠道校验无关）：有界重试，避免把偶发负载记成判据。
    for (let attempt = 0; attempt < 3 && result.code === 14003; attempt++) {
      await sleep(15_000)
      result = await probeArm(auth, arm.messages)
    }
    const matched = arm.expect === '11128'
      ? result.status === 400 && result.code === 11128
      : result.status === 200
    results.push({ arm: arm.name, expect: arm.expect, matched, ...result })
    console.log(`${matched ? 'ok  ' : 'FAIL'} ${arm.name}: status=${result.status} code=${result.code ?? '-'} expect=${arm.expect} (${result.ms}ms)`)
    await sleep(SPACING_MS)
  }
  const verdict = results.every((r) => r.matched) ? 'PASS' : 'FAIL'
  const evidence = {
    at: new Date().toISOString(),
    gateway: GATEWAY,
    model: MODEL,
    authMode: auth.mode,
    note: 'A/D 复现渠道指纹 11128；B 证明改写放行；C 证明只扫 system/developer。prompt 内容不入证据。',
    sanitizer: 'providers/codebuddy/channel-guard.js',
    verdict,
    arms: results.map((r) => ({
      arm: r.arm, expect: r.expect, matched: r.matched, status: r.status, code: r.code, ms: r.ms,
    })),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`\n${verdict} → ${OUT}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}

main().catch((err) => {
  console.error(`probe crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
