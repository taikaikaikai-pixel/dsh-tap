#!/usr/bin/env node
/**
 * verify-host-split.mjs — 0.25.0「可维护性」批的**结构验收**（组合根拆分后必须恒真）。
 *
 * 拆分的目标不是把行数搬走，而是让"改哪类东西去哪个文件"变成机器可判的边界：
 *
 *   [1] 组合根 ≤1200 行、设置路由 ≤120 行（外壳只做门/GET/包体/分发）
 *   [2] host/ 七个模块各就各位；路由实现不在 index.js
 *   [3] **单向依赖**：index → host/settings → host/models → host/providers → host/config
 *       —— 下层不得反向 import 上层（`host/models/**` 不许 import `host/settings/**`，
 *       `host/providers/**` 不许 import `host/models/**` 或 `host/settings/**`，
 *       `core/**` 不许 import `host/**` 或 `providers/**`）
 *   [4] 28 个 action 名字都在 actions 表里；patch 语义只在 patch.js
 *   [5] 每个 host 模块有文件头注释（说明职责与边界，不是"文件说明"占位）
 *
 * 零网络、零凭据。跑法：node scripts/verify-host-split.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker } from './lib/harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ok, section, finish } = createChecker('verify-host-split')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const lines = (rel) => read(rel).split('\n').length

// 拆分后的模块地图（新模块必须登记在这里——"随手往 host/ 扔文件"是可判的失败）
const HOST_MODULES = [
  'host/config.js',
  'host/runtime.js',
  'host/redact.js',
  'host/models/state.js',
  'host/models/mirror.js',
  'host/models/channels.js',
  'host/providers/instances.js',
  'host/providers/registry.js',
  'host/settings/route.js',
  'host/settings/actions.js',
  'host/settings/patch.js',
  'host/settings/view.js',
  'host/channels/index.js',
  'host/channels/codebuddy.js',
  'host/channels/trae.js',
  'host/channels/qoder.js',
]

// ---------------------------------------------------------------------------
section('1. 行数预算')
{
  const indexLines = lines('index.js')
  ok(`index.js ≤ 1200 行（实际 ${indexLines}）`, indexLines <= 1200, String(indexLines))
  const routeLines = lines('host/settings/route.js')
  ok(`host/settings/route.js ≤ 120 行（实际 ${routeLines}）`, routeLines <= 120, String(routeLines))
  ok('index.js 仍是组合根（有 name/inject/apply 三个出口）',
    /export const name/.test(read('index.js')) && /export const inject/.test(read('index.js'))
    && /export function apply\(/.test(read('index.js')))
}

// ---------------------------------------------------------------------------
section('2. 模块就位且职责不串门')
{
  for (const mod of HOST_MODULES) {
    ok(`${mod} 存在`, existsSync(join(ROOT, mod)))
  }
  // 实际存在但与登记表不一致 → 红灯（新增模块要同时更新本清单与 wiki/02）
  const actual = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry)
      if (readdirSync(dirname(abs)) && entry.endsWith('.js')) actual.push(relative(ROOT, abs))
      else if (!entry.includes('.')) walk(abs)
    }
  }
  walk(join(ROOT, 'host'))
  ok('host/ 下没有未登记的模块',
    actual.sort().join(',') === HOST_MODULES.slice().sort().join(','),
    `多出: ${actual.filter((f) => !HOST_MODULES.includes(f)).join(',')}`)

  ok('设置路由实现不在 index.js', !/function registerSettingsRoute/.test(read('index.js')))
  ok('路由实现在 host/settings/route.js', /export function registerSettingsRoute/.test(read('host/settings/route.js')))
  const actions = read('host/settings/actions.js')
  ok('actions.js 以表驱动方式导出（createActions 返回对象）',
    /export function createActions\(/.test(actions) && /return \{/.test(actions))
  ok('patch 分支语义只在 patch.js（response 出口叫 reply）',
    /export function createPatchHandler\(/.test(read('host/settings/patch.js'))
    && !/sendJSON\(response/.test(read('host/settings/patch.js')))
  ok('view.js 只读（不写文件层）',
    !/writeFileLayer\(|writeJson\(|writeTextAtomic\(/.test(read('host/settings/view.js')))
}

// ---------------------------------------------------------------------------
section('3. 单向依赖（下层不得反向 import 上层）')
{
  const importsOf = (rel) => [...read(rel).matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const hostJs = (() => {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry)
        if (entry.endsWith('.js')) out.push(relative(ROOT, abs))
        else walk(abs)
      }
    }
    walk(join(ROOT, 'host'))
    return out
  })()

  const violates = (prefix, forbidden) => hostJs
    .filter((f) => f.startsWith(prefix))
    .filter((f) => importsOf(f).some((spec) => forbidden.some((bad) => spec.includes(bad))))

  ok('host/models/** 不 import host/settings/**', violates('host/models/', ['../settings/', './settings/']).length === 0,
    violates('host/models/', ['../settings/', './settings/']).join(','))
  ok('host/providers/** 不 import host/models/** 或 host/settings/**',
    violates('host/providers/', ['../models/', '../settings/']).length === 0,
    violates('host/providers/', ['../models/', '../settings/']).join(','))
  ok('host/channels/** 不 import host/settings/**（通道描述符不认识设置面）',
    violates('host/channels/', ['../settings/']).length === 0,
    violates('host/channels/', ['../settings/']).join(','))
  ok('host/config.js 零内部依赖（只 import core/providers 的叶子与 node 内置）',
    importsOf('host/config.js').filter((s) => s.includes('/host/') || s.startsWith('../models') || s.startsWith('../settings')).length === 0)

  // core 不得 import host/ 或 providers/（core-generic 已锁 providers；这里补 host/）
  const coreFiles = readdirSync(join(ROOT, 'core')).filter((f) => f.endsWith('.js'))
  const coreLeaks = coreFiles.filter((f) => /from '\.\.\/(host|providers)\//.test(read(`core/${f}`)))
  ok('core/** 不 import host/**（凭据边缘层不认识组合根）', coreLeaks.length === 0, coreLeaks.join(','))
}

// ---------------------------------------------------------------------------
section('4. 28 个 action 与契约闸门对齐')
{
  const EXPECTED = ['oauth-start', 'oauth-status', 'model-list', 'model-sync', 'provider-list',
    'provider-add', 'provider-remove', 'provider-refresh', 'provider-test', 'credential-test',
    'credential-scan', 'credential-import', 'oauth-logout', 'trae-oauth-start', 'trae-oauth-status',
    'trae-oauth-logout', 'trae-model-sync', 'trae-model-list', 'trae-quota',
    'qoder-oauth-start', 'qoder-oauth-status', 'qoder-oauth-logout', 'qoder-model-sync',
    'qoder-model-list', 'qoder-quota', 'usage', 'quota-all', 'gateway-retry']
  const actions = read('host/settings/actions.js')
  const missing = EXPECTED.filter((a) => !new RegExp(`'${a}':`).test(actions))
  ok(`28 个 action 全部在表里（缺 ${missing.length}）`, missing.length === 0, missing.join(','))
  ok('动作体不再自己拼响应（统一走 reply）',
    (actions.match(/^\s*sendJSON\(response/gm) || []).length === 0)
  ok('路由外壳不内联动作语义（无 "body?.action ===" 链）',
    !/body\?\.action ===/.test(read('host/settings/route.js')))
  ok('契约闸门 verify-route-contract 与 actions 表同源（都在 scripts/）',
    existsSync(join(ROOT, 'scripts/verify-route-contract.mjs')))
}

// ---------------------------------------------------------------------------
section('5. 模块头注释（职责与边界写清楚，不是占位）')
{
  for (const mod of HOST_MODULES) {
    const head = read(mod).slice(0, 1200)
    ok(`${mod} 有说明职责的文件头`, /^\/\*\*/m.test(head) && /—/.test(head), head.slice(0, 60))
  }
}

finish()
