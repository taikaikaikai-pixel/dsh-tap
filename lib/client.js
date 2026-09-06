/**
 * Browser half of dsh-tap: a settings card in Settings → 插件配置.
 *
 * Interaction model (2026-09 redesign): the card is the only thing the host
 * slot gives us, so intuitiveness comes from three layers instead of one
 * long scroll —
 *   1. Collapsed: the header carries three live status chips (登录 / 模型数 /
 *      流式桥), so the card is readable without expanding.
 *   2. Expanded: a status strip of six clickable chips (jump straight to the
 *      owning tab) above a horizontal tab bar — the same tab pattern the
 *      host's own settings dialog uses.
 *   3. Tabs (登录 / 模型 / 额度与用量 / 工具 / 服务商 / TraeWork CN / 桥与高级)
 *      lazy-mount on first visit and then stay mounted hidden, so drafts,
 *      scroll positions and fetched catalogs survive both tab switches and
 *      saves. Heavy work stays lazy: model-list / provider-list / trae
 *      model-list load when their tab first opens; the usage poller only
 *      runs while the 额度与用量 tab is active.
 *
 * Every schema field in index.js SETTINGS_FIELDS has a home here, plus the
 * two stateful surfaces that are not plain fields: per-model enable/limits
 * (CodeBuddy + Trae) and the extra OpenAI-compatible providers registry.
 *
 * Talks to the host route /dsh-tap/settings:
 *   GET  → { value, user, fields, oauth, bridge, models, trae }
 *   POST → { patch } | { action: 'oauth-start'|'oauth-status'|'oauth-logout'
 *          |'model-list'|'model-sync'|'usage'|'provider-*'|'credential-*'
 *          |'trae-oauth-*'|'trae-model-*' }
 *   ('usage' → { usage, bridge, quota }: live consumption metered by the
 *   bridge from the gateway's per-request usage.credit, plus the account-side
 *   quota signals; OAuth mode gets numeric remaining quota from
 *   /billing/meter/get-user-resource (docs/rules/quota-signals.md R-Q7),
 *   api-key mode falls back to a manual-total estimate, labeled 估算.)
 *
 * Loaded by the dsh web client module loader via package.json
 * exports["./client"]. No build step: plain React.createElement.
 *
 * Host resources this module reuses (see AGENTS.md):
 * - `@deepseek-ai/dsh-client-ui-primitives` (Button/Input/icons) — a
 *   platform seed module, require()'d with a native-element fallback so the
 *   card still renders if the primitives table ever goes missing.
 * - The `--dsw-alias-*` design tokens (never hard-coded colors; dark theme
 *   follows automatically via body[data-ds-dark-theme]). Two token names do
 *   NOT exist upstream (`--dsw-alias-accent`, `--dsw-alias-label-error`) —
 *   use state-business-primary / state-error-primary instead.
 * - Styling follows the host's own protocol: one injected
 *   <style data-plugin="dsh-tap" data-plugin-css="card"> block,
 *   cbc- prefixed classes, card shell mirrored from the first-party
 *   PluginCard (border-l2, bg-layer-3 → open bg-layer-2, radius 12,
 *   padding 14/16).
 *
 * House rules (hard-won, see AGENTS.md pitfalls): all hooks before any
 * conditional return; window.open must fire synchronously inside the click
 * handler or popup blockers eat it; controlled checkboxes can fire change
 * twice — debounce against a useRef table (a per-render object is rebuilt
 * every render and never debounces); field editor components must live at
 * module level or typing loses focus.
 */
window.__ModuleLoader__.load({
	id: "dsh-tap",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var createElement = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useRef = react.useRef;
		var Fragment = react.Fragment;

		// Platform primitives are a seed module; require defensively anyway —
		// a missing table must degrade to native elements, not a dead card.
		var ui = null;
		try { ui = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { ui = null; }
		var UIButton = ui && ui.Button ? ui.Button : null;
		var UIInput = ui && ui.Input ? ui.Input : null;
		var IconChevron = ui && ui.IconChevronDownOutline14 ? ui.IconChevronDownOutline14 : null;
		var IconRefresh = ui && ui.IconRefreshOutline14 ? ui.IconRefreshOutline14 : null;

		var ROUTE = "/dsh-tap/settings";

		// ------------------------------------------------------------------
		// Styles: one injected block, cbc- prefixed, token-backed. Idempotent.
		// ------------------------------------------------------------------
		var CSS_TEXT = [
			// ---- card shell（镜像第一方 PluginCard：radius 12 / border-l2 / 层级底色）----
			".cbc-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);list-style:none;transition:border-color .16s}",
			".cbc-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}",
			".cbc-card.cbc-open{background:var(--dsw-alias-bg-layer-2,#fff)}",
			".cbc-header{all:unset;display:flex;width:100%;box-sizing:border-box;padding:14px 16px;cursor:pointer;align-items:center;justify-content:space-between;gap:12px;border-radius:12px}",
			".cbc-header:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:-2px}",
			".cbc-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-desc{font-size:13px;color:var(--dsw-alias-label-tertiary,gray);margin-top:2px}",
			".cbc-headchips{display:flex;gap:6px;flex:0 0 auto}",
			".cbc-chevron{display:inline-flex;color:var(--dsw-alias-label-tertiary,gray);font-size:12px;transition:transform .16s}",
			".cbc-chevron.cbc-open{transform:rotate(180deg)}",
			".cbc-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));margin:0 16px;padding:10px 0 12px;display:flex;flex-direction:column}",
			// ---- 状态条：可点击芯片（点击直跳分区）----
			".cbc-strip{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}",
			".cbc-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;padding:5px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;box-sizing:border-box}",
			"button.cbc-chip{all:unset;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;padding:5px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;cursor:pointer;box-sizing:border-box}",
			"button.cbc-chip:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5));color:var(--dsw-alias-label-primary,inherit)}",
			"button.cbc-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px}",
			".cbc-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary,gray)}",
			".cbc-dot.cbc-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}",
			".cbc-dot.cbc-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".cbc-dot.cbc-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			// ---- 标签页 ----
			".cbc-tabs{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));margin:0 0 2px;overflow-x:auto}",
			".cbc-tab{all:unset;display:inline-flex;align-items:center;gap:5px;font-size:13px;line-height:1;padding:9px 10px 8px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;cursor:pointer;border-bottom:2px solid transparent}",
			".cbc-tab:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:-2px}",
			".cbc-tab.cbc-active{color:var(--dsw-alias-label-primary,inherit);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-tabcount{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,gray);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:1px 5px}",
			".cbc-tabcount.cbc-ok{color:var(--dsw-alias-state-success-primary,#2a9d4a);border-color:rgba(42,157,74,.35)}",
			".cbc-tabcount.cbc-warn{color:var(--dsw-alias-state-warn-primary,#b80);border-color:rgba(187,136,0,.4)}",
			".cbc-saveflash{margin-left:auto;font-size:12px;color:var(--dsw-alias-state-success-primary,#2a9d4a);padding:0 8px;white-space:nowrap}",
			".cbc-panel{padding:8px 0 4px}",
			".cbc-panel[hidden]{display:none}",
			// ---- 分区通用 ----
			".cbc-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);margin:0 0 10px}",
			".cbc-divider{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));margin:4px 0}",
			".cbc-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}",
			".cbc-row-label{flex:0 0 132px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-row-control{flex:1;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
			".cbc-check{width:16px;height:16px;flex:0 0 auto;accent-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);margin:4px 0 6px;line-height:1.5}",
			".cbc-status{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);line-height:1.5}",
			".cbc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid rgba(211,51,51,.35);border-radius:8px;padding:6px 10px;margin:6px 0}",
			".cbc-error-close{all:unset;cursor:pointer;font-size:13px;padding:0 4px;color:inherit;display:inline-flex}",
			".cbc-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b80);line-height:1.5;margin:4px 0}",
			".cbc-muted{color:var(--dsw-alias-label-tertiary,gray);font-size:12px}",
			".cbc-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,gray);margin:10px 0 6px}",
			".cbc-link{color:var(--dsw-alias-state-business-primary,#1a66ff);text-decoration:none}",
			".cbc-link:hover{text-decoration:underline}",
			// ---- 列表行 / 徽标 ----
			".cbc-listrow{display:flex;align-items:center;flex-wrap:wrap;row-gap:2px;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin-bottom:6px;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-cell-name{font-weight:600;min-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-cell-masked{color:var(--dsw-alias-label-tertiary,gray);flex:1;font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".cbc-badge{font-size:11px;color:var(--dsw-alias-state-success-primary,#2a9d4a);border:1px solid rgba(42,157,74,.35);border-radius:4px;padding:1px 4px;white-space:nowrap;flex:0 0 auto}",
			".cbc-effort{font-size:11px;color:var(--dsw-alias-label-tertiary,gray);font-family:var(--ds-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;flex:0 0 auto}",
			".cbc-model-name{font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-tname{font-weight:600;flex:0 1 auto;min-width:90px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-model-ctx{font-size:11px;font-family:var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary,gray);white-space:nowrap;flex:0 0 auto}",
			".cbc-radio{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-radio input{accent-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-mode{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:10px;padding:2px;gap:2px}",
			".cbc-mode .cbc-radio{padding:5px 14px;border-radius:8px}",
			// ---- 额度 hero / 统计卡 ----
			".cbc-hero{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;padding:12px 14px;margin:6px 0 10px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-hero-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}",
			".cbc-hero-label{font-size:12px;color:var(--dsw-alias-label-tertiary,gray)}",
			".cbc-hero-num{font-size:24px;font-weight:700;color:var(--dsw-alias-label-primary,inherit);font-family:var(--ds-font-family-number,var(--ds-font-family-code,inherit))}",
			".cbc-hero-unit{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary,gray);margin-left:4px}",
			".cbc-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,#eee);margin:8px 0 6px;overflow:hidden}",
			".cbc-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-hero-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);line-height:1.5}",
			".cbc-stats{display:flex;gap:8px;margin:8px 0}",
			".cbc-stat{flex:1;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;padding:10px 12px;min-width:0}",
			".cbc-statlabel{font-size:12px;color:var(--dsw-alias-label-tertiary,gray)}",
			".cbc-statnum{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);margin:3px 0 1px}",
			".cbc-minibar{display:inline-block;width:56px;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,#eee);overflow:hidden;vertical-align:middle;margin-right:6px;flex:0 0 auto}",
			".cbc-minibar-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-toggle{all:unset;display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;color:var(--dsw-alias-state-business-primary,#1a66ff);white-space:nowrap}",
			".cbc-toggle:hover{text-decoration:underline}",
			// ---- 控件 ----
			".cbc-w90{width:90px}.cbc-w110{width:110px}.cbc-w140{width:140px}.cbc-w200{width:200px}.cbc-w220{width:220px}.cbc-w260{width:260px}.cbc-wfull{width:100%}",
			".cbc-danger{color:var(--dsw-alias-state-error-primary,#d33)!important}",
			".cbc-select{font:inherit;font-size:13px;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-input{font:inherit;font-size:13px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#1a66ff);outline:none}",
			".cbc-btn{all:unset;display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:4px 10px;border-radius:14px;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-btn-outline{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4))}",
			".cbc-btn-primary{background:var(--dsw-alias-button-primary-fill,#1a66ff);color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".cbc-btn:disabled{cursor:not-allowed;opacity:.4}",
			".cbc-scrollbox{max-height:300px;overflow-y:auto}",
			".cbc-addrow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}",
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-tap-card"]')) return;
			var el = document.createElement("style");
			// Host protocol: data-plugin / data-plugin-css let the module loader
			// attribute (and hot-clean) injected styles per plugin.
			el.setAttribute("data-plugin", "dsh-tap");
			el.setAttribute("data-plugin-css", "dsh-tap-card");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}
		ensureStyles();

		// ------------------------------------------------------------------
		// Control adapters: primitives when available, native fallback when not.
		// ------------------------------------------------------------------
		function CbcButton(props) {
			if (UIButton) {
				return createElement(UIButton, {
					variant: props.variant || "outline",
					size: "sm",
					icon: props.icon || undefined,
					className: props.danger ? "cbc-danger" : undefined,
					type: "button",
					title: props.title,
					disabled: props.disabled,
					onClick: props.onClick,
				}, props.children);
			}
			return createElement("button", {
				type: "button",
				className: "cbc-btn cbc-btn-" + (props.variant || "outline") + (props.danger ? " cbc-danger" : ""),
				title: props.title,
				disabled: props.disabled,
				onClick: props.onClick,
			}, props.icon || null, props.children);
		}

		function CbcInput(props) {
			var w = props.widthClass || "cbc-wfull";
			var shared = {
				type: props.type || "text",
				value: props.value,
				placeholder: props.placeholder,
				onInput: props.onInput,
				onBlur: props.onBlur,
				onKeyDown: props.onKeyDown,
			};
			if (UIInput) return createElement(UIInput, Object.assign({ className: w }, shared));
			return createElement("input", Object.assign({ className: "cbc-input " + w }, shared));
		}

		// 状态点：ok 绿 / warn 黄 / err 红 / off 灰（token 驱动，深色主题自动跟随）。
		function Dot(props) {
			return createElement("span", { className: "cbc-dot" + (props.tone ? " cbc-" + props.tone : "") });
		}

		function fmtTime(ms) {
			if (!ms) return "";
			var d = new Date(ms);
			var p = function (n) { return n < 10 ? "0" + n : "" + n; };
			return (d.getMonth() + 1) + "-" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}
		function fmtCredit(n) {
			if (n == null) return "-";
			return (Math.round(n * 100) / 100).toFixed(2);
		}
		function fmtHit(hit, miss) {
			var total = (hit || 0) + (miss || 0);
			if (!total) return "-";
			return Math.round((hit / total) * 100) + "%";
		}
		function pct(remain, size) {
			if (!size || size <= 0) return null;
			return Math.max(0, Math.min(100, Math.round((remain / size) * 100)));
		}

		// ------------------------------------------------------------------
		// Tabs. Order = dependency order: everything else keys off the
		// credential, so 登录 is first; 桥与高级 collects the plumbing.
		// ------------------------------------------------------------------
		var TAB_DEFS = [
			{ id: "login", title: "登录" },
			{ id: "models", title: "模型" },
			{ id: "usage", title: "额度与用量" },
			{ id: "tools", title: "工具" },
			{ id: "providers", title: "服务商" },
			{ id: "trae", title: "TraeWork CN" },
			{ id: "bridge", title: "桥与高级" },
		];
		var PANEL_RENDERERS = {};

		// ------------------------------------------------------------------
		// Root card.
		// ------------------------------------------------------------------
		function CodeBuddyCard() {
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var dataState = useState(null);
			var data = dataState[0];
			var setData = dataState[1];
			var errState = useState("");
			var err = errState[0];
			var setErr = errState[1];
			var tabState = useState("login");
			var activeTab = tabState[0];
			var setActiveTab = tabState[1];
			// 懒挂载：分区首次访问才 mount，之后保持挂载（隐藏不卸载）——草稿、
			// 滚动、已拉取的目录跨标签切换与保存都保留（step22 的不变式）。
			var mountedState = useState({ login: true });
			var mounted = mountedState[0];
			var setMounted = mountedState[1];
			var savedState = useState(0);
			var savedAt = savedState[0];
			var setSavedAt = savedState[1];

			var load = function () {
				fetch(ROUTE, { headers: { accept: "application/json" } })
					.then(function (r) {
						// Tolerate a non-JSON error page instead of dying in the
						// parser and misreporting it as a network failure.
						return r.text().then(function (t) {
							var d = null;
							try { d = JSON.parse(t); } catch (e) { /* not JSON */ }
							if (d == null) throw new Error("设置服务返回了非 JSON（HTTP " + r.status + "）");
							return d;
						});
					})
					.then(function (d) { setData(d); setErr(""); })
					.catch(function (e) { setErr(e && e.message ? e.message : "设置服务不可达"); });
			};
			// Mount 即拉一次（折叠态头部芯片要有真值），每次展开再刷新。
			useEffect(function () {
				load();
				return undefined;
			}, [open]);

			var post = function (body) {
				return fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}).then(function (r) {
					return r.text().then(function (t) {
						var d = null;
						try { d = JSON.parse(t); } catch (e) { /* not JSON */ }
						return { ok: r.ok, status: r.status, d: d || {} };
					});
				});
			};
			var save = function (patch) {
				post({ patch: patch }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "保存失败（HTTP " + res.status + "）"); return; }
					setSavedAt(Date.now());
					load();
				}).catch(function () { setErr("保存失败（网络）"); });
			};

			// “已保存 ✓”短提示：1.8s 后自动消失（保存成功无其他反馈曾是盲区）。
			useEffect(function () {
				if (!savedAt) return undefined;
				var t = setTimeout(function () { setSavedAt(0); }, 1800);
				return function () { clearTimeout(t); };
			}, [savedAt]);

			var switchTab = function (id) {
				setActiveTab(id);
				setMounted(function (prev) {
					if (prev[id]) return prev;
					var next = Object.assign({}, prev);
					next[id] = true;
					return next;
				});
			};

			var chevron = IconChevron
				? createElement("span", { className: "cbc-chevron" + (open ? " cbc-open" : "") }, createElement(IconChevron, { size: 14 }))
				: createElement("span", { className: "cbc-chevron" + (open ? " cbc-open" : "") }, "▾");

			// 折叠态头部芯片（span，非按钮——头部是卡内第一个 button，测试靠它展开）。
			var headChips = null;
			if (!open && data) {
				var chips = buildChips(data);
				headChips = createElement("span", { className: "cbc-headchips" },
					[chips.login, chips.models, chips.bridge].map(function (c, i) {
						return createElement("span", { key: i, className: "cbc-chip" }, createElement(Dot, { tone: c.tone }), c.text);
					}));
			}

			var header = createElement(
				"button",
				{ type: "button", className: "cbc-header", "aria-expanded": open ? "true" : "false", onClick: function () { setOpen(!open); } },
				createElement("span", null,
					createElement("div", { className: "cbc-name" }, "dsh-tap"),
					createElement("div", { className: "cbc-desc" }, "CodeBuddy 网关与 Trae 订阅通道接入：凭据、模型、额度、工具与流式桥。")),
				headChips,
				chevron,
			);
			var cardClass = "cbc-card" + (open ? " cbc-open" : "");
			if (!open) return createElement("li", { className: cardClass }, header);
			if (!data) {
				return createElement("li", { className: cardClass }, header,
					createElement("div", { className: "cbc-body" }, createElement("p", { className: "cbc-status" }, err || "正在读取设置…")));
			}

			var chips = buildChips(data);
			var errorBanner = err
				? createElement("p", { className: "cbc-error" },
					createElement("span", null, err),
					createElement("button", { type: "button", className: "cbc-error-close", title: "关闭", onClick: function () { setErr(""); } }, "✕"))
				: null;

			// 状态条：每枚芯片可点击，直跳所属分区。
			var strip = createElement("div", { className: "cbc-strip" },
				[chips.login, chips.models, chips.bridge, chips.search, chips.image, chips.trae].map(function (c, i) {
					return createElement("button", {
						key: i, type: "button", className: "cbc-chip", title: "查看" + c.tabTitle,
						onClick: function () { switchTab(c.tab); },
					}, createElement(Dot, { tone: c.tone }), c.text);
				}));

			// 标签栏：徽标数字来自 GET 视图；右侧为保存成功短提示。
			var badge = tabBadge(data);
			var tabBar = createElement("div", { className: "cbc-tabs", role: "tablist" },
				TAB_DEFS.map(function (def) {
					var b = badge[def.id];
					return createElement("button", {
						key: def.id, type: "button", role: "tab",
						className: "cbc-tab" + (activeTab === def.id ? " cbc-active" : ""),
						"aria-selected": activeTab === def.id ? "true" : "false",
						onClick: function () { switchTab(def.id); },
					}, def.title,
						b ? createElement("span", { className: "cbc-tabcount" + (b.tone ? " cbc-" + b.tone : "") }, b.text) : null);
				}),
				savedAt ? createElement("span", { className: "cbc-saveflash" }, "已保存 ✓") : null);

			// 分区：懒挂载 + 隐藏不卸载（display:none 保留组件状态与 DOM）。
			var panelProps = {
				login: { value: data.value || {}, oauth: data.oauth || {}, save: save, post: post, reload: load, setErr: setErr, overridden: overriddenFor(data) },
				models: { post: post, setErr: setErr, reload: load, modelsInfo: data.models || {} },
				usage: { post: post, value: data.value || {}, save: save, overridden: overriddenFor(data), active: activeTab === "usage" },
				tools: { value: data.value || {}, save: save, overridden: overriddenFor(data) },
				providers: { post: post, setErr: setErr },
				trae: { value: data.value || {}, save: save, post: post, reload: load, setErr: setErr, overridden: overriddenFor(data), trae: data.trae || {} },
				bridge: { value: data.value || {}, save: save, overridden: overriddenFor(data), bridgeView: data.bridge || {} },
			};
			var panels = TAB_DEFS.map(function (def) {
				if (!mounted[def.id]) return null;
				return createElement("div", {
					key: def.id, className: "cbc-panel", "data-tab": def.id,
					hidden: activeTab === def.id ? undefined : true,
				},
					createElement("h4", { className: "cbc-section-title" }, def.title),
					createElement(PANEL_RENDERERS[def.id], panelProps[def.id]));
			});

			return createElement("li", { className: cardClass }, header,
				createElement("div", { className: "cbc-body" },
					errorBanner,
					strip,
					tabBar,
					panels,
					createElement("p", { className: "cbc-status" }, "修改即保存（写入 ~/.dsh/codebuddy-plugin.json），立即生效；标\u201C重置\u201D的字段可一键恢复默认值。")));
		}

		function overriddenFor(data) {
			var user = data.user || {};
			return function (k) { return Object.prototype.hasOwnProperty.call(user, k); };
		}

		// 状态芯片：全部由 GET 视图推导，不硬编码任何当前值。
		function buildChips(data) {
			var value = data.value || {};
			var oauth = data.oauth || {};
			var bridge = data.bridge || {};
			var modelsInfo = data.models || {};
			var trae = data.trae || {};
			var login;
			if (value.authMode === "oauth") {
				login = oauth.signedIn
					? { tone: "ok", text: "OAuth 已登录" }
					: (oauth.pending ? { tone: "warn", text: "OAuth 登录中…" } : { tone: "err", text: "OAuth 未登录" });
			} else {
				login = value.activeApiKey
					? { tone: "ok", text: "API Key · " + value.activeApiKey }
					: { tone: "err", text: "API Key 未配置" };
			}
			var effCount = modelsInfo.effectiveCount;
			var models = { tone: effCount > 0 ? "ok" : "warn", text: "模型 " + (effCount != null ? effCount : "?") + " 个" };
			var bridgeChip;
			if (value.bridgeEnabled === false) bridgeChip = { tone: "err", text: "桥已禁用" };
			else if (bridge.running) bridgeChip = { tone: "ok", text: "桥 :" + bridge.port };
			else bridgeChip = { tone: "warn", text: "桥未监听 :" + (bridge.port || value.bridgePort || "?") };
			return {
				login: Object.assign({ tab: "login", tabTitle: "登录" }, login),
				models: Object.assign({ tab: "models", tabTitle: "模型" }, models),
				bridge: Object.assign({ tab: "bridge", tabTitle: "桥与高级" }, bridgeChip),
				search: {
					tab: "tools", tabTitle: "工具",
					tone: value.searchEnabled === true ? "ok" : "off",
					text: "搜索 " + (value.searchEnabled === true ? "已启用" : "已禁用"),
				},
				image: {
					tab: "tools", tabTitle: "工具",
					tone: value.imageGenEnabled === true ? "ok" : "off",
					text: "生图 " + (value.imageGenEnabled === true ? "已启用" : "已禁用"),
				},
				trae: {
					tab: "trae", tabTitle: "TraeWork CN",
					tone: value.traeEnabled === true ? "ok" : "off",
					text: "Trae " + (value.traeEnabled === true ? "已启用" : "未启用"),
				},
			};
		}

		// 标签徽标：数字/短词来自 GET 视图（usage 等懒加载数据不上徽标）。
		function tabBadge(data) {
			var value = data.value || {};
			var oauth = data.oauth || {};
			var bridge = data.bridge || {};
			var modelsInfo = data.models || {};
			var effCount = modelsInfo.effectiveCount;
			var login = value.authMode === "oauth"
				? (oauth.signedIn ? { text: "已登录", tone: "ok" } : { text: "未登录", tone: "warn" })
				: null;
			var trae = value.traeEnabled === true
				? ((data.trae || {}).bridge || {}).running === true ? { text: "运行", tone: "ok" } : { text: "开", tone: null }
				: null;
			return {
				login: login,
				models: effCount != null ? { text: String(effCount), tone: effCount > 0 ? "ok" : "warn" } : null,
				usage: null,
				tools: null,
				providers: null,
				trae: trae,
				bridge: value.bridgeEnabled === false
					? { text: "禁用", tone: "warn" }
					: (bridge.running ? { text: ":" + bridge.port, tone: "ok" } : { text: "未监听", tone: "warn" }),
			};
		}

		// --- 登录：模式选择 + 多 API Key + OAuth（一切功能的前提，排第一） --------
		function LoginSection(props) {
			var value = props.value;
			var oauth = props.oauth;
			var save = props.save;
			var post = props.post;
			var reload = props.reload;
			var setErr = props.setErr;

			var addNameState = useState("");
			var addName = addNameState[0];
			var setAddName = addNameState[1];
			var addKeyState = useState("");
			var addKey = addKeyState[0];
			var setAddKey = addKeyState[1];
			var oauthBusyState = useState(false);
			var oauthBusy = oauthBusyState[0];
			var setOauthBusy = oauthBusyState[1];

			// While a login handshake is pending, poll its status.
			useEffect(function () {
				if (!oauth.pending) return undefined;
				var timer = setInterval(function () {
					post({ action: "oauth-status" }).then(function (res) {
						if (res.ok && res.d.oauth && !res.d.oauth.pending) reload();
					}).catch(function () {});
				}, 3000);
				return function () { clearInterval(timer); };
			}, [oauth.pending]);

			var modeRow = createElement("div", { className: "cbc-row" },
				createElement("div", { className: "cbc-row-label" }, "登录方式"),
				createElement("div", { className: "cbc-row-control" },
					createElement("span", { className: "cbc-mode" },
						createElement("label", { className: "cbc-radio" },
							createElement("input", { type: "radio", checked: value.authMode !== "oauth", onChange: function () { save({ authMode: "api-key" }); } }),
							"API Key"),
						createElement("label", { className: "cbc-radio" },
							createElement("input", { type: "radio", checked: value.authMode === "oauth", onChange: function () { save({ authMode: "oauth" }); } }),
							"OAuth 登录"))));

			var body;
			if (value.authMode === "oauth") {
				var parts = [];
				if (oauth.signedIn) {
					var acct = oauth.account || {};
					parts.push(createElement("div", { key: "acct", className: "cbc-listrow" },
						createElement(Dot, { tone: "ok" }),
						createElement("span", { className: "cbc-cell-name" }, acct.nickname || acct.uid || "未知账号"),
						createElement("span", { className: "cbc-badge" }, "已登录"),
						acct.enterpriseName ? createElement("span", { className: "cbc-muted" }, acct.enterpriseName) : null,
						createElement("span", { className: "cbc-effort" },
							(acct.type ? "套餐 " + acct.type : ""),
							oauth.accessTokenExpiresAt ? (acct.type ? " · 令牌至 " : "令牌至 ") + fmtTime(oauth.accessTokenExpiresAt) : "")));
					parts.push(createElement("p", { key: "scope", className: "cbc-hint" },
						"此登录覆盖模型对话（主聊天经流式桥统一取凭据）、网络搜索与抓取、生图与额度读数。"));
					parts.push(createElement("div", { key: "out", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "outline", danger: true, onClick: function () { post({ action: "oauth-logout" }).then(reload); } }, "退出登录")));
				} else if (oauth.pending) {
					parts.push(createElement("p", { key: "pend", className: "cbc-status" }, "等待浏览器完成登录…（3 秒轮询，完成后自动刷新）"));
					parts.push(createElement("div", { key: "url", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "outline", onClick: function () { window.open(oauth.authUrl, "_blank"); } }, "重新打开登录页")));
				} else {
					parts.push(createElement("div", { key: "start", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "primary", disabled: oauthBusy, onClick: function () {
							// window.open must fire synchronously in the click
							// handler — an async one (after the fetch) is eaten
							// by popup blockers and the click looks dead.
							var win = window.open("", "_blank");
							setOauthBusy(true);
							post({ action: "oauth-start" }).then(function (res) {
								setOauthBusy(false);
								if (res.ok && res.d.authUrl) {
									if (win) win.location.href = res.d.authUrl;
									reload();
								} else {
									if (win) win.close();
									setErr(res.d && res.d.error ? res.d.error : "发起登录失败");
								}
							}).catch(function () { setOauthBusy(false); if (win) win.close(); setErr("发起登录失败（网络）"); });
						} }, oauthBusy ? "发起中…" : "登录 CodeBuddy 账号")));
				}
				if (oauth.error) parts.push(createElement("p", { key: "err", className: "cbc-error" }, oauth.error));
				body = parts;
			} else {
				// 使用中置顶，其余按名称字典序（仅展示层排序，不动存储顺序）。
				var sortedKeys = (value.apiKeys || []).slice().sort(function (a, b) {
					var wa = value.activeApiKey === a.name ? 0 : 1;
					var wb = value.activeApiKey === b.name ? 0 : 1;
					return wa - wb || String(a.name).localeCompare(String(b.name));
				});
				var rows = sortedKeys.map(function (k) {
					var isActive = value.activeApiKey === k.name;
					return createElement("div", { key: k.name, className: "cbc-listrow" },
						createElement("input", { type: "radio", className: "cbc-check", checked: isActive, onChange: function () { save({ activeApiKey: k.name }); }, title: "设为当前使用" }),
						createElement("span", { className: "cbc-cell-name", title: k.name }, k.name),
						createElement("span", { className: "cbc-cell-masked" }, k.masked),
						isActive ? createElement("span", { className: "cbc-badge" }, "使用中") : null,
						createElement(CbcButton, { variant: "ghost", danger: true, onClick: function () { post({ patch: { apiKeysRemove: k.name } }).then(reload); } }, "删除"));
				});
				body = rows.concat([
					createElement("div", { key: "add", className: "cbc-addrow" },
						createElement(CbcInput, { widthClass: "cbc-w140", placeholder: "名称（如 工作）", value: addName, onInput: function (e) { setAddName(e.target.value); } }),
						createElement(CbcInput, { widthClass: "cbc-w260", placeholder: "ck_…", value: addKey, onInput: function (e) { setAddKey(e.target.value); } }),
						createElement(CbcButton, { variant: "outline", onClick: function () {
							var name = addName.trim();
							var key = addKey.trim();
							if (!name || !key) { setErr("名称和 Key 都不能为空"); return; }
							post({ patch: { apiKeysAdd: { name: name, key: key } } }).then(function (res) {
								if (res.ok) { setAddName(""); setAddKey(""); reload(); }
								else setErr(res.d && res.d.error ? res.d.error : "添加失败");
							});
						} }, "添加")),
					createElement("div", { key: "env", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "环境变量引用"),
						createElement("div", { className: "cbc-row-control" },
							createElement(TextField, { fieldKey: "apiKeyEnv", value: value.apiKeyEnv, save: save, widthClass: "cbc-w220", overridden: props.overridden("apiKeyEnv") }))),
					createElement("div", { key: "cooldown", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "失败冷却 (ms)"),
						createElement("div", { className: "cbc-row-control" },
							createElement(NumberField, { fieldKey: "keyCooldownMs", value: value.keyCooldownMs, save: save, overridden: props.overridden("keyCooldownMs") }))),
					createElement("p", { key: "hint", className: "cbc-hint" }, "多把 Key 时逐请求轮询；遇 401/403/429/5xx 或网络错误自动换下一把，失败 Key 冷却指定毫秒后自动回到轮换。单选仅决定模型目录拉取用的 Key；一个都不选时回落到环境变量引用（进程环境或 ~/.dsh/.credentials.yaml 中的同名条目）。"),
				]);
			}

			return createElement("div", { className: "cbc-section" }, modeRow, body);
		}
		PANEL_RENDERERS.login = LoginSection;

		// --- 额度与用量：桥计量的消耗 + 账户侧额度（登录之后） ----------------------
		// 消耗量来自桥对每请求 usage.credit 的计量（精确，本插件路径）；剩余额度在
		// OAuth 模式显示真实数值（/billing/meter/get-user-resource，R-Q7），
		// api-key 模式该 API 为 OAuth 专享（401）→ 手填总额度的估算档（标注"估算"）。
		// 轮询只在分区可见（active）时跑；资源包按名称聚合，明细可展开。
		function UsageSection(props) {
			var post = props.post;
			var value = props.value || {};
			var active = props.active !== false; // 面板挂载即 active（标签页机制保证）
			var dataState = useState(null); // {usage, bridge, quota}
			var usageData = dataState[0];
			var setUsageData = dataState[1];
			var failState = useState("");
			var fail = failState[0];
			var setFail = failState[1];
			var expandPacksState = useState(false);
			var expandPacks = expandPacksState[0];
			var setExpandPacks = expandPacksState[1];

			// 实时 = 分区可见期间 10s 轮询；切走即停（不可见的轮询是浪费）。
			useEffect(function () {
				if (!active) return undefined;
				var stop = false;
				var pull = function () {
					post({ action: "usage" }).then(function (res) {
						if (stop) return;
						if (res.ok) { setUsageData(res.d); setFail(""); }
						else setFail(res.d && res.d.error ? res.d.error : "用量读取失败");
					}).catch(function () { if (!stop) setFail("用量读取失败（网络）"); });
				};
				pull();
				var timer = setInterval(pull, 10000);
				return function () { stop = true; clearInterval(timer); };
			}, [active]);

			var KIND_LABEL = { chat: "对话", title: "标题", compaction: "压缩", image: "生图", search: "搜索", fetch: "抓取" };
			var usage = usageData && usageData.usage || null;
			var bridge = usageData && usageData.bridge || null;
			var quota = usageData && usageData.quota || null;

			var rows = [];

			// 账户与剩余额度（账户级，与 WorkBuddy 共用）。
			if (quota && quota.error) {
				rows.push(createElement("p", { key: "qerr", className: "cbc-status" }, "账户信息：" + quota.error));
			} else if (quota) {
				var acct = quota.account;
				if (acct) {
					rows.push(createElement("p", { key: "acct", className: "cbc-status" },
						createElement("span", { className: "cbc-chip", style: { marginRight: 6 } }, createElement(Dot, { tone: "ok" }), "账户"),
						acct.nickname || "-",
						acct.enterpriseName ? "（" + acct.enterpriseName + "）" : "",
						" · 套餐：" + (acct.type || "?")));
				}
				// 真实数值额度（OAuth 模式）：hero 大数字 + 周期进度条。
				if (quota.numericQuota && quota.resource) {
					var res = quota.resource;
					var pPct = pct(res.cycleRemain, res.cycleSize);
					rows.push(createElement("div", { key: "hero", className: "cbc-hero" },
						createElement("div", { className: "cbc-hero-top" },
							createElement("span", { className: "cbc-hero-label" }, "剩余额度（当前周期）"),
							createElement("span", null,
								createElement("span", { className: "cbc-hero-num" }, fmtCredit(res.cycleRemain)),
								createElement("span", { className: "cbc-hero-unit" }, " credit"))),
						createElement("div", { className: "cbc-bar" },
							createElement("div", { className: "cbc-bar-fill", style: { width: (pPct == null ? 0 : pPct) + "%" } })),
						createElement("div", { className: "cbc-hero-sub" },
							"总量口径 " + fmtCredit(res.totalRemain) + " credit" +
							(res.cycleSize ? " · 周期余量 " + pPct + "%（已用 " + fmtCredit(res.cycleUsed) + " / " + fmtCredit(res.cycleSize) + "）" : ""))));
					var packs = res.packs || [];
					if (packs.length) {
						var agg = aggregatePacks(packs);
						var showAgg = agg.length < packs.length || agg.length > 4;
						var packRows = (showAgg && !expandPacks ? agg : packs).map(function (p, i) {
							var bar = pct(p.cycleRemain != null ? p.cycleRemain : p.remain, p.cycleSize != null && p.cycleSize > 0 ? p.cycleSize : p.size);
							var count = showAgg && !expandPacks && p.count > 1 ? " ×" + p.count : "";
							return createElement("div", { key: "pk" + i, className: "cbc-listrow" },
								createElement("span", { className: "cbc-cell-name", title: p.name }, (p.name || "?") + count),
								createElement("span", { className: "cbc-minibar" }, createElement("span", { className: "cbc-minibar-fill", style: { width: (bar == null ? 0 : bar) + "%" } })),
								createElement("span", { className: "cbc-effort" },
									"余 " + fmtCredit(p.cycleRemain != null ? p.cycleRemain : p.remain) +
									((p.cycleSize != null && p.cycleSize > 0) ? " / " + fmtCredit(p.cycleSize) : "")),
								createElement("span", { className: "cbc-cell-masked" },
									p.cycleEnd ? "周期至 " + String(p.cycleEnd).slice(0, 10) : ""));
						});
						rows.push(createElement("div", { key: "pkh", className: "cbc-group-title" },
							"资源包（" + packs.length + "）",
							showAgg ? createElement("button", { type: "button", className: "cbc-toggle", style: { marginLeft: 8, fontWeight: 400 }, onClick: function () { setExpandPacks(!expandPacks); } },
								expandPacks ? "收起明细" : "展开明细") : null));
						rows.push.apply(rows, packRows);
					}
				} else if (quota.numericQuota && quota.resourceError) {
					rows.push(createElement("p", { key: "reserr", className: "cbc-warn" }, "数值额度读取失败：" + quota.resourceError));
				}
				if (quota.dosage && quota.dosage.text) {
					rows.push(createElement("p", { key: "dosage", className: "cbc-warn" }, "额度告警：" + quota.dosage.text));
				}
			}
			// api-key 模式：数值额度 API 是 OAuth 专享（实测 401）→ 手填总额度估算档。
			if (quota && !quota.numericQuota) {
				var manual = typeof value.quotaTotalManual === "number" ? value.quotaTotalManual : 0;
				rows.push(createElement("div", { key: "est", className: "cbc-row" },
					createElement("span", { className: "cbc-row-label" }, "总额度（手填）"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "quotaTotalManual", value: value.quotaTotalManual, save: props.save, overridden: props.overridden("quotaTotalManual") }),
						usage && manual > 0
							? createElement("span", { className: "cbc-status" },
								"估算剩余：" + fmtCredit(manual - usage.totalCredit) + " credit（估算）")
							: null)));
				rows.push(createElement("p", { key: "qlink", className: "cbc-hint" },
					"api-key 模式网关不开放数值额度 API（OAuth 专享，实测 401）；上方为「手填总额 − 本插件计量累计」的估算值，准确余额见 ",
					createElement("a", { className: "cbc-link", href: "https://www.codebuddy.cn/profile/plan", target: "_blank", rel: "noreferrer" }, "codebuddy.cn 套餐页"),
					" 或切到 OAuth 登录。额度为账户级，与 WorkBuddy 共用。"));
			} else if (quota && quota.numericQuota) {
				rows.push(createElement("p", { key: "qlink", className: "cbc-hint" },
					"数值来自 /billing/meter/get-user-resource（账户级，与 WorkBuddy 共用），每分钟缓存；准确口径以 ",
					createElement("a", { className: "cbc-link", href: "https://www.codebuddy.cn/profile/plan", target: "_blank", rel: "noreferrer" }, "codebuddy.cn 套餐页"),
					" 为准。"));
			}

			// 消耗统计（本插件路径实测）：今日 / 累计两张统计卡。
			if (usage) {
				rows.push(createElement("div", { key: "totals", className: "cbc-stats" },
					createElement("div", { className: "cbc-stat" },
						createElement("div", { className: "cbc-statlabel" }, "今日消耗"),
						createElement("div", { className: "cbc-statnum" }, fmtCredit(usage.today.credit) + " credit"),
						createElement("div", { className: "cbc-muted" }, usage.today.requests + " 请求")),
					createElement("div", { className: "cbc-stat" },
						createElement("div", { className: "cbc-statlabel" }, "累计消耗"),
						createElement("div", { className: "cbc-statnum" }, fmtCredit(usage.totalCredit) + " credit"),
						createElement("div", { className: "cbc-muted" }, usage.totalRequests + " 请求 · 自 " + fmtTime(usage.since)))));
			}

			// 桥状态（EADDRINUSE 等失败在这里可见，不再静默崩溃）。
			if (bridge) {
				var bridgeText = !bridge.enabled
					? "已禁用（主聊天将直连失败，请保持启用）"
					: bridge.running
						? "运行中（127.0.0.1:" + bridge.port + "）"
						: "未监听（:" + bridge.port + " " + (bridge.lastError || "启动中") + "）" + (bridge.lastError === "EADDRINUSE" ? "——若占用者是另一个 dsh 实例，其桥仍会代管本实例流量" : "");
				rows.push(createElement("p", { key: "bridge", className: "cbc-status" },
					createElement("span", { className: "cbc-chip", style: { marginRight: 6 } },
						createElement(Dot, { tone: !bridge.enabled ? "err" : (bridge.running ? "ok" : "warn") }), "流式桥"),
					bridgeText));
			}

			// 最近轮次（>45s 间隔聚类的近似口径）：credit + token 拆解。
			if (usage && usage.turns && usage.turns.length) {
				rows.push(createElement("p", { key: "th", className: "cbc-group-title" }, "最近轮次（按间隔聚类，近似）"));
				usage.turns.forEach(function (t, i) {
					var kinds = t.kinds.map(function (k) { return KIND_LABEL[k] || k; }).join("+");
					rows.push(createElement("div", { key: "t" + i, className: "cbc-listrow" },
						createElement("span", { className: "cbc-model-ctx" }, fmtTime(t.start)),
						createElement("span", { className: "cbc-cell-name" }, fmtCredit(t.credit)),
						createElement("span", { className: "cbc-effort" }, "入 " + t.prompt + " · 命中 " + fmtHit(t.hit, t.miss) + " · 出 " + (t.completion || 0)),
						createElement("span", { className: "cbc-effort" }, t.requests + " 请求"),
						createElement("span", { className: "cbc-cell-masked" }, kinds + (t.models.length ? " · " + t.models.join("/") : ""))));
				});
			} else if (usage) {
				rows.push(createElement("p", { key: "empty", className: "cbc-hint" }, "还没有经过桥的计费请求。消耗数据来自流式桥与搜索/抓取/生图路径的网关 usage 自报。"));
			}
			if (fail) rows.push(createElement("p", { key: "fail", className: "cbc-error" }, fail));
			if (!usageData && !fail) rows.push(createElement("p", { key: "loading", className: "cbc-status" }, "正在读取用量…"));

			return createElement("div", { className: "cbc-section" }, rows);
		}
		PANEL_RENDERERS.usage = UsageSection;

		// 资源包按名称聚合：×N、余量/总量求和、最早周期结束日。
		function aggregatePacks(packs) {
			var byName = {};
			var order = [];
			packs.forEach(function (p) {
				var key = p.name || "?";
				if (!byName[key]) {
					byName[key] = { name: key, count: 0, remain: 0, size: 0, cycleRemain: 0, cycleSize: 0, cycleEnd: null };
					order.push(key);
				}
				var a = byName[key];
				a.count += 1;
				a.remain += p.remain || 0;
				a.size += p.size || 0;
				a.cycleRemain += p.cycleRemain || 0;
				a.cycleSize += p.cycleSize || 0;
				if (p.cycleEnd && (!a.cycleEnd || String(p.cycleEnd) < String(a.cycleEnd))) a.cycleEnd = p.cycleEnd;
			});
			var r2 = function (n) { return Math.round(n * 100) / 100; };
			return order.map(function (k) {
				var a = byName[k];
				return { name: a.name, count: a.count, remain: r2(a.remain), size: r2(a.size), cycleRemain: r2(a.cycleRemain), cycleSize: r2(a.cycleSize), cycleEnd: a.cycleEnd };
			});
		}

		// --- 模型：网关目录同步 + 逐模型启停（同步到对话选择器） ------------------
		// G4：清单默认跟 /v3/config 走（启动自动同步 + 这里的手动刷新），
		// 静态清单只做离线兜底；勾选语义 = 在不在对话选择器里（effectiveIds）。
		function ModelsSection(props) {
			var post = props.post;
			var setErr = props.setErr;
			var reload = props.reload;
			var modelsInfo = props.modelsInfo || {};
			var dataState = useState(null); // {catalog, staticIds, state, effectiveIds, ...}
			var data = dataState[0];
			var setData = dataState[1];
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var syncBusyState = useState(false);
			var syncBusy = syncBusyState[0];
			var setSyncBusy = syncBusyState[1];
			var filterState = useState("");
			var filter = filterState[0];
			var setFilter = filterState[1];

			var fetchList = function () {
				setBusy(true);
				post({ action: "model-list" }).then(function (res) {
					setBusy(false);
					if (res.ok) setData(res.d);
					else setErr(res.d && res.d.error ? res.d.error : "获取失败");
				}).catch(function () { setBusy(false); setErr("获取失败（网络）"); });
			};
			// 首次挂载即拉取（标签页懒挂载保证此时才发生），不用先找按钮。
			useEffect(function () { fetchList(); }, []);

			// G4 手动刷新：重拉 /v3/config 并重铺 settings.yaml 镜像（选择器即时刷新）。
			var syncNow = function () {
				setSyncBusy(true);
				post({ action: "model-sync" }).then(function (res) {
					setSyncBusy(false);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "同步失败"); return; }
					if (res.d.sync && res.d.sync.ok === false) setErr("目录同步失败（已" + (res.d.sync.kept ? "保留上次清单" : "回落静态清单") + "）：" + res.d.sync.error);
					reload();   // modelsInfo.sync / effectiveCount 刷新
					fetchList(); // 管理列表刷新
				}).catch(function () { setSyncBusy(false); setErr("同步失败（网络）"); });
			};

			// 受控 checkbox 可能一次交互双 change——用“同值去重”挡（useRef 跨渲染
			// 存活，踩坑 #27）：重复事件携带与上次已发送相同的目标态，真实切换
			// 必然反值。不用时间窗——勾选往返（POST+reload）可以快过任何时间窗。
			var lastSentRef = useRef({});
			var toggleModel = function (m, enabled) {
				if (lastSentRef.current[m.id] === enabled) return;
				lastSentRef.current[m.id] = enabled;
				var staticIds = (data && data.staticIds) || [];
				var isStatic = staticIds.indexOf(m.id) >= 0;
				var payload = { id: m.id, enabled: enabled };
				if (enabled && !isStatic) {
					payload.profile = {
						id: m.id,
						name: m.name || m.id,
						contextWindow: m.maxInputTokens != null ? m.maxInputTokens : 262144,
						maxTokens: m.maxOutputTokens != null ? m.maxOutputTokens : 32768,
					};
					if (m.images) payload.profile.input = ["text", "image"];
				}
				post({ patch: { modelSetEnabled: payload } }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					if (res.d.models) {
						// settingsView ships disabled/extraIds as arrays; turn
						// them into lookup maps and keep the fetched catalog.
						var dis = {}; (res.d.models.disabled || []).forEach(function (id) { dis[id] = true; });
						var ext = {}; (res.d.models.extraIds || []).forEach(function (id) { ext[id] = true; });
						setData(function (prev) {
							// G4：勾选状态跟随服务端选择器真值 effectiveIds
							// （动态目录模型默认在选择器里，不在 extra 里）。
							return prev ? { catalog: prev.catalog, staticIds: prev.staticIds, staticEfforts: prev.staticEfforts, effectiveIds: res.d.models.effectiveIds || prev.effectiveIds, state: { disabled: dis, extra: ext, overrides: res.d.models.overrides || {} } } : prev;
						});
					}
					reload(); // 状态条/徽标的可用模型数随 effectiveCount 刷新
				}).catch(function (e) { setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
			};

			// G5：上限保存后本地合并——overrides 取服务端真值，profiles 依
			// ceilings 重算（输入框显示值随之刷新；清空覆盖即回基值）。
			var onModelsSaved = function (models) {
				setData(function (prev) {
					if (!prev) return prev;
					var ov = models.overrides || {};
					var profiles = {};
					Object.keys(prev.ceilings || {}).forEach(function (id) {
						var c = prev.ceilings[id] || {};
						var o = ov[id] || {};
						profiles[id] = {
							contextWindow: o.contextWindow != null ? o.contextWindow : c.contextWindow,
							maxTokens: o.maxTokens != null ? o.maxTokens : c.maxTokens,
						};
					});
					var st = prev.state || {};
					return Object.assign({}, prev, {
						effectiveIds: models.effectiveIds || prev.effectiveIds,
						profiles: profiles,
						state: Object.assign({}, st, { overrides: ov }),
					});
				});
			};

			var body = null;
			if (data && data.catalog) {
				var staticIds = data.staticIds || [];
				// G4：勾选语义唯一权威 = effectiveIds（服务端算好的选择器真实内容）。
				// 动态目录启用后目录模型默认在选择器里（不是 extra），不能再靠
				// disabled/extra 反推。
				var effectiveIds = data.effectiveIds || [];
				var needle = filter.trim().toLowerCase();
				var seen = {};
				var enabledRows = [];
				var inactiveRows = [];
				var matchFilter = function (m) {
					if (!needle) return true;
					return String(m.id).toLowerCase().indexOf(needle) >= 0
						|| (m.name && String(m.name).toLowerCase().indexOf(needle) >= 0);
				};
				var makeRow = function (m, fromCatalog) {
					if (seen[m.id]) return;
					seen[m.id] = true;
					if (!matchFilter(m)) return;
					var isStatic = staticIds.indexOf(m.id) >= 0;
					var enabled = effectiveIds.indexOf(m.id) >= 0;
					// 思考档位：静态模型用 cordis.patch.yml 的 reasoningEfforts
					// 键名（off/low/medium/high/max），目录新增模型用目录
					// reasoning.effort（目录标注的默认档，非档位清单）。
					var effortText = null;
					if (isStatic) {
						var tiers = (data.staticEfforts || {})[m.id];
						if (tiers && tiers.length) effortText = tiers.join("/");
					} else if (typeof m.reasoningEffort === "string" && m.reasoningEffort) {
						effortText = "思考:" + m.reasoningEffort;
					}
					// G5：有效值 = 覆盖 ?? 目录/静态基值；ceiling 用于本地快检与 title。
					var prof = (data.profiles || {})[m.id] || {};
					var ceil = (data.ceilings || {})[m.id] || {};
					var ov = (((data.state || {}).overrides) || {})[m.id] || {};
					var ctxVal = prof.contextWindow != null ? prof.contextWindow : (m.maxInputTokens != null ? m.maxInputTokens : null);
					var outVal = prof.maxTokens != null ? prof.maxTokens : (m.maxOutputTokens != null ? m.maxOutputTokens : null);
					var ctxCeil = ceil.contextWindow != null ? ceil.contextWindow : (m.maxInputTokens != null ? m.maxInputTokens : null);
					var outCeil = ceil.maxTokens != null ? ceil.maxTokens : (m.maxOutputTokens != null ? m.maxOutputTokens : null);
					var row = createElement("div", { key: m.id, className: "cbc-listrow" },
						createElement("input", {
							type: "checkbox", className: "cbc-check", checked: enabled,
							title: enabled ? "从对话选择器移除" : "加入对话选择器",
							onChange: function (e) { toggleModel(m, e.target.checked); },
						}),
						createElement("span", { className: "cbc-model-name", title: m.id }, m.id),
						createElement("span", { className: "cbc-model-ctx" },
							"ctx ",
							createElement(LimitInput, { id: m.id, field: "contextWindow", value: ctxVal, ceiling: ctxCeil, overridden: ov.contextWindow != null, post: post, setErr: setErr, onSaved: onModelsSaved }),
							" / ",
							createElement(LimitInput, { id: m.id, field: "maxTokens", value: outVal, ceiling: outCeil, overridden: ov.maxTokens != null, post: post, setErr: setErr, onSaved: onModelsSaved }),
							fromCatalog ? null : createElement("span", { className: "cbc-muted" }, " 旧 id")),
						isStatic ? createElement("span", { className: "cbc-badge" }, "插件") : createElement("span", { className: "cbc-muted" }, "目录"),
						m.cli ? createElement("span", { className: "cbc-badge" }, "CLI") : null,
						m.images ? createElement("span", { className: "cbc-badge" }, "图") : null,
						effortText
							? createElement("span", { className: "cbc-effort", title: isStatic ? "思考档位（插件静态清单）" : "目录标注的思考强度" }, effortText)
							: (m.reasoning ? createElement("span", { className: "cbc-badge" }, "思考") : null));
					(enabled ? enabledRows : inactiveRows).push(row);
				};
				(data.catalog.models || []).forEach(function (m) { makeRow(m, true); });
				// 静态清单里目录没有的（旧 id）：目录对象无 ctx 数据
				staticIds.forEach(function (id) {
					if (seen[id]) return;
					makeRow({ id: id, name: id }, false);
				});
				body = createElement("div", { style: { marginTop: 8 } },
					createElement("div", { className: "cbc-scrollbox" },
						createElement("p", { className: "cbc-group-title" }, "当前可用（" + enabledRows.length + "）"),
						enabledRows.length ? enabledRows : createElement("p", { className: "cbc-muted" }, "无匹配模型"),
						inactiveRows.length
							? createElement("p", { className: "cbc-group-title" }, "未启用（" + inactiveRows.length + "）")
							: null,
						inactiveRows),
					createElement("p", { className: "cbc-status" },
						"目录 " + (data.catalog.models || []).length + " 个（按当前登录凭据获取）；勾选即同步到对话模型选择器，下次请求生效。"));
			}

			var syncInfo = modelsInfo.sync;
			var syncText = syncInfo
				? "上次同步 " + fmtTime(syncInfo.at) + " · 网关目录 " + syncInfo.count + " 个（选择器跟随网关）"
				: "静态清单兜底（启动与手动同步均未取到网关目录）";
			return createElement("div", { className: "cbc-section" },
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "目录同步"),
					createElement("div", { className: "cbc-row-control" },
						createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, disabled: busy, onClick: fetchList, title: "重拉网关管理目录（勾选视图）" }, busy ? "获取中…" : "刷新列表"),
						createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, disabled: syncBusy, onClick: syncNow }, syncBusy ? "同步中…" : "立即同步"),
						createElement("span", { className: "cbc-muted" }, syncText))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "筛选"),
					createElement("div", { className: "cbc-row-control" },
						createElement(CbcInput, { widthClass: "cbc-w220", placeholder: "输入 id 关键字过滤模型…", value: filter, onInput: function (e) { setFilter(e.target.value); } }))),
				body,
				createElement("p", { className: "cbc-hint" }, "启动时自动同步网关目录（/v3/config）并入对话选择器，此处可手动再同步；勾选控制每个模型是否出现在选择器，ctx/输出上限可直接改（清空恢复目录默认），均写入 ~/.dsh/settings.yaml 的 llm-pi-ai 覆盖层，下次请求生效。"));
		}
		PANEL_RENDERERS.models = ModelsSection;

		// --- 工具：网络搜索与抓取 + 图像生成（都是 dsh 工具缝的注册开关） ---------
		function ToolsSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "网络搜索与抓取"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "搜索与抓取"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.searchEnabled === true, onChange: function (e) { save({ searchEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.searchEnabled === true ? "web_search / web_fetch 走 CodeBuddy" : "已禁用（web_search 将报 provider 未注册）"),
						createElement(ResetButton, { fieldKey: "searchEnabled", overridden: overridden("searchEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "搜索默认条数"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "searchMaxResults", value: value.searchMaxResults, save: save, overridden: overridden("searchMaxResults") }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "抓取正文上限"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "fetchBodyCap", value: value.fetchBodyCap, save: save, overridden: overridden("fetchBodyCap") }))),
				createElement("p", { className: "cbc-hint" }, "禁用即注销 dsh 原生 web_search/web_fetch 的 codebuddy 后端；搜索条数 1–20。"),
				createElement("hr", { className: "cbc-divider" }),
				createElement("p", { className: "cbc-group-title" }, "图像生成"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "生图工具"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.imageGenEnabled === true, onChange: function (e) { save({ imageGenEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.imageGenEnabled === true ? "image_generate 工具已注册到 agent" : "已禁用（agent 不再看到 image_generate）"),
						createElement(ResetButton, { fieldKey: "imageGenEnabled", overridden: overridden("imageGenEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "生图模型"),
					createElement("div", { className: "cbc-row-control" },
						createElement(TextField, { fieldKey: "imageGenModel", value: value.imageGenModel, save: save, widthClass: "cbc-w260", overridden: overridden("imageGenModel") }))),
				createElement("p", { className: "cbc-hint" }, "经 dsh 工具缝注册 image_generate（/v2/images/generations，约 20s/张，目录标注 x5 credits）；图片保存到会话工作区 generated-images/（无工作区信息时落 ~/.dsh/generated-images/）。"));
		}
		PANEL_RENDERERS.tools = ToolsSection;

		// --- 服务商（G6：key 型 OpenAI 兼容上游注册表） ------------------------------
		// ark/百炼 preset 或自定义：添加 = 实测 GET /models 验 key → 写
		// settings.yaml provider 块 + .credentials.yaml（<ID>_API_KEY，0600），
		// 模型进选择器免重启；删除连凭据一起清。key 只回脱敏值。
		function ProvidersSection(props) {
			var post = props.post;
			var setErr = props.setErr;
			var dataState = useState(null); // {providers, presets}
			var data = dataState[0];
			var setData = dataState[1];
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var presetState = useState("ark");
			var presetSel = presetState[0];
			var setPresetSel = presetState[1];
			var addIdState = useState("");
			var addId = addIdState[0];
			var setAddId = addIdState[1];
			var addBaseState = useState("");
			var addBase = addBaseState[0];
			var setAddBase = addBaseState[1];
			var addKeyState = useState("");
			var addKey = addKeyState[0];
			var setAddKey = addKeyState[1];

			var fetchList = function () {
				post({ action: "provider-list" }).then(function (res) {
					if (res.ok) setData(res.d);
					else setErr(res.d && res.d.error ? res.d.error : "获取失败");
				}).catch(function () { setErr("获取失败（网络）"); });
			};
			useEffect(function () { fetchList(); }, []);

			// G7 本机凭据：只读扫描（自动一次）+ 用户点按钮才导入。
			var findingsState = useState(null); // null=未扫到/未扫；[]=无命中
			var findings = findingsState[0];
			var setFindings = findingsState[1];
			var importBusyState = useState(null); // 正在导入的 source
			var importBusy = importBusyState[0];
			var setImportBusy = importBusyState[1];
			var scanLocal = function () {
				post({ action: "credential-scan" }).then(function (res) {
					if (res.ok) setFindings(res.d.findings || []);
				}).catch(function () { /* 扫描失败不影响分区其余功能 */ });
			};
			useEffect(function () { scanLocal(); }, []);
			var importSource = function (source) {
				setImportBusy(source);
				post({ action: "credential-import", source: source }).then(function (res) {
					setImportBusy(null);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "导入失败"); return; }
					mergeProviders(res.d.providers || []);
					if (res.d.findings) setFindings(res.d.findings);
				}).catch(function (e) { setImportBusy(null); setErr("导入失败：" + (e && e.message ? e.message : String(e))); });
			};

			var mergeProviders = function (list) {
				setData(function (prev) { return prev ? { presets: prev.presets, providers: list } : prev; });
			};

			var addUpstream = function () {
				if (!addKey.trim()) { setErr("添加失败：需要 API Key"); return; }
				var body = { action: "provider-add", apiKey: addKey.trim() };
				if (presetSel === "custom") {
					if (!addId.trim() || !addBase.trim()) { setErr("添加失败：自定义上游需要 id 与 baseURL"); return; }
					body.id = addId.trim();
					body.baseURL = addBase.trim();
				} else {
					body.preset = presetSel;
				}
				setBusy(true);
				post(body).then(function (res) {
					setBusy(false);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "添加失败"); return; }
					mergeProviders(res.d.providers || []);
					setAddKey(""); setAddId(""); setAddBase("");
				}).catch(function (e) { setBusy(false); setErr("添加失败：" + (e && e.message ? e.message : String(e))); });
			};

			var removeUpstream = function (id) {
				setBusy(true);
				post({ action: "provider-remove", id: id }).then(function (res) {
					setBusy(false);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "删除失败"); return; }
					mergeProviders(res.d.providers || []);
				}).catch(function (e) { setBusy(false); setErr("删除失败：" + (e && e.message ? e.message : String(e))); });
			};

			var refreshUpstream = function (id) {
				setBusy(true);
				post({ action: "provider-refresh", id: id }).then(function (res) {
					setBusy(false);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "刷新失败"); return; }
					mergeProviders(res.d.providers || []);
				}).catch(function (e) { setBusy(false); setErr("刷新失败：" + (e && e.message ? e.message : String(e))); });
			};

			var providers = (data && data.providers) || [];
			var presets = (data && data.presets) || [];
			var isCustom = presetSel === "custom";

			return createElement("div", { className: "cbc-section" },
				(findings && findings.length)
					? createElement("div", { className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "本机凭据"),
						createElement("div", { className: "cbc-row-control" },
							findings.map(function (f) {
								var already = f.detail && f.detail.import && providers.some(function (p) { return p.id === f.detail.import.id; });
								var kids = [f.label + "（" + (f.kind === "apikey" ? "API Key" : f.kind === "oauth" ? "OAuth" : "未知") + "）"];
								if (f.importable && !already) kids.push(createElement(CbcButton, { key: "go", variant: "ghost", disabled: importBusy !== null, onClick: function () { importSource(f.source); } }, importBusy === f.source ? "导入中…" : "一键导入"));
								if (f.importable && already) kids.push(createElement("span", { key: "done", className: "cbc-badge" }, "已导入"));
								if (f.importable && !already && f.detail && f.detail.expiredHint) kids.push(createElement("span", { key: "exp", className: "cbc-muted" }, "令牌疑似过期，导入时实测"));
								if (!f.importable) kids.push(createElement("span", { key: "why", className: "cbc-muted" }, f.reason || "不可导入"));
								return createElement("span", { key: f.source, title: f.path, style: { display: "inline-flex", alignItems: "center", gap: 6 } }, kids);
							})))
					: null,
				providers.map(function (p) {
					return createElement("div", { key: p.id, className: "cbc-listrow" },
						createElement("span", { className: "cbc-cell-name", title: p.baseURL }, p.displayName),
						createElement("span", { className: "cbc-muted" }, p.id + " · " + p.modelCount + " 模型"),
						createElement("span", { className: "cbc-muted", title: "凭据引用 " + p.keyRef }, p.maskedKey || "无凭据"),
						createElement(CbcButton, { variant: "ghost", disabled: busy, onClick: function () { refreshUpstream(p.id); } }, "刷新模型"),
						createElement(CbcButton, { variant: "ghost", danger: true, onClick: function () { removeUpstream(p.id); } }, "删除"));
				}),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "添加上游"),
					createElement("div", { className: "cbc-row-control" },
						createElement("select", {
							className: "cbc-select cbc-w140",
							value: presetSel,
							onChange: function (e) { setPresetSel(e.target.value); },
						},
							presets.map(function (p) { return createElement("option", { key: p.id, value: p.id }, p.displayName); }),
							createElement("option", { value: "custom" }, "自定义 OpenAI 兼容")),
						isCustom ? createElement(CbcInput, { widthClass: "cbc-w110", placeholder: "id（小写字母/数字/-）", value: addId, onInput: function (e) { setAddId(e.target.value); } }) : null,
						isCustom ? createElement(CbcInput, { widthClass: "cbc-w200", placeholder: "baseURL（如 https://…/v1）", value: addBase, onInput: function (e) { setAddBase(e.target.value); } }) : null,
						createElement(CbcInput, { widthClass: "cbc-w200", placeholder: "API Key", value: addKey, onInput: function (e) { setAddKey(e.target.value); } }),
						createElement(CbcButton, { variant: "outline", disabled: busy, onClick: addUpstream }, busy ? "验证中…" : "测试并添加"))),
				!providers.length ? createElement("p", { className: "cbc-muted" }, "还没有注册上游；预设含火山引擎 Ark 与阿里云百炼。") : null,
				createElement("p", { className: "cbc-hint" }, "key 型 OpenAI 兼容上游：添加时实测 GET /models 验证 key 并把模型写进选择器（免重启）；key 落 ~/.dsh/.credentials.yaml（<ID>_API_KEY，0600），只回脱敏值；删除连同凭据一起清。"));
		}
		PANEL_RENDERERS.providers = ProvidersSection;

		// --- TraeWork CN（订阅额度通道，v0.8.x）--------------------------------
		// 翻译网关 + 自持设备密钥 OAuth + 本机 state.vscdb 目录；目录同步后可逐
		// 模型启停（traeModelSetEnabled，全部禁用 = 整块路由从选择器移除）。
		function TraeSection(props) {
			var value = props.value;
			var save = props.save;
			var post = props.post;
			var reload = props.reload;
			var setErr = props.setErr;
			var overridden = props.overridden;
			var trae = props.trae || {};
			var toauth = trae.oauth || {};
			var tbridge = trae.bridge || {};
			var tmodels = trae.models || {};

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var listState = useState(null); // {profiles, disabled:{id:true}} 来自 trae-model-list
			var tlist = listState[0];
			var setTlist = listState[1];
			var advOpenState = useState(false);
			var advOpen = advOpenState[0];
			var setAdvOpen = advOpenState[1];

			var fetchTlist = function () {
				post({ action: "trae-model-list" }).then(function (res) {
					if (!res.ok) return;
					var disabled = {};
					(res.d.disabled || []).forEach(function (id) { disabled[id] = true; });
					setTlist({ profiles: (res.d.view && res.d.view.profiles) || [], disabled: disabled });
				}).catch(function () { /* 目录未同步等——分组不显示 */ });
			};
			useEffect(function () { fetchTlist(); }, []);

			var startLogin = function () {
				// 房规：window.open 必须在点击处理器内同步发起，异步（fetch 后）
				// 的调用会被弹窗拦截器吃掉——先开空白页，拿到 authUrl 再导航。
				var win = window.open("", "_blank");
				setBusy(true);
				post({ action: "trae-oauth-start" }).then(function (res) {
					setBusy(false);
					if (!res.ok) {
						if (win) win.close();
						setErr(res.d && res.d.error ? res.d.error : "启动登录失败");
						return;
					}
					if (res.d && res.d.authUrl && win) win.location.href = res.d.authUrl;
					reload();
				}).catch(function () { setBusy(false); if (win) win.close(); setErr("启动登录失败（网络）"); });
			};
			var syncModels = function () {
				setBusy(true);
				post({ action: "trae-model-sync" }).then(function (res) {
					setBusy(false);
					if (!res.ok) { setErr(res.d && res.d.sync && res.d.sync.error ? res.d.sync.error : "目录同步失败"); return; }
					fetchTlist();
					reload();
				}).catch(function () { setBusy(false); setErr("目录同步失败（网络）"); });
			};

			// Trae 模型启停：受控 checkbox 双 change 同值去重（同 CodeBuddy 模型行）。
			var tlastSentRef = useRef({});
			var toggleTmodel = function (p, enabled) {
				if (tlastSentRef.current[p.id] === enabled) return;
				tlastSentRef.current[p.id] = enabled;
				post({ patch: { traeModelSetEnabled: { id: p.id, enabled: enabled } } }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					var disabled = {};
					(((res.d.trae || {}).models || {}).disabled || []).forEach(function (id) { disabled[id] = true; });
					setTlist(function (prev) { return prev ? { profiles: prev.profiles, disabled: disabled } : prev; });
					reload(); // 徽标/状态随镜像刷新
				}).catch(function (e) { setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
			};

			var account = toauth.account;
			var loginStatus = toauth.pending
				? { tone: "warn", text: "登录进行中：浏览器完成授权后会自动回调本机（10 分钟内有效）。" }
				: toauth.signedIn
					? { tone: "ok", text: "已登录" + (account && (account.nickname || account.uid) ? "：" + (account.nickname || account.uid) : "") +
						(toauth.accessTokenExpiresAt ? "（令牌至 " + fmtTime(toauth.accessTokenExpiresAt) + "）" : "") + (toauth.error ? "｜" + toauth.error : "") }
					: { tone: "off", text: "未登录" + (toauth.error ? "｜" + toauth.error : "") };

			var syncInfo = tmodels.sync
				? "已同步 " + tmodels.sync.count + " 个模型（候选 " + tmodels.sync.candidate + "，" + fmtTime(tmodels.sync.at) + "）"
				: "未同步（启用后自动从本机 TRAE SOLO CN 缓存同步）";

			// 模型启停组：通道开启且目录已拉到才显示。
			var tmodelRows = null;
			if (value.traeEnabled === true && tlist && tlist.profiles.length) {
				var enabledCount = tlist.profiles.filter(function (p) { return !tlist.disabled[p.id]; }).length;
				tmodelRows = createElement("div", { key: "tmodels", style: { marginTop: 4 } },
					createElement("div", { className: "cbc-group-title" }, "Trae 模型（选择器内 " + enabledCount + " / " + tlist.profiles.length + "）"),
					createElement("div", { className: "cbc-scrollbox", style: { maxHeight: 220 } },
						tlist.profiles.map(function (p) {
							var enabled = !tlist.disabled[p.id];
							return createElement("div", { key: p.id, className: "cbc-listrow" },
								createElement("input", {
									type: "checkbox", className: "cbc-check", checked: enabled,
									title: enabled ? "从 Trae 路由移除" : "加入 Trae 路由",
									onChange: function (e) { toggleTmodel(p, e.target.checked); },
								}),
								createElement("span", { className: "cbc-tname", title: p.id }, p.id),
								createElement("span", { className: "cbc-muted" }, p.name && p.name !== p.id ? p.name : ""),
								createElement("span", { className: "cbc-model-ctx" },
									p.contextWindow != null ? "ctx " + p.contextWindow : "",
									p.input && p.input.indexOf("image") >= 0 ? " · 图" : ""));
						})),
					createElement("p", { className: "cbc-hint" }, "勾选控制每个 Trae 模型是否进对话选择器（写入 ~/.dsh/settings.yaml 的 providers.trae 块，免重启）；全部取消 = 整个 Trae 路由从选择器移除。"));
			}

			return createElement("div", { className: "cbc-section" },
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "启用通道"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.traeEnabled === true, onChange: function (e) { save({ traeEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.traeEnabled === true
							? "翻译网关已上线（:" + value.traeBridgePort + (tbridge.running ? "，运行中" : "，未监听" + (tbridge.lastError ? "：" + tbridge.lastError : "")) + "）"
							: "已禁用（选择器里的 Trae 模型会整体移除）"),
						createElement(ResetButton, { fieldKey: "traeEnabled", overridden: overridden("traeEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "Trae 登录"),
					createElement("div", { className: "cbc-row-control" },
						toauth.signedIn
							? createElement(CbcButton, { variant: "outline", danger: true, onClick: function () { post({ action: "trae-oauth-logout" }).then(reload); } }, "退出登录")
							: createElement(CbcButton, { variant: "primary", disabled: busy, onClick: startLogin }, busy ? "启动中…" : "登录（浏览器授权）"),
						createElement("span", { className: loginStatus.tone === "warn" ? "cbc-warn" : "cbc-status", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							createElement(Dot, { tone: loginStatus.tone }), loginStatus.text))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "模型目录"),
					createElement("div", { className: "cbc-row-control" },
						createElement(CbcButton, { variant: "outline", disabled: busy, onClick: syncModels }, busy ? "同步中…" : "从本机缓存同步"),
						createElement("span", { className: "cbc-muted" }, syncInfo))),
				tmodelRows,
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "聊天传输"),
					createElement("div", { className: "cbc-row-control" },
						createElement("select", {
							className: "cbc-select cbc-w220",
							value: value.traeChatTransport || "inline",
							onChange: function (e) { save({ traeChatTransport: e.target.value }); },
						},
							createElement("option", { value: "inline" }, "inline（账户默认模型，支持工具，耗 IDE 额度）"),
							createElement("option", { value: "remote" }, "remote（模型切换真实生效，不支持工具，耗 work 额度）")),
						createElement(ResetButton, { fieldKey: "traeChatTransport", overridden: overridden("traeChatTransport"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关端口"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "traeBridgePort", value: value.traeBridgePort, save: save, overridden: overridden("traeBridgePort") }),
						createElement("span", { className: "cbc-muted" }, "须与 cordis.patch.yml 的 trae baseURL 端口一致（默认 3902）"))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "首字节超时 (ms)"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "upstreamFirstByteTimeoutMs", value: value.upstreamFirstByteTimeoutMs, save: save, overridden: overridden("upstreamFirstByteTimeoutMs") }),
						createElement("span", { className: "cbc-muted" }, "inline 传输护栏：响应头超时即快速失败（SSE 长流不受限）"))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "连接域名"),
					createElement("div", { className: "cbc-row-control" },
						createElement("button", { type: "button", className: "cbc-toggle", onClick: function () { setAdvOpen(!advOpen); } },
							advOpen ? "▾ 收起高级连接设置" : "▸ 认证 / 聊天 / 登录域（高级）"))),
				advOpen ? createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, ""),
					createElement("div", { className: "cbc-row-control" },
						createElement(TextField, { fieldKey: "traeAuthBaseURL", value: value.traeAuthBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeAuthBaseURL") }),
						createElement(TextField, { fieldKey: "traeChatBaseURL", value: value.traeChatBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeChatBaseURL") }),
						createElement(TextField, { fieldKey: "traeLoginHost", value: value.traeLoginHost, save: save, widthClass: "cbc-w220", overridden: overridden("traeLoginHost") }))) : null,
				createElement("p", { className: "cbc-hint" }, "走 TraeWork CN 订阅额度：本插件用自持设备密钥完成 OAuth（凭据只存本机 ~/.dsh/trae-plugin-auth.json），经本地翻译网关把 OpenAI 请求转成 Trae 云端协议。模型清单来自本机 TRAE SOLO CN 的缓存数据库（只读、自动脱敏）。"));
		}
		PANEL_RENDERERS.trae = TraeSection;

		// --- 桥与高级：流式桥（主聊天链路）+ 网关地址 -----------------------------
		function BridgeAdvancedSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			var bridgeView = props.bridgeView || {};
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "流式桥"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "启用流式桥"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.bridgeEnabled === true, onChange: function (e) { save({ bridgeEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" },
							value.bridgeEnabled === true
								? (bridgeView.running
									? "运行中（127.0.0.1:" + bridgeView.port + "）——主聊天与工具请求均经由此桥"
									: "已启用，当前未监听" + (bridgeView.lastError ? "：" + bridgeView.lastError : "") + "（启动中或端口被占）")
								: "已禁用——主聊天将中断（模型请求经由此桥）"),
						createElement(ResetButton, { fieldKey: "bridgeEnabled", overridden: overridden("bridgeEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "端口"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "bridgePort", value: value.bridgePort, save: save, overridden: overridden("bridgePort") }),
						createElement("span", { className: "cbc-muted" }, "须与 cordis.patch.yml 的 baseURL 端口一致（默认 3901），否则主聊天断"))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "会话归因注入"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.sessionHeadersEnabled === true, onChange: function (e) { save({ sessionHeadersEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, "按入站会话 id 注入网关会话头（已设置的逐头保留）"),
						createElement(ResetButton, { fieldKey: "sessionHeadersEnabled", overridden: overridden("sessionHeadersEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "会话头格式"),
					createElement("div", { className: "cbc-row-control" },
						createElement("select", {
							className: "cbc-select cbc-w200",
							value: value.sessionHeaderFormat || "openai",
							onChange: function (e) { save({ sessionHeaderFormat: e.target.value }); },
						},
							createElement("option", { value: "openai" }, "openai（session_id 等）"),
							createElement("option", { value: "openrouter" }, "openrouter（x-session-id）")),
						createElement(ResetButton, { fieldKey: "sessionHeaderFormat", overridden: overridden("sessionHeaderFormat"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "每会话并发上限"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "maxConcurrentPerSession", value: value.maxConcurrentPerSession, save: save, overridden: overridden("maxConcurrentPerSession") }))),
				createElement("p", { className: "cbc-hint" }, "桥统一解析凭据（登录区选 OAuth 或 Key），主聊天也经由此桥。同一会话超过上限的请求排队（FIFO）；无会话 id 的请求不限流。非流式入站聚合成标准 JSON，chat/completions 之外的请求直接透传。"),
				createElement("hr", { className: "cbc-divider" }),
				createElement("p", { className: "cbc-group-title" }, "高级"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关地址"),
					createElement("div", { className: "cbc-row-control" },
						createElement(TextField, { fieldKey: "baseURL", value: value.baseURL, save: save, overridden: overridden("baseURL") }))),
				createElement("p", { className: "cbc-hint" }, "CodeBuddy 网关地址，一般无需修改；必须是 http/https 绝对地址。"));
		}
		PANEL_RENDERERS.bridge = BridgeAdvancedSection;

		// --- 字段控件（必须在模块级定义——组件身份随父重渲染变化会丢焦点） ---------

		// “重置”：字段在文件层被覆盖时出现，点一下写 null 删覆盖、回默认值。
		function ResetButton(props) {
			if (!props.overridden) return null;
			return createElement(CbcButton, {
				variant: "ghost", title: "恢复默认值",
				onClick: function () { var p = {}; p[props.fieldKey] = null; props.save(p); },
			}, "重置");
		}

		function TextField(props) {
			var draftState = useState(String(props.value == null ? "" : props.value));
			var draft = draftState[0];
			var setDraft = draftState[1];
			// 服务端回值变化（保存成功/被规范化/重置）时同步草稿，不困住旧值。
			useEffect(function () { setDraft(String(props.value == null ? "" : props.value)); }, [props.value]);
			var commit = function () {
				if (draft === String(props.value == null ? "" : props.value)) return;
				var patch = {};
				patch[props.fieldKey] = draft;
				props.save(patch);
			};
			// Enter 只 blur：提交统一走 onBlur。曾经 Enter 先 commit 再 blur，
			// blur 又触发一次 commit —— 一次保存产生两趟 POST+GET。
			return createElement(Fragment, null,
				createElement(CbcInput, {
					widthClass: props.widthClass,
					value: draft,
					onInput: function (e) { setDraft(e.target.value); },
					onBlur: commit,
					onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
				}),
				createElement(ResetButton, { fieldKey: props.fieldKey, overridden: props.overridden, save: props.save }));
		}

		function NumberField(props) {
			var draftState = useState(String(props.value == null ? "" : props.value));
			var draft = draftState[0];
			var setDraft = draftState[1];
			useEffect(function () { setDraft(String(props.value == null ? "" : props.value)); }, [props.value]);
			var commit = function () {
				var n = Number(draft);
				if (!Number.isFinite(n) || draft.trim() === "" || n === props.value) return;
				var patch = {};
				patch[props.fieldKey] = n;
				props.save(patch);
			};
			return createElement(Fragment, null,
				createElement(CbcInput, {
					type: "number",
					widthClass: "cbc-w110",
					value: draft,
					onInput: function (e) { setDraft(e.target.value); },
					onBlur: commit,
					onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
				}),
				createElement(ResetButton, { fieldKey: props.fieldKey, overridden: props.overridden, save: props.save }));
		}

		// G5：模型行内上限输入框（contextWindow/maxTokens 覆盖值）。
		// 显示有效值（覆盖 ?? 基值），Enter/blur 提交；清空 = 清除覆盖回基值。
		// 正整数/上限本地快检，服务端仍是权威校验（报错走全局横幅并回退草稿）。
		function LimitInput(props) {
			var cur = props.value == null ? "" : String(props.value);
			var draftState = useState(cur);
			var draft = draftState[0];
			var setDraft = draftState[1];
			useEffect(function () { setDraft(props.value == null ? "" : String(props.value)); }, [props.value]);
			var commit = function () {
				var raw = draft.trim();
				if (raw === cur) return;
				if (raw !== "" && (!/^\d+$/.test(raw) || Number(raw) <= 0)) {
					props.setErr("上限必须是正整数（清空 = 恢复目录默认）");
					setDraft(cur);
					return;
				}
				if (raw !== "" && props.ceiling != null && Number(raw) > props.ceiling) {
					props.setErr("超出该模型实际上限 " + props.ceiling);
					setDraft(cur);
					return;
				}
				var payload = { id: props.id };
				payload[props.field] = raw === "" ? null : Number(raw);
				props.post({ patch: { modelSetLimits: payload } }).then(function (res) {
					if (!res.ok) { props.setErr(res.d && res.d.error ? res.d.error : "保存失败"); setDraft(cur); return; }
					if (res.d && res.d.models) props.onSaved(res.d.models);
				}).catch(function (e) {
					props.setErr("保存失败：" + (e && e.message ? e.message : String(e)));
					setDraft(cur);
				});
			};
			return createElement("span", {
				title: props.overridden
					? "覆盖中（目录基值 " + (props.ceiling != null ? props.ceiling : "?") + "），清空恢复默认"
					: (props.ceiling != null ? "可改，上限 " + props.ceiling : "可改"),
			}, createElement(CbcInput, {
				type: "number",
				widthClass: "cbc-w90",
				value: draft,
				onInput: function (e) { setDraft(e.target.value); },
				onBlur: commit,
				onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
			}));
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.inject(["slots"], function (sctx) {
				sctx.slots.register(
					{
						name: "settings.plugin.item",
						// dsh ≥ rc.7 made this slot keyed: the tab dispatches
						// one entry per Host-served settings namespace, matched
						// on `key` (host half registers that namespace).
						// `id`/`order`/`label` keep rc.6 (list slot) working;
						// rc.7 ignores them.
						key: "dsh-tap",
						id: "codebuddy",
						order: 60,
						label: function () { return "dsh-tap"; },
						inject: function () { return {}; },
					},
					CodeBuddyCard,
				);
			});
		}

		exports.ROUTE = ROUTE;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
