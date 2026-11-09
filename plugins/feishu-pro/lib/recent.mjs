/**
 * plugins/feishu-pro/lib/recent.mjs
 * 「最近访问」本地记录 —— 飞书 OpenAPI **不提供**这个列表，只能自己记。
 *
 * 为什么不靠飞书（2026-11 实测，逐条排除）：
 *   - `drive/v1/files` 只返回 `created_time` / `modified_time`，**没有访问时间**；
 *   - `order_by` 只认 `EditedTime` / `CreatedTime`，`OpenedTime`/`LastOpenTime`/`ViewTime`
 *     全部 99992402（字段校验失败）；
 *   - `drive/v1/files/:token/view_records` 返回的是**该文件的访问明细**（且多为空），
 *     不是"我最近看过什么"；`statistics` 只有 pv/uv/点赞数，没有时间；
 *   - 没有任何 `/recent` 类端点。
 *
 * 所以：插件在读正文、点「在飞书中打开」时记一条，存在插件自己的 storage 里。
 * 记的是**本机这份 pi-web-ui 上的访问**（不是你在飞书客户端里看过什么），这一点会如实写在 UI 上。
 */

/** 条目上限：再多也没人翻，且要控制 storage 体积。 */
export const RECENT_LIMIT = 200;

/** 同一条目的去重键：token 优先，其次 url（同一个文档可能以 wiki/obj 两种形式出现）。 */
export function recentKey(entry = {}) {
	const token = String(entry.token ?? "").trim();
	if (token) return `t:${token}`;
	const nodeToken = String(entry.nodeToken ?? "").trim();
	if (nodeToken) return `n:${nodeToken}`;
	return `u:${String(entry.url ?? "").trim()}`;
}

/**
 * 写入一条访问记录：同键去重 + 移到最前 + 截断。
 * 保留已有的 createdAt/modifiedAt（新传入的非零值覆盖），并刷新 accessedAt。
 */
export function upsertRecent(list, entry, { limit = RECENT_LIMIT, now = Date.now() } = {}) {
	const items = Array.isArray(list) ? list : [];
	const key = recentKey(entry);
	if (!key || key === "u:") return items;
	const prev = items.find((item) => recentKey(item) === key);
	const merged = {
		...prev,
		...entry,
		// 时间字段：新值优先，但别用 0/空把原有值抹掉
		createdAt: Number(entry.createdAt) || Number(prev?.createdAt) || 0,
		modifiedAt: Number(entry.modifiedAt) || Number(prev?.modifiedAt) || 0,
		accessedAt: Number(now) || Date.now(),
		accessCount: (Number(prev?.accessCount) || 0) + 1,
	};
	const rest = items.filter((item) => recentKey(item) !== key);
	return [merged, ...rest].slice(0, Math.max(1, Number(limit) || RECENT_LIMIT));
}

/** 按访问时间倒序（storage 里可能被手改成乱序，读的时候统一排一遍）。 */
export function sortRecent(list) {
	return [...(Array.isArray(list) ? list : [])].sort(
		(a, b) => (Number(b?.accessedAt) || 0) - (Number(a?.accessedAt) || 0),
	);
}

/** 读列表：排序 + 截断 + 丢掉没有 token/url 的脏数据。 */
export function readRecent(list, { limit = 50 } = {}) {
	return sortRecent(list)
		.filter((item) => item && (String(item.token ?? "").trim() || String(item.url ?? "").trim()))
		.slice(0, Math.max(1, Number(limit) || 50));
}

/** 从候选项里挑出"能记"的最小字段集（避免把整个列表对象塞进 storage）。 */
export function recentEntryFrom(doc = {}, { now = Date.now(), source = "" } = {}) {
	const token = String(doc.token ?? doc.nodeToken ?? "").trim();
	const url = String(doc.url ?? "").trim();
	if (!token && !url) return null;
	return {
		token,
		nodeToken: String(doc.nodeToken ?? ""),
		title: String(doc.title ?? "").trim() || "（无标题）",
		type: String(doc.type ?? "docx").toLowerCase(),
		typeLabel: String(doc.typeLabel ?? ""),
		url,
		source,
		ownerId: String(doc.ownerId ?? ""),
		createdAt: Number(doc.createdAt) || 0,
		modifiedAt: Number(doc.modifiedAt) || 0,
		accessedAt: Number(now) || Date.now(),
		accessCount: 1,
	};
}

/* ------------------------------------------------------------------ *
 * 按身份分桶：同一台 pi-web-ui 可能多人共用，记录必须跟着"人"走
 * ------------------------------------------------------------------ *
 *
 * v1 的坑：记录存在插件级 storage 里，整个实例一份 —— A 和 B 登录各自的飞书
 * 账号时会看到对方的访问历史，UI 上还写着"这台机器"。这里改成以飞书 open_id
 * 为桶键：谁登录就是谁的记录，互不可见。
 *
 * 没登录（应用身份）时落在 `__anon__` 桶：我们不知道你是谁，不能猜；
 * 登录后不会自动把匿名桶并进你的身份（共用机器上那等于抄别人的历史）。
 */

/** 存储结构版本。 */
export const RECENT_STORE_VERSION = 2;

/** 未登录时的桶键。 */
export const ANON_OWNER = "__anon__";

/** 身份 → 桶键：空 open_id 一律进匿名桶。 */
export function ownerKeyFrom(openId) {
	const id = String(openId ?? "").trim();
	return id || ANON_OWNER;
}

/** 空存储。 */
export function emptyRecentStore() {
	return { version: RECENT_STORE_VERSION, owners: {} };
}

/**
 * 归一化存储，并迁移 v1 的扁平数组 / 缺字段的历史数据。
 * @param {unknown} raw storage 里读出来的原始值
 * @param {{ legacyOwner?: string }} [opts] 迁移旧数据时归给谁（一般是当前身份）
 */
export function normalizeRecentStore(raw, { legacyOwner = ANON_OWNER } = {}) {
	// v1：整个值就是条目数组
	if (Array.isArray(raw)) {
		const items = raw.filter((x) => x && typeof x === "object");
		return items.length ? writeRecentStore(emptyRecentStore(), legacyOwner, items) : emptyRecentStore();
	}
	if (!raw || typeof raw !== "object") return emptyRecentStore();
	const owners = {};
	const src = /** @type {Record<string, unknown>} */ (raw).owners;
	if (src && typeof src === "object") {
		for (const [key, value] of Object.entries(src)) {
			const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
			const clean = items.filter((x) => x && typeof x === "object");
			if (clean.length) owners[key] = { updatedAt: Number(value?.updatedAt) || 0, items: clean };
		}
	}
	return { version: RECENT_STORE_VERSION, owners };
}

/**
 * 取某个身份的条目（不排序，排序交给 readRecent）。
 * @param {any} store
 * @param {string} owner
 * @returns {any[]}
 */
export function readStoreItems(store, owner) {
	return Array.isArray(store?.owners?.[owner]?.items) ? store.owners[owner].items : [];
}

/** 写某个身份的条目，返回**新** store（不改原对象，便于 diff 与测试）。 */
export function writeRecentStore(store, owner, items, { now = Date.now() } = {}) {
	const key = String(owner ?? "").trim() || ANON_OWNER;
	return {
		version: RECENT_STORE_VERSION,
		owners: {
			...store?.owners,
			[key]: { updatedAt: Number(now) || Date.now(), items: Array.isArray(items) ? items : [] },
		},
	};
}

/** 清空某个身份（其余人的记录保持不动）。 */
export function clearRecentStore(store, owner, { now = Date.now() } = {}) {
	return writeRecentStore(store, owner, [], { now });
}

/**
 * 该身份是否有记录（用于 UI 区分"没东西"和"不属于你"）。
 * @param {any} store
 * @param {string} owner
 */
export function hasOwnerRecords(store, owner) {
	return readStoreItems(store, owner).length > 0;
}

/**
 * 只列出桶键（不含内容）—— 诊断用，绝不外泄别人的文档标题。
 * @param {any} store
 * @returns {string[]}
 */
export function listOwnerKeys(store) {
	return Object.keys(store?.owners ?? {});
}
