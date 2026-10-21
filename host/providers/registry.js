/**
 * host/providers/registry.js — key 型 OpenAI 兼容上游的**登记册**（0.25.0 从 index.js 拆出）。
 *
 * 职责：预设表（ark/百炼/…）、受管清单（写在本插件的文件层，无 secret）、凭据引用
 * （`keyRef` → `~/.dsh/.credentials.yaml` 的 0600 条目）、宿主配置层的 provider 块
 * 写入/删除、以及设置卡用的 `extraProvidersView`（外部删块 → 自动出册）。
 *
 * 两条硬纪律（都曾以故障形式出现）：
 *  - 写块前必须校验（踩坑 #21：坏 provider 块会让宿主整层用户配置被丢弃）；
 *  - 凭据引用只存 env/credentials 名，密钥永不进文件层与响应（踩坑 #26）。
 */

import { chmodSync, readFileSync } from 'node:fs'

import YAML from 'yaml'

import { writeTextAtomic, resolveEnvKey } from '../../core/json-store.js'
import { PROVIDER_ID_RE, createOpenAICompatProvider, rebuildAdapterForEntry } from '../../providers/openai-compat.js'
import arkProvider from '../../providers/ark/index.js'
import bailianProvider from '../../providers/bailian/index.js'
import deepseekProvider from '../../providers/deepseek/index.js'
import bigmodelProvider from '../../providers/bigmodel/index.js'
import moonshotProvider from '../../providers/moonshot/index.js'
import openrouterProvider from '../../providers/openrouter/index.js'
import qwenProvider from '../../providers/qwen/index.js'
import { DSH_CREDENTIALS_PATH, readFileLayer, writeFileLayer, hostConfig } from '../config.js'
import { maskKey } from '../redact.js'

export const PROVIDER_PRESETS = [
  arkProvider, bailianProvider,
  deepseekProvider, bigmodelProvider, moonshotProvider, openrouterProvider,
  qwenProvider,
]

export function readManagedProviders() {
  const list = readFileLayer().managedProviders
  if (!Array.isArray(list)) return []
  return list.filter((p) => p && typeof p.id === 'string' && typeof p.keyRef === 'string')
}

export function writeManagedProviders(list) {
  const layer = readFileLayer()
  if (list.length) layer.managedProviders = list
  else delete layer.managedProviders
  writeFileLayer(layer)
}

/** ~/.dsh/.credentials.yaml 写入（dsh-credentials-local 要求文件 0600）。 */
export function writeCredential(ref, value) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_CREDENTIALS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  doc.set(ref, value)
  writeTextAtomic(DSH_CREDENTIALS_PATH, String(doc), 0o600)
  chmodSync(DSH_CREDENTIALS_PATH, 0o600)
}

export function deleteCredential(ref) {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_CREDENTIALS_PATH, 'utf8'))
  } catch {
    return
  }
  if (doc.delete(ref)) writeTextAtomic(DSH_CREDENTIALS_PATH, String(doc), 0o600)
}

/** 有效 provider 块视图（登记册对账/重名判定）。新宿主读 describe 的 live value。 */
export function readSettingsProviders() {
  return hostConfig.readProviders()
}

/**
 * 写/删（block=null）llm-pi-ai.providers.<id>。
 * dsh 0.1.7+ = Settings forms 的 mutate（落 profile patch，即时生效）；
 * ≤0.1.6 = 注释保留的 settings.yaml 文档编辑。
 */
export async function writeProviderBlock(id, block) {
  try {
    return await hostConfig.applyOps(block === null
      ? [{ op: 'unset', path: ['providers', id] }]
      : [{ op: 'set', path: ['providers', id], value: block }])
  } catch (err) {
    const d = describeError(err, { fallback: 'provider block write failed' })
    process.stderr.write(`[dsh-tap] provider block write failed: ${d.message}\n`)
    return { ok: false, error: d.message }
  }
}

/**
 * 添加上游：本地校验 → 实测 GET /models（验 key 兼拿目录）→ 写凭据 →
 * 写 provider 块 → 登记。任何一步失败都不留半成品（凭据先写是因为
 * 可服务性校验不查凭据，块后写保证热加载看到的是完整配置）。
 */
export async function addExtraProvider({ preset, id, baseURL, displayName, apiKey }) {
  let adapter
  let presetId = null
  if (preset != null) {
    const found = PROVIDER_PRESETS.find((p) => p.id === preset)
    if (!found) throw new Error(`未知 preset：${preset}`)
    adapter = found
    presetId = found.id
  } else {
    if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
      throw new Error('id 必须小写字母/数字开头（小写字母、数字、中划线）')
    }
    if (typeof baseURL !== 'string') throw new Error('需要 baseURL')
    validateBaseURL(baseURL)
    adapter = createOpenAICompatProvider({
      id,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : id,
      baseURL: baseURL.replace(/\/+$/, ''),
    })
  }
  const pid = adapter.id
  if (pid === 'codebuddy') throw new Error('codebuddy 是本插件保留路由')
  if (readManagedProviders().some((p) => p.id === pid)) throw new Error(`${pid} 已在注册表里`)
  if (readSettingsProviders()[pid]) throw new Error(`宿主配置层已存在 ${pid} 提供商（先手动清理或换 id）`)
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('需要 API Key')
  const key = apiKey.trim()
  // 实测目录：key/URL 错误在这里就炸，不落任何文件。
  const models = await adapter.fetchModels(key)
  writeCredential(adapter.keyRef, key)
  await writeProviderBlock(pid, adapter.modelBlock(models))
  writeManagedProviders(readManagedProviders().concat([{
    id: pid,
    displayName: adapter.displayName,
    baseURL: adapter.baseURL,
    preset: presetId ?? 'custom',
    keyRef: adapter.keyRef,
    addedAt: Date.now(),
  }]))
  return { id: pid, modelCount: models.length }
}

/** 移除上游：删块 + 删凭据 + 出登记册（外部已删块也照常清理）。 */
export async function removeExtraProvider(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  await writeProviderBlock(id, null)
  deleteCredential(entry.keyRef)
  writeManagedProviders(readManagedProviders().filter((p) => p.id !== id))
}

/**
 * P2-5「测一下」：只读验证——与 refresh 同一路径解析 key 并实拉目录
 * （/models；无目录/静态目录上游走 probeChatKey 探针），**不写 provider 块**。
 */
export async function testExtraProvider(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  const key = resolveEnvKey(entry.keyRef, DSH_CREDENTIALS_PATH)
  if (!key) throw new Error(`凭据 ${entry.keyRef} 不在环境或 .credentials.yaml 里`)
  const presetHit = PROVIDER_PRESETS.find((p) => p.id === entry.preset)
  const adapter = rebuildAdapterForEntry(entry, presetHit)
  const models = await adapter.fetchModels(key)
  return { id, modelCount: models.length }
}

/** 重新拉取模型清单（key 从 .credentials.yaml 活解析）。 */
export async function refreshExtraProviderModels(id) {
  const entry = readManagedProviders().find((p) => p.id === id)
  if (!entry) throw new Error(`${id} 不在注册表里`)
  const key = resolveEnvKey(entry.keyRef, DSH_CREDENTIALS_PATH)
  if (!key) throw new Error(`凭据 ${entry.keyRef} 不在环境或 .credentials.yaml 里`)
  // preset 条目经共用接缝重建（与 provider-test 同参）：fallbackModels/
  // staticCatalog 与档位声明（modelEfforts/reasoningCompat）一起合并 ⇒ 无
  // /models 或静态目录上游刷新 = 探针复验 + 沿用兜底/内置清单 + **档位声明
  // 不丢**（providerBlock 按模型 id 重新合并）。0.19.0 修：此前此处裸调
  // createOpenAICompatProvider 漏传声明字段，每次刷新洗掉「推理等级」档位表。
  const presetHit = PROVIDER_PRESETS.find((p) => p.id === entry.preset)
  const adapter = rebuildAdapterForEntry(entry, presetHit)
  const models = await adapter.fetchModels(key)
  await writeProviderBlock(id, adapter.modelBlock(models))
  return { id, modelCount: models.length }
}

/** 设置卡视图：登记册 × settings.yaml 实况对账（外部删块 → 自动出册）。 */
export function extraProvidersView() {
  const providers = readSettingsProviders()
  const stale = []
  const list = []
  for (const p of readManagedProviders()) {
    const block = providers[p.id]
    if (!block) {
      stale.push(p.id)
      continue
    }
    const key = resolveEnvKey(p.keyRef, DSH_CREDENTIALS_PATH)
    list.push({
      id: p.id,
      displayName: typeof block.displayName === 'string' ? block.displayName : p.displayName,
      baseURL: typeof block.baseURL === 'string' ? block.baseURL : p.baseURL,
      preset: p.preset,
      keyRef: p.keyRef,
      maskedKey: key ? maskKey(key) : null,
      modelCount: Array.isArray(block.models) ? block.models.length : 0,
    })
  }
  if (stale.length) {
    writeManagedProviders(readManagedProviders().filter((p) => !stale.includes(p.id)))
  }
  return list
}
