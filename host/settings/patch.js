/**
 * host/settings/patch.js — 设置路由的 **patch 分支**（0.25.0 从 index.js 拆出）。
 *
 * 两类 patch：①模型/通道类（modelSetEnabled / traeModelSetPrefs / …）走各自 setter，
 * 再 `commitPatch` 重读文件层并只在凭据真被改动时回写凭据组（并发保存不丢 key）；
 * ②通用设置 patch 按 `SETTINGS_FIELDS` 白名单落文件层，经 `Config` 校验 + baseURL
 * 安全校验后 `applyLive()`。
 *
 * 顺序纪律（踩坑 #76）：**副作用先于响应**——`applyLive()` 抛错时外层 catch 还能
 * 如实回 400，而不是先发 200 再撞 `ERR_HTTP_HEADERS_SENT`。
 */

import { describeError } from '../../core/errors.js'
import { Config, SETTINGS_FIELDS, readFileLayer, writeFileLayer, validateBaseURL } from '../config.js'
import { maskedUserLayer } from '../redact.js'
import { setModelEnabled, setModelLimits } from '../models/mirror.js'
import {
  setTraeModelEnabled, setTraeModelPrefs, setQoderModelEnabled, setQoderModelPrefs,
} from '../models/channels.js'
import { readManualCredits, setManualCredits, creditsView } from '../models/state.js'
import { settingsView } from './view.js'

/**
 * 模型/偏好类 patch 的公共收尾：重读文件层 → **仅在本次请求确实改动过 apiKeys 时**
 * 把凭据组写回 → 落盘。
 *
 * 为什么不能无条件回写：`nextUser` 是本请求进 handler 时的层快照，而模型类 setter
 * 内部还有一次 await 写盘；两次并发保存（四区块可同时展开，是正常路径）时，先发
 * 请求的旧快照会把后发请求刚加的 key 覆盖掉——静默丢凭据。
 */
function commitPatch({ nextUser, patch }) {
  const keysTouched = patch?.apiKeysAdd !== undefined || patch?.apiKeysRemove !== undefined
  const after = readFileLayer()
  if (keysTouched) {
    after.apiKeys = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
    if (nextUser.activeApiKey === undefined) delete after.activeApiKey
    else after.activeApiKey = nextUser.activeApiKey
  }
  writeFileLayer(after)
  return after
}

/**
 * @param {{ applyLive: () => void, resolveNow: () => object, entryConfig: object }} deps
 * @returns {(body: object, reply: (status: number, payload: object) => void) => Promise<void>}
 */
export function createPatchHandler({ applyLive, resolveNow, entryConfig }) {
  return async (body, reply) => {
    const patch = body?.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('body must be {patch} or {action}')
    }
    const nextUser = { ...readFileLayer() }
    // Key-list operations run against the stored raw list — the card
    // only ever sees masked keys, so adds/removes must resolve here.
    if (patch.apiKeysAdd !== undefined) {
      const entry = patch.apiKeysAdd
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string'
        || typeof entry.key !== 'string' || !entry.name.trim() || !entry.key.trim()) {
        throw new Error('apiKeysAdd 需要 {name, key}')
      }
      const name = entry.name.trim()
      const key = entry.key.trim()
      const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
      nextUser.apiKeys = list.filter((k) => k?.name !== name).concat([{ name, key }])
      if (!nextUser.activeApiKey) nextUser.activeApiKey = name
    }
    if (patch.apiKeysRemove !== undefined) {
      if (typeof patch.apiKeysRemove !== 'string') throw new Error('apiKeysRemove 需要名称字符串')
      const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
      nextUser.apiKeys = list.filter((k) => k?.name !== patch.apiKeysRemove)
      if (nextUser.activeApiKey === patch.apiKeysRemove) delete nextUser.activeApiKey
    }
    if (patch.modelSetEnabled !== undefined) {
      // Runs against modelState inside setModelEnabled; re-read the
      // layer afterwards so apiKeys edits above are not clobbered.
      await setModelEnabled(patch.modelSetEnabled)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        models: settingsView(resolveNow).models,
      })
      return
    }
    if (patch.modelSetLimits !== undefined) {
      // G5：同 modelSetEnabled 的层叠纪律——setModelLimits 内部自写
      // modelState，事后重读层并把本请求里的 apiKeys 改动合回。
      await setModelLimits(patch.modelSetLimits)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        models: settingsView(resolveNow).models,
      })
      return
    }
    if (patch.traeModelSetEnabled !== undefined) {
      await setTraeModelEnabled(patch.traeModelSetEnabled)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        trae: settingsView(resolveNow).trae,
      })
      return
    }
    if (patch.traeModelSetPrefs !== undefined) {
      // 同 traeModelSetEnabled 的层叠纪律：setTraeModelPrefs 内部自写
      // traeModelPrefs，事后重读层并把本请求里的 apiKeys 改动合回。
      await setTraeModelPrefs(patch.traeModelSetPrefs)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        trae: settingsView(resolveNow).trae,
      })
      return
    }
    if (patch.qoderModelSetEnabled !== undefined) {
      await setQoderModelEnabled(patch.qoderModelSetEnabled)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        qoder: settingsView(resolveNow).qoder,
      })
      return
    }
    if (patch.qoderModelSetPrefs !== undefined) {
      // 同 qoderModelSetEnabled 的层叠纪律：setQoderModelPrefs 内部自写
      // qoderModelPrefs，事后重读层并把本请求里的 apiKeys 改动合回。
      await setQoderModelPrefs(patch.qoderModelSetPrefs)
      const after = commitPatch({ nextUser, patch })
      // 副作用先于响应：applyLive 抛错时外层 catch 还能如实回 400。
      applyLive()
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        qoder: settingsView(resolveNow).qoder,
      })
      return
    }
    if (patch.manualCreditsSet !== undefined) {
      // 手填积分倍率：纯展示字段（不进宿主配置层、不参与任何镜像），
      // 故刻意不调 applyLive——那会白跑一遍五个 gateway sync。
      await setManualCredits(patch.manualCreditsSet)
      const after = commitPatch({ nextUser, patch })
      reply(200, {
        ok: true,
        value: settingsView(resolveNow).value,
        user: maskedUserLayer(after),
        manualCredits: readManualCredits(),
        // 合并表回带：输入框选择器的徽标据此当场更新（不必刷新页面）。
        credits: creditsView(),
      })
      return
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'apiKeysAdd' || key === 'apiKeysRemove') continue
      // Whitelist by SETTINGS_FIELDS, not Config({}) keys: fields
      // without a schema default (activeApiKey) vanish from a bare
      // Config({}) resolution and were silently dropped here.
      if (!SETTINGS_FIELDS.some((f) => f.key === key)) continue
      if (value === null) delete nextUser[key]
      else nextUser[key] = value
    }
    // Validate through the schema before persisting.
    const candidate = Config({ ...entryConfig, ...nextUser })
    validateBaseURL(candidate.baseURL)
    for (const f of ['traeAuthBaseURL', 'traeChatBaseURL', 'traeLoginHost', 'qoderLoginHost', 'qoderOpenapiBaseURL', 'qoderInferBaseURL']) {
      validateBaseURL(candidate[f])
    }
    const resolved = candidate
    if (resolved.activeApiKey && !resolved.apiKeys.some((k) => k.name === resolved.activeApiKey)) {
      throw new Error('activeApiKey 不在 apiKeys 列表中')
    }
    // 副作用先于响应：`applyLive()`/视图计算抛错时还能如实回 400，
    // 而不是先发 200 再在 catch 里撞 ERR_HTTP_HEADERS_SENT。
    writeFileLayer(nextUser)
    applyLive()
    reply(200, { ok: true, value: settingsView(resolveNow).value, user: maskedUserLayer(nextUser) })
  }
}
