/**
 * host/providers/instances.js — 三个 provider 单例与**凭据编排**（0.25.0 从 index.js 拆出）。
 *
 * 这里回答一个问题：一次出站调用该用哪把凭据、按什么顺序试。
 *  - codebuddy：api-key 模式多 key 轮询（冷却/故障转移在 core/rotation），
 *    OAuth 模式单候选不轮换；
 *  - trae/qoder：OAuth 单候选，空候选错误带 `credentialUnavailable` 稳定标记
 *    （调用方按标记分支，不靠中文文案匹配，踩坑 #7/#77）。
 *
 * 为什么单例留在模块层：`apply()` 每代都要用同一批实例（宿主重载会重跑 apply，
 * 但 provider 内部的令牌/目录缓存要跨代继续有效）；设置解析走 `settingsRef`
 * 迟绑定，由 apply 每代重设。
 *
 * 依赖方向：本模块 → config / core / providers/**；**不 import host/models、
 * host/settings**（上层模块 import 本模块，反向即环）。
 */

import { join } from 'node:path'

import { readJson, writeJson, resolveEnvKey } from '../../core/json-store.js'
import { KeyRotator } from '../../core/rotation.js'
import { createUsageMeter } from '../../core/usage-meter.js'
import { createCodeBuddyProvider } from '../../providers/codebuddy/index.js'
import { CREDENTIAL_UNAVAILABLE_MESSAGE } from '../../providers/codebuddy/errors.js'
import { createTraeProvider } from '../../providers/trae/index.js'
import { TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE } from '../../providers/trae/errors.js'
import { createQoderProvider } from '../../providers/qoder/index.js'
import {
  DSH_HOME, DSH_CREDENTIALS_PATH, AUTH_PATH, TRAE_AUTH_PATH, QODER_AUTH_PATH,
  readAuth, writeAuth, settingsRef,
} from '../config.js'
import { traeRuntime, qoderRuntime } from '../runtime.js'

export const NO_CHANNEL_RETRY_POLICY = Object.freeze({ mode: 'normal', maxRetries: 0 })
export const QUEUE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2880,
  retryableCodes: Object.freeze(['RATE_LIMIT']),
  backoff: Object.freeze({ initialDelayMs: 30000, maxDelayMs: 30000, jitterRatio: 0 }),
})


// ---------------------------------------------------------------------------
// Credential composition (core rotation engine + provider OAuth flow).
// api-key mode: apiKeys list > legacy env ref; ≥2 keys round-robin with
// cooldown failover. OAuth: single candidate, never rotated.
// ---------------------------------------------------------------------------

/** Legacy single-key path: process env, then ~/.dsh/.credentials.yaml. */
export const envKey = (envName) => resolveEnvKey(envName, join(DSH_HOME, '.credentials.yaml'))

export const rotator = new KeyRotator()
export const meter = createUsageMeter({ path: join(DSH_HOME, 'codebuddy-plugin-usage.json') })

/**
 * The provider instance for this module instance. `withKeyRotation` /
 * `resolveCredential` are late-bound arrows over the hoisted function
 * declarations below — the provider needs them for outbound calls, they need
 * the provider for the OAuth branch; this is the deliberate cycle break.
 */
export const provider = createCodeBuddyProvider({
  meter,
  readAuth,
  writeAuth,
  envKey,
  withKeyRotation: (settings, attempt) => withKeyRotation(settings, attempt),
  resolveCredential: (settings) => resolveCredential(settings),
  effortWireFor: (model) => wireRef.effort(model),
  dshHome: DSH_HOME,
})

export const makeSearchProvider = provider.makeSearchProvider

/**
 * Resolve the credential every outbound call should use (no rotation —
 * the catalog/quota dialect endpoints authenticate by raw key).
 * @returns {Promise<{authorization: string, headers: Record<string,string>} | null>}
 */
export async function resolveCredential(settings) {
  const s = settings()
  if (s.authMode === 'oauth') return provider.oauth.resolveOAuthCredential(s)
  // api-key mode: the active list entry wins, legacy env ref is the fallback.
  const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
  const key = active?.key ?? envKey(s.apiKeyEnv)
  if (!key) return null
  return { authorization: `Bearer ${key}`, headers: {} }
}

/**
 * Credential candidates for one outbound call, in try order.
 * OAuth: zero or one candidate (rotation deliberately not applied).
 * api-key: 0 keys → the legacy env ref (single candidate); 1 key → that key;
 * ≥2 keys → every key exactly once, non-cooling first in round-robin order,
 * cooling keys appended as last resort.
 */
export async function resolveCredentialCandidates(settings) {
  const s = settings()
  if (s.authMode === 'oauth') {
    const single = await provider.oauth.resolveOAuthCredential(s)
    return single ? [{ ...single, keyName: null }] : []
  }
  const keys = (s.apiKeys ?? []).filter((k) => typeof k?.key === 'string' && k.key.length > 0)
  if (keys.length === 0) {
    const env = envKey(s.apiKeyEnv)
    return env ? [{ authorization: `Bearer ${env}`, headers: {}, keyName: null }] : []
  }
  if (keys.length === 1) {
    return [{ authorization: `Bearer ${keys[0].key}`, headers: {}, keyName: keys[0].name }]
  }
  return rotator.ordered(keys)
}

/**
 * Run `attempt(cred)` over the rotation candidates with failover (see
 * core/rotation.js). The empty-candidate error is flagged
 * `credentialUnavailable` so the bridge/provider layers recognize it without
 * matching on the message text (the text itself stays for users).
 */
export async function withKeyRotation(settings, attempt) {
  const candidates = await resolveCredentialCandidates(settings)
  const emptyError = new Error(CREDENTIAL_UNAVAILABLE_MESSAGE)
  emptyError.credentialUnavailable = true
  return rotator.run(candidates, attempt, {
    cooldownMs: settings().keyCooldownMs,
    emptyError,
  })
}

// ---------------------------------------------------------------------------
// TraeWork CN 通道（v0.8.x）：第二上游 = OAuth 订阅额度 + 私有协议翻译网关。
// 凭据只有 OAuth 一支（Trae 订阅跟账号走）；设备密钥自持（providers/trae/
// oauth.js）。模型目录来自本机 state.vscdb（提取器纯函数复用），镜像进
// settings.yaml 的 llm-pi-ai.providers.trae.models——patch 层只带路由不带
// 模型，清单永远由镜像独占（无"陈旧遮蔽"问题，纯净态=删镜像路径）。
// ---------------------------------------------------------------------------

export const readTraeAuth = () => readJson(TRAE_AUTH_PATH)
export const writeTraeAuth = (v) => writeJson(TRAE_AUTH_PATH, v)

/** Trae 凭据候选（OAuth 单候选，无轮换）；空候选错误带稳定标记。 */
export async function withTraeCredentials(settingsFn, attempt) {
  const s = settingsFn()
  let cred = null
  try {
    cred = await traeProvider.oauth.resolveTraeCredential(s)
  } catch (err) {
    const e = new Error(`trae credential error: ${err?.message ?? err}`)
    e.credentialUnavailable = true
    return { cred: null, res: null, err: e }
  }
  if (!cred) {
    const e = new Error(TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE)
    e.credentialUnavailable = true
    return { cred: null, res: null, err: e }
  }
  try {
    const res = await attempt(cred)
    return { cred, res, err: null }
  } catch (err) {
    return { cred, res: null, err }
  }
}

// 迟绑定：网关需要"本代"的 settings 解析函数；apply() 每代重设该模块级
// 变量（与 codebuddy 侧 hoisted 函数的迟绑定等价，形态不同只因工厂签名）。

export const traeProvider = createTraeProvider({
  readAuth: readTraeAuth,
  writeAuth: writeTraeAuth,
  settings: () => settingsRef.trae(),
  withCredentials: (attempt) => withTraeCredentials(() => settingsRef.trae(), attempt),
  meter,
  runtime: traeRuntime,
  forensics: { logPath: () => process.env.TRAE_BRIDGE_LOG },
  getModelPrefs: () => prefsRef.trae(),
})

// ---------------------------------------------------------------------------
// Qoder CN 通道（2026-09-19 Phase 1 登录；2026-09-20 Phase 2 聊天面打通）：
// 设备流 OAuth（凭据存 ~/.dsh/qoder-plugin-auth.json）+ COSY WASM 签名
// （providers/qoder/cosy.js）+ 翻译网关（OpenAI↔COSY SSE 信封）+ 网关目录
// 镜像 providers.qoder 整块（路由存在性管理，同 trae 踩坑 #25 纪律）。
// ---------------------------------------------------------------------------

export const readQoderAuth = () => readJson(QODER_AUTH_PATH)
export const writeQoderAuth = (v) => writeJson(QODER_AUTH_PATH, v)

// 迟绑定：网关/目录需要"本代"的 settings 解析函数；apply() 每代重设。

export const qoderProvider = createQoderProvider({
  readAuth: readQoderAuth,
  writeAuth: writeQoderAuth,
  settings: () => settingsRef.qoder(),
  meter,
  runtime: qoderRuntime,
  forensics: { logPath: () => process.env.QODER_GATEWAY_LOG },
  getModelPrefs: () => prefsRef.qoder(),
})

/**
 * 逐模型思考档位**线值**的迟绑定槽：读侧在 host/models/state.js（它读设置层的
 * `effortByModel` 与目录声明）。为什么用槽而不是 import：本模块是 providers 层，
 * 不许反向依赖 models 层（`scripts/verify-host-split.mjs` 锁方向）；组合根装配时
 * 把函数指针填进来即可。
 */
export const wireRef = {
  effort: () => undefined,
}

/**
 * 测试接缝（scripts/verify-rotation.mjs）：轮换游标/冷却表是单例状态，
 * 组合根拆分后 `?case=` 复制的是 index.js，复制不了本模块——用例之间显式清空。
 * 生产路径不调用（清空 ≈ 重启插件，没有运行时语义）。
 */
export function resetRotationForTests() {
  rotator.reset()
}

/**
 * 逐模型思考档位偏好的**迟绑定槽**：读侧在 host/models/channel-models.js
 * （它 import 本模块拿 provider），故这里只留函数指针，由组合根装配时填。
 */
export const prefsRef = {
  qoder: () => ({}),
  trae: () => ({}),
}
