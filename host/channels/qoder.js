/**
 * host/channels/qoder.js — Qoder CN 通道描述符（契约见 providers/channel.js）。
 *
 * 结构与 trae 同形：目录走网关目录（`catalogSync`）→ 镜像 `providers.qoder`；
 * 额度走官方计数器。差异只在 provider 实现与镜像目标，通道契约不再感知。
 */

import { defineChannel } from '../../providers/channel.js'
import { qoderProvider } from '../providers/instances.js'
import { qoderRuntime } from '../runtime.js'
import { syncQoderModelsToDshSettings } from '../models/channels.js'

export const qoderChannel = defineChannel({
  id: 'qoder',
  label: 'Qoder CN',
  settings: { enabled: 'qoderEnabled', port: 'qoderBridgePort' },
  runtime: qoderRuntime,
  listen: (port) => qoderProvider.gateway.listen(port),
  quota: ({ fresh }) => qoderProvider.quota.snapshot({ fresh }),
  catalogSync: () => qoderProvider.syncCatalog(),
  catalogView: () => qoderProvider.catalogView(),
  onDisabled: () => { syncQoderModelsToDshSettings() },
  onStarted: () => qoderProvider.syncCatalog().then((r) => {
    if (r.ok) {
      syncQoderModelsToDshSettings()
      process.stderr.write(`[dsh-tap] qoder catalog synced (${r.count} models)\n`)
    } else if (qoderProvider.catalogView()) {
      syncQoderModelsToDshSettings()
    }
  }),
  block: { gateway: true, control: { kind: 'switch', field: 'qoderEnabled' } },
})
