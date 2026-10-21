#!/usr/bin/env node
/**
 * verify-gateway-core.mjs — 0.24.0「统一性」批的机器可判闸门。
 *
 * 改造前，本插件的「本机面」散着六份回环门实现 + 三份 HTTP 脚手架 + 三份
 * 通道监听生命周期。语义靠运气一致，细节已经分叉（403 只有桥回 text/plain、
 * 413 上限文案一处写数字两处写 32MiB、只有两家回填 runtime.port、只有两家在
 * 拒答前排空请求体）。本套件锁住收敛后的**单份实现**：
 *
 *   [1] core/net-guard.js 的判定矩阵（Host/Origin/例外/allowedOrigins）
 *   [2] core/http-surface.js 的服务器行为（403→排空→JSON、413 先排空后应答、
 *       404、同步/异步 handler 抛错→500、stop、port=0 回填）
 *   [3] core/errors.js 的出口契约（kind/code/截断/折叠换行/敌意对象）
 *   [4] core/http-surface.js 的 createChannelRuntime（禁用撤镜像、同端口幂等、
 *       wedge 自愈、retry 语义）
 *   [5] 静态唯一实现：门/脚手架/响应出口只在 core 一份，客户端格式化器只有两个
 *
 * 零网络（全部 127.0.0.1 临时端口）、零凭据、零真实写入。
 * 跑法：node scripts/verify-gateway-core.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker, sleep, httpRequest } from './lib/harness.mjs'
import {
  LOOPBACK_HOSTNAMES, isLoopbackHostname, isLoopbackHostHeader,
  originMatchesHost, localGuardFailure, hostHeaderHostname,
} from '../core/net-guard.js'
import {
  createLoopbackServer, openAICompatRoutes, sendError, createChannelRuntime,
  DEFAULT_MAX_BODY_BYTES, OVERSIZE_GRACE_MS, GUARD_REFUSAL_MESSAGE,
} from '../core/http-surface.js'
import { describeError } from '../core/errors.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ok, section, finish } = createChecker('verify-gateway-core')

const req = (headers) => ({ headers })
const hostFile = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------------------
section('1. 回环门矩阵（core/net-guard.js 是唯一实现）')
{
  ok('白名单含裸 ::1 与解析形态 [::1]',
    LOOPBACK_HOSTNAMES.has('::1') && LOOPBACK_HOSTNAMES.has('[::1]'))
  ok('hostname 形态：127.0.0.1 / localhost / [::1] 通过',
    isLoopbackHostname('127.0.0.1') && isLoopbackHostname('localhost') && isLoopbackHostname('[::1]'))
  ok('hostname 形态：LAN IP / 域名 / 尾点域名拒绝',
    !isLoopbackHostname('192.168.1.9') && !isLoopbackHostname('evil.example') && !isLoopbackHostname('localhost.'))
  ok('hostname 形态：非字符串/空串拒绝', !isLoopbackHostname(null) && !isLoopbackHostname(''))

  ok('Host 头带端口：127.0.0.1:3901 / localhost:3901 / [::1]:3901 通过',
    isLoopbackHostHeader('127.0.0.1:3901') && isLoopbackHostHeader('localhost:3901') && isLoopbackHostHeader('[::1]:3901'))
  ok('Host 头：LAN IP / 重绑定域名 / 尾点 / 缺省拒绝',
    !isLoopbackHostHeader('192.168.1.9:3901') && !isLoopbackHostHeader('rebind.example:3901')
    && !isLoopbackHostHeader('localhost.:3901') && !isLoopbackHostHeader(undefined))
  ok('Host 头：裸 ::1 经 URL 解析失败 ⇒ 拒绝（不猜）',
    hostHeaderHostname('::1') === null && isLoopbackHostHeader('::1') === false)

  ok('Origin 缺省放行（本机 fetch/curl 与剥 Origin 的壳转发）',
    originMatchesHost(req({ host: '127.0.0.1:3901' })) === true)
  ok('Origin 与 Host 全等放行',
    originMatchesHost(req({ host: '127.0.0.1:3901', origin: 'http://127.0.0.1:3901' })) === true)
  ok('Origin 端口不同 ⇒ 拒绝（跨站 drive-by）',
    originMatchesHost(req({ host: '127.0.0.1:3901', origin: 'http://127.0.0.1:3902' })) === false)
  ok('Origin 非法 / 字面量 null ⇒ 拒绝',
    originMatchesHost(req({ host: '127.0.0.1:3901', origin: 'null' })) === false
    && originMatchesHost(req({ host: '127.0.0.1:3901', origin: 'not a url' })) === false)

  ok('localGuardFailure：正常回环请求 → null',
    localGuardFailure(req({ host: '127.0.0.1:3901' })) === null)
  ok('localGuardFailure：LAN Host → { code:"host" }',
    localGuardFailure(req({ host: '10.0.0.2:3901' }))?.code === 'host')
  ok('localGuardFailure：缺 Host → { code:"host" }',
    localGuardFailure(req({}))?.code === 'host')
  ok('localGuardFailure：跨站 Origin → { code:"origin", origin }',
    localGuardFailure(req({ host: '127.0.0.1:3901', origin: 'http://evil.example' }))?.code === 'origin')
  ok('localGuardFailure：allowedOrigins 精确放行（桌面壳 dsh-app://app）',
    localGuardFailure(req({ host: '127.0.0.1:3901', origin: 'dsh-app://app' }), { allowedOrigins: ['dsh-app://app'] }) === null)
  ok('localGuardFailure：allowedOrigins 不做前缀/通配匹配',
    localGuardFailure(req({ host: '127.0.0.1:3901', origin: 'dsh-app://app.evil' }), { allowedOrigins: ['dsh-app://app'] })?.code === 'origin')
  ok('localGuardFailure：Host 门先于 Origin 门（LAN Host + 合法 Origin 仍 host）',
    localGuardFailure(req({ host: '10.0.0.2:3901', origin: 'http://10.0.0.2:3901' }))?.code === 'host')
}

// ---------------------------------------------------------------------------
section('2. 服务器脚手架（门 → 排空 → 包体 → 路由 → 信封）')
{
  const runtime = { running: false, port: null, lastError: null }
  const seen = []
  const routes = {
    'GET /ok': (rq, rs) => { seen.push(rq.url); rs.writeHead(200, { 'Content-Type': 'text/plain' }); rs.end('ok') },
    'POST /echo': (rq, rs, body) => { rs.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); rs.end(body) },
    'GET /boom-sync': () => { throw new Error('sync boom') },
    'GET /boom-async': async () => { throw new Error('async boom') },
    ...openAICompatRoutes({
      handleChat: (rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{}') },
      modelIds: () => ['m1'],
    }),
  }
  const srv = createLoopbackServer({ runtime, logPrefix: '[test]', label: 'gateway', routes, maxBodyBytes: 1024 })
  const stop = srv.listen(0)
  for (let i = 0; i < 40 && !runtime.running; i++) await sleep(10)
  const port = runtime.port
  ok('listen(0) 后 runtime.running=true 且 port 回填真实端口',
    runtime.running === true && port > 0, `port=${port}`)
  ok('listen 成功后 lastError 清空', runtime.lastError === null)

  const badHost = await httpRequest(port, { path: '/ok', headers: { host: 'evil.example' } })
  ok('非回环 Host → 403', badHost.status === 403, `got ${badHost.status}`)
  ok('403 是 OpenAI 形 JSON 信封（message + code）',
    badHost.text.includes(GUARD_REFUSAL_MESSAGE) && badHost.text.includes('"code":"forbidden"'), badHost.text.slice(0, 120))
  ok('403 不进入处理逻辑（路由未被调用）', seen.length === 0)

  const crossOrigin = await httpRequest(port, { path: '/ok', headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example' } })
  ok('跨站 Origin → 403', crossOrigin.status === 403 && !seen.length, `got ${crossOrigin.status}`)

  const sameOrigin = await httpRequest(port, { path: '/ok', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } })
  ok('同源 Origin → 放行', sameOrigin.status === 200 && sameOrigin.text === 'ok')

  const noOrigin = await httpRequest(port, { path: '/ok', headers: { host: `127.0.0.1:${port}` } })
  ok('无 Origin → 放行（壳转发/本机客户端）', noOrigin.status === 200 && noOrigin.text === 'ok')

  const notFound = await httpRequest(port, { path: '/nope', headers: { host: `127.0.0.1:${port}` } })
  ok('未命中路由 → 404 + code not_found',
    notFound.status === 404 && notFound.text.includes('"code":"not_found"') && notFound.text.includes('no route: GET /nope'),
    notFound.text.slice(0, 120))

  const echoBody = 'héllo 中文'
  const echo = await httpRequest(port, { method: 'POST', path: '/echo', headers: { host: `127.0.0.1:${port}` }, body: echoBody })
  ok('包体一次解码：多字节字符往返字节一致（踩坑 #28）', echo.status === 200 && echo.text === echoBody, JSON.stringify(echo.text))

  const seenBefore = seen.length
  const oversize = await httpRequest(port, {
    method: 'POST', path: '/echo', headers: { host: `127.0.0.1:${port}` }, body: 'x'.repeat(4096),
  })
  ok('超限 → 413（排空这一轮上传后仍完整送达）', oversize.status === 413, `got ${oversize.status}`)
  ok('413 带 code body_too_large 与真实上限字节数',
    oversize.text.includes('"code":"body_too_large"') && oversize.text.includes('(limit 1024 bytes)'), oversize.text.slice(0, 140))
  ok('413 应答 Connection: close', String(oversize.headers.connection ?? '').toLowerCase() === 'close')
  ok('超限请求未进入处理逻辑（不缓冲整包）', seen.length === seenBefore)

  const boomSync = await httpRequest(port, { path: '/boom-sync', headers: { host: `127.0.0.1:${port}` } })
  ok('同步处理抛错 → 500 JSON 信封（不再回纯文本）',
    boomSync.status === 500 && boomSync.text.includes('sync boom') && boomSync.text.includes('"code":"internal"'),
    boomSync.text.slice(0, 120))
  const boomAsync = await httpRequest(port, { path: '/boom-async', headers: { host: `127.0.0.1:${port}` } })
  ok('异步处理 reject → 500 JSON 信封', boomAsync.status === 500 && boomAsync.text.includes('async boom'))

  const models = await httpRequest(port, { path: '/v1/models', headers: { host: `127.0.0.1:${port}` } })
  const modelJson = JSON.parse(models.text)
  ok('共享 OpenAI 路由：GET /v1/models 形状不变',
    models.status === 200 && modelJson.object === 'list' && modelJson.data[0]?.id === 'm1' && modelJson.data[0]?.object === 'model')
  ok('共享 OpenAI 路由：POST /v1/chat/completions 与 /chat/completions 都命中、/models 别名同样可用',
    (await httpRequest(port, { method: 'POST', path: '/v1/chat/completions', headers: { host: `127.0.0.1:${port}` }, body: '{}' })).status === 200
    && (await httpRequest(port, { method: 'POST', path: '/chat/completions', headers: { host: `127.0.0.1:${port}` }, body: '{}' })).status === 200
    && (await httpRequest(port, { path: '/models', headers: { host: `127.0.0.1:${port}` } })).status === 200)

  await stop()
  await sleep(30)
  ok('stop() 之后连接被拒（端口真的释放了）',
    await httpRequest(port, { path: '/ok', headers: { host: `127.0.0.1:${port}` } }).then(() => false, () => true))

  // 端口占用：listen 失败只落 runtime.lastError，绝不抛/掀翻进程
  const holderRuntime = { running: false, port: null, lastError: null }
  const holder = createLoopbackServer({ runtime: holderRuntime, label: 'holder', onRequest: () => {} })
  const stopHolder = holder.listen(0)
  for (let i = 0; i < 40 && !holderRuntime.running; i++) await sleep(10)
  const busyRuntime = { running: false, port: null, lastError: null }
  const busy = createLoopbackServer({ runtime: busyRuntime, label: 'busy', onRequest: () => {} })
  const holderPort = holderRuntime.running ? holderRuntime.port : null
  if (holderPort) {
    const stopBusy = busy.listen(holderPort)
    await sleep(120)
    ok('listen EADDRINUSE → runtime.lastError=EADDRINUSE，不抛异常',
      busyRuntime.running === false && busyRuntime.lastError === 'EADDRINUSE', JSON.stringify(busyRuntime))
    await stopBusy()
  } else {
    ok('listen EADDRINUSE → runtime.lastError=EADDRINUSE，不抛异常', false, 'holder 未监听成功')
  }
  await stopHolder()
}

// ---------------------------------------------------------------------------
section('3. describeError 出口契约（core/errors.js）')
{
  const d1 = describeError(new Error('boom'))
  ok('普通 Error → message 取用、code/kind 都是 internal',
    d1.message === 'boom' && d1.code === 'internal' && d1.kind === 'internal')
  const d2 = describeError(Object.assign(new Error('timed out'), { kind: 'timeout' }))
  ok('fetch-guard 的 kind 透传（timeout/aborted/network）且无 err.code 时 code=kind',
    d2.kind === 'timeout' && d2.code === 'timeout')
  const d3 = describeError(Object.assign(new Error('addr in use'), { code: 'EADDRINUSE' }))
  ok('err.code 优先于 kind（EADDRINUSE 保留）', d3.code === 'EADDRINUSE')
  ok('字符串错误体可用', describeError('boom string').message === 'boom string')
  ok('空/缺省回落 fallback', describeError(null, { fallback: '兜底' }).message === '兜底'
    && describeError({}, { fallback: '兜底' }).message === '兜底')
  ok('换行折叠成单行（错误行不撑破徽标）', describeError(new Error('a\nb\r\nc')).message === 'a b c')
  const long = describeError(new Error('x'.repeat(900)))
  ok('超长文案截断到 400 字 + 省略号', long.message.length === 401 && long.message.endsWith('…'))
  const hostile = { get message() { throw new Error('nope') }, get code() { throw new Error('nope') } }
  ok('敌意对象（getter 抛错）不把异常抛给响应路径',
    (() => { const r = describeError(hostile, { fallback: 'f' }); return r.message === 'f' && r.code === 'internal' })())
  ok('AbortError 归到 aborted（取消不该回 500 的业务错误）',
    (() => { const e = new Error('aborted'); e.name = 'AbortError'; return describeError(e).kind === 'aborted' })())
}

// ---------------------------------------------------------------------------
section('4. createChannelRuntime（三通道共用的监听生命周期）')
{
  const state = { enabled: false, port: 3901 }
  const runtime = { running: false, port: null, lastError: null }
  const calls = []
  const lifecycle = []
  const channel = createChannelRuntime({
    runtime,
    listen: (port) => { calls.push(port); return () => { lifecycle.push('stop') } },
    stateOf: () => ({ enabled: state.enabled, port: state.port }),
    onDisabled: () => lifecycle.push('mirror-withdraw'),
    onStarted: () => Promise.reject(new Error('catalog down')),
  })
  let unhandled = 0
  const onUnhandled = () => { unhandled++ }
  process.on('unhandledRejection', onUnhandled)

  channel.sync()
  ok('禁用态：不起监听、runtime 全清、撤镜像', calls.length === 0 && runtime.running === false
    && runtime.port === null && lifecycle.includes('mirror-withdraw'))
  ok('禁用态 retry() → false 且什么都不做（不写配置）',
    channel.retry() === false && calls.length === 0 && lifecycle.filter((x) => x === 'mirror-withdraw').length === 1)

  state.enabled = true
  channel.sync()
  ok('启用态：listen 一次，runtime.port 记录目标端口', calls.length === 1 && calls[0] === 3901 && runtime.port === 3901)
  channel.sync()
  ok('同端口重复 sync 幂等（不再 listen）', calls.length === 1)
  state.port = 3902
  channel.sync()
  ok('端口变化 → 先停旧的再起新的（旧 stop 被调用）',
    calls.length === 2 && calls[1] === 3902 && lifecycle.includes('stop'))

  runtime.lastError = 'EADDRINUSE'
  channel.sync()
  ok('wedge 自愈：lastError 置位时同端口也重新 listen（重试语义本体）', calls.length === 3)

  state.enabled = false
  channel.sync()
  ok('再次禁用 → 停监听、runtime 清空、撤镜像',
    lifecycle.filter((x) => x === 'stop').length >= 2 && runtime.port === null && runtime.running === false)

  state.enabled = true
  runtime.lastError = 'EADDRINUSE'
  channel.retry()
  ok('retry() 启用态：真的重跑 listen 并清 lastError 前提交给 listen', calls.length === 4 && runtime.lastError === null)

  await sleep(20)
  process.off('unhandledRejection', onUnhandled)
  ok('onStarted 的 reject 被吞掉（不留未处理拒绝）', unhandled === 0)

  channel.stop()
  ok('stop() 收尾后 port 归零', channel.port() === null)
}

// ---------------------------------------------------------------------------
section('5. 静态唯一实现（分叉会立刻变红）')
{
  // --cached --others：新写的文件在提交前也必须被扫到（只 ls-files 会漏掉未跟踪的新模块）
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('scripts/') && !f.startsWith('docs/') && f !== 'lib/client.js')
  const defs = (re) => files.filter((f) => re.test(hostFile(f)))

  ok('回环白名单字面量只出现在 core/net-guard.js',
    defs(/LOOPBACK_HOSTNAMES\s*=/).join(',') === 'core/net-guard.js',
    defs(/LOOPBACK_HOSTNAMES\s*=/).join(','))
  ok('Host 门函数只有一份定义',
    defs(/function isLoopbackHostHeader|function isLoopbackHost\(/).join(',') === 'core/net-guard.js',
    defs(/function isLoopbackHostHeader|function isLoopbackHost\(/).join(','))
  ok('Origin 门函数只有一份定义',
    defs(/function originMatchesHost|function isLoopbackOrigin/).join(',') === 'core/net-guard.js',
    defs(/function originMatchesHost|function isLoopbackOrigin/).join(','))
  // 唯一豁免：Trae 的 OAuth 回调（临时端口 0、一次性、无凭据面）——它不属
  // 「本地代理面」，迁移留待 B4 通道契约统一时评估（见 CHANGELOG 0.24.0 未做项）。
  const serverFiles = defs(/createServer\(/)
  ok('本机代理 server 只在 core/http-surface.js 里 createServer（OAuth 回调豁免）',
    serverFiles.filter((f) => f !== 'providers/trae/oauth.js').join(',') === 'core/http-surface.js',
    serverFiles.join(','))
  ok('sendJSON 定义唯一（core/http-surface.js）', defs(/function sendJSON\(/).join(',') === 'core/http-surface.js')
  // 0.26.0 起组合根按通道清单迭代：createChannelRuntime 只出现一次（在循环里），
  // 三条通道的差异由 host/channels/* 的描述符声明。
  ok('通道生命周期只有一份实现（清单迭代，不再各自维护 runningPort）',
    (hostFile('index.js').match(/createChannelRuntime\(/g) || []).length === 1
    && /createChannels\(\{ bridge \}\)/.test(hostFile('index.js'))
    && !/let runningPort|let traeRunningPort|let qoderRunningPort/.test(hostFile('index.js')))
  ok('网关不再自带 isLoopbackHost/isLoopbackOrigin/403 文案',
    !/isLoopbackHost|isLoopbackOrigin|forbidden: loopback host/.test(hostFile('providers/trae/gateway.js'))
    && !/isLoopbackHost|isLoopbackOrigin|forbidden: loopback host/.test(hostFile('providers/qoder/gateway.js')))
  ok('桥不再自带 Host/Origin 门与 413 包体代码',
    !/hostIsLoopback|originMatchesHost|request body too large/.test(hostFile('core/bridge.js')))

  const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  ok('客户端 httpErr/netErr 各只有一处定义',
    (client.match(/function httpErr\(/g) || []).length === 1
    && (client.match(/function netErr\(/g) || []).length === 1)
  ok('客户端不再内联 res.d.error 三元（62 处已收口）',
    !/res\.d && res\.d\.error \?/.test(client) && !/e && e\.message \? e\.message/.test(client))
}

console.log(`\n[done] 包体上限默认 ${DEFAULT_MAX_BODY_BYTES} 字节 / 超限排空宽限 ${OVERSIZE_GRACE_MS}ms`)
finish()
