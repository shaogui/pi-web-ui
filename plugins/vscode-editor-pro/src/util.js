/**
 * 客户端通用工具：DOM 转义 / 体积格式化 / 应用根与 token / WS 请求封装 / 主题判定。
 *
 * 插件 bundle 与主应用同页但仍走窄通道（ctx.send / ctx.onData），HTTP 侧
 *（图片、PDF、音视频的原始字节）由本文件拼 URL：应用根从 document.baseURI 推导
 *（兼容 nginx 子路径反代），token 从 localStorage 的 pi-web-ui:token 取，
 * 与宿主 web/src/base-url.ts、auth-token.ts 同口径。
 */

export function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function fmtBytes(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v < 0) return "—";
	if (v < 1024) return `${v} B`;
	let i = 0;
	let x = v;
	while (x >= 1024 && i < UNITS.length - 1) {
		x /= 1024;
		i++;
	}
	return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${UNITS[i]}`;
}

export function fmtTime(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v <= 0) return "—";
	try {
		return new Date(v).toLocaleString();
	} catch {
		return String(v);
	}
}

export function extOf(name) {
	const base =
		String(name ?? "")
			.replace(/\\/g, "/")
			.split("/")
			.pop() ?? "";
	const i = base.lastIndexOf(".");
	return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function parentOf(rel) {
	const i = String(rel ?? "").lastIndexOf("/");
	return i < 0 ? "" : String(rel).slice(0, i);
}

export function baseName(rel) {
	const s = String(rel ?? "");
	const i = s.lastIndexOf("/");
	return i < 0 ? s : s.slice(i + 1);
}

export function joinRel(dir, name) {
	return dir ? `${dir}/${name}` : name;
}

/**
 * 绝对路径 → 工作区相对路径（跨插件联动用：仓库根未必等于工作区根）。
 *
 * - 不在工作区内（含 `..` 越界段）/ 参数缺失 → null；正好是工作区根 → ""（没有文件名）；
 * - 一律把 `\` 归一成 `/` 后比较，Windows 盘符折大小写（与宿主 WorkspaceFS 同口径）；
 * - 返回的路径用 `/` 分隔，与宿主的 rel 路径同口径。
 *
 * @param {string} root 工作区绝对根
 * @param {string} abs 目标绝对路径
 * @returns {string | null}
 */
export function relInWorkspace(root, abs) {
	const norm = (p) =>
		String(p ?? "")
			.replace(/\\/g, "/")
			.replace(/\/+$/, "");
	const r = norm(root);
	const a = norm(abs);
	if (!r || !a) return null;
	// 只有盘符路径（C:/…）才折大小写：POSIX 下大小写是区分开的
	const fold = /^[a-z]:/i.test(r);
	const rs = fold ? r.toLowerCase() : r;
	const as = fold ? a.toLowerCase() : a;
	if (as === rs) return "";
	if (!as.startsWith(`${rs}/`)) return null;
	const rel = a.slice(r.length + 1);
	// 字符串前缀相同不代表真在目录里（`/repo/../etc`）：越界段一律拒
	if (rel.split("/").includes("..")) return null;
	return rel;
}

/** 应用根（含子路径反代场景）："/" 或 "/pi/" 之类，末尾必带 "/"。 */
let cachedBase = null;
export function appBase() {
	if (cachedBase !== null) return cachedBase;
	let base = "/";
	try {
		const u = new URL(document.baseURI);
		let p = u.pathname;
		if (!p.endsWith("/")) p = p.slice(0, p.lastIndexOf("/") + 1) || "/";
		base = p;
	} catch {
		base = "/";
	}
	cachedBase = base;
	return base;
}

const TOKEN_KEY = "pi-web-ui:token";

export function authToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

export function withToken(url) {
	const t = authToken();
	if (!t) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

/** 插件 API 根（绝对：应用根 + /plugins-api/<id>）。 */
export function apiRoot(pluginId) {
	return `${appBase()}plugins-api/${encodeURIComponent(pluginId)}`;
}

/** 原始字节 URL（图片/PDF/音视频/字体都用它，Range 由浏览器自己谈）。 */
export function makeRawUrl(pluginId) {
	const root = `${apiRoot(pluginId)}/raw`;
	return (relPath, opts = {}) => {
		const q = new URLSearchParams();
		q.set("path", String(relPath ?? ""));
		if (opts.download) q.set("download", "1");
		if (opts.bust) q.set("v", String(opts.bust));
		return withToken(`${root}?${q.toString()}`);
	};
}

/** 主题：浅色主题统一声明 color-scheme: light（与宿主 web/src/theme.ts 同口径）。 */
export const THEME_EVENT = "pi-web-ui:theme-change";

export function isLightTheme() {
	try {
		return getComputedStyle(document.documentElement).getPropertyValue("color-scheme").trim().startsWith("light");
	} catch {
		return false;
	}
}

/**
 * WS 请求/响应封装：ctx.send 上行带 reqId，服务端 host.sendTo 回同 reqId。
 * 超时兜底（不让 UI 永远转圈），无 reqId 的下行消息转给 onData 订阅者。
 */
export function createConn(ctx, timeoutMs = 30000) {
	let seq = 0;
	const pending = new Map();
	const dataCbs = new Set();
	const offData = ctx.onData((payload) => {
		if (payload && typeof payload === "object" && payload.res && payload.reqId && pending.has(payload.reqId)) {
			const done = pending.get(payload.reqId);
			pending.delete(payload.reqId);
			done(payload);
			return;
		}
		for (const cb of dataCbs) {
			try {
				cb(payload);
			} catch (err) {
				console.error("[vscode-editor-pro] onData handler failed", err);
			}
		}
	});
	function req(payload, perCallTimeout) {
		const reqId = `p${++seq}`;
		return new Promise((resolve) => {
			pending.set(reqId, resolve);
			try {
				ctx.send({ ...payload, reqId });
			} catch (err) {
				pending.delete(reqId);
				resolve({ ok: false, error: err?.message ?? String(err) });
				return;
			}
			setTimeout(() => {
				if (pending.delete(reqId)) resolve({ ok: false, error: "请求超时" });
			}, perCallTimeout ?? timeoutMs);
		});
	}
	return {
		req,
		onData(cb) {
			dataCbs.add(cb);
			return () => dataCbs.delete(cb);
		},
		dispose() {
			try {
				offData();
			} catch {}
			pending.clear();
			dataCbs.clear();
		},
	};
}

/** 元素工厂：el("div", { class: "x" }, ["文本", child]) */
export function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = String(v);
		else if (k === "text") node.textContent = String(v);
		else if (k === "html") node.innerHTML = String(v);
		else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
		else if (k === "dataset") Object.assign(node.dataset, v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of [].concat(children)) {
		if (c === null || c === undefined || c === false) continue;
		node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
	}
	return node;
}

/** 防抖。 */
export function debounce(fn, ms = 160) {
	let timer = null;
	return (...args) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, ms);
	};
}

/** 本地安全存储（隐私模式/配额异常不该炸整个视图）。 */
export const store = {
	get(key, fallback = null) {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	},
	del(key) {
		try {
			localStorage.removeItem(key);
		} catch {}
	},
};

/** 文件图标（按扩展名，emoji；目录单独判断）。 */
const ICONS = {
	png: "🖼️",
	jpg: "🖼️",
	jpeg: "🖼️",
	jfif: "🖼️",
	gif: "🖼️",
	webp: "🖼️",
	avif: "🖼️",
	bmp: "🖼️",
	ico: "🖼️",
	tif: "🖼️",
	tiff: "🖼️",
	heic: "🖼️",
	svg: "🖌️",
	pdf: "📕",
	mp4: "🎬",
	m4v: "🎬",
	webm: "🎬",
	mov: "🎬",
	mkv: "🎬",
	avi: "🎬",
	mp3: "🎵",
	wav: "🎵",
	ogg: "🎵",
	flac: "🎵",
	m4a: "🎵",
	aac: "🎵",
	ttf: "🔤",
	otf: "🔤",
	woff: "🔤",
	woff2: "🔤",
	md: "📝",
	markdown: "📝",
	csv: "📊",
	tsv: "📊",
	json: "🧾",
	jsonc: "🧾",
	jsonl: "🧾",
	zip: "🗜️",
	gz: "🗜️",
	tar: "🗜️",
	"7z": "🗜️",
	rar: "🗜️",
	docx: "📄",
	xlsx: "📄",
	pptx: "📄",
	doc: "📄",
	xls: "📄",
	ppt: "📄",
	js: "🟨",
	mjs: "🟨",
	cjs: "🟨",
	jsx: "⚛️",
	ts: "🟦",
	tsx: "⚛️",
	css: "🎨",
	scss: "🎨",
	less: "🎨",
	html: "🌐",
	vue: "🌐",
	svelte: "🌐",
	py: "🐍",
	go: "🐹",
	rs: "🦀",
	java: "☕",
	php: "🐘",
	sql: "🗄️",
	xml: "📐",
	yml: "⚙️",
	yaml: "⚙️",
	toml: "⚙️",
	ini: "⚙️",
	sh: "🐚",
	bash: "🐚",
	zsh: "🐚",
	ps1: "🐚",
	lock: "🔒",
	exe: "⚙️",
	wasm: "⚙️",
	log: "🧾",
	txt: "🧾",
};

export function iconFor(name, type) {
	if (type === "dir") return "📁";
	const ext = extOf(name);
	if (ICONS[ext]) return ICONS[ext];
	const base = baseName(name).toLowerCase();
	if (base === "dockerfile") return "🐳";
	if (base === "makefile" || base === "gnumakefile") return "🛠️";
	if (base.startsWith(".env")) return "🔑";
	if (base.startsWith(".git")) return "🌿";
	return "📄";
}
