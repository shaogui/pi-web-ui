/**
 * plugins/feishu-pro/lib/chat-cache.mjs
 * 会话消息的**本地缓存**：打开会话不再等 CLI，取到的内容也能被二次检索。
 *
 * 为什么要有它（这是本文件存在的唯一理由）：
 *   - 每次 `im +chat-messages-list` 都是一次 CLI 子进程 + 网络往返（实测 1–3s）。界面每点一次
 *     会话就等一遍、切回来还要再来一遍；
 *   - 后台轮询（`lib/dm-watch.mjs`，私聊 + 群）本来就在按间隔拉同一批消息 —— 两份数据各拉各的，
 *     配额全花在「同一件事做两遍」上；
 *   - AI 侧要「翻看刚才聊了什么 / 找一句话」时也只能重新拉一遍，没法在本地检索。
 *
 * 现在只有**一个数据落点**：谁拉到消息（后台轮询（私聊 + 群）/ 界面拉取 / AI 工具）都 `put()` 进来，
 * 谁要读（打开会话 / 列表上的最后一条预览 / 关键词检索）都 `chat()` / `search()` 出去。
 *
 * 五条硬约束（都体现在实现里）：
 *   1. **每个会话先「补一屏」（`entry.full`）**：增量拉取（`--start <缓存里最新一条>`）只能
 *      带回「更新的那几条」，缓存里原本没有的历史永远补不进来；而水位（`lib/dm-watch.mjs`）
 *      比缓存活得久，于是真机出现过「轮询一直在跑，缓存里每个会话却永远只有 1 条」——
 *      打开会话只看到一条。每个会话的 `full` 记录「整页拉过一次」，没有它就先整页拉，
 *      有了才允许走增量（见 `CHAT_CACHE_FULL_ROWS` / `needsBackfill()`）；
 *   2. **有界**：每会话最多 `CHAT_CACHE_MESSAGES` 条、每会话 `CHAT_CACHE_ENTRY_BYTES` 字节、
 *      最多 `CHAT_CACHE_CHATS` 个会话、**整份缓存** `CHAT_CACHE_TOTAL_BYTES` 字节、
 *      超过 `CHAT_CACHE_TTL_MS` 没更新就丢 —— 插件 storage 是一整个 JSON 文件，不能让它无限长；
 *   3. **可重建**：缓存只加速、不改语义。丢了就重新拉，任何缓存异常都不该让读消息失败；
 *   4. **落盘合并写**：`storage.set` 是同步整文件读改写 → 写入走 `persistDelayMs` 防抖，
 *      一轮轮询 30 个会话只落一次盘；
 *   5. **纯函数与存储解耦**：`mergeRows` / `pruneChatCache` / `searchChatCache` 都不碰 IO，
 *      单测直接 import（`tests/unit/feishu-pro-chat-cache.test.ts`）。
 */

/** 消息缓存落盘键。 */
export const CHAT_CACHE_KEY = "chats_msg_cache";
/** 发送人姓名缓存落盘键（CLI 的消息里常带 `sender.name`，缺的那部分才查一次并记下来）。 */
export const CHAT_NAMES_KEY = "chats_names_cache";
/** 结构版本：改字段形状时 bump，老数据在下一次 `normalizeChatCache` 里自然降级。 */
export const CHAT_CACHE_VERSION = 1;
/**
 * 每会话保留多少条（界面一屏 40 条，多留半屏方便往回翻）。
 *
 * 为什么不敢开大：`host.storage` 是**一整个 JSON 文件**、同步整文件读改写。
 * 单会话还有字节预算（`CHAT_CACHE_ENTRY_BYTES`）与全局预算（`CHAT_CACHE_TOTAL_BYTES`）两道闸。
 */
export const CHAT_CACHE_MESSAGES = 60;
/**
 * 「缓存里已经有一整屏」的行数台阶（界面一屏 40 条）。
 *
 * 用途只有两个：
 *   1. `full` 标记的**升级迁移**：老缓存里没有这个字段，行数够一屏就当它整页拉过，
 *      免得升级后把每个会话都重新整页拉一遍（一次 CLI 就是 1–3s）；
 *   2. `needsBackfill()` 的第二道判断：行数已经够一屏时即使标记丢了也不必回源。
 */
export const CHAT_CACHE_FULL_ROWS = 40;
/**
 * 最多保留多少个会话（按最近更新时间保留）。
 *
 * 从 24 提到 60（0.14.1）：后台轮询一轮就能碰到 30 个单聊 + 20 个群，
 * 容量小于**轮询候选数**时会出现「同步在跑，但缓存里只剩前 24 个」——
 * 后 26 个会话每轮都被写进去、又每轮被剪掉（白花 CPU），并且**群几乎永远进不了缓存**
 * （候选顺序是手填→单聊→群，群排在最后）。60 覆盖 50 个候选 + 余量给「手动打开过的会话」，
 * 真正限制体积的是下面的全局字节预算。
 */
export const CHAT_CACHE_CHATS = 60;
/** 多久没更新的会话从缓存里剔除（14 天；重建代价只是一次 CLI 调用）。 */
export const CHAT_CACHE_TTL_MS = 14 * 24 * 3600_000;
/**
 * 单条消息的正文上限（字符）。
 *
 * 为什么必须截：真机实测有会话 40 条就 260 KB（单条 44 KB 的长推文），
 * 而 `host.storage` 是**整个插件一个 JSON 文件**且同步整文件读改写 ——
 * 缓存把文件撑大，会拖慢这个插件的每一次写（待办、配置也一样）。
 * 1200/2400 字仍然够界面渲染一整屏气泡；更长的内容回源再看。
 */
export const CHAT_ROW_TEXT_MAX = 1200;
/**
 * 富文本（post / 卡片）正文上限。
 * 从 2400 降到 1600（0.14.1）：真机一轮 45 个会话的缓存字节里，富文本是最贵的一项 ——
 * 少 800 字换来的却是「更多会话能留在缓存里」（用户要的是群消息别掉出缓存，不是一篇长文看全）。
 * 更长的内容回源再看（点开会话会重新拉）。
 */
export const CHAT_ROW_RICH_MAX = 1600;
/**
 * 单个会话缓存的总预算（字节）：超出就从**最旧**的开始丢（用户看的是最近的）。
 * 从 40KB 降到 32KB（0.14.1）：40KB 时真机单会话几乎顶满，45 个会话里只能留下 35 个；
 * 32KB 仍然装得下「60 条 × 一整屏」，却能把更多会话保留下来。
 */
export const CHAT_CACHE_ENTRY_BYTES = 32 * 1024;
/**
 * **整份缓存**的字节预算（抢先于会话数生效）。
 *
 * 为什么需要全局预算：提到 60 个会话后，单靠「每会话 40KB」理论上能到 2.4MB ——
 * 而 `host.storage` 是整个插件**一个** JSON 文件、同步整文件读改写，
 * 缓存一大就会拖慢这个插件的**每一次写**（待办、配置、水位也一样）。
 * 1.25MB 是实测出来的折中（0.14.1 真机：45 个会话首轮建基线 2135 条消息）：
 * 1MB 只装得下 35 个会话（会掉 10 个群），1.25MB 能装完全部候选；
 * 一次 `JSON.stringify` + 写盘在 20ms 量级，且**内容没变就不落盘**（见 `put()`），不会变成常驻开销。
 * 超了从**最旧更新的会话**开始丢。
 */
export const CHAT_CACHE_TOTAL_BYTES = 1280 * 1024;

/** 姓名缓存上限 / 有效期。 */
export const CHAT_NAMES_LIMIT = 800;
export const CHAT_NAMES_TTL_MS = 7 * 24 * 3600_000;
/** 本地检索默认返回多少条命中。 */
export const CHAT_SEARCH_LIMIT = 60;
/** 关键词少于这个长度不做检索（一个字符会把整库都翻出来）。 */
export const CHAT_SEARCH_QUERY_MIN = 2;

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{4,}$/;

const text = (value) => (typeof value === "string" ? value.trim() : "");

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

const clampInt = (value, min, max, fallback) => {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	if (n < min) return min;
	if (n > max) return max;
	return n;
};

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * 会话 ID 形状（`oc_` 前缀）。
 * 与 `dm-watch.mjs` 的 `isValidChatId` **同口径**，但这里刻意不 import 它：
 * 本模块要能被单测直接 import，不该顺带拉起轮询引擎那一串依赖。
 */
export function isChatIdLike(value) {
	return CHAT_ID_RE.test(text(value));
}

/** 空缓存（读盘失败、首次运行都用它，形状必须和正常缓存一致）。 */
export function emptyChatCache() {
	return { version: CHAT_CACHE_VERSION, chats: {} };
}

/** 新到旧：时间相同再用 id 兜底，保证排序稳定（否则同一毫秒的两条会来回跳）。 */
function byNewestFirst(a, b) {
	const diff = (Number(b?.createTimeMs) || 0) - (Number(a?.createTimeMs) || 0);
	if (diff !== 0) return diff;
	return String(b?.id || "").localeCompare(String(a?.id || ""));
}

/**
 * 单条消息归一化：只留「界面 / 检索 / AI」都真正要用的字段。
 * 不落整包原始 JSON —— 一条飞书消息整包几 KB，120 条 × 40 会话会把 storage 撑爆。
 */
export function normalizeCachedRow(row) {
	if (!row || typeof row !== "object") return null;
	const id = text(row.id) || text(row.message_id);
	if (!id) return null;
	return {
		id,
		chatId: text(row.chatId) || text(row.chat_id),
		senderId: text(row.senderId),
		senderType: text(row.senderType),
		senderName: text(row.senderName),
		msgType: text(row.msgType) || "unknown",
		imageKey: text(row.imageKey),
		richText: text(row.richText).slice(0, CHAT_ROW_RICH_MAX),
		text: text(row.text).slice(0, CHAT_ROW_TEXT_MAX),
		createTimeMs: num(row.createTimeMs) || num(row.create_time),
		mentions: list(row.mentions)
			.slice(0, 20)
			.map((m) => ({ id: text(m?.id), name: text(m?.name) })),
		systemTemplate: text(row.systemTemplate).slice(0, 400),
	};
}

/** 按字节预算裁剪（从最旧的丢）：保住「最近一屏 + 一点回看」，也保住 storage 的体积。 */
export function trimRowsByBytes(rows, budget = CHAT_CACHE_ENTRY_BYTES) {
	const list = Array.isArray(rows) ? rows : [];
	const cap = Number(budget) > 0 ? Number(budget) : 0;
	if (!cap || list.length === 0) return list;
	const out = [];
	let total = 0;
	for (const row of list) {
		const size = JSON.stringify(row).length;
		// 至少留一条：单条就超预算时也不能返回空列表（界面会显示"没有消息"）。
		if (out.length > 0 && total + size > cap) break;
		total += size;
		out.push(row);
	}
	return out;
}

/** 同一 id 的新旧两份行：新行缺的字段（空串 / 0）沿用旧行，别把已知内容清掉。 */
function mergeCachedRow(prev, next) {
	const out = { ...prev };
	for (const [key, value] of Object.entries(next)) {
		if (value === "" || value === 0 || value === undefined || value === null) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		out[key] = value;
	}
	return out;
}

/** 合并两组消息：按 id 去重（后到的覆盖）、时间倒序、保留最近 `limit` 条。 */
export function mergeRows(prev, next, limit = CHAT_CACHE_MESSAGES) {
	const cap = clampInt(limit, 1, 1000, CHAT_CACHE_MESSAGES);
	const byId = new Map();
	const absorb = (row) => {
		const normalized = normalizeCachedRow(row);
		if (!normalized) return;
		const old = byId.get(normalized.id);
		byId.set(normalized.id, old ? mergeCachedRow(old, normalized) : normalized);
	};
	for (const row of list(prev)) absorb(row);
	for (const row of list(next)) absorb(row);
	return Array.from(byId.values()).sort(byNewestFirst).slice(0, cap);
}

/** 落盘数据 → 内存缓存（非 `oc_` 键、坏行、超限一律丢掉，绝不抛错）。 */
export function normalizeChatCache(raw) {
	const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const chats = src.chats && typeof src.chats === "object" && !Array.isArray(src.chats) ? src.chats : {};
	const out = emptyChatCache();
	for (const [chatId, entry] of Object.entries(chats)) {
		if (!isChatIdLike(chatId)) continue;
		// 读盘时也按预算裁一遍：老版本把整包正文存下来的会话（实测单条 42KB），
		// 不该一直占着 storage 的体积，下次落盘就瘦下来了。
		const rows = trimRowsByBytes(mergeRows([], entry?.rows));
		const fetchedAt = num(entry?.fetchedAt);
		const updatedAt = num(entry?.updatedAt) || fetchedAt;
		if (rows.length === 0 && !updatedAt) continue;
		out.chats[chatId] = {
			id: chatId,
			rows,
			// 老缓存没有 `full`：行数≥一屏就当它整页拉过（升级不该把每个会话都重拉一遍）。
			full: Boolean(entry?.full) || rows.length >= CHAT_CACHE_FULL_ROWS,
			newestMs: rows[0]?.createTimeMs || 0,
			hasMore: Boolean(entry?.hasMore),
			pageToken: text(entry?.pageToken),
			source: text(entry?.source),
			selfOpenId: text(entry?.selfOpenId),
			fetchedAt,
			updatedAt,
		};
	}
	return out;
}

/** 写入/合并一个会话（只碰这一条，不整库归一化 —— 否则每次 put 都要重排全部行）。 */
export function upsertChatCache(cache, chatId, patch = {}, { now = Date.now(), limit = CHAT_CACHE_MESSAGES } = {}) {
	if (!isChatIdLike(chatId)) return cache;
	const src = cache && typeof cache === "object" ? cache : emptyChatCache();
	const chats = src.chats && typeof src.chats === "object" ? { ...src.chats } : {};
	const prev = chats[chatId] || null;
	const rows = trimRowsByBytes(mergeRows(prev?.rows, patch.rows, limit));
	const at = num(now) || Date.now();
	chats[chatId] = {
		id: chatId,
		rows,
		// 「这个会话已经整页拉过一次」（见 `CHAT_CACHE_FULL_ROWS`）：没它之前一切拉取都是增量，
		// 缓存里永远只有增量那几条。写入口只在**真的整页拉过**时传 `full: true`。
		full: patch.full === undefined ? Boolean(prev?.full) : Boolean(patch.full),
		newestMs: rows[0]?.createTimeMs || 0,
		hasMore: patch.hasMore === undefined ? Boolean(prev?.hasMore) : Boolean(patch.hasMore),
		pageToken: patch.pageToken === undefined ? text(prev?.pageToken) : text(patch.pageToken),
		source: text(patch.source) || text(prev?.source),
		selfOpenId: text(patch.selfOpenId) || text(prev?.selfOpenId),
		// put 的语义就是「我刚拉过一次」：时间戳一起推进，界面据此判断要不要后台刷新。
		fetchedAt: at,
		updatedAt: at,
	};
	return { version: CHAT_CACHE_VERSION, chats };
}

/**
 * 剔除过期会话，按最近更新时间保留 `maxChats` 个，并保证**整份缓存不超字节预算**。
 *
 * 两道闸的顺序有意义：先按数量/TTL 筛，再按字节从最旧的会话开始丢。
 * 只按字节丢会把「很久没说话但很关键的会话」留下、把「刚同步过的群」丢掉，
 * 而用户真正要看的是**最近有动静的**那个。
 */
export function pruneChatCache(
	cache,
	{
		now = Date.now(),
		maxChats = CHAT_CACHE_CHATS,
		ttlMs = CHAT_CACHE_TTL_MS,
		totalBytes = CHAT_CACHE_TOTAL_BYTES,
	} = {},
) {
	const src = cache && typeof cache === "object" ? cache : emptyChatCache();
	const chats = src.chats && typeof src.chats === "object" ? src.chats : {};
	const at = num(now) || Date.now();
	const keep = [];
	for (const [chatId, entry] of Object.entries(chats)) {
		if (!isChatIdLike(chatId)) continue;
		const last = num(entry?.updatedAt) || num(entry?.fetchedAt);
		if (!last || at - last > Math.max(0, Number(ttlMs) || 0)) continue;
		keep.push([chatId, entry]);
	}
	keep.sort((a, b) => (num(b[1]?.updatedAt) || 0) - (num(a[1]?.updatedAt) || 0));
	const out = emptyChatCache();
	// 全局字节预算（0 / 非法值 = 不设限）：至少留一个会话，别因为一条大消息把缓存清空。
	const cap = Number(totalBytes) > 0 ? Number(totalBytes) : 0;
	let used = 0;
	for (const [chatId, entry] of keep.slice(0, clampInt(maxChats, 1, 500, CHAT_CACHE_CHATS))) {
		const size = JSON.stringify(entry).length;
		if (cap > 0 && used > 0 && used + size > cap) break;
		used += size;
		out.chats[chatId] = entry;
	}
	return out;
}

/** 读一个会话的消息（新到旧，最多 `limit` 条）。 */
export function readChatRows(cache, chatId, { limit = CHAT_CACHE_MESSAGES } = {}) {
	const entry = cache?.chats?.[chatId] || null;
	if (!entry) return { rows: [], entry: null };
	return { rows: entry.rows.slice(0, clampInt(limit, 1, 1000, CHAT_CACHE_MESSAGES)), entry };
}

/** 命中片段：围绕关键词截一段，让「为什么这条被搜出来」一眼可见。 */
export function snippetOf(value, needle, width = 90) {
	const raw = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!raw) return "";
	const key = String(needle ?? "").toLowerCase();
	const at = key ? raw.toLowerCase().indexOf(key) : -1;
	if (at < 0) return raw.length > width ? `${raw.slice(0, width)}…` : raw;
	const half = Math.max(10, Math.floor((width - key.length) / 2));
	const start = Math.max(0, at - half);
	const end = Math.min(raw.length, at + key.length + half);
	return `${start > 0 ? "…" : ""}${raw.slice(start, end)}${end < raw.length ? "…" : ""}`;
}

/**
 * 本地关键词检索：跨会话翻缓存，不打任何飞书接口。
 * 命中按时间倒序（用户找的多半是「刚才那句」）；`scanned` 让界面/模型知道搜了多大范围。
 */
export function searchChatCache(cache, { query = "", chatIds = [], limit = CHAT_SEARCH_LIMIT, sinceMs = 0 } = {}) {
	const needle = text(query).toLowerCase();
	const cap = clampInt(limit, 1, 200, CHAT_SEARCH_LIMIT);
	if (needle.length < CHAT_SEARCH_QUERY_MIN) return { hits: [], scanned: 0, tooShort: true };
	const scope = list(chatIds).filter(isChatIdLike);
	const scopeSet = scope.length ? new Set(scope) : null;
	const chats = cache?.chats && typeof cache.chats === "object" ? cache.chats : {};
	const since = num(sinceMs);
	let scanned = 0;
	const hits = [];
	for (const [chatId, entry] of Object.entries(chats)) {
		if (scopeSet && !scopeSet.has(chatId)) continue;
		for (const row of list(entry?.rows)) {
			scanned += 1;
			if (since && (Number(row.createTimeMs) || 0) < since) continue;
			const haystack = `${row.text || ""}\n${row.richText || ""}\n${row.senderName || ""}`.toLowerCase();
			if (!haystack.includes(needle)) continue;
			hits.push({ ...row, chatId, snippet: snippetOf(row.text || row.richText || "", needle) });
		}
	}
	hits.sort(byNewestFirst);
	return { hits: hits.slice(0, cap), scanned, tooShort: false };
}

/**
 * 整份缓存的字节数（**各会话条目之和**）。只用来卡预算/自述，不要求精确。
 *
 * 为什么要和 `pruneChatCache` 同一口径（按条目累加、不计 JSON 外壳）：
 * 两边用不同度量时会出现「自以为在预算内，实际已超」—— 预算这种东西，量法和限法必须是同一个。
 */
export function cacheBytes(cache) {
	const chats = cache?.chats && typeof cache.chats === "object" ? cache.chats : {};
	let total = 0;
	for (const entry of Object.values(chats)) total += JSON.stringify(entry).length;
	return total;
}

/** 缓存自述（界面/排错用）：多少会话、多少行、时间跨度、最后拉取时间、占多大。 */
export function chatCacheStats(cache) {
	const chats = cache?.chats && typeof cache.chats === "object" ? cache.chats : {};
	let rows = 0;
	let newestAt = 0;
	let oldestAt = 0;
	let lastFetchedAt = 0;
	for (const entry of Object.values(chats)) {
		const rowsOf = Array.isArray(entry?.rows) ? entry.rows : [];
		rows += rowsOf.length;
		const newest = num(rowsOf[0]?.createTimeMs);
		const oldest = num(rowsOf[rowsOf.length - 1]?.createTimeMs);
		if (newest > newestAt) newestAt = newest;
		if (oldest && (!oldestAt || oldest < oldestAt)) oldestAt = oldest;
		const fetched = num(entry?.fetchedAt);
		if (fetched > lastFetchedAt) lastFetchedAt = fetched;
	}
	return {
		chats: Object.keys(chats).length,
		rows,
		newestAt,
		oldestAt,
		lastFetchedAt,
		bytes: cacheBytes(cache),
	};
}

/* ------------------------------ 姓名缓存 ------------------------------ */
//
// CLI 的消息里通常已带 `sender.name`，缺的那些才需要 `contact +search-user --user-ids`。
// 但那是一个额外的 CLI 子进程（每打开一次会话就多等 1–3s），所以查到的名字记 7 天。

/** 落盘数据 → 名字表（只留非空姓名，按时间保留最近的）。 */
export function normalizeNameCache(raw) {
	const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const rows = Object.entries(src)
		.filter(([openId, value]) => text(openId) && value && typeof value === "object" && text(value.name))
		.sort((a, b) => (num(b[1]?.at) || 0) - (num(a[1]?.at) || 0));
	const out = {};
	for (const [openId, value] of rows.slice(0, CHAT_NAMES_LIMIT)) {
		out[openId] = { name: text(value.name), at: num(value.at) };
	}
	return out;
}

/** 合并一批名字（`{ openId: name }`），返回归一化后的整表。 */
export function mergeNameCache(cache, map, { now = Date.now() } = {}) {
	const src = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
	const out = { ...src };
	const at = num(now) || Date.now();
	for (const [openId, name] of Object.entries(map || {})) {
		const id = text(openId);
		const value = text(name);
		if (!id || !value) continue;
		out[id] = { name: value, at };
	}
	return normalizeNameCache(out);
}

/** 从名字表里取若干个 open_id 的姓名（无则缺省）。 */
export function pickNames(cache, openIds) {
	const out = {};
	for (const id of list(openIds)) {
		const name = text(cache?.[id]?.name);
		if (id && name) out[id] = name;
	}
	return out;
}

/** 这些 open_id 里哪些还需要查（没名字，或名字已过期）。 */
export function staleNameIds(cache, openIds, { now = Date.now(), ttlMs = CHAT_NAMES_TTL_MS } = {}) {
	const at = num(now) || Date.now();
	const out = [];
	for (const raw of list(openIds)) {
		const id = text(raw);
		if (!id || out.includes(id)) continue;
		const entry = cache?.[id];
		const fresh = text(entry?.name) && at - (num(entry?.at) || 0) <= Math.max(0, Number(ttlMs) || 0);
		if (!fresh) out.push(id);
	}
	return out;
}

/* ------------------------------ 存储外壳 ------------------------------ */

/**
 * 缓存存储：内存为主、落盘防抖。
 *
 * @param {object} deps
 * @param {{get?:Function,set?:Function}} [deps.storage] host.storage
 * @param {(level:string,text:string)=>void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.persistDelayMs] 落盘防抖（一轮轮询只写一次文件）
 */
export function createChatCacheStore({
	storage,
	log = () => {},
	now = () => Date.now(),
	limitMessages = CHAT_CACHE_MESSAGES,
	limitChats = CHAT_CACHE_CHATS,
	limitBytes = CHAT_CACHE_TOTAL_BYTES,
	ttlMs = CHAT_CACHE_TTL_MS,
	nameTtlMs = CHAT_NAMES_TTL_MS,
	nameLimit = CHAT_NAMES_LIMIT,
	// 落盘只服务「重启后还在」：运行时读的都是内存，所以不必每轮都写文件。
	persistDelayMs = 5000,
} = {}) {
	let cache = emptyChatCache();
	let names = {};
	let loaded = false;
	let loading = null;
	let timer = null;
	let dirty = false;
	/**
	 * 整份缓存的字节数（增量维护）。
	 * 为什么不在 put 里直接 `JSON.stringify(cache)`：一轮轮询会写 50 个会话，
	 * 每次都把整份缓存（可能 ~1MB）序列化一遍，纯属白烧主线程；只算**这一条**的前后差值即可。
	 */
	let bytes = 0;
	/** 在飞的落盘（并发 flush 合并成一次）。 */
	let flushing = null;

	async function readKey(key) {
		try {
			return await storage?.get?.(key);
		} catch (err) {
			log("warn", `feishu-pro 会话缓存读取失败（${key}）：${err?.message || err}`);
			return undefined;
		}
	}

	/** 读盘（幂等、并发安全）：缓存只是加速，任何异常都降级成空缓存。 */
	async function load() {
		if (loaded) return cache;
		if (loading) return loading;
		loading = (async () => {
			const [rawCache, rawNames] = await Promise.all([readKey(CHAT_CACHE_KEY), readKey(CHAT_NAMES_KEY)]);
			cache = pruneChatCache(normalizeChatCache(rawCache), {
				now: now(),
				maxChats: limitChats,
				ttlMs,
				totalBytes: limitBytes,
			});
			names = normalizeNameCache(rawNames);
			bytes = cacheBytes(cache);
			loaded = true;
			// 读进来的数据被裁剪过（老版本 / 超过体积预算）就安排一次落盘：文件自己瘦下来，
			// 而不是等下一次有人写缓存。空缓存不写，免得每次激活都碰一下磁盘。
			if (Object.keys(cache.chats).length > 0) schedule();
			loading = null;
			return cache;
		})();
		return loading;
	}

	/**
	 * 落盘：清定时器 → 真的脏才写（防抖窗口内的多次 put 合成一次整文件写）。
	 * 并发调用共用同一次写入；**写失败不清 dirty**，下一次还有机会补上。
	 */
	async function flush() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!dirty) return flushing ?? undefined;
		if (flushing) return flushing;
		flushing = (async () => {
			try {
				await storage?.set?.(CHAT_CACHE_KEY, cache);
				await storage?.set?.(CHAT_NAMES_KEY, names);
				dirty = false;
			} catch (err) {
				log("warn", `feishu-pro 会话缓存落盘失败：${err?.message || err}`);
			}
		})().finally(() => {
			flushing = null;
		});
		return flushing;
	}

	function schedule() {
		dirty = true;
		if (timer) return;
		timer = setTimeout(
			() => {
				timer = null;
				void flush();
			},
			Math.max(0, Number(persistDelayMs) || 0),
		);
		timer?.unref?.();
	}

	/**
	 * 落盘判重的口径：只有这些字段变了才值得写整份缓存。
	 *
	 * `fetchedAt` / `updatedAt` 每轮都在变（put 的语义就是「我刚拉过一次」），把它们算进去
	 * 就变成「每轮必落盘」—— 而增量轮询大多数轮次拉回来的还是那几条（`--start` 边界重叠）。
	 * 反过来，`full` / `hasMore` / `pageToken` **必须**算：它们决定「下次是增量还是补一屏」，
	 * 只在内存里变了而不落盘的话，重启后会再去整页拉一轮。
	 */
	function persistSignature(entry) {
		if (!entry) return "";
		return JSON.stringify([entry.rows, Boolean(entry.full), Boolean(entry.hasMore), text(entry.pageToken)]);
	}

	/** 写入一个会话的消息（后台轮询 / 界面拉取 / AI 读消息都走这里）。 */
	function put(chatId, patch = {}) {
		if (!isChatIdLike(chatId)) return null;
		const prevEntry = cache.chats[chatId] || null;
		const prevSignature = persistSignature(prevEntry);
		const before = prevEntry ? JSON.stringify(prevEntry).length : 0;
		cache = upsertChatCache(cache, chatId, patch, { now: now(), limit: limitMessages });
		const entry = cache.chats[chatId] || {};
		bytes = Math.max(0, bytes - before + JSON.stringify(entry).length);
		// 只在超限时裁剪：每次 put 都 prune 会让上千行反复排序。
		// 「超限」包含**会话数**与**整份缓存的字节数**：只按会话数判断，一批长推文就能把文件撑到几 MB。
		if (Object.keys(cache.chats).length > limitChats || bytes > limitBytes) {
			cache = pruneChatCache(cache, { now: now(), maxChats: limitChats, ttlMs, totalBytes: limitBytes });
			bytes = cacheBytes(cache);
		}
		// **内容没变就不落盘**：增量轮询大多数轮次拉回来的还是那几条（`--start` 的边界重叠），
		// 而整份缓存已经到 MB 级 —— 每轮白写一次文件纯属浪费。时间戳照旧只留在内存里，
		// 落盘的那份稍旧一点没有影响（它只用于「重启后界面先有内容」）。
		if (persistSignature(cache.chats[chatId] || null) !== prevSignature) schedule();
		return cache.chats[chatId] || null;
	}

	/** 读一个会话（新到旧）。 */
	function chat(chatId, { limit = limitMessages } = {}) {
		return readChatRows(cache, chatId, { limit });
	}

	/** 该会话最新一条（会话列表上的「最后一条预览」用）。 */
	function lastMessage(chatId) {
		return cache?.chats?.[chatId]?.rows?.[0] || null;
	}

	/** 会话元信息（条数 / 新鲜度），列表页据此显示「本地已缓存 N 条」。 */
	function meta(chatId) {
		const entry = cache?.chats?.[chatId];
		if (!entry) return null;
		return {
			rows: list(entry.rows).length,
			full: Boolean(entry.full),
			hasMore: Boolean(entry.hasMore),
			pageToken: text(entry.pageToken),
			newestMs: num(entry.newestMs),
			fetchedAt: num(entry.fetchedAt),
			updatedAt: num(entry.updatedAt),
			source: text(entry.source),
		};
	}

	/**
	 * 这个会话要不要先**整页补一屏**（缓存里还没整页拉过 = 只有增量那几条）。
	 *
	 * 调用方（共用同一份缓存的后台轮询）据此把这一轮的取数从「`--start` 之后的新消息」
	 * 换成「最新整页」——**不增加 CLI 调用次数**，只是这一次多带回一屏历史。
	 * 没有这个阀门，水位比缓存活得久的会话会永远是「缓存里只有 1 条」。
	 */
	function needsBackfill(chatId) {
		const entry = cache?.chats?.[chatId];
		if (!entry) return true;
		if (entry.full) return false;
		// 行数已经够一屏：标记丢了也不必回源（老缓存 / 手工修过的数据）。
		return list(entry.rows).length < CHAT_CACHE_FULL_ROWS;
	}

	function namesFor(openIds) {
		return pickNames(names, openIds);
	}

	function putNames(map) {
		const next = mergeNameCache(names, map, { now: now() });
		names = Object.fromEntries(Object.entries(next).slice(0, clampInt(nameLimit, 1, 5000, CHAT_NAMES_LIMIT)));
		schedule();
		return namesFor(Object.keys(map || {}));
	}

	/** 还需要去查名字的 open_id（无名字 / 过期）。 */
	function missingNames(openIds) {
		return staleNameIds(names, openIds, { now: now(), ttlMs: nameTtlMs });
	}

	function search(options = {}) {
		return searchChatCache(cache, options);
	}

	function stats() {
		return {
			...chatCacheStats(cache),
			names: Object.keys(names).length,
			limit: { messages: limitMessages, chats: limitChats, bytes: limitBytes, ttlMs },
			keys: { cache: CHAT_CACHE_KEY, names: CHAT_NAMES_KEY },
		};
	}

	/** 缓存里的会话 id（AI 侧「我本地有哪些会话」用）。 */
	function chatIds() {
		return Object.keys(cache?.chats || {});
	}

	async function clear() {
		cache = emptyChatCache();
		names = {};
		bytes = 0;
		dirty = true;
		await flush();
	}

	function prune() {
		cache = pruneChatCache(cache, { now: now(), maxChats: limitChats, ttlMs, totalBytes: limitBytes });
		bytes = cacheBytes(cache);
		schedule();
		return cache;
	}

	return {
		load,
		put,
		chat,
		lastMessage,
		meta,
		needsBackfill,
		namesFor,
		putNames,
		missingNames,
		search,
		stats,
		chatIds,
		prune,
		clear,
		flush,
	};
}
