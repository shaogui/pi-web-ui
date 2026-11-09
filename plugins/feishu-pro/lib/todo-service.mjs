/**
 * plugins/feishu-pro/lib/todo-service.mjs
 * 「AI 待办」服务层：把纯函数（todo-store / todo-ai）与宿主能力（storage / llm / chat / 飞书发送）拼起来。
 *
 * 为什么单独一层而不是塞进 index.mjs：这块有**副作用集中区**（写 storage、花模型额度、
 * 以用户名义发消息、派无头 agent 任务），必须能用假宿主端到端跑单测。
 * 依赖全部注入，本文件不 import 宿主、不读环境变量、不起定时器。
 *
 * 三道闸：
 *   1. `advise` 同一条待办在飞（inflight）时直接跳过 —— 连点两次不该花两份额度；
 *   2. `execute` 只执行**服务端存过的**动作（不信任前端传来的文本/收件人），发送带
 *      由 todo.id + action.id 推出的幂等键，重试不会发两遍；
 *   3. `agent` 动作的提示词由 `buildAgentTask` 固定生成，明确"只做这一件事、不确定就别发"。
 *
 * 双向同步（0.12.0）：
 *   - 新建：只有用户**显式勾了「同步飞书」**（`toFeishu`）才在飞书建任务，guid 落进 `ref`；
 *   - 编辑：`ref.kind === "task"` 的条目改标题/描述/截止/完成态 → PATCH 回飞书；
 *   - 失败一律"本地已改 + writeBack.warning"，并把 warning 记进历史（绝不假装同步成功）；
 *   - `autoRun()` 定时拉飞书任务 + 从监听会话提取候选 —— **调度器在 index.mjs**，
 *     本文件不起定时器（保持"纯服务 + 注入依赖"，单测能一行跑一遍）。
 */
import {
	TODO_ADVICE_LIMIT,
	TODO_CONFIG_KEY,
	TODO_LIMIT,
	TODO_STORE_KEY,
	applyTodoPatch,
	autoNextAt,
	isAdviceFresh,
	mergeCandidates,
	mergeFeishuTasks,
	normalizeAction,
	normalizeDeletedTaskIds,
	normalizeStore,
	normalizeTodo,
	normalizeTodoConfig,
	pickAdviceTargets,
	pushHistory,
	removeTodo,
	sortTodos,
	todoKeyOf,
	todoStats,
	upsertTodo,
	ADVICE_TTL_MS,
} from "./todo-store.mjs";
import {
	ADVICE_SYSTEM,
	EXTRACT_SYSTEM,
	buildAdvicePrompt,
	buildAgentTask,
	buildExtractPrompt,
	parseAdviceReply,
	parseExtractReply,
	replyUuidFor,
	sanitizeOutgoingText,
} from "./todo-ai.mjs";

/** 待办触发的无头运行走独立账号：与「私聊自动问答」的会话互不覆盖。 */
export const TODO_ACCOUNT_ID = "feishu-pro:todo";
/** 一次提取最多读几个会话、每个会话读多少条消息。 */
const EXTRACT_CHATS = 3;
const EXTRACT_PER_CHAT = 20;
const EXTRACT_MESSAGE_CAP = 60;
/** 同时在跑的 agent 上限（模型额度与机器资源都有限）。 */
const MAX_PENDING_RUNS = 4;

const str = (value, cap = 0) => {
	const out =
		typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
	return cap > 0 && out.length > cap ? out.slice(0, cap) : out;
};

/**
 * @param {object} deps
 * @param {object} deps.storage               host.storage（必需：get/set）
 * @param {object} [deps.llm]                 host.llm（一次性补全）
 * @param {(req: object) => Promise<any>} [deps.chat]  host.chat（无头 agent）
 * @param {(args: object) => Promise<any>} [deps.send] 飞书发文本（{chatId,text,uuid}）
 * @param {{list?: Function, setDone?: Function, create?: Function, update?: Function}} [deps.tasks] 飞书任务适配
 * @param {() => Promise<Array<{chatId:string,name:string}>>} [deps.listSources] 提取来源
 * @param {(args: object) => Promise<object>} [deps.readMessages] 读某个会话的最近消息
 * @param {(level: string, text: string) => void} [deps.notify]
 * @param {(level: string, text: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createTodoService(deps = {}) {
	const { storage, llm, chat, send, tasks, listSources, readMessages, notify, log } = deps;
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
		throw new Error("createTodoService 需要 storage（get/set）");
	}

	let store = normalizeStore(null, { now: now() });
	let autoConfig = normalizeTodoConfig(null, { now: now() });
	let loaded = false;
	let loading = null;
	/** 自动同步在跑时不再重入（定时器抖动 + 用户手点不能并发拿同一份库）。 */
	let autoRunning = false;
	/** 正在生成建议的待办（防连点重复烧额度）。 */
	const advising = new Set();
	/** runId → { todoId, text }：认领由本服务派出去的无头运行。 */
	const pendingRuns = new Map();

	const warn = (text) => {
		try {
			log?.("warn", `feishu-pro todo: ${text}`);
		} catch {
			/* ignore */
		}
	};

	function save() {
		store = {
			...store,
			items: sortTodos(store.items).slice(0, TODO_LIMIT),
			candidates: Array.isArray(store.candidates) ? store.candidates : [],
			updatedAt: now(),
		};
		try {
			storage.set(TODO_STORE_KEY, store);
		} catch (err) {
			warn(`写入待办失败：${String(err?.message || err)}`);
		}
	}

	function saveConfig() {
		autoConfig = normalizeTodoConfig({ ...autoConfig, updatedAt: now() }, { now: now() });
		try {
			storage.set(TODO_CONFIG_KEY, autoConfig);
		} catch (err) {
			warn(`写入自动获取配置失败：${String(err?.message || err)}`);
		}
	}

	async function load() {
		if (loaded) return store;
		if (loading) return loading;
		loading = Promise.resolve()
			.then(async () => {
				const [rawStore, rawConfig] = await Promise.all([
					storage.get(TODO_STORE_KEY, null),
					typeof storage.get === "function" ? storage.get(TODO_CONFIG_KEY, null) : null,
				]);
				store = normalizeStore(rawStore, { now: now() });
				autoConfig = normalizeTodoConfig(rawConfig, { now: now() });
				loaded = true;
				return store;
			})
			.catch((err) => {
				warn(`读取待办失败：${String(err?.message || err)}`);
				loaded = true;
				return store;
			})
			.finally(() => {
				loading = null;
			});
		return loading;
	}

	const find = (id) => store.items.find((todo) => todo.id === str(id, 64)) || null;

	/** 前端要的自描述快照：能做什么（llm/chat/send/飞书任务）、建议保鲜期、统计、自动获取状态。 */
	function snapshot() {
		return {
			items: sortTodos(store.items),
			candidates: Array.isArray(store.candidates) ? store.candidates : [],
			stats: todoStats(store.items, { now: now() }),
			syncedAt: store.syncedAt || 0,
			adviceTtlMs: ADVICE_TTL_MS,
			config: { ...autoConfig },
			nextAutoAt: autoNextAt(autoConfig, { now: now() }),
			autoRunning,
			capabilities: {
				advice: Boolean(llm && typeof llm.complete === "function"),
				agent: Boolean(chat && typeof chat === "function"),
				send: Boolean(send && typeof send === "function"),
				feishuTasks: Boolean(tasks && typeof tasks.list === "function"),
				taskWrite: Boolean(tasks && typeof tasks.create === "function" && typeof tasks.update === "function"),
				extract: Boolean(listSources && readMessages),
			},
		};
	}

	/** 在飞书建任务并挂到这条待办上（`ref = task:guid`，之后的编辑才会回写到同一条）。 */
	async function createInFeishu(todo) {
		if (!tasks || typeof tasks.create !== "function") {
			return { guid: "", warning: "飞书任务通道不可用：这条只存在本地" };
		}
		try {
			const out = await tasks.create({ title: todo.title, detail: todo.detail, dueAt: todo.dueAt });
			return { guid: str(out?.guid, 128), warning: str(out?.warning, 200) };
		} catch (err) {
			return { guid: "", warning: `飞书任务没建成（本地已保存）：${str(err?.message || err, 200)}` };
		}
	}

	/**
	 * 新增待办。`toFeishu: true` = 用户显式勾了「同步飞书」：同时建一条飞书任务，guid 记进 ref。
	 * 建失败**不回滚本地**（人已经把这件事故下来了），只如实回 `writeBack` 并记一笔历史。
	 */
	async function create(input = {}) {
		await load();
		let todo = normalizeTodo(
			{
				title: input.title,
				detail: input.detail,
				priority: input.priority,
				dueAt: input.dueAt,
				status: input.status,
				source: input.source || "manual",
				ref: input.ref,
			},
			{ now: now() },
		);
		if (!todo.title && !todo.detail) throw new Error("待办至少要有个标题");
		todo.history = pushHistory(todo, { kind: "create", text: "新建待办" }, { now: now() });
		let writeBack = null;
		if (input.toFeishu) {
			const created = await createInFeishu(todo);
			if (created.guid) {
				todo = normalizeTodo(
					{
						...todo,
						// 标题/截止由本地刚写下去，飞书侧是同一份 —— 下一轮自动同步不会把它当新条目。
						ref: { kind: "task", id: created.guid, title: todo.title },
					},
					{ now: now(), prev: todo },
				);
				todo.history = pushHistory(todo, { kind: "sync", text: "已在飞书创建同名任务" }, { now: now() });
				writeBack = { writeBack: true, warning: "" };
			} else {
				writeBack = { writeBack: false, warning: created.warning || "飞书任务没建成（本地已保存）" };
				todo.history = pushHistory(todo, { kind: "sync", text: writeBack.warning }, { now: now() });
			}
		}
		store = { ...store, items: upsertTodo(store.items, todo, { now: now() }) };
		save();
		return { todo: find(todo.id) || todo, snapshot: snapshot(), writeBack };
	}

	async function update({ id, patch } = {}) {
		await load();
		const target = find(id);
		if (!target) throw new Error("待办不存在（可能在另一个标签页里删掉了）");
		const { items, todo } = applyTodoPatch(store.items, target.id, patch, { now: now() });
		if (!todo) throw new Error("待办不存在");
		store = { ...store, items };
		save();
		// 标题 / 截止 / 完成态都要写回飞书：失败只是**本地已改**，必须如实回报给界面。
		const writeBack = await pushTask(todo, target);
		if (writeBack?.warning) {
			store = {
				...store,
				items: store.items.map((item) =>
					item.id === todo.id
						? { ...item, history: pushHistory(item, { kind: "sync", text: writeBack.warning }, { now: now() }) }
						: item,
				),
			};
			save();
		}
		return { todo: find(todo.id), snapshot: snapshot(), writeBack };
	}

	/** 写操作统一捞错：适配层理论上已经递 warning，这里兼容注入的假实现直接抛。 */
	async function guardWrite(run) {
		try {
			return await run();
		} catch (err) {
			return { writeBack: false, warning: `飞书任务没改成功（本地已更新）：${str(err?.message || err, 200)}` };
		}
	}

	/**
	 * 把本地改动回写飞书任务（只对 `ref.kind === "task"` 的条目）。
	 * - 标题/描述/截止 → PATCH 字段；
	 * - 完成/重开 → PATCH completed_at；
	 * 两段都可能跑（改了标题又勾了完成），warning 合成一条（只报第一个失败）。
	 * 只同步本地**真的改过**的字段：没改的东西不去碰飞书，避免覆盖同事在飞书侧的编辑。
	 */
	async function pushTask(todo, before) {
		const guid = str(todo?.ref?.id, 128);
		if (todo?.ref?.kind !== "task" || !guid) return null;
		if (!tasks || (typeof tasks.setDone !== "function" && typeof tasks.update !== "function")) {
			return { writeBack: false, warning: "飞书任务通道不可用：本地已改，飞书侧未改动" };
		}
		const fields = {};
		if (todo.title !== before.title && todo.title) fields.title = todo.title;
		if (todo.detail !== before.detail) fields.detail = todo.detail;
		if (todo.dueAt !== before.dueAt) fields.dueAt = todo.dueAt;
		const results = [];
		if (Object.keys(fields).length && typeof tasks.update === "function") {
			results.push(await guardWrite(() => tasks.update(guid, fields)));
		}
		const statusChanged = todo.status !== before.status;
		const completionChanged =
			statusChanged && (todo.status === "done" || (todo.status === "open" && before.status === "done"));
		if (completionChanged && typeof tasks.setDone === "function") {
			results.push(await guardWrite(() => tasks.setDone(guid, { done: todo.status === "done", now: now() })));
		}
		if (!results.length) return null;
		const failed = results.find((row) => row && row.writeBack === false);
		return failed
			? { writeBack: false, warning: failed.warning || "飞书任务没改成功（本地已更新）" }
			: { writeBack: true, warning: "" };
	}

	async function remove(id) {
		await load();
		const target = find(id);
		const before = store.items.length;
		const taskGuid = target?.ref?.kind === "task" ? str(target.ref.id, 128) : "";
		store = {
			...store,
			items: removeTodo(store.items, id),
			// 飞书任务不跟着删（删同事可见的任务是破坏性操作，得人去飞书里确认），
			// 但得记住「这条我已经删了」：否则下一轮自动同步又拉回来，删除看着像失效。
			...(taskGuid ? { deletedTaskIds: normalizeDeletedTaskIds([taskGuid, ...(store.deletedTaskIds || [])]) } : {}),
		};
		save();
		const removed = before - store.items.length > 0;
		const warning = removed && taskGuid ? "本地已删；飞书任务还在（下次同步不会拉回来，需要的话去飞书里删）" : "";
		return { removed, warning, snapshot: snapshot() };
	}

	/** 同步飞书任务：只读，失败降级（返回 warning，不动本地库）。 */
	async function sync() {
		await load();
		if (!tasks || typeof tasks.list !== "function") {
			return {
				added: 0,
				updated: 0,
				total: 0,
				syncedAt: store.syncedAt || 0,
				warning: "没有可用的飞书任务通道（lark-cli 未就绪）",
			};
		}
		let listed;
		try {
			listed = await tasks.list({ completed: false });
		} catch (err) {
			return {
				added: 0,
				updated: 0,
				total: 0,
				syncedAt: store.syncedAt || 0,
				warning: `读取飞书任务失败：${str(err?.message || err, 200)}`,
			};
		}
		const merged = mergeFeishuTasks(store.items, listed.items || [], {
			now: now(),
			skip: store.deletedTaskIds || [],
		});
		store = { ...store, items: merged.items, syncedAt: now() };
		save();
		return {
			added: merged.added,
			updated: merged.updated,
			total: merged.total,
			syncedAt: store.syncedAt,
			warning: "",
			via: listed.via || "",
		};
	}

	/**
	 * 能力降级：模型可能给出"本机做不到"的动作。
	 * - 没有无头 agent 通道 → `agent` 掏不出手，降为 `insert`（把任务描述交给人粘回去）；
	 * - 没有飞书发送通道 → `reply` 降为 `insert`（草稿留给自己）。
	 * 界面宁可少一个按钮，也不要给一个点了必错的按钮。
	 */
	function degradeActions(actions = []) {
		const canAgent = Boolean(chat && typeof chat === "function");
		const canSend = Boolean(send && typeof send === "function");
		return actions
			.map((action, index) => {
				if (action.kind === "agent" && !canAgent) {
					return normalizeAction(
						{ kind: "insert", label: "插入任务描述", text: action.task || action.label, ranAt: action.ranAt },
						{ index },
					);
				}
				if (action.kind === "reply" && !canSend) {
					return normalizeAction(
						{ kind: "insert", label: "插入回复草稿", text: action.text, ranAt: action.ranAt },
						{ index },
					);
				}
				return action;
			})
			.filter(Boolean);
	}

	/** 单条建议：已新鲜就跳过（除非 force），拿不到建议就把原因留在 note 里。 */
	async function adviseOne(todo, { force = false } = {}) {
		if (!llm || typeof llm.complete !== "function") throw new Error("宿主没有提供 llm 补全：无法生成建议");
		if (!force && isAdviceFresh(todo, { now: now() })) return { id: todo.id, skipped: "fresh" };
		if (advising.has(todo.id)) return { id: todo.id, skipped: "inflight" };
		advising.add(todo.id);
		try {
			const prompt = buildAdvicePrompt(todo, { now: now() });
			const result = await llm.complete({
				prompt,
				system: ADVICE_SYSTEM,
				maxChars: 1600,
				timeoutMs: 75_000,
			});
			if (!result?.ok) {
				return { id: todo.id, error: str(result?.error || "生成建议失败", 300) };
			}
			const parsed = parseAdviceReply(result.text, { todo, now: now(), model: result.model || "" });
			if (!parsed.advice) return { id: todo.id, error: parsed.note || "模型没有给出可用的建议" };
			parsed.advice.actions = degradeActions(parsed.advice.actions);
			const target = find(todo.id);
			if (!target) return { id: todo.id, error: "待办已被删除" };
			const next = normalizeTodo(
				{
					...target,
					priority: parsed.priority || target.priority,
					advice: parsed.advice,
					adviceMutedAt: 0,
					updatedAt: now(),
				},
				{ now: now(), prev: target },
			);
			store = { ...store, items: sortTodos(store.items.map((item) => (item.id === next.id ? next : item))) };
			save();
			return { id: todo.id, advice: next.advice, note: parsed.note, model: result.model || "" };
		} finally {
			advising.delete(todo.id);
		}
	}

	/**
	 * 批量建议：ids 缺省 = 自动挑最该看的几条（逾期/今天优先，最多 limit）。
	 * 串行执行：`host.llm.complete` 全局只有 4 路并发，串行反而更稳（也不会把额度一次烧完）。
	 */
	async function advise({ ids = [], force = false, limit = TODO_ADVICE_LIMIT } = {}) {
		await load();
		const wanted =
			Array.isArray(ids) && ids.length
				? ids.map((id) => find(id)).filter(Boolean)
				: pickAdviceTargets(store.items, { now: now(), limit });
		const results = [];
		for (const todo of wanted.slice(0, Math.max(1, limit))) {
			try {
				results.push(await adviseOne(todo, { force }));
			} catch (err) {
				results.push({ id: todo.id, error: str(err?.message || err, 300) });
			}
		}
		return { results, snapshot: snapshot() };
	}

	/**
	 * 执行建议里的一个动作。
	 * - `insert` / `open` 是纯前端指令（不产生副作用），服务端只回 directive；
	 * - `reply` 真的发消息（带幂等键）；`agent` 派一轮无头运行。
	 */
	async function execute({ id, actionId } = {}) {
		await load();
		const todo = find(id);
		if (!todo) throw new Error("待办不存在");
		const action = (todo.advice?.actions || []).find((item) => item.id === str(actionId, 32));
		if (!action) throw new Error("这条建议里没有该动作（可能已被刷新，重新生成一次）");
		if (action.ranAt) return { alreadyRan: true, action, snapshot: snapshot() };

		if (action.kind === "insert")
			return { directive: { type: "insert", text: action.text || "" }, snapshot: snapshot() };
		if (action.kind === "open") return { directive: { type: "open", url: action.url || "" }, snapshot: snapshot() };

		if (action.kind === "reply") {
			if (!send) throw new Error("宿主没有接飞书发送通道：无法直接回复");
			const chatId = str(action.chatId);
			if (!chatId) throw new Error("这条建议没有可发送的对话");
			const body = sanitizeOutgoingText(action.text);
			if (!body) throw new Error("草稿是空的");
			const uuid = replyUuidFor(todo, action);
			const sent = await send({ chatId, text: body, uuid });
			const marked = markActionRan(todo.id, action.id, { kind: "reply", text: `已发送：${body.slice(0, 120)}` });
			return { sent: true, result: sent, todo: marked, snapshot: snapshot() };
		}

		if (action.kind === "agent") {
			if (!chat) throw new Error("宿主没有提供无头 agent 通道：无法自动处理");
			const task = buildAgentTask(todo, { now: now(), action });
			const receipt = await chat({ text: task, accountId: TODO_ACCOUNT_ID });
			const runId = str(receipt?.runId, 128);
			if (runId) {
				while (pendingRuns.size >= MAX_PENDING_RUNS) {
					const oldest = pendingRuns.keys().next().value;
					pendingRuns.delete(oldest);
				}
				pendingRuns.set(runId, { todoId: todo.id, text: "" });
			}
			const marked = markActionRan(todo.id, action.id, {
				kind: "agent",
				text: `已派给 AI：${str(action.task || action.label, 120)}`,
				...(runId ? { ref: runId } : {}),
			});
			if (marked) {
				store = {
					...store,
					items: sortTodos(store.items.map((item) => (item.id === marked.id ? { ...item, status: "doing" } : item))),
				};
				save();
			}
			return {
				started: true,
				runId,
				conversationId: receipt?.conversationId || "",
				todo: find(todo.id),
				snapshot: snapshot(),
			};
		}

		throw new Error(`不支持的动作类型：${action.kind}`);
	}

	function markActionRan(todoId, actionId, entry) {
		const target = find(todoId);
		if (!target) return null;
		const actions = (target.advice?.actions || []).map((action) =>
			action.id === actionId ? { ...action, ranAt: now() } : action,
		);
		const next = normalizeTodo(
			{
				...target,
				advice: { ...(target.advice || {}), actions },
				history: pushHistory(target, entry, { now: now() }),
				updatedAt: now(),
			},
			{ now: now(), prev: target },
		);
		store = { ...store, items: sortTodos(store.items.map((item) => (item.id === next.id ? next : item))) };
		save();
		return next;
	}

	/** 无头运行的进度回收：assistant 文本先攒着，run_end 时一次性写进历史并通知。 */
	function handleRunEvent(ev = {}) {
		const runId = str(ev.runId, 128);
		if (!runId || !pendingRuns.has(runId)) return false;
		const job = pendingRuns.get(runId);
		if (ev.type === "message" && ev.message?.role === "assistant") {
			const text = assistantText(ev.message);
			if (text) job.text = text;
			return true;
		}
		if (ev.type !== "run_end") return false;
		pendingRuns.delete(runId);
		const summary = str(job.text, 400) || (ev.stopReason === "aborted" ? "运行被中止" : "AI 没有输出结论");
		const target = find(job.todoId);
		if (target) {
			// 处理完回到 open：要不要算完成由人决定（自动勾掉是越权）。
			const next = normalizeTodo(
				{
					...target,
					status: target.status === "doing" ? "open" : target.status,
					history: pushHistory(target, { kind: "agent-done", text: summary, ref: runId }, { now: now() }),
					updatedAt: now(),
				},
				{ now: now(), prev: target },
			);
			store = { ...store, items: sortTodos(store.items.map((item) => (item.id === next.id ? next : item))) };
			save();
		}
		try {
			notify?.("info", `待办「${str(target?.title, 40) || "已删除"}」处理完毕：${summary.split("\n")[0].slice(0, 60)}`);
		} catch {
			/* ignore */
		}
		return true;
	}

	function assistantText(message) {
		const content = message?.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.map((part) => (typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : ""))
				.join("")
				.trim();
		}
		if (typeof message?.text === "string") return message.text.trim();
		return "";
	}

	/** 从最近的消息里找待办（返回候选，同时落盘到 `store.candidates` 等“记下”）。 */
	async function extract({ limit = EXTRACT_CHATS } = {}) {
		await load();
		if (!llm || typeof llm.complete !== "function") throw new Error("宿主没有提供 llm 补全：无法提取待办");
		if (!listSources || !readMessages) throw new Error("没有可读的飞书会话通道");
		const sources = (await listSources()) || [];
		if (!sources.length) {
			throw new Error("还没有可读的会话：先到「会话」页监听一个私聊（或群），再回来提取");
		}
		const rows = [];
		for (const source of sources.slice(0, Math.max(1, limit))) {
			try {
				const read = await readMessages({ chatId: source.chatId, limit: EXTRACT_PER_CHAT });
				for (const message of read?.items || []) {
					rows.push({
						at: message.at || "",
						chat: source.name || read?.name || "",
						from: message.self ? "我" : message.from || "",
						text: str(message.text, 400),
						self: Boolean(message.self),
					});
				}
			} catch (err) {
				warn(`读取会话 ${source.chatId} 失败：${str(err?.message || err, 160)}`);
			}
		}
		if (!rows.length) throw new Error("这些会话里没有读到消息（可能是刚监听的，等有新消息后再试）");
		rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
		const trimmed = rows.slice(-EXTRACT_MESSAGE_CAP);
		const result = await llm.complete({
			prompt: buildExtractPrompt(trimmed, { now: now() }),
			system: EXTRACT_SYSTEM,
			maxChars: 1600,
			timeoutMs: 75_000,
		});
		if (!result?.ok) throw new Error(str(result?.error || "提取失败", 300));
		const candidates = parseExtractReply(result.text, { now: now() });
		const known = new Set(store.items.map((item) => str(item.title).replace(/\s+/g, "")));
		const fresh = candidates.filter((item) => !known.has(item.title.replace(/\s+/g, "")));
		// 候选也落盘：自动提取会在面板关着的时候跑，回来还得看得见（否则白花额度）。
		const merged = mergeCandidates(store.candidates, fresh, { now: now() });
		if (merged.added > 0) {
			store = { ...store, candidates: merged.items };
			save();
		}
		return {
			candidates: fresh,
			chats: sources.slice(0, Math.max(1, limit)).length,
			messages: trimmed.length,
			model: result.model || "",
			added: merged.added,
			stored: merged.total,
		};
	}

	/** 采纳一条候选：用**服务端存过的**字段建待办（前端只能给 id，不能给正文）。 */
	async function adopt({ id, toFeishu = false } = {}) {
		await load();
		const target = str(id, 64);
		const cand = (store.candidates || []).find((row) => row.id === target) || null;
		if (!cand) throw new Error("候选不存在（可能已记下或已被删）");
		const { todo } = await create({
			title: cand.title,
			detail: cand.detail,
			dueAt: cand.dueAt,
			priority: cand.priority,
			source: "extract",
			toFeishu,
			...(cand.chatId
				? {
						ref: {
							kind: "chat",
							id: cand.messageId || "",
							chatId: cand.chatId,
							sender: cand.sender || "",
							title: cand.chat || "",
						},
					}
				: {}),
		});
		store = { ...store, candidates: (store.candidates || []).filter((row) => row.id !== cand.id) };
		save();
		return { todo: find(todo.id), snapshot: snapshot() };
	}

	/** 收起候选（不建待办）：清空列表，下次提取重新找。 */
	async function clearCandidates() {
		await load();
		const cleared = (store.candidates || []).length;
		store = { ...store, candidates: [] };
		save();
		return { cleared, snapshot: snapshot() };
	}

	/** 改自动获取配置（默认关；开关一变，调度器由 index.mjs 重新排期）。 */
	async function setConfig(patch = {}) {
		await load();
		const src = patch && typeof patch === "object" ? patch : {};
		autoConfig = normalizeTodoConfig(
			{
				...autoConfig,
				...(Object.hasOwn(src, "autoSync") ? { autoSync: Boolean(src.autoSync) } : {}),
				...(Object.hasOwn(src, "autoExtract") ? { autoExtract: Boolean(src.autoExtract) } : {}),
				...(Object.hasOwn(src, "intervalMin") ? { intervalMin: src.intervalMin } : {}),
				// 刚打开就别等一个间隔：下一次排期落在「现在」（插上也先看一眼）。
				...(src.restart ? { lastRunAt: 0 } : {}),
			},
			{ now: now() },
		);
		saveConfig();
		return { config: { ...autoConfig }, nextAutoAt: autoNextAt(autoConfig, { now: now() }), snapshot: snapshot() };
	}

	/**
	 * 定时跑一轮：拉飞书任务（`autoSync`）+ 从监听会话提取候选（`autoExtract`）。
	 * 失败只记 `lastError`/历史，不抛给调用方（后台任务不能因为一次网络抖动就死）。
	 */
	async function autoRun({ reason = "timer" } = {}) {
		await load();
		if (!autoConfig.autoSync && !autoConfig.autoExtract) return { skipped: "disabled", at: now() };
		if (autoRunning) return { skipped: "inflight", at: now() };
		autoRunning = true;
		const at = now();
		const out = { at, reason, synced: null, extracted: null, candidates: 0, warnings: [] };
		try {
			if (autoConfig.autoSync) {
				const pulled = await sync();
				out.synced = { added: pulled.added, updated: pulled.updated, total: pulled.total };
				if (pulled.warning) out.warnings.push(pulled.warning);
			}
			if (autoConfig.autoExtract) {
				if (!llm || typeof llm.complete !== "function" || !listSources || !readMessages) {
					out.warnings.push("没有可读会话或模型补全：自动提取未执行");
				} else {
					try {
						const found = await extract({ limit: EXTRACT_CHATS });
						out.extracted = { chats: found.chats, messages: found.messages };
						out.candidates = found.added || 0;
					} catch (err) {
						out.warnings.push(`自动提取失败：${str(err?.message || err, 200)}`);
					}
				}
			}
		} catch (err) {
			// 兜底：任何意外都只能变成一行 warning（不然 `lastRunAt` 写不下去，调度的 5s 下限会变成热循环）。
			out.warnings.push(`自动获取失败：${str(err?.message || err, 200)}`);
		} finally {
			autoRunning = false;
		}
		const summary = [
			out.synced ? `同步：新增 ${out.synced.added} / 更新 ${out.synced.updated}` : "",
			out.extracted ? `提取：${out.candidates} 条候选` : "",
		]
			.filter(Boolean)
			.join("；");
		autoConfig = normalizeTodoConfig(
			{
				...autoConfig,
				// 失败也要记时间：否则过点立刻又跑，会变成热循环。
				lastRunAt: at,
				lastResult: str(summary, 300),
				lastError: str(out.warnings[0] || "", 300),
			},
			{ now: now() },
		);
		saveConfig();
		if (out.candidates > 0) {
			try {
				notify?.("info", `待办自动提取：发现 ${out.candidates} 条候选，打开「待办」页签点「记下」`);
			} catch {
				/* ignore */
			}
		}
		return { ...out, config: { ...autoConfig }, nextAutoAt: autoNextAt(autoConfig, { now: now() }) };
	}

	/** 「这条建议没用」：静音到这次建议之后（下次刷新才重新生成）。 */
	async function muteAdvice(id) {
		await load();
		const target = find(id);
		if (!target) throw new Error("待办不存在");
		const next = normalizeTodo(
			{ ...target, advice: null, adviceMutedAt: now(), updatedAt: now() },
			{ now: now(), prev: target },
		);
		store = { ...store, items: sortTodos(store.items.map((item) => (item.id === next.id ? next : item))) };
		save();
		return { todo: next, snapshot: snapshot() };
	}

	return {
		load,
		snapshot,
		create,
		update,
		remove,
		sync,
		advise,
		execute,
		extract,
		adopt,
		clearCandidates,
		setConfig,
		autoRun,
		muteAdvice,
		handleRunEvent,
		get pendingCount() {
			return pendingRuns.size;
		},
		/** 供 AI 工具一次性写完（agent 自己记待办用）。 */
		async addMany(items = []) {
			const added = [];
			for (const item of Array.isArray(items) ? items : []) {
				try {
					const { todo } = await create({ ...item, source: item?.source || "agent" });
					added.push(todo);
				} catch (err) {
					warn(`新增待办失败：${str(err?.message || err, 160)}`);
				}
			}
			return { added, snapshot: snapshot() };
		},
		keyOf: todoKeyOf,
	};
}
