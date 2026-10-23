#!/usr/bin/env node
/**
 * probe-codebuddy-tier-wiring.mjs — 「思考强度」全链路**真实上游**联调。
 *
 * 分工：verify-bridge [17] 是离线 mock 回归（可随时跑）；本脚本是真实联调，
 * 证明线上真这么走，跑一次即可、不进 CI。
 *
 * 拓扑：本脚本 → 插件桥（临时 DSH_HOME，不碰用户 settings.yaml / 文件层 / 令牌）
 *       → 本地捕获代理（原样转发并记录出站体）→ https://copilot.tencent.com
 *
 * 断言（每条都有真实字节或真实响应作依据）：
 *   [1] 真实 /v3/config → model-sync 成功；model-list 的 `efforts` 档位表与
 *       目录声明一致（glm-5.3-flash/kimi-k2.8-preview = low/high/max、
 *       hy4-preview = high；legacy 模型走 patch 静态表；无表模型不出现）
 *   [2] settings.yaml 镜像（宿主 Model/Effort 选择器的数据源）带 reasoningEfforts
 *   [3] 真实 chat：捕获代理看到的出站体含被注入的 reasoning_effort，且上游 200 出正文
 *   [4] 负例：未声明档位 / 无表模型 → 出站体不带 reasoning_effort
 *
 * 用法：
 *   node scripts/probe-codebuddy-tier-wiring.mjs                 # 默认全套
 *   node scripts/probe-codebuddy-tier-wiring.mjs --skip-chat     # 只验目录/镜像接线
 *
 * 凭据：CODEBUDDY_API_KEY（env）或 ~/.dsh/.credentials.yaml（与插件同解析顺序）。
 */

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeMockCtx, disposeAll } from './lib/mock-ctx.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const UPSTREAM = 'https://copilot.tencent.com'
const argv = process.argv.slice(2)
const SKIP_CHAT = argv.includes('--skip-chat')
const OUT = join(ROOT, 'docs', 'probes', `codebuddy-tier-wiring-${new Date().toISOString().slice(0, 10)}.json`)

function loadApiKey() {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY
  const credFile = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return m[1]
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

const key = loadApiKey()
if (!key) {
  console.error('CODEBUDDY_API_KEY not found (env or ~/.dsh/.credentials.yaml)')
  process.exit(1)
}

// ------------------------------------------------------------ 隔离的运行环境
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tap-tier-'))
mkdirSync(process.env.DSH_HOME, { recursive: true })
process.env.CODEBUDDY_API_KEY = key
process.env.CODEBUDDY_BRIDGE_LOG = join(process.env.DSH_HOME, 'bridge-log.jsonl')

// ------------------------------------------------- 本地捕获代理（原样转发 + 记录）
const captured = []
const proxy = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const url = `${UPSTREAM}${req.url}`
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    let upstream
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      })
    } catch (err) {
      captured.push({ url: req.url, body, proxyError: String(err.message ?? err) })
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end('{"code":1,"msg":"proxy upstream failed"}')
      return
    }
    captured.push({
      url: req.url,
      status: upstream.status,
      body,
      reasoningEffort: (() => { try { return JSON.parse(body).reasoning_effort ?? null } catch { return null } })(),
      model: (() => { try { return JSON.parse(body).model ?? null } catch { return null } })(),
    })
    const out = {}
    for (const [k, v] of upstream.headers) if (k !== 'content-encoding' && k !== 'content-length') out[k] = v
    res.writeHead(upstream.status, out)
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
    else res.end()
  })
})

async function main() {
  const proxyPort = await freePort()
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r))
  const bridgePort = await freePort()

  const { apply } = await import(new URL('../index.js', import.meta.url).href)
  const routes = {}
  const effects = []
  const ctx = makeMockCtx({ routes, effects })
  apply(ctx, {
    baseURL: `http://127.0.0.1:${proxyPort}`,
    bridgePort,
    authMode: 'api-key',
  })
  await sleep(300)

  // 设置路由用事件发射器驱动（同 verify-bridge 的 callRoute）。
  const { EventEmitter } = await import('node:events')
  const call = (body) => new Promise((resolve, reject) => {
    const handler = routes['/dsh-tap/settings']
    if (!handler) return reject(new Error('settings route not registered'))
    const req = new EventEmitter()
    req.method = body ? 'POST' : 'GET'
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(b) { let json = null; try { json = JSON.parse(b) } catch { /* non-JSON */ } resolve({ status: this.status, json }) },
    }
    handler(req, res)
    if (body) {
      const bytes = Buffer.from(JSON.stringify(body))
      req.emit('data', bytes.subarray(0, 3))
      req.emit('data', bytes.subarray(3))
      req.emit('end')
    }
  })

  console.log(`[1] 真实目录 → 档位表（proxy :${proxyPort}，bridge :${bridgePort}）`)
  let res = await call({ action: 'model-sync' })
  check('model-sync 成功且拿到网关目录', res.json?.sync?.ok === true && res.json?.sync?.count > 20,
    JSON.stringify(res.json?.sync))
  const catalogCount = res.json?.sync?.count ?? 0

  res = await call({ action: 'model-list' })
  const listed = res.json
  const efforts = listed?.efforts ?? {}
  const expect = {
    'glm-5.3-flash': ['low', 'high', 'max'],
    'kimi-k2.8-preview': ['low', 'high', 'max'],
    'hy4-preview': ['high'],
  }
  for (const [id, tiers] of Object.entries(expect)) {
    check(`目录声明 → 档位表 ${id} = ${JSON.stringify(tiers)}`,
      JSON.stringify(efforts[id]) === JSON.stringify(tiers), JSON.stringify(efforts[id]))
  }
  check('静态 legacy 模型仍由 patch 表驱动（deepseek-v4-pro）',
    JSON.stringify(efforts['deepseek-v4-pro']) === '["low","medium","high","max"]', JSON.stringify(efforts['deepseek-v4-pro']))
  check('hy3 的 off 已撤（省略参数会思考）',
    JSON.stringify(efforts['hy3']) === '["low","medium","high","max"]', JSON.stringify(efforts['hy3']))
  check('无表模型不出现（auto / deepseek-v3）',
    efforts['auto'] === undefined && efforts['deepseek-v3'] === undefined)
  const flash = (listed?.catalog?.models ?? []).find((m) => m.id === 'glm-5.3-flash')
  check('目录条目带完整声明（supportedEfforts/canDisableThinking/defaultEffort）',
    JSON.stringify(flash?.supportedEfforts) === '["low","high","max"]' && flash?.canDisableThinking === true
      && flash?.defaultEffort === 'high', JSON.stringify(flash))

  console.log('\n[2] settings.yaml 镜像（宿主 Effort 选择器的数据源）')
  const mirror = readFileSync(join(process.env.DSH_HOME, 'settings.yaml'), 'utf8')
  check('镜像含目录模型的 reasoningEfforts',
    /glm-5\.3-flash[\s\S]{0,400}?reasoningEfforts/.test(mirror))

  const chats = []
  if (!SKIP_CHAT) {
    console.log('\n[3] 真实 chat：出站注入 + 上游接受')
    const layerPath = join(process.env.DSH_HOME, 'codebuddy-plugin.json')
    const chat = async (model) => {
      const r = await fetch(`http://127.0.0.1:${bridgePort}/v2/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, max_tokens: 24, messages: [{ role: 'user', content: '只回一个字：好' }] }),
      })
      const text = await r.text()
      const last = [...captured].reverse().find((c) => c.url?.endsWith('/chat/completions'))
      chats.push({ model, status: r.status, effort: last?.reasoningEffort ?? null, bodyPreview: text.slice(0, 120) })
      return r.status
    }

    writeFileSync(layerPath, JSON.stringify({ effortByModel: { 'glm-5.3-flash': 'max' } }) + '\n')
    let status = await chat('glm-5.3-flash')
    check('已声明档位 max → 出站体带 reasoning_effort:"max"，上游 200',
      status === 200 && chats.at(-1).effort === 'max', JSON.stringify(chats.at(-1)))

    writeFileSync(layerPath, JSON.stringify({ effortByModel: { 'glm-5.3-flash': 'medium' } }) + '\n')
    status = await chat('glm-5.3-flash')
    check('未声明档位 medium → 不注入（仍 200）',
      status === 200 && chats.at(-1).effort === null, JSON.stringify(chats.at(-1)))

    writeFileSync(layerPath, JSON.stringify({ effortByModel: { auto: 'high' } }) + '\n')
    status = await chat('auto')
    check('无表模型 auto → 不注入（仍 200）',
      status === 200 && chats.at(-1).effort === null, JSON.stringify(chats.at(-1)))

    writeFileSync(layerPath, JSON.stringify({}) + '\n')
  }

  const evidence = {
    fetchedAt: new Date().toISOString(),
    catalogCount,
    efforts,
    mirrorHasReasoningEfforts: /glm-5\.3-flash[\s\S]{0,400}?reasoningEfforts/.test(mirror),
    chats,
    captured: captured.map((c) => ({ url: c.url, status: c.status, model: c.model, reasoningEffort: c.reasoningEffort })),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(evidence, null, 2))

  console.log(failures === 0 ? '\nall wiring checks passed' : `\n${failures} check(s) FAILED`)
  console.log(`证据落盘：${OUT}`)
  proxy.close()
  await disposeAll(effects) // apply() 的 teardown：关掉本进程起的桥
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`probe crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
