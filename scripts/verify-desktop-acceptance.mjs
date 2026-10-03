#!/usr/bin/env node
/**
 * verify-desktop-acceptance.mjs — desktop 适配 goal 的「可执行验收」。
 *
 * 把 docs/goals/desktop-adaptation.md 的验收标准 §1–§5 逐条变成机器可判的断言。
 * 这是 goal 的 executable spec：规约即验收，验收即断言。
 *
 * 三条分层（对应 goal 验收标准的可机器化程度）：
 *   A. 离线结构性不变量 —— 任何环境可跑，CI 硬闸门。
 *      §4a index.js 无 desktop 特化分支（静态守卫）
 *      §4b 宿主差异收口在 host-config.js / lib/client.js 候选兜底（静态守卫）
 *      §6  goal 文档存在且含可执行验收锚点
 *   B. 桌面环境断言 —— 本机有 ~/.dsh/profiles/desktop 时跑；没有则 SKIP（不假装覆盖）。
 *      §1a desktop patch 的 llm-pi-ai.providers 键枚举可解析（接入后必含 codebuddy）
 *      §1b 手写块并存校验（volces 等不被接管/破坏）
 *   C. 活桌面实例断言 —— 需要运行中的 desktop 实例，本脚本标记 SKIP。
 *      §1c ?probe=host-config 全绿、§2 三通道端到端、§3 UI 壳回归
 *      → 这些由 dsh-ui-test / 端到端探针承担，此处诚实标注，不伪造。
 *
 * 跑法：node scripts/verify-desktop-acceptance.mjs [--structural]
 *   默认（本机/接入验证）：A + B 全跑，B 组结果断言 FAIL 即「适配未达成」信号。
 *   --structural（CI 硬闸门）：只锁 A 组结构性不变量——它们必须恒真、与适配进度无关；
 *     B 组结果断言（§1c codebuddy 已接入）在适配完成前必然 FAIL，不该进 CI 恒闸门。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const structuralOnly = process.argv.includes('--structural')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
let skip = 0
const ok = (desc, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) }
  else { fail++; console.log(`  FAIL ${desc}${extra ? ' — ' + extra : ''}`) }
}
const skipped = (desc, why) => { skip++; console.log(`  SKIP ${desc} — ${why}`) }
const section = (t) => console.log(`\n[${t}]`)

// ============================================================
// A 组：离线结构性不变量（任何环境可跑）
// ============================================================
section('A. 离线结构性不变量')

// §4a index.js 无 desktop 特化分支
{
  const src = readFileSync(join(root, 'index.js'), 'utf8')
  // desktop 特化 = 出现 desktop 字样的条件分支；注释/字符串里提及不计。
  const branch = src.split('\n').filter((l) =>
    /\b(if|else if|case|&&|\|\||\?)\b.*desktop/i.test(l) && !/^\s*(\/\/|\*)/.test(l))
  ok('§4a index.js 无 desktop 特化分支', branch.length === 0,
    branch.length ? `命中 ${branch.length} 行：${branch[0].trim().slice(0, 80)}` : '')
}

// §4b 宿主差异收口：desktop 相关选路只允许出现在 host-config.js / lib/client.js
{
  const files = ['index.js', 'host-config.js', 'lib/client.js']
  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    const hits = src.split('\n').filter((l) => /desktop/i.test(l))
    if (f !== 'host-config.js' && f !== 'lib/client.js' && hits.length) {
      offenders.push(`${f}(${hits.length})`)
    }
  }
  ok('§4b 宿主差异收口 host-config/client（index.js 零 desktop 引用）', offenders.length === 0,
    offenders.join(' '))
}

// §6 goal 文档存在且含可执行验收锚点
{
  const goalPath = join(root, 'docs/goals/desktop-adaptation.md')
  ok('§6a goal 文档存在', existsSync(goalPath))
  if (existsSync(goalPath)) {
    const txt = readFileSync(goalPath, 'utf8')
    ok('§6b goal 文档引用本可执行验收', /verify-desktop-acceptance/.test(txt),
      'goal 应写明本脚本为验收锚点')
    ok('§6c goal 文档含验收标准节', /## 验收标准/.test(txt))
  } else {
    skipped('§6b/§6c goal 内容', 'goal 文档不存在')
  }
}

// ============================================================
// B 组：桌面环境断言（有 desktop profile 才跑）
// ============================================================
section('B. 桌面环境断言')

const dshHome = join(homedir(), '.dsh')
const desktopPatch = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')

if (structuralOnly) {
  skipped('B 组全部', '--structural 模式：CI 只锁 A 组恒真不变量；B 组结果断言随适配进度变化，留给本机默认跑')
} else if (!existsSync(desktopPatch)) {
  skipped('B 组全部', `无 desktop profile（${desktopPatch} 不存在）——无桌面环境属预期`)
} else {
  // 枚举 llm-pi-ai.providers 键（与 workflow 闸门同款逻辑，缩进层级已实测）
  const lines = readFileSync(desktopPatch, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => l.indexOf('- id: llm-pi-ai') === 0)
  ok('§1a desktop patch 存在 llm-pi-ai 条目', start >= 0)

  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].indexOf('- id: ') === 0) { end = i; break }
    }
    const block = lines.slice(start, end)
    let provIdx = -1, baseIndent = 0
    for (let i = 0; i < block.length; i++) {
      const t = block[i].trimEnd()
      if (t.endsWith('providers:')) { provIdx = i; baseIndent = block[i].length - block[i].trimStart().length; break }
    }
    const keyIndent = baseIndent + 2
    const keys = []
    if (provIdx >= 0) {
      for (let i = provIdx + 1; i < block.length; i++) {
        const l = block[i]
        if (l.trim() === '' || l.trim().startsWith('#')) continue
        const indent = l.length - l.trimStart().length
        if (indent <= baseIndent) break
        if (indent !== keyIndent) continue
        const m = l.trim().match(/^([A-Za-z0-9_-]+):\s*$/)
        if (m) keys.push(m[1])
      }
    }
    ok('§1b providers 键可枚举（结构未破坏）', keys.length > 0, `枚举到 ${JSON.stringify(keys)}`)
    // 接入判据：适配落地后 codebuddy 必须出现；手写块 volces 必须仍在（并存不接管）
    ok('§1c 接入判据：codebuddy 已进入 desktop providers', keys.includes('codebuddy'),
      `当前=${JSON.stringify(keys)}（适配未完成时此项 FAIL 即「未达成」信号）`)
    ok('§1d 手写块并存：volces 未被接管/删除', keys.includes('volces'),
      `当前=${JSON.stringify(keys)}`)
  }
}

// ============================================================
// C 组：活桌面实例断言（诚实标注，不伪造）
// ============================================================
section('C. 活桌面实例断言（诚实标注）')
skipped('§2 三通道端到端（CodeBuddy 桥聊天出正文）', '需运行中的 desktop 实例——由端到端探针承担，不在离线脚本伪造')
skipped('§3 UI 壳设置卡回归', '需按 desktop UI 壳形态适配 dsh-ui-test 驱动后另跑（先加载 .agents/skills/dsh-ui-regression/）')
skipped('§1e ?probe=host-config 活实例全绿', '需运行中的 desktop 实例——workflow G4 阶段承担')

// ============================================================
console.log(`\n${pass} ok / ${fail} FAIL / ${skip} SKIP`)
console.log('（B 组 SKIP = 无桌面环境属预期；C 组恒 SKIP，活实例断言由探针/GUI 套件承担）')
process.exit(fail > 0 ? 1 : 0)
