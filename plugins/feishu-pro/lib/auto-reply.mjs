/**
 * plugins/feishu-pro/lib/auto-reply.mjs
 * 私聊自动问答闭环：dm-watch 的 onNew → host.chat（无头跑一轮 agent）→ 回填发送。
 *
 * 为什么单独一个模块：这块是**唯一会以「你本人」名义自动开口**的能力，风险不在
 * "怎么发"，而在"什么时候不该发"。所以判定逻辑（白名单 / 冷却 / 频率 / 陈旧数据）
 * 全做成纯函数，单测直接钉住；发送与投递走注入的 deps，方便用假宿主跑端到端。
 *
 * 语义约定（与 docs/dm-watch-lark-cli-eval.md 的结论一致）：
 *   - 飞书人类账号的私聊**没有事件**，触发只能靠轮询 → 每条消息天生有延迟；
 *     因此 `staleSec` 只是一道"别把积压当新消息补答一遍"的保险，不是实时性保证。
 *   - 回复以 user 身份发出时，dm-watch 会把自己的消息过滤掉（selfOpenId），
 *     不会形成自激回环；以 bot 身份发时由 `senderType === "app"` 挡住。
 */

import { isValidChatId, parseChatIds } from "./dm-watch.mjs?v=0.12.0";

export const AUTO_CONFIG_KEY = "auto_reply";
export const AUTO_STATE_KEY = "auto_reply_state";
/** 通道内的账号标识：所有自动回复共用一个伪客户端，会话按 chatId 绑各自的 conversationId。 */
export const AUTO_ACCOUNT_ID = "feishu-pro:auto";
/** 一个会话同时在跑的上限（同一个 chatId 只允许一轮，避免消息互相插队）。 */
export const AUTO_MAX_SENT_HISTORY = 200;
export const AUTO_REPLY_HISTORY = 20;
/** 回包分片：飞书单条 text 上限 4000，留一点余量给"（续）"这类后缀。 */
export const AUTO_CHUNK_LIMIT = 3800;

export const AUTO_DEFAULT_CONFIG = {
	/** 默认关闭：自动开口这件事必须由人显式打开。 */
	enabled: false,
	/** 白名单会话 ID（逗号/换行分隔）。**空 = 谁都不回**，不做"全部"这种危险默认。 */
	chatIds: "",
	/** 回包身份：user = 我本人（默认，与界面一致）/ bot = 机器人。 */
	as: "user",
	/** 同一会话的最小间隔：防止对方连发几条就触发一串回答。 */
	cooldownSec: 20,
	/** 全局限频：每小时最多回几条（0 = 不限）。 */
	maxPerHour: 20,
	/** 超过这个秒数的消息不再自动回（0 = 不回旧消息；负值视为 0）。 */
	staleSec: 300,
	/** 只回报"本来会发什么"，不真的发 —— 上线前先跑一阵这个。 */
	dryRun: false,
	/** 回包后缀/签名（留空 = 不加）。让收件人知道这是自动回复。 */
	signature: "",
};

const num = (value, fallback = 0) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

/** 带上下限的整数归一化（配置来自浏览器，什么都可能传进来）。 */
function clampInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
	const n = Math.round(num(value, fallback));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

/** 配置归一化：未知字段丢弃，数值夹到安全区间，`as` 只认 user/bot。 */
export function normalizeAutoConfig(input = {}, base = AUTO_DEFAULT_CONFIG) {
	const src = input && typeof input === "object" ? input : {};
	const prev = base && typeof base === "object" ? base : AUTO_DEFAULT_CONFIG;
	const pick = (key) => (src[key] === undefined ? prev[key] : src[key]);
	const as = String(pick("as") ?? "user")
		.trim()
		.toLowerCase();
	return {
		enabled: Boolean(pick("enabled")),
		// 只留合法 chat_id：白名单是最后一道闸，脏值不该让"谁都不回"变成"全都不管"。
		chatIds: parseChatIds(pick("chatIds")).join(","),
		as: as === "bot" || as === "tenant" ? "bot" : "user",
		cooldownSec: clampInt(pick("cooldownSec"), { min: 0, max: 3600, fallback: 20 }),
		maxPerHour: clampInt(pick("maxPerHour"), { min: 0, max: 1000, fallback: 20 }),
		staleSec: clampInt(pick("staleSec"), { min: 0, max: 86_400, fallback: 300 }),
		dryRun: Boolean(pick("dryRun")),
		signature: String(pick("signature") ?? "").slice(0, 120),
	};
}

/** 运行时状态：会话绑定、上次回复时间、回复历史（落盘，重启后不会重复答同一批）。 */
export function autoStateDefaults() {
	return { conversations: {}, lastReplyAt: {}, sent: [], replies: [], lastError: "", lastReplyAtMs: 0 };
}

export function normalizeAutoState(input) {
	const src = input && typeof input === "object" ? input : {};
	const convs = {};
	if (src.conversations && typeof src.conversations === "object") {
		for (const [chatId, convId] of Object.entries(src.conversations)) {
			if (isValidChatId(chatId) && convId) convs[chatId] = String(convId);
		}
	}
	const lastReplyAt = {};
	if (src.lastReplyAt && typeof src.lastReplyAt === "object") {
		for (const [chatId, ms] of Object.entries(src.lastReplyAt)) {
			if (isValidChatId(chatId) && num(ms) > 0) lastReplyAt[chatId] = num(ms);
		}
	}
	const replies = (Array.isArray(src.replies) ? src.replies : [])
		.slice(-AUTO_REPLY_HISTORY)
		.map((r) => ({
			at: num(r?.at),
			chatId: String(r?.chatId ?? ""),
			chatName: String(r?.chatName ?? ""),
			from: String(r?.from ?? ""),
			ask: String(r?.ask ?? "").slice(0, 300),
			reply: String(r?.reply ?? "").slice(0, 1000),
			dryRun: Boolean(r?.dryRun),
			error: String(r?.error ?? ""),
		}))
		.filter((r) => r.at > 0);
	return {
		conversations: convs,
		lastReplyAt,
		sent: (Array.isArray(src.sent) ? src.sent : [])
			.map((s) => ({ at: num(s?.at), chatId: String(s?.chatId ?? "") }))
			.filter((s) => s.at > 0)
			.slice(-AUTO_MAX_SENT_HISTORY),
		replies,
		lastError: String(src.lastError ?? ""),
		lastReplyAtMs: num(src.lastReplyAtMs),
	};
}

/** 一小时内的回复条数（滑动窗口）。 */
export function repliesInLastHour(sent = [], now = Date.now()) {
	const since = now - 3_600_000;
	return (Array.isArray(sent) ? sent : []).filter((s) => num(s?.at) > since).length;
}

/**
 * 这条消息该不该自动回。返回 `{ accepted, reason }`，reason 是给日志/界面看的中文短语。
 * 顺序有讲究：先排除"绝不回"（关闭 / 非白名单 / 机器人 / 自己），再谈节流。
 */
export function matchAutoReply(record, config, { now = Date.now(), lastReplyAt = {}, sent = [] } = {}) {
	const cfg = config || AUTO_DEFAULT_CONFIG;
	if (!cfg.enabled) return { accepted: false, reason: "自动回复未启用" };
	if (!record || typeof record !== "object") return { accepted: false, reason: "空消息" };
	const chatId = String(record.chatId ?? "");
	if (!isValidChatId(chatId)) return { accepted: false, reason: "会话 ID 不合法" };
	const allow = parseChatIds(cfg.chatIds);
	if (allow.length === 0) return { accepted: false, reason: "白名单为空（先在面板里填要自动回复的会话）" };
	if (!allow.includes(chatId)) return { accepted: false, reason: "会话不在白名单" };
	if (record.self) return { accepted: false, reason: "自己发的" };
	if (String(record.senderType ?? "") === "app") return { accepted: false, reason: "机器人发的" };
	if (String(record.msgType ?? "") === "system") return { accepted: false, reason: "系统消息" };
	const text = String(record.text ?? "").trim();
	if (!text && !record.imageKey) return { accepted: false, reason: "消息没有可读正文" };
	// 陈旧保护：轮询天生有延迟，重启后第一轮可能捞到一堆旧消息 —— 那些该由人来看，
	// 不是由 AI 挨个回答（否则对方会突然收到一串"迟到"的回复）。
	const staleSec = clampInt(cfg.staleSec, { min: 0, max: 86_400, fallback: 300 });
	const createMs = num(record.createTimeMs);
	if (staleSec > 0 && createMs > 0 && now - createMs > staleSec * 1000) {
		return { accepted: false, reason: `消息已过期（>${staleSec}s）` };
	}
	const cooldownSec = clampInt(cfg.cooldownSec, { min: 0, max: 3600, fallback: 0 });
	const last = num(lastReplyAt?.[chatId]);
	if (cooldownSec > 0 && last > 0 && now - last < cooldownSec * 1000) {
		return { accepted: false, reason: `冷却中（${Math.ceil((cooldownSec * 1000 - (now - last)) / 1000)}s）` };
	}
	const cap = clampInt(cfg.maxPerHour, { min: 0, max: 1000, fallback: 0 });
	if (cap > 0 && repliesInLastHour(sent, now) >= cap) {
		return { accepted: false, reason: `已达每小时上限（${cap} 条）` };
	}
	return { accepted: true, reason: "" };
}

/** 带时区的本地时间文案（提示词里给人看的，不参与解析）。 */
function stamp(ms) {
	const n = num(ms);
	if (!(n > 0)) return "";
	const d = new Date(n);
	const pad = (v) => String(v).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 拼投给 agent 的任务文本。
 *
 * 刻意做窄：只给"这个人刚说了什么"，**不复述整段历史** —— agent 手里有
 * `feishu_pro action=im_messages`，需要上下文时自己去取（省 token，也不会因为
 * 我们截断历史而让模型以为对话只有这几句）。
 */
export function buildAutoPrompt({ record, chatName = "", chatId = "" } = {}) {
	const row = record || {};
	const who = String(row.senderName || "").trim() || `…${String(row.senderId || "").slice(-6)}`;
	const body = String(row.text || "").trim() || "[image or file only]";
	const lines = [
		`[Feishu direct message] ${who} → me${chatName ? ` (${chatName})` : ""}${stamp(row.createTimeMs) ? ` at ${stamp(row.createTimeMs)}` : ""}:`,
		body,
		"",
		"Reply as me to this message. Output ONLY the message body that will be sent back to Feishu — no preamble, no quotes, no code fence, no signature (one is appended automatically).",
		`Match the sender's language. Call feishu_pro with action=im_messages chat_id=${chatId || row.chatId || "<chat_id>"} limit=10 when you need the earlier context of this thread.`,
		"If the request is ambiguous or involves commitments you cannot verify, answer with a short safe acknowledgement instead of inventing facts.",
	];
	return lines.join("\n");
}

/** UiMessage.content → 纯文本（数组里可能是 text/toolCall 混排；只有工具调用返回空）。 */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	if (content.some((p) => p?.type === "toolCall" || p?.type === "tool_use")) return "";
	return content
		.map((p) => (typeof p === "string" ? p : String(p?.text ?? "")))
		.join("")
		.trim();
}

/** 去掉模型爱加的包装（整段代码块、"回复："前缀），其余原样保留。 */
export function cleanReply(text) {
	let out = String(text ?? "").trim();
	const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(out);
	if (fenced) out = fenced[1].trim();
	out = out.replace(/^(回复|回答|Reply)\s*[:：]\s*/i, "");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 按行切片（不要从句子中间切断），单块 ≤ limit。 */
export function chunkReply(text, limit = AUTO_CHUNK_LIMIT) {
	const raw = String(text ?? "");
	const cap = Math.max(200, Math.floor(num(limit, AUTO_CHUNK_LIMIT) || AUTO_CHUNK_LIMIT));
	if (raw.length <= cap) return raw ? [raw] : [];
	const out = [];
	let current = "";
	for (const line of raw.split("\n")) {
		// 单行本身就超长：硬切（宁可断行，也不能超过飞书上限）。
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

/** 幂等键：同一轮重试不会发两遍（飞书按 idempotency-key 去重）。 */
export function replyUuid(key) {
	const base = String(key ?? "")
		.replace(/[^\w.-]/g, "")
		.slice(0, 40);
	return `auto-${base || "run"}`;
}

/**
 * 自动回复引擎。
 *
 * deps：
 *   - storage：host.storage（配置与状态落盘）
 *   - chat(req)：host.chat（投给 agent；返回 { conversationId, runId }）
 *   - send(args)：发文本（内部就是 sendChatText，身份/幂等/错误翻译都复用）
 *   - log / notify：宿主日志与通知（失败要看得到）
 *   - now：时钟（单测注入）
 *   - onActivity(status)：状态变化回调（顶栏后台任务条用）
 */
export function createAutoReplier({
	storage,
	chat,
	send,
	log = () => {},
	notify = () => {},
	now = () => Date.now(),
	onActivity,
} = {}) {
	if (typeof storage?.get !== "function") throw new Error("createAutoReplier 需要 storage");
	if (typeof chat !== "function") throw new Error("createAutoReplier 需要 chat()");
	if (typeof send !== "function") throw new Error("createAutoReplier 需要 send()");

	let config = { ...AUTO_DEFAULT_CONFIG };
	let state = autoStateDefaults();
	let loaded = false;
	let loading = null;
	/** runId（或 conv:conversationId）→ 正在等结果的任务。 */
	const pending = new Map();
	/** 回执未到时先到的终态/文本（host.chat 是异步的，事件可能抢先一步）。 */
	const early = new Map();
	/** 正在等回执的投递数：>0 时未知 runId 的事件才有可能是「我们自己的」。 */
	let awaiting = 0;
	let lastNotifyAt = 0;

	function activity() {
		try {
			onActivity?.(status());
		} catch {
			/* 状态回显失败不该影响回包 */
		}
	}

	async function load() {
		if (loaded) return;
		if (loading) return loading;
		loading = (async () => {
			try {
				config = normalizeAutoConfig((await storage.get(AUTO_CONFIG_KEY, AUTO_DEFAULT_CONFIG)) ?? AUTO_DEFAULT_CONFIG);
				state = normalizeAutoState((await storage.get(AUTO_STATE_KEY, null)) ?? null);
			} catch (err) {
				log("warn", `auto-reply: 读取配置失败：${err?.message || err}`);
			} finally {
				loaded = true;
				loading = null;
			}
		})();
		return loading;
	}

	async function persist() {
		try {
			await storage.set(AUTO_CONFIG_KEY, config);
			await storage.set(AUTO_STATE_KEY, state);
		} catch (err) {
			log("warn", `auto-reply: 保存失败：${err?.message || err}`);
		}
	}

	/** 失败通知节流：同一条链反复失败时别刷屏（5 分钟一次）。 */
	function warn(msg, en) {
		state.lastError = String(msg);
		const at = now();
		if (at - lastNotifyAt > 300_000) {
			lastNotifyAt = at;
			notify("warning", `飞书自动回复：${msg}`, `Feishu auto-reply: ${en || msg}`);
		} else {
			log("warn", `auto-reply: ${msg}`);
		}
		activity();
	}

	function pushReply(entry) {
		state.replies = [...state.replies, entry].slice(-AUTO_REPLY_HISTORY);
		state.lastReplyAtMs = entry.at;
	}

	function status() {
		return {
			config,
			enabled: Boolean(config.enabled),
			inflight: pending.size,
			conversations: Object.keys(state.conversations).length,
			sentLastHour: repliesInLastHour(state.sent, now()),
			lastError: state.lastError,
			lastReplyAt: state.lastReplyAtMs,
			replies: state.replies.slice(-AUTO_REPLY_HISTORY).reverse(),
		};
	}

	async function setConfig(patch = {}) {
		await load();
		config = normalizeAutoConfig(patch, config);
		await persist();
		activity();
		return config;
	}

	/**
	 * 处理一轮轮询的新消息。
	 * 每轮只回**白名单里每个会话的最后一条**：对方连发 3 条时回 3 次是刷屏，
	 * 回 1 次（针对最新那条）才像人。
	 */
	async function onMessages(records = []) {
		await load();
		if (!config.enabled) return { skipped: "disabled", handled: 0, results: [] };
		const latest = new Map();
		for (const record of Array.isArray(records) ? records : []) {
			const chatId = String(record?.chatId ?? "");
			if (!chatId) continue;
			const prev = latest.get(chatId);
			if (!prev || num(record.createTimeMs) >= num(prev.createTimeMs)) latest.set(chatId, record);
		}
		const results = [];
		for (const record of latest.values()) {
			// 串行：一轮里多个会话同时投递会瞬间起多个无头运行，没必要。
			results.push(await handleRecord(record));
		}
		activity();
		return {
			skipped: "",
			handled: results.filter((r) => r.ok).length,
			results,
		};
	}

	async function handleRecord(record) {
		const chatId = String(record?.chatId ?? "");
		const verdict = matchAutoReply(record, config, {
			now: now(),
			lastReplyAt: state.lastReplyAt,
			sent: state.sent,
		});
		if (!verdict.accepted) {
			log("info", `auto-reply: 跳过 ${chatId}（${verdict.reason}）`);
			return { ok: false, chatId, reason: verdict.reason };
		}
		const prompt = buildAutoPrompt({
			record,
			chatName: String(record.chatName ?? ""),
			chatId,
		});
		let receipt;
		awaiting += 1;
		try {
			receipt = await chat({
				text: prompt,
				accountId: AUTO_ACCOUNT_ID,
				// 绑定的会话还在 → 多轮记忆连续；被回收 → 宿主回落新会话，不丢消息。
				conversationId: state.conversations[chatId] || undefined,
			});
		} catch (err) {
			warn(`投递失败（${chatId}）：${err?.message || err}`, `delivery failed (${chatId}): ${err?.message || err}`);
			return { ok: false, chatId, reason: "chat-failed", error: String(err?.message || err) };
		} finally {
			awaiting -= 1;
		}
		const runId = String(receipt?.runId ?? "");
		const conversationId = String(receipt?.conversationId ?? "");
		if (conversationId && state.conversations[chatId] !== conversationId) {
			state.conversations[chatId] = conversationId;
			await persist();
		}
		const key = runId || (conversationId ? `conv:${conversationId}` : "");
		if (!key) {
			warn("宿主没有返回 runId/conversationId，无法关联回包", "host returned no runId/conversationId");
			return { ok: false, chatId, reason: "no-run-id" };
		}
		const job = {
			key,
			chatId,
			chatName: String(record.chatName ?? ""),
			messageId: String(record.id ?? ""),
			from: String(record.senderName ?? ""),
			ask: String(record.text ?? "").slice(0, 300),
			prompt,
			text: "",
			startedAt: now(),
		};
		pending.set(key, job);
		// 回执之前到的文本/终态：这里补齐（否则"运行很快"的那条会永远等不到 run_end）。
		const buffered = early.get(key);
		if (buffered) {
			early.delete(key);
			if (buffered.text) job.text = buffered.text;
			if (buffered.end) {
				pending.delete(key);
				await finish(job, buffered.end);
			}
		}
		activity();
		return { ok: true, chatId, runId: key, conversationId };
	}

	function buffer(key, patch) {
		if (early.size >= 32) return; // 只防"回执迟到"这一小段，别无限攒
		const prev = early.get(key) || {};
		early.set(key, { ...prev, ...patch });
	}

	/** 处理宿主的运行事件；返回 true 表示这条事件属于本引擎。 */
	async function handleRunEvent(ev) {
		if (!ev || typeof ev !== "object") return false;
		const key = ev.runId ? String(ev.runId) : ev.conversationId ? `conv:${ev.conversationId}` : "";
		if (!key) return false;
		const job = pending.get(key);
		if (!job) {
			// 还没拿到 runId 就先来了事件：只有「我们正在等回执」时才缓冲，别的对话不掺和。
			if (awaiting <= 0) return false;
			if (ev.type === "run_end") buffer(key, { end: ev });
			else if (ev.type === "message" && ev.message?.role === "assistant") {
				const text = messageText(ev.message);
				if (text) buffer(key, { text });
			}
			return Boolean(early.has(key));
		}
		if (ev.type === "message" && ev.message?.role === "assistant") {
			const text = messageText(ev.message);
			if (text) job.text = text;
			return true;
		}
		if (ev.type !== "run_end") return false;
		pending.delete(key);
		await finish(job, ev);
		activity();
		return true;
	}

	async function finish(job, ev) {
		const stop = String(ev?.stopReason ?? "");
		let text = cleanReply(job.text);
		if (!text) {
			const reason = stop === "aborted" ? "运行被中止" : "模型没有输出文本（只调用了工具？）";
			warn(`${reason}（${job.chatId}），没有回包`, `no reply text (${job.chatId})`);
			pushReply({
				at: now(),
				chatId: job.chatId,
				chatName: job.chatName,
				from: job.from,
				ask: job.ask,
				reply: "",
				dryRun: false,
				error: reason,
			});
			await persist();
			return;
		}
		const finalText = config.signature ? `${text}\n${config.signature}` : text;
		const at = now();
		if (config.dryRun) {
			pushReply({
				at,
				chatId: job.chatId,
				chatName: job.chatName,
				from: job.from,
				ask: job.ask,
				reply: finalText,
				dryRun: true,
				error: "",
			});
			await persist();
			log("info", `auto-reply(dry-run): ${job.chatId} → ${finalText.slice(0, 120)}`);
			return;
		}
		const chunks = chunkReply(finalText);
		try {
			for (let i = 0; i < chunks.length; i += 1) {
				// 幂等键带序号：同一块重试不会发两遍，多块之间又不会互相覆盖。
				const uuid = chunks.length > 1 ? `${replyUuid(job.key)}-${i + 1}` : replyUuid(job.key);
				await send({ chatId: job.chatId, text: chunks[i], as: config.as, uuid });
			}
		} catch (err) {
			const msg = String(err?.message || err);
			warn(`回包失败（${job.chatId}）：${msg}`, `send failed (${job.chatId}): ${msg}`);
			pushReply({
				at,
				chatId: job.chatId,
				chatName: job.chatName,
				from: job.from,
				ask: job.ask,
				reply: finalText,
				dryRun: false,
				error: msg,
			});
			await persist();
			return;
		}
		state.lastReplyAt[job.chatId] = at;
		state.sent = [...state.sent, { at, chatId: job.chatId }].slice(-AUTO_MAX_SENT_HISTORY);
		state.lastError = "";
		pushReply({
			at,
			chatId: job.chatId,
			chatName: job.chatName,
			from: job.from,
			ask: job.ask,
			reply: finalText,
			dryRun: false,
			error: "",
		});
		await persist();
		log("info", `auto-reply: 已回 ${job.chatId}（${chunks.length} 块）`);
	}

	/**
	 * 「如果现在收到这条消息，会怎样」：不建运行、不发消息，只回判定与提示词。
	 * 面板上的「预览」按钮与真上线前的自查都走这里。
	 */
	async function preview(record) {
		await load();
		const verdict = matchAutoReply(record, config, {
			now: now(),
			lastReplyAt: state.lastReplyAt,
			sent: state.sent,
		});
		return {
			accepted: verdict.accepted,
			reason: verdict.reason,
			prompt: buildAutoPrompt({
				record,
				chatName: String(record?.chatName ?? ""),
				chatId: String(record?.chatId ?? ""),
			}),
			config,
		};
	}

	function stop() {
		pending.clear();
		early.clear();
	}

	return { load, status, setConfig, preview, onMessages, handleRunEvent, stop };
}
