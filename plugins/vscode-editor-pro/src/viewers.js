/**
 * 查看器集合 —— 新插件相对 vscode-editor 的核心增量。
 *
 * 每种查看器都是 `({ file, rawUrl, conn, settings, openPath, toast }) → { dom, dispose? }`：
 * - image  图片：缩放（滚轮/按钮）、适应窗口、1:1、拖拽平移、棋盘格透明底、尺寸与体积
 * - media  视频/音频：原生 <video>/<audio>，走 raw 路由的 Range 断点续传
 * - pdf    浏览器内置阅读器（iframe），附「新标签打开 / 下载」
 * - font   字体：@font-face 注入 + 可变字号样张
 * - md     Markdown 预览（相对图片/链接按当前文件目录解析）
 * - csv    CSV/TSV 表格：分隔符自动识别、表头固定、行列号
 * - json   JSON 折叠树（含数组/对象计数、类型色）
 * - hex    二进制 Hex Dump：分页拉取（大小文件都不卡）、偏移跳转、ASCII 列
 * - info   无法内嵌预览的格式（Office/压缩包/未知二进制）：信息卡 + 下载/新标签
 *
 * 所有二进制内容都经 HTTP raw 路由按需分段取，不进 base64 报文，也不假设文本。
 */
import { esc, el, fmtBytes, fmtTime, baseName, parentOf, extOf } from "./util.js";
import { renderMarkdown } from "./md.js";

function shell(cls) {
	return el("div", { class: `vpro-viewer ${cls}` });
}

function infoBar(items) {
	const bar = el("div", { class: "vpro-vbar" });
	for (const it of items) {
		if (!it) continue;
		bar.appendChild(el("span", { class: "vpro-vbar-item", html: it }));
	}
	return bar;
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/**
 * 图片查看器。缩放用 CSS 像素尺寸（width/height）+ 原生滚动条，拖拽只改
 * scrollLeft/Top —— 比 transform 矩阵简单得多，也不会有「缩到角落」的怪现象。
 */
export function mountImageViewer(opts) {
	const { file, rawUrl, settings } = opts;
	const dom = shell("vpro-image");
	if (settings?.imageCheckerboard !== false) dom.classList.add("checker");

	const stage = el("div", { class: "vpro-img-stage" });
	const img = el("img", { class: "vpro-img", alt: file.name, draggable: "false" });
	img.src = rawUrl(file.path, { bust: file.mtime });
	const viewport = el("div", { class: "vpro-img-viewport" }, [stage]);
	stage.appendChild(img);

	const zoomLabel = el("span", { class: "vpro-zoom", text: "适应" });
	let scale = 0; // 0 = 适应窗口
	let natural = { w: file.dimensions?.width ?? 0, h: file.dimensions?.height ?? 0 };

	const applyScale = (next, keepCenter = true) => {
		const { w, h } = natural;
		if (!w || !h) return;
		const prev = {
			sl: viewport.scrollLeft,
			st: viewport.scrollTop,
			cw: viewport.clientWidth,
			ch: viewport.clientHeight,
		};
		scale = next;
		if (next === 0) {
			img.style.width = "";
			img.style.height = "";
			img.style.maxWidth = "100%";
			img.style.maxHeight = "100%";
			zoomLabel.textContent = "适应";
		} else {
			img.style.maxWidth = "none";
			img.style.maxHeight = "none";
			img.style.width = `${Math.round(w * next)}px`;
			img.style.height = `${Math.round(h * next)}px`;
			zoomLabel.textContent = `${Math.round(next * 100)}%`;
		}
		if (keepCenter && scale !== 0) {
			// 保持视图中心点在图上同一点
			viewport.scrollLeft = prev.sl + (viewport.clientWidth - prev.cw) / 2;
			viewport.scrollTop = prev.st + (viewport.clientHeight - prev.ch) / 2;
		}
	};

	const fit = () => applyScale(0, false);
	const zoomBy = (factor) => {
		const { w, h } = natural;
		if (!w || !h) return;
		const current = scale === 0 ? Math.min(viewport.clientWidth / w, viewport.clientHeight / h, 1) || 1 : scale;
		applyScale(Math.min(16, Math.max(0.05, current * factor)));
	};

	const buttons = el("div", { class: "vpro-img-tools" });
	const mkBtn = (label, title, fn) => {
		const b = el("button", { type: "button", class: "vpro-tool", title, text: label });
		b.addEventListener("click", fn);
		return b;
	};
	buttons.append(
		mkBtn("－", "缩小（Ctrl/⌘ + 滚轮）", () => zoomBy(1 / 1.25)),
		zoomLabel,
		mkBtn("＋", "放大（Ctrl/⌘ + 滚轮）", () => zoomBy(1.25)),
		mkBtn("适应", "适应窗口（双击图片）", fit),
		mkBtn("1:1", "原始像素", () => applyScale(1)),
	);

	// Ctrl/⌘ + 滚轮缩放；普通滚轮交给原生滚动
	const onWheel = (ev) => {
		if (!ev.ctrlKey && !ev.metaKey) return;
		ev.preventDefault();
		zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15);
	};
	viewport.addEventListener("wheel", onWheel, { passive: false });
	img.addEventListener("dblclick", () => (scale === 0 ? applyScale(1) : fit()));

	// 拖拽平移（pointer 事件，触屏也生效）
	let drag = null;
	const onPointerDown = (ev) => {
		if (ev.button !== 0) return;
		drag = { x: ev.clientX, y: ev.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop };
		img.classList.add("dragging");
		img.setPointerCapture?.(ev.pointerId);
	};
	const onPointerMove = (ev) => {
		if (!drag) return;
		viewport.scrollLeft = drag.sl - (ev.clientX - drag.x);
		viewport.scrollTop = drag.st - (ev.clientY - drag.y);
	};
	const onPointerUp = () => {
		drag = null;
		img.classList.remove("dragging");
	};
	img.addEventListener("pointerdown", onPointerDown);
	img.addEventListener("pointermove", onPointerMove);
	img.addEventListener("pointerup", onPointerUp);
	img.addEventListener("pointercancel", onPointerUp);

	const errBox = el("div", { class: "vpro-img-err vpro-hidden" });
	const showError = (msg) => {
		errBox.classList.remove("vpro-hidden");
		errBox.replaceChildren(
			el("div", { class: "vpro-empty-title", text: "浏览器无法解码这张图片" }),
			el("div", { class: "vpro-empty-sub", text: msg }),
			el("a", {
				class: "vpro-link",
				href: rawUrl(file.path, { download: true }),
				text: "下载原文件",
			}),
		);
	};

	img.addEventListener("load", () => {
		natural = { w: img.naturalWidth, h: img.naturalHeight };
		applyScale(scale, false);
	});
	img.addEventListener("error", () => showError(`${file.mime} 可能是不被当前浏览器支持的子格式（如 HEIC/TIFF）`));

	dom.append(
		viewport,
		buttons,
		infoBar([
			file.dimensions ? `${file.dimensions.width} × ${file.dimensions.height}` : null,
			esc(fmtBytes(file.size)),
			esc(file.mime),
		]),
		errBox,
	);

	const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => applyScale(scale, false)) : null;
	ro?.observe(viewport);

	return {
		dom,
		dispose() {
			ro?.disconnect();
			img.removeAttribute("src");
		},
	};
}

// ---------------------------------------------------------------------------
// 音视频
// ---------------------------------------------------------------------------

const UNPLAYABLE = new Set(["mov", "mkv", "avi", "wmv", "flv"]);

export function mountMediaViewer(opts) {
	const { file, rawUrl } = opts;
	const isVideo = file.kind === "video";
	const dom = shell(isVideo ? "vpro-video" : "vpro-audio");
	const src = rawUrl(file.path, { bust: file.mtime });
	const err = el("div", { class: "vpro-empty vpro-hidden" });
	const player = isVideo
		? el("video", {
				class: "vpro-media",
				controls: "controls",
				preload: "metadata",
				playsinline: "",
				src,
			})
		: el("audio", { class: "vpro-media-audio", controls: "controls", preload: "metadata", src });
	player.addEventListener("error", () => {
		err.classList.remove("vpro-hidden");
		err.replaceChildren(
			el("div", { class: "vpro-empty-title", text: "浏览器无法播放该媒体" }),
			el("div", {
				class: "vpro-empty-sub",
				text: UNPLAYABLE.has(extOf(file.name))
					? `${extOf(file.name).toUpperCase()} 容器/编码通常不被浏览器支持，可用桌面播放器打开原文件。`
					: "编码可能不在浏览器支持范围内（如 H.265 / AC-3）。",
			}),
			el("a", { class: "vpro-link", href: rawUrl(file.path, { download: true }), text: "下载原文件" }),
		);
	});
	const meta = el("div", { class: "vpro-media-meta" });
	const fmtDuration = (s) => {
		if (!Number.isFinite(s) || s <= 0) return "—";
		const total = Math.round(s);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const sec = total % 60;
		return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(sec).padStart(2, "0")}`;
	};
	player.addEventListener("loadedmetadata", () => {
		meta.replaceChildren(
			el("span", { text: `时长 ${fmtDuration(player.duration)}` }),
			el("span", { text: `${player.videoWidth ? `${player.videoWidth}×${player.videoHeight}` : ""}`.trim() || "音频" }),
			el("span", { text: fmtBytes(file.size) }),
			el("span", { text: file.mime }),
		);
	});
	dom.append(player, meta, err);
	return {
		dom,
		dispose() {
			try {
				player.pause();
			} catch {}
			player.removeAttribute("src");
			player.load?.();
		},
	};
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function mountPdfViewer(opts) {
	const { file, rawUrl } = opts;
	const dom = shell("vpro-pdf");
	const src = rawUrl(file.path, { bust: file.mtime });
	const frame = el("iframe", { class: "vpro-pdf-frame", src, title: file.name });
	dom.append(
		infoBar([
			`${esc(fmtBytes(file.size))} · ${esc(file.mime)}`,
			`<a class="vpro-link" href="${esc(src)}" target="_blank" rel="noopener">新标签打开</a>`,
			`<a class="vpro-link" href="${esc(rawUrl(file.path, { download: true }))}">下载</a>`,
		]),
		frame,
		el("div", {
			class: "vpro-hint",
			text: "由浏览器内置 PDF 阅读器渲染；若是一片空白，说明浏览器禁用了内嵌 PDF（Safari/iOS 常见），点上面的「新标签打开」。",
		}),
	);
	return { dom };
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

export function mountFontViewer(opts) {
	const { file, rawUrl } = opts;
	const dom = shell("vpro-font");
	const family = `vproFont${Math.random().toString(36).slice(2, 9)}`;
	const style = document.createElement("style");
	style.textContent = `@font-face{font-family:"${family}";src:url("${rawUrl(file.path, { bust: file.mtime })}");font-display:swap;}`;
	const sample = el("input", {
		class: "vpro-font-input",
		type: "text",
		value: "永The quick brown fox 0123456789 你好，世界",
		"aria-label": "预览文本",
	});
	const rows = el("div", { class: "vpro-font-rows" });
	const sizes = [12, 16, 20, 28, 40, 64];
	for (const size of sizes) {
		rows.appendChild(
			el("div", { class: "vpro-font-row" }, [
				el("span", { class: "vpro-font-size", text: `${size}px` }),
				el("span", {
					class: "vpro-font-sample",
					style: `font-family:"${family}",sans-serif;font-size:${size}px`,
					text: sample.value,
				}),
			]),
		);
	}
	sample.addEventListener("input", () => {
		for (const node of rows.querySelectorAll(".vpro-font-sample")) node.textContent = sample.value;
	});
	dom.append(
		style,
		sample,
		rows,
		infoBar([esc(fmtBytes(file.size)), esc(file.mime), esc(file.name)]),
		el("div", {
			class: "vpro-hint",
			text: "字体由浏览器按需渲染；WOFF2 体积最小，TTF/OTF 兼容性最好。",
		}),
	);
	return {
		dom,
		dispose() {
			style.remove();
		},
	};
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function rootPath(rel) {
	// 判断相对引用是否「离开」当前目录（超出工作区根的 ../ 一律丢弃）
	return parentOf(rel);
}

export function mountMarkdownViewer(opts) {
	const { file, rawUrl, openPath } = opts;
	const dom = shell("vpro-md");
	const body = el("article", { class: "vpro-md-body" });
	const dir = rootPath(file.path);
	const resolve = {
		image: (href) => {
			if (/^(https?:|data:)/i.test(href)) return href;
			if (href.startsWith("/")) return href; // 站点绝对路径：保持原样
			const rel = normalizeJoin(dir, href);
			return rel ? rawUrl(rel) : href;
		},
		link: (href) => {
			if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
			if (href.startsWith("#")) return href;
			if (openPath) {
				const rel = normalizeJoin(dir, href.split("#")[0]);
				if (rel) {
					// 交给调用方接管（拦截默认跳转）
					return `#vpro-open:${encodeURIComponent(rel)}`;
				}
			}
			const rel = normalizeJoin(dir, href.split("#")[0]);
			return rel ? rawUrl(rel) : href;
		},
	};
	body.appendChild(renderMarkdown(file.text ?? "", { resolve }));
	body.addEventListener("click", (ev) => {
		const a = ev.target.closest?.("a.vpro-md-link");
		if (!a || !openPath) return;
		const href = a.getAttribute("href") ?? "";
		if (!href.startsWith("#vpro-open:")) return;
		ev.preventDefault();
		openPath(decodeURIComponent(href.slice("#vpro-open:".length)));
	});
	dom.append(body, infoBar([esc(fmtBytes(file.size)), "Markdown", esc(file.path)]));
	return { dom };
}

/** 相对路径归一化：越出工作区根（../ 过多）返回 null。 */
export function normalizeJoin(dir, rel) {
	const clean = String(rel ?? "")
		.replace(/\\/g, "/")
		.split("#")[0]
		.split("?")[0]
		.trim();
	if (!clean) return null;
	const segs = (dir ? `${dir}/` : "").split("/").filter(Boolean);
	for (const part of clean.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!segs.length) return null;
			segs.pop();
			continue;
		}
		segs.push(part);
	}
	return segs.join("/");
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/** 引号感知的逐行解析（支持 "" 转义与字段内换行）。 */
export function parseDelimited(text, delimiter) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	const src = String(text ?? "");
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"' && field === "") {
			quoted = true;
			continue;
		}
		if (c === delimiter) {
			row.push(field);
			field = "";
			continue;
		}
		if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			continue;
		}
		field += c;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** 分隔符识别：前 50 行按「每行字段数方差最小 + 字段数 >1」打分。 */
export function detectDelimiter(text) {
	const sample = String(text ?? "")
		.split(/\r?\n/)
		.slice(0, 50)
		.filter((l) => l.trim())
		.join("\n");
	let best = { delimiter: ",", score: -1 };
	for (const delimiter of [",", "\t", ";", "|"]) {
		const rows = parseDelimited(sample, delimiter).slice(0, 50);
		if (!rows.length) continue;
		const counts = rows.map((r) => r.length);
		if (Math.max(...counts) < 2) continue;
		const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
		const variance = counts.reduce((a, b) => a + (b - avg) ** 2, 0) / counts.length;
		const score = avg * 2 - variance;
		if (score > best.score) best = { delimiter, score };
	}
	return best.delimiter;
}

export function mountCsvViewer(opts) {
	const { file } = opts;
	const dom = shell("vpro-csv");
	const text = String(file.text ?? "");
	let delimiter = extOf(file.name) === "tsv" ? "\t" : detectDelimiter(text);
	const MAX_ROWS = 5000;
	const MAX_COLS = 80;
	let header = true;

	const tools = el("div", { class: "vpro-table-tools" });
	const tableWrap = el("div", { class: "vpro-table-wrap" });
	const status = el("span", { class: "vpro-table-status" });
	const delimSelect = el("select", { class: "vpro-select", "aria-label": "分隔符" });
	for (const [value, label] of [
		[",", "逗号 ,"],
		["\t", "制表符 ⇥"],
		[";", "分号 ;"],
		["|", "竖线 |"],
	]) {
		delimSelect.appendChild(el("option", { value, text: label, selected: value === delimiter ? true : undefined }));
	}
	delimSelect.addEventListener("change", () => {
		delimiter = delimSelect.value;
		render();
	});
	const headerToggle = el("label", { class: "vpro-check" }, [
		el("input", { type: "checkbox", checked: header ? "" : undefined }),
		el("span", { text: "首行为表头" }),
	]);
	headerToggle.querySelector("input").addEventListener("change", (ev) => {
		header = ev.target.checked;
		render();
	});
	tools.append(delimSelect, headerToggle, status);

	function render() {
		const rows = parseDelimited(text, delimiter);
		const dataRows = header ? rows.slice(1) : rows;
		const cols = Math.max(1, ...rows.map((r) => r.length));
		const shownRows = dataRows.slice(0, MAX_ROWS);
		const shownCols = Math.min(cols, MAX_COLS);
		const table = el("table", { class: "vpro-table" });
		if (header && rows.length) {
			const thead = el("thead");
			const tr = el("tr");
			tr.appendChild(el("th", { class: "vpro-th-index", text: "#" }));
			for (let c = 0; c < shownCols; c++) tr.appendChild(el("th", { text: rows[0][c] ?? "" }));
			thead.appendChild(tr);
			table.appendChild(thead);
		}
		const tbody = el("tbody");
		for (const [idx, row] of shownRows.entries()) {
			const tr = el("tr");
			tr.appendChild(el("td", { class: "vpro-td-index", text: String(header ? idx + 2 : idx + 1) }));
			for (let c = 0; c < shownCols; c++) {
				const cell = row[c] ?? "";
				const td = el("td", { title: cell.length > 120 ? cell : undefined });
				td.textContent = cell.length > 4000 ? `${cell.slice(0, 4000)}…` : cell;
				if (/^-?\d+(\.\d+)?$/.test(cell.trim()) && cell.trim().length < 20) td.classList.add("num");
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		tableWrap.replaceChildren(table);
		const notes = [`${rows.length} 行 × ${cols} 列`];
		if (dataRows.length > MAX_ROWS) notes.push(`仅显示前 ${MAX_ROWS} 行`);
		if (cols > MAX_COLS) notes.push(`仅显示前 ${MAX_COLS} 列`);
		status.textContent = notes.join(" · ");
	}

	render();
	dom.append(tools, tableWrap);
	return { dom };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function jsonValueNode(value, depth) {
	if (value === null) return el("span", { class: "vpro-json-null", text: "null" });
	const type = typeof value;
	if (type === "string") {
		const s = value;
		const short = s.length > 300 ? `${s.slice(0, 300)}…` : s;
		return el("span", { class: "vpro-json-str", text: JSON.stringify(short) });
	}
	if (type === "number") return el("span", { class: "vpro-json-num", text: String(value) });
	if (type === "boolean") return el("span", { class: "vpro-json-bool", text: String(value) });
	if (Array.isArray(value)) {
		const details = el("details", { class: "vpro-json-node", open: depth < 2 ? "" : undefined });
		details.appendChild(el("summary", {}, [el("span", { class: "vpro-json-badge", text: `Array(${value.length})` })]));
		const body = el("div", { class: "vpro-json-children" });
		for (const [idx, item] of value.entries()) {
			body.appendChild(
				el("div", { class: "vpro-json-row" }, [
					el("span", { class: "vpro-json-key", text: String(idx) }),
					jsonValueNode(item, depth + 1),
				]),
			);
		}
		details.appendChild(body);
		return details;
	}
	if (type === "object") {
		const keys = Object.keys(value);
		const details = el("details", { class: "vpro-json-node", open: depth < 2 ? "" : undefined });
		details.appendChild(el("summary", {}, [el("span", { class: "vpro-json-badge", text: `Object(${keys.length})` })]));
		const body = el("div", { class: "vpro-json-children" });
		for (const key of keys) {
			body.appendChild(
				el("div", { class: "vpro-json-row" }, [
					el("span", { class: "vpro-json-key", text: key }),
					jsonValueNode(value[key], depth + 1),
				]),
			);
		}
		details.appendChild(body);
		return details;
	}
	return el("span", { class: "vpro-json-other", text: String(value) });
}

export function mountJsonViewer(opts) {
	const { file } = opts;
	const dom = shell("vpro-json");
	const text = String(file.text ?? "");
	if (file.kind === "jsonl") {
		const lines = text.split(/\r?\n/).filter((l) => l.trim());
		const list = el("div", { class: "vpro-jsonl" });
		for (const [idx, line] of lines.slice(0, 2000).entries()) {
			let parsed;
			let ok = true;
			try {
				parsed = JSON.parse(line);
			} catch {
				ok = false;
			}
			const row = el("div", { class: "vpro-jsonl-row" }, [
				el("span", { class: "vpro-jsonl-idx", text: String(idx + 1) }),
				ok ? jsonValueNode(parsed, 1) : el("code", { class: "vpro-jsonl-raw", text: line.slice(0, 500) }),
			]);
			list.appendChild(row);
		}
		dom.append(
			infoBar([`${lines.length} 条记录${lines.length > 2000 ? "（显示前 2000 条）" : ""}`, esc(fmtBytes(file.size))]),
			list,
		);
		return { dom };
	}
	let parsed;
	let error = null;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		error = err?.message ?? String(err);
	}
	if (error) {
		dom.append(
			el("div", { class: "vpro-empty" }, [
				el("div", { class: "vpro-empty-title", text: "JSON 解析失败" }),
				el("div", { class: "vpro-empty-sub", text: error }),
				el("div", { class: "vpro-empty-sub", text: "切到「源码」可以逐行看原文。" }),
			]),
		);
		return { dom };
	}
	const toolRow = el("div", { class: "vpro-table-tools" });
	const expand = el("button", { type: "button", class: "vpro-tool", text: "全部展开" });
	const collapse = el("button", { type: "button", class: "vpro-tool", text: "全部折叠" });
	expand.addEventListener("click", () => {
		for (const d of dom.querySelectorAll("details")) d.open = true;
	});
	collapse.addEventListener("click", () => {
		for (const d of dom.querySelectorAll("details")) d.open = false;
	});
	toolRow.append(expand, collapse);
	const tree = el("div", { class: "vpro-json-tree" }, [jsonValueNode(parsed, 0)]);
	dom.append(toolRow, tree, infoBar([esc(fmtBytes(file.size)), esc(file.encoding ?? "utf-8")]));
	return { dom };
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

const HEX_PAGE = 8 * 1024; // 每次拉 8KB（512 行）

export function mountHexViewer(opts) {
	const { file, conn, toast } = opts;
	const dom = shell("vpro-hex");
	const toolbar = el("div", { class: "vpro-table-tools" });
	const status = el("span", { class: "vpro-table-status" });
	const prev = el("button", { type: "button", class: "vpro-tool", text: "‹ 上一页" });
	const next = el("button", { type: "button", class: "vpro-tool", text: "下一页 ›" });
	const jump = el("input", {
		type: "number",
		class: "vpro-input",
		min: "0",
		placeholder: "跳转到偏移",
		"aria-label": "跳转到偏移",
	});
	const jumpBtn = el("button", { type: "button", class: "vpro-tool", text: "跳转" });
	toolbar.append(prev, next, jump, jumpBtn, status);
	const body = el("div", { class: "vpro-hex-body" });
	const total = Number(file.size) || 0;
	let offset = 0;

	const hex = (n) => n.toString(16).padStart(2, "0");
	const rowOf = (bytes, start) => {
		const cells = el("div", { class: "vpro-hex-row" });
		const parts = [];
		for (let i = 0; i < 16; i++) parts.push(i < bytes.length ? hex(bytes[i]) : "  ");
		cells.appendChild(el("span", { class: "vpro-hex-off", text: start.toString(16).padStart(8, "0") }));
		cells.appendChild(el("span", { class: "vpro-hex-bytes", text: parts.slice(0, 8).join(" ") }));
		cells.appendChild(el("span", { class: "vpro-hex-bytes", text: parts.slice(8).join(" ") }));
		let ascii = "";
		for (const b of bytes) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
		cells.appendChild(el("span", { class: "vpro-hex-ascii", text: ascii }));
		return cells;
	};

	async function load(start) {
		const clamped = Math.max(0, Math.min(start, Math.max(0, total - 1)));
		const res = await conn.req({ action: "read_bytes", path: file.path, offset: clamped, length: HEX_PAGE });
		if (!res.ok) {
			toast?.(`读取失败：${res.error ?? "未知错误"}`);
			return;
		}
		offset = clamped;
		const bytes = Uint8Array.from(atob(res.b64 ?? ""), (c) => c.charCodeAt(0));
		const frag = document.createDocumentFragment();
		for (let i = 0; i < bytes.length; i += 16) frag.appendChild(rowOf(bytes.subarray(i, i + 16), offset + i));
		body.replaceChildren(frag);
		status.textContent = `${offset.toLocaleString()} – ${(offset + bytes.length).toLocaleString()} / ${total.toLocaleString()} 字节`;
		prev.disabled = offset <= 0;
		next.disabled = offset + bytes.length >= total;
	}

	prev.addEventListener("click", () => void load(Math.max(0, offset - HEX_PAGE)));
	next.addEventListener("click", () => void load(offset + HEX_PAGE));
	jumpBtn.addEventListener("click", () => void load(Number(jump.value) || 0));
	jump.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") void load(Number(jump.value) || 0);
	});
	void load(0);

	dom.append(infoBar([esc(fmtBytes(file.size)), esc(file.mime), esc(file.encoding ?? "binary")]), toolbar, body);
	return { dom };
}

// ---------------------------------------------------------------------------
// 信息卡（Office / 压缩包 / 未知二进制）
// ---------------------------------------------------------------------------

const KIND_HINT = {
	office:
		"Office 文档需要专门的渲染引擎。装 `@plugins/office` 插件可直接在宿主文件树里打开 docx/xlsx/pptx；这里先提供下载与原样字节访问。",
	binary: "这是二进制文件（压缩包/可执行文件/数据库等），不按文本打开。可用 Hex 视图看字节，或下载到本地处理。",
	image: "浏览器无法解码该图片格式。",
};

export function mountInfoViewer(opts) {
	const { file, rawUrl, onSwitchView } = opts;
	const dom = shell("vpro-info");
	const card = el("div", { class: "vpro-empty" }, [
		el("div", { class: "vpro-empty-title", text: baseName(file.name) }),
		el("div", { class: "vpro-empty-sub", text: KIND_HINT[file.kind] ?? "暂无内嵌查看器。" }),
		el("div", { class: "vpro-kv" }, [
			el("span", { text: "类型" }),
			el("b", { text: file.mime || "unknown" }),
			el("span", { text: "大小" }),
			el("b", { text: fmtBytes(file.size) }),
			el("span", { text: "修改时间" }),
			el("b", { text: fmtTime(file.mtime) }),
			el("span", { text: "路径" }),
			el("b", { class: "vpro-wrap", text: file.path }),
		]),
		el("div", { class: "vpro-empty-actions" }, [
			el("a", { class: "vpro-btn", href: rawUrl(file.path, { download: true }), text: "⬇ 下载" }),
			el("a", { class: "vpro-btn", href: rawUrl(file.path), target: "_blank", rel: "noopener", text: "↗ 新标签打开" }),
			onSwitchView
				? el("button", {
						type: "button",
						class: "vpro-btn",
						text: "⧉ 以 Hex 查看",
						onclick: () => onSwitchView("hex"),
					})
				: null,
		]),
	]);
	dom.appendChild(card);
	return { dom };
}
