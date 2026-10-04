// probe-qoder-thinking-config.mjs — 取 Qoder 目录里逐模型的思考能力声明
// （thinking_config）并落证据，同时打印投影出的 reasoningEfforts 档位表。
//
// 只读：一次签名 GET（/algo/api/v2/model/list?Encode=1），不发聊天请求、不动配置。
// 用法：node scripts/probe-qoder-thinking-config.mjs
// 证据 → docs/probes/qoder-thinking-config-<ts>.json
import { readJson } from '../core/json-store.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const store = readJson(join(homedir(), '.dsh', 'qoder-plugin-auth.json'))
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
const { fetchQoderCatalog, qoderReasoningEfforts } = await import('../providers/qoder/catalog.js')

const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const cred = { accessToken: store.auth.accessToken, machineId: store.machine.machineId, uid: store.account.uid }
const infer = process.argv[2] ?? 'https://gateway.qoder.com.cn'
const cat = await fetchQoderCatalog(cosy, cred, infer)

const entries = {}
for (const [id, entry] of Object.entries(cat.entries)) {
  entries[id] = {
    is_reasoning: entry.is_reasoning === true,
    thinking_config: entry.thinking_config ?? null,
    effortTable: qoderReasoningEfforts(entry),
  }
}

console.log('model                     is_reasoning  effortTable')
for (const [id, e] of Object.entries(entries)) {
  const table = e.effortTable
  const shape = table === null
    ? '—'
    : Object.entries(table).map(([k, v]) => `${k}${v === null ? ':null' : `:${v}`}`).join('/')
  console.log(`${id.padEnd(24)} ${String(e.is_reasoning).padEnd(13)} ${shape}`)
}
const withTable = Object.values(entries).filter((e) => e.effortTable !== null).length
console.log(`\n${withTable}/${Object.keys(entries).length} 个模型出档位表（宿主 Model/Effort 选择器据此出档）`)

mkdirSync(join(ROOT, 'docs', 'probes'), { recursive: true })
const out = join(ROOT, 'docs', 'probes', `qoder-thinking-config-${Date.now()}.json`)
writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(),
  source: `GET ${infer}/algo/api/v2/model/list?Encode=1（providers/qoder/catalog.js，签名只读）`,
  models: Object.keys(entries).length,
  withEffortTable: withTable,
  entries,
}, null, 2))
console.log('证据 →', out)
