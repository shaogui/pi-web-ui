/**
 * plugins/feishu-pro/client/todo-view.mjs
 * 「待办」页签：AI 帮我盯着、给建议，必要时一键让它替我处理。
 *
 * 为什么单独一个模块：entry.mjs 里已经是一整段巨型模板字符串，再塞进列表 + 建议块 +
 * 动作按钮 + 内联编辑 + 提取候选，改动面会失控。这里只依赖宿主传进来的 `call`（同一传输层）
 * 与 `compose`（插入对话输入框），自己管 DOM 与状态。
 *
 * 四条约束（与前几个页签同口径）：
 *   1. 所有插值一律 esc()：标题/正文来自消息与模型，都属于不可信输入；
 *   2. 打字过程中**不整页重渲染**（内联编辑期间跳过自动刷新，否则光标会跳）；
 *   3. 对外动作（发消息 / 派 agent）必须**先看见再执行**：reply 先展开草稿，agent 先 confirm；
 *   4. 失败只写在行内提示里，不把已有列表清空。
 */

import { esc } from "@pi-web-ui/plugin-sdk/client";

const STYLE_ID = "fp-todo-styles";

const STYLES = `
.fp-td{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;}
.fp-td-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 12px;border-bottom:1px solid var(--border);}
.fp-td-new{flex:1 1 220px;max-width:420px;min-width:140px;padding:5px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;outline:none;}
.fp-td-new:focus{border-color:var(--accent);}
.fp-td-segs{display:inline-flex;gap:1px;padding:2px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);}
.fp-td-seg{border:none;background:transparent;color:var(--text-dim);font:inherit;font-size:11px;line-height:1.5;padding:3px 9px;border-radius:5px;cursor:pointer;white-space:nowrap;}
.fp-td-seg:hover{color:var(--text);}
.fp-td-seg.on{background:var(--bg);color:var(--text);font-weight:600;}
.fp-td-q{width:118px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:11.5px;outline:none;}
.fp-td-q:focus{border-color:var(--accent);}
.fp-td-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:11.5px;line-height:1.35;cursor:pointer;white-space:nowrap;}
.fp-td-btn:hover{border-color:var(--accent);color:var(--accent);}
.fp-td-btn[disabled]{opacity:.5;cursor:not-allowed;}
.fp-td-btn.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:600;}
.fp-td-primary{border-color:var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);font-weight:600;}
.fp-td-primary:hover{color:var(--accent-contrast,#fff);filter:brightness(1.06);}
.fp-td-danger:hover{border-color:var(--red);color:var(--red);}
/* 行内图标按钮：默认低对比，hover 才亮 —— 一屏能多看几条 */
.fp-td-op{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;padding:0;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--text-faint);font:inherit;font-size:12px;line-height:1;cursor:pointer;}
.fp-td-op:hover{background:var(--bg-elev2);border-color:var(--border);color:var(--accent);}
.fp-td-op.danger:hover{border-color:var(--red);color:var(--red);}
.fp-td-op.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);}
.fp-td-note{padding:5px 12px;font-size:11px;line-height:1.6;color:var(--text-dim);border-bottom:1px solid var(--border);overflow-wrap:anywhere;}
.fp-td-note.err{color:var(--red);}
.fp-td-note.ok{color:var(--green);}
.fp-td-cands{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-elev);}
.fp-td-cand{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;border:1px solid var(--border-soft);background:var(--bg);min-width:0;}
.fp-td-cand-main{flex:1;min-width:0;display:flex;align-items:baseline;gap:7px;}
.fp-td-cand-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%;}
.fp-td-cand-sub{flex:1;min-width:0;font-size:10.8px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-list{flex:1;min-height:0;overflow:auto;padding:5px 9px 26px;display:flex;flex-direction:column;gap:3px;}
.fp-td-empty{padding:22px 16px;text-align:center;font-size:12px;line-height:1.9;color:var(--text-faint);}
.fp-td-card{display:flex;flex-direction:column;padding:5px 8px 5px 7px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev);min-width:0;}
.fp-td-card:hover{border-color:var(--border);background:var(--bg-elev2);}
.fp-td-card.done{opacity:.66;}
.fp-td-card.doing{border-color:var(--accent);}
.fp-td-row{display:flex;align-items:flex-start;gap:7px;min-width:0;}
.fp-td-check{flex:0 0 auto;width:15px;height:15px;margin-top:2px;border-radius:50%;border:1px solid var(--border);background:var(--bg);color:var(--text-dim);font-size:9px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}
.fp-td-check:hover{border-color:var(--accent);color:var(--accent);}
.fp-td-check.on{border-color:var(--green);background:var(--green-soft);color:var(--green);}
.fp-td-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
/* 标题与标签同一行：宽度不够时标签折到下一行，标题先让位（省略号） */
.fp-td-line{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0;}
.fp-td-title{flex:1 1 auto;min-width:80px;font-size:12.5px;font-weight:600;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* 展开态才允许换行：默认一条待办就是**一行**，靠省略号省高度 */
.fp-td-card.expanded .fp-td-title{white-space:normal;overflow:visible;overflow-wrap:anywhere;word-break:break-word;}
.fp-td-card.done .fp-td-title{text-decoration:line-through;color:var(--text-dim);}
.fp-td-meta{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;flex-wrap:nowrap;font-size:10px;color:var(--text-faint);}
.fp-td-chip{padding:0 5px;border-radius:999px;border:1px solid var(--border);line-height:1.65;white-space:nowrap;font-size:10px;}
.fp-td-chip.accent{color:var(--accent);border-color:var(--accent);}
.fp-td-chip.warn{color:var(--amber);border-color:var(--amber);}
.fp-td-chip.bad{color:var(--red);border-color:var(--red);}
.fp-td-chip.ok{color:var(--green);border-color:var(--green);}
button.fp-td-chip{background:transparent;font:inherit;font-size:10px;cursor:pointer;line-height:1.65;}
button.fp-td-chip:hover{color:var(--accent);border-color:var(--accent);}
.fp-td-ops{flex:0 0 auto;display:flex;align-items:center;gap:1px;margin:-2px -2px 0 0;}
/* 正文默认单行省略：想看全文点「展开」 */
.fp-td-detail{font-size:11.5px;line-height:1.6;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-detail.full{white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere;word-break:break-word;border-left:2px solid var(--border);padding-left:8px;}
.fp-td-advice{display:flex;flex-direction:column;gap:3px;margin-top:1px;padding:4px 7px;border-radius:6px;border:1px solid var(--border-soft);background:var(--bg);}
.fp-td-advice-line{display:flex;align-items:center;gap:6px;min-width:0;}
.fp-td-badge{flex:0 0 auto;font-size:9px;font-weight:700;letter-spacing:.3px;padding:0 4px;border-radius:4px;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);line-height:1.6;}
.fp-td-summary{flex:1;min-width:0;font-size:11.6px;line-height:1.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-summary.full{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;}
.fp-td-at{flex:0 0 auto;font-size:10px;color:var(--text-faint);white-space:nowrap;}
.fp-td-steps{margin:1px 0 0;padding-left:16px;font-size:11px;line-height:1.7;color:var(--text-dim);}
.fp-td-steps > li{overflow-wrap:anywhere;word-break:break-word;}
.fp-td-acts{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.fp-td-acts .fp-td-btn{padding:2px 7px;font-size:11px;}
.fp-td-draft{display:flex;flex-direction:column;gap:5px;padding:6px 8px;border-radius:7px;border:1px dashed var(--accent);background:var(--accent-soft);}
.fp-td-draft-body{font-size:11.8px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:var(--text);}
.fp-td-draft-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--text-dim);}
.fp-td-hist{display:flex;flex-direction:column;gap:1px;font-size:10.5px;line-height:1.6;color:var(--text-faint);}
.fp-td-hist-row{display:flex;gap:6px;overflow-wrap:anywhere;word-break:break-word;}
.fp-td-edit{display:flex;flex-direction:column;gap:5px;}
.fp-td-edit input,.fp-td-edit textarea,.fp-td-edit select{padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;outline:none;width:100%;}
.fp-td-edit textarea{min-height:56px;resize:vertical;}
.fp-td-edit input:focus,.fp-td-edit textarea:focus,.fp-td-edit select:focus{border-color:var(--accent);}
.fp-td-edit-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.fp-td-edit-row > select{width:auto;min-width:90px;}
.fp-td-edit-row > input[type="date"],.fp-td-edit-row > input[type="datetime-local"]{width:auto;}
/* 新建时的「同步飞书」勾选：默认不勾（建远程任务是显式动作），未就绪时禁用 + title 说明 */
.fp-td-chk{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.5;color:var(--text-dim);white-space:nowrap;cursor:pointer;}
.fp-td-chk input{width:12px;height:12px;margin:0;accent-color:var(--accent);cursor:pointer;}
.fp-td-chk:hover{color:var(--text);}
.fp-td-chk input[disabled]{cursor:not-allowed;}
.fp-td-chk:has(input[disabled]){opacity:.5;cursor:not-allowed;}
/* 自动获取间隔：紧凑 select，和「自动」按钮成一组 */
.fp-td-int{padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:11px;line-height:1.5;outline:none;cursor:pointer;}
.fp-td-int:hover{border-color:var(--accent);}
.fp-td-cand-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--text-faint);}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLES;
	document.head.appendChild(style);
}

/* ------------------------------- 纯展示函数 ------------------------------- */

const PRIORITY_LABEL = { low: "低", normal: "常规", high: "重要", urgent: "紧急" };
const STATUS_LABEL = { open: "待处理", doing: "AI 处理中", done: "已完成", dropped: "搁置" };
const SOURCE_LABEL = { manual: "手动", feishu: "飞书任务", extract: "消息提取", agent: "AI 记录" };

const two = (n) => String(n).padStart(2, "0");
function clockOf(ms) {
	const t = Number(ms);
	if (!Number.isFinite(t) || t <= 0) return "";
	const d = new Date(t);
	return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function dayStart(ms) {
	const d = new Date(Number(ms) || Date.now());
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** 截止时间的人话（服务端口径：今天的边界按本地时区）。 */
export function formatDue(todo, now = Date.now()) {
	const due = Number(todo?.dueAt) || 0;
	if (!due) return "";
	const diffDays = Math.round((dayStart(due) - dayStart(now)) / 86_400_000);
	const clock = `${two(new Date(due).getHours())}:${two(new Date(due).getMinutes())}`;
	const atMidnight = new Date(due).getHours() === 0 && new Date(due).getMinutes() === 0;
	const suffix = atMidnight ? "" : ` ${clock}`;
	if (todo?.status === "done" || todo?.status === "dropped")
		return `${two(new Date(due).getMonth() + 1)}-${two(new Date(due).getDate())}`;
	if (due < now) return `已逾期 ${Math.abs(diffDays) || 1} 天`;
	if (diffDays === 0) return `今天${suffix}`;
	if (diffDays === 1) return `明天${suffix}`;
	if (diffDays > 1 && diffDays <= 6) return `${diffDays} 天后${suffix}`;
	return `${two(new Date(due).getMonth() + 1)}-${two(new Date(due).getDate())}${suffix}`;
}

export function dueTone(todo, now = Date.now()) {
	const due = Number(todo?.dueAt) || 0;
	if (!due || todo?.status === "done" || todo?.status === "dropped") return "";
	if (due < now) return "bad";
	if (due < dayStart(now) + 86_400_000) return "warn";
	return "";
}

/** 建议是否还新鲜（与 lib/todo-store.mjs 的 isAdviceFresh 同口径，前端只用来决定要不要自动算）。 */
export function adviceFresh(todo, now = Date.now(), ttlMs = 6 * 60 * 60_000) {
	if (!todo?.advice) return false;
	const muted = Number(todo.adviceMutedAt) || 0;
	if (muted && muted >= (Number(todo.advice.at) || 0)) return false;
	return now - (Number(todo.advice.at) || 0) < ttlMs;
}

/** 三个分段：待处理（含 AI 处理中）/ 全部 / 已完成（含搁置）。 */
export function filterTodos(items, { seg = "active", query = "" } = {}) {
	const needle = String(query ?? "")
		.trim()
		.toLowerCase();
	return (Array.isArray(items) ? items : []).filter((todo) => {
		const status = String(todo?.status || "open");
		if (seg === "active" && status !== "open" && status !== "doing") return false;
		if (seg === "done" && status !== "done" && status !== "dropped") return false;
		if (!needle) return true;
		const hay = [
			todo?.title,
			todo?.detail,
			todo?.ref?.title,
			todo?.ref?.sender,
			todo?.advice?.summary,
			...(Array.isArray(todo?.advice?.steps) ? todo.advice.steps : []),
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return hay.includes(needle);
	});
}

/**
 * 标签行：默认只放「截止 + 优先级 + 处理中」，来源/发送者这类不常看的挪到展开态。
 * 紧凑优先 —— 一屏能多看几条，比每条都摊开来源重要。
 */
function metaHtml(todo, now, { full = false } = {}) {
	const chips = [];
	const due = formatDue(todo, now);
	if (due) chips.push(`<span class="fp-td-chip ${dueTone(todo, now)}" title="截止时间">🕒 ${esc(due)}</span>`);
	const priority = String(todo?.priority || "normal");
	if (priority !== "normal") {
		chips.push(
			`<span class="fp-td-chip ${priority === "urgent" ? "bad" : priority === "high" ? "warn" : ""}" title="优先级 ${esc(PRIORITY_LABEL[priority] || priority)}">${esc(PRIORITY_LABEL[priority] || priority)}</span>`,
		);
	}
	const status = String(todo?.status || "open");
	if (status === "doing") chips.push('<span class="fp-td-chip accent">AI 处理中</span>');
	if (status === "dropped") chips.push('<span class="fp-td-chip">已搁置</span>');
	// 与飞书任务联动的条目：紧凑行就给一个信号（同步了却没标出来，人会以为白扩了）。
	if (todo?.ref?.kind === "task") chips.push('<span class="fp-td-chip accent" title="和飞书任务双向同步">飞书</span>');
	if (full) {
		const source = String(todo?.source || "manual");
		// 来源本身就是飞书任务的条目，上面已经有「飞书」标签，不再重复。
		if (source !== "feishu")
			chips.push(`<span class="fp-td-chip" title="来源">${esc(SOURCE_LABEL[source] || source)}</span>`);
		if (todo?.ref?.sender)
			chips.push(`<span class="fp-td-chip" title="来源会话">${esc(String(todo.ref.sender).slice(0, 16))}</span>`);
	}
	return chips.join("");
}

/**
 * 建议块：**一句话判断一行 + 动作一行**，步骤与时间去后台。
 * 之前把 4 条步骤全摊开，一条待办就吃掉半屏 —— 建议是"扫一眼"的东西，不是文档。
 */
function adviceHtml(todo, now, ttlMs, { expanded = false } = {}) {
	const advice = todo?.advice;
	if (!advice) return "";
	const steps = Array.isArray(advice.steps) ? advice.steps : [];
	const actions = Array.isArray(advice.actions) ? advice.actions : [];
	const stale = !adviceFresh(todo, now, ttlMs);
	const stepList =
		expanded && steps.length
			? `<ol class="fp-td-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`
			: "";
	const stepChip = steps.length
		? `<button class="fp-td-chip" data-act="${expanded ? "collapse" : "expand"}" data-id="${esc(todo.id)}" title="${
				expanded ? "收起步骤" : "展开步骤"
			}">${expanded ? "收起" : `${steps.length} 步`}</button>`
		: "";
	const buttons = actions
		.map((action) => {
			const ran = Boolean(action?.ranAt);
			// 发送类按钮用主色：这是唯一会"对外说话"的动作，视觉上必须和别的按钮分开。
			const cls = action?.kind === "reply" ? "fp-td-btn fp-td-primary" : "fp-td-btn";
			const icon = { reply: "✉️", agent: "🤖", insert: "⌨️", open: "↗" }[action?.kind] || "▶";
			return `<button class="${cls}" data-act="run" data-id="${esc(todo.id)}" data-aid="${esc(action.id)}" data-kind="${esc(action.kind)}" ${
				ran ? "disabled" : ""
			}>${icon} ${esc(action.label || action.kind)}${ran ? " · 已执行" : ""}</button>`;
		})
		.join("");
	return `
		<div class="fp-td-advice">
			<div class="fp-td-advice-line">
				<span class="fp-td-badge">AI</span>
				<span class="fp-td-summary ${expanded ? "full" : ""}" title="${esc(advice.summary || "")}">${esc(advice.summary || "（没有一句话判断）")}</span>
				${stepChip}
				<span class="fp-td-at" title="${esc(clockOf(advice.at))}${stale ? "（可重算）" : ""}">${esc(clockOf(advice.at))}</span>
			</div>
			${stepList}
			<div class="fp-td-acts">
				${buttons}
				<button class="fp-td-btn" data-act="advise-one" data-id="${esc(todo.id)}" title="重新生成这条建议">重算</button>
				<button class="fp-td-btn" data-act="mute" data-id="${esc(todo.id)}" title="这条建议没用：清掉，下次换个说法">没用</button>
			</div>
			<div class="fp-td-draft-slot" data-slot="draft" data-id="${esc(todo.id)}" hidden></div>
		</div>`;
}

function historyHtml(todo) {
	const rows = Array.isArray(todo?.history) ? todo.history.slice(0, 4) : [];
	if (!rows.length) return "";
	return `<div class="fp-td-hist">${rows
		.map(
			(row) =>
				`<div class="fp-td-hist-row"><span>${esc(clockOf(row.at))}</span><span>${esc(row.text || row.kind)}</span></div>`,
		)
		.join("")}</div>`;
}

/** 行尾图标按钮：图标 + title 兜底可读性（不放文字，省一整列宽度）。 */
function opHtml({ act, id, glyph, label, cls = "" }) {
	return `<button class="fp-td-op ${cls}" data-act="${esc(act)}" data-id="${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}">${glyph}</button>`;
}

/**
 * 单张卡片（导出给单测：保证"完成态/建议/动作按钮/逾期色"这几个可见事实）。
 * 布局目标：**一条待办一行**（标题 + 截止 + 优先级 + 图标操作），建议再占一行；
 * 正文/步骤/历史/来源一律折叠到「展开」后面。
 * @param {object} todo
 * @param {{now?: number, ttlMs?: number, expanded?: boolean}} [opts]
 */
export function todoCardHtml(todo, { now = Date.now(), ttlMs = 6 * 60 * 60_000, expanded = false } = {}) {
	const status = String(todo?.status || "open");
	const closed = status === "done" || status === "dropped";
	const detail = String(todo?.detail || "").trim();
	const history = Array.isArray(todo?.history) ? todo.history : [];
	const hasMore = Boolean(detail) || history.length > 0;
	const ops = [
		closed ? "" : opHtml({ act: "advise-one", id: todo.id, glyph: "✦", label: "AI 建议" }),
		opHtml({ act: "edit", id: todo.id, glyph: "✎", label: "编辑" }),
		closed
			? opHtml({ act: "reopen", id: todo.id, glyph: "↺", label: "重新打开" })
			: opHtml({ act: "drop", id: todo.id, glyph: "⏸", label: "搁置" }),
		hasMore
			? opHtml({
					act: expanded ? "collapse" : "expand",
					id: todo.id,
					glyph: expanded ? "▴" : "▾",
					label: expanded ? "收起详情与历史" : "展开详情与历史",
					cls: expanded ? "on" : "",
				})
			: "",
		opHtml({ act: "delete", id: todo.id, glyph: "🗑", label: "删除", cls: "danger" }),
	]
		.filter(Boolean)
		.join("");
	return `
		<div class="fp-td-card ${esc(status)} ${expanded ? "expanded" : ""}" data-id="${esc(todo.id)}">
			<div class="fp-td-row">
				<button class="fp-td-check ${closed ? "on" : ""}" data-act="toggle" data-id="${esc(todo.id)}" title="${
					closed ? "重新打开" : "标记完成"
				}">${closed ? "✓" : ""}</button>
				<div class="fp-td-main">
					<div class="fp-td-line">
						<span class="fp-td-title">${esc(todo.title || "（无标题）")}</span>
						<span class="fp-td-meta">${metaHtml(todo, now, { full: expanded })}</span>
					</div>
					${
						detail
							? `<div class="fp-td-detail ${expanded ? "full" : ""}" ${expanded ? "" : `title="${esc(detail)}"`}>${esc(
									detail,
								)}</div>`
							: ""
					}
					${expanded ? historyHtml(todo) : ""}
					${closed ? "" : adviceHtml(todo, now, ttlMs, { expanded })}
				</div>
				<div class="fp-td-ops">${ops}</div>
			</div>
		</div>`;
}

/* --------------------------------- 挂载 --------------------------------- */

/**
 * @param {object} deps
 * @param {HTMLElement} deps.panel  页签容器（`[data-panel="todos"]`）
 * @param {(path: string, init?: object) => Promise<any>} deps.call entry.mjs 的传输层
 * @param {(text: string, tone?: string) => void} [deps.say] 状态栏
 * @param {(text: string) => Promise<boolean>|boolean} [deps.compose] 插入对话输入框
 */
export function mountTodoView({ panel, call, say, compose } = {}) {
	if (!panel || typeof panel.appendChild !== "function" || typeof call !== "function") {
		return { refresh: async () => {}, destroy: () => {} };
	}
	injectStyles();

	const root = document.createElement("div");
	root.className = "fp-td";
	root.innerHTML = `
		<div class="fp-td-head">
			<input class="fp-td-new" placeholder="记一条待办：明天 10 点前给张总发周报（回车添加）…" />
			<button class="fp-td-btn fp-td-primary" data-act="add">添加</button>
			<label class="fp-td-chk" title="同时在飞书里创建这个任务，之后改标题/截止/完成都会同步回飞书">
				<input type="checkbox" class="fp-td-tf" /> 飞书
			</label>
			<div class="fp-td-segs">
				<button class="fp-td-seg on" data-seg="active">待处理</button>
				<button class="fp-td-seg" data-seg="all">全部</button>
				<button class="fp-td-seg" data-seg="done">已完成</button>
			</div>
			<input class="fp-td-q" placeholder="搜索…" />
			<button class="fp-td-btn" data-act="advise-batch" title="让 AI 逐条给出处理建议（逾期/今天优先）">AI 梳理</button>
			<button class="fp-td-btn" data-act="sync" title="读飞书任务并合并进本地待办">同步飞书任务</button>
			<button class="fp-td-btn" data-act="extract" title="从监听的会话里找「需要我做的事」">从消息提取</button>
			<button class="fp-td-btn" data-act="auto-toggle" title="后台定时同步飞书任务 + 从监听会话提取待办（默认关）">⏱ 自动</button>
			<select class="fp-td-int" title="自动获取间隔">
				<option value="15">15 分钟</option>
				<option value="30">30 分钟</option>
				<option value="60">60 分钟</option>
				<option value="120">2 小时</option>
			</select>
		</div>
		<div class="fp-td-note" style="display:none"></div>
		<div class="fp-td-cands-slot"></div>
		<div class="fp-td-list"></div>
	`;

	panel.appendChild(root);

	const $ = (sel) => root.querySelector(sel);
	const elNew = $(".fp-td-new");
	const elQ = $(".fp-td-q");
	const elNote = $(".fp-td-note");
	const elCands = $(".fp-td-cands-slot");
	const elList = $(".fp-td-list");
	const elTf = $(".fp-td-tf");
	const elInt = $(".fp-td-int");

	let snapshot = {
		items: [],
		candidates: [],
		config: {},
		stats: {},
		capabilities: {},
		adviceTtlMs: 6 * 60 * 60_000,
	};
	let seg = "active";
	let query = "";
	let editingId = "";
	let busy = false;
	const expanded = new Set();
	const advising = new Set();
	let pollTimer = null;
	let pollTicks = 0;
	let destroyed = false;
	let autoAdviseDone = false;

	const now = () => Date.now();
	const ttl = () => Number(snapshot.adviceTtlMs) || 6 * 60 * 60_000;
	const findTodo = (id) => (snapshot.items || []).find((todo) => todo.id === id) || null;
	const autoOn = () => Boolean(snapshot.config?.autoSync || snapshot.config?.autoExtract);

	function note(text, tone = "") {
		if (!elNote) return;
		if (!text) {
			elNote.style.display = "none";
			elNote.textContent = "";
			return;
		}
		elNote.style.display = "block";
		elNote.className = `fp-td-note ${tone}`;
		elNote.textContent = text;
	}

	function render() {
		const items = filterTodos(snapshot.items, { seg, query });
		const caps = snapshot.capabilities || {};
		// 能力门禁：没有 llm 就说不生成建议，而不是点了报错（先告诉用户缺什么）。
		for (const btn of root.querySelectorAll('[data-act="advise-batch"]')) {
			btn.disabled = !caps.advice;
			btn.title = caps.advice ? "让 AI 逐条给出处理建议（逾期/今天优先）" : "宿主未提供模型补全（llm 能力）";
		}
		for (const btn of root.querySelectorAll('[data-act="extract"]')) {
			btn.disabled = !caps.extract || !caps.advice;
			btn.title = caps.extract ? "从监听的会话里找「需要我做的事」" : "需要可读的飞书会话 + 模型补全";
		}
		for (const btn of root.querySelectorAll('[data-act="sync"]')) {
			btn.disabled = !caps.feishuTasks;
			btn.title = caps.feishuTasks
				? "读飞书任务并合并进本地待办"
				: "lark-cli 未就绪：飞书任务不可同步（本地待办仍然可用）";
		}
		// 自动获取：开关与间隔都从快照来（两个标签页同时开着也不会互相覆盖）。
		const cfg = snapshot.config || {};
		const on = autoOn();
		for (const btn of root.querySelectorAll('[data-act="auto-toggle"]')) {
			btn.classList.toggle("on", on);
			btn.textContent = on ? `⏱ 自动 · ${cfg.intervalMin || 30}分` : "⏱ 自动";
			btn.title = on
				? "已开启：后台定时同步飞书任务 + 提取消息待办（点一下关掉）"
				: "后台定时同步飞书任务并从监听会话提取待办（默认关，会花模型额度）";
		}
		if (elInt) elInt.value = String(cfg.intervalMin || 30);
		if (elTf) {
			elTf.disabled = !caps.taskWrite;
			elTf.parentElement.title = caps.taskWrite
				? "同时在飞书里创建这个任务，之后改标题/截止/完成都会同步回飞书"
				: "lark-cli 未就绪：不能在飞书建任务（仍可只存本地）";
		}
		renderCandidates();
		if (!items.length) {
			elList.innerHTML = `<div class="fp-td-empty">${
				seg === "done"
					? "还没有完成的待办。"
					: query
						? "没有匹配的待办。"
						: "还没有待办。<br/>上面输入框记一条，或点「从消息提取」让 AI 从监听的会话里找「需要我做的事」。"
			}</div>`;
			return;
		}
		elList.innerHTML = items
			.map((todo) => {
				if (editingId === todo.id) return editCardHtml(todo);
				return todoCardHtml(todo, { now: now(), ttlMs: ttl(), expanded: expanded.has(todo.id) });
			})
			.join("");
	}

	/**
	 * 待采纳候选：一律由服务端下发（自动提取也会落盘），前端只负责显示与点「记下」。
	 * 记住：候选正文来自聊天记录，属于不可信输入 —— 全部 esc()。
	 */
	function renderCandidates() {
		const list = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
		if (!list.length) {
			elCands.innerHTML = "";
			return;
		}
		elCands.innerHTML = `
			<div class="fp-td-cands">
				<div class="fp-td-cand-head">待采纳 ${list.length} 条（来自消息，点「记下」才进待办）<span style="flex:1"></span>
					<button class="fp-td-btn" data-act="cands-clear" title="全部收起：不建待办，下次提取重新找">收起</button>
				</div>
				${list
					.map(
						(item) => `
					<div class="fp-td-cand">
						<div class="fp-td-cand-main">
							<div class="fp-td-cand-title">${esc(item.title)}</div>
							<div class="fp-td-cand-sub">${esc(
								[item.detail, item.reason, item.dueAt ? formatDue({ dueAt: item.dueAt }) : ""]
									.filter(Boolean)
									.join(" · "),
							)}</div>
						</div>
						<button class="fp-td-btn fp-td-primary" data-act="adopt" data-cid="${esc(item.id)}" title="记进待办">记下</button>
					</div>`,
					)
					.join("")}
			</div>`;
	}

	/** 内联编辑器：只在编辑的那一张卡上替换，输入期间不重渲染。 */
	function editCardHtml(todo) {
		const due = Number(todo.dueAt) || 0;
		const dateValue = due ? new Date(due - new Date(due).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
		return `
			<div class="fp-td-card" data-id="${esc(todo.id)}">
				<div class="fp-td-edit">
					<input class="fp-td-edit-title" value="${esc(todo.title || "")}" placeholder="标题" />
					<textarea class="fp-td-edit-detail" placeholder="详细说明（原话、链接、背景…）">${esc(todo.detail || "")}</textarea>
					<div class="fp-td-edit-row">
						<select class="fp-td-edit-priority">
							${["low", "normal", "high", "urgent"]
								.map(
									(key) =>
										`<option value="${key}" ${todo.priority === key ? "selected" : ""}>${PRIORITY_LABEL[key]}</option>`,
								)
								.join("")}
						</select>
						<input type="datetime-local" class="fp-td-edit-due" value="${esc(dateValue)}" />
						<span style="flex:1"></span>
						<button class="fp-td-btn" data-act="edit-cancel" data-id="${esc(todo.id)}">取消</button>
						<button class="fp-td-btn fp-td-primary" data-act="edit-save" data-id="${esc(todo.id)}">保存</button>
					</div>
				</div>
			</div>`;
	}

	async function refresh({ quiet = false } = {}) {
		try {
			const payload = await call("/todos", { timeoutMs: 15000 });
			snapshot = {
				items: payload.items || [],
				candidates: payload.candidates || [],
				config: payload.config || {},
				nextAutoAt: payload.nextAutoAt || 0,
				stats: payload.stats || {},
				capabilities: payload.capabilities || {},
				adviceTtlMs: payload.adviceTtlMs || 6 * 60 * 60_000,
				syncedAt: payload.syncedAt || 0,
			};
			render();
			if (!quiet) {
				const stats = snapshot.stats || {};
				const parts = [`待处理 ${stats.open || 0}`];
				if (stats.doing) parts.push(`AI 处理中 ${stats.doing}`);
				if (stats.overdue) parts.push(`逾期 ${stats.overdue}`);
				if (stats.today) parts.push(`今天 ${stats.today}`);
				if (snapshot.syncedAt) parts.push(`上次同步 ${clockOf(snapshot.syncedAt)}`);
				if (autoOn()) parts.push(`自动每 ${snapshot.config.intervalMin || 30} 分钟`);
				note(parts.join(" · "), stats.overdue ? "err" : "");
			}
			scheduleAutoAdvise();
			return payload;
		} catch (err) {
			note(`读取待办失败：${err.message}`, "err");
			return null;
		}
	}

	/**
	 * 打开面板时自动算建议：只挑「未完成 + 建议过期」的前 3 条，一次打开只触发一轮。
	 * 这是"持续为我提供处理建议"的落点 —— 但绝不无限重试，也不覆盖用户手动改过的优先级。
	 */
	function scheduleAutoAdvise() {
		if (autoAdviseDone || busy || destroyed) return;
		if (!snapshot.capabilities?.advice) return;
		const targets = (snapshot.items || [])
			.filter((todo) => (todo.status === "open" || todo.status === "doing") && !adviceFresh(todo, now(), ttl()))
			.filter((todo) => !advising.has(todo.id))
			.slice(0, 3);
		if (!targets.length) {
			autoAdviseDone = true;
			return;
		}
		autoAdviseDone = true;
		void adviseIds(
			targets.map((todo) => todo.id),
			{ auto: true },
		);
	}

	async function adviseIds(ids, { force = false, auto = false } = {}) {
		const wanted = (ids || []).filter((id) => id && !advising.has(id));
		if (!wanted.length) return;
		for (const id of wanted) advising.add(id);
		busy = true;
		render();
		note(auto ? "AI 正在看这几条待办（只算最该看的 3 条）…" : "AI 正在生成建议…");
		try {
			const payload = await call("/todos/advise", {
				method: "POST",
				body: { ids: wanted, force, limit: Math.min(Math.max(wanted.length, 1), 3) },
				// 服务端是串行调模型（每条一次 llm.complete）：三条留足 3 分钟，中途断开只是看不到结果。
				timeoutMs: 180000,
			});
			const results = payload.results || [];
			const failed = results.filter((row) => row.error);
			if (failed.length) note(`有 ${failed.length} 条没算出建议：${failed[0].error}`, "err");
			else note(failed.length ? "" : "建议已更新", "ok");
		} catch (err) {
			note(`生成建议失败：${err.message}`, "err");
		} finally {
			busy = false;
			for (const id of wanted) advising.delete(id);
			await refresh({ quiet: true });
		}
	}

	async function createTodo(input) {
		try {
			const payload = await call("/todos/create", { method: "POST", body: input, timeoutMs: 25000 });
			const warning = payload?.writeBack?.warning;
			if (warning) note(warning, "err");
			else note(input?.toFeishu ? "已添加（已在飞书建同名任务）" : "已添加", "ok");
			await refresh({ quiet: true });
			scheduleAutoAdvise();
		} catch (err) {
			note(`添加失败：${err.message}`, "err");
		}
	}

	async function updateTodo(id, patch) {
		try {
			const payload = await call("/todos/update", { method: "POST", body: { id, patch }, timeoutMs: 25000 });
			const writeBack = payload?.writeBack;
			if (writeBack?.warning) note(writeBack.warning, "err");
			else if (writeBack?.writeBack) note("已保存，并同步到飞书任务", "ok");
			await refresh({ quiet: true });
			return payload;
		} catch (err) {
			note(`更新失败：${err.message}`, "err");
			return null;
		}
	}

	/** 采纳一条候选：只传 id，正文由服务端存过的那份决定。 */
	async function adoptCandidate(cid) {
		try {
			await call("/todos/adopt", { method: "POST", body: { id: cid }, timeoutMs: 25000 });
			note("已记下", "ok");
			await refresh({ quiet: true });
			scheduleAutoAdvise();
		} catch (err) {
			note(`记下失败：${err.message}`, "err");
		}
	}

	/** 自动获取设置：开关与间隔都回服务端存（两个标签页开着也不会对不上）。 */
	async function saveAutoConfig(patch, okText) {
		try {
			const payload = await call("/todos/config", { method: "POST", body: patch, timeoutMs: 15000 });
			await refresh({ quiet: true });
			const cfg = payload?.config || snapshot.config || {};
			note(okText ? okText(cfg) : "已更新自动获取设置", "ok");
		} catch (err) {
			note(`设置自动获取失败：${err.message}`, "err");
		}
	}

	async function runAction(todo, actionId) {
		const action = (todo.advice?.actions || []).find((item) => item.id === actionId);
		if (!action) {
			note("这个动作已经失效（建议被刷新过），重新算一次", "err");
			return;
		}
		// insert / open 是纯前端指令：不惊动服务端。
		if (action.kind === "insert") {
			const text = String(action.text || "");
			const ok = compose ? await compose(text) : false;
			if (!ok) {
				try {
					await navigator.clipboard.writeText(text);
					note("输入框不可用，草稿已复制到剪贴板", "ok");
				} catch {
					note("插入失败：剪贴板也不可用", "err");
				}
			} else note("草稿已插入对话输入框", "ok");
			return;
		}
		if (action.kind === "open") {
			if (action.url) window.open(action.url, "_blank", "noopener,noreferrer");
			return;
		}
		if (action.kind === "agent") {
			// 派出去就是真的在跑（会改文件、可能发消息）—— 必须由人确认。
			if (
				!window.confirm(`让 AI 直接处理这条待办？\n\n${todo.title}\n\n它会在后台跑一轮（可用工具），跑完在通知里回报。`)
			)
				return;
			await executeAction(todo.id, action.id, "已派给 AI，跑完会通知你");
			return;
		}
		// reply：把草稿摊开给人看，二次确认才发 —— 唯一会以你的名义对外说话的动作。
		showDraft(todo, action);
	}

	function showDraft(todo, action) {
		const slot = root.querySelector(`.fp-td-draft-slot[data-id="${CSS.escape(todo.id)}"]`);
		if (!slot) return;
		slot.hidden = false;
		slot.innerHTML = `
			<div class="fp-td-draft">
				<div class="fp-td-draft-body">${esc(action.text || "")}</div>
				<div class="fp-td-draft-bar">
					<span>收件人：${esc(todo.ref?.sender || todo.ref?.title || action.chatId || "该会话")}</span>
					<span style="flex:1"></span>
					<button class="fp-td-btn" data-act="draft-cancel">取消</button>
					<button class="fp-td-btn fp-td-primary" data-act="draft-send" data-id="${esc(todo.id)}" data-aid="${esc(action.id)}">确认发送</button>
				</div>
			</div>`;
	}

	async function executeAction(id, actionId, okText) {
		try {
			const payload = await call("/todos/execute", { method: "POST", body: { id, actionId }, timeoutMs: 60000 });
			if (payload.directive?.type === "open" && payload.directive.url) {
				window.open(payload.directive.url, "_blank", "noopener,noreferrer");
			}
			note(okText, "ok");
			await refresh({ quiet: true });
			if (payload.started) startPolling();
		} catch (err) {
			note(`执行失败：${err.message}`, "err");
		}
	}

	/** agent 跑完的结果由服务端在 onRunEvent 里写进历史：轮询几次把新历史取回来。 */
	function startPolling() {
		if (destroyed || pollTimer) return;
		pollTicks = 0;
		let sawRun = (snapshot.items || []).some((todo) => todo.status === "doing");
		pollTimer = setInterval(() => {
			pollTicks += 1;
			const stillDoing = (snapshot.items || []).some((todo) => todo.status === "doing");
			if (stillDoing) sawRun = true;
			if (pollTicks > 30 || !stillDoing) {
				stopPolling();
				if (!stillDoing) {
					void refresh({ quiet: true });
					// 跑到结束才提示（只派过单、还没跑完的不要提前报喜）。
					if (sawRun) say?.("AI 处理完了：结果已写进这条待办的历史", "ok");
				}
				return;
			}
			void refresh({ quiet: true });
		}, 5000);
	}

	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
	}

	async function syncFeishu() {
		note("正在读飞书任务…");
		try {
			const payload = await call("/todos/sync", { method: "POST", timeoutMs: 60000 });
			if (payload.warning) note(payload.warning, "err");
			else
				note(
					`同步完成：新增 ${payload.added || 0} 条，更新 ${payload.updated || 0} 条（飞书共 ${payload.total || 0} 条）`,
					"ok",
				);
			await refresh({ quiet: true });
			scheduleAutoAdvise();
		} catch (err) {
			note(`同步失败：${err.message}`, "err");
		}
	}

	async function extractTodos() {
		note("正在读监听的会话并让 AI 找待办…");
		try {
			const payload = await call("/todos/extract", { method: "POST", body: { limit: 3 }, timeoutMs: 150000 });
			// 服务端会把候选落盘（自动提取也一样）：以后者为准，手动这一次先用回包渲染。
			if (Array.isArray(payload.pending)) {
				snapshot = { ...snapshot, candidates: payload.pending };
				renderCandidates();
			}
			const added = Number(payload.added ?? (payload.candidates || []).length) || 0;
			if (!added) {
				note(`扫了 ${payload.chats || 0} 个会话 / ${payload.messages || 0} 条消息，没找到新的待办`, "ok");
				return;
			}
			note(`从 ${payload.chats || 0} 个会话里找到 ${added} 条候选，点「记下」加入待办`, "ok");
		} catch (err) {
			note(`提取失败：${err.message}`, "err");
		}
	}

	/* -------------------------------- 事件 -------------------------------- */

	root.addEventListener("click", async (ev) => {
		const target = ev.target;
		if (!(target instanceof HTMLElement)) return;
		const btn = target.closest("[data-act]");
		if (!btn) return;
		const act = btn.dataset.act || "";
		const id = btn.dataset.id || "";
		const todo = id ? findTodo(id) : null;

		if (act === "add") {
			const title = String(elNew.value || "").trim();
			if (!title) return;
			const toFeishu = Boolean(elTf?.checked) && !elTf?.disabled;
			elNew.value = "";
			await createTodo({ title, toFeishu });
			return;
		}
		if (act === "toggle" && todo) {
			await updateTodo(todo.id, { status: todo.status === "done" ? "open" : "done" });
			return;
		}
		if (act === "reopen" && todo) {
			await updateTodo(todo.id, { status: "open" });
			return;
		}
		if (act === "drop" && todo) {
			await updateTodo(todo.id, { status: "dropped" });
			return;
		}
		if (act === "delete" && todo) {
			if (!window.confirm(`删除待办「${todo.title}」？`)) return;
			try {
				const payload = await call("/todos/delete", { method: "POST", body: { id: todo.id }, timeoutMs: 15000 });
				// 飞书任务不跟着删（破坏性操作得人去飞书里点）：有提醒就照实说。
				if (payload?.warning) note(payload.warning, "err");
				else note("已删除", "ok");
				await refresh({ quiet: true });
			} catch (err) {
				note(`删除失败：${err.message}`, "err");
			}
			return;
		}
		if (act === "advise-one" && todo) {
			await adviseIds([todo.id], { force: true });
			return;
		}
		if (act === "advise-batch") {
			const ids = (snapshot.items || [])
				.filter((item) => (item.status === "open" || item.status === "doing") && !adviceFresh(item, now(), ttl()))
				.slice(0, 3)
				.map((item) => item.id);
			if (!ids.length) {
				note("当前没有需要重算的待办（建议都还新鲜）", "ok");
				return;
			}
			await adviseIds(ids, { force: true });
			return;
		}
		if (act === "mute" && todo) {
			try {
				await call("/todos/mute", { method: "POST", body: { id: todo.id }, timeoutMs: 15000 });
				autoAdviseDone = false;
				await refresh({ quiet: true });
				note("已清掉这条建议：下次 AI 会换个说法", "ok");
			} catch (err) {
				note(`操作失败：${err.message}`, "err");
			}
			return;
		}
		if (act === "run" && todo) {
			await runAction(todo, btn.dataset.aid || "");
			return;
		}
		if (act === "draft-cancel") {
			const slot = btn.closest(".fp-td-draft-slot");
			if (slot) {
				slot.hidden = true;
				slot.innerHTML = "";
			}
			return;
		}
		if (act === "draft-send") {
			await executeAction(id, btn.dataset.aid || "", "已发送");
			return;
		}
		if (act === "expand" && todo) {
			expanded.add(todo.id);
			render();
			return;
		}
		if (act === "collapse") {
			expanded.delete(id);
			render();
			return;
		}
		if (act === "edit" && todo) {
			editingId = todo.id;
			render();
			root.querySelector(".fp-td-edit-title")?.focus();
			return;
		}
		if (act === "edit-cancel") {
			editingId = "";
			render();
			return;
		}
		if (act === "edit-save" && todo) {
			const card = btn.closest(".fp-td-card");
			const title = String(card?.querySelector(".fp-td-edit-title")?.value || "").trim();
			const detail = String(card?.querySelector(".fp-td-edit-detail")?.value || "").trim();
			const priority = String(card?.querySelector(".fp-td-edit-priority")?.value || "normal");
			const dueRaw = String(card?.querySelector(".fp-td-edit-due")?.value || "");
			editingId = "";
			// 回写结果由 updateTodo 统一提示（同步成功/失败都会写一行）。
			await updateTodo(todo.id, {
				title: title || todo.title,
				detail,
				priority,
				dueAt: dueRaw ? new Date(dueRaw).getTime() : 0,
			});
			return;
		}
		if (act === "sync") {
			await syncFeishu();
			return;
		}
		if (act === "extract") {
			await extractTodos();
			return;
		}
		if (act === "auto-toggle") {
			const next = !autoOn();
			const intervalMin = Number(elInt?.value) || Number(snapshot.config?.intervalMin) || 30;
			await saveAutoConfig({ autoSync: next, autoExtract: next, intervalMin, restart: next }, (cfg) =>
				next
					? `已开启自动获取：每 ${cfg.intervalMin} 分钟同步飞书任务 + 从监听会话提取待办（会花模型额度）`
					: "已关闭自动获取（手动按钮照旧可用）",
			);
			return;
		}
		if (act === "cands-clear") {
			try {
				await call("/todos/candidates-clear", { method: "POST", timeoutMs: 15000 });
				await refresh({ quiet: true });
			} catch (err) {
				note(`收起候选失败：${err.message}`, "err");
			}
			return;
		}
		if (act === "adopt") {
			const cid = btn.dataset.cid || "";
			if (!cid) return;
			btn.disabled = true;
			await adoptCandidate(cid);
			return;
		}
	});

	root.addEventListener("keydown", (ev) => {
		if (!(ev.target instanceof HTMLElement)) return;
		if (ev.target === elNew && ev.key === "Enter") {
			ev.preventDefault();
			const title = String(elNew.value || "").trim();
			if (!title) return;
			const toFeishu = Boolean(elTf?.checked) && !elTf?.disabled;
			elNew.value = "";
			void createTodo({ title, toFeishu });
		}
	});

	elInt?.addEventListener("change", () => {
		const intervalMin = Number(elInt.value) || 30;
		void saveAutoConfig({ intervalMin }, (cfg) =>
			autoOn() ? `自动获取间隔已改为 ${cfg.intervalMin} 分钟` : `已记住间隔 ${cfg.intervalMin} 分钟`,
		);
	});

	elQ?.addEventListener("input", () => {
		query = String(elQ.value || "");
		render();
	});

	for (const btn of root.querySelectorAll(".fp-td-seg")) {
		btn.addEventListener("click", () => {
			seg = btn.dataset.seg || "active";
			for (const other of root.querySelectorAll(".fp-td-seg")) other.classList.toggle("on", other === btn);
			render();
		});
	}

	return {
		refresh: () => refresh(),
		/** 页签切回来时调用：静默刷新 + 重跑一次自动建议（新的一天/新的逾期）。 */
		async resume() {
			autoAdviseDone = false;
			await refresh({ quiet: true });
		},
		destroy() {
			destroyed = true;
			stopPolling();
			try {
				root.remove();
			} catch {
				/* 容器已移除 */
			}
		},
	};
}
