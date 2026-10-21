/**
 * verify-host-config.mjs — 宿主配置层（host-config.js）离线回归。
 *
 * 锁定 dsh 0.1.7 的配置持久化迁移：settings.yaml（dsh-settings-file，已删除）
 * → profile 的 cordis.patch.yml（dsh-settings 的 forms seam + dsh-config-editor）。
 * 两代宿主的选路、写前比对、revision 冲突重试、不可写降级、legacy 回退的注释
 * 保留，全部用假服务/临时文件断言，不碰真实 ~/.dsh。
 *
 * 跑法：node scripts/verify-host-config.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostConfigLayer } from '../host-config.js'

import { createChecker } from './lib/harness.mjs'

// 断言记账与 [section] 输出走共享骨架（scripts/lib/harness.mjs）。
const { ok, section, finish } = createChecker('verify-host-config')

// --- 假宿主：0.1.7 形态的 Settings forms 服务 -------------------------------
function makeFormsService(opts = {}) {
  const state = { providers: structuredClone(opts.providers ?? {}) }
  let revision = opts.revision ?? 1
  let conflicts = opts.conflicts ?? 0
  const calls = { mutate: [], configure: [], register: [], dispose: 0 }
  const svc = {
    calls,
    get writable() { return opts.writable !== false },
    documentPath: opts.documentPath ?? '/fake/.dsh/profiles/web/cordis.patch.yml',
    prepareDocument: async () => svc.documentPath,
    configure(presentation, owner) {
      calls.configure.push({ presentation, owner })
      return () => { calls.dispose++ }
    },
    describe() {
      return [
        { ns: 'llm-pi-ai', revision, value: { providers: state.providers }, autoGenerate: false, applies: 'live', schema: { uid: 'x' } },
        { ns: 'ui-theme', revision: 9, value: { preference: 'dark' }, autoGenerate: true, applies: 'live', schema: {} },
      ]
    },
    async mutate(ns, ops, expected) {
      calls.mutate.push({ ns, ops: structuredClone(ops), expected })
      if (expected !== revision) {
        const e = new Error(`expected ${expected}, actual ${revision}`)
        e.code = 'SETTINGS_CONFLICT'
        throw e
      }
      if (conflicts > 0) {
        conflicts--
        revision++
        const e = new Error('injected conflict')
        e.code = 'SETTINGS_CONFLICT'
        throw e
      }
      for (const op of ops) {
        const path = op.path
        if (op.op === 'unset') {
          let cur = state
          for (let i = 0; i < path.length - 1; i++) cur = cur?.[path[i]]
          if (cur) delete cur[path[path.length - 1]]
        } else {
          let cur = state
          for (let i = 0; i < path.length - 1; i++) { cur[path[i]] ??= {}; cur = cur[path[i]] }
          cur[path[path.length - 1]] = structuredClone(op.value)
        }
      }
      revision++
    },
    _state: state,
    _revision: () => revision,
  }
  return svc
}

/** 只有 register() 的旧宿主（≤0.1.6）。 */
function makeLegacyService() {
  const calls = { register: [], configure: [] }
  return { calls, register(ns, schema) { calls.register.push({ ns, schema }) } }
}

function fakeCtx(service, fiber = { id: 'dsh-tap-fiber' }) {
  return {
    fiber,
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('settings')) cb({ settings: service })
    },
  }
}

const TRAE_BLOCK = {
  displayName: 'TraeWork CN',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:3902/v1',
  headers: { Authorization: 'Bearer dsh-trae-bridge' },
  models: [{ id: 'tm1', name: 'Trae M1', contextWindow: 128000, maxTokens: 32000 }],
}

// === A. forms 选路（dsh 0.1.7+）============================================
section('A] forms seam（0.1.7+：写落 profile patch）')
{
  const svc = makeFormsService()
  const layer = createHostConfigLayer({ settingsPath: '/nonexistent/settings.yaml', schema: { fake: true }, log: () => {} })
  layer.attach(fakeCtx(svc))

  ok('A1 attach 走 configure({auto:false}) 而不是 register',
    svc.calls.configure.length === 1 && svc.calls.configure[0].presentation.auto === false && svc.calls.register.length === 0,
    JSON.stringify({ configure: svc.calls.configure.length, register: svc.calls.register.length }))
  ok('A2 configure 带上调用方 fiber（策略归属本插件实例）',
    svc.calls.configure[0]?.owner?.id === 'dsh-tap-fiber')
  ok('A3 mode() = forms', layer.mode() === 'forms', layer.mode())
  ok('A4 servicePresent() = true', layer.servicePresent() === true)

  const r1 = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  ok('A5 set 新块：ok 且 changed', r1.ok === true && r1.changed === true, JSON.stringify(r1))
  ok('A6 mutate 命名空间 = profile entry id llm-pi-ai', svc.calls.mutate[0]?.ns === 'llm-pi-ai', svc.calls.mutate[0]?.ns)
  ok('A7 mutate 带 describe 拿到的 expectedRevision', svc.calls.mutate[0]?.expected === 1, String(svc.calls.mutate[0]?.expected))
  ok('A8 块真的进了有效配置', layer.readProviders().trae?.baseURL === 'http://127.0.0.1:3902/v1')

  const before = svc.calls.mutate.length
  const r2 = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: structuredClone(TRAE_BLOCK) }])
  ok('A9 同值重写不再 mutate（避免 revision 抖动/reload 风暴）',
    r2.ok === true && r2.changed === false && svc.calls.mutate.length === before, JSON.stringify(r2))

  const r3 = await layer.applyOps([{ op: 'unset', path: ['providers', 'nope'] }])
  ok('A10 unset 不存在的路径：不写', r3.ok === true && r3.changed === false && svc.calls.mutate.length === before)

  const r4 = await layer.applyOps([{ op: 'unset', path: ['providers', 'trae'] }])
  ok('A11 unset 存在的路径：删除生效', r4.ok === true && r4.changed === true && layer.readProviders().trae === undefined)

  const r5 = await layer.applyOps([{ op: 'set', path: ['providers', 'codebuddy', 'models'], value: [{ id: 'deepseek-v3', name: 'DeepSeek V3', contextWindow: 131072, maxTokens: 32768 }] }])
  ok('A12 深路径（providers.codebuddy.models）可写', r5.ok === true && layer.readProviders().codebuddy?.models?.[0]?.id === 'deepseek-v3')

  const p = layer.probe()
  ok('A13 probe 报 forms/可写/documentPath/entry/autoGenerate',
    p.mode === 'forms' && p.writable === true && /cordis\.patch\.yml$/.test(p.documentPath) && p.entryNs === 'llm-pi-ai' && p.autoGenerate === false,
    JSON.stringify({ mode: p.mode, writable: p.writable, doc: p.documentPath, ns: p.entryNs, auto: p.autoGenerate }))
  ok('A14 probe 列出全部命名空间（升级排查用）', Array.isArray(p.allNamespaces) && p.allNamespaces.includes('ui-theme'))

  const disposer = svc.calls.dispose
  layer.dispose()
  ok('A15 dispose 释放 configure 的 effect', svc.calls.dispose === disposer + 1)
}

section('A] forms seam：冲突与降级')
{
  const svc = makeFormsService({ conflicts: 1 })
  const layer = createHostConfigLayer({ settingsPath: '/nonexistent/settings.yaml', schema: {}, log: () => {} })
  layer.attach(fakeCtx(svc))
  const r = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  ok('A16 SETTINGS_CONFLICT 后重读 revision 重试成功',
    r.ok === true && svc.calls.mutate.length === 2 && svc.calls.mutate[1].expected === 2,
    JSON.stringify({ ok: r.ok, n: svc.calls.mutate.length, exp: svc.calls.mutate.map((c) => c.expected) }))
}
{
  const svc = makeFormsService({ writable: false })
  const layer = createHostConfigLayer({ settingsPath: '/nonexistent/settings.yaml', schema: {}, log: () => {} })
  layer.attach(fakeCtx(svc))
  const r = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  ok('A17 不可写 profile：返回失败而不是抛（踩坑 #33）',
    r.ok === false && /SETTINGS_NOT_WRITABLE/.test(r.error ?? '') && svc.calls.mutate.length === 0, JSON.stringify(r))
  ok('A18 失败落 lastError', layer.lastError === r.error)
}
{
  const svc = makeFormsService()
  svc.mutate = async () => { throw new Error('boom upstream') }
  const layer = createHostConfigLayer({ settingsPath: '/nonexistent/settings.yaml', schema: {}, log: () => {} })
  layer.attach(fakeCtx(svc))
  const r = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  ok('A19 mutate 抛非冲突错：不 reject，带错误码前缀', r.ok === false && /boom upstream/.test(r.error ?? ''), JSON.stringify(r))
  const r2 = await layer.applyOps([])
  ok('A20 空 ops 直接成功且不触服务', r2.ok === true && r2.changed === false)
}

// === A2. 宿主替换 Settings 实例（0.1.7 profile 重载语义）====================
section('A] 宿主替换 Settings 实例后仍能写（踩坑 #43 同批实测）')
{
  // 每次写 profile patch 都会触发重载，Settings 服务实例可能被**替换**；
  // cordis 的 ctx.settings 是实时 getter，缓存旧引用会带着陈旧 revision 写，
  // 实测症状 = SETTINGS_CONFLICT 连撞三次全败（镜像停在残缺清单）。
  const makeSvc = (rev) => makeFormsService({ revision: rev })
  let current = makeSvc(1)
  const ctx = {
    fiber: { id: 'dsh-tap-fiber' },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('settings')) cb({ get settings() { return current } })
    },
  }
  const layer = createHostConfigLayer({ settingsPath: '/nonexistent/settings.yaml', schema: {}, log: () => {} })
  layer.attach(ctx)
  const r1 = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  ok('A21 首次写入成功', r1.ok === true, JSON.stringify(r1))

  // 宿主重载：旧实例作废（再写即 SETTINGS_CLOSED），换上 revision 不同的新实例
  const stale = current
  stale.mutate = async () => { const e = new Error('service closed'); e.code = 'SETTINGS_CLOSED'; throw e }
  current = makeSvc(20)
  const r2 = await layer.applyOps([{ op: 'set', path: ['providers', 'qoder'], value: { displayName: 'Qoder CN', models: [{ id: 'qmodel' }] } }])
  ok('A22 服务被替换后仍写成功（活取 ctx.settings，不吃陈旧引用）', r2.ok === true, JSON.stringify(r2))
  ok('A23 写入落在新实例上、命名空间正确', current.calls.mutate.length === 1 && current.calls.mutate[0].ns === 'llm-pi-ai' && current.calls.mutate[0].expected === 20,
    JSON.stringify(current.calls.mutate.map((c) => c.expected)))
  ok('A24 陈旧实例没有被再碰过（否则会 SETTINGS_CLOSED）', stale.calls.mutate.length === 1, String(stale.calls.mutate.length))
}

// === B. legacy 回退（≤0.1.6：settings.yaml 文档编辑）========================
section('B] legacy 回退（settings.yaml + 注释保留）')
const dir = mkdtempSync(join(tmpdir(), 'dsh-tap-hostconfig-'))
{
  const path = join(dir, 'settings.yaml')
  writeFileSync(path, [
    '# 用户手写注释必须活下来',
    'ui-theme:',
    '  preference: dark',
    'llm-pi-ai:',
    '  providers:',
    '    codebuddy:',
    '      models:',
    '        - id: deepseek-v3',
    '          name: DeepSeek V3',
    '',
  ].join('\n'))
  const svc = makeLegacyService()
  const layer = createHostConfigLayer({ settingsPath: path, schema: { fake: 'schema' }, log: () => {} })
  layer.attach(fakeCtx(svc))

  ok('B1 旧宿主走 register(命名空间, schema)',
    svc.calls.register.length === 1 && svc.calls.register[0].ns === 'dsh-tap' && svc.calls.register[0].schema?.fake === 'schema' && svc.calls.configure.length === 0,
    JSON.stringify(svc.calls))
  ok('B2 mode() = legacy', layer.mode() === 'legacy', layer.mode())
  ok('B3 readProviders 读 settings.yaml', layer.readProviders().codebuddy?.models?.[0]?.id === 'deepseek-v3')

  const r = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: TRAE_BLOCK }])
  const text = readFileSync(path, 'utf8')
  ok('B4 set 写进 llm-pi-ai.providers.trae', r.ok === true && /trae:/.test(text) && /TraeWork CN/.test(text))
  ok('B5 用户注释与无关段保留', text.includes('# 用户手写注释必须活下来') && /ui-theme:/.test(text) && /preference: dark/.test(text))
  ok('B6 既有 codebuddy 块未被整段重写掉', /codebuddy:/.test(text) && /deepseek-v3/.test(text))

  const snapshot = readFileSync(path, 'utf8')
  const r2 = await layer.applyOps([{ op: 'set', path: ['providers', 'trae'], value: structuredClone(TRAE_BLOCK) }])
  ok('B7 同值不写文件', r2.ok === true && r2.changed === false && readFileSync(path, 'utf8') === snapshot)

  await layer.applyOps([{ op: 'unset', path: ['providers', 'trae'] }])
  ok('B8 unset 删块（路由存在性管理的旧路径）', !/trae:/.test(readFileSync(path, 'utf8')))
  ok('B9 删块后注释仍在', readFileSync(path, 'utf8').includes('# 用户手写注释必须活下来'))
}

// === C. 完全没有 settings 服务（rc.6 等）===================================
section('C] 无 settings 服务')
{
  const path = join(dir, 'bare.yaml')
  const layer = createHostConfigLayer({ settingsPath: path, schema: {}, log: () => {} })
  layer.attach({ fiber: null, inject: () => {} }) // inject 永不回调
  ok('C1 servicePresent = false 且 mode = legacy', layer.servicePresent() === false && layer.mode() === 'legacy')
  const r = await layer.applyOps([{ op: 'set', path: ['providers', 'qoder'], value: { displayName: 'Qoder CN', models: [{ id: 'qmodel' }] } }])
  ok('C2 仍能把块写进文件（宿主无 settings 服务时不失能）',
    r.ok === true && existsSync(path) && /qoder:/.test(readFileSync(path, 'utf8')))
  ok('C3 probe 不炸且报 legacy', layer.probe().mode === 'legacy' && layer.probe().servicePresent === false)
}

rmSync(dir, { recursive: true, force: true })
finish()
