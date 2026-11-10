/**
 * plugins/feishu-pro/lib/chats.mjs
 * 「会话列表」的**纯函数层**：归一化（会话条目 / 消息行）、分类、合并、私聊/群反推。
 *
 * 分工（0.10.27 起很清晰）：
 *   - 取数在 `lib/cli-chats.mjs`（`lark-cli im +chat-list` / `im +chat-messages-list`）；
 *   - 后台轮询在 `lib/dm-watch.mjs`；
 *   - 本模块只做"把飞书/CLI 的返回解释成前端要的形状"，不发请求、不读写存储，因此全部可单测。
 *
 * 三个必须如实交代的现实约束（都在界面/diagnostics 里体现）：
 *   1. 单聊会话的 `name` 常年为空（飞书不给对方姓名），所以用**最近一条非自己发的消息**
 *      的发送人兜底命名（拿不到就退化成 `oc_` 尾巴）；
 *   2. 单聊能不能被列出来取决于飞书给不给，列表页因此同时显示「单聊 N / 群 M」，为 0 时提示手填 chat_id；
 *   3. 读历史消息要有 `im:message:readonly`（CLI 的 scope），没有就明确报错，不装作"这个会话没消息"。
 */

/** 身份口径常量（原 lib/openapi.mjs 已随凭证链下线一起删除，这里内联）。 */
export const IDENTITY_TENANT = "tenant";
export const IDENTITY_USER = "user";
// 缓存穿透：与 index.mjs 的 `?v=` **必须同值**（否则 Node 会把 dm-watch 当成另一份缓存副本，
// 出现 "does not provide an export named ..." 这种加载期崩溃）。改这里也要 bump manifest.version，
// `tests/unit/feishu-pro-core.test.ts` 扫全插件钉住一致性。
import {
	applyMentions,
	isValidChatId,
	messagePreview,
	normalizeChatItem,
	normalizeMessageItem,
} from "./dm-watch.mjs?v=0.14.1";

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** 会话展示名：飞书没给 name 时退化成"单聊/群聊 · id 尾巴"，绝不显示空白行。 */
export function chatLabel(chat) {
	const name = text(chat?.name);
	if (name) return name;
	const id = text(chat?.id);
	const tail = id ? ` · ${id.slice(-6)}` : "";
	return `${chat?.p2p ? "单聊" : "群聊"}${tail}`;
}

/** 会话条目：在 dm-watch 的归一化基础上补列表页要用的展示字段。 */
export function normalizeChatEntry(item) {
	const base = normalizeChatItem(item);
	if (!base) return null;
	return {
		id: base.id,
		name: base.name,
		label: chatLabel(base),
		mode: base.mode,
		type: base.type,
		p2p: base.p2p,
		desc: base.desc,
		avatar: text(item?.avatar) || "",
		ownerId: text(item?.owner_id) || "",
		memberCount: Number(item?.user_count ?? item?.member_count ?? 0) || 0,
		external: Boolean(item?.external),
	};
}

/** 会话列表归一化 + 去重（同 id 只留第一条，保留顺序）。 */
export function normalizeChatEntries(items) {
	const out = [];
	const seen = new Set();
	for (const item of Array.isArray(items) ? items : []) {
		const entry = normalizeChatEntry(item);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
	}
	return out;
}

/** 列表头部的计数（界面用来解释"为什么只有群没有单聊"）。 */
export function chatCounts(chats) {
	const list = Array.isArray(chats) ? chats : [];
	const p2p = list.filter((c) => c.p2p).length;
	return { total: list.length, p2p, groups: list.length - p2p };
}

/**
 * 已归一化的消息行 → 界面行：补 `self`（自己发的）、展示名与预览。
 *
 * 单独抽出来是因为本地缓存（`lib/chat-cache.mjs`）里存的就是**已归一化**的行：
 * 读缓存时不能把它们再喂一次 `normalizeMessageItem`（那份会重新解析 raw 形状），
 * 但 `self` / 姓名 / 预览又必须按**当前**登录身份与最新的姓名缓存重算 —— 两处共用这一个函数。
 */
export function decorateMessageRow(row, { selfOpenId = "", names = {} } = {}) {
	if (!row || typeof row !== "object") return null;
	const senderId = text(row.senderId);
	const self = Boolean(selfOpenId) && Boolean(senderId) && senderId === selfOpenId;
	const given = text(names[senderId]);
	const senderName = text(row.senderName);
	const msgType = text(row.msgType) || "unknown";
	const senderType = text(row.senderType);
	// 没有名字时的兜底：系统消息没有 sender、机器人没有 open_id，都不能退化成"未知"。
	const fallback =
		msgType === "system" ? "系统" : senderType === "app" ? "机器人" : senderId ? `…${senderId.slice(-6)}` : "未知";
	const body = text(row.text);
	return {
		...row,
		id: text(row.id),
		chatId: text(row.chatId),
		senderId,
		senderType,
		senderName,
		msgType,
		text: body,
		createTimeMs: Number(row.createTimeMs) || 0,
		self,
		senderLabel: self ? "我" : given || senderName || fallback,
		preview: body,
	};
}

/** 消息条目（CLI / 飞书 raw 形状）→ 界面行：归一化 + 装饰，一次做完。 */
export function normalizeMessageRow(item, { selfOpenId = "", names = {} } = {}) {
	const base = normalizeMessageItem(item);
	if (!base) return null;
	return decorateMessageRow(base, { selfOpenId, names });
}

/** 从消息里推断单聊的对方：最近一条**不是自己发的**消息的发送人。 */
export function pickPeerFromMessages(rows, selfOpenId = "") {
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row?.senderId) continue;
		if (selfOpenId && row.senderId === selfOpenId) continue;
		return row.senderId;
	}
	return "";
}

/** 需要补名字的 open_id（去重、非自己、有上限）。 */
export function collectSenders(rows, { selfOpenId = "", limit = 20 } = {}) {
	const cap = Math.max(0, Math.floor(Number(limit) || 0));
	if (cap === 0) return [];
	const out = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		const id = text(row?.senderId);
		if (!id || id === selfOpenId) continue;
		if (out.includes(id)) continue;
		out.push(id);
		if (out.length >= cap) break;
	}
	return out;
}

/** 在飞书客户端里打开该会话（列表页"打开飞书"按钮）。 */
export function chatLink(chatId) {
	const id = text(chatId);
	if (!isValidChatId(id)) return "";
	return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(id)}`;
}

/** 正文解析的再导出（客户端/测试复用同一口径：预览 + @ 提及还原）。 */
export { applyMentions, messagePreview };

/* --------------------------------- 发消息 --------------------------------- */
//
// 发送本身在 `lib/cli-chats.mjs`（`lark-cli im +messages-send --as user|bot`），失败不回落。
// 这里只剩两个纯函数：输入框上限与"发送身份"归一化。
//   1. **我**（identity=user）：以你本人名义发，需要 `im:message` + `im:message.send_as_user`；
//   2. **机器人**（identity=tenant）：需要机器人已在会话里，需 `im:message:send_as_bot`。
// 两种身份的错误码可能同码不同义，所以身份是显式参数，由调用方一路传下去。

/** 输入框软上限：飞书单条 text 上限远大于此，超过它读起来已经不是"消息"了。 */
export const MESSAGE_TEXT_LIMIT = 4000;

/** 发送身份归一化：只认 user / tenant，其它值一律走调用方给的默认值。 */
export function normalizeSendIdentity(value, fallback = IDENTITY_TENANT) {
	if (value === IDENTITY_USER) return IDENTITY_USER;
	if (value === IDENTITY_TENANT) return IDENTITY_TENANT;
	return fallback === IDENTITY_USER ? IDENTITY_USER : IDENTITY_TENANT;
}

/** open_id 形状校验（ou_ 开头）。和 `isValidChatId` 一样只做“显然是错”的拦截。 */
export function isValidOpenId(value) {
	const id = String(value ?? "").trim();
	return /^ou_[A-Za-z0-9_-]{4,}$/.test(id) && !/\s/.test(id);
}

/* ---------------------------- 会话来源合并与分类 ---------------------------- */
//
// `im/v1/chats` 只返回群，所以"个人"这一栏要靠**手填 chat_id / 监听名单**补齐；
// 补进来的 id 到底是单聊还是群，来自 `chats_info` 缓存（打开过 / 发现过 / 推断出来就记一笔）。
// 排序不再自己做：`lark-cli im +chat-list` 已按 active_time 排好
// （旧的"逐会话拉 1 条消息预热最后时间"那套 0.10.27 已删除）。

/** 手填会话的元信息缓存（chat_id → { name, p2p, mode, memberCount, fetchedAt }）。 */
export const CHAT_INFO_KEY = "chats_info";
const CHAT_ID_OK = (value) => isValidChatId(value);
const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 按 id 归并两组来源（发现的群 + 手填的单聊），后者的信息优先补齐。 */
export function mergeChatSources(discovered, manual = [], prevInfo = {}) {
	const byId = new Map();
	for (const chat of Array.isArray(discovered) ? discovered : []) {
		if (!chat?.id) continue;
		byId.set(chat.id, { ...chat });
	}
	for (const id of Array.isArray(manual) ? manual : []) {
		if (!CHAT_ID_OK(id)) continue;
		const known = prevInfo?.[id] || {};
		const existing = byId.get(id) || {
			id,
			name: "",
			label: chatLabel({ id, p2p: known.p2p }),
			p2p: false,
			mode: "unknown",
			desc: "",
		};
		byId.set(id, {
			...existing,
			// 手填会话的"身份"来自 chats_info 缓存，可能还不知道（p2p 为 null = 未识别）
			...known,
			id,
			manual: true,
			label: chatLabel({
				id,
				name: known.name ?? existing.name,
				p2p: known.p2p ?? existing.p2p,
			}),
		});
	}
	return Array.from(byId.values());
}

/** 分栏计数（私聊 / 群 / 未识别），界面据此禁用空栏。 */
export function chatSections(chats) {
	const list = Array.isArray(chats) ? chats : [];
	const p2p = list.filter((c) => c.p2p === true).length;
	const groups = list.filter((c) => c.p2p === false && c.mode !== "unknown").length;
	return { total: list.length, p2p, groups, unknown: list.length - p2p - groups };
}

/* ----------------------------- 自动发现私聊 ----------------------------- */
//
// 结论先说：**飞书没有「我的会话列表」这种能列出个人私聊的接口**（实测 `im/v1/chats`
// 用个人身份也只回群）。所以"自动发现私聊"只能靠**可观测的证据**，本模块把能拿到的都收拢：
//
//   1. 个人身份的完整分页遍历（万一某页里有 p2p 就抓到，不再只看第一页）；
//   2. **应用身份（机器人）的会话列表** —— 这是唯一会返回 p2p 的列表接口：
//      同事与机器人私聊过，那个 p2p 会话就在这里；
//   3. 任何**已经打开过/读过/监听中**的会话，由上层写进 `chats_info` 缓存（打开一次即永久记住）。
//
// 三路合并后，私聊栏里会自己长出条目；仍然拿不到"你和同事之间"的私聊是产品边界，不是没做。

/** 把若干条会话元信息并入缓存（不覆盖已经知道的名字，除非新名字非空）。 */
export function mergeChatInfo(cache = {}, entries = [], now = Date.now()) {
	const out = { ...(cache && typeof cache === "object" ? cache : {}) };
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry?.id) continue;
		// 归一化只补缺省字段（mode/type/p2p），entry 自带的推断结果与时间原样保留 ——
		// 历史上这里调用过一个从未存在的 `chatInfoFromEntry`，于是任何调用都抛
		// ReferenceError（「发完消息却报错」的真凶），现在改走已有的 normalizeChatEntry。
		const base = normalizeChatEntry(entry) ?? entry;
		if (!base?.id || !CHAT_ID_OK(base.id)) continue;
		const prev = out[base.id] || {};
		// 只补缺省字段：entry 自带的推断结果（inferred/inferReason）与时间原样保留，
		// 也不要写入 undefined（缓存里的脏键会被当成「已知字段」盖掉真值）。
		const patch = { mode: base.mode, p2p: base.p2p };
		if (base.type) patch.type = base.type;
		out[base.id] = {
			...prev,
			...entry,
			...patch,
			name: String(entry.name || base.name || prev.name || ""),
			fetchedAt: num(entry.fetchedAt) || now,
		};
	}
	return out;
}

/* ------------------------- 从消息反推「私聊 or 群」 ------------------------- */
//
// 权威来源始终是 `GET /im/v1/chats/:chat_id` 的 `chat_mode`。但那个接口要**先有 id**，
// 且机器人不在会话里时查不到。所以从消息反推是**兜底**（把「未识别」变成可用标签），
// 不是发现手段 —— `im/v1/messages` 必须给 chat_id，反解不出你不知道的会话。
//
// 只认**有强区分度**的线索，宁可不判也不乱判：
//   - 系统消息里的"邀请/加入群聊"模板 → 群（单聊不会有入群系统消息）
//   - 除自己以外出现 ≥2 个发送人 → 群
//   - `mentions` 里出现"既不是我也不是唯一对方"的人 → 群（群内 @ 第三人）
//   - 只有 1 个对方、且有 ≥3 条消息、无上面任何反向证据 → 私聊（中等置信）
// 反例：只有 2 人的群会被判成私聊 —— 所以结果带 `inferred: true`，界面据此标注"推断"。

/** 系统消息里出现这些词，基本可以断定是群（入群/邀请/群公告）。 */
const GROUP_SYSTEM_HINTS = /invited|joined|invite|group|群|邀请|加入|成员|chatter/i;

const isSelf = (id, selfOpenId) => Boolean(selfOpenId) && id === selfOpenId;

/**
 * @param {Array<object>} rows 归一化后的消息（`normalizeMessageRow` 的产物）
 * @param {{ selfOpenId?: string }} [options]
 * @returns {{ mode: "p2p"|"group"|"unknown", reason: string, others: string[] }}
 */
export function inferChatMode(rows, { selfOpenId = "" } = {}) {
	const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
	if (list.length === 0) return { mode: "unknown", reason: "没有消息可参考", others: [] };

	// 1. 系统消息：入群/邀请模板 —— 最强信号。
	for (const row of list) {
		if (row.msgType !== "system") continue;
		const blob = `${row.systemTemplate || ""} ${row.preview || row.text || ""}`;
		if (GROUP_SYSTEM_HINTS.test(blob)) {
			return { mode: "group", reason: "系统消息含入群/邀请特征", others: [] };
		}
	}

	// 2. 发送人：除自己外有几个不同的人。
	const others = [];
	for (const row of list) {
		const id = String(row.senderId || "");
		if (!id || isSelf(id, selfOpenId)) continue;
		if (!others.includes(id)) others.push(id);
	}
	if (others.length >= 2) return { mode: "group", reason: `${others.length} 个不同发送人`, others };

	// 3. @ 提及里的第三方。
	const mentioned = [];
	for (const row of list) {
		for (const mention of Array.isArray(row.mentions) ? row.mentions : []) {
			const id = String(mention?.id || "");
			if (!id || isSelf(id, selfOpenId)) continue;
			if (others.length === 1 && id === others[0]) continue; // @ 对方本人：单聊里也成立
			if (!mentioned.includes(id)) mentioned.push(id);
		}
	}
	if (mentioned.length > 0) {
		return { mode: "group", reason: `@ 提及了会话外的人（${mentioned.length}）`, others };
	}

	// 4. 只剩一个对方、消息够多 → 私聊（中等置信；2 人群会被误判，故标 inferred）。
	if (others.length === 1 && list.length >= 3) {
		return { mode: "p2p", reason: "只有 1 个对方且无群特征", others };
	}

	return { mode: "unknown", reason: "证据不足", others };
}

/* ------------------------------ 私聊 id 的来历 ------------------------------ */
//
// 飞书**没有** `/p2p_chats` 这类接口（探过，404），`im/v1/chats` 的文档也明写不含单聊。
// 所以私聊 chat_id 现在只从一处拿：`lark-cli contact +search-user --user-ids` 的 `p2p_chat_id`
// （`lib/cli-chats.mjs` 的 `resolveP2pChatId`，0 副作用、不发消息）。
// 历史的 A/B/C 兜底（发给 open_id 拿 chat_id / 发一条秒撤回 / 消息搜索多形状探针）
// 连同 `buildOpenIdSendPayload()` / `findFirstChatNode()` 已在 0.10.27 删除。
