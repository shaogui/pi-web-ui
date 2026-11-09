/**
 * 搜索面板：**全工作区 / 指定目录** 内的内容搜索（grep）与批量替换。
 *
 * 事实源在服务端 `index.mjs` 的 `search_content` / `replace_content`：
 * 服务端负责遍历、跳过二进制/噪音目录/.gitignore、限流（文件数、命中数、耗时）；
 * 客户端只做「输入 → 结果树 → 点击定位」。
 *
 * 安全：结果行文本来自磁盘 = 不可信输入，一律 `document.createTextNode` 拼装，
 * 全程不碰 innerHTML（高亮只用 `<mark>` 元素）。
 */
import { baseName, debounce, el, iconFor, parentOf } from "./util.js";

/** 区分大小写 / 全字匹配 / 正则 三个开关（VS Code 同款语义）。 */
const FLAGS = [
	{ key: "caseSensitive", label: "Aa", title: "区分大小写" },
	{ key: "wholeWord", label: "ab", title: "全字匹配" },
	{ key: "regex", label: ".*", title: "正则表达式" },
];

const MAX_RESULTS = 1500;
const MAX_PER_FILE = 100;

/**
 * @param {{
 *   conn: { req: (payload: object, timeout?: number) => Promise<any> },
 *   toast: (text: string, isError?: boolean) => void,
 *   openAt: (path: string, loc: { line: number, col: number, length: number }) => void,
 *   selectedDir?: () => string,
 *   activeFile?: () => string,
 *   onFilesChanged?: (paths: string[]) => void,
 * }} opts
 */
export function createSearchPanel(opts) {
	const { conn, toast } = opts;
	const state = {
		replace: "",
		showReplace: false,
		caseSensitive: false,
		wholeWord: false,
		regex: false,
		/** @type {null | {files:any[], totalMatches:number, scanned:number, truncated:boolean, elapsedMs:number}} */
		results: null,
		error: "",
		busy: false,
		collapsed: new Set(),
		activeIndex: -1,
	};
	let seq = 0;
	/** 当前结果的扁平匹配表：[{ filePath, match }]，键盘上下键与 active 高亮共用 */
	let flat = [];

	// ------------------------------------------------------------------ DOM
	const dom = el("div", { class: "vpro-searchpane" });

	const queryInput = el("input", {
		type: "text",
		class: "vpro-sinput",
		placeholder: "搜索内容（Enter 搜索）",
		"aria-label": "搜索内容",
		spellcheck: "false",
	});
	const searchBtn = el("button", { type: "button", class: "vpro-tool", text: "搜索", title: "开始搜索" });
	const rowQuery = el("div", { class: "vpro-srow" }, [queryInput, searchBtn]);

	const baseInput = el("input", {
		type: "text",
		class: "vpro-sinput",
		placeholder: "范围：全工作区（可填子目录或文件，如 src）",
		"aria-label": "搜索范围目录",
		spellcheck: "false",
	});
	const pickBtn = el("button", {
		type: "button",
		class: "vpro-tool",
		text: "选中",
		title: "用左栏文件树里选中的目录作为搜索范围",
	});
	const curBtn = el("button", {
		type: "button",
		class: "vpro-tool",
		text: "当前",
		title: "只在当前打开的文件里搜",
	});
	const allBtn = el("button", { type: "button", class: "vpro-tool", text: "全", title: "范围改回全工作区" });
	const rowBase = el("div", { class: "vpro-srow" }, [baseInput, pickBtn, curBtn, allBtn]);

	const includeInput = el("input", {
		type: "text",
		class: "vpro-sinput",
		placeholder: "包含 *.ts,src/**",
		"aria-label": "包含文件",
		spellcheck: "false",
	});
	const excludeInput = el("input", {
		type: "text",
		class: "vpro-sinput",
		placeholder: "排除 *.min.js",
		"aria-label": "排除文件",
		spellcheck: "false",
	});
	const rowFilter = el("div", { class: "vpro-srow" }, [includeInput, excludeInput]);

	const flagRow = el("div", { class: "vpro-sflags" });
	const flagBtns = new Map();
	for (const flag of FLAGS) {
		const btn = el("button", {
			type: "button",
			class: "vpro-flag",
			text: flag.label,
			title: flag.title,
			"aria-pressed": "false",
		});
		btn.addEventListener("click", () => {
			state[flag.key] = !state[flag.key];
			btn.classList.toggle("on", state[flag.key]);
			btn.setAttribute("aria-pressed", String(state[flag.key]));
			if (state.results) void run();
		});
		flagBtns.set(flag.key, btn);
		flagRow.appendChild(btn);
	}
	const replaceToggle = el("button", {
		type: "button",
		class: "vpro-flag",
		text: "替换",
		title: "展开替换输入框",
		"aria-pressed": "false",
	});
	replaceToggle.addEventListener("click", () => {
		state.showReplace = !state.showReplace;
		replaceToggle.classList.toggle("on", state.showReplace);
		replaceToggle.setAttribute("aria-pressed", String(state.showReplace));
		rowReplace.classList.toggle("vpro-hidden", !state.showReplace);
		if (state.showReplace) replaceInput.focus();
	});
	flagRow.append(el("span", { class: "vpro-sgap" }), replaceToggle);

	const replaceInput = el("input", {
		type: "text",
		class: "vpro-sinput",
		placeholder: "替换为（正则可用 $1）",
		"aria-label": "替换内容",
		spellcheck: "false",
	});
	const replaceBtn = el("button", {
		type: "button",
		class: "vpro-tool",
		text: "全部替换",
		title: "替换所有文件里的匹配",
	});
	const rowReplace = el("div", { class: "vpro-srow vpro-hidden" }, [replaceInput, replaceBtn]);

	const statusEl = el("div", { class: "vpro-sstat" });
	const resultsEl = el("div", { class: "vpro-sresults" });

	dom.append(
		el("div", { class: "vpro-sform" }, [rowQuery, rowBase, rowFilter, flagRow, rowReplace]),
		statusEl,
		resultsEl,
	);

	// --------------------------------------------------------------- 状态栏
	function paintStatus() {
		statusEl.replaceChildren();
		statusEl.classList.toggle("error", Boolean(state.error));
		if (state.busy) {
			statusEl.appendChild(el("span", { text: "搜索中…" }));
			return;
		}
		if (state.error) {
			statusEl.appendChild(el("span", { text: state.error }));
			return;
		}
		const r = state.results;
		if (!r) {
			const scope = baseInput.value.trim();
			statusEl.appendChild(
				el("span", { text: scope ? `范围：${scope}/（Enter 开始搜索）` : "范围：全工作区（Enter 开始搜索）" }),
			);
			return;
		}
		statusEl.appendChild(
			el("span", {
				text: `${r.files.length} 个文件 · ${r.totalMatches} 处匹配`,
			}),
		);
		if (r.truncated) statusEl.appendChild(el("span", { class: "vpro-sflagtext", text: "已截断" }));
		statusEl.appendChild(el("span", { text: `扫描 ${r.scanned} 个文件 · ${r.elapsedMs}ms` }));
	}

	// --------------------------------------------------------------- 结果树
	function matchRow(filePath, match, index) {
		const row = el("div", {
			class: `vpro-smatch${index === state.activeIndex ? " active" : ""}`,
			title: `${filePath}:${match.line}:${match.col}`,
		});
		row.appendChild(el("span", { class: "vpro-sline", text: String(match.line) }));
		const body = el("span", { class: "vpro-sline-text" });
		const start = Math.max(0, match.col - 1 - (match.offset ?? 0));
		const len = Math.max(1, match.length ?? 1);
		const before = match.text.slice(0, start);
		const hit = match.text.slice(start, start + len);
		const after = match.text.slice(start + len);
		if (match.offset > 0) body.appendChild(document.createTextNode("…"));
		if (before) body.appendChild(document.createTextNode(before));
		body.appendChild(el("mark", { text: hit }));
		if (after) body.appendChild(document.createTextNode(after));
		if ((match.offset ?? 0) + match.text.length < (match.lineLength ?? 0))
			body.appendChild(document.createTextNode("…"));
		row.appendChild(body);
		row.addEventListener("click", () => {
			state.activeIndex = index;
			paintResults();
			opts.openAt(filePath, { line: match.line, col: match.col, length: len });
		});
		return row;
	}

	function paintResults() {
		resultsEl.replaceChildren();
		flat = [];
		const r = state.results;
		if (!r) return;
		if (!r.files.length) {
			resultsEl.appendChild(el("div", { class: "vpro-tree-empty", text: "没有匹配" }));
			return;
		}
		for (const file of r.files) {
			const collapsed = state.collapsed.has(file.path);
			const head = el("div", { class: "vpro-sfile", title: file.path });
			head.appendChild(el("span", { class: "vpro-caret", text: collapsed ? "▸" : "▾" }));
			head.appendChild(el("span", { text: iconFor(file.name, "file") }));
			head.appendChild(el("span", { class: "vpro-sfile-name", text: baseName(file.path) }));
			head.appendChild(
				el("span", {
					class: "vpro-sfile-dir",
					text: parentOf(file.path) || ".",
				}),
			);
			head.appendChild(el("span", { class: "vpro-sfile-count", text: `${file.count}${file.truncated ? "+" : ""}` }));
			head.addEventListener("click", () => {
				if (collapsed) state.collapsed.delete(file.path);
				else state.collapsed.add(file.path);
				paintResults();
			});
			resultsEl.appendChild(head);
			if (collapsed) continue;
			for (const match of file.matches) {
				flat.push({ filePath: file.path, match });
				resultsEl.appendChild(matchRow(file.path, match, flat.length - 1));
			}
		}
	}

	function paint() {
		paintStatus();
		paintResults();
	}

	// ---------------------------------------------------------------- 搜索
	async function run() {
		const query = queryInput.value;
		if (!query.trim()) {
			state.results = null;
			state.error = "";
			state.busy = false;
			paint();
			return;
		}
		const mine = ++seq;
		state.busy = true;
		state.error = "";
		paintStatus();
		const res = await conn.req(
			{
				action: "search_content",
				query,
				base: baseInput.value.trim(),
				include: includeInput.value.trim(),
				exclude: excludeInput.value.trim(),
				caseSensitive: state.caseSensitive,
				wholeWord: state.wholeWord,
				regex: state.regex,
				maxResults: MAX_RESULTS,
				maxPerFile: MAX_PER_FILE,
			},
			45000,
		);
		if (mine !== seq) return; // 已有更新的请求，丢弃旧结果
		state.busy = false;
		if (!res.ok) {
			state.results = null;
			state.error = res.error ?? "搜索失败";
			paint();
			return;
		}
		state.results = {
			files: res.files ?? [],
			totalMatches: res.totalMatches ?? 0,
			scanned: res.scanned ?? 0,
			truncated: Boolean(res.truncated),
			elapsedMs: res.elapsedMs ?? 0,
		};
		state.collapsed.clear();
		state.activeIndex = -1;
		paint();
	}

	const runDebounced = debounce(() => void run(), 320);

	queryInput.addEventListener("input", () => {
		// 空输入立刻清空结果，不等待防抖
		if (!queryInput.value.trim()) {
			seq++;
			state.results = null;
			state.error = "";
			state.busy = false;
			paint();
			return;
		}
		runDebounced();
	});
	queryInput.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			if (state.activeIndex >= 0 && flat[state.activeIndex]) return void openActive();
			void run();
		}
	});
	searchBtn.addEventListener("click", () => void run());
	baseInput.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			void run();
		}
	});
	pickBtn.addEventListener("click", () => {
		const dir = opts.selectedDir?.() ?? "";
		baseInput.value = dir;
		if (state.results) void run();
	});
	curBtn.addEventListener("click", () => {
		const file = opts.activeFile?.() ?? "";
		if (!file) {
			toast("没有打开的文件", true);
			return;
		}
		baseInput.value = file;
		if (state.results) void run();
	});
	allBtn.addEventListener("click", () => {
		baseInput.value = "";
		if (state.results) void run();
	});

	// ---------------------------------------------------------------- 替换
	replaceBtn.addEventListener("click", () => void replaceAll());

	async function replaceAll() {
		const query = queryInput.value;
		if (!query.trim()) {
			toast("先输入要替换的内容", true);
			return;
		}
		const r = state.results;
		if (!r || !r.files.length) {
			toast("请先搜索出结果，再执行替换", true);
			return;
		}
		state.replace = replaceInput.value;
		const ok = window.confirm(
			`在 ${r.files.length} 个文件的 ${r.totalMatches} 处匹配里替换为「${state.replace}」？\n` +
				"（只处理 UTF-8 文本，二进制 / 超过 2MB / 非 UTF-8 的文件会跳过）",
		);
		if (!ok) return;
		const res = await conn.req(
			{
				action: "replace_content",
				query,
				replace: state.replace,
				base: baseInput.value.trim(),
				include: includeInput.value.trim(),
				exclude: excludeInput.value.trim(),
				caseSensitive: state.caseSensitive,
				wholeWord: state.wholeWord,
				regex: state.regex,
			},
			60000,
		);
		if (!res.ok) {
			toast(`替换失败：${res.error ?? "未知错误"}`, true);
			return;
		}
		const skipped = res.skippedCount ? `，跳过 ${res.skippedCount} 个文件` : "";
		toast(`已替换 ${res.totalReplacements} 处 / ${res.totalFiles} 个文件${skipped}`);
		opts.onFilesChanged?.((res.files ?? []).map((f) => f.path));
		await run();
	}

	// ---------------------------------------------------------------- 键盘
	function openActive() {
		const item = flat[state.activeIndex];
		if (!item) return;
		opts.openAt(item.filePath, { line: item.match.line, col: item.match.col, length: item.match.length });
	}

	dom.addEventListener("keydown", (ev) => {
		if (ev.target === baseInput || ev.target === includeInput || ev.target === excludeInput) return;
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			if (!flat.length) return;
			ev.preventDefault();
			const delta = ev.key === "ArrowDown" ? 1 : -1;
			state.activeIndex = (state.activeIndex + delta + flat.length) % flat.length;
			paintResults();
			resultsEl.querySelector(".vpro-smatch.active")?.scrollIntoView?.({ block: "nearest" });
			return;
		}
		if (ev.key === "Enter" && state.activeIndex >= 0) {
			ev.preventDefault();
			openActive();
		}
	});

	return {
		dom,
		/** 聚焦搜索框：可带范围目录与预填关键字（Ctrl+Shift+F / 树右键） */
		focus({ base, query } = {}) {
			if (typeof base === "string") baseInput.value = base;
			if (typeof query === "string" && query) {
				queryInput.value = query;
				void run();
			}
			queryInput.focus();
			queryInput.select();
		},
		setBase(base) {
			baseInput.value = String(base ?? "");
		},
		/** 工作区切换后清空结果（旧路径在新根里没有意义） */
		reset() {
			seq++;
			state.results = null;
			state.error = "";
			state.busy = false;
			state.collapsed.clear();
			state.activeIndex = -1;
			paint();
		},
	};
}
