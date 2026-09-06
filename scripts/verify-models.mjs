#!/usr/bin/env node
/**
 * Verify that every model declared in cordis.patch.yml is still served by
 * the CodeBuddy gateway. Retired or unknown model ids fail with error
 * 11102 ("service info not found").
 *
 * Usage:
 *   node scripts/verify-models.mjs --list   # offline: print configured models
 *   node scripts/verify-models.mjs          # online: probe each model
 *   node scripts/verify-models.mjs --sync   # online: diff against the
 *                                           # gateway's /v3/config catalog
 *   node scripts/verify-models.mjs --efforts [id ...]
 *                                           # online: probe reasoning_effort
 *                                           # levels (omit/low/medium/high/
 *                                           # max) per model; defaults to
 *                                           # models lacking reasoningEfforts
 *
 * No npm dependencies. The API key is read from CODEBUDDY_API_KEY (env) or
 * ~/.dsh/.credentials.yaml — the same resolution order dsh uses.
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')
const BASE_URL = 'https://copilot.tencent.com/v2'

// The gateway has no OpenAI-style GET /models endpoint (404), which is why
// dsh's built-in "fetch available models" cannot work. The catalog the
// official CLI itself uses lives at /v3/config instead — with its own auth
// dialect: x-api-key header, and a UA that must match the CLI shape or the
// gateway answers error 12403 ("check ua"). The /v2 client UA is rejected.
const CATALOG_URL = 'https://copilot.tencent.com/v3/config'
const CATALOG_USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'

// Same header set the provider config sends — the gateway routes and logs
// CodeBuddy traffic by these client markers.
const CLIENT_HEADERS = {
  'User-Agent': 'CodeBuddyCode/1.0',
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': '2.133.1',
  'X-Product-Version': '2.133.1',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Private-Data': 'false',
}

/**
 * Extract the `models:` list from cordis.patch.yml. The patch has a fixed,
 * flat shape, so a line scanner scoped to the models block is enough —
 * anything failing to parse here means the patch layout changed and the
 * script must be updated.
 */
function parseModels(text) {
  const models = []
  let modelsIndent = null
  let current = null
  for (const line of text.split('\n')) {
    if (modelsIndent === null) {
      const header = line.match(/^(\s*)models:\s*$/)
      if (header) modelsIndent = header[1].length
      continue
    }
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= modelsIndent) break // models block ended
    const entry = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
    if (entry) {
      current = { id: entry[1], contextWindow: null, maxTokens: null, input: [] }
      models.push(current)
      continue
    }
    const kv = line.match(/^\s*(contextWindow|maxTokens):\s*(\d+)/)
    if (kv && current) current[kv[1]] = Number(kv[2])
    if (/^\s*reasoningEfforts:/.test(line) && current) current.reasoningEfforts = true
    const input = line.match(/^\s*input:\s*\[([^\]]*)\]/)
    if (input && current) {
      current.input = input[1].split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  return models
}

function loadApiKey() {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY
  const credFile = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(
      /^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m,
    )
    if (m) return m[1]
  }
  return null
}

async function fetchCatalog(apiKey) {
  const res = await fetch(CATALOG_URL, {
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      'user-agent': CATALOG_USER_AGENT,
      'x-product': 'SaaS',
    },
  })
  if (!res.ok) throw new Error(`catalog endpoint returned HTTP ${res.status}`)
  const body = await res.json()
  if (body?.code !== 0) {
    throw new Error(`catalog error: ${body?.msg ?? body?.code}`)
  }
  const data = body.data ?? {}
  const models = new Map((data.models ?? []).map((m) => [m.id, m]))
  const cliEnabled = new Set(
    (data.agents ?? []).find((a) => a.name === 'cli')?.models ?? [],
  )
  return { models, cliEnabled }
}

async function probeModel(id, apiKey) {
  let res
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true,
      }),
    })
  } catch (err) {
    return { ok: false, detail: `network error: ${err.message}` }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 200)}` }
  }
  // The gateway may answer 200 and still stream an error payload (e.g.
  // code 11102 for retired ids), so scan the stream instead of trusting
  // the status code.
  let streamed = ''
  try {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      streamed += decoder.decode(value, { stream: true })
      if (streamed.length > 4096) break
    }
  } catch {
    // Body already partially read; what we have is enough to judge.
  }
  const errMatch = streamed.match(/"code"\s*:\s*(\d+)|"error"\s*:/)
  if (errMatch) {
    return { ok: false, detail: `streamed error: ${streamed.slice(0, 200)}` }
  }
  return { ok: true, detail: 'ok' }
}

/**
 * Diff the patch's model list against the /v3/config catalog: report
 * parameter drift, ids the catalog no longer lists, and catalog ids the
 * patch could adopt; emit corrected YAML entries for the drifted ones.
 * Exits 1 only when a model present in both disagrees with the catalog —
 * unlisted legacy ids and not-yet-adopted catalog ids are informational.
 */
async function runSync(models, apiKey) {
  const { models: catalog, cliEnabled } = await fetchCatalog(apiKey)
  const inPatch = new Set(models.map((m) => m.id))
  const drifted = []
  const aligned = []
  const unlisted = []

  for (const m of models) {
    const c = catalog.get(m.id)
    if (!c) {
      unlisted.push(m.id)
      continue
    }
    const issues = []
    if (c.maxInputTokens != null && m.contextWindow !== c.maxInputTokens) {
      issues.push(`contextWindow ${m.contextWindow} → ${c.maxInputTokens}`)
    }
    if (c.maxOutputTokens != null && m.maxTokens !== c.maxOutputTokens) {
      issues.push(`maxTokens ${m.maxTokens} → ${c.maxOutputTokens}`)
    }
    const wantsImage = c.supportsImages === true
    const hasImage = m.input.includes('image')
    if (wantsImage !== hasImage) {
      issues.push(`input ${hasImage ? '[text, image]' : '[text]'} → ${wantsImage ? '[text, image]' : '[text]'}`)
    }
    issues.length ? drifted.push({ m, c, issues }) : aligned.push(m.id)
  }

  console.log(`catalog: ${catalog.size} models, ${cliEnabled.size} CLI-enabled`)
  console.log(`\naligned with catalog (${aligned.length}): ${aligned.join(', ')}`)

  console.log(`\nparameter drift (${drifted.length}):`)
  if (drifted.length === 0) {
    console.log('  none')
  } else {
    for (const { m, issues } of drifted) {
      console.log(`  ${m.id}`)
      for (const issue of issues) console.log(`    ${issue}`)
    }
    console.log('\ncorrected entries (replace the matching ids in the patch):')
    for (const { m, c } of drifted) {
      const lines = [
        `          - id: ${m.id}`,
        `            name: ${m.name ?? m.id}`,
      ]
      if (c.maxInputTokens != null) lines.push(`            contextWindow: ${c.maxInputTokens}`)
      if (c.maxOutputTokens != null) lines.push(`            maxTokens: ${c.maxOutputTokens}`)
      if (c.supportsImages === true) lines.push('            input: [text, image]')
      console.log(lines.join('\n'))
    }
  }

  console.log(`\nnot in catalog, still serving as legacy ids (${unlisted.length}):`)
  for (const id of unlisted) console.log(`  ${id}`)

  const adoptable = [...catalog.keys()].filter((id) => !inPatch.has(id))
  console.log(`\nin catalog but not in the patch (${adoptable.length}):`)
  for (const id of adoptable) {
    const c = catalog.get(id)
    const cli = cliEnabled.has(id) ? ' [CLI]' : ''
    const sizes = c.maxInputTokens != null
      ? `ctx=${c.maxInputTokens} max=${c.maxOutputTokens}`
      : 'no token fields'
    const img = c.supportsImages === true ? ' img' : ''
    console.log(`  ${id}${cli}  ${sizes}${img}`)
  }

  return drifted.length > 0 ? 1 : 0
}

/**
 * Probe which reasoning_effort levels a model accepts: one streaming request
 * per level (omitting the parameter is the baseline). reasoning_content vs
 * content length tells whether the level actually changed the thinking
 * budget — identical lengths across all levels mean the gateway ignores
 * the parameter for that model.
 */
const EFFORT_LEVELS = [null, 'low', 'medium', 'high', 'max']

async function probeEffort(id, apiKey, effort) {
  const body = {
    model: id,
    messages: [{ role: 'user', content: '9.11和9.9哪个大？先想清楚再给一句话结论。' }],
    max_tokens: 800,
    stream: true,
  }
  if (effort) body.reasoning_effort = effort
  let res
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { error: `network: ${err.message}` }
  }
  if (!res.ok) {
    return { error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}` }
  }
  let buf = ''
  let reasonChars = 0
  let contentChars = 0
  let streamErr = null
  let finish = null
  try {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          if (j.error || (j.code != null && j.code !== 0)) streamErr = payload.slice(0, 120)
          const ch = j.choices?.[0]
          if (ch?.delta?.reasoning_content) reasonChars += ch.delta.reasoning_content.length
          if (ch?.delta?.content) contentChars += ch.delta.content.length
          if (ch?.finish_reason) finish = ch.finish_reason
        } catch {
          // incomplete JSON inside a complete line — skip it
        }
      }
      if (reasonChars + contentChars > 6000) break
    }
  } catch {
    // partial stream is still evidence
  }
  return { reasonChars, contentChars, finish, streamErr }
}

async function runEfforts(models, apiKey) {
  for (const m of models) {
    console.log(`\n${m.id}`)
    for (const e of EFFORT_LEVELS) {
      const label = (e ?? '(omit)').padEnd(8)
      process.stdout.write(`  ${label}`)
      const r = await probeEffort(m.id, apiKey, e)
      if (r.error || r.streamErr) {
        console.log(` ✗  ${r.error ?? r.streamErr}`)
      } else {
        console.log(
          ` reason=${String(r.reasonChars).padStart(5)}  content=${String(r.contentChars).padStart(4)}  finish=${r.finish ?? '-'}`,
        )
      }
    }
  }
  return 0
}

const models = parseModels(readFileSync(PATCH_FILE, 'utf8'))
if (models.length === 0) {
  console.error(`Failed to parse any model from ${PATCH_FILE} — patch layout changed?`)
  process.exit(1)
}

if (process.argv.includes('--list')) {
  for (const m of models) {
    const input = m.input.length ? m.input.join('+') : 'text'
    console.log(
      `${m.id.padEnd(18)} contextWindow=${String(m.contextWindow ?? '?').padEnd(7)} maxTokens=${String(m.maxTokens ?? '?').padEnd(6)} input=${input}`,
    )
  }
  console.log(`\n${models.length} models configured`)
  process.exit(0)
}

const apiKey = loadApiKey()
if (!apiKey) {
  console.error('CODEBUDDY_API_KEY not found (env or ~/.dsh/.credentials.yaml)')
  process.exit(1)
}

if (process.argv.includes('--sync')) {
  try {
    process.exit(await runSync(models, apiKey))
  } catch (err) {
    console.error(`catalog fetch failed: ${err.message}`)
    process.exit(1)
  }
}

const effortIdx = process.argv.indexOf('--efforts')
if (effortIdx !== -1) {
  const requested = process.argv.slice(effortIdx + 1).filter((a) => !a.startsWith('--'))
  const targets = requested.length
    ? models.filter((m) => requested.includes(m.id))
    : models.filter((m) => !m.reasoningEfforts)
  if (targets.length === 0) {
    console.error('no matching models to probe')
    process.exit(1)
  }
  await runEfforts(targets, apiKey)
  process.exit(0)
}

let failed = 0
for (const m of models) {
  process.stdout.write(`probing ${m.id.padEnd(18)} ... `)
  const r = await probeModel(m.id, apiKey)
  console.log(r.ok ? 'OK' : `FAIL (${r.detail})`)
  if (!r.ok) failed++
}
console.log(`\n${models.length - failed}/${models.length} models available`)
process.exit(failed > 0 ? 1 : 0)
