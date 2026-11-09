/**
 * vscode-editor-pro 客户端视图 —— 多格式查看器工作台。
 *
 * 布局：左栏文件树（懒加载 + 过滤 + 右键菜单）+ 中间分隔把手 + 右侧多标签
 * （标签内按格式挑查看器）+ 底部状态栏。
 *
 * 与 vscode-editor 的关键差异：
 * 1. 二进制不再进 base64 报文 —— 图片/PDF/音视频/字体走 HTTP raw 路由（Range），
 *    浏览器原生解码，大文件也不炸内存；
 * 2. 每种格式有真正的查看器（Markdown 预览、CSV 表格、JSON 折叠树、Hex Dump…），
 *    预览/源码双模可切换；
 * 3. 语言高亮从 8 种扩到 ~25 种；
 * 4. 同一个 bundle 还向宿主文件树注册 fileHandlers（导出见文件末尾），
 *    主应用里点图片也是本插件的查看器。
 *
 * 窄通道：ctx.send / ctx.onData（服务端 index.mjs 的 action 协议）。
 */
import { CodeEditor, langLabel } from "./code.js";
import { createSearchPanel } from "./search.js";
import {
	mountCsvViewer,
	mountFontViewer,
	mountHexViewer,
	mountImageViewer,
	mountInfoViewer,
	mountJsonViewer,
	mountMarkdownViewer,
	mountMediaViewer,
	mountPdfViewer,
} from "./viewers.js";
import { CSS } from "./styles.js";
import {
	THEME_EVENT,
	baseName,
	createConn,
	debounce,
	el,
	fmtBytes,
	fmtTime,
	iconFor,
	isLightTheme,
	makeRawUrl,
	parentOf,
	joinRel,
	relInWorkspace,
	store,
} from "./util.js";

/** 支持「预览/源码」双模的格式：kind → [[mode, label], …] */
const MODES = {
	markdown: [
		["preview", "预览"],
		["source", "源码"],
	],
	svg: [
		["image", "图像"],
		["source", "源码"],
	],
	json: [
		["tree", "树"],
		["source", "源码"],
	],
	jsonl: [
		["tree", "树"],
		["source", "源码"],
	],
	csv: [
		["table", "表格"],
		["source", "源码"],
	],
	// hex 不给「源码」：服务端对二进制内容不返回 text（latin1 回写会毁坏字节）
	binary: [
		["info", "信息"],
		["hex", "Hex"],
	],
	office: [
		["info", "信息"],
		["hex", "Hex"],
	],
};

const KIND_LABEL = {
	image: "图片",
	svg: "SVG",
	pdf: "PDF",
	video: "视频",
	audio: "音频",
	font: "字体",
	markdown: "Markdown",
	csv: "表格",
	json: "JSON",
	jsonl: "JSON Lines",
	hex: "Hex",
	code: "文本",
	binary: "二进制",
	office: "文档",
};

const MAX_RESTORE_TABS = 16;

/** 显式模式 → 渲染器（模式优先于 kind：binary 也能切到 hex 看字节）。 */
const MODE_RENDERER = {
	preview: "markdown",
	source: "code",
	image: "image",
	tree: "json",
	table: "csv",
	hex: "hex",
	info: "info",
};

/** 某 kind 的默认查看模式（双模格式取第一个，其余 null）。 */
function defaultMode(kind) {
	const modes = MODES[kind];
	return modes ? modes[0][0] : null;
}

/** kind + mode → 实际渲染器。 */
function rendererOf(kind, mode) {
	if (mode && MODE_RENDERER[mode]) return MODE_RENDERER[mode];
	if (kind === "image" || kind === "svg") return "image";
	if (kind === "pdf") return "pdf";
	if (kind === "video" || kind === "audio") return "media";
	if (kind === "font") return "font";
	if (kind === "markdown") return "markdown";
	if (kind === "csv") return "csv";
	if (kind === "json" || kind === "jsonl") return "json";
	if (kind === "hex") return "hex";
	if (kind === "binary" || kind === "office") return "info";
	return "code";
}

export default {
	mount(container, ctx) {
		const conn = createConn(ctx, 60000);
		const rawUrl = makeRawUrl(ctx.pluginId);
		const settings = { autoReload: true, imageCheckerboard: true, restoreTabs: true };

		/** @type {{path:string,name:string,file:any,error:string|null,mode:string|null,dirty:boolean,loading:boolean}[]} */
		let tabs = [];
		let activePath = null;
		let root = "";
		let childrenCache = new Map();
		const expanded = new Set([""]);
		const loadingDirs = new Set();
		let filterQuery = "";
		let searchResults = null;

		let currentEditor = null;
		let currentViewer = null;
		let disposed = false;

		// ------------------------------------------------------------ DOM 骨架
		container.innerHTML = "";
		const rootEl = el("div", { class: "vpro" });
		const styleEl = el("style", { text: CSS });
		const sideEl = el("div", { class: "vpro-side" });
		const sideHead = el("div", { class: "vpro-side-head" }, [
			el("button", {
				type: "button",
				class: "vpro-iconbtn vpro-toggle-side",
				title: "窄屏下显示/隐藏文件树",
				text: "☰",
				onclick: () => rootEl.classList.toggle("side-open"),
			}),
			el("b", { text: "资源管理器" }),
			el("button", {
				type: "button",
				class: "vpro-iconbtn",
				title: "新建文件",
				text: "＋",
				onclick: () => void newEntry("file"),
			}),
			el("button", {
				type: "button",
				class: "vpro-iconbtn",
				title: "新建文件夹",
				text: "🗀",
				onclick: () => void newEntry("dir"),
			}),
			el("button", {
				type: "button",
				class: "vpro-iconbtn",
				title: "刷新",
				text: "⟳",
				onclick: () => void refreshAll(),
			}),
		]);
		const filterInput = el("input", {
			type: "text",
			placeholder: "按文件名过滤（回车打开首个结果）",
			"aria-label": "按文件名过滤",
		});
		const filterWrap = el("div", { class: "vpro-filter" }, [filterInput]);
		const treeEl = el("div", { class: "vpro-tree" });

		// 侧栏两个视图：资源管理器（文件名过滤 + 树）/ 搜索（内容搜 + 批量替换）
		const explorerPane = el("div", { class: "vpro-pane on" }, [filterWrap, treeEl]);
		const searchPane = el("div", { class: "vpro-pane" });
		const explorerTabBtn = el("button", {
			type: "button",
			class: "vpro-sidtab on",
			text: "文件",
			title: "资源管理器（Ctrl/⌘+Shift+E）",
		});
		const searchTabBtn = el("button", {
			type: "button",
			class: "vpro-sidtab",
			text: "搜索",
			title: "内容搜索（Ctrl/⌘+Shift+F）",
		});
		const sideTabs = el("div", { class: "vpro-side-tabs" }, [explorerTabBtn, searchTabBtn]);
		sideEl.append(sideHead, sideTabs, explorerPane, searchPane);

		/** @type {null | ReturnType<typeof createSearchPanel>} */
		let searchPanel = null;
		function setSideView(view) {
			const isSearch = view === "search";
			explorerTabBtn.classList.toggle("on", !isSearch);
			searchTabBtn.classList.toggle("on", isSearch);
			explorerPane.classList.toggle("on", !isSearch);
			searchPane.classList.toggle("on", isSearch);
			if (window.matchMedia?.("(max-width: 760px)").matches) rootEl.classList.add("side-open");
		}
		explorerTabBtn.addEventListener("click", () => setSideView("explorer"));
		searchTabBtn.addEventListener("click", () => setSideView("search"));

		const splitter = el("div", { class: "vpro-splitter", title: "拖动调整宽度" });
		const mainEl = el("div", { class: "vpro-main" });
		const tabsEl = el("div", { class: "vpro-tabs" });
		const toolbarEl = el("div", { class: "vpro-toolbar" });
		const contentEl = el("div", { class: "vpro-content" });
		const statusEl = el("div", { class: "vpro-status" });
		mainEl.append(tabsEl, toolbarEl, contentEl, statusEl);
		const toastEl = el("div", { class: "vpro-toast" });
		rootEl.append(styleEl, sideEl, splitter, mainEl, toastEl);
		container.appendChild(rootEl);

		// ------------------------------------------------------------ 小工具
		let toastTimer = null;
		function toast(text, isError = false) {
			toastEl.textContent = text;
			toastEl.classList.toggle("error", Boolean(isError));
			toastEl.classList.add("on");
			if (toastTimer) clearTimeout(toastTimer);
			toastTimer = setTimeout(() => toastEl.classList.remove("on"), 2600);
		}

		const raw = (path, opts) => rawUrl(path, opts);

		function tabsStoreKey() {
			return `vpro:tabs:${root}`;
		}

		function persistTabs() {
			if (!settings.restoreTabs) return;
			store.set(tabsStoreKey(), { open: tabs.map((t) => t.path).slice(0, MAX_RESTORE_TABS), active: activePath });
		}

		function activeTab() {
			return tabs.find((t) => t.path === activePath) ?? null;
		}

		// ------------------------------------------------------------ 文件树
		async function loadDir(rel) {
			if (childrenCache.has(rel) || loadingDirs.has(rel)) return childrenCache.get(rel) ?? [];
			loadingDirs.add(rel);
			renderTree();
			const r = await conn.req({ action: "list", path: rel });
			loadingDirs.delete(rel);
			if (!r.ok) {
				toast(`打开目录失败：${r.error ?? "未知错误"}`, true);
				childrenCache.set(rel, []);
				renderTree();
				return [];
			}
			childrenCache.set(rel, r.entries ?? []);
			renderTree();
			return r.entries ?? [];
		}

		function renderTree() {
			if (disposed) return;
			treeEl.replaceChildren();
			if (filterQuery) {
				if (!searchResults) {
					treeEl.appendChild(el("div", { class: "vpro-tree-empty", text: "搜索中…" }));
					return;
				}
				if (!searchResults.length) {
					treeEl.appendChild(el("div", { class: "vpro-tree-empty", text: `没有匹配「${filterQuery}」的文件` }));
					return;
				}
				for (const m of searchResults) {
					treeEl.appendChild(
						makeRow({
							rel: m.path,
							name: m.name,
							type: "file",
							depth: 0,
							hint: parentOf(m.path) || ".",
						}),
					);
				}
				return;
			}
			if (!childrenCache.has("")) {
				treeEl.appendChild(el("div", { class: "vpro-tree-empty", text: "加载中…" }));
				return;
			}
			renderBranch("", 0, treeEl);
			if (!treeEl.childElementCount) treeEl.appendChild(el("div", { class: "vpro-tree-empty", text: "工作区是空的" }));
		}

		function renderBranch(rel, depth, host) {
			const entries = childrenCache.get(rel) ?? [];
			for (const entry of entries) {
				const childRel = joinRel(rel, entry.name);
				host.appendChild(makeRow({ rel: childRel, name: entry.name, type: entry.type, depth, size: entry.size }));
				if (entry.type === "dir" && expanded.has(childRel)) {
					if (loadingDirs.has(childRel)) {
						host.appendChild(el("div", { class: "vpro-tree-empty", text: "　".repeat(depth + 2) + "加载中…" }));
					} else {
						renderBranch(childRel, depth + 1, host);
					}
				}
			}
		}

		function makeRow({ rel, name, type, depth, size, hint }) {
			const row = el("div", {
				class: "vpro-row",
				title: rel,
				dataset: { path: rel, type },
				style: `padding-left:${8 + depth * 13}px`,
			});
			row.appendChild(el("span", { class: "vpro-caret", text: type === "dir" ? (expanded.has(rel) ? "▾" : "▸") : "" }));
			row.appendChild(el("span", { text: iconFor(name, type) }));
			row.appendChild(el("span", { class: "vpro-name", text: name }));
			if (hint) row.appendChild(el("span", { class: "vpro-size", text: hint }));
			else if (type === "file" && Number(size) > 0)
				row.appendChild(el("span", { class: "vpro-size", text: fmtBytes(size) }));
			if (rel === activePath) row.classList.add("active");
			row.addEventListener("click", () => {
				if (type === "dir") void toggleDir(rel);
				else void openPath(rel);
			});
			row.addEventListener("contextmenu", (ev) => {
				ev.preventDefault();
				showNodeMenu(ev.clientX, ev.clientY, { rel, name, type });
			});
			return row;
		}

		async function toggleDir(rel) {
			if (expanded.has(rel)) {
				expanded.delete(rel);
				renderTree();
				return;
			}
			expanded.add(rel);
			if (!childrenCache.has(rel)) await loadDir(rel);
			else renderTree();
		}

		const runFilter = debounce(async (query) => {
			if (!query) {
				searchResults = null;
				renderTree();
				return;
			}
			const r = await conn.req({ action: "search", query, base: "" });
			if (!r.ok) {
				searchResults = [];
				toast(`搜索失败：${r.error ?? "未知错误"}`, true);
			} else searchResults = r.matches ?? [];
			renderTree();
		}, 180);

		filterInput.addEventListener("input", () => {
			filterQuery = filterInput.value.trim();
			if (!filterQuery) {
				searchResults = null;
				renderTree();
				return;
			}
			renderTree();
			void runFilter(filterQuery);
		});
		filterInput.addEventListener("keydown", (ev) => {
			if (ev.key !== "Enter") return;
			const first = searchResults?.[0];
			if (first) {
				ev.preventDefault();
				void openPath(first.path);
			}
		});

		async function refreshAll() {
			childrenCache = new Map();
			expanded.clear();
			expanded.add("");
			searchResults = null;
			const r = await conn.req({ action: "ping" });
			if (r.ok && r.root) root = r.root;
			await loadDir("");
			renderAll();
		}

		// ------------------------------------------------------------ 右键菜单
		let menuEl = null;
		function closeMenu() {
			if (!menuEl) return;
			menuEl.remove();
			menuEl = null;
			document.removeEventListener("pointerdown", onDocPointerDown, true);
			document.removeEventListener("keydown", onMenuKey, true);
		}
		function onDocPointerDown(ev) {
			if (menuEl && !menuEl.contains(ev.target)) closeMenu();
		}
		function onMenuKey(ev) {
			if (ev.key === "Escape") closeMenu();
		}
		function showMenu(x, y, items) {
			closeMenu();
			const menu = el("div", { class: "vpro-menu", role: "menu" });
			for (const item of items) {
				if (!item) continue;
				if (item.sep) {
					menu.appendChild(el("div", { class: "vpro-menu-sep" }));
					continue;
				}
				const row = el("div", {
					class: `vpro-menu-item${item.danger ? " danger" : ""}`,
					role: "menuitem",
					text: item.label,
				});
				row.addEventListener("click", () => {
					closeMenu();
					void item.onSelect?.();
				});
				menu.appendChild(row);
			}
			document.body.appendChild(menu);
			const rect = menu.getBoundingClientRect();
			const left = Math.min(x, window.innerWidth - rect.width - 8);
			const top = Math.min(y, window.innerHeight - rect.height - 8);
			menu.style.left = `${Math.max(6, left)}px`;
			menu.style.top = `${Math.max(6, top)}px`;
			menuEl = menu;
			setTimeout(() => {
				document.addEventListener("pointerdown", onDocPointerDown, true);
				document.addEventListener("keydown", onMenuKey, true);
			}, 0);
		}

		function showNodeMenu(x, y, node) {
			const dir = node.type === "dir" ? node.rel : parentOf(node.rel);
			const isFile = node.type === "file";
			showMenu(x, y, [
				isFile
					? {
							label: "打开",
							onSelect: () => openPath(node.rel),
						}
					: {
							label: expanded.has(node.rel) ? "折叠" : "展开",
							onSelect: () => toggleDir(node.rel),
						},
				isFile
					? {
							label: "以源码打开",
							onSelect: async () => {
								await openPath(node.rel);
								const tab = tabs.find((t) => t.path === node.rel);
								if (!tab?.file) return;
								if (!MODES[tab.file.kind]?.some(([mode]) => mode === "source")) {
									toast("该格式没有源码视图（二进制）", true);
									return;
								}
								tab.mode = "source";
								await showTab(tab);
								renderToolbar();
							},
						}
					: null,
				isFile
					? {
							label: "下载到电脑",
							onSelect: () => download(node.rel),
						}
					: null,
				{
					label: "在此目录中搜索…",
					onSelect: () => openSearch(node.type === "dir" ? node.rel : parentOf(node.rel)),
				},
				{ sep: true },
				{
					label: "新建文件…",
					onSelect: () => newEntry("file", dir),
				},
				{
					label: "新建文件夹…",
					onSelect: () => newEntry("dir", dir),
				},
				{ sep: true },
				{
					label: "重命名…",
					onSelect: () => renameEntry(node),
				},
				{
					label: node.type === "dir" ? "删除文件夹…" : "删除文件…",
					danger: true,
					onSelect: () => deleteEntry(node),
				},
				{ sep: true },
				{
					label: "复制路径",
					onSelect: async () => {
						try {
							await navigator.clipboard.writeText(node.rel);
							toast("已复制路径");
						} catch {
							toast("复制失败", true);
						}
					},
				},
				window.__piWebUiHost?.openFileContextMenu
					? {
							label: "宿主文件菜单…",
							onSelect: () =>
								window.__piWebUiHost.openFileContextMenu({
									x,
									y,
									path: node.rel,
									kind: node.type === "dir" ? "dir" : "file",
									label: node.name,
									onHostAction: (actionId) => toast(`宿主动作：${actionId}`),
								}),
						}
					: null,
				{
					label: "刷新",
					onSelect: () => {
						childrenCache.delete(dir);
						void loadDir(dir);
					},
				},
			]);
		}

		function download(rel) {
			const a = document.createElement("a");
			a.href = raw(rel, { download: true });
			a.download = baseName(rel);
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		}

		async function newEntry(kind, dirOverride) {
			const dir = dirOverride ?? targetDir();
			const label = kind === "dir" ? "新文件夹名" : "新文件名";
			const name = window.prompt(label, kind === "dir" ? "新建文件夹" : "untitled.txt");
			if (!name) return;
			const path = joinRel(dir, name.trim());
			const r = await conn.req({ action: "create", path, kind: kind === "dir" ? "dir" : "file" });
			if (!r.ok) {
				toast(`创建失败：${r.error ?? "未知错误"}`, true);
				return;
			}
			childrenCache.delete(dir);
			if (kind === "dir") expanded.add(dir);
			await loadDir(dir);
			toast(`已创建 ${path}`);
			if (kind !== "dir") void openPath(path);
		}

		function targetDir() {
			const sel = treeEl.querySelector(".vpro-row.active") ?? treeEl.querySelector(".vpro-row");
			if (!sel) return "";
			const type = sel.dataset.type;
			return type === "dir" ? sel.dataset.path : parentOf(sel.dataset.path);
		}

		async function renameEntry(node) {
			const next = window.prompt("新名字", node.name);
			if (!next || next === node.name) return;
			const r = await conn.req({ action: "rename", path: node.rel, name: next.trim() });
			if (!r.ok) {
				toast(`重命名失败：${r.error ?? "未知错误"}`, true);
				return;
			}
			const newRel = r.path;
			// 打开着的标签跟着改名（含子路径）；active 指针按「改名前的路径」映射
			const affected = tabs.filter((t) => t.path === node.rel || t.path.startsWith(`${node.rel}/`));
			const activeTabRef = affected.find((t) => t.path === activePath) ?? null;
			for (const tab of affected) {
				tab.path = newRel + tab.path.slice(node.rel.length);
				tab.name = baseName(tab.path);
				// 查看器用 file.path 拼 raw URL，改名后必须同步，否则图片会 404
				if (tab.file) tab.file.path = tab.path;
			}
			if (activeTabRef) activePath = activeTabRef.path;
			childrenCache.delete(parentOf(node.rel));
			await loadDir(parentOf(node.rel));
			renderAll();
		}

		async function deleteEntry(node) {
			const ok = window.confirm(`确定删除「${node.rel}」${node.type === "dir" ? "（含其中所有内容）" : ""}？`);
			if (!ok) return;
			const r = await conn.req({ action: "delete", path: node.rel, isDir: node.type === "dir" });
			if (!r.ok) {
				toast(`删除失败：${r.error ?? "未知错误"}`, true);
				return;
			}
			const gone = tabs.filter((t) => t.path === node.rel || t.path.startsWith(`${node.rel}/`));
			if (gone.some((t) => t.dirty) && !window.confirm("被删除的文件里有未保存修改，仍然关闭标签？")) return;
			for (const tab of gone) closeTabState(tab.path);
			childrenCache.delete(parentOf(node.rel));
			await loadDir(parentOf(node.rel));
			renderAll();
			// 被删的可能正是当前打开的文件：内容区跟着换成邻居标签或空态
			const next = activeTab();
			if (next) await showTab(next);
			else {
				disposeContent();
				renderEmptyState();
			}
		}

		// ------------------------------------------------------------ 标签
		function closeTabState(path) {
			const idx = tabs.findIndex((t) => t.path === path);
			if (idx >= 0) tabs.splice(idx, 1);
			if (activePath === path) activePath = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
		}

		function closeTab(path, { force = false } = {}) {
			const tab = tabs.find((t) => t.path === path);
			if (!tab) return;
			if (tab.dirty && !force && !window.confirm(`「${tab.name}」有未保存的修改，确定关闭？`)) return;
			closeTabState(path);
			if (!activePath) {
				disposeContent();
				renderAll();
				renderEmptyState();
				return;
			}
			const next = activeTab();
			if (next) void showTab(next);
			renderAll();
		}

		async function openPath(path, { focus = true } = {}) {
			rootEl.classList.remove("side-open");
			let tab = tabs.find((t) => t.path === path);
			if (!tab) {
				tab = { path, name: baseName(path), file: null, error: null, mode: null, dirty: false, loading: false };
				tabs.push(tab);
			}
			activePath = path;
			if (!tab.file) {
				await loadFile(tab);
			} else if (settings.autoReload && !tab.dirty) {
				void refreshIfStale(tab);
			}
			if (disposed) return;
			await showTab(tab);
			renderAll();
			if (focus) {
				rootEl.querySelector(".vpro-row.active")?.scrollIntoView?.({ block: "nearest" });
				currentEditor?.focus();
			}
		}

		async function loadFile(tab) {
			tab.loading = true;
			renderToolbar();
			const r = await conn.req({ action: "open", path: tab.path });
			tab.loading = false;
			if (!r.ok) {
				tab.file = null;
				tab.error = r.error ?? "打开失败";
				return;
			}
			tab.file = r.file;
			tab.error = null;
			tab.dirty = false;
			if (!tab.mode) tab.mode = defaultMode(r.file.kind);
		}

		async function refreshIfStale(tab) {
			const r = await conn.req({ action: "stat", path: tab.path });
			if (!r.ok || !r.mtime) return;
			if (r.mtime === tab.file?.mtime) return;
			await loadFile(tab);
			if (activePath === tab.path) await showTab(tab);
			toast("检测到磁盘改动，已重新加载");
		}

		// ------------------------------------------------------------ 搜索面板
		searchPanel = createSearchPanel({
			conn,
			toast,
			selectedDir: () => targetDir(),
			activeFile: () => activePath ?? "",
			openAt: (path, loc) => void openAt(path, loc),
			onFilesChanged: (paths) => void refreshChangedTabs(paths),
		});
		searchPane.appendChild(searchPanel.dom);

		/** 打开搜索视图（可带范围目录/预填关键字）。 */
		function openSearch(base, seed) {
			setSideView("search");
			searchPanel?.focus({ base, query: seed });
		}

		/**
		 * 打开文件并定位到某行某列（（搜索结果、替换后刷新都用它）。
		 * 非文本查看器（图片/PDF…）自动切「源码」再定位，双模都没有则提示。
		 */
		async function openAt(path, loc) {
			await openPath(path, { focus: false });
			const tab = tabs.find((t) => t.path === path);
			if (!tab?.file) return;
			const renderer = rendererOf(tab.file.kind, tab.mode ?? defaultMode(tab.file.kind));
			if (renderer !== "code") {
				if (MODES[tab.file.kind]?.some(([mode]) => mode === "source")) {
					tab.mode = "source";
					await showTab(tab);
					renderToolbar();
				} else {
					toast("该格式没有源码视图，无法定位到行", true);
					return;
				}
			}
			currentEditor?.gotoLine(loc.line, loc.col, loc.length);
		}

		/** 批量替换后把已打开且无未保存修改的标签重读（脏标签不覆盖）。 */
		async function refreshChangedTabs(paths) {
			const changed = new Set(paths ?? []);
			if (!changed.size) return;
			for (const tab of tabs) {
				if (!changed.has(tab.path) || tab.dirty) continue;
				await loadFile(tab);
				if (activePath === tab.path) await showTab(tab);
			}
			renderTabs();
			renderToolbar();
			renderStatus();
			// 批量替换也是写盘：顺手叫源代码管理面板刷新（C）
			notifyScmChanged();
		}

		// ------------------------------------------------------------ 内容
		function disposeContent() {
			try {
				currentEditor?.destroy();
			} catch {}
			currentEditor = null;
			try {
				currentViewer?.dispose?.();
			} catch {}
			currentViewer = null;
			contentEl.replaceChildren();
		}

		async function showTab(tab) {
			disposeContent();
			if (tab.error || !tab.file) {
				contentEl.appendChild(
					el("div", { class: "vpro-empty" }, [
						el("div", { class: "vpro-empty-title", text: tab.error ? "打不开这个文件" : "加载中…" }),
						tab.error ? el("div", { class: "vpro-empty-sub", text: tab.error }) : null,
						tab.error
							? el("div", { class: "vpro-empty-actions" }, [
									el("button", {
										type: "button",
										class: "vpro-btn",
										text: "重试",
										onclick: () => {
											void loadFile(tab).then(() => (activePath === tab.path ? showTab(tab) : null));
										},
									}),
								])
							: null,
					]),
				);
				return;
			}
			const file = tab.file;
			const kind = file.kind;
			const mode = tab.mode ?? defaultMode(kind);
			const renderer = rendererOf(kind, mode);

			if (file.truncated) {
				contentEl.appendChild(
					el("div", {
						class: "vpro-banner",
						text: `文件超过 4MB，仅显示开头部分（只读，避免误写回截断内容）。下载后可完整查看。`,
					}),
				);
			}

			const host = el("div", { class: "vpro-editor" });
			if (renderer === "code") {
				const readOnly = Boolean(file.truncated) || file.kind === "hex";
				contentEl.appendChild(host);
				const wrapProse = ["markdown", "code"].includes(kind) && /\.(md|markdown|mdx|txt|log|text)$/i.test(file.name);
				currentEditor = new CodeEditor({
					parent: host,
					doc: file.text ?? "",
					lang: file.lang,
					readOnly,
					wrap: wrapProse,
					light: isLightTheme(),
					onChange: () => {
						if (!currentEditor || !tab.file || tab.file.truncated) return;
						const dirty = currentEditor.text !== (tab.file.text ?? "");
						if (dirty !== tab.dirty) {
							tab.dirty = dirty;
							renderTabs();
							renderToolbar();
							renderStatus();
						}
					},
					onSave: () => void saveActive(),
				});
			} else {
				const viewerOpts = {
					file,
					rawUrl: raw,
					conn,
					settings,
					toast,
					openPath: (rel) => void openPath(rel),
					onSwitchView: (next) => {
						tab.mode = next;
						void showTab(tab);
						renderToolbar();
					},
				};
				let viewer;
				if (renderer === "image") viewer = mountImageViewer(viewerOpts);
				else if (renderer === "media") viewer = mountMediaViewer(viewerOpts);
				else if (renderer === "pdf") viewer = mountPdfViewer(viewerOpts);
				else if (renderer === "font") viewer = mountFontViewer(viewerOpts);
				else if (renderer === "markdown") viewer = mountMarkdownViewer(viewerOpts);
				else if (renderer === "csv") viewer = mountCsvViewer(viewerOpts);
				else if (renderer === "json") viewer = mountJsonViewer(viewerOpts);
				else if (renderer === "hex") viewer = mountHexViewer(viewerOpts);
				else viewer = mountInfoViewer(viewerOpts);
				currentViewer = viewer;
				contentEl.appendChild(viewer.dom);
			}
			renderToolbar();
			renderStatus();
		}

		async function saveActive() {
			const tab = activeTab();
			if (!tab || !currentEditor || !tab.file) return;
			if (tab.file.truncated) {
				toast("文件过大被截断，已禁止写回", true);
				return;
			}
			const text = currentEditor.text;
			const r = await conn.req({ action: "write", path: tab.path, text });
			if (!r.ok) {
				toast(`保存失败：${r.error ?? "未知错误"}`, true);
				return;
			}
			tab.file.text = text;
			tab.file.size = r.size ?? tab.file.size;
			tab.file.mtime = r.mtime ?? tab.file.mtime;
			tab.file.lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
			tab.dirty = false;
			renderTabs();
			renderToolbar();
			renderStatus();
			toast("已保存");
			notifyScmChanged();
		}

		// ------------------------------------------------------------ 渲染
		function renderAll() {
			renderTabs();
			renderToolbar();
			renderStatus();
			renderTree();
			persistTabs();
		}

		function renderTabs() {
			tabsEl.replaceChildren();
			if (!tabs.length) {
				tabsEl.appendChild(el("div", { class: "vpro-tabs-empty", text: "没有打开的文件（Ctrl/⌘+P 快速打开）" }));
				return;
			}
			for (const tab of tabs) {
				const node = el("div", { class: `vpro-tab${tab.path === activePath ? " active" : ""}`, title: tab.path });
				node.appendChild(el("span", { text: iconFor(tab.name, "file") }));
				node.appendChild(el("span", { class: "vpro-tab-name", text: tab.name }));
				if (tab.dirty) node.appendChild(el("span", { class: "vpro-dot", title: "未保存" }));
				const close = el("button", { type: "button", class: "vpro-close", title: "关闭（Ctrl/⌘+W）", text: "✕" });
				close.addEventListener("click", (ev) => {
					ev.stopPropagation();
					closeTab(tab.path);
				});
				node.appendChild(close);
				node.addEventListener("click", () => {
					if (tab.path === activePath) return;
					void openPath(tab.path);
				});
				node.addEventListener("auxclick", (ev) => {
					if (ev.button === 1) closeTab(tab.path);
				});
				node.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					showMenu(ev.clientX, ev.clientY, [
						{ label: "关闭", onSelect: () => closeTab(tab.path) },
						{
							label: "关闭其它",
							onSelect: () => {
								for (const t of tabs.slice()) if (t.path !== tab.path) closeTab(t.path, { force: !t.dirty });
							},
						},
						{ label: "关闭全部", onSelect: () => closeAllTabs() },
						{ sep: true },
						{
							label: "复制路径",
							onSelect: () => void navigator.clipboard?.writeText(tab.path).then(() => toast("已复制路径")),
						},
					]);
				});
				tabsEl.appendChild(node);
			}
		}

		function renderEmptyState() {
			contentEl.replaceChildren(
				el("div", { class: "vpro-empty" }, [
					el("div", { class: "vpro-empty-title", text: "选择一个文件开始" }),
					el("div", {
						class: "vpro-empty-sub",
						text: "图片 / PDF / 音视频 / 字体 / Markdown / CSV / JSON / 二进制都有对应查看器；Ctrl/⌘+P 快速打开，Ctrl/⌘+Shift+F 全工作区搜内容，Ctrl/⌘+S 保存。",
					}),
				]),
			);
		}

		function closeAllTabs() {
			const dirty = tabs.filter((t) => t.dirty);
			if (dirty.length && !window.confirm(`${dirty.length} 个文件有未保存修改，确定全部关闭？`)) return;
			tabs = [];
			activePath = null;
			disposeContent();
			renderAll();
			renderEmptyState();
		}

		function renderToolbar() {
			toolbarEl.replaceChildren();
			const tab = activeTab();
			if (!tab) return;
			const file = tab.file;
			toolbarEl.appendChild(el("span", { class: "vpro-crumb", text: tab.path, title: tab.path }));
			const modes = file ? MODES[file.kind] : null;
			if (modes && modes.length > 1) {
				const seg = el("div", { class: "vpro-seg" });
				const current = tab.mode ?? defaultMode(file.kind);
				for (const [mode, label] of modes) {
					const btn = el("button", { type: "button", class: mode === current ? "on" : "", text: label });
					btn.addEventListener("click", () => {
						tab.mode = mode;
						void showTab(tab);
					});
					seg.appendChild(btn);
				}
				toolbarEl.appendChild(seg);
			}
			const renderer = file ? rendererOf(file.kind, tab.mode ?? defaultMode(file.kind)) : "code";
			if (renderer === "code" && file && !file.truncated && file.kind !== "hex") {
				const saveBtn = el("button", { type: "button", class: "vpro-tool", text: "保存" });
				saveBtn.disabled = !tab.dirty;
				saveBtn.addEventListener("click", () => void saveActive());
				toolbarEl.appendChild(saveBtn);
			}
			const reloadBtn = el("button", { type: "button", class: "vpro-tool", text: "重新加载", title: "从磁盘重新读取" });
			reloadBtn.addEventListener("click", async () => {
				if (tab.dirty && !window.confirm("有未保存修改，重新加载会丢弃，继续？")) return;
				tab.dirty = false;
				await loadFile(tab);
				await showTab(tab);
				renderTabs();
				renderToolbar();
			});
			toolbarEl.appendChild(reloadBtn);
			toolbarEl.appendChild(
				el("button", {
					type: "button",
					class: "vpro-tool",
					text: "下载",
					title: "下载原文件到电脑",
					onclick: () => download(tab.path),
				}),
			);
		}

		function renderStatus() {
			statusEl.replaceChildren();
			const tab = activeTab();
			if (!tab) {
				statusEl.appendChild(el("span", { class: "vpro-status-item", text: root ? `工作区 ${root}` : "—" }));
				return;
			}
			const file = tab.file;
			statusEl.appendChild(el("span", { class: "vpro-status-path", text: tab.path, title: tab.path }));
			if (tab.dirty) statusEl.appendChild(el("span", { class: "vpro-status-item vpro-dirty", text: "未保存 ●" }));
			if (!file) {
				statusEl.appendChild(el("span", { class: "vpro-status-item", text: tab.error ?? "加载中…" }));
				return;
			}
			const mode = tab.mode ?? defaultMode(file.kind);
			const renderer = rendererOf(file.kind, mode);
			statusEl.appendChild(
				el("span", {
					class: "vpro-status-item",
					text: renderer === "code" ? langLabel(file.lang) : (KIND_LABEL[file.kind] ?? file.kind),
				}),
			);
			statusEl.appendChild(el("span", { class: "vpro-status-item", text: fmtBytes(file.size) }));
			if (file.encoding) statusEl.appendChild(el("span", { class: "vpro-status-item", text: file.encoding }));
			if (file.lines) statusEl.appendChild(el("span", { class: "vpro-status-item", text: `${file.lines} 行` }));
			if (file.dimensions)
				statusEl.appendChild(
					el("span", {
						class: "vpro-status-item",
						text: `${file.dimensions.width}×${file.dimensions.height}`,
					}),
				);
			if (file.truncated) statusEl.appendChild(el("span", { class: "vpro-status-item vpro-dirty", text: "已截断" }));
			if (currentEditor) {
				const pos = currentEditor.cursor();
				statusEl.appendChild(el("span", { class: "vpro-status-item", text: `行 ${pos.line}，列 ${pos.col}` }));
			}
			statusEl.appendChild(el("span", { class: "vpro-status-item", text: fmtTime(file.mtime) }));
		}

		// ------------------------------------------------------------ 快速打开
		let quickEl = null;
		let quickIndex = 0;
		let quickItems = [];
		async function openQuickOpen() {
			if (quickEl) {
				quickEl.querySelector("input")?.focus();
				return;
			}
			const overlay = el("div", { class: "vpro-quick" });
			const panel = el("div", { class: "vpro-quick-panel" });
			const input = el("input", {
				type: "text",
				placeholder: "输入文件名快速打开（Esc 取消）",
				"aria-label": "快速打开",
			});
			const list = el("div", { class: "vpro-quick-list" });
			panel.append(input, list);
			overlay.appendChild(panel);
			overlay.addEventListener("pointerdown", (ev) => {
				if (ev.target === overlay) closeQuickOpen();
			});
			rootEl.appendChild(overlay);
			quickEl = overlay;
			quickItems = [];
			quickIndex = 0;

			const paint = () => {
				list.replaceChildren();
				if (!quickItems.length) {
					list.appendChild(
						el("div", { class: "vpro-tree-empty", text: input.value ? "没有匹配" : "最近打开 / 全部文件" }),
					);
					return;
				}
				quickItems.forEach((item, idx) => {
					const row = el("div", { class: `vpro-quick-item${idx === quickIndex ? " active" : ""}` }, [
						el("span", { text: iconFor(item.name, "file") }),
						el("span", { class: "vpro-quick-name", text: item.name }),
						el("span", { class: "vpro-quick-dir", text: parentOf(item.path) || "." }),
					]);
					row.addEventListener("click", () => {
						closeQuickOpen();
						void openPath(item.path);
					});
					list.appendChild(row);
				});
				list.children[quickIndex]?.scrollIntoView?.({ block: "nearest" });
			};

			const search = debounce(async (query) => {
				if (!query) {
					quickItems = tabs
						.slice()
						.reverse()
						.map((t) => ({ path: t.path, name: t.name }));
					paint();
					return;
				}
				const r = await conn.req({ action: "search", query, base: "" });
				quickItems = r.ok ? (r.matches ?? []) : [];
				quickIndex = 0;
				paint();
			}, 140);

			input.addEventListener("input", () => void search(input.value.trim()));
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Escape") {
					ev.preventDefault();
					closeQuickOpen();
					return;
				}
				if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
					ev.preventDefault();
					if (!quickItems.length) return;
					quickIndex = (quickIndex + (ev.key === "ArrowDown" ? 1 : -1) + quickItems.length) % quickItems.length;
					paint();
					return;
				}
				if (ev.key === "Enter") {
					ev.preventDefault();
					const item = quickItems[quickIndex];
					if (!item) return;
					closeQuickOpen();
					void openPath(item.path);
				}
			});
			input.focus();
			quickItems = tabs
				.slice()
				.reverse()
				.map((t) => ({ path: t.path, name: t.name }));
			paint();
		}
		function closeQuickOpen() {
			quickEl?.remove();
			quickEl = null;
			quickItems = [];
		}

		// ------------------------------------------------------------ 事件
		function onKeyDown(ev) {
			const mod = ev.ctrlKey || ev.metaKey;
			if (mod && ev.key.toLowerCase() === "p" && !ev.shiftKey) {
				ev.preventDefault();
				void openQuickOpen();
				return;
			}
			if (mod && ev.shiftKey && ev.key.toLowerCase() === "f") {
				ev.preventDefault();
				// 有单行选中内容时当搜索词预填（VS Code 行为）
				const sel = (currentEditor?.selectedText?.() ?? "").split("\n")[0].slice(0, 200);
				openSearch("", sel);
				return;
			}
			if (mod && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
				return;
			}
			if (mod && ev.key.toLowerCase() === "w") {
				if (!activePath) return;
				ev.preventDefault();
				closeTab(activePath);
				return;
			}
			if (mod && ev.shiftKey && ev.key.toLowerCase() === "e") {
				ev.preventDefault();
				rootEl.classList.toggle("side-open");
				setSideView("explorer");
				filterInput.focus();
				return;
			}
			if (ev.key === "Escape") {
				if (menuEl) closeMenu();
				else if (quickEl) closeQuickOpen();
				else if (rootEl.classList.contains("side-open")) rootEl.classList.remove("side-open");
			}
		}
		container.addEventListener("keydown", onKeyDown);

		// 分栏拖动
		const onSplitterDown = (ev) => {
			ev.preventDefault();
			const startX = ev.clientX;
			const startW = sideEl.getBoundingClientRect().width;
			const move = (e) => {
				const next = Math.min(560, Math.max(160, startW + (e.clientX - startX)));
				rootEl.style.setProperty("--vpro-side-w", `${Math.round(next)}px`);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		};
		splitter.addEventListener("pointerdown", onSplitterDown);

		// 主题切换
		const onThemeChange = () => {
			try {
				currentEditor?.setTheme(isLightTheme());
			} catch {}
		};
		document.addEventListener(THEME_EVENT, onThemeChange);

		// 工作区切换
		const offWorkspace = conn.onData((payload) => {
			if (!payload || payload.kind !== "workspace") return;
			const nextRoot = String(payload.root ?? "");
			if (!nextRoot || nextRoot === root) return;
			const dirty = tabs.filter((t) => t.dirty).length;
			if (dirty && !window.confirm(`${dirty} 个文件有未保存修改，切换工作区会关闭这些标签，继续？`)) return;
			root = nextRoot;
			tabs = [];
			activePath = null;
			childrenCache = new Map();
			expanded.clear();
			expanded.add("");
			searchResults = null;
			filterInput.value = "";
			filterQuery = "";
			searchPanel?.reset();
			disposeContent();
			renderAll();
			void bootstrap();
		});

		// 离开页面前提醒未保存
		const onBeforeUnload = (ev) => {
			if (!tabs.some((t) => t.dirty)) return;
			ev.preventDefault();
			ev.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);

		// ------------------------------------------------------------ 跨插件联动（git-scm ↔ 本插件）
		//
		// 两个插件互不 import（client bundle 只服务自己的 client/ 子树），联动只走**页内契约**：
		//   A（git-scm → 本）：`window.__piVproEditor.open(req)` / `pi:vpro:open` 事件 /
		//      `window.__piVproPending`（bundle 还没挂上时的待办槽）；
		//      req = { source, path, absPath, line?, repoRoot?, workspace? }。
		//   C（本 → git-scm）：写盘成功后回叫 `window.__piGitScm.refresh()`。
		// 对方没装 → 全部静默（不报错、不影响任何本机能力）。
		const BRIDGE_VERSION = 1;
		/** 工作区根还没到手（bootstrap 未跑完）时的早期请求：先受理，root 一到就补开。 */
		const earlyRequests = [];

		/**
		 * 外部请求 → 打开并定位。同步回「是否受理」（发起方要立刻决定切不切视图）。
		 * 路径不在工作区内 → false；文件不存在等读取错误留给标签内的错误态。
		 *
		 * @param {any} req
		 */
		function acceptOpenRequest(req) {
			if (!req || typeof req !== "object") return false;
			if (!root) {
				earlyRequests.push(req);
				return true;
			}
			const absPath = String(req.absPath ?? "");
			const rel = absPath ? relInWorkspace(root, absPath) : String(req.path ?? "");
			if (rel === null || !rel) return false;
			const line = Math.max(0, Math.floor(Number(req.line ?? req.loc?.line) || 0));
			const col = Math.max(1, Math.floor(Number(req.loc?.col) || 1));
			void (line > 0 ? openAt(rel, { line, col }) : openPath(rel));
			return true;
		}

		const onBridgeOpen = (ev) => {
			if (acceptOpenRequest(/** @type {CustomEvent} */ (ev).detail)) ev.preventDefault();
		};
		window.addEventListener("pi:vpro:open", onBridgeOpen);
		const bridgeApi = { version: BRIDGE_VERSION, open: (req) => acceptOpenRequest(req) };
		/** @type {any} */ (window).__piVproEditor = bridgeApi;

		/** 认领发起方留下的待办（view 首次加载 / bundle 晚挂载的竞态）。 */
		function claimPendingOpen() {
			const pending = /** @type {any} */ (window).__piVproPending;
			if (!pending || typeof pending !== "object") return;
			if (Date.now() - Number(pending.at ?? 0) > 30000) {
				/** @type {any} */ (window).__piVproPending = null;
				return;
			}
			if (!acceptOpenRequest(pending)) return; // 不在工作区：留给发起方超时提示
			if (/** @type {any} */ (window).__piVproPending === pending) /** @type {any} */ (window).__piVproPending = null;
		}

		/** 写盘后通知「源代码管理」面板立刻刷新（C）：没装就静默。 */
		function notifyScmChanged() {
			try {
				/** @type {any} */ (window).__piGitScm?.refresh?.();
			} catch {}
		}

		// ------------------------------------------------------------ 启动
		async function bootstrap() {
			const [ping, cfg] = await Promise.all([conn.req({ action: "ping" }), conn.req({ action: "settings" })]);
			if (ping.ok && ping.root) root = ping.root;
			if (cfg.ok && cfg.settings) Object.assign(settings, cfg.settings);
			await loadDir("");
			const saved = settings.restoreTabs ? store.get(tabsStoreKey()) : null;
			renderAll();
			if (saved && Array.isArray(saved.open) && saved.open.length) {
				for (const path of saved.open.slice(0, MAX_RESTORE_TABS)) {
					if (disposed) return;
					try {
						await openPath(path, { focus: false });
					} catch {}
				}
				if (saved.active && tabs.some((t) => t.path === saved.active)) await openPath(saved.active, { focus: false });
			}
			if (!tabs.length) {
				renderEmptyState();
				renderToolbar();
				renderStatus();
			}
			claimPendingOpen();
			// root 已就位：把早期请求补开（方括号快照，免得 accept 里再 push）
			for (const req of earlyRequests.splice(0)) acceptOpenRequest(req);
		}
		void bootstrap();

		// ------------------------------------------------------------ 清理
		return () => {
			disposed = true;
			try {
				container.removeEventListener("keydown", onKeyDown);
			} catch {}
			document.removeEventListener(THEME_EVENT, onThemeChange);
			window.removeEventListener("beforeunload", onBeforeUnload);
			window.removeEventListener("pi:vpro:open", onBridgeOpen);
			// 跨插件桥：只拆自己登记的那份（重挂 / 热重载可能已经换了新实例）
			if (/** @type {any} */ (window).__piVproEditor === bridgeApi) /** @type {any} */ (window).__piVproEditor = null;
			splitter.removeEventListener("pointerdown", onSplitterDown);
			offWorkspace();
			closeMenu();
			closeQuickOpen();
			if (toastTimer) clearTimeout(toastTimer);
			disposeContent();
			conn.dispose();
			rootEl.remove();
		};
	},
};

// ---------------------------------------------------------------------------
// 宿主文件树的 fileHandler：图片/PDF/音视频/字体/Office 等（manifest 里声明）
// ---------------------------------------------------------------------------

/**
 * 宿主文件树点开这些扩展名时，宿主把容器交给这里。视图只渲染查看器本体
 *（没有侧栏/标签），读取走 ctx.apiUrl("/raw") 的原始字节通道。
 */
export const fileHandlers = [
	{
		id: "media",
		mount(container, file, ctx) {
			const conn = createConn(ctx, 60000);
			const rawUrl = (relPath, opts = {}) =>
				ctx.apiUrl("/raw", { path: relPath, download: opts.download ? 1 : undefined, v: opts.bust });
			const rootEl = el("div", { class: "vpro vpro-standalone", style: "grid-template-columns:minmax(0,1fr)" });
			const styleEl = el("style", { text: CSS });
			const contentEl = el("div", { class: "vpro-content" });
			rootEl.append(styleEl, contentEl);
			container.appendChild(rootEl);
			let viewer = null;
			let disposed = false;
			let offTheme = null;

			const toast = (text, isError) => {
				const box = el("div", { class: `vpro-toast on${isError ? " error" : ""}` });
				box.textContent = text;
				rootEl.appendChild(box);
				setTimeout(() => box.classList.remove("on"), 2600);
			};

			void (async () => {
				contentEl.appendChild(el("div", { class: "vpro-empty", text: "加载中…" }));
				const r = await conn.req({ action: "open", path: file.path });
				if (disposed) return;
				contentEl.replaceChildren();
				if (!r.ok) {
					contentEl.appendChild(
						el("div", { class: "vpro-empty" }, [
							el("div", { class: "vpro-empty-title", text: "打不开这个文件" }),
							el("div", { class: "vpro-empty-sub", text: r.error ?? "未知错误" }),
						]),
					);
					return;
				}
				const opened = r.file;
				const opts = { file: opened, rawUrl, conn, settings: {}, toast };
				const renderer = rendererOf(opened.kind, defaultMode(opened.kind));
				if (renderer === "image") viewer = mountImageViewer(opts);
				else if (renderer === "media") viewer = mountMediaViewer(opts);
				else if (renderer === "pdf") viewer = mountPdfViewer(opts);
				else if (renderer === "font") viewer = mountFontViewer(opts);
				else viewer = mountInfoViewer({ ...opts, onSwitchView: null });
				contentEl.appendChild(viewer.dom);
			})();

			return () => {
				disposed = true;
				try {
					viewer?.dispose?.();
				} catch {}
				offTheme?.();
				conn.dispose();
				rootEl.remove();
			};
		},
	},
];
