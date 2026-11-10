/**
 * plugins/feishu-pro/lib/chat-ai.mjs
 * 会话页「让 AI 代写回复」：按需跑一轮无头 agent，拿到一段可直接发出去的正文。
 *
 * 与 lib/auto-reply.mjs 的分工（两者不要合并）：
 *   - auto-reply 是**无人值守**回包：白名单 / 冷却 / 限频 / 陈旧判定，默认关；
 *   - 这里是**人在会话页点一下**的按需回复（预览 or 直发）—— 判定就是那次点击。
 * 两者共用同一套宿主契约：`host.chat` 派活、回执 `runId` 认领 `onRunEvent`、
 * 「宁可少发，不可重发」（发送失败不自动重试）。
 *
 * 提示词刻意自包含（把最近几条消息贴进去），因为每次点击都是一条独立的无头运行：
 *   - 不让模型自己去翻会话（少一次工具往返，也避免它顺手调用 im_send 真发出去）；
 *   - 明确「只输出正文」——宿主没有独立 system 通道，规则只能写在正文提示里。
 */

/** 与自动回复、待办各用各的账号：多轮会话记忆互不污染。 */
export const CHAT_AI_ACCOUNT_ID = "feishu-pro:chat-ai";
/** 一轮生成的兜底时限：模型慢/工具卡住时别让浏览器请求一直挂着。 */
export const CHAT_AI_TIMEOUT_MS = 180_000;
/** 贴进提示词的最近消息条数（多了只是噪音，少了接不上话）。 */
export const CHAT_AI_ROWS = 12;
/** 单条消息进提示词的上限（避免一条长文把窗口吃满）。 */
export const CHAT_AI_ROW_CHARS = 400;
/** 转录总预算：从最新往回装，装不下就丢最旧的。 */
export const CHAT_AI_TRANSCRIPT_CHARS = 4_000;
/** 回复正文上限（与消息发送上限一致；超过就分条）。 */
export const CHAT_AI_REPLY_CHARS = 4_000;
/** 单条发送分片上限：飞书 text 上限 4000，留一点余量给「（续）」。 */
export const CHAT_AI_SEND_CHUNK = 3_800;

const num = (value, fallback = 0) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

const clip = (value, cap) => {
	const text = String(value ?? "");
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
};

function stamp(ms) {
	const n = num(ms);
	if (!(n > 0)) return "";
	const d = new Date(n);
	const pad = (v) => String(v).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 消息行里可读的正文：富文本/卡片消息 text 可能为空，richText 才是内容。 */
function bodyOf(row) {
	return String(row?.text ?? "").trim() || String(row?.richText ?? "").trim() || String(row?.preview ?? "").trim();
}

/** 发言人：自己就写 me（模型最不容易搞错视角），别人用姓名，缺姓名退化成 id 尾巴。 */
function whoOf(row) {
	if (row?.self) return "me";
	const named = String(row?.senderLabel ?? "").trim() || String(row?.senderName ?? "").trim();
	if (named) return named;
	const id = String(row?.senderId ?? "").trim();
	return id ? `…${id.slice(-6)}` : "unknown";
}

/**
 * 拼「替我写一条回复」的提示词。
 *
 * @param {object} input
 * @param {string} [input.chatName] 会话名（群名 / 对方姓名），只用于让模型知道场景
 * @param {string} [input.chatId]
 * @param {Array<object>} [input.rows] 会话消息（UI 的 items，时间正序倒序都行，这里自己排）
 * @param {string} [input.instruction] 用户填的「回复要点」（可选：没有就按上下文自然回复）
 * @param {string} [input.messageId] 右键选中的那条消息：回复它，且不把更晚的消息带进上下文
 * @returns {string}
 */
export function buildReplyPrompt({ chatName = "", chatId = "", rows = [], instruction = "", messageId = "" } = {}) {
	const anchorId = String(messageId || "").trim();
	// 缓存/接口回的是「最新在前」，但纯函数不赌调用方顺序：按时间排一遍再取。
	const ordered = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => num(a?.createTimeMs) - num(b?.createTimeMs));
	// 右键的是某条历史消息：它之后的消息不属于这次回复的上下文（回的是它，不是后来那些）。
	let scoped = ordered;
	if (anchorId) {
		const idx = ordered.findIndex((row) => String(row?.id ?? "") === anchorId);
		if (idx >= 0) scoped = ordered.slice(0, idx + 1);
	}
	const usable = scoped
		.map((row) => ({
			id: String(row?.id ?? ""),
			at: num(row?.createTimeMs),
			who: whoOf(row),
			body: clip(bodyOf(row).replace(/\s+\n/g, "\n").trim(), CHAT_AI_ROW_CHARS),
		}))
		.filter((row) => row.body)
		.slice(-CHAT_AI_ROWS);

	// 从最新往回装预算：超了先丢最旧的那几条（回复靠的是「刚刚说了什么」）。
	const kept = [];
	let budget = CHAT_AI_TRANSCRIPT_CHARS;
	for (let i = usable.length - 1; i >= 0; i -= 1) {
		const cost = usable[i].body.length + 48;
		if (cost > budget) break;
		budget -= cost;
		kept.push(usable[i]);
	}
	kept.reverse();

	const title = String(chatName || "").trim() || String(chatId || "").trim() || "(unknown chat)";
	const lines = [`[Feishu chat reply task] ${title}${chatId ? ` (${chatId})` : ""}`, ""];
	if (kept.length) {
		lines.push('Recent messages (oldest → newest; "me" = the account owner):');
		for (const row of kept) {
			const mark = anchorId && row.id === anchorId ? "   <-- reply to this" : "";
			lines.push(`${stamp(row.at) ? `${stamp(row.at)} ` : ""}${row.who}: ${row.body}${mark}`);
		}
	} else {
		lines.push("Recent messages: (none readable — write from my intent below)");
	}
	const anchorKept = Boolean(anchorId) && kept.some((row) => row.id === anchorId);
	if (anchorId) {
		lines.push(
			"",
			anchorKept
				? `The message to reply to is the one marked "<-- reply to this" (id: ${anchorId}). Do not reply to any message after it.`
				: `The message I right-clicked (id: ${anchorId}) is not in the readable transcript; write from my intent below.`,
		);
	}
	const want = String(instruction ?? "")
		.trim()
		.slice(0, 500);
	if (want) lines.push("", `My intent for this reply: ${want}`);
	lines.push(
		"",
		anchorId
			? 'Write my reply to the message marked "<-- reply to this" (the last one above).'
			: "Write the single next message that I (the account owner) should send in this chat.",
		"Rules:",
		'- Output ONLY the message body: no preamble, no quotes, no markdown code fence, no "Reply:" label, no signature.',
		"- Match the language and tone of the thread; keep it natural for IM (short paragraphs, no bullet lists unless asked).",
		"- Never invent facts, numbers, links or commitments. If the last message asks something you cannot verify, ask one short clarifying question.",
		"- Do not call any tools and do not send anything yourself: the plugin sends the text after the user decides.",
	);
	return lines.join("\n");
}

/** 去掉模型爱加的包装（整段代码块 / 「回复：」前缀），其余原样保留。 */
export function cleanAiReply(text) {
	let out = String(text ?? "").trim();
	const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(out);
	if (fenced) out = fenced[1].trim();
	out = out.replace(/^(回复|回答|Reply|Draft)\s*[:：]\s*/i, "");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 按行切片（不从句子中间切断），单块 ≤ limit。
 * 绝大多数回复都只有一块；这里存在是为了「一条 4000+ 字的长回复」也能完整发出去。
 */
export function splitReplyText(text, limit = CHAT_AI_SEND_CHUNK) {
	const raw = String(text ?? "");
	const cap = Math.max(200, Math.floor(num(limit, CHAT_AI_SEND_CHUNK) || CHAT_AI_SEND_CHUNK));
	if (raw.length <= cap) return raw ? [raw] : [];
	const out = [];
	let current = "";
	for (const line of raw.split("\n")) {
		if (line.length > cap) {
			if (current) {
				out.push(current);
				current = "";
			}
			for (let i = 0; i < line.length; i += cap) out.push(line.slice(i, i + cap));
			continue;
		}
		const next = current ? `${current}\n${line}` : line;
		if (next.length > cap) {
			out.push(current);
			current = line;
		} else current = next;
	}
	if (current) out.push(current);
	return out.filter(Boolean);
}

/** UiMessage.content → 纯文本（只取 text 段；工具调用消息不算回复）。 */
export function assistantText(message) {
	const content = message?.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : ""))
			.join("")
			.trim();
	}
	if (typeof message?.text === "string") return message.text.trim();
	return "";
}

/**
 * 生成引擎：`generate()` 派一轮无头运行并等它结算，返回可直接发送的正文。
 *
 * deps：
 *   - chat(req)：host.chat（无头投递；返回 { runId, conversationId }）
 *   - log：宿主日志
 *   - now：时钟（单测注入）
 *   - timeoutMs：单轮上限
 *
 * 事件认领与 auto-reply 同一套：回执可能晚于 `message` / `run_end`，先到的进 `early` 缓冲，
 * 回执到手再补齐；`runId` 是主键，拿不到时用 `conv:<conversationId>` 兜底。
 */
export function createChatAiReplier({
	chat,
	log = () => {},
	now = () => Date.now(),
	timeoutMs = CHAT_AI_TIMEOUT_MS,
} = {}) {
	if (typeof chat !== "function") throw new Error("createChatAiReplier 需要 chat()");
	const cap = Math.max(10_000, Math.min(num(timeoutMs, CHAT_AI_TIMEOUT_MS) || CHAT_AI_TIMEOUT_MS, 600_000));
	/** runId（或 conv:conversationId）→ 正在等的任务。 */
	const pending = new Map();
	/** 回执未到时先到的终态/文本。 */
	const early = new Map();
	/** chatId → 在跑的 key：同一会话只允许一轮，连点不烧两份额度。 */
	const inflight = new Map();
	/** 正在等回执的投递数：>0 时未知 runId 的事件才有可能是「我们自己的」。 */
	let awaiting = 0;

	function buffer(key, patch) {
		if (early.size >= 32) return;
		const prev = early.get(key) || {};
		early.set(key, { ...prev, ...patch });
	}

	function settle(job, outcome) {
		if (job.settled) return;
		job.settled = true;
		if (job.timer) {
			clearTimeout(job.timer);
			job.timer = null;
		}
		pending.delete(job.key);
		if (inflight.get(job.chatId) === job.key) inflight.delete(job.chatId);
		job.resolve({
			...outcome,
			runId: job.runId,
			conversationId: job.conversationId,
			chatId: job.chatId,
		});
	}

	function finish(job, ev) {
		const text = cleanAiReply(job.text);
		if (!text) {
			const reason = String(ev?.stopReason ?? "") === "aborted" ? "运行被中止" : "模型没有输出文本（可能只调用了工具）";
			settle(job, { ok: false, error: reason });
			return;
		}
		settle(job, { ok: true, text, stopReason: String(ev?.stopReason ?? "") });
	}

	/**
	 * 派一轮并等结果。
	 * @returns {Promise<{ok:boolean,text?:string,error?:string,runId:string,conversationId:string,chatId:string}>}
	 */
	async function generate({
		chatId,
		chatName = "",
		rows = [],
		instruction = "",
		conversationId = "",
		messageId = "",
	} = {}) {
		const id = String(chatId ?? "").trim();
		if (!id) throw new Error("缺少 chatId");
		if (inflight.has(id)) throw new Error("这个会话正在生成 AI 回复：等它出来再点");
		const anchorId = String(messageId || "").trim();
		const list = Array.isArray(rows) ? rows : [];
		if (anchorId && !list.some((row) => String(row?.id ?? "") === anchorId)) {
			throw new Error("没找到要回复的那条消息（本地缓存可能已滚动）：刷新会话后再试");
		}
		if (list.length === 0) {
			if (!String(instruction ?? "").trim()) {
				throw new Error("这个会话还没有可读消息：先在「回复要点」写一句你想要的结果，再让 AI 回复");
			}
		}
		const prompt = buildReplyPrompt({ chatName, chatId: id, rows: list, instruction, messageId: anchorId });
		// 先占位再 await：两次点击的间隔可能短于一次 host.chat 的往返，
		// 等回执回来才占位的话，第二次点击会照样派活（连点 = 烧两份额度且互相插队）。
		const reservation = `pending:${id}`;
		inflight.set(id, reservation);
		let receipt;
		awaiting += 1;
		try {
			receipt = await chat({
				text: prompt,
				accountId: CHAT_AI_ACCOUNT_ID,
				...(conversationId ? { conversationId } : {}),
			});
		} catch (err) {
			if (inflight.get(id) === reservation) inflight.delete(id);
			throw err;
		} finally {
			awaiting -= 1;
		}
		const runId = String(receipt?.runId ?? "");
		const convId = String(receipt?.conversationId ?? "");
		const key = runId || (convId ? `conv:${convId}` : "");
		if (!key) {
			if (inflight.get(id) === reservation) inflight.delete(id);
			throw new Error("宿主没有返回 runId/conversationId，无法关联 AI 输出");
		}
		const job = {
			key,
			runId,
			conversationId: convId,
			chatId: id,
			text: "",
			settled: false,
			startedAt: now(),
		};
		const promise = new Promise((resolve) => {
			job.resolve = resolve;
		});
		pending.set(key, job);
		inflight.set(id, key);
		job.timer = setTimeout(() => {
			settle(job, { ok: false, error: `AI 回复超时（${Math.round(cap / 1000)}s）未返回` });
		}, cap);
		job.timer?.unref?.();

		// 回执迟到：把先到的文本/终态补齐（否则「跑得很快」的那轮会永远等不到 run_end）。
		for (const candidate of [key, convId ? `conv:${convId}` : ""]) {
			if (!candidate) continue;
			const buffered = early.get(candidate);
			if (!buffered) continue;
			early.delete(candidate);
			if (buffered.text) job.text = buffered.text;
			if (buffered.end) {
				finish(job, buffered.end);
				break;
			}
		}
		return promise;
	}

	/** 处理宿主的运行事件；返回 true 表示这条事件属于本引擎。 */
	function handleRunEvent(ev) {
		if (!ev || typeof ev !== "object") return false;
		const runId = String(ev.runId ?? "");
		const convId = String(ev.conversationId ?? "");
		// 回执可能只给 runId、事件可能只给 conversationId（或反过来）：两个键都试一遍。
		const keys = [runId, convId ? `conv:${convId}` : ""].filter(Boolean);
		if (keys.length === 0) return false;
		const job = keys.map((key) => pending.get(key)).find(Boolean);
		const text = ev.type === "message" && ev.message?.role === "assistant" ? assistantText(ev.message) : "";
		if (!job) {
			if (awaiting <= 0) return false;
			for (const key of keys) {
				if (ev.type === "run_end") buffer(key, { end: ev });
				else if (text) buffer(key, { text });
			}
			return keys.some((key) => early.has(key));
		}
		if (text) {
			job.text = text;
			return true;
		}
		if (ev.type !== "run_end") return false;
		finish(job, ev);
		return true;
	}

	/** 停用/重载：把还在等结果的调用收掉，别让浏览器请求挂到超时。 */
	function stop() {
		for (const job of [...pending.values()]) {
			settle(job, { ok: false, error: "插件已重新加载，这一轮 AI 回复被取消" });
		}
		pending.clear();
		early.clear();
		inflight.clear();
	}

	return {
		generate,
		handleRunEvent,
		stop,
		get pendingCount() {
			return pending.size;
		},
	};
}
