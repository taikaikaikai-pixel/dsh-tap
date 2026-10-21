/**
 * verify-picker-badge.mjs — 主界面输入框模型选择器的徽标装饰离线回归。
 *
 * 浏览器半（lib/client.js） normally 由 dsh-ui-test/ 的 puppeteer 套件覆盖；
 * 这里的假 DOM 只跑**装饰数据层**（不渲染设置卡）：window.__ModuleLoader__ 拿到
 * factory → 假 react require → apply(假 ctx) → 假 fetch 喂视图 → 断言 <style> 里的
 * ::after 规则。锁的是三条口径：
 *   1. 加载即出徽标，且**零额外请求**（限流/排队搭全量 GET 的便车）；
 *   2. 上游文案绝不进 CSS——恢复时刻用本地时钟从 epoch 现算，模型 id 里的引号必须转义；
 *   3. 时效与设置卡同构：恢复时刻已过 / 排队超 5 分钟 = 不显示；按需刷新（点选择器、
 *      回前台）带 5s 节流，稳态零轮询。
 *
 * 跑法：node scripts/verify-picker-badge.mjs
 */
const listeners = {};
const mk = (tag) => ({
	tagName: tag, children: [], attrs: {}, textContent: "",
	setAttribute(k, v) { this.attrs[k] = v },
	appendChild(c) { this.children.push(c); return c },
});
const doc = (globalThis.document = {
	head: mk("head"), visibilityState: "visible", createElement: mk,
	querySelector: () => doc.head.children.find((c) => c.attrs["data-plugin-css"] === "dsh-tap-credits") || null,
	addEventListener: (t, fn) => { listeners[t] = fn },
});
const calls = [];
let probe = null;
globalThis.fetch = (url) => {
	calls.push(String(url));
	// 两个读者都要支持：客户端对设置服务走 text()（非 JSON 错误页也要能读），
	// 探针与旧路径可能走 json()。返回同一份载荷。
	const payload = () => (String(url).includes("probe=runtime") ? probe : view);
	return Promise.resolve({
		ok: true, status: 200,
		json: () => Promise.resolve(payload()),
		text: () => Promise.resolve(JSON.stringify(payload())),
	});
};
globalThis.AbortController = class { constructor() { this.signal = {} } abort() {} };
// 可控时钟：断点②③ 要把"5 分钟窗口已过/未到"跑出来，不能等真时间。
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

let view = null;
globalThis.window = { __ModuleLoader__: { load: (m) => { exports_ = m.factory(req) } } };
let exports_;
function req(id) {
	if (id === "react") {
		return {
			createElement: () => null, useState: () => [null, () => {}], useEffect: () => {},
			useRef: () => ({ current: null }), Fragment: "Fragment",
			Component: class { constructor(p) { this.props = p; this.state = {} } setState() {} },
		};
	}
	throw new Error("宿主模块不可用：" + id); // 踩坑 #9：浏览器半必须能在缺原语时降级
}
import { createChecker } from "./lib/harness.mjs";

await import(new URL("../lib/client.js", import.meta.url).pathname);

const flush = () => new Promise((r) => setTimeout(r, 0));
const css = () => doc.querySelector().textContent;
// 断言记账走共享骨架（scripts/lib/harness.mjs）。
const { ok, finish } = createChecker("verify-picker-badge");

// 恢复时刻取「未来 30 分钟」并现算 HH:mm——fixture 禁绝对日期（踩坑 #38）：
// 写死本地时刻的测试在钟点过后必然把「限流徽标」测成空（2026-10-21 实发）。
const pad = (n) => String(n).padStart(2, "0");
const resetAt = Math.floor((Date.now() + 30 * 60 * 1000) / 1000) * 1000;
const resetHHMM = `${pad(new Date(resetAt).getHours())}:${pad(new Date(resetAt).getMinutes())}`;
view = {
	credits: { codebuddy: { "glm-5.3": "0.51" } },
	bridge: { rateLimit: { model: "deepseek-v4.1-flash", resetAt, resetText: "2026-10-21 11:42:24 UTC+8 重置…", at: Date.now() } },
	qoder: { bridge: { queue: { model: "dfmodel", queueType: "p3", retryAfter: 30, at: Date.now() } } },
};

console.log("[1] 加载即出徽标（搭全量 GET 的便车）");
exports_.apply({ inject: () => {} });
await flush();
ok("限流徽标 + 本地时钟恢复时刻", css().includes(`content:"限流中 · ${resetHHMM} 恢复"`), css());
ok("排队徽标 + retryAfter", css().includes('content:"排队中 · 约30s"'));
ok("倍率徽标同表共存", css().includes('content:"x0.51"'));
ok("零额外请求", calls.length === 1, JSON.stringify(calls));

console.log("[1b] trigger 换锚点（label 是截断盒，行内末尾的 ::after 会被整枚裁掉）");
{
	const t = css();
	const trig = 'button[aria-haspopup="menu"]:has([data-provider-id="codebuddy"][data-model-id="deepseek-v4.1-flash"])';
	ok("trigger 规则挂在 button 上（:has 锚点）", t.includes(trig + "::after{order:1;flex:none;"), t);
	ok("trigger 用短文案（限流 · HH:mm，不带「恢复」）", t.includes(`content:"限流 · ${resetHHMM}"`));
	ok("label 盒里的同一枚被 content:none 关掉（不重复、不留空白碎片）",
		t.includes(':has([data-provider-id="codebuddy"][data-model-id="deepseek-v4.1-flash"]) [data-provider-id="codebuddy"][data-model-id="deepseek-v4.1-flash"]::after{content:none}'));
	ok("effort/箭头排到徽标之后（恰一条 order 规则）", t.split("nth-child(n+3){order:2}").length - 1 === 1, t);
	ok("菜单/选项里仍是全文徽标", t.includes(`content:"限流中 · ${resetHHMM} 恢复"`));
	ok("排队 trigger 短文案 = 排队", t.includes('content:"排队"'));
	ok("倍率模型不被误关（仍走 label 盒）", !t.includes(':has([data-provider-id="codebuddy"][data-model-id="glm-5.3"])'));
}

console.log("[2] 上游文案不进 CSS");
ok("网关 resetText 未落地", !css().includes("重置"));

console.log("[3] 时效与刷新（陈旧态不显示 / 按需刷新带节流）");
probe = { ok: true, rateLimit: { model: "m1", resetAt: Date.now() - 1000, at: Date.now() }, queue: { model: "q1", at: Date.now() - 301000 } };
listeners.visibilitychange();
await flush();
ok("已过恢复点 + 排队超 5 分钟 ⇒ 全清", !css().includes("限流中") && !css().includes("排队中"), css());
offset += 6000; // 出节流窗口
probe = { ok: true, rateLimit: { model: 'x";body{color:red}', resetAt: Date.now() + 60000, at: Date.now() }, queue: null };
const n = calls.length;
listeners.click({ target: { closest: (s) => (s === "[data-model-id]" ? {} : null) } });
await flush();
ok("点选择器 → 一次 probe=runtime", calls.length === n + 1 && calls[calls.length - 1].includes("probe=runtime"), JSON.stringify(calls.slice(n)));
ok("模型 id 里的引号被转义（不脱出选择器）", css().includes('x\\";body') && !css().includes('x";body'), css());
ok("徽标照常出", css().includes("限流中"));
listeners.click({ target: { closest: (s) => (s === "[data-model-id]" ? {} : null) } });
await flush();
ok("5s 内连点不连发", calls.length === n + 1, JSON.stringify(calls.slice(n)));

console.log("[4] 排队重试条数据选择器（pickQueueRetry）");
{
	const pick = exports_.pickQueueRetry;
	const node = (over) => ({
		kind: "model-retry",
		data: {
			current: Object.assign({
				provider: "qoder", retry: 1, delayMs: 30000, seq: 10, retryState: "scheduled",
				failure: { code: "RATE_LIMIT", message: "Qoder 模型 dfmodel 排队中（queueType=p3）" },
			}, over),
		},
	});
	const snap = (...nodes) => ({ nodes: new Map(nodes.map((n, i) => [String(i), n])) });
	ok("qoder 排队态被选中", pick(snap(node({})))?.retry === 1);
	ok("started 不选中", pick(snap(node({ retryState: "started" }))) === null);
	ok("codebuddy 频率限制不选中（不误判成排队）",
		pick(snap(node({ provider: "codebuddy", failure: { code: "RATE_LIMIT", message: "CodeBuddy 频率限制：该模型当前用量已超限" } }))) === null);
	ok("其它 provider 不选中", pick(snap(node({ provider: "deepseek", failure: { code: "RATE_LIMIT", message: "429 rate limit" } }))) === null);
	ok("空快照不炸", pick(null) === null && pick({}) === null && pick({ nodes: new Map() }) === null);
	ok("多行取 retry 最大", pick(snap(
		node({ retry: 2, seq: 11 }),
		node({ retry: 1, seq: 10 }),
	))?.retry === 2);
}

console.log("[5] 排队重试条 dock 注册（slot wiring）");
{
	const regs = [];
	const fakeSlots = {
		inject: (key, fn) => { regs.push({ inject: key }); try { fn(); } catch {} },
		register: (opts, comp) => { regs.push({ register: opts, comp }); return () => {}; },
	};
	exports_.apply({ inject: (deps, cb) => cb({ slots: fakeSlots }) });
	await flush();
	const dock = regs.find((r) => r.register && r.register.name === "conversation.input.dock");
	ok("apply 注册 conversation.input.dock", !!dock, JSON.stringify(regs.map((r) => r.inject ?? r.register?.name)));
	ok("dock id = dsh-tap-queue（不覆盖宿主 queue 条目）", dock?.register?.id === "dsh-tap-queue", JSON.stringify(dock?.register));
	ok("dock 渲染组件是函数", typeof dock?.comp === "function");
}

// 浏览器半的假环境常驻定时器（quota 心跳/退避）：显式退出，别等事件循环空。
process.exit(finish() ? 0 : 1);
