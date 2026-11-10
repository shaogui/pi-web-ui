/**
 * plugins/feishu-pro/client/auto-reply-panel.mjs
 * 「私聊自动问答」的**表单体**（不含卡片外壳 —— 外壳由设置页 ③ 区提供）。
 *
 * 为什么要有这块 UI：自动回复是**唯一会以你本人名义自动开口**的能力。
 * 默认关闭、白名单为空则谁都不回 —— 打开它必须是人手动点的一次决定，
 * 所以面板上把「谁会被回 / 频率多少 / 会说什么」三件事都摊开给用户看。
 *
 * 0.15.0 改版：外壳（卡头、状态胶囊、卡底动作条）交给 `settings-view.mjs`，
 * 这里只留控件 + 脏标记 + 保存；低频内容（预览、回复历史）收进折叠区。
 */

import { apiBase, esc } from "@pi-web-ui/plugin-sdk/client";

const BASE = apiBase("feishu-pro");
const STYLE_ID = "fp-auto-styles";

const STYLES = `
.fp-auto{display:flex;flex-direction:column;gap:12px;}
.fp-auto .fp-auto-num{width:78px;text-align:center;}
.fp-auto .fp-auto-ids{width:100%;min-height:58px;line-height:1.6;resize:vertical;word-break:break-all;}
.fp-auto-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim);word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--text-faint);}
.fp-auto-dot.on{background:var(--green);}
.fp-auto-dot.err{background:var(--red);}
.fp-auto-msg{font-size:11.5px;line-height:1.7;color:var(--text-faint);word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-msg.err{color:var(--red);}
.fp-auto-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.fp-auto-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;}
.fp-auto-item{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border-radius:8px;background:var(--bg);border:1px solid var(--border-soft);min-width:0;}
.fp-auto-head{display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--text-faint);}
.fp-auto-who{font-size:12px;font-weight:600;color:var(--text);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-auto-ask,.fp-auto-reply{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-ask{color:var(--text-dim);}
.fp-auto-reply{color:var(--text);}
.fp-auto-dry{color:var(--text-faint);font-style:italic;}
.fp-auto-preview{width:100%;min-height:130px;line-height:1.6;resize:vertical;}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

/** 兜底传输层：见 sync-panel.mjs 同名字段的注释（设置页会注入自己的 `call`）。 */
async function localCall(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
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
	if (!payload || payload.ok !== true) throw new Error(payload?.error || `请求失败（HTTP ${resp.status}）`);
	return payload;
}

function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta < 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 挂载表单体。
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {(path: string, init?: object) => Promise<any>} [opts.call] 传输层（不传就用自己的 fetch 封装）
 * @param {(dirty: boolean) => void} [opts.onDirty] 脏标记变化（设置页据此显示卡底动作条）
 * @returns {{ apply: (state: any) => void, refresh: () => Promise<any>, save: () => Promise<void>, revert: () => void, isDirty: () => boolean, destroy: () => void }}
 */
export function mountAutoReplyPanel(container, opts = {}) {
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
	wrap.className = "fp-auto";
	wrap.innerHTML = `
		<div class="fp-form">
			<div class="fp-field">
				<div class="fp-field-label">开关</div>
				<label class="fp-check"><input type="checkbox" class="fp-auto-enabled" /> 启用自动回复</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-dry" /> 空跑（只记录不发）</label>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">回包身份</div>
				<select class="fp-input fp-auto-as">
					<option value="user">我（本人）</option>
					<option value="bot">机器人</option>
				</select>
				<div class="fp-field-hint">以你本人身份回包时，对方看到的是你。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">频率</div>
				<label class="fp-check">冷却 <input type="number" class="fp-input fp-auto-num fp-auto-cooldown" min="0" max="3600" step="5" aria-label="冷却秒数" /> 秒</label>
				<label class="fp-check">每小时上限 <input type="number" class="fp-input fp-auto-num fp-auto-cap" min="0" max="1000" step="1" aria-label="每小时上限" /></label>
			</div>
		</div>
		<div class="fp-field">
			<div class="fp-field-label">允许自动回复的会话</div>
			<div class="fp-field-hint"><code>oc_…</code>，逗号或换行分隔。<b>空 = 一条都不回</b>。建议先用「空跑」跑一天，确认话术没问题再关掉。</div>
			<textarea class="fp-input fp-mono fp-auto-ids" spellcheck="false" placeholder="oc_0123456789abcdef0123456789abcdef"></textarea>
			<div class="fp-field-hint fp-auto-count"></div>
		</div>
		<div class="fp-field">
			<div class="fp-field-label">签名</div>
			<input class="fp-input fp-auto-signature" placeholder="（留空则不加，如：—— 由 AI 助理代回）" />
		</div>
		<details class="fp-fold">
			<summary>预览会发什么</summary>
			<div class="fp-fold-body">
				<div class="fp-auto-row">
					<button class="fp-btn fp-btn-sm fp-auto-preview-btn" type="button">预览白名单第一个会话</button>
				</div>
				<textarea class="fp-input fp-mono fp-auto-preview" readonly placeholder="点上面的按钮：选白名单里第一个会话拉最近一条消息，看看模型会收到什么提示词。"></textarea>
			</div>
		</details>
		<div class="fp-auto-state"><span class="fp-auto-dot"></span><span class="fp-auto-state-text">读取中…</span></div>
		<div class="fp-auto-msg fp-auto-hint"></div>
		<details class="fp-fold">
			<summary>最近自动回复</summary>
			<div class="fp-fold-body">
				<div class="fp-auto-list"><div class="fp-auto-msg">还没有记录</div></div>
			</div>
		</details>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elEnabled = $(".fp-auto-enabled");
	const elDry = $(".fp-auto-dry");
	const elAs = $(".fp-auto-as");
	const elCooldown = $(".fp-auto-cooldown");
	const elCap = $(".fp-auto-cap");
	const elIds = $(".fp-auto-ids");
	const elCount = $(".fp-auto-count");
	const elSig = $(".fp-auto-signature");
	const elStateText = $(".fp-auto-state-text");
	const elDot = $(".fp-auto-dot");
	const elHint = $(".fp-auto-hint");
	const elPreview = $(".fp-auto-preview");
	const elList = $(".fp-auto-list");
	const btnPreview = $(".fp-auto-preview-btn");

	let busy = false;
	let disposed = false;
	let state = null;
	let dirty = false;

	function markDirty(next) {
		if (dirty === next) return;
		dirty = next;
		opts.onDirty?.(dirty);
	}

	/** 白名单里到底有几个 oc_：省得用户自己数（空 = 谁都不回，最危险的那种"看起来配好了"）。 */
	function paintCount(value) {
		const ids = String(value || "")
			.split(/[\s,;]+/)
			.map((s) => s.trim())
			.filter((s) => s.startsWith("oc_"));
		elCount.textContent = ids.length ? `已识别 ${ids.length} 个会话` : "还没有填会话 → 谁都不会被自动回复";
		elCount.className = `fp-field-hint fp-auto-count${ids.length ? "" : " err"}`;
		return ids;
	}

	function paint() {
		if (!state) return;
		const cfg = state.config || {};
		if (!dirty) {
			elEnabled.checked = Boolean(cfg.enabled);
			elDry.checked = Boolean(cfg.dryRun);
			elAs.value = cfg.as === "bot" ? "bot" : "user";
			elCooldown.value = String(cfg.cooldownSec ?? 20);
			elCap.value = String(cfg.maxPerHour ?? 20);
			elIds.value = String(cfg.chatIds ?? "");
			elSig.value = String(cfg.signature ?? "");
		}
		paintCount(elIds.value);

		const error = state.lastError || "";
		elDot.className = `fp-auto-dot${error ? " err" : cfg.enabled ? " on" : ""}`;
		const parts = [cfg.enabled ? "已启用" : "未启用"];
		if (cfg.enabled && !String(cfg.chatIds || "").trim()) parts.push("白名单为空 → 不会回任何会话");
		if (state.inflight) parts.push(`在跑 ${state.inflight}`);
		parts.push(`本小时已回 ${state.sentLastHour ?? 0}${cfg.maxPerHour ? `/${cfg.maxPerHour}` : ""}`);
		if (state.lastReplyAt) parts.push(`上次 ${ago(state.lastReplyAt)}`);
		parts.push(`已绑定会话 ${state.conversations ?? 0}`);
		if (error) parts.push(`错误：${error}`);
		elStateText.textContent = parts.join(" · ");

		if (state.hostChat === false) {
			elHint.textContent = "当前宿主没有注入 chat 通道（无头 agent 不可用），自动回复无法启动。";
			elHint.className = "fp-auto-msg fp-auto-hint err";
		} else {
			elHint.textContent = cfg.dryRun ? "空跑模式：会跑 agent 并记录要发的内容，但不会真的发出去。" : "";
			elHint.className = "fp-auto-msg fp-auto-hint";
		}

		const replies = Array.isArray(state.replies) ? state.replies : [];
		elList.innerHTML = replies.length
			? replies
					.slice(0, 20)
					.map(
						(r) => `<div class="fp-auto-item">
							<div class="fp-auto-head"><span>${esc(ago(r.at))}</span><span class="fp-auto-who">${esc(
								r.from || r.chatName || r.chatId,
							)}</span>${r.dryRun ? '<span class="fp-auto-dry">空跑</span>' : ""}${
								r.error ? `<span class="fp-auto-dry" style="color:var(--red)">${esc(r.error)}</span>` : ""
							}</div>
							<div class="fp-auto-ask">← ${esc(r.ask)}</div>
							<div class="fp-auto-reply">→ ${esc(r.reply || "（未发送）")}</div>
						</div>`,
					)
					.join("")
			: `<div class="fp-auto-msg">还没有记录</div>`;
	}

	function apply(next) {
		if (!next) return;
		state = next;
		paint();
	}

	async function refresh() {
		if (disposed) return null;
		try {
			const payload = await call("/auto/state");
			apply(payload);
			return payload;
		} catch (err) {
			elHint.textContent = `读取失败：${err?.message || err}`;
			elHint.className = "fp-auto-msg fp-auto-hint err";
			return null;
		}
	}

	function patch() {
		return {
			enabled: elEnabled.checked,
			dryRun: elDry.checked,
			as: elAs.value,
			cooldownSec: Number(elCooldown.value) || 0,
			maxPerHour: Number(elCap.value) || 0,
			chatIds: elIds.value,
			signature: elSig.value,
		};
	}

	async function withBusy(fn) {
		if (busy || disposed) return;
		busy = true;
		try {
			await fn();
		} catch (err) {
			elHint.textContent = String(err?.message || err);
			elHint.className = "fp-auto-msg fp-auto-hint err";
		} finally {
			busy = false;
		}
	}

	/** 保存并生效：由设置页的卡底动作条调用。 */
	async function save() {
		await withBusy(async () => {
			const payload = await call("/auto/config", { method: "POST", body: patch() });
			markDirty(false);
			apply(payload);
			elHint.textContent = payload.config?.enabled ? "已保存并生效" : "已保存（当前是关闭状态）";
			elHint.className = "fp-auto-msg fp-auto-hint";
		});
	}

	function revert() {
		markDirty(false);
		paint();
	}

	btnPreview?.addEventListener("click", () =>
		withBusy(async () => {
			const ids = paintCount(elIds.value);
			if (!ids.length) {
				elHint.textContent = "先在白名单里填一个 oc_ 会话 ID，预览才知道要看哪个会话。";
				elHint.className = "fp-auto-msg fp-auto-hint err";
				return;
			}
			const result = await call("/auto/preview", { method: "POST", body: { chatId: ids[0] } });
			elPreview.value = `[判定] ${result.accepted ? "会被回复" : `不会回（${result.reason}）`}\n\n${result.prompt || ""}`;
			elHint.textContent = result.accepted ? "" : `当前配置下这条消息不会触发回复：${result.reason}`;
			elHint.className = `fp-auto-msg fp-auto-hint${result.accepted ? "" : " err"}`;
		}),
	);

	for (const el of [elEnabled, elDry, elAs, elCooldown, elCap, elIds, elSig]) {
		el?.addEventListener("input", () => {
			markDirty(true);
			if (el === elIds) paintCount(elIds.value);
		});
		el?.addEventListener("change", () => {
			markDirty(true);
			if (el === elIds) paintCount(elIds.value);
		});
	}

	void refresh();

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
