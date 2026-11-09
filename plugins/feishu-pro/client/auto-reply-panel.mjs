/**
 * plugins/feishu-pro/client/auto-reply-panel.mjs
 * 「私聊自动问答」设置卡片：独立模块，与 dm-panel 同款骨架（.fp-card / .fp-* 变量）。
 *
 * 为什么要有这块 UI：自动回复是**唯一会以你本人名义自动开口**的能力。
 * 默认关闭、白名单为空则谁都不回 —— 打开它必须是人手动点的一次决定，
 * 所以面板上把「谁会被回 / 频率多少 / 会说什么」三件事都摊开给用户看。
 */

import { apiBase } from "@pi-web-ui/plugin-sdk/client";

const BASE = apiBase("feishu-pro");
const STYLE_ID = "fp-auto-styles";

const STYLES = `
.fp-auto{display:flex;flex-direction:column;gap:12px;}
.fp-auto-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-top:1px;border-radius:50%;font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);}
.fp-auto-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;}
.fp-auto-row > label{display:inline-flex;align-items:center;gap:6px;color:var(--text-dim);}
.fp-auto-num{width:84px;padding:4px 8px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px;}
.fp-auto-ids{width:100%;min-height:56px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;resize:vertical;word-break:break-all;}
.fp-auto-sig{flex:1;min-width:160px;padding:5px 9px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px;}
.fp-auto-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim);word-break:break-word;}
.fp-auto-dot{width:8px;height:8px;border-radius:50%;background:var(--text-faint);flex:0 0 auto;}
.fp-auto-dot.on{background:var(--accent);}
.fp-auto-dot.err{background:var(--danger,#d0453a);}
.fp-auto-msg{font-size:11.5px;color:var(--text-faint);line-height:1.7;word-break:break-word;}
.fp-auto-msg.err{color:var(--danger,#d0453a);}
.fp-auto-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;}
.fp-auto-item{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border-radius:8px;background:var(--bg);border:1px solid var(--border-soft);min-width:0;}
.fp-auto-head{display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--text-faint);}
.fp-auto-who{font-size:12px;font-weight:600;color:var(--text);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-auto-ask,.fp-auto-reply{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.fp-auto-ask{color:var(--text-dim);}
.fp-auto-reply{color:var(--text);}
.fp-auto-dry{color:var(--text-faint);font-style:italic;}
.fp-auto-preview{width:100%;min-height:120px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-dim);font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.6;resize:vertical;}
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

async function call(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
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
 * 挂载面板。
 * @param {HTMLElement} container
 */
export function mountAutoReplyPanel(container) {
	if (!container || typeof container.appendChild !== "function") {
		return { refresh: async () => {}, destroy: () => {} };
	}
	injectStyles();

	const wrap = document.createElement("section");
	wrap.className = "fp-card";
	wrap.innerHTML = `
		<div class="fp-card-head">
			<span class="fp-auto-badge">AI</span>
			<div class="fp-card-titles">
				<span class="fp-card-title">私聊自动问答</span>
				<span class="fp-card-desc">轮询到白名单会话里的新消息 → 跑一轮 agent → 以「我 / 机器人」身份回包。默认关闭；白名单为空则谁都不回。</span>
			</div>
		</div>
		<div class="fp-card-body fp-auto">
			<div class="fp-auto-row">
				<label><input type="checkbox" class="fp-auto-enabled" /> 启用自动回复</label>
				<label><input type="checkbox" class="fp-auto-dry" /> 空跑（只记录不发）</label>
				<label
					>身份
					<select class="fp-auto-num fp-auto-as">
						<option value="user">我（本人）</option>
						<option value="bot">机器人</option>
					</select>
				</label>
				<label>冷却 <input type="number" class="fp-auto-num fp-auto-cooldown" min="0" max="3600" step="5" /> 秒</label>
				<label>每小时上限 <input type="number" class="fp-auto-num fp-auto-cap" min="0" max="1000" step="1" /></label>
			</div>
			<div>
				<div class="fp-auto-msg">允许自动回复的会话 ID（<code>oc_…</code>，逗号或换行分隔）。<b>空 = 一条都不回</b>。建议先用「空跑」跑一天，确认话术没问题再关掉。</div>
				<textarea class="fp-auto-ids" spellcheck="false" placeholder="oc_0123456789abcdef0123456789abcdef"></textarea>
			</div>
			<div class="fp-auto-row">
				<label style="flex:1;min-width:200px;">签名 <input class="fp-auto-sig fp-auto-signature" placeholder="（留空则不加，如：—— 由 AI 助理代回）" /></label>
			</div>
			<div class="fp-auto-row">
				<button class="fp-auto-save" style="${BUTTON_PRIMARY}">保存并生效</button>
				<button class="fp-auto-preview-btn" style="${BUTTON}">预览会发什么</button>
				<span class="fp-auto-state"><span class="fp-auto-dot"></span><span class="fp-auto-state-text">读取中…</span></span>
			</div>
			<div class="fp-auto-msg fp-auto-hint"></div>
			<textarea class="fp-auto-preview" readonly placeholder="点「预览会发什么」，选白名单里第一个会话拉最近一条消息，看看模型会收到什么提示词。"></textarea>
			<div class="fp-auto-msg">最近自动回复</div>
			<div class="fp-auto-list"><div class="fp-auto-msg">还没有记录</div></div>
		</div>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elEnabled = $(".fp-auto-enabled");
	const elDry = $(".fp-auto-dry");
	const elAs = $(".fp-auto-as");
	const elCooldown = $(".fp-auto-cooldown");
	const elCap = $(".fp-auto-cap");
	const elIds = $(".fp-auto-ids");
	const elSig = $(".fp-auto-signature");
	const elStateText = $(".fp-auto-state-text");
	const elDot = $(".fp-auto-dot");
	const elHint = $(".fp-auto-hint");
	const elPreview = $(".fp-auto-preview");
	const elList = $(".fp-auto-list");
	const btnSave = $(".fp-auto-save");
	const btnPreview = $(".fp-auto-preview-btn");

	let busy = false;
	let disposed = false;
	let state = null;

	function paint() {
		if (!state) return;
		const cfg = state.config || {};
		elEnabled.checked = Boolean(cfg.enabled);
		elDry.checked = Boolean(cfg.dryRun);
		elAs.value = cfg.as === "bot" ? "bot" : "user";
		elCooldown.value = String(cfg.cooldownSec ?? 20);
		elCap.value = String(cfg.maxPerHour ?? 20);
		elIds.value = String(cfg.chatIds ?? "");
		elSig.value = String(cfg.signature ?? "");

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
								r.error ? `<span class="fp-auto-dry" style="color:var(--danger,#d0453a)">${esc(r.error)}</span>` : ""
							}</div>
							<div class="fp-auto-ask">← ${esc(r.ask)}</div>
							<div class="fp-auto-reply">→ ${esc(r.reply || "（未发送）")}</div>
						</div>`,
					)
					.join("")
			: `<div class="fp-auto-msg">还没有记录</div>`;
	}

	async function refresh() {
		if (disposed) return;
		try {
			state = await call("/auto/state");
			paint();
		} catch (err) {
			elHint.textContent = `读取失败：${err?.message || err}`;
			elHint.className = "fp-auto-msg fp-auto-hint err";
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
		if (busy) return;
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

	btnSave?.addEventListener("click", () =>
		withBusy(async () => {
			state = await call("/auto/config", { method: "POST", body: patch() });
			paint();
		}),
	);

	btnPreview?.addEventListener("click", () =>
		withBusy(async () => {
			const ids = String(elIds.value || "")
				.split(/[\s,;]+/)
				.map((s) => s.trim())
				.filter((s) => s.startsWith("oc_"));
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

	void refresh();

	return {
		refresh,
		destroy() {
			disposed = true;
			wrap.remove();
		},
	};
}
