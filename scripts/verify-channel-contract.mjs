#!/usr/bin/env node
/**
 * verify-channel-contract.mjs — 0.26.0「可扩展性」批的机器可判闸门。
 *
 * 目标不是"通道能跑"（跑不跑由 trae/qoder/bridge 三套件证），而是**加一条通道
 * 只需要动应该动的地方**：
 *
 *   [1] 契约形状：`defineChannel` 必填/可选字段、id 规则、未知字段拒绝、重复 id 拒绝
 *   [2] 三条真实通道：settings 键在 Config schema 与 SETTINGS_FIELDS 里真有、
 *       runtime 是 host/runtime.js 的台账、listen 是函数、额度面可选
 *   [3] 组合根按清单迭代：index.js 不出现通道名分支；actions 的 gateway-retry /
 *       quota-all 不写死三个 id
 *   [4] 客户端区块声明与清单对账：每个通道有区块、`control` 字段真实存在、
 *       渲染代码不再 `def.id === "trae"` 这类分支
 *   [5] quota-view 接受清单形态（`channels` 映射）且与命名参数形态同形
 *
 * 零网络、零凭据（通道描述符是纯数据 + 惰性函数，不触发任何 IO）。
 * 跑法：node scripts/verify-channel-contract.mjs
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker } from './lib/harness.mjs'
import { defineChannel, assertChannels } from '../providers/channel.js'
import { createChannels, CHANNEL_IDS } from '../host/channels/index.js'
import { createCodebuddyChannel } from '../host/channels/codebuddy.js'
import { Config, SETTINGS_FIELDS } from '../host/config.js'
import { bridgeRuntime, traeRuntime, qoderRuntime } from '../host/runtime.js'
import { buildQuotaView } from '../quota-view.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ok, section, finish } = createChecker('verify-channel-contract')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const fakeChannel = (over = {}) => defineChannel({
  id: 'mock',
  label: 'Mock',
  settings: { enabled: 'mockEnabled', port: 'mockPort' },
  runtime: { running: false, port: null, lastError: null },
  listen: () => () => {},
  ...over,
})

// ---------------------------------------------------------------------------
section('1. 契约形状（defineChannel / assertChannels）')
{
  ok('合法描述符被冻结（组合根只读）', Object.isFrozen(fakeChannel()))
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  ok('缺 listen → 拒绝', throws(() => fakeChannel({ listen: undefined })))
  ok('settings 缺 port → 拒绝', throws(() => fakeChannel({ settings: { enabled: 'x' } })))
  ok('id 非法（大写/下划线开头）→ 拒绝', throws(() => fakeChannel({ id: 'Mock' })))
  ok('未知字段 → 拒绝（防"以为是契约的私有字段"）', throws(() => fakeChannel({ bogus: 1 })))
  ok('清单为空 → 拒绝', throws(() => assertChannels([])))
  ok('id 重复 → 拒绝', throws(() => assertChannels([fakeChannel(), fakeChannel()])))
  ok('清单合法 → 返回 id 集合', assertChannels([fakeChannel()]).has('mock'))
}

// ---------------------------------------------------------------------------
section('2. 三条真实通道与设置真源对账')
{
  const channels = createChannels({ bridge: { listen: () => () => {} } })
  ok('清单恰为 codebuddy/trae/qoder（顺序 = 设置卡区块顺序）',
    channels.map((c) => c.id).join(',') === CHANNEL_IDS.join(','), channels.map((c) => c.id).join(','))
  ok('CHANNEL_IDS 与清单一致', CHANNEL_IDS.length === channels.length)

  const schemaKeys = Object.keys(Config({}) ?? {})
  const fieldKeys = SETTINGS_FIELDS.map((f) => f.key)
  for (const ch of channels) {
    ok(`channel(${ch.id}) settings.enabled 在 Config schema 里`, schemaKeys.includes(ch.settings.enabled), ch.settings.enabled)
    ok(`channel(${ch.id}) settings.port 在 Config schema 里`, schemaKeys.includes(ch.settings.port), ch.settings.port)
    ok(`channel(${ch.id}) settings.enabled 在 SETTINGS_FIELDS（POST 白名单）里`, fieldKeys.includes(ch.settings.enabled), ch.settings.enabled)
    ok(`channel(${ch.id}) runtime 是 host/runtime.js 的台账对象`,
      [bridgeRuntime, traeRuntime, qoderRuntime].includes(ch.runtime))
    ok(`channel(${ch.id}) listen 是函数`, typeof ch.listen === 'function')
  }
  ok('codebuddy 有额度面（quota 函数）', typeof channels.find((c) => c.id === 'codebuddy').quota === 'function')
  ok('trae/qoder 有目录同步与目录视图',
    ['trae', 'qoder'].every((id) => {
      const ch = channels.find((c) => c.id === id)
      return typeof ch.catalogSync === 'function' && typeof ch.catalogView === 'function'
    }))
  // codebuddy 的桥实例按 apply 每代创建：描述符是工厂，listen 必须委托给传入的 bridge。
  const probeBridge = { listen: () => 'STOP-FN' }
  const cbProbe = createCodebuddyChannel({ bridge: probeBridge })
  ok('codebuddy 通道是工厂，listen 委托给传入的 bridge',
    typeof createCodebuddyChannel === 'function' && cbProbe.listen(1) === 'STOP-FN')
}

// ---------------------------------------------------------------------------
section('3. 组合根按清单迭代（不再有通道名分支）')
{
  const index = read('index.js')
  ok('index.js 里没有 "channel === \'trae\'" 型分支',
    !/(channel|id)\s*===\s*'(trae|qoder|codebuddy)'/.test(index))
  ok('index.js 三份 createChannelRuntime 已合成一个循环',
    (index.match(/createChannelRuntime\(/g) || []).length === 1)
  ok('index.js 用渠道清单（createChannels）装配', /createChannels\(\{ bridge \}\)/.test(index))

  const actions = read('host/settings/actions.js')
  ok('gateway-retry 不写死三个 id', !/'trae'/.test(actions.split("'gateway-retry'")[1]?.split('},')[0] ?? ''))
  ok('gateway-retry 的 id 校验来自清单', /channels\.some\(/.test(actions))
  ok('quota-all 按清单并发（无三条命名 Promise.all）',
    /channels\.map\(/.test(actions) && !/traeProvider\.quota\.snapshot\(\{ fresh \}\)/.test(actions))

  const view = read('host/settings/view.js')
  ok('view.js 仍显式产出三通道视图片段（GET 契约按通道分层，未强行统一）',
    /trae:\s*\{/.test(view) && /qoder:\s*\{/.test(view) && /bridge:\s*\{/.test(view))
}

// ---------------------------------------------------------------------------
section('4. 客户端区块声明与清单对账')
{
  const client = read('lib/client.js')
  for (const id of CHANNEL_IDS) {
    ok(`客户端有 ${id} 区块`, new RegExp(`\\{ id: "${id}"`).test(client), id)
  }
  ok('客户端不再按 def.id 判通道（重试/开关/诊断全部数据驱动）',
    !/def\.id === "trae"|def\.id === "qoder"|def\.id === "codebuddy"/.test(client))
  ok('客户端不再按 channel 名取诊断数据源',
    !/channel === "trae"|channel === "qoder"/.test(client))
  ok('区块声明的 control 字段在 SETTINGS_FIELDS 里',
    ['traeEnabled', 'qoderEnabled'].every((f) => SETTINGS_FIELDS.some((x) => x.key === f)))
}

// ---------------------------------------------------------------------------
section('5. quota-view 的清单形态与命名形态同形')
{
  const snap = { state: 'ok', remain: 100, total: 200, unit: 'credit', fetchedAt: Date.now() }
  const named = buildQuotaView({ codebuddy: snap, trae: null, qoder: null, now: 1 })
  const list = buildQuotaView({ channels: { codebuddy: snap, trae: null, qoder: null }, now: 1 })
  ok('两种形态的顶层键一致',
    JSON.stringify(Object.keys(named).sort()) === JSON.stringify(Object.keys(list).sort()))
  ok('两种形态的合计一致', JSON.stringify(named.total) === JSON.stringify(list.total))
  ok('两种形态的通道行一致', JSON.stringify(named.channels) === JSON.stringify(list.channels))
  ok('未知通道键被忽略（不会把新通道塞进合计）',
    buildQuotaView({ channels: { codebuddy: snap, mock: snap }, now: 1 }).channels.length === 3)
}

finish()
