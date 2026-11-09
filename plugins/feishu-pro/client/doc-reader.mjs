/**
 * plugins/feishu-pro/client/doc-reader.mjs
 * 云文档富文本渲染器：把 markdown（`lark-cli docs +fetch` 的输出）转成 Node[] 后渲染成只读 DOM。
 *
 * 三条红线：
 *   1. **绝不用 innerHTML 拼文档内容**：一律 createElement + createTextNode，文本天然不解析标签
 *      （文档标题/正文来自企业数据，属于不可信输入）；`vnodeToHtml` 只给单测和调试用，自带转义。
 *   2. 链接只放行 http(s)（服务端已过滤一次，这里再过滤一次：两层都不信任输入）；
 *   3. 颜色只用主题 token / 低透明度色块 —— 不写死前景色，暗色主题下必须可读。
 *
 * 结构上刻意分成三层，前两层是纯函数（可单测、不碰 document）：
 *   renderDocNodes(nodes, ctx) → vnode[]      （纯）
 *   vnodeToHtml(vnode)          → string      （纯，转义）
 *   mountDocReader(el, doc)     → void        （浏览器：vnode → DOM + 事件委托）
 */

import { apiBase, esc } from "@pi-web-ui/plugin-sdk/client";

const PLUGIN_ID = "feishu-pro";
const BASE = apiBase(PLUGIN_ID);
const STYLE_ID = "feishu-pro-doc-render-css";
/** 一帧最多建多少个块（大文档分帧插入，避免长任务卡住输入）。 */
const CHUNK = 200;

/* ------------------------------- vnode 工具 ------------------------------- */

const VOID_TAGS = new Set(["img", "hr", "br", "input"]);

/** 文本节点 → vnode（对象形式，避免与元素混淆）。 */
const textNode = (text) => ({ text: String(text ?? "") });

/** 元素 vnode 构造器（测试里也用它拼期望值）。 */
export function el(tag, attrs, ...children) {
	const flat = [];
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		flat.push(typeof child === "string" ? textNode(child) : child);
	}
	return { tag, attrs: attrs ?? {}, children: flat };
}

/** 纯函数：vnode → HTML 字符串（全转义；仅单测/调试使用）。 */
export function vnodeToHtml(vnode) {
	if (vnode === null || vnode === undefined) return "";
	if (typeof vnode === "string") return esc(vnode);
	if (vnode.text !== undefined) return esc(vnode.text);
	const attrs = Object.entries(vnode.attrs ?? {})
		.filter(([, value]) => value !== undefined && value !== null && value !== false)
		.map(([key, value]) => ` ${key}="${esc(value)}"`)
		.join("");
	if (VOID_TAGS.has(vnode.tag)) return `<${vnode.tag}${attrs}>`;
	const inner = (vnode.children ?? []).map(vnodeToHtml).join("");
	return `<${vnode.tag}${attrs}>${inner}</${vnode.tag}>`;
}

/** 浏览器：vnode → DOM。文本走 createTextNode，属性走 setAttribute（不拼字符串）。 */
export function vnodeToDom(vnode) {
	if (vnode === null || vnode === undefined) return null;
	if (typeof vnode === "string") return document.createTextNode(vnode);
	if (vnode.text !== undefined) return document.createTextNode(vnode.text);
	const node = document.createElement(vnode.tag);
	for (const [key, value] of Object.entries(vnode.attrs ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		node.setAttribute(key, String(value));
	}
	for (const child of vnode.children ?? []) {
		const built = vnodeToDom(child);
		if (built) node.appendChild(built);
	}
	return node;
}

/* ------------------------------ 行内：Run[] ------------------------------ */

/** Run[] → span / a / em 等行内节点。 */
export function runsToVNodes(runs, ctx = {}) {
	const out = [];
	for (const run of Array.isArray(runs) ? runs : []) {
		const text = String(run?.text ?? "");
		if (!text) continue;
		const style = run.style ?? {};
		let node = textNode(text);
		if (style.code) node = el("code", { class: "fp-dc-inline-code" }, node);
		if (style.s) node = el("s", null, node);
		if (style.u) node = el("u", null, node);
		if (style.i) node = el("em", null, node);
		if (style.b) node = el("strong", null, node);
		if (style.bg) node = el("span", { class: `fp-dc-bg${Number(style.bg) || 1}` }, node);
		const href = safeHref(style.link || run.url);
		if (run.t === "mention_doc") {
			node = href
				? el("a", { class: "fp-dc-mention", href, target: "_blank", rel: "noopener noreferrer" }, node)
				: el("span", { class: "fp-dc-mention" }, node);
		} else if (run.t === "equation") {
			node = el("span", { class: "fp-dc-eq" }, node);
		} else if (run.t === "file") {
			node = el("span", { class: "fp-dc-inline-file" }, `📎 ${text}`);
		} else if (href) {
			node = el("a", { href, target: "_blank", rel: "noopener noreferrer" }, node);
		}
		out.push(node);
	}
	void ctx;
	return out;
}

/** 链接协议白名单（服务端已过滤，前端再兜一次）。 */
export function safeHref(url) {
	const text = String(url ?? "").trim();
	if (!text) return "";
	try {
		const parsed = new URL(text);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
	} catch {
		return "";
	}
}

/* ------------------------------ 块：Node[] ------------------------------ */

/**
 * 主入口：Node[] → vnode[]（按文档顺序，列表自动成组）。
 * @param {object[]} nodes
 * @param {{ mediaUrl?: (token: string, kind?: string) => string }} [ctx]
 */
export function renderDocNodes(nodes, ctx = {}) {
	return flow(Array.isArray(nodes) ? nodes : [], ctx);
}

/**
 * 「流」渲染：连续同类列表块合并成一个 ul/ol/todo 容器，其余块各渲染一份。
 * 飞书把每个列表项都建模成独立块，直接逐个渲染会产出 `<li>` 悬挂在根上（非法结构）。
 */
function flow(nodes, ctx) {
	const out = [];
	let group = null;
	const flush = () => {
		if (!group) return;
		out.push(group.node);
		group = null;
	};
	for (const node of nodes) {
		const kind = node?.k;
		if (kind === "page" || !kind) continue;
		if (kind === "view") {
			// 分组视图：直接展平（保留内部块顺序）。
			flush();
			out.push(...flow(node.children ?? [], ctx));
			continue;
		}
		if (kind === "bullet" || kind === "ordered" || kind === "todo") {
			const tag = kind === "ordered" ? "ol" : "ul";
			if (!group || group.tag !== tag) {
				flush();
				const attrs = { class: kind === "todo" ? "fp-dc-todos" : "fp-dc-list" };
				group = { tag, node: el(tag, attrs), attrs };
			}
			if (kind === "ordered" && Number(node.seq) > 1) group.node.attrs.start = String(Number(node.seq));
			group.node.children.push(listItem(node, ctx));
			continue;
		}
		flush();
		const built = blockVNode(node, ctx);
		if (!built) continue;
		if (Array.isArray(built)) out.push(...built);
		else out.push(built);
	}
	flush();
	return out;
}

function listItem(node, ctx) {
	const children = [];
	if (node.runs?.length) children.push(...runsToVNodes(node.runs, ctx));
	children.push(...flow(node.children ?? [], ctx));
	if (node.k === "todo") {
		return el(
			"li",
			{ class: "fp-dc-todo", "data-done": node.done ? "1" : "0" },
			el("span", { class: "fp-dc-check" }, node.done ? "☑" : "☐"),
			el("div", { class: "fp-dc-li" }, ...children),
		);
	}
	return el("li", null, ...children);
}

/** 单个块 → vnode（列表项由 flow 处理，不在这里）。 */
function blockVNode(node, ctx) {
	switch (node.k) {
		case "text": {
			// children（嵌套的子块，常见于列表项正文）不能塞进 <p>，拆成兄弟节点。
			const para = el("p", null, ...runsToVNodes(node.runs, ctx));
			const rest = flow(node.children ?? [], ctx);
			return rest.length ? [para, ...rest] : para;
		}
		case "heading1":
			return heading(node, "h1", ctx);
		case "heading2":
			return heading(node, "h2", ctx);
		case "heading3":
			return heading(node, "h3", ctx);
		case "heading4":
			return heading(node, "h4", ctx);
		case "heading5":
		case "heading6":
		case "heading7":
		case "heading8":
		case "heading9":
			return heading(node, node.k === "heading5" ? "h5" : "h6", ctx);
		case "code":
			return el(
				"pre",
				{ class: "fp-dc-pre", "data-lang": node.lang && node.lang !== "PlainText" ? node.lang : "" },
				el("code", null, ...runsToVNodes(node.runs, ctx)),
			);
		case "quote":
			return el("blockquote", null, ...runsToVNodes(node.runs, ctx), ...flow(node.children ?? [], ctx));
		case "quote_container":
			return el("blockquote", { class: "fp-dc-quote-container" }, ...flow(node.children ?? [], ctx));
		case "divider":
			return el("hr", { class: "fp-dc-hr" });
		case "table":
			return tableView(node, ctx);
		case "image":
			return imageView(node, ctx);
		case "file":
			return el("div", { class: "fp-dc-placeholder" }, `📎 ${node.media?.name ?? "附件"}（在飞书中下载）`);
		case "sheet":
			return insertCard("sheet", node, ctx);
		case "bitable":
			return insertCard("bitable", node, ctx);
		case "callout": {
			const emoji = String(node.callout?.emoji ?? "").trim();
			const bg = Number(node.callout?.bg) || 0;
			const box = el(
				"div",
				{ class: `fp-dc-callout${bg ? ` fp-dc-bg${bg}` : ""}` },
				emoji ? el("span", { class: "fp-dc-emoji" }, emoji) : null,
				el("div", { class: "fp-dc-callout-body" }, ...flow(node.children ?? [], ctx)),
			);
			return box;
		}
		case "grid":
			return el("div", { class: "fp-dc-grid" }, ...flow(node.children ?? [], ctx));
		case "grid_column":
			return el(
				"div",
				{ class: "fp-dc-col", style: `flex:${Number(node.ratio) || 1} 1 0` },
				...flow(node.children ?? [], ctx),
			);
		case "agenda":
			return el("div", { class: "fp-dc-agenda" }, ...runsToVNodes(node.runs, ctx), ...flow(node.children ?? [], ctx));
		case "agenda_item":
			return el("div", { class: "fp-dc-agenda-item" }, ...flow(node.children ?? [], ctx));
		case "agenda_item_title":
			return el("div", { class: "fp-dc-agenda-title" }, ...runsToVNodes(node.runs, ctx));
		case "agenda_item_content":
			return el(
				"div",
				{ class: "fp-dc-agenda-content" },
				...runsToVNodes(node.runs, ctx),
				...flow(node.children ?? [], ctx),
			);
		case "iframe":
		case "link": {
			const href = safeHref(node.url);
			const label = String(node.text || node.url || "链接");
			return href
				? el("a", { class: "fp-dc-linkcard", href, target: "_blank", rel: "noopener noreferrer" }, `🔗 ${label}`)
				: el("div", { class: "fp-dc-placeholder" }, `🔗 ${label}`);
		}
		case "placeholder":
			return el("div", { class: "fp-dc-placeholder" }, String(node.text ?? "（未支持的块）"));
		default:
			// 兜底：认识不认识的都别丢内容。
			if (node.runs?.length) return el("p", null, ...runsToVNodes(node.runs, ctx));
			return null;
	}
}

function heading(node, tag, ctx) {
	const head = el(tag, null, ...runsToVNodes(node.runs, ctx));
	const rest = flow(node.children ?? [], ctx);
	return rest.length ? [head, ...rest] : head;
}

/**
 * 表格单元格内容：纯文本单元格**不再包一层 <p>**（否则每格多出段间距，表格看着很散）。
 * 只有多块内容（列表/表格/代码块）才走完整 flow。
 */
function cellChildren(nodes, ctx) {
	const blocks = Array.isArray(nodes) ? nodes.filter((node) => node && node.k !== "page") : [];
	if (blocks.every((node) => node.k === "text" || node.k === "placeholder")) {
		const out = [];
		for (const node of blocks) {
			if (node.k === "placeholder") {
				out.push(el("span", { class: "fp-dc-placeholder-inline" }, String(node.text ?? "")));
				continue;
			}
			out.push(...runsToVNodes(node.runs, ctx));
		}
		return out;
	}
	return flow(blocks, ctx);
}

/** 表格：rowspan/colspan 已在服务端算好，这里只跳过被合并覆盖的格子。 */
function tableView(node, ctx) {
	const rows = Array.isArray(node.cells) ? node.cells : [];
	const header = Boolean(node.table?.header);
	const body = [];
	rows.forEach((row, index) => {
		const cells = [];
		for (const cell of row ?? []) {
			if (!cell || cell.skip) continue;
			const attrs = {};
			if (cell.rs > 1) attrs.rowspan = String(cell.rs);
			if (cell.cs > 1) attrs.colspan = String(cell.cs);
			cells.push(el(index === 0 && header ? "th" : "td", attrs, ...cellChildren(cell.nodes ?? [], ctx)));
		}
		if (cells.length) body.push(el("tr", null, ...cells));
	});
	const table = el("table", { class: "fp-dc-table" }, ...body);
	return el("div", { class: "fp-dc-tablewrap" }, table);
}

/** 图片：同源代理（<img> 自带 Cookie），失败由 DOM 层的 error 捕获换成占位。 */
function imageView(node, ctx) {
	const token = String(node.media?.token ?? "");
	if (!token) return el("div", { class: "fp-dc-placeholder" }, "（图片缺少 token）");
	const src = mediaUrlOf(ctx, token);
	const attrs = { class: "fp-dc-img", src, loading: "lazy", alt: "图片", "data-media-token": token };
	const w = Number(node.media?.w) || 0;
	const h = Number(node.media?.h) || 0;
	if (w > 0) attrs.width = String(w);
	if (h > 0) attrs.height = String(h);
	return el("div", { class: "fp-dc-imgwrap" }, el("img", attrs));
}

/** sheet / bitable 卡片：首屏只给尺寸，点击才拉数据（由 mount 的事件委托绑定）。 */
function insertCard(type, node, ctx) {
	const token = type === "sheet" ? String(node.sheet?.token ?? "") : String(node.bitable?.token ?? "");
	const label = type === "sheet" ? `📊 电子表格 ${node.sheet?.rows || "?"}×${node.sheet?.cols || "?"}` : "📋 多维表格";
	if (!token) return el("div", { class: "fp-dc-placeholder" }, `${label}（缺少 token）`);
	void ctx;
	return el(
		"button",
		{ class: "fp-dc-card", type: "button", "data-fp-card": type, "data-fp-token": token },
		el("span", { class: "fp-dc-card-title" }, label),
		el("span", { class: "fp-dc-card-hint" }, "点击加载预览"),
	);
}

function mediaUrlOf(ctx, token) {
	if (typeof ctx?.mediaUrl === "function") return ctx.mediaUrl(token, "image");
	return `${BASE}/docs/media?kind=image&token=${encodeURIComponent(token)}`;
}

/* ------------------------------ Markdown ------------------------------ */

/** markdown → 纯文本（复制 / 引用用；保留表格制表符）。 */
export function markdownToPlain(markdown) {
	return String(markdown ?? "")
		.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => `📷 ${String(alt || "图片").trim() || "图片"}`)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/[*_~`]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 行内 markdown → Run[]（复用 runsToVNodes 的样式映射）。 */
export function parseInlineMarkdown(text) {
	const source = String(text ?? "");
	const runs = [];
	const re =
		/`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(([^)\s]+)\)/g;
	let last = 0;
	let m;
	const pushText = (value, style = {}) => {
		if (!value) return;
		runs.push({ t: "text", text: value, style });
	};
	while ((m = re.exec(source))) {
		if (m.index > last) pushText(source.slice(last, m.index));
		const [whole, code, bold, bold2, strike, italic, italic2, imgAlt, imgUrl, linkText, linkUrl] = m;
		if (code !== undefined) pushText(code, { code: true });
		else if (bold !== undefined || bold2 !== undefined) pushText(bold ?? bold2, { b: true });
		else if (strike !== undefined) pushText(strike, { s: true });
		else if (italic !== undefined || italic2 !== undefined) pushText(italic ?? italic2, { i: true });
		else if (imgAlt !== undefined || imgUrl !== undefined) {
			// 飞书图片链接需要鉴权，直接 <img> 肯定 403；渲染成带链接的文字占位更诚实。
			const href = safeHref(imgUrl);
			pushText(`📷 ${imgAlt || "图片"}`, href ? { link: href } : {});
		} else if (linkText !== undefined || linkUrl !== undefined) {
			const href = safeHref(linkUrl);
			pushText(linkText || linkUrl || "链接", href ? { link: href } : {});
		}
		last = m.index + whole.length;
	}
	if (last < source.length) pushText(source.slice(last));
	return mergeRuns(runs);
}

function mergeRuns(runs) {
	const out = [];
	const keyOf = (style) => [style?.b, style?.i, style?.s, style?.u, style?.code, style?.link].join("|");
	for (const run of runs) {
		const prev = out[out.length - 1];
		if (prev && keyOf(prev.style) === keyOf(run.style)) prev.text += run.text;
		else out.push({ ...run, style: run.style ?? {} });
	}
	return out;
}

const MD_LIST_RE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const MD_TABLE_RE = /^\s*\|.*\|\s*$/;
const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** markdown → Node[]（docx blocks 通道已随 openapi 下线，这里是唯一来源）。 */
/**
 * 清掉 lark-cli `im-markdown` 仍会残留的少量 DocxXML 片段。
 * 实测最常见的是 `<br/>`（换行没被转成 markdown 换行），成对标签极少但要兜住，
 * 否则渲染出来就是字面量 `<br/>` / `<callout>`。
 */
export function stripResidualDocxXml(markdown) {
	return String(markdown ?? "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(?:title|callout|quote|code|list|table|tbody|thead|tr|td|th|div|span|font|b|i|u|s|a)\b[^>]*>/gi, "");
}

export function markdownToNodes(markdown) {
	const lines = stripResidualDocxXml(markdown).replace(/\r\n?/g, "\n").split("\n");
	const nodes = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		const fence = line.match(/^\s*```+\s*([\w+#.-]*)\s*$/);
		if (fence) {
			const body = [];
			i++;
			while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
			i++;
			nodes.push({ k: "code", lang: fence[1] || "PlainText", runs: [{ t: "text", text: body.join("\n"), style: {} }] });
			continue;
		}

		if (!line.trim()) {
			i++;
			continue;
		}

		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			nodes.push({ k: "divider" });
			i++;
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			nodes.push({ k: `heading${heading[1].length}`, runs: parseInlineMarkdown(heading[2]) });
			i++;
			continue;
		}

		if (MD_TABLE_RE.test(line) && i + 1 < lines.length && MD_TABLE_SEP_RE.test(lines[i + 1])) {
			const [table, next] = parseMarkdownTable(lines, i);
			nodes.push(table);
			i = next;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			const inner = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ""));
			nodes.push({ k: "quote", runs: [], children: markdownToNodes(inner.join("\n")) });
			continue;
		}

		if (MD_LIST_RE.test(line)) {
			const [items, next] = parseMarkdownList(lines, i);
			nodes.push(...items);
			i = next;
			continue;
		}

		// 段落：连续非块级行合并（软换行保留为空格）
		const paragraph = [];
		while (i < lines.length) {
			const cur = lines[i];
			if (!cur.trim()) break;
			if (/^\s*```/.test(cur) || /^(#{1,6})\s+/.test(cur) || MD_LIST_RE.test(cur) || /^\s*>/.test(cur)) break;
			if (MD_TABLE_RE.test(cur) && i + 1 < lines.length && MD_TABLE_SEP_RE.test(lines[i + 1])) break;
			paragraph.push(cur.trim());
			i++;
		}
		if (paragraph.length) nodes.push({ k: "text", runs: parseInlineMarkdown(paragraph.join(" ")) });
		else i++;
	}
	return nodes;
}

function indentOf(line) {
	const m = String(line ?? "").match(/^[ \t]*/);
	const raw = m ? m[0] : "";
	return raw.replace(/\t/g, "    ").length;
}

function parseMarkdownList(lines, start) {
	const baseIndent = indentOf(lines[start]);
	const items = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			const next = lines[i + 1];
			if (next && indentOf(next) >= baseIndent && MD_LIST_RE.test(next)) {
				i++;
				continue;
			}
			break;
		}
		const indent = indentOf(line);
		if (indent < baseIndent) break;
		const match = line.match(MD_LIST_RE);
		if (!match) {
			if (indent > baseIndent && items.length) {
				// 子列表/续行：递归到上一项的 children
				const [children, next] = parseMarkdownList(lines, i);
				items[items.length - 1].children.push(...children);
				i = next;
				continue;
			}
			break;
		}
		if (indent > baseIndent) {
			const [children, next] = parseMarkdownList(lines, i);
			if (items.length) items[items.length - 1].children.push(...children);
			i = next;
			continue;
		}
		const [, marker, body] = match;
		const todo = body.match(/^\[( |x|X)\]\s*(.*)$/);
		items.push({
			ordered: /\d/.test(marker[0]),
			number: /\d/.test(marker[0]) ? Number.parseInt(marker, 10) || 1 : 0,
			text: todo ? todo[2] : body,
			done: todo ? todo[1].toLowerCase() === "x" : undefined,
			children: [],
		});
		i++;
	}

	const nodes = [];
	let seq = 0;
	for (const item of items) {
		if (item.done !== undefined) {
			nodes.push({ k: "todo", runs: parseInlineMarkdown(item.text), done: item.done, children: item.children });
			continue;
		}
		if (item.ordered) {
			seq++;
			const node = { k: "ordered", runs: parseInlineMarkdown(item.text), children: item.children };
			if (seq === 1 && item.number > 1) node.seq = item.number;
			nodes.push(node);
			continue;
		}
		seq = 0;
		nodes.push({ k: "bullet", runs: parseInlineMarkdown(item.text), children: item.children });
	}
	return [nodes, i];
}

function parseMarkdownTable(lines, start) {
	const rows = [];
	let i = start;
	while (i < lines.length && MD_TABLE_RE.test(lines[i])) {
		if (MD_TABLE_SEP_RE.test(lines[i])) {
			i++;
			continue;
		}
		rows.push(splitMarkdownRow(lines[i]));
		i++;
	}
	const cols = Math.max(1, ...rows.map((row) => row.length));
	const cells = rows.map((row) => {
		const line = [];
		for (let c = 0; c < cols; c++) {
			line.push({ nodes: [{ k: "text", runs: parseInlineMarkdown(row[c] ?? "") }], rs: 1, cs: 1 });
		}
		return line;
	});
	return [
		{
			k: "table",
			table: { rows: rows.length, cols, header: rows.length > 1, merge: [] },
			cells,
		},
		i,
	];
}

function splitMarkdownRow(line) {
	const text = String(line ?? "")
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "");
	const out = [];
	let buf = "";
	let escaped = false;
	for (const ch of text) {
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "|") {
			out.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	out.push(buf.trim());
	return out;
}

/** markdown → vnode[]（唯一入口：服务端给的 `doc.markdown`）。 */
export function markdownToVNodes(markdown, ctx = {}) {
	return renderDocNodes(markdownToNodes(markdown), ctx);
}

/** 按 doc 的形态选解析器：优先 lark-cli 的 markdown，其次 blocks 树。 */
export function docToNodes(doc) {
	const markdown = String(doc?.markdown ?? "");
	if (markdown.trim()) return markdownToNodes(markdown);
	return Array.isArray(doc?.blocks) ? doc.blocks : [];
}

/* ------------------------------- 样式 ------------------------------- */

const STYLES = `
.fp-doc-render{white-space:normal;font-size:13px;line-height:1.7;color:var(--text);overflow-wrap:anywhere;word-break:break-word;}
.fp-doc-render > :first-child{margin-top:0;}
.fp-doc-render h1,.fp-doc-render h2,.fp-doc-render h3,.fp-doc-render h4,.fp-doc-render h5,.fp-doc-render h6{margin:14px 0 8px;line-height:1.35;font-weight:600;}
.fp-doc-render h1{font-size:20px;} .fp-doc-render h2{font-size:17px;} .fp-doc-render h3{font-size:15px;}
.fp-doc-render h4{font-size:13.5px;} .fp-doc-render h5,.fp-doc-render h6{font-size:13px;color:var(--text-dim);}
.fp-doc-render p{margin:6px 0;min-width:0;}
.fp-doc-render ul,.fp-doc-render ol{margin:6px 0;padding-left:20px;}
.fp-doc-render ul.fp-dc-todos{list-style:none;padding-left:4px;}
.fp-doc-render li{margin:2px 0;min-width:0;}
.fp-doc-render li.fp-dc-todo{display:flex;gap:6px;align-items:baseline;}
.fp-doc-render li.fp-dc-todo .fp-dc-li{flex:1;min-width:0;}
.fp-doc-render li.fp-dc-todo[data-done="1"] .fp-dc-li{color:var(--text-dim);text-decoration:line-through;}
.fp-doc-render .fp-dc-check{flex:0 0 auto;color:var(--accent);font-size:12px;}
.fp-doc-render blockquote{margin:8px 0;padding:2px 0 2px 10px;border-left:3px solid var(--border);color:var(--text-dim);}
.fp-doc-render hr.fp-dc-hr{border:0;border-top:1px solid var(--border);margin:12px 0;}
.fp-doc-render pre.fp-dc-pre{position:relative;margin:8px 0;padding:8px 10px;border-radius:6px;background:var(--bg-elev2);border:1px solid var(--border);overflow:auto;}
.fp-doc-render pre.fp-dc-pre[data-lang]:not([data-lang=""])::before{content:attr(data-lang);position:absolute;top:4px;right:8px;font-size:10px;color:var(--text-faint);text-transform:uppercase;}
.fp-doc-render code,.fp-doc-render pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}
.fp-doc-render code.fp-dc-inline-code{padding:1px 4px;border-radius:4px;background:var(--bg-elev2);border:1px solid var(--border-soft);}
.fp-doc-render .fp-dc-tablewrap{max-width:100%;overflow:auto;margin:10px 0;border:1px solid var(--border);border-radius:6px;}
.fp-doc-render table.fp-dc-table{border-collapse:collapse;font-size:12px;min-width:100%;}
.fp-doc-render table.fp-dc-table td,.fp-doc-render table.fp-dc-table th{border:1px solid var(--border);padding:5px 8px;min-width:6em;max-width:30em;overflow-wrap:anywhere;word-break:break-word;vertical-align:top;text-align:left;}
.fp-doc-render table.fp-dc-table th{background:var(--bg-elev2);font-weight:600;}
.fp-doc-render table.fp-dc-table p{margin:0;}
.fp-doc-render .fp-dc-imgwrap{margin:8px 0;}
.fp-doc-render img.fp-dc-img{max-width:100%;height:auto;border-radius:4px;display:block;background:var(--bg-elev2);}
.fp-doc-render .fp-dc-callout{display:flex;gap:8px;margin:8px 0;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);}
.fp-doc-render .fp-dc-emoji{flex:0 0 auto;line-height:1.5;}
.fp-doc-render .fp-dc-callout-body{min-width:0;flex:1;}
.fp-doc-render .fp-dc-grid{display:flex;gap:10px;margin:8px 0;}
.fp-doc-render .fp-dc-col{min-width:0;}
.fp-doc-render .fp-dc-agenda{margin:8px 0;}
.fp-doc-render .fp-dc-agenda-title{font-weight:600;margin:6px 0 2px;}
.fp-doc-render .fp-dc-agenda-content{padding-left:12px;}
.fp-doc-render .fp-dc-linkcard{display:inline-block;margin:4px 0;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);text-decoration:none;overflow-wrap:anywhere;}
.fp-doc-render .fp-dc-linkcard:hover{border-color:var(--accent);}
.fp-doc-render .fp-dc-placeholder{margin:8px 0;padding:8px 10px;border:1px dashed var(--border);border-radius:6px;color:var(--text-dim);font-size:12px;line-height:1.7;}
.fp-doc-render .fp-dc-card{display:flex;flex-direction:column;gap:2px;width:100%;margin:8px 0;padding:9px 11px;border-radius:6px;border:1px dashed var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.fp-doc-render .fp-dc-card:hover{border-color:var(--accent);}
.fp-doc-render .fp-dc-card-hint{font-size:11px;color:var(--text-faint);}
.fp-doc-render .fp-dc-mention{color:var(--accent);text-decoration:none;}
.fp-doc-render .fp-dc-eq{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-dim);}
.fp-doc-render .fp-dc-truncated{margin:14px 0 4px;font-size:11.5px;color:var(--text-faint);}
/* 飞书背景色 1-15：只铺很淡的底色，前景一律用主题色 —— 暗色主题下也不可读的问题就不会出现 */
.fp-doc-render .fp-dc-bg1{background:rgba(127,127,127,.12);}
.fp-doc-render .fp-dc-bg2{background:rgba(127,127,127,.20);}
.fp-doc-render .fp-dc-bg3{background:rgba(255,120,120,.22);}
.fp-doc-render .fp-dc-bg4{background:rgba(255,175,105,.22);}
.fp-doc-render .fp-dc-bg5{background:rgba(255,214,102,.26);}
.fp-doc-render .fp-dc-bg6{background:rgba(148,220,130,.24);}
.fp-doc-render .fp-dc-bg7{background:rgba(120,205,235,.24);}
.fp-doc-render .fp-dc-bg8{background:rgba(150,170,255,.24);}
.fp-doc-render .fp-dc-bg9{background:rgba(205,160,255,.24);}
.fp-doc-render .fp-dc-bg10{background:rgba(240,150,210,.24);}
.fp-doc-render .fp-dc-bg11{background:rgba(200,200,200,.24);}
.fp-doc-render .fp-dc-bg12{background:rgba(120,160,230,.22);}
.fp-doc-render .fp-dc-bg13{background:rgba(255,140,120,.22);}
.fp-doc-render .fp-dc-bg14{background:rgba(120,200,170,.24);}
.fp-doc-render .fp-dc-bg15{background:rgba(255,190,90,.24);}
/* 图片放大层 */
.fp-dc-lightbox{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.72);cursor:zoom-out;}
.fp-dc-lightbox img{max-width:100%;max-height:100%;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.5);}
`;

/** 幂等注入样式（视图反复打开也只留一份）。 */
export function ensureDocReaderStyles(doc = typeof document === "undefined" ? null : document) {
	if (!doc || doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLES;
	doc.head?.appendChild(style);
}

/** 样式全文（离线预览 / 主题回归时复用，不要在业务代码里拼字符串）。 */
export const DOC_READER_STYLES = STYLES;

/* ------------------------------- 挂载 ------------------------------- */

/** 复制按钮 / AI 用的纯文本：优先服务端给的 plain，其次 markdown 折纯，最后 raw_content。 */
export function docPlainText(doc) {
	const plain = String(doc?.plain ?? "").trim();
	if (plain) return plain;
	const markdown = String(doc?.markdown ?? "");
	if (markdown.trim()) return markdownToPlain(markdown);
	return String(doc?.content ?? "");
}

/** 该 doc 能不能走富文本渲染（lark-cli 的 markdown 或原生 blocks 两种都行）。 */
export function canRenderRich(doc) {
	if (!doc || doc.ok === false) return false;
	if (String(doc.markdown ?? "").trim()) return true;
	return Array.isArray(doc.blocks) && doc.blocks.length > 0;
}

/**
 * 浏览器挂载：清空容器 → 分帧插入 vnode → 绑定事件（图片放大、图片失败占位、sheet/bitable 卡片）。
 * 富文本不可用时**回落纯文本**（保证不白屏，这是最低要求）。
 *
 * @param {HTMLElement} container 现有 `.fp-reader-body`
 * @param {object} doc `/docs/read` 返回的 doc
 * @param {{ mediaUrl?: Function, call?: Function, onSay?: Function }} [opts]
 */
export function mountDocReader(container, doc, opts = {}) {
	if (!container) return;
	ensureDocReaderStyles(container.ownerDocument);
	// 上一轮的事件监听全部解绑（换文档时不残留）。
	container.__fpAbort?.abort?.();
	container.textContent = "";
	container.__fpAbort = typeof AbortController === "function" ? new AbortController() : null;
	const signal = container.__fpAbort?.signal;

	if (!canRenderRich(doc)) {
		container.classList.remove("fp-doc-render");
		container.style.whiteSpace = "pre-wrap";
		container.style.fontSize = "12px";
		container.style.color = doc?.ok === false ? "var(--red,#f87171)" : "var(--text)";
		container.textContent = String(doc?.content || doc?.error || "（没有内容）");
		return;
	}

	container.classList.add("fp-doc-render");
	container.style.whiteSpace = "normal";
	container.style.color = "var(--text)";
	container.style.fontSize = "";

	const nodes = docToNodes(doc);
	const vnodes = renderDocNodes(nodes, { mediaUrl: opts.mediaUrl });
	const tail = doc.truncated ? [el("div", { class: "fp-dc-truncated" }, "内容过大，仅显示前面部分")] : [];
	const all = [...vnodes, ...tail];

	// 分帧插入：首帧 200 块，之后每帧 200 块（大文档不阻塞输入）。
	let cursor = 0;
	const doc0 = container.ownerDocument ?? document;
	const view = doc0.defaultView ?? globalThis;
	const step = () => {
		const end = Math.min(cursor + CHUNK, all.length);
		const frag = doc0.createDocumentFragment();
		for (; cursor < end; cursor++) {
			const built = vnodeToDom(all[cursor]);
			if (built) frag.appendChild(built);
		}
		container.appendChild(frag);
		if (cursor < all.length) {
			if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(step);
			else setTimeout(step, 0);
		}
	};
	step();

	bindReaderEvents(container, opts, signal);
}

/** 事件委托：图片放大 / 图片失败占位 / sheet·bitable 卡片加载。 */
function bindReaderEvents(container, opts, signal) {
	const handlerOptions = signal ? { signal } : undefined;

	container.addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const img = target.closest("img.fp-dc-img");
			if (img && !img.dataset.failed) {
				openLightbox(container, img.getAttribute("src") || "");
				return;
			}
			const card = target.closest("[data-fp-card]");
			if (card) {
				void loadCard(container, card, opts);
			}
		},
		handlerOptions,
	);

	// 图片加载失败：error 不冒泡，用捕获阶段接住 → 换成可读占位（不是破图图标）。
	container.addEventListener(
		"error",
		(event) => {
			const target = event.target;
			if (!(target instanceof HTMLImageElement) || !target.classList.contains("fp-dc-img")) return;
			target.dataset.failed = "1";
			const wrap = target.parentElement;
			if (!wrap) return;
			const placeholder = el(
				"div",
				{ class: "fp-dc-placeholder" },
				"图片无法显示（应用未开通云文档下载权限，或该图片无访问权限）",
			);
			const built = vnodeToDom(placeholder);
			if (built) wrap.replaceChildren(built);
		},
		{ ...(handlerOptions ?? {}), capture: true },
	);
}

/** 图片放大：一个固定定位的遮罩，点击/ESC 关闭，无第三方依赖。 */
function openLightbox(container, src) {
	if (!src) return;
	const doc0 = container.ownerDocument ?? document;
	const box = doc0.createElement("div");
	box.className = "fp-dc-lightbox";
	const img = doc0.createElement("img");
	img.src = src;
	img.alt = "图片";
	box.appendChild(img);
	const close = () => {
		box.remove();
		doc0.removeEventListener("keydown", onKey);
	};
	const onKey = (event) => {
		if (event.key === "Escape") close();
	};
	box.addEventListener("click", close);
	doc0.addEventListener("keydown", onKey);
	doc0.body.appendChild(box);
}

/** sheet / bitable 卡片：有 call 就拉预览，没有就给出可执行提示。 */
async function loadCard(container, card, opts) {
	const type = card.getAttribute("data-fp-card");
	const token = card.getAttribute("data-fp-token") ?? "";
	if (!token) return;
	if (typeof opts.call !== "function") {
		opts.onSay?.("该预览需要重新加载插件页面后再试", "error");
		return;
	}
	card.disabled = true;
	card.querySelector(".fp-dc-card-hint")?.replaceChildren(document.createTextNode("加载中…"));
	try {
		const query =
			type === "sheet"
				? `/docs/sheet?token=${encodeURIComponent(token)}`
				: `/docs/bitable?token=${encodeURIComponent(token)}`;
		const payload = await opts.call(query, { timeoutMs: 25000 });
		const built = type === "sheet" ? sheetTable(payload) : bitableTable(payload);
		const node = vnodeToDom(built);
		if (node) card.replaceWith(node);
	} catch (err) {
		card.disabled = false;
		card
			.querySelector(".fp-dc-card-hint")
			?.replaceChildren(document.createTextNode(String(err?.message || err).slice(0, 120)));
	}
}

/** sheet 预览：只读网格（首行/首列 sticky 由 CSS 的 table 结构天然近似即可）。 */
function sheetTable(payload) {
	const values = Array.isArray(payload?.grid?.values) ? payload.grid.values : [];
	if (!values.length) return el("div", { class: "fp-dc-placeholder" }, "表格没有数据或没有权限");
	const rows = values.map((row) =>
		el("tr", null, ...(Array.isArray(row) ? row : []).map((cell) => el("td", null, cellText(cell)))),
	);
	const wrap = el("div", { class: "fp-dc-tablewrap" }, el("table", { class: "fp-dc-table" }, ...rows));
	const hint = payload?.grid?.truncated
		? el("div", { class: "fp-dc-truncated" }, "仅显示前若干行，完整内容请在飞书中查看")
		: null;
	return el("div", null, wrap, hint);
}

/** bitable 预览：字段名做表头，记录做行。 */
function bitableTable(payload) {
	const fields = Array.isArray(payload?.fields) ? payload.fields : [];
	const rows = Array.isArray(payload?.rows) ? payload.rows : [];
	if (!fields.length || !rows.length) return el("div", { class: "fp-dc-placeholder" }, "多维表格没有数据或没有权限");
	const head = el("tr", null, ...fields.map((name) => el("th", null, String(name))));
	const body = rows.map((row) => el("tr", null, ...fields.map((name) => el("td", null, cellText(row?.[name])))));
	const wrap = el("div", { class: "fp-dc-tablewrap" }, el("table", { class: "fp-dc-table" }, head, ...body));
	const hint = payload?.truncated ? el("div", { class: "fp-dc-truncated" }, "仅显示前 20 条记录") : null;
	return el("div", null, wrap, hint);
}

function cellText(value) {
	if (value === null || value === undefined || value === "") return "-";
	if (Array.isArray(value)) return value.map(cellText).join("\n");
	if (typeof value === "object") return String(value.text ?? value.value ?? "-");
	return String(value);
}
