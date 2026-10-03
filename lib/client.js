/**
 * Browser half of dsh-tap: a settings card. dsh ≥ 0.1.6 renders it in the
 * Plugin Manager panel (slot `plugins.item`, owner props {view}); older hosts
 * render it in Settings → 插件配置 (slot `settings.plugin.item`).
 *
 * Interaction model (2026-09 redesign, 0.10.0 channel accordion): the card is
 * the only thing the host slot gives us, so intuitiveness comes from channel
 * blocks instead of one long scroll or a flat tab bar —
 *   1. Collapsed: the header floats a single on-demand chip (「n 项需处理」,
 *      warn/err count from attentionCount) only when something needs
 *      attention — the per-block status lines are the real source. (Legacy
 *      settings.plugin.item slot only; the Plugin Manager page view has no
 *      card header at all.)
 *   2. Expanded: four channel blocks (CodeBuddy / TraeWork CN / Qoder CN /
 *      通用) in fixed order; each head always shows a status line derived from
 *      buildChips (tone = the block's worst chip), so warn/err is readable
 *      without expanding.
 *   3. Blocks lazy-mount on first open and then stay mounted hidden, so
 *      drafts, scroll positions and fetched catalogs survive both collapse
 *      and saves. Heavy work stays lazy: model-list / provider-list / trae
 *      model-list load when their block first opens; the usage poller only
 *      runs while the 通用 block is open. Long background explanations
 *      collapse into per-section <details> (HelpNote); short point-of-use
 *      hints stay inline.
 *
 * Every schema field in index.js SETTINGS_FIELDS has a home here, plus the
 * two stateful surfaces that are not plain fields: per-model enable/limits
 * (CodeBuddy + Trae) and the extra OpenAI-compatible providers registry.
 *
 * Talks to the host route /dsh-tap/settings:
 *   GET  → { value, user, oauth, bridge, models, trae, qoder }
 *   POST → { patch } | { action: 'oauth-start'|'oauth-status'|'oauth-logout'
 *          |'model-list'|'model-sync'|'usage'|'provider-*'|'credential-*'
 *          |'trae-oauth-*'|'trae-model-*'|'qoder-oauth-*' }
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
		// 图标命名两代共存（dsh 0.1.7 换代，实测）：≤0.1.6 导出带尺寸数字后缀的
		// IconChevronDownOutline14 / IconRefreshOutline14；0.1.7 起数字后缀**全部消失**，
		// 改为 Artwork/Medium/Regular 尺寸变体（且基础名 IconChevronDownOutline 并不导出）。
		// 按候选顺序取第一个存在的——两代宿主都拿到原生图标，全缺才退原生兜底。
		function pickComponent(names) {
			if (!ui) return null;
			for (var i = 0; i < names.length; i++) { if (ui[names[i]]) return ui[names[i]]; }
			return null;
		}
		var UIButton = pickComponent(["Button"]);
		var UIInput = pickComponent(["Input"]);
		var IconChevron = pickComponent(["IconChevronDownOutline14", "IconChevronDownOutlineRegular", "IconChevronDownOutlineMedium", "IconChevronDownOutline", "IconChevronDownOutlineArtwork"]);
		var IconRefresh = pickComponent(["IconRefreshOutline14", "IconRefreshOutlineRegular", "IconRefreshOutlineMedium", "IconRefreshOutline", "IconRefreshOutlineArtwork"]);

		var ROUTE = "/dsh-tap/settings";

		// fetch 超时护栏：设置服务挂起时卡片不能永久停在"正在读取"（健壮性）。
		// AbortError 换成带原因的中文错误——只写"（网络）"曾误导排查（踩坑 #7）。
		function fetchWithTimeout(url, opts, ms) {
			var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
			var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
			var o = Object.assign({}, opts || {});
			if (ctrl) o.signal = ctrl.signal;
			return fetch(url, o).then(function (r) {
				if (timer) clearTimeout(timer);
				return r;
			}, function (e) {
				if (timer) clearTimeout(timer);
				if (ctrl && e && e.name === "AbortError") throw new Error("设置服务响应超时（" + Math.round(ms / 1000) + "s，网络或服务挂起）");
				throw e;
			});
		}

		// ------------------------------------------------------------------
		// Styles: one injected block, cbc- prefixed, token-backed. Idempotent.
		// ------------------------------------------------------------------
		var CSS_TEXT = [
			// ---- card shell（镜像第一方 PluginCard：radius 12 / border-l2 / 层级底色）----
			// 原生控件配色必须绑宿主主题**属性**：宿主在 html/body 上无条件写
			// color-scheme:dark（实测两态计算值恒为 dark），而该属性决定 Chrome 给
			// checkbox/radio 取哪套面板色 ⇒ 浅色主题下未勾选框被画成深色实心块，看着
			// 像"已开启"（区块头常显的通道开关正处在收起态第一眼位置）。宿主主题由
			// body[data-ds-dark-theme] 驱动，prefers-color-scheme 仿真实测零效果 ⇒ 不用
			// @media。卡片根是全卡唯一共同根（page 视图 div.cbc-card / 旧槽 li.cbc-card；
			// summary 视图是一行 span、无任何控件）。
			"body[data-ds-dark-theme] .cbc-card{color-scheme:dark}",
			"body:not([data-ds-dark-theme]) .cbc-card{color-scheme:light}",
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
			// :where() 零特异性：all:unset 不再压过基类，button 只需补 cursor——消除两份全量属性拷贝的同步义务。
			":where(button).cbc-chip{all:unset}",
			".cbc-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;padding:5px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;box-sizing:border-box}",
			"button.cbc-chip{cursor:pointer}",
			"button.cbc-chip:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5));color:var(--dsw-alias-label-primary,inherit)}",
			"button.cbc-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px}",
			".cbc-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary,gray)}",
			".cbc-dot.cbc-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}",
			".cbc-dot.cbc-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".cbc-dot.cbc-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			// idle = 「本区块没有通道运行态」（通用区块）：空心环，占位不变。
			// off 的实心灰点在三家行里读作「未启用」，借给一个有额度读数的区块是自相矛盾。
			".cbc-dot.cbc-idle{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}",
			// ---- 区块头「已保存 ✓」短提示 ----
			// 常驻占位（visibility 切换而非条件渲染）：flash 出现/消失瞬间不改变
			// 同行 checkbox 的水平位置，避免 1.8s 内同坐标二次点击误触展开 button。
			".cbc-saveflash{margin-left:auto;font-size:12px;color:var(--dsw-alias-state-success-primary,#2a9d4a);padding:0 8px;white-space:nowrap;visibility:hidden}",
			".cbc-saveflash.cbc-on{visibility:visible}",
			// sr-only（live region 专用）：流外 1px clip，文本进出 DOM 不参与布局，
			// 可见行的宽度恒定契约不受影响。
			".cbc-srlive{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}",
			// ---- 分区通用 ----
			".cbc-divider{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));margin:4px 0}",
			".cbc-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}",
			".cbc-row-label{flex:0 0 132px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-row-control{flex:1;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
			".cbc-check{width:16px;height:16px;flex:0 0 auto;accent-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			// 命中面 ≥24×24（WCAG 2.2 SC 2.5.8）：原生 checkbox 命中就是 16×16，Chrome
			// 对 appearance:checkbox 不吃 input 自身的 padding（命中仍 16×16 且框挪
			// 7px，tmp-geom-probe.js padOnInput 证伪）；label 包裹 + 负 margin 让 label
			// 在 flex 布局里仍按 16px 占位——实测命中 31×30、开关 x 与行高不变
			// （padOnLabel 变体）。label 对落在控件自身的 click 不再转发，只对 label
			// 空白处派发一次合成 click ⇒ 不引入双 change（#27 的双 change 是受控回弹
			// 时序问题，与 label 无关；[C3]「恰 1 次 POST」断言在跑）。
			".cbc-checkhit{display:inline-flex;align-items:center;padding:4px;margin:-4px;flex:0 0 auto}",
			".cbc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);margin:4px 0 6px;line-height:1.5}",
			".cbc-status{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);line-height:1.5}",
			".cbc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid rgba(211,51,51,.35);border-radius:8px;padding:6px 10px;margin:6px 0}",
			".cbc-error-close{all:unset;cursor:pointer;font-size:13px;padding:0 4px;color:inherit;display:inline-flex}",
			".cbc-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b80);line-height:1.5;margin:4px 0}",
			".cbc-muted{color:var(--dsw-alias-label-tertiary,gray);font-size:12px}",
			".cbc-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,gray);margin:10px 0 6px}",
			// 模型列表内的子标题（当前可用/未启用/选择器内 n/m）：比一级分组标题
			// 低一层，不参与「凭据/模型/工具/网关/高级」的一级序列契约。
			".cbc-subtitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);margin:8px 0 4px}",
			// 模型组操作条（三家同构）：同步按钮 + 状态文字 + 筛选框同一行。
			".cbc-syncbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 8px}",
			".cbc-link{color:var(--dsw-alias-state-business-primary,#1a66ff);text-decoration:none}",
			".cbc-link:hover{text-decoration:underline}",
			// ---- 列表行 / 徽标 ----
			".cbc-listrow{display:flex;align-items:center;flex-wrap:wrap;row-gap:2px;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin-bottom:6px;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-cell-name{font-weight:600;min-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-cell-masked{color:var(--dsw-alias-label-tertiary,gray);flex:1;font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".cbc-badge{font-size:11px;color:var(--dsw-alias-state-success-primary,#2a9d4a);border:1px solid rgba(42,157,74,.35);border-radius:4px;padding:1px 4px;white-space:nowrap;flex:0 0 auto}",
			// P2-4：已知不可路由（恒 11102）条目置灰 + 警示色徽标。
			".cbc-listrow.cbc-unroutable{opacity:.55}",
			".cbc-badge-dead{color:var(--dsw-alias-state-warning-primary,#b27d00);border-color:rgba(178,125,0,.4)}",
			".cbc-effort{font-size:11px;color:var(--dsw-alias-label-tertiary,gray);font-family:var(--ds-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;flex:0 0 auto}",
			".cbc-effort-sel{font-size:11px;padding:2px 4px;max-width:110px;flex:0 0 auto}",
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
			// ghost 变名实归：9 处 ghost 按钮（含两处破坏性「删除」与区块头「重置」）此前
			// 无任何规则 ⇒ 零 hover 零焦点环，读起来就是普通文本（区块头紧邻开关时会被
			// 当成开关的标签）。hover 给底色、focus-visible 给环，与 .cbc-headact 同口径。
			".cbc-btn-ghost:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
			".cbc-btn-ghost:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px}",
			".cbc-btn:disabled{cursor:not-allowed;opacity:.4}",
			".cbc-scrollbox{max-height:300px;overflow-y:auto}",
			".cbc-addrow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}",
			// ---- 幽灵输入（模型行上限）：常态无边框、hover/focus 显边框、去数字步进器 ----
			// 宿主 Input 原语把 className 落在 wrapper span（边框也在 wrapper），
			// 焦点在内层 input ⇒ 用 :focus-within；原生兜底路径 className 在 input 自身。
			".cbc-ghost{border-color:transparent!important;background:var(--dsw-alias-bg-layer-1,transparent)!important}",
			".cbc-ghost:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.4))!important}",
			".cbc-ghost:focus,.cbc-ghost:focus-visible,.cbc-ghost:focus-within{border-color:var(--dsw-alias-state-business-primary,#1a66ff)!important;background:var(--dsw-alias-bg-layer-1,transparent)!important}",
			".cbc-ghost::-webkit-outer-spin-button,.cbc-ghost::-webkit-inner-spin-button,.cbc-ghost input::-webkit-outer-spin-button,.cbc-ghost input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
			".cbc-ghost,.cbc-ghost input{-moz-appearance:textfield;appearance:textfield}",
			".cbc-updated{font-size:12px;color:var(--dsw-alias-label-tertiary,gray)}",
			// ---- 折叠说明（HelpNote）：长背景说明默认收起，信息一次点击可达 ----
			".cbc-help{margin:6px 0 2px}",
			".cbc-help summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary,gray);list-style:none;display:inline-flex;align-items:center;gap:4px;user-select:none}",
			".cbc-help summary::-webkit-details-marker{display:none}",
			".cbc-help summary:after{content:\"▸\";font-size:10px}",
			".cbc-help[open] summary:after{content:\"▾\"}",
			".cbc-help summary:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-help summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px;border-radius:4px}",
			".cbc-helpbody{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);line-height:1.6;margin:4px 0 2px}",
			".cbc-helpbody .cbc-hint{margin:2px 0}",
			// ---- 高级工程项折叠（details.cbc-adv）：与使用说明（cbc-help）同款纪律，
			// 开合状态由 <details> 自带，零 JS。域名/baseURL/client_id 收进这里。 ----
			".cbc-adv{margin:10px 0 2px}",
			".cbc-adv>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,gray);list-style:none;display:inline-flex;align-items:center;gap:4px;user-select:none}",
			".cbc-adv>summary::-webkit-details-marker{display:none}",
			".cbc-adv>summary:after{content:\"▸\";font-size:10px}",
			".cbc-adv[open]>summary:after{content:\"▾\"}",
			".cbc-adv>summary:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-adv>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px;border-radius:4px}",
			".cbc-advbody{margin-top:6px}",
			// ---- 通道手风琴（0.10.0 交互模型）----
			".cbc-acc{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-acc.cbc-open{background:var(--dsw-alias-bg-layer-2,#fff)}",
			".cbc-acc-head{display:flex;align-items:center;gap:8px;padding:10px 12px}",
			".cbc-acc-toggle{all:unset;flex:1 1 auto;display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0}",
			".cbc-acc-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:-2px;border-radius:8px}",
			".cbc-acc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);flex:0 0 auto}",
			".cbc-acc-status{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}",
			// 状态行 warn/err 段自带色（点仍取最差）：整行底色是 tertiary 灰，需要处理
			// 的段落跳出来；token 与 .cbc-dot 同名同值，深色主题自动跟随。
			".cbc-acc-status .cbc-seg-warn{color:var(--dsw-alias-state-warn-primary,#b80)}",
			".cbc-acc-status .cbc-seg-err{color:var(--dsw-alias-state-error-primary,#d33)}",
			".cbc-acc-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));padding:8px 12px 10px}",
			".cbc-acc-body[hidden]{display:none}",
			".cbc-acc-ctl{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,gray)}",
			// P2-3 区块头就地动作（重试监听/复制诊断）：仅 warn/err 态渲染，正常态零占位。
			".cbc-acc-acts{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px}",
			".cbc-headact{all:unset;cursor:pointer;font-size:11px;line-height:1.4;padding:2px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));color:var(--dsw-alias-label-secondary,gray);white-space:nowrap}",
			".cbc-headact:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}",
			".cbc-headact:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:1px}",
			".cbc-headact[disabled]{opacity:.5;cursor:default}",
			".cbc-headconfirm{font-size:11px;line-height:1.4;color:var(--dsw-alias-state-warn-primary,#b80);white-space:nowrap;padding:0 2px}",
			".cbc-chevronwrap{flex:0 0 auto;display:inline-flex}",
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
				autoComplete: props.autoComplete,
				"aria-label": props.ariaLabel,
				onInput: props.onInput,
				onBlur: props.onBlur,
				onKeyDown: props.onKeyDown,
			};
			if (UIInput) return createElement(UIInput, Object.assign({ className: w }, shared));
			return createElement("input", Object.assign({ className: "cbc-input " + w }, shared));
		}

		// 折叠说明：长背景说明（>60 字）默认收进 details——每标签少一堵小字墙，
		// 信息一次点击可达；短的就地点提示（模型组/OAuth 覆盖范围/空态）保持直显。
		function HelpNote(props) {
			return createElement("details", { className: "cbc-help" },
				createElement("summary", null, props.label || "使用说明"),
				createElement("div", { className: "cbc-helpbody" }, props.children));
		}

		// 分区级错误隔离：任一标签渲染抛错只塌该标签（fallback + 重试按钮），
		// 不拖垮整卡——React 对未捕获的渲染错误会卸载整棵树（健壮性）。
		var PanelBoundary = (function () {
			class PB extends react.Component {
				constructor(props) {
					super(props);
					this.state = { err: null, nonce: 0 };
				}
				render() {
					if (this.state.err) {
						var self = this;
						return createElement("div", { className: "cbc-error" },
							createElement("span", null, "此分区渲染失败：" + (this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err))),
							createElement("button", {
								type: "button", className: "cbc-error-close", title: "重试渲染该分区",
								onClick: function () { self.setState(function (s) { return { err: null, nonce: s.nonce + 1 }; }); },
							}, "重试"));
					}
					// nonce 进 key：重试时换 key 强制重挂载子树。
					return createElement(Fragment, { key: this.state.nonce }, this.props.children);
				}
			}
			PB.getDerivedStateFromError = function (err) { return { err: err }; };
			// fallback 只显示 message；堆栈进 console，否则排查无线索（踩坑 #7）。
			PB.prototype.componentDidCatch = function (err, info) {
				console.error("[dsh-tap] 分区渲染失败", err, info && info.componentStack);
			};
			return PB;
		})();

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
		// 千分位：791237 → 791,237（用量 token 读数可读性）。
		function fmtNum(n) {
			if (n == null || n === "") return "-";
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}
		function fmtClock(ms) {
			var d = new Date(ms);
			var p = function (n) { return n < 10 ? "0" + n : "" + n; };
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		function pct(remain, size) {
			if (!size || size <= 0) return null;
			return Math.max(0, Math.min(100, Math.round((remain / size) * 100)));
		}

		// ------------------------------------------------------------------
		// Blocks（通道手风琴）。顺序 = 主通道 → 两家订阅通道 → 跨通道通用；
		// 归类原则「谁提供归谁」，证据见 docs/goals/settings-card-ux-redesign.md §3。
		// ------------------------------------------------------------------
		var BLOCK_DEFS = [
			{ id: "codebuddy", title: "CodeBuddy" },
			{ id: "trae", title: "TraeWork CN" },
			{ id: "qoder", title: "Qoder CN" },
			{ id: "general", title: "通用" },
		];
		// 区块 → 分区序列（渲染顺序即数组顺序）。
		var BLOCK_SECTIONS = {
			codebuddy: ["login", "models", "tools", "bridge"],
			trae: ["trae"],
			qoder: ["qoder"],
			general: ["usage", "providers", "hostrecon"],
		};
		var SECTION_RENDERERS = {};

		// 保存后网关「未监听」的退避补拉节奏（见 CodeBuddyCard 里的 settleGateways）。
		var GATEWAY_SETTLE_DELAYS = [1000, 2000, 4000];

		// ------------------------------------------------------------------
		// Root card.
		// ------------------------------------------------------------------
		function CodeBuddyCard(props) {
			props = props || {};
			// embedded = dsh 0.1.6 Plugin Manager 的 page 视图：页面自带标题与
			// 返回 crumb，卡片常开且不再画自己的折叠头部。
			var embedded = props.embedded === true;
			var cardOpenState = useState(embedded);
			var cardOpen = cardOpenState[0];
			var setCardOpen = cardOpenState[1];
			var dataState = useState(null);
			var data = dataState[0];
			var setData = dataState[1];
			var errState = useState("");
			var err = errState[0];
			var setErr = errState[1];
			// 手风琴：多开互不联动；展开才挂载、收起不卸载（hidden 保留 DOM，
			// 草稿/滚动/已拉目录跨展开与保存保留）。
			var openBlocksState = useState({});
			var openBlocks = openBlocksState[0];
			var setOpenBlocks = openBlocksState[1];
			var mountedBlocksState = useState({});
			var mountedBlocks = mountedBlocksState[0];
			var setMountedBlocks = mountedBlocksState[1];
			// 「已保存 ✓」落在触发该次保存的区块头右侧，1.8s 自愈。
			var savedState = useState(null);   // { block, at }
			var saved = savedState[0];
			var setSaved = savedState[1];
			// P2-3 区块头就地动作状态：retryBusy = 重试中的通道 id；copied = 刚复制过
			// 诊断的通道 id（1.8s 自愈，复用「已保存 ✓」的节奏）。
			var retryState = useState(null);
			var retryBusy = retryState[0];
			var setRetryBusy = retryState[1];
			var copiedState = useState(null);
			var copied = copiedState[0];
			var setCopied = copiedState[1];
			var copiedTimerRef = useRef(null);
			useEffect(function () { return function () { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); }; }, []);
			// P3-7 头部开关误触缓解（设计文档 §8 风险表首选方案）：Trae/Qoder 区块头
			// 启用开关在**收起态**第一次点击只进确认态（沿用 askConfirm 模式，4s 不确认
			// 自动复位；受控 checkbox 不落 save 会自己弹回原态），展开态直切不确认。
			// 误触代价不对称——收起态即可改路由（1 POST），确认只挡收起态这一面。
			var swConfirmState = useState(null);   // 确认中的 fieldKey，或 null
			var swConfirm = swConfirmState[0];
			var setSwConfirm = swConfirmState[1];
			var swConfirmTimerRef = useRef(null);
			useEffect(function () { return function () { if (swConfirmTimerRef.current) clearTimeout(swConfirmTimerRef.current); }; }, []);

			var toggleBlock = function (id) {
				setOpenBlocks(function (prev) {
					var next = Object.assign({}, prev);
					if (next[id]) delete next[id]; else next[id] = true;
					return next;
				});
				setMountedBlocks(function (prev) {
					if (prev[id]) return prev;
					var next = Object.assign({}, prev);
					next[id] = true;
					return next;
				});
			};

			// 请求代次（终审 Important 2 / 踩坑 #45 的另一半）：save 的 .then 里必跟一次
			// load()，而「四区块可同时展开 + 每分区各持一个 saveIn(block)」让 1 秒内并发
			// 保存成为正常路径。两次 POST 落在同一个 GET 往返窗口（实测 ~1.0–1.3s）时，
			// 先发后回的旧响应会覆掉新响应、UI 停在旧值且主视图无轮询自救 ⇒ 每次 load
			// 领一个代次号，回包时代次不是最新就整包丢弃（含失败分支——陈旧请求的报错也
			// 不该盖住新态）。作废包**不写** dataRef ⇒ ref 里永远是「最新被采纳的那份」。
			// 补拉链的**两个判定点都读 dataRef、都不读回调参数**：启动点（save 的 .then）
			// 与续跑点（settleGateways 的退避回调）同形——load() 被更新的请求抢先时返回的
			// 是 null，任何一处拿 null 去判 pending 都会让链条在那一刻静默停摆（踩坑 #45）。
			var loadGenRef = useRef(0);
			var dataRef = useRef(null);
			// P3-6 冷启动引导：首次被采纳的视图里三通道均无凭据 ⇒ 默认展开 CodeBuddy
			// 区块一次（useRef 守卫——同一挂载内只引导一次，用户手动收起后不被后续
			// load 反复撬开；不引入持久化状态，任一通道有凭据即保持默认全收）。
			var coldStartRef = useRef(false);
			var load = function () {
				var my = ++loadGenRef.current;
				return fetchWithTimeout(ROUTE, { headers: { accept: "application/json" } }, 20000)
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
					.then(function (d) {
						if (my !== loadGenRef.current) return null;   // 有更新的请求在飞/已回 ⇒ 本包作废
						dataRef.current = d;
						setData(d); setErr("");
						if (!coldStartRef.current) {
							coldStartRef.current = true;
							var v = d.value || {};
							var cbHasCred = v.authMode === "oauth" ? !!((d.oauth || {}).signedIn) : !!v.activeApiKey;
							var traeHasCred = !!(((d.trae || {}).oauth || {}).signedIn);
							var qoderHasCred = !!(((d.qoder || {}).oauth || {}).signedIn);
							if (!cbHasCred && !traeHasCred && !qoderHasCred) {
								setOpenBlocks(function (prev) { var n = Object.assign({}, prev); n.codebuddy = true; return n; });
								setMountedBlocks(function (prev) { var n = Object.assign({}, prev); n.codebuddy = true; return n; });
							}
						}
						return d;
					})
					.catch(function (e) {
						if (my !== loadGenRef.current) return null;
						setErr(e && e.message ? e.message : "设置服务不可达"); return null;
					});
			};
			// Mount 即拉一次（折叠态头部芯片要有真值），每次展开（false→true）
			// 再刷新——收起不拉：[cardOpen] 依赖在 true→false 时同样 fire。
			var prevOpenRef = useRef(null);
			useEffect(function () {
				if (prevOpenRef.current === null || (cardOpen && prevOpenRef.current === false)) load();
				prevOpenRef.current = cardOpen;
				return undefined;
			}, [cardOpen]);

			// 保存后的网关补拉：三个网关的 running 都由 'listening' 事件异步翻转
			//（index.js syncBridge/syncTraeBridge/syncQoderBridge），紧跟 POST 的 GET
			// 很容易采样到 pre-listening 窗口；主视图没有轮询，这枚假「未监听」会一直
			// 挂到用户收起再展开。有限次退避补拉即自愈；真是 EADDRINUSE 之类的失败，
			// 用尽次数后停手，warn 如实留下。
			var settleRef = useRef(null);
			useEffect(function () {
				return function () { if (settleRef.current) clearTimeout(settleRef.current); };
			}, []);
			var gatewayPending = function (d) {
				if (!d) return false;
				var c = buildChips(d);
				return [c.bridge, c.trae, c.qoder].some(function (x) {
					return !!x && x.tone !== "ok" && x.tone !== "off" && /未监听/.test(x.text);
				});
			};
			var settleGateways = function (attempt) {
				if (settleRef.current) clearTimeout(settleRef.current);
				if (attempt >= GATEWAY_SETTLE_DELAYS.length) return;
				settleRef.current = setTimeout(function () {
					settleRef.current = null;
					// 读 dataRef 而非回调参数：本包若被更新的请求作废，load() 返回 null，
					// 拿 null 去判 pending 会让退避链就地停摆（踩坑 #45 的自愈保护被悄悄削
					// 弱）。dataRef 只被采纳分支写 ⇒ 读到的必是最新采纳态，链照旧走完。
					load().then(function () { if (gatewayPending(dataRef.current)) settleGateways(attempt + 1); });
				}, GATEWAY_SETTLE_DELAYS[attempt]);
			};

			var post = function (body) {
				return fetchWithTimeout(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}, 30000).then(function (r) {
					return r.text().then(function (t) {
						var d = null;
						try { d = JSON.parse(t); } catch (e) { /* not JSON */ }
						return { ok: r.ok, status: r.status, d: d || {} };
					});
				});
			};
			var save = function (patch, blockId) {
				post({ patch: patch }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "保存失败（HTTP " + res.status + "）"); return; }
					setSaved({ block: blockId || null, at: Date.now() });
					// 启动点与续跑点（settleGateways 内那处）同形：判 pending 读 dataRef 而非
					// 回调参数，否则本次 GET 被更新的一发抢先作废时拿到 null ⇒ 退避链一次都
					// 没启动（踩坑 #45 的自愈保护被静默削掉）。
					load().then(function () { if (gatewayPending(dataRef.current)) settleGateways(0); });
				}).catch(function (e) { setErr(e && e.message ? e.message : "保存失败（网络）"); });
			};
			// 分区拿到的是绑定了所属区块的 save —— 「已保存 ✓」才知道浮在哪个区块头。
			var saveIn = function (blockId) {
				return function (patch) { save(patch, blockId); };
			};

			// P2-3 状态行可操作化：warn/err 通道的区块头尾部出两个就地动作。
			// 重试监听 = 服务端 action 重跑该通道 sync*（enabled 限定、不写配置）；
			// running 由 'listening' 异步翻转 ⇒ 补拉链启动点与 save 同形（踩坑 #45：
			// 判 pending 读 dataRef，不读回调参数）。
			var retryGateway = function (channel) {
				if (retryBusy) return;
				setRetryBusy(channel);
				post({ action: "gateway-retry", channel: channel }).then(function (res) {
					setRetryBusy(null);
					if (!res.ok) { setErr((res.d && res.d.error) || ("重试失败（HTTP " + res.status + "）")); return; }
					load().then(function () { if (gatewayPending(dataRef.current)) settleGateways(0); });
				}).catch(function (e) {
					setRetryBusy(null);
					setErr("重试失败：" + (e && e.message ? e.message : String(e)));
				});
			};
			// 复制诊断 = 纯客户端聚合（数据全在 dataRef 的 GET 视图里：running/端口/
			// lastError/最近同步时间——该视图本就脱敏，无密钥无令牌，踩坑 #26 纪律不破）。
			var copyDiagnostics = function (channel) {
				var d = dataRef.current || {};
				var value = d.value || {};
				var br, port, sync;
				if (channel === "trae") { br = (d.trae || {}).bridge || {}; port = value.traeBridgePort; sync = ((d.trae || {}).models || {}).sync; }
				else if (channel === "qoder") { br = (d.qoder || {}).bridge || {}; port = value.qoderBridgePort; sync = ((d.qoder || {}).models || {}).sync; }
				else { br = d.bridge || {}; port = value.bridgePort; sync = (d.models || {}).sync; }
				var drifts = (((d.host || {}).drift) || []).filter(function (x) { return x && x.channel === channel; });
				var lines = [
					"[dsh-tap] " + channel + " 诊断 · " + new Date().toLocaleString(),
					"网关: " + (br.running ? ("运行中 127.0.0.1:" + br.port) : ("未监听 :" + (br.port || port || "?")) + (br.lastError === "EADDRINUSE" ? "（另一实例代管）" : "")),
					"lastError: " + (br.lastError || "（无）") + (br.lastError === "EADDRINUSE" ? "——若占用者是另一个 dsh 实例，其桥仍会代管本实例流量，功能等价" : ""),
					"模型目录: " + (sync ? (sync.count + " 个 · 同步于 " + fmtTime(sync.at)) : "未同步"),
					"宿主漂移: " + (drifts.length ? drifts.map(function (x) { return "期望 " + x.expected + " / 实际 " + (x.actual == null ? "路由缺席" : x.actual); }).join("；") : "无"),
				];
				var fail = function () { setErr("复制失败：浏览器拒绝了剪贴板写入"); };
				if (!navigator.clipboard || !navigator.clipboard.writeText) { fail(); return; }
				navigator.clipboard.writeText(lines.join("\n")).then(function () {
					setCopied(channel);
					if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
					copiedTimerRef.current = setTimeout(function () { setCopied(null); }, 1800);
				}, fail);
			};

			// “已保存 ✓”短提示：1.8s 后自动消失（保存成功无其他反馈曾是盲区）。
			useEffect(function () {
				if (!saved) return undefined;
				var t = setTimeout(function () { setSaved(null); }, 1800);
				return function () { clearTimeout(t); };
			}, [saved]);

			// 通用区块头的「额度 / 服务商数」不在 GET 视图里（额度来自 action:'usage'、
			// 服务商数来自 provider-list）⇒ ①卡片挂载时各取样一次 ②「通用」区块**由展开
			// 转为收起**那一刻再重采一次（终审 Important 1）。
			// 为什么必须有 ②：头部状态行是本轮卖点「首屏即总览 / 区块头 = 状态单一真源」
			// 的载体，而它正下方的展开区每 10s 轮询——只在挂载时采一次会让头部停在"打开
			// 页面那一刻"的快照，用户加/删一个服务商或聊了一小时之后，头部与同屏正文自相
			// 矛盾。为什么不做周期轮询：头部四行常驻，轮询等于每次开卡都多打一份上游额度
			// 只读（成本考虑，spec §3）⇒ 只在一个交互边界上补采，请求量最多 +1 次/收起。
			// credential-scan 不上移——它扫本机文件，仍只在通用区块首次挂载时做。
			var genSampleState = useState(null);   // { text }
			var genSample = genSampleState[0];
			var setGenSample = genSampleState[1];
			// 取样代次：同一刻只认最后一次（展开边界与保存补拉可能撞车）。
			var genSampleGenRef = useRef(0);
			var sampleGeneralHead = function () {
				var my = ++genSampleGenRef.current;
				Promise.all([
					post({ action: "usage" }).catch(function () { return null; }),
					post({ action: "provider-list" }).catch(function () { return null; }),
				]).then(function (res) {
					if (my !== genSampleGenRef.current) return;
					setGenSample({ text: generalSummary(res[0], res[1]) });
				}).catch(function (e) {
					// fire-and-forget 必须落地（踩坑 #33）：genSample 保持 null ⇒ 头部
					// 回落「额度与用量 · 服务商」无数字文案，绝不用假值填坑。
					// 两个输入各自 .catch(() => null)，网络失败到不了这里 ⇒ 能进这个分支的
					// 只有 generalSummary / setGenSample 自己的 bug；静默置 null 会让头部
					// 永久停在占位文案且零线索（踩坑 #7：错误提示要带原因）。只 warn 不弹
					// 横幅——头部取样是装饰性信息，横幅反而打扰。
					console.warn("dsh-tap: 通用区块头取样失败", e);
					if (my !== genSampleGenRef.current) return;
					setGenSample(null);
				});
			};
			// deps 只挂 general 的开/关：prev 为 null = 挂载首采；true→false = 收起边界重采。
			// 展开（false→true）不采——正文自己会拉，且 [F4] 的"展开后 ≥2"来自轮询不是这里。
			var prevGenOpenRef = useRef(null);
			useEffect(function () {
				var was = prevGenOpenRef.current;
				var isOpen = !!openBlocks.general;
				prevGenOpenRef.current = isOpen;
				if (was === null || (was === true && isOpen === false)) sampleGeneralHead();
				return undefined;
			}, [!!openBlocks.general]);

			var chevron = IconChevron
				? createElement("span", { className: "cbc-chevron" + (cardOpen ? " cbc-open" : "") }, createElement(IconChevron, { size: 14 }))
				: createElement("span", { className: "cbc-chevron" + (cardOpen ? " cbc-open" : "") }, "▾");

			// 折叠态（仅旧槽 settings.plugin.item 会走到）：不再常显三芯片——
			// 状态由区块头承载；只在确有待处理项时浮一枚计数芯片。
			var headChips = null;
			if (!cardOpen && data) {
				var n = attentionCount(data);
				if (n > 0) {
					headChips = createElement("span", { className: "cbc-headchips" },
						createElement("span", { className: "cbc-chip" },
							createElement(Dot, { tone: "warn" }), n + " 项需处理"));
				}
			}

			var header = createElement(
				"button",
				{ type: "button", className: "cbc-header", "aria-expanded": cardOpen ? "true" : "false", onClick: function () { setCardOpen(!cardOpen); } },
				createElement("span", null,
					createElement("div", { className: "cbc-name" }, "dsh-tap"),
					createElement("div", { className: "cbc-desc" }, "CodeBuddy / Trae / Qoder CN 通道接入：凭据、模型、额度、工具与流式桥。")),
				headChips,
				chevron,
			);
			var cardClass = "cbc-card" + ((cardOpen || embedded) ? " cbc-open" : "");
			var cardTag = embedded ? "div" : "li";
			if (!cardOpen && !embedded) return createElement(cardTag, { className: cardClass }, header);
			if (!data) {
				return createElement(cardTag, { className: cardClass }, embedded ? null : header,
					createElement("div", { className: "cbc-body" }, createElement("p", { className: "cbc-status" }, err || "正在读取设置…")));
			}

			var errorBanner = err
				? createElement("p", { className: "cbc-error", role: "alert" },
					createElement("span", null, err),
					createElement("button", { type: "button", className: "cbc-error-close", title: "关闭", onClick: function () { setErr(""); } }, "✕"))
				: null;

			// 分区：展开才挂载 + 收起隐藏不卸载（hidden 保留组件状态与 DOM）。
			var sectionProps = {
				login: { value: data.value || {}, oauth: data.oauth || {}, save: saveIn("codebuddy"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data) },
				models: { post: post, setErr: setErr, reload: load, modelsInfo: data.models || {}, value: data.value || {}, save: saveIn("codebuddy") },
				tools: { value: data.value || {}, save: saveIn("codebuddy"), overridden: overriddenFor(data) },
				bridge: { value: data.value || {}, save: saveIn("codebuddy"), overridden: overriddenFor(data), bridgeView: data.bridge || {} },
				trae: { value: data.value || {}, save: saveIn("trae"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data), trae: data.trae || {}, active: !!openBlocks.trae },
				qoder: { value: data.value || {}, save: saveIn("qoder"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data), qoder: data.qoder || {}, active: !!openBlocks.qoder },
				usage: { post: post, value: data.value || {}, save: saveIn("general"), overridden: overriddenFor(data), active: !!openBlocks.general },
				providers: { post: post, setErr: setErr },
				hostrecon: { host: data.host || null },
			};
			var status = blockStatus(data, genSample ? genSample.text : null);
			var blocks = BLOCK_DEFS.map(function (def) {
				var isOpen = !!openBlocks[def.id];
				var isMounted = !!mountedBlocks[def.id];
				// 通道级启用开关：Trae/Qoder 的唯一落点（收起态也能一眼看状态并直接启停）。
				// 头部是 div + 两个独立交互元素，不构成嵌套交互。
				var channelSwitch = function (blockId, fieldKey, blockTitle) {
					var curOn = (data.value || {})[fieldKey] === true;
					var confirming = swConfirm === fieldKey;
					// 子节点顺序 = [确认提示?, 重置?, 开关]：ctl 右边缘被常驻的 flash +
					// chevron 钉死，开关放最后才能吃到固定 x 坐标。反序时"重置"在位与否
					// 会让开关行间错开 ≈50px，而第一次点击插入的确认提示（≈90px）会把
					// 开关当场推走——收起态的两次点击（P3-7）就落在非交互文本上，确认永远
					// 完不成（偏右一点还正好命中「重置」）。元素级 click 的测试看不见这个。
					return createElement("span", null,
						confirming
							? createElement("span", {
								className: "cbc-headconfirm", "data-field": fieldKey + "-confirm", role: "status",
							}, "再点一次确认" + (curOn ? "停用" : "启用"))
							: null,
						createElement(ResetButton, { fieldKey: fieldKey, overridden: overriddenFor(data)(fieldKey), save: saveIn(blockId) }),
						// label 包裹扩命中面（.cbc-checkhit，SC 2.5.8）；title/aria-label
						// 仍在 input 上，可访问名与工具提示行为不变。
						createElement("label", { className: "cbc-checkhit" },
							createElement("input", {
								type: "checkbox", className: "cbc-check", "data-field": fieldKey,
								checked: curOn,
								title: confirming
									? ("再点一次确认" + (curOn ? "停用" : "启用") + "（4 秒内有效）")
									: (curOn ? "停用该通道（其模型整体移出选择器）" : "启用该通道"),
								// 可访问名（键盘/AT）：无可见文案，aria-label 动态报出「启用/停用 <通道> 通道」。
								"aria-label": confirming
									? ("确认" + (curOn ? "停用 " : "启用 ") + blockTitle + " 通道（再点一次）")
									: ((curOn ? "停用 " : "启用 ") + blockTitle + " 通道"),
								onChange: function (e) {
									// 收起态先确认（P3-7）：不 save，受控框自动弹回原态；4s 窗内
									// 第二次点击才落盘。展开态直切——用户正看着分区内容，误触面不同。
									if (!openBlocks[blockId] && swConfirm !== fieldKey) {
										if (swConfirmTimerRef.current) clearTimeout(swConfirmTimerRef.current);
										setSwConfirm(fieldKey);
										swConfirmTimerRef.current = setTimeout(function () {
											setSwConfirm(null); swConfirmTimerRef.current = null;
										}, 4000);
										return;
									}
									if (swConfirmTimerRef.current) { clearTimeout(swConfirmTimerRef.current); swConfirmTimerRef.current = null; }
									setSwConfirm(null);
									var p = {};
									p[fieldKey] = e.target.checked;
									save(p, blockId);
								},
							})),
					);
				};
				// P2-3：仅 warn/err 态在区块头状态行尾部出就地动作（重试监听/复制诊断）；
				// 正常态零动作零噪音（spec P2-3）。通用区块无网关，不参与。
				var acts = null;
				if ((def.id === "codebuddy" || def.id === "trae" || def.id === "qoder")
					&& status[def.id] && (status[def.id].tone === "warn" || status[def.id].tone === "err")) {
					acts = [
						createElement("button", {
							key: "r", type: "button", className: "cbc-headact", "data-act": "retry",
							disabled: retryBusy === def.id,
							title: "重跑该通道的本地网关监听（不改配置；端口被占等失败会如实回到状态行）",
							onClick: function () { retryGateway(def.id); },
						}, retryBusy === def.id ? "重试中…" : "重试监听"),
						createElement("button", {
							key: "d", type: "button", className: "cbc-headact", "data-act": "diag",
							title: "复制该通道的 running/端口/lastError/最近同步时间到剪贴板",
							onClick: function () { copyDiagnostics(def.id); },
						}, copied === def.id ? "已复制 ✓" : "复制诊断"),
					];
				}
				return createElement("div", {
					key: def.id, className: "cbc-acc" + (isOpen ? " cbc-open" : ""), "data-block": def.id,
				},
					createElement(BlockHead, {
						id: def.id, title: def.title, status: status[def.id],
						open: isOpen, mounted: isMounted,
						onToggle: function () { toggleBlock(def.id); },
						flash: !!(saved && saved.block === def.id),
						actions: acts,
						control: def.id === "trae" ? channelSwitch("trae", "traeEnabled", def.title)
							: def.id === "qoder" ? channelSwitch("qoder", "qoderEnabled", def.title)
								: null,
					}),
					isMounted ? createElement("div", {
						className: "cbc-acc-body cbc-block", "data-block": def.id,
						id: "cbc-block-" + def.id,
						hidden: isOpen ? undefined : true,
					}, BLOCK_SECTIONS[def.id].map(function (sid) {
						// PanelBoundary 粒度 = 每分区：一处塌落不影响同区块其它分区。
						return createElement(PanelBoundary, { key: sid },
							createElement(SECTION_RENDERERS[sid], sectionProps[sid]));
					})) : null);
			});

			return createElement(cardTag, { className: cardClass }, embedded ? null : header,
				createElement("div", { className: "cbc-body" },
					errorBanner,
					blocks,
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
			var qoauth = (data.qoder || {}).oauth || {};
			// P1-1 宿主实况对账：漂移通道就地 warn（状态行尾部追加「宿主漂移」标记）。
			var hostView = data.host || {};
			var driftAt = {};
			(hostView.drift || []).forEach(function (d) { if (d && d.channel) driftAt[d.channel] = d; });
			// web 钉选漂移（searchProvider/fetchProvider 未指向 codebuddy）同样落在
			// codebuddy 头——搜索/抓取工具归该区块；它不在 drift[]（通道形状）里，直读 webPin。
			var codebuddyDrift = !!driftAt.codebuddy || !!(hostView.webPin && hostView.webPin.ok === false);
			var login;
			if (value.authMode === "oauth") {
				login = oauth.needsRelogin
					? { tone: "err", text: "OAuth 需重新登录" }
					: oauth.signedIn
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
			var traeChip = {
				// 启用但网关未监听 = 需要处理（warn），与 Qoder 芯片同口径。
				// 品牌前缀不进 text——Trae/Qoder 已各自成块，标题承载品牌。
				tone: value.traeEnabled === true
					? (((data.trae || {}).bridge || {}).running === true ? "ok" : "warn")
					: "off",
				text: value.traeEnabled === true
					? ((((data.trae || {}).bridge || {}).running === true) ? "运行中" : ("网关未监听 :" + (value.traeBridgePort || "?")) + ((((data.trae || {}).bridge || {}).lastError === "EADDRINUSE") ? "·另一实例代管" : ""))
					: "未启用",
			};
			var qoderChip = {
				tone: value.qoderEnabled === true
					? (((data.qoder || {}).bridge || {}).running === true ? "ok" : "warn")
					: (qoauth.signedIn ? (qoauth.needsRelogin ? "err" : "ok") : "off"),
				text: value.qoderEnabled === true
					? ((((data.qoder || {}).bridge || {}).running === true) ? "运行中" : ("网关未监听 :" + (value.qoderBridgePort || "?")) + ((((data.qoder || {}).bridge || {}).lastError === "EADDRINUSE") ? "·另一实例代管" : ""))
					: (qoauth.signedIn ? (qoauth.needsRelogin ? "需重登" : "已登录·未启用") : (qoauth.pending ? "登录中" : "未启用")),
			};
			// 漂移标记：只升不降（已是 err 不再降成 warn）；文案追加而非替换，原有因保留可见。
			if (driftAt.trae) {
				traeChip = { tone: TONE_RANK[traeChip.tone] >= TONE_RANK.warn ? traeChip.tone : "warn", text: traeChip.text + " · 宿主漂移" };
			}
			if (driftAt.qoder) {
				qoderChip = { tone: TONE_RANK[qoderChip.tone] >= TONE_RANK.warn ? qoderChip.tone : "warn", text: qoderChip.text + " · 宿主漂移" };
			}
			return {
				login: login,
				models: models,
				bridge: bridgeChip,
				// codebuddy 的漂移单独成芯片（它的行是 login/models/bridge 三枚拼接）。
				hostDrift: codebuddyDrift ? { tone: "warn", text: "宿主漂移" } : null,
				search: {
					tone: value.searchEnabled === true ? "ok" : "off",
					text: "搜索 " + (value.searchEnabled === true ? "已启用" : "已禁用"),
				},
				image: {
					tone: value.imageGenEnabled === true ? "ok" : "off",
					text: "生图 " + (value.imageGenEnabled === true ? "已启用" : "已禁用"),
				},
				trae: traeChip,
				qoder: qoderChip,
			};
		}

		// 区块头状态行：判定口径沿用 buildChips（唯一真源）。每个区块取自己那几枚
		// 芯片拼一行，tone = 其中最差的一枚——warn/err 因此就地出现在所属区块头，
		// 不再需要独立的注意条（0.10.0 状态收敛）。
		var TONE_RANK = { off: 0, ok: 1, warn: 2, err: 3 };
		function worstTone(chips) {
			var t = "off";
			chips.forEach(function (c) {
				if (c && (TONE_RANK[c.tone] || 0) > TONE_RANK[t]) t = c.tone;
			});
			return t;
		}
		// 状态行分段渲染（族2）：warn/err 段自带色（token 同 .cbc-dot 口径），点仍取
		// 最差（worstTone 不变）；ok/off/idle 段保持整行灰底色——绿色文字铺开会把
		// 「一切正常」渲染成绿海噪音，且点的语义已覆盖 ok。分隔符用裸文本节点 " · "，
		// textContent 与 chip.join(" · ") 逐字全等——[B2] 预言机等值断言依赖这一点。
		function statusSegs(status) {
			var segs = status.segs || [{ tone: status.tone, text: status.text }];
			var kids = [];
			segs.forEach(function (s, i) {
				if (i > 0) kids.push(" · ");
				kids.push(createElement("span", {
					key: i,
					className: s.tone === "warn" ? "cbc-seg-warn" : s.tone === "err" ? "cbc-seg-err" : undefined,
				}, s.text));
			});
			return kids;
		}
		function blockStatus(data, generalText) {
			var c = buildChips(data);
			var cb = [c.login, c.models, c.bridge];
			if (c.hostDrift) cb.push(c.hostDrift);
			var join = function (list) {
				return list.map(function (x) { return x.text; }).join(" · ");
			};
			return {
				codebuddy: { tone: worstTone(cb), text: join(cb), segs: cb },
				trae: { tone: c.trae.tone, text: c.trae.text, segs: [c.trae] },
				qoder: { tone: c.qoder.tone, text: c.qoder.text, segs: [c.qoder] },
				// idle 而非 off：通用区块没有「通道启用」这回事，实心灰点会被读成未启用。
				general: { tone: "idle", text: generalText || "额度与用量 · 服务商" },
			};
		}

		// 通用区块头文案：额度（OAuth = 真实周期余量；api-key = 标注估算，不编数字）
		// + 服务商数。取样失败时回落到无数字文案，绝不显示假值。
		function generalSummary(usageRes, providersRes) {
			var parts = [];
			var q = usageRes && usageRes.ok ? usageRes.d && usageRes.d.quota : null;
			var u = usageRes && usageRes.ok ? usageRes.d && usageRes.d.usage : null;
			if (q && q.numericQuota && q.resource && q.resource.cycleRemain != null) {
				parts.push("额度 " + fmtCredit(q.resource.cycleRemain) + " credit");
			} else if (q && q.numericQuota && q.resourceError) {
				// 已声明数值额度（OAuth）但读取失败（resourceError 是字符串："code <n>" /
				// "http <n>" / "network"；分区自己渲染「数值额度读取失败：…」）⇒ 不得落进
				// 下面的「估算（累计 …）」分支：那是本插件计量口径的累计消耗，摆在「额度」
				// 位上等于编一个余额（spec §3：取不到就不给数字）。
				parts.push("额度 —");
			} else if (u && typeof u.totalCredit === "number") {
				parts.push("额度 估算（累计 " + fmtCredit(u.totalCredit) + "）");
			} else {
				parts.push("额度 —");
			}
			var list = providersRes && providersRes.ok && providersRes.d ? providersRes.d.providers : null;
			parts.push("服务商 " + (list ? list.length : "—"));
			return parts.join(" · ");
		}

		// 待处理项计数（warn/err）：旧槽折叠态的按需芯片用；展开态由区块头就地承载。
		function attentionCount(data) {
			var c = buildChips(data);
			return [c.login, c.models, c.bridge, c.hostDrift, c.search, c.image, c.trae, c.qoder]
				.filter(function (x) { return x && (x.tone === "warn" || x.tone === "err"); }).length;
		}

		// 区块头：div 里若干独立交互元素（展开 button + 可选动作 + 可选开关），避免
		// 嵌套交互。Task 3 起 control 槽放 Trae/Qoder 的启用开关；P2-3 起 actions 槽
		// 放 warn/err 态的就地动作（重试监听/复制诊断），视觉落在状态行尾部。
		function BlockHead(props) {
			var chevron = IconChevron
				? createElement("span", { className: "cbc-chevron" + (props.open ? " cbc-open" : "") }, createElement(IconChevron, { size: 14 }))
				: createElement("span", { className: "cbc-chevron" + (props.open ? " cbc-open" : "") }, "▾");
			var kids = [
				createElement("button", {
					key: "t", type: "button", className: "cbc-acc-toggle", "data-block": props.id,
					"aria-expanded": props.open ? "true" : "false",
					// 未挂载时没有对应 body，不留空引用（同原 tablist 纪律）。
					"aria-controls": props.mounted ? "cbc-block-" + props.id : undefined,
					onClick: props.onToggle,
				},
					createElement(Dot, { tone: props.status.tone }),
					createElement("span", { className: "cbc-acc-title" }, props.title),
					// 状态行单行省略（窄窗口/漂移追加时必被截），而尾部恰是原因段
					// （「· 宿主漂移」「网关未监听 :3902」）⇒ title 兜住完整文本。
					// 内容走 statusSegs：warn/err 段自带色，文本逐字不变。
					createElement("span", { className: "cbc-acc-status", title: props.status.text }, statusSegs(props.status))),
			];
			// 动作槽紧随展开 button：状态文本在 button 内吃满弹性宽度，动作视觉
			// 上正好落在状态行尾部；独立元素（不是 button 的子节点），点击不触发展开。
			if (props.actions) kids.push(createElement("span", { key: "a", className: "cbc-acc-acts" }, props.actions));
			if (props.control) kids.push(createElement("span", { key: "c", className: "cbc-acc-ctl" }, props.control));
			// flash 常驻占位（visibility 切换）：出现/消失不挤压同行 checkbox 的水平位置。
			kids.push(createElement("span", {
				key: "f", className: "cbc-saveflash" + (props.flash ? " cbc-on" : ""),
				"aria-hidden": props.flash ? undefined : "true",
			}, "已保存 ✓"));
			// live region 收尾：可见占位是宽度恒定契约的载体（P3-7 依赖，文本从不进出
			// DOM ⇒ live region 永不播报），播报职责移到流外 sr-only role=status——
			// 文本 "" ⇄ "已保存 ✓" 进出 DOM 才会被播报；position:absolute 不参与
			// flex 布局，宽度契约原样保住（不加任何会改变行宽的东西）。
			kids.push(createElement("span", {
				key: "fl", className: "cbc-srlive", role: "status",
			}, props.flash ? "已保存 ✓" : ""));
			kids.push(createElement("span", { key: "v", className: "cbc-chevronwrap" }, chevron));
			return createElement("div", { className: "cbc-acc-head" }, kids);
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
			// 破坏性操作二次确认（同 ProvidersSection 模式）：第一次点击只进确认
			// 态（按钮变"确认删除/确认退出"），4 秒不确认自动复位。确认态标识 =
			// Key 名，或 "__logout__" 哨兵（OAuth 视图与 Key 列表互斥不会同屏）。
			var confirmActState = useState(null);
			var confirmAct = confirmActState[0];
			var setConfirmAct = confirmActState[1];
			var confirmTimerRef = useRef(null);
			var askConfirm = function (id) {
				if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
				setConfirmAct(id);
				confirmTimerRef.current = setTimeout(function () { setConfirmAct(null); }, 4000);
			};
			var clearConfirm = function () {
				if (confirmTimerRef.current) { clearTimeout(confirmTimerRef.current); confirmTimerRef.current = null; }
				setConfirmAct(null);
			};

			// P2-5「测一下」：目录面 GET /v3/config 主动验证当前凭据（零额度消耗，
			// UA 口径同目录拉取）；结果就地显示，不进全局横幅。
			var cbTestState = useState(null); // null | {busy:true} | {ok:bool, text:string}
			var cbTest = cbTestState[0];
			var setCbTest = cbTestState[1];
			var testCredential = function () {
				setCbTest({ busy: true });
				post({ action: "credential-test", channel: "codebuddy" }).then(function (res) {
					if (res.ok && res.d.available) setCbTest({ ok: true, text: "✓ 可用（" + (res.d.detail || "验证通过") + "）" });
					else setCbTest({ ok: false, text: "✗ " + ((res.d && res.d.error) || ("HTTP " + res.status)) });
				}).catch(function (e) { setCbTest({ ok: false, text: "✗ " + (e && e.message ? e.message : "网络错误") }); });
			};

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
				if (oauth.signedIn && !oauth.needsRelogin) {
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
						confirmAct === "__logout__"
							? createElement(CbcButton, { variant: "outline", danger: true, onClick: function () {
								clearConfirm();
								post({ action: "oauth-logout" }).then(reload).catch(function (e) { setErr(e && e.message ? e.message : "退出失败（网络）"); });
							} }, "确认退出")
							: createElement(CbcButton, { variant: "outline", danger: true, onClick: function () { askConfirm("__logout__"); } }, "退出登录")));
				} else if (oauth.pending) {
					parts.push(createElement("p", { key: "pend", className: "cbc-status" }, "等待浏览器完成登录…（3 秒轮询，完成后自动刷新）"));
					parts.push(createElement("div", { key: "url", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "outline", onClick: function () { window.open(oauth.authUrl, "_blank"); } }, "重新打开登录页")));
				} else {
					// 令牌在但 refresh 已不可用/已实败：signedIn 的字面状态不再误导，
					// 明说"需重新登录"（此时聊天会因凭据不可用全 503）。
					if (oauth.needsRelogin) {
						parts.push(createElement("p", { key: "relogin", className: "cbc-warn" },
							"登录已失效（刷新令牌过期或被拒绝），当前对话会报凭据不可用——请重新登录。"));
					}
					parts.push(createElement("div", { key: "start", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "primary", disabled: oauthBusy, onClick: function () {
							startOAuthFlow(post, "oauth-start", setOauthBusy, setErr, reload);
						} }, oauthBusy ? "发起中…" : (oauth.needsRelogin ? "重新登录 CodeBuddy 账号" : "登录 CodeBuddy 账号"))));
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
						confirmAct === k.name
							? createElement(CbcButton, { variant: "outline", danger: true, onClick: function () {
								clearConfirm();
								post({ patch: { apiKeysRemove: k.name } }).then(reload).catch(function (e) { setErr(e && e.message ? e.message : "删除失败（网络）"); });
							} }, "确认删除")
							: createElement(CbcButton, { variant: "ghost", danger: true, onClick: function () { askConfirm(k.name); } }, "删除"));
				});
				body = rows.concat([
					createElement("div", { key: "add", className: "cbc-addrow" },
						createElement(CbcInput, { widthClass: "cbc-w140", placeholder: "名称（如 工作）", value: addName, onInput: function (e) { setAddName(e.target.value); } }),
						createElement(CbcInput, { widthClass: "cbc-w260", placeholder: "ck_…", type: "password", autoComplete: "off", value: addKey, onInput: function (e) { setAddKey(e.target.value); } }),
						createElement(CbcButton, { variant: "outline", onClick: function () {
							var name = addName.trim();
							var key = addKey.trim();
							if (!name || !key) { setErr("名称和 Key 都不能为空"); return; }
							post({ patch: { apiKeysAdd: { name: name, key: key } } }).then(function (res) {
								if (res.ok) { setAddName(""); setAddKey(""); reload(); }
								else setErr(res.d && res.d.error ? res.d.error : "添加失败");
							}).catch(function (e) { setErr(e && e.message ? e.message : "添加失败（网络）"); });
						} }, "添加")),
					createElement("div", { key: "env", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "环境变量引用"),
						createElement("div", { className: "cbc-row-control" },
							createElement(TextField, { fieldKey: "apiKeyEnv", value: value.apiKeyEnv, save: save, widthClass: "cbc-w220", overridden: props.overridden("apiKeyEnv") }))),
					createElement("div", { key: "cooldown", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "失败冷却 (ms)"),
						createElement("div", { className: "cbc-row-control" },
							createElement(NumberField, { fieldKey: "keyCooldownMs", value: value.keyCooldownMs, save: save, overridden: props.overridden("keyCooldownMs") }))),
					createElement(HelpNote, { key: "hint" }, "多把 Key 时逐请求轮询；遇 401/403/429/5xx 或网络错误自动换下一把，失败 Key 冷却指定毫秒后自动回到轮换。单选仅决定模型目录拉取用的 Key；一个都不选时回落到环境变量引用（进程环境或 ~/.dsh/.credentials.yaml 中的同名条目）。"),
				]);
			}

			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "凭据"),
				modeRow, body,
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "凭据验证"),
					createElement("div", { className: "cbc-row-control" },
						createElement(CbcButton, { variant: "ghost", disabled: !!(cbTest && cbTest.busy), onClick: testCredential },
							cbTest && cbTest.busy ? "验证中…" : "测一下"),
						cbTest && !cbTest.busy
							? createElement("span", { className: cbTest.ok ? "cbc-status" : "cbc-warn", "data-test": "codebuddy" }, cbTest.text)
							: null,
						createElement("span", { className: "cbc-muted" }, "目录面 GET /v3/config，零额度消耗"))));
		}
		SECTION_RENDERERS.login = LoginSection;

		// --- 额度与用量：桥计量的消耗 + 账户侧额度（登录之后） ----------------------
		// 消耗量来自桥对每请求 usage.credit 的计量（精确，本插件路径）；剩余额度在
		// OAuth 模式显示真实数值（/billing/meter/get-user-resource，R-Q7），
		// api-key 模式该 API 为 OAuth 专享（401）→ 手填总额度的估算档（标注"估算"）。
		// 轮询只在分区可见（active）时跑；资源包按名称聚合，明细可展开。
		function UsageSection(props) {
			var post = props.post;
			var value = props.value || {};
			var active = props.active === true; // 严格随「通用」区块展开：未展开/缺省一律不轮询（sectionProps.usage.active = !!openBlocks.general）
			var dataState = useState(null); // {usage, bridge, quota}
			var usageData = dataState[0];
			var setUsageData = dataState[1];
			var failState = useState("");
			var fail = failState[0];
			var setFail = failState[1];
			var expandPacksState = useState(false);
			var expandPacks = expandPacksState[0];
			var setExpandPacks = expandPacksState[1];
			var updState = useState(0);
			var lastUpd = updState[0];
			var setLastUpd = updState[1];

			// 实时 = 通用区块展开期间 10s 轮询；收起即停（隐藏不卸载，但不可见的轮询是浪费）。
			// pull 提到组件级并经 ref 持有：手动刷新按钮共用同一入口，
			// interval 永远调最新闭包（props.post 每渲染换新）。
			var pullRef = useRef(null);
			pullRef.current = function () {
				post({ action: "usage" }).then(function (res) {
					if (res.ok) { setUsageData(res.d); setFail(""); setLastUpd(Date.now()); }
					else setFail(res.d && res.d.error ? res.d.error : "用量读取失败");
				}).catch(function (e) { setFail(e && e.message ? e.message : "用量读取失败（网络）"); });
			};
			useEffect(function () {
				if (!active) return undefined;
				pullRef.current();
				var timer = setInterval(function () { pullRef.current(); }, 10000);
				return function () { clearInterval(timer); };
			}, [active]);

			var KIND_LABEL = { chat: "对话", title: "标题", compaction: "压缩", image: "生图", search: "搜索", fetch: "抓取" };
			var usage = usageData && usageData.usage || null;
			var bridge = usageData && usageData.bridge || null;
			var quota = usageData && usageData.quota || null;

			var rows = [];

			// 更新时间戳 + 手动刷新（原先只有隐形 10s 轮询，数据新旧无从判断）。
			rows.push(createElement("div", { key: "upd", className: "cbc-row" },
				createElement("div", { className: "cbc-row-label" }, "实时用量"),
				createElement("div", { className: "cbc-row-control" },
					createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, onClick: function () { pullRef.current(); } }, "刷新"),
					createElement("span", { className: "cbc-updated" }, lastUpd ? "更新于 " + fmtClock(lastUpd) + " · 通用区块展开时每 10 秒自动刷新" : "正在读取…"))));

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
						rows.push(createElement("div", { key: "pkh", className: "cbc-subtitle" },
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
				rows.push(createElement(HelpNote, { key: "qlink" },
					createElement("p", { className: "cbc-hint" },
						"api-key 模式网关不开放数值额度 API（OAuth 专享，实测 401）；上方为「手填总额 − 本插件计量累计」的估算值，准确余额见 ",
						createElement("a", { className: "cbc-link", href: "https://www.codebuddy.cn/profile/plan", target: "_blank", rel: "noreferrer" }, "codebuddy.cn 套餐页"),
						" 或切到 OAuth 登录。额度为账户级，与 WorkBuddy 共用。")));
			} else if (quota && quota.numericQuota) {
				rows.push(createElement(HelpNote, { key: "qlink" },
					createElement("p", { className: "cbc-hint" },
						"数值来自 /billing/meter/get-user-resource（账户级，与 WorkBuddy 共用），每分钟缓存；准确口径以 ",
						createElement("a", { className: "cbc-link", href: "https://www.codebuddy.cn/profile/plan", target: "_blank", rel: "noreferrer" }, "codebuddy.cn 套餐页"),
						" 为准。")));
			}

			// 消耗统计（本插件路径实测）：今日 / 累计两张统计卡。
			if (usage) {
				rows.push(createElement("div", { key: "totals", className: "cbc-stats" },
					createElement("div", { className: "cbc-stat" },
						createElement("div", { className: "cbc-statlabel" }, "今日消耗"),
						createElement("div", { className: "cbc-statnum" }, fmtCredit(usage.today.credit) + " credit"),
						createElement("div", { className: "cbc-muted" }, fmtNum(usage.today.requests) + " 请求")),
					createElement("div", { className: "cbc-stat" },
						createElement("div", { className: "cbc-statlabel" }, "累计消耗"),
						createElement("div", { className: "cbc-statnum" }, fmtCredit(usage.totalCredit) + " credit"),
						createElement("div", { className: "cbc-muted" }, fmtNum(usage.totalRequests) + " 请求 · 自 " + fmtTime(usage.since)))));
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
				rows.push(createElement("p", { key: "th", className: "cbc-subtitle" }, "最近轮次（按间隔聚类，近似）"));
				usage.turns.forEach(function (t, i) {
					var kinds = t.kinds.map(function (k) { return KIND_LABEL[k] || k; }).join("+");
					rows.push(createElement("div", { key: "t" + i, className: "cbc-listrow" },
						createElement("span", { className: "cbc-model-ctx" }, fmtTime(t.start)),
						createElement("span", { className: "cbc-cell-name" }, fmtCredit(t.credit)),
						createElement("span", { className: "cbc-effort", title: "缓存命中 " + (t.hit || 0) + " / 未命中 " + (t.miss || 0) + "（命中率 = 命中 / 总和）" }, "入 " + fmtNum(t.prompt) + " · 命中 " + fmtHit(t.hit, t.miss) + " · 出 " + fmtNum(t.completion || 0)),
						createElement("span", { className: "cbc-effort" }, fmtNum(t.requests) + " 请求"),
						createElement("span", { className: "cbc-cell-masked" }, kinds + (t.models.length ? " · " + t.models.join("/") : ""))));
				});
			} else if (usage) {
				rows.push(createElement("p", { key: "empty", className: "cbc-hint" }, "还没有经过桥的计费请求。消耗数据来自流式桥与搜索/抓取/生图路径的网关 usage 自报。"));
			}
			if (fail) rows.push(createElement("p", { key: "fail", className: "cbc-error" }, fail));
			if (!usageData && !fail) rows.push(createElement("p", { key: "loading", className: "cbc-status" }, "正在读取用量…"));

			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "额度与用量"),
				rows);
		}
		SECTION_RENDERERS.usage = UsageSection;

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

		// 三家模型列表共用的筛选谓词：按 id / name 子串匹配（大小写不敏感）。
		function matchesModelFilter(item, filterText) {
			var needle = String(filterText == null ? "" : filterText).trim().toLowerCase();
			if (!needle) return true;
			return String(item.id == null ? "" : item.id).toLowerCase().indexOf(needle) >= 0
				|| (item.name && String(item.name).toLowerCase().indexOf(needle) >= 0);
		}

		// --- 模型：网关目录同步 + 逐模型启停（同步到对话选择器） ------------------
		// G4：清单默认跟 /v3/config 走（启动自动同步 + 这里的手动刷新），
		// 静态清单只做离线兜底；勾选语义 = 在不在对话选择器里（effectiveIds）。
		function ModelsSection(props) {
			var post = props.post;
			var setErr = props.setErr;
			var reload = props.reload;
			var modelsInfo = props.modelsInfo || {};
			// G8：逐模型思考强度（effortByModel 存文件层；桥出站按档位表注入
			// reasoning_effort）。静态行有档位表才出 select；off 不出现在选项里
			// （其线值是 null = 省略参数，与"默认"等价）。
			var effortMap = (props.value && props.value.effortByModel) || {};
			var saveEffort = function (id, level) {
				if (!props.save) return;
				var next = Object.assign({}, effortMap);
				if (level) next[id] = level; else delete next[id];
				props.save({ effortByModel: next });
			};
			var dataState = useState(null); // {catalog, staticIds, state, effectiveIds, ...}
			var data = dataState[0];
			var setData = dataState[1];
			var syncBusyState = useState(false);
			var syncBusy = syncBusyState[0];
			var setSyncBusy = syncBusyState[1];
			var filterState = useState("");
			var filter = filterState[0];
			var setFilter = filterState[1];

			var fetchList = function () {
				post({ action: "model-list" }).then(function (res) {
					if (res.ok) setData(res.d);
					else setErr(res.d && res.d.error ? res.d.error : "获取失败");
				}).catch(function (e) { setErr(e && e.message ? e.message : "获取失败（网络）"); });
			};
			// 首次挂载即拉取（标签页懒挂载保证此时才发生），不用先找按钮。
			useEffect(function () { fetchList(); }, []);

			// G4 手动刷新：重拉 /v3/config 并重铺 settings.yaml 镜像（选择器即时刷新）。
			// 「同步目录」= 一次点按做两件事：拉网关目录并铺镜像（model-sync）、
			// 刷新管理列表（model-list）。原先是两个按钮，语义重叠、用户要判断点哪个。
			// 「同步目录」按钮的忙碌态用独立的 syncBusy。
			var syncNow = function () {
				setSyncBusy(true);
				post({ action: "model-sync" }).then(function (res) {
					if (!res.ok) { setSyncBusy(false); setErr(res.d && res.d.error ? res.d.error : "同步失败"); return; }
					if (res.d.sync && res.d.sync.ok === false) setErr("目录同步失败（已" + (res.d.sync.kept ? "保留上次清单" : "回落静态清单") + "）：" + res.d.sync.error);
					reload();   // modelsInfo.sync / effectiveCount 刷新
					// 目录同步失败也要刷新管理列表——两侧原因分别可见，不互相掩盖。
					return post({ action: "model-list" }).then(function (r2) {
						setSyncBusy(false);
						if (r2.ok) setData(r2.d);
						else setErr(r2.d && r2.d.error ? r2.d.error : "获取失败");
					});
				}).catch(function (e) { setSyncBusy(false); setErr(e && e.message ? e.message : "同步失败（网络）"); });
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
					// 失败回滚同值去重表——否则该模型同向操作被永久吞掉（踩坑 #27 去重的配套纪律）。
					if (!res.ok) { delete lastSentRef.current[m.id]; setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					if (res.d.models) {
						// settingsView ships disabled/extraIds as arrays; turn
						// them into lookup maps and keep the fetched catalog.
						var dis = {}; (res.d.models.disabled || []).forEach(function (id) { dis[id] = true; });
						var ext = {}; (res.d.models.extraIds || []).forEach(function (id) { ext[id] = true; });
						setData(function (prev) {
							// G4：勾选状态跟随服务端选择器真值 effectiveIds
							// （动态目录模型默认在选择器里，不在 extra 里）。
							return prev ? { catalog: prev.catalog, staticIds: prev.staticIds, efforts: prev.efforts, staticEfforts: prev.staticEfforts, profiles: prev.profiles, ceilings: prev.ceilings, effectiveIds: res.d.models.effectiveIds || prev.effectiveIds, state: { disabled: dis, extra: ext, overrides: res.d.models.overrides || {} } } : prev;
						});
					}
					reload(); // 状态条/徽标的可用模型数随 effectiveCount 刷新
				}).catch(function (e) { delete lastSentRef.current[m.id]; setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
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
				// P2-4：已知不可路由（目录在列但 /v2 恒 11102）条目表 id→原因，服务端事实源。
				var unroutable = data.unroutable || {};
				var needle = filter.trim().toLowerCase();
				var seen = {};
				var enabledRows = [];
				var inactiveRows = [];
				var makeRow = function (m, fromCatalog) {
					if (seen[m.id]) return;
					seen[m.id] = true;
					if (!matchesModelFilter(m, filter)) return;
					var isStatic = staticIds.indexOf(m.id) >= 0;
					var enabled = effectiveIds.indexOf(m.id) >= 0;
					// P2-4：已知不可路由条目置灰 + 原因徽标；勾选框只在「未启用」时禁用
					// （不能把已知死模型加进选择器），已启用的保留可勾掉（出清通道）。
					var deadReason = unroutable[m.id] || null;
					// 思考档位：档位表来自服务端 `efforts`（静态 reasoningEfforts ∪
					// 目录声明的 supportedEfforts，2026-09-22 起目录也发能力清单）。
					// G8：有档位表就出 select 直接设档（存 effortByModel，桥出站注入
					// reasoning_effort）；"关"只在它是真开关（线值非空）时出现，
					// 否则 off ≡ 省略参数 ≡ 默认态，不出选项。
					var effortText = null;
					var effortSel = null;
					var tiers = ((data.efforts || {})[m.id] || []).slice();
					if (tiers.length) {
						effortSel = createElement("select", {
							className: "cbc-select cbc-effort-sel",
							title: "思考强度：桥出站对该模型注入 reasoning_effort（默认 = 不注入）",
							value: effortMap[m.id] || "",
							onChange: function (e) { saveEffort(m.id, e.target.value); },
						},
							createElement("option", { value: "" }, "思考:默认"),
							tiers.map(function (t) {
								return createElement("option", { key: t, value: t }, "思考:" + (t === "off" ? "关" : t));
							}));
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
					var row = createElement("div", { key: m.id, className: "cbc-listrow" + (deadReason ? " cbc-unroutable" : "") },
						createElement("input", {
							type: "checkbox", className: "cbc-check", checked: enabled,
							disabled: deadReason && !enabled ? true : undefined,
							title: deadReason
								? deadReason + (enabled ? "——建议勾掉移出选择器" : "——不可加入选择器")
								: enabled ? "从对话选择器移除" : "加入对话选择器",
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
						deadReason ? createElement("span", { className: "cbc-badge cbc-badge-dead", title: deadReason }, "不可路由") : null,
						m.cli ? createElement("span", { className: "cbc-badge" }, "CLI") : null,
						m.images ? createElement("span", { className: "cbc-badge" }, "图") : null,
						effortSel
							? effortSel
							: effortText
								? createElement("span", { className: "cbc-effort", title: "目录标注的思考强度" }, effortText)
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
					createElement("div", { className: "cbc-scrollbox", style: { maxHeight: 400 } },
						createElement("p", { className: "cbc-subtitle" }, needle
							? "筛选命中 " + (enabledRows.length + inactiveRows.length) + "（可用 " + enabledRows.length + " / 未启用 " + inactiveRows.length + "）"
							: "当前可用（" + enabledRows.length + "）"),
						enabledRows.length ? enabledRows : createElement("p", { className: "cbc-muted" }, "无匹配模型"),
						inactiveRows.length
							? createElement("p", { className: "cbc-subtitle" }, "未启用（" + inactiveRows.length + "）")
							: null,
						inactiveRows),
					createElement("p", { className: "cbc-status" },
						// P2-4 口径透明：「目录 N · 可路由 M」（M = N − 已知恒 11102 在列条目）。
						"目录 " + (data.catalog.models || []).length + " 个 · 可路由 "
							+ (data.catalog.models || []).filter(function (m) { return !unroutable[m.id]; }).length + " 个"
							+ "（按当前登录凭据获取）；勾选即同步到对话模型选择器，下次请求生效。"));
			}

			var syncInfo = modelsInfo.sync;
			// P2-4：「目录 N · 可路由 M」（routable 由服务端按已知恒 11102 表算出；
			// 老服务端无该字段时不显示 M，不编造）。
			var syncText = syncInfo
				? "上次同步 " + fmtTime(syncInfo.at) + " · 网关目录 " + syncInfo.count + " 个"
					+ (syncInfo.routable != null ? " · 可路由 " + syncInfo.routable + " 个" : "")
					+ "（选择器跟随网关）"
				: "静态清单兜底（启动与手动同步均未取到网关目录）";
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "模型"),
				// 操作条（三家同构）：同步按钮 + 状态文字 + 筛选框同一行，
				// 不再各占一个带标签的行。
				createElement(SyncBar, { busy: syncBusy, onSync: syncNow, info: syncText, filter: filter, onFilter: setFilter }),
				body,
				createElement(HelpNote, null, "启动时自动同步网关目录（/v3/config）并入对话选择器，此处可手动再同步；勾选控制每个模型是否出现在选择器，ctx/输出上限可直接改（清空恢复目录默认），均写入宿主配置层（dsh 0.1.7+ 落 profile 的 cordis.patch.yml，更早版本落 ~/.dsh/settings.yaml 的 llm-pi-ai 覆盖层），下次请求生效。"));
		}
		SECTION_RENDERERS.models = ModelsSection;

		// --- 工具：网络搜索与抓取 + 图像生成（都是 dsh 工具缝的注册开关） ---------
		function ToolsSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "工具"),
				createElement("p", { className: "cbc-hint" }, "网络搜索与抓取"),
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
				createElement("p", { className: "cbc-hint" }, "图像生成"),
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
				createElement(HelpNote, null, "经 dsh 工具缝注册 image_generate（/v2/images/generations，约 20s/张，目录标注 x5 credits）；图片保存到会话工作区 generated-images/（无工作区信息时落 ~/.dsh/generated-images/）。"));
		}
		SECTION_RENDERERS.tools = ToolsSection;

		// --- 服务商（G6：key 型 OpenAI 兼容上游注册表） ------------------------------
		// preset（ark/百炼/DeepSeek/智谱/Moonshot/OpenRouter/qwen）或自定义：
		// 添加 = 实测验 key（有目录走 GET /models，无目录/公开目录走 chat 探针）→ 写
		// settings.yaml provider 块 + .credentials.yaml（<ID>_API_KEY，0600），
		// 模型进选择器免重启；删除连凭据一起清。key 只回脱敏值。
		function ProvidersSection(props) {
			var post = props.post;
			var setErr = props.setErr;
			var dataState = useState(null); // {providers, presets}
			var data = dataState[0];
			var setData = dataState[1];
			// 单 flight 行级进度：'add' 或 provider id——谁忙谁的按钮变进度文案。
			var busyState = useState(null);
			var busyId = busyState[0];
			var setBusyId = busyState[1];
			// 操作成功的行内反馈（失败走全局横幅，踩坑 #7）。
			var noticeState = useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			// 删除连同凭据一起清、不可逆——第一次点击只进确认态（4 秒不确认自动复位）。
			var confirmDelState = useState(null);
			var confirmDelId = confirmDelState[0];
			var setConfirmDelId = confirmDelState[1];
			var confirmTimerRef = useRef(null);
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
				}).catch(function (e) { setErr(e && e.message ? e.message : "获取失败（网络）"); });
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
				var newId = body.preset || body.id;
				setBusyId("add");
				post(body).then(function (res) {
					setBusyId(null);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "添加失败"); return; }
					var list = res.d.providers || [];
					mergeProviders(list);
					setAddKey(""); setAddId(""); setAddBase("");
					var added = list.find(function (p) { return p.id === newId; });
					setNotice(added ? ("已添加 " + added.displayName + "（" + added.modelCount + " 个模型）") : ("已添加 " + newId));
				}).catch(function (e) { setBusyId(null); setErr("添加失败：" + (e && e.message ? e.message : String(e))); });
			};

			var askRemove = function (id) {
				if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
				setConfirmDelId(id);
				confirmTimerRef.current = setTimeout(function () { setConfirmDelId(null); }, 4000);
			};

			var removeUpstream = function (id) {
				if (confirmTimerRef.current) { clearTimeout(confirmTimerRef.current); confirmTimerRef.current = null; }
				setConfirmDelId(null);
				setBusyId(id);
				post({ action: "provider-remove", id: id }).then(function (res) {
					setBusyId(null);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "删除失败"); return; }
					mergeProviders(res.d.providers || []);
					setNotice("已删除 " + id + "（连同凭据）");
				}).catch(function (e) { setBusyId(null); setErr("删除失败：" + (e && e.message ? e.message : String(e))); });
			};

			var refreshUpstream = function (id) {
				setBusyId(id);
				post({ action: "provider-refresh", id: id }).then(function (res) {
					setBusyId(null);
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "刷新失败"); return; }
					var list = res.d.providers || [];
					mergeProviders(list);
					var p = list.find(function (x) { return x.id === id; });
					setNotice(p ? ("已刷新 " + id + "：" + p.modelCount + " 个模型") : ("已刷新 " + id));
				}).catch(function (e) { setBusyId(null); setErr("刷新失败：" + (e && e.message ? e.message : String(e))); });
			};

			// P2-5「测一下」：只读验证（/models 或聊天探针），不写 provider 块；
			// 结果就地落在行内（testResults[id]），不进全局横幅。
			var testResultsState = useState({});
			var testResults = testResultsState[0];
			var setTestResults = testResultsState[1];
			var testUpstream = function (id) {
				setBusyId(id);
				setTestResults(function (prev) { var n = Object.assign({}, prev); delete n[id]; return n; });
				post({ action: "provider-test", id: id }).then(function (res) {
					setBusyId(null);
					var cell = res.ok && res.d.available
						? { ok: true, text: "✓ 可用（" + (res.d.detail || "验证通过") + "）" }
						: { ok: false, text: "✗ " + ((res.d && res.d.error) || ("HTTP " + res.status)) };
					setTestResults(function (prev) { var n = Object.assign({}, prev); n[id] = cell; return n; });
				}).catch(function (e) {
					setBusyId(null);
					var cell = { ok: false, text: "✗ " + (e && e.message ? e.message : "网络错误") };
					setTestResults(function (prev) { var n = Object.assign({}, prev); n[id] = cell; return n; });
				});
			};

			var providers = (data && data.providers) || [];
			var presets = (data && data.presets) || [];
			var isCustom = presetSel === "custom";
			// 本机凭据行只渲染可导入项：不可导入命中（登录态在 keyring、方言未接入等）
			// 没有任何可执行操作，罗列即噪音。扫描器/路由保留，将来新增可导入源自动出现。
			var importableFindings = findings ? findings.filter(function (f) { return f.importable; }) : findings;

			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "服务商"),
				(importableFindings && importableFindings.length)
					? createElement("div", { className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "本机凭据"),
						createElement("div", { className: "cbc-row-control" },
							importableFindings.map(function (f) {
								var already = f.detail && f.detail.import && providers.some(function (p) { return p.id === f.detail.import.id; });
								var kids = [f.label + "（" + (f.kind === "apikey" ? "API Key" : f.kind === "oauth" ? "OAuth" : "未知") + "）"];
								if (!already) kids.push(createElement(CbcButton, { key: "go", variant: "ghost", disabled: importBusy !== null, onClick: function () { importSource(f.source); } }, importBusy === f.source ? "导入中…" : "一键导入"));
								if (already) kids.push(createElement("span", { key: "done", className: "cbc-badge" }, "已导入"));
								if (!already && f.detail && f.detail.expiredHint) kids.push(createElement("span", { key: "exp", className: "cbc-muted" }, "令牌疑似过期，导入时实测"));
								return createElement("span", { key: f.source, title: f.path, style: { display: "inline-flex", alignItems: "center", gap: 6 } }, kids);
							})))
					: null,
				providers.map(function (p) {
					var tr = testResults[p.id];
					return createElement("div", { key: p.id, className: "cbc-listrow" },
						createElement("span", { className: "cbc-cell-name", title: p.baseURL }, p.displayName),
						createElement("span", { className: "cbc-muted" }, p.id + " · " + p.modelCount + " 模型"),
						createElement("span", { className: "cbc-muted", title: "凭据引用 " + p.keyRef }, p.maskedKey || "无凭据"),
						createElement(CbcButton, { variant: "ghost", disabled: busyId !== null, onClick: function () { testUpstream(p.id); } },
							busyId === p.id ? "验证中…" : "测一下"),
						createElement(CbcButton, { variant: "ghost", disabled: busyId !== null, onClick: function () { refreshUpstream(p.id); } }, busyId === p.id ? "刷新中…" : "刷新模型"),
						confirmDelId === p.id
							? createElement(CbcButton, { variant: "outline", danger: true, disabled: busyId !== null, onClick: function () { removeUpstream(p.id); } }, busyId === p.id ? "删除中…" : "确认删除")
							: createElement(CbcButton, { variant: "ghost", danger: true, disabled: busyId !== null, onClick: function () { askRemove(p.id); } }, "删除"),
						tr ? createElement("span", { className: tr.ok ? "cbc-status" : "cbc-warn", "data-test": p.id }, tr.text) : null);
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
						createElement(CbcInput, { widthClass: "cbc-w200", placeholder: "API Key", type: "password", autoComplete: "off", value: addKey, onInput: function (e) { setAddKey(e.target.value); } }),
						createElement(CbcButton, { variant: "outline", disabled: busyId !== null, onClick: addUpstream }, busyId === "add" ? "验证中…" : "测试并添加"))),
				notice ? createElement("p", { className: "cbc-status" }, notice) : null,
				!providers.length ? createElement("p", { className: "cbc-muted" }, "还没有注册上游；从下拉选预设或自定义添加。") : null,
				createElement(HelpNote, null, "key 型 OpenAI 兼容上游：添加时实测验证 key（有目录的拉 GET /models，无目录/公开目录的走聊天探针）并把模型写进选择器（免重启）；key 落 ~/.dsh/.credentials.yaml（<ID>_API_KEY，0600），只回脱敏值；删除连同凭据一起清。"));
		}
		SECTION_RENDERERS.providers = ProvidersSection;

		// --- 宿主实况（P1-1，只读对账）：期望 = 插件镜像纪律，实际 = 宿主配置层
		// 合成结果（hostConfig 读出）。漂移 = 上游改模块名 patch 条目被整条跳过
		// （踩坑 #43/#49，退出码仍 0）这类静默失效在卡上的唯一可见出口。
		// 数据全部来自 GET 视图的 host 字段，本分区不发任何请求。
		function HostReconSection(props) {
			var host = props.host;
			if (!host) {
				return createElement("div", { className: "cbc-section" },
					createElement("p", { className: "cbc-group-title" }, "宿主实况"),
					createElement("p", { className: "cbc-muted" }, "对账数据不可用（旧版视图无 host 字段）。"));
			}
			var chanRow = function (label, ch) {
				if (!ch) return null;
				var drifted = host.drift && host.drift.some(function (d) { return d && d.channel === label.key; });
				var text;
				if (ch.expected == null && ch.actual == null) text = "无镜像（符合预期）";
				else text = "期望 " + (ch.expected == null ? "无镜像" : ch.expected + " 模型") +
					" · 实际 " + (ch.actual == null ? "无镜像" : ch.actual + " 模型") +
					(ch.inferred ? "（推断自静态基线）" : "");
				return createElement("div", { className: "cbc-row", key: label.key, "data-recon": label.key },
					createElement("div", { className: "cbc-row-label" }, label.name),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: drifted ? "cbc-warn" : "cbc-status", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							createElement(Dot, { tone: drifted ? "warn" : "ok" }), text)));
			};
			var missing = host.missingEntries;
			var entriesText = missing == null
				? "—（当前宿主无 describe 可查）"
				: missing.length === 0
					? "在位"
					: "缺失：" + missing.join("、");
			var webPin = host.webPin || null;
			var webPinText = webPin == null
				? null
				: webPin.ok
					? "web 钉选在位（search/fetch → codebuddy）"
					: "web 钉选漂移：searchProvider=" + (webPin.searchProvider || "（无）") + " · fetchProvider=" + (webPin.fetchProvider || "（无）");
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "宿主实况"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "配置层"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: "cbc-status" },
							host.mode === "forms" ? "forms（profile patch）" : "legacy（settings.yaml）",
							host.servicePresent ? "" : " · settings 服务不在位"))),
				chanRow({ key: "codebuddy", name: "CodeBuddy 模型镜像" }, host.channels && host.channels.codebuddy),
				chanRow({ key: "trae", name: "Trae 路由镜像" }, host.channels && host.channels.trae),
				chanRow({ key: "qoder", name: "Qoder 路由镜像" }, host.channels && host.channels.qoder),
				createElement("div", { className: "cbc-row", "data-recon": "entries" },
					createElement("div", { className: "cbc-row-label" }, "patch 条目"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: (missing && missing.length) ? "cbc-warn" : "cbc-status", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							missing == null ? null : createElement(Dot, { tone: missing.length ? "warn" : "ok" }), entriesText))),
				webPinText == null ? null : createElement("div", { className: "cbc-row", "data-recon": "webpin" },
					createElement("div", { className: "cbc-row-label" }, "web 钉选"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: webPin.ok ? "cbc-status" : "cbc-warn", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							createElement(Dot, { tone: webPin.ok ? "ok" : "warn" }), webPinText))),
				createElement(HelpNote, null, "只读对账：左侧是插件应铺的镜像（模型数/路由存在性），右侧是宿主配置层实际加载值；不一致即漂移（区块头出现「宿主漂移」warn）。patch 条目行的口径 = settings 命名空间（llm-pi-ai、agent-default-model；web 钉选不是 settings 条目，单独一行直查 web 服务的实际钉选值）。离线权威映射（entry id → 模块名）用 dsh --dump-config 的 bundle 清单段核对——上游改模块名会让 profile patch 条目被整条跳过且退出码仍为 0（踩坑 #49）。"));
		}
		SECTION_RENDERERS.hostrecon = HostReconSection;

		// --- Trae/Qoder（+模型区）同构行组件 --------------------------------------
		// 模块级定义：组件身份随渲染位置变化会丢焦点（与下方字段控件同纪律）。
		// 三者只做形状收敛，DOM 树与抽取前逐字节同形——套件按 .cbc-* 结构断言，
		// 形状即契约。

		// 模型组操作条（三家同构）：同步按钮 + 状态文字 + 过滤框同一行。
		// info 由调用方拼好（CodeBuddy 是「上次同步…」长文案，Trae/Qoder 追加
		// 「（通道未启用）」），组件不掺和口径。
		function SyncBar(props) {
			return createElement("div", { className: "cbc-syncbar" },
				createElement(CbcButton, {
					variant: "outline",
					icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined,
					disabled: props.busy,
					onClick: props.onSync,
				}, props.busy ? "同步中…" : "同步目录"),
				createElement("span", { className: "cbc-muted" }, props.info),
				createElement(CbcInput, {
					widthClass: "cbc-w220", placeholder: "输入 id 关键字过滤模型…",
					value: props.filter, onInput: function (e) { props.onFilter(e.target.value); },
				}));
		}

		// 通道模型行外壳（Trae/Qoder 同构）：checkbox + id + 显示名 + ctx 徽标。
		// Qoder 的思考强度/上下文 select 走 extra（Fragment 不产生 DOM 包装）。
		function SubModelRow(props) {
			return createElement("div", { className: "cbc-listrow" },
				createElement("input", {
					type: "checkbox", className: "cbc-check", checked: props.enabled,
					title: props.enabled ? props.titleOff : props.titleOn,
					onChange: props.onToggle,
				}),
				createElement("span", { className: "cbc-tname", title: props.id }, props.id),
				createElement("span", { className: "cbc-muted" }, props.name && props.name !== props.id ? props.name : ""),
				createElement("span", { className: "cbc-model-ctx" },
					props.ctx != null ? "ctx " + props.ctx : "",
					props.image ? " · 图" : ""),
				props.extra || null);
		}

		// 通道登录行外壳（Trae/Qoder 同构）：标签 + 主按钮 + Dot 状态文本。
		// Qoder 的重开登录页/测一下/测一下结果走 extra。
		function ChannelLoginRow(props) {
			return createElement("div", { className: "cbc-row" },
				createElement("div", { className: "cbc-row-label" }, props.label),
				createElement("div", { className: "cbc-row-control" },
					props.button,
					createElement("span", {
						className: props.status.tone === "warn" ? "cbc-warn" : "cbc-status",
						style: { display: "inline-flex", alignItems: "center", gap: 6 },
					},
						createElement(Dot, { tone: props.status.tone }), props.status.text),
					props.extra || null));
		}

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
			var tmodels = trae.models || {};

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			// 退出登录二次确认（同 ProvidersSection 模式）：第一次点击进确认态
			//（按钮变"确认退出"），4 秒不确认自动复位。
			var tLogoutConfirmState = useState(false);
			var tLogoutConfirm = tLogoutConfirmState[0];
			var setTLogoutConfirm = tLogoutConfirmState[1];
			var tLogoutTimerRef = useRef(null);
			var askTLogout = function () {
				if (tLogoutTimerRef.current) clearTimeout(tLogoutTimerRef.current);
				setTLogoutConfirm(true);
				tLogoutTimerRef.current = setTimeout(function () { setTLogoutConfirm(false); }, 4000);
			};
			var doTLogout = function () {
				if (tLogoutTimerRef.current) { clearTimeout(tLogoutTimerRef.current); tLogoutTimerRef.current = null; }
				setTLogoutConfirm(false);
				post({ action: "trae-oauth-logout" }).then(reload).catch(function (e) { setErr(e && e.message ? e.message : "退出失败（网络）"); });
			};
			var listState = useState(null); // {profiles, disabled:{id:true}} 来自 trae-model-list
			var tlist = listState[0];
			var setTlist = listState[1];
			// 模型筛选（与 CodeBuddy 模型组同款）：只过滤渲染，不发请求。
			var tfilterState = useState("");
			var tfilter = tfilterState[0];
			var setTfilter = tfilterState[1];

			var fetchTlist = function () {
				post({ action: "trae-model-list" }).then(function (res) {
					if (!res.ok) return;
					var disabled = {};
					(res.d.disabled || []).forEach(function (id) { disabled[id] = true; });
					setTlist({ profiles: (res.d.view && res.d.view.profiles) || [], disabled: disabled });
				}).catch(function (e) {
					// 拉取失败必须带原因（踩坑 #7，终审 Minor）：原先的空 catch 是全文件唯一
					// 真吞错——"请求失败"与"目录本来是空的"在 UI 上不可区分。走本分区已有的
					// 错误出口（setErr = 卡片顶部横幅）。注意 `!res.ok`（目录未同步等**已知**
					// 空态）在上面正常 return、分组不显示，不进这里 ⇒ 两种态仍可辨。
					setErr("Trae 模型目录读取失败：" + (e && e.message ? e.message : "（网络）"));
				});
			};
			useEffect(function () { fetchTlist(); }, []);
			// 开启通道或目录同步完成（sync.at 变化）后重拉启停清单——挂载时拉到的
			// 空结果（目录尚未同步）必须被替换，否则用户开启后看不到启停组。
			var traeSyncAt = tmodels.sync && tmodels.sync.at;
			var traeOn = value.traeEnabled === true;
			useEffect(function () { fetchTlist(); }, [traeSyncAt, traeOn]);

			var startLogin = function () { startOAuthFlow(post, "trae-oauth-start", setBusy, setErr, reload); };
			// P1-2 余额行（双额度池，只读）：展开/收起两个边界各采一次 + 登录态翻转
			// 时重采，不周期轮询；服务端 60s memoize 控成本。取不到一律「—（原因）」，
			// 绝不编造数值；未登录不发请求。
			var active = props.active === true;
			var quotaState = useState(null);
			var quota = quotaState[0];
			var setQuota = quotaState[1];
			var quotaGenRef = useRef(0);
			var fetchQuota = function () {
				if (!toauth.signedIn) { setQuota({ error: "未登录" }); return; }
				var my = ++quotaGenRef.current;
				post({ action: "trae-quota" }).then(function (res) {
					if (my !== quotaGenRef.current) return;
					setQuota(res.ok && res.d && res.d.quota ? res.d.quota : { error: (res.d && res.d.error) || ("HTTP " + res.status) });
				}).catch(function (e) {
					if (my !== quotaGenRef.current) return;
					setQuota({ error: e && e.message ? e.message : "（网络）" });
				});
			};
			useEffect(function () { fetchQuota(); }, [active, toauth.signedIn]);
			var balanceText = !quota ? "读取中…"
				: quota.error ? "—（" + quota.error + "）"
					: quota.pools
						? "IDE 池 余 " + fmtCredit(quota.pools.ide.remain) + " / " + fmtCredit(quota.pools.ide.limit) +
							" · work 池 余 " + fmtCredit(quota.pools.work.remain) + " / " + fmtCredit(quota.pools.work.limit)
						: "—";
			var syncModels = function () {
				setBusy(true);
				post({ action: "trae-model-sync" }).then(function (res) {
					setBusy(false);
					if (!res.ok) { setErr(res.d && res.d.sync && res.d.sync.error ? res.d.sync.error : "目录同步失败"); return; }
					fetchTlist();
					reload();
				}).catch(function (e) { setBusy(false); setErr(e && e.message ? e.message : "目录同步失败（网络）"); });
			};

			// Trae 模型启停：受控 checkbox 双 change 同值去重（同 CodeBuddy 模型行）。
			var tlastSentRef = useRef({});
			var toggleTmodel = function (p, enabled) {
				if (tlastSentRef.current[p.id] === enabled) return;
				tlastSentRef.current[p.id] = enabled;
				post({ patch: { traeModelSetEnabled: { id: p.id, enabled: enabled } } }).then(function (res) {
					// 失败回滚同值去重表（同 CodeBuddy 模型行）。
					if (!res.ok) { delete tlastSentRef.current[p.id]; setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					var disabled = {};
					(((res.d.trae || {}).models || {}).disabled || []).forEach(function (id) { disabled[id] = true; });
					setTlist(function (prev) { return prev ? { profiles: prev.profiles, disabled: disabled } : prev; });
					reload(); // 徽标/状态随镜像刷新
				}).catch(function (e) { delete tlastSentRef.current[p.id]; setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
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

			// 网关状态行（:3902 失败原因的唯一 UI 出口，踩坑 #7）：口径照
			// CodeBuddy 流式桥行——未监听时把 lastError（如 EADDRINUSE）带出来。
			var tbridge = trae.bridge || {};
			var bridgeStatus = value.traeEnabled === true
				? (tbridge.running
					? { tone: "ok", text: "运行中（127.0.0.1:" + (tbridge.port != null ? tbridge.port : value.traeBridgePort) + "）" }
					: { tone: "warn", text: "未监听" + (tbridge.lastError ? "：" + tbridge.lastError : "") + (tbridge.lastError === "EADDRINUSE" ? "——若占用者是另一个 dsh 实例，其桥仍会代管本实例流量" : "（启动中或端口被占）") })
				: { tone: "off", text: "通道未启用" };

			// 模型启停组：通道开启且目录已拉到才显示。
			var tmodelRows = null;
			if (value.traeEnabled === true && tlist && tlist.profiles.length) {
				var enabledCount = tlist.profiles.filter(function (p) { return !tlist.disabled[p.id]; }).length;
				var tshown = tlist.profiles.filter(function (p) { return matchesModelFilter(p, tfilter); });
				tmodelRows = createElement("div", { key: "tmodels", style: { marginTop: 4 } },
					createElement("div", { className: "cbc-subtitle" }, "Trae 模型（选择器内 " + enabledCount + " / " + tlist.profiles.length + "）"),
					createElement("div", { className: "cbc-scrollbox", style: { maxHeight: 220 } },
						tshown.length ? tshown.map(function (p) {
							return createElement(SubModelRow, {
								key: p.id, id: p.id, name: p.name, enabled: !tlist.disabled[p.id],
								titleOn: "加入 Trae 路由", titleOff: "从 Trae 路由移除",
								ctx: p.contextWindow, image: !!(p.input && p.input.indexOf("image") >= 0),
								onToggle: function (e) { toggleTmodel(p, e.target.checked); },
							});
						}) : createElement("p", { className: "cbc-muted" }, "无匹配模型")),
					createElement(HelpNote, null, "勾选控制每个 Trae 模型是否进对话选择器（写入宿主配置层的 providers.trae 块——dsh 0.1.7+ 落 profile patch，更早落 ~/.dsh/settings.yaml；免重启）；全部取消 = 整个 Trae 路由从选择器移除。"));
			}

			return createElement("div", { className: "cbc-section" },
				// 「启用通道」开关已上移到区块头（唯一落点）：网关运行态由区块头状态行承载。
				createElement("p", { className: "cbc-group-title" }, "凭据"),
				createElement(ChannelLoginRow, {
					label: "Trae 登录", status: loginStatus,
					button: toauth.signedIn
						? (tLogoutConfirm
							? createElement(CbcButton, { variant: "outline", danger: true, onClick: doTLogout }, "确认退出")
							: createElement(CbcButton, { variant: "outline", danger: true, onClick: askTLogout }, "退出登录"))
						: createElement(CbcButton, { variant: "primary", disabled: busy, onClick: startLogin }, busy ? "启动中…" : "登录（浏览器授权）"),
				}),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "余额"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: "cbc-status cbc-balance" }, balanceText))),
				createElement("p", { className: "cbc-group-title" }, "模型"),
				// 操作条（三家同构）：通道未启用时也要在——按钮不生效的原因写在
				// 状态文字里，比整组消失更好排查；只有下面的启停列表受启用条件约束。
				createElement(SyncBar, { busy: busy, onSync: syncModels, info: syncInfo + (traeOn ? "" : "（通道未启用）"), filter: tfilter, onFilter: setTfilter }),
				tmodelRows,
				createElement("p", { className: "cbc-group-title" }, "网关"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关状态"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: bridgeStatus.tone === "warn" ? "cbc-warn" : "cbc-status", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							createElement(Dot, { tone: bridgeStatus.tone }), bridgeStatus.text))),
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
				createElement("details", { className: "cbc-adv" },
					// summary 的 title 复述旧折叠按钮携带的范围提示（可见文本仍是「高级」）。
					createElement("summary", { title: "认证 / 聊天 / 登录域" }, "高级"),
					createElement("div", { className: "cbc-advbody" },
						createElement("div", { className: "cbc-row" },
							createElement("div", { className: "cbc-row-label" }, "连接域名"),
							createElement("div", { className: "cbc-row-control" },
								createElement(TextField, { fieldKey: "traeAuthBaseURL", value: value.traeAuthBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeAuthBaseURL") }),
								createElement(TextField, { fieldKey: "traeChatBaseURL", value: value.traeChatBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeChatBaseURL") }),
								createElement(TextField, { fieldKey: "traeLoginHost", value: value.traeLoginHost, save: save, widthClass: "cbc-w220", overridden: overridden("traeLoginHost") }))))),
				createElement(HelpNote, null, "走 TraeWork CN 订阅额度：本插件用自持设备密钥完成 OAuth（凭据只存本机 ~/.dsh/trae-plugin-auth.json），经本地翻译网关把 OpenAI 请求转成 Trae 云端协议。模型清单来自本机 TRAE SOLO CN 的缓存数据库（只读、自动脱敏）。"));
		}
		SECTION_RENDERERS.trae = TraeSection;

		// --- Qoder CN：设备流 OAuth + 翻译网关 + 网关目录模型启停/逐模型调节 ----
		// 行内两个 select（思考强度/上下文长度）绑后端 qoderModelSetPrefs 契约：
		// prefs 发全量期望态（完整替换），成功后用响应回带的 qoder 区刷新。
		var QODER_EFFORT_TIERS = ["off", "low", "medium", "high", "max"];
		function QoderSection(props) {
			var value = props.value;
			var save = props.save;
			var post = props.post;
			var reload = props.reload;
			var setErr = props.setErr;
			var overridden = props.overridden;
			var qoder = props.qoder || {};
			var qoauth = qoder.oauth || {};
			var qmodels = qoder.models || {};

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			// 退出登录二次确认（同 Trae 区模式）：第一次点击进确认态，4 秒复位。
			var qLogoutConfirmState = useState(false);
			var qLogoutConfirm = qLogoutConfirmState[0];
			var setQLogoutConfirm = qLogoutConfirmState[1];
			var qLogoutTimerRef = useRef(null);
			var askQLogout = function () {
				if (qLogoutTimerRef.current) clearTimeout(qLogoutTimerRef.current);
				setQLogoutConfirm(true);
				qLogoutTimerRef.current = setTimeout(function () { setQLogoutConfirm(false); }, 4000);
			};
			var doQLogout = function () {
				if (qLogoutTimerRef.current) { clearTimeout(qLogoutTimerRef.current); qLogoutTimerRef.current = null; }
				setQLogoutConfirm(false);
				post({ action: "qoder-oauth-logout" }).then(reload).catch(function (e) { setErr(e && e.message ? e.message : "退出失败（网络）"); });
			};
			var listState = useState(null); // {profiles, disabled:{id:true}} 来自 qoder-model-list
			var qlist = listState[0];
			var setQlist = listState[1];
			// 模型筛选（与 CodeBuddy/Trae 模型组同款）：只过滤渲染，不发请求。
			var qfilterState = useState("");
			var qfilter = qfilterState[0];
			var setQfilter = qfilterState[1];
			// 逐模型 prefs 本地态：跟随 GET（props.qoder 经 reload 刷新），POST 成功
			// 后用响应回带的 qoder 区覆写（与启停同款"响应权威"纪律）。
			var qPrefsState = useState(null); // { [id]: { effort?, contextVariant? } }
			var qPrefs = qPrefsState[0];
			var setQPrefs = qPrefsState[1];
			useEffect(function () { setQPrefs(qmodels.modelPrefs || {}); }, [qmodels.modelPrefs]);

			// P2-5「测一下」：签名目录 GET（catalog 面 /algo，非聊天面）验证设备流
			// 凭据；结果就地显示，不进全局横幅。
			var qTestState = useState(null); // null | {busy:true} | {ok:bool, text:string}
			var qTest = qTestState[0];
			var setQTest = qTestState[1];
			var testCredential = function () {
				setQTest({ busy: true });
				post({ action: "credential-test", channel: "qoder" }).then(function (res) {
					if (res.ok && res.d.available) setQTest({ ok: true, text: "✓ 可用（" + (res.d.detail || "验证通过") + "）" });
					else setQTest({ ok: false, text: "✗ " + ((res.d && res.d.error) || ("HTTP " + res.status)) });
				}).catch(function (e) { setQTest({ ok: false, text: "✗ " + (e && e.message ? e.message : "网络错误") }); });
			};

			// 无本地回环回调（授权在服务端完成、本机只轮询）：pending 期间 3 秒
			// 轮询状态，收敛后 reload（同 CodeBuddy 登录区的 pending 轮询）。
			useEffect(function () {
				if (!qoauth.pending) return undefined;
				var timer = setInterval(function () {
					post({ action: "qoder-oauth-status" }).then(function (res) {
						if (res.ok && res.d.qoder && !res.d.qoder.pending) reload();
					}).catch(function () {});
				}, 3000);
				return function () { clearInterval(timer); };
			}, [qoauth.pending]);

			var fetchQlist = function () {
				post({ action: "qoder-model-list" }).then(function (res) {
					if (!res.ok) return;
					var disabled = {};
					(res.d.disabled || []).forEach(function (id) { disabled[id] = true; });
					setQlist({ profiles: (res.d.view && res.d.view.profiles) || [], disabled: disabled });
				}).catch(function (e) {
					// 同 Trae 区纪律：拉取失败带原因（踩坑 #7），`!res.ok` 的已知空态不进来。
					setErr("Qoder 模型目录读取失败：" + (e && e.message ? e.message : "（网络）"));
				});
			};
			useEffect(function () { fetchQlist(); }, []);
			// 开启通道或目录同步完成（sync.at 变化）后重拉启停清单（同 Trae 区纪律）。
			var qoderSyncAt = qmodels.sync && qmodels.sync.at;
			var qoderOn = value.qoderEnabled === true;
			useEffect(function () { fetchQlist(); }, [qoderSyncAt, qoderOn]);

			var startLogin = function () { startOAuthFlow(post, "qoder-oauth-start", setBusy, setErr, reload); };
			// P1-2 余额行（账户配额，只读）：展开/收起边界各采一次 + 登录态翻转折采，
			// 不周期轮询；服务端 60s memoize 控成本。取不到一律「—（原因）」，绝不编造。
			var active = props.active === true;
			var quotaState = useState(null);
			var quota = quotaState[0];
			var setQuota = quotaState[1];
			var quotaGenRef = useRef(0);
			var fetchQuota = function () {
				if (!qoauth.signedIn) { setQuota({ error: "未登录" }); return; }
				var my = ++quotaGenRef.current;
				post({ action: "qoder-quota" }).then(function (res) {
					if (my !== quotaGenRef.current) return;
					setQuota(res.ok && res.d && res.d.quota ? res.d.quota : { error: (res.d && res.d.error) || ("HTTP " + res.status) });
				}).catch(function (e) {
					if (my !== quotaGenRef.current) return;
					setQuota({ error: e && e.message ? e.message : "（网络）" });
				});
			};
			useEffect(function () { fetchQuota(); }, [active, qoauth.signedIn]);
			var qfmtPool = function (q) { return "余 " + fmtCredit(q.remaining) + " / " + fmtCredit(q.total) + (q.unit ? " " + q.unit : ""); };
			var balanceText = !quota ? "读取中…"
				: quota.error ? "—（" + quota.error + "）"
					: quota.addOnQuota && quota.addOnQuota.total != null
						? "附加额度 " + qfmtPool(quota.addOnQuota) +
							(quota.userQuota && quota.userQuota.total > 0 ? " · 订阅 " + qfmtPool(quota.userQuota) : "")
						: "—";
			var syncModels = function () {
				setBusy(true);
				post({ action: "qoder-model-sync" }).then(function (res) {
					setBusy(false);
					if (!res.ok || res.d.ok === false) { setErr(res.d && (res.d.error || (res.d.sync && res.d.sync.error)) ? (res.d.error || res.d.sync.error) : "目录同步失败"); return; }
					fetchQlist();
					reload();
				}).catch(function (e) { setBusy(false); setErr(e && e.message ? e.message : "目录同步失败（网络）"); });
			};

			// Qoder 模型启停：受控 checkbox 双 change 同值去重（踩坑 #27/#32 纪律）。
			var qlastSentRef = useRef({});
			var toggleQmodel = function (p, enabled) {
				if (qlastSentRef.current[p.id] === enabled) return;
				qlastSentRef.current[p.id] = enabled;
				post({ patch: { qoderModelSetEnabled: { id: p.id, enabled: enabled } } }).then(function (res) {
					if (!res.ok) { delete qlastSentRef.current[p.id]; setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					var disabled = {};
					(((res.d.qoder || {}).models || {}).disabled || []).forEach(function (id) { disabled[id] = true; });
					setQlist(function (prev) { return prev ? { profiles: prev.profiles, disabled: disabled } : prev; });
					reload();
				}).catch(function (e) { delete qlastSentRef.current[p.id]; setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
			};

			// 逐模型 prefs（思考强度/上下文长度）：后端完整替换语义，这里发全量
			// 期望态；useRef 同值去重 + 失败销账（踩坑 #27/#32 纪律）。空 rec = 删
			// 记录回默认。成功后以响应回带的 qoder.modelPrefs 为权威刷新本地态。
			var qprefLastSentRef = useRef({});
			var saveQpref = function (id, prefs) {
				var rec = {};
				if (prefs.effort) rec.effort = prefs.effort;
				if (prefs.contextVariant) rec.contextVariant = prefs.contextVariant;
				var json = JSON.stringify(rec);
				if (qprefLastSentRef.current[id] === json) return;
				qprefLastSentRef.current[id] = json;
				post({ patch: { qoderModelSetPrefs: { id: id, prefs: rec } } }).then(function (res) {
					if (!res.ok) {
						delete qprefLastSentRef.current[id];
						setErr(res.d && res.d.error ? res.d.error : "操作失败");
						reload(); // 服务端未变，回同步本地（select 弹回旧值）
						return;
					}
					setQPrefs((((res.d.qoder || {}).models || {}).modelPrefs) || {});
					reload();
				}).catch(function (e) {
					delete qprefLastSentRef.current[id];
					setErr("操作失败：" + (e && e.message ? e.message : String(e)));
				});
			};

			var account = qoauth.account;
			var loginStatus = qoauth.pending
				? { tone: "warn", text: "登录进行中：浏览器完成授权后自动收敛（5 分钟内有效）。" }
				: qoauth.signedIn
					? {
						tone: qoauth.needsRelogin ? "err" : "ok",
						text: (qoauth.needsRelogin ? "需重新登录" : "已登录") +
							(account && (account.nickname || account.uid) ? "：" + (account.nickname || account.uid) : "") +
							(qoauth.accessTokenExpiresAt ? "（令牌至 " + fmtTime(qoauth.accessTokenExpiresAt) + "）" : "") +
							(qoauth.error ? "｜" + qoauth.error : ""),
					}
					: { tone: "off", text: "未登录" + (qoauth.error ? "｜" + qoauth.error : "") };

			var syncInfo = qmodels.sync
				? "已同步 " + qmodels.sync.count + " 个模型（" + fmtTime(qmodels.sync.at) + "）"
				: "未同步（需已登录；启用后自动从网关同步）";

			// 网关状态行（:3903 失败原因的唯一 UI 出口，踩坑 #7）：口径同 Trae 区。
			var qbridge = qoder.bridge || {};
			var bridgeStatus = value.qoderEnabled === true
				? (qbridge.running
					? { tone: "ok", text: "运行中（127.0.0.1:" + (qbridge.port != null ? qbridge.port : value.qoderBridgePort) + "）" }
					: { tone: "warn", text: "未监听" + (qbridge.lastError ? "：" + qbridge.lastError : "") + (qbridge.lastError === "EADDRINUSE" ? "——若占用者是另一个 dsh 实例，其桥仍会代管本实例流量" : "（启动中或端口被占）") })
				: { tone: "off", text: "通道未启用" };

			// 模型启停组：通道开启且目录已拉到才显示。
			var qmodelRows = null;
			if (value.qoderEnabled === true && qlist && qlist.profiles.length) {
				var enabledCount = qlist.profiles.filter(function (p) { return !qlist.disabled[p.id]; }).length;
				var qshown = qlist.profiles.filter(function (p) { return matchesModelFilter(p, qfilter); });
				qmodelRows = createElement("div", { key: "qmodels", style: { marginTop: 4 } },
					createElement("div", { className: "cbc-subtitle" }, "Qoder 模型（选择器内 " + enabledCount + " / " + qlist.profiles.length + "）"),
					createElement("div", { className: "cbc-scrollbox", style: { maxHeight: 220 } },
						qshown.length ? qshown.map(function (p) {
							var enabled = !qlist.disabled[p.id];
							var prefsRec = (qPrefs || qmodels.modelPrefs || {})[p.id] || {};
							var variants = (qmodels.variants || {})[p.id] || [];
							// 思考强度：选项含 off（prefs 显式存 off，网关层 = 省略参数）。
							var effortSel = createElement("select", {
								className: "cbc-select cbc-effort-sel",
								title: "思考强度：网关出站对该模型注入 reasoning_effort（默认 = 不注入）",
								value: prefsRec.effort || "",
								onChange: function (e) { saveQpref(p.id, { effort: e.target.value, contextVariant: prefsRec.contextVariant }); },
							},
								createElement("option", { value: "" }, "思考:默认"),
								QODER_EFFORT_TIERS.map(function (t) { return createElement("option", { key: t, value: t }, "思考:" + t); }));
							// 上下文长度：无变体模型不出控件；默认档 = isDefault 项（无则第一项）。
							var ctxSel = null;
							var effWindow = p.contextWindow;
							if (variants.length) {
								var defVar = variants.filter(function (v) { return v.isDefault; })[0] || variants[0];
								var curVar = variants.filter(function (v) { return v.name === prefsRec.contextVariant; })[0];
								if (curVar) effWindow = curVar.tokenCount;
								ctxSel = createElement("select", {
									className: "cbc-select cbc-effort-sel",
									title: "上下文长度：选中变体镜像为该模型的 contextWindow（默认 = 目录默认档）",
									value: (curVar && curVar.name) || "",
									onChange: function (e) { saveQpref(p.id, { effort: prefsRec.effort, contextVariant: e.target.value }); },
								},
									createElement("option", { value: "" }, "上下文:" + defVar.name),
									variants.map(function (v) { return createElement("option", { key: v.name, value: v.name }, "上下文:" + v.name); }));
							}
							return createElement(SubModelRow, {
								key: p.id, id: p.id, name: p.name, enabled: enabled,
								titleOn: "加入 Qoder 路由", titleOff: "从 Qoder 路由移除",
								ctx: effWindow, image: !!(p.input && p.input.indexOf("image") >= 0),
								onToggle: function (e) { toggleQmodel(p, e.target.checked); },
								extra: createElement(Fragment, null, effortSel, ctxSel),
							});
						}) : createElement("p", { className: "cbc-muted" }, "无匹配模型")),
					createElement(HelpNote, null, "勾选控制每个 Qoder 模型是否进对话选择器；行内 select 逐模型调思考强度与上下文长度（写文件层 prefs 并镜像进 settings.yaml，均免重启）；全部取消 = 整个 Qoder 路由从选择器移除。"));
			}

			return createElement("div", { className: "cbc-section" },
				// 「启用通道」开关已上移到区块头（唯一落点）：网关运行态由区块头状态行承载。
				createElement("p", { className: "cbc-group-title" }, "凭据"),
				createElement(ChannelLoginRow, {
					label: "Qoder 登录", status: loginStatus,
					button: qoauth.signedIn && !qoauth.needsRelogin
						? (qLogoutConfirm
							? createElement(CbcButton, { variant: "outline", danger: true, onClick: doQLogout }, "确认退出")
							: createElement(CbcButton, { variant: "outline", danger: true, onClick: askQLogout }, "退出登录"))
						: createElement(CbcButton, { variant: "primary", disabled: busy, onClick: startLogin },
							busy ? "启动中…" : (qoauth.needsRelogin ? "重新登录（浏览器授权）" : "登录（浏览器授权）")),
					extra: createElement(Fragment, null,
						qoauth.pending && qoauth.authUrl
							? createElement(CbcButton, { variant: "outline", onClick: function () { window.open(qoauth.authUrl, "_blank"); } }, "重新打开登录页")
							: null,
						createElement(CbcButton, { variant: "ghost", disabled: !!(qTest && qTest.busy), onClick: testCredential },
							qTest && qTest.busy ? "验证中…" : "测一下"),
						qTest && !qTest.busy
							? createElement("span", { className: qTest.ok ? "cbc-status" : "cbc-warn", "data-test": "qoder" }, qTest.text)
							: null),
				}),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "余额"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: "cbc-status cbc-balance" }, balanceText))),
				createElement("p", { className: "cbc-group-title" }, "模型"),
				// 操作条（三家同构）：通道未启用时也渲染，理由同 Trae 区。
				createElement(SyncBar, { busy: busy, onSync: syncModels, info: syncInfo + (qoderOn ? "" : "（通道未启用）"), filter: qfilter, onFilter: setQfilter }),
				qmodelRows,
				createElement("p", { className: "cbc-group-title" }, "网关"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关状态"),
					createElement("div", { className: "cbc-row-control" },
						createElement("span", { className: bridgeStatus.tone === "warn" ? "cbc-warn" : "cbc-status", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
							createElement(Dot, { tone: bridgeStatus.tone }), bridgeStatus.text))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关端口"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "qoderBridgePort", value: value.qoderBridgePort, save: save, overridden: overridden("qoderBridgePort") }),
						createElement("span", { className: "cbc-muted" }, "settings.yaml 镜像里的 qoder baseURL 端口（默认 3903），改端口重铺镜像热生效"))),
				createElement("details", { className: "cbc-adv" },
					// summary 的 title 复述旧折叠按钮携带的范围提示（可见文本仍是「高级」）。
					createElement("summary", { title: "登录域 / OpenAPI / infer / client_id" }, "高级"),
					createElement("div", { className: "cbc-advbody" },
						createElement("div", { className: "cbc-row" },
							createElement("div", { className: "cbc-row-label" }, "连接域名"),
							createElement("div", { className: "cbc-row-control" },
								createElement(TextField, { fieldKey: "qoderLoginHost", value: value.qoderLoginHost, save: save, widthClass: "cbc-w220", overridden: overridden("qoderLoginHost") }),
								createElement(TextField, { fieldKey: "qoderOpenapiBaseURL", value: value.qoderOpenapiBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("qoderOpenapiBaseURL") }),
								createElement(TextField, { fieldKey: "qoderInferBaseURL", value: value.qoderInferBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("qoderInferBaseURL") }),
								createElement(TextField, { fieldKey: "qoderClientId", value: value.qoderClientId, save: save, widthClass: "cbc-w220", overridden: overridden("qoderClientId") }))))),
				createElement(HelpNote, null, "Qoder CN（qoder.cn）设备流 OAuth + COSY 签名翻译网关：对话经本地 :3903 网关转成官方 infer 协议（凭据只存 ~/.dsh/qoder-plugin-auth.json，不回传浏览器）。额度跟账号走（按 usage.credits 计量，额度与用量页可见）。"));
		}
		SECTION_RENDERERS.qoder = QoderSection;

		// --- 网关与高级：流式桥（主聊天链路）+ 网关地址（高级折叠） -----------------
		function BridgeAdvancedSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			var bridgeView = props.bridgeView || {};
			return createElement("div", { className: "cbc-section" },
				createElement("p", { className: "cbc-group-title" }, "网关"),
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
				createElement(HelpNote, null, "桥统一解析凭据（凭据组选 OAuth 或 Key），主聊天也经由此桥。同一会话超过上限的请求排队（FIFO）；无会话 id 的请求不限流。非流式入站聚合成标准 JSON，chat/completions 之外的请求直接透传。"),
				createElement("details", { className: "cbc-adv" },
					createElement("summary", null, "高级"),
					createElement("div", { className: "cbc-advbody" },
						createElement("div", { className: "cbc-row" },
							createElement("div", { className: "cbc-row-label" }, "网关地址"),
							createElement("div", { className: "cbc-row-control" },
								createElement(TextField, { fieldKey: "baseURL", value: value.baseURL, save: save, overridden: overridden("baseURL") }))),
						createElement("p", { className: "cbc-hint" }, "CodeBuddy 网关地址，一般无需修改；必须是 http/https 绝对地址。"))));
		}
		SECTION_RENDERERS.bridge = BridgeAdvancedSection;

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
				if (props.numeric) {
					var n = Number(draft);
					if (!Number.isFinite(n) || draft.trim() === "" || n === props.value) return;
					var np = {};
					np[props.fieldKey] = n;
					props.save(np);
					return;
				}
				if (draft === String(props.value == null ? "" : props.value)) return;
				var patch = {};
				patch[props.fieldKey] = draft;
				props.save(patch);
			};
			// Enter 只 blur：提交统一走 onBlur。曾经 Enter 先 commit 再 blur，
			// blur 又触发一次 commit —— 一次保存产生两趟 POST+GET。
			return createElement(Fragment, null,
				createElement(CbcInput, {
					type: props.numeric ? "number" : undefined,
					widthClass: props.numeric ? "cbc-w110" : props.widthClass,
					value: draft,
					onInput: function (e) { setDraft(e.target.value); },
					onBlur: commit,
					onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
				}),
				createElement(ResetButton, { fieldKey: props.fieldKey, overridden: props.overridden, save: props.save }));
		}

		// 数值字段 = TextField 的 numeric 变体（提交前 Number() 解析+有限性
		// 校验，宽度钉死 cbc-w110）——原先是 TextField 的逐行拷贝，双份维护。
		function NumberField(props) {
			return createElement(TextField, Object.assign({}, props, { numeric: true }));
		}

		// OAuth 启动流程（CodeBuddy 与 Trae 两处共用）：window.open 必须在点击
		// 处理器内同步发起，异步（fetch 后）的调用会被弹窗拦截器吃掉——先开
		// 空白页，拿到 authUrl 再导航。
		function startOAuthFlow(post, action, setBusy, setErr, reload) {
			var win = window.open("", "_blank");
			setBusy(true);
			post({ action: action }).then(function (res) {
				setBusy(false);
				if (res.ok && res.d.authUrl) {
					if (win) win.location.href = res.d.authUrl;
					reload();
				} else {
					if (win) win.close();
					setErr(res.d && res.d.error ? res.d.error : "发起登录失败");
				}
			}).catch(function (e) { setBusy(false); if (win) win.close(); setErr(e && e.message ? e.message : "发起登录失败（网络）"); });
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
				widthClass: "cbc-w90 cbc-ghost",
				ariaLabel: props.field === "contextWindow" ? "上下文长度上限（清空恢复目录默认）" : "输出长度上限（清空恢复目录默认）",
				value: draft,
				onInput: function (e) { setDraft(e.target.value); },
				onBlur: commit,
				onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
			}));
		}

		var inject = ["slots"];

		// dsh 0.1.6 plugins.item 槽契约：owner props {view}——summary = 标题下的
		// 一行简介；page = 完整表单（页面自带标题/图标/返回 crumb，卡片常开、
		// 不再画自己的折叠头部）。
		function PluginManagerEntry(props) {
			if (props && props.view === "summary") {
				return createElement("span", null, "CodeBuddy / Trae / Qoder CN 通道：凭据、模型、额度与流式桥。");
			}
			return createElement(CodeBuddyCard, { embedded: true });
		}

		function apply(ctx) {
			ctx.inject(["slots"], function (sctx) {
				// dsh 0.1.6 拆除了 settings.plugin.item 槽（卡片迁入 Plugin Manager
				// 的 plugins.item，boot 即声明，inject 立即回调）；旧槽名在新宿主上
				// 永不声明，而 slots.inject 对未声明槽是静默等待——0.1.5→0.1.6 升级
				// "卡片消失且零报错"正是这个机制。两槽都注册：哪个声明了走哪个。
				if (typeof sctx.slots.inject === "function") {
					sctx.slots.inject("plugins.item", function () {
						return sctx.slots.register(
							{
								name: "plugins.item",
								id: "dsh-tap",
								order: 60,
								label: function () { return "dsh-tap"; },
								inject: function () { return {}; },
							},
							PluginManagerEntry,
						);
					});
					sctx.slots.inject("settings.plugin.item", function () {
						return sctx.slots.register(
							{
								name: "settings.plugin.item",
								// keyed 槽：设置页按 Host 服务的 settings 命名空间逐个
								// 派发，配对本 key（host 半注册同名命名空间）。
								key: "dsh-tap",
								inject: function () { return {}; },
							},
							CodeBuddyCard,
						);
					});
				} else {
					sctx.slots.register(
						{
							name: "settings.plugin.item",
							key: "dsh-tap",
							id: "codebuddy",
							order: 60,
							label: function () { return "dsh-tap"; },
							inject: function () { return {}; },
						},
						CodeBuddyCard,
					);
				}
			});
		}

		exports.ROUTE = ROUTE;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
