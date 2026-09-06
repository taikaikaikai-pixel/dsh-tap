#!/usr/bin/env node
/**
 * TraeWork CN / TRAE SOLO CN model catalog extractor (read-only, offline).
 *
 * Reads the VS Code global-state SQLite DB used by the Windows IDE
 *   %APPDATA%\TRAE SOLO CN\User\globalStorage\state.vscdb   (ItemTable)
 * and extracts the `AI.agent.model.model_list_map` cache into a stable JSON
 * catalog + a Markdown table. No network, no credentials, no OAuth.
 *
 * Safety contract:
 *   - never reads/prints/persists token-like fields (ak/sk/token/…, exact-name
 *     match after lowercasing + stripping non-alphanumerics, so promptMaxTokens
 *     etc. are untouched);
 *   - outputs carry SHA-256/12 fingerprints instead of raw user_id / itemKey /
 *     db path;
 *   - the DB is copied to a temp dir before opening (Windows side may hold it).
 *
 * Usage:
 *   node scripts/trae-model-catalog.mjs [--db <state.vscdb>] [--out <json>] [--md <md>] [--pretty]
 *                                       [--list-keys] [--key <itemKey>] [--all]
 * Requires Node with node:sqlite (22.5+; no flag needed on 23.4+/24).
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, statSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// ---------------------------------------------------------------------------
// constants

const MODEL_LIST_KEY_SUFFIX = 'AI.agent.model.model_list_map'
// Windows product dirs known to host the same layout; discovery scans both.
const PRODUCT_DIRS = ['TRAE SOLO CN', 'TraeWork CN']
const DEFAULT_USERS_ROOT = '/mnt/c/Users'

const DEFAULT_OUT_JSON = 'out/trae-model-catalog.json'
const DEFAULT_OUT_MD = 'out/trae-model-catalog.md'

// Exact names (case/symbol-insensitive) that must never survive into output.
// Exact match on purpose: substring matching would eat promptMaxTokens etc.
const FORBIDDEN_KEY_NAMES = new Set([
  'ak', 'sk', 'token', 'secret', 'password', 'authorization', 'credential',
  'apikey', 'refreshtoken', 'sessiontoken', 'encryptedmodelparams',
])

// Source fields the normalizer consumes (mapped or technical). Anything else
// is dropped and reported by name only.
const MAPPED_SOURCE_FIELDS = new Set([
  'config_name', 'name', 'display_name', 'provider', 'model_type', 'multimodal',
  'prompt_max_tokens', 'context_window_size', 'max_tokens', 'max_turn', 'max_turns',
  'is_default', 'is_preset', 'selectable', 'status', 'fee_model_level',
  'reasoning_effort_options',
])
const TECHNICAL_SOURCE_FIELDS = new Set(['temperature', 'top_p', 'top_k', 'thinking_enable', 'tags', 'features'])

// Per-category limit fields tracked in categoryProfiles when they differ from
// the merged (first-occurrence) values.
const LIMIT_FIELDS = ['promptMaxTokens', 'contextWindowDefault', 'contextWindowMax', 'maxOutputTokens', 'maxTurns']

// ---------------------------------------------------------------------------
// small helpers

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function fingerprint(s) {
  return 'sha256:' + sha256hex(String(s)).slice(0, 12)
}

function normalizeKeyName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isForbiddenKeyName(key) {
  return FORBIDDEN_KEY_NAMES.has(normalizeKeyName(key))
}

function numOrNull(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null
}

/** context_window_size.max may be a number, an array of numbers, or junk. */
function normalizeContextMax(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (Array.isArray(v)) {
    const nums = v.filter((n) => typeof n === 'number' && Number.isFinite(n))
    return nums.length ? nums : null
  }
  return null
}

/** max_turns may be a number or {default,max}; falls back to max_turn. */
function normalizeMaxTurns(maxTurns, maxTurn) {
  if (typeof maxTurns === 'number' && Number.isFinite(maxTurns)) return maxTurns
  if (maxTurns && typeof maxTurns === 'object') {
    const m = numOrNull(maxTurns.max)
    if (m !== null) return m
    const d = numOrNull(maxTurns.default)
    if (d !== null) return d
  }
  return numOrNull(maxTurn)
}

/**
 * openaiCompatibleId slug. The sample contract maps "glm-5.3" -> "glm-5-3"
 * (dots are replaced too), so the allowed set here is [A-Za-z0-9_-].
 */
export function toOpenaiCompatibleId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '-')
}

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

function shallowEqualByString(a, b) {
  return stableStringify(a) === stableStringify(b)
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

// ---------------------------------------------------------------------------
// security: recursive scrub + violation scan

/** Returns a copy of `value` with every forbidden key removed at any depth. */
export function scrubSensitive(value) {
  if (Array.isArray(value)) return value.map(scrubSensitive)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKeyName(k)) continue
      out[k] = scrubSensitive(v)
    }
    return out
  }
  return value
}

/** Returns the paths of every forbidden key found at any depth (for asserts). */
export function findForbiddenKeys(value, path = '$') {
  const hits = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKeyName(k)) hits.push(`${path}.${k}`)
      else hits.push(...findForbiddenKeys(v, `${path}.${k}`))
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// db discovery / copy / read

/** Scan /mnt/c/Users/&lt;user&gt;/AppData/Roaming/&lt;product&gt;/User/globalStorage for
 *  state.vscdb files. Returns [{dbPath, mtimeMs}] sorted newest-first; [] when
 *  nothing matches. */
export function discoverStateDbs(usersRoot = DEFAULT_USERS_ROOT) {
  const found = []
  let users
  try {
    users = readdirSync(usersRoot, { withFileTypes: true })
  } catch {
    return [] // no /mnt/c (not WSL) or unreadable root — not an error
  }
  for (const entry of users) {
    if (!entry.isDirectory()) continue
    for (const product of PRODUCT_DIRS) {
      const dbPath = join(usersRoot, entry.name, 'AppData', 'Roaming', product, 'User', 'globalStorage', 'state.vscdb')
      try {
        const st = statSync(dbPath)
        if (st.isFile()) found.push({ dbPath, mtimeMs: st.mtimeMs })
      } catch {
        // absent — skip
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/** Copy the DB (+ -wal/-shm when present) into tmpDir and return the copy path.
 *  We always read from the copy: the Windows-side app may hold the original. */
export function copySqliteForRead(dbPath, tmpDir) {
  mkdirSync(tmpDir, { recursive: true })
  const copyPath = join(tmpDir, basename(dbPath))
  copyFileSync(dbPath, copyPath)
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix
    if (existsSync(side)) copyFileSync(side, copyPath + suffix)
  }
  return copyPath
}

function openSqliteReadOnly(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    // WAL recovery may need write access; this is our private temp copy, so a
    // read-write open never touches the original DB.
    return new DatabaseSync(dbPath)
  }
}

/** Parse BLOB/string value into {text, bytes}. */
function decodeItemValue(value) {
  if (typeof value === 'string') return { text: value, bytes: Buffer.byteLength(value, 'utf8') }
  const buf = Buffer.from(value ?? '')
  return { text: buf.toString('utf8'), bytes: buf.length }
}

/** All model_list_map candidates from a state.vscdb (open the temp copy). */
export function readModelListCandidates(dbPath) {
  const db = openSqliteReadOnly(dbPath)
  try {
    const rows = db.prepare(
      'SELECT key, value FROM ItemTable WHERE key LIKE ? ORDER BY key'
    ).all(`%${MODEL_LIST_KEY_SUFFIX}`)
    return rows.map(({ key, value }) => {
      const { text, bytes } = decodeItemValue(value)
      const m = /^(?:([^:_]+)[:_])?AI\.agent\.model\.model_list_map$/.exec(String(key))
      const candidate = {
        dbPath,
        itemKey: String(key),
        userId: m ? (m[1] ?? '') : '',
        valueBytes: bytes,
        valid: false,
        json: null,
        parseError: null,
        entryCount: 0,
        categories: [],
      }
      try {
        const json = JSON.parse(text)
        candidate.valid = true
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          candidate.json = json
          candidate.categories = Object.keys(json)
          candidate.entryCount = candidate.categories.reduce(
            (sum, cat) => sum + (Array.isArray(json[cat]) ? json[cat].length : 0), 0)
        } else {
          candidate.parseError = 'value is valid JSON but not an object'
        }
      } catch (err) {
        candidate.parseError = String(err?.message ?? err)
      }
      return candidate
    })
  } finally {
    db.close()
  }
}

/** Default candidate: most entries, then longest value, then smallest key. */
export function selectDefaultCandidate(candidates) {
  const usable = candidates.filter((c) => c.valid && c.json)
  if (!usable.length) return null
  const sorted = [...usable].sort((a, b) =>
    (b.entryCount - a.entryCount) ||
    (b.valueBytes - a.valueBytes) ||
    (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0))
  return sorted[0]
}

// ---------------------------------------------------------------------------
// normalization

/** Normalize one parsed candidate into the stable catalog envelope. */
export function normalizeCatalog(candidate, { generatedAt = new Date().toISOString() } = {}) {
  const warnings = new Set()
  const functions = {}
  const models = new Map()

  const source = {
    kind: 'trae-solo-cn-state-vscdb',
    dbPathFingerprint: fingerprint(candidate.dbPath ?? ''),
    itemKeyFingerprint: fingerprint(candidate.itemKey ?? ''),
    userIdFingerprint: fingerprint(candidate.userId ?? ''),
    generatedAt,
  }

  if (!candidate.valid || !candidate.json) {
    return {
      schemaVersion: 1,
      source,
      functions: {},
      models: [],
      warnings: [`候选 ${source.itemKeyFingerprint} 无法解析：${candidate.parseError ?? 'unknown'}`],
    }
  }

  const json = candidate.json
  for (const category of Object.keys(json)) {
    const list = json[category]
    if (!Array.isArray(list)) {
      warnings.add(`分类 ${category} 的值不是数组，已跳过`)
      functions[category] = []
      continue
    }
    functions[category] = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.add(`跳过分类 ${category} 中非对象条目`)
        continue
      }
      for (const field of Object.keys(item)) {
        if (MAPPED_SOURCE_FIELDS.has(field) || TECHNICAL_SOURCE_FIELDS.has(field)) continue
        if (isForbiddenKeyName(field)) warnings.add(`已移除敏感字段：${field}`)
        else warnings.add(`已忽略非白名单字段：${field}`)
      }
      const id = firstString(item.config_name, item.name, item.display_name)
      if (!id) {
        warnings.add(`跳过分类 ${category} 中无法确定 id 的模型条目`)
        continue
      }

      const profile = {
        provider: item.provider || null,
        modelType: item.model_type ?? null,
        multimodal: item.multimodal === true,
        input: item.multimodal === true ? ['text', 'image'] : ['text'],
        promptMaxTokens: numOrNull(item.prompt_max_tokens),
        contextWindowDefault: numOrNull(item.context_window_size?.default),
        contextWindowMax: normalizeContextMax(item.context_window_size?.max),
        maxOutputTokens: numOrNull(item.max_tokens),
        maxTurns: normalizeMaxTurns(item.max_turns, item.max_turn),
        isDefault: item.is_default === true,
        isPreset: item.is_preset === true,
        selectable: item.selectable === undefined ? null : item.selectable === true,
        status: item.status === undefined ? null : item.status === true,
        feeModelLevel: numOrNull(item.fee_model_level),
        reasoningEffortOptions: item.reasoning_effort_options ?? null,
      }
      const technical = {}
      for (const field of TECHNICAL_SOURCE_FIELDS) {
        const v = item[field]
        if (v === null || v === undefined) continue
        if (field === 'features' && !(v && typeof v === 'object' && !Array.isArray(v))) continue
        if (field === 'tags' && !Array.isArray(v) && typeof v !== 'string') continue
        technical[field] = v
      }

      const existing = models.get(id)
      if (!existing) {
        models.set(id, {
          id,
          openaiCompatibleId: toOpenaiCompatibleId(id),
          configName: item.config_name || null,
          displayName: firstString(item.display_name, item.name) ?? id,
          ...profile,
          categories: [category],
          categoryProfiles: { [category]: {} },
          technical,
        })
        functions[category].push({ id, displayName: firstString(item.display_name, item.name) ?? id })
        continue
      }

      // Merge rule: first occurrence wins for limits/labels; differences are
      // preserved per-category in categoryProfiles; isDefault ORs; provider /
      // reasoningEffortOptions take the first non-null across categories.
      if (!existing.categories.includes(category)) existing.categories.push(category)
      const diff = {}
      for (const field of LIMIT_FIELDS) {
        if (!shallowEqualByString(existing[field], profile[field])) diff[field] = profile[field]
      }
      existing.categoryProfiles[category] = diff
      existing.isDefault = existing.isDefault || profile.isDefault
      if (existing.provider == null && profile.provider != null) existing.provider = profile.provider
      if (existing.reasoningEffortOptions == null && profile.reasoningEffortOptions != null) {
        existing.reasoningEffortOptions = profile.reasoningEffortOptions
      }
      functions[category].push({ id, displayName: firstString(item.display_name, item.name) ?? id })
    }
  }

  const modelList = [...models.values()]
    .sort((a, b) => (a.displayName.localeCompare(b.displayName)) || a.id.localeCompare(b.id))

  const catalog = {
    schemaVersion: 1,
    source,
    functions,
    models: modelList,
    warnings: [...warnings].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
  }
  // Defense in depth: the whitelist above should never let one through, but a
  // sensitive key could hide inside a copied `features` blob.
  return assertNoSensitiveKeys(scrubSensitive(catalog))
}

function assertNoSensitiveKeys(catalog) {
  const hits = findForbiddenKeys(catalog)
  if (hits.length) {
    throw new Error(`敏感字段未被清除：${hits.join(', ')}（这是 bug，请回报）`)
  }
  return catalog
}

// ---------------------------------------------------------------------------
// markdown rendering

function mdCell(v) {
  if (v === null || v === undefined) return '-'
  if (Array.isArray(v)) return v.join(',').replace(/\|/g, '\\|')
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

const MD_COLUMNS = ['id', 'openaiCompatibleId', 'displayName', 'provider', 'multimodal',
  'contextWindowDefault', 'contextWindowMax', 'maxOutputTokens', 'maxTurns', 'categories']

/** Render the catalog (or {candidates:[...]}) as a Markdown document. */
export function renderMarkdown(catalog) {
  const catalogs = catalog.candidates ? catalog.candidates : [catalog]
  const lines = []
  if (catalog.candidates) {
    lines.push('# TraeWork CN 模型目录（全部候选 key）', '')
  } else {
    lines.push('# TraeWork CN 模型目录（本地缓存提取）', '')
  }
  for (const c of catalogs) {
    if (catalog.candidates) {
      lines.push(`## 候选 ${c.source.itemKeyFingerprint}`, '')
    }
    lines.push(
      `- 生成时间：${c.source.generatedAt}`,
      `- 来源：${c.source.kind}（db ${c.source.dbPathFingerprint} / itemKey ${c.source.itemKeyFingerprint} / user ${c.source.userIdFingerprint}）`,
      `- 去重后模型数：${c.models.length}；分类数：${Object.keys(c.functions).length}`,
      ''
    )
    lines.push('| ' + MD_COLUMNS.join(' | ') + ' |')
    lines.push('|' + MD_COLUMNS.map(() => '---').join('|') + '|')
    for (const m of c.models) {
      lines.push('| ' + MD_COLUMNS.map((col) => {
        if (col === 'multimodal') return m.multimodal ? '✔' : '✘'
        if (col === 'categories') return mdCell(m.categories)
        return mdCell(m[col])
      }).join(' | ') + ' |')
    }
    lines.push('')
    if (c.warnings?.length) {
      lines.push('## 警告', '')
      for (const w of c.warnings) lines.push(`- ${w}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI

function usage() {
  return [
    '用法：node scripts/trae-model-catalog.mjs [选项]',
    '  --db <path>     指定 state.vscdb（默认自动扫描 /mnt/c/Users，取 mtime 最新）',
    '  --out <path>    JSON 输出路径（默认 out/trae-model-catalog.json）',
    '  --md <path>     Markdown 输出路径（默认 out/trae-model-catalog.md）',
    '  --pretty        格式化 JSON 输出',
    '  --list-keys     仅在 stdout 列出候选 key、长度、指纹，不写文件',
    '  --key <itemKey> 只解析指定候选 key',
    '  --all           输出所有候选 key 的归一化结果',
  ].join('\n')
}

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    const eq = tok.indexOf('=')
    let name = tok, inlineValue = null
    if (tok.startsWith('--') && eq > 2) { name = tok.slice(0, eq); inlineValue = tok.slice(eq + 1) }
    if (name === '--db' || name === '--out' || name === '--md' || name === '--key') {
      const v = inlineValue ?? argv[++i]
      if (v === undefined) { console.error(`缺少 ${name} 的值`); process.exit(1) }
      args.values[name] = v
    } else if (name === '--pretty' || name === '--list-keys' || name === '--all' || name === '--help' || name === '-h') {
      args.flags.add(name)
    } else {
      console.error(`未知参数：${tok}\n${usage()}`); process.exit(1)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.has('--help') || args.flags.has('-h')) { console.log(usage()); return }
  if (args.flags.has('--list-keys') && args.flags.has('--all')) {
    console.error('--list-keys 与 --all 互斥'); process.exit(1)
  }
  if (args.values['--key'] && args.flags.has('--all')) {
    console.error('--key 与 --all 互斥'); process.exit(1)
  }

  let dbPath = args.values['--db']
  if (dbPath) {
    if (!existsSync(dbPath)) { console.error(`数据库不存在：${dbPath}`); process.exit(1) }
  } else {
    const found = discoverStateDbs()
    if (!found.length) {
      console.error('未发现 state.vscdb（可用 --db 指定路径）。扫描位置：/mnt/c/Users/*/AppData/Roaming/{TRAE SOLO CN,TraeWork CN}/User/globalStorage/')
      process.exit(1)
    }
    dbPath = found[0].dbPath
    if (found.length > 1) {
      console.error(`发现 ${found.length} 个数据库，取 mtime 最新：${dbPath}`)
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'trae-catalog-'))
  let candidates
  try {
    const copyPath = copySqliteForRead(dbPath, tmpDir)
    candidates = readModelListCandidates(copyPath)
    // 指纹一律指向原始路径（而不是临时副本）
    for (const c of candidates) c.dbPath = dbPath
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  if (!candidates.length) {
    console.error('数据库中没有 AI.agent.model.model_list_map 候选 key')
    process.exit(1)
  }

  if (args.flags.has('--list-keys')) {
    console.log(`候选 key 共 ${candidates.length} 个（数据库：${dbPath}）`)
    for (const [i, c] of candidates.entries()) {
      console.log(`${i + 1}) key=${c.itemKey}`)
      console.log(`   bytes=${c.valueBytes}  valid=${c.valid}  entries=${c.entryCount}  categories=${c.categories.length}`)
      console.log(`   itemKeyFp=${fingerprint(c.itemKey)}  userIdFp=${fingerprint(c.userId)}${c.parseError ? `  parseError=${c.parseError}` : ''}`)
    }
    return
  }

  const outPath = args.values['--out'] ?? DEFAULT_OUT_JSON
  const mdPath = args.values['--md'] ?? DEFAULT_OUT_MD
  const defaultCandidate = selectDefaultCandidate(candidates)
  let envelope, summaryKeyFp, summaryModelCount

  if (args.values['--key']) {
    const chosen = candidates.find((c) => c.itemKey === args.values['--key'])
    if (!chosen) {
      console.error(`未找到候选 key：${args.values['--key']}（可用 --list-keys 查看候选）`)
      process.exit(1)
    }
    envelope = normalizeCatalog(chosen)
    summaryKeyFp = fingerprint(chosen.itemKey)
    summaryModelCount = envelope.models.length
  } else if (args.flags.has('--all')) {
    const catalogs = candidates.map((c) => normalizeCatalog(c))
    envelope = { schemaVersion: 1, kind: 'trae-model-catalog-multi', candidates: catalogs }
    const defIdx = defaultCandidate ? candidates.indexOf(defaultCandidate) : -1
    summaryKeyFp = defIdx >= 0 ? catalogs[defIdx].source.itemKeyFingerprint : '-'
    summaryModelCount = defIdx >= 0 ? catalogs[defIdx].models.length : 0
  } else {
    if (!defaultCandidate) { console.error('所有候选 key 都无法解析为有效 JSON'); process.exit(1) }
    envelope = normalizeCatalog(defaultCandidate)
    summaryKeyFp = envelope.source.itemKeyFingerprint
    summaryModelCount = envelope.models.length
  }

  const json = JSON.stringify(envelope, null, args.flags.has('--pretty') ? 2 : undefined)
  for (const [path, content] of [[outPath, json + '\n'], [mdPath, renderMarkdown(envelope) + '\n']]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, { mode: 0o644 })
  }

  console.log(`完成：候选 ${candidates.length} 个，选用 ${summaryKeyFp}，去重后模型 ${summaryModelCount} 个`)
  console.log(`JSON → ${outPath}（${json.length} bytes）`)
  console.log(`MD   → ${mdPath}`)
}

// import.meta.url check so the verify script can import this module freely
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err?.stack ?? err); process.exit(1) })
}
