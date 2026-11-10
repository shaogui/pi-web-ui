/**
 * plugins/feishu-pro/client/diagnostics-panel.mjs
 * 「诊断与数据」的表单体：指标条 / 会话清单 / 提醒历史 / 危险操作 —— 由设置页 ④ 区挂载。
 *
 * 为什么单独成模块：
 *   ① 设置页的 shell 只该管"分区导航 + 每个分区怎么摆"，不该替某一块画 4 个指标卡 + 一张表；
 *   ② 这块的数据全部来自 `/sync/state`（与 ② 同一份），所以它**不自己拉**：
 *      设置页拉到状态后 `apply(state)` 推进来；危险操作改完东西再通过 `onChanged()` 让设置页重拉，
 *      避免"面板里清了缓存、别的卡片还显示旧数字"。
 *
 * 危险操作放这里（而不是 ② 的保存按钮旁边）是刻意的：
 *   清空缓存 / 重新发现会话会把本地数据或飞书接口真的动一遍，与"改个开关"不是同一个心理动作。
 *   所以它单独一块红框、单独一行说明、清空缓存还要二次确认（点一次只上膛，3 秒不动自己复位）。
 */

const STYLE_ID = "fp-diag-styles";
/** 危险操作的二次确认窗口：过了这段时间按钮自己复原（避免"上一次怒气"生效）。 */
const CONFIRM_MS = 3_000;
/** 会话清单默认显示几行（其余靠「显示全部」或过滤）。 */
const ROW_LIMIT = 8;

const STYLES = `
.fp-diag{display:flex;flex-direction:column;gap:12px;}
.fp-diag-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:10px;}
.fp-diag-metric{display:flex;flex-direction:column;gap:3px;min-width:0;padding:9px 11px;border-radius:9px;border:1px solid var(--border);background:var(--bg);}
.fp-diag-metric-label{font-size:11px;line-height:1.5;color:var(--text-dim);}
.fp-diag-metric-value{font-size:13px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
.fp-diag-metric-sub{font-size:11px;line-height:1.6;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-diag-note{font-size:11.5px;line-height:1.75;color:var(--text-dim);overflow-wrap:anywhere;}
.fp-diag-note.err{color:var(--red);}
.fp-diag-note.ok{color:var(--green);}
.fp-diag-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.fp-diag-filter{flex:1;min-width:150px;}
.fp-diag-table{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:9px;overflow:hidden;background:var(--bg);}
.fp-diag-tr{display:grid;grid-template-columns:54px minmax(0,1.3fr) minmax(0,1.5fr) minmax(0,1fr);gap:10px;align-items:center;padding:7px 10px;font-size:11.5px;line-height:1.5;}
.fp-diag-tr-head{background:var(--bg-elev2);color:var(--text-dim);font-size:11px;font-weight:600;}
.fp-diag-tr:not(.fp-diag-tr-head){border-top:1px solid var(--border-soft);}
.fp-diag-tr:not(.fp-diag-tr-head):hover{background:var(--bg-elev2);}
.fp-diag-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-diag-cell-mono{font-family:var(--mono);font-size:11px;color:var(--text-dim);}
.fp-diag-cell-tail{font-variant-numeric:tabular-nums;color:var(--text-dim);text-align:right;}
.fp-diag-kind{display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:999px;border:1px solid var(--border);color:var(--text-faint);font-size:10px;line-height:1.7;}
.fp-diag-kind.p2p{color:var(--accent);border-color:var(--accent);}
.fp-diag-kind.group{color:var(--green);border-color:var(--green);}
.fp-diag-empty{padding:12px;border:1px dashed var(--border);border-radius:9px;font-size:11.5px;line-height:1.7;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-diag-remind{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;}
.fp-diag-remind-item{display:flex;gap:8px;align-items:baseline;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid var(--border-soft);background:var(--bg);}
.fp-diag-when{flex:0 0 auto;font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums;}
.fp-diag-who{flex:0 0 auto;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;}
.fp-diag-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-dim);}
.fp-diag-danger{display:flex;flex-direction:column;gap:9px;padding:12px 13px;border-radius:9px;border:1px solid var(--red);background:var(--red-soft);}
.fp-diag-danger-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--red);}
.fp-diag-danger-desc{font-size:11px;line-height:1.75;color:var(--text-dim);overflow-wrap:anywhere;}
.fp-diag-danger-actions{display:flex;gap:8px;flex-wrap:wrap;}
.fp-diag-danger-actions .fp-btn[data-armed="1"]{border-color:var(--red);background:var(--red);color:var(--on-red,#1a1a1a);font-weight:600;}
@media (max-width:560px){
	.fp-diag-tr{grid-template-columns:48px minmax(0,1fr) minmax(0,0.9fr);}
	.fp-diag-cell-id{display:none;}
}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

const esc = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);

/** "3 分钟前"：诊断区只关心"多久以前"。 */
function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta <= 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/** 缓存体积的人话（storage 是一整个 JSON 文件，这个数字关系到"会不会拖慢别的功能"）。 */
function sizeLabel(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 挂载表单体。
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {(path: string, init?: object) => Promise<any>} opts.call 传输层（设置页提供）
 * @param {() => Promise<void>} [opts.onChanged] 危险操作完成后请设置页重拉一次状态
 * @returns {{ apply: (state: any) => void, destroy: () => void }}
 */
export function mountDiagnosticsPanel(container, { call, onChanged } = {}) {
	const noop = { apply: () => {}, destroy: () => {} };
	if (!container || typeof container.appendChild !== "function" || typeof call !== "function") return noop;
	injectStyles();

	const wrap = document.createElement("div");
	wrap.className = "fp-diag";
	wrap.innerHTML = `
		<div class="fp-diag-metrics">
			${[
				["同步状态", "run-value", "run-sub"],
				["本地消息缓存", "cache-value", "cache-sub"],
				["上一轮拉取", "poll-value", "poll-sub"],
				["候选会话", "cand-value", "cand-sub"],
			]
				.map(
					([label, value, sub]) => `<div class="fp-diag-metric">
						<span class="fp-diag-metric-label">${esc(label)}</span>
						<span class="fp-diag-metric-value" data-field="${value}">读取中…</span>
						<span class="fp-diag-metric-sub" data-field="${sub}"></span>
					</div>`,
				)
				.join("")}
		</div>
		<div class="fp-diag-note fp-diag-head" hidden></div>
		<div class="fp-diag-toolbar">
			<input class="fp-input fp-diag-filter" placeholder="过滤会话（名称 / chat_id / 类型）…" spellcheck="false" />
			<button class="fp-btn fp-btn-sm fp-diag-more" type="button" hidden>显示全部</button>
		</div>
		<div class="fp-diag-table fp-diag-chats" role="table" aria-label="正在同步的会话"></div>
		<div class="fp-diag-note">最近提醒</div>
		<div class="fp-diag-remind fp-diag-history"></div>
		<div class="fp-diag-danger">
			<div class="fp-diag-danger-title"><span aria-hidden="true">⚠️</span><span>危险操作</span></div>
			<div class="fp-diag-danger-desc"><b>清空消息缓存</b>要再点一次确认（水位保留，不会把历史当新消息弹一遍）；<b>重新发现会话</b>会真的逐个探测飞书接口（限速约 1.7 QPS），多会话时要几十秒。</div>
			<div class="fp-diag-danger-actions">
				<button class="fp-btn fp-btn-sm fp-diag-discover" type="button">重新发现会话</button>
				<button class="fp-btn fp-btn-sm fp-diag-clear" type="button" data-armed="0">清空消息缓存</button>
			</div>
			<div class="fp-diag-note fp-diag-danger-note" hidden></div>
		</div>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elHead = $(".fp-diag-head");
	const elChats = $(".fp-diag-chats");
	const elHistory = $(".fp-diag-history");
	const elFilter = $(".fp-diag-filter");
	const btnMore = $(".fp-diag-more");
	const btnDiscover = $(".fp-diag-discover");
	const btnClear = $(".fp-diag-clear");
	const elDangerNote = $(".fp-diag-danger-note");

	let state = null;
	let keyword = "";
	let expanded = false;
	let disposed = false;

	const notes = new WeakMap();

	/** 就地反馈：成功 4 秒淡出、错误常驻。 */
	function note(el, text, tone = "") {
		if (!el) return;
		const timer = notes.get(el);
		if (timer) clearTimeout(timer);
		if (!text) {
			el.hidden = true;
			el.textContent = "";
			el.className = el.dataset.baseClass || "";
			return;
		}
		el.hidden = false;
		el.textContent = text;
		el.className = `${el.dataset.baseClass || ""} ${tone}`.trim();
		if (tone !== "err")
			notes.set(
				el,
				setTimeout(() => note(el, ""), 4_000),
			);
	}
	for (const [el, cls] of [
		[elHead, "fp-diag-note fp-diag-head"],
		[elDangerNote, "fp-diag-note fp-diag-danger-note"],
	]) {
		if (el) el.dataset.baseClass = cls;
	}

	function setField(name, text) {
		const el = wrap.querySelector(`[data-field="${name}"]`);
		if (el) el.textContent = text;
	}

	const kindLabel = (c) => (c.explicit ? "手填" : c.kind === "group" ? "群" : c.kind === "p2p" ? "单聊" : "未知");

	/** 设置页拉到 `/sync/state` 后推过来（面板自己不拉，避免同一接口两处轮询）。 */
	function apply(next) {
		if (disposed) return;
		state = next || null;
		paint();
	}

	function paint() {
		const st = state;
		const cfg = st?.config || {};
		const cache = st?.cache || {};
		const last = st?.lastPoll || {};
		const cand = st?.candidates || {};
		const disc = st?.discovered || {};
		const error = String(st?.lastError || disc.error || "");

		/* 指标 */
		setField(
			"run-value",
			!st
				? "读取中…"
				: st.running
					? `运行中 · 每 ${cfg.intervalSec ?? 60} 秒`
					: cfg.enabled
						? "已启用，等待首轮"
						: "未启用",
		);
		setField(
			"run-sub",
			!st
				? ""
				: [
						cfg.autoDiscover ? "自动发现私聊" : "",
						cfg.syncGroups ? "同步群聊" : "群聊不同步",
						cfg.notify === false ? "不弹通知" : cfg.notifyGroups ? "群也弹通知" : "群静默",
					]
						.filter(Boolean)
						.join(" · "),
		);
		setField("cache-value", !st ? "读取中…" : cache.chats ? `${cache.chats} 个会话 · ${cache.rows} 条` : "空");
		setField(
			"cache-sub",
			!st
				? ""
				: cache.chats
					? `${sizeLabel(cache.bytes)}${cache.lastFetchedAt ? ` · 最后写入 ${ago(cache.lastFetchedAt)}` : ""}`
					: "同步过或用过的会话才会进来",
		);
		setField(
			"poll-value",
			last.at ? ago(last.at) || "刚刚" : st?.lastPollAt ? `检查 ${ago(st.lastPollAt)}` : "还没跑过",
		);
		setField("poll-sub", last.at ? `${last.chats} 会话 / ${last.rows} 条 / 新增 ${last.fresh}` : "");
		setField(
			"cand-value",
			disc.at ? `${disc.total} 个（单聊 ${disc.p2p} / 群 ${disc.groups}）` : cand.total ? `${cand.total} 个` : "未发现",
		);
		setField(
			"cand-sub",
			disc.at && cfg.syncGroups && disc.groups === 0
				? "飞书没返回群会话"
				: disc.at && disc.p2p === 0
					? "飞书没返回单聊会话 → 请手填 chat_id"
					: st?.channel?.ready === false
						? "lark-cli 未就绪"
						: "",
		);

		/* 诊断行：只写"有行动价值"的东西，不铺原始 JSON */
		const bad = (Array.isArray(st?.chats) ? st.chats : []).filter((c) => c.lastError).length;
		const bits = [];
		if (error) bits.push(error);
		if (bad) bits.push(`${bad} 个会话同步失败（见下表）`);
		if (st && !st.authorized) bits.push("需要先在 ① 完成登录");
		if (bits.length) note(elHead, bits.join("；"), "err");
		else note(elHead, "");

		/* 会话清单 */
		const chats = Array.isArray(st?.chats) ? st.chats : [];
		const kw = keyword.trim().toLowerCase();
		const matched = kw
			? chats.filter((c) =>
					`${c.name || ""} ${c.id || ""} ${c.kind || ""} ${c.explicit ? "手填" : ""}`.toLowerCase().includes(kw),
				)
			: chats;
		const shown = expanded ? matched : matched.slice(0, ROW_LIMIT);
		if (btnMore) {
			btnMore.hidden = matched.length <= ROW_LIMIT;
			btnMore.textContent = expanded ? "收起" : `显示全部（${matched.length}）`;
		}
		if (!st) {
			elChats.innerHTML = `<div class="fp-diag-empty">读取中…</div>`;
		} else if (!chats.length) {
			elChats.innerHTML = `<div class="fp-diag-empty">还没有可同步的会话：在「② 消息同步与提醒」勾上同步范围，或手填 chat_id。</div>`;
		} else if (!matched.length) {
			elChats.innerHTML = `<div class="fp-diag-empty">没有匹配「${esc(keyword)}」的会话。</div>`;
		} else {
			elChats.innerHTML =
				`<div class="fp-diag-tr fp-diag-tr-head"><span>类型</span><span>名称</span><span class="fp-diag-cell-id">chat_id</span><span class="fp-diag-cell-tail">同步 / 缓存 / 未读</span></div>` +
				shown
					.map((c) => {
						// 手填会话单独一档配色：它的"类型"是来源（手填），不是单聊/群
						const kindClass = c.explicit ? "" : c.kind || "";
						const tail = [
							c.syncedAt ? ago(c.syncedAt) : "未同步",
							c.cachedRows ? `${c.cachedRows} 条` : "",
							c.unread ? `未读 ${c.unread}` : "",
						]
							.filter(Boolean)
							.join(" · ");
						return `<div class="fp-diag-tr">
							<span><span class="fp-diag-kind ${esc(kindClass)}">${esc(kindLabel(c))}</span></span>
							<span class="fp-diag-cell" title="${esc(c.name || "")}">${esc(c.name || (c.kind === "group" ? "群聊" : "单聊"))}${
								c.lastError ? ` <span style="color:var(--red)">（${esc(c.lastError)}）</span>` : ""
							}</span>
							<span class="fp-diag-cell fp-diag-cell-mono fp-diag-cell-id" title="${esc(c.id)}">${esc(c.id)}</span>
							<span class="fp-diag-cell fp-diag-cell-tail" title="${esc(tail)}">${esc(tail)}</span>
						</div>`;
					})
					.join("");
		}

		/* 提醒历史 */
		const history = Array.isArray(st?.history) ? st.history : [];
		elHistory.innerHTML = history.length
			? history
					.slice(0, 12)
					.map(
						(item) => `<div class="fp-diag-remind-item">
							<span class="fp-diag-when">${esc(ago(item.at) || "刚刚")}</span>
							<span class="fp-diag-who">${esc(item.senderName || item.chatName || "会话")}${item.chatKind === "group" ? "（群）" : ""}</span>
							<span class="fp-diag-text" title="${esc(item.text)}">${esc(item.text)}</span>
						</div>`,
					)
					.join("")
			: `<div class="fp-diag-empty">还没有提醒记录（首轮只建基线；自己发的不报）。</div>`;
	}

	function armConfirm(btn) {
		btn.dataset.armed = "1";
		btn.textContent = "确认清空";
		btn.dataset.timer = String(setTimeout(() => disarmConfirm(btn), CONFIRM_MS));
	}

	function disarmConfirm(btn) {
		const timer = Number(btn.dataset.timer || 0);
		if (timer) clearTimeout(timer);
		btn.dataset.armed = "0";
		btn.dataset.timer = "0";
		btn.textContent = "清空消息缓存";
	}

	wrap.addEventListener("click", async (ev) => {
		const target = ev.target instanceof Element ? ev.target : null;
		if (!target || disposed) return;

		if (target.closest(".fp-diag-more")) {
			expanded = !expanded;
			paint();
			return;
		}
		const discoverBtn = target.closest(".fp-diag-discover");
		if (discoverBtn instanceof HTMLButtonElement) {
			discoverBtn.disabled = true;
			note(elDangerNote, "正在重新发现会话…（会逐个探测飞书接口，多会话时可能要几十秒）");
			try {
				await call("/dm/discover", { method: "POST", timeoutMs: 180_000 });
				await onChanged?.();
				note(elDangerNote, "已重新发现会话", "ok");
			} catch (err) {
				note(elDangerNote, `发现失败：${err?.message || err}`, "err");
			} finally {
				discoverBtn.disabled = false;
			}
			return;
		}
		const clearBtn = target.closest(".fp-diag-clear");
		if (clearBtn instanceof HTMLButtonElement) {
			// 二次确认：第一次点击只是"上膛"，3 秒内再点才真清。
			if (clearBtn.dataset.armed !== "1") {
				armConfirm(clearBtn);
				note(elDangerNote, "再点一次「确认清空」才会真的清空本地消息缓存（水位保留，下一轮只补最近的消息）。");
				return;
			}
			disarmConfirm(clearBtn);
			clearBtn.disabled = true;
			try {
				await call("/sync/clear", { method: "POST" });
				await onChanged?.();
				note(elDangerNote, "已清空本地消息缓存（水位保留：不会把历史当新消息弹一遍）", "ok");
			} catch (err) {
				note(elDangerNote, `清空失败：${err?.message || err}`, "err");
			} finally {
				clearBtn.disabled = false;
			}
		}
	});

	// 过滤框：只重画表格，不重画整页（打字时光标不跳）。
	elFilter?.addEventListener("input", (ev) => {
		keyword = String(ev.target?.value || "");
		expanded = false;
		paint();
	});

	paint();

	return {
		apply,
		destroy() {
			disposed = true;
			wrap.remove();
		},
	};
}
