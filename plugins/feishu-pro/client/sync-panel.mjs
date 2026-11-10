/**
 * plugins/feishu-pro/client/sync-panel.mjs
 * 「消息同步与提醒」的**表单体**（不含卡片外壳）—— 由 `client/settings-view.mjs` 挂进设置页 ② 区。
 *
 * 为什么只剩"表单体"（0.15.0 改）：
 *   - 改版前它自己 append 一张 `.fp-card`，连卡头、编号（"3"）、状态胶囊、审计清单都自己画，
 *     结果设置页变成了三张平铺卡片，同一份缓存/提醒数据在 ② 和 ④ 各画一遍；
 *   - 现在"外壳"（分区标题、状态胶囊、卡底动作条）由设置页统一提供，这个模块只负责
 *     **控件 + 脏标记 + 保存**。审计类数据（缓存体积、会话清单、提醒历史、危险操作）
 *     属于「④ 诊断与数据」，也从这里搬走了 —— 一个数据只画一处。
 *
 * 为什么同步与提醒仍然是**一个面板**（0.14.0 定下的）：
 *   两者是 `lib/dm-watch.mjs` **同一个引擎的两个面**（同一份水位、同一份缓存、同一个定时器），
 *   拆成两个面板就会出现「一张关了群聊、另一张又打开」的经典事故。所以只写一个配置对象。
 *
 * 数据流向（面板不再自己起定时器）：
 *   设置页每 15s 拉一次 `/sync/state` → `apply(state)`；
 *   面板保存 / 立即同步后拿到的新状态经 `onState(state)` 回给设置页（① ② ④ 一起更新）。
 *
 * 交互红线：输入框类控件**不做整页重渲染**（只更新状态行与诊断行），否则打字时光标会跳。
 */

import { apiBase } from "@pi-web-ui/plugin-sdk/client";

const BASE = apiBase("feishu-pro");
const STYLE_ID = "fp-sync-styles";
const MIN_INTERVAL = 30;
const MAX_INTERVAL = 900;

const STYLES = `
.fp-sync{display:flex;flex-direction:column;gap:12px;}
.fp-sync .fp-sync-interval{width:78px;text-align:center;}
.fp-sync .fp-sync-ids{width:100%;min-height:62px;line-height:1.6;resize:vertical;word-break:break-all;}
.fp-sync-state{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--text-dim);word-break:break-word;overflow-wrap:anywhere;}
.fp-sync-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--text-faint);}
.fp-sync-dot.on{background:var(--green);}
.fp-sync-dot.err{background:var(--red);}
.fp-sync-msg{font-size:11.5px;line-height:1.7;color:var(--text-faint);word-break:break-word;overflow-wrap:anywhere;}
.fp-sync-msg.err{color:var(--red);}
.fp-sync-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

/**
 * 兜底传输层：面板被单独挂载时用（设置页会把自己的 `call` 注进来，
 * 这样超时、404「服务端旧代码」提示这类口径只有一份）。
 */
async function localCall(path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
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

/** 时间：状态行里只要"多久以前"。 */
function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta < 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 同步跳过的原因 → 人话。
 * `/sync/run` 与定时轮询共用一条路径，所以「上一轮还没跑完」是**正常**结果（`busy`），
 * 不能写成「没有新消息」—— 那会让人以为飞书没消息。
 */
function skipText(reason) {
	switch (String(reason || "")) {
		case "busy":
			return "正在同步中（上一轮还没跑完），几秒后自动续上";
		case "no-channel":
			return "lark-cli 未就绪：到「设置 → lark-cli 与身份」完成安装 / 配置 / 登录";
		case "no-chats":
			return "没有可同步的会话：勾上「同步私聊 / 同步群聊」或填 chat_id";
		default:
			return "没有新消息";
	}
}

/**
 * 挂载表单体。
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {(path: string, init?: object) => Promise<any>} [opts.call] 传输层（不传就用自己的 fetch 封装）
 * @param {(dirty: boolean) => void} [opts.onDirty] 脏标记变化（设置页据此显示卡底动作条）
 * @param {(state: any) => void} [opts.onState] 保存 / 同步后拿到的新状态（设置页据此刷新 ④）
 * @returns {{ apply: (state: any) => void, refresh: () => Promise<any>, save: () => Promise<void>, revert: () => void, isDirty: () => boolean, destroy: () => void }}
 */
export function mountSyncPanel(container, opts = {}) {
	const noop = {
		apply: () => {},
		refresh: async () => null,
		save: async () => {},
		revert: () => {},
		isDirty: () => false,
		destroy: () => {},
	};
	if (!container || typeof container.appendChild !== "function") return noop;
	injectStyles();
	const call = typeof opts.call === "function" ? opts.call : localCall;

	const wrap = document.createElement("div");
	wrap.className = "fp-sync";
	wrap.innerHTML = `
		<div class="fp-form">
			<div class="fp-field">
				<div class="fp-field-label">后台同步</div>
				<label class="fp-check"><input type="checkbox" class="fp-sync-enabled" /> 启用（每 <input type="number" class="fp-input fp-sync-interval" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" step="5" aria-label="同步间隔（秒）" /> 秒一轮）</label>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">同步范围</div>
				<label class="fp-check"><input type="checkbox" class="fp-sync-auto" /> 私聊（自动发现）</label>
				<label class="fp-check"><input type="checkbox" class="fp-sync-groups" /> 群聊（自动发现）</label>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">提醒</div>
				<label class="fp-check"><input type="checkbox" class="fp-sync-notify" /> 私聊新消息弹通知</label>
				<label class="fp-check"><input type="checkbox" class="fp-sync-notify-groups" /> 群消息也弹通知</label>
			</div>
		</div>
		<details class="fp-fold">
			<summary>手动指定会话（<code>oc_…</code>）</summary>
			<div class="fp-fold-body">
				<div class="fp-field-hint">手填的会话<b>无论单聊群聊</b>都会被同步并提醒；自动发现拿不到时，在飞书里复制会话链接填这里（逗号或换行分隔）。</div>
				<textarea class="fp-input fp-mono fp-sync-ids" spellcheck="false" placeholder="oc_0123456789abcdef0123456789abcdef"></textarea>
			</div>
		</details>
		<div class="fp-sync-row">
			<button class="fp-btn fp-btn-sm fp-sync-run" type="button">立即同步</button>
			<span class="fp-sync-state"><span class="fp-sync-dot"></span><span class="fp-sync-state-text">读取中…</span></span>
		</div>
		<div class="fp-sync-msg fp-sync-diag"></div>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elEnabled = $(".fp-sync-enabled");
	const elInterval = $(".fp-sync-interval");
	const elAuto = $(".fp-sync-auto");
	const elGroups = $(".fp-sync-groups");
	const elNotify = $(".fp-sync-notify");
	const elNotifyGroups = $(".fp-sync-notify-groups");
	const elIds = $(".fp-sync-ids");
	const elFold = $(".fp-fold");
	const elStateText = $(".fp-sync-state-text");
	const elDot = $(".fp-sync-dot");
	const elDiag = $(".fp-sync-diag");
	const btnRun = $(".fp-sync-run");

	let busy = false;
	let disposed = false;
	let state = null;
	/**
	 * 表单有没有「用户改了但还没保存」的内容。
	 * 设置页每 15s 推一次状态，`paint()` 会把服务端配置写回表单 ——
	 * 不设这道闸，用户在填 chat_id 的中间就会被后台刷新清掉。
	 */
	let dirty = false;

	function markDirty(next) {
		if (dirty === next) return;
		dirty = next;
		opts.onDirty?.(dirty);
	}

	function diag(text, tone = "") {
		if (!elDiag) return;
		elDiag.textContent = text || "";
		elDiag.className = `fp-sync-msg fp-sync-diag${tone ? ` ${tone}` : ""}`;
	}

	function paint() {
		if (!state) return;
		const cfg = state.config || {};
		if (!dirty) {
			elEnabled.checked = Boolean(cfg.enabled);
			elInterval.value = String(cfg.intervalSec ?? 60);
			elAuto.checked = Boolean(cfg.autoDiscover);
			elGroups.checked = Boolean(cfg.syncGroups);
			elNotify.checked = cfg.notify !== false;
			elNotifyGroups.checked = Boolean(cfg.notifyGroups);
			elIds.value = String(cfg.chatIds ?? "");
			// 已经手填过会话就把折叠区打开：藏起来等于让人以为没配。
			if (elFold) elFold.open = Boolean(String(cfg.chatIds || "").trim());
		}

		const running = state.running;
		const error = state.lastError || state.discovered?.error || "";
		elDot.className = `fp-sync-dot${error ? " err" : running ? " on" : ""}`;
		const cand = state.candidates || {};
		const parts = [];
		parts.push(running ? `运行中（每 ${cfg.intervalSec}s）` : cfg.enabled ? "已启用，等待首轮" : "未启用");
		if (cand.total) {
			const bits = [];
			if (cand.p2p) bits.push(`私聊 ${cand.p2p}`);
			if (cand.groups) bits.push(`群 ${cand.groups}`);
			parts.push(bits.length ? `候选 ${cand.total} 个（${bits.join(" / ")}）` : `候选 ${cand.total} 个`);
		}
		const last = state.lastPoll || {};
		if (last.at) parts.push(`上轮 ${ago(last.at)}：${last.chats} 会话 / ${last.rows} 条 / 新增 ${last.fresh}`);
		else if (state.lastPollAt) parts.push(`上次检查 ${ago(state.lastPollAt)}`);
		if (state.channel && state.channel.ready === false) parts.push("lark-cli 未就绪");
		if (!state.authorized) parts.push("需要先在 ① 完成登录");
		if (dirty) parts.push("有未保存的修改");
		elStateText.textContent = parts.join(" · ");
	}

	async function withBusy(fn) {
		if (busy || disposed) return;
		busy = true;
		try {
			await fn();
		} catch (err) {
			diag(String(err?.message || err), "err");
		} finally {
			busy = false;
		}
	}

	function configPatch() {
		return {
			enabled: elEnabled.checked,
			intervalSec: Number(elInterval.value) || 60,
			chatIds: elIds.value,
			autoDiscover: elAuto.checked,
			syncGroups: elGroups.checked,
			notify: elNotify.checked,
			notifyGroups: elNotifyGroups.checked,
		};
	}

	/** 设置页推状态进来（它自己只拉一份 `/sync/state`）。 */
	function apply(next) {
		if (!next) return;
		state = next;
		paint();
	}

	/** 独立挂载时的兜底：自己拉一次（设置页用 apply 推送，不会走这里）。 */
	async function refresh() {
		if (disposed) return null;
		try {
			const payload = await call("/sync/state");
			apply(payload);
			return payload;
		} catch (err) {
			diag(`读取同步状态失败：${err?.message || err}`, "err");
			return null;
		}
	}

	/** 保存并生效：由设置页的卡底动作条调用。 */
	async function save() {
		await withBusy(async () => {
			const payload = await call("/sync/config", { method: "POST", body: configPatch() });
			markDirty(false);
			apply(payload);
			opts.onState?.(payload);
			diag("已保存并生效");
		});
	}

	/** 撤销未保存的改动：丢掉表单里的值，回到服务端那份。 */
	function revert() {
		markDirty(false);
		paint();
		diag("");
	}

	btnRun?.addEventListener("click", () =>
		withBusy(async () => {
			diag("同步中…（逐会话串行，多会话时可能要几十秒）");
			const payload = await call("/sync/run", { method: "POST", timeoutMs: 180_000 });
			apply(payload);
			opts.onState?.(payload);
			const synced = payload.synced || {};
			diag(
				synced.skipped
					? skipText(synced.skipped)
					: `${synced.waited ? "上一轮刚跑完：" : ""}${synced.chats} 个会话 / ${synced.rows} 条消息，新增 ${synced.fresh} 条${
							synced.fresh === 0 ? "（首轮只建基线，不会通知）" : ""
						}`,
			);
		}),
	);

	// 任何一次手改都算「未保存」：设置页据此亮出卡底动作条。
	for (const el of [elEnabled, elInterval, elAuto, elGroups, elNotify, elNotifyGroups, elIds]) {
		el?.addEventListener("input", () => markDirty(true));
		el?.addEventListener("change", () => markDirty(true));
	}

	return {
		apply,
		refresh,
		save,
		revert,
		isDirty: () => dirty,
		destroy() {
			disposed = true;
			wrap.remove();
		},
	};
}
