/**
 * vscode-editor-pro 服务端入口 —— 多格式查看器的文件后端。
 *
 * 约定：ESM 默认导出 { activate(host) → deactivate? }。
 *
 * 两条通道：
 * 1) WS `plugin_message`：{ action, reqId, ... } 上行，`host.sendTo` 定向回包（带 reqId 匹配并发）。
 *    action = ping/list/open/stat/read_bytes/write/mkdir/create/rename/delete/search
 *             search_content（全工作区/指定目录的内容搜索）· replace_content（批量替换）
 * 2) HTTP `/plugins-api/vscode-editor-pro/raw?path=…`：**原始字节流**（Range / 206 断点续传）。
 *    图片、PDF、视频、音频、字体都走它——不再把二进制塞进 base64 报文，
 *    浏览器因此能原生解码、拖进度条、按需分段拉取大文件。
 *
 * 安全：
 * - 所有 path 必须是相对工作区根（host.cwd 的活值）的相对路径；resolve 后必须仍在根内，
 *   越界/绝对路径/`..` 一律拒绝；写前再做一次 realpath 校验（防符号链接穿出）。
 * - 目录遍历跳过 node_modules/.git 等噪音目录；文本读取有上限，超出只回前缀并标记 truncated。
 * - 内容搜索（grep）只读文本类文件：先按扩展名筛，再按内容嗅探二进制，单文件有体积上限，
 *   总文件数/总命中数/耗时都有预算；批量替换只写 UTF-8 文本文件（其余记进 skipped），
 *   沿用 tmp+rename 原子落盘，写前 realpath 校验。
 */

import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";

/** 列目录/搜索时跳过的噪音目录 */
const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".pi-web",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"dist",
	"build",
	"out",
	"coverage",
	"venv",
	".venv",
	".mypy_cache",
	"__pycache__",
	"target",
	".DS_Store",
]);

const MAX_TEXT_BYTES = 4 * 1024 * 1024; // 文本预览/编辑上限（超出只回前缀）
const MAX_HEAD_BYTES = 96 * 1024; // 嗅探头部（图片尺寸、二进制判定）
const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024; // 单次流式响应上限（2GB，防误点巨型文件）
const MAX_SEARCH_MATCHES = 300;
const MAX_SEARCH_VISIT = 40000;
const MAX_SEARCH_DEPTH = 14;
const MAX_BYTES_CHUNK = 512 * 1024; // read_bytes 单次上限（hex 视图分页）

// ---- 内容搜索（grep）预算：宁可截断也不能把主进程拖死 ----
const MAX_CONTENT_FILES = 6000; // 单次搜索最多读多少个文件
const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024; // 单文件超过就不搜（避免整库 grep 卡住）
const MAX_CONTENT_MATCHES = 2000; // 总命中上限（超出标记 truncated）
const MAX_CONTENT_PER_FILE = 200; // 单文件命中上限
const CONTENT_BUDGET_MS = 9000; // 单次搜索墙钟预算
const MAX_REPLACE_FILES = 400; // 单次批量替换最多改多少个文件
const PREVIEW_MAX = 400; // 结果行预览最多多少字符

/** 扩展名 → 查看器 + MIME。kind 是查看器契约（客户端按它选渲染器）。 */
const TYPES = {
	// ---- 图片：原生解码 + 缩放/平移 ----
	png: ["image", "image/png"],
	apng: ["image", "image/apng"],
	jpg: ["image", "image/jpeg"],
	jpeg: ["image", "image/jpeg"],
	jfif: ["image", "image/jpeg"],
	pjpeg: ["image", "image/jpeg"],
	pjp: ["image", "image/jpeg"],
	gif: ["image", "image/gif"],
	webp: ["image", "image/webp"],
	avif: ["image", "image/avif"],
	bmp: ["image", "image/bmp"],
	ico: ["image", "image/x-icon"],
	cur: ["image", "image/x-icon"],
	tif: ["image", "image/tiff"],
	tiff: ["image", "image/tiff"],
	heic: ["image", "image/heic"],
	heif: ["image", "image/heif"],
	// ---- SVG：图像 / 源码双模 ----
	svg: ["svg", "image/svg+xml"],
	svgz: ["svg", "image/svg+xml"],
	// ---- 文档 ----
	pdf: ["pdf", "application/pdf"],
	// ---- 音视频 ----
	mp4: ["video", "video/mp4"],
	m4v: ["video", "video/mp4"],
	webm: ["video", "video/webm"],
	ogv: ["video", "video/ogg"],
	mov: ["video", "video/quicktime"],
	mkv: ["video", "video/x-matroska"],
	avi: ["video", "video/x-msvideo"],
	mp3: ["audio", "audio/mpeg"],
	wav: ["audio", "audio/wav"],
	ogg: ["audio", "audio/ogg"],
	oga: ["audio", "audio/ogg"],
	opus: ["audio", "audio/ogg"],
	flac: ["audio", "audio/flac"],
	m4a: ["audio", "audio/mp4"],
	aac: ["audio", "audio/aac"],
	weba: ["audio", "audio/webm"],
	// ---- 字体 ----
	ttf: ["font", "font/ttf"],
	otf: ["font", "font/otf"],
	woff: ["font", "font/woff"],
	woff2: ["font", "font/woff2"],
	// ---- 结构化文本（专用查看器）----
	md: ["markdown", "text/markdown; charset=utf-8"],
	markdown: ["markdown", "text/markdown; charset=utf-8"],
	mdx: ["markdown", "text/markdown; charset=utf-8"],
	csv: ["csv", "text/csv; charset=utf-8"],
	tsv: ["csv", "text/tab-separated-values; charset=utf-8"],
	json: ["json", "application/json; charset=utf-8"],
	jsonc: ["json", "application/json; charset=utf-8"],
	json5: ["code", "application/json; charset=utf-8"],
	ndjson: ["jsonl", "application/x-ndjson; charset=utf-8"],
	jsonl: ["jsonl", "application/x-ndjson; charset=utf-8"],
	// ---- 无法渲染的二进制：信息卡 + 下载 ----
	zip: ["binary", "application/zip"],
	gz: ["binary", "application/gzip"],
	tgz: ["binary", "application/gzip"],
	tar: ["binary", "application/x-tar"],
	xz: ["binary", "application/x-xz"],
	bz2: ["binary", "application/x-bzip2"],
	"7z": ["binary", "application/x-7z-compressed"],
	rar: ["binary", "application/vnd.rar"],
	exe: ["binary", "application/vnd.microsoft.portable-executable"],
	dll: ["binary", "application/vnd.microsoft.portable-executable"],
	so: ["binary", "application/octet-stream"],
	dylib: ["binary", "application/octet-stream"],
	bin: ["binary", "application/octet-stream"],
	dat: ["binary", "application/octet-stream"],
	db: ["binary", "application/vnd.sqlite3"],
	sqlite: ["binary", "application/vnd.sqlite3"],
	sqlite3: ["binary", "application/vnd.sqlite3"],
	wasm: ["binary", "application/wasm"],
	doc: ["office", "application/msword"],
	docx: ["office", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	xls: ["office", "application/vnd.ms-excel"],
	xlsx: ["office", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	ppt: ["office", "application/vnd.ms-powerpoint"],
	pptx: ["office", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	odt: ["office", "application/vnd.oasis.opendocument.text"],
	ods: ["office", "application/vnd.oasis.opendocument.spreadsheet"],
	odp: ["office", "application/vnd.oasis.opendocument.presentation"],
	epub: ["office", "application/epub+zip"],
};

/** 这些 kind 的内容不是「可编辑文本」，open 时不回 text。 */
const BINARY_KINDS = new Set(["image", "svg", "pdf", "video", "audio", "font", "binary", "office"]);

/** 语言的常见别名（给状态栏显示 + 客户端挑 CodeMirror 语言用）。 */
const LANG_BY_EXT = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	json: "json",
	jsonc: "json",
	json5: "json",
	css: "css",
	scss: "scss",
	sass: "sass",
	less: "less",
	html: "html",
	htm: "html",
	vue: "html",
	svelte: "html",
	xml: "xml",
	svg: "xml",
	xsl: "xml",
	plist: "xml",
	yml: "yaml",
	yaml: "yaml",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	py: "python",
	pyi: "python",
	pyw: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "java",
	gradle: "java",
	scala: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	php: "php",
	phtml: "php",
	sql: "sql",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	ksh: "shell",
	fish: "shell",
	ps1: "powershell",
	psm1: "powershell",
	bat: "powershell",
	cmd: "powershell",
	toml: "toml",
	ini: "properties",
	cfg: "properties",
	conf: "properties",
	env: "properties",
	properties: "properties",
	dockerfile: "dockerfile",
	mk: "shell",
	rb: "ruby",
	lua: "lua",
	pl: "perl",
	pm: "perl",
	r: "r",
	swift: "swift",
	cs: "csharp",
	kts: "clike",
	dart: "dart",
	ex: "erlang",
	exs: "erlang",
	erl: "erlang",
	hs: "haskell",
	clj: "clojure",
	cljs: "clojure",
	scm: "clojure",
	el: "clojure",
	vim: "vim",
	diff: "diff",
	patch: "diff",
	graphql: "clike",
	gql: "clike",
	proto: "clike",
	text: "text",
	txt: "text",
	log: "text",
};

const MIME_BY_TEXT_EXT = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	cjs: "text/javascript; charset=utf-8",
	ts: "text/plain; charset=utf-8",
	tsx: "text/plain; charset=utf-8",
	jsx: "text/plain; charset=utf-8",
	xml: "text/xml; charset=utf-8",
	yaml: "text/yaml; charset=utf-8",
	yml: "text/yaml; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	ini: "text/plain; charset=utf-8",
	sh: "text/x-sh; charset=utf-8",
};

/** 扩展名（小写、不带点）。 */
export function extOf(name) {
	const base =
		String(name ?? "")
			.replace(/\\/g, "/")
			.split("/")
			.pop() ?? "";
	const i = base.lastIndexOf(".");
	return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/**
 * 扩展名 → { kind, mime, lang, textual }（纯函数，单测覆盖）。
 * 未知扩展名一律按文本处理（kind=code），真正的二进制由内容嗅探在 open 时改判为 hex。
 */
export function classifyFile(name) {
	const ext = extOf(name);
	const hit = TYPES[ext];
	if (hit) {
		const [kind, mime] = hit;
		return { kind, mime, lang: LANG_BY_EXT[ext] ?? null, textual: !BINARY_KINDS.has(kind) };
	}
	// Dockerfile / Makefile 这类无扩展名的约定文件
	const base = String(name ?? "")
		.replace(/\\/g, "/")
		.split("/")
		.pop()
		?.toLowerCase();
	const byName =
		base === "dockerfile" || base?.startsWith("dockerfile.") || base === "containerfile"
			? { kind: "code", mime: "text/plain; charset=utf-8", lang: "dockerfile" }
			: base === "makefile" || base === "gnumakefile"
				? { kind: "code", mime: "text/plain; charset=utf-8", lang: "shell" }
				: base === ".env" || base?.startsWith(".env.")
					? { kind: "code", mime: "text/plain; charset=utf-8", lang: "properties" }
					: base === ".gitignore" || base === ".dockerignore" || base === ".npmignore"
						? { kind: "code", mime: "text/plain; charset=utf-8", lang: "properties" }
						: null;
	if (byName) return { ...byName, textual: true };
	return {
		kind: "code",
		mime: MIME_BY_TEXT_EXT[ext] ?? "text/plain; charset=utf-8",
		lang: LANG_BY_EXT[ext] ?? null,
		textual: true,
	};
}

/** UTF-8 → GBK → latin1 兜底解码（BOM 优先）。 */
export function decodeBytes(buf) {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
		return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8" };
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
		return { text: safeDecode("utf-16le", buf.subarray(2)) ?? "", encoding: "utf-16le" };
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
		return { text: safeDecode("utf-16be", buf.subarray(2)) ?? "", encoding: "utf-16be" };
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
	} catch {}
	const gbk = safeDecode("gbk", buf);
	if (gbk !== null) return { text: gbk, encoding: "gbk" };
	return { text: buf.toString("latin1"), encoding: "latin1" };
}

function safeDecode(enc, buf) {
	try {
		return new TextDecoder(enc, { fatal: false }).decode(buf);
	} catch {
		return null;
	}
}

/** 二进制判定：NUL 字节或高比例控制字符（纯函数，单测覆盖）。 */
export function looksBinary(buf) {
	const n = Math.min(buf.length, 8192);
	if (n === 0) return false;
	let ctrl = 0;
	for (let i = 0; i < n; i++) {
		const b = buf[i];
		if (b === 0) return true;
		// 允许 \t \n \r \f \b 与 ESC（ANSI 彩色日志）
		if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) ctrl++;
	}
	return ctrl / n > 0.1;
}

/** 图片尺寸嗅探（PNG/JPEG/GIF/WebP/BMP/ICO；认不出回 null）。 */
export function imageSize(buf) {
	if (!buf || buf.length < 26) return null;
	// PNG
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	// GIF
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	// BMP
	if (buf[0] === 0x42 && buf[1] === 0x4d)
		return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
	// ICO
	if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00)
		return { width: buf[6] || 256, height: buf[7] || 256 };
	// WebP
	if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
		const fmt = buf.toString("latin1", 12, 16);
		if (fmt === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
		if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
		if (fmt === "VP8L") {
			const b = buf.readUInt32LE(21);
			return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
		}
	}
	// JPEG：扫 SOFn 段
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = buf[i + 1];
			const len = buf.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
				return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
			if (len < 2) break;
			i += 2 + len;
		}
	}
	return null;
}

/** 行数（末尾空行不计）。 */
export function countLines(text) {
	if (!text) return 0;
	const n = text.split("\n").length;
	return text.endsWith("\n") ? n - 1 : n;
}

/** 数字参数兜底：非法/越界一律落到 [min, max] 里（防止客户端传 Infinity 搞挂遍历）。 */
function clampInt(value, min, max, fallback) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** 归一化工作区相对路径：拒绝绝对路径/`..`/NUL；`""` 表示根。 */
export function normRel(input) {
	const raw = String(input ?? "").replace(/\\/g, "/");
	if (raw.includes("\0")) return null;
	if (raw.startsWith("/")) return null;
	if (/^[A-Za-z]:/.test(raw)) return null;
	const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
	if (segs.some((s) => s === "..")) return null;
	return segs.join("/");
}

function parentOf(rel) {
	const i = rel.lastIndexOf("/");
	return i < 0 ? "" : rel.slice(0, i);
}

function baseName(rel) {
	const i = rel.lastIndexOf("/");
	return i < 0 ? rel : rel.slice(i + 1);
}

/** 目录排序：文件夹在前，其余按名字（大小写不敏感）。 */
function sortEntries(list) {
	return list.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
	});
}

// ---------------------------------------------------------------------------
// 内容搜索（grep）用的纯函数：glob → 正则、.gitignore 规则、搜索表达式
// ---------------------------------------------------------------------------

const RE_SPECIAL = new Set([..."\\^$.|+()[]{}"]);

/**
 * glob → 锚定整串正则。支持 `**`（跨层）、`*`（单层）、`?`、`{a,b}`、`[abc]`。
 * 只用来做 include/exclude/.gitignore 的路径匹配，所以一律 `^…$` 全串匹配。
 */
export function globToRegExp(glob) {
	const src = String(glob ?? "");
	let out = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === "*") {
			if (src[i + 1] === "*") {
				i++;
				if (src[i + 1] === "/") {
					i++;
					out += "(?:.*/)?"; // `**/` 可以吃掉零层目录
				} else out += ".*";
			} else out += "[^/]*";
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		if (ch === "{") {
			const close = src.indexOf("}", i);
			if (close > i + 1) {
				const alts = src
					.slice(i + 1, close)
					.split(",")
					.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
				out += `(?:${alts.join("|")})`;
				i = close;
				continue;
			}
		}
		if (ch === "[") {
			const close = src.indexOf("]", i + 1);
			if (close > i + 1) {
				out += src.slice(i, close + 1).replace(/\\/g, "\\\\");
				i = close;
				continue;
			}
		}
		out += RE_SPECIAL.has(ch) ? `\\${ch}` : ch;
	}
	return new RegExp(`^${out}$`);
}

/**
 * `.gitignore` 文本 → 规则集（`baseRel` 是该文件所在目录的工作区相对路径）。
 * 语义按 git 的简化版：`#` 注释、`!` 取反、结尾 `/` 只压目录、含 `/` 的图样相对该目录锚定，
 * 否则只比文件名；后面的规则覆盖前面的。
 */
export function parseGitignore(text, baseRel = "") {
	const rules = [];
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		let line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		let negate = false;
		if (line.startsWith("!")) {
			negate = true;
			line = line.slice(1).trim();
		}
		if (!line) continue;
		const dirOnly = line.endsWith("/");
		if (dirOnly) line = line.slice(0, -1);
		const rooted = line.startsWith("/");
		if (rooted) line = line.slice(1);
		if (!line || line === "**") continue;
		// `/x` 与含 `/` 的图样相对 .gitignore 所在目录锚定，否则只比 basename
		const anchored = rooted || line.includes("/");
		rules.push({ re: globToRegExp(line), negate, dirOnly, anchored, base: baseRel });
	}
	return rules;
}

/** 某工作区相对路径是否被 .gitignore 规则集忽略（最后一个命中的规则胜出）。 */
export function isIgnoredPath(rel, isDir, rules) {
	let ignored = false;
	const base = baseName(rel);
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		let target = base;
		if (rule.anchored) {
			if (rule.base) {
				if (!rel.startsWith(`${rule.base}/`)) continue;
				target = rel.slice(rule.base.length + 1);
			} else target = rel;
		}
		if (rule.re.test(target)) ignored = !rule.negate;
	}
	return ignored;
}

/**
 * 搜索 / 替换共用的正则构造。
 * - `regex` 直接当正则（1 层 `(?:…)` 包裹，$1 这类反向引用仍可用）；
 * - `wholeWord` 用前后 lookaround 而不是 `\b`，否则 CJK 词永远匹配不上；
 * - 无效正则抛错（UI 回显错误而不是静默无结果）。
 */
export function buildSearchRegExp({ query, regex = false, caseSensitive = false, wholeWord = false }) {
	const q = String(query ?? "");
	if (!q) return null;
	let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (wholeWord) src = `(?<![\\w$])(?:${src})(?![\\w$])`;
	try {
		return new RegExp(src, caseSensitive ? "g" : "gi");
	} catch (err) {
		throw new Error(`无效的正则：${err?.message ?? String(err)}`);
	}
}

/** 结果行预览：长行截一段窗口，`offset` 告诉客户端预览前面的省略号与高亮位置。 */
function previewWindow(line, start, max = PREVIEW_MAX) {
	if (line.length <= max) return { text: line, offset: 0 };
	const from = Math.max(0, Math.min(start - Math.floor(max / 3), line.length - max));
	return { text: line.slice(from, from + max), offset: from };
}

export default {
	async activate(host) {
		let root = path.resolve(String(host.cwd ?? process.cwd()));
		let rootReal = root;
		const refreshRootReal = async () => {
			try {
				rootReal = await fs.realpath(root);
			} catch {
				rootReal = root;
			}
		};
		await refreshRootReal();

		/** 归一化 + 落在工作区根内（词法）。返回 { rel, abs } 或 null。 */
		const locate = (input) => {
			const rel = normRel(input);
			if (rel === null) return null;
			const abs = path.resolve(root, rel);
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return { rel, abs };
		};

		/** 写前 realpath 校验：已存在的祖先真实落点必须在根内，目标本身不能是符号链接。 */
		const assertRealInside = async (abs) => {
			let probe = abs;
			for (;;) {
				try {
					const real = await fs.realpath(probe);
					if (real !== rootReal && !real.startsWith(rootReal + path.sep))
						throw new Error("路径越界（符号链接指向工作区外）");
					break;
				} catch (err) {
					if (err?.code === "ENOENT" && path.dirname(probe) !== probe) {
						probe = path.dirname(probe);
						continue;
					}
					if (err?.code === "ENOENT") break;
					throw err;
				}
			}
			try {
				const lst = await fs.lstat(abs);
				if (lst.isSymbolicLink()) throw new Error("拒绝写入符号链接");
			} catch (err) {
				if (err?.code !== "ENOENT") throw err;
			}
		};

		const readHead = async (abs, max) => {
			const fh = await fs.open(abs, "r");
			try {
				const buf = Buffer.allocUnsafe(max);
				const { bytesRead } = await fh.read(buf, 0, max, 0);
				return buf.subarray(0, bytesRead);
			} finally {
				await fh.close();
			}
		};

		const statEntry = async (abs) => {
			const st = await fs.stat(abs);
			return {
				type: st.isDirectory() ? "dir" : "file",
				size: st.size,
				mtime: Math.round(st.mtimeMs),
			};
		};

		/** 打开一个文件：分类 + （文本类）正文 + （图片）尺寸。 */
		const openFile = async (input) => {
			const loc = locate(input);
			if (!loc) throw new Error("路径越界");
			const st = await fs.stat(loc.abs);
			if (st.isDirectory()) throw new Error("这是一个目录");
			const name = baseName(loc.rel);
			const info = classifyFile(name);
			const head = await readHead(loc.abs, Math.min(MAX_HEAD_BYTES, Math.max(st.size, 1)));
			const dims = info.kind === "image" || info.kind === "svg" ? imageSize(head) : null;
			const base = {
				path: loc.rel,
				name,
				size: st.size,
				mtime: Math.round(st.mtimeMs),
				kind: info.kind,
				mime: info.mime,
				lang: info.lang,
				dimensions: dims,
			};
			let kind = info.kind;
			// 扩展名说是文本、内容却是二进制 → 走 hex（图片等在 TYPES 里已有专用 kind）
			if (info.textual && looksBinary(head)) kind = "hex";
			if (!info.textual) return { ...base, kind };

			if (st.size > MAX_TEXT_BYTES) {
				const headText = decodeBytes(await readHead(loc.abs, MAX_TEXT_BYTES));
				return {
					...base,
					kind,
					text: headText.text,
					encoding: headText.encoding,
					lines: countLines(headText.text),
					eol: headText.text.includes("\r\n") ? "crlf" : "lf",
					truncated: true,
				};
			}
			const buf = await fs.readFile(loc.abs);
			if (looksBinary(buf)) return { ...base, kind: "hex" };
			const { text, encoding } = decodeBytes(buf);
			return {
				...base,
				kind,
				text,
				encoding,
				lines: countLines(text),
				eol: text.includes("\r\n") ? "crlf" : "lf",
				truncated: false,
			};
		};

		const listDir = async (input) => {
			const loc = locate(input);
			if (!loc) throw new Error("路径越界");
			const dirents = await fs.readdir(loc.abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (d.name.startsWith(".") && IGNORED_DIRS.has(d.name)) continue;
				if (IGNORED_DIRS.has(d.name)) continue;
				let type = d.isDirectory() ? "dir" : "file";
				let size = 0;
				let mtime = 0;
				try {
					const st = await fs.lstat(path.join(loc.abs, d.name));
					if (st.isSymbolicLink()) type = st.isDirectory() ? "dir" : "file";
					size = st.size;
					mtime = Math.round(st.mtimeMs);
				} catch {
					continue;
				}
				entries.push({ name: d.name, type, size, mtime });
			}
			return { root: root, path: loc.rel, entries: sortEntries(entries).slice(0, 5000) };
		};

		/** 原子落盘：先写同目录 tmp 再 rename（断电/并发不会留半截文件）。 */
		const atomicWrite = async (abs, text) => {
			await assertRealInside(abs);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			const tmp = `${abs}.pi-tmp-${process.pid}-${Date.now()}`;
			await fs.writeFile(tmp, String(text ?? ""), "utf8");
			await fs.rename(tmp, abs);
		};

		const writeText = async (input, text) => {
			const loc = locate(input);
			if (!loc) throw new Error("路径越界");
			await atomicWrite(loc.abs, text);
			const st = await fs.stat(loc.abs);
			return { path: loc.rel, size: st.size, mtime: Math.round(st.mtimeMs) };
		};

		const searchFiles = async (query, baseRel) => {
			const q = String(query ?? "").toLowerCase();
			if (!q) return { matches: [] };
			const start = locate(baseRel ?? "");
			if (!start) throw new Error("路径越界");
			const matches = [];
			let visited = 0;
			/** @type {{dir: string, rel: string, depth: number}[]} */
			const queue = [{ dir: start.abs, rel: start.rel, depth: 0 }];
			while (queue.length && matches.length < MAX_SEARCH_MATCHES && visited < MAX_SEARCH_VISIT) {
				const cur = queue.shift();
				let dirents;
				try {
					dirents = await fs.readdir(cur.dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const d of dirents) {
					visited++;
					if (visited > MAX_SEARCH_VISIT) break;
					const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
					if (d.isDirectory()) {
						if (IGNORED_DIRS.has(d.name) || cur.depth >= MAX_SEARCH_DEPTH) continue;
						queue.push({ dir: path.join(cur.dir, d.name), rel, depth: cur.depth + 1 });
						continue;
					}
					if (!d.name.toLowerCase().includes(q)) continue;
					matches.push({ path: rel, name: d.name, score: fuzzyScore(q, rel) });
					if (matches.length >= MAX_SEARCH_MATCHES) break;
				}
			}
			matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
			return { matches: matches.slice(0, MAX_SEARCH_MATCHES).map(({ path: p, name }) => ({ path: p, name })) };
		};

		// ------------------------------------------------ 内容搜索（grep）
		/** .gitignore 规则缓存（每轮搜索清空，避免读到改过的 ignore 文件） */
		const gitignoreCache = new Map();

		const readGitignore = async (abs, rel) => {
			if (gitignoreCache.has(abs)) return gitignoreCache.get(abs);
			let rules = [];
			try {
				rules = parseGitignore(await fs.readFile(path.join(abs, ".gitignore"), "utf8"), rel);
			} catch {
				rules = [];
			}
			if (gitignoreCache.size > 500) gitignoreCache.clear();
			gitignoreCache.set(abs, rules);
			return rules;
		};

		/** include/exclude：逗号/分号分隔的 glob；含 `/` 的比全路径，否则只比文件名。 */
		const compileFilters = (include, exclude) => {
			const build = (raw) =>
				String(raw ?? "")
					.split(/[,;]/)
					.map((s) => s.trim())
					.filter(Boolean)
					.slice(0, 24)
					.map((p) => ({
						re: globToRegExp(p.startsWith("/") ? p.slice(1) : p),
						onPath: p.replace(/^\//, "").includes("/"),
					}));
			return { include: build(include), exclude: build(exclude) };
		};

		const passesFilters = (rel, filters) => {
			const base = baseName(rel);
			const hit = (list) => list.some((f) => f.re.test(f.onPath ? rel : base));
			if (filters.include.length && !hit(filters.include)) return false;
			if (filters.exclude.length && hit(filters.exclude)) return false;
			return true;
		};

		/**
		 * 深度遍历文本类文件（印字典序，目录先序）。
		 * onFile 返回 false 时立即停止（总命中数达上限）。
		 * 跳过：IGNORED_DIRS、.gitignore 命中的路径、非文本扩展名、过深目录。
		 */
		const walkTextFiles = async (opts, onFile) => {
			const start = locate(opts.baseRel ?? opts.base ?? "");
			if (!start) throw new Error("路径越界");
			const filters = compileFilters(opts.include, opts.exclude);
			const useGitignore = opts.useGitignore !== false;
			const maxFiles = clampInt(opts.maxFiles, 1, 20000, MAX_CONTENT_FILES);
			const startedAt = Date.now();
			let scanned = 0;
			let stopped = false;

			// 范围可以是一个具体文件（“只看当前文件”），此时不进目录遍历
			let startStat = null;
			try {
				startStat = await fs.stat(start.abs);
			} catch {
				startStat = null;
			}
			if (startStat?.isFile()) {
				if (classifyFile(baseName(start.rel)).textual) {
					await onFile({ abs: start.abs, rel: start.rel, name: baseName(start.rel) });
					scanned = 1;
				}
				return { scanned, stopped: false, elapsedMs: Date.now() - startedAt, base: start.rel };
			}
			const stack = [{ abs: start.abs, rel: start.rel, rules: [], depth: 0 }];

			while (stack.length) {
				if (Date.now() - startedAt > CONTENT_BUDGET_MS) {
					stopped = true;
					break;
				}
				const cur = stack.pop();
				let rules = cur.rules;
				if (useGitignore) {
					const extra = await readGitignore(cur.abs, cur.rel);
					if (extra.length) rules = [...rules, ...extra];
				}
				let dirents;
				try {
					dirents = await fs.readdir(cur.abs, { withFileTypes: true });
				} catch {
					continue;
				}
				dirents.sort((a, b) => a.name.localeCompare(b.name));
				const subdirs = [];
				for (const d of dirents) {
					if (IGNORED_DIRS.has(d.name)) continue;
					const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
					const isDir = d.isDirectory();
					if (useGitignore && isIgnoredPath(rel, isDir, rules)) continue;
					if (isDir) {
						if (cur.depth >= MAX_SEARCH_DEPTH) continue;
						subdirs.push({ abs: path.join(cur.abs, d.name), rel, rules, depth: cur.depth + 1 });
						continue;
					}
					if (!d.isFile()) continue;
					if (!passesFilters(rel, filters)) continue;
					if (!classifyFile(d.name).textual) continue;
					scanned++;
					if (scanned > maxFiles) {
						stopped = true;
						break;
					}
					let keepGoing = true;
					try {
						keepGoing = (await onFile({ abs: path.join(cur.abs, d.name), rel, name: d.name })) !== false;
					} catch {
						keepGoing = true; // 单文件读失败不该打断整轮搜索
					}
					if (!keepGoing) {
						stopped = true;
						break;
					}
				}
				if (stopped) break;
				for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
			}
			return { scanned, stopped, elapsedMs: Date.now() - startedAt, base: start.rel };
		};

		/** 单文件扫描：返回值集掉二进制/超大文件（返回空数组）。 */
		const scanFileMatches = async (abs, re, perFile) => {
			let st;
			try {
				st = await fs.stat(abs);
			} catch {
				return { matches: [] };
			}
			if (!st.isFile() || st.size === 0 || st.size > MAX_CONTENT_FILE_BYTES) return { matches: [] };
			const buf = await fs.readFile(abs);
			if (looksBinary(buf)) return { matches: [] };
			const { text } = decodeBytes(buf);
			const lines = text.split("\n");
			const matches = [];
			let truncated = false;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
				if (!line) continue;
				re.lastIndex = 0;
				let m;
				while ((m = re.exec(line)) !== null) {
					if (m[0].length === 0) {
						re.lastIndex += 1; // 空匹配（如 `a*`）不能死循环
						continue;
					}
					const win = previewWindow(line, m.index);
					matches.push({
						line: i + 1,
						col: m.index + 1,
						length: m[0].length,
						text: win.text,
						offset: win.offset,
						lineLength: line.length,
					});
					if (matches.length >= perFile) {
						truncated = true;
						break;
					}
				}
				if (truncated) break;
			}
			return { matches, truncated };
		};

		/** 内容搜索：按文件分组回匹配行（行号/列/预览）。 */
		const searchContent = async (msg) => {
			const re = buildSearchRegExp(msg);
			if (!re) return { files: [], totalMatches: 0, scanned: 0, elapsedMs: 0, truncated: false, base: "" };
			const perFile = clampInt(msg.maxPerFile, 1, 500, MAX_CONTENT_PER_FILE);
			// 换成非 sticky 的拷贝：每行 lastIndex 归零即可，不共享状态
			gitignoreCache.clear();
			const files = [];
			let totalMatches = 0;
			let limitHit = false;
			const walk = await walkTextFiles(msg, async (entry) => {
				const { matches, truncated } = await scanFileMatches(entry.abs, re, perFile);
				if (!matches.length) return true;
				totalMatches += matches.length;
				files.push({
					path: entry.rel,
					name: entry.name,
					matches,
					count: matches.length,
					truncated: Boolean(truncated),
				});
				if (totalMatches >= clampInt(msg.maxResults, 1, 5000, MAX_CONTENT_MATCHES)) {
					limitHit = true;
					return false;
				}
				return true;
			});
			return {
				files,
				totalMatches,
				scanned: walk.scanned,
				elapsedMs: walk.elapsedMs,
				base: walk.base,
				truncated: Boolean(limitHit || walk.stopped),
			};
		};

		/** 批量替换：只动 UTF-8 文本，写盘走 atomicWrite；dryRun 只算不写。 */
		const replaceContent = async (msg) => {
			const re = buildSearchRegExp(msg);
			if (!re) throw new Error("替换内容为空");
			const replacement = String(msg.replace ?? "");
			const dryRun = msg.dryRun === true;
			gitignoreCache.clear();
			const changed = [];
			const skipped = [];
			let total = 0;
			const walk = await walkTextFiles(msg, async (entry) => {
				let buf;
				try {
					const st = await fs.stat(entry.abs);
					if (!st.isFile() || st.size > MAX_CONTENT_FILE_BYTES) {
						skipped.push({ path: entry.rel, reason: "超过 2MB" });
						return true;
					}
					buf = await fs.readFile(entry.abs);
				} catch {
					return true;
				}
				if (looksBinary(buf)) {
					skipped.push({ path: entry.rel, reason: "二进制" });
					return true;
				}
				const { text, encoding } = decodeBytes(buf);
				if (encoding !== "utf-8") {
					skipped.push({ path: entry.rel, reason: `非 UTF-8（${encoding}）` });
					return true;
				}
				re.lastIndex = 0;
				const count = (text.match(re) ?? []).length;
				if (!count) return true;
				const next = text.replace(re, replacement);
				if (next === text) return true;
				if (!dryRun) {
					try {
						await atomicWrite(entry.abs, next);
					} catch (err) {
						skipped.push({ path: entry.rel, reason: err?.message ?? "写入失败" });
						return true;
					}
				}
				total += count;
				changed.push({ path: entry.rel, count });
				return changed.length < MAX_REPLACE_FILES;
			});
			return {
				files: changed,
				skipped: skipped.slice(0, 50),
				skippedCount: skipped.length,
				totalFiles: changed.length,
				totalReplacements: total,
				scanned: walk.scanned,
				stopped: walk.stopped,
				elapsedMs: walk.elapsedMs,
				dryRun,
			};
		};

		const readBytes = async (input, offset, length) => {
			const loc = locate(input);
			if (!loc) throw new Error("路径越界");
			const start = Math.max(0, Number(offset) || 0);
			const want = Math.min(MAX_BYTES_CHUNK, Math.max(1, Number(length) || 4096));
			const fh = await fs.open(loc.abs, "r");
			try {
				const st = await fh.stat();
				const buf = Buffer.allocUnsafe(Math.min(want, Math.max(0, st.size - start)));
				const { bytesRead } = await fh.read(buf, 0, buf.length, start);
				return { offset: start, size: st.size, b64: buf.subarray(0, bytesRead).toString("base64") };
			} finally {
				await fh.close();
			}
		};

		/** 统一的 action 分发（WS 与 HTTP /raw 之外的元信息查询共用）。 */
		const handle = async (msg) => {
			const action = String(msg.action ?? "");
			switch (action) {
				case "ping":
					return { ok: true, root };
				case "settings": {
					// 声明式设置（manifest.settings）只有服务端拿得到，客户端 bootstrap 时拉一次
					let cfg = {};
					try {
						cfg = host.getSettings?.() ?? {};
					} catch {
						cfg = {};
					}
					return {
						ok: true,
						settings: {
							autoReload: cfg.autoReload !== false,
							imageCheckerboard: cfg.imageCheckerboard !== false,
							restoreTabs: cfg.restoreTabs !== false,
						},
					};
				}
				case "list":
					return { ok: true, ...(await listDir(msg.path)) };
				case "open":
					return { ok: true, file: await openFile(msg.path) };
				case "stat": {
					const loc = locate(msg.path);
					if (!loc) throw new Error("路径越界");
					const st = await statEntry(loc.abs);
					return { ok: true, path: loc.rel, ...st, kind: classifyFile(baseName(loc.rel)).kind };
				}
				case "read_bytes":
					return { ok: true, ...(await readBytes(msg.path, msg.offset, msg.length)) };
				case "write":
					return { ok: true, ...(await writeText(msg.path, msg.text)) };
				case "create": {
					const loc = locate(msg.path);
					if (!loc) throw new Error("路径越界");
					if (msg.kind === "dir") {
						await assertRealInside(loc.abs);
						await fs.mkdir(loc.abs, { recursive: true });
					} else {
						await assertRealInside(loc.abs);
						await fs.mkdir(path.dirname(loc.abs), { recursive: true });
						const fh = await fs.open(loc.abs, "wx");
						await fh.close();
					}
					return { ok: true, path: loc.rel };
				}
				case "mkdir": {
					const loc = locate(msg.path);
					if (!loc) throw new Error("路径越界");
					await assertRealInside(loc.abs);
					await fs.mkdir(loc.abs, { recursive: true });
					return { ok: true, path: loc.rel };
				}
				case "rename": {
					const loc = locate(msg.path);
					if (!loc) throw new Error("路径越界");
					const nextName = String(msg.name ?? "").trim();
					if (!nextName || nextName.includes("/") || nextName.includes("\\") || nextName === "." || nextName === "..")
						throw new Error("非法的新文件名");
					const dest = path.join(path.dirname(loc.abs), nextName);
					const destRel = parentOf(loc.rel) ? `${parentOf(loc.rel)}/${nextName}` : nextName;
					await assertRealInside(dest);
					await fs.rename(loc.abs, dest);
					return { ok: true, path: destRel };
				}
				case "delete": {
					const loc = locate(msg.path);
					if (!loc) throw new Error("路径越界");
					if (loc.rel === "") throw new Error("拒绝删除工作区根目录");
					await assertRealInside(loc.abs);
					if (msg.isDir) await fs.rm(loc.abs, { recursive: true, force: true });
					else await fs.rm(loc.abs, { force: true });
					return { ok: true, path: loc.rel };
				}
				case "search":
					return { ok: true, ...(await searchFiles(msg.query, msg.base)) };
				case "search_content":
					return { ok: true, ...(await searchContent(msg)) };
				case "replace_content":
					return { ok: true, ...(await replaceContent(msg)) };
				default:
					throw new Error(`未知操作 ${action || "(空)"}`);
			}
		};

		// ---------------------------------------------------------------- WS 通道
		const off = host.onMessage(async (msg, from) => {
			const payload = msg && typeof msg === "object" ? msg : {};
			const reqId = payload.reqId;
			if (!reqId) return; // 无 reqId = 不是请求，忽略（避免误发广播）
			try {
				const r = await handle(payload);
				if (from) host.sendTo(from, { res: true, reqId, action: payload.action, ...r });
			} catch (err) {
				if (from)
					host.sendTo(from, {
						res: true,
						reqId,
						ok: false,
						action: payload.action,
						error: err?.message ?? String(err),
					});
			}
		});

		// ---------------------------------------------------------------- HTTP 原始字节
		/** 解析 Range 头（单区间）；非法回 null。 */
		const parseRange = (header, size) => {
			const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
			if (!m) return null;
			const [, a, b] = m;
			if (!a && !b) return null;
			let start;
			let end;
			if (!a) {
				// 后缀区间：最后 N 字节
				const n = Number(b);
				if (!Number.isFinite(n) || n <= 0) return null;
				start = Math.max(0, size - n);
				end = size - 1;
			} else {
				start = Number(a);
				end = b ? Math.min(Number(b), size - 1) : size - 1;
			}
			if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
			return { start, end };
		};

		const offRoute = host.route("GET", "/raw", async (req, res) => {
			const rel = normRel(req.query?.path);
			const loc = rel === null ? null : locate(rel);
			if (!loc) return void res.status(400).json({ ok: false, error: "非法路径" });
			let st;
			try {
				st = await fs.stat(loc.abs);
			} catch {
				return void res.status(404).json({ ok: false, error: "文件不存在" });
			}
			if (!st.isFile()) return void res.status(400).json({ ok: false, error: "不是普通文件" });
			if (st.size > MAX_STREAM_BYTES) return void res.status(413).json({ ok: false, error: "文件过大" });
			const name = baseName(loc.rel);
			const info = classifyFile(name);
			const download = String(req.query?.download ?? "") === "1";
			res.setHeader("Content-Type", download ? "application/octet-stream" : info.mime);
			res.setHeader("Accept-Ranges", "bytes");
			res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
			res.setHeader("Last-Modified", new Date(st.mtimeMs).toUTCString());
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader(
				"Content-Disposition",
				`${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
			);
			// SVG 走 <img> 时不执行脚本；这段 CSP 是「用户把 raw 地址直接开成页面」时的兜底。
			if (info.kind === "svg")
				res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
			const range = req.headers?.range ? parseRange(req.headers.range, st.size) : null;
			if (req.headers?.range && !range) {
				res.setHeader("Content-Range", `bytes */${st.size}`);
				return void res.status(416).end();
			}
			if (range) {
				res.statusCode = 206;
				res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${st.size}`);
				res.setHeader("Content-Length", String(range.end - range.start + 1));
				createReadStream(loc.abs, { start: range.start, end: range.end })
					.on("error", () => res.destroy())
					.pipe(res);
				return;
			}
			res.setHeader("Content-Length", String(st.size));
			createReadStream(loc.abs)
				.on("error", () => res.destroy())
				.pipe(res);
		});

		// 工作区跟随主应用 set_cwd
		const offCwd = host.onCwdChange?.((next) => {
			root = path.resolve(String(next));
			void refreshRootReal();
			host.broadcast({ kind: "workspace", root });
			host.log(`workspace root switched: ${root}`);
		});

		host.log(`vscode-editor-pro activated; workspace root: ${root}`);
		return () => {
			off();
			try {
				offRoute();
			} catch {}
			try {
				offCwd?.();
			} catch {}
			host.log("vscode-editor-pro deactivated");
		};
	},
};

/** 文件名模糊打分（越靠前命中、越短路径越高分；-1 = 不匹配）。 */
export function fuzzyScore(query, target) {
	const q = String(query ?? "").toLowerCase();
	const p = String(target ?? "").toLowerCase();
	if (!q) return 0;
	let qi = 0;
	let score = 0;
	let streak = 0;
	for (let i = 0; i < p.length && qi < q.length; i++) {
		if (p[i] === q[qi]) {
			qi++;
			streak++;
			score += 10 + streak * 2 + (i === 0 || /[/_.\- ]/.test(p[i - 1]) ? 8 : 0);
		} else {
			streak = 0;
		}
	}
	if (qi < q.length) return -1;
	return score + Math.max(0, 40 - target.length) / 10;
}
