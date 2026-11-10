/**
 * git-scm 服务端入口 —— VSCode 式「源代码管理」面板的 git 后端。
 *
 * 与宿主内置 SCM 面板（server/scm.ts，只读）的分工：这里要能**改工作区**
 * （暂存 / 取消暂存 / 放弃更改 / 提交 / 拉取 / 推送 / 切分支），所以命令自己跑：
 *   - 一律 `execFile("git", [argv...])`，**不过 shell**（无提示符、无 echo、无 ANSI）；
 *   - argv 逐项传，路径永不拼 shell 字符串——含空格的路径天然正确；
 *   - 每个命令都有超时与输出上限（卡死的仓库不拖死面板）；
 *   - `GIT_TERMINAL_PROMPT=0` + `GIT_EDITOR=true` + `GIT_PAGER=cat`：永不等待用户输入
 *     （否则凭据提示 / 编辑器会把这个 HTTP 请求挂到超时）。
 *
 * 端点全走 host.route（`/plugins-api/git-scm/*`，要 "http" 能力）：
 *   GET  /status        工作区状态（分支/ahead-behind/文件/每文件行数/本地分支/标签/储藏/上次提交）
 *   GET  /diff          单文件 diff（staged + worktree；未跟踪文件合成「新文件」补丁）
 *   GET  /log           最近提交（可按 path 过滤 = 单文件历史）
 *   GET  /commit        单条提交的完整 patch
 *   GET  /commit-message 单条提交的原始消息（amend 时回填输入框）
 *   GET  /blame         单文件逐行追溯
 *   GET  /stash          单条储藏的补丁
 *   POST /stage         暂存（paths 或 all）
 *   POST /unstage       取消暂存（paths 或 all）
 *   POST /discard       放弃工作区改动（未跟踪文件走 git clean，调用方须已确认）
 *   POST /commit        提交（可选 stageAll / amend；多段消息按 `-m 主题 -m 正文` 传）
 *   POST /sync          pull / pull-rebase / push / push-force / fetch / publish
 *   POST /branch        分支：switch / create / delete / rename
 *   POST /merge         合并分支（含 --abort 取消合并）
 *   POST /reset         撤销最近的提交（soft / mixed / hard）
 *   POST /revert        还原指定提交（生成一次反向提交）
 *   POST /stash         储藏：save / pop / apply / drop / clear
 *   POST /tag           标签：create / delete / push
 *   POST /init          在非仓库工作区 git init
 *   POST /ai-message    AI 生成提交信息（host.llm.complete，要 "llm" 能力）：
 *                     structured（默认）= 仓库提交规范（类型(范围): 摘要 / 空行 /
 *                     ≥2 点正文 / 可选页脚），缺正文自动重试一次并回 problems；
 *                     repo = 跟随仓库既有风格（单行）
 *
 * 纯函数（porcelain 解析 / 提示词组装 / 消息清洗）刻意**内联在本文件**并导出给单测——
 * 宿主 reload 只给 index.mjs 加 `?e=<epoch>` 击穿缓存，被静态 import 的兄弟模块会命中
 * Node 模块缓存（改了不生效，必须重启服务）。
 */
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** 普通 git 命令超时；push/pull/fetch 走网络另给一档。 */
const GIT_TIMEOUT_MS = 20_000;
const NET_TIMEOUT_MS = 180_000;
const MAX_GIT_OUTPUT = 24 * 1024 * 1024;
/** 单文件 diff 回给浏览器前截断（超长 diff 让浏览器卡死，不如截断并标注）。 */
const MAX_DIFF_CHARS = 400_000;
/** 未跟踪文件预览上限（读模型不需要整本字典）。 */
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** 喂给模型的补丁上限：host.llm.complete 的 prompt 硬上限是 8000 字。 */
const AI_PATCH_CAP = 3600;
const AI_MAX_PROMPT = 7600;
/** 生成的提交信息主体上限（与宿主 SCM 面板同口径）。 */
export const MAX_COMMITMSG_LEN = 200;
const MAX_FILE_LINES_IN_PROMPT = 60;
const MAX_BODY_CHARS = 8_000;
/** 模型没在写提交信息（吐了工具调用/JSON/控制标记）时的统一提示。 */
const UNUSABLE_AI_ERROR = "模型返回的不是提交信息（看起来是工具调用、JSON 或特殊标记），请重试或换一个模型";

// ════════════════════════════════════════════════════════════════════════════
// 纯函数区（可离线单测）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解析 `git status --porcelain=v1 -z -b`（NUL 分隔）。
 * 用 -z 而不是换行分隔：路径里的空格、引号、非 ASCII 都不需要反转义。
 * 重命名/复制记录后面紧跟一条「原路径」记录（`R  new\0old\0`），这里顺手吃掉。
 *
 * @param {string} raw
 * @returns {{ header: string | null, files: Array<{ path: string, x: string, y: string, from?: string }> }}
 */
export function parsePorcelainZ(raw) {
	const tokens = String(raw ?? "").split("\u0000");
	const files = [];
	let header = null;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (token.startsWith("## ")) {
			header = token.slice(3);
			continue;
		}
		if (token.length < 4) continue;
		const x = token[0];
		const y = token[1];
		const path = token.slice(3);
		let from;
		if (x === "R" || x === "C" || y === "R" || y === "C") {
			from = tokens[i + 1] || undefined;
			i++;
		}
		files.push({ path, x, y, ...(from ? { from } : {}) });
	}
	return { header, files };
}

/**
 * 解析 porcelain 的 `## …` 分支行：
 *   `main...origin/main [ahead 1, behind 2]` / `HEAD (no branch)` /
 *   `No commits yet on master` / `main`。
 *
 * @param {string | null | undefined} text
 */
export function parseBranchHeader(text) {
	const out = {
		branch: "",
		detached: false,
		unborn: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
	};
	let rest = String(text ?? "").trim();
	if (!rest) return out;
	const bracket = /\[(.+)\]$/.exec(rest);
	if (bracket) {
		rest = rest.slice(0, bracket.index).trim();
		for (const part of (bracket[1] ?? "").split(",")) {
			const item = part.trim();
			const ahead = /^ahead (\d+)$/.exec(item);
			if (ahead) out.ahead = Number(ahead[1]);
			const behind = /^behind (\d+)$/.exec(item);
			if (behind) out.behind = Number(behind[1]);
			if (item === "gone") out.upstreamGone = true;
		}
	}
	if (rest.startsWith("No commits yet on ")) {
		out.unborn = true;
		out.branch = rest.slice("No commits yet on ".length).trim();
		return out;
	}
	if (rest.startsWith("Initial commit on ")) {
		out.unborn = true;
		out.branch = rest.slice("Initial commit on ".length).trim();
		return out;
	}
	if (rest.startsWith("HEAD (no branch)")) {
		out.detached = true;
		out.branch = "HEAD";
		return out;
	}
	const dots = rest.indexOf("...");
	if (dots >= 0) {
		out.branch = rest.slice(0, dots);
		out.upstream = rest.slice(dots + 3) || null;
	} else {
		out.branch = rest;
	}
	if (!out.branch) out.branch = "HEAD";
	if (out.branch === "HEAD" || out.branch.startsWith("HEAD~") || out.branch.startsWith("HEAD^")) out.detached = true;
	return out;
}

/**
 * 解析 `git diff --numstat`：`add\tdel\tpath`；重命名的路径形如
 * `old => new`（含 `{a/b => c/d}` 花括号缩写），只保留**新路径**与面板对齐。
 *
 * @param {string} text
 * @returns {Record<string, [number, number]>}
 */
export function parseNumstat(text) {
	/** @type {Record<string, [number, number]>} */
	const out = {};
	for (const line of String(text ?? "").split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const add = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
		const del = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
		let path = parts.slice(2).join("\t");
		const arrow = path.lastIndexOf(" => ");
		if (arrow >= 0) {
			path = path
				.slice(arrow + 4)
				.replace(/[{}]/g, "")
				.trim();
		}
		if (path) out[path] = [add, del];
	}
	return out;
}

/**
 * 解析 `git log --pretty=format:%H%x09%h%x09%an%x09%ad%x09%s`（`--date=short`）。
 *
 * @param {string} text
 */
export function parseLog(text) {
	return String(text ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const cells = line.split("\t");
			const [hash = "", shortHash = "", author = "", date = "", ...rest] = cells;
			return { hash, shortHash, author, date, subject: rest.join("\t") };
		})
		.filter((c) => c.hash);
}

/**
 * 解析 `git stash list --pretty=format:%gd%x09%s`：`stash@{0}\tOn main: WIP on …`
 * → `[{ index, ref, message }]`（index 取 `stash@{n}` 里的 n，弹栈/删除要用）。
 *
 * @param {string} text
 */
export function parseStashList(text) {
	return String(text ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			const [ref = "", ...rest] = line.split("\t");
			const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? i);
			return { index: Number.isFinite(index) ? index : i, ref: ref || `stash@{${i}}`, message: rest.join("\t") };
		})
		.filter((entry) => entry.ref.startsWith("stash@{"));
}

/**
 * 解析 `git for-each-ref refs/tags --format=%(refname:short)%x09%(subject)`。
 *
 * @param {string} text
 */
export function parseTagList(text) {
	return String(text ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [name = "", ...rest] = line.split("\t");
			return { name: name.trim(), subject: rest.join("\t").trim() };
		})
		.filter((tag) => tag.name);
}

/** `git log -1 --pretty=format:%H%x09%h%x09%an%x09%ad%x09%s` → 单条提交（无提交回 null）。 */
export function parseLastCommit(text) {
	return parseLog(text)[0] ?? null;
}

/** unix 秒 → `YYYY-MM-DD`（blame 的 author-time；非法值回空串）。 */
function blameDate(seconds) {
	const value = Number(seconds);
	if (!Number.isFinite(value) || value <= 0) return "";
	try {
		return new Date(value * 1000).toISOString().slice(0, 10);
	} catch {
		return "";
	}
}

/**
 * 解析 `git blame --line-porcelain`：每行一个 `<sha> <orig> <final>` 头 + 若干
 * `key value` 元信息 + 以 Tab 开头的正文行。
 *
 * @param {string} text
 * @returns {Array<{ line: number, hash: string, shortHash: string, author: string, date: string, summary: string, text: string }>}
 */
export function parseBlame(text) {
	const rows = String(text ?? "").split("\n");
	const out = [];
	for (let i = 0; i < rows.length; i++) {
		const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/.exec(rows[i] ?? "");
		if (!header) continue;
		const hash = header[1] ?? "";
		const entry = {
			line: Number(header[2]) || out.length + 1,
			hash,
			shortHash: hash.slice(0, 8),
			author: "",
			date: "",
			summary: "",
			text: "",
		};
		let j = i + 1;
		for (; j < rows.length; j++) {
			const row = rows[j] ?? "";
			if (row.startsWith("\t")) {
				entry.text = row.slice(1);
				break;
			}
			const space = row.indexOf(" ");
			if (space < 0) continue;
			const key = row.slice(0, space);
			const value = row.slice(space + 1);
			if (key === "author") entry.author = value;
			else if (key === "author-time") entry.date = blameDate(value);
			else if (key === "summary") entry.summary = value;
		}
		out.push(entry);
		i = j;
	}
	return out;
}

/**
 * 分支 / 标签名安全校验。git 自己的 check-ref-format 规则里最容易致命的那几条：
 * 空白与控制字符、`-` 开头（会被当成选项）、`..`、`@{`、`~^:?*[\\`、结尾 `/` 或 `.lock`。
 * 一律在服务端先拦，绝不把可疑字符串交给 git 去「解释」。
 *
 * @param {unknown} name
 */
export function isSafeRefName(name) {
	const value = String(name ?? "").trim();
	if (!value || value.length > 200) return false;
	if (value.startsWith("-") || value.startsWith("/") || value.startsWith(".")) return false;
	if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
	if (value === "@" || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
	return !/[\s\u0000-\u001f~^:?*[\\]/.test(value);
}

/** porcelain 清单里的冲突项（UU / AA / DD / AU / UA / DU / UD）。 */
export function conflictPaths(files) {
	return (Array.isArray(files) ? files : [])
		.filter(
			(file) =>
				Boolean(file) &&
				(file.x === "U" || file.y === "U" || (file.x === "A" && file.y === "A") || (file.x === "D" && file.y === "D")),
		)
		.map((file) => file.path);
}

/**
 * 把未跟踪文件的内容合成一份「新文件」补丁——`git diff` 永远看不到未跟踪文件，
 * 不合成的话面板对新增文件只能干瞪眼（VSCode 是同款做法）。
 *
 * @param {string} path 仓库相对路径
 * @param {string} content 文件正文（调用方已按行尾切成 \n）
 */
export function buildUntrackedPatch(path, content) {
	const lines = String(content ?? "").split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	return [
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join("\n");
}

/**
 * 剥掉模型/网关混进来的「控制标记、工具调用标记」：
 * `<|DSML|tool_calls>`、`< | DSML | calls>`、`<|end_of_sentence|>`、`|DSML|`、
 * `<tool_calls>…</tool_calls>` 这类自造标签。不剥的话它们会被当成提交信息正文
 * （实测：输入框里出现过 `???: < | DSML | calls>`）。
 *
 * 只针对「带管竖线 / 已知关键字」的标记：普通正文里的 `a < b`、`<div>` 一律不动。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function stripModelArtifacts(raw) {
	let text = String(raw ?? "");
	for (let i = 0; i < 5; i++) {
		const before = text;
		text = text
			// <|DSML|tool_calls> / <｜end_of_sentence｜> / 带空格的 < | DSML | calls>
			.replace(/<\s*[|｜][^<>]{0,300}>/g, "")
			.replace(/<[|｜][\s\S]{0,300}?[|｜]>/g, "")
			// 被 maxChars 截断的残片：只有开头没结尾
			.replace(/<[|｜][^<>\n]*$/g, "")
			// 裸的 |DSML| / |EOS| 片段
			.replace(/[|｜]\s*(?:DSML|dsml|tool_calls|EOT|BOS|EOS)\s*[|｜]/g, "")
			// <tool_calls> … </tool_calls> 这类自造标签
			.replace(/<\/?(?:tool_calls|tool_call|function_calls|function_call|invoke|im_start|im_end)\b[^<>]*>/gi, "");
		if (text === before) break;
	}
	return text;
}

/**
 * 模型输出是否根本不像提交信息（应当拒收，不要写进输入框）：
 * 空、只剩标点/竖线/尖括号、整段是 JSON（工具调用的典型形态）。
 *
 * @param {unknown} raw
 */
export function isUnusableCommitText(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return true;
	// 得有真正的文字/数字（中文、字母、数字），只有 `???: < | >` 不算
	if (!/[\p{L}\p{N}]/u.test(text)) return true;
	// 整段就是一个 JSON 对象/数组：模型把工具参数当成答案了
	if (/^[[{][\s\S]*[\]}]$/.test(text)) return true;
	return false;
}

/**
 * 把模型输出清洗成**一行**提交信息（「跟随仓库风格」模式用）。
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeCommitMessage(raw) {
	let text = stripModelArtifacts(raw).replace(/\r/g, "");
	text = text.replace(/```[^\n]*\n?/g, "").replace(/```/g, "");
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!lines.length) return "";
	let first = lines[0];
	first = first.replace(/^(?:commit\s*message|message|subject|提交信息|提交消息|提交说明)\s*[:：\-–]\s*/i, "");
	first = first.replace(/^[-*•\d.\s]+(?=\S)/, "");
	first = first.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
	first = first.replace(/\s+/g, " ").trim();
	return first.slice(0, MAX_COMMITMSG_LEN);
}

/** 固定类型表（提交信息生成规则：类型必须取自这张表，简体中文）。 */
export const COMMIT_TYPES = ["新增", "修复", "优化", "重构", "文档", "格式", "测试", "构建", "运维", "清理", "回滚"];

/** 模型偶尔会写 conventional commits 类型 → 映射回固定表。 */
const TYPE_ALIASES = {
	feat: "新增",
	feature: "新增",
	fix: "修复",
	bugfix: "修复",
	perf: "优化",
	improve: "优化",
	refactor: "重构",
	docs: "文档",
	doc: "文档",
	style: "格式",
	format: "格式",
	test: "测试",
	tests: "测试",
	build: "构建",
	ci: "运维",
	cd: "运维",
	chore: "清理",
	cleanup: "清理",
	revert: "回滚",
};

/** 页脚行的前缀（关联/关闭 Issue、破坏性变更、回滚说明）。 */
const FOOTER_PREFIXES = ["关联", "关闭", "修复 #", "破坏性变更", "回滚"];

/** “标题行”正则：`类型(范围): 摘要` / `类型（范围）：摘要` / `类型: 摘要`。 */
const TITLE_RE = /^\s*([^\s:：()（）]{1,12})\s*(?:[(（]([^)）]{0,60})[)）])?\s*[:：]\s*(.+)$/;

/**
 * 按「提交信息生成规则」规范化模型输出：
 * ```
 * 类型(范围): 摘要
 * <空行>
 * - 背景/改动/影响，至少两点
 * <空行>
 * 关联 #123 | 破坏性变更: … | 回滚 abc1234 …
 * ```
 * 返回 `problems` 供界面提示（缺正文 = 违反规则里的「禁止单句提交」）。
 *
 * @param {string} raw
 * @returns {{ text: string, title: string, body: string, footer: string, type: string, scope: string, subject: string, problems: string[] }}
 */
export function normalizeCommitMessage(raw) {
	const problems = [];
	let text = stripModelArtifacts(raw)
		.replace(/\r\n?/g, "\n")
		.replace(/```[^\n]*\n?/g, "")
		.replace(/```/g, "");
	// 去掉模型爱加的标签行（「提交信息：」单独成行时）
	text = text.replace(/^\s*(?:commit\s*message|message|提交信息|提交消息|提交说明)\s*[:：]\s*$/gim, "");
	text = text.replace(/^\s*(?:commit\s*message|提交信息|提交消息|提交说明)\s*[:：]\s*/i, "");
	const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
	// 去掉首尾空行、把连续空行压成一个（保持「标题 / 空行 / 正文 / 空行 / 页脚」的骨架）
	const compact = [];
	for (const line of lines) {
		if (line.trim() === "") {
			if (!compact.length || compact[compact.length - 1] === "") continue;
			compact.push("");
		} else {
			compact.push(line.trim());
		}
	}
	while (compact.length && compact[compact.length - 1] === "") compact.pop();
	if (!compact.length)
		return {
			text: "",
			title: "",
			body: "",
			footer: "",
			type: "",
			scope: "",
			subject: "",
			problems: ["模型没有返回任何内容"],
		};
	// 剩下的东西不是人话（整段 JSON / 只剩标点）：宁可回空，也不把垃圾当标题
	if (isUnusableCommitText(compact.join("\n")))
		return {
			text: "",
			title: "",
			body: "",
			footer: "",
			type: "",
			scope: "",
			subject: "",
			problems: ["模型返回的不是提交信息（看起来是工具调用、JSON 或特殊标记）"],
		};

	const blocks = [];
	for (const line of compact) {
		if (line === "") blocks.push([]);
		else if (!blocks.length) blocks.push([line]);
		else blocks[blocks.length - 1].push(line);
	}

	const rawTitle = (blocks[0]?.[0] ?? "").replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
	const match = TITLE_RE.exec(rawTitle);
	let type = "";
	let scope = "";
	let subject = "";
	if (match) {
		const head = match[1].trim();
		const aliasKey = head.toLowerCase();
		const mapped = COMMIT_TYPES.includes(head) ? head : (TYPE_ALIASES[aliasKey] ?? "");
		if (mapped) type = mapped;
		else problems.push(`标题类型「${head}」不在固定类型表内（${COMMIT_TYPES.join("/")}）`);
		scope = (match[2] ?? "").trim();
		subject = match[3].trim();
	} else {
		// 没有 `类型: 摘要` 结构：整行当摘要，类型留给 problems 提示
		subject = rawTitle.trim();
		problems.push(`标题缺少「类型(范围): 摘要」结构（类型取 ${COMMIT_TYPES.join("/")}）`);
	}
	subject = subject.replace(/[。.]\s*$/, "").trim();
	// 模型偶尔会把提示词里的模板当成答案照抄（`<类型>(<影响范围>): <摘要>`）
	if (
		/<[^<>\n]{1,20}>/.test(
			`${rawTitle}\n${blocks
				.slice(1)
				.map((b) => b.join("\n"))
				.join("\n")}`,
		)
	) {
		problems.push("输出里残留了尖括号占位符（如 <类型>/<摘要>），必须换成真实内容");
	}
	if (!subject) problems.push("标题摘要为空");
	if (subject.length > 50) problems.push(`标题摘要 ${subject.length} 字，建议不超过 50 字`);
	const title = `${type || "???"}${scope ? `(${scope})` : ""}: ${subject}`;

	// 正文：标题后所有块（最后一块若像页脚则单独拎出——即使它是唯一的块）
	const rest = blocks.slice(1).map((block) => block.join("\n"));
	let footer = "";
	if (rest.length) {
		const last = rest[rest.length - 1];
		if (FOOTER_PREFIXES.some((prefix) => last.startsWith(prefix))) footer = rest.pop();
	}
	const body = rest.join("\n\n");
	const bullets = body.split("\n").filter((line) => /^\s*[-*•]\s+/.test(line));
	if (!body.trim()) problems.push("缺少正文详情：除单个错别字或单个配置值微调外，禁止单句提交");
	else if (bullets.length < 2) problems.push(`正文只有 ${bullets.length} 点，规则要求至少 2 点`);
	if (/一些改动|部分优化|修复\s*bug|更新代码|优化一下|若干修改/i.test(`${title}\n${body}`)) {
		problems.push("出现模糊表述（如「修复bug」「更新代码」「优化一下」），请写清具体改了什么");
	}

	const normalizedBody = body
		? body
				.split("\n")
				.map((line) => (/^\s*[-*•]\s+/.test(line) ? line.replace(/^\s*[-*•]\s+/, "- ") : line))
				.join("\n")
		: "";
	const parts = [title, normalizedBody, footer].filter((part) => part && part.trim());
	return {
		text: parts.join("\n\n"),
		title,
		body: normalizedBody,
		footer,
		type,
		scope,
		subject,
		problems,
	};
}

/** 提交信息缺正文（= 「单句提交」，规则禁止）。 */
export function isSingleLineCommit(message) {
	const text = String(message ?? "").trim();
	if (!text) return false;
	return !/\n\s*\n/.test(text) && !/\n/.test(text.replace(/^.*\n/, ""));
}

/**
 * 把一次提交拆成 `git commit` 的 `-m` 段：第一段是主题，空行之后的每段是正文。
 * 返回空数组 = 没有可提交的消息。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitCommitMessage(text) {
	const raw = String(text ?? "")
		.replace(/\r\n/g, "\n")
		.trim();
	if (!raw) return [];
	const blocks = raw
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);
	if (!blocks.length) return [];
	if (blocks.length === 1) return [blocks[0].replace(/\s*\n\s*/g, " ").slice(0, 4000)];
	return [blocks[0].replace(/\n/g, " ").slice(0, 4000), ...blocks.slice(1).map((b) => b.slice(0, 4000))];
}

/** 截断一段补丁并留标记（保住开头：早出现的文件最能代表这次改动）。 */
export function capPatch(text, cap = AI_PATCH_CAP) {
	const value = String(text ?? "");
	if (value.length <= cap) return value;
	return `${value.slice(0, cap)}\n… (diff truncated)`;
}

/** "path → [add,del]" → `+12/-3 path`（按路径排序，稳定输出便于单测）。 */
function formatNumStat(stat) {
	return Object.keys(stat)
		.sort()
		.map((path) => `+${stat[path][0]}/-${stat[path][1]} ${path}`);
}

/**
 * 组装「AI 生成提交信息」的 user message。
 * 结构：最近提交（风格参照）→ 改动文件清单 → 暂存区补丁 → 工作区补丁 → 未跟踪清单。
 *
 * @param {{
 *   subjects?: string[],
 *   files?: Array<{ path: string, x: string, y: string }>,
 *   stagedStat?: Record<string, [number, number]>,
 *   worktreeStat?: Record<string, [number, number]>,
 *   stagedPatch?: string,
 *   worktreePatch?: string,
 * }} ctx
 * @param {{ lang?: "zh" | "en", cap?: number, format?: "structured" | "repo" }} [opts]
 * @returns {string}
 */
export function buildCommitPrompt(ctx, opts = {}) {
	const lang = opts.lang === "en" ? "en" : "zh";
	const structured = opts.format !== "repo";
	const cap = Number(opts.cap) > 0 ? Number(opts.cap) : AI_MAX_PROMPT;
	const parts = [];
	const subjects = Array.isArray(ctx?.subjects) ? ctx.subjects : [];
	if (subjects.length) {
		// 结构化模式下历史提交**只用来感受项目用词**，格式由规范钦定（不能照抄成单行）。
		parts.push(
			structured
				? "Recent commit subjects (terminology reference ONLY — the output structure is fixed by the spec, do NOT copy their format):"
				: "Recent commit subjects (newest first — style reference):",
		);
		parts.push(...subjects.map((s) => `- ${s}`));
	} else if (structured) {
		parts.push("（仓库还没有任何提交；按规范用简体中文写，标题类型取固定类型表）");
	} else {
		parts.push(
			lang === "zh"
				? "（仓库还没有任何提交；请用中文写这条提交信息）"
				: "(The repository has no commits yet; write this commit message in English.)",
		);
	}
	const files = Array.isArray(ctx?.files) ? ctx.files : [];
	if (files.length) {
		const shown = files.slice(0, MAX_FILE_LINES_IN_PROMPT);
		parts.push("Changed files (porcelain status):");
		parts.push(...shown.map((f) => `${f.x}${f.y} ${f.path}`));
		if (files.length > shown.length) parts.push(`… (+${files.length - shown.length} more files)`);
	}
	const stagedPatch = String(ctx?.stagedPatch ?? "");
	if (stagedPatch.trim()) {
		parts.push("Staged diff (these changes are the commit's subject):");
		const stat = ctx?.stagedStat ?? {};
		if (Object.keys(stat).length) parts.push(...formatNumStat(stat));
		parts.push(capPatch(stagedPatch));
	}
	const worktreePatch = String(ctx?.worktreePatch ?? "");
	if (worktreePatch.trim()) {
		parts.push("Unstaged diff (worktree only):");
		const stat = ctx?.worktreeStat ?? {};
		if (Object.keys(stat).length) parts.push(...formatNumStat(stat));
		parts.push(capPatch(worktreePatch));
	}
	const untracked = files.filter((f) => f.x === "?" && f.y === "?");
	if (untracked.length && !stagedPatch.trim()) {
		parts.push(
			`Untracked files (new, content not shown): ${untracked
				.map((f) => f.path)
				.join(", ")
				.slice(0, 1200)}`,
		);
	}
	let text = parts.join("\n");
	if (text.length > cap) text = `${text.slice(0, cap)}\n… (truncated)`;
	return text;
}

/** 「跟随仓库风格」模式的系统提示词（单行；英文精简）。 */
export const AI_SYSTEM_PROMPT = `You write git commit messages. You receive the pending changes of a repository and output exactly one commit message: a single subject line.

Rules:
1. Match the style, format and language of the repository's recent commit subjects when provided — conventional commits ("type(scope): summary"), prefixes, punctuation, language: copy what the repo actually does.
2. Describe what the change does at a glance (the user-facing effect), not a file-by-file listing.
3. The staged diff is the subject of the commit. Describe staged changes when any exist; otherwise describe the unstaged and untracked changes shown.
4. One line. No quotes, no markdown, no code fences, no "Commit message:" label, no explanation. Under 72 characters when the repository's language allows it.
5. Never invent scope names, issue numbers or details not visible in the provided material.
6. If the repository has no commits yet, write the message in the language stated in the request.
7. Plain text only: never emit tool calls, function calls, JSON, code fences or control tokens.

Output ONLY the subject line.`;

/**
 * 「结构化规范」模式的系统提示词：标题行 + 空行 + 正文（≥2 点）+ 空行 + 页脚。
 * 与用户给定的《Git 提交信息生成规则》逐条对齐（类型固定表 / 祈使句≤ 50 字 /
 * 禁止单句提交 / 禁止模糊表述 / 页脚只写真实事项）。
 */
export const STRUCTURED_SYSTEM_PROMPT = `你为代码仓库撰写 git 提交信息。只输出提交信息本身：不要解释、不要代码围栏、不要任何标签或前后缀。

输出恰好由三部分组成，用空行隔开：
第 1 行：类型(影响范围): 摘要 — 影响范围可省略，省略时写成 类型: 摘要
第 2 部分：正文 — 若干行以「- 」开头的列表点，至少 2 点
第 3 部分：页脚 — 可选，只在确有其事时写

规则：
1. 类型必须从这张固定类型表中取，不得自造、不得用英文类型：新增 / 修复 / 优化 / 重构 / 文档 / 格式 / 测试 / 构建 / 运维 / 清理 / 回滚。
2. 影响范围可选但推荐：标注改动的模块或组件，例如 订单模块、K8s配置、认证接口，用半角圆括号紧跟在类型后。
3. 摘要：一句话概括核心改动，使用祈使句式，不超过 50 个汉字，结尾不加句号，写「用户可见的效果」而不是文件清单。
4. 正文强制：至少 2 个列表点，覆盖以下维度——修改背景（为什么改、解决什么问题、对应什么需求）、改动详情（具体改了什么、核心逻辑变化）、影响范围（涉及模块、副作用或风险），有量化数据时可补优化效果。只有单个错别字修正或单个配置值微调可以只写一点，但仍必须有正文。
5. 页脚可选且只在确有其事时写，例如：关联 #123、关闭 #456、破坏性变更: 移除旧版 v1 接口，需同步升级调用方、回滚 abc1234 提交的权限配置变更。绝不编造 Issue 编号、提交哈希或不存在的细节。
6. 禁止模糊表述：修复bug、更新代码、优化一下、一些改动、部分优化 等——必须写清具体改了什么、改在哪里。
7. 禁止把不相关的多个功能混在同一条信息里；若改动确实横跨多个模块，用影响范围与正文说明「同一件事」如何波及它们。
8. 上面这些只是写作约定，不是模板：**不要输出任何字段名、占位词或说明性文字**（例如类型、影响范围、摘要、正文第几点这类字眼），也不要用尖括号或方括号包住待填内容——每一处都必须是你根据改动写出的真实文字。素材不足时，就按 diff 里能看到的事实概括。
9. 用简体中文书写（专有名词、代码标识符、路径可保留原文）。
10. 只输出纯文本提交信息：禁止输出工具调用、函数调用、JSON、代码块或任何控制标记。

格式示范（只示范结构，内容必须来自本次改动）：
修复(登录): 修正过期令牌未触发跳转

- 背景：令牌过期时只弹提示不跳登录页，用户反复点击仍停留在原地
- 详情：在校验失败分支补上清除本地会话与跳转登录页
- 影响：仅影响登录态失效路径，正常刷新流程不变`;

/**
 * 拼系统提示词：先按模式选事实源，再把用户自定义提示词拼上/替掉。
 *
 * @param {"append" | "replace"} mode
 * @param {string} custom
 * @param {"structured" | "repo"} [format] 提交信息格式（默认结构化规范）
 */
export function buildAiSystemPrompt(mode, custom, format = "structured") {
	const base = format === "repo" ? AI_SYSTEM_PROMPT : STRUCTURED_SYSTEM_PROMPT;
	const text = String(custom ?? "").trim();
	if (mode === "replace" && text) return text.slice(0, 3800);
	if (text) return `${base}\n\n${text}`.slice(0, 3800);
	return base;
}

/** 路径是否落在 root 内（拒绝 `../` 与绝对路径逃逸）。 */
function isInside(root, abs) {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ════════════════════════════════════════════════════════════════════════════
// git 执行层
// ════════════════════════════════════════════════════════════════════════════

/** 子进程环境：永不等待交互（凭据 / 编辑器 / 分页器都会把 HTTP 请求挂死）。
 *  `GIT_OPTIONAL_LOCKS=0`：面板每几秒拉一次 status，不让它去刷索引 → 也就不会跟
 *  用户自己的 git 操作抢 index.lock（必须的锁不受影响，add/commit 照常）。 */
function gitEnv() {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_EDITOR: "true",
		GIT_PAGER: "cat",
		GIT_ASKPASS: "true",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

/**
 * 杀掉 git 及其子进程。POSIX 上 git fetch 会再拉起 `git-remote-https`，只 kill 父进程
 * 会留下握着 stdout 的孙进程 —— execFile 的回调要等管道关闭，于是 Promise 永远不结算
 * （界面就一直转圈）。这里让子进程自成进程组（detached），再按 -pid 整组杀；
 * Windows 用 taskkill /T 杀树。
 */
function killTree(child) {
	if (!child || !child.pid) return;
	if (process.platform === "win32") {
		try {
			execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
		} catch {
			/* ignore */
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			/* 已经退出 */
		}
	}
}

/**
 * 跑一条 git 命令（argv 数组，不过 shell）。
 *
 * 用 `spawn` 自己管结算，而不是 execFile 等回调 —— 理由（实测踩过）：
 * `git fetch` 会再拉起 `git-remote-https`，孙进程握着 stdout 管道时 execFile 的
 * 回调可能**永远不触发**；杀了父进程也一样。所以这里由我们决定何时结算：
 * 取消 / 超时 / 输出超限一律立刻 reject，不等 stdio 关闭。
 *
 * 失败抛 Error，message 尽量是 git 自己那句人话（取 stderr 首个非空行）。
 *
 * `opts.state.cancel()` 给网络操作用：用户点「取消」→ 整组 kill + 立刻回「已取消」。
 *
 * @param {string} bin
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onChild?: (child: import("node:child_process").ChildProcess) => void, state?: { cancelled?: boolean, cancel?: () => void } }} [opts]
 * @returns {Promise<string>} stdout
 */
function runGit(bin, cwd, args, opts = {}) {
	const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;
	// 网速地板：连接挂住（长时间没数据）时让 git 自己放弃，别把面板吊到超时。
	const netArgs =
		opts.timeoutMs && opts.timeoutMs > GIT_TIMEOUT_MS
			? ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"]
			: [];
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let timer = null;
		const done = (error, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error instanceof Error ? error : new Error(String(error)));
			else resolvePromise(String(value ?? ""));
		};
		let child;
		try {
			child = spawn(bin, ["-c", "core.quotepath=false", "-c", "color.ui=false", ...netArgs, ...args], {
				cwd,
				env: gitEnv(),
				windowsHide: true,
				// 自成进程组：取消时按 -pid 整组杀（POSIX）；Windows 走 taskkill /T
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			done(err);
			return;
		}
		let out = "";
		let errText = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			if (settled) return;
			if (out.length + chunk.length > MAX_GIT_OUTPUT) {
				killTree(child);
				done(new Error(`git ${args[0]} 输出过大（>${Math.round(MAX_GIT_OUTPUT / 1024 / 1024)}MB）`));
				return;
			}
			out += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			// 只留开头的诊断信息，别让 stderr 占内存
			if (errText.length < 64 * 1024) errText += chunk;
		});
		child.on("error", (err) => {
			const code = /** @type {any} */ (err)?.code;
			done(code === "ENOENT" ? new Error(`找不到 git 可执行文件：${bin}（可在插件设置里填绝对路径）`) : err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			if (opts.state?.cancelled) return done(new Error("已取消"));
			if (code === 0) return done(null, out);
			const detail =
				errText
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.find((line) => !line.startsWith("hint:")) ?? "";
			done(new Error(detail || `git ${args[0]} 退出码 ${code ?? signal ?? "?"}`));
		});
		timer = setTimeout(() => {
			killTree(child);
			done(new Error(`git ${args[0]} 超时（${Math.round(timeout / 1000)}s）`));
		}, timeout);
		timer.unref?.();
		opts.onChild?.(child);
		if (opts.state) {
			opts.state.cancel = () => {
				opts.state.cancelled = true;
				killTree(child);
				done(new Error("已取消"));
			};
		}
	});
}

/**
 * 与 runGit 相同，但失败回空串（"读不到就算了"的查询用：空仓库没有 HEAD、
 * 未跟踪仓库没有 upstream 等都属于正常情况，不该让整次刷新失败）。
 *
 * @returns {Promise<string>}
 */
function runGitSoft(bin, cwd, args, opts) {
	return runGit(bin, cwd, args, opts).catch(() => "");
}

/** 仓库根（`git rev-parse --show-toplevel`）；不是仓库回 null。 */
async function repoRoot(bin, cwd) {
	try {
		const out = await runGit(bin, cwd, ["rev-parse", "--show-toplevel"]);
		const root = out.trim();
		return root || null;
	} catch {
		return null;
	}
}

/** 仓库当前是否正卡在某次合并/变基/挑拣里（决定是否给「取消合并」入口）。
 *  一次 rev-parse 拿全部路径，再多路 fs.access 并发探测：不为了三个 rst 多拉两个子进程。 */
async function repoStateFlags(bin, root) {
	const out = await runGitSoft(bin, root, [
		"rev-parse",
		"--git-path",
		"MERGE_HEAD",
		"--git-path",
		"rebase-merge",
		"--git-path",
		"rebase-apply",
		"--git-path",
		"CHERRY_PICK_HEAD",
	]);
	const paths = out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const exists = await Promise.all(
		paths.map(async (path) => {
			try {
				await fs.access(isAbsolute(path) ? path : resolve(root, path));
				return true;
			} catch {
				return false;
			}
		}),
	);
	return {
		mergeInProgress: Boolean(exists[0]),
		rebaseInProgress: Boolean(exists[1] || exists[2]),
		cherryPickInProgress: Boolean(exists[3]),
	};
}

/** 组装一次完整的状态快照（分支 + 文件 + 分块行数 + 本地分支 + 标签/储藏/上次提交）。 */
async function collectStatus(bin, cwd) {
	const root = await repoRoot(bin, cwd);
	if (!root) return { repo: false };
	const [statusOut, worktreeStat, stagedStat, refOut, remoteOut, tagOut, stashOut, lastOut, flags] = await Promise.all([
		runGit(bin, root, ["status", "--porcelain=v1", "-z", "-b", "--find-renames", "--untracked-files=all"]),
		runGitSoft(bin, root, ["diff", "--numstat", "-M"]),
		runGitSoft(bin, root, ["diff", "--cached", "--numstat", "-M"]),
		runGitSoft(bin, root, ["for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname)"]),
		runGitSoft(bin, root, ["remote"]),
		runGitSoft(bin, root, [
			"for-each-ref",
			"refs/tags",
			"--sort=-creatordate",
			"--count=30",
			"--format=%(refname:short)%09%(subject)",
		]),
		runGitSoft(bin, root, ["stash", "list", "--pretty=format:%gd%x09%s"]),
		runGitSoft(bin, root, ["log", "-1", "--date=short", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s"]),
		repoStateFlags(bin, root),
	]);
	const { header, files } = parsePorcelainZ(statusOut);
	const branch = parseBranchHeader(header);
	const branches = [];
	const remoteBranches = [];
	for (const line of refOut.split("\n")) {
		const ref = line.trim();
		if (ref.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length));
		else if (ref.startsWith("refs/remotes/")) {
			const short = ref.slice("refs/remotes/".length);
			// origin/HEAD 只是个符号引用，列出来会让人误点
			if (short && !short.endsWith("/HEAD")) remoteBranches.push(short);
		}
	}
	return {
		repo: true,
		root,
		branch: branch.branch,
		detached: branch.detached,
		unborn: branch.unborn,
		upstream: branch.upstream,
		ahead: branch.ahead,
		behind: branch.behind,
		upstreamGone: branch.upstreamGone,
		branches,
		remoteBranches,
		remotes: remoteOut
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		tags: parseTagList(tagOut),
		stashes: parseStashList(stashOut),
		lastCommit: parseLastCommit(lastOut),
		conflicts: conflictPaths(files),
		...flags,
		files,
		stats: { staged: parseNumstat(stagedStat), worktree: parseNumstat(worktreeStat) },
	};
}

/** 读未跟踪文件 → 新文件补丁；二进制/超大一律只回标记，不塞满浏览器。 */
async function untrackedPatch(root, path) {
	const abs = resolve(root, path);
	if (!isInside(root, abs)) throw new Error(`路径越界：${path}`);
	let buf;
	try {
		buf = await fs.readFile(abs);
	} catch (err) {
		return { patch: "", binary: false, error: `读不到文件：${path}（${/** @type {any} */ (err).code ?? ""}）` };
	}
	if (buf.includes(0)) return { patch: "", binary: true };
	const sliced = buf.length > MAX_UNTRACKED_BYTES ? buf.subarray(0, MAX_UNTRACKED_BYTES) : buf;
	const text = sliced.toString("utf8");
	const patch = buildUntrackedPatch(path, text);
	const more = buf.length > MAX_UNTRACKED_BYTES ? "\n… (file truncated)" : "";
	return { patch: patch + more, binary: false };
}

/** 收集 AI 生成提交信息需要的全部素材（一次并行拉齐）。 */
async function collectCommitContext(bin, root) {
	const [statusOut, stagedPatch, worktreePatch, stagedStat, worktreeStat, subjectOut] = await Promise.all([
		runGitSoft(bin, root, ["status", "--porcelain=v1", "-z", "--find-renames", "--untracked-files=all"]),
		runGitSoft(bin, root, ["diff", "--cached", "--no-color", "--no-ext-diff", "--find-renames"]),
		runGitSoft(bin, root, ["diff", "--no-color", "--no-ext-diff", "--find-renames"]),
		runGitSoft(bin, root, ["diff", "--cached", "--numstat", "-M"]),
		runGitSoft(bin, root, ["diff", "--numstat", "-M"]),
		runGitSoft(bin, root, ["log", "-n", "15", "--pretty=format:%s"]),
	]);
	const { files } = parsePorcelainZ(statusOut);
	return {
		subjects: subjectOut
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		files,
		stagedStat: parseNumstat(stagedStat),
		worktreeStat: parseNumstat(worktreeStat),
		stagedPatch,
		worktreePatch,
	};
}

/** git 的英文报错 → 用户看得懂的一句话（未知错误原样回）。 */
function friendlyError(err, lang) {
	const raw = String(/** @type {any} */ (err)?.message ?? err ?? "");
	const zh = lang !== "en";
	if (/not a git repository/i.test(raw)) return zh ? "当前工作区不是 git 仓库（可点「初始化仓库」）" : raw;
	if (/nothing (added )?to commit/i.test(raw)) return zh ? "没有暂存的更改可提交" : raw;
	if (/no changes added to commit/i.test(raw)) return zh ? "没有暂存的更改可提交" : raw;
	if (/Please tell me who you are|unable to auto-detect email address/i.test(raw))
		return zh ? "git 还没有配置 user.name / user.email，先配置再提交" : raw;
	if (/has no upstream branch|no upstream configured|no tracking information/i.test(raw))
		return zh ? "当前分支没有上游分支：打开「⋯ → 发布分支」推一次即可建立跟踪" : raw;
	if (/did not match any file\(s\) known to git/i.test(raw)) return zh ? `本地没有这个分支：${raw}` : raw;
	if (/could not resolve host|unable to access|authentication failed|permission denied/i.test(raw))
		return zh ? `网络或凭据问题：${raw}` : raw;
	// —— 以下是常见操作的人话化（冲突 / 工作区未干净 / 分支与储藏 / 标签）——
	if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(raw))
		return zh ? "合并产生冲突：解决冲突文件后提交，或用「取消合并」放弃" : raw;
	if (
		/Your local changes to the following files would be overwritten|Please commit your changes or stash them|cannot (pull|merge|switch|checkout).*(local changes|unstaged|uncommitted)/i.test(
			raw,
		)
	)
		return zh ? "工作区还有未提交的改动：先提交或「储藏更改」，再重试" : raw;
	if (/would be overwritten by merge/i.test(raw)) return zh ? "有未跟踪文件会被合并覆盖：先移走或改名" : raw;
	if (/already exists/i.test(raw)) return zh ? `已存在同名对象：${raw}` : raw;
	if (/cannot delete branch .* checked out/i.test(raw)) return zh ? "不能删掉当前所在的分支：先切到别的分支" : raw;
	if (/not fully merged/i.test(raw)) return zh ? "这个分支还没合并：确认后可改用强制删除（-D）" : raw;
	if (/is in the middle of a (merge|rebase|cherry-pick)/i.test(raw))
		return zh ? "仓库正处于合并/变基过程中：先完成或取消它" : raw;
	if (/no stash entries found|no stash entries/i.test(raw)) return zh ? "没有可用的储藏记录" : raw;
	if (/is not a valid branch name|is not a valid tag name|not a valid ref/i.test(raw))
		return zh ? `名字不合法：${raw}` : raw;
	if (/no such path|no such file/i.test(raw)) return zh ? "这个文件还没被 git 跟踪（新文件没有 blame）" : raw;
	if (/bad revision|couldn't find remote ref|unknown revision|ambiguous argument/i.test(raw))
		return zh ? `找不到这个版本/引用（可能已经是第一个提交）：${raw}` : raw;
	return raw;
}

// ════════════════════════════════════════════════════════════════════════════
// 插件入口
// ════════════════════════════════════════════════════════════════════════════

export default {
	/**
	 * @param {any} host 插件宿主窄接口（见 docs/architecture-plugins.md）
	 */
	activate(host) {
		const settings = () => {
			try {
				return host.getSettings() ?? {};
			} catch {
				return {};
			}
		};
		const gitBin = () => {
			const value = settings().gitBin;
			return typeof value === "string" && value.trim() ? value.trim() : "git";
		};
		/** 路由回包永远是 200 + `{ok}`：前端只认 ok，不用 try/catch fetch。 */
		const send = (res, payload) => {
			try {
				res.status(200).json(payload);
			} catch {
				/* 连接已断：无所谓 */
			}
		};
		const fail = (res, err, lang) => send(res, { ok: false, error: friendlyError(err, lang) });
		/** 包一层：任何异常都变成 `{ok:false,error}`，绝不让宿主进程 500。 */
		const wrap = (handler) => (req, res) => {
			Promise.resolve()
				.then(() => handler(req, res))
				.catch((err) => {
					const message = friendlyError(err, String(req?.query?.lang ?? "") === "en" ? "en" : "zh");
					// 「已取消」不是错误，给稳定 code 让前端切成中性提示（不靠中英文案比对）
					send(res, { ok: false, error: message, ...(message === "已取消" ? { code: "cancelled" } : {}) });
				});
		};
		/** 工作区根：路由里现取（host.cwd 是活值，跟随 set_cwd）。 */
		const workspace = () => String(host.cwd ?? "").trim();

		const normalizePaths = (body) => {
			const list = Array.isArray(body?.paths) ? body.paths : body?.path ? [body.path] : [];
			return list
				.map((p) => String(p ?? "").trim())
				.filter((p) => p && !p.startsWith("/") && !p.includes("\u0000") && !p.split("/").includes(".."))
				.slice(0, 5000);
		};

		const disposers = [];
		/** 在飞的网络操作（opId → 子进程），供 /sync/cancel 与反激活清理。 */
		const runningOps = new Map();

		// ── 状态 ────────────────────────────────────────────────────────────
		disposers.push(
			host.route(
				"GET",
				"/status",
				wrap(async (req, res) => {
					const cwd = workspace();
					if (!cwd) return send(res, { ok: false, error: "宿主未提供工作区路径" });
					const status = await collectStatus(gitBin(), cwd);
					const seconds = Number(settings().refreshSeconds);
					send(res, {
						ok: true,
						cwd,
						refreshSeconds: Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 120)) : 6,
						...status,
					});
				}),
			),
		);

		// ── 单文件 diff ─────────────────────────────────────────────────────
		disposers.push(
			host.route(
				"GET",
				"/diff",
				wrap(async (req, res) => {
					const cwd = workspace();
					const path = String(req.query?.path ?? "");
					if (!cwd || !path) return send(res, { ok: false, error: "缺少路径" });
					const bin = gitBin();
					const root = await repoRoot(bin, cwd);
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const status = await collectStatus(bin, cwd);
					const entry = status.repo ? status.files.find((f) => f.path === path) : undefined;
					const untracked = Boolean(entry && entry.x === "?" && entry.y === "?");
					if (untracked) {
						const shot = await untrackedPatch(root, path);
						return send(res, {
							ok: true,
							path,
							untracked: true,
							binary: shot.binary,
							staged: "",
							worktree: shot.patch,
							...(shot.error ? { error: shot.error } : {}),
						});
					}
					const [staged, worktree] = await Promise.all([
						runGitSoft(bin, root, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", "--", path]),
						runGitSoft(bin, root, ["diff", "--no-color", "--no-ext-diff", "-M", "--", path]),
					]);
					const clip = (text) =>
						text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : text;
					send(res, { ok: true, path, untracked: false, staged: clip(staged), worktree: clip(worktree) });
				}),
			),
		);

		// ── 提交历史 / 单条提交 ──────────────────────────────────────────────
		disposers.push(
			host.route(
				"GET",
				"/log",
				wrap(async (req, res) => {
					const cwd = workspace();
					const bin = gitBin();
					const root = await repoRoot(bin, cwd);
					if (!root) return send(res, { ok: true, commits: [] });
					const limit = Math.max(1, Math.min(Number(req.query?.limit ?? 60) || 60, 200));
					// path 有值 = 单文件历史（`--follow` 跟着重命名走）
					const rawPath = String(req.query?.path ?? "").trim();
					const path = normalizePaths({ path: rawPath })[0] ?? "";
					if (rawPath && !path) return send(res, { ok: false, error: "路径非法" });
					const args = ["log", "-n", String(limit), "--date=short", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s"];
					if (path) args.push("--follow", "--", path);
					const out = await runGitSoft(bin, root, args);
					send(res, { ok: true, path: path || undefined, commits: parseLog(out) });
				}),
			),
		);

		disposers.push(
			host.route(
				"GET",
				"/commit",
				wrap(async (req, res) => {
					const cwd = workspace();
					const hash = String(req.query?.hash ?? "").trim();
					if (!/^[0-9a-f]{4,40}$/i.test(hash)) return send(res, { ok: false, error: "提交哈希非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, cwd);
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const text = await runGit(bin, root, [
						"show",
						"--no-color",
						"--no-ext-diff",
						"--find-renames",
						"--format=medium",
						"--stat",
						"--patch",
						hash,
					]);
					send(res, {
						ok: true,
						text: text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : text,
					});
				}),
			),
		);

		// ── 提交消息原文（amend 时回填输入框，不去解析 medium 格式的 patch） ──
		disposers.push(
			host.route(
				"GET",
				"/commit-message",
				wrap(async (req, res) => {
					const raw = String(req.query?.hash ?? "HEAD").trim() || "HEAD";
					if (raw !== "HEAD" && !/^[0-9a-f]{4,40}$/i.test(raw)) return send(res, { ok: false, error: "提交哈希非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const out = await runGitSoft(bin, root, ["log", "-1", "--pretty=format:%B", raw]);
					send(res, { ok: true, message: out.trim() });
				}),
			),
		);

		// ── 逐行追溯（blame） ───────────────────────────────────────────────
		disposers.push(
			host.route(
				"GET",
				"/blame",
				wrap(async (req, res) => {
					const path = normalizePaths({ path: String(req.query?.path ?? "") })[0] ?? "";
					if (!path) return send(res, { ok: false, error: "路径非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const out = await runGit(bin, root, ["blame", "--line-porcelain", "--", path], {
						timeoutMs: 30_000,
					});
					const lines = parseBlame(out);
					const capped = lines.slice(0, 5000);
					send(res, { ok: true, path, lines: capped, truncated: lines.length > capped.length });
				}),
			),
		);

		// ── 单条储藏的补丁（点储藏记录看内容） ─────────────────────────────
		disposers.push(
			host.route(
				"GET",
				"/stash",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const index = Math.max(0, Math.min(Number(req.query?.index ?? 0) || 0, 999));
					const ref = `stash@{${index}}`;
					const text = await runGit(bin, root, ["stash", "show", "-p", "--no-color", ref]);
					send(res, {
						ok: true,
						index,
						text: text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : text,
					});
				}),
			),
		);

		// ── 写操作：暂存 / 取消暂存 / 放弃 ──────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/stage",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const paths = normalizePaths(req.body);
					const all = Boolean(req.body?.all);
					if (!all && !paths.length) return send(res, { ok: false, error: "没有要暂存的文件" });
					await runGit(bin, root, all ? ["add", "-A"] : ["add", "-A", "--", ...paths]);
					send(res, { ok: true });
				}),
			),
		);

		disposers.push(
			host.route(
				"POST",
				"/unstage",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const paths = normalizePaths(req.body);
					const all = Boolean(req.body?.all);
					if (!all && !paths.length) return send(res, { ok: false, error: "没有要取消暂存的文件" });
					const scope = all ? [] : ["--", ...paths];
					try {
						await runGit(bin, root, ["restore", "--staged", ...scope]);
					} catch {
						// 空仓库没有 HEAD（restore 无从回落）或老版本 git 没有 restore：
						// 退回「从索引移除」，效果对用户是等价的（文件回到未跟踪）。
						await runGit(bin, root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", ...scope]);
					}
					send(res, { ok: true });
				}),
			),
		);

		disposers.push(
			host.route(
				"POST",
				"/discard",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const paths = normalizePaths(req.body);
					const all = Boolean(req.body?.all);
					if (!all && !paths.length) return send(res, { ok: false, error: "没有要放弃的文件" });
					const status = await collectStatus(bin, workspace());
					const files = status.repo ? status.files : [];
					const wanted = all ? files.map((f) => f.path) : paths;
					// 分三类处理（与 VSCode 的「放弃更改」口径一致）：
					//   ??      未跟踪 → git clean 删掉
					//   A?      本次新增（索引里有、HEAD 里没有）→ 从索引移除并删文件
					//   其余   工作区改动 → 用索引回写（索引里的暂存不动，只丢工作区那层）
					const untracked = [];
					const stagedNew = [];
					const tracked = [];
					for (const path of wanted) {
						const file = files.find((x) => x.path === path);
						if (file && file.x === "?" && file.y === "?") untracked.push(path);
						else if (file && file.x === "A") stagedNew.push(path);
						else tracked.push(path);
					}
					if (tracked.length) {
						try {
							await runGit(bin, root, ["restore", "--worktree", "--", ...tracked]);
						} catch {
							await runGit(bin, root, ["checkout", "--", ...tracked]);
						}
					}
					if (stagedNew.length) {
						await runGit(bin, root, ["rm", "-f", "--cached", "--quiet", "--", ...stagedNew]);
						await Promise.all(
							stagedNew.map((path) => {
								const abs = resolve(root, path);
								return isInside(root, abs) ? fs.rm(abs, { force: true }).catch(() => {}) : undefined;
							}),
						);
					}
					if (untracked.length) await runGit(bin, root, ["clean", "-f", "-d", "--", ...untracked]);
					send(res, { ok: true, discarded: wanted.length });
				}),
			),
		);

		// ── 提交 ────────────────────────────────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/commit",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const parts = splitCommitMessage(req.body?.message);
					if (!parts.length) return send(res, { ok: false, error: "提交信息不能为空" });
					if (parts.join("\n").length > MAX_BODY_CHARS) return send(res, { ok: false, error: "提交信息过长" });
					if (req.body?.stageAll) await runGit(bin, root, ["add", "-A"]);
					// amend：把暂存区并进上一条提交并换掉消息（面板里的「修正上次提交」）
					const amend = Boolean(req.body?.amend);
					const args = ["commit"];
					if (amend) args.push("--amend");
					for (const part of parts) args.push("-m", part);
					const out = await runGit(bin, root, args);
					const summary = out
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
						.slice(0, 3)
						.join(" · ");
					send(res, { ok: true, summary, amended: amend });
				}),
			),
		);

		// ── 撤销最近的提交（soft / mixed / hard）──────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/reset",
				wrap(async (req, res) => {
					const mode = String(req.body?.mode ?? "mixed");
					if (!["soft", "mixed", "hard"].includes(mode)) return send(res, { ok: false, error: "未知的重置方式" });
					const count = Math.max(1, Math.min(Number(req.body?.count ?? 1) || 1, 20));
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const head = (await runGitSoft(bin, root, ["rev-parse", "--verify", "HEAD"])).trim();
					if (!head) return send(res, { ok: false, error: "还没有任何提交，无法撤销" });
					await runGit(bin, root, ["reset", `--${mode}`, `HEAD~${count}`]);
					const summary =
						mode === "soft"
							? `已撤销最近 ${count} 次提交（改动保留在暂存区）`
							: mode === "mixed"
								? `已撤销最近 ${count} 次提交（改动保留在工作区）`
								: `已丢弃最近 ${count} 次提交及其改动`;
					send(res, { ok: true, summary, mode, count });
				}),
			),
		);

		// ── 还原某次提交（revert：生成一条反向提交，不改历史）────────────────
		disposers.push(
			host.route(
				"POST",
				"/revert",
				wrap(async (req, res) => {
					const hash = String(req.body?.hash ?? "").trim();
					if (!/^[0-9a-f]{4,40}$/i.test(hash)) return send(res, { ok: false, error: "提交哈希非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					try {
						await runGit(bin, root, ["revert", "--no-edit", hash]);
					} catch (err) {
						const status = await collectStatus(bin, workspace());
						const conflicts = conflictPaths(status.repo ? status.files : []);
						if (conflicts.length)
							return send(res, {
								ok: false,
								code: "conflict",
								conflicts,
								error: `还原产生冲突：${conflicts.length} 个文件（解决后提交，或用「终止还原」放弃）`,
							});
						throw err;
					}
					send(res, { ok: true, summary: `已还原 ${hash.slice(0, 8)}` });
				}),
			),
		);

		// ── 储藏（stash）：save / pop / apply / drop / clear ────────────────
		disposers.push(
			host.route(
				"POST",
				"/stash",
				wrap(async (req, res) => {
					const action = String(req.body?.action ?? "save");
					if (!["save", "pop", "apply", "drop", "clear"].includes(action))
						return send(res, { ok: false, error: "未知操作" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					if (action === "clear") {
						await runGit(bin, root, ["stash", "clear"]);
						return send(res, { ok: true, summary: "已清空储藏列表" });
					}
					if (action === "save") {
						const message = String(req.body?.message ?? "")
							.trim()
							.slice(0, 200);
						const args = ["stash", "push"];
						if (req.body?.includeUntracked) args.push("--include-untracked");
						// 不传 -m 时用 git 自己的「WIP on <branch>: <hash> <subject>」（信息量更好）
						if (message) args.push("-m", message);
						await runGit(bin, root, args);
						return send(res, { ok: true, summary: message ? `已储藏：${message}` : "已储藏当前改动" });
					}
					const index = Math.max(0, Math.min(Number(req.body?.index ?? 0) || 0, 999));
					const ref = `stash@{${index}}`;
					if (action === "drop") {
						await runGit(bin, root, ["stash", "drop", ref]);
						return send(res, { ok: true, summary: `已删除 ${ref}` });
					}
					await runGit(bin, root, ["stash", action, ref]);
					send(res, { ok: true, summary: action === "pop" ? `已恢复并删除 ${ref}` : `已恢复 ${ref}（保留储藏）` });
				}),
			),
		);

		// ── 标签（tag）：create / delete / push ─────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/tag",
				wrap(async (req, res) => {
					const action = String(req.body?.action ?? "create");
					if (!["create", "delete", "push"].includes(action)) return send(res, { ok: false, error: "未知操作" });
					const name = String(req.body?.name ?? "").trim();
					if (!isSafeRefName(name)) return send(res, { ok: false, error: "标签名非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					if (action === "delete") {
						await runGit(bin, root, ["tag", "-d", name]);
						return send(res, { ok: true, summary: `已删除标签 ${name}` });
					}
					if (action === "push") {
						const status = await collectStatus(bin, workspace());
						const remote = String(req.body?.remote ?? "").trim() || (status.repo ? status.remotes?.[0] : "") || "";
						if (!remote) return send(res, { ok: false, error: "仓库没有配置远端，无法推送标签" });
						// 推标签走网络：单独一档超时，并允许前端取消
						const state = { cancelled: false };
						const opId = String(req.body?.opId ?? "")
							.replace(/[^A-Za-z0-9_-]/g, "")
							.slice(0, 48);
						await runGit(bin, root, ["push", remote, `refs/tags/${name}`], {
							timeoutMs: NET_TIMEOUT_MS,
							state,
							onChild: (proc) => {
								if (opId) runningOps.set(opId, { child: proc, state });
							},
						}).finally(() => {
							if (opId) runningOps.delete(opId);
						});
						return send(res, { ok: true, summary: `已推送标签 ${name} → ${remote}` });
					}
					const message = String(req.body?.message ?? "")
						.trim()
						.slice(0, 500);
					await runGit(bin, root, message ? ["tag", "-a", name, "-m", message] : ["tag", name]);
					send(res, { ok: true, summary: message ? `已创建附注标签 ${name}` : `已创建标签 ${name}` });
				}),
			),
		);

		// ── 网络：pull / pull-rebase / push / push-force / fetch / publish ─────
		disposers.push(
			host.route(
				"POST",
				"/sync",
				wrap(async (req, res) => {
					const action = String(req.body?.action ?? "");
					if (!["pull", "pull-rebase", "push", "push-force", "fetch", "publish"].includes(action))
						return send(res, { ok: false, error: "未知操作" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					let publishBranch = "";
					let publishRemote = "";
					if (action === "publish") {
						const status = await collectStatus(bin, workspace());
						if (!status.repo) return send(res, { ok: false, error: "not a git repository" });
						const remote = (req.body?.remote ? String(req.body.remote) : "") || (status.remotes ?? [])[0] || "";
						if (!remote) return send(res, { ok: false, error: "仓库没有配置远端，先 git remote add origin <url>" });
						if (status.detached || !status.branch || status.unborn)
							return send(res, { ok: false, error: "游离 HEAD 或还没有提交，无法发布分支" });
						if (!(status.remotes ?? []).includes(remote))
							return send(res, { ok: false, error: `远端不存在：${remote}` });
						publishBranch = status.branch;
						publishRemote = remote;
					}
					const args =
						action === "pull"
							? ["pull", "--no-edit", "--no-rebase"]
							: action === "pull-rebase"
								? ["pull", "--rebase", "--no-edit"]
								: action === "push"
									? ["push"]
									: action === "push-force"
										? ["push", "--force-with-lease"]
										: action === "publish"
											? ["push", "-u", publishRemote, publishBranch]
											: ["fetch", "--prune", "--all"];
					// 网络操作可取消：opId 对上一次子进程，「取消」按钮走 /sync/cancel。
					const opId = String(req.body?.opId ?? "")
						.replace(/[^A-Za-z0-9_-]/g, "")
						.slice(0, 48);
					const state = { cancelled: false };
					let child = null;
					const out = await runGit(bin, root, args, {
						timeoutMs: NET_TIMEOUT_MS,
						state,
						onChild: (proc) => {
							child = proc;
							if (opId) runningOps.set(opId, { child: proc, state });
						},
					}).finally(() => {
						if (opId) runningOps.delete(opId);
						void child;
					});
					const text = out
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
						.slice(0, 6)
						.join("\n");
					send(res, { ok: true, output: text });
				}),
			),
		);

		disposers.push(
			host.route(
				"POST",
				"/sync/cancel",
				wrap(async (req, res) => {
					const opId = String(req.body?.opId ?? "")
						.replace(/[^A-Za-z0-9_-]/g, "")
						.slice(0, 48);
					const entry = opId ? runningOps.get(opId) : null;
					if (!entry) return send(res, { ok: false, error: "该操作已结束" });
					if (typeof entry.state.cancel === "function") entry.state.cancel();
					else {
						entry.state.cancelled = true;
						killTree(entry.child);
					}
					runningOps.delete(opId);
					send(res, { ok: true });
				}),
			),
		);

		// ── 分支：切换 / 新建 / 删除 / 重命名 ────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/branch",
				wrap(async (req, res) => {
					const action = String(req.body?.action ?? "switch");
					if (!["switch", "create", "delete", "rename"].includes(action))
						return send(res, { ok: false, error: "未知操作" });
					const name = String(req.body?.name ?? "").trim();
					if (!isSafeRefName(name)) return send(res, { ok: false, error: "分支名非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					if (action === "create") {
						const startPoint = String(req.body?.from ?? "").trim();
						if (startPoint && !isSafeRefName(startPoint)) return send(res, { ok: false, error: "起始分支名非法" });
						const suffix = startPoint ? [name, startPoint] : [name];
						try {
							await runGit(bin, root, ["switch", "-c", ...suffix]);
						} catch {
							await runGit(bin, root, ["checkout", "-b", ...suffix]);
						}
						return send(res, { ok: true, branch: name, summary: `已新建并切到 ${name}` });
					}
					if (action === "delete") {
						const force = Boolean(req.body?.force);
						await runGit(bin, root, ["branch", force ? "-D" : "-d", name]);
						return send(res, { ok: true, summary: `已删除分支 ${name}` });
					}
					if (action === "rename") {
						// 原分支名省略 = 重命名当前分支
						const from = String(req.body?.from ?? "").trim();
						if (from && !isSafeRefName(from)) return send(res, { ok: false, error: "原分支名非法" });
						await runGit(bin, root, from ? ["branch", "-m", from, name] : ["branch", "-m", name]);
						return send(res, { ok: true, branch: name, summary: `已重命名为 ${name}` });
					}
					// switch：本地分支直接切；带 `/` 的（origin/x）本地没有时自动建跟踪分支
					const looksRemote = name.includes("/");
					try {
						await runGit(bin, root, ["switch", name]);
					} catch {
						try {
							await runGit(bin, root, ["checkout", name]);
						} catch (err) {
							// 本地没有这个分支：不猜，把 git 的原话回给用户（friendlyError 会翻成人话）
							if (!looksRemote) throw err;
							await runGit(bin, root, ["switch", "--track", name]);
						}
					}
					send(res, { ok: true, branch: name });
				}),
			),
		);

		// ── 合并分支（含 --abort 取消合并）────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/merge",
				wrap(async (req, res) => {
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					// 冲突后想收手：merge --abort（还原冲突则 revert --abort）
					if (req.body?.abort) {
						const kind = String(req.body.abort);
						const args =
							kind === "revert"
								? ["revert", "--abort"]
								: kind === "cherry-pick"
									? ["cherry-pick", "--abort"]
									: ["merge", "--abort"];
						await runGit(bin, root, args);
						return send(res, { ok: true, summary: "已取消进行中的合并" });
					}
					const name = String(req.body?.name ?? "").trim();
					if (!isSafeRefName(name)) return send(res, { ok: false, error: "分支名非法" });
					const args = ["merge", "--no-edit"];
					if (req.body?.noFf) args.push("--no-ff");
					args.push(name);
					try {
						const out = await runGit(bin, root, args);
						send(res, {
							ok: true,
							summary: `已合并 ${name}`,
							output: out.split("\n").filter(Boolean).slice(0, 4).join("\n"),
						});
					} catch (err) {
						const status = await collectStatus(bin, workspace());
						const conflicts = conflictPaths(status.repo ? status.files : []);
						if (conflicts.length)
							return send(res, {
								ok: false,
								code: "conflict",
								conflicts,
								error: `合并产生冲突：${conflicts.length} 个文件（解决后提交，或用「取消合并」放弃）`,
							});
						throw err;
					}
				}),
			),
		);

		// ── 远端（remote）：add / remove（新仓库 init 后先把 origin 配上）──────
		disposers.push(
			host.route(
				"POST",
				"/remote",
				wrap(async (req, res) => {
					const action = String(req.body?.action ?? "add");
					if (!["add", "remove"].includes(action)) return send(res, { ok: false, error: "未知操作" });
					const name = String(req.body?.name ?? "origin").trim() || "origin";
					if (!isSafeRefName(name)) return send(res, { ok: false, error: "远端名非法" });
					const bin = gitBin();
					const root = await repoRoot(bin, workspace());
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					if (action === "remove") {
						await runGit(bin, root, ["remote", "remove", name]);
						return send(res, { ok: true, summary: `已删除远端 ${name}` });
					}
					// URL 只收「长得像地址」的串：不空、无控制字符、不以 - 开头（避免被当成选项）
					const url = String(req.body?.url ?? "").trim();
					if (!url || url.startsWith("-") || /[\u0000-\u001f\s]/.test(url))
						return send(res, { ok: false, error: "远端地址非法" });
					await runGit(bin, root, ["remote", "add", name, url]);
					send(res, { ok: true, summary: `已添加远端 ${name} → ${url}` });
				}),
			),
		);

		// ── 初始化仓库 ───────────────────────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/init",
				wrap(async (req, res) => {
					const cwd = workspace();
					if (!cwd) return send(res, { ok: false, error: "宿主未提供工作区路径" });
					await runGit(gitBin(), cwd, ["init"]);
					send(res, { ok: true });
				}),
			),
		);

		// ── AI 生成提交信息 ─────────────────────────────────────────────────
		disposers.push(
			host.route(
				"POST",
				"/ai-message",
				wrap(async (req, res) => {
					const bin = gitBin();
					const cwd = workspace();
					const root = await repoRoot(bin, cwd);
					if (!root) return send(res, { ok: false, error: "not a git repository" });
					const ctx = await collectCommitContext(bin, root);
					if (!ctx.files.length) return send(res, { ok: false, error: "没有可描述的改动" });
					if (!host.llm || typeof host.llm.complete !== "function")
						return send(res, { ok: false, error: "宿主未提供 llm 补全" });
					const prefs = settings();
					// structured（默认）= 用户钦定的《提交信息生成规则》；repo = 跟随仓库既有风格（单行）。
					const format = String(prefs.msgFormat ?? "structured") === "repo" ? "repo" : "structured";
					const wanted = String(req.body?.lang ?? prefs.language ?? "auto");
					const lang = wanted === "zh" || wanted === "en" ? wanted : "zh";
					const prompt = buildCommitPrompt(ctx, { lang, format });
					const model = typeof prefs.model === "string" ? prefs.model.trim() : "";
					const system = buildAiSystemPrompt(
						String(prefs.aiPromptMode ?? "append"),
						String(prefs.aiPrompt ?? ""),
						format,
					);
					const ask = (extra) =>
						host.llm.complete({
							prompt: extra ? `${prompt}\n\n${extra}` : prompt,
							system,
							...(model ? { model } : {}),
							maxChars: 1200,
							timeoutMs: 60_000,
						});

					let result = await ask("");
					if (!result?.ok) return send(res, { ok: false, error: String(result?.error ?? "生成失败") });

					if (format === "repo") {
						let message = sanitizeCommitMessage(result.text);
						// 模型吐了工具调用 / JSON / 控制标记：带着明确约束重试一次
						if (isUnusableCommitText(message)) {
							const retry = await ask(
								"你上一次的输出不是提交信息（看起来是工具调用、JSON 或特殊控制标记）。请只输出一行提交信息文本本身：不要任何标签、函数调用、JSON 或控制字符。",
							);
							if (retry?.ok) {
								const second = sanitizeCommitMessage(retry.text);
								if (!isUnusableCommitText(second)) message = second;
							}
						}
						if (isUnusableCommitText(message)) return send(res, { ok: false, error: UNUSABLE_AI_ERROR });
						return send(res, { ok: true, format, message, problems: [], model: result.model ?? "" });
					}

					let normalized = normalizeCommitMessage(result.text);
					const usable = (value) => !isUnusableCommitText(value.text);
					// 三种情况带着纠正指令重试一次：输出根本不是提交信息 / 缺正文 / 有占位符
					const junk = !usable(normalized);
					const needsRetry =
						junk ||
						!normalized.body.trim() ||
						normalized.problems.some((problem) => problem.includes("占位符") || problem.includes("缺少"));
					if (needsRetry) {
						const hint = junk
							? "你上一次的输出不是提交信息（看起来是工具调用、JSON 或特殊控制标记）。请只输出提交信息文本本身：不要任何标签、函数调用、JSON 或控制字符。"
							: normalized.body.trim()
								? "上一次的输出没有通过校验，请只重写下面这些问题对应的部分，其余保持不变、整条重新输出。"
								: "你上一次的输出只有标题行。必须在标题行后空一行，按维度（修改背景 / 改动详情 / 影响范围）补上至少 2 个「- 」正文点，再输出完整信息。";
						const retry = await ask(
							[
								hint,
								...(normalized.problems.length ? [`需要修正：${normalized.problems.join("；")}`] : []),
								`你上一次的输出（请不要照抄这些格式说明，要写成真实内容）：`,
								String(result.text ?? "").slice(0, 400),
							].join("\n"),
						);
						if (retry?.ok) {
							const second = normalizeCommitMessage(retry.text);
							// 第二次只要真的可用、且比第一次更接近规范，就换掉（原来的「必须有正文」放宽到「可用」）
							if (usable(second) && (!usable(normalized) || second.problems.length < normalized.problems.length))
								normalized = second;
						}
					}
					// 两次都不像人话（工具调用/JSON/只剩标点）：报错，绝不把垃圾写进输入框
					if (!usable(normalized)) return send(res, { ok: false, error: UNUSABLE_AI_ERROR });
					send(res, {
						ok: true,
						format,
						message: normalized.text,
						title: normalized.title,
						problems: normalized.problems,
						model: result.model ?? "",
					});
				}),
			),
		);

		// 工作区（项目）切换：面板要跟着换，不然会对着旧仓库点按钮。
		disposers.push(
			host.onCwdChange((cwd) => {
				host.broadcast({ type: "workspace", cwd: String(cwd ?? "") });
			}),
		);

		return () => {
			for (const [opId, entry] of runningOps) {
				entry.state.cancelled = true;
				if (typeof entry.state.cancel === "function") entry.state.cancel();
				else killTree(entry.child);
				runningOps.delete(opId);
			}
			for (const off of disposers) {
				try {
					off?.();
				} catch {
					/* ignore */
				}
			}
		};
	},
};
