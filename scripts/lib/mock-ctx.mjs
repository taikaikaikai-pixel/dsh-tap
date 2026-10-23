/**
 * scripts/lib/mock-ctx.mjs — 驱动 `index.js` 的 `apply()` 用的假 cordis Context。
 *
 * 为什么要有这个共享件：`apply()` 只碰 Context 的五个面（inject / on /
 * effect / web / webServer 注入载荷），此前六个 verify/probe 脚本各自手搓
 * 一份，且都是**按当时 index.js 用到的面**手搓的——index.js 一长出新面，
 * 手搓的那份就落后：`ctx.effect` 落地后（cordis 4 无 'dispose' context 事件，
 * 见 index.js 收尾注释），六份假 Context 全在 apply() 末尾抛
 * `ctx.effect is not a function`——脚本崩得响，但**该点之后的断言一条都没跑**，
 * 且 trae/qoder 两套件原先靠 `on('dispose')` 收 teardown，那个事件已不再注册、
 * 收集恒为空，收尾关网关是**静默空转**（进程退出才被动释放端口）。
 * 集中一份，缺面即在此处一次补齐。
 *
 * 只镜像 apply() 真正用到的语义，不做通用 cordis 仿真：
 *   - `inject(deps, cb)`：mock 下依赖恒定可用，同步回调。`requireDeps` 给出
 *     时按 deps 过滤（真实 cordis 是「全部就绪才回调」，脚本用过滤表达
 *     "某服务缺席"的合成场景）。
 *   - `effect(execute)`：**立即执行并收集 disposer**（真实 cordis 在 fiber
 *     上延迟到 dispose 才调用）。脚本收尾须显式调用收集到的 disposer——
 *     这正好让脚本的 teardown 真的关掉网关（此前走 on('dispose') 收集，
 *     那个事件已不再注册，收集恒为空、teardown 是空转）。
 *
 * @param {object} [options]
 * @param {Record<string, Function>} [options.routes] webServer.register 的
 *   落点：`routes[path] = handler`。
 * @param {Function} [options.onRegister] 每次 webServer.register 的回调（收
 *   完整 route 对象，用于取 handler 之外的字段）。
 * @param {Array} [options.effects] apply() 注册的 disposer 收集数组。
 * @param {object} [options.extra] 并入每次 inject 回调载荷的额外服务。
 * @param {string[]|null} [options.requireDeps] 非空时只在 deps 命中其一才回调。
 * @param {boolean} [options.withTools] 载荷带 `tools.register`（no-op disposer）。
 */
export function makeMockCtx({ routes = {}, onRegister = null, effects = [], extra = {}, requireDeps = null, withTools = false } = {}) {
  const ctx = {
    web: {
      registerSearchProvider: () => () => {},
      registerFetchProvider: () => () => {},
    },
    // 真实 cordis 的 'dispose' 事件不存在；保留空实现只为兼容 apply() 里
    // 其他 ctx.on 用法（当前无）。
    on: () => {},
    effect(execute) {
      const dispose = execute()
      effects.push(dispose)
      return dispose
    },
    inject(deps, cb) {
      if (requireDeps && !deps.some((d) => requireDeps.includes(d))) return
      const webServer = {
        register: (r) => {
          routes[r.path] = r.handler
          onRegister?.(r)
        },
      }
      const payload = { webServer, ...extra }
      if (withTools) payload.tools = { register: () => () => {} }
      cb(payload)
    },
  }
  return ctx
}

/** 逆序调用收集到的 disposer 并等其落地（apply() 的 disposer 是异步的）。 */
export async function disposeAll(effects) {
  for (const dispose of [...effects].reverse()) {
    try {
      await dispose?.()
    } catch { /* teardown 失败不该盖住断言结论 */ }
  }
}
