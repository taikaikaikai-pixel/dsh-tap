/**
 * core/json-store.js — provider-agnostic JSON file persistence and
 * environment/credentials-file key resolution.
 *
 * Extracted from index.js during the core/providers split. Nothing in this
 * file knows anything about any specific upstream gateway.
 */

import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read a JSON object file; missing/corrupt/non-object all yield {}. */
export function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write a JSON object file (pretty, trailing newline), creating parents.
 * These files carry credentials/tokens, so they are created 0600 (same
 * discipline as the dsh credentials file). mode only applies at creation —
 * an existing world-readable file is chmod'ed back (a no-op failure on
 * Windows is silently tolerated).
 */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  try {
    // mode only applies at file creation — re-assert on pre-existing files.
    chmodSync(path, 0o600)
  } catch {
    // e.g. Windows ENOTSUP — nothing to harden there
  }
}

/**
 * Resolve a named secret: process environment first, then a flat YAML-ish
 * credentials file (`NAME: value` per line — the ~/.dsh/.credentials.yaml
 * shape dsh uses). Returns null when neither source has it.
 *
 * The file is scanned with string operations, NOT a RegExp built from
 * `envName`: the name is settings-configurable free text, and interpolating
 * it into a pattern would let a crafted name (regex metachar payloads)
 * rewrite what the match accepts. Line-wise parsing keeps the exact
 * previous semantics: a line whose pre-colon part equals envName, with an
 * optional single quote stripped from either end of the value.
 *
 * @param {string|undefined} envName settings-configured reference name
 * @param {string} credFilePath absolute path of the credentials file
 */
export function resolveEnvKey(envName, credFilePath) {
  if (envName && process.env[envName]) return process.env[envName]
  if (envName && existsSync(credFilePath)) {
    for (const line of readFileSync(credFilePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      const colon = trimmed.indexOf(':')
      if (colon <= 0) continue
      // No trim on the name part: the old pattern required envName
      // immediately followed by ':'.
      if (trimmed.slice(0, colon) !== envName) continue
      let value = trimmed.slice(colon + 1).trim()
      // Same optional single-quote stripping the old pattern accepted
      // (asymmetric quotes included), then the same character class:
      // no whitespace, no quotes inside the value.
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) value = value.slice(1)
      if (value.length >= 1 && (value.endsWith('"') || value.endsWith("'"))) {
        value = value.slice(0, -1)
      }
      if (value && !/[\s"']/.test(value)) return value
    }
  }
  return null
}
