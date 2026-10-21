#!/usr/bin/env node
// AGENTS.md 预算与引用完整性闸门（离线、零依赖；本地与 CI 同跑）。
// 锁三件事：①体积预算（行数/字节）②引用的本仓路径都存在 ③踩坑速查编号集 == docs/pitfalls.md 编号集且连续。
// 背景与动机见 docs/pitfalls.md #52。
import { readFileSync, existsSync } from 'node:fs';
import { createChecker } from './lib/harness.mjs';

const MAX_LINES = 150;
const MAX_BYTES = 12000;
// 断言记账走共享骨架：本套件历史调点是 ok(msg) / fail(msg)（消息里自带判据）。
const checker = createChecker('agents-md');
const ok = (m) => checker.check(m, true);
const fail = (m) => checker.check(m, false);

const buf = readFileSync('AGENTS.md');
const text = buf.toString('utf8');

const nLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
(nLines <= MAX_LINES ? ok : fail)(`AGENTS.md 行数 ${nLines} <= ${MAX_LINES}`);
(buf.length <= MAX_BYTES ? ok : fail)(`AGENTS.md 字节数 ${buf.length} <= ${MAX_BYTES}`);

// 引用路径存在性：只查白名单根前缀/裸文件名，URL 与 ~/.dsh 等不纳入
const ROOTS = ['docs/', 'wiki/', 'scripts/', 'providers/', 'core/', 'lib/', '.agents/', '.github/'];
const BARE = new Set(['AGENTS.md', 'CHANGELOG.md', 'cordis.patch.yml', 'package.json', 'index.js', 'host-config.js']);
const candidates = new Set();
for (const m of text.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?/g)) {
  const p = m[0];
  if (ROOTS.some((r) => p.startsWith(r))) candidates.add(p);
}
for (const m of text.matchAll(/[A-Za-z0-9_.-]+\.[a-z]+/g)) if (BARE.has(m[0])) candidates.add(m[0]);
for (const p of [...candidates].sort()) (existsSync(p) ? ok : fail)(`引用存在 ${p}`);

// 踩坑编号连续性：AGENTS.md 速查表 `#N` 集合 == pitfalls.md `^N.` 集合 == 1..max
const sec = text.match(/## 踩坑速查[\s\S]*?(?=\n## )/);
if (!sec) fail('踩坑速查章节缺失');
const agentNums = new Set(sec ? [...sec[0].matchAll(/`#(\d+)`/g)].map((m) => +m[1]) : []);
const pitText = readFileSync('docs/pitfalls.md', 'utf8');
const fileNums = new Set([...pitText.matchAll(/^(\d+)\.\s/gm)].map((m) => +m[1]));
const max = Math.max(...fileNums);
const continuous = fileNums.size === max && agentNums.size === max;
const sameSet = agentNums.size === fileNums.size && [...agentNums].every((n) => fileNums.has(n));
(sameSet && continuous ? ok : fail)(
  `踩坑编号连续对账 AGENTS.md=${agentNums.size} pitfalls.md=${fileNums.size} 1..${max}${sameSet && continuous ? '' : '（集合不一致或断号）'}`,
);

if (!checker.finish()) process.exit(1);
