/**
 * scripts/verify-protocols.mjs — 两个本机客户端协议面（Anthropic Messages /
 * OpenAI Responses）的离线断言。
 *
 * 纪律（与仓库其余 verify 套件一致）：**不碰真实上游、不碰用户配置**——用
 * `createLoopbackGateway` 起一个临时端口（`listen(0)`），注入一个桩 `handleChat`
 * 扮演「本通道内部 OpenAI chat 面」，记录它收到的内部 payload 并回放一段固定的
 * 内部 OpenAI SSE。于是同一套断言同时覆盖：
 *   - 协议请求 → 内部 chat payload 的映射（上游只支持流式，断言 stream:true）；
 *   - 内部 chunk → 协议 SSE 事件序列与顺序；
 *   - 非流式聚合结果形状（上游仅流式，非流式面必须由我们聚合）；
 *   - 工具调用往返（tool_use/tool_result ↔ tool_calls；function_call items）；
 *   - 上游错误 → 协议化错误映射（HTTP 状态 + 信封 + 原因）；
 *   - 共享骨架的 Host/Origin 双门与 413 收体上限仍生效；
 *   - 既有 /v1/chat/completions 与 GET /v1/models 路由零回归。
 *
 * 运行：node scripts/verify-protocols.mjs
 */

import { request } from 'node:http'

import { createLoopbackGateway } from '../providers/loopback-gateway.js'
import { anthropicToChat } from '../providers/protocols/anthropic-messages.js'
import { responsesToChat } from '../providers/protocols/openai-responses.js'

let passed = 0
const failures = []

function ok(cond, label) {
  if (cond) { passed++; return }
  failures.push(label)
  console.error(`✗ ${label}`)
}
function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简 HTTP 客户端：能自定义 Host/Origin（undici fetch 不允许改 Host）。 */
function httpRequest({ port, path, method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** SSE 文本 → [{event, data}]（具名事件两个协议面都用）。 */
function parseSse(text) {
  const frames = []
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue
    let event = null
    let data = null
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim()
        try { data = JSON.parse(raw) } catch { data = raw }
      }
    }
    if (event) frames.push({ event, data })
  }
  return frames
}

const json = (obj) => JSON.stringify(obj)

// ---------------------------------------------------------------------------
// 桩：本通道内部 OpenAI chat 面
// ---------------------------------------------------------------------------

/** 场景由最后一条 user 文本里的 [[scenario:x]] 标记选择。 */
function detectScenario(payload) {
  const m = json(payload?.messages ?? []).match(/\[\[scenario:([a-z0-9-]+)\]\]/)
  return m ? m[1] : 'text'
}

function makeStub(records) {
  return async function handleChat(req, res, rawBody) {
    let payload = null
    try { payload = JSON.parse(rawBody) } catch { payload = null }
    records.push({ payload, headers: req.headers })
    const scenario = detectScenario(payload)
    if (scenario === 'status-503') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(json({ error: { message: 'CodeBuddy/Trae/Qoder 未登录：请先完成授权', code: 'credential_unavailable' } }))
      return
    }
    if (scenario === 'status-400-numeric') {
      // CodeBuddy 网关的码方言是**数字**（providers/codebuddy/errors.js：11102 等），
      // 另两通道是字符串。协议信封的 code 是字符串字段，数字码若不归一就会丢成 null。
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(json({ error: { message: 'service info not found', code: 11102 } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (o) => res.write(`data: ${json(o)}\n\n`)
    if (scenario === 'error-stream') {
      chunk({ error: { message: 'upstream exploded mid-stream', code: 'upstream_boom' } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: payload?.model ?? 'test-model' }
    chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] })
    if (scenario === 'error-after-text') {
      // 已下发用户可见内容后再出错：提交判据（踩坑 #60）不允许再改答 JSON 错误。
      chunk({ ...base, choices: [{ index: 0, delta: { content: 'Partial' } }] })
      chunk({ error: { message: 'upstream died after first token', code: 'upstream_boom' } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (scenario === 'error-after-text-numeric') {
      // 流内错误事件的 code 也走码方言归一（CodeBuddy 数字码 → 字符串）。
      chunk({ ...base, choices: [{ index: 0, delta: { content: 'Partial' } }] })
      chunk({ error: { message: 'numeric code boom', code: 11102 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (scenario === 'tools-interleaved') {
      // 并行工具调用：两块同时声明，随后参数增量跨索引交错（OpenAI 方言允许）。
      // Anthropic 同一时刻只许一个块开着，translator 必须缓存参数、整块下发。
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"a"' } },
        { index: 1, id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"b"' } },
      ] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':2}' } }] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (scenario === 'length') {
      // max_output_tokens 截断：Responses 的协议终态事件是 response.incomplete。
      chunk({ ...base, choices: [{ index: 0, delta: { content: 'Truncated' } }] })
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (scenario === 'tools') {
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] })
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
    } else {
      chunk({ ...base, choices: [{ index: 0, delta: { content: 'Hello' } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { reasoning_content: 'secret-thoughts' } }] })
      chunk({ ...base, choices: [{ index: 0, delta: { content: ' world' } }] })
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

async function startGateway({ bodyLimitBytes } = {}) {
  const runtime = { running: false, port: null, lastError: null }
  const records = []
  const gw = createLoopbackGateway({
    runtime,
    logPrefix: '[verify-protocols]',
    unavailableNote: '',
    listModelIds: () => ['test-model', 'glm-5.3'],
    handleChat: makeStub(records),
    ...(bodyLimitBytes ? { bodyLimitBytes } : {}),
  })
  const stop = gw.listen(0)
  for (let i = 0; i < 300 && !runtime.running; i++) await delay(10)
  if (!runtime.running) throw new Error(`gateway did not listen: ${runtime.lastError}`)
  return { runtime, records, stop, port: runtime.port }
}

const post = (port, path, body, headers = {}) => httpRequest({
  port, path, method: 'POST',
  headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : json(body),
})

// ---------------------------------------------------------------------------
// 1) Anthropic 请求 → 内部 chat payload 映射
// ---------------------------------------------------------------------------

const gw = await startGateway()
const P = gw.port

const anthropicBody = {
  model: 'glm-5.3',
  system: [{ type: 'text', text: 'be brief' }],
  max_tokens: 128,
  temperature: 0.5,
  stop_sequences: ['STOP'],
  metadata: { user_id: 'u-1' },
  tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  tool_choice: { type: 'tool', name: 'get_weather' },
  messages: [
    { role: 'user', content: 'hi [[scenario:tools]]' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":21}' }, { type: 'text', text: 'thanks' }] },
  ],
  stream: true,
}
{
  const res = await post(P, '/v1/messages', anthropicBody, { 'x-session-id': 'sess-1' })
  eq(res.status, 200, '[1] anthropic stream status')
  const up = gw.records.at(-1).payload
  eq(up.stream, true, '[1] 内部面恒流式（上游仅支持流式）')
  eq(up.model, 'glm-5.3', '[1] model 透传')
  eq(up.max_tokens, 128, '[1] max_tokens 透传')
  eq(up.temperature, 0.5, '[1] temperature 透传')
  eq(up.stop, ['STOP'], '[1] stop_sequences → stop')
  eq(up.user, 'u-1', '[1] metadata.user_id → user')
  eq(up.messages[0], { role: 'system', content: 'be brief' }, '[1] system 块数组 → system 消息')
  eq(up.messages[1], { role: 'user', content: 'hi [[scenario:tools]]' }, '[1] 串 content 原样')
  eq(up.messages[2].role, 'assistant', '[1] tool_use → assistant')
  eq(up.messages[2].tool_calls[0].id, 'toolu_1', '[1] tool_use.id → tool_calls[].id')
  eq(up.messages[2].tool_calls[0].function.name, 'get_weather', '[1] tool_use.name → function.name')
  eq(up.messages[2].tool_calls[0].function.arguments, '{"city":"Paris"}', '[1] tool_use.input → arguments JSON')
  eq(up.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '{"temp":21}' }, '[1] tool_result → role:tool（先于同消息文本）')
  eq(up.messages[4], { role: 'user', content: 'thanks' }, '[1] tool_result 后的文本留在 user')
  eq(up.tools[0].function.name, 'get_weather', '[1] tools[].input_schema → function.parameters')
  eq(up.tools[0].function.parameters.properties.city.type, 'string', '[1] input_schema 结构保留')
  eq(up.tool_choice, { type: 'function', function: { name: 'get_weather' } }, '[1] tool_choice {type:tool} 映射')
  eq(gw.records.at(-1).headers['x-session-id'], 'sess-1', '[1] 会话亲和头原样到达内部面')
}

// ---------------------------------------------------------------------------
// 2) Anthropic 流式 SSE 事件序列
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: true })
  eq(res.status, 200, '[2] 流式状态码')
  ok(String(res.headers['content-type']).includes('text/event-stream'), '[2] 流式 content-type')
  const frames = parseSse(res.text)
  eq(frames.map((f) => f.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ], '[2] 事件序列与顺序')
  eq(frames[0].data.type, 'message_start', '[2] 首帧 message_start')
  eq(frames[0].data.message.role, 'assistant', '[2] message_start.message.role')
  eq(frames[1].data.content_block, { type: 'text', text: '' }, '[2] text 块起始')
  eq(frames[2].data.delta, { type: 'text_delta', text: 'Hello' }, '[2] text_delta 1')
  eq(frames[3].data.delta, { type: 'text_delta', text: ' world' }, '[2] text_delta 2')
  eq(frames[2].data.index, frames[1].data.index, '[2] delta.index 与块 index 一致')
  ok(!res.text.includes('secret-thoughts'), '[2] reasoning_content 不下发（未实现项，如实丢弃）')
  eq(frames[5].data.delta.stop_reason, 'end_turn', '[2] stop_reason 映射')
  eq(frames[5].data.usage.output_tokens, 5, '[2] message_delta 带 output_tokens')
  eq(frames[5].data.usage.input_tokens, 11, '[2] message_delta 补 input_tokens（上游 usage 只在末帧）')
  eq(frames[6].data.type, 'message_stop', '[2] 末帧 message_stop')
}

// ---------------------------------------------------------------------------
// 3) Anthropic 非流式聚合（上游仅流式 → 我们聚合）
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: false })
  eq(res.status, 200, '[3] 非流式状态码')
  ok(String(res.headers['content-type']).includes('application/json'), '[3] 非流式 content-type')
  const body = JSON.parse(res.text)
  eq(body.type, 'message', '[3] type=message')
  eq(body.role, 'assistant', '[3] role=assistant')
  eq(body.model, 'glm-5.3', '[3] model 回显')
  eq(body.content, [{ type: 'text', text: 'Hello world' }], '[3] content 聚合')
  eq(body.stop_reason, 'end_turn', '[3] stop_reason')
  eq(body.usage, { input_tokens: 11, output_tokens: 5 }, '[3] usage 聚合')
  ok(!res.text.includes('event:'), '[3] 非流式响应不含 SSE 帧')
}

// ---------------------------------------------------------------------------
// 4) Anthropic 工具往返
// ---------------------------------------------------------------------------

{
  const streamed = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: '[[scenario:tools]]' }], stream: true })
  const frames = parseSse(streamed.text)
  eq(frames.map((f) => f.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ], '[4] 工具流事件序列（参数在 finish 整块下发）')
  eq(frames[1].data.content_block.type, 'tool_use', '[4] content_block_start 为 tool_use')
  eq(frames[1].data.content_block.id, 'call_abc', '[4] tool_use.id')
  eq(frames[1].data.content_block.name, 'get_weather', '[4] tool_use.name')
  eq(frames[2].data.delta.type, 'input_json_delta', '[4] 参数增量类型')
  const args = frames.filter((f) => f.event === 'content_block_delta').map((f) => f.data.delta.partial_json).join('')
  eq(args, '{"city":"Paris"}', '[4] 参数增量拼接')
  eq(frames[4].data.delta.stop_reason, 'tool_use', '[4] 有工具调用时 stop_reason=tool_use')

  const plain = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: '[[scenario:tools]]' }], stream: false })
  const body = JSON.parse(plain.text)
  eq(body.content, [{ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Paris' } }], '[4] 非流式 tool_use 聚合')
  eq(body.stop_reason, 'tool_use', '[4] 非流式 stop_reason')
  eq(body.usage, { input_tokens: 11, output_tokens: 7 }, '[4] 非流式 usage')
}

// ---------------------------------------------------------------------------
// 4b) Anthropic 并行工具调用：参数增量跨索引交错时不产生「已关闭块的 delta」
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: '[[scenario:tools-interleaved]]' }], stream: true })
  const frames = parseSse(res.text)
  eq(frames.map((f) => f.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ], '[4b] 两个工具块各自完整、顺序下发')

  // 块内连续性体检：delta 只能落在当前开着的块上，stop 后该块不得再出现事件。
  let openIndex = null
  const violations = []
  for (const f of frames) {
    if (f.event === 'content_block_start') openIndex = f.data.index
    else if (f.event === 'content_block_delta' && f.data.index !== openIndex) violations.push(`delta@${f.data.index} open=${openIndex}`)
    else if (f.event === 'content_block_stop') {
      if (f.data.index !== openIndex) violations.push(`stop@${f.data.index} open=${openIndex}`)
      openIndex = null
    }
  }
  eq(violations, [], '[4b] 无「已关闭块再收 delta」的非法事件')

  const deltaText = (index) => frames
    .filter((f) => f.event === 'content_block_delta' && f.data.index === index)
    .map((f) => f.data.delta.partial_json).join('')
  eq(deltaText(0), '{"a":1}', '[4b] 槽 0 参数完整')
  eq(deltaText(1), '{"b":2}', '[4b] 槽 1 参数完整')

  const plain = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 64, messages: [{ role: 'user', content: '[[scenario:tools-interleaved]]' }], stream: false })
  eq(JSON.parse(plain.text).content, [
    { type: 'tool_use', id: 'call_a', name: 'alpha', input: { a: 1 } },
    { type: 'tool_use', id: 'call_b', name: 'beta', input: { b: 2 } },
  ], '[4b] 非流式两槽聚合')
}

// ---------------------------------------------------------------------------
// 5) Responses 请求 → 内部 chat payload 映射
// ---------------------------------------------------------------------------

const responsesBody = {
  model: 'glm-5.3',
  instructions: 'be terse',
  max_output_tokens: 256,
  temperature: 0.2,
  parallel_tool_calls: false,
  reasoning: { effort: 'high' },
  text: { format: { type: 'json_schema', name: 'weather', schema: { type: 'object' }, strict: true } },
  tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
  tool_choice: { type: 'function', name: 'get_weather' },
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather? [[scenario:tools]]' }] },
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
  ],
  stream: true,
}
{
  const res = await post(P, '/v1/responses', responsesBody, { 'x-session-id': 'sess-2' })
  eq(res.status, 200, '[5] responses stream status')
  const up = gw.records.at(-1).payload
  eq(up.stream, true, '[5] 内部面恒流式')
  eq(up.messages[0], { role: 'system', content: 'be terse' }, '[5] instructions → system')
  eq(up.messages[1], { role: 'user', content: 'weather? [[scenario:tools]]' }, '[5] input_text → user 文本')
  eq(up.messages[2].role, 'assistant', '[5] function_call → assistant')
  eq(up.messages[2].content, '', '[5] 纯工具回合 content 为可见空串')
  eq(up.messages[2].tool_calls[0].id, 'call_1', '[5] call_id → tool_calls[].id')
  eq(up.messages[2].tool_calls[0].function.arguments, '{"city":"Paris"}', '[5] arguments 原样')
  eq(up.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' }, '[5] function_call_output → role:tool')
  eq(up.max_tokens, 256, '[5] max_output_tokens → max_tokens')
  eq(up.temperature, 0.2, '[5] temperature 透传')
  eq(up.parallel_tool_calls, false, '[5] parallel_tool_calls 透传')
  eq(up.reasoning_effort, 'high', '[5] reasoning.effort → reasoning_effort')
  eq(up.response_format, { type: 'json_schema', json_schema: { name: 'weather', schema: { type: 'object' }, strict: true } }, '[5] text.format → response_format')
  eq(up.tools[0].function.name, 'get_weather', '[5] 扁平工具定义 → 嵌套 function')
  eq(up.tool_choice, { type: 'function', function: { name: 'get_weather' } }, '[5] tool_choice 映射')
  eq(gw.records.at(-1).headers['x-session-id'], 'sess-2', '[5] 会话亲和头原样到达内部面')
}

// ---------------------------------------------------------------------------
// 6) Responses 流式事件序列
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/responses', { model: 'glm-5.3', input: 'hi', stream: true })
  eq(res.status, 200, '[6] 流式状态码')
  ok(String(res.headers['content-type']).includes('text/event-stream'), '[6] 流式 content-type')
  const frames = parseSse(res.text)
  eq(frames.map((f) => f.event), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ], '[6] 事件序列与顺序')
  eq(frames.map((f) => f.data.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], '[6] sequence_number 单调连续')
  eq(frames[2].data.item.type, 'message', '[6] output_item.added 为 message')
  eq(frames[2].data.output_index, 0, '[6] output_index 0')
  eq(frames[4].data.delta, 'Hello', '[6] output_text.delta 1')
  eq(frames[5].data.delta, ' world', '[6] output_text.delta 2')
  eq(frames[4].data.item_id, frames[2].data.item.id, '[6] delta.item_id 与 item 一致')
  eq(frames[6].data.text, 'Hello world', '[6] output_text.done.text')
  const completed = frames[9].data.response
  eq(completed.status, 'completed', '[6] response.completed.status')
  eq(completed.output_text, 'Hello world', '[6] response.completed.output_text')
  eq(completed.output.length, 1, '[6] 单个 output item')
  eq(completed.output[0].content, [{ type: 'output_text', text: 'Hello world', annotations: [] }], '[6] output item content')
  eq(completed.usage, { input_tokens: 11, output_tokens: 5, total_tokens: 16 }, '[6] usage 映射')
  ok(!res.text.includes('secret-thoughts'), '[6] reasoning 摘要不下发（未实现项）')
}

// ---------------------------------------------------------------------------
// 7) Responses 非流式聚合
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/responses', { model: 'glm-5.3', input: 'hi', stream: false })
  eq(res.status, 200, '[7] 非流式状态码')
  const body = JSON.parse(res.text)
  eq(body.object, 'response', '[7] object=response')
  eq(body.status, 'completed', '[7] status')
  eq(body.model, 'glm-5.3', '[7] model')
  eq(body.output_text, 'Hello world', '[7] output_text')
  eq(body.output[0].type, 'message', '[7] output[0] 类型')
  eq(body.output[0].content[0], { type: 'output_text', text: 'Hello world', annotations: [] }, '[7] output[0].content')
  eq(body.usage, { input_tokens: 11, output_tokens: 5, total_tokens: 16 }, '[7] usage')
  eq(body.error, null, '[7] error 为 null')
}

// ---------------------------------------------------------------------------
// 7b) Responses 截断终态：max_output_tokens 截断 → response.incomplete
// ---------------------------------------------------------------------------

{
  const res = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:length]]', stream: true })
  const frames = parseSse(res.text)
  eq(frames.at(-1).event, 'response.incomplete', '[7b] 截断的协议终态事件是 response.incomplete')
  eq(frames.at(-1).data.response.status, 'incomplete', '[7b] 终态 response.status=incomplete')
  eq(frames.at(-1).data.response.incomplete_details, { reason: 'max_output_tokens' }, '[7b] incomplete_details 说明原因')
  eq(frames.at(-1).data.response.output_text, 'Truncated', '[7b] 截断前已产出的文本保留')
}

// ---------------------------------------------------------------------------
// 8) Responses 工具往返
// ---------------------------------------------------------------------------

{
  const streamed = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:tools]]', stream: true })
  const frames = parseSse(streamed.text)
  eq(frames.map((f) => f.event), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ], '[8] 工具流事件序列')
  eq(frames[2].data.item.type, 'function_call', '[8] output_item.added 为 function_call')
  eq(frames[2].data.item.call_id, 'call_abc', '[8] call_id 透传')
  eq(frames[2].data.item.name, 'get_weather', '[8] name 透传')
  const args = frames.filter((f) => f.event === 'response.function_call_arguments.delta').map((f) => f.data.delta).join('')
  eq(args, '{"city":"Paris"}', '[8] 参数增量拼接')
  eq(frames[5].data.arguments, '{"city":"Paris"}', '[8] arguments.done')
  eq(frames[7].data.response.output[0].type, 'function_call', '[8] 终态 output item')
  eq(frames[7].data.response.output[0].arguments, '{"city":"Paris"}', '[8] 终态 arguments')

  const plain = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:tools]]', stream: false })
  const body = JSON.parse(plain.text)
  eq(body.output.length, 1, '[8] 非流式单个 function_call item')
  eq(body.output[0], { id: body.output[0].id, type: 'function_call', status: 'completed', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' }, '[8] 非流式 function_call 形状')
}

// ---------------------------------------------------------------------------
// 9) 错误面：协议化信封 + 原因 + 状态码
// ---------------------------------------------------------------------------

{
  // 内部面非 200（未登录）：未下发任何用户可见内容 → 干净地改答协议化错误
  const a = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: '[[scenario:status-503]]' }], stream: true })
  eq(a.status, 503, '[9] anthropic 内部 503 透传状态码')
  const ab = JSON.parse(a.text)
  eq(ab.type, 'error', '[9] anthropic 错误信封 type=error')
  eq(ab.error.type, 'api_error', '[9] anthropic 503 → api_error')
  ok(ab.error.message.includes('未登录') && ab.error.message.includes('credential_unavailable'), '[9] anthropic 错误带原因与内部 code')
  ok(!a.text.includes('event:'), '[9] 未提交时不下发半截 SSE 流')

  const r = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:status-503]]', stream: true })
  eq(r.status, 503, '[9] responses 内部 503 透传状态码')
  const rb = JSON.parse(r.text)
  eq(rb.error.type, 'server_error', '[9] responses 503 → server_error')
  ok(rb.error.message.includes('未登录'), '[9] responses 错误带原因')
  eq(rb.error.code, 'credential_unavailable', '[9] responses 错误带内部 code')

  // 流中途错误、但**尚未下发任何用户可见内容** → 仍可干净地改答协议化 JSON 错误（踩坑 #60）
  const as = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: '[[scenario:error-stream]]' }], stream: true })
  eq(as.status, 502, '[9] anthropic 未提交时的流错误 → 502')
  const asb = JSON.parse(as.text)
  eq(asb.error.type, 'api_error', '[9] anthropic 流错误信封')
  ok(asb.error.message.includes('upstream exploded mid-stream'), '[9] anthropic 流错误带原因')
  ok(!as.text.includes('event:'), '[9] 未提交时不下发半截 SSE 流')

  const rs = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:error-stream]]', stream: true })
  eq(rs.status, 502, '[9] responses 未提交时的流错误 → 502')
  eq(JSON.parse(rs.text).error.code, 'upstream_boom', '[9] responses 流错误带内部 code')

  // 已下发用户可见内容后再出错 → 不能再改答 JSON：按协议语法下发错误事件并收尾
  const as2 = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: '[[scenario:error-after-text]]' }], stream: true })
  eq(as2.status, 200, '[9] 已提交后流错误仍是 200')
  const as2Frames = parseSse(as2.text)
  eq(as2Frames.map((f) => f.event), ['message_start', 'content_block_start', 'content_block_delta', 'error'], '[9] 已提交后的错误事件序列')
  eq(as2Frames[2].data.delta.text, 'Partial', '[9] 已下发的可见内容保留')
  ok(as2Frames[3].data.error.message.includes('upstream died after first token'), '[9] 流内错误事件带原因')

  const rs2 = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:error-after-text]]', stream: true })
  const rs2Frames = parseSse(rs2.text)
  eq(rs2Frames.at(-1).event, 'error', '[9] responses 已提交后末帧为 error 事件')
  eq(rs2Frames[4].data.delta, 'Partial', '[9] responses 已下发的可见内容保留')
  eq(rs2Frames.at(-1).data.code, 'upstream_boom', '[9] responses 流内错误带内部 code')

  // 流内 error 事件的 code 同样归一：CodeBuddy 数字码不得以 number 落进字符串字段。
  const rsNumeric = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:error-after-text-numeric]]', stream: true })
  const rsNumericFrames = parseSse(rsNumeric.text)
  eq(rsNumericFrames.at(-1).event, 'error', '[9] responses 数字码流错误末帧为 error 事件')
  eq(rsNumericFrames.at(-1).data.code, '11102', '[9] responses 流内数字码归一成字符串')
  ok(rsNumericFrames.at(-1).data.message.includes('numeric code boom'), '[9] responses 流内数字码错误带原因')

  // 入站校验：缺必需字段 → 400 + 原因
  const badA = await post(P, '/v1/messages', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
  eq(badA.status, 400, '[9] anthropic 缺 max_tokens → 400')
  ok(JSON.parse(badA.text).error.message.includes('max_tokens'), '[9] anthropic 400 原因写明 max_tokens')
  const badR = await post(P, '/v1/responses', { model: 'glm-5.3', previous_response_id: 'resp_1' })
  eq(badR.status, 400, '[9] responses 有状态链 → 400')
  ok(JSON.parse(badR.text).error.message.includes('previous_response_id'), '[9] responses 400 原因写明不支持有状态链')
  const badJson = await post(P, '/v1/messages', '{not json')
  eq(badJson.status, 400, '[9] 非 JSON 体 → 400')

  // 数字码方言（CodeBuddy）也必须进协议信封：信封 code 是字符串字段，数字码
  // 不归一就落成 null，机器可读的码丢掉（原因仍在 message，但踩坑 #7 的
  // 「错误带原因」应含码）。
  const numA = await post(P, '/v1/messages', { model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: '[[scenario:status-400-numeric]]' }], stream: true })
  eq(numA.status, 400, '[9] anthropic 数字码内部 400 透传状态码')
  ok(JSON.parse(numA.text).error.message.includes('[11102]'), '[9] anthropic 信封保留数字码（归一成字符串）')

  const numR = await post(P, '/v1/responses', { model: 'glm-5.3', input: '[[scenario:status-400-numeric]]', stream: true })
  eq(numR.status, 400, '[9] responses 数字码内部 400 透传状态码')
  eq(JSON.parse(numR.text).error.code, '11102', '[9] responses 信封保留数字码（归一成字符串）')
}

// ---------------------------------------------------------------------------
// 10) 共享骨架：Host/Origin 双门 + 既有路由零回归
// ---------------------------------------------------------------------------

{
  const evilHost = await httpRequest({ port: P, path: '/v1/messages', method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' }, body: '{}' })
  eq(evilHost.status, 403, '[10] 非回环 Host → 403')
  const evilOrigin = await httpRequest({ port: P, path: '/v1/responses', method: 'POST', headers: { Host: `127.0.0.1:${P}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' }, body: '{}' })
  eq(evilOrigin.status, 403, '[10] 跨站 Origin → 403')
  const goodOrigin = await httpRequest({ port: P, path: '/v1/messages', method: 'POST', headers: { Host: `127.0.0.1:${P}`, Origin: `http://127.0.0.1:${P}`, 'Content-Type': 'application/json' }, body: json({ model: 'm', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }) })
  eq(goodOrigin.status, 200, '[10] 同源 Origin → 放行')
  const noOrigin = await post(P, '/v1/messages', { model: 'm', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] })
  eq(noOrigin.status, 200, '[10] 无 Origin（本机 fetch/壳转发）→ 放行')

  const models = await httpRequest({ port: P, path: '/v1/models', method: 'GET', headers: { Host: `127.0.0.1:${P}` } })
  eq(models.status, 200, '[10] GET /v1/models 仍可用')
  eq(JSON.parse(models.text).data.map((m) => m.id), ['test-model', 'glm-5.3'], '[10] 目录清单不变')

  const chat = await post(P, '/v1/chat/completions', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true })
  eq(chat.status, 200, '[10] 既有 OpenAI chat 面零回归')
  ok(chat.text.includes('"Hello"'), '[10] 既有 chat 面原样透传内部 SSE')

  const missing = await httpRequest({ port: P, path: '/v1/nope', method: 'POST', headers: { Host: `127.0.0.1:${P}` }, body: '{}' })
  eq(missing.status, 404, '[10] 未知路由 404')
}

await gw.stop()

// ---------------------------------------------------------------------------
// 11) 收体上限 413 仍生效（小上限网关，毫秒级、零 RST 风险）
// ---------------------------------------------------------------------------

{
  const small = await startGateway({ bodyLimitBytes: 256 })
  const big = await post(small.port, '/v1/messages', { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'x'.repeat(1024) }] })
  eq(big.status, 413, '[11] 超限 → 413')
  ok(JSON.parse(big.text).error.message.includes('too large'), '[11] 413 带原因')
  await small.stop()
}

// ---------------------------------------------------------------------------
// 12) 纯函数层：未实现字段如实披露（不静默假装兼容）
// ---------------------------------------------------------------------------

{
  const a = anthropicToChat({ model: 'm', max_tokens: 8, thinking: { type: 'enabled', budget_tokens: 1024 }, top_k: 5, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] })
  ok(a.unsupported.includes('thinking (extended thinking)'), '[12] anthropic thinking 计入未实现清单')
  ok(a.unsupported.includes('top_k'), '[12] anthropic top_k 计入未实现清单')
  ok(a.unsupported.some((u) => u.includes('web_search_20250305')), '[12] anthropic 服务端工具计入未实现清单')
  eq(a.chat.tools, undefined, '[12] 服务端工具不透传')

  const r = responsesToChat({ model: 'm', input: 'hi', store: true, include: ['reasoning.encrypted_content'], tools: [{ type: 'web_search' }], reasoning: { effort: 'low' } })
  ok(r.unsupported.includes('store'), '[12] responses store 计入未实现清单')
  ok(r.unsupported.includes('include'), '[12] responses include 计入未实现清单')
  ok(r.unsupported.some((u) => u.includes('web_search')), '[12] responses 非 function 工具计入未实现清单')
  eq(r.chat.reasoning_effort, 'low', '[12] responses reasoning.effort 仍映射')
}

// ---------------------------------------------------------------------------

console.log(`\nverify-protocols: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('failures:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
