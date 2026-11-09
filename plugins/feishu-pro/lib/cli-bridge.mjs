/**
 * plugins/feishu-pro/lib/cli-bridge.mjs
 * lark-cli 执行器：发现二进制 → 跑命令 → 解析官方 JSON 信封 → 翻译成插件的错误契约。
 *
 * 为什么整个插件改成驱动 lark-cli：凭证（app 注册 / OAuth / 2h 轮换 / 单飞刷新）全由 CLI 负责，
 * 插件不再持有第二套身份；文档读取也直接拿 `docs +fetch --doc-format markdown`，
 * 不用自己拼 docx 块树。
 *
 * 为什么自己 spawn 而不是 host.bash：
 *   1. host.bash 把命令按**空白字符切分**（server/plugins.ts: `split(/\s+/)`）——
 *      `--doc https://…?a=b c` / JSON 参数会被切碎，等于不能用；
 *   2. host.bash 的 cwd 必须落在工作区内，而 CLI 配置可能希望固定在插件目录；
 *   3. 它把输出截断到 256KB，长文档 markdown 会被截掉。
 * 插件内直接用 node:child_process 是既有惯例（desktop-use / imessage / webmail 都这么干）。
 * 安全上我们只执行**探测到的 lark-cli 绝对路径**，参数一律数组传递（不经 shell）。
 *
 * 输出契约（官方 README，别用 code==0 判断）：
 *   成功 → stdout `{ ok: true, identity, data, meta }`，退出码 0
 *   失败 → stderr `{ ok: false, identity, error: { type, subtype, code, message, hint } }`，退出码非 0
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 环境变量优先（部署方可能把 CLI 装在别处）。 */
export const CLI_ENV_VARS = ["PI_WEB_LARK_CLI_BIN", "LARK_CLI_BIN"];
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
/** 单次调用最多收多少输出（长文档 markdown 常上 MB，别用默认的 1MB）。 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 探测 `--version` 的超时：CLI 启动很快，卡住即视为不可用。 */
const PROBE_TIMEOUT_MS = 4_000;

const IS_WIN = process.platform === "win32";
const BIN_NAME = IS_WIN ? "lark-cli.exe" : "lark-cli";
/** 插件自己的目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

/** 解析 `lark-cli version 1.0.99` / `lark-cli v1.0.99`。 */
export function parseCliVersion(text) {
	const m = String(text ?? "").match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
	return m ? m[1] : "";
}

/** 静态候选（不碰文件系统，便于单测）。顺序 = 优先级。 */
export function staticCandidates({ env = {}, home = homedir(), pluginDir = PLUGIN_DIR } = {}) {
	const out = [];
	for (const key of CLI_ENV_VARS) {
		const value = String(env[key] ?? "").trim();
		if (value) out.push({ path: value, source: key.toLowerCase(), label: `环境变量 ${key}` });
	}
	// 插件自带依赖（host.ensureDeps 装到这里）/ 宿主仓库内联 vendor
	out.push({
		path: join(pluginDir, "node_modules", "@larksuite", "cli", "bin", BIN_NAME),
		source: "plugin",
		label: "插件依赖",
	});
	// PATH：execFile 会按 PATH 解析裸命令名
	out.push({ path: "lark-cli", source: "path", label: "PATH" });
	// Trae 插件自带的 lark-cli（企业里常见的既有安装，版本可能略旧）
	out.push({
		path: join(home, ".trae-cn", "plugins", "trae-remote-official", "lark"),
		source: "trae",
		label: "Trae 内置",
	});
	out.push({
		path: join(home, ".trae", "plugins", "trae-remote-official", "lark"),
		source: "trae",
		label: "Trae 内置",
	});
	return out;
}

/** 把「目录型候选」（Trae 版本目录）展开成具体二进制。 */
export function expandTraeCandidates(candidate, { readdir = readdirSync, exists = existsSync } = {}) {
	if (candidate.source !== "trae") return [candidate];
	let versions = [];
	try {
		versions = readdir(candidate.path)
			.filter((name) => /^\d+\.\d+\.\d+/.test(name))
			.sort((a, b) => compareVersions(b, a)); // 高版本优先
	} catch {
		return [];
	}
	const out = [];
	for (const version of versions) {
		const bin = join(candidate.path, version, "bin", BIN_NAME);
		if (exists(bin)) out.push({ path: bin, source: "trae", label: `Trae ${version}` });
	}
	return out;
}

/** npx 缓存里的 `@larksuite/cli`（`npx -y @larksuite/cli@latest …` 留下的那份）。 */
export function npxCandidates({ home = homedir(), readdir = readdirSync, exists = existsSync } = {}) {
	const root = join(home, ".npm", "_npx");
	let dirs = [];
	try {
		dirs = readdir(root);
	} catch {
		return [];
	}
	const out = [];
	for (const dir of dirs) {
		const bin = join(root, dir, "node_modules", "@larksuite", "cli", "bin", BIN_NAME);
		if (exists(bin)) out.push({ path: bin, source: "npx", label: "npx 缓存" });
	}
	return out;
}

/** 版本比较（只处理 semver 数字段，够用）。 */
export function compareVersions(a, b) {
	const pa = String(a)
		.split(/[.-]/)
		.map((x) => Number.parseInt(x, 10) || 0);
	const pb = String(b)
		.split(/[.-]/)
		.map((x) => Number.parseInt(x, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/** 汇总所有候选（去重，保持优先级）。 */
export function collectCandidates(opts = {}) {
	const { readdir = readdirSync, exists = existsSync } = opts;
	// 环境变量是部署方最常用的覆盖点：不显式传 env 时读真实 process.env
	// （staticCandidates 本身保持纯函数，默认 env 为空对象，便于单测）。
	const env = opts.env ?? process.env;
	const seen = new Set();
	const out = [];
	const push = (item) => {
		if (!item?.path || seen.has(item.path)) return;
		seen.add(item.path);
		out.push(item);
	};
	for (const candidate of staticCandidates({ ...opts, env })) {
		if (candidate.source === "trae") {
			for (const expanded of expandTraeCandidates(candidate, { readdir, exists })) push(expanded);
			continue;
		}
		push(candidate);
	}
	for (const item of npxCandidates({ home: opts.home, readdir, exists })) push(item);
	return out;
}

/** 跑 `<bin> --version` 判断这个候选到底能不能用。 */
export function probeBin(bin, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		try {
			execFile(
				bin,
				["--version"],
				{ timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
				(err, stdout, stderr) => {
					if (err) {
						resolve({ ok: false, error: String(err?.message || err).slice(0, 200) });
						return;
					}
					const version = parseCliVersion(`${stdout}${stderr}`);
					resolve(version ? { ok: true, version } : { ok: false, error: "无法解析版本号" });
				},
			);
		} catch (err) {
			resolve({ ok: false, error: String(err?.message || err).slice(0, 200) });
		}
	});
}

/**
 * 依次探测候选，返回第一个可用的。
 * @returns {Promise<{ok:boolean, bin:string, version:string, source:string, candidates:object[], error?:string}>}
 */
export async function discoverCli(opts = {}) {
	const candidates = collectCandidates(opts);
	const checked = [];
	for (const candidate of candidates) {
		const probed = await (opts.probe ?? probeBin)(candidate.path);
		checked.push({ ...candidate, ok: Boolean(probed.ok), version: probed.version ?? "", error: probed.error ?? "" });
		if (probed.ok) {
			return { ok: true, bin: candidate.path, version: probed.version, source: candidate.source, candidates: checked };
		}
	}
	return {
		ok: false,
		bin: "",
		version: "",
		source: "",
		candidates: checked,
		error: candidates.length ? "找到候选但都无法执行（检查文件权限/架构）" : "未找到 lark-cli",
	};
}

/* ------------------------------- 执行与解析 ------------------------------- */

/** 官方信封解析（纯函数，单测重点）。 */
export function parseCliEnvelope({ stdout = "", stderr = "", exitCode = 0 } = {}) {
	const ok = parseJson(stdout);
	// 有的命令（`auth list --json`）直接吐顶层数组，没有 ok 信封：也算成功，data 就是数组本身。
	if (Array.isArray(ok)) {
		return { ok: true, identity: "", data: ok, meta: null, payload: { users: ok }, text: "" };
	}
	if (ok && ok.ok === true) {
		return {
			ok: true,
			identity: String(ok.identity ?? ""),
			data: ok.data ?? null,
			meta: ok.meta ?? null,
			payload: ok,
			text: "",
		};
	}
	if (ok && ok.ok === false) {
		return { ok: false, error: normalizeCliError(ok.error, exitCode), text: "" };
	}
	const bad = parseJson(stderr);
	if (bad && bad.ok === false) {
		return { ok: false, error: normalizeCliError(bad.error, exitCode), text: "" };
	}
	// 非 JSON：help 输出、被信号杀掉、或网关返回纯文本
	const text = String(stdout || stderr || "").trim();
	if (exitCode === 0 && text) return { ok: true, identity: "", data: null, meta: null, payload: null, text };
	return {
		ok: false,
		error: normalizeCliError(null, exitCode, text),
		text,
	};
}

function parseJson(text) {
	const raw = String(text ?? "").trim();
	if (!raw.startsWith("{") && !raw.startsWith("[")) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function normalizeCliError(error, exitCode, text = "") {
	const type = String(error?.type ?? "");
	const subtype = String(error?.subtype ?? "");
	const code = error?.code ?? null;
	const message = String(error?.message ?? text ?? "").trim() || `lark-cli 退出码 ${exitCode}`;
	return {
		type,
		subtype,
		code,
		message,
		hint: String(error?.hint ?? ""),
		exitCode: Number(exitCode) || 0,
	};
}

/** 需要用户动手的 CLI 错误（装/配置/登录），前端据此给按钮而不是红字。 */
export function cliActionFor(error) {
	const type = String(error?.type ?? "");
	const subtype = String(error?.subtype ?? "");
	const text = `${subtype} ${error?.message ?? ""}`.toLowerCase();
	if (type === "config" || text.includes("not_configured") || text.includes("not configured")) return "config";
	if (type === "auth" || text.includes("unauthorized") || text.includes("not logged in") || text.includes("token")) {
		return "login";
	}
	return "";
}

/** 插件统一错误对象（与 openapi.mjs 的 FeishuApiError 同形状，前端不用改）。 */
export class CliError extends Error {
	constructor(message, { type, subtype, code, hint, exitCode, argv, action } = {}) {
		super(message);
		this.name = "CliError";
		this.type = type;
		this.subtype = subtype;
		this.code = code;
		this.hint = hint;
		this.exitCode = exitCode;
		this.argv = argv;
		this.cliAction = action;
		this.needUser = action === "login";
	}
}

/** 错误 → 路由层载荷（沿用 `{ok:false,error,code,needUser}` + `cli` 补充字段）。 */
export function toCliErrorPayload(err) {
	if (err instanceof CliError) {
		return {
			ok: false,
			error: err.message,
			code: err.code ?? null,
			needUser: Boolean(err.needUser),
			cli: { type: err.type ?? "", subtype: err.subtype ?? "", hint: err.hint ?? "", action: err.cliAction ?? "" },
		};
	}
	return { ok: false, error: String(err?.message || err), code: err?.code ?? null, needUser: false };
}

/**
 * 跑一条 lark-cli 命令。
 * @param {string[]} args 不含二进制名；全部数组传递，绝不拼 shell
 * @param {{bin:string, cwd?:string, timeoutMs?:number, env?:object, maxBuffer?:number}} opts
 */
export async function runCli(args, opts = {}) {
	const bin = String(opts.bin ?? "").trim();
	if (!bin)
		throw new CliError("未找到 lark-cli 可执行文件", { type: "setup", subtype: "missing_cli", action: "install" });
	const argv = (Array.isArray(args) ? args : []).map((x) => String(x));
	for (const arg of argv) {
		if (arg.includes("\0")) throw new CliError("命令参数含非法字符（NUL）", { type: "setup", subtype: "bad_arg" });
	}
	const timeoutMs = Math.max(
		1_000,
		Math.min(Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
	);
	const cwd = opts.cwd ?? process.cwd();
	const env = { ...process.env, ...(opts.env ?? {}), LARK_CLI_NO_COLOR: "1", NO_COLOR: "1" };

	const result = await new Promise((resolve) => {
		try {
			execFile(
				bin,
				argv,
				{
					cwd,
					env,
					timeout: timeoutMs,
					windowsHide: true,
					encoding: "utf8",
					maxBuffer: opts.maxBuffer ?? MAX_OUTPUT_BYTES,
				},
				(err, stdout, stderr) => {
					const exitCode = err ? Number(err.code ?? 1) || 1 : 0;
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode, error: err });
				},
			);
		} catch (err) {
			resolve({ stdout: "", stderr: String(err?.message || err), exitCode: 1, error: err });
		}
	});

	if (result.error && result.error.killed) {
		throw new CliError(`lark-cli 超时（${timeoutMs}ms）`, { type: "network", subtype: "timeout", action: "" });
	}
	const parsed = parseCliEnvelope({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
	if (parsed.ok) return { ...parsed, argv, exitCode: result.exitCode };

	const error = parsed.error;
	throw new CliError(error.message, {
		type: error.type,
		subtype: error.subtype,
		code: error.code,
		hint: error.hint,
		exitCode: error.exitCode,
		argv,
		action: cliActionFor(error),
	});
}

/**
 * 启动会阻塞的交互命令（`config init --new` / `auth login`），边跑边抓验证链接。
 * 返回的 `firstUrl` 会在抓到第一个 http(s) 链接时 resolve；`done` 是进程退出结果。
 * 调用方拿到 URL 就能立刻返回前端，不必等进程结束。
 */
export function startInteractive(args, opts = {}) {
	const bin = String(opts.bin ?? "").trim();
	if (!bin)
		throw new CliError("未找到 lark-cli 可执行文件", { type: "setup", subtype: "missing_cli", action: "install" });
	const argv = (Array.isArray(args) ? args : []).map((x) => String(x));
	const timeoutMs = Math.max(5_000, Math.min(Number(opts.timeoutMs ?? 180_000) || 180_000, MAX_TIMEOUT_MS));
	const env = { ...process.env, ...(opts.env ?? {}), LARK_CLI_NO_COLOR: "1", NO_COLOR: "1" };
	const child = spawn(bin, argv, {
		cwd: opts.cwd ?? process.cwd(),
		env,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let buffer = "";
	let resolveUrl;
	const firstUrl = new Promise((resolve) => {
		resolveUrl = resolve;
	});
	// 任何情况下都别让 firstUrl 永远悬着
	const urlTimer = setTimeout(() => resolveUrl(""), Math.min(timeoutMs, 30_000));

	const onData = (chunk) => {
		const text = String(chunk ?? "");
		buffer = (buffer + text).slice(-64 * 1024);
		const url = extractVerificationUrl(text) || extractVerificationUrl(buffer);
		if (url) resolveUrl(url);
		opts.onOutput?.(text);
	};
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	const done = new Promise((resolve) => {
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* 已退出 */
			}
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: 1, output: String(err?.message || err), timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(urlTimer);
			resolveUrl("");
			resolve({ code: Number(code ?? 0), output: buffer, timedOut: false });
		});
	});

	return {
		child,
		firstUrl,
		done,
		output: () => buffer,
		kill() {
			try {
				child.kill("SIGTERM");
			} catch {
				/* 已退出 */
			}
		},
	};
}

/** 从 CLI 输出里挑出授权链接（设备码流会混着提示文字与二维码）。 */
export function extractVerificationUrl(text) {
	const urls = String(text ?? "").match(/https?:\/\/[^\s"'<>）)]+/g) ?? [];
	if (!urls.length) return "";
	// 优先设备码/授权页，其次任意链接
	const preferred = urls.find((url) =>
		/verification|device|oauth|authorize|accounts|open\.feishu|open\.larksuite/i.test(url),
	);
	return preferred ?? urls[0];
}

/* ------------------------------- 便捷封装 ------------------------------- */

/** 绑定 bin/cwd 的执行上下文，路由层只传业务参数。 */
export function createCliRunner({ getBin, cwd, timeoutMs } = {}) {
	const resolveBin = async () => {
		if (typeof getBin === "function") {
			const bin = String((await getBin()) ?? "").trim();
			if (!bin) throw new CliError("lark-cli 不可用", { type: "setup", subtype: "missing_cli", action: "install" });
			return bin;
		}
		return String(getBin ?? "").trim();
	};
	return {
		async run(args, opts = {}) {
			const bin = await resolveBin();
			return runCli(args, { bin, cwd: opts.cwd ?? cwd, timeoutMs: opts.timeoutMs ?? timeoutMs, env: opts.env });
		},
		async runJson(args, opts = {}) {
			const out = await this.run(args, opts);
			return out.data;
		},
		async interactive(args, opts = {}) {
			const bin = await resolveBin();
			return startInteractive(args, { bin, cwd: opts.cwd ?? cwd, timeoutMs: opts.timeoutMs, onOutput: opts.onOutput });
		},
	};
}

/** 供测试用：判断某路径是否可执行文件。 */
export function isExecutableFile(path) {
	try {
		const st = statSync(path);
		return st.isFile();
	} catch {
		return false;
	}
}
