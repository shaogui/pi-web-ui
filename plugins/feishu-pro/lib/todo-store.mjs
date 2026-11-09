/**
 * plugins/feishu-pro/lib/todo-store.mjs
 * 「AI 待办」本地库：**纯函数**（无 IO、无宿主、无随机/时钟副作用——now 与 id 都可注入）。
 *
 * 为什么插件自己存一份：
 *   - 飞书任务（task/v2）只能表达「标题 + 截止时间 + 完成」，装不下三样东西：
 *     AI 给出的**处理建议**、建议附带的**可执行动作**、以及「谁在什么时候点了哪个动作」的审计；
 *   - 用户的待办大量来自**消息与文档**（"你明天把方案发我"），这些不会变成飞书任务；
 *   - 服务端存储是插件私有 KV（`<pluginDir>/storage.json`），CLI 不可用时本库仍然可用，
 *     面板不会因为"没装 CLI"整块瘫掉。
 *
 * 与飞书任务的关系是**合并**而不是镜像：飞书给的字段（标题/截止/完成）以飞书为准，
 * 本地字段（建议、动作、历史、AI 备注）永远保留 —— 同步不该抹掉用户已经看过的建议。
 */

export const TODO_STORE_KEY = "todos";
/** 自动获取（定时同步 / 定时提取）的配置：单独一个键，脏配置不该拖垮待办列表。 */
export const TODO_CONFIG_KEY = "todos.config";
export const TODO_STORE_VERSION = 1;
/** 条目上限：storage.json 是单文件原子写，太多会拖慢每次落盘。 */
export const TODO_LIMIT = 300;
export const TODO_HISTORY_LIMIT = 24;
/** 建议的保鲜期：6 小时内不重复花用户的模型额度。 */
export const ADVICE_TTL_MS = 6 * 60 * 60_000;
/** 一次「AI 梳理」最多处理几条（打开面板时自动触发的批次上限）。 */
export const TODO_ADVICE_LIMIT = 3;

/** 自动获取的间隔下限/上限（分钟）：15 分钟是下限 —— 再密就该手动点，模型额度是用户的。 */
export const TODO_AUTO_MIN_MINUTES = 15;
export const TODO_AUTO_MAX_MINUTES = 360;
export const TODO_AUTO_DEFAULT_MINUTES = 30;
/** 待采纳候选的保留上限（自动提取会反复产出，不能无限堆）。 */
export const TODO_CANDIDATE_LIMIT = 20;
/** 删掉的联动任务（guid）最多记多少条：只用于「别在下次同步时又拉回来」。 */
export const TODO_DELETED_TASK_LIMIT = 100;

export const TODO_STATUSES = ["open", "doing", "done", "dropped"];
export const TODO_PRIORITIES = ["low", "normal", "high", "urgent"];
export const TODO_SOURCES = ["manual", "feishu", "extract", "agent"];
/** 建议里的动作类型白名单：只认这四种，模型吐别的直接丢。 */
export const ACTION_KINDS = ["reply", "agent", "insert", "open"];
/** 动作文本上限（服务端与前端共用同一口径）。 */
export const ACTION_TEXT_LIMIT = 1500;
export const ADVICE_STEP_LIMIT = 6;
export const ADVICE_ACTION_LIMIT = 4;

const TITLE_CAP = 200;
const DETAIL_CAP = 4000;
const SUMMARY_CAP = 400;
const URL_CAP = 2000;

const STATUS_ORDER = { open: 0, doing: 1, done: 2, dropped: 3 };
const PRIORITY_ORDER = { low: 0, normal: 1, high: 2, urgent: 3 };

const text = (value, cap = 0) => {
	const out =
		typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
	return cap > 0 && out.length > cap ? out.slice(0, cap) : out;
};

const num = (value, fallback = 0) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

const clampInt = (value, min, max, fallback) => {
	const n = Math.round(num(value, NaN));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
};

/** 短哈希：候选去重键要稳定（同一条候选重算/重启后仍是同一个 id，界面不会重复出按钮）。 */
function hash36(value) {
	let hash = 2166136261;
	const raw = String(value ?? "");
	for (let i = 0; i < raw.length; i += 1) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

/** 毫秒时间戳归一：接受 ms / 秒 / ISO 字符串；0 = 没有。 */
export function toMs(value, fallback = 0) {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return fallback;
		// 秒级时间戳（飞书任务 due.timestamp 就是字符串毫秒，但别赌）
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	const raw = text(value);
	if (!raw) return fallback;
	if (/^\d+$/.test(raw)) return toMs(Number(raw), fallback);
	const ms = Date.parse(raw);
	return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

export function normalizeStatus(value, fallback = "open") {
	const out = text(value).toLowerCase();
	return TODO_STATUSES.includes(out) ? out : fallback;
}

export function normalizePriority(value, fallback = "normal") {
	const out = text(value).toLowerCase();
	return TODO_PRIORITIES.includes(out) ? out : fallback;
}

export function normalizeSource(value, fallback = "manual") {
	const out = text(value).toLowerCase();
	return TODO_SOURCES.includes(out) ? out : fallback;
}

/** 动作 ID：同一份建议里必须唯一且稳定（前端按钮 data-* 与幂等键都靠它）。 */
export function actionIdOf(kind, index = 0) {
	return `a${index}_${text(kind, 16) || "act"}`;
}

/** 待办 ID：时间前缀可读 + 随机后缀防撞。 */
export function newTodoId(now = Date.now(), rand = Math.random) {
	const stamp = Math.max(0, Math.round(num(now, Date.now()))).toString(36);
	const noise = Math.floor(Math.abs(num(rand(), 0.5)) * 36 ** 4)
		.toString(36)
		.padStart(4, "0")
		.slice(-4);
	return `td_${stamp}_${noise}`;
}

/**
 * 来源引用归一：`kind:id` 是**跨同步去重键**（飞书任务按 guid、消息按 messageId）。
 * 拿不到稳定 ID 时留空 —— 宁可重复一条，也不要把两条不同的事合成一条。
 */
export function normalizeRef(raw = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	const kind = ["task", "chat", "doc", "manual"].includes(text(src.kind)) ? text(src.kind) : "manual";
	const id = text(src.id, 128);
	const chatId = text(src.chatId, 128);
	const sender = text(src.sender, 80);
	const title = text(src.title, TITLE_CAP);
	const url = text(src.url, URL_CAP);
	return {
		kind,
		id,
		chatId,
		sender,
		title,
		url,
	};
}

/** 去重键：有来源引用就用来源，没有就用本地 id。 */
export function todoKeyOf(todo) {
	const ref = todo?.ref;
	const kind = text(ref?.kind);
	const id = text(ref?.id);
	if (id && kind && kind !== "manual") return `${kind}:${id}`;
	return `id:${text(todo?.id)}`;
}

/** 历史条目：动作可审计（谁点的、跑了什么、结果如何），上限滚动。 */
export function pushHistory(todo, entry = {}, { now = Date.now(), limit = TODO_HISTORY_LIMIT } = {}) {
	const list = Array.isArray(todo?.history) ? todo.history : [];
	const row = {
		at: num(entry.at, now) || now,
		kind: text(entry.kind, 32) || "note",
		text: text(entry.text, 600),
	};
	if (entry.ref) row.ref = text(entry.ref, 200);
	return [row, ...list].slice(0, Math.max(1, limit));
}

/**
 * 单条建议归一。`actions` 只保留白名单类型；`reply` 没有明确收件人（chatId）时**降级成 insert**：
 * 宁可让用户自己粘一下，也不要把消息发给一个模型猜出来的对象。
 */
export function normalizeAction(raw = {}, { index = 0, chatId = "" } = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	let kind = text(src.kind).toLowerCase();
	if (!ACTION_KINDS.includes(kind)) return null;
	const label =
		text(src.label, 40) || { reply: "发回复", agent: "让 AI 处理", insert: "插入输入框", open: "打开链接" }[kind];
	const body = text(src.text, ACTION_TEXT_LIMIT);
	const url = text(src.url, URL_CAP);
	const task = text(src.task, 800);
	const recipient = text(src.chatId, 128) || text(chatId, 128);
	// `ranAt` 必须跟着动作走：否则每次 normalize（保存/同步/建议更新）都会把「已执行」抹掉，
	// 界面又变回可点，同一件事会被发两遍。
	const ranAt = num(src.ranAt, 0);
	const ran = ranAt > 0 ? { ranAt } : {};
	if (kind === "insert" && !body) return null;
	if (kind === "open" && !/^https?:\/\//i.test(url)) return null;
	if (kind === "agent" && !task && !label) return null;
	let out = { id: actionIdOf(kind, index), kind, label, ...ran };
	if (kind === "reply") {
		if (!body) return null;
		if (!recipient) {
			// 没有可发对象：降级为「插到输入框」，动作类型也随之改掉（界面按钮文案跟着变）。
			out = { id: actionIdOf("insert", index), kind: "insert", label: "插入回复草稿", text: body, ...ran };
			return out;
		}
		out.chatId = recipient;
		out.text = body;
	}
	if (kind === "insert") out.text = body;
	if (kind === "agent") {
		out.task = task || label;
		if (body) out.text = body;
	}
	if (kind === "open") out.url = url;
	return out;
}

/** 建议归一：结构对不上就整块丢掉（返回 null），不要留半截 UI。 */
export function normalizeAdvice(raw, { now = Date.now(), chatId = "" } = {}) {
	if (!raw || typeof raw !== "object") return null;
	const summary = text(raw.summary, SUMMARY_CAP);
	const steps = (Array.isArray(raw.steps) ? raw.steps : [])
		.map((step) => text(step, 240))
		.filter(Boolean)
		.slice(0, ADVICE_STEP_LIMIT);
	const actions = (Array.isArray(raw.actions) ? raw.actions : [])
		.map((action, index) => normalizeAction(action, { index, chatId }))
		.filter(Boolean)
		.slice(0, ADVICE_ACTION_LIMIT);
	if (!summary && !steps.length && !actions.length) return null;
	return {
		summary,
		steps,
		actions,
		model: text(raw.model, 120),
		at: num(raw.at, now) || now,
	};
}

/** 待办归一：白名单字段 + 幂等（normalizeTodo(normalizeTodo(x)) 等价于 normalizeTodo(x)）。 */
export function normalizeTodo(raw = {}, { now = Date.now(), prev = null } = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	const before = prev && typeof prev === "object" ? prev : null;
	// doneAt 只跟 status 走：转 done 时补、转回 open 时清，避免出现"未完成但有完成时间"。
	const status = normalizeStatus(src.status, before ? before.status : "open");
	const doneAt = status === "done" ? num(src.doneAt, before?.doneAt || now) || now : 0;
	const ref = normalizeRef(src.ref && typeof src.ref === "object" ? src.ref : before?.ref);
	const adviceRaw = src.advice === null ? null : src.advice === undefined ? (before?.advice ?? null) : src.advice;
	const advice = normalizeAdvice(adviceRaw, { now, chatId: ref.chatId });
	const createdAt = num(src.createdAt, before?.createdAt || now) || now;
	const updatedAt = num(src.updatedAt, now) || now;
	return {
		id: text(src.id, 64) || text(before?.id, 64) || newTodoId(now),
		title: text(src.title ?? before?.title, TITLE_CAP),
		detail: text(src.detail ?? before?.detail, DETAIL_CAP),
		status,
		priority: normalizePriority(src.priority, before ? before.priority : "normal"),
		source: normalizeSource(src.source, before ? before.source : "manual"),
		dueAt: num(src.dueAt, before?.dueAt || 0),
		ref,
		advice,
		/** 用户手动勾掉的"这条建议没用"：清空 advice 的同时记一笔，AI 下次换个说法。 */
		adviceMutedAt: num(src.adviceMutedAt, before?.adviceMutedAt || 0),
		history: (Array.isArray(src.history) ? src.history : before?.history || [])
			.map((row) => ({
				at: num(row?.at, 0),
				kind: text(row?.kind, 32) || "note",
				text: text(row?.text, 600),
				...(row?.ref ? { ref: text(row.ref, 200) } : {}),
			}))
			.filter((row) => row.at > 0 && (row.text || row.kind !== "note"))
			.slice(0, TODO_HISTORY_LIMIT),
		createdAt,
		updatedAt: Math.max(createdAt, updatedAt),
		doneAt,
	};
}

/* ---------------------------- 自动获取配置 ---------------------------- */

/**
 * 自动获取配置归一：默认**全关**（会自动花模型额度的事必须由用户显式打开）。
 * `lastResult` / `lastError` 是给面板的一行状态，`lastRunAt` 是调度基准（失败也要记，否则会热循环）。
 */
export function normalizeTodoConfig(raw = {}, { now = Date.now() } = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	return {
		autoSync: Boolean(src.autoSync),
		autoExtract: Boolean(src.autoExtract),
		intervalMin: clampInt(src.intervalMin, TODO_AUTO_MIN_MINUTES, TODO_AUTO_MAX_MINUTES, TODO_AUTO_DEFAULT_MINUTES),
		lastRunAt: num(src.lastRunAt, 0),
		lastResult: text(src.lastResult, 300),
		lastError: text(src.lastError, 300),
		updatedAt: num(src.updatedAt, now) || now,
	};
}

/** 配置是否开着任意一种自动获取。 */
export function isAutoEnabled(config) {
	return Boolean(config?.autoSync || config?.autoExtract);
}

/**
 * 下次自动运行的时间（0 = 未启用）。
 * 从没跑过 → 立刻（`now`）；已经过点（服务停过/睡过一晚）→ 也返回 `now`，醒来先补一轮。
 */
export function autoNextAt(config, { now = Date.now() } = {}) {
	if (!isAutoEnabled(config)) return 0;
	const every =
		clampInt(config.intervalMin, TODO_AUTO_MIN_MINUTES, TODO_AUTO_MAX_MINUTES, TODO_AUTO_DEFAULT_MINUTES) * 60_000;
	const last = num(config.lastRunAt, 0);
	if (!last) return now;
	return last + every <= now ? now : last + every;
}

/* ---------------------------- 待采纳候选 ---------------------------- */

/** 候选去重键：标题归一（中文不分词，直接去空白 + 忽略大小写）。 */
export function candidateKeyOf(row) {
	return text(row?.title).replace(/\s+/g, "").toLowerCase();
}

/** 候选归一：没有标题就没意义（返回 null，界面不留半截按钮）。 */
export function normalizeCandidate(raw = {}, { now = Date.now() } = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	const title = text(src.title, TITLE_CAP);
	if (!title) return null;
	return {
		// id 由标题哈希而来：同一条候选在重算/重启后仍是同一个 id，"记下"按钮不会被点第二遍。
		id: text(src.id, 64) || `cd_${hash36(candidateKeyOf({ title }))}`,
		title,
		detail: text(src.detail, 1000),
		dueAt: toMs(src.dueAt ?? src.due_at, 0),
		priority: normalizePriority(src.priority, "normal"),
		reason: text(src.reason, 160),
		chat: text(src.chat, 80),
		chatId: text(src.chatId, 128),
		sender: text(src.sender, 80),
		messageId: text(src.messageId, 128),
		at: num(src.at ?? src.createdAt, now) || now,
	};
}

/** 合并候选（按标题去重，新的在前，封顶 limit）；已存在的不覆盖 —— 用户可能正在看。 */
export function mergeCandidates(existing, incoming, { now = Date.now(), limit = TODO_CANDIDATE_LIMIT } = {}) {
	const byKey = new Map();
	for (const row of Array.isArray(existing) ? existing : []) {
		const cand = normalizeCandidate(row, { now });
		if (cand) byKey.set(candidateKeyOf(cand), cand);
	}
	const before = byKey.size;
	for (const row of Array.isArray(incoming) ? incoming : []) {
		const cand = normalizeCandidate(row, { now });
		if (!cand) continue;
		const key = candidateKeyOf(cand);
		if (byKey.has(key)) continue;
		byKey.set(key, cand);
	}
	const items = [...byKey.values()].sort((a, b) => num(b.at, 0) - num(a.at, 0)).slice(0, Math.max(1, limit));
	return { items, added: byKey.size - before, total: items.length };
}

/**
 * 已删除的联动任务 guid：本地删了但飞书任务还在（删远程是破坏性操作，不自动做）。
 * 不记这一笔的话，下一轮自动同步会把同一条又拉回来 —— 用户会以为删除失效了。
 */
export function normalizeDeletedTaskIds(raw) {
	const list = Array.isArray(raw) ? raw : [];
	const seen = new Set();
	const out = [];
	for (const row of list) {
		const id = text(row, 128);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= TODO_DELETED_TASK_LIMIT) break;
	}
	return out;
}

/** 存储归一：兼容"只存了数组"的老数据。 */
export function normalizeStore(raw, { now = Date.now() } = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	const list = Array.isArray(src) ? src : Array.isArray(src.items) ? src.items : [];
	const seen = new Set();
	const items = [];
	for (const row of list) {
		const todo = normalizeTodo(row, { now });
		if (!todo.title && !todo.detail) continue;
		const key = todoKeyOf(todo);
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(todo);
		if (items.length >= TODO_LIMIT) break;
	}
	return {
		version: TODO_STORE_VERSION,
		items: sortTodos(items),
		// 自动提取出来的候选也要落盘：面板没开着的时候发现的事，回来还得看得见。
		candidates: mergeCandidates([], Array.isArray(src) ? [] : src.candidates, { now }).items,
		deletedTaskIds: normalizeDeletedTaskIds(Array.isArray(src) ? [] : src.deletedTaskIds),
		syncedAt: Array.isArray(src) ? 0 : num(src.syncedAt, 0),
		updatedAt: Array.isArray(src) ? 0 : num(src.updatedAt, 0),
	};
}

/**
 * 排序：未完成在前 → 有截止时间的在前（早的优先）→ 优先级高在前 → 最近动过的在前。
 * 完成/放弃的沉到最底，但**不隐藏**（用户要能翻回去看 AI 当时建议了什么）。
 */
export function sortTodos(items) {
	const list = Array.isArray(items) ? items : [];
	return [...list].sort((a, b) => {
		const sa = STATUS_ORDER[a?.status] ?? 9;
		const sb = STATUS_ORDER[b?.status] ?? 9;
		if (sa !== sb) return sa - sb;
		const da = num(a?.dueAt, 0);
		const db = num(b?.dueAt, 0);
		if (Boolean(da) !== Boolean(db)) return da ? -1 : 1;
		if (da && db && da !== db) return da - db;
		const pa = PRIORITY_ORDER[a?.priority] ?? 1;
		const pb = PRIORITY_ORDER[b?.priority] ?? 1;
		if (pa !== pb) return pb - pa;
		return num(b?.updatedAt, 0) - num(a?.updatedAt, 0);
	});
}

/** 写入/替换一条（同 key 覆盖，保留原 id 与 createdAt）。 */
export function upsertTodo(items, todo, { now = Date.now(), limit = TODO_LIMIT } = {}) {
	const list = Array.isArray(items) ? items : [];
	const key = todoKeyOf(todo);
	const prev = list.find((item) => todoKeyOf(item) === key || (todo.id && item.id === todo.id)) || null;
	const merged = normalizeTodo({ ...prev, ...todo, createdAt: prev?.createdAt || todo.createdAt }, { now, prev });
	const rest = list.filter((item) => item !== prev && todoKeyOf(item) !== key && item.id !== merged.id);
	return sortTodos([merged, ...rest]).slice(0, Math.max(1, limit));
}

/** 部分更新（白名单字段）；`status` 变更会补/清 doneAt 并记一条历史。 */
export function applyTodoPatch(items, id, patch = {}, { now = Date.now() } = {}) {
	const list = Array.isArray(items) ? items : [];
	const target = list.find((item) => item.id === text(id));
	if (!target) return { items: list, todo: null };
	const src = patch && typeof patch === "object" ? patch : {};
	const next = {
		...target,
		...(Object.hasOwn(src, "title") ? { title: patchText(src.title, target.title, TITLE_CAP) } : {}),
		...(Object.hasOwn(src, "detail") ? { detail: patchText(src.detail, target.detail, DETAIL_CAP) } : {}),
		...(Object.hasOwn(src, "status") ? { status: normalizeStatus(src.status, target.status) } : {}),
		...(Object.hasOwn(src, "priority") ? { priority: normalizePriority(src.priority, target.priority) } : {}),
		...(Object.hasOwn(src, "dueAt") ? { dueAt: toMs(src.dueAt, 0) } : {}),
		updatedAt: now,
	};
	if (next.status === "done" && target.status !== "done") {
		next.history = pushHistory(next, { kind: "done", text: "标记完成" }, { now });
	}
	if (next.status !== "done" && target.status === "done") {
		next.history = pushHistory(next, { kind: "reopen", text: "重新打开" }, { now });
	}
	const todo = normalizeTodo(next, { now, prev: target });
	return { items: sortTodos(list.map((item) => (item.id === todo.id ? todo : item))), todo };
}

/** 缺字段（undefined）保留原值；显式 null 才清空 —— 避免前端漏传把内容抹掉。 */
function patchText(value, fallback, cap) {
	if (value === undefined) return text(fallback, cap);
	if (value === null) return "";
	return text(value, cap);
}

export function removeTodo(items, id) {
	const list = Array.isArray(items) ? items : [];
	const target = text(id);
	return list.filter((item) => item.id !== target);
}

/** 统计（面板头部与通知共用同一口径）。 */
export function todoStats(items, { now = Date.now() } = {}) {
	const list = Array.isArray(items) ? items : [];
	const dayStart = startOfDay(now);
	const dayEnd = dayStart + 24 * 60 * 60_000;
	const out = { total: list.length, open: 0, doing: 0, done: 0, dropped: 0, overdue: 0, today: 0, urgent: 0 };
	for (const todo of list) {
		const status = normalizeStatus(todo?.status);
		out[status] = (out[status] || 0) + 1;
		if (status === "done" || status === "dropped") continue;
		const due = num(todo?.dueAt, 0);
		if (due && due < now) out.overdue += 1;
		else if (due && due < dayEnd) out.today += 1;
		if (todo?.priority === "urgent") out.urgent += 1;
	}
	return out;
}

export function startOfDay(ms = Date.now()) {
	const d = new Date(num(ms, Date.now()));
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** 截止状态：给前端一个词，前端别再自己算（两边算不一样的"今天"很常见）。 */
export function dueInfo(todo, { now = Date.now() } = {}) {
	const due = num(todo?.dueAt, 0);
	if (!due) return { kind: "none", ms: 0 };
	if (todo?.status === "done" || todo?.status === "dropped") return { kind: "closed", ms: due };
	if (due < now) return { kind: "overdue", ms: due };
	const dayEnd = startOfDay(now) + 24 * 60 * 60_000;
	if (due < dayEnd) return { kind: "today", ms: due };
	const d = Math.round((startOfDay(due) - startOfDay(now)) / (24 * 60 * 60_000));
	return { kind: d <= 3 ? "soon" : "later", ms: due, days: d };
}

/** 建议是否还新鲜（同一条待办 6 小时内不重复烧额度）。 */
export function isAdviceFresh(todo, { now = Date.now(), ttlMs = ADVICE_TTL_MS } = {}) {
	if (!todo?.advice) return false;
	if (num(todo.adviceMutedAt, 0) && num(todo.adviceMutedAt, 0) >= num(todo.advice.at, 0)) return false;
	return now - num(todo.advice.at, 0) < Math.max(60_000, num(ttlMs, ADVICE_TTL_MS));
}

/**
 * 该先给谁生成建议：未完成 + 建议过期 + 未被静音。
 * 排序与列表一致（逾期/今天在最前），一次最多 limit 条 —— 模型调用是有成本的。
 */
export function pickAdviceTargets(items, { now = Date.now(), limit = 3, ttlMs = ADVICE_TTL_MS } = {}) {
	return sortTodos(items)
		.filter((todo) => todo.status === "open" || todo.status === "doing")
		.filter((todo) => !isAdviceFresh(todo, { now, ttlMs }))
		.filter((todo) => !num(todo.adviceMutedAt, 0) || num(todo.adviceMutedAt, 0) < num(todo.updatedAt, 0))
		.slice(0, Math.max(0, limit));
}

/** 搜索：标题/正文/来源标题/建议正文都能命中（中文不分词，直接 includes）。 */
export function matchTodo(todo, query) {
	const needle = text(query).toLowerCase();
	if (!needle) return true;
	const hay = [
		todo?.title,
		todo?.detail,
		todo?.ref?.title,
		todo?.ref?.sender,
		todo?.advice?.summary,
		...(Array.isArray(todo?.advice?.steps) ? todo.advice.steps : []),
		todo?.priority,
		todo?.status,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return hay.includes(needle);
}

/* ---------------------------- 飞书任务合并 ---------------------------- */

/**
 * 飞书任务 → 本地待办。
 * 只取"我相关"的语义字段：标题、描述、截止、完成态；其余（清单、自定义字段）先不落库。
 */
export function todoFromFeishuTask(task = {}, { now = Date.now(), prev = null } = {}) {
	const src = task && typeof task === "object" ? task : {};
	const guid = text(src.guid ?? src.id ?? src.taskGuid, 128);
	const completedAt = toMs(src.completedAt ?? src.completed_at, 0);
	const due = toMs(src.dueAt ?? src.due_at ?? src.due?.timestamp ?? src.due?.time ?? src.due?.date, prev?.dueAt || 0);
	return normalizeTodo(
		{
			id: prev?.id,
			title: text(src.title ?? src.summary ?? prev?.title, TITLE_CAP),
			detail: text(src.detail ?? src.description ?? prev?.detail, DETAIL_CAP),
			status: completedAt ? "done" : prev && prev.status === "done" ? "open" : prev?.status || "open",
			priority: prev?.priority || "normal",
			source: "feishu",
			dueAt: due,
			doneAt: completedAt,
			ref: { kind: "task", id: guid, title: text(src.title ?? src.summary, TITLE_CAP), url: text(src.url, URL_CAP) },
			advice: prev?.advice ?? null,
			history: prev?.history || [],
			createdAt: prev?.createdAt || now,
			updatedAt: now,
		},
		{ now, prev },
	);
}

/**
 * 把飞书任务合并进本地库（按 `task:<guid>` 去重）。
 * 本地独有字段（建议/历史/优先级）保留；飞书已完成的条目不会因为"本地还是 open"被拉回来。
 */
export function mergeFeishuTasks(items, tasks, { now = Date.now(), limit = TODO_LIMIT, skip = [] } = {}) {
	const list = Array.isArray(items) ? items : [];
	// 本地删掉的联动任务：不能因为「飞书里还在」就被拉回来（删除得是删除）。
	const skipSet = new Set((Array.isArray(skip) ? skip : []).map((id) => text(id, 128)));
	const incoming = (Array.isArray(tasks) ? tasks : []).filter((task) => text(task?.guid ?? task?.id ?? task?.taskGuid));
	const byKey = new Map(list.map((item) => [todoKeyOf(item), item]));
	let added = 0;
	let updated = 0;
	for (const task of incoming) {
		const guid = text(task?.guid ?? task?.id ?? task?.taskGuid, 128);
		if (skipSet.has(guid)) continue;
		const key = `task:${guid}`;
		const prev = byKey.get(key) || null;
		const todo = todoFromFeishuTask(task, { now, prev });
		if (!todo.title) continue;
		byKey.set(key, todo);
		if (prev) updated += 1;
		else added += 1;
	}
	const merged = sortTodos([...byKey.values()]).slice(0, Math.max(1, limit));
	return { items: merged, added, updated, total: incoming.length };
}
