#!/usr/bin/env node
/**
 * verify-net-discipline.mjs — 上游调用与设置路由的**成本/护栏纪律**静态闸门（0.23.0）。
 *
 * 背景：一次审计发现 17 处上游 `fetch` 从来没带 abort——额度、目录、OAuth
 * 轮询/刷新、上报全靠 undici 默认的「响应头 300s」。于是「上游连上不回应」
 * 会把模型同步/额度刷新挂五分钟，而 OAuth 轮询循环的 deadline 检查永远走不到
 * （它卡在 await 里）。本闸门把三条纪律变成机器可判：
 *
 *   [1] 上游 fetch 必须带超时/abort：改用 core/fetch-guard.js 的
 *       `fetchWithTimeout`（按面分类超时），或在调用处显式传 `signal`
 *       （网关转发 inbound abort 的既有形态）。豁免须写 `// no-timeout: 理由`。
 *   [2] 设置路由的入站护栏必须在：body 上限 + 413、aborted/error 收口、
 *       sendJSON 幂等（已应答/已销毁连接不重复写 ⇒ 不再有
 *       ERR_HTTP_HEADERS_SENT 打死宿主进程的路径）。
 *   [3] 登录态与网关运行态走结构化字段：三个额度快照带 `unauth`，settingsView
 *       带 `mirror` 台账与 `bridge.state`。
 *
 * 零网络、零凭据。跑法：node scripts/verify-net-discipline.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0
let fail = 0
const ok = (desc, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n[${t}]`)
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// 只审「宿主半」的出货代码；scripts/ 是探针/回归（允许自由 fetch），
// lib/client.js 走自己的 fetchWithTimeout（浏览器半，由 verify-client-logic 锁）。
const hostFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.js'], { cwd: ROOT, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('scripts/') && !f.startsWith('docs/') && f !== 'lib/client.js')

const CALL = /\bfetch\s*\(/
const EXEMPT = /\/\/\s*no-timeout:\s*\S/

section('1. 上游 fetch 一律带超时/abort（按面分类，豁免须注明理由）')
{
  const offenders = []
  for (const file of hostFiles) {
    const lines = read(file).split('\n')
    lines.forEach((line, i) => {
      if (!CALL.test(line)) return
      if (/fetchWithTimeout/.test(line)) return // 走 core/fetch-guard 的封装
      if (/async fetch\(request/.test(line)) return // 适配器方法形参，不是调用
      if (EXEMPT.test(line) || EXEMPT.test(lines[i - 1] ?? '')) return
      // 调用的选项块里出现 signal（显式绑定）即视为已受控。
      const window = lines.slice(Math.max(0, i - 3), i + 25).join('\n')
      if (/\bsignal\b/.test(window)) return
      offenders.push(`${file}:${i + 1}`)
    })
  }
  ok('无「裸 fetch」调用点', offenders.length === 0, offenders.join(' '))
  ok('core/fetch-guard.js 提供分类超时', /FETCH_TIMEOUTS/.test(read('core/fetch-guard.js')))
  // 迁移面：三个通道的额度/目录/登录路径都必须走封装，不能靠"信号碰巧在附近"。
  for (const [file, label] of [
    ['providers/codebuddy/catalog.js', 'CodeBuddy 目录/额度'],
    ['providers/codebuddy/oauth.js', 'CodeBuddy OAuth'],
    ['providers/qoder/oauth.js', 'Qoder OAuth'],
    ['providers/trae/oauth.js', 'Trae OAuth'],
  ]) {
    ok(`${label} 走 fetchWithTimeout`, /fetchWithTimeout/.test(read(file)))
  }
  for (const [file, cls] of [
    ['providers/codebuddy/catalog.js', 'catalog'],
    ['providers/codebuddy/catalog.js', 'quota'],
    ['providers/codebuddy/oauth.js', 'oauth'],
    ['providers/qoder/oauth.js', 'oauth'],
    ['providers/trae/oauth.js', 'oauth'],
  ]) {
    ok(`${file} 使用 ${cls} 档超时`, new RegExp(`FETCH_TIMEOUTS\\.${cls}\\b`).test(read(file)))
  }
}

section('2. 设置路由入站护栏（0.24.0 起在 core/http-surface.js，路由只声明上限）')
{
  // 0.25.0 起设置路由在 host/settings/route.js：扫宿主半拼接源，不假设落点。
  // 组合根源码 = index.js + host/**（core/providers 各自有专项闸门）
  const host = hostFiles.filter((f) => f === 'index.js' || f.startsWith('host/')).map((f) => read(f)).join('\n')
  const surface = read('core/http-surface.js')
  ok('body 上限常量存在（1MiB）', /MAX_SETTINGS_BODY_BYTES\s*=\s*1024\s*\*\s*1024/.test(host))
  ok('路由改用共享 readBody', /readBody\(request,\s*response/.test(host))
  ok('超限答 413（不静默 reset）', /sendJSON\(res,\s*413/.test(host) && /code:\s*'body_too_large'/.test(surface))
  ok('aborted/error 收口', /req\.on\('aborted'/.test(surface) && /req\.on\('error'/.test(surface))
  ok('超限先排空再应答（立刻 end 会被 RST 抹掉 413）',
    /OVERSIZE_GRACE_MS/.test(surface) && /answerOversize/.test(surface))
  ok('sendJSON 幂等守卫（writableEnded/destroyed/headersSent）',
    /writableEnded\s*\|\|\s*res\.destroyed\s*\|\|\s*res\.headersSent/.test(surface))
  ok('副作用先于响应（applyLive 在 reply 之前）',
    /applyLive\(\)\s*\n\s*reply\(/.test(host))
  ok('已应答后的错误只记日志，不再二次写响应',
    /settings handler error after response/.test(host))
  ok('唯一的 sendJSON 定义（在 core，index.js 不再有）',
    (surface.match(/export function sendJSON\(/g) || []).length === 1
    && (host.match(/function sendJSON\(/g) || []).length === 0)
}

section('3. 结构化状态：unauth / mirror / bridge.state')
{
  for (const file of ['providers/codebuddy/catalog.js', 'providers/trae/quota.js', 'providers/qoder/quota.js']) {
    ok(`${file} 未登录回传 unauth 布尔`, /unauth:\s*true/.test(read(file)))
  }
  // 组合根源码 = index.js + host/**（core/providers 各自有专项闸门）
  const host = hostFiles.filter((f) => f === 'index.js' || f.startsWith('host/')).map((f) => read(f)).join('\n')
  ok('settingsView 带 mirror 台账', /mirror:\s*readMirrorState\(\)/.test(host))
  ok('镜像结果记账（成功/失败两条路）', /mirrorState\[channel\]/.test(host) && /ok:\s*false/.test(host))
  ok('三通道 bridge.state 由 bridgeStateOf 产出',
    (host.match(/state:\s*bridgeStateOf\(/g) || []).length === 3)
  const view = read('quota-view.js')
  ok('quota-view 优先结构化 unauth', /snap\.unauth\s*===\s*true/.test(view))
}

console.log(`\n=== verify-net-discipline: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
