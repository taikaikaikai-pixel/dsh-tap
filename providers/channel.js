/**
 * providers/channel.js — **通道契约**（0.26.0）：一条订阅/翻译通道要向组合根
 * 暴露的全部事实。
 *
 * 为什么需要它：改造前"加一条通道"= 改五个地方（apply 生命周期、retryGateway
 * 的 if 链、quota-all 的三段 Promise.all、settingsView 的视图片段、客户端的
 * BLOCK_DEFS 分支），漏一处就表现为"界面有开关但网关不起"/"重试按钮点不动"。
 * 契约把"通道是什么"变成数据 + 工厂：组合根只按清单迭代，`scripts/verify-channel-contract.mjs`
 * 逐字段对账，`wiki/11-add-a-channel.md` 给新增通道的步骤。
 *
 * 本文件**不含任何通道具体值**（只校验形状）——具体描述符在 host/channels/
 * （它们要 import host 的 provider 单例与模型镜像，属于组合层）。
 *
 * 形状（必填 = 缺了组合根就转不动；可选 = 有才启用对应行为）：
 *
 *   id            string    稳定标识：设置键前缀、quota 视图键、客户端 data-block
 *   label         string    展示名（设置卡区块标题）
 *   settings      {enabled, port}  Config 字段名（enabled 决定起停，port 决定端口）
 *   runtime       object    host/runtime.js 的运行态台账（running/port/lastError）
 *   listen        (port) => stop   起本机网关；stop 关服务 + 收连接
 *   quota?        ({fresh}) => Promise<snapshot>   额度快照（缺省 = 该通道无额度面）
 *   catalogSync?  () => Promise<{ok,count}>        目录同步（缺省 = 无目录）
 *   catalogView?  () => object|null                目录视图（有才参与效果校验）
 *   onDisabled?   () => void        禁用时额外动作（撤镜像等）
 *   onStarted?    () => Promise|void 起监听后的动作（目录同步 + 镜像）
 *   block?        {gateway, control, source}  设置卡区块的声明式描述
 */

/** 必填字段（缺一个通道就跑不起来）。 */
const REQUIRED = ['id', 'label', 'settings', 'runtime', 'listen']

/** 可选字段（有则组合根启用对应行为，无则跳过）。 */
const OPTIONAL = ['quota', 'catalogSync', 'catalogView', 'onDisabled', 'onStarted', 'block']

const ID_RE = /^[a-z][a-z0-9-]*$/

/**
 * 定义并校验一条通道。
 *
 * @param {object} spec 见文件头形状说明
 * @returns {Readonly<object>} 冻结后的描述符（组合根只读不改）
 */
export function defineChannel(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('channel: 需要描述符对象')
  for (const key of REQUIRED) {
    if (spec[key] === undefined || spec[key] === null) throw new Error(`channel.${key} 必填`)
  }
  if (!ID_RE.test(spec.id)) throw new Error(`channel.id 非法（小写字母开头、小写字母/数字/中划线）：${spec.id}`)
  if (typeof spec.listen !== 'function') throw new Error(`channel(${spec.id}).listen 必须是函数`)
  if (!spec.settings.enabled || !spec.settings.port) {
    throw new Error(`channel(${spec.id}).settings 需要 {enabled, port} 两个 Config 字段名`)
  }
  const unknown = Object.keys(spec).filter((k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k))
  if (unknown.length) throw new Error(`channel(${spec.id}) 含未声明字段：${unknown.join(',')}`)
  return Object.freeze({ ...spec })
}

/**
 * 通道清单自检：id 唯一、形状合格。组合根在装配前调用（启动即报，不是首个请求才炸）。
 *
 * @param {ReadonlyArray<object>} channels
 */
export function assertChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('channel: 清单为空')
  const seen = new Set()
  for (const ch of channels) {
    defineChannel(ch) // 形状（再次校验，防绕过 defineChannel 直接塞对象）
    if (seen.has(ch.id)) throw new Error(`channel.id 重复：${ch.id}`)
    seen.add(ch.id)
  }
  return seen
}
