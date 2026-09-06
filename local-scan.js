/**
 * local-scan.js — G7 本机登录态自动检测（只读扫描 + 确认后导入）。
 *
 * 红线：扫描只读、绝不回传任何 secret 值——findings 只带路径/类型/过期等
 * 元数据；importLocalCredential 在用户确认后把凭据从原文件直接搬进对应落点
 * （key 型上游走 openai-compat 注册表，.credentials.yaml 0600）。
 *
 * 每个探测器的产出：{ source, label, path, kind, importable, reason?, detail? }
 * - importable=true 的 finding 必须带 detail.import = { id, baseURL, keyFrom }
 *   （keyFrom 指出凭据在哪个文件哪个字段，导入时才读真值）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/** 各工具探测器。新增工具 = 往这里加一条（保持只读）。 */
const DETECTORS = [
  function iflow() {
    const settings = readJsonSafe(join(HOME, '.iflow', 'settings.json'))
    if (!settings) return null
    const apiKey = typeof settings.apiKey === 'string' && settings.apiKey ? settings.apiKey : null
    const baseURL = typeof settings.baseUrl === 'string' && settings.baseUrl.startsWith('http')
      ? settings.baseUrl : 'https://apis.iflow.cn/v1'
    if (!apiKey) {
      return { source: 'iflow', label: 'iFlow', path: '~/.iflow/settings.json', kind: 'apikey', importable: false, reason: 'settings.json 里没有 apiKey' }
    }
    return {
      source: 'iflow', label: 'iFlow', path: '~/.iflow/settings.json', kind: 'apikey', importable: true,
      detail: { import: { id: 'iflow', displayName: 'iFlow', baseURL, keyFrom: { file: join(HOME, '.iflow', 'settings.json'), field: 'apiKey' } } },
    }
  },
  function qwen() {
    const creds = readJsonSafe(join(HOME, '.qwen', 'oauth_creds.json'))
    if (!creds) return null
    const resource = typeof creds.resource_url === 'string' && creds.resource_url ? creds.resource_url : null
    const expiry = typeof creds.expiry_date === 'number' ? creds.expiry_date : null
    const expired = expiry != null && expiry < Date.now()
    if (typeof creds.access_token !== 'string' || !creds.access_token || !resource) {
      return { source: 'qwen', label: 'Qwen Code（千问）', path: '~/.qwen/oauth_creds.json', kind: 'oauth', importable: false, reason: 'oauth_creds.json 缺 access_token/resource_url' }
    }
    // access_token 当 Bearer 直用（OpenAI 兼容端点 https://<resource>/v1）；
    // 过期与否以导入时探针实测为准（expiry_date 与真实有效期未必一致；
    // 另：Qwen OAuth 免费额度 2026-04-15 已停服，存量 token 大概率被拒）。
    return {
      source: 'qwen', label: 'Qwen Code（千问）', path: '~/.qwen/oauth_creds.json', kind: 'oauth', importable: true,
      detail: {
        expiresAt: expiry,
        expiredHint: expired,
        import: { id: 'qwen', displayName: 'Qwen（本机导入）', baseURL: `https://${resource.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/v1`, keyFrom: { file: join(HOME, '.qwen', 'oauth_creds.json'), field: 'access_token' } },
      },
    }
  },
  function codex() {
    const auth = readJsonSafe(join(HOME, '.codex', 'auth.json'))
    if (!auth) return null
    return { source: 'codex', label: 'Codex（ChatGPT OAuth）', path: '~/.codex/auth.json', kind: 'oauth', importable: false, reason: 'ChatGPT 后端 responses 方言接入复杂，v0.8 暂不支持' }
  },
  function codebuddyCli() {
    if (!exists(join(HOME, '.codebuddy', 'user-state.json'))) return null
    return { source: 'codebuddy-cli', label: 'CodeBuddy CLI', path: '~/.codebuddy/', kind: 'unknown', importable: false, reason: '文件里无独立凭据（登录态在系统 keyring/内存）；本插件 OAuth 已覆盖同一网关' }
  },
  function kimiCode() {
    if (!exists(join(HOME, '.kimi-code', 'config.toml'))) return null
    return { source: 'kimi-code', label: 'Kimi Code', path: '~/.kimi-code/', kind: 'unknown', importable: false, reason: '本机服务令牌非 API key；kimi-coding 凭据如已配则无需导入' }
  },
  function zcode() {
    if (!exists(join(HOME, '.zcode', 'cli', 'config.json'))) return null
    return { source: 'zcode', label: 'ZCode', path: '~/.zcode/', kind: 'unknown', importable: false, reason: '已安装，但凭据不在可见文件里（疑似 keyring/sqlite）' }
  },
]

/** 只读扫描：返回所有命中（含"已安装但不可导入"及其原因）。 */
export function scanLocalCredentials() {
  const found = []
  for (const detect of DETECTORS) {
    try {
      const hit = detect()
      if (hit) found.push(hit)
    } catch {
      // 单个探测器失败不影响其余（只读操作，失败多为文件竞态删除）。
    }
  }
  return found
}

/**
 * 按 finding.detail.import.keyFrom 读凭据真值（导入路径专用，扫描路径禁用）。
 * 返回 { id, displayName, baseURL, apiKey }。
 */
export function readImportCredential(findings, source) {
  const f = findings.find((x) => x.source === source)
  if (!f || !f.importable || !f.detail?.import) throw new Error(`${source} 不可导入`)
  const { id, displayName, baseURL, keyFrom } = f.detail.import
  const doc = readJsonSafe(keyFrom.file)
  const apiKey = doc && typeof doc[keyFrom.field] === 'string' ? doc[keyFrom.field].trim() : ''
  if (!apiKey) throw new Error(`${keyFrom.file} 里没有 ${keyFrom.field}`)
  return { id, displayName, baseURL, apiKey }
}
