/**
 * plugins/feishu-pro/lib/cli-chats.mjs
 * 会话域 → lark-cli 适配层：会话列表 / 消息 / 发送 / 姓名补全 / P2P 解析。
 *
 * 关键取舍：**归一化复用旧模块的纯函数**（`normalizeChatEntries` / `normalizeMessageRow`），
 * CLI 只是换了一条取数的路（`im +chat-list` / `im +chat-messages-list`），前端结构一字不变。
 *
 * 发送是唯一不做"失败回落"的写操作：回落等于可能发两遍（血泪教训见 lib/chats.mjs 注释）。
 */

import { MAX_PAGES_PER_CHAT, POLL_PAGE_SIZE, isValidChatId } from "./dm-watch.mjs?v=0.14.1";
import { normalizeChatEntries, normalizeMessageRow } from "./chats.mjs?v=0.14.1";
import { getUsersByIds, normalizeCliUser } from "./cli-contacts.mjs";

/** CLI 身份取值：`--as user|bot`；插件内部仍用 user/tenant 口径。 */
function cliIdentity(as) {
	return String(as ?? "").toLowerCase() === "bot" ? "bot" : "user";
}

function internalIdentity(as) {
	return cliIdentity(as) === "bot" ? "tenant" : "user";
}

/** chat-list 的 data 里条目字段：`chats`（快捷命令）或 `items`（原生 API）。 */
export function pickChats(data) {
	if (!data || typeof data !== "object") return [];
	if (Array.isArray(data.chats)) return data.chats;
	if (Array.isArray(data.items)) return data.items;
	return [];
}

/**
 * 会话列表。
 * 注意：`--types p2p,group` 只有个人身份能用（官方限制），机器人身份回落成只列群。
 */
export async function fetchChats(run, { as = "user", pageSize = 100, pageToken = "", includeP2p = true } = {}) {
	const who = cliIdentity(as);
	const types = who === "bot" || !includeP2p ? "group" : "group,p2p";
	const args = [
		"im",
		"+chat-list",
		"--as",
		who,
		"--types",
		types,
		"--sort",
		"active_time",
		"--page-size",
		String(Math.min(Math.max(Number(pageSize) || 100, 1), 100)),
	];
	if (pageToken) args.push("--page-token", String(pageToken));
	const out = await run(args, { timeoutMs: 40_000 });
	const data = out?.data ?? {};
	return {
		chats: normalizeChatEntries(pickChats(data)),
		identity: internalIdentity(who),
		hasMore: Boolean(data.has_more ?? out?.meta?.has_more),
		pageToken: String(data.page_token ?? out?.meta?.page_token ?? ""),
		error: "",
		types,
	};
}

/** 读会话消息（默认倒序：最新在前）。`--no-reactions` 省一次批量查询。 */
export async function fetchChatMessages(
	run,
	chatId,
	{ as = "user", pageSize = 30, pageToken = "", selfOpenId = "", startMs = 0 } = {},
) {
	const id = String(chatId ?? "").trim();
	if (!isValidChatId(id)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
	const args = [
		"im",
		"+chat-messages-list",
		"--as",
		cliIdentity(as),
		"--chat-id",
		id,
		"--order",
		"desc",
		"--page-size",
		String(Math.min(Math.max(Number(pageSize) || 30, 1), 50)),
		"--no-reactions",
	];
	if (pageToken) args.push("--page-token", String(pageToken));
	// 增量刷新：只取比本地缓存最新一条更新的消息（默认路径就是「打开会话 → 后台补几条」，
	// 不必每次把整页 40 条重新搬一遍）。时间口径与 dm-watch 一致：向下取整到秒，边界靠 id 去重。
	const since = watermarkToIso(startMs);
	if (since) args.push("--start", since);
	const out = await run(args, { timeoutMs: 40_000 });
	const data = out?.data ?? {};
	// 快捷命令返回的是 `data.messages`（不是原生 API 的 `data.items`）。
	const list = Array.isArray(data.messages) ? data.messages : Array.isArray(data.items) ? data.items : [];
	const rows = list
		.map((item) => cliMessageToRaw(item))
		.map((item) => normalizeMessageRow(item, { selfOpenId }))
		.filter(Boolean);
	return {
		chatId: id,
		items: rows,
		hasMore: Boolean(data.has_more),
		pageToken: String(data.page_token ?? ""),
		identity: internalIdentity(as),
		// 调用方据此知道「这次是整页取数还是增量」：增量不该覆盖翻页游标/是否还有更早。
		since: since || "",
	};
}

/**
 * CLI 的消息条目 → `normalizeMessageItem` 认的形状。
 *
 * 两者的口径差别（实测 1.0.94，`im +chat-messages-list --json`）：
 *   - 内容：CLI 已渲染成**可读纯文本** `content`，没有 OpenAPI 的 `body.content` JSON；
 *   - 时间：CLI 给本地时间字符串 `"2026-11-06 16:59"`，归一化要毫秒；
 *   - 发送人：CLI 已补好 `sender.name` / `sender.is_agent`；
 *   - @提及：CLI 的 `mentions[].id` 是字符串，不是 `{open_id}`。
 * 不翻译这一层，`normalizeMessageRow` 会全部返回 null（前端就显示"没有可读的消息"）。
 */
export function cliMessageToRaw(message = {}) {
	const ms = Date.parse(String(message.create_time ?? "")) || 0;
	const type = String(message.msg_type ?? "text");
	return {
		message_id: String(message.message_id ?? ""),
		chat_id: String(message.chat_id ?? ""),
		// CLI 已把正文渲染成文本：除了 system（要拿原文做群/单聊推断），统一按 text 喂进去，
		// 避免 post/富文本分支去解析一个不是 post 结构的 content 而把消息丢掉。
		msg_type: type === "system" ? "system" : "text",
		create_time: String(ms),
		sender: {
			id: String(message.sender?.id ?? ""),
			sender_type: message.sender?.is_agent ? "app" : "user",
			name: String(message.sender?.name ?? ""),
		},
		body: { content: JSON.stringify({ text: String(message.content ?? "") }) },
		// 原始富文本：post 是 markdown（含 `![Image](img_…)`），卡片是 `<card title="…">…</card>`。
		// 只给 "能渲染" 的那部分，前端不认识就退回纯文本预览。
		rich_text: String(message.content ?? ""),
		// 图片/文件消息：CLI 的 content 形如 `[Image: img_v3_xxx]` / `[File: file_v3_xxx]`，
		// 把资源 key 单独抽出来给前端渲染（不然只能显示一段占位文字）。
		image_key: type === "image" ? (/(img_[A-Za-z0-9_-]{4,})/.exec(String(message.content ?? ""))?.[1] ?? "") : "",
		cli_msg_type: type,
		mentions: (Array.isArray(message.mentions) ? message.mentions : []).map((m) => ({
			id: { open_id: String(m?.id ?? "") },
			name: String(m?.name ?? ""),
		})),
	};
}

/** 一组 raw 行（`cliMessageToRaw` 产出）里最旧的毫秒时间；空集返回 Infinity。 */
function oldestRawMs(rows) {
	let min = Infinity;
	for (const row of Array.isArray(rows) ? rows : []) {
		const ms = Number(row?.create_time) || 0;
		if (ms > 0 && ms < min) min = ms;
	}
	return min;
}

/** 按人找私聊（0 副作用）：`contact +search-user --user-ids` 直接回 `p2p_chat_id`。 */
export async function resolveP2pChatId(run, { openId, as = "user" } = {}) {
	const id = String(openId ?? "").trim();
	if (!id) throw new Error("缺少 openId");
	const { items } = await getUsersByIds(run, { ids: [id], as: cliIdentity(as) });
	const user = items[0];
	return { chatId: user?.p2pChatId || "", via: user?.p2pChatId ? "search-user" : "", user: user ?? null };
}

/** 会话详情（chat_mode 权威来源，用来区分群/单聊）。 */
export async function fetchChatInfo(run, chatId, { as = "user" } = {}) {
	const id = String(chatId ?? "").trim();
	if (!isValidChatId(id)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
	const out = await run(["api", "GET", `/open-apis/im/v1/chats/${encodeURIComponent(id)}`, "--as", cliIdentity(as)], {
		timeoutMs: 20_000,
	});
	return out?.data ?? {};
}

/** 发送者姓名补全（失败只降级成 open_id 尾巴，不影响正文）。 */
export async function fetchUserNames(run, openIds, { as = "user" } = {}) {
	const ids = (Array.isArray(openIds) ? openIds : []).filter(Boolean).slice(0, 20);
	if (!ids.length) return { names: {}, error: "" };
	try {
		const { names, error } = await getUsersByIds(run, { ids, as: cliIdentity(as) });
		return { names, error };
	} catch (err) {
		return { names: {}, error: String(err?.message || err) };
	}
}

/**
 * 发文本。
 * @param {{chatId?:string, openId?:string, text:string, as?:string, uuid?:string}} opts
 */
export async function sendText(run, { chatId = "", openId = "", text = "", as = "user", uuid = "" } = {}) {
	const body = String(text ?? "");
	if (!body.trim()) throw new Error("消息内容不能为空");
	const args = ["im", "+messages-send", "--as", cliIdentity(as), "--text", body];
	if (openId) args.push("--user-id", String(openId));
	else if (chatId) args.push("--chat-id", String(chatId));
	else throw new Error("缺少 chatId 或 openId");
	if (uuid) args.push("--idempotency-key", String(uuid).slice(0, 50));
	const out = await run(args, { timeoutMs: 30_000 });
	const data = out?.data ?? {};
	return {
		chatId: String(data.chat_id ?? chatId ?? ""),
		messageId: String(data.message_id ?? ""),
		identity: cliIdentity(as),
		via: "lark-cli",
	};
}

/** 从一组消息里找"对方"（单聊标题兜底用）。 */
export function pickPeerFromRows(rows, selfOpenId = "") {
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row?.senderId) continue;
		if (selfOpenId && row.senderId === selfOpenId) continue;
		return row.senderId;
	}
	return "";
}

/**
 * 水位毫秒 → ISO 8601（CLI 的 `--start` 只认 ISO）。
 * 向下取整到秒：与 `buildMessageQuery` 的 floor 口径一致 —— 宁可多取边界那一秒，
 * 靠 `seen` 去重保证不重复报，也不要因为向上取整漏掉消息。
 */
export function watermarkToIso(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) return "";
	return new Date(Math.floor(n / 1000) * 1000).toISOString();
}

/**
 * dm-watch 用的窄通道（只暴露 ready / listChats / fetchMessages）。
 * 刻意不暴露命令细节：轮询引擎不该知道 CLI 怎么拼参数。
 *
 * @param {{ run: Function, isReady?: () => Promise<boolean>|boolean }} deps
 */
export function createDmCliChannel({ run, isReady } = {}) {
	if (typeof run !== "function") throw new Error("createDmCliChannel 需要 run()");
	const who = (identity) => (String(identity ?? "").toLowerCase() === "tenant" ? "bot" : "user");
	return {
		ready: async () => (typeof isReady === "function" ? Boolean(await isReady()) : true),
		listChats: async ({ identity } = {}) => {
			const as = who(identity);
			// 机器人身份拿不到 p2p（官方限制），只列群。
			const types = as === "bot" ? "group" : "p2p,group";
			const out = await run(
				["im", "+chat-list", "--as", as, "--types", types, "--sort", "active_time", "--page-size", "100"],
				{ timeoutMs: 40_000 },
			);
			return pickChats(out?.data);
		},
		fetchMessages: async (
			chatId,
			{ startMs = 0, pageSize = POLL_PAGE_SIZE, maxPages = MAX_PAGES_PER_CHAT, identity } = {},
		) => {
			const id = String(chatId ?? "").trim();
			if (!isValidChatId(id)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
			const size = Math.min(Math.max(Number(pageSize) || POLL_PAGE_SIZE, 1), 50);
			const pages = Math.min(Math.max(Number(maxPages) || MAX_PAGES_PER_CHAT, 1), 20);
			const iso = watermarkToIso(startMs);
			const items = [];
			let pageToken = "";
			for (let page = 0; page < pages; page += 1) {
				const args = [
					"im",
					"+chat-messages-list",
					"--as",
					who(identity),
					"--chat-id",
					id,
					// **必须 desc**：爬「最近一段时间」只能从最新往回翻。
					// asc 拿到的是水位之后**最旧**的一页（基线时更是会话历史最旧一页），积压时提醒永远追不上。
					"--order",
					"desc",
					"--page-size",
					String(size),
					"--no-reactions",
				];
				if (iso) args.push("--start", iso);
				if (pageToken) args.push("--page-token", pageToken);
				const out = await run(args, { timeoutMs: 30_000 });
				const data = out?.data ?? {};
				// 与 fetchChatMessages 同一坑：快捷命令回的是 `data.messages`，且字段形状要翻译，
				// 否则 dm-watch 拿到的永远是空数组 → 水位永远建不起来（界面看着"在跑但没提醒"）。
				const list = Array.isArray(data.messages) ? data.messages : Array.isArray(data.items) ? data.items : [];
				const rows = list.map((item) => cliMessageToRaw(item));
				items.push(...rows);
				const pagination = out?.meta?.pagination;
				const more =
					data.has_more !== undefined
						? Boolean(data.has_more)
						: pagination
							? pagination.complete === false
							: Boolean(out?.meta?.has_more);
				pageToken = String(data.page_token ?? pagination?.next_token ?? out?.meta?.page_token ?? "");
				if (!more || !pageToken) return { items, truncated: false };
				// 降序翻页：本页最旧一条已在水位之前 ⇒ 剩下的都是历史，不必再 spawn 一次。
				if (startMs && oldestRawMs(rows) <= Number(startMs)) return { items, truncated: false };
			}
			// 翻到上限还有更多：交给 pollOnce 当积压处理（只报最近这几页，水位对齐最新）。
			return { items, truncated: true };
		},
	};
}

export { normalizeCliUser };
