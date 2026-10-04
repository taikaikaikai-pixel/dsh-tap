/**
 * providers/trae/catalog.js — Trae 本地模型目录接入。
 *
 * 数据源是本机 TRAE SOLO CN 的 VS Code 全局状态库（state.vscdb 的
 * AI.agent.model.model_list_map），由 scripts/trae-model-catalog.mjs 的纯函数
 * 负责（发现/复制/解析/归一化/scrub——该脚本的 CLI 入口带 import.meta 守卫，
 * 作为库导入不会执行 main）。这里只做"目录 → dsh 模型 profile"的映射与镜像。
 *
 * 映射规则（docs/reverse/trae-model-catalog.md 的字段说明为裁判）：
 *   - 只收 preset 型条目（provider 为空）——deepseek//… 等 BYOK 条目路由到
 *     用户自己的 provider，经 Trae 通道会失败；
 *   - id 用目录原 id（dsh 里模型 id 按 provider 命名空间隔离，与 codebuddy
 *     重名不冲突）；
 *   - contextWindow 取 contextWindowDefault，缺失回落 max（数组取最大档）；
 *   - maxTokens 取 maxOutputTokens；multimodal → input [text,image]。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  discoverStateDbs, copySqliteForRead, readModelListCandidates,
  selectDefaultCandidate, normalizeCatalog,
} from '../../scripts/trae-model-catalog.mjs'

// Trae 声明拼写 → 宿主枚举键（保序映射：light<high<extra_high ↔ low<high<xhigh）。
// 宿主 llm-pi-ai 对 models[].reasoningEfforts 的键有固定枚举
//（off|minimal|low|medium|high|xhigh|max）——声明拼写原样做键会被宿主 schema
// 整块拒收（2026-10-04 实测 host-config lastError），值则恒为目录声明拼写
//（remote 通道 custom_model.reasoning_effort 线值，不臆造，踩坑 #42）。
const TRAE_EFFORT_TO_HOST_KEY = { light: 'low', high: 'high', extra_high: 'xhigh' }

/** 目录条目 → dsh 模型 profile（可路由集合 = preset 且未禁用）。 */
export function catalogToProfiles(catalog) {
  const list = []
  for (const m of catalog?.models ?? []) {
    if (m.provider) continue // BYOK/托管条目不经 Trae 通道
    if (m.selectable === false || m.status === false) continue
    const p = { id: m.id, name: m.displayName ?? m.id }
    const ctx = m.contextWindowDefault
      ?? (Array.isArray(m.contextWindowMax) ? Math.max(...m.contextWindowMax) : m.contextWindowMax)
      ?? null
    if (ctx != null) p.contextWindow = ctx
    if (m.maxOutputTokens != null) p.maxTokens = m.maxOutputTokens
    if (m.multimodal === true) p.input = ['text', 'image']
    // 档位投影（goal: trae-work-cn-repair G3）：目录 reasoning_effort_config
    // 声明 {support_thinking, options, default_level} → reasoningEfforts。
    // supportThinking 非 true 或空 options 不出档（不摆假档位）；未映射拼写
    // 不进宿主表（仍可由设置卡档位控件按声明拼写使用）。
    const eff = m.reasoningEffortConfig
    if (eff && eff.supportThinking === true && Array.isArray(eff.options) && eff.options.length) {
      const table = {}
      for (const opt of eff.options) {
        const hostKey = TRAE_EFFORT_TO_HOST_KEY[opt]
        if (hostKey) table[hostKey] = opt
      }
      if (Object.keys(table).length) p.reasoningEfforts = table
    }
    list.push(p)
  }
  return list
}

/**
 * 从本机 state.vscdb 拉一次目录（发现 → 副本 → 解析 → 归一化）。
 * 返回 { profiles, catalog, fetchedAt, source }；任何一步失败抛错（调用方
 * 决定保底策略——沿用旧镜像或清空）。
 */
export function fetchLocalCatalog({ dbPath } = {}) {
  const target = dbPath ?? discoverStateDbs()[0]?.dbPath
  if (!target) throw new Error('未发现 TRAE SOLO CN 的 state.vscdb（需要 --db 或本机安装）')
  const tmp = mkdtempSync(join(tmpdir(), 'trae-catalog-'))
  try {
    const copy = copySqliteForRead(target, tmp)
    const candidates = readModelListCandidates(copy)
    for (const c of candidates) c.dbPath = target // 指纹指向原始路径
    const best = selectDefaultCandidate(candidates)
    if (!best) throw new Error('state.vscdb 中没有可解析的 model_list_map 候选')
    const catalog = normalizeCatalog(best)
    const profiles = catalogToProfiles(catalog)
    if (!profiles.length) throw new Error('目录归一化后无可路由模型（全为 BYOK 或禁用？）')
    return {
      profiles,
      catalog,
      fetchedAt: catalog.source.generatedAt,
      source: { candidateCount: candidates.length, chosen: catalog.source.itemKeyFingerprint },
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
