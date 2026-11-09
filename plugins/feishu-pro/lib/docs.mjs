/**
 * plugins/feishu-pro/lib/docs.mjs
 * 云文档：知识库（应用身份可读目录）、我的空间文件（个人身份）、云文档搜索（个人身份）、
 * 正文读取（docx raw_content，谁有权限谁读得到）。
 *
 * 为什么"我的空间"和"搜索"必须是个人身份：这两个接口查的是**某个人的**可见数据，
 * 应用身份根本没有"我的空间"这个概念。用 tenant token 打它们只会拿到权限错误，
 * 所以在 openapi.mjs 里提前拦截成 NEED_USER，UI 就能直接引导授权。
 */

/** 身份口径常量（原 lib/openapi.mjs 已随凭证链下线一起删除，这里内联）。 */
export const IDENTITY_TENANT = "tenant";
export const IDENTITY_USER = "user";
import { buildDocUrl, docHost } from "./config.mjs";

/** 统一的文档类型（决定链接前缀与可读性）。 */
export const DOC_TYPES = ["docx", "doc", "sheet", "bitable", "mindnote", "file", "wiki", "folder"];

const TYPE_LABEL = {
	docx: "新文档",
	doc: "旧文档",
	sheet: "表格",
	bitable: "多维表格",
	mindnote: "思维笔记",
	slides: "幻灯片",
	file: "文件",
	wiki: "知识库",
	folder: "文件夹",
};

export function typeLabel(type) {
	return TYPE_LABEL[String(type ?? "").toLowerCase()] ?? String(type ?? "");
}

/** 飞书的时间字段口径很杂：秒级字符串、毫秒字符串、空串都出现过。统一成毫秒。
 *
 * 实测坑：`drive/v1/files` 返回的是**秒**（`"1767510632"`），而缓存/搜索接口有时给毫秒。
 * 早先按毫秒直接 `new Date()`，页面上显示成 1970 年 —— 所以这里做一次量级判断。 */
export function toMs(value) {
	if (value === undefined || value === null || value === "") return 0;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	// < 1e12 视为秒（1e12 ms ≈ 2001 年，真实文档时间不可能小于它）
	return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** 文档条目归一化：drive files / docs search / wiki nodes 三种来源都收敛到这里。 */
export function normalizeDoc(raw = {}, { kind, cfg } = {}) {
	const type = String(raw.docs_type ?? raw.obj_type ?? raw.type ?? kind ?? "docx").toLowerCase();
	const token = String(raw.docs_token ?? raw.obj_token ?? raw.token ?? raw.node_token ?? "").trim();
	const nodeToken = String(raw.node_token ?? "").trim();
	// 知识库节点用 node_token 拼链接（wiki/<node>），其它类型用 obj token。
	const linkType = kind === "wiki" || type === "wiki" || nodeToken ? "wiki" : type;
	const linkToken = linkType === "wiki" ? nodeToken || token : token;
	const url = String(raw.url ?? "").trim() || buildDocUrl({ cfg, type: linkType, token: linkToken });
	// 三个时间分开记：创建 / 最后修改（来自飞书）+ 访问（只能本地记，见 recent.mjs）。
	const modifiedAt = toMs(raw.modified_time ?? raw.latest_modify_time ?? raw.obj_edit_time);
	const createdAt = toMs(raw.created_time ?? raw.create_time ?? raw.obj_create_time ?? raw.node_create_time);
	return {
		id: token || nodeToken,
		token,
		nodeToken,
		title: String(raw.title ?? raw.name ?? "").trim() || "（无标题）",
		type,
		typeLabel: typeLabel(type),
		url,
		createdAt,
		modifiedAt,
		/** @deprecated 兼容旧前端：等价于 modifiedAt。 */
		updatedAt: modifiedAt,
		ownerId: String(raw.owner_id ?? raw.creator ?? ""),
		lastModifyUser: String(raw.latest_modify_user ?? ""),
		parentToken: String(raw.parent_token ?? raw.parent_node_token ?? ""),
		hasChild: Boolean(raw.has_child),
		isFolder: type === "folder",
	};
}

/** 我的空间文件清单（**个人身份**）；folderToken 为空 = 根目录。 */
/** `drive/v1/files` 只认这两个排序值（实测 OpenedTime/LastOpenTime/ViewTime 都是 99992402）。 */
export const DRIVE_ORDER_BY = ["EditedTime", "CreatedTime"];

export function normalizeOrderBy(value) {
	const raw = String(value ?? "").trim();
	return DRIVE_ORDER_BY.find((x) => x.toLowerCase() === raw.toLowerCase()) ?? "EditedTime";
}

function chunkBy(list, size) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}
