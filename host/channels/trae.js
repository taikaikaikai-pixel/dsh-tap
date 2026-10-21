/**
 * host/channels/trae.js — TraeWork CN 通道描述符（契约见 providers/channel.js）。
 *
 * 目录来自本机 state.vscdb（`catalogSync`），镜像进 `llm-pi-ai.providers.trae.models`；
 * 禁用时按纯净态纪律撤镜像（`onDisabled`）。额度面是 IDE/work 双池只读端点。
 */

import { defineChannel } from '../../providers/channel.js'
import { traeProvider } from '../providers/instances.js'
import { traeRuntime } from '../runtime.js'
import { syncTraeModelsToDshSettings } from '../models/channels.js'

export const traeChannel = defineChannel({
  id: 'trae',
  label: 'TraeWork CN',
  settings: { enabled: 'traeEnabled', port: 'traeBridgePort' },
  runtime: traeRuntime,
  listen: (port) => traeProvider.gateway.listen(port),
  quota: ({ fresh }) => traeProvider.quota.snapshot({ fresh }),
  catalogSync: () => traeProvider.syncCatalog(),
  catalogView: () => traeProvider.catalogView(),
  onDisabled: () => { syncTraeModelsToDshSettings() },
  // 目录同步失败静默（state.vscdb 不在本机时 Trae 分区只是空转）；有旧目录就重铺镜像。
  onStarted: () => traeProvider.syncCatalog().then((r) => {
    if (r.ok) {
      syncTraeModelsToDshSettings()
      process.stderr.write(`[dsh-tap] trae catalog synced (${r.count} models)\n`)
    } else if (traeProvider.catalogView()) {
      syncTraeModelsToDshSettings()
    }
  }),
  block: { gateway: true, control: { kind: 'switch', field: 'traeEnabled' } },
})
