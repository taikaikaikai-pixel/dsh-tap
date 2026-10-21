#!/usr/bin/env node
/**
 * verify-client-logic.mjs — 浏览器半「决策逻辑」离线回归（0.23.0 起）。
 *
 * 为什么需要这一层：`lib/client.js` 是宿主加载器直接执行的单文件（不能拆、不能
 * 相对导入、无构建步骤），浏览器套件在仓库外（`.agents/skills/dsh-ui-regression/`）
 * 且不进 CI。于是把「能判的判定」全部做成导出纯函数（见文件尾 exports），在这里
 * 用假 `window.__ModuleLoader__` + 假 react + 假 fetch 驱动，锁住四条纪律：
 *
 *   [1] 网关状态词汇（gwState）：off / pending / listening / error 与旧宿主回退
 *       ——客户端不再用 /未监听/ 正则判状态（文案一改就静默改行为）。
 *   [2] 状态芯片（buildChips）：三通道 tone/state 推导、宿主镜像失败可见。
 *   [3] 额度卡退避（quotaRetryDelay）：30→60→120→300s 封顶。
 *   [4] 资源包合并（aggregatePacks）：缺字段保 null，绝不变成「余 0.00」。
 *   [5] 排队重试条（pickQueueRetry）：结构化 queueHint 与文案兜底都能选出来。
 *   [6] 静态一致性：state 词汇与宿主 index.js 的 bridgeStateOf 同集合；客户端
 *       只有一份 fetchWithTimeout；不再有按文案判状态的遗留正则。
 *
 * 零网络、零凭据、零 DOM 真实渲染。跑法：node scripts/verify-client-logic.mjs
 */

import { readFileSync } from 'node:fs'
import { hostSource } from './lib/host-sources.mjs'

// ── 假运行环境（必须在 import client 之前就位）──────────────────────────────
const noop = () => {};
const mkEl = (tag) => ({
	tag, attrs: {}, children: [], textContent: "",
	setAttribute(k, v) { this.attrs[k] = v },
	appendChild(c) { this.children.push(c); return c },
});
const listeners = {};
const doc = (globalThis.document = {
	head: mkEl("head"),
	visibilityState: "visible",
	createElement: mkEl,
	querySelector: () => null,
	addEventListener: (t, fn) => { listeners[t] = fn },
	removeEventListener: noop,
});
const fetchCalls = [];
const view = {
	value: { bridgeEnabled: true, traeEnabled: true, qoderEnabled: true, bridgePort: 3901, traeBridgePort: 3902, qoderBridgePort: 3903 },
	oauth: { signedIn: true },
	bridge: { running: false, port: 3901, lastError: null, state: "pending", rateLimit: null },
	trae: { oauth: { signedIn: true }, bridge: { running: false, port: 3902, lastError: null, state: "pending" } },
	qoder: { oauth: { signedIn: true }, bridge: { running: true, port: 3903, lastError: null, state: "listening", queue: null } },
	models: { effectiveCount: 3 },
	host: { drift: [] },
	mirror: { codebuddy: { ok: true, at: 1, error: null }, trae: { ok: false, at: 1, error: "EACCES" }, qoder: null },
};
globalThis.fetch = (url) => {
	fetchCalls.push(String(url));
	const payload = () => (String(url).includes("probe=runtime") ? { ok: true, rateLimit: null, queue: null } : view);
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload()), text: () => Promise.resolve(JSON.stringify(payload())) });
};
globalThis.AbortController = class { constructor() { this.signal = {} } abort() {} };

globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m.factory(req) } } };
let mod;
function req(id) {
	if (id === "react") {
		return {
			createElement: () => null,
			useState: (v) => [typeof v === "function" ? v() : v, noop],
			useEffect: noop,
			useRef: (v) => ({ current: v === undefined ? null : v }),
			Fragment: "Fragment",
			Component: class { constructor(p) { this.props = p; this.state = {} } setState() {} },
		};
	}
	throw new Error("宿主模块不可用：" + id);
}
await import(new URL("../lib/client.js", import.meta.url).pathname);

let pass = 0;
let fail = 0;
const ok = (desc, cond, extra = "") => {
	if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}${extra ? " — " + extra : ""}`) }
};
const eq = (desc, actual, expected) => ok(desc, actual === expected, `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);
const section = (t) => console.log(`\n[${t}]`);

// ── [1] 网关状态词汇 ────────────────────────────────────────────────────────
section("1. gwState：结构化状态词（旧宿主回退同语义）");
{
	const g = mod.gwState;
	eq("禁用 ⇒ off", g(false, { running: true }), "off");
	eq("运行中 ⇒ listening", g(true, { running: true, state: "listening" }), "listening");
	eq("已启用未监听 ⇒ pending", g(true, { running: false }), "pending");
	eq("监听失败 ⇒ error", g(true, { running: false, lastError: "EADDRINUSE" }), "error");
	eq("宿主显式 state 优先（pending）", g(true, { running: true, state: "pending" }), "pending");
	eq("宿主显式 state 优先（error）", g(true, { running: false, state: "error" }), "error");
	eq("宿主非法 state 回退推导", g(true, { running: false, state: "bogus" }), "pending");
	eq("缺 bridge 视图不炸", g(true, null), "pending");
}

// ── [2] 状态芯片 ────────────────────────────────────────────────────────────
section("2. buildChips：三通道状态 + 镜像失败可见");
{
	const c = mod.buildChips(view);
	eq("codebuddy 桥 pending", c.bridge.state, "pending");
	eq("codebuddy 桥 warn", c.bridge.tone, "warn");
	eq("trae pending", c.trae.state, "pending");
	eq("trae 镜像失败 ⇒ 文案可见", /宿主配置写入失败/.test(c.trae.text), true);
	eq("trae 镜像失败 ⇒ 升到 warn", c.trae.tone, "warn");
	eq("qoder listening", c.qoder.state, "listening");
	eq("qoder ok", c.qoder.tone, "ok");
	eq("codebuddy 镜像成功不出现失败词", c.mirror, null);

	// 旧宿主：视图里没有 state 字段，仍按 running/lastError 推导
	const legacy = JSON.parse(JSON.stringify(view));
	delete legacy.bridge.state;
	delete legacy.trae.bridge.state;
	delete legacy.qoder.bridge.state;
	legacy.bridge.running = true;
	const cl = mod.buildChips(legacy);
	eq("旧宿主 running ⇒ listening", cl.bridge.state, "listening");
	eq("旧宿主 未监听 ⇒ pending", cl.trae.state, "pending");
}

// ── [3] 额度卡退避 ──────────────────────────────────────────────────────────
section("3. quotaRetryDelay：30/60/120/300 封顶");
{
	const d = mod.quotaRetryDelay;
	eq("第 1 次 30s", d(0), 30000);
	eq("第 2 次 60s", d(1), 60000);
	eq("第 3 次 120s", d(2), 120000);
	eq("第 4 次 300s", d(3), 300000);
	eq("超出封顶 300s", d(9), 300000);
	eq("负数按第 1 次", d(-3), 30000);
}

// ── [4] 资源包合并保 null ───────────────────────────────────────────────────
section("4. aggregatePacks：缺字段不变成 0");
{
	const agg = mod.aggregatePacks([
		{ name: "包A", remain: null, size: null, cycleRemain: null, cycleSize: null, cycleEnd: null },
		{ name: "包A", remain: 10, size: 100, cycleRemain: 10, cycleSize: 100, cycleEnd: "2026-11-01" },
	]);
	eq("同名合并 count", agg[0].count, 2);
	eq("null+10 ⇒ 10（不是 0）", agg[0].remain, 10);
	eq("null+null ⇒ null（不是 0）", mod.aggregatePacks([{ name: "B", remain: null }])[0].remain, null);
	eq("纯 null 组 size 保持 null", mod.aggregatePacks([{ name: "C", size: null }])[0].size, null);
	eq("cycleEnd 取最早", agg[0].cycleEnd, "2026-11-01");
}

// ── [5] 排队重试条 ──────────────────────────────────────────────────────────
section("5. pickQueueRetry：结构化 queueHint + 文案兜底");
{
	const snap = (message) => ({
		nodes: [{ kind: "model-retry", data: { current: { retryState: "scheduled", provider: "qoder", retry: 3, delayMs: 30000, failure: { message } } } }],
	});
	const fresh = { model: "dfmodel", at: Date.now(), retryAfter: 30 };
	const stale = { model: "dfmodel", at: Date.now() - 600000, retryAfter: 30 };
	ok("文案含排队 ⇒ 选中", !!mod.pickQueueRetry(snap("上游排队中，请稍候"), null));
	ok("文案不含但 queueHint 新鲜 ⇒ 选中", !!mod.pickQueueRetry(snap("HTTP 429"), fresh));
	eq("文案不含且 queueHint 陈旧 ⇒ 不选", mod.pickQueueRetry(snap("HTTP 429"), stale), null);
	eq("非排队通道（provider 不在白名单）⇒ 不选", mod.pickQueueRetry({
		nodes: [{ kind: "model-retry", data: { current: { retryState: "scheduled", provider: "other", failure: { message: "排队" } } } }],
	}, null), null);
	eq("retryState 非 scheduled ⇒ 不选", mod.pickQueueRetry({
		nodes: [{ kind: "model-retry", data: { current: { retryState: "done", provider: "qoder", failure: { message: "排队" } } } }],
	}, null), null);
}

// ── [6] 静态一致性 ──────────────────────────────────────────────────────────
section("6. 静态一致性（宿主/客户端同词汇、单实现）");
{
	const { readFileSync } = await import("node:fs");
	const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const host = hostSource(); // index.js + host/**（0.25.0 组合根拆分后不再假设单一文件）

	// 宿主 bridgeStateOf 的返回集合必须与客户端 GW_STATES 同集合。
	// 0.25.0 起 bridgeStateOf 在 host/settings/view.js（组合根拆分）：读宿主半拼接源，
	// 不假设定义留在哪个文件。
	const hostFn = host.match(/function bridgeStateOf\([\s\S]*?\n}/);
	const hostBody = hostFn ? hostFn[0] : "";
	const hostStates = ["off", "listening", "pending", "error"].filter((s) => hostBody.includes(`'${s}'`));
	eq("宿主 bridgeStateOf 声明 4 个状态词", JSON.stringify(hostStates), JSON.stringify(["off", "listening", "pending", "error"]));
	ok("客户端 GW_STATES 含同一组词", ["off", "pending", "listening", "error"].every((s) => client.includes(`"${s}"`)));

	eq("fetchWithTimeout 只有一份实现", (client.match(/function fetchWithTimeout\s*\(/g) || []).length, 1);
	ok("不再按「未监听」文案判状态", !/test\(x\.text\)[\s\S]{0,80}未监听/.test(client));
	ok("客户端不做 JSON.parse 前的 r.json() 猜测用于额度主路径", !/quota-all[\s\S]{0,400}r\.json\(\)/.test(client));
	ok("退避序列只在一处定义", (client.match(/\[30000, 60000, 120000, 300000\]/g) || []).length === 1);
}

console.log(`\n=== verify-client-logic: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
