/**
 * plugins/feishu-pro/lib/cli-status.mjs
 * lark-cli 状态与生命周期：装了没 / 配了没 / 登录了没 / 下一步该干嘛。
 *
 * 设计原则：插件不再自建"连接应用 + 个人授权"两套流程，而是把 CLI 的四个真实状态
 * 原样报给界面，并给出**一条**可执行动作（装 / 配置 / 登录 / 就绪）。
 * 状态的判定全部基于 CLI 自己的命令输出，不猜：
 *   - `--version`      → 装了没
 *   - `whoami`         → 配置 + 登录（未配置时是 {ok:false,error.type:"config"}）
 *   - `auth list`      → 已登录用户（未配置时返回 {ok:true, reason:"not_configured", users:[]}）
 */

import { CliError } from "./cli-bridge.mjs";

/** 安装/升级命令（界面直接展示给用户复制）。 */
export const INSTALL_COMMAND = "npx @larksuite/cli@latest install";
export const CONFIG_COMMAND = "lark-cli config init --new";
export const LOGIN_COMMAND = "lark-cli auth login --recommend --no-wait";

/** 状态缓存：/state 每次刷新都探一次太贵（每个候选一次 execFile）。 */
const CACHE_TTL_MS = 20_000;

/**
 * 汇总状态。依赖注入便于单测：
 *   discover() → discoverCli 的结果
 *   run(args)  → 已绑定 bin 的 runCli
 */
export async function readCliStatus({ discover, run, now = () => Date.now() } = {}) {
	const discovery = await discover();
	if (!discovery?.ok) {
		return {
			installed: false,
			bin: "",
			version: "",
			source: "",
			configured: false,
			loggedIn: false,
			users: [],
			identity: "",
			action: "install",
			installCommand: INSTALL_COMMAND,
			candidates: (discovery?.candidates ?? []).map(publicCandidate),
			error: discovery?.error ?? "未找到 lark-cli",
			checkedAt: now(),
		};
	}

	let whoami = null;
	let whoamiError = null;
	try {
		const out = await run(["whoami"], { timeoutMs: 15_000 });
		whoami = out?.payload ?? out?.data ?? null;
	} catch (err) {
		whoamiError = err instanceof CliError ? { ...err, message: err.message } : { message: String(err?.message || err) };
	}

	let authList = null;
	let authError = null;
	try {
		const out = await run(["auth", "list", "--json"], { timeoutMs: 15_000 });
		authList = out?.payload ?? out?.data ?? null;
	} catch (err) {
		authError = String(err?.message || err);
	}

	const users = normalizeUsers(authList);
	const reason = String(authList?.reason ?? "").trim();
	const configured = !whoamiError && !reason.includes("not_configured");
	const loggedIn = configured && users.length > 0;
	// whoami 在 `defaultAs=auto` 时对未登录状态会报 bot；只要有用户，身份就是 user。
	const identity = loggedIn ? "user" : String(whoami?.identity ?? whoami?.data?.identity ?? "").trim();

	return {
		installed: true,
		bin: discovery.bin,
		version: discovery.version,
		source: discovery.source,
		configured,
		loggedIn,
		users,
		identity,
		action: !configured ? "config" : !loggedIn ? "login" : "",
		app: configured ? pickApp(whoami) : null,
		configCommand: CONFIG_COMMAND,
		loginCommand: LOGIN_COMMAND,
		installCommand: INSTALL_COMMAND,
		error: whoamiError ? String(whoamiError.message ?? whoamiError) : authError ? String(authError) : "",
		errorAction: whoamiError?.cliAction ?? "",
		candidates: (discovery.candidates ?? []).map(publicCandidate),
		checkedAt: now(),
	};
}

/** `auth list` 的用户条目归一化（字段口径按 CLI 输出，多候选兜底）。 */
export function normalizeUsers(authList) {
	const raw = Array.isArray(authList?.users)
		? authList.users
		: Array.isArray(authList?.items)
			? authList.items
			: Array.isArray(authList)
				? authList
				: [];
	return raw
		.filter((user) => user && typeof user === "object")
		.map((user) => ({
			// 实测 `auth list --json` 给的是 camelCase：{ userName, userOpenId, tokenStatus, appId }
			openId: String(user.open_id ?? user.openId ?? user.userOpenId ?? user.user_id ?? ""),
			name: String(user.name ?? user.user_name ?? user.userName ?? user.en_name ?? ""),
			email: String(user.email ?? user.enterprise_email ?? ""),
			avatar: String(user.avatar_url ?? user.avatar ?? ""),
			active: user.active !== false && user.is_active !== false,
			identity: String(user.identity ?? user.type ?? ""),
			tokenExpireAt: Number(user.expire_time ?? user.expires_at ?? 0) || 0,
		}));
}

function pickApp(whoami) {
	const app = whoami?.app ?? whoami?.data?.app ?? null;
	if (!app) return null;
	return {
		appId: String(app.app_id ?? app.appId ?? ""),
		name: String(app.name ?? app.app_name ?? ""),
		brand: String(app.brand ?? whoami?.brand ?? ""),
	};
}

/** 候选列表对外只暴露必要字段（完整路径给界面排查用，不含 token）。 */
function publicCandidate(item) {
	return {
		path: String(item?.path ?? ""),
		source: String(item?.source ?? ""),
		label: String(item?.label ?? ""),
		ok: Boolean(item?.ok),
		version: String(item?.version ?? ""),
		error: String(item?.error ?? ""),
	};
}

/** 带 TTL 的状态缓存（discovery 探测贵，whoami 便宜但也会起进程）。 */
export function createStatusCache({ ttlMs = CACHE_TTL_MS, now = () => Date.now() } = {}) {
	let cached = null;
	let inflight = null;
	return {
		async get(load) {
			if (cached && now() - cached.at < ttlMs) return cached.value;
			if (inflight) return inflight;
			inflight = Promise.resolve()
				.then(load)
				.then((value) => {
					cached = { at: now(), value };
					return value;
				})
				.finally(() => {
					inflight = null;
				});
			return inflight;
		},
		invalid() {
			cached = null;
		},
	};
}

/**
 * 启动配置/登录流程：CLI 会阻塞等浏览器，我们只抓第一条验证链接立刻回前端，
 * 剩下的（用户点完授权）由前端轮询 `/cli/status` 确认。
 */
export async function startCliSetup({ interactive, step = "config" }) {
	const args =
		step === "config" ? ["config", "init", "--new"] : ["auth", "login", "--recommend", "--no-wait", "--json"];
	const session = await interactive(args, { timeoutMs: step === "config" ? 180_000 : 60_000 });
	const url = await Promise.race([session.firstUrl, new Promise((resolve) => setTimeout(() => resolve(""), 25_000))]);
	// `--no-wait` 是立即返回的：它自己会打印 JSON（含验证 URL），此时进程已退出。
	const finished = await Promise.race([session.done, new Promise((resolve) => setTimeout(() => resolve(null), 0))]);
	return {
		step,
		url: url || extractFromOutput(finished?.output ?? session.output?.() ?? ""),
		live: !finished,
		session,
		finished,
	};
}

function extractFromOutput(output) {
	const m = String(output ?? "").match(/https?:\/\/[^\s"'<>）)]+/);
	return m ? m[0] : "";
}

/** 从 `auth login --no-wait --json` 的 JSON 输出里取设备码 / 链接（该命令会立即退出）。 */
export function parseLoginStart(output) {
	const raw = typeof output === "string" ? output : String(output?.output ?? output?.text ?? "");
	let payload = null;
	try {
		payload = JSON.parse(raw.trim());
	} catch {
		/* 非 JSON（老版本/交互式输出）：退回正则 */
	}
	const data = payload?.data ?? payload ?? {};
	return {
		url: String(data.verification_url ?? data.verification_uri ?? data.url ?? extractFromOutput(raw)),
		userCode: String(data.user_code ?? data.code ?? ""),
		deviceCode: String(data.device_code ?? ""),
		expiresIn: Number(data.expires_in ?? 0) || 0,
		interval: Number(data.interval ?? 5) || 5,
	};
}
