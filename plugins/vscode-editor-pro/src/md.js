/**
 * 零依赖 Markdown → DOM 渲染器（安全优先）。
 *
 * 与 live-preview 的字符串渲染器不同，这里直接产出 DOM 节点：**任何文本都先
 * 转义再进 DOM**，不拼 innerHTML，因此 Markdown/MDX 里的裸 HTML、`<script>`、
 * `onerror=` 之类都不会被解释（预览里没有 XSS 面）。
 *
 * 支持：ATX 标题、围栏代码块（``` / ~~~，带语言标签与复制键）、引用、有序/无序
 * 列表（含两级缩进与任务复选框）、表格（对齐）、分割线、段落、行内代码、粗体、
 * 斜体、删除线、链接、图片（相对路径经 resolveImage 落到插件 raw 路由）、裸链接。
 */

const SAFE_SCHEME = /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;

function safeHref(raw) {
	const url = String(raw ?? "").trim();
	if (!url) return null;
	// 允许无协议的相对路径（a/b.md、img.png）；显式协议的走白名单
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		if (!/^(https?:|mailto:|tel:)/i.test(url)) return null;
		return url;
	}
	return SAFE_SCHEME.test(url) || !url.includes(":") ? url : null;
}

/** 行内解析：纯文本先转义，再把受支持的标记转成节点。 */
export function inlineNodes(text, resolve = {}) {
	const out = [];
	const src = String(text ?? "");
	let i = 0;
	let buf = "";
	const flush = () => {
		if (buf) {
			out.push(document.createTextNode(buf));
			buf = "";
		}
	};
	while (i < src.length) {
		const rest = src.slice(i);
		const ch = src[i];
		// 行内代码
		if (ch === "`") {
			const m = /^(`+)([\s\S]*?)\1/.exec(rest);
			if (m) {
				flush();
				out.push(
					Object.assign(document.createElement("code"), {
						className: "vpro-md-code",
						textContent: m[2].trim(),
					}),
				);
				i += m[0].length;
				continue;
			}
		}
		// 图片
		if (ch === "!" && src[i + 1] === "[") {
			const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(rest);
			if (m) {
				flush();
				const href = safeHref(m[2]);
				if (href) {
					const img = document.createElement("img");
					img.className = "vpro-md-img";
					img.alt = m[1] || "";
					img.loading = "lazy";
					img.src = resolve.image ? resolve.image(href) : href;
					img.addEventListener("click", () => window.open(img.src, "_blank", "noopener"));
					out.push(img);
				} else {
					buf += m[1] || "";
				}
				i += m[0].length;
				continue;
			}
		}
		// 链接
		if (ch === "[") {
			const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(rest);
			if (m) {
				flush();
				const href = safeHref(m[2]);
				if (href) {
					const a = document.createElement("a");
					a.className = "vpro-md-link";
					a.textContent = m[1] || m[2];
					a.href = resolve.link ? resolve.link(href) : href;
					a.target = "_blank";
					a.rel = "noopener noreferrer";
					if (m[3]) a.title = m[3];
					out.push(a);
				} else {
					buf += m[1] || "";
				}
				i += m[0].length;
				continue;
			}
		}
		// 粗体 / 斜体 / 删除线
		const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
		if (strong) {
			flush();
			const node = document.createElement("strong");
			node.append(...inlineNodes(strong[2], resolve));
			out.push(node);
			i += strong[0].length;
			continue;
		}
		const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest);
		if (em) {
			flush();
			const node = document.createElement("em");
			node.append(...inlineNodes(em[2], resolve));
			out.push(node);
			i += em[0].length;
			continue;
		}
		const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
		if (strike) {
			flush();
			const node = document.createElement("del");
			node.textContent = strike[1];
			out.push(node);
			i += strike[0].length;
			continue;
		}
		// 裸链接
		const auto = /^(https?:\/\/[^\s<>"'`]+)/.exec(rest);
		if (auto && !/[a-z0-9]/i.test(src[i - 1] ?? "")) {
			flush();
			const a = document.createElement("a");
			a.className = "vpro-md-link";
			a.href = auto[1];
			a.textContent = auto[1];
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			out.push(a);
			i += auto[0].length;
			continue;
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

function headingNode(level, text, resolve) {
	const node = document.createElement(`h${Math.min(6, Math.max(1, level))}`);
	node.className = "vpro-md-h";
	node.append(...inlineNodes(text, resolve));
	return node;
}

function codeBlockNode(lang, code) {
	const wrap = document.createElement("div");
	wrap.className = "vpro-md-pre";
	const bar = document.createElement("div");
	bar.className = "vpro-md-pre-bar";
	const label = document.createElement("span");
	label.className = "vpro-md-pre-lang";
	label.textContent = lang || "text";
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "vpro-md-pre-copy";
	copy.textContent = "复制";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(code);
			copy.textContent = "已复制";
			setTimeout(() => {
				copy.textContent = "复制";
			}, 1200);
		} catch {
			copy.textContent = "复制失败";
		}
	});
	bar.append(label, copy);
	const pre = document.createElement("pre");
	pre.className = "vpro-md-pre-body";
	const codeEl = document.createElement("code");
	codeEl.textContent = code;
	pre.appendChild(codeEl);
	wrap.append(bar, pre);
	return wrap;
}

function tableNode(rows, aligns, resolve) {
	const table = document.createElement("table");
	table.className = "vpro-md-table";
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const [idx, cell] of rows[0].entries()) {
		const th = document.createElement("th");
		th.append(...inlineNodes(cell, resolve));
		const a = aligns[idx];
		if (a) th.style.textAlign = a;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	const tbody = document.createElement("tbody");
	for (const row of rows.slice(1)) {
		const tr = document.createElement("tr");
		for (let idx = 0; idx < rows[0].length; idx++) {
			const td = document.createElement("td");
			td.append(...inlineNodes(row[idx] ?? "", resolve));
			const a = aligns[idx];
			if (a) td.style.textAlign = a;
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.append(thead, tbody);
	return table;
}

function splitRow(line) {
	const cells = [];
	let cur = "";
	let inCode = false;
	const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (c === "`") inCode = !inCode;
		if (c === "|" && !inCode) {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	cells.push(cur.trim());
	return cells;
}

function parseAligns(sepLine) {
	return splitRow(sepLine).map((c) => {
		const left = c.startsWith(":");
		const right = c.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return "";
	});
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

/** 主入口：把 Markdown 源码渲染成 DocumentFragment。 */
export function renderMarkdown(src, opts = {}) {
	const resolve = opts.resolve ?? {};
	const lines = String(src ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const frag = document.createDocumentFragment();
	let i = 0;
	const consumeParagraph = () => {
		const buf = [];
		while (i < lines.length) {
			const line = lines[i];
			if (!line.trim()) break;
			if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) break;
			if (UL_RE.test(line) || OL_RE.test(line)) break;
			// 表格：本行含 | 且下一行是分隔行
			if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) break;
			buf.push(line);
			i++;
		}
		if (buf.length) {
			const p = document.createElement("p");
			p.className = "vpro-md-p";
			// 行尾双空格 = 硬换行
			for (const [idx, line] of buf.entries()) {
				p.append(
					...inlineNodes(
						line.replace(/\s+$/, (m) => (m.length >= 2 ? "\u0000" : "")),
						resolve,
					),
				);
				const last = p.lastChild;
				if (idx < buf.length - 1) {
					if (last && last.nodeType === 3 && last.textContent?.endsWith("\u0000")) {
						last.textContent = last.textContent.slice(0, -1);
						p.appendChild(document.createElement("br"));
					} else {
						p.appendChild(document.createTextNode(" "));
					}
				} else if (last && last.nodeType === 3) {
					last.textContent = last.textContent.replace(/\u0000/g, "");
				}
			}
			frag.appendChild(p);
		}
	};

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		// 围栏代码块
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const len = fence[1].length;
			const lang = fence[2] ?? "";
			const body = [];
			i++;
			while (i < lines.length) {
				const close = new RegExp(`^\\s{0,3}${marker === "`" ? "`" : "~"}{${len},}\\s*$`);
				if (close.test(lines[i])) {
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			frag.appendChild(codeBlockNode(lang, body.join("\n")));
			continue;
		}
		// 标题
		const heading = HEADING_RE.exec(line);
		if (heading) {
			frag.appendChild(headingNode(heading[1].length, heading[2].replace(/\s+#+\s*$/, ""), resolve));
			i++;
			continue;
		}
		// 分割线
		if (HR_RE.test(line)) {
			const hr = document.createElement("hr");
			hr.className = "vpro-md-hr";
			frag.appendChild(hr);
			i++;
			continue;
		}
		// 引用
		if (QUOTE_RE.test(line)) {
			const buf = [];
			while (i < lines.length && (QUOTE_RE.test(lines[i]) || (!lines[i].trim() && QUOTE_RE.test(lines[i + 1] ?? "")))) {
				const m = QUOTE_RE.exec(lines[i]);
				buf.push(m ? m[1] : "");
				i++;
			}
			const quote = document.createElement("blockquote");
			quote.className = "vpro-md-quote";
			quote.appendChild(renderMarkdown(buf.join("\n"), opts));
			frag.appendChild(quote);
			continue;
		}
		// 表格
		if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
			const rows = [splitRow(line)];
			const aligns = parseAligns(lines[i + 1]);
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
				rows.push(splitRow(lines[i]));
				i++;
			}
			frag.appendChild(tableNode(rows, aligns, resolve));
			continue;
		}
		// 列表（支持两级缩进 + 任务框）
		if (UL_RE.test(line) || OL_RE.test(line)) {
			const { list, next } = parseList(lines, i, resolve);
			frag.appendChild(list);
			i = next;
			continue;
		}
		consumeParagraph();
	}
	return frag;
}

function parseList(lines, start, resolve) {
	const first = UL_RE.exec(lines[start]) ?? OL_RE.exec(lines[start]);
	const ordered = !UL_RE.test(lines[start]);
	const baseIndent = first[1].length;
	const list = document.createElement(ordered ? "ol" : "ul");
	list.className = "vpro-md-list";
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			// 空行：后面还是同类列表就继续，否则结束
			const nxt = lines[i + 1] ?? "";
			if (UL_RE.test(nxt) || OL_RE.test(nxt)) {
				i++;
				continue;
			}
			break;
		}
		const m = UL_RE.exec(line) ?? OL_RE.exec(line);
		if (!m) break;
		const indent = m[1].length;
		if (indent < baseIndent) break;
		const text = m[3];
		if (indent > baseIndent) {
			// 嵌套：挂到上一个 li 里
			const { list: sub, next } = parseList(lines, i, resolve);
			(list.lastElementChild ?? list).appendChild(sub);
			i = next;
			continue;
		}
		const li = document.createElement("li");
		const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
		if (task) {
			const box = document.createElement("input");
			box.type = "checkbox";
			box.disabled = true;
			box.checked = task[1].toLowerCase() === "x";
			box.className = "vpro-md-task";
			li.appendChild(box);
			li.append(...inlineNodes(task[2], resolve));
		} else {
			li.append(...inlineNodes(text, resolve));
		}
		list.appendChild(li);
		i++;
	}
	return { list, next: i };
}
