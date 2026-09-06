#!/usr/bin/env node
/**
 * Offline regression for providers/openai-compat.js (G6/G7 shared skeleton):
 *
 *   1. primary path: GET /models works → real catalog returned
 *   2. /models 401 (bad key) → throws, NOT tagged MODELS_ENDPOINT_404
 *   3. /models 404 without fallbackModels → error propagates (strict custom)
 *   4. /models 404 + fallbackModels + good key → chat probe ok → fallback list
 *   5. /models 404 + fallbackModels + bad key (std 401 invalid_api_key) → throws
 *   6. iFlow dialect: 200 + {"status":"434"} → auth fail; 200 + choices → ok
 *   7. providerBlock shape (apiKeyEnv convention)
 *   8. shipped presets: iflow/qwen carry fallbackModels, ark/bailian don't
 *
 * Usage: node scripts/verify-providers.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'

import { PROVIDER_ID_RE, keyRefFor, fetchOpenAIModels, probeChatKey, providerBlock, createOpenAICompatProvider } from '../providers/openai-compat.js'
import ark from '../providers/ark/index.js'
import bailian from '../providers/bailian/index.js'
import iflow from '../providers/iflow/index.js'
import qwen from '../providers/qwen/index.js'

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** Spin up a mock upstream; routes: { models: [status, body], chat: (req, body) => [status, body] }. */
function mockUpstream(routes) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const hit = req.url.endsWith('/models') ? routes.models
        : req.url.endsWith('/chat/completions') ? (typeof routes.chat === 'function' ? routes.chat(req, raw) : routes.chat)
        : null
      if (!hit) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(hit[0], { 'content-type': 'application/json' })
      res.end(typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` })
  }))
}

const GOOD = 'sk-good-key'

// 1–3: /models behavior variants
{
  const { server, base } = await mockUpstream({
    models: [200, { object: 'list', data: [{ id: 'm-a' }, { id: 'm-b', name: 'B' }] }],
    chat: [200, { choices: [] }],
  })
  const models = await fetchOpenAIModels(base, GOOD)
  check('1 GET /models 主路径返回真实目录', models.length === 2 && models[0].id === 'm-a' && models[1].id === 'm-b', JSON.stringify(models))
  server.close()
}
{
  const { server, base } = await mockUpstream({ models: [401, { error: { message: 'bad key' } }], chat: [200, {}] })
  const err = await fetchOpenAIModels(base, 'sk-bad').then(() => null, (e) => e)
  check('2 /models 401 抛错且不带 404 标记', !!err && err.code !== 'MODELS_ENDPOINT_404' && /401/.test(err.message), String(err))
  server.close()
}
{
  const { server, base } = await mockUpstream({ models: [404, 'nf'], chat: [200, { choices: [] }] })
  const strict = createOpenAICompatProvider({ id: 'strict', displayName: 'Strict', baseURL: base })
  const err = await strict.fetchModels(GOOD).then(() => null, (e) => e)
  check('3 无 fallbackModels 时 /models 404 原样抛出（custom 严格）', err?.code === 'MODELS_ENDPOINT_404', String(err))
  server.close()
}

// 4–5: fallback path, standard auth dialect
{
  const { server, base } = await mockUpstream({
    models: [404, 'nf'],
    chat: (req) => (req.headers.authorization === `Bearer ${GOOD}`
      ? [200, { choices: [{ message: { content: 'p' } }], usage: { total_tokens: 1 } }]
      : [401, { error: { code: 'invalid_api_key', message: 'invalid access token or token expired' } }]),
  })
  const adapter = createOpenAICompatProvider({ id: 'fb', displayName: 'FB', baseURL: base, fallbackModels: ['fb-pro', 'fb-lite'] })
  const models = await adapter.fetchModels(GOOD)
  check('4 /models 404 + 好 key：探针通过，吃兜底清单', models.length === 2 && models[0].id === 'fb-pro', JSON.stringify(models))
  const err = await adapter.fetchModels('sk-bad').then(() => null, (e) => e)
  check('5 /models 404 + 坏 key（401 invalid_api_key）：拒绝', !!err && /认证拒绝|401/.test(err.message), String(err))
  server.close()
}

// 6: iFlow dialect (HTTP 200 + status 434)
{
  const { server, base } = await mockUpstream({
    models: [404, 'nf'],
    chat: (req) => (req.headers.authorization === `Bearer ${GOOD}`
      ? [200, { status: '200', body: { choices: [{ message: { content: 'p' } }] } }]
      : [200, { status: '434', msg: 'Invalid apiKey，get your apiKey', body: null }]),
  })
  const adapter = createOpenAICompatProvider({ id: 'iflowish', displayName: 'IF', baseURL: base, fallbackModels: ['if-a'] })
  const err = await adapter.fetchModels('sk-bad').then(() => null, (e) => e)
  check('6a iFlow 方言坏 key（200+status 434）：拒绝', !!err && /认证拒绝/.test(err.message), String(err))
  const models = await adapter.fetchModels(GOOD)
  check('6b iFlow 方言好 key（200+choices）：通过', models.length === 1 && models[0].id === 'if-a', JSON.stringify(models))
  // probeChatKey 直连形态也锁一下（网络错误之外的判定都在这层）。
  await probeChatKey(base, GOOD, 'if-a')
  check('6c probeChatKey 好 key 不抛', true)
  server.close()
}

// 7: providerBlock shape
{
  const block = providerBlock({ id: 'mock-up', displayName: 'Mock', baseURL: 'http://x/v1' }, [{ id: 'm1' }, { id: 'm2', name: 'N' }])
  check('7 providerBlock：apiKeyEnv 惯例 + 模型形状',
    block.api === 'openai-completions' && block.apiKeyEnv === 'MOCK_UP_API_KEY'
      && block.models.length === 2 && block.models[1].name === 'N' && !('name' in block.models[0]),
    JSON.stringify(block))
  check('7b keyRefFor / PROVIDER_ID_RE 不变', keyRefFor('ark') === 'ARK_API_KEY' && PROVIDER_ID_RE.test('a-1') && !PROVIDER_ID_RE.test('Bad'))
}

// 8: shipped presets
{
  check('8a ark/bailian 无兜底（有真 /models）', ark.fallbackModels.length === 0 && bailian.fallbackModels.length === 0)
  check('8b iflow/qwen 带兜底清单且首项可作探针模型',
    iflow.fallbackModels.length >= 2 && qwen.fallbackModels.length >= 1
      && typeof iflow.fallbackModels[0] === 'string' && typeof qwen.fallbackModels[0] === 'string')
  check('8c preset baseURL 不被意外改动',
    ark.baseURL === 'https://ark.cn-beijing.volces.com/api/v3'
      && bailian.baseURL === 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      && iflow.baseURL === 'https://apis.iflow.cn/v1'
      && qwen.baseURL === 'https://portal.qwen.ai/v1')
}

console.log(failures ? `\n${failures} FAIL` : '\nall green')
process.exit(failures ? 1 : 0)
