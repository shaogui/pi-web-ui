/**
 * plugins/feishu-pro/client/dm-panel.mjs
 * 「私聊提醒（轮询）」设置卡片：**独立模块**，不掺进 entry.mjs 的模板字符串。
 *
 * 为什么要单独一个文件：飞书没有「我的私聊」事件（事件订阅只推机器人收到的消息），
 * 也没有「我的会话列表 / 未读数」接口 —— 这块能力天生是"轮询 + 手填会话 ID"的组合，
 * 交互比通讯录/云文档复杂得多，塞进设置页那一长串 HTML 里会越来越难改。
 *
 * 挂载方式：`mountDmPanel(el)` 会把自己 append 到传入的容器里，返回 { refresh, destroy }。
 * 样式复用 entry.mjs 注入的 `.fp-card / .fp-card-head / .fp-card-title` 骨架，
 * 只额外注入几条 `.fp-dm-*` 规则（幂等，按 id 判重）。
 */

import { apiBase } from "@pi-web-ui/plugin-sdk/client";

const BASE = apiBase("feishu-pro");
const STYLE_ID = "fp-dm-styles";
const MIN_INTERVAL = 30;
const MAX_INTERVAL = 900;

const STYLES = `
.fp-dm{display:flex;flex-direction:column;gap:12px;}
.fp-dm-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-top:1px;border-radius:50%;font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);}
.fp-dm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;}
.fp-dm-row > label{display:inline-flex;align-items:center;gap:6px;color:var(--text-dim);}
.fp-dm-num{width:84px;padding:4px 8px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px;}
.fp-dm-ids{width:100%;min-height:64px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;resize:vertical;word-break:break-all;}
.fp-dm-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim);word-break:break-word;}
.fp-dm-dot{width:8px;height:8px;border-radius:50%;background:var(--text-faint);flex:0 0 auto;}
.fp-dm-dot.on{background:var(--accent);}
.fp-dm-dot.err{background:var(--danger,#d0453a);}
.fp-dm-msg{font-size:11.5px;color:var(--text-faint);line-height:1.7;word-break:break-word;}
.fp-dm-msg.err{color:var(--danger,#d0453a);}
.fp-dm-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto;}
.fp-dm-item{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border-soft);min-width:0;}
.fp-dm-when{flex:0 0 auto;font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums;}
.fp-dm-who{flex:0 0 auto;font-size:12px;font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-dm-text{flex:1;min-width:0;font-size:12px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-dm-chats{display:flex;flex-direction:column;gap:4px;}
.fp-dm-chat{display:flex;gap:8px;align-items:baseline;font-size:11.5px;color:var(--text-dim);min-width:0;}
.fp-dm-chat code{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px;}
`;

const BUTTON =
	"padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elev);color:var(--text);font-size:12.5px;cursor:pointer;";
const BUTTON_PRIMARY =
	"padding:6px 12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);font-size:12.5px;font-weight:600;cursor:pointer;";

function injectStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLES;
	document.head.appendChild(style);
}

const esc = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);

async function call(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
	const init = { method, credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs) };
	if (method !== "GET" && body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const resp = await fetch(`${BASE}${path}`, init);
	let payload;
	try {
		payload = await resp.json();
	} catch {
		throw new Error(`服务端返回非 JSON（HTTP ${resp.status}）——插件服务端可能还是旧代码，到「插件」面板点「重新加载」`);
	}
	if (!payload || payload.ok !== true) {
		throw Object.assign(new Error(payload?.error || `请求失败（HTTP ${resp.status}）`), {
			needUser: Boolean(payload?.needUser),
		});
	}
	return payload;
}

/** 时间：历史列表里只要"多久以前"。 */
function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta < 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 把面板挂到容器里。
 * @param {HTMLElement} container
 * @param {{ onNeedUser?: () => void }} [opts]
 */
export function mountDmPanel(container, opts = {}) {
	if (!container || typeof container.appendChild !== "function") {
		return { refresh: async () => {}, destroy: () => {} };
	}
	injectStyles();

	const wrap = document.createElement("section");
	wrap.className = "fp-card";
	wrap.innerHTML = `
		<div class="fp-card-head">
			<span class="fp-dm-badge">3</span>
			<div class="fp-card-titles">
				<span class="fp-card-title">私聊提醒（轮询）</span>
				<span class="fp-card-desc">飞书不给「人类账号私聊」事件，只能按间隔拉增量。首次只建基线不弹通知，之后只报新消息。</span>
			</div>
		</div>
		<div class="fp-card-body fp-dm">
			<div class="fp-dm-row">
				<label><input type="checkbox" class="fp-dm-enabled" /> 启用轮询</label>
				<label>间隔 <input type="number" class="fp-dm-num fp-dm-interval" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" step="5" /> 秒</label>
				<label><input type="checkbox" class="fp-dm-auto" /> 自动发现单聊会话</label>
				<label><input type="checkbox" class="fp-dm-notify" /> 弹通知</label>
			</div>
			<div>
				<div class="fp-dm-msg">会话 ID（<code>oc_…</code>，逗号或换行分隔）。自动发现拿不到单聊时，在飞书里复制会话链接填这里。</div>
				<textarea class="fp-dm-ids" spellcheck="false" placeholder="oc_0123456789abcdef0123456789abcdef"></textarea>
			</div>
			<div class="fp-dm-row">
				<button class="fp-dm-save" style="${BUTTON_PRIMARY}">保存并生效</button>
				<button class="fp-dm-poll" style="${BUTTON}">立即检查</button>
				<button class="fp-dm-discover" style="${BUTTON}">重新发现会话</button>
				<span class="fp-dm-state"><span class="fp-dm-dot"></span><span class="fp-dm-state-text">读取中…</span></span>
			</div>
			<div class="fp-dm-msg fp-dm-diag"></div>
			<div class="fp-dm-chats"></div>
			<div class="fp-dm-msg">最近提醒</div>
			<div class="fp-dm-list"><div class="fp-dm-msg">还没有提醒记录</div></div>
		</div>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elEnabled = $(".fp-dm-enabled");
	const elInterval = $(".fp-dm-interval");
	const elAuto = $(".fp-dm-auto");
	const elNotify = $(".fp-dm-notify");
	const elIds = $(".fp-dm-ids");
	const elStateText = $(".fp-dm-state-text");
	const elDot = $(".fp-dm-dot");
	const elDiag = $(".fp-dm-diag");
	const elChats = $(".fp-dm-chats");
	const elList = $(".fp-dm-list");
	const btnSave = $(".fp-dm-save");
	const btnPoll = $(".fp-dm-poll");
	const btnDiscover = $(".fp-dm-discover");

	let busy = false;
	let disposed = false;
	let state = null;

	function paintState() {
		if (!state) return;
		const cfg = state.config || {};
		elEnabled.checked = Boolean(cfg.enabled);
		elInterval.value = String(cfg.intervalSec ?? 60);
		elAuto.checked = Boolean(cfg.autoDiscover);
		elNotify.checked = cfg.notify !== false;
		elIds.value = String(cfg.chatIds ?? "");

		const running = state.running;
		const error = state.lastError || state.discovered?.error || "";
		elDot.className = `fp-dm-dot${error ? " err" : running ? " on" : ""}`;
		const parts = [];
		parts.push(running ? `运行中（每 ${cfg.intervalSec}s）` : cfg.enabled ? "已启用，等待首轮" : "未启用");
		// 取数只有 lark-cli 一条通道：CLI 未就绪时把原因直接摆出来（不静默）。
		const ch = state.channel;
		if (ch && ch.ready === false) parts.push("lark-cli 未就绪");
		if (state.lastPollAt) parts.push(`上次检查 ${ago(state.lastPollAt)}`);
		if (!state.authorized) parts.push("需要先完成「登录飞书账号」");
		elStateText.textContent = parts.join(" · ");

		const diag = state.discovered || {};
		const diagBits = [];
		if (diag.at) diagBits.push(`发现 ${diag.total} 个会话（单聊 ${diag.p2p} / 群 ${diag.groups}）`);
		if (diag.at && diag.p2p === 0) diagBits.push("飞书没返回单聊会话 → 请手填 chat_id");
		if (diag.error) diagBits.push(`发现失败：${diag.error}`);
		if (state.chats?.some((c) => c.lastError)) {
			const bad = state.chats.filter((c) => c.lastError).length;
			diagBits.push(`${bad} 个会话轮询失败`);
		}
		elDiag.textContent = diagBits.join("；");
		elDiag.className = `fp-dm-msg fp-dm-diag${error ? " err" : ""}`;

		const chats = Array.isArray(state.chats) ? state.chats : [];
		elChats.innerHTML = chats.length
			? chats
					.map(
						(c) =>
							`<div class="fp-dm-chat"><code title="${esc(c.id)}">${esc(c.id)}</code><span>${esc(
								c.name || (c.p2p ? "单聊" : c.explicit ? "手填" : "群"),
							)}</span>${
								c.lastError ? `<span style="color:var(--danger,#d0453a)">${esc(c.lastError)}</span>` : ""
							}</div>`,
					)
					.join("")
			: "";

		const history = Array.isArray(state.history) ? state.history : [];
		elList.innerHTML = history.length
			? history
					.slice(0, 20)
					.map(
						(item) =>
							`<div class="fp-dm-item"><span class="fp-dm-when">${esc(ago(item.at))}</span><span class="fp-dm-who">${esc(
								item.senderName || item.chatName || "会话",
							)}</span><span class="fp-dm-text" title="${esc(item.text)}">${esc(item.text)}</span></div>`,
					)
					.join("")
			: `<div class="fp-dm-msg">还没有提醒记录</div>`;
	}

	async function refresh() {
		if (disposed) return;
		try {
			const payload = await call("/dm/state");
			state = payload;
			paintState();
		} catch (err) {
			elDiag.textContent = `读取失败：${err?.message || err}`;
			elDiag.className = "fp-dm-msg fp-dm-diag err";
		}
	}

	function configPatch() {
		return {
			enabled: elEnabled.checked,
			intervalSec: Number(elInterval.value) || 60,
			chatIds: elIds.value,
			autoDiscover: elAuto.checked,
			notify: elNotify.checked,
		};
	}

	async function withBusy(fn) {
		if (busy) return;
		busy = true;
		try {
			await fn();
		} catch (err) {
			elDiag.textContent = String(err?.message || err);
			elDiag.className = "fp-dm-msg fp-dm-diag err";
			if (err?.needUser) opts.onNeedUser?.();
		} finally {
			busy = false;
		}
	}

	btnSave?.addEventListener("click", () =>
		withBusy(async () => {
			const payload = await call("/dm/config", { method: "POST", body: configPatch() });
			state = payload;
			paintState();
		}),
	);
	btnPoll?.addEventListener("click", () =>
		withBusy(async () => {
			const payload = await call("/dm/poll", { method: "POST" });
			state = payload;
			paintState();
			if (payload.polled === 0) {
				elDiag.textContent = payload.skipped
					? `没有新消息（${payload.skipped}）`
					: "没有新消息（首轮只建基线，不会通知）";
				elDiag.className = "fp-dm-msg fp-dm-diag";
			}
		}),
	);
	btnDiscover?.addEventListener("click", () =>
		withBusy(async () => {
			const payload = await call("/dm/discover", { method: "POST" });
			state = payload;
			paintState();
		}),
	);

	void refresh();

	return {
		refresh,
		destroy() {
			disposed = true;
			wrap.remove();
		},
	};
}
