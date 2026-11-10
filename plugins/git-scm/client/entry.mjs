/**
 * git-scm 客户端入口 —— VSCode 式「源代码管理」视图（纯 DOM，无框架）。
 *
 * 布局（对齐 VSCode 的源代码管理面板 + 参考图的左右分栏）：
 *   左栏  分支行 / 提交框（含 ✦ AI 生成）/ 更改区（**目录树**：暂存的更改 + 更改）/ 提交历史
 *   右栏  diff（默认**左右分栏**：旧文件 | 新文件，各带行号；头部按钮可切回单栏 unified；
 *         提交历史点开看完整 patch）
 *   两栏之间是可拖拽分隔条（宽度存 localStorage，双击复位）；diff 的显示方式同样存档
 *
 * 数据全走宿主的 `/plugins-api/git-scm/*`（index.mjs 的 host.route）：
 *   GET  /status → 分支 + 文件清单 + 每文件行数；每 refreshSeconds 秒轮询一次，
 *                  但**视图不可见时跳过**（offsetParent === null = 被 .view-pane.hidden 藏了），
 *                  免得在别的 tab 里白白跑 git；
 *   GET  /diff   → 单文件 staged + worktree 补丁（未跟踪文件由服务端合成新文件补丁）。
 *
 * 纯函数（建树 / 扁平化 / 补丁解析 / 未跟踪判定）都 export 出去给单测——它们在模块顶层
 * 不碰 document，因此 node 环境 import 本文件是安全的。
 */

/** HTML 转义走插件 SDK 的共享实现（内联手写 esc 被 shared-utils-hygiene 守卫拦）：
 *  宿主用 Import Map 把 `@pi-web-ui/plugin-sdk/client` 映到 /plugins-shared/client-utils.mjs。 */
import { esc } from "@pi-web-ui/plugin-sdk/client";

/** 侧栏宽度的 localStorage 键（双击分隔条复位）。 */
const SIDEBAR_KEY = "pi-web-ui:git-scm-sidebar";
/** diff 显示方式（左右分栏 / 单栏 unified）的 localStorage 键。 */
const DIFFMODE_KEY = "pi-web-ui:git-scm-diffmode";
const SIDEBAR_DEFAULT = 330;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 720;
const DIFF_MIN = 220;

/** 从 bundle URL 推 API 前缀（子路径部署时自带应用根前缀）。 */
function resolveApiBase(importMetaUrl) {
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/git-scm`;
}

const TEXT = {
	zh: {
		title: "源代码管理",
		refreshTip: "刷新状态",
		moreTip: "更多操作",
		staged: "暂存的更改",
		changes: "更改",
		history: "提交历史",
		historyEmpty: "还没有提交",
		msgPlaceholder: "标题：类型(范围): 摘要。空一行后写至少两点正文（Ctrl+Enter 提交）",
		commit: "提交",
		commitAll: "全部暂存并提交",
		commitTip: "提交已暂存的更改（Ctrl+Enter）",
		commitAllTip: "把全部改动暂存后一次性提交",
		genTip: "AI 生成提交信息（按仓库提交规范：标题+正文+页脚）",
		needBody: "规范要求：「标题行 + 空行 + 正文详情（至少 2 点）」。当前信息只有一行/没有正文，仍要提交吗？",
		aiNote: "AI 生成提醒：",
		genRunning: "AI 生成中…",
		clickToStop: "（再点一次可中止写入）",
		cancel: "取消",
		cancelled: "已取消",
		cancelTip: "中断这次网络操作（子进程直接结束）",
		stage: "暂存",
		unstage: "取消暂存",
		discard: "放弃更改",
		stageAll: "全部暂存",
		unstageAll: "全部取消暂存",
		discardAll: "放弃所有更改",
		fetch: "获取（fetch）",
		init: "初始化仓库",
		notRepo: "当前工作区不是 git 仓库",
		notRepoHint: "初始化后即可在这里查看改动、暂存与提交。",
		noChanges: "没有更改",
		selectFile: "点左侧文件查看 diff",
		selectCommit: "点提交查看完整 patch",
		loading: "载入中…",
		loadingStatus: "正在读取仓库状态…",
		binary: "二进制文件，不显示 diff",
		untrackedNote: "新文件（未跟踪）",
		noDiff: "没有可显示的差异",
		pull: "拉取（pull）",
		push: "推送（push）",
		publish: "发布分支（push -u）",
		publishTip: "当前分支没有上游：点这里推一次并建立跟踪",
		pushNoUpstreamTip: "当前分支没有上游，直接推送会失败——点「⋯ → 发布分支」先推一次",
		working: "正在{op}…",
		workingHint: "网络操作可能几秒到几十秒…",
		donePull: "拉取完成",
		donePush: "推送完成",
		donePublish: "分支已发布（已建立上游跟踪）",
		doneFetch: "获取完成",
		doneStage: "已暂存",
		doneUnstage: "已取消暂存",
		doneDiscard: "已放弃改动",
		doneCommit: "已提交",
		commitAmend: "修正提交",
		doneInit: "仓库已初始化",
		doneBranch: "已切换分支",
		aiWaiting: "AI 生成中",
		detached: "游离 HEAD",
		unborn: "尚无提交",
		noUpstream: "无上游",

		discardConfirm: "即将放弃 {n} 个文件的改动，未跟踪文件会被删除。此操作不可撤销，继续？",
		discardAllConfirm: "即将放弃全部改动（未跟踪的新文件会被删除）。此操作不可撤销，继续？",
		side: "暂存区",
		work: "工作区",
		toUnified: "切换为单栏（unified）",
		toSplit: "切换为左右分栏",

		// —— 常见 git 操作：分支 / 储藏 / 修正与撤销 / 标签 / 同步 / 追溯 ——
		branchMenuTip: "分支：新建 / 切换 / 合并 / 删除",
		newBranch: "新建分支…",
		renameBranch: "重命名当前分支…",
		mergeBranch: "合并分支…",
		deleteBranch: "删除分支…",
		newBranchPrompt: "新分支名（从当前 HEAD 创建）",
		renameBranchPrompt: "把当前分支重命名为",
		deleteBranchConfirm: "删除分支 {name}？未合并的提交也会一起丢掉。",
		mergeIntoConfirm: "把 {name} 合并到 {current}？",
		backToBranches: "返回分支菜单",
		remoteBranches: "远端分支（切换时自动建本地跟踪分支）",
		localBranches: "本地分支",
		stashTitle: "储藏",
		stashEmpty: "没有储藏记录",
		stashSave: "储藏当前更改",
		stashSaveUntracked: "储藏更改（含未跟踪文件）",
		stashPop: "恢复并删除",
		stashApply: "恢复（保留记录）",
		stashDrop: "删除这条储藏",
		stashClear: "清空储藏",
		stashClearConfirm: "清空全部储藏？此操作不可撤销。",
		doneStashSave: "已储藏当前改动",
		doneStashPop: "已恢复并删除储藏",
		doneStashApply: "已应用储藏（记录保留）",
		doneStashDrop: "已删除储藏记录",
		doneStashClear: "已清空储藏",
		amend: "修正上次提交（amend）",
		amendCancel: "退出修正模式",
		amendOn: "修正模式：提交将替换上一次提交",
		amendTip: "把暂存区并进上一次提交，并可以改掉它的提交信息",
		amendOfferTip: "恢复为普通提交",
		commitAmendTip: "提交并修正上一次提交（Ctrl+Enter）",
		undoCommit: "撤销上次提交…",
		undoSoft: "撤销提交，改动放进暂存区（--soft）",
		undoMixed: "撤销提交，改动留在工作区（--mixed）",
		undoHard: "撤销提交并丢弃改动（--hard）",
		undoHardConfirm: "会丢掉最近一次提交里的代码改动，不可撤销。继续？",
		doneReset: "已撤销提交",
		mergeAbort: "取消合并（merge --abort）",
		revertAbort: "终止还原（revert --abort）",
		doneMergeAbort: "已取消进行中的合并",
		conflicts: "冲突",
		tagCreate: "创建标签…",
		tagNamePrompt: "标签名（例如 v1.2.0）",
		tagMessagePrompt: "标签说明（留空 = 轻量标签）",
		tagPushConfirm: "把标签 {name} 推到远端？",
		doneTag: "已创建标签",
		doneTagPush: "已推送标签",
		pullRebase: "拉取并变基（pull --rebase）",
		donePullRebase: "拉取并变基完成",
		pushForce: "强制推送（--force-with-lease）",
		pushForceConfirm: "用 --force-with-lease 覆盖远端分支？只在你独占的分支上这么做。",
		donePushForce: "强制推送完成",
		fileHistory: "只看这个文件的历史",
		fileHistoryOn: "仅显示该文件的提交",
		historyAll: "显示全部提交",
		blame: "逐行追溯（blame）",
		blameTip: "每一行是谁、哪个提交改的",
		blameNotCommitted: "尚未提交",
		blameTruncated: "文件太长，只显示前 5000 行",
		openInEditor: "在编辑器中打开",
		openInEditorTip: "在「编辑器 Pro」里打开这个文件（插件没装时只会提示一句）",
		openInEditorAt: "在编辑器中打开第 {line} 行",
		openInEditorMissing: "没装「编辑器 Pro」插件：这个按钮需要它（插件市场搜 vscode-editor-pro）",
		openInEditorOutside: "这个文件不在编辑器的工作区内（编辑器只打开工作区里的文件）",
		revert: "还原这次提交（revert）",
		revertConfirm: "生成一条反向提交来还原 {hash}？",
		doneRevert: "已还原提交",
		amendBadge: "修正",
		remoteAdd: "添加远端…",
		remoteAddPrompt: "远端地址（例如 git@github.com:user/repo.git 或 https://…）",
		doneRemoteAdd: "已添加远端",
	},
	en: {
		title: "Source Control",
		refreshTip: "Refresh status",
		moreTip: "More actions",
		staged: "Staged Changes",
		changes: "Changes",
		history: "Commits",
		historyEmpty: "No commits yet",
		msgPlaceholder: "Title: type(scope): summary. Blank line, then at least 2 body points (Ctrl+Enter)",
		commit: "Commit",
		commitAll: "Stage All & Commit",
		commitTip: "Commit the staged changes (Ctrl+Enter)",
		commitAllTip: "Stage everything, then commit in one go",
		genTip: "Generate commit message with AI (title + body + footer)",
		needBody:
			"The spec requires a title line, a blank line, then body details (at least 2 points). This message has no body — commit anyway?",
		aiNote: "AI notes: ",
		genRunning: "Generating…",
		clickToStop: "(click again to finish instantly)",
		cancel: "Cancel",
		cancelled: "Cancelled",
		cancelTip: "Abort this network operation (the git process is terminated)",
		stage: "Stage",
		unstage: "Unstage",
		discard: "Discard changes",
		stageAll: "Stage all",
		unstageAll: "Unstage all",
		discardAll: "Discard all changes",
		fetch: "Fetch",
		init: "Initialize repository",
		notRepo: "This workspace is not a git repository",
		notRepoHint: "Initialize it to see changes, stage and commit here.",
		noChanges: "No changes",
		selectFile: "Pick a file on the left to see its diff",
		selectCommit: "Pick a commit to see its patch",
		loading: "Loading…",
		loadingStatus: "Reading repository status…",
		binary: "Binary file — no diff shown",
		untrackedNote: "New file (untracked)",
		noDiff: "No diff to show",
		pull: "Pull",
		push: "Push",
		publish: "Publish branch (push -u)",
		publishTip: "This branch has no upstream — push once and set the tracking branch",
		pushNoUpstreamTip: "No upstream for this branch, a plain push will fail — use “⋯ → Publish branch”",
		working: "Running {op}…",
		workingHint: "network operations can take seconds to a minute…",
		donePull: "Pull finished",
		donePush: "Push finished",
		donePublish: "Branch published (upstream tracking set)",
		doneFetch: "Fetch finished",
		doneStage: "Staged",
		doneUnstage: "Unstaged",
		doneDiscard: "Changes discarded",
		doneCommit: "Committed",
		commitAmend: "Amend",
		doneInit: "Repository initialised",
		doneBranch: "Branch switched",
		aiWaiting: "Generating with AI",
		detached: "detached HEAD",
		unborn: "no commits yet",
		noUpstream: "no upstream",

		discardConfirm: "Discard changes in {n} file(s)? Untracked files are deleted. This cannot be undone.",
		discardAllConfirm: "Discard all changes? Untracked files are deleted. This cannot be undone.",
		side: "staged",
		work: "worktree",
		toUnified: "Switch to inline (unified) view",
		toSplit: "Switch to side-by-side view",

		// — common git operations: branches / stash / amend & undo / tags / sync / blame —
		branchMenuTip: "Branches: create / switch / merge / delete",
		newBranch: "New branch…",
		renameBranch: "Rename current branch…",
		mergeBranch: "Merge branch…",
		deleteBranch: "Delete branch…",
		newBranchPrompt: "New branch name (created from HEAD)",
		renameBranchPrompt: "Rename the current branch to",
		deleteBranchConfirm: "Delete branch {name}? Unmerged commits are lost.",
		mergeIntoConfirm: "Merge {name} into {current}?",
		backToBranches: "Back to branches",
		remoteBranches: "Remote branches (switching creates a local tracking branch)",
		localBranches: "Local branches",
		stashTitle: "Stashes",
		stashEmpty: "No stashes",
		stashSave: "Stash changes",
		stashSaveUntracked: "Stash changes (incl. untracked)",
		stashPop: "Pop (restore & drop)",
		stashApply: "Apply (keep entry)",
		stashDrop: "Drop this stash",
		stashClear: "Clear all stashes",
		stashClearConfirm: "Clear every stash entry? This cannot be undone.",
		doneStashSave: "Changes stashed",
		doneStashPop: "Stash restored and dropped",
		doneStashApply: "Stash applied (entry kept)",
		doneStashDrop: "Stash dropped",
		doneStashClear: "Stashes cleared",
		amend: "Amend last commit",
		amendCancel: "Leave amend mode",
		amendOn: "Amend mode: committing replaces the last commit",
		amendTip: "Fold the staged changes into the last commit and edit its message",
		amendOfferTip: "Back to a normal commit",
		commitAmendTip: "Commit and amend the last commit (Ctrl+Enter)",
		undoCommit: "Undo last commit…",
		undoSoft: "Undo commit, keep changes staged (--soft)",
		undoMixed: "Undo commit, keep changes in the worktree (--mixed)",
		undoHard: "Undo commit and discard the changes (--hard)",
		undoHardConfirm: "This throws away the code changes of the last commit. Cannot be undone. Continue?",
		doneReset: "Commit undone",
		mergeAbort: "Abort merge (merge --abort)",
		revertAbort: "Abort revert (revert --abort)",
		doneMergeAbort: "Merge aborted",
		conflicts: "conflicts",
		tagCreate: "Create tag…",
		tagNamePrompt: "Tag name (e.g. v1.2.0)",
		tagMessagePrompt: "Tag message (empty = lightweight tag)",
		tagPushConfirm: "Push tag {name} to the remote?",
		doneTag: "Tag created",
		doneTagPush: "Tag pushed",
		pullRebase: "Pull with rebase (pull --rebase)",
		donePullRebase: "Pull --rebase finished",
		pushForce: "Force push (--force-with-lease)",
		pushForceConfirm: "Overwrite the remote branch with --force-with-lease? Only do this on a branch you own.",
		donePushForce: "Force push finished",
		fileHistory: "History of this file",
		fileHistoryOn: "Showing commits that touched this file",
		historyAll: "Show all commits",
		blame: "Blame (line by line)",
		blameTip: "Who and which commit touched each line",
		blameNotCommitted: "not committed yet",
		blameTruncated: "File too long — showing the first 5000 lines",
		openInEditor: "Open in editor",
		openInEditorTip: "Open this file in Editor Pro (without that plugin you just get a hint)",
		openInEditorAt: "Open line {line} in the editor",
		openInEditorMissing: "Editor Pro (vscode-editor-pro) is not installed — this button needs it",
		openInEditorOutside: "This file is outside the editor's workspace",
		revert: "Revert this commit",
		revertConfirm: "Create a reverse commit that reverts {hash}?",
		doneRevert: "Commit reverted",
		amendBadge: "AMEND",
		remoteAdd: "Add remote…",
		remoteAddPrompt: "Remote URL (e.g. git@github.com:user/repo.git or https://…)",
		doneRemoteAdd: "Remote added",
	},
};

function detectLang() {
	try {
		const raw = document.documentElement?.lang ?? navigator.language ?? "zh";
		return String(raw).toLowerCase().startsWith("zh") ? "zh" : "en";
	} catch {
		return "zh";
	}
}

// ════════════════════════════════════════════════════════════════════════════
// 纯函数区（导出给单测）
// ════════════════════════════════════════════════════════════════════════════

/** 未跟踪条目（porcelain 的 `??`）。 */
export function isUntracked(file) {
	return Boolean(file) && file.x === "?" && file.y === "?";
}

/**
 * 把 porcelain 清单拆成两块：**暂存的更改**（x 有效）与**更改**（工作区 y 有效 /
 * 未跟踪）。一个文件的两块改动会同时出现在两边——与 VSCode 一致。
 *
 * @param {Array<{ path: string, x: string, y: string }>} files
 * @param {{ staged?: Record<string, [number, number]>, worktree?: Record<string, [number, number]> }} [stats]
 */
export function splitSections(files, stats) {
	const staged = [];
	const changes = [];
	for (const file of files ?? []) {
		if (!file || !file.path) continue;
		const untracked = isUntracked(file);
		const hasStaged = !untracked && file.x !== " " && file.x !== "?";
		const hasWorktree = untracked || (file.y !== " " && file.y !== "?");
		if (hasStaged) staged.push({ ...file, scope: "staged", stat: stats?.staged?.[file.path] });
		if (hasWorktree) {
			changes.push({
				...file,
				scope: "changes",
				stat: untracked ? undefined : stats?.worktree?.[file.path],
			});
		}
	}
	return { staged, changes };
}

/** 文件在某个分组里显示的状态字母（暂存区看 x，工作区看 y；未跟踪显示 U）。 */
export function statusLetter(file, scope) {
	if (!file) return "";
	if (isUntracked(file)) return "U";
	const letter = scope === "staged" ? file.x : file.y;
	return !letter || letter === " " || letter === "?" ? "" : letter;
}

/** 状态字母 → CSS 类后缀（A 绿 / D 红 / M 蓝 / R 蓝 / U 黄 / 其余灰）。 */
export function statusTone(letter) {
	switch (letter) {
		case "A":
			return "add";
		case "D":
			return "del";
		case "M":
			return "mod";
		case "R":
		case "C":
			return "ren";
		case "U":
		case "?":
			return "new";
		default:
			return "other";
	}
}

/**
 * 文件清单 → 目录树。目录节点带 `count`（子树里的文件数），排序：目录在前、
 * 同级按名字自然序（`doc2` 在 `doc10` 前）。
 *
 * @param {Array<{ path: string }>} files
 * @returns {Array<object>} 根层节点数组
 */
export function buildChangeTree(files) {
	/** @type {any} */
	const root = { type: "dir", name: "", path: "", children: [], map: new Map() };
	for (const file of files ?? []) {
		if (!file || !file.path) continue;
		const segments = String(file.path).split("/").filter(Boolean);
		let node = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i];
			let next = node.map.get(seg);
			if (!next) {
				next = {
					type: "dir",
					name: seg,
					path: segments.slice(0, i + 1).join("/"),
					children: [],
					map: new Map(),
				};
				node.map.set(seg, next);
				node.children.push(next);
			}
			node = next;
		}
		node.children.push({
			type: "file",
			name: segments[segments.length - 1] ?? String(file.path),
			path: file.path,
			file,
		});
	}
	const finalize = (nodes) => {
		nodes.sort((a, b) =>
			a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1,
		);
		for (const node of nodes) {
			if (node.type === "dir") {
				finalize(node.children);
				node.count = countFiles(node);
			}
			// Map 只用于建树，留在对象上会深比较/序列化都变味。
			delete node.map;
		}
		return nodes;
	};
	return finalize(root.children);
}

function countFiles(node) {
	let total = 0;
	for (const child of node.children ?? []) total += child.type === "dir" ? countFiles(child) : 1;
	return total;
}

/**
 * 树 → 渲染用的扁平行（折叠的目录不展开子节点，但仍占一行）。
 *
 * @param {Array<object>} nodes
 * @param {Set<string>} collapsed 折叠目录的 key 集合（调用方负责加分组前缀）
 * @param {number} [depth]
 * @param {string} [prefix] 目录 key 前缀（"docs" / "docs/client"）
 * @returns {Array<{ kind: "dir" | "file", node: object, depth: number, key: string }>}
 */
export function flattenTree(nodes, collapsed, depth = 0, prefix = "") {
	const rows = [];
	for (const node of nodes ?? []) {
		const key = prefix ? `${prefix}/${node.name}` : node.name;
		rows.push({ kind: node.type, node, depth, key });
		if (node.type === "dir" && !collapsed?.has(key))
			rows.push(...flattenTree(node.children, collapsed, depth + 1, key));
	}
	return rows;
}

/**
 * 解析 unified diff 成带双行号的渲染行。`inHunk` 之外的上下文行按元信息处理
 * （`git show --stat` 的表格行也落在这一档，不会给出错位的行号）。
 *
 * kind: meta | hunk | add | del | ctx | blank
 *
 * @param {string} text
 * @returns {Array<{ kind: string, text: string, oldNo?: number, newNo?: number }>}
 */
export function parseUnifiedDiff(text) {
	const rows = [];
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	const metaPrefixes = [
		"diff --git",
		"index ",
		"new file",
		"deleted file",
		"old mode",
		"new mode",
		"similarity index",
		"dissimilarity index",
		"rename ",
		"copy ",
		"Binary files",
		"Only in ",
		"commit ",
		"Author:",
		"Date:",
		"Merge:",
		"AuthorDate:",
		"Commit:",
		"CommitDate:",
	];
	for (const line of String(text ?? "").split("\n")) {
		if (!line) {
			rows.push({ kind: "blank", text: "" });
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (match) {
				oldNo = Number(match[1]);
				newNo = Number(match[2]);
			}
			rows.push({ kind: "hunk", text: line });
			inHunk = true;
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++") || metaPrefixes.some((p) => line.startsWith(p))) {
			rows.push({ kind: "meta", text: line });
			continue;
		}
		if (line.startsWith("\\")) {
			rows.push({ kind: "meta", text: line });
			continue;
		}
		if (!inHunk) {
			rows.push({ kind: "meta", text: line });
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ kind: "add", text: line, newNo });
			newNo++;
			continue;
		}
		if (line.startsWith("-")) {
			rows.push({ kind: "del", text: line, oldNo });
			oldNo++;
			continue;
		}
		rows.push({ kind: "ctx", text: line, oldNo, newNo });
		oldNo++;
		newNo++;
	}
	return rows;
}

/**
 * unified diff → 左右分栏的行。同一段改动里删除行与新增行按顺序两两配对：
 * 删除落在左栏（旧文件）、新增落在右栏（新文件），一侧多出来的行用 null 占位
 * （对侧画斜纹，不至于让用户误读成「这行两边一样」）。遇到上下文 / hunk / 元信息
 * 先 flush，配对绝不跨行组。
 *
 * kind: meta | hunk | blank（通栏一行）| ctx（左右同文，共用行号）|
 *       change（左删右增，left / right 可各自为 null）
 *
 * @param {string} text
 * @returns {Array<{ kind: string, text?: string, left?: any, right?: any }>}
 */
export function buildSplitRows(text) {
	/** @type {Array<{ kind: string, text?: string, left?: any, right?: any }>} */
	const rows = [];
	/** @type {any[]} */
	let dels = [];
	/** @type {any[]} */
	let adds = [];
	const flush = () => {
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i++) rows.push({ kind: "change", left: dels[i] ?? null, right: adds[i] ?? null });
		dels = [];
		adds = [];
	};
	for (const row of parseUnifiedDiff(text)) {
		if (row.kind === "del") {
			dels.push(row);
			continue;
		}
		if (row.kind === "add") {
			adds.push(row);
			continue;
		}
		flush();
		rows.push(row.kind === "ctx" ? { kind: "ctx", left: row, right: row } : { kind: row.kind, text: row.text });
	}
	flush();
	return rows;
}

/**
 * 提交信息是否「缺正文」（= 规则里的「禁止单句提交」）：只有标题行，或标题行之外
 * 只剩页脚（关联/关闭/破坏性变更/回滚）。空串不算违规（还没写）。
 *
 * @param {string} message
 */
export function needsBodyWarning(message) {
	const text = String(message ?? "").trim();
	if (!text) return false;
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 2) return true;
	const footerRe = /^(关联|关闭|破坏性变更|回滚|Closes|Refs|BREAKING CHANGE)/;
	return lines.slice(1).every((line) => footerRe.test(line));
}

/** 侧栏宽度夹取（拖拽与存档解析共用）。 */
export function clampSidebarWidth(width, containerPx = 0) {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
	const upper = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, containerPx > 0 ? containerPx - DIFF_MIN : SIDEBAR_MAX));
	return Math.min(upper, Math.max(SIDEBAR_MIN, Math.round(width)));
}

/** 存档解析：缺失 / 空串 / 坏值都回落默认。 */
export function parseSidebarWidth(raw) {
	if (raw === null || raw === undefined || String(raw).trim() === "") return SIDEBAR_DEFAULT;
	return clampSidebarWidth(Number(raw));
}

/**
 * diff 显示方式存档解析：默认左右分栏（split），只有明确存了 "unified" 才走单栏。
 *
 * @param {string | null | undefined} raw
 * @returns {"split" | "unified"}
 */
export function parseDiffMode(raw) {
	return String(raw ?? "").trim() === "unified" ? "unified" : "split";
}

/**
 * 浮层横向定位（纯函数）：优先与锚点**左缘**对齐（下拉菜单常规行为）；
 * 放不下就换成**右缘**对齐（菜单从右往左长）；再夹进 boundRight 与整个视图宽度。
 *
 * 为什么要夹：⋯ 按钮在侧栏最右侧，左对齐会把菜单甩到右侧 diff 区上方；
 * 夹到侧栏右缘后菜单「往左展开」，视觉上仍是贴着 ⋯ 的。
 *
 * @param {number} anchorLeft 锚点左缘（相对容器）
 * @param {number} anchorRight 锚点右缘（相对容器）
 * @param {number} width 菜单宽度
 * @param {number} boundRight 可见区右缘（所在侧栏的右缘；相对容器）
 * @param {number} hostWidth 整个视图宽度
 * @returns {number} 菜单的 left（px）
 */
export function menuLeft(anchorLeft, anchorRight, width, boundRight, hostWidth) {
	const pad = 6;
	let left = anchorLeft;
	if (left + width > boundRight - pad) left = anchorRight - width;
	left = Math.max(4, Math.min(left, boundRight - width - pad));
	return Math.max(4, Math.min(left, hostWidth - width - pad));
}

// ── 与「编辑器 Pro」的联动（纯函数区）──────────────────────────────────────
//
// 两个插件互不 import（client bundle 只服务自己的子树），联动只走**页内契约**：
//   window.__piVproEditor = { version, open(req) → boolean }（编辑器挂载时登记）
//   事件 `pi:vpro:open`（cancelable：preventDefault = 有人接）
//   window.__piVproPending（编辑器还没挂载时的待办槽）
//   window.__piGitScm = { version, refresh(why?) }（本插件登记，编辑器写盘后回叫）
// 缺席一律静默：不装编辑器 = 点了提示一句，不报错、不影响任何 git 能力。

/**
 * 仓库根 + 仓库相对路径 → 绝对路径。保留根的路径风格（Windows 的反斜杠不会被改成 `/`）。
 *
 * @param {string} root
 * @param {string} rel
 */
export function absJoin(root, rel) {
	const base = String(root ?? "").replace(/[\\/]+$/, "");
	const tail = String(rel ?? "").replace(/^[\\/]+/, "");
	if (!base) return "";
	if (!tail) return base;
	const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
	return `${base}${sep}${tail}`;
}

/**
 * 构造「在编辑器 Pro 中打开」的请求。
 *
 * 为什么带绝对路径：仓库根未必等于编辑器的工作区根（工作区可能只是仓库的一个子目录，
 * 或者是嵌套仓库）。编辑器用 absPath 自己折算成工作区相对路径，两边都不靠猜。
 *
 * @param {any} status /status 的响应（要用 root 与 cwd）
 * @param {string} path 仓库相对路径
 * @param {number} [line] 1 起的行号（0 / 缺省 = 不定位）
 * @returns {null | { source: string, path: string, absPath: string, line: number, repoRoot: string, workspace: string }}
 */
export function buildEditorOpenRequest(status, path, line) {
	const root = String(status?.root ?? "");
	if (!root || !path) return null;
	return {
		source: "git-scm",
		path: String(path),
		absPath: absJoin(root, path),
		line: Math.max(0, Math.floor(Number(line) || 0)),
		repoRoot: root,
		workspace: String(status?.cwd ?? ""),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// 图标（内联 SVG，跟着 currentColor 走主题）
// ════════════════════════════════════════════════════════════════════════════

const ICON = {
	branch:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
	refresh:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
	more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
	plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
	minus:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
	undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h10a6 6 0 0 1 0 12H9"/></svg>',
	check:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
	download:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="15"/><polyline points="7 11 12 16 17 11"/><line x1="4" y1="20" x2="20" y2="20"/></svg>',
	upload:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="9"/><polyline points="7 13 12 8 17 13"/><line x1="4" y1="4" x2="20" y2="4"/></svg>',
	sparkle:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/></svg>',
	folder:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
	file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5L14.5 3z"/><polyline points="14 3 14 8 19 8"/></svg>',
	chevron:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
	commit:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4"/><line x1="2" y1="12" x2="8.6" y2="12"/><line x1="15.4" y1="12" x2="22" y2="12"/></svg>',
	/* 左右分栏：一块被竖线劈开的版式 */
	columns:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
	/* 单栏（unified）：一行行横条 */
	lines:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
	/* 镉笔：重命名 / 修正 */
	pencil:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg>',
	/* 储藏：带盖的箱子 */
	archive:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
	/* 标签 */
	tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.5L12.5 20 4 11.5V4h7.5z"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>',
	/* 历史：带指针的钟 */
	history:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><polyline points="3 4 3 9 8 9"/><polyline points="12 7.5 12 12 15.5 14"/></svg>',
	/* 逐行追溯：一个人形 */
	blame:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
	/* 在编辑器中打开：一张带折角的稿纸 */
	editor:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5L14.5 3z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="12.5" x2="15" y2="12.5"/></svg>',
	/* 删除：垃圾桶 */
	trash:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>',
	/* 返回 */
	back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><line x1="20" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/></svg>',
};

// ════════════════════════════════════════════════════════════════════════════
// 样式（内联在本文件：reload 只击穿 entry.mjs 的缓存，兄弟模块改了不生效）
// ════════════════════════════════════════════════════════════════════════════

const STYLE_ID = "git-scm-style";
const CSS = `
.gscm-root{position:relative;display:flex;height:100%;min-height:0;min-width:0;background:var(--bg);color:var(--text);
 font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box}
.gscm-root *{box-sizing:border-box}
.gscm-side{display:flex;flex-direction:column;min-height:0;width:330px;flex:none;border-right:1px solid var(--border);
 background:var(--bg-elev)}
.gscm-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.gscm-head{display:flex;align-items:center;gap:6px;padding:7px 8px 6px 12px;border-bottom:1px solid var(--border-soft);
 min-width:0;flex:none}
.gscm-title{font-size:12.5px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim);
 min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-sp{flex:1 1 auto;min-width:0}
.gscm-ico{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;flex:none;
 border:0;border-radius:6px;background:transparent;color:var(--text-dim);cursor:pointer;font-size:13px;font-family:inherit}
.gscm-ico svg{width:15px;height:15px}
.gscm-ico:hover:not(:disabled){background:var(--accent-soft);color:var(--text)}
/* 左右分栏是默认状态：按钮高亮一下，切回单栏后变回普通灰 */
.gscm-ico.on{color:var(--accent)}
.gscm-ico:disabled{opacity:.45;cursor:default}
.gscm-spin svg{animation:gscm-rot .9s linear infinite}
@keyframes gscm-rot{to{transform:rotate(360deg)}}
.gscm-branchbar{display:flex;align-items:center;gap:6px;padding:6px 8px;min-width:0;flex:none;
 border-bottom:1px solid var(--border-soft)}
.gscm-branch{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;padding:2px 7px;border-radius:7px;
 border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font-size:12px;font-family:var(--mono);
 cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-branch svg{width:13px;height:13px;flex:none;color:var(--text-faint)}
.gscm-branch:hover{border-color:var(--accent);color:var(--accent)}
.gscm-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gscm-ab{font-family:var(--mono);font-size:11px;color:var(--text-faint);flex:none;white-space:nowrap}
.gscm-msgwrap{position:relative;margin:8px 8px 0;flex:none}
.gscm-msg{width:100%;height:56px;min-height:56px;max-height:40vh;resize:vertical;padding:7px 30px 7px 9px;
 border-radius:8px;border:1px solid var(--border);background:var(--inputbox-bg, var(--bg-elev2));
 color:var(--text);font:12.5px/1.45 var(--mono);outline:none}
.gscm-msg:focus{border-color:var(--accent)}
.gscm-msg::placeholder{color:var(--text-faint)}
.gscm-ai{position:absolute;top:5px;right:5px;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;
 justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--accent);cursor:pointer}
.gscm-ai svg{width:15px;height:15px}
.gscm-ai:hover:not(:disabled){background:var(--accent-soft)}
.gscm-ai:disabled{opacity:.5;cursor:default}
.gscm-ai.gscm-spin svg{animation:gscm-rot .9s linear infinite}
.gscm-aierr{margin:6px 8px 0;padding:5px 8px;border:1px solid var(--red-soft);border-radius:6px;background:var(--red-soft);
 color:var(--red);font-size:11.5px;overflow-wrap:anywhere;flex:none}
.gscm-ainote{margin:6px 8px 0;padding:5px 8px;border:1px solid color-mix(in srgb, var(--amber) 35%, transparent);
 border-radius:6px;background:color-mix(in srgb, var(--amber) 10%, transparent);color:var(--text);
 font-size:11.5px;overflow-wrap:anywhere;flex:none}
.gscm-op{display:flex;align-items:center;gap:6px;margin:6px 8px 0;padding:5px 9px;border-radius:7px;
 font-size:11.5px;overflow-wrap:anywhere;flex:none;border:1px solid var(--border);
 background:var(--bg-elev2);color:var(--text-dim)}
.gscm-op.busy{color:var(--text)}
.gscm-op.info{color:var(--text-dim)}
.gscm-op.ok{border-color:var(--green-soft);background:var(--green-soft);color:var(--green)}
.gscm-op.error{border-color:var(--red-soft);background:var(--red-soft);color:var(--red)}
.gscm-op-spin{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid currentColor;
 border-right-color:transparent;animation:gscm-rot .8s linear infinite}
.gscm-op-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-op-cancel{flex:none;margin-left:auto;padding:1px 8px;border-radius:5px;border:1px solid var(--border);
 background:transparent;color:var(--text-dim);font:11.5px system-ui,sans-serif;cursor:pointer}
.gscm-op-cancel:hover{border-color:var(--accent);color:var(--accent)}
.gscm-banner{margin:6px 8px 0;padding:6px 9px;border:1px solid color-mix(in srgb, var(--amber) 40%, transparent);
 border-radius:7px;background:color-mix(in srgb, var(--amber) 12%, transparent);color:var(--text);
 font-size:11.5px;overflow-wrap:anywhere;flex:none}
.gscm-commitrow{display:flex;gap:6px;padding:8px;flex:none}
.gscm-btn{flex:1 1 auto;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:5px;
 padding:5px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);
 font:12.5px system-ui,sans-serif;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-btn svg{width:14px;height:14px;flex:none}
.gscm-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.gscm-btn:disabled{opacity:.5;cursor:default}
.gscm-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast,#fff)}
.gscm-btn.primary:hover:not(:disabled){filter:brightness(1.07);color:var(--accent-contrast,#fff)}
.gscm-lists{flex:1 1 auto;min-height:0;overflow:auto;border-top:1px solid var(--border-soft)}
.gscm-sect{flex:none}
.gscm-sechead{display:flex;align-items:center;gap:5px;width:100%;padding:5px 8px;border:0;background:transparent;
 color:var(--text-dim);font:600 11.5px/1.6 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.4px;
 cursor:pointer;min-width:0;user-select:none}
.gscm-sechead:hover{background:var(--accent-soft);color:var(--text)}
.gscm-caret{display:inline-flex;width:12px;height:12px;flex:none;color:var(--text-faint);transition:transform .12s}
.gscm-caret svg{width:12px;height:12px}
.gscm-caret.open{transform:rotate(90deg)}
.gscm-secname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gscm-count{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:0 5px;border-radius:9px;
 background:var(--bg-elev2);color:var(--text-faint);flex:none}
.gscm-secacts{display:none;gap:2px;margin-left:auto;flex:none}
.gscm-sechead:hover .gscm-secacts{display:inline-flex}
.gscm-row{display:flex;align-items:center;gap:5px;padding:2px 8px 2px 0;min-width:0;cursor:pointer;
 border-left:2px solid transparent}
.gscm-row:hover{background:var(--accent-soft)}
.gscm-row.active{background:var(--accent-soft);border-left-color:var(--accent)}
.gscm-indent{flex:none;display:inline-block}
.gscm-twist{width:13px;height:13px;flex:none;color:var(--text-faint);display:inline-flex;align-items:center;
 justify-content:center;transition:transform .12s}
.gscm-twist svg{width:11px;height:11px}
.gscm-twist.open{transform:rotate(90deg)}
.gscm-tico{width:13px;height:13px;flex:none;display:inline-flex;color:var(--text-faint)}
.gscm-tico svg{width:13px;height:13px}
.gscm-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
 font-family:var(--mono);font-size:12px;color:var(--text)}
.gscm-row.dir .gscm-name{color:var(--text-dim)}
.gscm-xy{flex:none;width:12px;text-align:center;font-family:var(--mono);font-size:10.5px;font-weight:700}
.gscm-xy.add{color:var(--green)}
.gscm-xy.del{color:var(--red)}
.gscm-xy.mod{color:var(--blue)}
.gscm-xy.ren{color:var(--blue)}
.gscm-xy.new{color:var(--amber)}
.gscm-xy.other{color:var(--text-faint)}
.gscm-stat{flex:none;font-family:var(--mono);font-size:10.5px;color:var(--text-faint);white-space:nowrap}
.gscm-stat .add{color:var(--green)}
.gscm-stat .del{color:var(--red)}
.gscm-acts{display:none;gap:2px;flex:none;margin-left:2px}
.gscm-row:hover .gscm-acts,.gscm-row.active .gscm-acts{display:inline-flex}
.gscm-mini{width:18px;height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;
 border:1px solid var(--border);border-radius:4px;background:var(--bg-elev2);color:var(--text-dim);cursor:pointer}
.gscm-mini svg{width:11px;height:11px}
.gscm-mini:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.gscm-mini.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.gscm-mini.danger:hover{color:var(--red);border-color:var(--red)}
.gscm-empty{padding:14px 12px;color:var(--text-faint);font-size:12px;text-align:center;overflow-wrap:anywhere}
.gscm-empty.tall{padding:38px 18px;line-height:1.7}
.gscm-hist{flex:none;max-height:45%;overflow:auto;border-top:1px solid var(--border-soft)}
.gscm-hist:empty{display:none}
/* ── 储藏（stash）区块：与「提交历史」同构的可折叠段 ───────────────────────── */
.gscm-stash{flex:none;max-height:40%;overflow:auto;border-top:1px solid var(--border-soft)}
.gscm-stash:empty{display:none}
.gscm-row.stash .gscm-name{color:var(--text-dim);font-size:11.5px}
.gscm-histfile{display:inline-flex;align-items:center;gap:4px;max-width:46%;min-width:0;padding:0 6px;border-radius:8px;
 background:var(--accent-soft);color:var(--accent);font:11px/1.6 var(--mono);overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap;flex:none}
.gscm-histfile button{width:14px;height:14px;padding:0;border:0;background:transparent;color:inherit;
 cursor:pointer;font-size:12px;line-height:1;flex:none}
/* ── amend 进度条：提醒「现在提交是修正上一条」────────────────────────── */
.gscm-amend{display:flex;align-items:center;gap:6px;margin:6px 8px 0;padding:4px 9px;border-radius:7px;flex:none;
 border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);background:var(--accent-soft);color:var(--accent);
 font-size:11.5px;overflow-wrap:anywhere}
.gscm-amend-text{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-amend-x{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;
 color:inherit;cursor:pointer;font-size:13px;line-height:1}
.gscm-amend-x:hover{background:color-mix(in srgb,var(--accent) 22%,transparent)}
.gscm-btn.amend{border-color:var(--accent);color:var(--accent)}
/* ── blame：行号 / 元信息 / 正文三列 ─────────────────────────────────── */
.gscm-blame{font:12.5px/1.55 var(--mono);min-width:100%}
.gscm-blame-row{display:grid;grid-template-columns:3.4em 15em minmax(0,1fr);min-width:100%;cursor:pointer}
.gscm-blame-row:hover{background:var(--bg-elev2)}
.gscm-blame-row.changed{background:var(--accent-soft)}
.gscm-blame-no{padding:0 6px;text-align:right;color:var(--text-faint);font-size:11.5px;user-select:none;opacity:.7}
.gscm-blame-meta{padding:0 8px;color:var(--text-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap;border-right:1px solid var(--border-soft)}
.gscm-blame-row.changed .gscm-blame-meta{color:var(--accent)}
.gscm-blame-tx{padding:0 14px 0 8px;white-space:pre;overflow-x:auto;overflow-y:hidden;color:var(--text-dim)}
.gscm-menu-sep{height:1px;margin:3px 4px;background:var(--border-soft);flex:none}
.gscm-menu-head{display:flex;align-items:center;gap:6px;padding:3px 8px 5px;color:var(--text-faint);
 font:600 10.5px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.4px;min-width:0}
.gscm-menu-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-menu-head .gscm-mini{margin-left:auto}
.gscm-menu.plain{min-width:230px;max-height:min(60vh,520px);overflow:auto}
.gscm-collapse{display:flex;align-items:center;gap:6px;padding:6px 10px;width:100%;border:0;background:transparent;
 color:var(--text-dim);font:600 11.5px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.4px;
 cursor:pointer;min-width:0}
.gscm-collapse:hover{background:var(--accent-soft);color:var(--text)}
.gscm-msgc{display:flex;flex-direction:column;gap:1px;padding:5px 10px;border:0;background:transparent;
 text-align:left;cursor:pointer;min-width:0;width:100%}
.gscm-msgc:hover{background:var(--accent-soft)}
.gscm-msgc.active{background:var(--accent-soft)}
.gscm-msgc-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--text)}
.gscm-msgc-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:10.5px;
 color:var(--text-faint)}
.gscm-divider{flex:none;width:5px;cursor:col-resize;background:transparent;position:relative}
.gscm-divider::after{content:"";position:absolute;inset:0 2px;background:var(--border-soft)}
.gscm-divider:hover::after{background:var(--accent)}
.gscm-diffhead{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-soft);
 background:var(--bg-elev);min-width:0;flex:none}
.gscm-diffhead-title{font-family:var(--mono);font-size:12px;color:var(--text-dim);overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gscm-badge{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:9px;background:var(--bg-elev2);
 color:var(--text-faint);white-space:nowrap;margin:6px 12px 2px}
.gscm-diffbody{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0 24px}
/* ── 单栏（unified）──────────────────────────────────────────────────────── */
.gscm-dl{display:flex;min-width:100%;font:12.5px/1.55 var(--mono);white-space:pre}
.gscm-dl-no{flex:none;width:3.2em;text-align:right;padding:0 6px;color:var(--text-faint);user-select:none;
 opacity:.7;font-size:11.5px}
/* 元信息行（diff --git / index / ---/+++）与 hunk 头不占行号列，正文从左边开始（同 VSCode） */
.gscm-dl.meta .gscm-dl-no,.gscm-dl.blank .gscm-dl-no,.gscm-dl.hunk .gscm-dl-no{display:none}
.gscm-dl-tx{flex:1 1 auto;padding-right:14px;min-width:0;white-space:pre}
.gscm-dl.meta .gscm-dl-tx{color:var(--text-faint)}
.gscm-dl.hunk .gscm-dl-tx{color:var(--accent)}
.gscm-dl.hunk{background:var(--accent-soft)}
.gscm-dl.add{background:var(--green-soft)}
.gscm-dl.add .gscm-dl-tx{color:var(--green)}
.gscm-dl.del{background:var(--red-soft)}
.gscm-dl.del .gscm-dl-tx{color:var(--red)}
.gscm-dl.ctx .gscm-dl-tx{color:var(--text-dim)}
/* ── 左右分栏（split，默认）─────────────────────────────────────────────────
   整份补丁装在一个 grid 里（而不是行内各建一个），四条列才会**跳行对齐**：
   旧行号 / 旧文件 | 新行号 / 新文件。两条文本列固定各占一半（分隔线居中），
   行内不换行：超宽的单行在**自己那一格里横向滚动**（同 GitHub / GitLab 的分栏），
   因此两侧始终同时可见，不会因一行太长把另一栏顶到屏幕外。 */
.gscm-ds{display:grid;grid-template-columns:3.6em minmax(0,1fr) 3.6em minmax(0,1fr);
 min-width:100%;font:12.5px/1.55 var(--mono)}
/* 元信息 / hunk / 空行：通栏一行，不占行号列（同 VSCode）；太长同样在本行内横滚。
   背景图上那条半透明的细线把分屏分隔线接着画下去（否则一到 hunk 头就断成虚线） */
.gscm-ds-full{grid-column:1/-1;padding:0 14px 0 6px;white-space:pre;overflow-x:auto;overflow-y:hidden;
 scrollbar-width:thin;background-color:transparent;background-repeat:no-repeat;
 background-image:linear-gradient(to right,transparent calc(50% - .5px),var(--border-soft) calc(50% - .5px),
  var(--border-soft) calc(50% + .5px),transparent calc(50% + .5px))}
.gscm-ds-full.meta{color:var(--text-faint)}
.gscm-ds-full.hunk{color:var(--accent);background-color:var(--accent-soft)}
.gscm-ds-no{padding:0 6px;text-align:right;font-size:11.5px;color:var(--text-faint);user-select:none;opacity:.7}
/* 右栏行号兼当两级分屏的竖分隔线 */
.gscm-ds-no2{border-left:1px solid var(--border-soft)}
.gscm-ds-no.del{background:var(--red-soft)}
.gscm-ds-no.add{background:var(--green-soft)}
.gscm-ds-tx{padding:0 12px 0 4px;white-space:pre;min-width:0;overflow-x:auto;overflow-y:hidden;
 scrollbar-width:thin}
.gscm-ds-tx::-webkit-scrollbar{height:6px}
.gscm-ds-tx.ctx{color:var(--text-dim)}
.gscm-ds-tx.del{color:var(--red);background:var(--red-soft)}
.gscm-ds-tx.add{color:var(--green);background:var(--green-soft)}
/* 一侧多出来（只有删或只有增）：对侧斜纹，一眼看出“这里没东西”
   而不是误读成两边一样 */
.gscm-ds-no.fill,.gscm-ds-tx.fill{
 background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--text-faint) 9%,transparent) 0 5px,transparent 5px 11px)}
.gscm-menu{position:absolute;top:32px;right:6px;z-index:20;min-width:190px;padding:5px;border-radius:9px;
 border:1px solid var(--border);background:var(--menu-bg,var(--bg-elev2));box-shadow:0 10px 28px rgba(0,0,0,.32);
 display:flex;flex-direction:column;gap:2px}
.gscm-mi{display:flex;align-items:center;gap:7px;padding:5px 9px;border:0;border-radius:6px;background:transparent;
 color:var(--text);font:12.5px system-ui,sans-serif;cursor:pointer;text-align:left;min-width:0}
.gscm-mi svg{width:13px;height:13px;flex:none;color:var(--text-faint)}
.gscm-mi:hover:not(:disabled){background:var(--accent-soft)}
.gscm-mi.danger:hover:not(:disabled){background:var(--red-soft);color:var(--red)}
.gscm-mi:disabled{opacity:.45;cursor:default}
.gscm-mi span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gscm-hide{display:none!important}
/* 触屏没有 hover：把悬停才出现的按钮常驻，否则整目录暂存/放弃无从下手 */
@media (hover:none){
 .gscm-acts,.gscm-secacts{display:inline-flex}
}
`;

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

// ════════════════════════════════════════════════════════════════════════════
// 视图
// ════════════════════════════════════════════════════════════════════════════

export default {
	/**
	 * @param {HTMLElement} root 宿主给的挂载容器
	 * @param {{ send: (payload: unknown) => void, onData: (cb: (payload: unknown) => void) => () => void }} ctx
	 */
	mount(root, ctx) {
		ensureStyles();
		const API = resolveApiBase(import.meta.url);
		const lang = detectLang();
		const t = (key, vars) => {
			let text = TEXT[lang]?.[key] ?? TEXT.zh[key] ?? key;
			if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
			return text;
		};

		let destroyed = false;
		/** @type {any} */
		const S = {
			status: null,
			loading: false,
			error: "",
			selected: /** @type {null | { path: string }} */ (null),
			diff: null,
			diffLoading: false,
			diffError: "",
			commitDetail: /** @type {null | { hash: string, subject: string, text: string }} */ (null),
			/** 储藏的补丁（点储藏行） */
			stashDetail: /** @type {null | { index: number, message: string, text: string }} */ (null),
			stashOpen: true,
			/** 逐行追溯：{ path, loading, error, lines, truncated } */
			blame: /** @type {null | { path: string, loading: boolean, error: string, lines: any[], truncated: boolean }} */ (
				null
			),
			/** amend 模式：提交时带 --amend（替换上一次提交） */
			amend: false,
			/** 提交历史只看某个文件时，这里存路径 */
			historyPath: "",
			history: [],
			historyOpen: false,
			historyLoaded: false,
			historyLoading: false,
			collapsed: new Set(),
			sectionOpen: { staged: true, changes: true },
			busy: "",
			/** 操作状态条：{ kind: "busy" | "ok" | "error", text, startedAt, detail } */
			op: null,
			/** AI 结果是否正在逐字写入提交框 */
			streaming: false,
			genLoading: false,
			aiError: "",
			aiNote: [],
			menuOpen: false,
			refreshSeconds: 6,
			sideWidth: parseSidebarWidth(readSidebarWidth()),
			/** diff 显示方式：默认左右分栏；可切回单栏 unified（存档） */
			diffMode: parseDiffMode(readDiffMode()),
		};

		function readSidebarWidth() {
			try {
				return localStorage.getItem(SIDEBAR_KEY);
			} catch {
				return null;
			}
		}
		function saveSidebarWidth(px) {
			try {
				localStorage.setItem(SIDEBAR_KEY, String(px));
			} catch {
				/* 隐私模式：算了 */
			}
		}

		function readDiffMode() {
			try {
				return localStorage.getItem(DIFFMODE_KEY);
			} catch {
				return null;
			}
		}
		function saveDiffMode(mode) {
			try {
				localStorage.setItem(DIFFMODE_KEY, mode);
			} catch {
				/* 隐私模式：算了 */
			}
		}

		// ── 骨架（静态 HTML，挿入的数据一律 esc） ──────────────────────────
		root.innerHTML = `
<div class="gscm-root">
  <div class="gscm-side">
    <div class="gscm-head">
      <span class="gscm-title">${esc(t("title"))}</span>
      <span class="gscm-sp"></span>
      <button type="button" class="gscm-ico" data-act="refresh" title="${esc(t("refreshTip"))}">${ICON.refresh}</button>
      <button type="button" class="gscm-ico" data-act="menu" title="${esc(t("moreTip"))}">${ICON.more}</button>
    </div>
    <div class="gscm-branchbar">
      <button type="button" class="gscm-branch" data-act="branch" title="${esc(t("branchMenuTip"))}">${ICON.branch}<span class="gscm-branch-name"></span></button>
      <span class="gscm-ab"></span>
      <span class="gscm-sp"></span>
      <button type="button" class="gscm-ico" data-act="pull" title="${esc(t("pull"))}">${ICON.download}</button>
      <button type="button" class="gscm-ico" data-act="push" title="${esc(t("push"))}">${ICON.upload}</button>
    </div>
    <div class="gscm-op gscm-hide"></div>
    <div class="gscm-msgwrap">
      <textarea class="gscm-msg" rows="3" spellcheck="false" placeholder="${esc(t("msgPlaceholder"))}"></textarea>
      <button type="button" class="gscm-ai" data-act="ai" title="${esc(t("genTip"))}">${ICON.sparkle}</button>
    </div>
    <div class="gscm-aierr gscm-hide"></div>
    <div class="gscm-ainote gscm-hide"></div>
    <div class="gscm-banner gscm-hide"></div>
    <div class="gscm-amend gscm-hide"><span class="gscm-amend-text"></span><button type="button" class="gscm-amend-x" data-act="amend-off" title="${esc(
			t("amendCancel"),
		)}">×</button></div>
    <div class="gscm-commitrow">
      <button type="button" class="gscm-btn primary" data-act="commit">${ICON.check}<span>${esc(t("commit"))}</span></button>
      <button type="button" class="gscm-btn" data-act="commit-all">${esc(t("commitAll"))}</button>
    </div>
    <div class="gscm-lists"></div>
    <div class="gscm-stash"></div>
    <div class="gscm-hist"></div>
  </div>
  <div class="gscm-divider" data-act="divider" role="separator" aria-orientation="vertical"></div>
  <div class="gscm-main">
    <div class="gscm-diffhead">
      <span class="gscm-diffhead-title"></span>
      <span class="gscm-sp"></span>
      <button type="button" class="gscm-ico" data-act="diffmode"></button>
      <span class="gscm-diffhead-acts"></span>
    </div>
    <div class="gscm-diffbody"></div>
  </div>
  <div class="gscm-menu gscm-hide"></div>
</div>`;

		const $ = (sel) => root.querySelector(sel);
		const sideEl = $(".gscm-side");
		const listsEl = $(".gscm-lists");
		const stashEl = $(".gscm-stash");
		const histEl = $(".gscm-hist");
		const diffHeadEl = $(".gscm-diffhead");
		const diffBodyEl = $(".gscm-diffbody");
		const diffModeBtn = /** @type {HTMLElement} */ ($('[data-act="diffmode"]'));
		const menuEl = $(".gscm-menu");
		const bannerEl = $(".gscm-banner");
		const aiErrEl = $(".gscm-aierr");
		const aiNoteEl = $(".gscm-ainote");
		const opEl = $(".gscm-op");
		const amendEl = $(".gscm-amend");
		const msgEl = /** @type {HTMLTextAreaElement} */ ($(".gscm-msg"));
		const aiBtn = $(".gscm-ai");
		const refreshBtn = $('[data-act="refresh"]');
		const moreBtn = /** @type {HTMLElement} */ ($('[data-act="menu"]'));
		const commitBtn = $('[data-act="commit"]');
		const commitAllBtn = $('[data-act="commit-all"]');
		const branchBtn = $('[data-act="branch"]');
		const abEl = $(".gscm-ab");
		const pullBtn = $('[data-act="pull"]');
		const pushBtn = $('[data-act="push"]');

		sideEl.style.width = `${S.sideWidth}px`;
		// 第一次 refresh 前先把切换按钮画出来（别留一个 24px 的空按钮）
		renderDiffMode();

		/** 状态条的自动消失 / 秒数刷新定时器 */
		let opTimer = null;
		let opClock = null;

		// ── 与宿主/服务端的往返 ─────────────────────────────────────────────
		async function api(path, init) {
			const res = await fetch(`${API}${path}`, {
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				...init,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		}

		// ── 与「编辑器 Pro」的联动 ──────────────────────────────────────────
		//  A（本 → 编辑器）：把「这个文件（第 N 行）」交给对方打开，请求体见
		//     buildEditorOpenRequest()（带绝对路径，仓库根 ≠ 工作区根也对得上）。
		//  C（编辑器 → 本）：对方写盘后回叫 window.__piGitScm.refresh()，不用等轮询。
		let externalRefreshTimer = null;

		/**
		 * 在「编辑器 Pro」里打开某个改动文件（可定位到行）。
		 * 没装插件 → 只提示一句；文件不在编辑器工作区 → 提示原因。绝不报错、不改任何 git 状态。
		 */
		function openInEditor(path, line) {
			const request = buildEditorOpenRequest(S.status, path, line);
			if (!request) return;
			const editor = /** @type {any} */ (window).__piVproEditor;
			if (editor && typeof editor.open === "function") {
				let accepted = false;
				try {
					accepted = editor.open(request) !== false;
				} catch {
					accepted = false;
				}
				if (accepted) {
					setBanner("");
					window.__piWebUiHost?.setView?.("plugin:vscode-editor-pro");
				} else {
					setBanner(`⚠ ${t("openInEditorOutside")}`);
				}
				return;
			}
			// 编辑器 bundle 还没挂上（首次加载 / 刚重载）：留待办槽 + 发事件（preventDefault = 有人接）。
			const pending = { ...request, at: Date.now() };
			/** @type {any} */ (window).__piVproPending = pending;
			let handled = false;
			try {
				handled = !window.dispatchEvent(new CustomEvent("pi:vpro:open", { detail: request, cancelable: true }));
			} catch {
				handled = false;
			}
			if (handled) {
				setBanner("");
				window.__piWebUiHost?.setView?.("plugin:vscode-editor-pro");
				/** @type {any} */ (window).__piVproPending = null;
				return;
			}
			// 给 bundle 一拍时间自行认领待办；没人认领 = 没装，提示一句（待办槽一起清掉）。
			setTimeout(() => {
				if (destroyed) return;
				if (/** @type {any} */ (window).__piVproPending !== pending) return;
				/** @type {any} */ (window).__piVproPending = null;
				setBanner(`⚠ ${t("openInEditorMissing")}`);
			}, 1200);
		}

		/**
		 * 编辑器写盘后的即时刷新（C）：状态立刻重取，正开着的 diff 也重取。
		 * 提交 / 储藏详情是历史数据，跟磁盘改动无关，不动。
		 */
		async function refreshFromEditor() {
			if (destroyed) return;
			await refresh();
			if (destroyed || !S.selected || S.commitDetail || S.stashDetail) return;
			await selectFile(S.selected.path);
		}

		/** 页内契约：本插件的对外半个（编辑器保存后调 refresh）。 */
		const scmBridge = {
			version: 1,
			refresh: () => {
				if (destroyed) return;
				// 连续保存（批量替换 / 多标签）时合并成一次，别把 git 跑成风暴。
				if (externalRefreshTimer) clearTimeout(externalRefreshTimer);
				externalRefreshTimer = setTimeout(() => {
					externalRefreshTimer = null;
					void refreshFromEditor();
				}, 120);
			},
		};
		/** @type {any} */ (window).__piGitScm = scmBridge;

		function setBanner(text) {
			S.error = text || "";
			if (!bannerEl) return;
			bannerEl.textContent = S.error;
			bannerEl.classList.toggle("gscm-hide", !S.error);
		}

		function setAiError(text) {
			S.aiError = text || "";
			aiErrEl.textContent = S.aiError;
			aiErrEl.classList.toggle("gscm-hide", !S.aiError);
		}

		/** 生成结果的「规范提醒」（缺正文 / 正文不足 / 类型不在表内…）：黄条，编辑消息即消失。 */
		function setAiNote(lines) {
			S.aiNote = Array.isArray(lines) ? lines.filter(Boolean) : [];
			if (!aiNoteEl) return;
			aiNoteEl.textContent = S.aiNote.length ? `${t("aiNote")}${S.aiNote.join("；")}` : "";
			aiNoteEl.classList.toggle("gscm-hide", S.aiNote.length === 0);
		}

		/** 操作状态条：busy 带转圈 + 实时秒数（网络操作可能几十秒），ok/error 6 秒后自动消失。 */
		function renderOp() {
			if (!opEl) return;
			const op = S.op;
			if (!op) {
				opEl.classList.add("gscm-hide");
				opEl.textContent = "";
				return;
			}
			opEl.classList.remove("gscm-hide");
			opEl.classList.toggle("busy", op.kind === "busy");
			opEl.classList.toggle("info", op.kind === "info");
			opEl.classList.toggle("ok", op.kind === "ok");
			opEl.classList.toggle("error", op.kind === "error");
			const seconds = op.kind === "busy" ? ` ${Math.max(0, Math.round((Date.now() - op.startedAt) / 1000))}s` : "";
			const cancellable = op.kind === "busy" && Boolean(op.opId);
			opEl.innerHTML = `${op.kind === "busy" ? '<span class="gscm-op-spin"></span>' : ""}<span class="gscm-op-text"></span>${
				cancellable
					? `<button type="button" class="gscm-op-cancel" data-act="cancel-op" title="${esc(t("cancelTip"))}">${esc(t("cancel"))}</button>`
					: ""
			}`;
			opEl.querySelector(".gscm-op-text").textContent = `${op.text}${seconds}`;
			opEl.title = op.detail || op.text;
		}

		function setOp(kind, text, detail = "", opId = "") {
			if (opTimer) {
				clearTimeout(opTimer);
				opTimer = null;
			}
			if (opClock) {
				clearInterval(opClock);
				opClock = null;
			}
			S.op = text ? { kind, text, detail, opId, startedAt: Date.now() } : null;
			renderOp();
			if (kind === "busy") {
				// 只刷秒数，别整块重建（避免闪烁）
				opClock = setInterval(() => {
					if (!S.op || S.op.kind !== "busy") return;
					const line = opEl?.querySelector(".gscm-op-text");
					if (line) line.textContent = `${S.op.text} ${Math.round((Date.now() - S.op.startedAt) / 1000)}s`;
				}, 500);
				return;
			}
			if (S.op) {
				opTimer = setTimeout(() => {
					if (S.op && S.op.kind !== "busy") {
						S.op = null;
						renderOp();
					}
				}, 6000);
			}
		}

		async function refresh() {
			if (destroyed || S.loading) return;
			S.loading = true;
			refreshBtn.classList.add("gscm-spin");
			try {
				const data = await api("/status");
				if (destroyed) return;
				if (!data?.ok) {
					setBanner(data?.error || t("loading"));
				} else {
					S.status = data;
					S.refreshSeconds = Number(data.refreshSeconds) || 6;
					setBanner("");
					pruneSelection();
					pruneStash();
				}
			} catch (err) {
				if (!destroyed) setBanner(`⚠ ${String(/** @type {any} */ (err)?.message ?? err)}`);
			} finally {
				S.loading = false;
				refreshBtn.classList.remove("gscm-spin");
				if (!destroyed) renderAll();
			}
		}

		function pruneSelection() {
			if (!S.selected) return;
			const files = S.status?.repo ? (S.status.files ?? []) : [];
			if (!files.some((f) => f.path === S.selected?.path)) {
				S.selected = null;
				S.diff = null;
				S.diffError = "";
			}
		}

		// ── 渲染：头 / 分支 ─────────────────────────────────────────────────
		function renderHead() {
			const status = S.status;
			const repo = Boolean(status?.repo);
			const branch = status?.branch || "";
			branchBtn.querySelector(".gscm-branch-name").textContent = repo
				? status.detached
					? `${branch || "HEAD"} (${t("detached")})`
					: branch || "…"
				: "—";
			branchBtn.disabled = !repo;
			const ab = [];
			if (status?.upstream) {
				if (status.upstreamGone) ab.push(t("noUpstream"));
				else {
					if (status.ahead) ab.push(`↑${status.ahead}`);
					if (status.behind) ab.push(`↓${status.behind}`);
				}
			} else if (repo) ab.push(t("noUpstream"));
			if (repo && status?.unborn) ab.push(t("unborn"));
			// 冲突中的仓库要先解决才能继续，直接在分支行给个显眼的提示
			const conflicts = Array.isArray(status?.conflicts) ? status.conflicts.length : 0;
			if (repo && conflicts) ab.push(`⚔ ${conflicts} ${t("conflicts")}`);
			abEl.textContent = ab.join(" ");
			abEl.title = conflicts ? `${status.conflicts.join("\n")}` : "";
			// amend 进度条：提醒「现在提交会把暂存区并进上一条提交」
			if (amendEl) {
				amendEl.classList.toggle("gscm-hide", !(repo && S.amend));
				const label = amendEl.querySelector(".gscm-amend-text");
				if (label) label.textContent = t("amendOn");
				amendEl.title = t("amendTip");
			}
			const canSync = repo && !S.busy;
			pullBtn.disabled = !canSync;
			pushBtn.disabled = !canSync;
			// 点下去之后按钮会变灰（防重复触发），但**当前那一个**显示转圈 + 文案，
			// 再配合浏览器下方状态条（含实时秒数），不会出现「灰了不知道在干嘛」。
			pullBtn.classList.toggle("gscm-spin", S.busy === "pull");
			pushBtn.classList.toggle("gscm-spin", S.busy === "push");
			pullBtn.title = S.busy === "pull" ? `${t("working")}${t("pull")}` : t("pull");
			pushBtn.title = !repo
				? t("push")
				: !status?.upstream
					? t("pushNoUpstreamTip")
					: S.busy === "push"
						? `${t("working")}${t("push")}`
						: t("push");
			refreshBtn.disabled = S.loading;
			aiBtn.disabled = !repo;
			aiBtn.classList.toggle("gscm-spin", S.genLoading);
			aiBtn.title = S.genLoading ? `${t("genRunning")} ${t("clickToStop")}` : t("genTip");
			const hasMsg = Boolean(msgEl.value.trim());
			const locked = Boolean(S.busy) || S.streaming;
			commitBtn.disabled = !repo || !hasMsg || locked;
			commitAllBtn.disabled = !repo || !hasMsg || locked;
			commitBtn.classList.toggle("amend", Boolean(S.amend));
			const commitLabel = commitBtn.querySelector("span");
			if (commitLabel) commitLabel.textContent = S.amend ? t("commitAmend") : t("commit");
			commitBtn.title = S.amend ? t("commitAmendTip") : t("commitTip");
			msgEl.disabled = !repo;
		}

		// ── 渲染：更改区（目录树） ──────────────────────────────────────────
		function renderLists() {
			const status = S.status;
			if (!status) {
				listsEl.innerHTML = `<div class="gscm-empty">${esc(t("loadingStatus"))}</div>`;
				return;
			}
			if (!status.repo) {
				listsEl.innerHTML = `<div class="gscm-empty tall">${esc(t("notRepo"))}<br>${esc(
					t("notRepoHint"),
				)}<br><br><button type="button" class="gscm-btn" data-act="init">${esc(t("init"))}</button></div>`;
				return;
			}
			const { staged, changes } = splitSections(status.files, status.stats);
			const parts = [];
			parts.push(sectionHtml("staged", t("staged"), staged, "unstage"));
			parts.push(sectionHtml("changes", t("changes"), changes, "stage"));
			listsEl.innerHTML = parts.join("");
		}

		function sectionHtml(key, title, files, mode) {
			const open = S.sectionOpen[key] !== false;
			const caret = `<span class="gscm-caret${open ? " open" : ""}">${ICON.chevron}</span>`;
			const actBtn =
				mode === "stage"
					? `<button type="button" class="gscm-mini" data-act="stage-all" data-scope="${key}" title="${esc(
							t("stageAll"),
						)}">${ICON.plus}</button>`
					: `<button type="button" class="gscm-mini" data-act="unstage-all" data-scope="${key}" title="${esc(
							t("unstageAll"),
						)}">${ICON.minus}</button>`;
			// 注意：分组头是 div 而不是 button —— 里面还要塞「整组暂存/取消暂存」的按钮，
			// button 套 button 会被浏览器把内层哥哥提升到外面（排版错位）。
			const head = `<div class="gscm-sechead" role="button" tabindex="0" data-act="toggle-section" data-scope="${key}">
				${caret}<span class="gscm-secname">${esc(title)}</span>
				<span class="gscm-count">${files.length}</span>
				<span class="gscm-secacts">${actBtn}</span></div>`;
			if (!open) return `<div class="gscm-sect">${head}</div>`;
			let body;
			if (!files.length) {
				body = `<div class="gscm-empty">${esc(t("noChanges"))}</div>`;
			} else {
				const tree = buildChangeTree(files);
				const rows = flattenTree(tree, prefixedCollapsed(key));
				body = rows.map((row) => rowHtml(row, key, files)).join("");
			}
			return `<div class="gscm-sect">${head}${body}</div>`;
		}

		/** 折叠状态按分组隔离（同一个 docs 目录在暂存区与工作区各自折叠）。 */
		function prefixedCollapsed(key) {
			const out = new Set();
			for (const item of S.collapsed) if (item.startsWith(`${key}:`)) out.add(item.slice(key.length + 1));
			return out;
		}

		function rowHtml(row, section, sectionFiles) {
			const indent = `<span class="gscm-indent" style="width:${row.depth * 12}px"></span>`;
			if (row.kind === "dir") {
				const collapsed = S.collapsed.has(`${section}:${row.key}`);
				const dirFiles = sectionFiles.filter((f) => f.path === row.key || f.path.startsWith(`${row.key}/`));
				const act =
					section === "changes"
						? `<button type="button" class="gscm-mini" data-act="stage-dir" data-scope="${section}" data-dir="${esc(
								row.key,
							)}" title="${esc(t("stageAll"))}">${ICON.plus}</button>`
						: `<button type="button" class="gscm-mini" data-act="unstage-dir" data-scope="${section}" data-dir="${esc(
								row.key,
							)}" title="${esc(t("unstageAll"))}">${ICON.minus}</button>`;
				return `<div class="gscm-row dir" data-act="toggle-dir" data-scope="${section}" data-dir="${esc(row.key)}">
					${indent}<span class="gscm-twist${collapsed ? "" : " open"}">${ICON.chevron}</span>
					<span class="gscm-tico">${ICON.folder}</span>
					<span class="gscm-name" title="${esc(row.key)}">${esc(row.node.name)}</span>
					<span class="gscm-count">${dirFiles.length}</span>
					<span class="gscm-acts">${act}</span></div>`;
			}
			const file = row.node.file;
			const letter = statusLetter(file, section);
			const tone = statusTone(letter);
			const stat = row.node.file?.stat;
			const statHtml =
				Array.isArray(stat) && (stat[0] > 0 || stat[1] > 0)
					? `<span class="gscm-stat">${stat[0] > 0 ? `<span class="add">+${stat[0]}</span>` : ""}${
							stat[1] > 0 ? `<span class="del">-${stat[1]}</span>` : ""
						}</span>`
					: "";
			const active = S.selected?.path === file.path;
			const acts =
				section === "changes"
					? `<button type="button" class="gscm-mini" data-act="stage" data-scope="${section}" data-path="${esc(
							file.path,
						)}" title="${esc(t("stage"))}">${ICON.plus}</button>
						<button type="button" class="gscm-mini danger" data-act="discard" data-scope="${section}" data-path="${esc(
							file.path,
						)}" title="${esc(t("discard"))}">${ICON.undo}</button>`
					: `<button type="button" class="gscm-mini" data-act="unstage" data-scope="${section}" data-path="${esc(
							file.path,
						)}" title="${esc(t("unstage"))}">${ICON.minus}</button>`;
			return `<div class="gscm-row file${active ? " active" : ""}" data-act="select" data-scope="${section}" data-path="${esc(
				file.path,
			)}" title="${esc(file.path)}">
				${indent}<span class="gscm-twist"></span>
				<span class="gscm-tico">${ICON.file}</span>
				<span class="gscm-xy ${tone}">${esc(letter)}</span>
				<span class="gscm-name">${esc(row.node.name)}</span>
				${statHtml}
				<span class="gscm-acts">${acts}</span></div>`;
		}

		// ── 渲染：储藏（stash）────────────────────────────────────────────
		function renderStash() {
			if (!stashEl) return;
			const status = S.status;
			const stashes = status?.repo && Array.isArray(status.stashes) ? status.stashes : [];
			if (!status?.repo || (!stashes.length && !S.stashDetail)) {
				stashEl.innerHTML = "";
				return;
			}
			const open = S.stashOpen !== false;
			const caret = `<span class="gscm-caret${open ? " open" : ""}">${ICON.chevron}</span>`;
			const head = `<div class="gscm-sechead" role="button" tabindex="0" data-act="toggle-stash">
				${caret}<span class="gscm-secname">${esc(t("stashTitle"))}</span>
				<span class="gscm-count">${stashes.length}</span>
				<span class="gscm-secacts"><button type="button" class="gscm-mini danger" data-act="stash-clear" title="${esc(
					t("stashClear"),
				)}">${ICON.trash}</button></span></div>`;
			if (!open) {
				stashEl.innerHTML = `<div class="gscm-sect">${head}</div>`;
				return;
			}
			const rows = stashes.length
				? stashes
						.map(
							(stash) => `<div class="gscm-row stash${
								S.stashDetail?.index === stash.index ? " active" : ""
							}" data-act="select-stash" data-index="${esc(stash.index)}" data-ref="${esc(stash.ref)}" data-msg="${esc(
								stash.message || "",
							)}" title="${esc(stash.ref)}">
					<span class="gscm-twist"></span><span class="gscm-tico">${ICON.archive}</span>
					<span class="gscm-name">${esc(stash.message || stash.ref)}</span>
					<span class="gscm-acts">
						<button type="button" class="gscm-mini" data-act="stash-pop" data-index="${esc(
							stash.index,
						)}" title="${esc(t("stashPop"))}">${ICON.download}</button>
						<button type="button" class="gscm-mini" data-act="stash-apply" data-index="${esc(
							stash.index,
						)}" title="${esc(t("stashApply"))}">${ICON.check}</button>
						<button type="button" class="gscm-mini danger" data-act="stash-drop" data-index="${esc(
							stash.index,
						)}" title="${esc(t("stashDrop"))}">${ICON.trash}</button>
					</span></div>`,
						)
						.join("")
				: `<div class="gscm-empty">${esc(t("stashEmpty"))}</div>`;
			stashEl.innerHTML = `<div class="gscm-sect">${head}${rows}</div>`;
		}

		// ── 渲染：提交历史 ──────────────────────────────────────────────────
		function renderHistory() {
			if (!S.status?.repo) {
				histEl.innerHTML = "";
				return;
			}
			const caret = `<span class="gscm-caret${S.historyOpen ? " open" : ""}">${ICON.chevron}</span>`;
			const count = S.historyLoaded ? `<span class="gscm-count">${S.history.length}</span>` : "";
			// 只看某个文件时，标题旁挂一个文件 chip（带 × 恢复全部历史）
			const fileChip = S.historyPath
				? `<span class="gscm-histfile" title="${esc(t("fileHistoryOn"))}">${esc(
						S.historyPath.split("/").pop() || S.historyPath,
					)}<button type="button" data-act="history-all" title="${esc(t("historyAll"))}">×</button></span>`
				: "";
			const head = `<div class="gscm-collapse" role="button" tabindex="0" data-act="toggle-history">${caret}
				<span class="gscm-secname">${esc(t("history"))}</span>${count}${fileChip}</div>`;
			let body = "";
			if (S.historyOpen) {
				if (S.historyLoading) body = `<div class="gscm-empty">${esc(t("loading"))}</div>`;
				else if (!S.history.length) body = `<div class="gscm-empty">${esc(t("historyEmpty"))}</div>`;
				else
					body = S.history
						.map(
							(commit) => `<button type="button" class="gscm-msgc${
								S.commitDetail?.hash === commit.hash ? " active" : ""
							}" data-act="select-commit" data-hash="${esc(commit.hash)}" data-subject="${esc(
								commit.subject,
							)}" title="${esc(commit.hash)}">
						<span class="gscm-msgc-subject">${esc(commit.subject)}</span>
						<span class="gscm-msgc-meta">${esc(commit.shortHash)} · ${esc(commit.author)} · ${esc(commit.date)}</span></button>`,
						)
						.join("");
			}
			histEl.innerHTML = head + body;
		}

		// ── 渲染：diff 区 ───────────────────────────────────────────────────
		/** 分栏 / 单栏的切换按钮：图标 + 提示语跟着当前方式走（切完立即重绘 diff）。 */
		function renderDiffMode() {
			if (!diffModeBtn) return;
			const split = S.diffMode !== "unified";
			diffModeBtn.innerHTML = split ? ICON.columns : ICON.lines;
			diffModeBtn.title = split ? t("toUnified") : t("toSplit");
			diffModeBtn.classList.toggle("on", split);
		}

		function renderDiff() {
			renderDiffMode();
			const head = diffHeadEl.querySelector(".gscm-diffhead-title");
			const acts = diffHeadEl.querySelector(".gscm-diffhead-acts");
			acts.innerHTML = "";
			if (S.commitDetail) {
				head.textContent = `${S.commitDetail.hash.slice(0, 8)}  ${S.commitDetail.subject}`;
				// 历史里的提交：一键生成反向提交（revert，不改历史）
				acts.innerHTML = `<button type="button" class="gscm-mini" data-act="revert" data-hash="${esc(
					S.commitDetail.hash,
				)}" title="${esc(t("revert"))}">${ICON.undo}</button>`;
				diffBodyEl.innerHTML = S.commitDetail.text
					? renderDiffRows(S.commitDetail.text)
					: `<div class="gscm-empty">${esc(t("loading"))}</div>`;
				return;
			}
			if (S.stashDetail) {
				head.textContent = `stash@{${S.stashDetail.index}}  ${S.stashDetail.message}`;
				acts.innerHTML = `<button type="button" class="gscm-mini" data-act="stash-apply" data-index="${esc(
					S.stashDetail.index,
				)}" title="${esc(t("stashApply"))}">${ICON.check}</button>`;
				diffBodyEl.innerHTML = S.stashDetail.text
					? renderDiffRows(S.stashDetail.text)
					: `<div class="gscm-empty">${esc(t("noDiff"))}</div>`;
				return;
			}
			if (!S.selected) {
				head.textContent = "";
				diffBodyEl.innerHTML = `<div class="gscm-empty tall">${esc(t("selectFile"))}</div>`;
				return;
			}
			const path = S.selected.path;
			head.textContent = path;
			const entry = (S.status?.files ?? []).find((f) => f.path === path);
			const untracked = isUntracked(entry);
			const staged = entry && !untracked && entry.x !== " " && entry.x !== "?";
			const fileActs = [];
			// 在编辑器 Pro 里打开（未装插件时点了只提示；blame 行可定位到行）
			fileActs.push(
				`<button type="button" class="gscm-mini" data-act="open-editor" data-path="${esc(path)}" title="${esc(
					t("openInEditorTip"),
				)}">${ICON.editor}</button>`,
			);
			// 已跟踪文件才能追溯 / 查文件历史
			if (!untracked) {
				fileActs.push(
					`<button type="button" class="gscm-mini${
						S.historyPath === path ? " on" : ""
					}" data-act="file-history" data-path="${esc(path)}" title="${esc(t("fileHistory"))}">${ICON.history}</button>`,
				);
				fileActs.push(
					`<button type="button" class="gscm-mini${
						S.blame?.path === path ? " on" : ""
					}" data-act="blame" data-path="${esc(path)}" title="${esc(t("blameTip"))}">${ICON.blame}</button>`,
				);
			}
			if (staged) {
				fileActs.push(
					`<button type="button" class="gscm-mini" data-act="unstage" data-scope="diff" data-path="${esc(
						path,
					)}" title="${esc(t("unstage"))}">${ICON.minus}</button>`,
				);
			} else if (entry) {
				fileActs.push(
					`<button type="button" class="gscm-mini" data-act="stage" data-scope="diff" data-path="${esc(
						path,
					)}" title="${esc(t("stage"))}">${ICON.plus}</button>`,
				);
			}
			acts.innerHTML = fileActs.join("");
			// blame 视图优先于 diff（用户主动切的视图）
			if (S.blame?.path === path) {
				if (S.blame.error) {
					diffBodyEl.innerHTML = `<div class="gscm-banner">${esc(S.blame.error)}</div>`;
					return;
				}
				if (S.blame.loading) {
					diffBodyEl.innerHTML = `<div class="gscm-empty">${esc(t("loading"))}</div>`;
					return;
				}
				if (!Array.isArray(S.blame.lines) || !S.blame.lines.length) {
					diffBodyEl.innerHTML = `<div class="gscm-empty">${esc(t("noDiff"))}</div>`;
					return;
				}
				diffBodyEl.innerHTML = renderBlame(S.blame);
				return;
			}
			if (S.diffError) {
				diffBodyEl.innerHTML = `<div class="gscm-banner">${esc(S.diffError)}</div>`;
				return;
			}
			if (S.diffLoading || !S.diff) {
				diffBodyEl.innerHTML = `<div class="gscm-empty">${esc(t("loading"))}</div>`;
				return;
			}
			const diff = S.diff;
			if (diff.binary) {
				diffBodyEl.innerHTML = `<div class="gscm-empty">${esc(t("binary"))}</div>`;
				return;
			}
			const blocks = [];
			if (untracked) blocks.push(`<div class="gscm-empty">${esc(t("untrackedNote"))}</div>`);
			if (diff.staged) {
				blocks.push(`<div class="gscm-badge">${esc(t("side"))}</div>`);
				blocks.push(renderDiffRows(diff.staged));
			}
			if (diff.worktree) {
				blocks.push(`<div class="gscm-badge">${esc(t("work"))}</div>`);
				blocks.push(renderDiffRows(diff.worktree));
			}
			diffBodyEl.innerHTML = blocks.length ? blocks.join("") : `<div class="gscm-empty">${esc(t("noDiff"))}</div>`;
		}

		/** blame：行号 / 「哈希 作者 日期」/ 正文；同一提交的连续行不重复重复底色。 */
		function renderBlame(blame) {
			const notices = [];
			if (blame.truncated) notices.push(`<div class="gscm-empty">${esc(t("blameTruncated"))}</div>`);
			const rows = blame.lines.map((line) => {
				const notCommitted = /^0{40}$/.test(String(line.hash ?? ""));
				const meta = notCommitted ? t("blameNotCommitted") : `${line.shortHash} ${line.author} ${line.date}`.trim();
				return `<div class="gscm-blame-row${notCommitted ? " changed" : ""}" data-act="open-editor-line" data-line="${esc(
					line.line,
				)}" title="${esc(t("openInEditorAt", { line: line.line }))}">
					<span class="gscm-blame-no">${esc(line.line)}</span>
					<span class="gscm-blame-meta" title="${esc(`${line.hash} ${line.summary || ""}`.trim())}">${esc(meta)}</span>
					<span class="gscm-blame-tx">${esc(line.text) || "&nbsp;"}</span></div>`;
			});
			return [notices.join(""), `<div class="gscm-blame">`, ...rows, `</div>`].join("");
		}

		/** 当前显示方式对应的渲染（默认左右分栏）。 */
		function renderDiffRows(text) {
			return S.diffMode === "unified" ? renderUnifiedRows(text) : renderSplitRows(text);
		}

		/** 单栏（unified）：双行号 + 增删着色，`+`/`-` 标记保留在行首。 */
		function renderUnifiedRows(text) {
			return parseUnifiedDiff(text)
				.map((row) => {
					const oldNo = row.oldNo === undefined ? "" : String(row.oldNo);
					const newNo = row.newNo === undefined ? "" : String(row.newNo);
					return `<div class="gscm-dl ${row.kind}"><span class="gscm-dl-no">${esc(oldNo)}</span><span class="gscm-dl-no">${esc(
						newNo,
					)}</span><span class="gscm-dl-tx">${esc(row.text) || " "}</span></div>`;
				})
				.join("");
		}

		/** 分栏里的正文：去掉行首标记（`+`/`-`/空格），空行补 nbsp 保住行高。 */
		function splitText(row) {
			return esc(String(row.text ?? "").slice(1)) || "&nbsp;";
		}

		/** 一格（行号 + 正文）；对侧没有对应行时画斜纹占位。 */
		function splitSide(row, no, kind, isNewSide) {
			const noCls = `gscm-ds-no${isNewSide ? " gscm-ds-no2" : ""}`;
			if (!row) return `<span class="${noCls} fill"></span><span class="gscm-ds-tx fill"></span>`;
			return (
				`<span class="${noCls} ${kind}">${esc(no === undefined ? "" : String(no))}</span>` +
				`<span class="gscm-ds-tx ${kind}">${splitText(row)}</span>`
			);
		}

		/**
		 * 左右分栏：旧文件（删 + 上下文）在左，新文件（增 + 上下文）在右，同一行对齐。
		 * 整份补丁共用一个 grid 容器，四条列才会跳行对齐。
		 */
		function renderSplitRows(text) {
			const out = ['<div class="gscm-ds">'];
			for (const row of buildSplitRows(text)) {
				if (row.kind === "meta" || row.kind === "hunk" || row.kind === "blank") {
					out.push(`<div class="gscm-ds-full ${row.kind}">${esc(row.text) || "&nbsp;"}</div>`);
					continue;
				}
				const kind = row.kind === "ctx" ? "ctx" : "";
				out.push(splitSide(row.left, row.left?.oldNo, kind || "del", false));
				out.push(splitSide(row.right, row.right?.newNo, kind || "add", true));
			}
			out.push("</div>");
			return out.join("");
		}

		function renderAll() {
			renderHead();
			renderLists();
			renderStash();
			renderHistory();
			renderDiff();
		}

		// ── 动作 ────────────────────────────────────────────────────────────

		/** 每个写操作的中文名与成功回执（状态条用）；未列出的原样显示名字。 */
		function opLabels(name) {
			const map = {
				pull: { run: t("pull"), done: t("donePull") },
				push: { run: t("push"), done: t("donePush") },
				publish: { run: t("publish"), done: t("donePublish") },
				fetch: { run: t("fetch"), done: t("doneFetch") },
				stage: { run: t("stage"), done: t("doneStage") },
				unstage: { run: t("unstage"), done: t("doneUnstage") },
				"stage-dir": { run: t("stage"), done: t("doneStage") },
				"unstage-dir": { run: t("unstage"), done: t("doneUnstage") },
				"stage-all": { run: t("stageAll"), done: t("doneStage") },
				"unstage-all": { run: t("unstageAll"), done: t("doneUnstage") },
				discard: { run: t("discard"), done: t("doneDiscard") },
				"discard-all": { run: t("discardAll"), done: t("doneDiscard") },
				commit: { run: t("commit"), done: t("doneCommit") },
				"commit-all": { run: t("commitAll"), done: t("doneCommit") },
				init: { run: t("init"), done: t("doneInit") },
				branch: { run: t("branch"), done: t("doneBranch") },
				"branch-create": { run: t("newBranch"), done: t("doneBranch") },
				"branch-delete": { run: t("deleteBranch"), done: t("doneBranch") },
				"branch-rename": { run: t("renameBranch"), done: t("doneBranch") },
				merge: { run: t("mergeBranch"), done: t("mergeBranch") },
				"merge-abort": { run: t("mergeAbort"), done: t("doneMergeAbort") },
				"revert-abort": { run: t("revertAbort"), done: t("doneMergeAbort") },
				"stash-save": { run: t("stashSave"), done: t("doneStashSave") },
				"stash-save-untracked": { run: t("stashSaveUntracked"), done: t("doneStashSave") },
				"stash-pop": { run: t("stashPop"), done: t("doneStashPop") },
				"stash-apply": { run: t("stashApply"), done: t("doneStashApply") },
				"stash-drop": { run: t("stashDrop"), done: t("doneStashDrop") },
				"stash-clear": { run: t("stashClear"), done: t("doneStashClear") },
				"undo-soft": { run: t("undoSoft"), done: t("doneReset") },
				"undo-mixed": { run: t("undoMixed"), done: t("doneReset") },
				"undo-hard": { run: t("undoHard"), done: t("doneReset") },
				"tag-create": { run: t("tagCreate"), done: t("doneTag") },
				"tag-push": { run: t("tagCreate"), done: t("doneTagPush") },
				"pull-rebase": { run: t("pullRebase"), done: t("donePullRebase") },
				"push-force": { run: t("pushForce"), done: t("donePushForce") },
				revert: { run: t("revert"), done: t("doneRevert") },
				"remote-add": { run: t("remoteAdd"), done: t("doneRemoteAdd") },
			};
			return map[name] ?? { run: name, done: name };
		}

		/**
		 * 跑一次写操作。三种反馈同时给到，避免「按钮灰了不知道在干嘛」：
		 *   1. 分支行下方的状态条：转圈 + 「正在拉取（pull）… 4s」（网络操作可能几十秒）；
		 *   2. 结束后的回执条：绿色「拉取完成」/ 红色错误原因（6 秒后自动消失）；
		 *   3. 当前按钮本体转圈，其余按钮置灰防重复触发。
		 */
		const NET_OPS = new Set(["pull", "pull-rebase", "push", "push-force", "publish", "fetch", "tag-push"]);

		/** 网络操作的取消凭据（opId → 发给服务端的同一串）。 */
		let currentOpId = "";

		async function runOp(name, fn) {
			if (S.busy) return false;
			const labels = opLabels(name);
			const online = NET_OPS.has(name);
			if (online) currentOpId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			S.busy = name;
			setOp("busy", t("working", { op: labels.run }), t("workingHint"), online ? currentOpId : "");
			renderHead();
			let outcome = null;
			try {
				const result = await fn({ opId: currentOpId });
				outcome = result;
				if (destroyed) return result;
				if (result && result.ok === false) {
					setBanner(result.code === "conflict" ? result.error || labels.run : "");
					if (result.code === "cancelled") setOp("info", t("cancelled"));
					else setOp("error", result.error || `${labels.run} 失败`);
				} else {
					setBanner("");
					const detail = String(result?.output ?? result?.summary ?? "").trim();
					setOp("ok", detail ? `${labels.done}：${detail.split("\n")[0]}` : labels.done, detail);
				}
			} catch (err) {
				const message = String(/** @type {any} */ (err)?.message ?? err);
				if (!destroyed) {
					setBanner("");
					setOp("error", message);
				}
			} finally {
				currentOpId = "";
				S.busy = "";
				if (!destroyed) {
					renderHead();
					await refresh();
					// 暂存/取消暂存会改变 diff 的归属（暂存区 vs 工作区），选中文件跟着重读。
					if (S.selected?.path) void selectFile(S.selected.path);
					if (name === "commit" || name === "commit-all") await loadHistory();
					// 储藏被 pop/drop / 合并或重置改变工作区：清掉不再存在的选中项
					pruneStash();
				}
			}
			return outcome;
		}

		function pathsUnder(dir, files) {
			return files.filter((f) => f.path === dir || f.path.startsWith(`${dir}/`)).map((f) => f.path);
		}

		/** 刷新 / 写操作后：储藏被 pop/drop 掉了就清掉右栏的旧补丁。 */
		function pruneStash() {
			if (!S.stashDetail) return;
			const list = S.status?.stashes ?? [];
			if (!list.some((item) => item.index === S.stashDetail?.index)) {
				S.stashDetail = null;
				renderStash();
				renderDiff();
			}
		}

		function currentSectionFiles(scopeKey) {
			const sections = splitSections(S.status?.files, S.status?.stats);
			return scopeKey === "staged" ? sections.staged : sections.changes;
		}

		async function selectFile(path) {
			S.commitDetail = null;
			S.stashDetail = null;
			if (S.blame && S.blame.path !== path) S.blame = null;
			S.selected = { path };
			S.diff = null;
			S.diffError = "";
			S.diffLoading = true;
			renderLists();
			renderStash();
			renderDiff();
			try {
				const data = await api(`/diff?path=${encodeURIComponent(path)}`);
				if (destroyed || S.selected?.path !== path) return;
				if (!data?.ok) S.diffError = data?.error || "diff 读取失败";
				else S.diff = data;
			} catch (err) {
				if (!destroyed && S.selected?.path === path) S.diffError = String(/** @type {any} */ (err)?.message ?? err);
			} finally {
				if (!destroyed && S.selected?.path === path) {
					S.diffLoading = false;
					renderDiff();
				}
			}
		}

		async function selectCommit(hash, subject) {
			S.selected = null;
			S.stashDetail = null;
			S.blame = null;
			S.commitDetail = { hash, subject, text: "" };
			renderLists();
			renderStash();
			renderHistory();
			renderDiff();
			try {
				const data = await api(`/commit?hash=${encodeURIComponent(hash)}`);
				if (destroyed || S.commitDetail?.hash !== hash) return;
				if (!data?.ok) setBanner(data?.error || "读取提交失败");
				else S.commitDetail = { hash, subject, text: data.text || "" };
			} catch (err) {
				if (!destroyed) setBanner(String(/** @type {any} */ (err)?.message ?? err));
			} finally {
				if (!destroyed && S.commitDetail?.hash === hash) renderDiff();
			}
		}

		async function loadHistory(path = S.historyPath) {
			const wanted = String(path || "");
			S.historyPath = wanted;
			S.historyLoading = true;
			renderHistory();
			try {
				const query = `?limit=60${wanted ? `&path=${encodeURIComponent(wanted)}` : ""}`;
				const data = await api(`/log${query}`);
				if (destroyed || S.historyPath !== wanted) return;
				if (data?.ok) {
					S.history = Array.isArray(data.commits) ? data.commits : [];
					S.historyLoaded = true;
				}
			} catch {
				/* 历史读不到不影响主流程 */
			} finally {
				S.historyLoading = false;
				if (!destroyed) renderHistory();
			}
		}

		/** 逐个文件追溯（blame）：已经打开则收起（同一按钮当开关）。 */
		async function toggleBlame(path) {
			if (S.blame?.path === path) {
				S.blame = null;
				renderDiff();
				return;
			}
			S.commitDetail = null;
			S.stashDetail = null;
			S.blame = { path, loading: true, error: "", lines: [], truncated: false };
			renderDiff();
			try {
				const data = await api(`/blame?path=${encodeURIComponent(path)}`);
				if (destroyed || S.blame?.path !== path) return;
				if (!data?.ok) S.blame = { ...S.blame, loading: false, error: data?.error || "blame 读取失败" };
				else S.blame = { path, loading: false, error: "", lines: data.lines ?? [], truncated: Boolean(data.truncated) };
			} catch (err) {
				if (!destroyed && S.blame?.path === path)
					S.blame = { ...S.blame, loading: false, error: String(/** @type {any} */ (err)?.message ?? err) };
			} finally {
				if (!destroyed) renderDiff();
			}
		}

		/** 点储藏行：右栏看它的补丁（与单文件 diff 共用渲染）。 */
		async function selectStash(index, message) {
			S.selected = null;
			S.commitDetail = null;
			S.blame = null;
			S.stashDetail = { index, message: message || `stash@{${index}}`, text: "" };
			renderLists();
			renderStash();
			renderDiff();
			try {
				const data = await api(`/stash?index=${encodeURIComponent(index)}`);
				if (destroyed || S.stashDetail?.index !== index) return;
				if (!data?.ok) setBanner(data?.error || "读取储藏失败");
				else S.stashDetail = { index, message: S.stashDetail.message, text: data.text || "" };
			} catch (err) {
				if (!destroyed) setBanner(String(/** @type {any} */ (err)?.message ?? err));
			} finally {
				if (!destroyed && S.stashDetail?.index === index) renderDiff();
			}
		}

		// ── AI 提交信息：等待期实时计时 + 结果逐字流入提交框 ────────────────
		let streamFrame = null;
		let streamFull = "";

		/** 结束逐字写入：把完整文本落到提交框（keepPartial=false 时）。 */
		function stopStream(keepPartial = false) {
			if (streamFrame) {
				cancelAnimationFrame(streamFrame);
				streamFrame = null;
			}
			const wasStreaming = S.streaming;
			S.streaming = false;
			if (wasStreaming && !keepPartial && streamFull) msgEl.value = streamFull;
			autoGrow();
			renderHead();
		}

		/**
		 * 逐字写入（按词元步进，总时长约 0.6~1s）。宿主的一次性补全接口
		 * （host.llm.complete）不提供 token 流，所以这里把「已经拿到的整段」按帧吐出来：
		 * 输入框是随内容实时长高的，看起来就是流式；用户随时可以打断（点 ✦ 或开始输入）。
		 */
		function streamInto(text) {
			stopStream(true);
			streamFull = String(text ?? "");
			if (!streamFull) return;
			S.streaming = true;
			msgEl.value = "";
			autoGrow();
			renderHead();
			const total = streamFull.length;
			const step = Math.max(4, Math.ceil(total / 48));
			let index = 0;
			const tick = () => {
				streamFrame = null;
				if (destroyed || !S.streaming) return;
				index = Math.min(total, index + step);
				msgEl.value = streamFull.slice(0, index);
				// 光标跟到末尾，视觉上像在打字
				try {
					msgEl.setSelectionRange(index, index);
				} catch {
					/* 未挂载时忽略 */
				}
				autoGrow();
				if (index >= total) {
					S.streaming = false;
					renderHead();
					return;
				}
				streamFrame = requestAnimationFrame(tick);
			};
			streamFrame = requestAnimationFrame(tick);
		}

		async function genMessage() {
			// 正在写入：点一下 = 立刻补全（不打断内容，只是不等动画）
			if (S.streaming) {
				stopStream(false);
				return;
			}
			if (S.genLoading) return;
			S.genLoading = true;
			setAiError("");
			setAiNote([]);
			setOp("busy", t("working", { op: t("aiWaiting") }), t("genTip"));
			renderHead();
			try {
				const data = await api("/ai-message", {
					method: "POST",
					body: JSON.stringify({ lang }),
				});
				if (destroyed) return;
				if (data?.ok && data.message) {
					setOp(null);
					setAiNote(Array.isArray(data.problems) ? data.problems : []);
					// 先流进输入框，写完再亮 commit 按钮（避免提交到一半的消息）
					streamInto(data.message);
				} else {
					setOp(null);
					setAiError(data?.error || t("genTip"));
				}
			} catch (err) {
				if (!destroyed) {
					setOp(null);
					setAiError(String(/** @type {any} */ (err)?.message ?? err));
				}
			} finally {
				S.genLoading = false;
				if (!destroyed) renderHead();
			}
		}

		function commitMessageOrWarn() {
			const text = msgEl.value.trim();
			if (!text) {
				setBanner(
					lang === "zh" ? "先写一条提交信息（可用 ✦ 让 AI 生成）" : "Write a commit message first (✦ can generate one)",
				);
				return null;
			}
			return text;
		}

		function doCommit(stageAll) {
			const message = commitMessageOrWarn();
			if (!message) return;
			// 仓库提交规范禁止单句提交：缺正文时把话说清，让用户自己决定。
			if (needsBodyWarning(message) && !window.confirm(t("needBody"))) return;
			// amend 模式：这次提交会用“上一条提交 + 暂存区”整体替换上一条
			const amend = Boolean(S.amend);
			void runOp(stageAll ? "commit-all" : "commit", async () => {
				const result = await api("/commit", {
					method: "POST",
					body: JSON.stringify({ message, stageAll, amend }),
				});
				if (result?.ok) {
					// 提交是异步的：期间用户可能已经敲了新内容，那就别清空、也别收细条。
					if (msgEl.value.trim() === message) {
						msgEl.value = "";
						collapseMsg();
					}
					S.amend = false;
					S.selected = null;
					S.diff = null;
					S.commitDetail = null;
				}
				return result;
			});
		}

		/** 进入 amend 模式：把上一条提交的完整消息回填输入框，用户可以直接改。 */
		async function enterAmend() {
			try {
				const data = await api("/commit-message?hash=HEAD");
				if (destroyed) return;
				if (!data?.ok) return setOp("error", data?.error || t("amend"));
				S.amend = true;
				if (data.message) {
					msgEl.value = data.message;
					autoGrow();
				}
				setAiNote([]);
				renderHead();
				try {
					msgEl.focus();
				} catch {
					/* 已卸载 */
				}
			} catch (err) {
				if (!destroyed) setOp("error", String(/** @type {any} */ (err)?.message ?? err));
			}
		}

		function toggleAmend() {
			if (S.amend) {
				S.amend = false;
				renderHead();
				return;
			}
			void enterAmend();
		}

		function handleAction(act, dataset, event) {
			const scopeKey = dataset.scope || "";
			switch (act) {
				case "refresh":
					void refresh();
					return;
				case "cancel-op": {
					const opId = S.op?.opId || currentOpId;
					if (!opId) return;
					// 保留 opId：取消按钮再点一次也安全（服务端回「已结束」）
					setOp("busy", t("working", { op: t("cancel") }), t("cancelTip"), opId);
					void api("/sync/cancel", { method: "POST", body: JSON.stringify({ opId }) }).catch(() => {});
					return;
				}
				case "menu":
					S.menuOpen = !S.menuOpen;
					renderMenu();
					return;
				case "divider":
					return;
				case "diffmode":
					// 左右分栏 ⇄ 单栏 unified；窄屏 / 看清行首标记时可以切回来，选择存档。
					S.diffMode = S.diffMode === "unified" ? "split" : "unified";
					saveDiffMode(S.diffMode);
					renderDiff();
					return;
				case "toggle-section":
					S.sectionOpen[scopeKey] = S.sectionOpen[scopeKey] === false;
					renderLists();
					return;
				case "toggle-dir": {
					const key = `${scopeKey}:${dataset.dir}`;
					if (S.collapsed.has(key)) S.collapsed.delete(key);
					else S.collapsed.add(key);
					renderLists();
					return;
				}
				case "select":
					if (dataset.path) void selectFile(dataset.path);
					return;
				case "select-commit":
					if (dataset.hash) void selectCommit(dataset.hash, dataset.subject || "");
					return;
				case "toggle-history":
					S.historyOpen = !S.historyOpen;
					renderHistory();
					if (S.historyOpen && !S.history.length) void loadHistory();
					return;
				case "file-history":
					// 右栏的「此文件历史」：历史区只看这个文件（再点一次 / × 恢复全部）
					if (!dataset.path) return;
					S.historyOpen = true;
					if (S.historyPath === dataset.path) {
						void loadHistory("");
						return;
					}
					void loadHistory(dataset.path);
					return;
				case "history-all":
					S.historyOpen = true;
					void loadHistory("");
					return;
				case "blame":
					if (dataset.path) void toggleBlame(dataset.path);
					return;
				case "open-editor":
					if (dataset.path) openInEditor(dataset.path, 0);
					return;
				case "open-editor-line":
					// blame 行：当前文件 + 该行（blame 只能开在选中的文件上）
					if (S.selected?.path) openInEditor(S.selected.path, Number(dataset.line) || 0);
					return;
				case "select-stash":
					if (dataset.index !== undefined) void selectStash(Number(dataset.index), dataset.msg || dataset.ref || "");
					return;
				case "toggle-stash":
					S.stashOpen = S.stashOpen === false;
					renderStash();
					return;
				case "stage":
				case "unstage": {
					const paths = dataset.path ? [dataset.path] : [];
					if (!paths.length) return;
					void runOp(act, () =>
						api(act === "stage" ? "/stage" : "/unstage", {
							method: "POST",
							body: JSON.stringify({ paths }),
						}),
					);
					return;
				}
				case "stage-dir":
				case "unstage-dir": {
					const files = currentSectionFiles(act === "stage-dir" ? "changes" : "staged");
					const paths = pathsUnder(dataset.dir || "", files);
					if (!paths.length) return;
					void runOp(act, () =>
						api(act === "stage-dir" ? "/stage" : "/unstage", {
							method: "POST",
							body: JSON.stringify({ paths }),
						}),
					);
					return;
				}
				case "stage-all":
				case "unstage-all":
					void runOp(act, () =>
						api(act === "stage-all" ? "/stage" : "/unstage", {
							method: "POST",
							body: JSON.stringify({ all: true }),
						}),
					);
					return;
				case "discard": {
					if (!dataset.path) return;
					const ok = window.confirm(t("discardConfirm", { n: 1 }));
					if (!ok) return;
					void runOp("discard", () =>
						api("/discard", { method: "POST", body: JSON.stringify({ paths: [dataset.path] }) }),
					);
					return;
				}
				case "discard-all": {
					S.menuOpen = false;
					renderMenu();
					if (!window.confirm(t("discardAllConfirm"))) return;
					void runOp("discard-all", () => api("/discard", { method: "POST", body: JSON.stringify({ all: true }) }));
					return;
				}
				case "fetch":
					S.menuOpen = false;
					renderMenu();
					void runOp("fetch", (op) =>
						api("/sync", { method: "POST", body: JSON.stringify({ action: "fetch", opId: op?.opId }) }),
					);
					return;
				case "init":
					void runOp("init", () => api("/init", { method: "POST", body: "{}" }));
					return;
				case "pull":
				case "push":
				case "publish":
				case "pull-rebase":
					void runOp(act, (op) =>
						api("/sync", { method: "POST", body: JSON.stringify({ action: act, opId: op?.opId }) }),
					);
					return;
				case "push-force":
					if (!window.confirm(t("pushForceConfirm"))) return;
					void runOp("push-force", (op) =>
						api("/sync", { method: "POST", body: JSON.stringify({ action: "push-force", opId: op?.opId }) }),
					);
					return;
				case "branch":
					pickBranch(event);
					return;
				case "switch-branch":
					if (!dataset.branch) return;
					void runOp("branch", () =>
						api("/branch", { method: "POST", body: JSON.stringify({ action: "switch", name: dataset.branch }) }),
					);
					return;
				case "branch-menu":
					pickBranch(event);
					return;
				case "branch-create": {
					const name = window.prompt(t("newBranchPrompt"));
					if (!name || !name.trim()) return;
					void runOp("branch-create", () =>
						api("/branch", { method: "POST", body: JSON.stringify({ action: "create", name: name.trim() }) }),
					);
					return;
				}
				case "branch-rename": {
					const name = window.prompt(t("renameBranchPrompt"), S.status?.branch || "");
					if (!name || !name.trim()) return;
					void runOp("branch-rename", () =>
						api("/branch", { method: "POST", body: JSON.stringify({ action: "rename", name: name.trim() }) }),
					);
					return;
				}
				case "branch-merge":
					openBranchPick("merge");
					return;
				case "branch-delete":
					openBranchPick("delete");
					return;
				case "merge-branch": {
					const name = dataset.branch || "";
					if (!name) return;
					if (!window.confirm(t("mergeIntoConfirm", { name, current: S.status?.branch || "HEAD" }))) return;
					void runOp("merge", () => api("/merge", { method: "POST", body: JSON.stringify({ name }) }));
					return;
				}
				case "delete-branch": {
					const name = dataset.branch || "";
					if (!name) return;
					if (!window.confirm(t("deleteBranchConfirm", { name }))) return;
					// 用户已在确认框里看清楚了：允许删未合并分支（-D）
					void runOp("branch-delete", () =>
						api("/branch", { method: "POST", body: JSON.stringify({ action: "delete", name, force: true }) }),
					);
					return;
				}
				case "merge-abort":
					void runOp("merge-abort", () => api("/merge", { method: "POST", body: JSON.stringify({ abort: "merge" }) }));
					return;
				case "revert-abort":
					void runOp("revert-abort", () =>
						api("/merge", { method: "POST", body: JSON.stringify({ abort: "revert" }) }),
					);
					return;
				case "revert": {
					const hash = dataset.hash || S.commitDetail?.hash || "";
					if (!hash) return;
					if (!window.confirm(t("revertConfirm", { hash: hash.slice(0, 8) }))) return;
					void runOp("revert", () => api("/revert", { method: "POST", body: JSON.stringify({ hash }) }));
					return;
				}
				case "amend-toggle":
					S.menuOpen = false;
					renderMenu();
					toggleAmend();
					return;
				case "amend-off":
					S.amend = false;
					renderHead();
					return;
				case "undo-menu": {
					// 撤销提交的三种方式做成子菜单（提示语里写明改动去哪儿了）
					openMenu(
						[
							{ act: "undo-soft", icon: ICON.undo, label: t("undoSoft") },
							{ act: "undo-mixed", icon: ICON.undo, label: t("undoMixed") },
							{ act: "undo-hard", icon: ICON.trash, label: t("undoHard"), danger: true },
						],
						moreBtn,
						true,
					);
					return;
				}
				case "undo-soft":
				case "undo-mixed":
				case "undo-hard": {
					const mode = act.slice("undo-".length);
					if (mode === "hard" && !window.confirm(t("undoHardConfirm"))) return;
					void runOp(act, () => api("/reset", { method: "POST", body: JSON.stringify({ mode, count: 1 }) }));
					return;
				}
				case "stash-save":
				case "stash-save-untracked":
					S.menuOpen = false;
					renderMenu();
					void runOp(act, () =>
						api("/stash", {
							method: "POST",
							body: JSON.stringify({
								action: "save",
								...(act === "stash-save-untracked" ? { includeUntracked: true } : {}),
							}),
						}),
					);
					return;
				case "stash-pop":
				case "stash-apply":
				case "stash-drop": {
					const index = Number(dataset.index ?? S.stashDetail?.index ?? 0) || 0;
					void runOp(act, () =>
						api("/stash", {
							method: "POST",
							body: JSON.stringify({ action: act.slice("stash-".length), index }),
						}),
					);
					return;
				}
				case "stash-clear":
					if (!window.confirm(t("stashClearConfirm"))) return;
					void runOp("stash-clear", () => api("/stash", { method: "POST", body: JSON.stringify({ action: "clear" }) }));
					return;
				case "remote-add": {
					const url = window.prompt(t("remoteAddPrompt"), "https://");
					if (!url || !url.trim()) return;
					S.menuOpen = false;
					renderMenu();
					void runOp("remote-add", () =>
						api("/remote", {
							method: "POST",
							body: JSON.stringify({ action: "add", name: "origin", url: url.trim() }),
						}),
					);
					return;
				}
				case "tag-create": {
					const name = window.prompt(t("tagNamePrompt"), "");
					if (!name || !name.trim()) return;
					const message = window.prompt(t("tagMessagePrompt"), "") ?? "";
					void runOp("tag-create", () =>
						api("/tag", {
							method: "POST",
							body: JSON.stringify({ action: "create", name: name.trim(), message }),
						}),
					).then(async (created) => {
						if (!created || destroyed) return;
						if (!window.confirm(t("tagPushConfirm", { name: name.trim() }))) return;
						void runOp("tag-push", (op) =>
							api("/tag", {
								method: "POST",
								body: JSON.stringify({ action: "push", name: name.trim(), opId: op?.opId }),
							}),
						);
					});
					return;
				}
				case "commit":
					doCommit(false);
					return;
				case "commit-all":
					doCommit(true);
					return;
				case "ai":
					void genMessage();
					return;
				default:
					return;
			}
		}

		/**
		 * 宿主没有原生 select 弹窗：所有菜单都画在同一个浮层里（内容由 openMenu 换）。
		 * anchorEl = 贴着那个按钮弹出（⋯ 菜单贴 ⋯、分支菜单贴分支名）；
		 * 菜单比按钮宽时往左推：**右边缘对齐按钮**，且不越出所在侧栏（不会跑到页面最右边）。
		 * wide = ⋯ 菜单（项多、需要滚动），分支菜单不需要。
		 */
		function openMenu(items, anchorEl, wide = false) {
			const rows = items.map((item) => {
				if (item.divider) return `<div class="gscm-menu-sep"></div>`;
				if (item.head) return `<div class="gscm-menu-head"><span>${esc(item.head)}</span>${esc(item.note ?? "")}</div>`;
				const attrs = [
					`data-act="${esc(item.act)}"`,
					item.branch ? `data-branch="${esc(item.branch)}"` : "",
					item.path ? `data-path="${esc(item.path)}"` : "",
					item.index !== undefined && item.index !== null ? `data-index="${esc(item.index)}"` : "",
					item.hash ? `data-hash="${esc(item.hash)}"` : "",
					item.title ? `title="${esc(item.title)}"` : "",
					item.disabled ? "disabled" : "",
				]
					.filter(Boolean)
					.join(" ");
				return `<button type="button" class="gscm-mi${item.danger ? " danger" : ""}" ${attrs}>${
					item.icon ?? ""
				}<span>${esc(item.label)}</span></button>`;
			});
			menuEl.innerHTML = rows.join("");
			menuEl.classList.remove("gscm-hide");
			menuEl.classList.toggle("plain", wide || !anchorEl);
			S.menuOpen = true;
			const hostRect = root.getBoundingClientRect();
			if (!anchorEl) {
				menuEl.style.top = "32px";
				menuEl.style.left = "auto";
				menuEl.style.right = "6px";
				return;
			}
			const rect = anchorEl.getBoundingClientRect();
			const width = menuEl.offsetWidth || (wide ? 230 : 210);
			// 边界取所在侧栏的右缘 —— ⋯ 在侧栏最右，不这样夹会甩到 diff 区上方
			const side = anchorEl.closest(".gscm-side");
			const boundRight = (side ? side.getBoundingClientRect().right : hostRect.right) - hostRect.left;
			const left = menuLeft(rect.left - hostRect.left, rect.right - hostRect.left, width, boundRight, hostRect.width);
			// 纵向：贴着按钮下方；放不下（窗口矮 / 菜单长）就往上收，别让底部项点不到
			const height = menuEl.offsetHeight || 0;
			let top = rect.bottom + 4;
			if (height && top + height > hostRect.bottom - 6) top = Math.max(hostRect.top + 4, hostRect.bottom - height - 6);
			menuEl.style.top = `${Math.max(4, top - hostRect.top)}px`;
			menuEl.style.left = `${left}px`;
			menuEl.style.right = "auto";
		}

		/** 分支菜单根：新建 / 重命名 / 合并 / 删除 + 本地与远端分支列表。 */
		function pickBranch(event) {
			const status = S.status;
			if (!status?.repo) return;
			const current = status.branch;
			const branches = status.branches ?? [];
			const others = branches.filter((name) => name !== current);
			const busy = Boolean(S.busy);
			const items = [
				{ act: "branch-create", icon: ICON.plus, label: t("newBranch"), disabled: busy },
				{
					act: "branch-rename",
					icon: ICON.pencil,
					label: t("renameBranch"),
					disabled: busy || Boolean(status.detached) || Boolean(status.unborn),
				},
				{
					act: "branch-merge",
					icon: ICON.branch,
					label: t("mergeBranch"),
					disabled: busy || !others.length,
					title: t("branchMenuTip"),
				},
				{
					act: "branch-delete",
					icon: ICON.trash,
					label: t("deleteBranch"),
					danger: true,
					disabled: busy || !others.length,
				},
				{ divider: true },
				{ head: t("localBranches") },
			];
			for (const name of branches) {
				items.push({
					act: "switch-branch",
					icon: ICON.branch,
					branch: name,
					label: name,
					disabled: busy || name === current,
					title: name,
				});
			}
			const remoteBranches = status.remoteBranches ?? [];
			if (remoteBranches.length) {
				items.push({ divider: true }, { head: t("remoteBranches") });
				for (const name of remoteBranches.slice(0, 40)) {
					items.push({ act: "switch-branch", icon: ICON.upload, branch: name, label: name, disabled: busy });
				}
			}
			openMenu(items, branchBtn);
			if (event) event.stopPropagation();
		}

		/** 合并 / 删除的子菜单：只列「不是当前分支」的那些（列表里点一条就执行）。 */
		function openBranchPick(mode) {
			const status = S.status;
			const current = status?.branch;
			const names = (status?.branches ?? []).filter((name) => name !== current);
			const items = [{ act: "branch-menu", icon: ICON.back, label: t("backToBranches") }, { divider: true }];
			for (const name of names) {
				items.push({
					act: mode === "merge" ? "merge-branch" : "delete-branch",
					icon: mode === "merge" ? ICON.branch : ICON.trash,
					branch: name,
					label: name,
					danger: mode === "delete",
				});
			}
			if (!names.length) items.push({ head: t("noChanges") });
			openMenu(items, branchBtn);
		}

		function renderMenu() {
			if (!S.menuOpen) {
				menuEl.classList.add("gscm-hide");
				return;
			}
			const status = S.status;
			const repo = Boolean(status?.repo);
			const busy = Boolean(S.busy);
			const items = [];
			if (!repo) {
				items.push({ act: "init", icon: ICON.folder, label: t("init") });
				openMenu(items, moreBtn, true);
				return;
			}
			const remotes = status?.remotes ?? [];
			// 刚 init 的仓库还没有远端：先给「添加远端」，否则 publish / push 都无从下手
			if (!remotes.length) items.push({ act: "remote-add", icon: ICON.branch, label: t("remoteAdd"), disabled: busy });
			// 没有上游但有远端：给一个「发布分支」入口（否则 push 必然报 no upstream）
			const canPublish = !status?.upstream && remotes.length > 0 && !status?.detached;
			if (canPublish) {
				items.push({ act: "publish", icon: ICON.upload, label: t("publish"), title: t("publishTip"), disabled: busy });
			}
			if (status?.mergeInProgress)
				items.push({ act: "merge-abort", icon: ICON.undo, label: t("mergeAbort"), danger: true, disabled: busy });
			items.push(
				{ act: "fetch", icon: ICON.download, label: t("fetch"), disabled: busy },
				{ act: "pull-rebase", icon: ICON.download, label: t("pullRebase"), disabled: busy },
			);
			if (status?.upstream && !status?.upstreamGone)
				items.push({ act: "push-force", icon: ICON.upload, label: t("pushForce"), danger: true, disabled: busy });
			items.push({ divider: true });
			const hasChanges = Boolean(status?.files?.length);
			items.push(
				{ act: "stash-save", icon: ICON.archive, label: t("stashSave"), disabled: busy || !hasChanges },
				{
					act: "stash-save-untracked",
					icon: ICON.archive,
					label: t("stashSaveUntracked"),
					disabled: busy || !hasChanges,
				},
			);
			items.push({ divider: true });
			items.push(
				{
					act: "amend-toggle",
					icon: ICON.pencil,
					label: S.amend ? t("amendCancel") : t("amend"),
					title: S.amend ? t("amendOfferTip") : t("amendTip"),
					disabled: busy || Boolean(status?.unborn),
				},
				{ act: "undo-menu", icon: ICON.undo, label: t("undoCommit"), disabled: busy || Boolean(status?.unborn) },
				{ act: "tag-create", icon: ICON.tag, label: t("tagCreate"), disabled: busy || Boolean(status?.unborn) },
			);
			items.push({ divider: true });
			items.push(
				{ act: "stage-all", icon: ICON.plus, label: t("stageAll"), disabled: busy },
				{ act: "unstage-all", icon: ICON.minus, label: t("unstageAll"), disabled: busy },
				{ act: "discard-all", icon: ICON.undo, label: t("discardAll"), danger: true, disabled: busy },
			);
			openMenu(items, moreBtn, true);
		}

		// ── 事件接线 ────────────────────────────────────────────────────────
		const onClick = (event) => {
			const target = /** @type {HTMLElement} */ (event.target);
			const node = target?.closest?.("[data-act]");
			if (!node) {
				if (S.menuOpen) {
					S.menuOpen = false;
					renderMenu();
				}
				return;
			}
			const act = node.getAttribute("data-act");
			if (!act) return;
			// 文件行 / 储藏行的子按钮不触发行本身的选中动作。
			if ((act === "select" || act === "select-stash") && target !== node && target.closest("button")) return;
			// 点菜单里的项：先收起旧菜单（下面开新菜单的 action 会重新打开它）
			if (act !== "menu" && act !== "branch" && S.menuOpen && node.closest(".gscm-menu")) {
				S.menuOpen = false;
				renderMenu();
			}
			handleAction(act, node.dataset, event);
		};
		root.addEventListener("click", onClick);

		/**
		 * 提交框默认就是 56px（点击不再变尺寸）；内容变多才跟着长，上限 40vh，超过自己滚。
		 * 结构化提交信息有 6~10 行，所以只往大涨、不往回缩。
		 */
		const OPEN_H = 56;
		function autoGrow() {
			// 先撤掉行内高度再量 scrollHeight，否则量到的是上一次的定高。
			msgEl.style.height = "auto";
			const limit = Math.max(96, Math.round(window.innerHeight * 0.4));
			const want = Math.max(OPEN_H, msgEl.scrollHeight);
			msgEl.style.height = `${Math.min(limit, want)}px`;
		}

		/** 提交成功 / 清空后回到默认高度（只清 value 不会自动缩回）。 */
		function collapseMsg() {
			autoGrow();
		}

		const onInput = () => {
			// 用户开始手改就不再显示上一轮生成的规范提醒（避免误读成「当前消息有问题」）。
			if (S.aiNote.length) setAiNote([]);
			// 手改即接管：立刻结束逐字写入，别跟用户抢光标。
			if (S.streaming) {
				stopStream(true);
				return;
			}
			autoGrow();
			renderHead();
		};
		msgEl.addEventListener("input", onInput);
		autoGrow();
		// 分组头是 div[role=button]（里面还套着整组暂存按钮），键盘回车也当点击用。
		const onKeyPress = (event) => {
			if (event.key !== "Enter") return;
			const node = /** @type {HTMLElement} */ (event.target)?.closest?.('[role="button"][data-act]');
			if (!node) return;
			event.preventDefault();
			node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		};
		root.addEventListener("keydown", onKeyPress);
		const onKeyDown = (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				doCommit(false);
			}
		};
		msgEl.addEventListener("keydown", onKeyDown);

		// 侧栏拖拽：改宽度 + 存档；双击复位。
		let dragging = false;
		const onDividerDown = (event) => {
			if (!event.target?.closest?.('[data-act="divider"]')) return;
			dragging = true;
			event.preventDefault();
		};
		const onPointerMove = (event) => {
			if (!dragging) return;
			const rect = root.getBoundingClientRect();
			S.sideWidth = clampSidebarWidth(event.clientX - rect.left, rect.width);
			sideEl.style.width = `${S.sideWidth}px`;
		};
		const onPointerUp = () => {
			if (!dragging) return;
			dragging = false;
			saveSidebarWidth(S.sideWidth);
		};
		const onDividerReset = (event) => {
			if (!event.target?.closest?.('[data-act="divider"]')) return;
			S.sideWidth = clampSidebarWidth(SIDEBAR_DEFAULT, root.getBoundingClientRect().width);
			sideEl.style.width = `${S.sideWidth}px`;
			saveSidebarWidth(S.sideWidth);
		};
		root.addEventListener("pointerdown", onDividerDown);
		root.addEventListener("dblclick", onDividerReset);
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);

		// 工作区被切换：整块重来（旧仓库的选中/diff 全部作废）。
		const offData = ctx.onData((payload) => {
			if (destroyed) return;
			if (/** @type {any} */ (payload)?.type === "workspace") {
				S.selected = null;
				S.diff = null;
				S.commitDetail = null;
				S.stashDetail = null;
				S.blame = null;
				S.amend = false;
				S.historyPath = "";
				S.history = [];
				S.historyOpen = false;
				S.historyLoaded = false;
				S.collapsed.clear();
				void refresh();
			}
		});

		// 轮询：视图不可见（被 view-pane.hidden 藏起来）或页面不在前台就跳过。
		let timer = null;
		const tick = () => {
			if (destroyed) return;
			const visible = document.visibilityState !== "hidden" && root.offsetParent !== null;
			if (!visible) return;
			const seconds = S.refreshSeconds > 0 ? S.refreshSeconds : 0;
			if (!seconds) return;
			void refresh();
		};
		const startTimer = () => {
			if (timer) clearInterval(timer);
			const seconds = S.refreshSeconds > 0 ? S.refreshSeconds : 6;
			timer = setInterval(tick, Math.max(2, seconds) * 1000);
		};
		// 从后台标签页回来 / 从别的视图切回来：立即补一次，不等下一个 tick。
		const onVisible = () => {
			if (destroyed) return;
			if (document.visibilityState === "hidden") return;
			if (root.offsetParent === null) return;
			void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);

		void refresh().then(() => {
			if (destroyed) return;
			startTimer();
			if (S.historyOpen) void loadHistory();
		});

		return () => {
			destroyed = true;
			if (timer) clearInterval(timer);
			if (opTimer) clearTimeout(opTimer);
			if (opClock) clearInterval(opClock);
			if (externalRefreshTimer) clearTimeout(externalRefreshTimer);
			if (streamFrame) cancelAnimationFrame(streamFrame);
			// 跨插件桥：只拆自己登记的那份（重载 / 重挂可能已经换了新实例）
			if (/** @type {any} */ (window).__piGitScm === scmBridge) /** @type {any} */ (window).__piGitScm = null;
			document.removeEventListener("visibilitychange", onVisible);
			root.removeEventListener("click", onClick);
			root.removeEventListener("keydown", onKeyPress);
			msgEl.removeEventListener("input", onInput);
			msgEl.removeEventListener("keydown", onKeyDown);
			root.removeEventListener("pointerdown", onDividerDown);
			root.removeEventListener("dblclick", onDividerReset);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			try {
				offData?.();
			} catch {
				/* ignore */
			}
			root.innerHTML = "";
		};
	},
};
