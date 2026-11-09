/**
 * plugins/feishu-pro/lib/cli-contacts.mjs
 * 通讯录域 → lark-cli 适配层：搜人 / 批量取人 / 部门 / 部门成员。
 *
 * 归一化目标与旧的 `lib/contacts.mjs` 完全一致（前端 renderContacts 零改动），
 * 但 CLI 的字段口径不同（`localized_name` / `enterprise_email` / `department` 路径字符串），
 * 所以单独写 `normalizeCliUser`，不改旧函数（旧通道还要用）。
 */

/** 部门列表/成员列表没有快捷命令 → 用 `api` 打原生端点（CLI 的 2500 API 逃生舱）。 */
const DEPT_PATH = "/open-apis/contact/v3/departments";
const DEPT_USERS_PATH = "/open-apis/contact/v3/users/find_by_department";

/** CLI 用户对象 → 插件用户对象（与 normalizeUser 同形状 + 两个 CLI 独有字段）。 */
export function normalizeCliUser(raw = {}) {
	const name = String(raw.localized_name ?? raw.name ?? raw.en_name ?? raw.open_id ?? "");
	return {
		openId: String(raw.open_id ?? raw.openId ?? ""),
		userId: String(raw.user_id ?? ""),
		unionId: String(raw.union_id ?? ""),
		name,
		enName: String(raw.en_name ?? ""),
		avatar: String(raw.avatar_url ?? ""),
		departmentIds: Array.isArray(raw.department_ids) ? raw.department_ids.map(String) : [],
		/** CLI 独有：部门路径字符串（服务端用 `-` 拼层级，不保证层数）。 */
		department: String(raw.department ?? ""),
		email: String(raw.enterprise_email ?? raw.email ?? ""),
		mobile: String(raw.mobile ?? ""),
		jobTitle: String(raw.job_title ?? ""),
		city: String(raw.city ?? ""),
		description: String(raw.signature ?? raw.description ?? ""),
		frozen: raw.is_activated === false || raw.is_resigned === true,
		/** CLI 独有：与当前用户的 P2P 会话 id（空 = 从未私聊过），可直接喂给 IM 命令。 */
		p2pChatId: String(raw.p2p_chat_id ?? ""),
		external: Boolean(raw.is_cross_tenant),
		hasChatted: Boolean(raw.has_chatted ?? raw.p2p_chat_id),
	};
}

/** `contact +search-user` 的 data → items（`--queries` 模式是扁平 users[]）。 */
export function pickUsers(data) {
	if (!data || typeof data !== "object") return [];
	for (const key of ["users", "items", "user_list"]) {
		if (Array.isArray(data[key])) return data[key];
	}
	return [];
}

/**
 * 搜同事（**必须个人身份**，CLI 快捷命令本身是 user-only）。
 * 空关键词时降级为「我聊过的人」枚举（--has-chatted），比返回空列表有用。
 */
export async function searchUsers(run, { query, limit = 20, as = "user", hasChatted } = {}) {
	const keyword = String(query ?? "").trim();
	const size = Math.min(Math.max(Number(limit) || 20, 1), 30);
	const args = ["contact", "+search-user", "--as", as, "--page-size", String(size)];
	if (keyword) args.push("--query", keyword);
	// 空关键词时什么 filter 都不给会得到空列表 —— 默认收窄成「我聊过的人」，用户能立刻看到东西。
	else if (hasChatted !== false) args.push("--has-chatted");
	const out = await run(args, { timeoutMs: 30_000 });
	const data = out?.data ?? out?.payload?.data ?? {};
	const items = pickUsers(data).map(normalizeCliUser);
	return {
		items: items.slice(0, size),
		hasMore: Boolean(data.has_more ?? out?.meta?.has_more),
		identity: "user",
		degraded: false,
		...(keyword ? {} : { note: "未输入关键词：显示的是最近私聊过的同事（--has-chatted），输入姓名/邮箱可全企业搜" }),
	};
}

/** 批量取人（open_id 列表，≤100）。用于消息发送者姓名补全、@提及详情。 */
export async function getUsersByIds(run, { ids = [], as = "user" } = {}) {
	const list = (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 100);
	if (!list.length) return { items: [], names: {}, error: "" };
	const out = await run(["contact", "+search-user", "--as", as, "--user-ids", list.join(",")], { timeoutMs: 30_000 });
	const items = pickUsers(out?.data).map(normalizeCliUser);
	const names = {};
	for (const user of items) if (user.openId && user.name) names[user.openId] = user.name;
	return { items, names, error: "" };
}

/** 单个同事详情（CLI `+get-user`，bot/user 都能用）。 */
export async function getUser(run, { openId, as = "user" } = {}) {
	const id = String(openId ?? "").trim();
	if (!id) throw new Error("缺少 id（open_id）");
	const out = await run(["contact", "+get-user", "--as", as, "--user-id", id, "--user-id-type", "open_id"], {
		timeoutMs: 20_000,
	});
	const data = out?.data ?? {};
	const raw = data.user ?? data ?? {};
	return { item: normalizeCliUser(raw) };
}

/** 部门树（父部门 id，`0` = 根）。 */
export async function listDepartments(run, { parentId = "0", pageSize = 50, as = "user" } = {}) {
	const params = {
		parent_department_id: String(parentId || "0"),
		page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 50),
		department_id_type: "open_department_id",
		user_id_type: "open_id",
	};
	const out = await run(["api", "GET", DEPT_PATH, "--params", JSON.stringify(params), "--as", as], {
		timeoutMs: 30_000,
	});
	const data = out?.data ?? {};
	return {
		items: (Array.isArray(data.items) ? data.items : []).map((raw) => ({
			id: String(raw.open_department_id ?? raw.department_id ?? ""),
			name: String(raw.name ?? ""),
			parentId: String(raw.parent_department_id ?? ""),
			memberCount: Number(raw.member_count) || 0,
			hasChild: Boolean(raw.has_child),
			leaderId: String(raw.leader_user_id ?? ""),
		})),
		hasMore: Boolean(data.has_more),
		pageToken: String(data.page_token ?? ""),
	};
}

/**
 * 部门成员。与旧实现保持同一份"降级说明"口径：拿不到就把原因写成可执行提示，
 * 而不是留一个看起来像插件坏了的空白列表。
 */
export async function listDepartmentUsers(
	run,
	{ departmentId = "0", pageSize = 50, pageToken = "", as = "user" } = {},
) {
	const params = {
		department_id: String(departmentId || "0"),
		page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 50),
		user_id_type: "open_id",
		department_id_type: "open_department_id",
		...(pageToken ? { page_token: String(pageToken) } : {}),
	};
	try {
		const out = await run(["api", "GET", DEPT_USERS_PATH, "--params", JSON.stringify(params), "--as", as], {
			timeoutMs: 30_000,
		});
		const data = out?.data ?? {};
		const items = (Array.isArray(data.items) ? data.items : []).map(normalizeCliUser);
		return {
			items,
			hasMore: Boolean(data.has_more),
			pageToken: String(data.page_token ?? ""),
			identity: "user",
			degraded: false,
		};
	} catch (err) {
		const message = String(err?.message || err);
		return {
			items: [],
			hasMore: false,
			pageToken: "",
			identity: "user",
			degraded: true,
			deptScopeDenied: true,
			note: `读不到该部门成员：${message}。个人身份下通常是通讯录可见范围或 contact 域权限未开（lark-cli auth login --domain contact）。`,
		};
	}
}
