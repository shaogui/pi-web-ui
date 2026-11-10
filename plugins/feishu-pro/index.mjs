/**
 * plugins/feishu-pro/index.mjs
 * 飞书通讯录 + 云文档工作台（服务端入口）。
 *
 * 与 plugins/feishu（原插件）的关系：**完全独立**。插件 id 不同 → 数据目录、secrets
 * 命名空间、视图、AI 工具全都不重叠，两个插件可以同时安装、同时启用，互不覆盖。
 * 原插件继续负责群聊/消息/机器人；本插件只做"读组织与人"和"读云文档"。
 *
 * 身份模型（0.10.0 起唯一）：
 *   全部能力都通过官方 `lark-cli` 执行（`--as user|bot`）。应用注册、OAuth、token 续期这些
 *   自建凭证链已经删除 —— 插件不再持有任何 App Secret / access_token。
 * CLI 不可用时直接把「装 / 配 / 登录」的可执行动作抛给界面，不做静默回落。
 */

import { PLUGIN_ID, normalizeConfig } from "./lib/config.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	RECENT_LIMIT,
	clearRecentStore,
	listOwnerKeys,
	normalizeRecentStore,
	ownerKeyFrom,
	readRecent,
	readStoreItems,
	recentEntryFrom,
	recentKey,
	upsertRecent,
	writeRecentStore,
} from "./lib/recent.mjs";
/**
 * 高频迭代的两个子模块带**版本查询串**静态引入（缓存穿透手法，真机踩过）：
 * 宿主 `server/plugins.ts` 只给 `index.mjs` 追加 `?e=<epoch>` 破缓存，`lib/*.mjs` 是普通
 * URL —— Node 对同一 URL 的 `import()` 永久返回缓存副本，于是"改了 lib/、点了插件重新
 * 加载、行为没变"，只有重启整个服务才生效。
 *
 * 约定：**改这两个文件必须把下面的 `?v=` 与 manifest.version 一起 bump**
 * （`tests/unit/feishu-pro-core.test.ts` 有一条断言钉住二者一致）。
 */
import { createDmWatcher, isValidChatId, parseChatIds } from "./lib/dm-watch.mjs?v=0.14.1";
import {
	CHAT_INFO_KEY,
	chatCounts,
	chatSections,
	chatLink,
	decorateMessageRow,
	inferChatMode,
	mergeChatInfo,
	mergeChatSources,
	MESSAGE_TEXT_LIMIT,
	normalizeSendIdentity,
	isValidOpenId,
	pickPeerFromMessages,
} from "./lib/chats.mjs?v=0.14.1";
import { normalizeOrderBy, toMs } from "./lib/docs.mjs";
// AI 待办：本地库（纯函数）+ 服务层 + 飞书任务适配（lark-cli `api` 兜底）。
import { createTodoService } from "./lib/todo-service.mjs?v=0.17.0";
import {
	createTask as createTaskViaCli,
	listMyTasks as listMyTasksViaCli,
	setTaskDone as setTaskDoneViaCli,
	updateTask as updateTaskViaCli,
} from "./lib/cli-tasks.mjs?v=0.14.1";
import { TODO_ADVICE_LIMIT } from "./lib/todo-store.mjs?v=0.17.0";
// lark-cli 通道：重构后的主路径（凭证与接口都交给官方 CLI；不可用时各能力回落上面的 OpenAPI 实现）。
import { CliError, createCliRunner, discoverCli, toCliErrorPayload } from "./lib/cli-bridge.mjs";
import {
	CONFIG_COMMAND,
	INSTALL_COMMAND,
	LOGIN_COMMAND,
	createStatusCache,
	parseLoginStart,
	readCliStatus,
} from "./lib/cli-status.mjs";
import {
	fetchDoc as fetchDocViaCli,
	listDriveFiles as listDriveFilesViaCli,
	listWikiNodes as listWikiNodesViaCli,
	listWikiSpaces as listWikiSpacesViaCli,
	markdownToPlain,
	searchDocs as searchDocsViaCli,
} from "./lib/cli-docs.mjs";
import {
	getUser as getUserViaCli,
	getUsersByIds as getUsersByIdsViaCli,
	listDepartmentUsers as listDepartmentUsersViaCli,
	listDepartments as listDepartmentsViaCli,
	searchUsers as searchUsersViaCli,
} from "./lib/cli-contacts.mjs";
import { createDmCliChannel } from "./lib/cli-chats.mjs?v=0.14.1";
// 会话消息的本地缓存：后台轮询 / 界面拉取 / AI 读消息共用一个落点，打开会话直接读缓存。
import { CHAT_SEARCH_LIMIT, createChatCacheStore } from "./lib/chat-cache.mjs?v=0.14.1";
import {
	AUTO_CONFIG_KEY,
	AUTO_DEFAULT_CONFIG,
	createAutoReplier,
	matchAutoReply,
	normalizeAutoConfig,
} from "./lib/auto-reply.mjs?v=0.18.1";
// 会话页按需「让 AI 代写回复」：预览 / 直发共用同一个生成引擎。
import { createChatAiReplier, splitReplyText } from "./lib/chat-ai.mjs?v=0.18.1";
import {
	fetchChatInfo as fetchChatInfoViaCli,
	fetchChatMessages as fetchChatMessagesViaCli,
	fetchChats as fetchChatsViaCli,
	fetchUserNames as fetchUserNamesViaCli,
	resolveP2pChatId as resolveP2pChatIdViaCli,
	sendText as sendTextViaCli,
} from "./lib/cli-chats.mjs?v=0.14.1";

// 纯函数对外暴露（单测直接 import 这些，不必起插件）。
export { DEFAULT_CONFIG, normalizeConfig, buildDocUrl } from "./lib/config.mjs";
export { normalizeUser, normalizeDepartment } from "./lib/contacts.mjs";
export { normalizeDoc, typeLabel, DOC_TYPES } from "./lib/docs.mjs";
// lark-cli 重构：纯函数导出，单测直接 import 这些。
export {
	CliError,
	cliActionFor,
	collectCandidates,
	compareVersions,
	discoverCli,
	extractVerificationUrl,
	parseCliEnvelope,
	parseCliVersion,
	staticCandidates,
	toCliErrorPayload,
} from "./lib/cli-bridge.mjs";
export {
	markdownToPlain as markdownToPlainCli,
	normalizeCliDoc,
	parseFetchPayload,
	pickItems,
	titleFromMarkdown,
} from "./lib/cli-docs.mjs";
export {
	CONFIG_COMMAND,
	INSTALL_COMMAND,
	LOGIN_COMMAND,
	createStatusCache,
	normalizeUsers,
	parseLoginStart,
	readCliStatus,
} from "./lib/cli-status.mjs";
export { normalizeCliUser as normalizeCliUserShape, pickUsers } from "./lib/cli-contacts.mjs";
export { pickChats, pickPeerFromRows } from "./lib/cli-chats.mjs";
export { isValidOpenId, normalizeSendIdentity } from "./lib/chats.mjs?v=0.14.1";
// AI 待办：纯函数导出（单测直接 import，不必起插件）。
export {
	ACTION_KINDS,
	TODO_ADVICE_LIMIT,
	TODO_LIMIT,
	TODO_STATUSES,
	applyTodoPatch,
	isAdviceFresh,
	mergeFeishuTasks,
	normalizeAdvice,
	normalizeStore as normalizeTodoStore,
	normalizeTodo,
	pickAdviceTargets,
	todoFromFeishuTask,
	todoKeyOf,
	todoStats,
	upsertTodo,
} from "./lib/todo-store.mjs?v=0.17.0";
export {
	buildAdvicePrompt,
	buildAgentTask,
	buildExtractPrompt,
	extractJson,
	parseAdviceReply,
	parseExtractReply,
} from "./lib/todo-ai.mjs?v=0.14.1";
export { listMyTasks as listMyTasksShape, normalizeCliTask } from "./lib/cli-tasks.mjs?v=0.14.1";
// 会话页 AI 回复：纯函数（提示词 / 清洗 / 分片）单测直接 import，不必起插件。
export { buildReplyPrompt, chatAiAccountId, cleanAiReply, splitReplyText } from "./lib/chat-ai.mjs?v=0.18.1";
export {
	ANON_OWNER,
	RECENT_LIMIT,
	RECENT_STORE_VERSION,
	clearRecentStore,
	emptyRecentStore,
	listOwnerKeys,
	normalizeRecentStore,
	ownerKeyFrom,
	readRecent,
	readStoreItems,
	recentEntryFrom,
	recentKey,
	sortRecent,
	upsertRecent,
	writeRecentStore,
} from "./lib/recent.mjs";
export { toMs, normalizeOrderBy, DRIVE_ORDER_BY } from "./lib/docs.mjs";

/**
 * 按文件头嗅探图片类型：CLI 下载的文件名后缀不一定可靠，回正确的 Content-Type
 * 才能让 <img> 显示（返回 octet-stream 时浏览器会当附件下载）。
 */
function sniffMediaType(buf) {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
	if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
		return "image/webp";
	return "application/octet-stream";
}

const CONFIG_KEY = "config";
const RECENT_KEY = "recentDocs";

/** 统一 JSON 响应（错误也用 200 + ok:false，前端只判 ok，不区分状态码）。 */
function sendJson(res, payload, status = 200) {
	try {
		res.statusCode = status;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.end(JSON.stringify(payload));
	} catch {
		try {
			res.end();
		} catch {
			/* 连接已断开 */
		}
	}
}

function sendOk(res, data = {}) {
	sendJson(res, { ok: true, ...data });
}

/**
 * 普通错误 → 统一载荷（与 `CliError` 的字段对齐：前端只判 `ok` / 读 `error`）。
 * 注意：这里**不能**再抛异常 —— 它在路由的 catch 里，抛出去就是「客户端一直等不到响应」。
 */
function toErrorPayload(err) {
	const message = String(err?.message || err || "请求失败");
	return { ok: false, error: message, code: err?.code ?? null, needUser: Boolean(err?.needUser) };
}

function sendFail(res, err) {
	// CLI 错误带「下一步该干什么」（装/配置/登录），不能被当成普通 500 抹平。
	try {
		if (err instanceof CliError) {
			sendJson(res, toCliErrorPayload(err));
			return;
		}
		sendJson(res, toErrorPayload(err));
	} catch {
		// 兜底：连接已断开 / 头已发送时保持静默（不制造二次崩溃）。
		try {
			res.end();
		} catch {
			/* ignore */
		}
	}
}

function queryOf(req) {
	const q = req?.query;
	return q && typeof q === "object" ? q : {};
}

function bodyOf(req) {
	const b = req?.body;
	if (b && typeof b === "object") return b;
	if (typeof b === "string" && b.trim()) {
		try {
			return JSON.parse(b);
		} catch {
			return {};
		}
	}
	return {};
}

function firstParam(value) {
	if (Array.isArray(value)) return value[0] === undefined ? "" : String(value[0]);
	return value === undefined || value === null ? "" : String(value);
}

export default {
	async activate(host) {
		const disposers = [];
		const log = (level, text) => host.log?.(level, text);

		// 插件本地只留展示项（平台预设 / 文档域名）；凭证与应用注册全在 lark-cli 里。
		let config = normalizeConfig(await host.storage?.get?.(CONFIG_KEY), {});
		/** 给 docHost / 文档链接用的轻量配置视图。 */
		const runtime = () => config;

		/* ----------------------------- lark-cli（主路径） ----------------------------- */
		//
		// app 注册 / OAuth / token 续期 / 接口调用全部交给官方 lark-cli，
		// 插件只负责「发现二进制 → 跑命令 → 渲染结果」。CLI 不可用（未装 / 未配置 / 未登录）
		// 就是不可用：没有第二条通道可回落（自建 OpenAPI 已随凭证链删除）。
		//
		// 为什么自己 spawn 而不是 host.bash：后者把命令按空白切分（参数里的 JSON/URL 会碎）、
		// cwd 跟死工作区、输出截断 256KB —— 详见 lib/cli-bridge.mjs 文件头。

		const CLI_DISCOVERY_TTL_MS = 60_000;
		let cliDiscovery = null;
		let cliDiscoveryAt = 0;
		/** 进行中的安装/配置/登录会话（config init 会阻塞，抓到验证链接就先回前端）。 */
		let cliSetup = null;

		async function loadCliDiscovery(force = false) {
			// 部署/测试开关：显式关掉 CLI 通道（模拟「没装 lark-cli」），不必真卸载它。
			// 注意：已无 OpenAPI 回落通道，打开后所有能力都会按 CLI 不可用报错。
			if (String(process.env.PI_WEB_LARK_CLI_DISABLE ?? "") === "1") {
				cliDiscovery = {
					ok: false,
					bin: "",
					version: "",
					source: "",
					candidates: [],
					error: "PI_WEB_LARK_CLI_DISABLE=1",
				};
				cliDiscoveryAt = Date.now();
				return cliDiscovery;
			}
			if (!force && cliDiscovery && Date.now() - cliDiscoveryAt < CLI_DISCOVERY_TTL_MS) return cliDiscovery;
			cliDiscovery = await discoverCli();
			cliDiscoveryAt = Date.now();
			if (cliDiscovery.ok) log("info", `feishu-pro: lark-cli ${cliDiscovery.version}（${cliDiscovery.source}）`);
			return cliDiscovery;
		}

		const cliRunner = createCliRunner({ getBin: async () => (await loadCliDiscovery()).bin || "" });
		const cliStatusCache = createStatusCache({ ttlMs: 15_000 });
		const cliStatus = () =>
			cliStatusCache.get(() =>
				readCliStatus({
					discover: () => loadCliDiscovery(true),
					run: (args, opts) => cliRunner.run(args, opts),
				}),
			);

		/** CLI 不可用时给出可执行错误（而不是一句「请求失败」）。 */
		async function cliSetupError() {
			const status = await cliStatus().catch(() => null);
			// 下一步做什么由 CLI 真实状态决定：没装 → install，没配 → config，没登录 → login。
			const action = !status?.installed
				? "install"
				: !status?.configured
					? "config"
					: !status?.loggedIn
						? "login"
						: "config";
			const what =
				action === "install"
					? "没找到 lark-cli：到「设置 → lark-cli 与身份」点第 1 步的「复制安装命令」，装完点「重新检测」"
					: action === "config"
						? "lark-cli 还没配置应用：到「设置 → lark-cli 与身份」点第 2 步的「配置应用」（浏览器里走官方设备码）"
						: "lark-cli 还没登录个人账号：到「设置 → lark-cli 与身份」点第 3 步的「登录账号」";
			return new CliError(what, {
				type: "setup",
				subtype: "cli_not_ready",
				action,
				hint: "所有能力只走 lark-cli：先装 CLI / 配置应用 / 登录账号（无 OpenAPI 回落）",
			});
		}

		/** CLI 已就绪（装了且登录了）时返回状态，否则 null。 */
		async function cliReady() {
			const status = await cliStatus().catch(() => null);
			return status?.installed && status.loggedIn ? status : null;
		}

		/**
		 * 唯一的取数入口：只走 lark-cli。
		 * 自建 OpenAPI 通道已随凭证链一起下线 —— CLI 不可用就是不可用，
		 * 报错里带「装 / 配 / 登录」的可执行动作，而不是偷偷换一条没人维护的通道。
		 */
		async function viaCli(label, cliCall) {
			if (!(await cliReady())) throw await cliSetupError();
			try {
				return { ...(await cliCall((args, opts) => cliRunner.run(args, opts))), via: "lark-cli" };
			} catch (err) {
				log("warn", `feishu-pro: lark-cli ${label} 失败：${String(err?.message || err)}`);
				throw err;
			}
		}

		/** 启动 `config init --new`（阻塞式）：抓到验证链接就回前端，进程继续在后台等。 */
		async function startCliConfig() {
			const discovery = await loadCliDiscovery();
			if (!discovery.ok)
				throw new CliError("未找到 lark-cli 可执行文件", { type: "setup", subtype: "missing_cli", action: "install" });
			// interactive() 是 async 的：不 await 拿到的是 Promise，`session.done` 会直接炸。
			const session = await cliRunner.interactive(["config", "init", "--new"], { timeoutMs: 180_000 });
			const url = await Promise.race([
				session.firstUrl,
				new Promise((resolve) => setTimeout(() => resolve(""), 20_000)),
			]);
			cliSetup = { step: "config", url, startedAt: Date.now(), session };
			void Promise.resolve(session.done)
				.then(() => {
					cliStatusCache.invalid();
					cliDiscovery = null;
				})
				.catch(() => {});
			// 抓不到链接时把 CLI 已经吐出的内容带回去：用户和我们都能看出它卡在哪（权限/交互/网络）。
			const transcript = url
				? ""
				: String(session.output?.() ?? "")
						.trim()
						.slice(-600);
			return {
				step: "config",
				url,
				running: Boolean(url),
				command: CONFIG_COMMAND,
				transcript,
				hint: url
					? "已在后台启动 lark-cli config init：请在浏览器里完成应用配置，完成后点「重新检测」"
					: transcript
						? "lark-cli 没有返回验证链接，下面是它的原始输出（可据此判断是缺交互还是网络问题）"
						: "没抓到验证链接：请在服务器终端执行 lark-cli config init --new，完成后点「重新检测」",
			};
		}

		/** 启动设备码登录（`--no-wait` 立即返回验证链接 + 设备码）。 */
		/**
		 * 登录：用**阻塞版** auth login（不是 --no-wait）。
		 * --no-wait 只发起设备码，必须再跑 `--device-code` 才真正换到 user token ——
		 * 少了那一步就会出现「浏览器里授权完成了，插件还是未登录」。
		 * 域收窄到本插件真正用的那几个：全部 24 个域（232 个 scope）在授权页里根本翻不完。
		 */
		const LOGIN_DOMAINS = "docs,drive,wiki,contact,im,sheets,base";
		/**
		 * `--domain im` 的映射集合里**不含** `im:message.send_as_user`（以我名义发消息的专用 scope），
		 * 实测授权完成后 token 里就是缺它 → 发消息直接 99991672。用 --scope 追加（与 --domain 叠加）。
		 */
		const LOGIN_EXTRA_SCOPES = "im:message.send_as_user";

		async function startCliLogin() {
			const discovery = await loadCliDiscovery();
			if (!discovery.ok)
				throw new CliError("未找到 lark-cli 可执行文件", { type: "setup", subtype: "missing_cli", action: "install" });
			const session = await cliRunner.interactive(
				["auth", "login", "--domain", LOGIN_DOMAINS, "--scope", LOGIN_EXTRA_SCOPES],
				{ timeoutMs: 180_000 },
			);
			const url = await Promise.race([
				session.firstUrl,
				new Promise((resolve) => setTimeout(() => resolve(""), 20_000)),
			]);
			const transcript = url
				? ""
				: String(session.output?.() ?? "")
						.trim()
						.slice(-600);
			cliSetup = { step: "login", url, startedAt: Date.now(), session };
			void Promise.resolve(session.done)
				.then(() => {
					cliStatusCache.invalid();
				})
				.catch(() => {});
			return {
				step: "login",
				url,
				running: Boolean(url),
				command: `lark-cli auth login --domain ${LOGIN_DOMAINS} --scope ${LOGIN_EXTRA_SCOPES}`,
				transcript,
				hint: url
					? "已在后台启动登录：浏览器里如果只看到「任务」，请切到「全部权限」tab，勾选云文档 / 云空间 / 知识库 / 通讯录 / 消息后再授权"
					: `没抓到登录链接：请在服务器终端执行 lark-cli auth login --domain ${LOGIN_DOMAINS} --scope ${LOGIN_EXTRA_SCOPES}`,
			};
		}

		/* --------------------- 会话消息本地缓存（打开会话秒开） --------------------- */
		//
		// 用户提的三件事，其实就是三句话：
		//   1. 选中会话时不要现拉 —— 后台预热过就用后台那份；
		//   2. 不要在「界面拉一遍 / 后台再拉一遍」重复取数 —— 只留**一个落点**；
		//   3. 拉回来的内容要能二次检索加工 —— 读出口统一，才可能被搜。
		//
		// 实现取舍（全部写在这里，免得以后又长出一条「顺手再拉一次」的路）：
		//   - 写入：dm-watch 的 `onFetched`（后台轮询每一页）、`refreshChatMessages`（界面/AI）、
		//     三处都只调 `chatCache.put()`；
		//   - 读取：`chatMessagesPayload()` 是唯一出口（路由 / AI 工具 / 自动问答预览共用），
		//     有缓存先回（带 `refreshing` 标记），没缓存才等这一次 CLI；
		//   - 增量：界面刷新只拉「比缓存最新一条更新」的消息（CLI `--start`），通常 1–3 条；
		//   - 单飞：同一 chatId 同时只允许一条 CLI 请求（前端 5s 轮询 + 后台轮询 + 用户点击会同时来）。
		// 落盘防抖 5s：运行时读的都是内存，落盘只为「重启后还在」；storage 是同步整文件写，别抢主线程。
		const chatCache = createChatCacheStore({ storage: host.storage, log, persistDelayMs: 5_000 });
		/** chatId → 在飞的拉取（命中直接复用，不重复 spawn）。 */
		const chatFetchInflight = new Map();
		/** chatId → 上次真正 spawn CLI 的时间（最小间隔）。 */
		const chatFetchAt = new Map();
		/** 一次拉取的条数（= 界面一屏；缓存内部保留 3 屏）。 */
		const CHAT_FETCH_LIMIT = 40;
		/** 同一会话两次 CLI 拉取的最小间隔：前端 5s 轮询下最多也就这个频率。 */
		const CHAT_FETCH_MIN_MS = 3_000;
		/**
		 * 缓存多久之内算「新鲜」：超过就后台补一次（不会阻塞这次响应）。
		 * 界面每 5s 轮询一次，取 10s 的话「读着看」基本不会触发刷新（半个轮询周期打一次 CLI），
		 * 新消息最多 10s 内自己冒出来 —— 比每轮都 spawn 一次 CLI 划算得多。
		 */
		const CHAT_FRESH_MS = 10_000;
		// 激活即读盘：首屏打开会话时直接就有数据（不阻塞激活）。
		void chatCache.load().catch(() => {});

		async function setupPayload() {
			return {
				setup: cliSetup
					? {
							step: cliSetup.step,
							url: cliSetup.url ?? "",
							userCode: cliSetup.userCode ?? "",
							startedAt: cliSetup.startedAt ?? 0,
						}
					: null,
				cli: await cliStatus(),
			};
		}

		/* ---------------------------- 消息同步 / 私聊提醒（轮询） ---------------------------- */
		//
		// 飞书事件订阅 `im.message.receive_v1` 只推「机器人收到的消息」，人类账号的私聊
		// 没有事件；也没有「我的会话列表 / 未读数」这类个人身份接口。所以只能按间隔
		// 拉 `im/v1/messages` 增量。首次只建基线不通知、水位严格大于、自己发的不报 ——
		// 这些取舍都写在 lib/dm-watch.mjs 文件头。
		//
		// 0.14.0 起同一个引擎同时负责**群消息同步**（`syncGroups`）：单聊与群聊同一轮拉、
		// 同一份水位、同一份缓存；差别只在通知（群默认静默）。所以控制面统一在 `/sync/*`，
		// 不要再另起一个「消息同步定时器」—— 两份定时器 = 同一批消息拉两遍 = 配额白花。
		/** 自动回复引擎（在下面「会话消息读写」之后创建；onNew 闭包先把它声明住）。 */
		let autoReplier = null;
		const dmWatcher = createDmWatcher({
			storage: host.storage,
			// dm-watch 用它判定"自己发的消息"与界面上的"是否已登录"；
			// openId 由 statePayload/cliStatus 刷新到缓存里（有 openId 即代表个人身份可用）。
			snapshot: () => ({ openId: currentOpenId, authorized: cliLoggedIn }),
			notify: (level, content, contentEn) => host.notify?.(level, content, contentEn),
			log,
			// 新增消息 → 自动回复引擎（未启用时引擎自己会跳过，不产生任何副作用）。
			// 注意自激回环：以 user 身份回包时 dm-watch 会因 selfOpenId 自己滤掉，不会自己答自己。
			onNew: (list) => {
				// 群聊默认只回 @我 的：飞书把被 @ 的人放在 `mentions[].id`（open_id），这里用自己的
				// openId 标一个 `mentionMe`。不知道自己是谁时留 `undefined`（引擎会放行，不误杀）。
				const selfId = currentOpenId || "";
				const rows = (Array.isArray(list) ? list : []).map((record) =>
					record && typeof record === "object" && record.chatKind === "group"
						? {
								...record,
								mentionMe: selfId
									? Array.isArray(record.mentions)
										? record.mentions.some((m) => m?.id === selfId)
										: false
									: undefined,
							}
						: record,
				);
				// 前置分析要最近几条上下文（"嗯" / "就按这个来" 离开上下文没法判）。
				// 只读**本地缓存**：不为 triage 多打一次飞书接口，也不额外 spawn CLI。
				const recentByChat = new Map();
				for (const record of rows) {
					const chatId = String(record?.chatId ?? "");
					if (!chatId || recentByChat.has(chatId)) continue;
					try {
						const cached = chatCache.chat(chatId, { limit: 8 }).rows || [];
						// 缓存是新到旧，提示词要旧到新。
						recentByChat.set(chatId, cached.slice().reverse());
					} catch {
						recentByChat.set(chatId, []);
					}
				}
				void autoReplier?.onMessages(rows, { recentByChat });
			},
			// 后台轮询拉到的每一页都进本地会话缓存：界面打开会话时直接读，
			// 不再为同一批消息另走一次 CLI（这正是「选中会话要等一会」的根因）。
			onFetched: ({ chatId, rows, identity, backfill }) => {
				// 只把**个人身份**拉到的消息写进缓存：界面 / AI 读消息都走个人身份，
				// 混入机器人视角的会话内容会让同一条消息“一会有一会没有”。
				if (identity && identity !== "user") return;
				chatCache.put(chatId, {
					rows,
					source: "poll",
					selfOpenId: currentOpenId || "",
					// 这一页是「不带 `--start` 的最新一页」⇒ 缓存里从这一刻起有了一屏，之后才能走增量。
					...(backfill ? { full: true } : {}),
				});
			},
			// 缓存里还没一整屏 ⇒ 这一轮改拉最新一页（不带 `--start`）。
			// 不补屏的话，水位比缓存活得久的会话会永远是「缓存里只有 1 条」（见 lib/chat-cache.mjs 顶部约束 1）。
			needsBackfill: async (chatId) => {
				await chatCache.load();
				return chatCache.needsBackfill(chatId);
			},
			// 取数通道：只有 lark-cli 一条（CLI 不可用时 dm-watch 报 no-channel）。
			cli: createDmCliChannel({
				run: (args, opts) => cliRunner.run(args, opts),
				isReady: async () => Boolean(await cliReady()),
			}),
		});

		/* --------------------------- 最近访问（按飞书身份分桶） --------------------------- */
		//
		// 飞书 OpenAPI 没有"我最近访问过的文档"列表（见 lib/recent.mjs 顶部实测说明），
		// 所以读写文档时本地记一笔。
		//
		// 关键：记录跟着**飞书身份**走，而不是跟着这台机器走 —— 同一台 pi-web-ui
		// 可能被多人共用，若整个实例共用一份记录，A/B 会互相看到对方的访问历史。
		// 桶键 = 当前 user_access_token 对应的 open_id；未登录时进 `__anon__` 桶。

		/**
		 * 当前记录归属：{ owner, openId, name, anonymous }。
		 * 身份来自 lark-cli（`auth list` 的第一个用户），不再有自建 OAuth 的 snapshot。
		 */
		/** 最近一次从 lark-cli 读到的 open_id（同步快照给 dm-watch 用）。 */
		let currentOpenId = "";
		/** lark-cli 的登录态缓存（dm-watch / 界面共用；由下面的预热与 statePayload 刷新）。 */
		let cliLoggedIn = false;

		async function currentCliUser() {
			try {
				const status = await cliStatus();
				return status?.users?.[0] ?? null;
			} catch {
				return null;
			}
		}

		function ownerFromUser(user) {
			const openId = String(user?.openId ?? "").trim();
			return {
				owner: ownerKeyFrom(openId),
				openId,
				name: String(user?.name ?? ""),
				anonymous: !openId,
			};
		}

		let recentOwnerCache = ownerFromUser(null);

		function recentOwner() {
			return recentOwnerCache;
		}

		recentOwnerCache = ownerFromUser(await currentCliUser());
		let recentStore = normalizeRecentStore(await host.storage?.get?.(RECENT_KEY), {
			// v1 的扁平数组没有身份信息：归给当前登录身份（迁移那一刻的操作者），
			// 未登录则进匿名桶 —— 不猜、不丢。
			legacyOwner: recentOwner().owner,
		});
		let recentSaveTimer = null;

		function saveRecentSoon() {
			if (recentSaveTimer) return;
			recentSaveTimer = setTimeout(() => {
				recentSaveTimer = null;
				void host.storage?.set?.(RECENT_KEY, recentStore)?.catch?.(() => {});
			}, 400);
			recentSaveTimer.unref?.();
		}

		/** 读当前身份的条目。 */
		function currentRecent() {
			return readStoreItems(recentStore, recentOwner().owner);
		}

		/** 记一次访问（同文档去重，越新越靠前），写进当前身份的桶。 */
		function touchRecent(doc, source) {
			const entry = recentEntryFrom(doc, { source });
			if (!entry) return null;
			const { owner } = recentOwner();
			const next = upsertRecent(readStoreItems(recentStore, owner), entry, { limit: RECENT_LIMIT });
			recentStore = writeRecentStore(recentStore, owner, next);
			saveRecentSoon();
			return entry;
		}

		/* ------------------------------- 业务封装 ------------------------------- */

		/** CLI 当前登录用户的 open_id（判定"自己发的消息"、私聊对端）。 */
		async function selfOpenId() {
			// 先用激活/首屏已经拿到的身份（cliStatus 缓存 15s），避免每次读消息都等一轮 CLI 状态；
			// 未登录/刚登出时回落到真实查询。
			if (currentOpenId) return currentOpenId;
			const status = await cliStatus().catch(() => null);
			return String(status?.users?.[0]?.openId ?? "");
		}

		/** 把一次"定位到的私聊"写进 chats_info，下次列表直接能看到。 */
		async function rememberP2pChats(items = []) {
			const entries = (Array.isArray(items) ? items : [])
				.filter((item) => item?.chatId)
				.map((item) => ({ id: item.chatId, name: "", mode: "p2p", p2p: true, fetchedAt: Date.now() }));
			if (entries.length === 0) return 0;
			const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
			await host.storage?.set?.(CHAT_INFO_KEY, mergeChatInfo(known, entries));
			return entries.length;
		}

		async function readDoc({ token, type }) {
			// 唯一路径：lark-cli `docs +fetch --doc-format markdown`（旧 raw_content 回落已下线）。
			const doc = await fetchDocViaCli((args, opts) => cliRunner.run(args, opts), { token, type, cfg: runtime() });
			const plain = markdownToPlain(doc.markdown || "") || String(doc.content ?? "");
			if (doc.ok || doc.error) {
				touchRecent(
					{ token, title: doc.title || token, type: type || "docx", url: doc.url, createdAt: 0, modifiedAt: 0 },
					"read",
				);
			}
			return { ...doc, plain, via: "lark-cli" };
		}

		/* ------------------------ 会话消息：缓存优先 + 后台增量 ------------------------ */
		//
		// 只有 `refreshChatMessages` 会 spawn CLI（读消息的唯一取数点）；其余函数都是读缓存。
		// 为什么这么切：以前选中会话 → 拉一页消息 + 再拉一次发言人姓名 = 2 次 CLI 子进程，
		// 切回同一会话又得重来；现在第一屏有缓存就直接出，后台只补增量。

		/** 补发言人姓名：CLI 一般已给 `sender.name`，只对**缺名字**的发查一次，并记 7 天。 */
		async function enrichSenderNames(rows, { self, initialNames = {} }) {
			const ids = [];
			for (const row of Array.isArray(rows) ? rows : []) {
				const id = String(row?.senderId || "");
				if (!id || id === self) continue;
				if (String(row?.senderName || "")) continue;
				if (initialNames[id]) continue;
				if (!ids.includes(id)) ids.push(id);
				if (ids.length >= 20) break;
			}
			if (ids.length === 0) return { names: initialNames, error: "" };
			const known = chatCache.namesFor(ids);
			const missing = chatCache.missingNames(ids);
			if (missing.length === 0) return { names: { ...initialNames, ...known }, error: "" };
			try {
				const result = await fetchUserNamesViaCli((args, opts) => cliRunner.run(args, opts), missing, { as: "user" });
				chatCache.putNames(result.names || {});
				return { names: { ...initialNames, ...known, ...chatCache.namesFor(ids) }, error: result.error || "" };
			} catch (err) {
				// 姓名是装饰：查不到就退化成 open_id 尾巴，不能让整页报错。
				return { names: { ...initialNames, ...known }, error: String(err?.message || err) };
			}
		}

		/**
		 * 拉一个会话的消息（**全插件唯一**会为“读消息” spawn CLI 的地方）。
		 * 取数口径分两种：
		 *   - **补屏**（这个会话还没整页拉过，`meta.full` 为假）→ 拉最新一整页；
		 *   - **增量**（已经补过一屏）→ 只要比缓存里最新一条更新的（CLI `--start`）。
		 * 翻旧页 / 强制刷新取整页。为什么必须分这两种：增量补不进缓存里没有的历史，
		 * 一律走增量就会出现「缓存里永远只有 1 条」（见 `lib/chat-cache.mjs` 顶部约束 1）。
		 */
		async function fetchChatIntoCache(chatId, { limit = CHAT_FETCH_LIMIT, pageToken = "", force = false } = {}) {
			const id = String(chatId ?? "").trim();
			if (!isValidChatId(id)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
			await chatCache.load();
			const cachedMeta = chatCache.meta(id);
			// 增量（`--start <缓存最新一条>`）只对「已经整页拉过」的会话成立：
			// 缓存里没有的历史，增量永远补不进来 —— 真机症状是「同步一直跑，
			// 缓存里每个会话却永远只有 1 条，打开会话只看得到一条」。
			const canIncremental = !force && !pageToken && Boolean(cachedMeta?.full);
			const newestMs = canIncremental ? Number(cachedMeta?.newestMs) || 0 : 0;
			const self = await selfOpenId();
			const result = await fetchChatMessagesViaCli((args, opts) => cliRunner.run(args, opts), id, {
				as: "user",
				pageSize: limit,
				pageToken,
				selfOpenId: self,
				// 增量：CLI 的 `--start` 向下取整到秒，边界重复由 message_id 去重（同一个 id 只存一份）。
				startMs: newestMs,
			});
			const named = await enrichSenderNames(result.items, { self });
			const rows = result.items
				.map((row) => decorateMessageRow(row, { selfOpenId: self, names: named.names }))
				.filter(Boolean);
			// 只有「整页取数」才更新「还有更早的 / 翻页游标」：增量那几条不能把历史状态改掉。
			const patch = { rows, source: "ui", selfOpenId: self };
			if (!newestMs) {
				patch.hasMore = result.hasMore;
				patch.pageToken = result.pageToken;
				// 只有「最新那一页」能证明缓存里有一屏（`pageToken` 翻的是更早的历史，不算）。
				if (!pageToken) patch.full = true;
			}
			chatCache.put(id, patch);
			chatFetchAt.set(id, Date.now());
			return {
				chatId: id,
				rows,
				self,
				namesError: named.error,
				count: rows.length,
				incremental: Boolean(newestMs),
				hasMore: result.hasMore,
				pageToken: result.pageToken,
			};
		}

		/**
		 * 单飞闸门：同一 chatId 同时只允许一条 CLI 请求，且 3s 内不重复 spawn。
		 * 命中在飞请求直接复用（前端 5s 轮询 + 后台轮询 + 用户点击会同时打进来）。
		 * 返回 `null` = 「刚拉过，用缓存即可」。
		 */
		function refreshChatMessages(chatId, opts = {}) {
			const id = String(chatId ?? "").trim();
			if (!isValidChatId(id)) return Promise.reject(new Error("会话 ID 不合法（应为 oc_ 开头）"));
			const running = chatFetchInflight.get(id);
			if (running) return running;
			const last = Number(chatFetchAt.get(id)) || 0;
			if (!opts.force && Date.now() - last < CHAT_FETCH_MIN_MS) return Promise.resolve(null);
			const task = fetchChatIntoCache(id, opts).finally(() => chatFetchInflight.delete(id));
			chatFetchInflight.set(id, task);
			return task;
		}

		/** 本进程内已尝试预热过的会话（失败也不重复试：CLI 挂了不该每次刷列表都再 spawn 一遍）。 */
		const chatWarmTried = new Set();
		/**
		 * 列表加载时顺手预热「最可能被点」的几个会话。
		 *
		 * 为什么要**后台**预热：后台轮询只覆盖监听名单 + 自动发现的单聊，群聊第一次点开
		 * 仍然要等一次 CLI。列表里最上面那几个就是最可能被点的，先补掉它们，
		 * 用户点下去时通常已经在缓存里了。上限 2 个 / 每个进程一次 —— 预热不能变成新的浪费。
		 */
		function warmLikelyChats(chats, { limit = 2 } = {}) {
			let started = 0;
			for (const chat of Array.isArray(chats) ? chats : []) {
				if (started >= limit) break;
				const id = String(chat?.id || "");
				if (!isValidChatId(id)) continue;
				if (chatCache.meta(id) || chatFetchInflight.has(id) || chatWarmTried.has(id)) continue;
				chatWarmTried.add(id);
				started += 1;
				refreshChatInBackground(id, { limit: CHAT_FETCH_LIMIT });
			}
			return started;
		}

		/** 后台补一次（不阻塞响应）：失败只记日志，不影响这次读到的缓存内容。 */
		function refreshChatInBackground(chatId, opts = {}) {
			void refreshChatMessages(chatId, opts).catch((err) => {
				log("warn", `feishu-pro 会话缓存后台刷新失败（${chatId}）：${String(err?.message || err)}`);
			});
		}

		/** 会话类型/对端名缓存（不把“读消息”变成“再打一次 chats/:id”）。 */
		async function rememberChatMeta(chatId, items, { self, names, inferred }) {
			try {
				const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
				const prev = known[chatId];
				const peerId = pickPeerFromMessages(items, self);
				const peerName = names[peerId] || items.find((row) => row.senderId === peerId)?.senderName || "";
				if ((!prev || prev.mode === "unknown" || prev.inferred) && inferred.mode !== "unknown") {
					await host.storage?.set?.(CHAT_INFO_KEY, {
						...known,
						[chatId]: {
							...(prev || {}),
							id: chatId,
							name: prev?.name || peerName || "",
							mode: inferred.mode,
							p2p: inferred.mode === "p2p",
							inferred: true,
							inferReason: inferred.reason,
							fetchedAt: Date.now(),
						},
					});
				}
				return {
					peer: { openId: peerId, name: peerName },
					label: peerName ? `与 ${peerName} 的私聊` : "",
				};
			} catch {
				// 写缓存失败不影响读消息（下次还会重算）。
				const peerId = pickPeerFromMessages(items, self);
				const peerName = names[peerId] || items.find((row) => row.senderId === peerId)?.senderName || "";
				return { peer: { openId: peerId, name: peerName }, label: peerName ? `与 ${peerName} 的私聊` : "" };
			}
		}

		/** 组装一份「读会话消息」的返回体（缓存路径 / 翻旧页路径共用，避免两套字段漂移）。 */
		async function chatPayloadOf({ id, items, hasMore, pageToken, self, cache, refreshing, refreshError, paging }) {
			let inferred = { mode: "unknown", reason: "" };
			try {
				inferred = inferChatMode(items, { selfOpenId: self });
			} catch {
				/* 反推失败不影响读消息 */
			}
			const senderIds = [];
			for (const row of items) {
				if (row?.senderId && !senderIds.includes(row.senderId)) senderIds.push(row.senderId);
				if (senderIds.length >= 20) break;
			}
			const names = chatCache.namesFor(senderIds);
			const meta = await rememberChatMeta(id, items, { self, names, inferred });
			return {
				chatId: id,
				items,
				hasMore: Boolean(hasMore),
				pageToken: String(pageToken || ""),
				identity: "user",
				peer: meta.peer,
				label: meta.label,
				remembered: true,
				inferredMode: inferred,
				namesError: "",
				link: chatLink(id),
				// 这份内容是从哪儿来的：cache = 从本地缓存读的（可能刚刚才被后台刷新过）。
				via: cache ? "cache" : "lark-cli",
				// 翻旧页时说明「这几条不是最新一屏」，别让调用方把 page token 当成最新游标。
				paging: Boolean(paging),
				cached: Boolean(cache),
				refreshing: Boolean(refreshing),
				// 缓存自述：界面据此显示「本地缓存 · Ns 前」，并在 `refreshing` 时快速补一次请求。
				cache: {
					rows: Number(cache?.rows) || 0,
					updatedAt: Number(cache?.updatedAt) || 0,
					ageMs: Number(cache?.ageMs) || 0,
					fetchedAt: Number(cache?.fetchedAt) || 0,
					source: String(cache?.source || ""),
					refreshing: Boolean(refreshing),
					error: String(refreshError || ""),
				},
			};
		}

		/**
		 * 读会话消息（**唯一出口**：路由 / AI 工具 / 自动问答预览都走这里）。
		 * cache-first：有缓存立刻回（stale-while-revalidate）；没缓存（第一次打开）才等这一次 CLI。
		 *
		 * @param {{limit?:number, pageToken?:string, refresh?:boolean, cacheOnly?:boolean}} [opts]
		 *   `cacheOnly` = 只读本地缓存（后台提取这类「扫很多会话」的调用用：一条都没缓存就回空，绝不 spawn CLI）。
		 */
		async function chatMessagesPayload(
			chatId,
			{ limit = CHAT_FETCH_LIMIT, pageToken = "", refresh = false, cacheOnly = false } = {},
		) {
			const id = String(chatId ?? "").trim();
			if (!isValidChatId(id)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
			await chatCache.load();

			// 翻旧页：缓存里只有「最近一段」，再往前的历史必须真的去拉一页 —— 而且回的是**这一页**，
			// 不是缓存里那屏最新的（否则调用方拿着 page_token 会一直拿到最前面几条）。
			if (pageToken) {
				const page = await fetchChatIntoCache(id, { limit, pageToken, force: true });
				return chatPayloadOf({
					id,
					items: page.rows,
					hasMore: page.hasMore,
					pageToken: page.pageToken,
					self: page.self,
					cache: chatCache.meta(id),
					refreshing: false,
					refreshError: page.namesError,
					paging: true,
				});
			}

			const before = chatCache.chat(id, { limit });
			const lastUpdate = Number(before.entry?.updatedAt) || 0;
			// 缓存里还没一整屏（`full`）：这时的「新不新」不重要 —— 只有一条也算新，
			// 不补一屏就永远只有那一条。所以它比「过期」优先级还高（后台补，不阻塞首帧）。
			const unfilled = !before.entry?.full;
			let refreshing = false;
			let refreshError = "";
			if (cacheOnly) {
				// 只读本地：没有缓存就是空的（调用方自己决定要不要回源），也不起后台刷新。
				if (!before.entry) {
					return chatPayloadOf({
						id,
						items: [],
						hasMore: false,
						pageToken: "",
						self: "",
						cache: null,
						refreshing: false,
						refreshError: "",
						paging: false,
					});
				}
			} else if (refresh || !before.entry) {
				// 冷启动 / 手动刷新：这两种必须等一次 CLI（其余都在后台补）。
				try {
					await refreshChatMessages(id, { limit, force: Boolean(refresh) });
				} catch (err) {
					// 已经看过这个会话（有缓存）就别因为刷新失败把内容清空。
					if (!before.entry) throw err;
					refreshError = String(err?.message || err);
				}
			} else if (
				(unfilled || Date.now() - lastUpdate > CHAT_FRESH_MS) &&
				// 真有可发的请求才算「刷新中」：被单飞/最小间隔挡住时不要骗界面（它 800ms 后会来问）。
				!chatFetchInflight.has(id) &&
				Date.now() - (Number(chatFetchAt.get(id)) || 0) >= CHAT_FETCH_MIN_MS
			) {
				// stale-while-revalidate：先回缓存，后台补增量（前端收到 `refreshing` 会马上再问一次）。
				// 「还没一屏」时这一拉会变成**整页**（`fetchChatIntoCache` 看 `full` 决定），
				// 800ms 后前端再问一次就能拿到整屏。
				refreshing = true;
				refreshChatInBackground(id, { limit });
			}

			const self = await selfOpenId();
			const after = chatCache.chat(id, { limit });
			const senderIds = [];
			for (const row of after.rows) {
				if (row?.senderId && !senderIds.includes(row.senderId)) senderIds.push(row.senderId);
				if (senderIds.length >= 20) break;
			}
			const names = chatCache.namesFor(senderIds);
			const items = after.rows.map((row) => decorateMessageRow(row, { selfOpenId: self, names })).filter(Boolean);
			const meta = chatCache.meta(id);
			// 新鲜度按**这次响应**算（刚刷新完就是「刚刚」），不然界面永远显示刷新前的年龄。
			const ageMs = meta?.updatedAt ? Math.max(0, Date.now() - meta.updatedAt) : 0;
			return chatPayloadOf({
				id,
				items,
				hasMore: meta?.hasMore,
				pageToken: meta?.pageToken,
				self,
				cache: { ...meta, ageMs },
				refreshing,
				refreshError,
			});
		}

		/* ---------------------- 会话消息读写（工具 / 路由共用） ---------------------- */
		//
		// 「读最近消息」「发文本」原本只有 HTTP 路由（给界面点按钮用），AI 工具拿不到 ——
		// 于是「收到就问 / 定时提醒」这类自动化只能靠人守在界面里。这里把同一套校验、
		// 身份口径与错误翻译收到一处，路由与工具共用，避免两套说法慢慢漂移。

		/** 发送身份：只认 user（我本人）/ bot（机器人）；tenant 是 CLI 侧对机器人的写法。 */
		function sendIdentity(value) {
			const v = String(value ?? "")
				.trim()
				.toLowerCase();
			return v === "tenant" || v === "bot" ? "bot" : "user";
		}

		/** CLI 的英文报错 → 「下一步该做什么」（否则用户只看到一串权限码）。 */
		function withSendHints(err) {
			const msg = String(err?.message || err);
			if (/missing required scope/i.test(msg)) {
				return new CliError(
					"发消息缺权限：到「设置 → lark-cli 与身份」点「登录账号」重新授权一次（这次会带上 im:message.send_as_user）",
					{ type: "auth", subtype: "missing_scope", action: "login", hint: msg },
				);
			}
			if (/out of the chat/i.test(msg)) {
				return new CliError("机器人不在这个会话里：私聊 / 普通群请把发送身份切到「我」", {
					type: "api",
					subtype: "bot_not_in_chat",
					action: "",
					hint: msg,
				});
			}
			return err;
		}

		/**
		 * 发送 / 阅读的目标会话：chat_id 优先；只给 open_id 时先解析出**已有单聊**
		 * （`contact +search-user --user-ids` 直接回 p2p_chat_id，0 副作用、不发试探消息）。
		 */
		async function resolveChatTarget({ chatId = "", openId = "" } = {}) {
			const chat = String(chatId ?? "").trim();
			const peer = String(openId ?? "").trim();
			if (chat) {
				if (!isValidChatId(chat)) throw new Error("chat_id 不合法（应为 oc_ 开头）");
				return { chatId: chat, openId: "", via: "chat-id" };
			}
			if (!peer) throw new Error("缺少 chat_id 或 open_id（先用 action=contacts 查人拿 open_id）");
			if (!isValidOpenId(peer)) throw new Error("open_id 不合法（应为 ou_ 开头）");
			const resolved = await resolveP2pChatIdViaCli((args, opts) => cliRunner.run(args, opts), {
				openId: peer,
				as: "user",
			});
			const p2p = String(resolved.chatId ?? "");
			if (p2p) await rememberP2pChats([{ chatId: p2p }]);
			return { chatId: p2p, openId: peer, via: p2p ? "p2p-resolve" : "open-id" };
		}

		/**
		 * 发文本（工具与 `/chat/send` 同一条路）。
		 * `dryRun` 只做校验与回执，不调用 CLI —— 自动化首次上线时先看它会发什么。
		 */
		async function sendChatText({ chatId = "", openId = "", text = "", as = "user", uuid = "", dryRun = false } = {}) {
			const body = String(text ?? "");
			if (!body.trim()) throw new Error("消息内容不能为空");
			if (body.length > MESSAGE_TEXT_LIMIT) {
				throw new Error(`消息过长（${body.length} > ${MESSAGE_TEXT_LIMIT} 字）：拆成多条，或把正文放进云文档再发链接`);
			}
			const target = await resolveChatTarget({ chatId, openId });
			const identity = sendIdentity(as);
			const key = String(uuid ?? "")
				.trim()
				.slice(0, 50);
			if (dryRun) {
				return {
					ok: true,
					dryRun: true,
					sent: false,
					chatId: target.chatId,
					...(target.openId ? { openId: target.openId } : {}),
					as: identity,
					chars: body.length,
					uuid: key,
				};
			}
			let sent;
			try {
				sent = await sendTextViaCli((args, opts) => cliRunner.run(args, opts), {
					chatId: target.chatId,
					openId: target.openId,
					text: body,
					as: identity,
					uuid: key,
				});
			} catch (err) {
				throw withSendHints(err);
			}
			// 只有「按 open_id 发」才登记成单聊：按 chat_id 发可能是群，别把群标成私聊。
			if (target.openId && sent.chatId) await rememberP2pChats([{ chatId: sent.chatId }]);
			return { ok: true, dryRun: false, sent: true, ...sent, ...(target.openId ? { openId: target.openId } : {}) };
		}

		/** 每条消息正文上限：50 条 × 原文会把模型窗口打满（与 doc_read 的 12k 口径一致）。 */
		const MESSAGE_TEXT_CAP = 800;
		/** 一批消息的总预算：超出就从**最旧的**开始丢，自动化关心的是「刚刚说了什么」。 */
		const TRANSCRIPT_BUDGET = 8000;

		/** since 既接受 ISO 字符串也接受秒/毫秒时间戳（换算口径与 toMs 一致）。 */
		function parseSince(value) {
			const raw = String(value ?? "").trim();
			if (!raw) return 0;
			if (/^\d+(\.\d+)?$/.test(raw)) return toMs(raw);
			const ms = Date.parse(raw);
			return Number.isFinite(ms) ? ms : 0;
		}

		function isoOf(ms) {
			const n = Number(ms) || 0;
			return n > 0 ? new Date(n).toISOString() : "";
		}

		function clipText(value, cap) {
			const text = String(value ?? "");
			return text.length > cap ? `${text.slice(0, cap)}…` : text;
		}

		/** 单行预览（列表/检索结果用）：去掉换行与多余空白，避免把强撑出三行。 */
		function clipPreview(value, cap) {
			const text = String(value ?? "")
				.replace(/\s+/g, " ")
				.trim();
			return text.length > cap ? `${text.slice(0, cap)}…` : text;
		}

		/**
		 * 读会话消息 → 模型友好的窄行（时间升序）。
		 *
		 * 与界面**同一条路**（`chatMessagesPayload`）：先读本地缓存，缓存里没有才 spawn CLI。
		 * 好处不只是快：agent 看完的内容与用户看到的是同一份，而且顺手把它落进缓存，
		 * 之后 `im_search` 能直接在本地二次检索（不必为「刚才那句是谁说的」再拉一遍）。
		 */
		async function readChatMessages({
			chatId = "",
			openId = "",
			limit = 20,
			pageToken = "",
			since = "",
			refresh = false,
			cacheOnly = false,
		} = {}) {
			const target = await resolveChatTarget({ chatId, openId });
			if (!target.chatId) throw new Error("这个 open_id 解析不出单聊：群聊请直接给 chat_id（oc_ 开头）");
			// 多取一屏：模型这边还要按 `since` 过滤与预算裁剪，缓存里留点余量。
			const payload = await chatMessagesPayload(target.chatId, {
				limit: Math.max(Number(limit) || 20, CHAT_FETCH_LIMIT),
				pageToken,
				refresh: Boolean(refresh),
				cacheOnly: Boolean(cacheOnly),
			});
			const self = await selfOpenId();
			const sinceMs = parseSince(since);
			const rows = payload.items
				.filter((row) => !sinceMs || (Number(row.createTimeMs) || 0) >= sinceMs)
				.map((row) => ({
					id: row.id,
					at: isoOf(row.createTimeMs),
					from: row.self
						? "我"
						: row.senderLabel || row.senderName || (row.senderId ? `…${String(row.senderId).slice(-6)}` : "未知"),
					self: Boolean(row.self),
					type: row.msgType,
					text: clipText(row.text, MESSAGE_TEXT_CAP),
				}))
				.sort((a, b) => a.at.localeCompare(b.at));
			const kept = [];
			let budget = TRANSCRIPT_BUDGET;
			for (let i = rows.length - 1; i >= 0; i -= 1) {
				const cost = rows[i].text.length + 64;
				if (cost > budget) break;
				budget -= cost;
				kept.push(rows[i]);
			}
			kept.reverse();
			// 会话名/类型来自本地缓存（权威来源要再打一次 chats/:id，读消息不该付这个成本）。
			let info = {};
			try {
				const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
				info = known[target.chatId] || {};
			} catch {
				info = {};
			}
			const cached = Number(payload.cache?.rows) || 0;
			return {
				// `via` 说明这份内容是从哪来的：cache = 没打飞书接口（本地缓存够新）。
				via: payload.cached ? "cache" : "lark-cli",
				chatId: target.chatId,
				self,
				mode: String(info.mode || payload.inferredMode?.mode || "unknown"),
				name: String(info.name || payload.peer?.name || ""),
				identity: payload.identity || "user",
				count: kept.length,
				omitted: rows.length - kept.length,
				hasMore: Boolean(payload.hasMore),
				pageToken: String(payload.pageToken || ""),
				cache: payload.cache
					? { rows: cached, ageMs: payload.cache.ageMs, refreshing: payload.cache.refreshing }
					: null,
				items: kept,
			};
		}

		/* ------------------------ 私聊自动问答（onNew → triage → 回包/动手） ------------------------ */
		//
		// 闭环：dm-watch 轮询出新消息 → 引擎判定该不该接（白名单/冷却/限频/陈旧）
		// → **前置分析**（一次 llm.complete：reply / work / escalate / ignore）
		// → 直接发 / 无头跑一轮 / 只通知+待办 / 不回。
		//
		// 三道安全闸：默认关闭、范围与会话都空则谁都不回、`dryRun` 可先只看不发。
		// 回包失败**不重试**（与发送同一条铁律：宁可少发，不可重发）。
		// 顶栏「后台任务」条（先声明再赋值：引擎的 onActivity 会引用它）。
		let bgTask = null;
		/** work 的 scratch 根：放在数据目录下，按 chatId 分目录（多轮要能续上上一轮的产物）。 */
		const WORK_ROOT = join(host.dataDir, "feishu-pro", "runs");
		/**
		 * 转人工落待办：todoService 在下面才创建，这里用惰性引用。
		 * 建失败只记日志 —— 通知已经发出去了，不能因为待办库异常把整条链拖挂。
		 */
		let createEscalationTodo = null;
		autoReplier = createAutoReplier({
			storage: host.storage,
			chat: (req) => host.chat(req),
			send: (args) => sendChatText(args),
			// 前置分析：无工具、有超时的小补全；宿主没注入就自动退回"只写正文"。
			llm: host.llm,
			// work 的沙盒：目录名只留安全字符（chatId 本来就是 oc_ 开头，这里再兜一层）。
			prepareWorkDir: async (chatId) => {
				const safe = String(chatId || "unknown").replace(/[^A-Za-z0-9_-]/g, "");
				const dir = join(WORK_ROOT, safe || "unknown");
				await mkdir(dir, { recursive: true });
				return dir;
			},
			createTodo: (input) => (createEscalationTodo ? createEscalationTodo(input) : null),
			abortRun: (conversationId) => host.abortRun?.(conversationId),
			// 跨重启幂等：同一条消息最多产生一次副作用（agent 跑一轮可能建待办/写文件）。
			inbox: host.inbox,
			log,
			notify: (level, content, contentEn) => host.notify?.(level, content, contentEn),
			onActivity: (snapshot) => {
				// 顶栏「后台任务」条：队列里有没有在跑、本小时回了几条、动手几次、错了什么。
				const work = snapshot.worksLastHour ? ` · 动手 ${snapshot.worksLastHour}` : "";
				bgTask?.update({
					status: snapshot.enabled
						? `已启用 · 在跑 ${snapshot.inflight} · 本小时 ${snapshot.sentLastHour}${work}${snapshot.lastError ? ` · 错误：${snapshot.lastError}` : ""}`
						: "未启用",
				});
			},
		});

		bgTask = host.registerBackgroundTask?.({
			id: "feishu-auto-reply",
			label: "💬 飞书自动回复",
			status: "未启用",
			stop: () => {
				// 面板上的「停止」必须真的让自动化停下来（否则用户以为关了实际还在回）。
				void autoReplier.setConfig({ enabled: false });
			},
		});

		// 回包要认领「自己发起的那一轮」：runId 由 host.chat 回执给出，过户/改名都不变。
		const offRunEvent = host.onRunEvent?.((ev) => {
			void autoReplier.handleRunEvent(ev);
		});
		if (typeof offRunEvent === "function") disposers.push(offRunEvent);
		void autoReplier.load().catch(() => {});

		/**
		 * 「全部私聊 / 全部群组」能不能真的覆盖到，取决于 dm-watch 有没有在轮询那类会话：
		 * 全部群组要 `syncGroups`、全部私聊要 `autoDiscover`。面板据此就地提示 ——
		 * 勾了不等于收得到，不能让人对着一个不生效的勾选猜。
		 */
		function autoScopeSnapshot() {
			const dm = dmWatcher.status();
			const budget = dm.candidates?.budget || {};
			return {
				enabled: Boolean(dm.config?.enabled),
				autoDiscover: Boolean(dm.config?.autoDiscover),
				syncGroups: Boolean(dm.config?.syncGroups),
				p2p: Number(dm.candidates?.p2p) || 0,
				groups: Number(dm.candidates?.groups) || 0,
				budget: { chats: Number(budget.chats) || 0, groups: Number(budget.groups) || 0 },
				// 预览要一个具体会话：给面板几个真正在轮询的，避免勾了「全部」却没处可预览。
				sample: (Array.isArray(dm.chats) ? dm.chats : []).slice(0, 5).map((chat) => ({
					id: String(chat?.id || ""),
					name: String(chat?.name || ""),
					kind: String(chat?.kind || ""),
				})),
			};
		}

		/** `/auto/state` 与 `/auto/config` 共用一份下发形状（面板两处读同一份字段）。 */
		function autoStatePayload() {
			return { ...autoReplier.status(), hostChat: typeof host.chat === "function", sync: autoScopeSnapshot() };
		}

		/**
		 * 素材目录校验：work 运行可以**读**这里的文件并摘给外部的人，配错的代价是整台机器
		 * 变成素材库。所以只接受真实存在的目录，并挡掉"根 / 主目录 / 数据目录 / 工作区根"。
		 */
		async function checkedLibraryDir(raw) {
			const dir = String(raw ?? "").trim();
			if (!dir) return "";
			const abs = resolve(dir);
			let info = null;
			try {
				info = await stat(abs);
			} catch {
				info = null;
			}
			if (!info?.isDirectory()) throw new Error(`素材目录不存在或不是目录：${abs}`);
			const banned = new Set(
				[resolve("/"), resolve(homedir()), resolve(host.dataDir), resolve(host.cwd)].map((p) => resolve(p)),
			);
			if (banned.has(abs)) throw new Error("素材目录不能是根目录 / 用户主目录 / 数据目录 / 工作区根");
			return abs;
		}

		/* --------------------- 会话页 AI 回复（按需，点击即触发） --------------------- */
		//
		// 与上面的自动回复**分开**：这里没有白名单/冷却，判定就是「人在会话页点了一下」。
		// 预览模式只生成不发；直发模式生成后立刻以当前身份发出去。两条路径共用同一个引擎，
		// 认领规则也一样：`host.chat` 回执的 runId → onRunEvent 拿 assistant 文本。
		const chatAiReplier = createChatAiReplier({ chat: (req) => host.chat(req), log });
		const offChatAiRun = host.onRunEvent?.((ev) => {
			void chatAiReplier.handleRunEvent(ev);
		});
		if (typeof offChatAiRun === "function") disposers.push(offChatAiRun);
		// 停用时把还在等结果的调用收掉（别让浏览器请求悬到 180s 超时）。
		disposers.push(() => chatAiReplier.stop());

		/* -------------------------------- AI 待办 -------------------------------- */
		//
		// 「与我有关 + 持续给建议 + 必要时一键让 AI 处理」。
		// 事实源是插件本地库（storage.json 的 todos 键）：飞书任务只在同步时**合并**进来，
		// lark-cli 没就绪 / 没授权任务 scope 时面板仍然可用（只是列不到飞书任务）。
		const todoService = createTodoService({
			storage: host.storage,
			llm: host.llm,
			chat: typeof host.chat === "function" ? (req) => host.chat(req) : null,
			// 发消息只走 CLI 通道（写操作不回落，与 im_send 同一铁律）。
			send: (args) => sendChatText({ ...args, as: "user" }),
			tasks: {
				list: ({ completed = false } = {}) =>
					viaCli("tasks", (run) => listMyTasksViaCli(run, { completed, as: "user" })),
				// 写操作只走 CLI（不回落）：本地新建/编辑要真落到飞书，失败就如实报 warning。
				setDone: (guid, { done = true } = {}) =>
					viaCli("task-done", (run) => setTaskDoneViaCli(run, guid, { done, as: "user" })),
				create: (fields = {}) => viaCli("task-create", (run) => createTaskViaCli(run, { ...fields, as: "user" })),
				update: (guid, fields = {}) =>
					viaCli("task-update", (run) => updateTaskViaCli(run, guid, fields, { as: "user" })),
			},
			// 提取待办的来源：**全局** —— 本地消息缓存里有消息的会话（打开过的私聊 / 群聊 /
			// 后台轮询写进来的都在里面）加监听名单（可能还没缓存过），按最后一条消息新到旧。
			// 飞书不给「我的全部聊天」，「我看过什么」就是「能提取什么」；缓存读是本地操作，
			// 所以多扫几个会话不花网络与配额（真正回源 CLI 的量由服务层封顶）。
			listSources: async () => {
				await chatCache.load();
				const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
				const dm = dmWatcher.status();
				/** @type {Map<string, {chatId:string,name:string,cached:number,newestMs:number,watched:boolean}>} */
				const byId = new Map();
				const touch = (chatId) => {
					const id = String(chatId ?? "").trim();
					if (!isValidChatId(id)) return null;
					let row = byId.get(id);
					if (!row) {
						row = { chatId: id, name: "", cached: 0, newestMs: 0, watched: false };
						byId.set(id, row);
					}
					return row;
				};
				// ① 监听名单（含自动发现的单聊）：还没被打开过的会话只有这条路能进候选。
				for (const chat of Array.isArray(dm?.chats) ? dm.chats : []) {
					const row = touch(chat?.id);
					if (!row) continue;
					row.watched = true;
					row.name = row.name || String(chat?.name || "");
					row.newestMs = Math.max(row.newestMs, Number(chat?.watermarkMs) || 0);
				}
				for (const chatId of parseChatIds(dm?.config?.chatIds)) {
					const row = touch(chatId);
					if (row) row.watched = true;
				}
				// ② 本地缓存：所有看过的会话（也是真正的消息来源）。
				for (const chatId of chatCache.chatIds()) {
					const row = touch(chatId);
					if (!row) continue;
					const meta = chatCache.meta(chatId);
					row.cached = Number(meta?.rows) || 0;
					row.newestMs = Math.max(row.newestMs, Number(meta?.newestMs) || 0);
				}
				return [...byId.values()]
					.map((row) => ({
						...row,
						name: row.name || String(known?.[row.chatId]?.name || known?.[row.chatId]?.label || ""),
					}))
					.sort((a, b) => b.newestMs - a.newestMs);
			},
			// `cacheOnly` = 只读本地缓存（提取扫多个会话时用：不该为了「找待办」spawn 一串 CLI）。
			readMessages: ({ chatId, limit, cacheOnly }) =>
				readChatMessages({ chatId, limit, cacheOnly: Boolean(cacheOnly) }),
			notify: (level, content) => host.notify?.(level, content),
			log,
		});
		await todoService.load().catch(() => {});
		// 自动回复的「转人工」落到同一个待办库：ref.kind=chat + 消息 id → 重试不会建出两条。
		createEscalationTodo = (input) => todoService.create(input);
		// 待办派的 agent 运行也要认领：与自动回复共用 onRunEvent，但按 runId 各认各的。
		const offTodoRun = host.onRunEvent?.((ev) => {
			if (todoService.handleRunEvent(ev)) publishTodoBadge();
		});
		if (typeof offTodoRun === "function") disposers.push(offTodoRun);

		/**
		 * 顶栏「待办」入口：一个按钮 + 逾期/今天数量。
		 * manifest 的 topbar 只能静态徽标，这里用 ui.register 注册同一个入口并动态 update badge；
		 * 宿主没有 ui.register（老版本）就安静跳过 —— 入口不是主流程，不能因此让插件激活失败。
		 */
		let todoBadgeReady = false;
		function publishTodoBadge() {
			try {
				const stats = todoService.snapshot().stats || {};
				const pending = (Number(stats.overdue) || 0) + (Number(stats.today) || 0);
				const badge = pending > 0 ? String(Math.min(pending, 99)) : "";
				if (!todoBadgeReady) {
					const off = host.ui?.register?.({
						id: "feishu-pro-todos",
						slot: "topbar.primary",
						label: "待办",
						labelEn: "To-dos",
						hint: pending > 0 ? `${pending} 条今天到期或已逾期` : "打开待办清单",
						hintEn: pending > 0 ? `${pending} due today or overdue` : "Open to-dos",
						kind: "view",
						view: `plugin:${PLUGIN_ID}`,
						icon: "✓",
						order: 59,
						badge,
					});
					if (typeof off === "function") disposers.push(off);
					todoBadgeReady = true;
				} else {
					host.ui?.update?.("feishu-pro-todos", { badge });
				}
			} catch {
				/* 顶栏入口失败不影响待办本身 */
			}
		}
		publishTodoBadge();

		// 自动获取的**调度器在宿主侧**：服务层保持“不起定时器”，面板/单测直接调 autoRun 即可。
		// 间隔下限 15 分钟（服务层已夹住），`unref` 掉不让 server 退出被这个定时器吊住。
		let todoAutoTimer = null;
		let todoBgTask = null;
		const todoAutoStatus = () => {
			const snap = todoService.snapshot();
			const cfg = snap.config || {};
			const what = [cfg.autoSync ? "同步飞书任务" : "", cfg.autoExtract ? "提取消息待办" : ""]
				.filter(Boolean)
				.join(" + ");
			if (!what) return "未启用";
			return `每 ${cfg.intervalMin} 分钟 ${what}${cfg.lastError ? ` · 上次错误：${cfg.lastError}` : ""}`;
		};
		const runTodoAuto = async () => {
			try {
				const out = await todoService.autoRun({ reason: "timer" });
				if (out?.warnings?.length) log("warn", `feishu-pro 待办自动获取：${out.warnings[0]}`);
			} catch (err) {
				log("warn", `feishu-pro 待办自动获取失败：${String(err?.message || err)}`);
			} finally {
				publishTodoBadge();
				armTodoAuto();
			}
		};
		const armTodoAuto = () => {
			if (todoAutoTimer) {
				clearTimeout(todoAutoTimer);
				todoAutoTimer = null;
			}
			const snap = todoService.snapshot();
			const nextAt = Number(snap.nextAutoAt) || 0;
			todoBgTask?.update?.({ status: todoAutoStatus() });
			if (!nextAt) return;
			// 下限 5s：刚打开开关时 nextAt ≈ now，别在同一个 tick 里重入。
			const every = (Number(snap.config?.intervalMin) || 30) * 60_000;
			const delay = Math.min(Math.max(nextAt - Date.now(), 5_000), every);
			todoAutoTimer = setTimeout(() => {
				todoAutoTimer = null;
				void runTodoAuto();
			}, delay);
			todoAutoTimer.unref?.();
		};
		todoBgTask = host.registerBackgroundTask?.({
			id: "feishu-todo-auto",
			label: "🗒 飞书待办自动获取",
			status: todoAutoStatus(),
			stop: () => {
				// 顶栏“停”必须真停：关开关 + 撤定时器（否则用户以为停了其实还在拉）。
				void todoService.setConfig({ autoSync: false, autoExtract: false }).then(() => armTodoAuto());
			},
		});
		armTodoAuto();

		async function statePayload() {
			const cli = await cliStatus().catch(() => null);
			const user = cli?.users?.[0] ?? null;
			recentOwnerCache = ownerFromUser(user);
			currentOpenId = recentOwnerCache.openId;
			cliLoggedIn = Boolean(cli?.loggedIn);
			// 只下发界面真正读的两个面：CLI 三态（install/config/login）与个人身份。
			// 旧凭证链的空壳字段（app / connect / oauth / presets / cliOnly）已随 OpenAPI 通道删除。
			return {
				pluginId: PLUGIN_ID,
				cli,
				user: user ? { authorized: true, name: user.name || "", openId: user.openId || "" } : { authorized: false },
			};
		}

		/* --------------------------- 消息同步（控制面） --------------------------- */
		//
		// 「消息同步」与「私聊提醒」是**同一个轮询引擎的两个面**（`lib/dm-watch.mjs`）：
		// 同一个定时器、同一份水位、同一份缓存，区别只在「要不要弹通知」。
		// `/dm/*` 保留为引擎原有入口（兼容旧界面 / 单测）;/sync/* 是给人用的控制面：
		// 它把**引擎状态 + 本地缓存自述**合成一份，界面只看这一份就不会出现
		// 「轮询在跑但缓存里没东西 / 缓存很脏却没人管」这种信息割裂。
		//
		// 为什么缓存统计不塞进 `/dm/state`：那个路由被会话页每 15s 轮一次，
		// 而 `chatCacheStats()` 要遍历整份缓存（还要算字节数）—— 「看未读」这种高频请求别干重活。
		async function syncStatePayload(extra = {}) {
			await chatCache.load();
			const status = dmWatcher.status();
			return {
				...status,
				// 每个候选会话「本地已经存了多少条」：一眼看出「同步在跑但不落东西」与「缓存被裁了」。
				// 只是遍历候选（≤50 个）查内存，与整份缓存的字节数无关。
				chats: status.chats.map((chat) => ({
					...chat,
					cachedRows: Number(chatCache.meta(chat.id)?.rows) || 0,
				})),
				cache: chatCache.stats(),
				...(extra || {}),
			};
		}

		/* --------------------------------- 路由 --------------------------------- */

		const routes = [
			[
				"GET",
				"/state",
				async (req, res) => {
					sendOk(res, await statePayload());
				},
			],
			[
				"GET",
				"/cli/status",
				async (req, res) => {
					sendOk(res, { cli: await cliStatus(), setup: (await setupPayload()).setup });
				},
			],
			[
				"POST",
				"/cli/refresh",
				async (req, res) => {
					cliStatusCache.invalid();
					cliDiscovery = null;
					sendOk(res, { cli: await cliStatus() });
				},
			],
			[
				"POST",
				"/cli/setup",
				async (req, res) => {
					const step = firstParam(bodyOf(req).step) === "login" ? "login" : "config";
					sendOk(res, { setup: step === "login" ? await startCliLogin() : await startCliConfig() });
				},
			],
			["GET", "/cli/setup", async (req, res) => sendOk(res, await setupPayload())],
			[
				"GET",
				"/contacts/search",
				async (req, res) => {
					const q = queryOf(req);
					const query = firstParam(q.q);
					const limit = Number(firstParam(q.limit)) || 20;
					const result = await viaCli("contact +search-user", (run) => searchUsersViaCli(run, { query, limit }));
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/contacts/departments",
				async (req, res) => {
					const q = queryOf(req);
					const parentId = firstParam(q.parent) || "0";
					const result = await viaCli("contact departments", (run) =>
						listDepartmentsViaCli(run, { parentId, pageSize: 50 }),
					);
					sendOk(res, { items: result.items ?? [] });
				},
			],
			[
				"GET",
				"/contacts/department-users",
				async (req, res) => {
					const q = queryOf(req);
					const departmentId = firstParam(q.department) || "0";
					const pageSize = Number(firstParam(q.limit)) || 50;
					const pageToken = firstParam(q.page_token);
					const result = await viaCli("contact find_by_department", (run) =>
						listDepartmentUsersViaCli(run, { departmentId, pageSize, pageToken }),
					);
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/contacts/user",
				async (req, res) => {
					const q = queryOf(req);
					const id = firstParam(q.id);
					if (!id) throw new Error("缺少 id（open_id）");
					const result = await viaCli("contact +get-user", (run) => getUserViaCli(run, { openId: id }));
					sendOk(res, { item: result.item ?? null });
				},
			],
			[
				"GET",
				"/docs/search",
				async (req, res) => {
					const q = queryOf(req);
					const query = firstParam(q.q);
					const count = Number(firstParam(q.count)) || 20;
					const result = await viaCli("docs +search", (run) => searchDocsViaCli(run, { query, count, cfg: runtime() }));
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/docs/files",
				async (req, res) => {
					const q = queryOf(req);
					const folderToken = firstParam(q.folder);
					const pageSize = Number(firstParam(q.limit)) || 50;
					const orderBy = normalizeOrderBy(firstParam(q.order_by));
					const result = await viaCli("drive files list", (run) =>
						listDriveFilesViaCli(run, { folderToken, pageSize, orderBy, cfg: runtime() }),
					);
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/docs/wikis",
				async (req, res) => {
					const result = await viaCli("wiki +space-list", (run) => listWikiSpacesViaCli(run, { pageSize: 50 }));
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/docs/wiki-nodes",
				async (req, res) => {
					const q = queryOf(req);
					const spaceId = firstParam(q.space);
					const parentNodeToken = firstParam(q.parent);
					const pageSize = Number(firstParam(q.limit)) || 50;
					const result = await viaCli("wiki +node-list", (run) =>
						listWikiNodesViaCli(run, { spaceId, parentNodeToken, pageSize, cfg: runtime() }),
					);
					sendOk(res, result);
				},
			],
			[
				"GET",
				"/docs/read",
				async (req, res) => {
					const q = queryOf(req);
					const token = firstParam(q.token);
					if (!token) throw new Error("缺少 token");
					sendOk(res, { doc: await readDoc({ token, type: firstParam(q.type) || "docx" }) });
				},
			],
			[
				"GET",
				"/docs/recent",
				async (req, res) => {
					const q = queryOf(req);
					const limit = Number(firstParam(q.limit)) || 50;
					const who = recentOwner();
					const items = readRecent(currentRecent(), { limit });
					sendOk(res, {
						items,
						total: currentRecent().length,
						limit: RECENT_LIMIT,
						// 记录归属：跟着飞书身份，不是一个实例共有一份。
						scope: {
							anonymous: who.anonymous,
							openId: who.openId,
							name: who.name,
							otherOwners: listOwnerKeys(recentStore).filter((k) => k !== who.owner).length,
						},
						note: who.anonymous
							? "当前未登录飞书账号：记录暂存在匿名身份下。登录后记录会跟着你的飞书账号走，与匿名记录分开"
							: "「访问时间」由本插件按你的飞书身份记录（飞书 OpenAPI 不提供最近访问列表）；创建/修改时间来自飞书",
					});
				},
			],
			[
				"POST",
				"/docs/touch",
				async (req, res) => {
					const body = bodyOf(req);
					const doc = body.doc ?? body;
					// 时间由调用方（列表接口）给：lark-cli 已返回创建/修改时间，不再额外打一次 metas。
					touchRecent(doc, String(body.source || "open"));
					// 回传**合并后**的条目（含新的 accessCount），而不是刚构造的那份 ——
					// 否则前端看到"次数 1"，与列表里的实际次数不一致。
					const who = recentOwner();
					const items = currentRecent();
					const key = recentKey(enriched);
					const merged = items.find((item) => recentKey(item) === key) ?? null;
					sendOk(res, {
						entry: merged,
						total: items.length,
						scope: { anonymous: who.anonymous, openId: who.openId, name: who.name },
					});
				},
			],
			[
				"DELETE",
				"/docs/recent",
				async (req, res) => {
					// 只清当前身份的桶：共用实例上不能因为 A 点"清空"把 B 的记录也删了。
					const who = recentOwner();
					recentStore = clearRecentStore(recentStore, who.owner);
					await host.storage?.set?.(RECENT_KEY, recentStore);
					sendOk(res, {
						items: [],
						total: 0,
						scope: { anonymous: who.anonymous, openId: who.openId, name: who.name },
					});
				},
			],
			["GET", "/dm/state", async (req, res) => sendOk(res, dmWatcher.status())],
			[
				"POST",
				"/dm/read",
				async (req, res) => {
					// 打开会话即视为已读：清掉该会话的未读累计（不影响水位，所以不会重复报旧消息）。
					const chatId = String(bodyOf(req).chatId ?? "").trim();
					if (!chatId) throw new Error("缺少 chatId");
					sendOk(res, dmWatcher.markRead(chatId));
				},
			],
			[
				"POST",
				"/dm/config",
				async (req, res) => {
					const incoming = bodyOf(req);
					sendOk(res, await dmWatcher.updateConfig(incoming.config ?? incoming));
				},
			],
			[
				"POST",
				"/dm/poll",
				async (req, res) => {
					const result = await dmWatcher.pollOnce({ force: true });
					sendOk(res, {
						...dmWatcher.status(),
						polled: result.messages.length,
						chats: result.chats ?? 0,
						rows: result.rows ?? 0,
						skipped: result.skipped ?? "",
					});
				},
			],
			[
				"POST",
				"/dm/discover",
				async (req, res) => {
					const found = await dmWatcher.discover();
					sendOk(res, { ...dmWatcher.status(), diagnostics: found.diagnostics });
				},
			],
			/* ------------------------ 消息同步（私聊 + 群，控制面） ------------------------ */
			[
				"GET",
				"/sync/state",
				async (req, res) => {
					sendOk(res, await syncStatePayload());
				},
			],
			[
				"POST",
				"/sync/config",
				async (req, res) => {
					// 与 `/dm/config` 是**同一个配置对象**（同一个引擎），这里只少一层 `config` 包裹。
					// 只允许改白名单字段（normalizeDmConfig 会丢掉多余的键）。
					const incoming = bodyOf(req);
					await dmWatcher.updateConfig(incoming.config ?? incoming);
					sendOk(res, await syncStatePayload());
				},
			],
			[
				"POST",
				"/sync/run",
				async (req, res) => {
					// 手动同步一轮：和定时轮询**同一条路径**（force 无视 enabled），
					// 所以不会出现「手动拉一次就带歪水位」的并发问题（内建 polling 闸门）。
					//
					// 闸门是「跳过」而不是「排队」：刚勾上「启用后台同步」就点「立即同步」时，
					// 很容易撞上刚起的那一轮。所以这里先**有限等待**在飞的这一轮（实测 45 个会话 ≈ 40s，
					// 所以等到 60s：既能让手动同步拿到真实数字，也不会把浏览器请求挂太久）。
					//   - 等到了 → 直接用那一轮的结果（**不再白拉一遂**：一轮 50 个会话 ≈ 50 次 spawn）；
					//   - 等不到（会话多 / CLI 慢）→ 如实回 skipped=busy，界面说「正在同步中」。
					const busyAtStart = dmWatcher.status().busy;
					const deadline = Date.now() + 60_000;
					while (dmWatcher.status().busy && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
					const after = dmWatcher.status();
					let synced;
					if (busyAtStart && !after.busy) {
						// 刚等到一轮跑完：数字就是它，不重复拉。
						synced = {
							chats: after.lastPoll?.chats ?? 0,
							rows: after.lastPoll?.rows ?? 0,
							fresh: after.lastPoll?.fresh ?? 0,
							skipped: "",
							waited: true,
						};
					} else if (after.busy) {
						synced = { chats: 0, rows: 0, fresh: 0, skipped: "busy" };
					} else {
						const result = await dmWatcher.pollOnce({ force: true });
						synced = {
							chats: result.chats ?? 0,
							rows: result.rows ?? 0,
							fresh: result.messages?.length ?? 0,
							skipped: result.skipped ?? "",
						};
					}
					sendOk(res, await syncStatePayload({ synced }));
				},
			],
			[
				"POST",
				"/sync/clear",
				async (req, res) => {
					// 只清**缓存内容**，不动水位与配置：清完下一轮增量会把最近的消息重新填回来，
					// 不会因为「清了缓存」就把整段历史当新消息弹一遍。
					await chatCache.clear();
					sendOk(res, await syncStatePayload());
				},
			],
			[
				"GET",
				"/chats",
				async (req, res) => {
					if (!(await cliReady())) throw await cliSetupError();
					const listed = await fetchChatsViaCli((args, opts) => cliRunner.run(args, opts), { as: "user" });
					const watched = new Set(parseChatIds(dmWatcher.status().config?.chatIds));
					const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
					// CLI 已经按 active_time 排好序，不再逐会话预热"最后一条消息"（那是旧实现的最大成本）。
					const merged = mergeChatSources(listed.chats, [...watched], known);
					await chatCache.load();
					const self = await selfOpenId();
					// 列表上的「最后一条」来自本地缓存（后台轮询 / 打开过的会话都写进来）：
					// 不额外 spawn 一次 CLI，也不会因为「没预热过」就整列显示 chat_id。
					const decorated = merged.map((chat) => {
						const last = chatCache.lastMessage(chat.id);
						const meta = chatCache.meta(chat.id);
						const lastSelf = Boolean(self) && Boolean(last?.senderId) && last.senderId === self;
						const lastSender = last
							? lastSelf
								? "我"
								: chatCache.namesFor([last.senderId])[last.senderId] || last.senderName || ""
							: "";
						return {
							...chat,
							watched: watched.has(chat.id),
							link: chatLink(chat.id),
							lastMessageAt: Number(last?.createTimeMs) || 0,
							lastPreview: clipPreview(last?.text || last?.richText || "", 60),
							lastSender,
							lastMessageSelf: lastSelf,
							// 「本地已缓存 N 条」：告诉用户「点开就有」，而不是又一个加载中的转圈。
							cachedRows: Number(meta?.rows) || 0,
							cachedAt: Number(meta?.updatedAt) || 0,
						};
					});
					const sections = chatSections(decorated);
					const p2pCount = decorated.filter((c) => c.p2p).length;
					// 顺手预热最上面三个（后台跑，不占这次响应）：点下去时多半已经在缓存里。
					const warming = warmLikelyChats(decorated, { limit: 3 });
					// 未读数来自私聊提醒的轮询（本地累计）；打开会话时前端会调 /dm/read 清零。
					const unread = dmWatcher.status().unread ?? {};
					sendOk(res, {
						items: decorated,
						counts: { total: sections.total, p2p: sections.p2p, groups: sections.groups },
						sections,
						authorized: true,
						identity: "user",
						hasMore: listed.hasMore,
						pageToken: listed.pageToken,
						error: "",
						needUser: false,
						watchedCount: watched.size,
						unread,
						// 本次顺手预热了几个会话（0 表示都有了，或已经试过）。
						warming,
						discovery: {
							ownPages: 1,
							ownHasMore: listed.hasMore,
							botPages: 0,
							botError: "",
							p2p: p2pCount,
							botTotal: 0,
							via: "lark-cli",
						},
						hint:
							p2pCount === 0
								? "lark-cli 没有返回单聊：确认登录的是你本人账号（私聊列表来自 im +chat-list --types p2p）"
								: "",
					});
				},
			],
			[
				"GET",
				"/chat/messages",
				async (req, res) => {
					// 缓存优先：有缓存立刻回（`cache.refreshing` 表示后台正在补增量），
					// 只有「第一次打开 / 手动刷新 / 翻旧页」才等 CLI。见 `chatMessagesPayload`。
					const q = queryOf(req);
					const payload = await chatMessagesPayload(firstParam(q.chatId) || firstParam(q.id), {
						limit: Number(firstParam(q.limit)) || CHAT_FETCH_LIMIT,
						pageToken: firstParam(q.pageToken),
						refresh:
							["1", "true", "yes"].includes(firstParam(q.refresh).toLowerCase()) ||
							["1", "true", "yes"].includes(firstParam(q.wait).toLowerCase()),
					});
					sendOk(res, payload);
				},
			],
			[
				"GET",
				"/chat/search",
				async (req, res) => {
					// 二次检索：只读本地缓存（后台轮询 + 打开过 + AI 读过的会话都在里面），不打飞书接口。
					const q = queryOf(req);
					const query = firstParam(q.q) || firstParam(q.query);
					await chatCache.load();
					const result = chatCache.search({
						query,
						chatIds: parseChatIds(firstParam(q.chatIds) || firstParam(q.chatId)),
						limit: Number(firstParam(q.limit)) || CHAT_SEARCH_LIMIT,
						sinceMs: parseSince(firstParam(q.since)),
					});
					const self = await selfOpenId();
					const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
					const chatNames = {};
					for (const row of result.hits) {
						if (!chatNames[row.chatId]) {
							const cached = chatCache.meta(row.chatId);
							chatNames[row.chatId] =
								String(known[row.chatId]?.name || "").trim() ||
								`…${String(row.chatId).slice(-6)}` + (cached?.rows ? "" : "");
						}
					}
					sendOk(res, {
						query,
						tooShort: Boolean(result.tooShort),
						scanned: result.scanned,
						count: result.hits.length,
						items: result.hits.map((row) => ({
							chatId: row.chatId,
							chatName: chatNames[row.chatId] || "",
							id: row.id,
							at: Number(row.createTimeMs) || 0,
							from:
								row.senderId === self ? "我" : chatCache.namesFor([row.senderId])[row.senderId] || row.senderName || "",
							self: Boolean(self) && row.senderId === self,
							type: row.msgType,
							text: clipPreview(row.text || row.richText || "", 200),
							snippet: row.snippet,
						})),
						note: result.tooShort ? "关键词至少两个字" : "",
					});
				},
			],
			[
				"GET",
				"/chat/cache",
				async (req, res) => {
					// 缓存自述：多少会话 / 多少条 / 多新 / 占多大（排错与「要不要清」都靠它）。
					await chatCache.load();
					sendOk(res, { ...chatCache.stats(), chats: chatCache.chatIds() });
				},
			],
			[
				"POST",
				"/chat/cache/clear",
				async (req, res) => {
					await chatCache.clear();
					sendOk(res, { ...chatCache.stats() });
				},
			],
			[
				"GET",
				"/chat/media",
				async (req, res) => {
					// 消息里的图片/文件：用 lark-cli 的 +messages-resources-download 落到临时目录，
					// 再以二进制回给前端（同源 <img> 自带 Cookie，不必把飞书 token 暴露出去）。
					const q = queryOf(req);
					const messageId = firstParam(q.messageId);
					const key = firstParam(q.key);
					const type = firstParam(q.type) === "file" ? "file" : "image";
					if (!/^om_[A-Za-z0-9_-]{4,}$/.test(messageId)) throw new Error("messageId 不合法");
					if (!/^(img|file)_[A-Za-z0-9_-]{4,}$/.test(key)) throw new Error("资源 key 不合法");
					if (!(await cliReady())) throw await cliSetupError();

					const dir = join(tmpdir(), "feishu-pro-media");
					await mkdir(dir, { recursive: true });
					// CLI 会自动按 Content-Type 给文件补扩展名（`<key>.png`），所以不能假设路径就是 key；
					// 先扫已知扩展名的缓存，没命中再下载，并以 CLI 返回的 saved_path 为准。
					const exts = ["", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
					let file = exts.map((ext) => join(dir, key + ext)).find((candidate) => existsSync(candidate)) || "";
					if (!file) {
						const out = await cliRunner.run(
							[
								"im",
								"+messages-resources-download",
								"--message-id",
								messageId,
								"--file-key",
								key,
								"--type",
								type,
								"--as",
								"user",
								"--output",
								join(dir, key),
							],
							{ timeoutMs: 60_000 },
						);
						const saved = String(out?.data?.saved_path ?? "");
						file =
							saved && existsSync(saved)
								? saved
								: exts.map((ext) => join(dir, key + ext)).find((c) => existsSync(c)) || "";
					}
					if (!file) {
						throw new CliError("下载资源失败：lark-cli 没有落盘（检查 im:resource 权限）", {
							type: "api",
							subtype: "media_missing",
							action: "login",
						});
					}
					const buf = await readFile(file);
					res.setHeader("Content-Type", type === "image" ? sniffMediaType(buf) : "application/octet-stream");
					res.setHeader("Content-Length", String(buf.length));
					res.setHeader("Cache-Control", "private, max-age=3600");
					res.setHeader("X-Content-Type-Options", "nosniff");
					res.end(buf);
				},
			],
			[
				"POST",
				"/chat/send",
				async (req, res) => {
					const body = bodyOf(req);
					const chatId = String(body.chatId ?? "").trim();
					const openId = String(body.openId ?? "").trim();
					// 身份语义：默认以我本人身份发；显式 as=tenant|bot 才走机器人。
					// 写操作只有一条路（lark-cli）—— 换通道重试等于可能发两遍。
					const sent = await sendChatText({
						chatId,
						openId,
						text: body.text,
						as: body.as ?? body.identity,
						uuid: String(body.uuid ?? "").trim(),
					});
					// 发完立刻后台补一次增量：新消息几百毫秒内就进缓存，界面下一次轮询直接看到它，
					// 而不是等 5s 轮询把整页重拉一遂（也就不会“发了却买不到”）。
					if (sent?.chatId && isValidChatId(sent.chatId)) refreshChatInBackground(sent.chatId, { force: true });
					sendOk(res, sent);
				},
			],
			[
				"POST",
				"/chat/ai-reply",
				async (req, res) => {
					const body = bodyOf(req);
					const chatId = String(body.chatId ?? "").trim();
					if (!isValidChatId(chatId)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
					// preview = 只生成，正文交给界面预览/编辑；direct = 生成后立刻以当前身份发出去。
					const mode = String(body.mode ?? "").toLowerCase() === "direct" ? "direct" : "preview";
					const identity = sendIdentity(body.as ?? body.identity ?? "user");
					const instruction = String(body.instruction ?? "")
						.trim()
						.slice(0, 500);
					// 右键选中的那条消息：只回复它，且不把更晚的消息当上下文（Feishu message id = om_...）。
					const messageId = String(body.messageId ?? "").trim();
					if (messageId && !/^[A-Za-z0-9_-]{1,80}$/.test(messageId)) throw new Error("消息 ID 不合法");
					// 上下文与界面**同一个读出口**（缓存优先）：用户看到的那几条，就是模型看到的那几条。
					// 读 60 条是为了兜住「右键的是屏幕上偏旧的一条」，提示词内部仍只取锚点前 ≤12 条。
					const payload = await chatMessagesPayload(chatId, { limit: 60 });
					const chatName = String(payload.label || payload.peer?.name || "").trim();
					// 「我的背景」与自动回复共用一份（设置里只填一次）：起草回复同样要知道我是谁、能拍板什么。
					await autoReplier.load();
					const profile = autoReplier.status().config.ownerProfile || "";
					const generated = await chatAiReplier.generate({
						chatId,
						chatName,
						rows: payload.items,
						instruction,
						messageId,
						profile,
					});
					if (!generated.ok) throw new Error(generated.error || "AI 没有产出回复");
					const text = generated.text;
					if (mode === "preview") {
						sendOk(res, {
							mode,
							chatId,
							chatName,
							text,
							chars: text.length,
							identity,
							sent: false,
							runId: generated.runId,
							conversationId: generated.conversationId,
						});
						return;
					}
					// 直发：按飞书单条上限切片；多块用「同前缀 + 序号」的幂等键（重试不会发两遍）。
					const chunks = splitReplyText(text);
					const base =
						String(body.uuid ?? "")
							.trim()
							.replace(/[^\w.-]/g, "")
							.slice(0, 44) || `ai-${Date.now().toString(36)}`;
					const sentItems = [];
					for (let i = 0; i < chunks.length; i += 1) {
						const uuid = (chunks.length > 1 ? `${base}-${i + 1}` : base).slice(0, 50);
						try {
							const sent = await sendChatText({ chatId, text: chunks[i], as: identity, uuid });
							sentItems.push({ index: i + 1, messageId: String(sent?.messageId ?? "") });
						} catch (err) {
							// 生成成功但发送失败：**不自动重试**，把还没发出去的部分带回界面
							// （预览面板可改后重发）。复用失败那一段的幂等键：万一它其实发出去了，
							// 飞书按 key 去重，不会发第二遍。
							if (sentItems.length > 0) refreshChatInBackground(chatId, { force: true });
							const remaining = chunks.slice(sentItems.length);
							sendOk(res, {
								mode,
								chatId,
								chatName,
								text: remaining.join("\n"),
								uuidBase: (chunks.length > 1 ? `${base}-${sentItems.length + 1}` : base).slice(0, 50),
								identity,
								sent: sentItems.length > 0,
								partial: sentItems.length > 0,
								sentChunks: sentItems.length,
								chunks: chunks.length,
								sendError: String(err?.message || err),
								hint: String(err?.hint ?? ""),
								runId: generated.runId,
							});
							return;
						}
					}
					// 自己发的消息立刻反映到缓存/列表（不等 5s 轮询）。
					refreshChatInBackground(chatId, { force: true });
					sendOk(res, {
						mode,
						chatId,
						chatName,
						text,
						identity,
						sent: true,
						chunks: chunks.length,
						chunked: chunks.length > 1,
						messageIds: sentItems.map((item) => item.messageId).filter(Boolean),
						runId: generated.runId,
						conversationId: generated.conversationId,
					});
				},
			],
			[
				"POST",
				"/chat/p2p-resolve",
				async (req, res) => {
					// `contact +search-user --user-ids` 直接回 p2p_chat_id：0 副作用（不发试探消息）。
					const b = bodyOf(req);
					const openId = String(b.openId ?? "").trim();
					const openIds = Array.isArray(b.openIds) ? b.openIds.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
					if (!openId && openIds.length === 0) throw new Error("open_id 不能为空");
					const ids = openIds.length ? openIds : [openId];
					const { items } = await getUsersByIdsViaCli((args, opts) => cliRunner.run(args, opts), { ids, as: "user" });
					const resolvedItems = items
						.map((user) => ({ chatId: user.p2pChatId || "", peerId: user.openId }))
						.filter((x) => x.chatId);
					const remembered = await rememberP2pChats(resolvedItems);
					sendOk(res, { via: "search-user", items: resolvedItems, remembered });
				},
			],
			[
				"POST",
				"/chat/watch",
				async (req, res) => {
					const body = bodyOf(req);
					const chatId = String(body.chatId ?? "").trim();
					if (!isValidChatId(chatId)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
					const current = dmWatcher.status().config;
					const ids = parseChatIds(current.chatIds);
					const watch = body.watch === undefined ? !ids.includes(chatId) : Boolean(body.watch);
					const next = watch ? [...ids, chatId] : ids.filter((id) => id !== chatId);
					const dm = await dmWatcher.updateConfig({ ...current, chatIds: next.join(",") });
					sendOk(res, { dm, chatId, watching: watch, chatIds: next });
				},
			],
			[
				"GET",
				"/auto/state",
				async (req, res) => {
					sendOk(res, autoStatePayload());
				},
			],
			[
				"POST",
				"/auto/config",
				async (req, res) => {
					const body = bodyOf(req);
					await autoReplier.setConfig({
						enabled: body.enabled,
						chatIds: body.chatIds,
						// 范围开关（全部私聊 / 全部群组）与「群里只回 @我」。
						allDms: body.allDms,
						allGroups: body.allGroups,
						groupMentionOnly: body.groupMentionOnly,
						as: body.as,
						cooldownSec: body.cooldownSec,
						maxPerHour: body.maxPerHour,
						staleSec: body.staleSec,
						dryRun: body.dryRun,
						signature: body.signature,
						ownerProfile: body.ownerProfile,
						triage: body.triage,
						workEnabled: body.workEnabled,
						maxWorkPerHour: body.maxWorkPerHour,
						runTimeoutSec: body.runTimeoutSec,
						// 目录要过存在性/越界校验：配错等于把整台机器变成可对外摘录的素材库。
						...(body.libraryDir === undefined ? {} : { libraryDir: await checkedLibraryDir(body.libraryDir) }),
						escalateTodo: body.escalateTodo,
						redact: body.redact,
					});
					sendOk(res, autoStatePayload());
				},
			],
			[
				"POST",
				"/auto/preview",
				async (req, res) => {
					// 上线前先看「对这人这条消息，模型会收到什么提示词」——不建运行、不发消息。
					const body = bodyOf(req);
					const chatId = String(body.chatId ?? "").trim();
					if (!isValidChatId(chatId)) throw new Error("会话 ID 不合法（应为 oc_ 开头）");
					const latest = await readChatMessages({ chatId, limit: 5 });
					const last = latest.items.filter((item) => !item.self).pop() || latest.items[latest.items.length - 1];
					if (!last) throw new Error("这个会话没有可用的消息");
					const record = {
						chatId,
						chatName: latest.name,
						// 会话种类决定「全部私聊 / 全部群组」与「群里只回 @我」在预览里怎么判：
						// 与 dm-watch 的记录同口径（`chatKind`），拿不到就是 unknown（范围开关不命中）。
						chatKind: latest.mode,
						id: last.id,
						senderName: last.from,
						senderType: "user",
						msgType: last.type,
						text: last.text,
						createTimeMs: Date.parse(last.at) || 0,
						self: Boolean(last.self),
					};
					sendOk(res, {
						chatId,
						message: last,
						...(await autoReplier.preview(record, { recent: latest.items })),
					});
				},
			],
		];

		/* ------------------------------ AI 待办路由 ------------------------------ */
		//
		// 写操作全部走 POST（GET 只读快照）：待办面板会反复刷新，别让预取/刷新重放副作用。
		routes.push(
			[
				"GET",
				"/todos",
				async (req, res) => {
					await todoService.load();
					sendOk(res, todoService.snapshot());
				},
			],
			["POST", "/todos/create", async (req, res) => sendOk(res, await todoService.create(bodyOf(req)))],
			[
				"POST",
				"/todos/update",
				async (req, res) => {
					const body = bodyOf(req);
					sendOk(res, await todoService.update({ id: firstParam(body.id), patch: body.patch || body }));
				},
			],
			["POST", "/todos/delete", async (req, res) => sendOk(res, await todoService.remove(firstParam(bodyOf(req).id)))],
			["POST", "/todos/sync", async (req, res) => sendOk(res, await todoService.sync())],
			[
				"POST",
				"/todos/advise",
				async (req, res) => {
					const body = bodyOf(req);
					// ids 缺省 = 服务端自动挑最该看的几条（逾期/今天优先）。limit 夹在 1–3：额度是用户的。
					const ids = Array.isArray(body.ids) ? body.ids.map((id) => firstParam(id)).filter(Boolean) : [];
					const limit = Math.min(Math.max(Number(body.limit) || TODO_ADVICE_LIMIT, 1), TODO_ADVICE_LIMIT);
					sendOk(res, await todoService.advise({ ids, force: Boolean(body.force), limit }));
				},
			],
			[
				"POST",
				"/todos/mute",
				async (req, res) => sendOk(res, await todoService.muteAdvice(firstParam(bodyOf(req).id))),
			],
			[
				"POST",
				"/todos/execute",
				async (req, res) => {
					// 动作正文/收件人一律取服务端存过的那份：前端只能指定「哪一个」，不能指定「发什么」。
					const body = bodyOf(req);
					sendOk(res, await todoService.execute({ id: firstParam(body.id), actionId: firstParam(body.actionId) }));
				},
			],
			[
				"POST",
				"/todos/extract",
				// 不传 limit = 用服务层默认（默认扫本地缓存里的多个会话；缓存读不花网络）。
				async (req, res) => sendOk(res, await todoService.extract({ limit: Number(bodyOf(req).limit) || 0 })),
			],
			[
				"POST",
				"/todos/config",
				async (req, res) => {
					const body = bodyOf(req);
					const patch = body.patch && typeof body.patch === "object" ? body.patch : body;
					const result = await todoService.setConfig({
						...(Object.hasOwn(patch, "autoSync") ? { autoSync: Boolean(patch.autoSync) } : {}),
						...(Object.hasOwn(patch, "autoExtract") ? { autoExtract: Boolean(patch.autoExtract) } : {}),
						...(Object.hasOwn(patch, "intervalMin") ? { intervalMin: patch.intervalMin } : {}),
						// 打开开关 = 立刻先跑一轮（不等一个间隔），但仍由服务层夹住重入。
						...(patch.restart ? { restart: true } : {}),
					});
					sendOk(res, result);
					// 排期随配置变：关掉开关就撤定时器，打开就排下一轮。
					armTodoAuto();
				},
			],
			[
				"POST",
				"/todos/adopt",
				async (req, res) => {
					// 前端只给候选 id：标题/截止一律取服务端存过的那份。
					const body = bodyOf(req);
					sendOk(res, await todoService.adopt({ id: firstParam(body.id), toFeishu: Boolean(body.toFeishu) }));
				},
			],
			[
				"POST",
				"/todos/briefing",
				async (req, res) => sendOk(res, await todoService.briefing({ force: Boolean(bodyOf(req).force) })),
			],
			[
				"POST",
				"/todos/candidates-ignore",
				async (req, res) => {
					const body = bodyOf(req);
					sendOk(res, await todoService.ignoreCandidates({ id: firstParam(body.id), all: Boolean(body.all) }));
				},
			],
			["POST", "/todos/candidates-clear", async (req, res) => sendOk(res, await todoService.clearCandidates())],
		);

		for (const [method, path, handler] of routes) {
			const off = host.route?.(method, path, (req, res) => {
				Promise.resolve()
					.then(() => handler(req, res))
					// 待办的写操作会改变「逾期 + 今天」的数量：顺手更新顶栏徽标（不让它等到下次重启）。
					.then(() => {
						if (method === "POST" && path.startsWith("/todos")) publishTodoBadge();
					})
					.catch((err) => {
						if (err instanceof CliError) log("warn", `feishu-pro ${method} ${path}: ${err.message}`);
						else log("warn", `feishu-pro ${method} ${path} failed: ${String(err?.message || err)}`);
						sendFail(res, err);
					});
			});
			if (typeof off === "function") disposers.push(off);
		}

		/* -------------------------------- AI 工具 -------------------------------- */

		host.registerTool?.({
			name: "feishu_pro",
			label: "飞书 Pro",
			description:
				"Work with Feishu (Lark) through the official lark-cli: search contacts and cloud docs, read documents as markdown, browse wiki spaces, list chats, read recent chat messages (served from a local cache when that chat was already fetched), search those cached messages offline, send a text message, and check which identity layer is ready.",
			promptSnippet: "find a Feishu chat, read it, and send a message",
			promptGuidelines: [
				"Every call runs through lark-cli; failure means the CLI is missing, logged out, or lacks a scope — read `hint` before retrying",
				"Use action=doc_read before summarizing a document, and cite the returned url instead of pasting long text",
				"Ask the user before repeating phone numbers, emails, or other personal data returned by contacts",
				"Use action=im_chats first when you do not know a chat id; a p2p chat only shows up when it is watched or discovered, so fall back to open_id from contacts",
				"action=im_messages reads the local cache first (via=cache) and only pulls from Feishu when that chat was never fetched; pass refresh=true only when the user needs truly current content",
				"action=im_search looks through the locally cached messages without calling Feishu — prefer it over re-reading a chat to find an earlier line",
				"action=im_send posts as the signed-in person unless as=bot: confirm recipient and wording with the user, and reuse the same uuid when retrying so nothing is sent twice",
				"action=status reports the background sync engine (DMs and groups share one poller): check it before claiming no new messages arrived",
			],
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: [
							"status",
							"contacts",
							"departments",
							"doc_search",
							"doc_list",
							"doc_read",
							"wikis",
							"wiki_nodes",
							"im_chats",
							"im_messages",
							"im_search",
							"im_send",
							"probe",
						],
						description: "The Feishu action to perform.",
					},
					query: {
						type: "string",
						description:
							"contacts/doc_search: keyword (person name or doc title). im_chats: filter by chat name. im_search: text to look up in the locally cached messages.",
					},
					limit: { type: "number", description: "Maximum items to return (default 20, max 50)." },
					department_id: {
						type: "string",
						description: "contacts/departments: department open_department_id; '0' or omitted means root.",
					},
					space_id: { type: "string", description: "wiki_nodes: wiki space id from action=wikis." },
					parent_node: { type: "string", description: "wiki_nodes/doc_list: parent node token (empty = root)." },
					folder_token: { type: "string", description: "doc_list: drive folder token (empty = my space root)." },
					token: { type: "string", description: "doc_read: document token (docx token or wiki node token)." },
					doc_type: {
						type: "string",
						enum: ["docx", "doc", "wiki", "sheet", "bitable", "mindnote", "file"],
						description: "doc_read: object type hint (default docx).",
					},
					chat_id: {
						type: "string",
						description:
							"im_messages/im_send: target chat id (oc_…), group or p2p. Omit when using open_id. im_search: optional chat filter (comma separated).",
					},
					chat_types: {
						type: "string",
						enum: ["all", "p2p", "group"],
						description: "im_chats: which kinds of chat to return (default all).",
					},
					open_id: {
						type: "string",
						description:
							"im_messages/im_send: peer open_id (ou_…); resolves the existing p2p chat without sending a probe message.",
					},
					text: { type: "string", description: "im_send: plain-text body (max 4000 chars)." },
					as: {
						type: "string",
						enum: ["user", "bot"],
						description: "im_send: send identity, default user (the signed-in person).",
					},
					uuid: {
						type: "string",
						description: "im_send: idempotency key (max 50 chars); reuse it when retrying the same send.",
					},
					since: {
						type: "string",
						description: "im_messages/im_search: ISO time or epoch seconds/milliseconds; only messages at or after it.",
					},
					refresh: {
						type: "boolean",
						description: "im_messages: force a fresh pull from Feishu instead of the local cache.",
					},
					page_token: {
						type: "string",
						description: "im_messages: page token from a previous call (paging goes backwards in time).",
					},
					dry_run: {
						type: "boolean",
						description: "im_send: validate and return the plan without sending anything.",
					},
				},
				required: ["action"],
			},
			async execute(args = {}) {
				const action = String(args.action || "");
				const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
				/**
				 * 工具级取数：只走 lark-cli（OpenAPI 回落已随凭证链下线）。
				 * 返回 { value, via }，数组也能安全包（不走对象展开）。
				 */
				const toolCli = async (cliCall) => {
					if (!(await cliReady())) throw await cliSetupError();
					return { value: await cliCall((argv, opts) => cliRunner.run(argv, opts)), via: "lark-cli" };
				};
				switch (action) {
					case "status": {
						const cli = await cliStatus().catch(() => null);
						return JSON.stringify(
							{
								// 只有一条通道：lark-cli。action 就是下一步该做的事（install|config|login|""）。
								larkCli: cli
									? {
											installed: cli.installed,
											version: cli.version,
											source: cli.source,
											configured: cli.configured,
											loggedIn: cli.loggedIn,
											users: (cli.users ?? []).slice(0, 3).map((u) => u.name || u.openId),
											action: cli.action || "",
										}
									: null,
								// 后台消息同步引擎（私聊 + 群共用一个轮询）的自述：agent 判断
								// 「到底有没有在同步 / 为什么没新消息 / 是不是该让用户去开同步」全靠它。
								// 只给计数与开关，不给会话清单（那是几 KB 噪音，要清单用 im_chats）。
								sync: (() => {
									const dm = dmWatcher.status();
									const cand = dm.candidates || {};
									const unreadTotal = Object.values(dm.unread || {}).reduce((acc, n) => acc + (Number(n) || 0), 0);
									return {
										running: Boolean(dm.running),
										intervalSec: Number(dm.config?.intervalSec) || 0,
										scope: {
											dm: Boolean(dm.config?.autoDiscover),
											groups: Boolean(dm.config?.syncGroups),
											pinned: Number(cand.explicit) || 0,
										},
										candidates: {
											total: Number(cand.total) || 0,
											p2p: Number(cand.p2p) || 0,
											groups: Number(cand.groups) || 0,
										},
										lastPoll: dm.lastPoll ?? null,
										unreadTotal,
										error: dm.lastError || "",
									};
								})(),
								hint: cli?.loggedIn
									? "lark-cli ready: every action goes through the CLI"
									: "lark-cli not ready: finish install → config init → auth login in the plugin settings",
							},
							null,
							2,
						);
					}
					case "contacts": {
						const { value: result, via } = await toolCli((run) => searchUsersViaCli(run, { query: args.query, limit }));
						return JSON.stringify(
							{
								via,
								identity: result.identity,
								degraded: result.degraded,
								deptScopeDenied: Boolean(result.deptScopeDenied),
								note: result.note ?? "",
								items: result.items.map((u) => ({
									name: u.name,
									openId: u.openId,
									jobTitle: u.jobTitle,
									department: u.department || (u.departmentIds ?? []).join(",") || "",
									email: u.email,
								})),
							},
							null,
							2,
						);
					}
					case "departments": {
						const parentId = String(args.department_id || "0");
						const { value: items, via } = await toolCli((run) =>
							listDepartmentsViaCli(run, { parentId, pageSize: limit }).then((r) => r.items),
						);
						return JSON.stringify({ via, items }, null, 2);
					}
					case "doc_search": {
						const { value: result, via } = await toolCli((run) =>
							searchDocsViaCli(run, { query: args.query, count: limit, cfg: runtime() }),
						);
						return JSON.stringify(
							{
								via,
								total: result.total,
								items: result.items.map((d) => ({ title: d.title, type: d.type, token: d.token, url: d.url })),
							},
							null,
							2,
						);
					}
					case "doc_list": {
						const folderToken = String(args.folder_token || "");
						const { value: result, via } = await toolCli((run) =>
							listDriveFilesViaCli(run, { folderToken, pageSize: limit, cfg: runtime() }),
						);
						return JSON.stringify(
							{
								via,
								items: result.items.map((d) => ({
									title: d.title,
									type: d.type,
									token: d.token,
									url: d.url,
									updatedAt: d.updatedAt,
								})),
							},
							null,
							2,
						);
					}
					case "doc_read": {
						if (!args.token) throw new Error("doc_read 需要 token");
						// readDoc 内部已是「CLI 优先 + 回落」，这里只把结果裁成模型友好的形状：
						// 正文给 markdown（结构化），超长截断 —— 绝不把 markdown/plain/content 三份塞进上下文。
						const doc = await readDoc({ token: String(args.token), type: String(args.doc_type || "docx") });
						const markdown = String(doc.markdown ?? "").trim();
						const text = markdown || String(doc.content ?? "");
						const LIMIT = 12000;
						const clipped =
							text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n…（已截断，原文 ${text.length} 字）` : text;
						return JSON.stringify(
							{
								ok: doc.ok !== false,
								via: doc.via ?? "",
								title: doc.title || "",
								type: doc.type || "docx",
								url: doc.url || "",
								chars: text.length,
								truncated: Boolean(doc.truncated) || text.length > LIMIT,
								format: markdown ? "markdown" : "text",
								content: clipped,
								...(doc.error ? { error: doc.error } : {}),
							},
							null,
							2,
						);
					}
					case "wikis": {
						const { value: result, via } = await toolCli((run) => listWikiSpacesViaCli(run, { pageSize: limit }));
						return JSON.stringify({ via, items: result.items }, null, 2);
					}
					case "wiki_nodes": {
						if (!args.space_id) throw new Error("wiki_nodes 需要 space_id（先用 action=wikis 取）");
						const spaceId = String(args.space_id);
						const parentNodeToken = String(args.parent_node || "");
						const { value: result, via } = await toolCli((run) =>
							listWikiNodesViaCli(run, { spaceId, parentNodeToken, pageSize: limit, cfg: runtime() }),
						);
						return JSON.stringify(
							{
								via,
								items: result.items.map((d) => ({
									title: d.title,
									type: d.type,
									token: d.token,
									nodeToken: d.nodeToken,
									url: d.url,
									hasChild: d.hasChild,
								})),
							},
							null,
							2,
						);
					}
					case "im_chats": {
						// agent 读消息/发消息都需要 chat_id，但界面之外没人告诉它 —— 这里是发现入口。
						// 注意：个人身份能拿到 p2p（群也能），机器人身份只能列群（官方限制，在 CLI 层已处理）。
						const pageSize = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
						const { value: listed, via } = await toolCli((run) =>
							fetchChatsViaCli(run, { as: "user", pageSize, pageToken: String(args.page_token || "") }),
						);
						const wanted = String(args.chat_types || "all").toLowerCase();
						const dm = dmWatcher.status();
						const watched = new Set(parseChatIds(dm.config?.chatIds));
						const unread = dm.unread ?? {};
						const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
						const keyword = String(args.query || "")
							.trim()
							.toLowerCase();
						// 合上「手动监听但不在列表里」的会话：那些往往是单聊（飞书不给完整 p2p 列表）。
						const merged = mergeChatSources(listed.chats, [...watched], known);
						const items = merged
							.map((chat) => ({
								chatId: chat.id,
								name: String(chat.name || ""),
								mode: chat.p2p ? "p2p" : String(chat.mode || "unknown"),
								watched: watched.has(chat.id),
								unread: Number(unread[chat.id] || 0),
							}))
							.filter((chat) =>
								wanted === "p2p" ? chat.mode === "p2p" : wanted === "group" ? chat.mode !== "p2p" : true,
							)
							.filter((chat) => (keyword ? `${chat.name} ${chat.chatId}`.toLowerCase().includes(keyword) : true))
							.slice(0, pageSize);
						return JSON.stringify(
							{
								via,
								identity: listed.identity,
								total: merged.length,
								count: items.length,
								hasMore: listed.hasMore,
								pageToken: listed.pageToken,
								items,
								...(items.length === 0
									? {
											note: "没找到符合条件的会话：飞书不给「我的全部私聊」列表，p2p 只能靠监听/自动发现或手填 chat_id",
										}
									: {}),
							},
							null,
							2,
						);
					}
					case "im_messages": {
						// 缓存优先：与界面同一条路（`chatMessagesPayload`）。缓存里有这条会话就直接给，
						// 不再 spawn 一次 CLI；只有「从没拉过 / 显式 refresh」才真去打飞书。
						// 发消息仍然只有 CLI 一条路（见 im_send）。
						if (!args.chat_id && !args.open_id) throw new Error("im_messages 需要 chat_id 或 open_id");
						if (args.open_id && !args.chat_id && !(await cliReady())) throw await cliSetupError();
						const data = await readChatMessages({
							chatId: args.chat_id,
							openId: args.open_id,
							limit,
							pageToken: String(args.page_token || ""),
							since: args.since,
							refresh: Boolean(args.refresh),
						});
						return JSON.stringify(data, null, 2);
					}
					case "im_search": {
						// 二次检索：只翻本地缓存（后台轮询 + 打开过的会话 + 之前 im_messages 拉过的），
						// 不打飞书接口、不花配额，适合「刚才那句是谁说的 / 找一下那条链接」。
						await chatCache.load();
						const keyword = String(args.query || "").trim();
						const chatIds = parseChatIds(args.chat_id || "");
						const result = chatCache.search({
							query: keyword,
							chatIds,
							limit,
							sinceMs: parseSince(args.since),
						});
						const self = await selfOpenId();
						const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
						const items = result.hits.map((hit) => ({
							chatId: hit.chatId,
							chatName: String(known[hit.chatId]?.name || chatCache.namesFor([hit.senderId])[hit.senderId] || ""),
							at: isoOf(hit.createTimeMs),
							from:
								hit.senderId === self ? "我" : chatCache.namesFor([hit.senderId])[hit.senderId] || hit.senderName || "",
							self: Boolean(self) && hit.senderId === self,
							type: hit.msgType,
							text: clipText(hit.text || hit.richText || "", MESSAGE_TEXT_CAP),
							snippet: hit.snippet,
						}));
						return JSON.stringify(
							{
								via: "cache",
								query: keyword,
								scanned: result.scanned,
								count: items.length,
								items,
								...(items.length === 0
									? {
											note: "本地缓存没有命中：先用 action=im_messages 打开相关会话（会拉一批并缓存），或等后台轮询预热；im_search 不查飞书服务端",
										}
									: {}),
							},
							null,
							2,
						);
					}
					case "im_send": {
						if (!(await cliReady())) throw await cliSetupError();
						const data = await sendChatText({
							chatId: args.chat_id,
							openId: args.open_id,
							text: args.text,
							as: args.as,
							uuid: args.uuid,
							dryRun: Boolean(args.dry_run),
						});
						return JSON.stringify(data, null, 2);
					}
					case "probe": {
						// 权限探针随 OpenAPI 通道一起下线；现在探的是 CLI 自己的健康状态（auth list / doctor 口径）。
						const cli = await cliStatus().catch(() => null);
						return JSON.stringify(
							{
								ok: Boolean(cli?.installed && cli?.loggedIn),
								installed: Boolean(cli?.installed),
								configured: Boolean(cli?.configured),
								loggedIn: Boolean(cli?.loggedIn),
								version: cli?.version ?? "",
								source: cli?.source ?? "",
								users: (cli?.users ?? []).map((u) => ({ name: u.name, openId: u.openId })),
								action: cli?.action ?? "install",
								candidates: (cli?.candidates ?? []).map((c) => ({ source: c.source, ok: c.ok, version: c.version })),
							},
							null,
							2,
						);
					}
					default:
						throw new Error(`Unknown action: ${action}`);
				}
			},
		});

		/* ------------------------------ AI 待办工具 ------------------------------ */
		//
		// 为什么不并进 feishu_pro：那个工具是「读飞书」，这个是「管我自己的事」——
		// 两件事的参数面完全不同，混在一个 enum 里模型会选错。
		host.registerTool?.({
			name: "feishu_todo",
			label: "飞书待办",
			description:
				"Manage the user's own to-do list kept by this pi-web-ui instance: list items, add or update one, produce a one-shot briefing for today, generate an AI plan for an item, run one of that plan's actions, and turn the background auto sync/extract on or off.",
			promptSnippet: "read and manage the user's to-do list",
			promptGuidelines: [
				"Use action=list before answering what the user still owes or what is due soon",
				"Use action=briefing when the user asks what to do first today; it returns a summary plus ordered ids (cached for 30 minutes)",
				"Add an item the moment the user asks to remember something; keep `title` under 40 chars and put the rest in `detail`",
				"Set to_feishu=true only when the user wants the item to exist in Feishu Tasks too (it creates a real remote task)",
				"action=advise only writes a plan (summary + steps + actions); action=handle kind=agent starts a real background run — confirm intent first",
				"Never mark an item done unless the user said it is done; action=sync only imports Feishu tasks and never deletes local items",
				"action=config turns the periodic auto sync/extract on or off; only do it when the user asks for it (it spends model quota)",
			],
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["list", "add", "update", "advise", "briefing", "handle", "mute", "sync", "config"],
						description: "The to-do action to perform.",
					},
					force: {
						type: "boolean",
						description: "briefing: regenerate even when the cached briefing is still fresh.",
					},
					id: { type: "string", description: "update/advise/handle/mute: the todo id from action=list." },
					title: { type: "string", description: "add: short title (max 40 chars)." },
					detail: { type: "string", description: "add/update: the full context, quote the original message if any." },
					due_at: {
						type: "string",
						description: "add/update: due date as YYYY-MM-DD (local) or an ISO timestamp; empty clears it.",
					},
					priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "add/update: priority." },
					status: { type: "string", enum: ["open", "doing", "done", "dropped"], description: "update: new status." },
					action_id: { type: "string", description: "handle: which planned action to run (from action=advise)." },
					kind: {
						type: "string",
						enum: ["reply", "agent", "insert", "open"],
						description: "handle: run the planned action of this kind when action_id is unknown.",
					},
					query: { type: "string", description: "list: filter by keyword." },
					limit: { type: "number", description: "list: max items (default 20, max 50)." },
					to_feishu: {
						type: "boolean",
						description: "add: also create the matching Feishu task (kept in sync afterwards). Default false.",
					},
					auto_sync: { type: "boolean", description: "config: periodically pull Feishu tasks in the background." },
					auto_extract: {
						type: "boolean",
						description:
							"config: periodically extract to-do candidates from locally cached chat messages (spends model quota).",
					},
					interval_min: { type: "number", description: "config: auto interval in minutes (15–360, default 30)." },
				},
				required: ["action"],
			},
			execute: async (args = {}) => {
				const action = String(args.action || "list");
				const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
				const clipped = (todo) => ({
					id: todo.id,
					title: todo.title,
					status: todo.status,
					priority: todo.priority,
					dueAt: todo.dueAt ? new Date(todo.dueAt).toISOString() : "",
					source: todo.source,
					detail: todo.detail ? String(todo.detail).slice(0, 600) : "",
					advice: todo.advice
						? {
								summary: todo.advice.summary,
								steps: todo.advice.steps,
								actions: (todo.advice.actions || []).map((item) => ({
									id: item.id,
									kind: item.kind,
									label: item.label,
									run: Boolean(item.ranAt),
								})),
							}
						: null,
					history: (todo.history || []).slice(0, 3).map((row) => row.text),
				});
				await todoService.load();
				switch (action) {
					case "list": {
						const snap = todoService.snapshot();
						const needle = String(args.query || "")
							.trim()
							.toLowerCase();
						const items = snap.items
							.filter((todo) => (needle ? `${todo.title} ${todo.detail}`.toLowerCase().includes(needle) : true))
							.slice(0, limit)
							.map(clipped);
						return JSON.stringify({ ...snap.stats, capabilities: snap.capabilities, items }, null, 2);
					}
					case "add": {
						const { todo, writeBack } = await todoService.create({
							title: args.title,
							detail: args.detail,
							priority: args.priority,
							dueAt: args.due_at,
							source: "agent",
							toFeishu: Boolean(args.to_feishu),
						});
						return JSON.stringify({ ok: true, todo: clipped(todo), writeBack: writeBack || null }, null, 2);
					}
					case "update": {
						const patch = {};
						for (const key of ["status", "priority", "title", "detail"]) {
							if (args[key] !== undefined) patch[key] = args[key];
						}
						if (args.due_at !== undefined) patch.dueAt = args.due_at;
						const result = await todoService.update({ id: args.id, patch });
						return JSON.stringify(
							{ ok: true, todo: clipped(result.todo), writeBack: result.writeBack || null },
							null,
							2,
						);
					}
					case "advise": {
						const result = await todoService.advise({
							ids: args.id ? [String(args.id)] : [],
							force: Boolean(args.id),
							limit: args.id ? 1 : TODO_ADVICE_LIMIT,
						});
						const items = result.snapshot.items.filter((todo) => result.results.some((row) => row.id === todo.id));
						return JSON.stringify({ ok: true, results: result.results, items: items.map(clipped) }, null, 2);
					}
					case "briefing": {
						const out = await todoService.briefing({ force: Boolean(args.force) });
						const brief = out.briefing || null;
						return JSON.stringify(
							{
								ok: true,
								summary: brief?.summary || "",
								order: (brief?.order || []).map((row) => ({
									id: row.id,
									title: out.snapshot.items.find((item) => item.id === row.id)?.title || "",
									why: row.why,
								})),
								drop: (brief?.drop || []).map((row) => ({
									id: row.id,
									title: out.snapshot.items.find((item) => item.id === row.id)?.title || "",
									why: row.why,
								})),
							},
							null,
							2,
						);
					}
					case "handle": {
						const snap = todoService.snapshot();
						const todo = snap.items.find((item) => item.id === String(args.id || ""));
						if (!todo) throw new Error("待办不存在：先用 action=list 取 id");
						const wanted = String(args.kind || "");
						const target =
							(todo.advice?.actions || []).find((item) => item.id === String(args.action_id || "")) ||
							(todo.advice?.actions || []).find(
								(item) => !item.ranAt && item.kind !== "open" && (!wanted || item.kind === wanted),
							);
						if (!target) throw new Error("这条待办没有可执行动作：先 action=advise 生成建议，或直接 update 改状态");
						const result = await todoService.execute({ id: todo.id, actionId: target.id });
						return JSON.stringify(
							{
								ok: true,
								ran: target.kind,
								...(result.directive ? { directive: result.directive } : {}),
								...(result.sent ? { sent: true } : {}),
								...(result.started ? { started: true, runId: result.runId } : {}),
								...(result.alreadyRan ? { alreadyRan: true } : {}),
							},
							null,
							2,
						);
					}
					case "mute": {
						const result = await todoService.muteAdvice(args.id);
						return JSON.stringify({ ok: true, todo: clipped(result.todo) }, null, 2);
					}
					case "sync": {
						return JSON.stringify({ ok: true, ...(await todoService.sync()) }, null, 2);
					}
					case "config": {
						const patch = {};
						if (args.auto_sync !== undefined) patch.autoSync = Boolean(args.auto_sync);
						if (args.auto_extract !== undefined) patch.autoExtract = Boolean(args.auto_extract);
						if (args.interval_min !== undefined) patch.intervalMin = Number(args.interval_min);
						patch.restart = true;
						const result = await todoService.setConfig(patch);
						armTodoAuto();
						return JSON.stringify({ ok: true, ...result.snapshot.config, nextAutoAt: result.nextAutoAt }, null, 2);
					}
					default:
						throw new Error(`Unknown action: ${action}`);
				}
			},
		});

		host.log?.("info", "feishu-pro activated（lark-cli 单一通道）");

		// 预热 CLI 身份：dm-watch 判断"自己发的消息"/"是否已登录"、以及界面首屏都靠它，
		// 不能等到第一次 /state 才填（否则私聊提醒会先显示一轮"需要先完成登录"）。
		void cliStatus()
			.then((status) => {
				const user = status?.users?.[0] ?? null;
				currentOpenId = String(user?.openId ?? "");
				cliLoggedIn = Boolean(status?.loggedIn);
			})
			.catch(() => {});

		// 先把本地配置读进来（status 里 running 才准），启用过就按配置跑起来。
		await dmWatcher.load().catch(() => {});
		void dmWatcher.start();

		return () => {
			// 卸载/重载前把缓存写下去：否则最后 5s 的增量会白丢（下次打开会话得重新拉）。
			void chatCache.flush().catch(() => {});
			dmWatcher.stop();
			autoReplier?.stop();
			bgTask?.unregister?.();
			bgTask = null;
			if (todoAutoTimer) clearTimeout(todoAutoTimer);
			todoAutoTimer = null;
			todoBgTask?.unregister?.();
			todoBgTask = null;
			for (const off of disposers.splice(0)) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
		};
	},
};
