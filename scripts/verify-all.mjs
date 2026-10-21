#!/usr/bin/env node
/**
 * verify-all.mjs — 全部**离线**回归的聚合入口（`npm run verify`）。
 *
 * 为什么要有它：0.23.0 前 CI 靠手写的 step 清单，漏了
 * `verify-trae-model-catalog.mjs`（50 条断言）整整两个版本没人发现——清单是
 * 手工维护的，就一定会有一次忘加。这里改成**自动发现** `scripts/verify-*.mjs`
 * 并按文件名排序执行，新增套件零登记：写进 scripts/ 就自动进闸门。
 *
 * 只有两类需要参数的套件在 DEFAULTS 里声明（其余按默认参数跑）：
 *   verify-models.mjs        --list       （不带时是「在线 18 次真实探测」，耗额度）
 *   verify-desktop-acceptance --structural（只跑与适配进度无关的结构不变量）
 *
 * 用法：
 *   node scripts/verify-all.mjs            # 跑全部
 *   node scripts/verify-all.mjs --list     # 只列清单
 *   node scripts/verify-all.mjs --only=bridge,qoder   # 跑名字含该子串的套件
 */

import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')
const SELF = 'verify-all.mjs'

const DEFAULTS = {
  'verify-models.mjs': ['--list'],
  'verify-desktop-acceptance.mjs': ['--structural'],
}

const argv = process.argv.slice(2)
const listOnly = argv.includes('--list')
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)
const filters = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : []

let suites = readdirSync(SCRIPTS)
  .filter((f) => /^verify-.*\.mjs$/.test(f) && f !== SELF)
  .sort()
if (filters.length) suites = suites.filter((s) => filters.some((f) => s.includes(f)))

if (listOnly) {
  console.log(`${suites.length} 个离线套件（自动发现，顺序执行）：`)
  for (const s of suites) console.log(`  - ${s} ${(DEFAULTS[s] ?? []).join(' ')}`.trimEnd())
  process.exit(0)
}

console.log(`离线回归：${suites.length} 个套件（自动发现；` +
  '在线探测请用 `npm run verify:live`，它会向真实上游发 18 次请求）\n')

const results = []
const t0 = Date.now()
for (const [i, suite] of suites.entries()) {
  const args = [join(SCRIPTS, suite), ...(DEFAULTS[suite] ?? [])]
  const started = Date.now()
  let output = ''
  let okAll = true
  try {
    output = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
      env: { ...process.env, DSH_VERIFY_ALL: '1' },
    })
  } catch (err) {
    okAll = false
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  const tag = `[${String(i + 1).padStart(2, ' ')}/${suites.length}]`
  console.log(`${tag} ${okAll ? 'ok  ' : 'FAIL'} ${suite} (${secs}s)`)
  if (!okAll) {
    // 失败时把该套件完整输出贴出来（含 FAIL 行与堆栈），否则排查还得手动重跑。
    console.log(output.split('\n').map((l) => `        ${l}`).join('\n').trimEnd())
    results.push({ suite, ok: false })
  } else {
    results.push({ suite, ok: true })
  }
}

const failed = results.filter((r) => !r.ok)
const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n=== verify-all: ${results.length - failed.length}/${results.length} 套件通过（${total}s）===`)
if (failed.length) {
  console.log(`失败：${failed.map((f) => f.suite).join(', ')}`)
  process.exit(1)
}
