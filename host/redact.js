/**
 * host/redact.js — 回传浏览器前的**脱敏原语**（0.25.0 从 index.js 拆出）。
 *
 * 单独成文件是为了断开环：登记册（`extraProvidersView` 的 maskedKey）与设置
 * 视图（`maskedUserLayer`）都要用它，而登记册与视图互相不该 import。这里零
 * 依赖，谁都能用。
 *
 * 纪律（踩坑 #26）：密钥只回 `前4…末4`；文件层整体回传前必须过 maskedUserLayer。
 */


/** Mask a key for display: first 4 and last 4 characters. */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * File layer safe to ship to the browser: plaintext apiKeys[].key masked away.
 * Same policy as the GET view — f9aeeaa covered GET only; the four POST
 * responses that also carried the raw file layer regressed it. The card
 * consumes `user` solely for top-level field presence (overriddenFor →
 * hasOwnProperty), never nested key material — masking here is lossless.
 */
export function maskedUserLayer(user) {
  return Array.isArray(user.apiKeys)
    ? { ...user, apiKeys: user.apiKeys.map((k) => ({ ...k, key: maskKey(k.key) })) }
    : user
}
