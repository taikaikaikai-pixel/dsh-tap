/**
 * host/channels/index.js — **通道清单**（唯一真源，0.26.0）。
 *
 * 组合根按这份清单迭代：起停生命周期、`gateway-retry`、`quota-all`、dispose。
 * 加通道 = 加一个描述符文件 + 登记到这里 + 设置卡区块（见 wiki/11-add-a-channel.md）；
 * `scripts/verify-channel-contract.mjs` 会把"清单 ↔ 设置字段 ↔ 客户端区块"三方对账。
 */

import { assertChannels } from '../../providers/channel.js'
import { createCodebuddyChannel } from './codebuddy.js'
import { traeChannel } from './trae.js'
import { qoderChannel } from './qoder.js'

/**
 * 构造本代通道清单。codebuddy 的桥是 apply 每代创建的，故走工厂。
 *
 * @param {{ bridge: { listen: (port: number) => (() => Promise<void>) } }} deps
 * @returns {ReadonlyArray<Readonly<object>>}
 */
export function createChannels({ bridge }) {
  const channels = [createCodebuddyChannel({ bridge }), traeChannel, qoderChannel]
  assertChannels(channels)
  return Object.freeze(channels)
}

/** 通道 id 清单（动作参数校验、视图遍历用；顺序 = 设置卡区块顺序）。 */
export const CHANNEL_IDS = Object.freeze(['codebuddy', 'trae', 'qoder'])
