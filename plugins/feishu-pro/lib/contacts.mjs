/**
 * plugins/feishu-pro/lib/contacts.mjs
 * 通讯录：搜索同事、按部门浏览、批量取用户、部门树。
 *
 * 两套身份的现实差别（决定 UI 文案）：
 *   - 应用身份：只能看到「通讯录数据权限范围」内的部门与人，且**没有全量导出接口**；
 *   - 个人身份：可用 search/v1/user 搜到企业内任意同事（受管理员策略约束）。
 * 飞书不提供"列出全部通讯录"的接口，所以这里是"搜索 + 按部门逐层遍历"，不是全量拉取。
 */

/** 身份口径常量（原 lib/openapi.mjs 已随凭证链下线一起删除，这里内联）。 */
export const IDENTITY_TENANT = "tenant";
export const IDENTITY_USER = "user";

/** 通讯录用户对象归一化（字段名飞书有多种写法，全部兜住）。 */
export function normalizeUser(raw = {}) {
	const avatar = raw.avatar && typeof raw.avatar === "object" ? raw.avatar : {};
	const status = raw.status && typeof raw.status === "object" ? raw.status : {};
	return {
		openId: String(raw.open_id ?? raw.openId ?? ""),
		userId: String(raw.user_id ?? ""),
		unionId: String(raw.union_id ?? ""),
		name: String(raw.name ?? raw.en_name ?? ""),
		enName: String(raw.en_name ?? ""),
		avatar: String(avatar.avatar_72 ?? avatar.avatar_240 ?? raw.avatar_url ?? ""),
		departmentIds: Array.isArray(raw.department_ids) ? raw.department_ids.map(String) : [],
		email: String(raw.email ?? raw.enterprise_email ?? ""),
		mobile: String(raw.mobile ?? ""),
		jobTitle: String(raw.job_title ?? ""),
		city: String(raw.city ?? ""),
		description: String(raw.description ?? ""),
		frozen: Boolean(status.is_frozen || status.is_resigned || status.is_exited),
	};
}

/** 部门对象归一化。 */
export function normalizeDepartment(raw = {}) {
	return {
		id: String(raw.open_department_id ?? raw.department_id ?? ""),
		name: String(raw.name ?? ""),
		parentId: String(raw.parent_department_id ?? ""),
		memberCount: Number(raw.member_count) || 0,
		hasChild: Boolean(raw.has_child),
		leaderId: String(raw.leader_user_id ?? ""),
	};
}
