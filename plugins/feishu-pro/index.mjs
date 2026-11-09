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
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createDmWatcher, isValidChatId, parseChatIds } from "./lib/dm-watch.mjs?v=0.12.0";
import {
	CHAT_INFO_KEY,
	chatCounts,
	chatSections,
	chatLink,
	collectSenders,
	inferChatMode,
	mergeChatInfo,
	mergeChatSources,
	MESSAGE_TEXT_LIMIT,
	normalizeSendIdentity,
	isValidOpenId,
	pickPeerFromMessages,
} from "./lib/chats.mjs?v=0.12.0";
import { normalizeOrderBy, toMs } from "./lib/docs.mjs";
// AI 待办：本地库（纯函数）+ 服务层 + 飞书任务适配（lark-cli `api` 兜底）。
import { createTodoService } from "./lib/todo-service.mjs?v=0.12.0";
import {
	createTask as createTaskViaCli,
	listMyTasks as listMyTasksViaCli,
	setTaskDone as setTaskDoneViaCli,
	updateTask as updateTaskViaCli,
} from "./lib/cli-tasks.mjs?v=0.12.0";
import { TODO_ADVICE_LIMIT } from "./lib/todo-store.mjs?v=0.12.0";
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
import { createDmCliChannel } from "./lib/cli-chats.mjs?v=0.12.0";
import {
	AUTO_CONFIG_KEY,
	AUTO_DEFAULT_CONFIG,
	createAutoReplier,
	matchAutoReply,
	normalizeAutoConfig,
} from "./lib/auto-reply.mjs?v=0.12.0";
import {
	fetchChatInfo as fetchChatInfoViaCli,
	fetchChatMessages as fetchChatMessagesViaCli,
	fetchChats as fetchChatsViaCli,
	fetchUserNames as fetchUserNamesViaCli,
	resolveP2pChatId as resolveP2pChatIdViaCli,
	sendText as sendTextViaCli,
} from "./lib/cli-chats.mjs?v=0.12.0";

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
export { isValidOpenId, normalizeSendIdentity } from "./lib/chats.mjs?v=0.12.0";
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
} from "./lib/todo-store.mjs?v=0.12.0";
export {
	buildAdvicePrompt,
	buildAgentTask,
	buildExtractPrompt,
	extractJson,
	parseAdviceReply,
	parseExtractReply,
} from "./lib/todo-ai.mjs?v=0.12.0";
export { listMyTasks as listMyTasksShape, normalizeCliTask } from "./lib/cli-tasks.mjs?v=0.12.0";
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

function sendFail(res, err) {
	// CLI 错误带「下一步该干什么」（装/配置/登录），不能被当成普通 500 抹平。
	if (err instanceof CliError) {
		sendJson(res, toCliErrorPayload(err));
		return;
	}
	sendJson(res, toErrorPayload(err));
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
					? "没找到 lark-cli：到「设置 → lark-cli」点「复制安装命令」，装完点「重新检测」"
					: action === "config"
						? "lark-cli 还没配置应用：到「设置 → lark-cli」点「配置应用」（浏览器里走官方设备码）"
						: "lark-cli 还没登录个人账号：到「设置 → lark-cli」点「登录账号」";
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

		/* ---------------------------- 私聊提醒（轮询） ---------------------------- */
		//
		// 飞书事件订阅 `im.message.receive_v1` 只推「机器人收到的消息」，人类账号的私聊
		// 没有事件；也没有「我的会话列表 / 未读数」这类个人身份接口。所以只能按间隔
		// 拉 `im/v1/messages` 增量。首次只建基线不通知、水位严格大于、自己发的不报 ——
		// 这些取舍都写在 lib/dm-watch.mjs 文件头，单测见 tests/unit/feishu-pro-dm-watch.test.ts。
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
				void autoReplier?.onMessages(list);
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
					"发消息缺权限：到「设置 → lark-cli」点「登录账号」重新授权一次（这次会带上 im:message.send_as_user）",
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

		/**
		 * 读会话消息 → 模型友好的窄行（时间升序）。
		 * 姓名只是装饰：查不到就退化成 open_id 尾巴，不影响正文。
		 */
		async function readChatMessages({ chatId = "", openId = "", limit = 20, pageToken = "", since = "" } = {}) {
			const target = await resolveChatTarget({ chatId, openId });
			if (!target.chatId) throw new Error("这个 open_id 解析不出单聊：群聊请直接给 chat_id（oc_ 开头）");
			const self = await selfOpenId();
			const result = await fetchChatMessagesViaCli((args, opts) => cliRunner.run(args, opts), target.chatId, {
				as: "user",
				pageSize: limit,
				pageToken,
				selfOpenId: self,
			});
			let names = {};
			try {
				names =
					(
						await fetchUserNamesViaCli(
							(args, opts) => cliRunner.run(args, opts),
							collectSenders(result.items, { selfOpenId: self }),
							{ as: "user" },
						)
					).names || {};
			} catch {
				names = {};
			}
			const sinceMs = parseSince(since);
			const rows = result.items
				.filter((row) => !sinceMs || (Number(row.createTimeMs) || 0) >= sinceMs)
				.map((row) => ({
					id: row.id,
					at: isoOf(row.createTimeMs),
					from: row.self
						? "我"
						: names[row.senderId] || row.senderName || (row.senderId ? `…${String(row.senderId).slice(-6)}` : "未知"),
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
				info = known[result.chatId] || {};
			} catch {
				info = {};
			}
			return {
				via: "lark-cli",
				chatId: result.chatId,
				self,
				mode: String(info.mode || "unknown"),
				name: String(info.name || (target.openId ? names[target.openId] : "") || ""),
				identity: result.identity,
				count: kept.length,
				omitted: rows.length - kept.length,
				hasMore: result.hasMore,
				pageToken: result.pageToken,
				items: kept,
			};
		}

		/* ------------------------ 私聊自动问答（onNew → chat → 回包） ------------------------ */
		//
		// 闭环：dm-watch 轮询出新消息 → 引擎判定该不该回（白名单/冷却/限频/陈旧）→ host.chat 无头跑一轮
		// → 收 assistant 文本 → 以「我」或机器人身份发回去。
		//
		// 三道安全闸：默认关闭、白名单空则谁都不回、`dryRun` 可先只看不发。
		// 回包失败**不重试**（与发送同一条铁律：宁可少发，不可重发）。
		// 顶栏「后台任务」条（先声明再赋值：引擎的 onActivity 会引用它）。
		let bgTask = null;
		autoReplier = createAutoReplier({
			storage: host.storage,
			chat: (req) => host.chat(req),
			send: (args) => sendChatText(args),
			log,
			notify: (level, content, contentEn) => host.notify?.(level, content, contentEn),
			onActivity: (snapshot) => {
				// 顶栏「后台任务」条：队列里有没有在跑、上次回给谁、错了什么，一眼看得到。
				bgTask?.update({
					status: snapshot.enabled
						? `已启用 · 在跑 ${snapshot.inflight} · 本小时 ${snapshot.sentLastHour}${snapshot.lastError ? ` · 错误：${snapshot.lastError}` : ""}`
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
			// 提取待办的来源：用户主动监听的会话（飞书不给「我的全部聊天」，所以只能从监听的里找）。
			listSources: async () => {
				const watched = parseChatIds(dmWatcher.status()?.config?.chatIds);
				const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
				return watched.map((chatId) => ({
					chatId,
					name: String(known?.[chatId]?.name || known?.[chatId]?.label || ""),
				}));
			},
			readMessages: ({ chatId, limit }) => readChatMessages({ chatId, limit }),
			notify: (level, content) => host.notify?.(level, content),
			log,
		});
		await todoService.load().catch(() => {});
		// 待办派的 agent 运行也要认领：与自动回复共用 onRunEvent，但按 runId 各认各的。
		const offTodoRun = host.onRunEvent?.((ev) => {
			todoService.handleRunEvent(ev);
		});
		if (typeof offTodoRun === "function") disposers.push(offTodoRun);

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
					sendOk(res, { ...dmWatcher.status(), polled: result.messages.length, skipped: result.skipped ?? "" });
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
			[
				"GET",
				"/chats",
				async (req, res) => {
					const q = queryOf(req);
					if (!(await cliReady())) throw await cliSetupError();
					const listed = await fetchChatsViaCli((args, opts) => cliRunner.run(args, opts), { as: "user" });
					const watched = new Set(parseChatIds(dmWatcher.status().config?.chatIds));
					const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
					// CLI 已经按 active_time 排好序，不再逐会话预热"最后一条消息"（那是旧实现的最大成本）。
					const merged = mergeChatSources(listed.chats, [...watched], known);
					const decorated = merged.map((chat) => ({
						...chat,
						watched: watched.has(chat.id),
						link: chatLink(chat.id),
					}));
					const sections = chatSections(decorated);
					const p2pCount = decorated.filter((c) => c.p2p).length;
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
					const q = queryOf(req);
					const chatId = firstParam(q.chatId) || firstParam(q.id);
					const self = await selfOpenId();
					const result = await fetchChatMessagesViaCli((args, opts) => cliRunner.run(args, opts), chatId, {
						as: "user",
						pageSize: Number(firstParam(q.limit)) || undefined,
						pageToken: firstParam(q.pageToken),
						selfOpenId: self,
					});
					// 姓名是装饰：查不到就退化成 open_id 尾巴，不能让整页报错。
					let named = { names: {}, error: "" };
					try {
						named = await fetchUserNamesViaCli(
							(args, opts) => cliRunner.run(args, opts),
							collectSenders(result.items, { selfOpenId: self }),
							{ as: "user" },
						);
					} catch (err) {
						named = { names: {}, error: String(err?.message || err) };
					}
					const items = result.items.map((row) => ({
						...row,
						senderLabel: row.self ? "我" : named.names[row.senderId] || row.senderLabel,
					}));
					const peerId = pickPeerFromMessages(items, self);
					const peerName = named.names[peerId] || "";
					let inferred = { mode: "unknown", reason: "" };
					try {
						inferred = inferChatMode(items, { selfOpenId: self });
					} catch {
						/* 反推失败不影响读消息 */
					}
					// 会话类型兜底：chats_info 里不知道是单聊还是群时，用消息反推（权威来源仍是 chats/:id）。
					try {
						const known = (await host.storage?.get?.(CHAT_INFO_KEY)) || {};
						const prev = known[result.chatId];
						if ((!prev || prev.mode === "unknown" || prev.inferred) && inferred.mode !== "unknown") {
							await host.storage?.set?.(CHAT_INFO_KEY, {
								...known,
								[result.chatId]: {
									...(prev || {}),
									id: result.chatId,
									name: prev?.name || peerName || "",
									mode: inferred.mode,
									p2p: inferred.mode === "p2p",
									inferred: true,
									inferReason: inferred.reason,
									fetchedAt: Date.now(),
								},
							});
						}
					} catch {
						/* 反推写缓存失败不影响读消息 */
					}
					sendOk(res, {
						chatId: result.chatId,
						items,
						hasMore: result.hasMore,
						pageToken: result.pageToken,
						identity: result.identity,
						peer: { openId: peerId, name: peerName },
						label: peerName ? `与 ${peerName} 的私聊` : "",
						remembered: Boolean(chatId),
						inferredMode: inferred,
						namesError: named.error || "",
						link: chatLink(result.chatId),
						via: "lark-cli",
					});
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
					sendOk(res, sent);
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
					sendOk(res, { ...autoReplier.status(), hostChat: typeof host.chat === "function" });
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
						as: body.as,
						cooldownSec: body.cooldownSec,
						maxPerHour: body.maxPerHour,
						staleSec: body.staleSec,
						dryRun: body.dryRun,
						signature: body.signature,
					});
					sendOk(res, { ...autoReplier.status(), hostChat: typeof host.chat === "function" });
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
						id: last.id,
						senderName: last.from,
						senderType: "user",
						msgType: last.type,
						text: last.text,
						createTimeMs: Date.parse(last.at) || 0,
						self: Boolean(last.self),
					};
					sendOk(res, { chatId, message: last, ...(await autoReplier.preview(record)) });
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
				async (req, res) => sendOk(res, await todoService.extract({ limit: Number(bodyOf(req).limit) || 3 })),
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
			["POST", "/todos/candidates-clear", async (req, res) => sendOk(res, await todoService.clearCandidates())],
		);

		for (const [method, path, handler] of routes) {
			const off = host.route?.(method, path, (req, res) => {
				Promise.resolve()
					.then(() => handler(req, res))
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
				"Work with Feishu (Lark) through the official lark-cli: search contacts and cloud docs, read documents as markdown, browse wiki spaces, list chats, read recent chat messages, send a text message, and check which identity layer is ready.",
			promptSnippet: "find a Feishu chat, read it, and send a message",
			promptGuidelines: [
				"Every call runs through lark-cli; failure means the CLI is missing, logged out, or lacks a scope — read `hint` before retrying",
				"Use action=doc_read before summarizing a document, and cite the returned url instead of pasting long text",
				"Ask the user before repeating phone numbers, emails, or other personal data returned by contacts",
				"Use action=im_chats first when you do not know a chat id; a p2p chat only shows up when it is watched or discovered, so fall back to open_id from contacts",
				"action=im_send posts as the signed-in person unless as=bot: confirm recipient and wording with the user, and reuse the same uuid when retrying so nothing is sent twice",
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
							"im_send",
							"probe",
						],
						description: "The Feishu action to perform.",
					},
					query: {
						type: "string",
						description: "contacts/doc_search: keyword (person name or doc title). im_chats: filter by chat name.",
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
						description: "im_messages/im_send: target chat id (oc_…), group or p2p. Omit when using open_id.",
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
						description: "im_messages: ISO time or epoch seconds/milliseconds; only messages at or after it.",
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
						// 读消息 / 发消息是**写与读的分界**：只有 CLI 一条路（与 /chat/send 同口径），
						// 不提供换通道重试 —— 发两遍的代价比报错大得多。
						if (!(await cliReady())) throw await cliSetupError();
						const data = await readChatMessages({
							chatId: args.chat_id,
							openId: args.open_id,
							limit,
							pageToken: String(args.page_token || ""),
							since: args.since,
						});
						return JSON.stringify(data, null, 2);
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
				"Manage the user's own to-do list kept by this pi-web-ui instance: list items, add or update one, generate an AI plan for an item, run one of that plan's actions, and turn the background auto sync/extract on or off.",
			promptSnippet: "read and manage the user's to-do list",
			promptGuidelines: [
				"Use action=list before answering what the user still owes or what is due soon",
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
						enum: ["list", "add", "update", "advise", "handle", "mute", "sync", "config"],
						description: "The to-do action to perform.",
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
						description: "config: periodically extract to-do candidates from the watched chats (spends model quota).",
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
