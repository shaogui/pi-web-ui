/**
 * plugins/feishu-pro/client/todo-view.mjs
 * 「待办」页签 v2：今天 / 收件箱 / 全部 + 列表详情分栏。
 *
 * 这一版解决的四个问题（都是上一版真实踩到的）：
 *   1. **捕获太贵**：以前只能填标题，截止/优先级要建完再点编辑。现在输入时本地解析
 *      「明天 10 点 / !高」，变成可删可改的 chips，回车就落库（不花模型额度）。
 *   2. **一屏什么都做**：以前 12 个工具控件 + 每卡 9 个按钮。现在工具栏只剩「记一条」，
 *      同步/提取/自动获取收进「⋯」；卡片一行一条，所有操作在右侧详情里。
 *   3. **AI 每条都说话**：以前打开页签自动给 3 条算建议。现在只有一份「今天怎么办」简报，
 *      单条建议在详情里按需生成（额度花在用户真的要看的那一刻）。
 *   4. **候选只能整条收**：以前「收起」后下一轮又回来。现在可以单条忽略，忽略记进
 *      `ignoredCandidateIds`，下一轮提取不再出现。
 *
 * 安全与稳定（与前几版同口径，不能破）：
 *   - 所有插值一律 esc()：标题/正文来自消息与模型，都属于不可信输入；
 *   - 对外动作先看见再执行：reply 先摊开草稿，agent 先展示任务文本再确认（不再用原生 confirm）；
 *   - 失败只写在提示条里，不清空已有列表；
 *   - 编辑期间不重渲染详情（否则光标会跳）。
 */

import { esc } from "@pi-web-ui/plugin-sdk/client";
import { captureChips, parseCapture } from "./capture-parse.mjs";

const STYLE_ID = "fp-todo-styles";

const STYLES = `
.fp-td{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;container-type:inline-size;}
.fp-td-head{display:flex;flex-direction:column;gap:6px;padding:8px 12px 7px;border-bottom:1px solid var(--border);}
.fp-td-capture{display:flex;align-items:center;gap:6px;min-width:0;}
.fp-td-new{flex:1 1 auto;min-width:120px;padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12.5px;outline:none;}
.fp-td-new:focus{border-color:var(--accent);}
.fp-td-new::placeholder{color:var(--text-faint);}
.fp-td-parse{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--text-dim);}
.fp-td-parse[hidden]{display:none;}
.fp-td-chip{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:999px;border:1px solid var(--border);line-height:1.7;white-space:nowrap;font-size:10.5px;color:var(--text-dim);background:var(--bg);}
.fp-td-chip.accent{color:var(--accent);border-color:var(--accent);}
.fp-td-chip.warn{color:var(--amber);border-color:var(--amber);}
.fp-td-chip.bad{color:var(--red);border-color:var(--red);}
.fp-td-chip.ok{color:var(--green);border-color:var(--green);}
.fp-td-chip button{border:none;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;padding:0 0 0 2px;cursor:pointer;opacity:.7;}
.fp-td-chip button:hover{opacity:1;}
.fp-td-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fp-td-segs{display:inline-flex;gap:1px;padding:2px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);}
.fp-td-seg{border:none;background:transparent;color:var(--text-dim);font:inherit;font-size:11.5px;line-height:1.5;padding:3px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;}
.fp-td-seg:hover{color:var(--text);}
.fp-td-seg.on{background:var(--bg);color:var(--text);font-weight:600;}
.fp-td-q{width:132px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:11.5px;outline:none;}
.fp-td-q:focus{border-color:var(--accent);}
.fp-td-spacer{flex:1 1 auto;min-width:4px;}
.fp-td-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:11.5px;line-height:1.35;cursor:pointer;white-space:nowrap;}
.fp-td-btn:hover{border-color:var(--accent);color:var(--accent);}
.fp-td-btn[disabled]{opacity:.5;cursor:not-allowed;}
.fp-td-btn.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:600;}
.fp-td-ghost{background:transparent;border-color:transparent;color:var(--text-dim);}
.fp-td-ghost:hover{background:var(--bg-elev2);border-color:var(--border);}
.fp-td-primary{border-color:var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);font-weight:600;}
.fp-td-primary:hover{color:var(--accent-contrast,#fff);filter:brightness(1.06);}
.fp-td-danger:hover{border-color:var(--red);color:var(--red);}
.fp-td-more{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 8px;border-radius:7px;border:1px dashed var(--border);background:var(--bg-elev);}
.fp-td-more[hidden]{display:none;}
.fp-td-more label{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim);white-space:nowrap;cursor:pointer;}
.fp-td-more input[type="checkbox"]{width:12px;height:12px;margin:0;accent-color:var(--accent);cursor:pointer;}
.fp-td-more select{padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:11px;outline:none;}
.fp-td-kbd{font-size:10.5px;color:var(--text-faint);white-space:nowrap;}
.fp-td-stats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 12px;font-size:10.8px;color:var(--text-faint);border-bottom:1px solid var(--border-soft);}
.fp-td-stats b{font-weight:600;color:var(--text-dim);}
.fp-td-stats .bad{color:var(--red);}
.fp-td-sync{border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-decoration:underline dotted;}
.fp-td-sync:hover{color:var(--accent);}
.fp-td-notice{padding:5px 12px;font-size:11px;line-height:1.6;color:var(--text-dim);border-bottom:1px solid var(--border-soft);overflow-wrap:anywhere;}
.fp-td-notice[hidden]{display:none;}
.fp-td-notice.err{color:var(--red);}
.fp-td-notice.ok{color:var(--green);}
.fp-td-body{display:flex;flex:1;min-height:0;}
.fp-td-list-col{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}
.fp-td-list{flex:1;min-height:0;overflow:auto;padding:6px 9px 28px;display:flex;flex-direction:column;gap:2px;outline:none;}
.fp-td-group{display:flex;align-items:center;gap:6px;padding:8px 4px 3px;font-size:10.5px;font-weight:600;letter-spacing:.3px;color:var(--text-faint);}
.fp-td-group.bad{color:var(--red);}
.fp-td-group-n{padding:0 5px;border-radius:999px;border:1px solid var(--border);font-weight:500;line-height:1.5;}
.fp-td-empty{padding:26px 18px;text-align:center;font-size:12px;line-height:1.9;color:var(--text-faint);}
.fp-td-empty .fp-td-btn{margin-top:6px;}
.fp-td-row{display:flex;align-items:flex-start;gap:8px;padding:6px 7px;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;min-width:0;}
.fp-td-row:hover{background:var(--bg-elev);border-color:var(--border-soft);}
.fp-td-row.sel{background:var(--bg-elev2);border-color:var(--border);}
.fp-td-row.done,.fp-td-row.dropped{opacity:.62;}
.fp-td-row.done .fp-td-title{text-decoration:line-through;color:var(--text-dim);}
.fp-td-check{flex:0 0 auto;width:16px;height:16px;margin-top:2px;border-radius:50%;border:1px solid var(--border);background:var(--bg);color:var(--text-dim);font-size:9px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;}
.fp-td-check:hover{border-color:var(--accent);color:var(--accent);}
.fp-td-check.on{border-color:var(--green);background:var(--green-soft);color:var(--green);}
.fp-td-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.fp-td-row-line{display:flex;align-items:baseline;gap:6px;min-width:0;}
.fp-td-title{flex:0 1 auto;min-width:60px;max-width:72%;font-size:12.5px;font-weight:600;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-meta{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--text-faint);white-space:nowrap;}
.fp-td-dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:var(--text-faint);}
.fp-td-dot.high{background:var(--amber);}
.fp-td-dot.urgent{background:var(--red);}
.fp-td-dot.low{background:var(--border);}
.fp-td-row-sub{font-size:10.8px;line-height:1.55;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-row-sub.live{color:var(--accent);}
.fp-td-cand{border-color:var(--border-soft);border-style:dashed;background:var(--bg-elev);}
.fp-td-cand-ops{display:flex;align-items:center;gap:3px;flex:0 0 auto;}
.fp-td-cand-ops .fp-td-btn{padding:2px 7px;font-size:10.5px;}
.fp-td-brief{margin:6px 9px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--accent);background:var(--accent-soft);}
.fp-td-brief[hidden]{display:none;}
.fp-td-brief-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--text-dim);}
.fp-td-badge{font-size:9px;font-weight:700;letter-spacing:.4px;padding:0 4px;border-radius:4px;color:var(--accent);background:var(--bg);border:1px solid var(--accent);line-height:1.6;}
.fp-td-brief-sum{margin:4px 0 0;font-size:12px;line-height:1.65;color:var(--text);overflow-wrap:anywhere;word-break:break-word;}
.fp-td-brief-order{margin:3px 0 0;padding-left:16px;font-size:11.5px;line-height:1.7;color:var(--text-dim);}
.fp-td-brief-order li{overflow-wrap:anywhere;word-break:break-word;}
.fp-td-brief-order button{border:none;background:transparent;color:var(--text);font:inherit;font-weight:600;cursor:pointer;padding:0;text-decoration:underline dotted;}
.fp-td-brief-order button:hover{color:var(--accent);}
.fp-td-brief-drop{margin-top:3px;font-size:11px;line-height:1.6;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-td-brief-cta{margin:6px 9px 0;padding:6px 9px;border-radius:7px;border:1px dashed var(--border);font-size:11px;color:var(--text-faint);display:flex;align-items:center;gap:6px;}
.fp-td-detail{flex:0 0 360px;width:360px;min-width:0;min-height:0;border-left:1px solid var(--border);background:var(--bg-elev);display:flex;flex-direction:column;}
.fp-td-detail[hidden]{display:none;}
.fp-td-detail-head{display:flex;align-items:center;gap:5px;padding:7px 9px;border-bottom:1px solid var(--border-soft);min-width:0;}
.fp-td-detail-title{flex:1;min-width:0;font-size:12.5px;font-weight:700;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fp-td-detail-scroll{flex:1;min-height:0;overflow:auto;padding:9px 11px 14px;display:flex;flex-direction:column;gap:9px;}
.fp-td-detail-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10.5px;color:var(--text-faint);}
.fp-td-link{border:none;background:transparent;color:var(--accent);font:inherit;font-size:10.5px;cursor:pointer;padding:0;text-decoration:underline;}
.fp-td-detail-text{font-size:12px;line-height:1.7;color:var(--text-dim);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;}
.fp-td-detail-text.empty{color:var(--text-faint);font-style:italic;}
.fp-td-sec{display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px solid var(--border-soft);}
.fp-td-sec-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--text-faint);}
.fp-td-sum{font-size:12px;line-height:1.65;color:var(--text);overflow-wrap:anywhere;word-break:break-word;}
.fp-td-steps{margin:0;padding-left:17px;font-size:11.5px;line-height:1.75;color:var(--text-dim);}
.fp-td-steps > li{overflow-wrap:anywhere;word-break:break-word;}
.fp-td-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.fp-td-actions .fp-td-btn{padding:3px 8px;font-size:11px;}
.fp-td-draft{display:flex;flex-direction:column;gap:5px;padding:7px 8px;border-radius:7px;border:1px dashed var(--accent);background:var(--accent-soft);}
.fp-td-draft-body{font-size:11.8px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:var(--text);}
.fp-td-draft-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--text-dim);}
.fp-td-confirm{display:flex;flex-direction:column;gap:5px;padding:7px 8px;border-radius:7px;border:1px dashed var(--amber);background:var(--bg);}
.fp-td-confirm-text{font-size:11.5px;line-height:1.6;color:var(--text);overflow-wrap:anywhere;word-break:break-word;}
.fp-td-hist{display:flex;flex-direction:column;gap:2px;font-size:10.8px;line-height:1.6;color:var(--text-faint);}
.fp-td-hist-row{display:flex;gap:7px;overflow-wrap:anywhere;word-break:break-word;}
.fp-td-hist-row.hl{color:var(--text-dim);}
.fp-td-hist-at{flex:0 0 auto;font-variant-numeric:tabular-nums;}
.fp-td-foot{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:7px 9px;border-top:1px solid var(--border-soft);}
.fp-td-edit{display:flex;flex-direction:column;gap:6px;}
.fp-td-edit input,.fp-td-edit textarea,.fp-td-edit select{width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;outline:none;}
.fp-td-edit textarea{min-height:82px;resize:vertical;}
.fp-td-edit input:focus,.fp-td-edit textarea:focus,.fp-td-edit select:focus{border-color:var(--accent);}
.fp-td-edit-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.fp-td-edit-row > select,.fp-td-edit-row > input[type="datetime-local"]{width:auto;min-width:110px;}
.fp-td-back{display:none;}
@container (max-width: 760px){
  .fp-td.detail-open .fp-td-list-col{display:none;}
  .fp-td.detail-open .fp-td-detail{flex:1 1 auto;width:auto;border-left:none;}
  .fp-td.detail-open .fp-td-back{display:inline-flex;}
}
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
const STATUS_LABEL = { open: "待处理", doing: "AI 处理中", done: "已完成", dropped: "以后再说" };
const SOURCE_LABEL = { manual: "手动记录", feishu: "飞书任务", extract: "消息提取", agent: "AI 记录" };

const DAY_MS = 86_400_000;
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

/** 只有日期（00:00）的截止按**当天结束**算：否则刚记下就显示「已逾期」。 */
export function dueDeadline(ms) {
	const t = Number(ms) || 0;
	if (!t) return 0;
	const d = new Date(t);
	return d.getHours() === 0 && d.getMinutes() === 0 ? dayStart(t) + DAY_MS - 1 : t;
}

/** 截止时间的人话（服务端口径：今天的边界按本地时区）。 */
export function formatDue(todo, now = Date.now()) {
	const due = Number(todo?.dueAt) || 0;
	if (!due) return "";
	const d = new Date(due);
	const atMidnight = d.getHours() === 0 && d.getMinutes() === 0;
	const clock = atMidnight ? "" : ` ${two(d.getHours())}:${two(d.getMinutes())}`;
	const dateText = `${two(d.getMonth() + 1)}-${two(d.getDate())}${clock}`;
	if (todo?.status === "done" || todo?.status === "dropped") return dateText;

	const deadline = dueDeadline(due);
	if (deadline < now) {
		const late = Math.floor((dayStart(now) - dayStart(deadline)) / DAY_MS);
		return late > 0 ? `已逾期 ${late} 天` : "已逾期";
	}
	const diffDays = Math.round((dayStart(due) - dayStart(now)) / DAY_MS);
	if (diffDays === 0) return `今天${clock}`;
	if (diffDays === 1) return `明天${clock}`;
	if (diffDays > 1 && diffDays <= 6) return `${diffDays} 天后${clock}`;
	return dateText;
}

export function dueTone(todo, now = Date.now()) {
	const due = Number(todo?.dueAt) || 0;
	if (!due || todo?.status === "done" || todo?.status === "dropped") return "";
	const deadline = dueDeadline(due);
	if (deadline < now) return "bad";
	if (deadline < dayStart(now) + DAY_MS) return "warn";
	return "";
}

/**
 * 这条待办属于哪一段：
 *   doing（AI 正在做）/ overdue（已过截止）/ today（今天到期）/ inbox（没排期）/ later（以后）/ closed。
 * 时间是连续的，"今天"的边界按本地时区（与服务端 todoStats 同口径）。
 */
export function bucketTodo(todo, now = Date.now()) {
	const status = String(todo?.status || "open");
	if (status === "done" || status === "dropped") return "closed";
	if (status === "doing") return "doing";
	const due = Number(todo?.dueAt) || 0;
	if (!due) return "inbox";
	const deadline = dueDeadline(due);
	if (deadline < now) return "overdue";
	if (deadline < dayStart(now) + DAY_MS) return "today";
	return "later";
}

/** 建议是否还新鲜（与 lib/todo-store.mjs 的 isAdviceFresh 同口径）。 */
export function adviceFresh(todo, now = Date.now(), ttlMs = 6 * 60 * 60_000) {
	if (!todo?.advice) return false;
	const muted = Number(todo.adviceMutedAt) || 0;
	if (muted && muted >= (Number(todo.advice.at) || 0)) return false;
	return now - (Number(todo.advice.at) || 0) < ttlMs;
}

function matchTodo(todo, needle) {
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
}

/** 兼容旧接口：只按分段/关键词过滤（新界面用 buildSections）。 */
export function filterTodos(items, { seg = "today", query = "", now = Date.now() } = {}) {
	const needle = String(query ?? "")
		.trim()
		.toLowerCase();
	return (Array.isArray(items) ? items : []).filter((todo) => {
		if (needle) return matchTodo(todo, needle);
		const bucket = bucketTodo(todo, now);
		if (seg === "today") return bucket === "today" || bucket === "overdue" || bucket === "doing";
		if (seg === "inbox") return bucket === "inbox" || bucket === "later";
		return true;
	});
}

/**
 * 列表分组：今天=逾期/今天/AI 处理中；收件箱=待安排/以后（候选由渲染层单独插在前面）；
 * 全部=待处理/进行中/已完成/以后再说。搜索时直接给一个结果组。
 */
export function buildSections(items, { seg = "today", query = "", now = Date.now() } = {}) {
	const list = Array.isArray(items) ? items : [];
	const needle = String(query ?? "")
		.trim()
		.toLowerCase();
	if (needle) {
		// 搜索是全局的（不受分段限制）：分组标题把这件事写出来，免得用户以为只搜了「今天」。
		return [{ key: "search", label: "搜索结果 · 全部", items: list.filter((todo) => matchTodo(todo, needle)) }];
	}
	const buckets = new Map();
	for (const todo of list) {
		const bucket = bucketTodo(todo, now);
		if (!buckets.has(bucket)) buckets.set(bucket, []);
		buckets.get(bucket).push(todo);
	}
	const take = (key) => buckets.get(key) || [];
	if (seg === "today") {
		return [
			{ key: "overdue", label: "逾期", tone: "bad", items: take("overdue") },
			{ key: "today", label: "今天", items: take("today") },
			{ key: "doing", label: "AI 处理中", items: take("doing") },
		].filter((section) => section.items.length);
	}
	if (seg === "inbox") {
		return [
			{ key: "inbox", label: "待安排", items: take("inbox") },
			{ key: "later", label: "以后", items: take("later") },
		].filter((section) => section.items.length);
	}
	return [
		{ key: "open", label: "待处理", items: take("overdue").concat(take("today"), take("inbox"), take("later")) },
		{ key: "doing", label: "AI 处理中", items: take("doing") },
		{ key: "done", label: "已完成", items: list.filter((todo) => todo.status === "done") },
		{ key: "dropped", label: "以后再说", items: list.filter((todo) => todo.status === "dropped") },
	].filter((section) => section.items.length);
}

function metaHtml(todo, now, { full = false } = {}) {
	const chips = [];
	const due = formatDue(todo, now);
	if (due) chips.push(`<span class="fp-td-chip ${dueTone(todo, now)}" title="截止时间">${esc(due)}</span>`);
	const priority = String(todo?.priority || "normal");
	if (priority !== "normal") {
		chips.push(`<span class="fp-td-chip" title="优先级">${esc(PRIORITY_LABEL[priority] || priority)}</span>`);
	}
	if (todo?.ref?.kind === "task") chips.push('<span class="fp-td-chip accent" title="和飞书任务双向同步">飞书</span>');
	if (full) {
		const status = String(todo?.status || "open");
		chips.push(`<span class="fp-td-chip">${esc(STATUS_LABEL[status] || status)}</span>`);
		const source = String(todo?.source || "manual");
		if (source !== "feishu" && source !== "manual")
			chips.push(`<span class="fp-td-chip" title="来源">${esc(SOURCE_LABEL[source] || source)}</span>`);
	}
	return chips.join("");
}

/** 一行一条：勾选 + 标题 + 截止/优先级 + （仅 AI 处理中才有的）进度行。 */
export function todoRowHtml(todo, { now = Date.now(), selected = false, runningAt = 0, running = false } = {}) {
	const status = String(todo?.status || "open");
	const closed = status === "done" || status === "dropped";
	const doing = status === "doing";
	const elapsed = runningAt ? Math.max(0, Math.round((now - runningAt) / 1000)) : 0;
	const live = doing
		? `<div class="fp-td-row-sub live">${
				running ? `AI 正在处理 · 已 ${Math.floor(elapsed / 60)}:${two(elapsed % 60)}` : "AI 正在处理…"
			}</div>`
		: "";
	return `
		<div class="fp-td-row ${esc(status)} ${selected ? "sel" : ""}" data-id="${esc(todo.id)}" role="option" aria-selected="${selected ? "true" : "false"}">
			<button class="fp-td-check ${closed ? "on" : ""}" data-act="toggle" data-id="${esc(todo.id)}" title="${
				closed ? "重新打开" : "标记完成"
			}" aria-label="${closed ? "重新打开" : "标记完成"}">${closed ? "✓" : ""}</button>
			<div class="fp-td-row-main">
				<div class="fp-td-row-line">
					<span class="fp-td-title" title="${esc(todo.title || "")}">${esc(todo.title || "（无标题）")}</span>
					<span class="fp-td-meta">${metaHtml(todo, now)}</span>
				</div>
				${live}
			</div>
		</div>`;
}

function historyHtml(todo, { all = false } = {}) {
	const rows = Array.isArray(todo?.history) ? todo.history : [];
	if (!rows.length) return "";
	const shown = all ? rows : rows.slice(0, 6);
	return `<div class="fp-td-hist">${shown
		.map(
			(row) =>
				`<div class="fp-td-hist-row ${row.kind === "agent-done" ? "hl" : ""}"><span class="fp-td-hist-at">${esc(
					clockOf(row.at),
				)}</span><span>${esc(row.text || row.kind)}</span></div>`,
		)
		.join("")}</div>`;
}

/** 详情里的 AI 建议区：判断 + 步骤 + 动作（风险分层：对外说话 = 主色）。 */
function adviceHtml(todo, state) {
	const advice = todo?.advice;
	const caps = state.capabilities || {};
	const busy = state.advisingId === todo.id;
	if (busy) {
		return `<div class="fp-td-sec"><div class="fp-td-sec-head">AI 建议</div><div class="fp-td-sum">正在看这一条…</div></div>`;
	}
	if (!advice) {
		const btn = `<button class="fp-td-btn" data-act="advise-one" data-id="${esc(todo.id)}" ${
			caps.advice ? "" : "disabled"
		} title="${caps.advice ? "一次模型调用，只算这一条" : "宿主未提供模型补全（llm 能力）"}">让 AI 给建议</button>`;
		return `<div class="fp-td-sec"><div class="fp-td-sec-head">AI 建议</div><div class="fp-td-actions">${btn}${
			caps.advice ? '<span class="fp-td-kbd">只在你要看的时候才算</span>' : ""
		}</div></div>`;
	}
	const steps = Array.isArray(advice.steps) ? advice.steps : [];
	const actions = Array.isArray(advice.actions) ? advice.actions : [];
	const stepList = steps.length
		? `<ol class="fp-td-steps">${steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`
		: "";
	const buttons = actions
		.map((action) => {
			const ran = Boolean(action?.ranAt);
			const cls = action?.kind === "reply" ? "fp-td-btn fp-td-primary" : "fp-td-btn";
			const icon = { reply: "✉", agent: "▶", insert: "⌨", open: "↗" }[action?.kind] || "▶";
			return `<button class="${cls}" data-act="run" data-id="${esc(todo.id)}" data-aid="${esc(action.id)}" data-kind="${esc(
				action.kind,
			)}" ${ran ? "disabled" : ""}>${icon} ${esc(action.label || action.kind)}${ran ? " · 已执行" : ""}</button>`;
		})
		.join("");
	const stale = !adviceFresh(todo, state.now, state.ttl);
	return `
		<div class="fp-td-sec">
			<div class="fp-td-sec-head">
				<span class="fp-td-badge">AI</span>
				<span>${esc(clockOf(advice.at))}${stale ? " · 可重算" : ""}</span>
				<span class="fp-td-spacer"></span>
				<button class="fp-td-btn fp-td-ghost" data-act="advise-one" data-id="${esc(todo.id)}" title="重新生成这条建议">重算</button>
				<button class="fp-td-btn fp-td-ghost" data-act="mute" data-id="${esc(todo.id)}" title="这条建议没用：清掉，下次换个说法">没用</button>
			</div>
			<div class="fp-td-sum">${esc(advice.summary || "（没有一句话判断）")}</div>
			${stepList}
			<div class="fp-td-actions">${buttons}</div>
		</div>`;
}

function detailHtml(todo, state) {
	const status = String(todo?.status || "open");
	const closed = status === "done" || status === "dropped";
	const running = (state.running || []).find((row) => row.id === todo.id) || null;
	const source =
		todo?.ref?.kind === "chat" && todo?.ref?.chatId
			? `<button class="fp-td-link" data-act="origin" data-id="${esc(todo.id)}">看原话 · ${esc(
					todo.ref.sender || todo.ref.title || "该会话",
				)}</button>`
			: "";
	const draft =
		state.draft && state.draft.todoId === todo.id
			? `<div class="fp-td-draft">
					<div class="fp-td-draft-body">${esc(state.draft.text)}</div>
					<div class="fp-td-draft-bar">
						<span>收件人：${esc(state.draft.recipient)}</span>
						<span class="fp-td-spacer"></span>
						<button class="fp-td-btn" data-act="draft-cancel">取消</button>
						<button class="fp-td-btn fp-td-primary" data-act="draft-send" data-id="${esc(todo.id)}" data-aid="${esc(
							state.draft.actionId,
						)}">确认发送</button>
					</div>
				</div>`
			: "";
	const confirm =
		state.agentConfirm && state.agentConfirm.todoId === todo.id
			? `<div class="fp-td-confirm">
					<div class="fp-td-confirm-text">交给 AI 执行：${esc(state.agentConfirm.task)}</div>
					<div class="fp-td-actions">
						<button class="fp-td-btn" data-act="agent-cancel">取消</button>
						<button class="fp-td-btn fp-td-primary" data-act="agent-go" data-id="${esc(todo.id)}" data-aid="${esc(
							state.agentConfirm.actionId,
						)}">确认派单</button>
					</div>
				</div>`
			: "";
	return `
		<div class="fp-td-detail-head">
			<button class="fp-td-btn fp-td-ghost fp-td-back" data-act="detail-back" title="返回列表" aria-label="返回列表">←</button>
			<span class="fp-td-detail-title" title="${esc(todo.title || "")}">${esc(todo.title || "（无标题）")}</span>
			<button class="fp-td-btn fp-td-ghost" data-act="edit" data-id="${esc(todo.id)}">编辑</button>
			<button class="fp-td-btn fp-td-ghost" data-act="detail-close" title="关闭详情" aria-label="关闭详情">×</button>
		</div>
		<div class="fp-td-detail-scroll">
			<div class="fp-td-detail-meta">${metaHtml(todo, state.now, { full: true })}${source}</div>
			<div class="fp-td-detail-text ${todo.detail ? "" : "empty"}">${
				todo.detail ? esc(todo.detail) : "没有补充说明，点「编辑」可以补上原话或链接。"
			}</div>
			${running ? `<div class="fp-td-row-sub live">AI 正在处理 · 已 ${Math.max(0, Math.round((state.now - running.at) / 1000))} 秒</div>` : ""}
			${closed ? "" : adviceHtml(todo, state)}
			${draft}
			${confirm}
			<div class="fp-td-sec">
				<div class="fp-td-sec-head">记录${todo.history?.length > 6 ? `（最近 6 / 共 ${todo.history.length}）` : ""}</div>
				${historyHtml(todo, { all: state.histAll }) || '<div class="fp-td-hist-row">还没有记录</div>'}
				${todo.history?.length > 6 && !state.histAll ? '<button class="fp-td-link" data-act="hist-all">展开全部记录</button>' : ""}
			</div>
		</div>
		<div class="fp-td-foot">
			<button class="fp-td-btn ${closed ? "" : "fp-td-primary"}" data-act="toggle" data-id="${esc(todo.id)}">${
				closed ? "重新打开" : "标记完成"
			}</button>
			${closed ? "" : `<button class="fp-td-btn" data-act="drop" data-id="${esc(todo.id)}">以后再说</button>`}
			${status === "doing" && !running ? `<button class="fp-td-btn" data-act="unstick" data-id="${esc(todo.id)}" title="这次运行可能已中断（服务重启或事件丢失）">结束这次处理</button>` : ""}
			<span class="fp-td-spacer"></span>
			<button class="fp-td-btn fp-td-danger" data-act="delete" data-id="${esc(todo.id)}">${
				state.pendingDelete === todo.id ? "再点一次确认删除" : "删除"
			}</button>
		</div>`;
}

function editHtml(todo) {
	const due = Number(todo.dueAt) || 0;
	const dateValue = due ? new Date(due - new Date(due).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
	return `
		<div class="fp-td-detail-head">
			<button class="fp-td-btn fp-td-ghost fp-td-back" data-act="edit-cancel" title="返回" aria-label="返回">←</button>
			<span class="fp-td-detail-title">编辑这条</span>
		</div>
		<div class="fp-td-detail-scroll">
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
				</div>
				<div class="fp-td-edit-row">
					<span class="fp-td-spacer"></span>
					<button class="fp-td-btn" data-act="edit-cancel">取消</button>
					<button class="fp-td-btn fp-td-primary" data-act="edit-save" data-id="${esc(todo.id)}">保存</button>
				</div>
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
 * @param {(chatId: string) => void} [deps.onOpenChat] 跳到「会话」页并打开某个会话
 */
export function mountTodoView({ panel, call, say, compose, onOpenChat } = {}) {
	if (!panel || typeof panel.appendChild !== "function" || typeof call !== "function") {
		return { refresh: async () => {}, resume: async () => {}, destroy: () => {} };
	}
	injectStyles();

	const root = document.createElement("div");
	root.className = "fp-td";
	root.tabIndex = -1;
	root.innerHTML = `
		<div class="fp-td-head">
			<div class="fp-td-capture">
				<input class="fp-td-new" placeholder="记一条：明天 10 点前给张总发周报  （回车记下）" />
				<button class="fp-td-btn fp-td-primary" data-act="add">记下</button>
			</div>
			<div class="fp-td-parse" hidden></div>
			<div class="fp-td-nav">
				<div class="fp-td-segs">
					<button class="fp-td-seg on" data-seg="today">今天</button>
					<button class="fp-td-seg" data-seg="inbox">收件箱</button>
					<button class="fp-td-seg" data-seg="all">全部</button>
				</div>
				<input class="fp-td-q" placeholder="搜索全部…" />
				<span class="fp-td-spacer"></span>
				<button class="fp-td-btn fp-td-ghost" data-act="briefing" title="一次模型调用：今天先做什么、什么可以放一放">AI 今天怎么办</button>
				<button class="fp-td-btn fp-td-ghost" data-act="more" title="同步 / 提取 / 自动获取">⋯</button>
			</div>
			<div class="fp-td-more" hidden>
				<button class="fp-td-btn" data-act="sync" title="读飞书任务并合并进本地待办">同步飞书任务</button>
				<button class="fp-td-btn" data-act="extract" title="从本地缓存的会话消息里找「需要我做的事」">从消息提取</button>
				<label title="后台定时读飞书任务（只读，不花模型额度）"><input type="checkbox" class="fp-td-auto-sync" /> 定时同步</label>
				<label title="后台定时从消息里提取候选（会花模型额度）"><input type="checkbox" class="fp-td-auto-extract" /> 定时提取</label>
				<select class="fp-td-int" title="自动获取间隔">
					<option value="15">15 分钟</option>
					<option value="30">30 分钟</option>
					<option value="60">60 分钟</option>
					<option value="120">2 小时</option>
				</select>
				<button class="fp-td-btn" data-act="cands-clear" title="把当前候选全部忽略，下一轮提取不再出现">清空候选</button>
				<span class="fp-td-kbd">/ 记一条 · j/k 选择 · x 完成 · Enter 打开</span>
			</div>
		</div>
		<div class="fp-td-stats"></div>
		<div class="fp-td-notice" hidden></div>
		<div class="fp-td-body">
			<div class="fp-td-list-col">
				<div class="fp-td-brief-slot"></div>
				<div class="fp-td-list" tabindex="0" role="listbox" aria-label="待办列表"></div>
			</div>
			<div class="fp-td-detail" hidden></div>
		</div>
	`;

	panel.appendChild(root);

	const $ = (sel) => root.querySelector(sel);
	const elNew = $(".fp-td-new");
	const elQ = $(".fp-td-q");
	const elParse = $(".fp-td-parse");
	const elStats = $(".fp-td-stats");
	const elNotice = $(".fp-td-notice");
	const elMore = $(".fp-td-more");
	const elBrief = $(".fp-td-brief-slot");
	const elList = $(".fp-td-list");
	const elDetail = $(".fp-td-detail");
	const elAutoSync = $(".fp-td-auto-sync");
	const elAutoExtract = $(".fp-td-auto-extract");
	const elInt = $(".fp-td-int");

	let snapshot = {
		items: [],
		candidates: [],
		config: {},
		stats: {},
		capabilities: {},
		adviceTtlMs: 6 * 60 * 60_000,
		running: [],
		briefing: null,
		briefingFresh: false,
	};
	let seg = "today";
	let query = "";
	let selectedId = "";
	let editing = false;
	let histAll = false;
	let draft = null;
	let agentConfirm = null;
	let pendingDelete = "";
	let advisingId = "";
	let briefingBusy = false;
	let adding = false;
	let moreOpen = false;
	let noticeTimer = null;
	let pollTimer = null;
	let destroyed = false;
	let captureOverride = { dueAt: null, priority: null };
	/** 「同步飞书」是显式动作：解析 chips 会重绘输入区，这个意图必须活在重绘之外。 */
	let wantFeishu = false;

	const now = () => Date.now();
	const ttl = () => Number(snapshot.adviceTtlMs) || 6 * 60 * 60_000;
	const findTodo = (id) => (snapshot.items || []).find((todo) => todo.id === id) || null;

	function note(text, tone = "") {
		if (!elNotice) return;
		if (noticeTimer) clearTimeout(noticeTimer);
		if (!text) {
			elNotice.hidden = true;
			elNotice.textContent = "";
			return;
		}
		elNotice.hidden = false;
		elNotice.className = `fp-td-notice ${tone}`;
		elNotice.textContent = text;
		// 成功提示会自己消失；错误留着，直到下一次操作覆盖它。
		if (tone !== "err") noticeTimer = setTimeout(() => note(""), 5000);
	}

	function noticeRunError(err) {
		note(`读取待办失败：${err?.message || err}`, "err");
	}

	/* ------------------------------ 渲染：头部 ------------------------------ */

	function parsedInput() {
		const parsed = parseCapture(elNew?.value || "", { now: now() });
		const dueAt = captureOverride.dueAt === null ? parsed.dueAt : captureOverride.dueAt;
		const priority = captureOverride.priority === null ? parsed.priority : captureOverride.priority;
		return { ...parsed, dueAt, priority };
	}

	function renderParse() {
		if (!elParse) return;
		const parsed = parsedInput();
		const chips = captureChips({ dueAt: parsed.dueAt, priority: parsed.priority }, { now: now() });
		const hasText = String(elNew?.value || "").trim().length > 0;
		const canWrite = Boolean(snapshot.capabilities?.taskWrite);
		const feishuTag = `<label class="fp-td-chip" title="${
			canWrite ? "同时在飞书里建这个任务（之后改标题/截止/完成都会同步回飞书）" : "lark-cli 未就绪：只能在本地记"
		}"><input type="checkbox" class="fp-td-tf" style="width:11px;height:11px;margin:0;accent-color:var(--accent)" ${
			wantFeishu && canWrite ? "checked" : ""
		} ${canWrite ? "" : "disabled"} /> 同步飞书</label>`;
		const chipHtml = chips
			.map(
				(chip) =>
					`<span class="fp-td-chip ${chip.kind === "priority" ? "warn" : ""}">${esc(chip.label)}<button data-act="clear-${
						chip.kind
					}" title="忽略这个解析结果" aria-label="忽略这个解析结果">×</button></span>`,
			)
			.join("");
		elParse.hidden = !hasText;
		elParse.innerHTML = hasText ? `${chipHtml}${feishuTag}<span class="fp-td-kbd">解析错了就点 ×；回车记下</span>` : "";
	}

	function renderStats() {
		if (!elStats) return;
		const stats = snapshot.stats || {};
		// 「收件箱」这个数字要和点进去看到的东西一致：没排期的 + 以后的 + 待采纳候选。
		const inbox =
			(snapshot.items || []).filter((todo) => {
				const bucket = bucketTodo(todo, now());
				return bucket === "inbox" || bucket === "later";
			}).length + (snapshot.candidates || []).length;
		const tasks = (snapshot.items || []).filter(
			(todo) => todo.ref?.kind === "task" && todo.status !== "done" && todo.status !== "dropped",
		).length;
		const cfg = snapshot.config || {};
		const auto = cfg.autoSync || cfg.autoExtract;
		const syncText = snapshot.capabilities?.feishuTasks
			? `飞书任务 ${tasks} 条${snapshot.syncedAt ? ` · ${clockOf(snapshot.syncedAt)} 同步` : ""}`
			: "飞书任务不可用（本地待办照常）";
		elStats.innerHTML = `
			<span>今天 <b>${Number(stats.today) || 0}</b></span>
			<span class="${stats.overdue ? "bad" : ""}">逾期 <b>${Number(stats.overdue) || 0}</b></span>
			<span>收件箱 <b>${inbox}</b></span>
			<span class="fp-td-spacer"></span>
			<button class="fp-td-sync" data-act="sync" title="现在同步一次飞书任务">${esc(syncText)}</button>
			${auto ? `<span>· 自动 ${Number(cfg.intervalMin) || 30} 分钟</span>` : ""}
			${snapshot.briefing && !snapshot.briefingFresh ? '<span class="fp-td-chip warn">简报已过期</span>' : ""}
		`;
	}

	/* ------------------------------ 渲染：候选 ------------------------------ */

	function candidatesHtml(list) {
		if (!list.length) return "";
		return `
			<div class="fp-td-group"><span>来自消息</span><span class="fp-td-group-n">${list.length}</span><span class="fp-td-spacer"></span><span class="fp-td-kbd">记下才进待办</span></div>
			${list
				.map((item) => {
					const sub = [item.detail, item.reason, item.dueAt ? formatDue({ dueAt: item.dueAt }, now()) : ""]
						.filter(Boolean)
						.join(" · ");
					return `<div class="fp-td-row fp-td-cand" data-cid="${esc(item.id)}">
						<span class="fp-td-dot"></span>
						<div class="fp-td-row-main">
							<div class="fp-td-row-line"><span class="fp-td-title">${esc(item.title)}</span></div>
							<div class="fp-td-row-sub">${esc(sub || "来自最近的会话消息")}</div>
						</div>
						<div class="fp-td-cand-ops">
							<button class="fp-td-btn fp-td-primary" data-act="adopt" data-cid="${esc(item.id)}" title="记进待办">记下</button>
							<button class="fp-td-btn" data-act="ignore" data-cid="${esc(item.id)}" title="不再提示这一条">忽略</button>
							${
								item.chatId
									? `<button class="fp-td-btn fp-td-ghost" data-act="cand-origin" data-cid="${esc(item.id)}">原话</button>`
									: ""
							}
						</div>
					</div>`;
				})
				.join("")}`;
	}

	/* ------------------------------ 渲染：列表 ------------------------------ */

	function emptyHtml() {
		if (query) return '<div class="fp-td-empty">没有匹配的待办。</div>';
		if (seg === "today")
			return `<div class="fp-td-empty">今天没有到期的事。<br/>看看收件箱里还有哪些没安排？<br/><button class="fp-td-btn" data-act="seg-inbox">打开收件箱</button></div>`;
		if (seg === "inbox")
			return `<div class="fp-td-empty">收件箱是空的。<br/>记一条不设时间的事，或让 AI 从最近的会话消息里找。<br/><button class="fp-td-btn" data-act="extract">从消息提取</button></div>`;
		return '<div class="fp-td-empty">还没有待办。<br/>上面输入框记一条，回车就存。</div>';
	}

	function renderList() {
		const sections = buildSections(snapshot.items, { seg, query, now: now() });
		const cands = seg === "inbox" && !query ? snapshot.candidates || [] : [];
		const total = sections.reduce((sum, section) => sum + section.items.length, 0) + cands.length;
		if (!total) {
			elList.innerHTML = emptyHtml();
			return;
		}
		const running = snapshot.running || [];
		let html = "";
		if (cands.length) html += candidatesHtml(cands);
		for (const section of sections) {
			html += `<div class="fp-td-group ${section.tone === "bad" ? "bad" : ""}"><span>${esc(section.label)}</span><span class="fp-td-group-n">${section.items.length}</span></div>`;
			html += section.items
				.map((todo) => {
					const live = running.find((row) => row.id === todo.id) || null;
					return todoRowHtml(todo, {
						now: now(),
						selected: todo.id === selectedId,
						running: Boolean(live),
						runningAt: Number(live?.at) || 0,
					});
				})
				.join("");
		}
		elList.innerHTML = html;
	}

	/* ------------------------------ 渲染：简报 ------------------------------ */

	function renderBrief() {
		if (!elBrief) return;
		if (seg !== "today" || query) {
			elBrief.innerHTML = "";
			return;
		}
		const briefing = snapshot.briefing;
		const caps = snapshot.capabilities || {};
		if (!briefing) {
			elBrief.innerHTML = caps.briefing
				? `<div class="fp-td-brief-cta"><span>让 AI 看一眼今天先做什么</span><span class="fp-td-spacer"></span><button class="fp-td-btn" data-act="briefing">生成简报</button></div>`
				: "";
			return;
		}
		const order = (briefing.order || [])
			.map((row) => {
				const todo = findTodo(row.id);
				if (!todo) return "";
				return `<li><button data-act="pick" data-id="${esc(row.id)}">${esc(todo.title)}</button>${
					row.why ? ` — ${esc(row.why)}` : ""
				}</li>`;
			})
			.filter(Boolean)
			.join("");
		const drop = (briefing.drop || [])
			.map((row) => findTodo(row.id))
			.filter(Boolean)
			.map((todo) => todo.title);
		elBrief.innerHTML = `
			<aside class="fp-td-brief">
				<div class="fp-td-brief-head">
					<span class="fp-td-badge">AI 简报</span>
					<span>${esc(clockOf(briefing.at))}</span>
					${snapshot.briefingFresh ? "" : '<span class="fp-td-chip warn">列表已变化</span>'}
					<span class="fp-td-spacer"></span>
					<button class="fp-td-btn fp-td-ghost" data-act="briefing" data-force="1" ${
						briefingBusy ? "disabled" : ""
					}>${briefingBusy ? "生成中…" : "刷新"}</button>
				</div>
				${briefing.summary ? `<p class="fp-td-brief-sum">${esc(briefing.summary)}</p>` : ""}
				${order ? `<ol class="fp-td-brief-order">${order}</ol>` : ""}
				${drop.length ? `<div class="fp-td-brief-drop">可以放一放：${esc(drop.join("、"))}</div>` : ""}
			</aside>`;
	}

	/* ------------------------------ 渲染：详情 ------------------------------ */

	function renderDetail() {
		if (!elDetail) return;
		const todo = selectedId ? findTodo(selectedId) : null;
		if (!todo) {
			selectedId = "";
			editing = false;
			elDetail.hidden = true;
			elDetail.innerHTML = "";
			root.classList.remove("detail-open");
			return;
		}
		elDetail.hidden = false;
		root.classList.add("detail-open");
		elDetail.innerHTML = editing
			? editHtml(todo)
			: detailHtml(todo, {
					now: now(),
					ttl: ttl(),
					capabilities: snapshot.capabilities || {},
					running: snapshot.running || [],
					draft,
					agentConfirm,
					pendingDelete,
					histAll,
					advisingId,
				});
	}

	function render() {
		renderStats();
		renderBrief();
		renderList();
		if (!editing) renderDetail();
	}

	/* -------------------------------- 数据 -------------------------------- */

	function applySnapshot(payload) {
		snapshot = {
			items: payload.items || [],
			candidates: payload.candidates || [],
			config: payload.config || {},
			nextAutoAt: payload.nextAutoAt || 0,
			stats: payload.stats || {},
			capabilities: payload.capabilities || {},
			adviceTtlMs: payload.adviceTtlMs || 6 * 60 * 60_000,
			syncedAt: payload.syncedAt || 0,
			running: Array.isArray(payload.running) ? payload.running : [],
			briefing: payload.briefing || null,
			briefingFresh: Boolean(payload.briefingFresh),
		};
		renderAutoToggles();
	}

	async function refresh({ quiet = false } = {}) {
		try {
			const payload = await call("/todos", { timeoutMs: 15000 });
			applySnapshot(payload);
			render();
			if (!quiet) {
				const stats = snapshot.stats || {};
				const parts = [];
				if (stats.overdue) parts.push(`逾期 ${stats.overdue}`);
				if (stats.today) parts.push(`今天 ${stats.today}`);
				if (snapshot.candidates?.length) parts.push(`待采纳 ${snapshot.candidates.length}`);
				if (parts.length) note(parts.join(" · "), stats.overdue ? "err" : "");
				else note("");
			}
			ensurePolling();
			return payload;
		} catch (err) {
			noticeRunError(err);
			return null;
		}
	}

	/**
	 * 有 AI 在跑就每 5 秒补一次快照；没有就停。
	 * 注意只看 `running`（服务端真的认领着的运行）：只剩一个 `doing` 状态说明运行早断了
	 * （服务重启 / 事件丢了），继续轮询只会每 5 秒空转一次 —— 那种情况由详情里的
	 * 「结束这次处理」交给用户收拾。
	 */
	function ensurePolling() {
		const alive = (snapshot.running || []).length > 0;
		if (alive && !pollTimer) {
			pollTimer = setInterval(() => void refresh({ quiet: true }), 5000);
			return;
		}
		if (!alive && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	/* -------------------------------- 动作 -------------------------------- */

	async function createTodo() {
		if (adding) return;
		const parsed = parsedInput();
		const title = String(parsed.title || "").trim();
		if (!title) {
			elNew?.focus();
			return;
		}
		const toFeishu = Boolean(root.querySelector(".fp-td-tf")?.checked);
		adding = true;
		const btn = root.querySelector('[data-act="add"]');
		if (btn) btn.disabled = true;
		try {
			const payload = await call("/todos/create", {
				method: "POST",
				body: {
					title,
					...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
					...(parsed.priority !== "normal" ? { priority: parsed.priority } : {}),
					toFeishu,
				},
				timeoutMs: 25000,
			});
			elNew.value = "";
			captureOverride = { dueAt: null, priority: null };
			wantFeishu = false;
			renderParse();
			const warning = payload?.writeBack?.warning;
			const when = parsed.dueAt ? formatDue({ dueAt: parsed.dueAt }, now()) : "";
			if (warning) note(warning, "err");
			else note(`已记下${when ? `：${when}` : ""}${toFeishu ? "（已在飞书建任务）" : ""}`, "ok");
			await refresh({ quiet: true });
			const created = payload?.todo;
			if (created?.id) {
				// 只在「当前分段看得到它」时才选中：没排期的事落在收件箱，硬选中会让列表里没有对应行。
				const bucket = bucketTodo(created, now());
				const visible =
					seg === "all" ||
					(seg === "today" && (bucket === "overdue" || bucket === "today" || bucket === "doing")) ||
					(seg === "inbox" && (bucket === "inbox" || bucket === "later"));
				if (visible) {
					selectedId = created.id;
					render();
				} else {
					note(`已记到收件箱${when ? `（${when}）` : ""}`, "ok");
				}
			}
		} catch (err) {
			note(`添加失败：${err.message}`, "err");
		} finally {
			adding = false;
			if (btn) btn.disabled = false;
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

	async function toggleStatus(id) {
		const todo = findTodo(id);
		if (!todo) return;
		await updateTodo(id, { status: todo.status === "done" ? "open" : "done" });
	}

	async function adoptCandidate(cid) {
		const btn = root.querySelector(`[data-act="adopt"][data-cid="${cid}"]`);
		if (btn) btn.disabled = true;
		try {
			const payload = await call("/todos/adopt", { method: "POST", body: { id: cid }, timeoutMs: 25000 });
			note("已记下，可点开补截止时间", "ok");
			await refresh({ quiet: true });
			if (payload?.todo?.id) {
				selectedId = payload.todo.id;
				render();
			}
		} catch (err) {
			note(`记下失败：${err.message}`, "err");
		}
	}

	async function ignoreCandidate(cid) {
		try {
			await call("/todos/candidates-ignore", { method: "POST", body: { id: cid }, timeoutMs: 15000 });
			note("已忽略，这一条不会再出现", "ok");
			await refresh({ quiet: true });
		} catch (err) {
			note(`忽略失败：${err.message}`, "err");
		}
	}

	async function adviseOne(id, { force = false } = {}) {
		if (advisingId) return;
		advisingId = id;
		renderDetail();
		note("AI 正在看这一条…");
		try {
			const payload = await call("/todos/advise", {
				method: "POST",
				body: { ids: [id], force, limit: 1 },
				timeoutMs: 120000,
			});
			const row = (payload.results || [])[0];
			if (row?.error) note(`没算出建议：${row.error}`, "err");
			else note(row?.note || "建议已更新", row?.note ? "err" : "ok");
		} catch (err) {
			note(`生成建议失败：${err.message}`, "err");
		} finally {
			advisingId = "";
			await refresh({ quiet: true });
		}
	}

	async function muteAdvice(id) {
		try {
			await call("/todos/mute", { method: "POST", body: { id }, timeoutMs: 15000 });
			note("已清掉这条建议：下次 AI 会换个说法", "ok");
			await refresh({ quiet: true });
		} catch (err) {
			note(`操作失败：${err.message}`, "err");
		}
	}

	async function requestBriefing({ force = false } = {}) {
		if (briefingBusy) return;
		if (!snapshot.capabilities?.briefing) {
			note("宿主未提供模型补全（llm 能力）", "err");
			return;
		}
		briefingBusy = true;
		renderBrief();
		note("AI 正在看今天…");
		try {
			const payload = await call("/todos/briefing", { method: "POST", body: { force }, timeoutMs: 120000 });
			if (payload?.snapshot) applySnapshot(payload.snapshot);
			if (payload?.empty) note("还没有未完成的事，先记一条", "ok");
			else note(payload?.cached ? "简报还是最新的" : "简报已更新", "ok");
		} catch (err) {
			note(`生成简报失败：${err.message}`, "err");
		} finally {
			briefingBusy = false;
			render();
		}
	}

	async function executeAction(id, actionId, okText) {
		try {
			const payload = await call("/todos/execute", { method: "POST", body: { id, actionId }, timeoutMs: 60000 });
			if (payload.directive?.type === "open" && payload.directive.url) {
				window.open(payload.directive.url, "_blank", "noopener,noreferrer");
			}
			draft = null;
			agentConfirm = null;
			note(okText, "ok");
			await refresh({ quiet: true });
			ensurePolling();
		} catch (err) {
			note(`执行失败：${err.message}`, "err");
		}
	}

	async function runAction(todo, actionId) {
		const action = (todo.advice?.actions || []).find((item) => item.id === actionId);
		if (!action) {
			note("这个动作已经失效（建议被刷新过），点「重算」再试", "err");
			return;
		}
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
			agentConfirm = {
				todoId: todo.id,
				actionId: action.id,
				task: String(action.task || action.label || todo.title || ""),
			};
			renderDetail();
			return;
		}
		// reply：唯一会以你的名义对外说话的动作 —— 先摊开草稿，人确认了才发。
		draft = {
			todoId: todo.id,
			actionId: action.id,
			text: String(action.text || ""),
			recipient: todo.ref?.sender || todo.ref?.title || action.chatId || "该会话",
		};
		renderDetail();
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
		} catch (err) {
			note(`同步失败：${err.message}`, "err");
		}
	}

	async function extractTodos() {
		note("正在读本地缓存的会话消息并让 AI 找待办（最多 8 个会话）…");
		try {
			const payload = await call("/todos/extract", { method: "POST", body: {}, timeoutMs: 150000 });
			const added = Number(payload.added ?? (payload.candidates || []).length) || 0;
			if (!added) {
				note(`扫了 ${payload.chats || 0} 个会话 / ${payload.messages || 0} 条消息，没找到新的待办`, "ok");
			} else {
				note(`从 ${payload.chats || 0} 个会话里找到 ${added} 条候选，点「记下」加入待办`, "ok");
			}
			await refresh({ quiet: true });
		} catch (err) {
			note(`提取失败：${err.message}`, "err");
		}
	}

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

	/* -------------------------------- 事件 -------------------------------- */

	function selectRow(id, { open = true } = {}) {
		if (!id) return;
		selectedId = id;
		editing = false;
		pendingDelete = "";
		histAll = false;
		draft = null;
		agentConfirm = null;
		if (open) root.classList.add("detail-open");
		render();
		// 行是重绘出来的：把焦点收回到面板上，j/k/x 才能接着用（否则焦点掉到 body）。
		root.focus?.({ preventScroll: true });
	}

	function moveSelection(delta) {
		const ids = [...elList.querySelectorAll(".fp-td-row[data-id]")]
			.map((row) => row.getAttribute("data-id"))
			.filter(Boolean);
		if (!ids.length) return;
		const at = ids.indexOf(selectedId);
		const next = at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(Math.max(at + delta, 0), ids.length - 1);
		const targetId = ids[next];
		if (!targetId) return;
		selectRow(targetId, { open: false });
		elList.querySelector(`.fp-td-row[data-id="${targetId}"]`)?.scrollIntoView?.({ block: "nearest" });
	}

	root.addEventListener("input", (ev) => {
		const target = ev.target;
		if (target === elNew) {
			renderParse();
			return;
		}
		if (target === elQ) {
			query = String(elQ.value || "");
			renderBrief();
			renderList();
		}
	});

	root.addEventListener("change", (ev) => {
		const target = ev.target;
		if (target instanceof HTMLInputElement && target.classList.contains("fp-td-tf")) {
			wantFeishu = Boolean(target.checked);
		}
	});

	root.addEventListener("keydown", (ev) => {
		const target = ev.target;
		const inField =
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement;
		if (ev.key === "Escape") {
			if (editing) {
				editing = false;
				renderDetail();
			} else if (selectedId) {
				selectedId = "";
				renderDetail();
			} else if (inField) {
				target.blur?.();
			}
			return;
		}
		if (inField) return;
		if (ev.key === "/" || ev.key === "n") {
			ev.preventDefault();
			elNew?.focus();
			return;
		}
		if (ev.key === "j" || ev.key === "ArrowDown") {
			ev.preventDefault();
			moveSelection(1);
			return;
		}
		if (ev.key === "k" || ev.key === "ArrowUp") {
			ev.preventDefault();
			moveSelection(-1);
			return;
		}
		if ((ev.key === "x" || ev.key === " ") && selectedId) {
			ev.preventDefault();
			void toggleStatus(selectedId);
		}
	});

	root.addEventListener("click", async (ev) => {
		const target = ev.target;
		if (!(target instanceof HTMLElement)) return;
		const btn = target.closest("[data-act]");
		if (!btn) {
			const row = target.closest(".fp-td-row[data-id]");
			if (row) selectRow(row.getAttribute("data-id") || "");
			return;
		}
		const act = btn.getAttribute("data-act") || "";
		const id = btn.getAttribute("data-id") || "";
		const cid = btn.getAttribute("data-cid") || "";
		const todo = id ? findTodo(id) : null;

		if (act === "add") {
			void createTodo();
			return;
		}
		if (act === "clear-due") {
			captureOverride.dueAt = 0;
			renderParse();
			return;
		}
		if (act === "clear-priority") {
			captureOverride.priority = "normal";
			renderParse();
			return;
		}
		if (act === "seg-inbox") {
			seg = "inbox";
			for (const other of root.querySelectorAll(".fp-td-seg"))
				other.classList.toggle("on", other.getAttribute("data-seg") === seg);
			render();
			return;
		}
		if (act === "more") {
			moreOpen = !moreOpen;
			elMore.hidden = !moreOpen;
			return;
		}
		if (act === "briefing") {
			void requestBriefing({ force: btn.getAttribute("data-force") === "1" });
			return;
		}
		if (act === "pick") {
			selectRow(id);
			return;
		}
		if (act === "toggle" && todo) {
			await toggleStatus(todo.id);
			return;
		}
		if (act === "drop" && todo) {
			await updateTodo(todo.id, { status: "dropped" });
			note("已移到「以后再说」，在「全部」里还能找到", "ok");
			return;
		}
		if (act === "unstick" && todo) {
			await updateTodo(todo.id, { status: "open" });
			note("已结束这次处理，可以重新派单", "ok");
			return;
		}
		if (act === "delete" && todo) {
			if (pendingDelete !== todo.id) {
				pendingDelete = todo.id;
				renderDetail();
				note("再点一次确认删除（飞书任务不会跟着删）");
				return;
			}
			pendingDelete = "";
			try {
				const payload = await call("/todos/delete", { method: "POST", body: { id: todo.id }, timeoutMs: 15000 });
				if (payload?.warning) note(payload.warning, "err");
				else note("已删除", "ok");
				selectedId = "";
				await refresh({ quiet: true });
			} catch (err) {
				note(`删除失败：${err.message}`, "err");
			}
			return;
		}
		if (act === "detail-close" || act === "detail-back") {
			selectedId = "";
			editing = false;
			renderDetail();
			return;
		}
		if (act === "edit" && todo) {
			editing = true;
			pendingDelete = "";
			renderDetail();
			elDetail.querySelector(".fp-td-edit-title")?.focus();
			return;
		}
		if (act === "edit-cancel") {
			editing = false;
			renderDetail();
			return;
		}
		if (act === "edit-save" && todo) {
			const title = String(elDetail.querySelector(".fp-td-edit-title")?.value || "").trim();
			const detail = String(elDetail.querySelector(".fp-td-edit-detail")?.value || "").trim();
			const priority = String(elDetail.querySelector(".fp-td-edit-priority")?.value || "normal");
			const dueRaw = String(elDetail.querySelector(".fp-td-edit-due")?.value || "");
			editing = false;
			await updateTodo(todo.id, {
				title: title || todo.title,
				detail,
				priority,
				dueAt: dueRaw ? new Date(dueRaw).getTime() : 0,
			});
			return;
		}
		if (act === "advise-one") {
			void adviseOne(id, { force: true });
			return;
		}
		if (act === "mute") {
			void muteAdvice(id);
			return;
		}
		if (act === "run" && todo) {
			await runAction(todo, btn.getAttribute("data-aid") || "");
			return;
		}
		if (act === "draft-cancel") {
			draft = null;
			renderDetail();
			return;
		}
		if (act === "draft-send") {
			await executeAction(id, btn.getAttribute("data-aid") || "", "已发送");
			return;
		}
		if (act === "agent-cancel") {
			agentConfirm = null;
			renderDetail();
			return;
		}
		if (act === "agent-go") {
			await executeAction(id, btn.getAttribute("data-aid") || "", "已派给 AI，跑完会通知你");
			return;
		}
		if (act === "hist-all") {
			histAll = true;
			renderDetail();
			return;
		}
		if (act === "origin" && todo) {
			if (todo.ref?.chatId && onOpenChat) onOpenChat(todo.ref.chatId);
			else note("这条没有可跳转的会话", "err");
			return;
		}
		if (act === "cand-origin") {
			const cand = (snapshot.candidates || []).find((row) => row.id === cid);
			if (cand?.chatId && onOpenChat) onOpenChat(cand.chatId);
			return;
		}
		if (act === "adopt") {
			void adoptCandidate(cid);
			return;
		}
		if (act === "ignore") {
			void ignoreCandidate(cid);
			return;
		}
		if (act === "sync") {
			void syncFeishu();
			return;
		}
		if (act === "extract") {
			void extractTodos();
			return;
		}
		if (act === "cands-clear") {
			try {
				await call("/todos/candidates-clear", { method: "POST", timeoutMs: 15000 });
				note("已清空候选（同一批不会再出现）", "ok");
				await refresh({ quiet: true });
			} catch (err) {
				note(`清空失败：${err.message}`, "err");
			}
			return;
		}
	});

	root.addEventListener("keydown", (ev) => {
		if (ev.target === elNew && ev.key === "Enter") {
			ev.preventDefault();
			void createTodo();
		}
	});

	elQ?.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") {
			elQ.value = "";
			query = "";
			renderBrief();
			renderList();
		}
	});

	for (const btn of root.querySelectorAll(".fp-td-seg")) {
		btn.addEventListener("click", () => {
			seg = btn.getAttribute("data-seg") || "today";
			for (const other of root.querySelectorAll(".fp-td-seg")) other.classList.toggle("on", other === btn);
			render();
		});
	}

	elAutoSync?.addEventListener("change", () => {
		const autoSync = Boolean(elAutoSync.checked);
		void saveAutoConfig({ autoSync, ...(autoSync ? { restart: true } : {}) }, (cfg) =>
			autoSync ? "已开启定时同步飞书任务" : "已关闭定时同步",
		);
	});

	elAutoExtract?.addEventListener("change", () => {
		const autoExtract = Boolean(elAutoExtract.checked);
		void saveAutoConfig({ autoExtract, ...(autoExtract ? { restart: true } : {}) }, (cfg) =>
			autoExtract ? `已开启定时提取（每 ${cfg.intervalMin} 分钟，会花模型额度）` : "已关闭定时提取",
		);
	});

	elInt?.addEventListener("change", () => {
		const intervalMin = Number(elInt.value) || 30;
		void saveAutoConfig({ intervalMin }, (cfg) => `自动获取间隔已改为 ${cfg.intervalMin} 分钟`);
	});

	/* -------------------------------- 生命周期 -------------------------------- */

	function renderAutoToggles() {
		const cfg = snapshot.config || {};
		if (elAutoSync) elAutoSync.checked = Boolean(cfg.autoSync);
		if (elAutoExtract) elAutoExtract.checked = Boolean(cfg.autoExtract);
		if (elInt) elInt.value = String(Number(cfg.intervalMin) || 30);
	}

	return {
		refresh: () => refresh(),
		/** 页签切回来时调用：静默刷新（不自动算建议/简报 —— 额度只在用户点的时候花）。 */
		async resume() {
			await refresh({ quiet: true });
			renderAutoToggles();
		},
		destroy() {
			destroyed = true;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
			if (noticeTimer) clearTimeout(noticeTimer);
			try {
				root.remove();
			} catch {
				/* 容器已移除 */
			}
		},
	};
}
