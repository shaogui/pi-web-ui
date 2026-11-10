/**
 * plugins/feishu-pro/lib/dm-watch.mjs
 * 轮询式「消息同步 / 私聊提醒」：把「有人给我发了消息」变成插件能感知的事件。
 *
 * 为什么只能轮询（这是飞书的产品边界，不是偷懒）：
 *   - 事件订阅 `im.message.receive_v1` **只推机器人收到的消息**，人类账号的私聊没有事件；
 *   - 飞书没有「我的会话列表」「我的未读数」这类个人身份接口；
 *   - 所以唯一可用的路径是：user_access_token 拉 `im/v1/messages` 增量，按间隔轮询。
 *
 * 轮询的两个真实难点，本模块都是围绕它们设计的：
 *   1. **会话从哪来**：`im/v1/chats` 用个人身份能不能返回单聊（chat_mode=p2p）**未经实测**，
 *      因此候选会话 = 手填的 chat_id + 自动发现的结果，自动发现失败也不阻断手填路径。
 *      发现结果本身也带诊断信息（total/p2p/groups），界面据此告诉用户"飞书没给单聊"。
 *   2. **首次轮询不能刷屏**：没有水位（watermark）的会话，第一次只**建基线**（把水位推到最新一条，
 *      不通知），之后只报比水位新的消息。否则一启用就把最近 50 条历史全弹一遍。
 *      建基线只取**一页**（多翻的页会被缓存条数上限剪掉，纯白 spawn）—— 首轮 50 个会话的成本就靠这条压住。
 *
 * 0.14.0 起本模块同时承担**群消息同步**（`syncGroups`）：同一轮轮询里，单聊与群聊都拉增量、
 * 都写进本地会话缓存（`onFetched`），区别只在于**要不要弹通知**（群默认静默，见 `pickNotifyRecords`）。
 * 也就是说「消息同步」与「私聊提醒」是**同一个引擎的两个面**：一个控制面（`/sync/*`）、
 * 一份水位、一份缓存；不存在第二套定时器，也就不会出现「两处各拉一遍」的配额浪费。
 *
 * 幂等与限流：
 *   - 水位存秒（飞书 create_time 是毫秒字符串，`im/v1/messages` 的 start_time 要秒）；
 *   - `seen` 记已报过的 message_id（有上限），防同一条因水位相等被重复报；
 *   - 每轮最多轮询 `MAX_CHATS_PER_POLL` 个会话，间隔下限 30s ≈ 0.33 QPS，远低于 20 QPS 限额；
 *   - 单会话失败只记在该会话的 lastError 上，不影响其它会话与下一轮。
 *
 * 取数方向（0.10.21 修）：**永远按时间降序、从最新往回翻**。
 *   升序 + start_time 拿到的是「水位之后最旧的一页」：积压 100 条时只报最旧的 20 条，
 *   每轮前进 20 条，提醒与未读数会一直滞后在历史里（症状就是「拉的不是最近一段的消息」）；
 *   首次建基线更惨 —— 无 start_time 的升序返回的是**会话历史最旧的一页**，
 *   基线被钉在开聊那天，之后把整段历史当新消息一条条弹出来。
 *   降序后：基线 = 现在；增量 = 最近一页（最多 `MAX_PAGES_PER_CHAT` 页），水位直接对齐到最新一条。
 */

/** 配置落盘键（host.storage）。 */
export const DM_CONFIG_KEY = "dm_watch";
/** 运行态落盘键：水位 + 已见 message_id，重启后不重报。 */
export const DM_STATE_KEY = "dm_watch_state";
/** 提醒历史（界面上显示最近几条）。 */
export const DM_HISTORY_KEY = "dm_watch_history";

/** 轮询间隔上下限（秒）：低于 30s 对飞书不礼貌，也换不来多少实时性。 */
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 900;
/**
 * 每轮最多轮询的**单聊**会话数（手填 / 监听名单也算在这个预算里）。
 * 从 10 提到 30：未读数要覆盖「全部单聊」（实测 26 个），30s 一轮 ≈ 0.9 QPS，
 * 仍远低于飞书 im/v1/messages 的限流；多出来的会话按 CLI 的 active_time 顺序排后面。
 */
export const MAX_CHATS_PER_POLL = 30;
/**
 * 每轮最多轮询的**群聊**会话数（独立预算，不与单聊抢名额）。
 *
 * 为什么单开一份预算：群的数量通常远多于单聊，若共用一个 30 的上限，
 * 26 个单聊就把名额吃光了，`syncGroups` 打开也等于没开。
 * 成本口径（按 lark-cli 单次 spawn ≈ 25ms 实测）：30 单聊 + 20 群 = 50 次/轮，
 * 60s 间隔 ≈ 每天 1.8 分钟 CPU（单核 0.13%）；30s 间隔 ≈ 0.25%，仍可接受。
 */
export const MAX_GROUPS_PER_POLL = 20;
/** 已见 message_id 上限。 */
export const SEEN_LIMIT = 600;
/** 每会话每页取多少条（飞书 `im/v1/messages` 上限 50）。 */
export const POLL_PAGE_SIZE = 50;
/**
 * 水位上「已处理 id」的保留上限（按会话计）。
 * 为什么不靠全局 `seen`：`seen` 是跨会话的滑动窗口（600 条），忙群几十分钟就能把安静会话的
 * 边界 id 挤出去 —— 那时「与水位同一毫秒」的消息就会被当成新消息反复上报（已读后又变未读）。
 * 边界去重必须**按会话**、且跟着水位一起落盘。
 */
export const WATERMARK_ID_LIMIT = 200;
/**
 * 每会话单轮最多往回翻几页。
 * 超过就当「积压」：只报最近这几页，水位直接对齐到最新一条。
 * 宁可漏报积压里的旧消息（用户点开会话就能看到），也不能让提醒永远追着历史跑。
 */
export const MAX_PAGES_PER_CHAT = 3;
/** 提醒历史上限。 */
export const HISTORY_LIMIT = 50;

/** 缺省配置：老数据缺字段时按它回落（新增字段必须给缺省值）。 */
export const DM_DEFAULT_CONFIG = {
	/** 是否启用轮询。 */
	enabled: false,
	/** 轮询间隔（秒）。 */
	intervalSec: 60,
	/** 用哪个身份读消息：user = 我的私聊（默认）；tenant = 机器人所在会话（对照用）。 */
	identity: "user",
	/** 手填会话 ID，逗号/空格/换行分隔。 */
	chatIds: "",
	/** 自动发现：用个人身份调 `im/v1/chats` 找 p2p 会话（可能返回空，见文件头）。 */
	autoDiscover: true,
	/**
	 * 群聊是否也自动发现并纳入轮询（**默认开**：群消息也要自动进本地缓存）。
	 *
	 * 为什么敢默认开：
	 *   - 群聊有**独立预算**（`MAX_GROUPS_PER_POLL`），不会和单聊抢名额；
	 *   - 群消息默认**只同步不提醒**（`notifyGroups: false`）—— 拉取存在感最小；
	 *   - 成本可算：30 单聊 + 20 群、60s 一轮 ≈ 每天 1.8 分钟 CPU（单核 0.13%）。
	 * 关掉它只影响「后台自动拉」，不影响打开会话时的按需拉取。
	 */
	syncGroups: true,
	/** 新消息是否弹通知（单聊提醒）。 */
	notify: true,
	/** 群消息是否也弹通知（默认关：同步不等于要打扰）。 */
	notifyGroups: false,
};

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{4,}$/;

const text = (value) => (typeof value === "string" ? value.trim() : "");

const clampInt = (value, min, max, fallback) => {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	if (n < min) return min;
	if (n > max) return max;
	return n;
};

/** 合法会话 ID（`oc_` 前缀；飞书的 p2p/群会话都是这个形状）。 */
export function isValidChatId(value) {
	return CHAT_ID_RE.test(text(value));
}

/**
 * 解析手填会话 ID：支持字符串（逗号/空白/换行分隔）或数组。
 * 非法项直接丢弃（写错一个不该让整条配置失效），结果去重保序。
 */
export function parseChatIds(value) {
	const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,，;；]+/);
	const out = [];
	for (const item of raw) {
		const id = text(item);
		if (!isValidChatId(id)) continue;
		if (out.includes(id)) continue;
		out.push(id);
	}
	return out;
}

/**
 * 配置归一化（幂等）：白名单 + 钳制 + 手填 ID 规范化。
 * 不认识的字段一律丢弃；identity 只认 user/tenant。
 */
export function normalizeDmConfig(input, base = DM_DEFAULT_CONFIG) {
	const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const prev = base && typeof base === "object" ? base : DM_DEFAULT_CONFIG;
	const pick = (key) => (Object.hasOwn(src, key) ? src[key] : prev[key]);
	const identity = String(pick("identity") ?? "").toLowerCase() === "tenant" ? "tenant" : "user";
	return {
		enabled: Boolean(pick("enabled")),
		intervalSec: clampInt(pick("intervalSec"), MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, DM_DEFAULT_CONFIG.intervalSec),
		identity,
		chatIds: parseChatIds(pick("chatIds")).join(","),
		autoDiscover: Boolean(pick("autoDiscover")),
		syncGroups: Boolean(pick("syncGroups")),
		notify: pick("notify") === undefined ? true : Boolean(pick("notify")),
		notifyGroups: Boolean(pick("notifyGroups")),
	};
}

/** `im/v1/chats` 的单条归一化。 */
export function normalizeChatItem(item) {
	if (!item || typeof item !== "object") return null;
	const id = text(item.chat_id);
	if (!isValidChatId(id)) return null;
	const mode = text(item.chat_mode) || "group";
	return {
		id,
		name: text(item.name) || "",
		mode,
		type: text(item.chat_type) || "",
		desc: text(item.description) || "",
		p2p: mode === "p2p",
	};
}

/** 会话列表归一化 + 去重。 */
export function normalizeChatItems(items) {
	const out = [];
	const seen = new Set();
	for (const item of Array.isArray(items) ? items : []) {
		const chat = normalizeChatItem(item);
		if (!chat || seen.has(chat.id)) continue;
		seen.add(chat.id);
		out.push(chat);
	}
	return out;
}

/** 会话种类（候选集合、通知判定、界面展示的唯一口径）。 */
export const CHAT_KINDS = ["p2p", "group", "unknown"];

/**
 * 本次轮询要拉哪些会话（纯函数，单测直接钉住）。
 *
 * 优先级与预算（这是「私聊和群消息的拉取机制」的核心规则）：
 *   1. **手填 / 手动监听**（explicit）：用户明确要求的，最高优先级，群聊也一样；
 *   2. **自动发现的单聊**：预算 `maxChats`（手填的单聊也算在里面）；
 *   3. **自动发现的群聊**：预算 `maxGroups`，**独立计数** —— 否则单聊一多群就永远轮不到。
 * 顺序也决定了「配额不够时先扔谁」：靠后的先被截掉（CLI 的 chat-list 已按 active_time 排序，
 * 所以被截掉的通常是最近没说话的会话）。
 *
 * @param {{explicit?: string[], p2p?: string[], groups?: string[]}} [sources]
 * @returns {{id: string, kind: "p2p"|"group"|"unknown", explicit: boolean}[]}
 */
export function buildPollCandidates({ explicit = [], p2p = [], groups = [] } = {}, options = {}) {
	const maxChats = clampInt(options.maxChats, 1, 200, MAX_CHATS_PER_POLL);
	const maxGroups = clampInt(options.maxGroups, 0, 200, MAX_GROUPS_PER_POLL);
	const asIds = (value) => {
		const out = [];
		for (const item of Array.isArray(value) ? value : []) {
			const id = text(item);
			// 条目也可能已经是 `{ id }` 形状（发现结果为对象时调用方不必先拆）。
			const raw = typeof item === "object" && item ? text(item.id) : id;
			if (!isValidChatId(raw) || out.includes(raw)) continue;
			out.push(raw);
		}
		return out;
	};
	const dmIds = asIds(p2p);
	const groupIds = asIds(groups);
	const dmSet = new Set(dmIds);
	const groupSet = new Set(groupIds);
	const kindOf = (id) => (dmSet.has(id) ? "p2p" : groupSet.has(id) ? "group" : "unknown");

	const out = [];
	const taken = new Set();
	let dmCount = 0;
	let groupCount = 0;
	const push = (id, isExplicit) => {
		if (!isValidChatId(id) || taken.has(id)) return;
		taken.add(id);
		out.push({ id, kind: kindOf(id), explicit: isExplicit });
	};

	for (const id of asIds(explicit)) {
		if (out.length >= maxChats + maxGroups) break;
		const kind = kindOf(id);
		if (kind === "group") {
			if (groupCount >= maxGroups) continue;
			groupCount += 1;
		} else {
			if (dmCount >= maxChats) continue;
			dmCount += 1;
		}
		push(id, true);
	}
	for (const id of dmIds) {
		if (dmCount >= maxChats) break;
		if (taken.has(id)) continue;
		push(id, false);
		dmCount += 1;
	}
	for (const id of groupIds) {
		if (groupCount >= maxGroups) break;
		if (taken.has(id)) continue;
		push(id, false);
		groupCount += 1;
	}
	return out;
}

/** 富文本（post）里的文本片段，深度优先收集。 */
function collectRichText(node, acc) {
	if (!node) return;
	if (Array.isArray(node)) {
		for (const item of node) collectRichText(item, acc);
		return;
	}
	if (typeof node !== "object") return;
	if (typeof node.text === "string" && node.text) acc.push(node.text);
	for (const value of Object.values(node)) {
		if (value && typeof value === "object") collectRichText(value, acc);
	}
}

/**
 * 把正文里的 `@_user_1` 占位符换成真实姓名（飞书在 `mentions` 里给映射）。
 * 不做这层替换，界面上就是一屏 `@_user_1 我看这个文档…`。
 */
export function applyMentions(text, mentions) {
	const raw = String(text ?? "");
	const list = Array.isArray(mentions) ? mentions : [];
	if (!raw || list.length === 0) return raw;
	let out = raw;
	for (const mention of list) {
		const key = text2(mention?.key);
		if (!key) continue;
		const openId = text2(mention?.id?.open_id);
		// key 自带 `@`，替换值也要带 `@`；没有名字时用 open_id 尾号兜底。
		const name = text2(mention?.name) || (openId ? openId.slice(-6) : "");
		if (name) out = out.split(key).join(`@${name}`);
	}
	return out;
}

const text2 = (value) => (typeof value === "string" ? value.trim() : "");

/** 消息正文预览：不能用"把 content 直接截断"糊过去，JSON 会糊用户一脸。 */
export function messagePreview(item, mentions) {
	const msgType = text(item?.msg_type) || "unknown";
	let content = item?.body?.content;
	if (typeof content === "string" && content.trim()) {
		try {
			content = JSON.parse(content);
		} catch {
			content = { text: content };
		}
	}
	if (!content || typeof content !== "object") content = {};

	switch (msgType) {
		case "text":
			return applyMentions(text(content.text), mentions ?? item?.mentions) || "[文本]";
		case "post": {
			const acc = [];
			collectRichText(content.content ?? content, acc);
			const joined = acc.join(" ").replace(/\s+/g, " ").trim();
			return applyMentions(joined, mentions ?? item?.mentions) || "[富文本]";
		}
		case "image":
			return "[图片]";
		case "file":
			return `[文件] ${text(content.file_name) || ""}`.trim();
		case "audio":
			return "[语音]";
		case "media":
			return `[视频] ${text(content.file_name) || ""}`.trim();
		case "sticker":
			return "[表情]";
		case "merge_forward":
			return "[合并转发]";
		case "share_chat":
			return "[群名片]";
		case "share_user":
			return "[个人名片]";
		case "interactive":
			return "[卡片]";
		case "hongbao":
			return "[红包]";
		case "system":
			return "[系统消息]";
		default:
			return `[${msgType}]`;
	}
}

/** 单条消息归一化：只留提醒需要的字段（不落整包，避免存储膨胀）。 */
export function normalizeMessageItem(item) {
	if (!item || typeof item !== "object") return null;
	const id = text(item.message_id);
	if (!id) return null;
	const sender = item.sender && typeof item.sender === "object" ? item.sender : {};
	const createTime = Number(item.create_time);
	// 保留 CLI 给的原始类型（post / interactive / image…）：上游为了统一解析会把它压成 text，
	// 真实类型放在 cli_msg_type 里，前端据此决定用 markdown / 卡片渲染。
	const msgType = text(item.cli_msg_type) || text(item.msg_type) || "unknown";
	// `mentions` / 系统消息模板是**推断"这是群还是单聊"**的关键线索（见 chats.mjs inferChatMode）：
	// 群里常见 @第三方与"XX 加入了群聊"，单聊里几乎没有。只留最小字段，别把整包带进存储。
	const mentions = Array.isArray(item.mentions)
		? item.mentions.slice(0, 20).map((m) => ({
				id: text(m?.id?.open_id) || text(m?.id?.user_id) || "",
				name: text(m?.name) || "",
			}))
		: [];
	const rawContent =
		msgType === "system" && typeof item.body?.content === "string" ? item.body.content.slice(0, 400) : "";
	return {
		id,
		chatId: text(item.chat_id),
		senderId: text(sender.id),
		senderType: text(sender.sender_type) || text(sender.id_type) || "",
		senderName: text(sender.name) || "",
		msgType,
		// 图片消息的资源 key（CLI 把它写进可读 content：`[Image: img_v3_xxx]`）；
		// 有了它前端才能把气泡换成真图片（走 /chat/media 代理）。
		imageKey: text(item.image_key) || "",
		richText: text(item.rich_text) || "",
		text: messagePreview(item),
		createTimeMs: Number.isFinite(createTime) ? createTime : 0,
		mentions,
		systemTemplate: rawContent,
	};
}

/**
 * 挑选本次要上报的新消息。
 * 规则：不旧于水位（严格 < 才丢）、不是自己发的、没在 seen 里；按时间升序，便于按顺序展示。
 *
 * 为什么边界用 `>=` 而不是 `>`：lark-cli 的 `create_time` 只到**分钟**（`"2026-11-06 23:51"`），
 * 同一分钟里后到的消息时间戳与水位完全相等 —— 用 `>` 会把它们永久漏掉（未读数偏少、提醒缺失）。
 * 边界那条靠 `seen` 挡住：基线会把当时那一页的 id 全部写进 seen（见 pollOnce）。
 */
export function pickNewMessages(items, options = {}) {
	// 兼容两种入参：`{ watermark: { ms, ids } }`（新）与 `{ watermarkMs }`（旧/单测）。
	const wm = normalizeWatermark(options.watermark ?? options.watermarkMs ?? 0);
	const handledAtWm = new Set(wm.ids);
	const watermarkMs = wm.ms;
	const seen = options.seen instanceof Set ? options.seen : new Set(Array.isArray(options.seen) ? options.seen : []);
	const selfId = text(options.selfOpenId);
	const out = [];
	// 同批里去重：分页边界可能重叠（或通道重试把同一页交回来两次），不能同一条报两遍。
	const emitted = new Set();
	for (const item of Array.isArray(items) ? items : []) {
		const msg = normalizeMessageItem(item);
		if (!msg) continue;
		if (seen.has(msg.id) || emitted.has(msg.id)) continue;
		if (selfId && msg.senderId === selfId) continue;
		if (watermarkMs && msg.createTimeMs < watermarkMs) continue;
		// 与水位同一毫秒：只有「已经处理过的那批 id」才算旧（飞书/CLI 的时间精度粗，同一毫秒会有多条）。
		if (watermarkMs && msg.createTimeMs === watermarkMs && handledAtWm.has(msg.id)) continue;
		emitted.add(msg.id);
		out.push(msg);
	}
	out.sort((a, b) => a.createTimeMs - b.createTimeMs);
	return out;
}

/** 推进水位（毫秒）：取已有水位与所有消息时间的最大值。 */
export function advanceWatermark(prevMs, items) {
	let next = Number(prevMs) || 0;
	for (const item of Array.isArray(items) ? items : []) {
		const msg = item && typeof item === "object" ? item : {};
		const ms = Number(msg.createTimeMs ?? msg.create_time);
		if (Number.isFinite(ms) && ms > next) next = ms;
	}
	return next;
}

/**
 * 水位归一化：老数据是纯数字（毫秒），新数据是 `{ ms, ids }`（ids = 这个毫秒上已处理过的 message_id）。
 * 老数据升级后 ids 为空，靠 `seen` 再挡一次（最多多报一轮边界，不影响后续）。
 */
export function normalizeWatermark(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const ms = Number(value.ms ?? value.watermarkMs) || 0;
		if (ms <= 0) return { ms: 0, ids: [] };
		const ids = (Array.isArray(value.ids) ? value.ids : []).filter((id) => typeof id === "string" && id);
		return { ms, ids: ids.slice(-WATERMARK_ID_LIMIT) };
	}
	const ms = Number(value) || 0;
	return { ms: ms > 0 ? ms : 0, ids: [] };
}

/** 水位推进后的下一状态：取最大时间，并收集该时间上的全部 id（这些以后都不再算新）。 */
export function nextWatermark(prev, items) {
	const base = normalizeWatermark(prev);
	const list = Array.isArray(items) ? items : [];
	const ms = advanceWatermark(base.ms, list);
	// 时间前进了就丢掉旧 ids（那批已经彻底过去）；仍在同一毫秒则要累加。
	const ids = ms === base.ms && base.ms > 0 ? [...base.ids] : [];
	for (const item of list) {
		const id = text(item?.id) || text(item?.message_id);
		if (!id) continue;
		const t = Number(item?.createTimeMs ?? item?.create_time);
		if (!Number.isFinite(t) || t !== ms) continue;
		ids.push(id);
	}
	return { ms, ids: Array.from(new Set(ids)).slice(-WATERMARK_ID_LIMIT) };
}

/**
 * `im/v1/messages` 查询参数。
 *
 * **必须是 `ByCreateTimeDesc`**：只有降序才是「最近一段时间的消息」。
 * 升序（0.10.20 及以前）在积压时拿到的是水位之后最旧的一页，首批返回的甚至是
 * 会话历史最旧的消息（无 start_time 时），见文件头「取数方向」。
 * `start_time` 用**秒**、向下取整：飞书是闭区间，宁可多带边界那一秒，靠 `seen` 去重。
 */
export function buildMessageQuery(chatId, watermarkMs, pageSize = POLL_PAGE_SIZE, pageToken = "") {
	const query = {
		container_id_type: "chat",
		container_id: chatId,
		sort_type: "ByCreateTimeDesc",
		page_size: clampInt(pageSize, 1, 50, POLL_PAGE_SIZE),
	};
	const sec = Math.floor((Number(watermarkMs) || 0) / 1000);
	if (sec > 0) query.start_time = String(sec);
	const token = text(pageToken);
	if (token) query.page_token = token;
	return query;
}

/** 一页里最旧一条的毫秒时间（用于「已经翻到水位以下就停」）。空页返回 Infinity。 */
export function oldestCreateMs(items) {
	let min = Infinity;
	for (const item of Array.isArray(items) ? items : []) {
		const ms = Number(item?.create_time);
		if (Number.isFinite(ms) && ms > 0 && ms < min) min = ms;
	}
	return min;
}

/**
 * 取数通道的统一返回形状。
 * `truncated` = 翻到页数上限还有更多（积压），由 pollOnce 决定「只报最近这几页并把水位对齐到最新」。
 * 容忍只返回数组的旧实现：适配器升级不该把提醒一下子打哑。
 */
function normalizeFetched(result) {
	if (Array.isArray(result)) return { items: result, truncated: false };
	return {
		items: Array.isArray(result?.items) ? result.items : [],
		truncated: Boolean(result?.truncated),
	};
}

/** 通知文案：单会话带条数折叠；多会话先说「几个会话几条」，再给最新一条的摘要。 */
export function summarizeNewMessages(list) {
	const items = Array.isArray(list) ? list : [];
	if (items.length === 0) return "";
	// 摘要主体取**最新**那条（调用方按时间升序传进来；这里再兜一次底，别依赖外部顺序）。
	const latest = items.reduce(
		(acc, item) => (Number(item?.createTimeMs) >= Number(acc?.createTimeMs) ? item : acc),
		items[0],
	);
	const who = latest.senderName || latest.chatName || latest.chatId || "有人";
	const raw = String(latest.text ?? "");
	const preview = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
	const chats = new Set(items.map((item) => String(item?.chatId ?? "")));
	if (chats.size > 1) return `${chats.size} 个会话 ${items.length} 条新消息 · ${who}：${preview}`;
	const more = items.length > 1 ? `（还有 ${items.length - 1} 条）` : "";
	return `${who}：${preview}${more}`;
}

/**
 * 本轮哪些新消息该**弹通知**（纯函数）。
 *
 * 规则（「同步」与「提醒」的分界线就在这里）：
 *   - `notify = false` → 一条都不弹（同步照跑，缓存照写）；
 *   - 手填 / 手动监听（explicit）→ 弹（用户明确要盯的，群也弹）；
 *   - 群聊 → 只有 `notifyGroups` 打开才弹（默认静默：群消息量比私聊大一个量级）；
 *   - 其余（自动发现的单聊）→ 弹。
 */
export function pickNotifyRecords(records, config, { explicitIds } = {}) {
	const cfg = config || DM_DEFAULT_CONFIG;
	if (!cfg.notify) return [];
	const explicit = explicitIds instanceof Set ? explicitIds : new Set(parseChatIds(explicitIds ?? cfg.chatIds));
	return (Array.isArray(records) ? records : []).filter((record) => {
		const id = text(record?.chatId);
		if (!id) return false;
		if (explicit.has(id)) return true;
		if (text(record?.chatKind) === "group") return Boolean(cfg.notifyGroups);
		return true;
	});
}

/** `/dm/state` 的缺省形状（界面可以先渲染再拿数据）。 */
export function dmStateDefaults() {
	return {
		ok: true,
		config: { ...DM_DEFAULT_CONFIG },
		running: false,
		chats: [],
		lastPollAt: 0,
		nextPollAt: 0,
		lastError: "",
		busy: false,
		pollCount: 0,
		totalNew: 0,
		lastPoll: { at: 0, chats: 0, rows: 0, fresh: 0, truncated: 0, errors: 0, backfill: 0 },
		candidates: { total: 0, p2p: 0, groups: 0, explicit: 0 },
		discovered: { total: 0, p2p: 0, groups: 0, at: 0, error: "" },
		unread: {},
		history: [],
	};
}

/**
 * 轮询引擎。
 *
 * @param {object} deps
 * @param {object} [deps.storage]                    host.storage（get/set）
 * @param {() => {openId?:string}} [deps.snapshot]   取当前个人身份（用于排除自己发的消息）
 * @param {(level:string, text:string, textEn?:string) => void} [deps.notify]
 * @param {(level:string, text:string) => void} [deps.log]
 * @param {() => number} [deps.now]                  可注入时钟（单测）
 * @param {(list: object[]) => void} [deps.onNew]    额外回调（宿主可投给 agent）
 * @param {(info: {chatId:string, rows: object[], identity:string, backfill:boolean}) => void} [deps.onFetched]
 *        每拉到一个会话的消息就回调一次（不管新不新）：宿主用它把**内容**落进本地会话缓存，
 *        界面打开会话时直接读缓存，不必为同一批消息再 spawn 一次 CLI。
 *        `backfill=true` 表示这一页是**不带 `--start` 的最新一页**（宿主可据此认定缓存里有一屏了）。
 * @param {(chatId: string) => boolean|Promise<boolean>} [deps.needsBackfill]
 *        这个会话的本地缓存还缺「一整屏」（缓存不归本模块管，宿主才知道）。
 *        返回 true 时**这一轮改拉最新一页**（不带 `--start`）：
 *        增量只能补新消息，补不进缓存里没有的历史 —— 不补就会出现「轮询一直在跑，
 *        缓存里每个会话却永远只有 1 条」（真实故障：水位比缓存活得久）。
 *        CLI 调用次数不变（这一轮本来就要拉这个会话），只是这一次多带回一屏历史；
 *        通知口径也不变（`pickNewMessages` 仍按水位过滤）。
 * @param {any} [deps.cli]                           lark-cli 通道（唯一取数通道；窄接口）
 */
export function createDmWatcher({
	storage,
	snapshot,
	notify,
	log = () => {},
	now = () => Date.now(),
	onNew,
	onFetched,
	needsBackfill,
	/**
	 * lark-cli 通道（唯一取数通道）。
	 * 接口故意做得很窄：dm-watch 不该知道 CLI 命令怎么拼。
	 *   ready(): Promise<boolean>
	 *   listChats(): Promise<rawChatItem[]>                        // 原始条目，归一化仍在本模块
	 *   fetchMessages(chatId, { startMs, pageSize }): Promise<rawMessageItem[]>
	 */
	cli,
} = {}) {
	/** @type {ReturnType<typeof normalizeDmConfig>} */
	let config = { ...DM_DEFAULT_CONFIG };
	/** chat_id → 水位毫秒 */
	let watermarks = {};
	/** 已报过的 message_id */
	let seen = new Set();
	let history = [];
	let chats = [];
	let discovered = { total: 0, p2p: 0, groups: 0, at: 0, error: "" };
	let running = false;
	let polling = false;
	let timer = null;
	let lastPollAt = 0;
	let nextPollAt = 0;
	let lastError = "";
	let lastPollError = "";
	/** chat_id → 该会话最近一次错误（与 chats 元信息分开存，手填但没被发现的会话也能带上错误） */
	let chatErrors = {};
	/** chat_id → 最近一次**成功**拉取的时间（界面上的「这条会话多久没同步了」）。运行时状态，不落盘。 */
	let chatSyncedAt = {};
	/** chat_id → 未读数（本地累计：轮询到的新消息数，用户打开会话时清零）。 */
	let unread = {};
	/** 上一轮自动发现的错误：同一个错误只记一次日志（否则每 60s 刷一行）。 */
	let lastDiscoverLog = "";
	let pollCount = 0;
	let totalNew = 0;
	/** 上一轮的自述（界面上的「上轮同步了几个会话 / 多少条」）：不落盘，重启后从 0 开始。 */
	let lastPoll = { at: 0, chats: 0, rows: 0, fresh: 0, truncated: 0, errors: 0, backfill: 0 };
	let loaded = false;
	/** 最近一次 CLI 可用性观测（null = 还没检查过）。界面用它解释「为什么没在轮询」。 */
	let cliReadyObserved = null;

	const selfOpenId = () => text(snapshot?.()?.openId);

	function identity() {
		return config.identity === "tenant" ? "tenant" : "user";
	}

	/**
	 * 取数通道：只有 lark-cli 一条（自建 OpenAPI 通道已随凭证链删除）。
	 * 返回 { ok, error, list(), messages() }，与调用方之间只有这一个契约。
	 */
	async function resolveChannel() {
		let ready = false;
		try {
			ready = Boolean(await cli?.ready?.());
		} catch (err) {
			// ready 判定本身失败（例如 CLI 探测超时）也当「不可用」，把原因说清楚。
			ready = false;
			log("warn", `dm-watch: lark-cli 可用性检查失败：${String(err?.message || err)}`);
		}
		cliReadyObserved = ready;
		if (!ready)
			return {
				ok: false,
				error: "lark-cli 不可用（到「设置 → lark-cli」完成安装 / 配置 / 登录）",
			};
		return {
			ok: true,
			error: "",
			list: async () => {
				const items = await cli.listChats({ identity: identity() });
				return Array.isArray(items) ? items : [];
			},
			messages: async (chatId, options = {}) => {
				const result = await cli.fetchMessages(chatId, { ...options, identity: identity() });
				// 通道契约：{ items, truncated }。也容忍只返回数组的旧实现（不让一次升级把提醒打哑）。
				return normalizeFetched(result);
			},
		};
	}

	async function persistConfig() {
		await storage?.set?.(DM_CONFIG_KEY, config);
	}

	async function persistState() {
		await storage?.set?.(DM_STATE_KEY, { watermarks, seen: Array.from(seen).slice(-SEEN_LIMIT), unread });
		await storage?.set?.(DM_HISTORY_KEY, history.slice(-HISTORY_LIMIT));
	}

	async function load() {
		if (loaded) return;
		loaded = true;
		try {
			const rawConfig = await storage?.get?.(DM_CONFIG_KEY);
			if (rawConfig) config = normalizeDmConfig(rawConfig);
			const rawState = await storage?.get?.(DM_STATE_KEY);
			if (rawState && typeof rawState === "object") {
				const wm = rawState.watermarks && typeof rawState.watermarks === "object" ? rawState.watermarks : {};
				for (const [key, value] of Object.entries(wm)) {
					if (!isValidChatId(key)) continue;
					// 老版本存的是纯数字毫秒：归一化成 { ms, ids: [] }（ids 空时由全局 seen 再挡一轮）。
					const normalized = normalizeWatermark(value);
					if (normalized.ms > 0) watermarks[key] = normalized;
				}
				const seenList = Array.isArray(rawState.seen) ? rawState.seen : [];
				seen = new Set(seenList.filter((id) => typeof id === "string" && id).slice(-SEEN_LIMIT));
				const rawUnread = rawState.unread && typeof rawState.unread === "object" ? rawState.unread : {};
				for (const [key, value] of Object.entries(rawUnread)) {
					if (!isValidChatId(key)) continue;
					const n = Math.floor(Number(value)) || 0;
					if (n > 0) unread[key] = Math.min(n, 999);
				}
			}
			const rawHistory = await storage?.get?.(DM_HISTORY_KEY);
			if (Array.isArray(rawHistory))
				history = rawHistory.filter((x) => x && typeof x === "object").slice(-HISTORY_LIMIT);
		} catch (err) {
			log("warn", `dm-watch: 读取本地状态失败：${err?.message || err}`);
		}
	}

	function chatLabel(chatId) {
		const found = chats.find((c) => c.id === chatId);
		return found?.name || (chatId ? `…${chatId.slice(-6)}` : "会话");
	}

	/**
	 * 自动发现会话。**失败不抛出**：手填路径必须仍然可用。
	 * 返回 { chats, diagnostics }，diagnostics 让界面能说清"是没权限还是飞书不给单聊"。
	 */
	async function discover({ persist = true, channel } = {}) {
		const diag = { total: 0, p2p: 0, groups: 0, at: now(), error: "" };
		const ch = channel ?? (await resolveChannel());
		if (!ch.ok) {
			diag.error = ch.error || `通道不可用（${ch.kind}）`;
			discovered = diag;
			return { chats: [], diagnostics: diag };
		}
		try {
			const items = normalizeChatItems(await ch.list());
			diag.total = items.length;
			diag.p2p = items.filter((c) => c.p2p).length;
			diag.groups = diag.total - diag.p2p;
			if (persist) {
				// 只把已发现的会话作为**元信息**合并进来；候选集合仍由配置决定（可预测、可解释）。
				const merged = new Map(chats.map((c) => [c.id, c]));
				for (const chat of items) merged.set(chat.id, { ...merged.get(chat.id), ...chat });
				chats = Array.from(merged.values());
			}
			log("info", `dm-watch: 发现 ${diag.total} 个会话（单聊 ${diag.p2p} / 群 ${diag.groups}）`);
		} catch (err) {
			diag.error = String(err?.message || err);
			if (diag.error !== lastDiscoverLog) {
				lastDiscoverLog = diag.error;
				log("warn", `dm-watch: 自动发现会话失败：${diag.error}`);
			}
		}
		discovered = diag;
		return { chats: chats.filter((c) => c.p2p), diagnostics: diag };
	}

	/**
	 * 候选会话：手填优先 → 自动发现的单聊 → 自动发现的群聊（群聊只在 `syncGroups` 打开时纳入）。
	 * 预算与顺序都在 `buildPollCandidates()` 里（纯函数，单测钉住）。
	 */
	function candidateChats() {
		return buildPollCandidates({
			explicit: parseChatIds(config.chatIds),
			p2p: config.autoDiscover ? chats.filter((c) => c.p2p).map((c) => c.id) : [],
			groups: config.syncGroups ? chats.filter((c) => !c.p2p).map((c) => c.id) : [],
		});
	}

	/**
	 * 跑一轮。`force=true` 时无视 enabled（手动"立即检查"用）。
	 * 返回本轮新增的消息列表（已去重、已推进水位）。
	 */
	async function pollOnce({ force = false } = {}) {
		await load();
		if (!force && !config.enabled) return { skipped: "disabled", messages: [] };
		if (polling) return { skipped: "busy", messages: [] };
		// 先占位再 await：resolveChannel() 里有异步的 CLI 可用性检查，
		// 若等它返回才置 polling，`whenIdle()` 会在这个窗口里误判「已空闲」，两条路径并发拿同一水位。
		polling = true;
		lastPollAt = now();
		const channel = await resolveChannel();
		if (!channel.ok) {
			polling = false;
			lastPollError = channel.error || "通道不可用";
			// 这条分支在 try 之外，必须手动同步 lastError，否则界面看不到"为什么没在轮询"。
			lastError = lastPollError;
			return { skipped: "no-channel", messages: [] };
		}
		const got = [];
		let baselineChanged = false;
		// 本轮自述（/sync/run 与界面都靠它说「上轮真正干了什么」）。
		const round = { chats: 0, rows: 0, truncated: 0, errors: 0, backfill: 0 };
		try {
			// 群聊也要发现：只要有一个「自动」开关打开，就得拉会话列表（否则 chats 里没群，syncGroups 形同虚设）。
			if (config.autoDiscover || config.syncGroups) await discover({ channel });
			const targets = candidateChats();
			if (targets.length === 0) {
				lastPollError = config.syncGroups
					? "没有可轮询的会话（自动发现为空，且未手填 chat_id）"
					: "没有可轮询的会话（自动发现为空，且未手填 chat_id；群消息同步需要打开「群聊」）";
				return { skipped: "no-chats", messages: [] };
			}
			const selfId = selfOpenId();
			for (const target of targets) {
				const chatId = target.id;
				const chatKind = target.kind;
				round.chats += 1;
				try {
					const watermark = normalizeWatermark(watermarks[chatId]);
					const watermarkMs = watermark.ms;
					// 缓存里还没一屏就先整页拉一次（不带 `--start`）：
					// 增量只能补新消息，而水位比缓存活得久 —— 不补屏的话「缓存里永远只有 1 条」，
					// 打开会话只看得到一条。代价是 0 次额外 CLI 调用，只是这一轮多带回一屏历史。
					let backfill = false;
					if (typeof needsBackfill === "function") {
						try {
							backfill = Boolean(await needsBackfill(chatId));
						} catch (err) {
							backfill = false;
							log("warn", `dm-watch: 判定会话 ${chatId} 是否需要补一屏失败：${err?.message || err}`);
						}
					}
					if (backfill) round.backfill += 1;
					const { items: rawItems, truncated } = await channel.messages(chatId, {
						startMs: backfill ? 0 : watermarkMs,
						pageSize: POLL_PAGE_SIZE,
						// 建基线 / 补屏都只要**一页**：它的作用就是把水位推到「现在」+ 给缓存盛一屏。
						// 多翻的页最终会被缓存的条数上限剪掉（60 条），纯属白 spawn + 白落盘。
						// 增量（已有水位）才允许多翻几页，为的是把积压看清。
						maxPages: watermarkMs && !backfill ? MAX_PAGES_PER_CHAT : 1,
					});
					const normalized = rawItems.map(normalizeMessageItem).filter(Boolean);
					round.rows += normalized.length;
					if (truncated) round.truncated += 1;
					// 内容先落本地缓存，再谈「新不新」：本模块只关心提醒，缓存关心的是「这个会话最近说了什么」。
					// 失败只记日志 —— 缓存是加速层，不该拖死提醒轮询。
					if (normalized.length > 0 && typeof onFetched === "function") {
						try {
							await onFetched({ chatId, rows: normalized, identity: identity(), kind: chatKind, backfill });
						} catch (err) {
							log("warn", `dm-watch: 本地消息缓存写入失败（${chatId}）：${err?.message || err}`);
						}
					}
					chatSyncedAt[chatId] = now();
					// 降序取数 ⇒ 本批里最大时间就是该会话当前的真实最新时间。
					const newest = nextWatermark(watermark, normalized);
					const newestMs = newest.ms;
					if (!watermarkMs) {
						// 首次：只建基线，不通知（否则一启用就把历史全弹一遍）。
						// 基线 = 最新一页（降序）⇒ 落在「现在」，不是可笑的「开聊那天」。
						if (newestMs) {
							watermarks[chatId] = newest;
							baselineChanged = true;
						}
						// 基线那一页的 id 也要进 seen：CLI 的 create_time 只到分钟，
						// 同一分钟里后到的消息时间戳与水位相等，靠 seen 区分「已报过的」与「真的新」。
						for (const item of normalized) seen.add(item.id);
						delete chatErrors[chatId];
						log(
							"info",
							`dm-watch: 会话 ${chatId}（${chatKind}）建立基线（水位 ${new Date(newestMs || 0).toISOString()}）`,
						);
						continue;
					}
					const fresh = pickNewMessages(rawItems, { watermark, seen, selfOpenId: selfId });
					for (const msg of fresh) {
						seen.add(msg.id);
						const record = {
							...msg,
							chatName: chatLabel(chatId),
							// 会话种类跟着记录走：通知要不要弹、界面上分不分群/私聊都看它。
							chatKind,
							at: now(),
							...(truncated ? { truncated: true } : {}),
						};
						history.push(record);
						got.push(record);
					}
					if (fresh.length > 0) unread[chatId] = Math.min((unread[chatId] || 0) + fresh.length, 999);
					if (truncated) {
						// 积压超过单轮上限：只报最近这几页，水位直接对齐到最新。
						// 剩下的是历史（用户点开会话就能看到），不能继续当「新消息」往前爬。
						log(
							"warn",
							`dm-watch: 会话 ${chatId} 积压超过 ${MAX_PAGES_PER_CHAT * POLL_PAGE_SIZE} 条，只报最近 ${fresh.length} 条并把水位对齐到最新`,
						);
					}
					// 水位（含该毫秒上已处理的 id）推进：下一轮同一分钟的重复项不会再被当成新消息。
					if (newestMs > watermarkMs || newest.ids.length !== watermark.ids.length) {
						watermarks[chatId] = newest;
						baselineChanged = true;
					}
					delete chatErrors[chatId];
				} catch (err) {
					const message = String(err?.message || err);
					chatErrors[chatId] = message;
					lastPollError = message;
					round.errors += 1;
					log("warn", `dm-watch: 会话 ${chatId}（${chatKind}）轮询失败：${message}`);
				}
			}
			if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
			if (seen.size > SEEN_LIMIT) seen = new Set(Array.from(seen).slice(-SEEN_LIMIT));
			// 跨会话按时间升序：通知摘要取「最新那条」才对得上用户的感知（之前取的是会话遍历顺序里的第一条）。
			got.sort((a, b) => a.createTimeMs - b.createTimeMs);
			pollCount += 1;
			lastPoll = { at: lastPollAt, ...round, fresh: got.length };
			// 全局错误只反映「本轮有会话失败」；单个会话的细节在 chatErrors 里，界面按行展示。
			lastPollError = round.errors > 0 ? lastPollError || `${round.errors} 个会话同步失败` : "";
			if (got.length > 0) totalNew += got.length;
			if (baselineChanged || got.length > 0) await persistState();
			if (got.length > 0) {
				// 分成「要弹」与「只落缓存」两份：群消息默认只同步、不打断人。
				const notifyList = pickNotifyRecords(got, config, { explicitIds: parseChatIds(config.chatIds) });
				const summary = summarizeNewMessages(notifyList);
				if (summary) {
					// 积压被截断时如实说一声：宁可让人知道“更早的没计”，也别给个看起来精确的假数字。
					const gap = notifyList.some((item) => item.truncated) ? "（更早的积压未计入）" : "";
					const silent = got.length - notifyList.length;
					const rest = silent > 0 ? `（另有 ${silent} 条已同步未提醒）` : "";
					notify?.(
						"info",
						`飞书：${summary}${gap}${rest}`,
						`Feishu: ${summary}${gap ? " (older backlog skipped)" : ""}${
							silent > 0 ? ` (${silent} more synced silently)` : ""
						}`,
					);
				}
				try {
					onNew?.(got);
				} catch (err) {
					log("warn", `dm-watch: onNew 回调异常：${err?.message || err}`);
				}
			}
			return { messages: got, chats: round.chats, rows: round.rows };
		} finally {
			polling = false;
			lastError = lastPollError;
		}
	}

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		nextPollAt = 0;
	}

	function schedule(delaySec) {
		clearTimer();
		if (!running) return;
		const sec = clampInt(delaySec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, config.intervalSec);
		nextPollAt = now() + sec * 1000;
		timer = setTimeout(() => {
			timer = null;
			void tick();
		}, sec * 1000);
		// 宿主的 server 生命周期不该被这个定时器吊住（进程退出时让它自然结束）。
		timer?.unref?.();
	}

	async function tick() {
		if (!running) return;
		try {
			await pollOnce();
		} catch (err) {
			lastError = String(err?.message || err);
			log("warn", `dm-watch: 轮询异常：${lastError}`);
		} finally {
			if (running) schedule(config.intervalSec);
		}
	}

	async function start() {
		await load();
		clearTimer();
		running = Boolean(config.enabled);
		if (!running) return status();
		// 启动即来一轮（首轮多半在建基线，不会刷屏）。
		void tick();
		return status();
	}

	function stop() {
		running = false;
		clearTimer();
	}

	/** 更新配置：立即按新配置重启（间隔/开关/会话都可能变）。 */
	async function updateConfig(patch) {
		await load();
		config = normalizeDmConfig(patch ?? {}, config);
		await persistConfig();
		clearTimer();
		running = Boolean(config.enabled);
		if (running) void tick();
		return status();
	}

	/** 打开某个会话时清零它的未读数（前端打开会话即视为已读）。 */
	function markRead(chatId) {
		const id = String(chatId ?? "").trim();
		if (isValidChatId(id) && unread[id]) {
			delete unread[id];
			void persistState();
		}
		return status();
	}

	function status() {
		// 列表口径 = **真的在轮询的候选**（手填 → 单聊 → 群聊），不是「发现了却没拉」的一大堆：
		// 界面上这一列是「同步状态表」，混进不拉的会话只会让「多久没同步」变成假信息。
		const explicit = parseChatIds(config.chatIds);
		const candidates = candidateChats();
		const listed = candidates.map((target) => {
			const meta = chats.find((c) => c.id === target.id) || null;
			return {
				id: target.id,
				name: meta?.name || "",
				mode: meta?.mode || "unknown",
				type: meta?.type || "",
				p2p: target.kind === "p2p",
				kind: target.kind,
				explicit: target.explicit,
				// 提醒开关跟着「会话种类 + 手填」走（与 pickNotifyRecords 同口径）。
				notify: Boolean(config.notify) && (target.explicit || target.kind !== "group" || config.notifyGroups),
				watermarkMs: normalizeWatermark(watermarks[target.id]).ms,
				unread: Number(unread[target.id]) || 0,
				syncedAt: Number(chatSyncedAt[target.id]) || 0,
				lastError: chatErrors[target.id] || "",
			};
		});
		const count = (kind) => candidates.filter((c) => c.kind === kind).length;
		return {
			ok: true,
			config: { ...config },
			// 取数通道：只有 lark-cli（`ready` 用于解释「为什么没在轮询」）。
			channel: { cli: Boolean(cli), ready: cliReadyObserved },
			identity: identity(),
			authorized: Boolean(snapshot?.()?.authorized),
			running,
			busy: polling,
			chats: listed,
			// 候选自述（按种类分开）：界面据此说「在同步 26 个私聊 / 3 个群」。
			candidates: {
				total: candidates.length,
				p2p: count("p2p"),
				groups: count("group"),
				explicit: candidates.filter((c) => c.explicit).length,
				budget: { chats: MAX_CHATS_PER_POLL, groups: MAX_GROUPS_PER_POLL },
			},
			lastPollAt,
			nextPollAt,
			lastPoll: { ...lastPoll },
			lastError,
			pollCount,
			totalNew,
			discovered: { ...discovered },
			unread: { ...unread },
			history: history.slice(-HISTORY_LIMIT).reverse(),
		};
	}

	return {
		load,
		start,
		stop,
		status,
		updateConfig,
		markRead,
		pollOnce,
		discover,
		/** 等当前这一轮跑完（手动「立即检查」与定时轮询共用一条路径，避免并发拿同一水位）。 */
		whenIdle: async () => {
			while (polling) await new Promise((resolve) => setTimeout(resolve, 5));
		},
		/** 单测/调试用：直接读当前配置与水位。 */
		inspect: () => ({
			config: { ...config },
			// 调试视图保持「chat_id → 毫秒」的形状（老用例与人工排查都按这个口径看）
			watermarks: Object.fromEntries(
				Object.entries(watermarks).map(([key, value]) => [key, normalizeWatermark(value).ms]),
			),
			watermarkIds: Object.fromEntries(
				Object.entries(watermarks).map(([key, value]) => [key, normalizeWatermark(value).ids]),
			),
			seen: Array.from(seen),
			chats: [...chats],
		}),
	};
}
