/**
 * plugins/feishu-pro/lib/cli-docs.mjs
 * 云文档域 → lark-cli 适配层：读取正文（markdown）、搜索、我的空间、知识库。
 *
 * 为什么不再自己拼 docx 块树：`lark-cli docs +fetch --doc-format markdown` 已经把
 * 标题/列表/表格/代码块/引用整理成 markdown（它还带 `--scope section|keyword|outline`
 * 做局部读取），渲染层只要会画 markdown 就够了。块级 API 仍可随时用 `lark-cli api` 兜底。
 *
 * 输出字段仍保持插件既有的 `normalizeDoc` 形状（前端 renderDocs 不用改）。
 */

import { buildDocUrl } from "./config.mjs";

/** 单次读取的字符上限（防止把整本手册塞进浏览器）。 */
export const MAX_DOC_CHARS = 400_000;

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

/** 时间字段口径统一成毫秒（CLI 透传的仍是 OpenAPI 原值：秒/毫秒都可能）。 */
export function toMs(value) {
	if (value === undefined || value === null || value === "") return 0;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** 文档条目归一化：search / drive files / wiki nodes 三个来源都收敛到这里。 */
export function normalizeCliDoc(raw = {}, { kind, cfg } = {}) {
	const type = String(raw.docs_type ?? raw.doc_type ?? raw.obj_type ?? raw.type ?? kind ?? "docx").toLowerCase();
	const token = String(raw.docs_token ?? raw.doc_token ?? raw.obj_token ?? raw.token ?? "").trim();
	const nodeToken = String(raw.node_token ?? "").trim();
	const linkType = kind === "wiki" || type === "wiki" || nodeToken ? "wiki" : type;
	const linkToken = linkType === "wiki" ? nodeToken || token : token;
	const url =
		String(raw.url ?? raw.doc_url ?? "").trim() ||
		(linkToken ? buildDocUrl({ cfg, type: linkType, token: linkToken }) : "");
	const modifiedAt = toMs(
		raw.modified_time ?? raw.latest_modify_time ?? raw.update_time ?? raw.obj_edit_time ?? raw.edit_time,
	);
	const createdAt = toMs(raw.created_time ?? raw.create_time ?? raw.obj_create_time ?? raw.node_create_time);
	return {
		id: token || nodeToken,
		token,
		nodeToken,
		title: String(raw.title ?? raw.name ?? raw.doc_title ?? "").trim() || "（无标题）",
		type,
		typeLabel: typeLabel(type),
		url,
		createdAt,
		modifiedAt,
		updatedAt: modifiedAt,
		ownerId: String(raw.owner_id ?? raw.creator ?? ""),
		lastModifyUser: String(raw.latest_modify_user ?? ""),
		parentToken: String(raw.parent_token ?? raw.parent_node_token ?? ""),
		hasChild: Boolean(raw.has_child),
		isFolder: type === "folder",
	};
}

/** 从 markdown 首行推标题（`# 内部向公开`）。 */
export function titleFromMarkdown(markdown) {
	const lines = String(markdown ?? "").split("\n");
	for (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		const m = text.match(/^#{1,6}\s+(.+)$/);
		return m ? m[1].trim() : "";
	}
	return "";
}

/**
 * `docs +fetch` 的 data → 插件读数结构（纯函数）。
 * 官方返回：`{ document: { document_id, revision_id, content, reference_map? } }`。
 */
export function parseFetchPayload(data, { token = "", cfg } = {}) {
	const doc = data?.document ?? data?.docx?.document ?? data?.doc ?? data?.document_data ?? null;
	const content = String(doc?.content ?? data?.content ?? "");
	const documentId = String(doc?.document_id ?? doc?.doc_token ?? token ?? "");
	const revision = Number(doc?.revision_id ?? 0) || 0;
	const metaTitle = String(doc?.title ?? data?.title ?? "").trim();
	const markdown = content;
	return {
		documentId,
		revision,
		title: metaTitle || titleFromMarkdown(markdown),
		markdown,
		url: documentId ? buildDocUrl({ cfg, type: "docx", token: documentId }) : "",
		truncated: false,
	};
}

/** 搜索/列表类返回的条目数组（字段名在不同接口间不统一，多候选探测）。 */
export function pickItems(data) {
	if (!data || typeof data !== "object") return [];
	const keys = ["items", "res_units", "docs_entities", "entities", "files", "nodes", "spaces", "list", "data"];
	for (const key of keys) {
		const value = data[key];
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object" && Array.isArray(value.items)) return value.items;
	}
	return Array.isArray(data) ? data : [];
}

/**
 * 读正文（markdown）。
 * 支持 `--scope`/`--keyword` 等可选参数：先整篇，超长时由调用方改用 section/keyword。
 */
export async function fetchDoc(
	run,
	{ token, type = "docx", cfg, scope, keyword, maxChars = MAX_DOC_CHARS, as = "user" } = {},
) {
	const doc = String(token ?? "").trim();
	if (!doc) throw new Error("token 不能为空");
	// 用 im-markdown 而不是 markdown：markdown 模式会**保留 DocxXML 片段**（`<title>` / `<callout emoji="📌">`
	// 之类），渲染出来就是一屏裸标签；im-markdown 会把这些残留片段降级成纯 markdown（实测 1.0.9x 均如此）。
	const args = ["docs", "+fetch", "--doc", doc, "--doc-format", "im-markdown", "--detail", "simple", "--as", as];
	if (scope) args.push("--scope", String(scope));
	if (keyword) args.push("--keyword", String(keyword));
	const out = await run(args, { timeoutMs: 60_000 });
	const parsed = parseFetchPayload(out?.data, { token: doc, cfg });
	if (!parsed.markdown.trim()) {
		return {
			ok: false,
			token: doc,
			type: String(type || "docx").toLowerCase(),
			title: parsed.title,
			markdown: "",
			content: "",
			error: "文档没有正文内容，或当前身份没有读取权限",
			url: parsed.url,
		};
	}
	const truncated = parsed.markdown.length > maxChars;
	return {
		ok: true,
		token: parsed.documentId || doc,
		type: String(type || "docx").toLowerCase(),
		title: parsed.title,
		markdown: truncated
			? `${parsed.markdown.slice(0, maxChars)}\n\n…（已截断，原文 ${parsed.markdown.length} 字）`
			: parsed.markdown,
		revision: parsed.revision,
		chars: parsed.markdown.length,
		truncated,
		url: parsed.url,
		source: "lark-cli docs +fetch",
	};
}

/** 云文档搜索（Search v2：doc_wiki/search）。 */
export async function searchDocs(run, { query, count = 20, cfg, pageToken = "", as = "user" } = {}) {
	const keyword = String(query ?? "").trim();
	if (!keyword) return { items: [], hasMore: false, total: 0 };
	const args = [
		"docs",
		"+search",
		"--query",
		keyword,
		"--page-size",
		String(Math.min(Math.max(Number(count) || 15, 1), 20)),
		"--as",
		as,
	];
	if (pageToken) args.push("--page-token", String(pageToken));
	const out = await run(args, { timeoutMs: 30_000 });
	const items = pickItems(out?.data);
	return {
		items: items.map((raw) => normalizeCliDoc(raw, { kind: "search", cfg })),
		hasMore: Boolean(out?.data?.has_more ?? out?.meta?.has_more),
		total: Number(out?.data?.total ?? items.length) || items.length,
		pageToken: String(out?.data?.page_token ?? out?.meta?.page_token ?? ""),
	};
}

/** 我的空间（drive files list）。folderToken 为空 = 根目录。 */
export async function listDriveFiles(
	run,
	{ folderToken = "", pageSize = 50, orderBy = "EditedTime", cfg, as = "user" } = {},
) {
	const params = {
		folder_token: folderToken,
		page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 50),
		order_by: orderBy === "CreatedTime" ? "CreatedTime" : "EditedTime",
		direction: "DESC",
	};
	const out = await run(["drive", "files", "list", "--params", JSON.stringify(params), "--as", as], {
		timeoutMs: 30_000,
	});
	const data = out?.data ?? {};
	return {
		items: pickItems(data).map((raw) => normalizeCliDoc(raw, { cfg })),
		nextPageToken: String(data.next_page_token ?? ""),
		hasMore: Boolean(data.has_more),
	};
}

/** 知识库列表。 */
export async function listWikiSpaces(run, { pageSize = 50, pageToken = "", as = "user" } = {}) {
	const args = [
		"wiki",
		"+space-list",
		"--page-size",
		String(Math.min(Math.max(Number(pageSize) || 50, 1), 50)),
		"--as",
		as,
	];
	if (pageToken) args.push("--page-token", String(pageToken));
	const out = await run(args, { timeoutMs: 30_000 });
	const data = out?.data ?? {};
	return {
		items: pickItems(data).map((raw) => ({
			id: String(raw.space_id ?? raw.id ?? ""),
			name: String(raw.name ?? "（未命名知识库）"),
			description: String(raw.description ?? ""),
			visibility: String(raw.visibility ?? ""),
			spaceType: String(raw.space_type ?? ""),
		})),
		pageToken: String(data.page_token ?? ""),
		hasMore: Boolean(data.has_more),
	};
}

/** 知识库节点（父节点为空 = 根）。 */
export async function listWikiNodes(
	run,
	{ spaceId, parentNodeToken = "", pageSize = 50, pageToken = "", cfg, as = "user" } = {},
) {
	if (!spaceId) throw new Error("space_id 不能为空");
	const args = [
		"wiki",
		"+node-list",
		"--space-id",
		String(spaceId),
		"--page-size",
		String(Math.min(Math.max(Number(pageSize) || 50, 1), 50)),
		"--as",
		as,
	];
	if (parentNodeToken) args.push("--parent-node-token", String(parentNodeToken));
	if (pageToken) args.push("--page-token", String(pageToken));
	const out = await run(args, { timeoutMs: 30_000 });
	const data = out?.data ?? {};
	return {
		items: pickItems(data).map((raw) => normalizeCliDoc(raw, { kind: "wiki", cfg })),
		pageToken: String(data.page_token ?? ""),
		hasMore: Boolean(data.has_more),
	};
}

/** 文档元信息（标题）：+fetch 已经带标题，这里只给"没有正文也要标题"的场景兜底。 */
export async function inspectDoc(run, { token, cfg, as = "user" } = {}) {
	const doc = String(token ?? "").trim();
	if (!doc) return { title: "", type: "docx", url: "" };
	try {
		const out = await run(["drive", "+inspect", "--doc", doc, "--as", as], { timeoutMs: 20_000 });
		const data = out?.data ?? {};
		const type = String(data.type ?? data.obj_type ?? "docx").toLowerCase();
		return {
			title: String(data.title ?? data.name ?? ""),
			type,
			token: String(data.token ?? data.obj_token ?? doc),
			url: String(data.url ?? "") || buildDocUrl({ cfg, type, token: String(data.token ?? doc) }),
		};
	} catch {
		return { title: "", type: "docx", url: buildDocUrl({ cfg, type: "docx", token: doc }) };
	}
}

/** 把 markdown 转成纯文本（复制按钮 / AI 工具用；保留表格制表符与列表标记）。 */
export function markdownToPlain(markdown) {
	return String(markdown ?? "")
		.replace(/^```[^\n]*\n([\s\S]*?)```$/gm, (_m, body) => body)
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => `📷 ${String(alt || "图片").trim() || "图片"}`)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/[*_~`>#]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
