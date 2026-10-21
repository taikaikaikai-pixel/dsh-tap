#!/usr/bin/env node
/**
 * verify-quota-view.mjs — 主界面额度卡（v0.22.0）的离线回归。
 *
 * 三段口径，零网络、零凭据：
 *   [1] core/quota-cache.js：60s memoize / 15s 强制地板 / 并发单飞 / 失败不缓存。
 *   [2] quota-view.js：三通道归一的每一条分支（官方数值、估算档、未登录、读失败、
 *       非 credit 单位、耗尽、陈旧），以及合计口径（精确优先、估算不混入、绝不编数字）。
 *   [3] 浏览器半与路由的静态面：槽注册 id、轮询下限、CSS 只用令牌、index.js 的
 *       配置字段与 quota-all 动作确实在（功能面靠 [1][2] 与活体验收，不靠文本断言冒充）。
 *
 * 跑法：node scripts/verify-quota-view.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { hostSource } from './lib/host-sources.mjs'
import { createQuotaCache } from '../core/quota-cache.js'
import { buildQuotaView, aggregateTotal } from '../quota-view.js'

let pass = 0
let fail = 0
const ok = (desc, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}${extra ? ' — ' + extra : ''}`) }
}
const eq = (desc, actual, expected) => ok(desc, actual === expected, `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`)

// ---------------------------------------------------------------------------
console.log('[1] core/quota-cache：TTL / 强制地板 / 单飞 / 失败不缓存')
{
  let clock = 0
  let loads = 0
  const cache = createQuotaCache({
    load: async () => ({ n: ++loads }),
    ttlMs: 60_000,
    forceFloorMs: 15_000,
    now: () => clock,
  })
  eq('未读之前 peek() 为 null', cache.peek(), null)
  eq('首读打一发', (await cache.read()).n, 1)
  eq('60s 内再读复用', (await cache.read()).n, 1)
  clock = 1_000
  eq('fresh 在 15s 地板内仍复用（悬停风暴被吸收）', (await cache.read({ fresh: true })).n, 1)
  clock = 15_000
  eq('fresh 越过地板后才真打上游', (await cache.read({ fresh: true })).n, 2)
  clock = 16_000
  eq('刚刷完又在 TTL 内 ⇒ 常规读复用', (await cache.read()).n, 2)
  clock = 16_000 + 60_000
  eq('TTL 过期 ⇒ 常规读重打', (await cache.read()).n, 3)
  cache.reset()
  eq('reset() 清空 peek()', cache.peek(), null)

  // 并发单飞：三个同时到达的读只打一发。
  let flights = 0
  let release = null
  const gate = new Promise((r) => { release = r })
  const single = createQuotaCache({
    load: () => { flights++; return gate },
    now: () => clock,
  })
  const racing = [single.read(), single.read({ fresh: true }), single.read()]
  release({ ok: true })
  const settled = await Promise.all(racing)
  eq('三并发只打一发', flights, 1)
  ok('三并发拿到同一份结果', settled.every((v) => v && v.ok === true))

  // 失败不写缓存（踩坑 #21：坏块毒化会让之后每个读者都拿到同一次失败）。
  let attempts = 0
  const flaky = createQuotaCache({
    load: async () => {
      attempts++
      if (attempts === 1) throw new Error('boom')
      return { ok: true }
    },
    now: () => clock,
  })
  let threw = null
  await flaky.read().catch((e) => { threw = e })
  ok('load 抛错时把错误抛给调用方', threw instanceof Error && threw.message === 'boom')
  eq('失败不缓存 ⇒ peek 仍为 null', flaky.peek(), null)
  eq('下一次读取重试（不毒化）', (await flaky.read()).ok, true)
  eq('重试次数 = 2', attempts, 2)
}

// ---------------------------------------------------------------------------
console.log('[2] quota-view：三通道归一 + 合计口径')
{
  const now = Date.now()
  const meter = {
    today: { credit: 12.5, requests: 9 },
    totalCredit: 88.25,
    byChannel: { codebuddy: { credit: 60 }, trae: { credit: 20 }, qoder: { credit: 8.25 } },
  }

  // 2a 全绿：OAuth 数值 + Trae 双池 + Qoder 订阅/附加。
  const full = buildQuotaView({
    codebuddy: {
      numericQuota: true,
      resource: { cycleRemain: 812.4, cycleSize: 1000, totalRemain: 900, packs: [{ name: 'a' }, { name: 'b' }] },
      fetchedAt: now,
    },
    trae: { pools: { ide: { limit: 100, used: 40, remain: 60 }, work: { limit: 50, used: 10, remain: 40 } }, fetchedAt: now },
    qoder: { userQuota: { remaining: 30, total: 50, unit: 'credit' }, addOnQuota: { remaining: 5, total: 10, unit: 'credit' }, isQuotaExceeded: false, fetchedAt: now },
    meter,
    manualTotal: 0,
    noQuotaProviders: 7,
    now,
  })
  eq('三通道都 ok', full.channels.map((c) => c.state).join(','), 'ok,ok,ok')
  eq('CodeBuddy 徽标 = 官方计数', full.channels[0].badge, '官方计数')
  eq('CodeBuddy primary = 周期剩余', full.channels[0].primary, 812.4)
  eq('CodeBuddy 读数两行', full.channels[0].rows.length, 2)
  eq('CodeBuddy 资源包说明', full.channels[0].note, '2 个资源包')
  eq('Trae primary = 双池余量之和', full.channels[1].primary, 100)
  eq('Qoder primary = 订阅 + 附加', full.channels[2].primary, 35)
  eq('合计 = 947.4', full.total.credit, 947.4)
  eq('合计 kind = exact', full.total.kind, 'exact')
  eq('合计通道数 = 3', full.total.channelCount, 3)
  eq('visible = true', full.visible, true)
  eq('无额度接口的服务商数透传', full.noQuotaProviders, 7)
  eq('本机计量今日 credit 透传', full.meter.todayCredit, 12.5)
  eq('逐通道本机计量透传', full.meter.byChannel.codebuddy, 60)

  // 2b api-key 估算档：手填 1000 − 本机计量 60 = 940，不混进精确合计。
  const est = buildQuotaView({
    codebuddy: { numericQuota: false, fetchedAt: now },
    trae: { error: '未登录' },
    qoder: { error: '未登录' },
    meter,
    manualTotal: 1000,
    now,
  })
  eq('CodeBuddy 估算 primary', est.channels[0].primary, 940)
  eq('CodeBuddy 估算徽标', est.channels[0].badge, '估算')
  eq('未登录 ⇒ unavailable（不参与可见性）', est.channels[1].state + ',' + est.channels[2].state, 'unavailable,unavailable')
  eq('未登录不写 error 文案（走 note）', est.channels[1].error, null)
  // 2b-2 结构化 unauth（0.23.0）：登录态由布尔归类，不靠中文文案——新文案/英文文案
  //     也必须归成 unavailable（否则一次措辞改动就把登录态画成「读取失败」并参与可见性）。
  const unauth = buildQuotaView({
    codebuddy: { numericQuota: false, fetchedAt: now },
    trae: { error: 'not signed in yet（上游换了措辞）', unauth: true },
    qoder: { error: 'http 502 from upstream', unauth: false },
    meter,
    manualTotal: 1000,
    now,
  })
  eq('unauth 布尔 ⇒ unavailable（与文案无关）', unauth.channels[1].state, 'unavailable')
  eq('unauth=false 的错误 ⇒ error（真故障可见）', unauth.channels[2].state, 'error')
  eq('unauth 通道不进合计', unauth.total.kind, 'estimate')
  eq('unauth=false 的 error 通道仍让胶囊可见', unauth.visible, true)
  eq('只有估算 ⇒ 合计 kind = estimate', est.total.kind, 'estimate')
  eq('估算合计 = 940（不是 exact）', est.total.credit, 940)
  eq('只有估算也必须可见', est.visible, true)

  // 2c 手填 0 ⇒ 该通道未登录；三通道都不可用 ⇒ 整枚胶囊隐藏。
  const nothing = buildQuotaView({
    codebuddy: { numericQuota: false, fetchedAt: now },
    trae: { error: '未登录' },
    qoder: { error: '未登录' },
    meter,
    manualTotal: 0,
    now,
  })
  eq('手填 0 ⇒ unavailable', nothing.channels[0].state, 'unavailable')
  eq('合计 kind = none', nothing.total.kind, 'none')
  eq('合计 credit = null（不编 0）', nothing.total.credit, null)
  eq('全不可用 ⇒ visible false（纯 key 型用户界面不变）', nothing.visible, false)

  // 2d 读失败/无响应：state=error、数字一律 null、可见（要有原因可看）。
  const broken = buildQuotaView({
    codebuddy: { numericQuota: true, resource: null, resourceError: 'code 11140' },
    trae: null,
    qoder: { error: 'http 403' },
    meter,
    now,
  })
  eq('读失败 state=error', broken.channels[0].state + ',' + broken.channels[1].state + ',' + broken.channels[2].state, 'error,error,error')
  eq('数值额度失败带原因', broken.channels[0].error, '数值额度读取失败：code 11140')
  eq('无响应也是 error（不是 0）', broken.channels[1].primary, null)
  eq('读失败 ⇒ visible true（让人看得到原因）', broken.visible, true)
  eq('读失败不计入合计', broken.total.kind, 'none')

  // 2e 单位归一：上游 `credits`（复数，Qoder 实测就是这么写的）必须与 `credit` 同义。
  //     2026-10-21 用户实测「胶囊上没有合计」的根因：Qoder 2865 被当成"另一种单位"排除。
  const plural = buildQuotaView({
    codebuddy: { numericQuota: true, resource: { cycleRemain: 3626.44, cycleSize: 3900, totalRemain: 3900, packs: [] }, fetchedAt: now },
    trae: { error: '未登录' },
    qoder: { userQuota: { remaining: 2000, total: 2000, unit: 'credits' }, addOnQuota: { remaining: 865, total: 865, unit: 'credits' }, isQuotaExceeded: false, fetchedAt: now },
    meter,
    now,
  })
  eq('复数 credits 归一成 credit', plural.channels[2].unit, 'credit')
  eq('复数单位的读数行也归一', plural.channels[2].rows[0].unit, 'credit')
  eq('复数单位参与合计（两家）', plural.total.channelCount, 2)
  eq('合计 = 3626.44 + 2865', plural.total.credit, 6491.44)
  for (const [label, raw] of [['大写 CREDIT', 'CREDIT'], ['带空格', ' credits ']]) {
    const v = buildQuotaView({
      codebuddy: { error: '未登录' },
      trae: { error: '未登录' },
      qoder: { userQuota: { remaining: 5, total: 5, unit: raw }, isQuotaExceeded: false, fetchedAt: now },
      meter, now,
    })
    ok(`${label} 也等同 credit`, v.channels[2].unit === 'credit' && v.total.credit === 5, JSON.stringify(v.channels[2]))
  }

  // 2f 非 credit 单位：照显示、不计入合计。
  const unit = buildQuotaView({
    codebuddy: { numericQuota: true, resource: { cycleRemain: 10, cycleSize: 20, totalRemain: 10, packs: [] }, fetchedAt: now },
    trae: { error: '未登录' },
    qoder: { userQuota: { remaining: 3, total: 9, unit: 'token' }, isQuotaExceeded: false, fetchedAt: now },
    meter,
    now,
  })
  eq('Qoder 单位透传', unit.channels[2].unit, 'token')
  eq('非 credit 通道不计入合计', unit.total.credit, 10)
  eq('非 credit 通道不计数', unit.total.channelCount, 1)

  // 2g 耗尽标注 + 陈旧标记。
  const exhausted = buildQuotaView({
    codebuddy: { numericQuota: true, resource: { cycleRemain: 0, cycleSize: 100, totalRemain: 0, packs: [] }, fetchedAt: now - 10 * 60_000 },
    trae: { pools: { ide: { limit: 100, used: 100, remain: 0 }, work: null }, fetchedAt: now },
    qoder: { userQuota: { remaining: 0, total: 10, unit: 'credit' }, isQuotaExceeded: true, fetchedAt: now },
    meter,
    now,
  })
  eq('耗尽仍算 ok（余量照实显示）', exhausted.channels[2].state, 'ok')
  eq('耗尽带说明', exhausted.channels[2].note, '配额已耗尽')
  eq('余量 0 计入合计（是真实读数）', exhausted.total.credit, 0)
  eq('10 分钟前的快照标陈旧', exhausted.channels[0].stale, true)
  eq('刚取的快照不陈旧', exhausted.channels[1].stale, false)

  // 2h aggregateTotal 的优先级与空集。
  eq('空集 ⇒ none', aggregateTotal([]).kind, 'none')
  eq(
    'exact 优先于 estimate',
    aggregateTotal([
      { state: 'ok', unit: 'credit', primary: 5 },
      { state: 'estimate', unit: 'credit', primary: 100 },
    ]).credit,
    5,
  )
}

// ---------------------------------------------------------------------------
console.log('[3] 浏览器半：turn-tail 计数选择器（离线）')
{
  const listeners = {}
  const mk = (tag) => ({
    tagName: tag, children: [], attrs: {}, textContent: '',
    setAttribute(k, v) { this.attrs[k] = v },
    appendChild(c) { this.children.push(c); return c },
  })
  const doc = (globalThis.document = {
    head: mk('head'),
    visibilityState: 'visible',
    createElement: mk,
    querySelector: () => null,
    addEventListener: (t, fn) => { listeners[t] = fn },
    removeEventListener: () => {},
  })
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') })
  globalThis.AbortController = class { constructor() { this.signal = {} } abort() {} }
  let exports_ = null
  globalThis.window = { __ModuleLoader__: { load: (m) => { exports_ = m.factory(req) } } }
  function req(id) {
    if (id === 'react') {
      return {
        createElement: () => null, useState: () => [null, () => {}], useEffect: () => {},
        useRef: () => ({ current: null }), Fragment: 'Fragment',
        Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
      }
    }
    throw new Error('宿主模块不可用：' + id) // 踩坑 #9：缺原语必须能降级
  }
  await import(new URL('../lib/client.js', import.meta.url).pathname)
  const count = exports_.countTurnTails
  ok('countTurnTails 已导出（离线回归眼）', typeof count === 'function')
  eq('空快照 ⇒ 0', count(null), 0)
  eq('无 nodes ⇒ 0', count({}), 0)
  eq(
    '只数 turn-tail（一轮一个）',
    count({ nodes: [{ kind: 'user' }, { kind: 'assistant-step' }, { kind: 'turn-tail' }, { kind: 'turn-tail' }, { kind: 'turn-error' }] }),
    2,
  )
  ok('nodes 不是 forEach 容器也不炸', count({ nodes: {} }) === 0)
  void doc; void listeners
}

// ---------------------------------------------------------------------------
console.log('[4] 静态面：槽注册 / 轮询下限 / CSS 只用令牌 / 路由与配置字段')
{
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 0.25.0 起 quota-all 动作在 host/settings/actions.js：扫宿主半拼接源。
  const index = hostSource()
  // 0.25.0 起 Config/SETTINGS_FIELDS 落在 host/config.js（组合根拆分）：
  // schema 断言跟着定义走，不再假设"定义必须在 index.js"。
  const configSrc = readFileSync(new URL('../host/config.js', import.meta.url), 'utf8')
  const workflow = readFileSync(new URL('../.github/workflows/node.js.yml', import.meta.url), 'utf8')

  ok('注册 composer.dock 槽（id dsh-tap-quota）', /conversation\.composer\.dock", id: "dsh-tap-quota"/.test(client))
  ok('不再误用 conversation.input.dock 放额度卡', !/conversation\.input\.dock", id: "dsh-tap-quota"/.test(client))
  const poll = client.match(/var QUOTA_POLL_MS = (\d+)/)
  ok('空闲轮询常量存在', !!poll)
  ok('空闲轮询 ≥ 60s（上游纪律）', !!poll && Number(poll[1]) >= 60_000, poll && poll[1])
  const floor = client.match(/var QUOTA_STALE_MS = (\d+)/)
  ok('陈旧阈值存在', !!floor)

  const cssStart = client.indexOf('var QUOTA_CSS = [')
  const cssBlock = cssStart >= 0 ? client.slice(cssStart, client.indexOf('].join("\\n")', cssStart)) : ''
  ok('CSS 段落可定位', cssBlock.length > 500, String(cssBlock.length))
  ok('CSS 无硬编码十六进制颜色', !/#[0-9a-fA-F]{3,8}\b/.test(cssBlock))
  ok('CSS 只用主题令牌', /--dsw-alias-/.test(cssBlock) && /--dsw-elevation-/.test(cssBlock))
  ok('面板绝对定位挂在自建锚点上', /\.cbc-q-wrap\{position:relative/.test(cssBlock) && /\.cbc-q-panel\{position:absolute/.test(cssBlock))

  ok('路由有 quota-all 动作（宿主半某处）', /['"]quota-all['"]\s*:/.test(index) || /body\?\.action === 'quota-all'/.test(index))
  ok('三通道并行取额度', /traeProvider\.quota\.snapshot\(\{ fresh \}\)/.test(index) && /qoderProvider\.quota\.snapshot\(\{ fresh \}\)/.test(index))
  ok('quotaDockEnabled 在 Config schema', /quotaDockEnabled: z\.boolean\(\)\.default\(true\)/.test(configSrc))
  ok('quotaDockEnabled 在 SETTINGS_FIELDS（POST 白名单）', /\{ key: 'quotaDockEnabled', kind: 'boolean' \}/.test(configSrc))
  // 0.24.0 起 CI 不再逐个列套件（手写清单漏过 verify-trae-model-catalog 两个版本），
  // 改为 `npm run verify` → scripts/verify-all.mjs 自动发现 scripts/ 下的 verify- 套件。
  ok('CI 接入方式 = npm run verify（自动发现，无需登记本脚本）',
    /run:\s*npm run verify/.test(workflow) && existsSync(new URL('./verify-all.mjs', import.meta.url)))
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
