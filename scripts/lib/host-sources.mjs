/**
 * scripts/lib/host-sources.mjs — 静态闸门的**宿主半源码视图**。
 *
 * 为什么要这层：0.25.0 把组合根拆成 index.js + host/** 之后，一批静态断言
 * （"唯一实现""定义只在一处""某字段出现在视图里"）原来直接读 index.js 内容，
 * 拆一个文件就红一次——闸门跟着文件搬家，等于每拆一次都要改一遍断言。
 *
 * 约定：
 *  - `hostSource()` 返回 index.js + host/**\/*.js 的拼接文本：**"宿主半某处有"**
 *    这类断言用它（与文件位置无关）；
 *  - `hostFile(rel)` 读单个文件：确实要锁"某个定义落在哪个模块"时用它；
 *  - 全部相对仓库根解析，路径不存在直接抛（防止静默空扫描）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** host/ 下的全部 .js（递归，返回相对仓库根的路径，升序）。 */
export function hostFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (entry.endsWith('.js')) out.push(relative(ROOT, abs))
    }
  }
  walk(join(ROOT, 'host'))
  return out
}

/** @param {string} rel 相对仓库根的路径 */
export function hostFile(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** index.js + host/** 的拼接文本（"宿主半某处有"类断言用）。 */
export function hostSource() {
  return ['index.js', ...hostFiles()].map(hostFile).join('\n')
}
