#!/usr/bin/env node
/**
 * verify-pack.mjs — `package.json#files` 与仓库实况的**发布完整性**闸门（0.25.0）。
 *
 * 为什么需要：npm 发包只带 `files` 白名单里的东西，漏一个目录就是"装完就崩"——
 * 0.25.0 把组合根拆出 `host/` 之后，`files` 里没有它，发布出去的包会 import 失败。
 * 这类事故在本地永远测不出来（本地跑的是工作树，不是 tarball）。
 *
 * 判据（纯 JS，不依赖 `npm pack`——本机 ~/.npm 缓存可能属主不可写）：
 *   [1] 每个 `files` 条目在磁盘上存在（或作为目录存在）；
 *   [2] 运行期必需的文件都被 `files` 覆盖：index.js / host-config.js / host/**
 *       / core/** / providers/** / quota-view.js / credits.js / local-scan.js
 *       / lib/client.js / cordis.patch.yml；
 *   [3] `main` 与 `exports` 指向的文件存在；
 *   [4] 文档类（CHANGELOG/README/AGENTS/docs）也在白名单里（发布包含说明与判据）。
 *
 * 跑法：node scripts/verify-pack.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker } from './lib/harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ok, section, finish } = createChecker('verify-pack')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const files = Array.isArray(pkg.files) ? pkg.files : []

/** 目录（以 / 结尾）在 files 里出现，等价于覆盖其下全部文件（npm 语义）。 */
const coveredByDir = (rel) => files.some((f) => f.endsWith('/') && (rel === f.slice(0, -1) || rel.startsWith(f)))
const coveredExactly = (rel) => files.includes(rel) || coveredByDir(rel)

const walk = (rel) => {
  const out = []
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return out
  if (statSync(abs).isFile()) return [rel]
  for (const entry of readdirSync(abs).sort()) out.push(...walk(join(rel, entry)))
  return out
}

// ---------------------------------------------------------------------------
section('1. files 白名单条目都存在')
{
  for (const entry of files) {
    ok(`files 条目存在：${entry}`, existsSync(join(ROOT, entry)), entry)
  }
}

// ---------------------------------------------------------------------------
section('2. 运行期必需文件被白名单覆盖（漏=装完即崩）')
{
  const required = [
    'index.js', 'host-config.js', 'quota-view.js', 'credits.js', 'local-scan.js',
    'lib/client.js', 'cordis.patch.yml',
  ]
  for (const rel of required) {
    ok(`必需文件在白名单：${rel}`, coveredExactly(rel), rel)
  }
  for (const dir of ['host', 'core', 'providers']) {
    const missing = walk(dir).filter((f) => !coveredExactly(f))
    ok(`${dir}/ 全部文件被白名单覆盖（缺 ${missing.length}）`, missing.length === 0, missing.slice(0, 5).join(','))
  }
}

// ---------------------------------------------------------------------------
section('3. 入口指向的文件存在')
{
  ok('main 指向的文件存在', typeof pkg.main === 'string' && existsSync(join(ROOT, pkg.main)), String(pkg.main))
  const exportsMap = typeof pkg.exports === 'object' && pkg.exports ? pkg.exports : {}
  for (const [key, rel] of Object.entries(exportsMap)) {
    if (typeof rel !== 'string') continue
    ok(`exports["${key}"] 指向的文件存在（${rel}）`, existsSync(join(ROOT, rel)), rel)
    // package.json 是 npm 的隐式必带项（即便不在 files 里也会进 tarball）
    const relPath = rel.replace(/^\.\//, '')
    ok(`exports["${key}"] 也在 files 白名单里`, relPath === 'package.json' || coveredExactly(relPath), rel)
  }
  ok('dsh.bundle.patch 指向的文件存在',
    existsSync(join(ROOT, String(pkg?.dsh?.bundle?.patch ?? ''))), String(pkg?.dsh?.bundle?.patch))
}

// ---------------------------------------------------------------------------
section('4. 发布包含说明与判据')
{
  for (const doc of ['CHANGELOG.md', 'README.md', 'README.en.md', 'AGENTS.md', 'LICENSE', 'docs/pitfalls.md']) {
    ok(`发布包含 ${doc}`, coveredExactly(doc), doc)
  }
}

// ---------------------------------------------------------------------------
section('5. 反向检查：白名单声明了但磁盘上没有的目录')
{
  for (const entry of files.filter((f) => f.endsWith('/'))) {
    ok(`目录白名单存在且非空：${entry}`, walk(entry.slice(0, -1)).length > 0, entry)
  }
}

finish()
