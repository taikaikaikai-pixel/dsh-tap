/**
 * providers/codebuddy/images.js — dsh 原生 `image_generate` 工具的
 * CodeBuddy 后端：POST /v2/images/generations（2026-08-17 探测可用，
 * hunyuan-image-v3.0-art 约 22s/张）。
 *
 * 路由事实（docs/rules/routing.md）：/v2/3d/generations 路由形状存在但
 * 当前账号无 3D 模型注册（14407 "route config not found"，注册表层拒绝）
 * ——3D 记为不可用，不接入。
 *
 * 计量说明：images 响应体的 usage 字段**未经探测证伪**（quota 探测只覆盖
 * agenttool），按咒语红线保留原计量路径，不删不改。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CREDENTIAL_UNAVAILABLE_MESSAGE } from './errors.js'

/**
 * @param {{ withKeyRotation: Function, meter: { record: Function }, dshHome: string }} deps
 */
export function createImageTool({ withKeyRotation, meter, dshHome }) {
  /** Where generated images land: the session workspace when the agent loop
   * exposes one, else <dshHome>/generated-images. */
  function resolveImageSaveDir(exec) {
    const a = exec?.agent
    const dir = a?.workspaceDir ?? a?.workDir ?? a?.cwd ?? a?.workspace?.dir ?? null
    return dir && typeof dir === 'string'
      ? join(dir, 'generated-images')
      : join(dshHome, 'generated-images')
  }

  /** dsh tool definition for `image_generate` (plain object — the plugin must
   * not import @deepseek-ai/*; the registry accepts the structural shape). */
  function makeImageGenTool(settings) {
    return {
      name: 'image_generate',
      description:
        'Generate an image from a text prompt (CodeBuddy hunyuan-image backend). ' +
        'Returns the local file path of the saved image and its source URL. ' +
        'Takes ~20s per image; one image per call.',
      // Schemas here are FINAL JSON Schema (the registry's defineTool shorthand
      // converter is not importable from a plugin — see docs/pitfalls.md #9).
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'What to draw; be concrete about subject, style, and colors.' },
          size: { type: 'string', description: 'WxH pixels, e.g. "1024x1024" (default), "768x768", "1280x720".' },
        },
        required: ['prompt'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            url: { type: 'string' },
            model: { type: 'string' },
            ms: { type: 'number' },
          },
          required: ['path', 'model', 'ms'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `image generated (${value.model}, ${(value.ms / 1000).toFixed(1)}s)\nsaved: ${value.path}\nsource: ${value.url ?? 'n/a'}`,
        }],
      },
      // Generation measured at ~22s end-to-end; keep headroom for slow runs.
      timeoutMs: 180_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
        if (!prompt) throw new Error('image_generate: prompt 不能为空')
        const size = typeof args?.size === 'string' && /^\d{3,4}x\d{3,4}$/.test(args.size)
          ? args.size : '1024x1024'
        const s = settings()
        const t0 = Date.now()
        const { res, err } = await withKeyRotation(settings, (cred) => fetch(`${s.baseURL}/v2/images/generations`, {
          method: 'POST',
          signal: exec?.signal,
          headers: {
            Authorization: cred.authorization,
            ...cred.headers,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ model: s.imageGenModel, prompt, size, n: 1 }),
        }))
        if (err) {
          if (err.message === CREDENTIAL_UNAVAILABLE_MESSAGE) throw err
          if (exec?.signal?.aborted) throw err
          const causes = []
          for (let e = err; e; e = e.cause) causes.push(e.code ?? e.message ?? String(e))
          throw new Error(`image_generate network error: ${causes.join(' ← ')}`)
        }
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(`image_generate HTTP ${res.status}${body?.code != null ? ` code ${body.code}: ${body.msg ?? ''}` : ''}`)
        }
        if (!body || body.code !== 0) {
          throw new Error(`image_generate error ${body?.code ?? '?'}: ${body?.msg ?? 'empty or malformed response'}`)
        }
        if (body.data?.usage) meter.record({ ts: t0, kind: 'image', model: s.imageGenModel, usage: body.data.usage })
        const item = body.data?.data?.[0]
        const url = typeof item?.url === 'string' ? item.url : null
        const b64 = typeof item?.b64_json === 'string' ? item.b64_json : null
        if (!url && !b64) throw new Error('image_generate: 响应既无 url 也无 b64_json')
        const dir = resolveImageSaveDir(exec)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `image-${t0}.png`)
        if (url) {
          const img = await fetch(url, { signal: exec?.signal })
          if (!img.ok) throw new Error(`image_generate: 下载图片失败 HTTP ${img.status}`)
          writeFileSync(file, Buffer.from(await img.arrayBuffer()))
        } else {
          writeFileSync(file, Buffer.from(b64, 'base64'))
        }
        return { path: file, url: url ?? undefined, model: s.imageGenModel, ms: Date.now() - t0 }
      },
    }
  }

  return { makeImageGenTool }
}
