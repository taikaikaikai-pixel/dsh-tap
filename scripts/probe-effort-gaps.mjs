#!/usr/bin/env node
/**
 * probe-effort-gaps.mjs — 「思考档位声明有没有真的到路由条目」缺口检测（免凭据）。
 *
 * 为什么需要（踩坑 #64）：宿主输入框的「推理等级」只认模型条目的
 * `reasoningEfforts`，而声明要一路走过「上游目录 → 适配器投影 → 镜像块」三层，
 * **任何一层丢掉都表现为"UI 里没入口"且零报错**——0.18.0 之前的 Qoder 14 个模型
 * 全丢就是这个形态。本脚本把三层对账成一张表，让漏项可见而不是靠人肉发现。
 *
 * 检查（只读，零写入）：
 *   1. 插件侧声明：live 实例 `model-list`（codebuddy）与 GET 视图
 *      `qoder.models.efforts`（qoder）——这是"适配器投影后"的档位表；
 *   2. 路由侧实况：宿主配置层（profile 的 cordis.patch.yml / 旧宿主 settings.yaml）
 *      里 `llm-pi-ai.providers.<route>` 的条目是否带同样的 `reasoningEfforts`，
 *      以及路由是否声明了 `compat.supportsReasoningEffort`（缺它 pi-ai 出站不写
 *      `reasoning_effort` = 出档但不生效）；
 *   3. 缺口 = 插件声明了档位而路由条目没有（或路由缺 compat）⇒ exit 1。
 *
 * 用法：
 *   node scripts/probe-effort-gaps.mjs [--url http://127.0.0.1:19387] [--patch <cordis.patch.yml>]
 * Trae：本机无 state.vscdb 时目录不可用，如实报 SKIP（不伪造）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const BASE = argOf('--url', 'http://127.0.0.1:19387').replace(/\/+$/, '')

async function getView() {
  const res = await fetch(`${BASE}/dsh-tap/settings`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`GET /dsh-tap/settings HTTP ${res.status}`)
  return res.json()
}
async function action(name) {
  const res = await fetch(`${BASE}/dsh-tap/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name }),
    signal: AbortSignal.timeout(60000),
  })
  return res.json().catch(() => null)
}

/** 宿主配置层：显式 --patch，否则在 ~/.dsh 里找带 llm-pi-ai 条目的那份。 */
function findPatch(explicit) {
  if (explicit) return explicit
  const candidates = []
  const profiles = join(homedir(), '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const d of readdirSync(profiles)) {
      const p = join(profiles, d, 'cordis.patch.yml')
      if (existsSync(p)) candidates.push(p)
    }
  }
  candidates.push(join(homedir(), '.dsh', 'settings.yaml'))
  for (const p of candidates) {
    try {
      const doc = YAML.parse(readFileSync(p, 'utf8'))
      const list = Array.isArray(doc) ? doc : [doc]
      const entry = list.find((e) => e?.id === 'llm-pi-ai')
      if (entry?.config?.providers) return p
    } catch { /* next */ }
  }
  return null
}

function routeBlock(patchPath, route) {
  const doc = YAML.parse(readFileSync(patchPath, 'utf8'))
  const list = Array.isArray(doc) ? doc : [doc]
  const entry = list.find((e) => e?.id === 'llm-pi-ai')
  return entry?.config?.providers?.[route] ?? null
}

const problems = []
const notes = []
const check = (route, declared, block, enabledIds) => {
  if (!declared) { console.log(`\n[${route}] 插件侧未提供档位声明（旧宿主或未同步）→ SKIP`); return }
  const enabled = enabledIds ? new Set(enabledIds) : null
  const ids = Object.keys(declared).filter((id) => (declared[id] ?? []).length > 0 && (!enabled || enabled.has(id)))
  if (!block) { console.log(`\n[${route}] 路由块不在宿主配置层 → SKIP（未启用？）`); return }
  const compat = block?.compat?.supportsReasoningEffort === true
  console.log(`\n[${route}] 声明了档位且**已启用**的模型 ${ids.length} 个；路由条目 ${(block.models ?? []).length} 个；compat.supportsReasoningEffort=${compat}`)
  const byId = new Map((block.models ?? []).map((m) => [m.id, m]))
  let tiered = 0
  for (const id of ids) {
    const entry = byId.get(id)
    if (!entry) {
      // 声明了但**路由里没这个模型** ⇒ 选择器不会列出它，谈不上"档位缺口"；
      // 这是配置分歧（未铺进选择器），单独记一条提示。
      notes.push(`${route}/${id}: 插件声明了档位，但路由条目里没有这个模型（未铺进选择器）`)
      continue
    }
    tiered += 1
    const mirrored = entry?.reasoningEfforts && Object.keys(entry.reasoningEfforts).length ? Object.keys(entry.reasoningEfforts) : null
    const okRow = mirrored && compat
    console.log(`  ${okRow ? 'ok  ' : 'GAP '} ${id.padEnd(22)} 插件声明=[${declared[id].join('/')}]  路由镜像=${mirrored ? `[${mirrored.join('/')}]` : '（无）'}`)
    if (!mirrored) problems.push(`${route}/${id}: 插件声明了档位但路由条目没有 reasoningEfforts（宿主选择器不会出档）`)
    else if (!compat) problems.push(`${route}: 有档位表但路由缺 compat.supportsReasoningEffort（出档也不生效）`)
  }
  if (tiered === 0) console.log(`  （声明档位且已启用的模型一个都不在路由里）`)
}

const view = await getView()
const patchPath = findPatch(argOf('--patch', null))
console.log(`实例 ${BASE}｜宿主配置层 ${patchPath ?? '(未找到)'}`)
if (!patchPath) { console.error('找不到宿主配置层（--patch 指定 profile 的 cordis.patch.yml 或 ~/.dsh/settings.yaml）'); process.exitCode = 2 } else {

const modelList = await action('model-list')
// 只对账**已启用**的模型（effectiveIds）：用户显式停用的模型本就不该铺进路由，
// 拿"声明"全集去比会把停用项误报成缺口。
check('codebuddy', modelList?.efforts ?? null, routeBlock(patchPath, 'codebuddy'), view?.models?.effectiveIds)
check('qoder', view?.qoder?.models?.efforts ?? null, routeBlock(patchPath, 'qoder'), null)
const traeView = view?.trae?.models?.sync
console.log(`\n[trae] ${traeView ? '目录已同步' : '目录未同步 / 通道未启用'} → 无声明可对账（0.19.0 起 Trae 有意不出档，见 gateway-facts）`)

if (notes.length) {
  console.log('\n=== 提示（不是档位缺口，是配置分歧）===')
  for (const n of notes) console.log('  ·', n)
}
if (problems.length) {
  console.log('\n=== 缺口 ===')
  for (const p of problems) console.log('  ✗', p)
  console.log(`\n共 ${problems.length} 处：声明没走到宿主选择器（重启 dsh 后再跑一次；仍是缺口就是投影/镜像代码漏了）`)
  process.exitCode = 1
} else {
  console.log('\n=== 无档位缺口：所有已铺进路由的声明都到了条目，且路由声明了 compat ===')
}
}
