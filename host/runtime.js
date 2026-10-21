/**
 * host/runtime.js — 三通道的**运行态台账**（0.25.0 从 index.js / instances.js 收拢）。
 *
 * 只放"监听到了没有"这类会被设置卡读走的可变状态：`running` 由服务器
 * `'listening'`/`'error'` 事件翻转，`port` 由 listen 成功后回填（`port:0` 时是
 * 真实端口），`lastError` 存 EADDRINUSE 之类的降级原因，`rateLimit`/`queue`
 * 是上游瞬时态（设置卡与主界面装饰读）。
 *
 * 纪律：这里是**唯一**的运行态真源（踩坑 #20：状态沉进模块全局会破坏多实例
 * 隔离；但运行态本就按进程一份，故集中在组合层，而不是沉进 core/providers）。
 */

export const bridgeRuntime = { running: false, port: null, lastError: null, rateLimit: null }

export const traeRuntime = { running: false, port: null, lastError: null }

export const qoderRuntime = { running: false, port: null, lastError: null, queue: null }
