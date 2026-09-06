#!/usr/bin/env node
/**
 * Offline regression for scripts/trae-model-catalog.mjs:
 *
 *   1. temp SQLite fixture with several candidate keys (good/bad/empty/odd)
 *   2. valid JSON parses; candidate discovery + default selection (+ tie-breaks)
 *   3. tolerates bad JSON / empty lists / missing fields / null / array ctx max
 *   4. same model across categories dedups into one entry (categoryProfiles
 *      keeps the differing limits)
 *   5. sensitive fields (ak/sk/api_key/refreshToken/…) recursively removed
 *   6. serialized JSON passes the forbidden-key-name scan
 *   7. markdown data-row count == models count
 *   8. discoverStateDbs on a missing root returns [] (no throw); mtime sort
 *   9. scrubSensitive unit (nested arrays/objects, exact-name matching)
 *  10. if a real state.vscdb is discoverable: one guarded end-to-end run
 *
 * Usage: node scripts/verify-trae-model-catalog.mjs   (no network; real-DB part
 * only reads, via a temp copy, and writes nothing into the repo)
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  discoverStateDbs, copySqliteForRead, readModelListCandidates,
  normalizeCatalog, renderMarkdown, selectDefaultCandidate,
  toOpenaiCompatibleId, scrubSensitive, findForbiddenKeys,
} from './trae-model-catalog.mjs'

let failures = 0
let checks = 0
function check(label, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }

}

// ---------------------------------------------------------------------------
// fixture

function fixtureModel(overrides = {}) {
  return {
    config_name: 'fixture-model', name: 'fixture-model', display_name: 'Fixture Model',
    provider: '', model_type: 'reasoning_model', multimodal: false,
    prompt_max_tokens: 1000, max_tokens: 4096, max_turn: 100,
    context_window_size: { default: 8000, max: [16000] },
    is_default: false, is_preset: true, selectable: true, status: true, fee_model_level: 1,
    reasoning_effort_options: null, temperature: null, top_p: null, top_k: null,
    thinking_enable: null, tags: [], features: {},
    ...overrides,
  }
}

function buildFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')

  const good = {
    solo_agent_lite: [
      // glm-5.3 carries credentials at top level; they must be dropped
      fixtureModel({
        config_name: 'glm-5.3', name: 'glm-5.3', display_name: 'GLM-5.3',
        prompt_max_tokens: 936000, max_tokens: 64000, max_turn: 500,
        max_turns: { default: 500, max: 2000 },
        context_window_size: { default: 200000, max: [1000000] },
        ak: 'SECRET-AK-TOP', sk: 'SECRET-SK-TOP',
      }),
      fixtureModel({
        config_name: 'Doubao-Seed-2.1-Pro', name: 'Doubao-Seed-2.1-Pro', display_name: 'Seed-2.1-Pro',
        multimodal: true, context_window_size: { default: 200000, max: 200000 },
        base_url: 'https://fixture.example.internal', hot_info: { x: 1 },
      }),
    ],
    solo_work_lite: [
      // same id as solo_agent_lite[0], different limits -> categoryProfiles diff
      fixtureModel({
        config_name: 'glm-5.3', name: 'glm-5.3', display_name: 'GLM-5.3',
        prompt_max_tokens: 168000, max_tokens: 32000, max_turn: 200, max_turns: 200,
      }),
      // old-style entry: no config_name (id from name), sensitive keys nested
      // inside features; missing ctx/max fields entirely
      {
        name: 'kimi-k3', display_name: 'Kimi-K3', model_type: 'chat_model', multimodal: true,
        features: { reasoning: { enable: true }, leak: { api_key: 'SECRET-NESTED-KEY', refreshToken: 'SECRET-NESTED-RT' } },
      },
      // entry without any usable id -> skipped with a warning
      { display_name: null, provider: 'x' },
      null,
    ],
    assistant: [],
    broken_category: 'not-an-array',
  }

  const rows = [
    ['111222333:AI.agent.model.model_list_map', JSON.stringify(good)],
    ['444555666:AI.agent.model.model_list_map', JSON.stringify({ solo_agent_lite: [fixtureModel()] })],
    ['777888999:AI.agent.model.model_list_map', '{"broken":'], // invalid JSON
    ['123123123_AI.agent.model.model_list_map', '{}'], // valid, empty
    ['987987987:AI.agent.model.model_list_map', 'null'], // valid JSON, not an object
  ]
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [k, v] of rows) insert.run(k, v)
  db.close()
}

// ---------------------------------------------------------------------------
// run

const workDir = mkdtempSync(join(tmpdir(), 'verify-trae-'))
let catalog = null
let fixtureCandidates = null

try {
  console.log('== fixture: parse & selection ==')
  const dbPath = join(workDir, 'state.vscdb')
  buildFixtureDb(dbPath)
  fixtureCandidates = readModelListCandidates(dbPath)

  check('发现全部 5 个候选 key', fixtureCandidates.length === 5, `got ${fixtureCandidates.length}`)
  const byKey = Object.fromEntries(fixtureCandidates.map((c) => [c.itemKey, c]))
  check('合法 JSON 解析成功', byKey['111222333:AI.agent.model.model_list_map'].valid === true)
  check('坏 JSON 被标记 invalid 且不抛', byKey['777888999:AI.agent.model.model_list_map'].valid === false
    && byKey['777888999:AI.agent.model.model_list_map'].parseError != null)
  check('空对象候选 entryCount=0', byKey['123123123_AI.agent.model.model_list_map'].entryCount === 0)
  check('JSON null 顶层不产生 entryCount', byKey['987987987:AI.agent.model.model_list_map'].entryCount === 0)
  check('userId 从 key 前缀提取', byKey['111222333:AI.agent.model.model_list_map'].userId === '111222333')
  const best = selectDefaultCandidate(fixtureCandidates)
  check('默认候选=条目最多者（111…，4 条 > 444…，1 条）', best?.itemKey === '111222333:AI.agent.model.model_list_map')

  // selection tie-breaks (in-memory)
  const tieA = { valid: true, json: { a: [1] }, itemKey: 'b:key', entryCount: 1, valueBytes: 10 }
  const tieB = { valid: true, json: { a: [1] }, itemKey: 'a:key', entryCount: 1, valueBytes: 10 }
  const tieC = { valid: true, json: { a: [1] }, itemKey: 'z:key', entryCount: 1, valueBytes: 99 }
  check('平手规则：value 更长者胜', selectDefaultCandidate([tieA, tieC]) === tieC)
  check('平手规则：key 字典序最小者胜', selectDefaultCandidate([tieA, tieB]) === tieB)
  check('全部 invalid 时返回 null', selectDefaultCandidate([{ valid: false }]) === null)

  console.log('== normalizeCatalog ==')
  catalog = normalizeCatalog(best, { generatedAt: '2026-08-23T00:00:00.000Z' })
  const jsonText = JSON.stringify(catalog)
  const glm = catalog.models.find((m) => m.id === 'glm-5.3')
  const doubao = catalog.models.find((m) => m.id === 'Doubao-Seed-2.1-Pro')
  const kimi = catalog.models.find((m) => m.id === 'kimi-k3')

  check('去重后模型数=3（glm 跨两分类合并）', catalog.models.length === 3, JSON.stringify(catalog.models.map((m) => m.id)))
  check('glm.categories 记录两个来源', glm?.categories.length === 2 && glm.categories[0] === 'solo_agent_lite' && glm.categories[1] === 'solo_work_lite')
  check('首个出现者限制为准（promptMaxTokens=936000）', glm?.promptMaxTokens === 936000)
  check('maxTurns 取 max_turns.max（2000）而非 max_turn（500）', glm?.maxTurns === 2000)
  check('categoryProfiles 保留差异字段', glm?.categoryProfiles.solo_work_lite?.promptMaxTokens === 168000
    && glm?.categoryProfiles.solo_work_lite?.maxOutputTokens === 32000
    && glm?.categoryProfiles.solo_work_lite?.maxTurns === 200
    && Object.keys(glm.categoryProfiles.solo_agent_lite).length === 0)
  check('数组型 contextWindowMax 保留', Array.isArray(glm?.contextWindowMax) && glm.contextWindowMax[0] === 1000000)
  check('数值型 contextWindowMax 保留', doubao?.contextWindowMax === 200000)
  check('openaiCompatibleId 点号转连字符（glm-5.3 -> glm-5-3）', glm?.openaiCompatibleId === 'glm-5-3'
    && toOpenaiCompatibleId('deepseek//deepseek-v4-pro') === 'deepseek--deepseek-v4-pro')
  check('multimodal=false -> input=[text]', glm?.input.length === 1 && glm.input[0] === 'text')
  check('multimodal=true -> input=[text,image]', doubao?.input.length === 2 && doubao.input[1] === 'image')
  check('缺 config_name 时 id 回落 name', kimi?.id === 'kimi-k3' && kimi?.configName === null)
  check('缺失字段归一为 null 而非崩溃', kimi?.promptMaxTokens === null && kimi?.contextWindowDefault === null && kimi?.maxTurns === null)
  check('functions 按分类列出模型', catalog.functions.solo_agent_lite?.length === 2
    && catalog.functions.solo_work_lite?.length === 2
    && Array.isArray(catalog.functions.assistant) && catalog.functions.assistant.length === 0)
  check('空 provider 归一为 null', glm?.provider === null)

  const warnText = catalog.warnings.join('\n')
  check('warnings 记录非数组分类', warnText.includes('broken_category'))
  check('warnings 记录无 id 条目跳过', warnText.includes('无法确定 id'))
  check('warnings 记录敏感字段移除（仅字段名）', warnText.includes('ak') && warnText.includes('sk'))
  check('warnings 记录忽略的非白名单字段名（仅名字，不含值）',
    warnText.includes('已忽略非白名单字段：base_url') && warnText.includes('已忽略非白名单字段：hot_info')
    && !warnText.includes('fixture.example.internal'))
  check('忽略字段的原值不进输出', !jsonText.includes('fixture.example.internal'))

  console.log('== 敏感字段递归清除 ==')
  check('输出不含顶层 ak/sk 值', !jsonText.includes('SECRET-AK-TOP') && !jsonText.includes('SECRET-SK-TOP'))
  check('输出不含 features 内嵌 api_key/refreshToken 值',
    !jsonText.includes('SECRET-NESTED-KEY') && !jsonText.includes('SECRET-NESTED-RT'))
  check('findForbiddenKeys 对成品目录零命中', findForbiddenKeys(catalog).length === 0)
  check('输出不含明文 userId', !jsonText.includes('111222333'))
  check('输出不含完整 itemKey', !jsonText.includes('AI.agent.model.model_list_map'))

  const nested = { models: [{ temperature: 1, Authorization: 'x', nested: [{ sessionToken: 'y', encrypted_model_params: 'z', keep: 1 }] }] }
  const scrubbed = scrubSensitive(nested)
  check('scrubSensitive 递归清除断言', findForbiddenKeys(scrubbed).length === 0 && scrubbed.models[0].nested[0].keep === 1)
  check('精确名匹配不误伤 promptMaxTokens 类字段', !findForbiddenKeys({ promptMaxTokens: 1, maxOutputTokens: 2, tags: ['token-free'] }).length)

  console.log('== markdown ==')
  const md = renderMarkdown(catalog)
  const dataRows = md.split('\n').filter((l) => l.startsWith('|')).length - 2 // header + separator
  check('Markdown 数据行数 == models 数', dataRows === catalog.models.length, `${dataRows} vs ${catalog.models.length}`)
  check('Markdown 表头列齐全', ['id', 'openaiCompatibleId', 'displayName', 'multimodal', 'contextWindowMax', 'categories']
    .every((col) => md.includes(` ${col} `) || md.includes(` ${col} |`)))
  check('Markdown 按 displayName 排序', md.indexOf('GLM-5.3') < md.indexOf('Kimi-K3') && md.indexOf('Kimi-K3') < md.indexOf('Seed-2.1-Pro'))
  check('Markdown 不含敏感值', !md.includes('SECRET-'))

  console.log('== discovery & copy ==')
  check('不存在的根目录返回空数组且不抛', discoverStateDbs(join(workDir, 'no-such-root')).length === 0)
  const fakeRoot = join(workDir, 'users')
  const fakeDbA = join(fakeRoot, 'alice', 'AppData', 'Roaming', 'TRAE SOLO CN', 'User', 'globalStorage', 'state.vscdb')
  const fakeDbB = join(fakeRoot, 'bob', 'AppData', 'Roaming', 'TRAE SOLO CN', 'User', 'globalStorage', 'state.vscdb')
  for (const p of [fakeDbA, fakeDbB]) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }
  utimesSync(fakeDbA, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
  utimesSync(fakeDbB, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))
  const discovered = discoverStateDbs(fakeRoot)
  check('发现伪数据库且按 mtime 降序', discovered.length === 2 && discovered[0].dbPath === fakeDbB)

  const copyDir = join(workDir, 'copy')
  const copied = copySqliteForRead(dbPath, copyDir)
  writeFileSync(dbPath + '-wal', '') // 0-byte wal is a valid empty wal
  const copied2 = copySqliteForRead(dbPath, join(workDir, 'copy2'))
  const reopened = readModelListCandidates(copied2)
  check('副本可读且结果一致（含 -wal 复制）', reopened.length === 5 && existsSync(copied2 + '-wal') && existsSync(copied) && !existsSync(copied + '-wal'))

  console.log('== 真实数据库（若存在）==')
  const realDbs = discoverStateDbs()
  if (!realDbs.length) {
    console.log('  skip 本机未发现 state.vscdb，跳过端到端真实提取')
  } else {
    const realDb = realDbs[0].dbPath
    const realTmp = mkdtempSync(join(tmpdir(), 'trae-catalog-real-'))
    try {
      const realCopy = copySqliteForRead(realDb, realTmp)
      const realCandidates = readModelListCandidates(realCopy)
      for (const c of realCandidates) c.dbPath = realDb
      check(`真实库发现候选 key（${realCandidates.length} 个）`, realCandidates.length >= 1)
      const realBest = selectDefaultCandidate(realCandidates)
      const realCatalog = normalizeCatalog(realBest, { generatedAt: '2026-08-23T00:00:00.000Z' })
      check('真实库去重后模型数 >= 1', realCatalog.models.length >= 1)
      const realJson = JSON.stringify(realCatalog)
      check('真实库输出零敏感键命中', findForbiddenKeys(realCatalog).length === 0)
      check('真实库输出不含明文 userId', !realCandidates.some((c) => c.userId && realJson.includes(c.userId)))
      check('真实库输出不含完整 itemKey', !realCandidates.some((c) => realJson.includes(c.itemKey)))
      const realMd = renderMarkdown(realCatalog)
      const realRows = realMd.split('\n').filter((l) => l.startsWith('|')).length - 2
      check('真实库 Markdown 行数一致', realRows === realCatalog.models.length)
      console.log(`  info  真实提取：${realCandidates.length} 候选，选用 ${realCatalog.source.itemKeyFingerprint}，模型 ${realCatalog.models.length} 个，分类 ${Object.keys(realCatalog.functions).join(', ')}`)
      console.log(`  info  忽略字段（仅名字）：${[...new Set(realCatalog.warnings)].slice(0, 40).join('；')}`)
    } finally {
      rmSync(realTmp, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log('')
if (failures) {
  console.log(`verify:trae FAILED — ${failures}/${checks} 项断言未通过`)
  process.exit(1)
}
console.log(`verify:trae OK — ${checks} 项断言全部通过`)
