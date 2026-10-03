/**
 * providers/qoder/cosy.js — Qoder COSY 签名运行时（WASM + 手写 wasm-bindgen 胶水）。
 *
 * 来源与版权边界：
 *   - qoder_auth.wasm：官方 CLI（@qodercn-ai/qoderclicn 1.1.57）bundle 内嵌
 *     base64（offset 25462）解出的原始字节，未修改——厂商专有组件，随官方
 *     包分发；本插件不复刻其算法，仅在运行时加载调用（逆向校准证据见
 *     docs/goals/qoder-cn-provider-design.md §2.3 与 2026-09-20 探测）。
 *   - 本文件的胶水代码是按 wasm-bindgen ABI 惯例的干净实现（heap 表 /
 *     passString / stack-pointer 返回槽 / handleError），不复制 bundle 文本。
 *
 * 关键事实（2026-09-20 实测，证据 C:\tmp\qoder-re\*.mjs 本地留存）：
 *   - prepareRequest（/algo 面）会把任意路径重写为 /algo 前缀 + ?Encode=1，
 *     签名绑定改写后的 URL——聊天面绝不能走它（401/404 的根因）。
 *   - prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) 是聊天面
 *     签名入口：URL 恒映射到 infer 节点的
 *     /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1，
 *     body 由 WASM 加密，头组含 Bearer COSY.* 与 Cosy-* 全家。
 *   - infer 节点由 region 发现服务给出（/api/v3/service/region/endpoints，
 *     sign 匿名模式可取，响应需 decrypt）：CN = gateway.qoder.com.cn。
 *   - RequestResult.headers 是 JS Map（wasm 侧 __wbg_new(Map) + set 组装的）——
 *     必须 Object.fromEntries 后才能进 fetch；直接展开 {...map} 会得到空头组
 *     （首次手写胶水实测：服务器直接断连，无错误响应）。
 *
 * 线程/并发：WASM 实例单例（模块级 promise 缓存）；QoderContext 持有的是不可变
 * 凭据快照，每次调用独立签名——凭据轮换（refresh 后 accessToken 变化）时
 * ensureContext 检测令牌字符串变化并重建上下文（构造很便宜，WASM 不重载）。
 *
 * clientMetadata（2026-09-22 对齐官方）：`{"client_type":5}`——wasm 把该字段映射成
 * `Cosy-ClientType` 头，官方 CLI/IDE 实测线缆值恒为 **5**；我们早期传字符串
 * `'qoder'` 会让出站头带上 `Cosy-ClientType: qoder`（与官方客户端签名不一致，
 * 网关侧可据此分辨第三方客户端）。这是**头保真度**修正，与模型可用性无关
 * （qfmodel 上游节点故障两种值下都复现）。
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// wasm-bindgen ABI 最小胶水（标准惯例实现）
// ---------------------------------------------------------------------------

const heap = new Array(1024).fill(undefined)
heap.push(undefined, null, true, false)
let heapNext = heap.length

function addHeapObject(obj) {
  if (heapNext === heap.length) heap.push(heap.length + 1)
  const idx = heapNext
  heapNext = heap[idx]
  heap[idx] = obj
  return idx
}
function getObject(idx) { return heap[idx] }
function dropObject(idx) {
  if (idx < 1028) return
  heap[idx] = heapNext
  heapNext = idx
}
function takeObject(idx) {
  const ret = getObject(idx)
  dropObject(idx)
  return ret
}

let wasm = null
let cachedU8 = null
let cachedDV = null
const u8 = () => {
  if (!cachedU8 || cachedU8.byteLength === 0) cachedU8 = new Uint8Array(wasm.memory.buffer)
  return cachedU8
}
const dv = () => {
  if (!cachedDV || cachedDV.buffer !== wasm.memory.buffer) cachedDV = new DataView(wasm.memory.buffer)
  return cachedDV
}
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false })

let WASM_VECTOR_LEN = 0
function passString(str) {
  const bytes = encoder.encode(str)
  const ptr = wasm.__wbindgen_export2(bytes.length, 1) >>> 0
  u8().subarray(ptr, ptr + bytes.length).set(bytes)
  WASM_VECTOR_LEN = bytes.length
  return ptr
}
const optString = (s) => (s == null ? 0 : passString(s))
const getString = (ptr, len) => decoder.decode(u8().subarray(ptr >>> 0, (ptr >>> 0) + len))
const getU8View = (ptr, len) => u8().subarray(ptr >>> 0, (ptr >>> 0) + len)

function handleError(fn, args) {
  try {
    return fn.apply(null, args)
  } catch (err) {
    wasm.__wbindgen_export(addHeapObject(err))
    return undefined
  }
}

const nullOr = (x) => (typeof x === 'undefined' ? null : x)
const isNullish = (x) => x == null

function buildImports() {
  return {
    './qoder_auth_wasm_bg.js': {
      __wbindgen_object_drop_ref: (i) => dropObject(i),
      __wbg_set_08463b1df38a7e29: (a, b, c) => addHeapObject(getObject(a).set(getObject(b), getObject(c))),
      __wbg_getRandomValues_d49329ff89a07af1: (...args) => handleError((a, b) => globalThis.crypto.getRandomValues(getU8View(a, b)), args),
      __wbg_crypto_38df2bab126b63dc: (a) => addHeapObject(getObject(a).crypto),
      __wbg_process_44c7a14e11e9f69e: (a) => addHeapObject(getObject(a).process),
      __wbg_versions_276b2795b1c6a219: (a) => addHeapObject(getObject(a).versions),
      __wbg_node_84ea875411254db1: (a) => addHeapObject(getObject(a).node),
      __wbg_require_b4edbdcf3e2a1ef0: (...args) => handleError(() => addHeapObject(module.require), args),
      __wbg_msCrypto_bd5a034af96bcba6: (a) => addHeapObject(getObject(a).msCrypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => handleError((a, b) => getObject(a).getRandomValues(getObject(b)), args),
      __wbg_randomFillSync_6c25eac9869eb53c: (...args) => handleError((a, b) => getObject(a).randomFillSync(takeObject(b)), args),
      __wbg_call_d578befcc3145dee: (...args) => handleError((a, b, c) => addHeapObject(getObject(a).call(getObject(b), getObject(c))), args),
      __wbindgen_object_clone_ref: (a) => addHeapObject(getObject(a)),
      __wbg_new_with_length_9cedd08484b73942: (a) => addHeapObject(new Uint8Array(a >>> 0)),
      __wbg_length_0c32cb8543c8e4c8: (a) => getObject(a).length,
      __wbg_prototypesetcall_3e05eb9545565046: (a, b, c) => Uint8Array.prototype.set.call(getU8View(a, b), getObject(c)),
      __wbg_subarray_0f98d3fb634508ad: (a, b, c) => addHeapObject(getObject(a).subarray(b >>> 0, c >>> 0)),
      __wbg_new_99cabae501c0a8a0: () => addHeapObject(new Map()),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => { const x = nullOr(globalThis); return isNullish(x) ? 0 : addHeapObject(x) },
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => { const x = typeof self === 'undefined' ? null : self; return isNullish(x) ? 0 : addHeapObject(x) },
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => { const x = typeof global === 'undefined' ? null : global; return isNullish(x) ? 0 : addHeapObject(x) },
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => { const x = typeof window === 'undefined' ? null : window; return isNullish(x) ? 0 : addHeapObject(x) },
      __wbg___wbindgen_throw_81fc77679af83bc6: (a, b) => { throw new Error(getString(a, b)) },
      __wbg_Error_2e59b1b37a9a34c3: (a, b) => addHeapObject(Error(getString(a, b))),
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (a) => { const v = getObject(a); return typeof v === 'object' && v !== null ? 1 : 0 },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (a) => (typeof getObject(a) === 'string' ? 1 : 0),
      __wbg___wbindgen_is_function_49868bde5eb1e745: (a) => (typeof getObject(a) === 'function' ? 1 : 0),
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (a) => (getObject(a) === undefined ? 1 : 0),
      __wbindgen_cast_0000000000000001: (a, b) => addHeapObject(getU8View(a, b)),
      __wbindgen_cast_0000000000000002: (a, b) => addHeapObject(getString(a, b)),
    },
  }
}

// ---------------------------------------------------------------------------
// 类封装（方法行为与官方胶水逐点对齐：栈指针返回槽 [ok, err, flag]）
// ---------------------------------------------------------------------------

class RequestResult {
  static __wrap(ptr) {
    ptr >>>= 0
    const o = Object.create(RequestResult.prototype)
    o.__wbg_ptr = ptr
    return o
  }
  /** 释放 wasm 侧对象（幂等）。wasm 堆对象不受 JS GC 管理，不释放即泄漏。 */
  free() {
    if (this.__wbg_ptr) wasm.__wbg_requestresult_free(this.__wbg_ptr)
    this.__wbg_ptr = 0
  }
  /** 可能返回 undefined（无 body 的签名结果）。 */
  get body() {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
    try {
      wasm.requestresult_body(sp, this.__wbg_ptr)
      const p = dv().getInt32(sp + 0, true)
      const l = dv().getInt32(sp + 4, true)
      let out
      if (p !== 0) {
        out = getString(p, l).slice()
        wasm.__wbindgen_export4(p, l, 1)
      }
      return out
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /** JS Map（调用方负责 Object.fromEntries）。 */
  get headers() {
    return takeObject(wasm.requestresult_headers(this.__wbg_ptr))
  }
  get url() {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
    let p
    let l
    try {
      wasm.requestresult_url(sp, this.__wbg_ptr)
      p = dv().getInt32(sp + 0, true)
      l = dv().getInt32(sp + 4, true)
      return getString(p, l)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(p, l, 1)
    }
  }
}

class QoderContext {
  constructor(machineId, cosyVersion, userInfoJson, clientMetaJson) {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
    try {
      const p1 = passString(machineId)
      const l1 = WASM_VECTOR_LEN
      const p2 = passString(cosyVersion)
      const l2 = WASM_VECTOR_LEN
      const p3 = passString(userInfoJson)
      const l3 = WASM_VECTOR_LEN
      const p4 = optString(clientMetaJson)
      const l4 = WASM_VECTOR_LEN
      wasm.qodercontext_new(sp, p1, l1, p2, l2, p3, l3, p4, l4)
      const ok = dv().getInt32(sp + 0, true)
      const err = dv().getInt32(sp + 4, true)
      if (dv().getInt32(sp + 8, true)) throw takeObject(err)
      this.__wbg_ptr = ok >>> 0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /** 聊天面签名：URL 由 WASM 路由表映射到 agent_chat_generation。 */
  prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
    try {
      const p1 = passString(endpoint)
      const l1 = WASM_VECTOR_LEN
      const p2 = passString(bodyJson)
      const l2 = WASM_VECTOR_LEN
      const p3 = optString(modelKey)
      const l3 = WASM_VECTOR_LEN
      const p4 = optString(modelSource)
      const l4 = WASM_VECTOR_LEN
      wasm.qodercontext_prepareInferRequest(sp, this.__wbg_ptr, p1, l1, p2, l2, p3, l3, p4, l4)
      const ok = dv().getInt32(sp + 0, true)
      const err = dv().getInt32(sp + 4, true)
      if (dv().getInt32(sp + 8, true)) throw takeObject(err)
      return RequestResult.__wrap(ok)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /** 释放 wasm 侧上下文（凭据轮换时旧上下文必 free）。 */
  free() {
    if (this.__wbg_ptr) wasm.__wbg_qodercontext_free(this.__wbg_ptr)
    this.__wbg_ptr = 0
  }
  /** /algo 面签名（目录等管理端点）：path 会被重写为 /algo 前缀 + Encode=1。 */
  prepareRequest(endpoint, path, method, mode, bodyJson, headersJson) {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
    try {
      const p1 = passString(endpoint)
      const l1 = WASM_VECTOR_LEN
      const p2 = passString(path)
      const l2 = WASM_VECTOR_LEN
      const p3 = passString(method)
      const l3 = WASM_VECTOR_LEN
      const p4 = passString(mode)
      const l4 = WASM_VECTOR_LEN
      const p5 = optString(bodyJson)
      const l5 = WASM_VECTOR_LEN
      const p6 = optString(headersJson)
      const l6 = WASM_VECTOR_LEN
      wasm.qodercontext_prepareRequest(sp, this.__wbg_ptr, p1, l1, p2, l2, p3, l3, p4, l4, p5, l5, p6, l6)
      const ok = dv().getInt32(sp + 0, true)
      const err = dv().getInt32(sp + 4, true)
      if (dv().getInt32(sp + 8, true)) throw takeObject(err)
      return RequestResult.__wrap(ok)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}

/** userInfoJson → { encrypt_user_info, key }（上下文构造的前置）。 */
function runtimeFields(userInfoJson) {
  const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
  let p
  let l
  try {
    const ps = passString(userInfoJson)
    const ls = WASM_VECTOR_LEN
    wasm.generate_runtime_auth_fields(sp, ps, ls)
    const rp = dv().getInt32(sp + 0, true)
    const rl = dv().getInt32(sp + 4, true)
    const ep = dv().getInt32(sp + 8, true)
    const el = dv().getInt32(sp + 12, true)
    if (el) throw takeObject(ep)
    p = rp
    l = rl
    return getString(rp, rl)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
    wasm.__wbindgen_export4(p, l, 1)
  }
}

/** Encode=1 响应体解密；失败原样返回（部分端点本就回明文）。
 * ABI：retptr-first 三参（与同文件 generate_runtime_auth_fields 同型）——
 * 栈槽布局 [resultPtr, resultLen, errPtr, errLen]；错用 2 参会让 wasm 把
 * 结果槽写进输入串的线性内存且 ret 为 undefined（2026-10-03 实测）。 */
function decrypt(text) {
  let p
  let l
  const sp = wasm.__wbindgen_add_to_stack_pointer(-16)
  try {
    const ptr = passString(text)
    wasm.decrypt_server_response(sp, ptr, WASM_VECTOR_LEN)
    const rp = dv().getInt32(sp + 0, true)
    const rl = dv().getInt32(sp + 4, true)
    const ep = dv().getInt32(sp + 8, true)
    const el = dv().getInt32(sp + 12, true)
    if (el) throw takeObject(ep)
    p = rp
    l = rl
    return getString(rp, rl)
  } catch {
    return text
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
    if (p) wasm.__wbindgen_export4(p, l, 1)
  }
}

// ---------------------------------------------------------------------------
// 运行时工厂
// ---------------------------------------------------------------------------

/** 官方 CLI 版本号（签名里的 cosyVersion，随提取的 wasm 钉住）。 */
export const QODER_COSY_VERSION = '1.1.57'

let wasmPromise = null

/**
 * @param {{ wasmPath: string }} opts
 * @returns 单例运行时 {
 *   ensureContext(cred), prepareChat({endpoint,body,modelKey,modelSource}),
 *   prepareGet({endpoint,path}), prepareSigned({endpoint,path,method,mode,body}),
 *   decrypt(text)
 * }；cred = { accessToken, machineId, uid }。
 */
export function createCosyRuntime({ wasmPath }) {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const bytes = readFileSync(wasmPath)
      const { instance } = await WebAssembly.instantiate(bytes, buildImports())
      wasm = instance.exports
      return wasm
    })()
    // 失败不缓存 promise（下次调用重试），也不留 half-init 状态。
    wasmPromise.catch(() => { wasmPromise = null })
  }

  let context = null
  let contextKey = null

  async function ensureWasm() {
    await wasmPromise
    if (!wasm) throw new Error('qoder cosy wasm 未加载')
  }

  /** 凭据快照变化（refresh 轮换）时重建上下文；同快照复用。 */
  async function ensureContext(cred) {
    if (!cred?.accessToken || !cred?.machineId) throw new Error('qoder 凭据不完整（需登录）')
    const key = `${cred.machineId}:${cred.accessToken}:${JSON.stringify(cred.extraUser ?? null)}`
    if (context && contextKey === key) return context
    await ensureWasm()
    const baseUser = {
      uid: cred.uid ?? '',
      security_oauth_token: cred.accessToken,
      organization_id: '',
      organization_tags: [],
      data_policy_agreed: true,
      // 2026-09-22 归因课题：官方 cachedUserInfo 比最小形态多 login_method/
      // user_type/plan/aid/yx_uid 等字段（bundle 实证），经 encrypt_user_info
      // 进服务端计费归因上下文；调用方可经 cred.extraUser 注入。
      ...(cred.extraUser && typeof cred.extraUser === 'object' ? cred.extraUser : {}),
    }
    const rf = JSON.parse(runtimeFields(JSON.stringify(baseUser)))
    const next = new QoderContext(cred.machineId, QODER_COSY_VERSION, JSON.stringify({
      ...baseUser,
      access_token: cred.accessToken,
      encrypt_user_info: rf.encrypt_user_info,
      key: rf.key,
    }), JSON.stringify({ client_type: 5 }))
    // 旧上下文在其 wasm 实例上占内存；轮换成功后才释放，失败则保留旧上下文。
    if (context) context.free()
    context = next
    contextKey = key
    return context
  }

  /** 取签名结果后即释放 RequestResult——它的 url/headers/body 已快照到纯 JS。 */
  function drain(req) {
    try {
      const headers = req.headers instanceof Map ? Object.fromEntries(req.headers) : req.headers
      return { url: req.url, headers, body: req.body }
    } finally {
      req.free()
    }
  }

  return {
    ensureContext,
    /** 聊天请求签名 → { url, headers（已转 record）, body（密文） }。 */
    async prepareChat(cred, { endpoint, body, modelKey, modelSource }) {
      const ctx = await ensureContext(cred)
      return drain(ctx.prepareInferRequest(endpoint, body, modelKey ?? null, modelSource ?? null))
    },
    /** /algo 面 GET 签名（目录/区域发现等）。 */
    async prepareGet(cred, { endpoint, path }) {
      const ctx = await ensureContext(cred)
      return drain(ctx.prepareRequest(endpoint, path, 'GET', 'auth', undefined, undefined))
    },
    /**
     * prepareRequest 直通（上报/管理面 POST）：mode 'auth'（/algo 重写 + 加密）
     * 或 'sign'（仅签名）。官方客户端 business/finish 用 auth、/api/v1/tracking
     * 用 sign（bundle g4i/aPl 调用点实证）。
     */
    async prepareSigned(cred, { endpoint, path, method = 'POST', mode = 'auth', body }) {
      const ctx = await ensureContext(cred)
      return drain(ctx.prepareRequest(endpoint, path, method, mode, body ?? undefined, undefined))
    },
    decrypt,
  }
}
