/**
 * CodeMirror 6 封装：语言解析（扩展名 → 语言扩展）+ 明暗主题 + 编辑/只读两种模式。
 *
 * 相比 vscode-editor 的 8 种语言，这里补到 ~25 种（含 legacy-modes 的 shell /
 * dockerfile / toml / powershell / ruby / lua / perl / swift / haskell / erlang /
 * clojure / diff / properties），并把「保存」做成 Prec.highest 的 Mod-s 键位，
 * 避免被浏览器默认行为或其它 keymap 抢先。
 */
import {
	EditorView,
	keymap,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	drawSelection,
	rectangularSelection,
	crosshairCursor,
	dropCursor,
	highlightSpecialChars,
} from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
	syntaxHighlighting,
	defaultHighlightStyle,
	StreamLanguage,
} from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { sass } from "@codemirror/lang-sass";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { toml } from "@codemirror/legacy-modes/mode/toml";

/** 语言名 → 扩展工厂（语言名由服务端 classifyFile 给出，见 index.mjs LANG_BY_EXT）。 */
const FACTORIES = {
	javascript: () => javascript(),
	typescript: () => javascript({ typescript: true }),
	json: () => json(),
	css: () => css(),
	scss: () => sass(),
	sass: () => sass({ indentedSyntax: true }),
	less: () => sass(),
	html: () => html(),
	xml: () => xml(),
	yaml: () => yaml(),
	markdown: () => markdown(),
	python: () => python(),
	sql: () => sql(),
	rust: () => rust(),
	go: () => go(),
	java: () => java(),
	c: () => cpp(),
	cpp: () => cpp(),
	csharp: () => cpp(),
	dart: () => cpp(),
	php: () => php(),
	shell: () => StreamLanguage.define(shell),
	dockerfile: () => StreamLanguage.define(dockerFile),
	properties: () => StreamLanguage.define(properties),
	powershell: () => StreamLanguage.define(powerShell),
	ruby: () => StreamLanguage.define(ruby),
	lua: () => StreamLanguage.define(lua),
	perl: () => StreamLanguage.define(perl),
	swift: () => StreamLanguage.define(swift),
	haskell: () => StreamLanguage.define(haskell),
	erlang: () => StreamLanguage.define(erlang),
	clojure: () => StreamLanguage.define(clojure),
	clike: () => cpp(),
	diff: () => StreamLanguage.define(diff),
	toml: () => StreamLanguage.define(toml),
};

/** 语言名 → 状态栏显示文案。 */
export function langLabel(lang) {
	const key = String(lang ?? "").toLowerCase();
	const MAP = {
		javascript: "JavaScript",
		typescript: "TypeScript",
		json: "JSON",
		css: "CSS",
		scss: "SCSS",
		sass: "Sass",
		less: "Less",
		html: "HTML",
		xml: "XML",
		yaml: "YAML",
		markdown: "Markdown",
		python: "Python",
		sql: "SQL",
		rust: "Rust",
		go: "Go",
		java: "Java",
		c: "C",
		cpp: "C++",
		csharp: "C#",
		dart: "Dart",
		php: "PHP",
		shell: "Shell",
		dockerfile: "Dockerfile",
		properties: "Properties",
		powershell: "PowerShell",
		ruby: "Ruby",
		lua: "Lua",
		perl: "Perl",
		swift: "Swift",
		haskell: "Haskell",
		erlang: "Erlang",
		clojure: "Clojure",
		clike: "C-like",
		diff: "Diff",
		toml: "TOML",
	};
	return MAP[key] ?? "Plain Text";
}

function languageFor(lang) {
	const make = FACTORIES[String(lang ?? "").toLowerCase()];
	try {
		return make ? make() : [];
	} catch {
		return [];
	}
}

/** 浅色壳：跟随宿主 --bg/--text/--accent（与 vscode-editor 同源口径）。 */
const cmLight = EditorView.theme(
	{
		"&": { backgroundColor: "var(--bg, #ffffff)", color: "var(--text, #1f2328)", height: "100%" },
		".cm-scroller": { fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)" },
		".cm-content": { caretColor: "var(--accent, #0969da)" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #0969da)" },
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 8%, transparent)" },
		".cm-activeLineGutter": { backgroundColor: "transparent" },
		".cm-gutters": {
			backgroundColor: "var(--bg, #ffffff)",
			color: "var(--text-faint, #818b98)",
			borderRight: "1px solid var(--border, #d0d7de)",
		},
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 18%, transparent)" },
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
			backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 22%, transparent)",
		},
		".cm-panels": { backgroundColor: "var(--bg-elev, #f6f8fa)", color: "var(--text, #1f2328)" },
		".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--amber, #fbbf24) 35%, transparent)" },
	},
	{ dark: false },
);

/** 深色壳：oneDark 打底，只把背景/前景对齐宿主令牌。 */
const cmDark = EditorView.theme(
	{
		"&": { backgroundColor: "var(--bg, #101016)", color: "var(--text, #e6e6ef)", height: "100%" },
		".cm-scroller": { fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)" },
		".cm-panels": { backgroundColor: "var(--bg-elev, #16161d)", color: "var(--text, #e6e6ef)" },
	},
	{ dark: true },
);

/**
 * 一个可复用的编辑器实例。onChange 拿得到「当前文本」，调用方自行比对脏状态。
 * readOnly 只影响编辑能力（仍可选中复制、搜索）。
 */
export class CodeEditor {
	/**
	 * @param {{
	 *   parent: HTMLElement,
	 *   doc?: string,
	 *   lang?: string|null,
	 *   readOnly?: boolean,
	 *   wrap?: boolean,
	 *   light?: boolean,
	 *   onChange?: (state: EditorState) => void,
	 *   onSave?: () => void,
	 * }} opts
	 */
	constructor(opts) {
		this.langComp = new Compartment();
		this.themeComp = new Compartment();
		this.wrapComp = new Compartment();
		this.readOnlyComp = new Compartment();
		this.onChange = opts.onChange;
		const extensions = [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightSpecialChars(),
			history(),
			foldGutter(),
			drawSelection(),
			dropCursor(),
			EditorState.allowMultipleSelections.of(true),
			indentOnInput(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			bracketMatching(),
			closeBrackets(),
			autocompletion(),
			rectangularSelection(),
			crosshairCursor(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			search({ top: true }),
			EditorState.tabSize.of(4),
			indentUnit.of("    "),
			keymap.of([
				...closeBracketsKeymap,
				...defaultKeymap,
				...searchKeymap,
				...historyKeymap,
				...foldKeymap,
				...completionKeymap,
				...lintKeymap,
				indentWithTab,
			]),
			Prec.highest(
				keymap.of([
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							opts.onSave?.();
							return true;
						},
					},
				]),
			),
			this.langComp.of(languageFor(opts.lang)),
			this.themeComp.of(opts.light ? [cmLight] : [oneDark, cmDark]),
			this.wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
			this.readOnlyComp.of(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
			EditorView.updateListener.of((u) => {
				if (u.docChanged || u.selectionSet) this.onChange?.(u.state);
			}),
		];
		this.view = new EditorView({
			parent: opts.parent,
			state: EditorState.create({ doc: String(opts.doc ?? ""), extensions }),
		});
	}

	get text() {
		return this.view.state.doc.toString();
	}

	/** 换文档 + 语言（切换标签/重新加载时用；历史随之重置，符合「新载入即干净」）。 */
	reset(doc, lang) {
		this.view.dispatch({
			changes: { from: 0, to: this.view.state.doc.length, insert: String(doc ?? "") },
			effects: this.langComp.reconfigure(languageFor(lang)),
			selection: { anchor: 0 },
			scrollIntoView: true,
		});
		this.view.setState(this.view.state); // 清掉 undo 历史（dispatch 不足以清栈）
	}

	setTheme(light) {
		this.view.dispatch({ effects: this.themeComp.reconfigure(light ? [cmLight] : [oneDark, cmDark]) });
	}

	setReadOnly(readOnly) {
		this.view.dispatch({
			effects: this.readOnlyComp.reconfigure(
				readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
			),
		});
	}

	setWrap(wrap) {
		this.view.dispatch({ effects: this.wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) });
	}

	/** 光标位置（1 基行/列），状态栏用。 */
	cursor() {
		const head = this.view.state.selection.main.head;
		const line = this.view.state.doc.lineAt(head);
		return { line: line.number, col: head - line.from + 1 };
	}

	/** 当前选中文本（空选返回 ""，Ctrl+Shift+F 用它预填搜索词）。 */
	selectedText() {
		const sel = this.view.state.selection.main;
		return sel.empty ? "" : this.view.state.sliceDoc(sel.from, sel.to);
	}

	/**
	 * 跳到指定行/列并选中 `length` 个字符（搜索结果、跳转到的匹配处共用）。
	 * 行号/列号都是 1 基，越界自动夹到文档范围内；最后居中滚动 + 聚焦。
	 */
	gotoLine(line, col = 1, length = 0, { focus = true } = {}) {
		const doc = this.view.state.doc;
		if (!doc.length) return;
		const ln = Math.min(Math.max(1, Math.floor(Number(line) || 1)), doc.lines);
		const target = doc.line(ln);
		const offset = Math.min(Math.max(0, Math.floor(Number(col) || 1) - 1), target.length);
		const from = target.from + offset;
		const to = Math.min(from + Math.max(0, Math.floor(Number(length) || 0)), target.to);
		this.view.dispatch({
			selection: { anchor: from, head: to },
			effects: EditorView.scrollIntoView(from, { y: "center" }),
		});
		if (focus) this.focus();
	}

	focus() {
		try {
			this.view.focus();
		} catch {}
	}

	destroy() {
		try {
			this.view.destroy();
		} catch {}
	}
}
