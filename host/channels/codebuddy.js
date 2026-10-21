/**
 * host/channels/codebuddy.js — CodeBuddy 通道描述符（契约见 providers/channel.js）。
 *
 * 它是三条通道里唯一"宿主半自建监听"的：桥实例由 apply 每代创建（要捕获本代
 * settings），故描述符是工厂而不是常量——组合根把 `bridge` 传进来。
 * 桥的额度面走 provider.catalog.quotaSnapshot（60s memoize + 15s 地板）。
 */

import { defineChannel } from '../../providers/channel.js'
import { provider } from '../providers/instances.js'
import { bridgeRuntime } from '../runtime.js'

/**
 * @param {{ bridge: { listen: (port: number) => (() => Promise<void>) } }} deps
 */
export function createCodebuddyChannel({ bridge }) {
  return defineChannel({
    id: 'codebuddy',
    label: 'CodeBuddy',
    settings: { enabled: 'bridgeEnabled', port: 'bridgePort' },
    runtime: bridgeRuntime,
    listen: (port) => bridge.listen(port),
    quota: ({ fresh, resolveNow }) => provider.catalog.quotaSnapshot(resolveNow, { fresh }),
    // 目录同步不挂在通道生命周期上：codebuddy 的目录是"模型清单真源"，
    // 由组合根在 apply 尾部单独跑一次（失败回落静态清单，与通道起停无关）。
    block: { gateway: true, control: { kind: 'switch', field: 'bridgeEnabled' } },
  })
}
