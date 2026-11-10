/**
 * plugins/feishu-pro/lib/todo-ai.mjs
 * 「AI 待办」的提示词与回包解析：**纯函数**（不碰宿主、不发请求，单测直接钉行为）。
 *
 * 三条硬约束（都是踩过的坑）：
 *   1. 提示词里必须带**今天的日期与星期** —— 否则模型把"下周一"算到哪一天全凭运气，
 *      待办的截止时间会系统性错位；
 *   2. 回包必须是**机器可读的 JSON**，但绝不能假设它干净：小模型爱套 ```json 围栏、
 *      爱在前后加解释、爱把字符串写成未转义换行。所以解析走"括号配平 + 逐级降级"，
 *      拿不到结构化结果就退化成纯文本建议（面板照样能显示，只是没有按钮）；
 *   3. 动作类型是**白名单**：模型吐出来的 `send_message` / `delete` 之类一律丢弃，
 *      只认 `reply` / `agent` / `insert` / `open`（见 todo-store.mjs 的 ACTION_KINDS）。
 *
 * 预算：`host.llm.complete` 的 prompt 硬上限 8000 字、system 4000 字，这里按 6000 / 1600 收口。
 */
import {
	ACTION_TEXT_LIMIT,
	BRIEFING_ITEM_LIMIT,
	normalizeAdvice,
	normalizeBriefing,
	normalizePriority,
	toMs,
	TODO_PRIORITIES,
} from "./todo-store.mjs";
import { extractJson } from "./json-text.mjs";

const PROMPT_BUDGET = 6000;
const MESSAGE_BUDGET = 4200;
const MESSAGE_TEXT_CAP = 400;

export const ADVICE_SYSTEM = [
	"你是一名严谨的执行助理，负责把用户的一条待办变成「一句话判断 + 可执行步骤 + 可直接执行的动作」。",
	"只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释文字。",
	"JSON 结构：",
	'{"summary":"一句话判断：这条事真正要做什么、卡在哪（≤60字）",',
	' "steps":["2-4 步具体动作，每步一句话，能直接照做"],',
	' "actions":[{"kind":"reply|agent|insert|open","label":"按钮文案（≤8字）","text":"（reply/insert）要发出去或插进输入框的正文","task":"（agent）交给 AI 执行的任务描述","url":"（open）链接"}],',
	' "priority":"low|normal|high|urgent（可选：你建议的优先级）"}',
	"规则：",
	"1. kind 只能是 reply / agent / insert / open；reply 只在输入里明确给出了对话（chatId）时才用；",
	"2. reply 的 text 是**可以直接发出去的成稿**：中文、口语、≤200 字、不要「你好」这类空话、不要署名；",
	"3. agent 的 task 要写成可独立执行的一句话（AI 有文件、命令、飞书工具），不要写「帮我看看」这种空指令；",
	"4. open 的 url 必须来自输入；没有就省略，禁止编造；",
	"5. 不要编造人名、时间、金额、进度；信息不够就在 summary 里说清缺什么；",
	"6. 最多 3 个动作；确实没什么可做的就只给 summary + steps。",
].join("\n");

function clip(value, cap) {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** 本地日期口径（与前端展示的"今天"一致：服务器时区）。 */
export function dayLabel(ms = Date.now()) {
	const d = new Date(toMs(ms, Date.now()) || Date.now());
	const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
	const two = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${week} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 生成建议的提示词。
 * 输入里明确列出「有没有可以发消息的对话」——模型据此决定给 reply 还是 insert，
 * 服务端仍会二次校验（没有 chatId 的 reply 会被降级）。
 */
export function buildAdvicePrompt(todo = {}, { now = Date.now(), selfName = "", sourceNote = "" } = {}) {
	const ref = todo.ref || {};
	const chatId = String(ref.chatId || "").trim();
	const lines = [
		`现在是 ${dayLabel(now)}。`,
		selfName ? `我是 ${selfName}。` : "",
		"下面是我的一条待办，请按系统提示的 JSON 结构给出建议：",
		"",
		`标题：${clip(todo.title, 200) || "（无）"}`,
		`状态：${todo.status === "doing" ? "进行中" : "待处理"}`,
		`优先级：${todo.priority || "normal"}`,
		todo.dueAt ? `截止：${dayLabel(todo.dueAt)}` : "截止：（未设置）",
		todo.detail ? `详细说明：${clip(todo.detail, 1200)}` : "",
		`来源：${todo.source || "manual"}${ref.title ? ` · ${clip(ref.title, 120)}` : ""}${
			ref.sender ? ` · 来自 ${clip(ref.sender, 60)}` : ""
		}`,
		chatId
			? `可以回复的对话：chatId=${chatId}（可以给 kind=reply）`
			: "没有可直接发送的对话（不要给 reply；要发内容请用 insert）",
		ref.url ? `原文链接（可用于 open）：${ref.url}` : "",
		sourceNote ? `补充上下文：${clip(sourceNote, 600)}` : "",
	];
	if (Array.isArray(todo.history) && todo.history.length) {
		lines.push("", "已经做过的事（不要重复建议）：");
		for (const row of todo.history.slice(0, 5)) lines.push(`- ${clip(row.text || row.kind, 120)}`);
	}
	if (todo.advice && todo.advice.summary) {
		lines.push("", `上一次的建议（用户看过但没有执行，请换更直接的做法）：${clip(todo.advice.summary, 200)}`);
	}
	const prompt = lines.filter((line) => line !== "").join("\n");
	return clip(prompt, PROMPT_BUDGET);
}

const PRIORITY_SET = new Set(TODO_PRIORITIES);

/**
 * 解析器搬到了 `json-text.mjs`（自动回复的前置分析也要用同一份）。
 * 这里 re-export：既有调用方与单测的 import 路径不变。
 */
export { extractJson };

/** 模型只吐了没结构的纯文本时，退化成「首行是判断、下面几行是步骤」。 */
function fallbackAdvice(reply, { now = Date.now() } = {}) {
	const text = String(reply ?? "")
		.replace(/```[\s\S]*?```/g, "")
		.trim();
	if (!text) return null;
	const lines = text
		.split(/\n+/)
		.map((line) => line.replace(/^[-*•\d.、)\s]+/, "").trim())
		.filter(Boolean);
	const summary = clip(lines[0] || text, 200);
	const steps = lines.slice(1, 5).map((line) => clip(line, 240));
	return normalizeAdvice({ summary, steps, at: now });
}

/**
 * 解析建议回包。
 * @returns {{advice: object|null, note: string, priority: string}}
 */
export function parseAdviceReply(reply, { todo = null, now = Date.now(), model = "" } = {}) {
	const raw = String(reply ?? "");
	const json = extractJson(raw);
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const advice = normalizeAdvice(
			{
				summary: json.summary ?? json.judgement ?? json.title,
				steps: json.steps ?? json.todos ?? json.plan,
				actions: json.actions,
				at: now,
				model,
			},
			{ now, chatId: todo?.ref?.chatId || "" },
		);
		if (advice) {
			const priority = PRIORITY_SET.has(String(json.priority ?? "").toLowerCase())
				? normalizePriority(json.priority, "")
				: "";
			return { advice, note: "", priority };
		}
	}
	const advice = fallbackAdvice(raw, { now });
	return {
		advice: advice ? { ...advice, model: String(model || ""), at: now } : null,
		note: advice ? "模型没按 JSON 回包，已按纯文本整理（无动作按钮）" : "模型没有给出可用的建议",
		priority: "",
	};
}

export const EXTRACT_SYSTEM = [
	"你是一名严谨的助理，要从聊天记录里找出**真正需要我本人动手**的待办事项。",
	"只输出一个 JSON 对象，不要 markdown 代码围栏，不要解释。结构：",
	'{"items":[{"title":"≤40字的待办标题","detail":"补充信息（谁要什么、原始原话）","dueAt":"YYYY-MM-DD 或空","priority":"low|normal|high|urgent","reason":"为什么判定这是待办（≤30字）"}]}',
	"规则：",
	"1. 只要「别人明确要求我做、且我还没做」的事；寒暄、已完成的确认、纯通知（例如系统消息）不要；",
	"2. 同一个人同一件事只出一条；最多 5 条，按紧急程度排序；",
	"3. dueAt 只能从原文里推断（「明天」「周四之前」「这个月底」按我给出的今天换算成日期），推断不出就留空；",
	"4. 不要编造原文没有的人名、时间、金额。",
].join("\n");

/** 待办提取的提示词：输入是消息窄行（时间升序）。 */
export function buildExtractPrompt(messages = [], { now = Date.now(), selfName = "" } = {}) {
	const rows = (Array.isArray(messages) ? messages : []).map((row) => ({
		at: row?.at || "",
		chat: clip(row?.chat ?? row?.chatName, 40),
		from: clip(row?.from ?? row?.sender, 40),
		text: clip(row?.text, MESSAGE_TEXT_CAP),
	}));
	const head =
		`现在是 ${dayLabel(now)}${selfName ? `，我是 ${selfName}` : ""}。下面是最近的消息（时间升序，` +
		`\`from\` 是我自己 = 我已经说过的，不要当成待办）：`;
	const body = JSON.stringify(rows, null, 1);
	// 超预算就从**最早的**消息开始丢：最近的对话才可能产生新待办。
	let prompt = `${head}\n${body}`;
	while (prompt.length > PROMPT_BUDGET + MESSAGE_BUDGET / 2 && rows.length > 1) {
		rows.shift();
		prompt = `${head}\n${JSON.stringify(rows, null, 1)}`;
	}
	return clip(prompt, PROMPT_BUDGET + MESSAGE_BUDGET);
}

/** 解析提取回包 → 候选待办（不落库，等用户点「采纳」）。 */
export function parseExtractReply(reply, { now = Date.now() } = {}) {
	const json = extractJson(reply);
	const list = Array.isArray(json)
		? json
		: Array.isArray(json?.items)
			? json.items
			: Array.isArray(json?.todos)
				? json.todos
				: [];
	const items = [];
	const seen = new Set();
	for (const row of list) {
		if (!row || typeof row !== "object") continue;
		const title = clip(String(row.title ?? row.summary ?? "").trim(), 120);
		if (!title) continue;
		const key = title.replace(/\s+/g, "");
		if (seen.has(key)) continue;
		seen.add(key);
		const dueRaw = String(row.dueAt ?? row.due ?? "").trim();
		const due = dueRaw ? toMs(dueRaw, 0) : 0;
		items.push({
			title,
			detail: clip(String(row.detail ?? row.context ?? "").trim(), 1000),
			dueAt: due > 0 ? due : 0,
			priority: PRIORITY_SET.has(String(row.priority ?? "").toLowerCase()) ? normalizePriority(row.priority) : "normal",
			reason: clip(String(row.reason ?? "").trim(), 120),
			createdAt: now,
		});
		if (items.length >= 5) break;
	}
	return items;
}

/* ------------------------------- AI 简报 ------------------------------- */

export const BRIEFING_SYSTEM = [
	"你是一名执行助理，要在用户打开清单的十秒内回答两件事：现在先做什么、什么可以先放一放。",
	"只输出一个 JSON 对象，不要 markdown 代码围栏，不要解释文字。结构：",
	'{"summary":"≤80字：今天的整体判断（最该先做哪件、为什么，不要复述标题）",',
	' "order":[{"id":"输入里的待办 id","why":"≤30字：为什么排在这里"}],',
	' "drop":[{"id":"输入里的待办 id","why":"≤30字：为什么现在可以先不做"}]}',
	"规则：",
	"1. id 必须原样来自输入，禁止编造；没有合适的就留空数组；",
	"2. order 最多 3 条、drop 最多 2 条，按重要性排序；",
	"3. 只依据输入里的截止、优先级、建议判断，不要猜金额、进度或人名；",
	"4. 信息不足就在 summary 里说清还缺什么，不要编。",
].join("\n");

/** 简报输入：只给判断需要的字段（id 必须原样带回，界面靠它对回条目）。 */
export function buildBriefingPrompt(items = [], { now = Date.now(), stats = null, selfName = "" } = {}) {
	const rows = (Array.isArray(items) ? items : []).slice(0, BRIEFING_ITEM_LIMIT).map((todo) => ({
		id: todo?.id || "",
		title: clip(todo?.title, 120),
		due: todo?.dueAt ? dayLabel(todo.dueAt) : "",
		priority: todo?.priority || "normal",
		status: todo?.status === "doing" ? "AI 正在处理" : "待处理",
		from: clip(todo?.ref?.sender || todo?.ref?.title, 40),
		advice: clip(todo?.advice?.summary, 120),
	}));
	const head = [
		`现在是 ${dayLabel(now)}${selfName ? `，我是 ${selfName}` : ""}。`,
		stats
			? `清单统计：待处理 ${stats.open || 0} 条，逾期 ${stats.overdue || 0} 条，今天到期 ${stats.today || 0} 条。`
			: "",
		"下面是未完成的事，请按系统提示的 JSON 结构给一份今天的简报：",
	].filter(Boolean);
	const body = JSON.stringify(rows, null, 1);
	let prompt = `${head.join("\n")}\n${body}`;
	// 超预算就从最不重要的（数组尾部）丢：排序本身已经把逾期/今天放前面了。
	while (prompt.length > PROMPT_BUDGET && rows.length > 1) {
		rows.pop();
		prompt = `${head.join("\n")}\n${JSON.stringify(rows, null, 1)}`;
	}
	return clip(prompt, PROMPT_BUDGET);
}

/** 解析简报：结构化失败就退化成"一段话"，至少还能读。 */
export function parseBriefingReply(reply, { now = Date.now(), items = [], model = "" } = {}) {
	const raw = String(reply ?? "");
	const ids = (Array.isArray(items) ? items : []).map((item) => String(item?.id || "")).filter(Boolean);
	const json = extractJson(raw);
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const briefing = normalizeBriefing({ ...json, ids, at: now, model }, { now, items });
		if (briefing) return briefing;
	}
	const text = raw
		.replace(/```[\s\S]*?```/g, "")
		.replace(/[{}"]/g, "")
		.trim();
	if (!text) return null;
	return normalizeBriefing({ summary: clip(text.split(/\n+/)[0] || text, 300), ids, at: now, model }, { now, items });
}

/**
 * 「让 AI 处理」时投给 host.chat 的任务文本。
 * 与建议里的 `agent.task` 不同：这里**固定**写清边界（能做什么、不能做什么、做完怎么回报），
 * 因为这条提示词是绕过界面的最后一道闸 —— 用户点的是「自动处理」，不是「随便处理」。
 */
export function buildAgentTask(todo = {}, { now = Date.now(), action = null, selfName = "" } = {}) {
	const ref = todo.ref || {};
	const lines = [
		`[飞书待办 · 自动处理] ${clip(todo.title, 160)}`,
		todo.detail ? `背景：${clip(todo.detail, 800)}` : "",
		todo.dueAt ? `截止：${dayLabel(todo.dueAt)}` : "",
		ref.title ? `来源：${clip(ref.title, 120)}${ref.sender ? `（${clip(ref.sender, 40)}）` : ""}` : "",
		ref.chatId ? `相关会话 chatId：${ref.chatId}（可用飞书工具读取；发送前先确认收件人）` : "",
		`现在是 ${dayLabel(now)}${selfName ? `，我是 ${selfName}` : ""}。`,
	];
	if (todo.advice?.summary) lines.push(`已有判断：${clip(todo.advice.summary, 200)}`);
	if (Array.isArray(todo.advice?.steps) && todo.advice.steps.length) {
		lines.push(`建议步骤：${todo.advice.steps.map((step) => clip(step, 120)).join("；")}`);
	}
	if (action?.task) lines.push(`本次要做的事：${clip(action.task, 600)}`);
	lines.push(
		"执行要求：",
		"1. 只处理这一件事，不要顺手改别的文件或给别人发无关消息；",
		"2. 需要发消息时，先判断收件人与措辞是否明确：不明确就不要发，把草稿留在回复里；",
		"3. 用工具真的把事情做完（改文件 / 查资料 / 发消息），不要只给计划；",
		"4. 最后用 3 行以内说清：做了什么、结果如何、还需要我做什么。",
	);
	return clip(lines.filter(Boolean).join("\n"), PROMPT_BUDGET);
}

/**
 * 发送幂等键：同一条待办 + 同一个动作永远得到同一个 uuid。
 * 重试（网络抖动 / 用户连点）在飞书侧被去重，不会发两遍 —— 与 im_send 同一条铁律。
 */
export function replyUuidFor(todo = {}, action = {}) {
	const base = `${todo.id || ""}|${todo.ref?.chatId || ""}|${action.id || ""}`;
	let hash = 2166136261;
	for (let i = 0; i < base.length; i += 1) {
		hash ^= base.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `fptodo${(hash >>> 0).toString(36)}`.slice(0, 50);
}

/** 动作执行前的服务端二次校验口径（前端传什么都要过一遍）。 */
export function sanitizeOutgoingText(value) {
	return clip(String(value ?? "").trim(), ACTION_TEXT_LIMIT);
}
