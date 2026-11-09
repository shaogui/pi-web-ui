/**
 * plugins/feishu-pro/lib/cli-tasks.mjs
 * 飞书任务（task/v2）→ lark-cli 适配层。
 *
 * 为什么走 `lark-cli api` 兜底而不是快捷命令：CLI 的快捷命令只覆盖高频域
 * （im / docs / contact / drive / wiki），任务域没有 `+task-list` 之类的封装，
 * 而 `api` 子命令能打到任意 2500+ 官方接口。这也意味着**接口契约由飞书决定**，
 * 插件必须假设字段可能缺、可能是数字也可能是字符串 —— 归一化全在本文件收口。
 *
 * 失败语义：只**读**不写时，拿不到就返回空列表 + warning（面板降级成"仅本地待办"）；
 * 写操作（新建 / 改字段 / 标记完成）失败必须如实回报 `writeBack:false` 并带原因，
 * 绝不能让界面以为同步成功。
 *
 * 双向同步的边界（0.12.0）：
 *   - 读：`listMyTasks` 把飞书任务**合并**进本地库（只增改，不删本地条目）；
 *   - 写：本地新建（用户勾了「同步飞书」）/ 编辑标题·描述·截止 / 勾完成 都会回写飞书。
 *     回写用**幂等**语义（PATCH 同一份目标状态，重复执行结果一致），所以自动同步可以放心重跑。
 */
import { toMs } from "./todo-store.mjs";

export const TASKS_PATH = "/open-apis/task/v2/tasks";
/** 单页上限（飞书 task/v2 是 100）。 */
const MAX_PAGE_SIZE = 100;
/** 写操作的 body 参数名各版本 CLI 不一，按这个顺序试（命中即用）。 */
const WRITE_BODY_FLAGS = ["--data", "--body", "--json"];

const text = (value, cap = 0) => {
	const out =
		typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
	return cap > 0 && out.length > cap ? out.slice(0, cap) : out;
};

/** 任务条目归一：字段名在 v2 里是 summary / description / due.timestamp / completed_at。 */
export function normalizeCliTask(raw = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	const due = src.due && typeof src.due === "object" ? src.due : {};
	const guid = text(src.guid ?? src.id ?? src.task_guid, 128);
	const completedAt = toMs(src.completed_at ?? src.completedAt, 0);
	return {
		guid,
		title: text(src.summary ?? src.title, 200),
		detail: text(src.description ?? src.notes, 4000),
		dueAt: toMs(due.timestamp ?? due.time ?? due.date ?? src.due_at, 0),
		completedAt,
		done: completedAt > 0,
		url: text(src.url ?? src.link, 2000),
		createdAt: toMs(src.created_at ?? src.createdAt, 0),
		updatedAt: toMs(src.updated_at ?? src.updatedAt, 0),
	};
}

/** 列表回包取条目：CLI 会把 `data` 原样透出，`items` / `tasks` 两种都见过。 */
export function pickTasks(data) {
	if (!data || typeof data !== "object") return [];
	if (Array.isArray(data.items)) return data.items;
	if (Array.isArray(data.tasks)) return data.tasks;
	if (Array.isArray(data.data?.items)) return data.data.items;
	return [];
}

/**
 * 列出「与我有关、未完成」的飞书任务。
 * @param {(args: string[], opts?: object) => Promise<any>} run  lark-cli 执行器
 */
export async function listMyTasks(
	run,
	{ completed = false, pageSize = MAX_PAGE_SIZE, pageToken = "", as = "user" } = {},
) {
	const params = {
		page_size: Math.min(Math.max(Number(pageSize) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE),
		...(completed ? { completed: true } : {}),
	};
	if (pageToken) params.page_token = String(pageToken);
	const out = await run(["api", "GET", TASKS_PATH, "--params", JSON.stringify(params), "--as", as], {
		timeoutMs: 30_000,
	});
	const data = out?.data ?? {};
	const items = pickTasks(data)
		.map(normalizeCliTask)
		.filter((task) => task.guid && task.title);
	return {
		items,
		hasMore: Boolean(data.has_more ?? out?.meta?.has_more),
		pageToken: text(data.page_token ?? out?.meta?.page_token, 200),
		via: "lark-cli",
	};
}

/** 判断 CLI 是否只是"不认识这个 body 参数名"（那就换个 flag 再试，不会重复写入）。 */
function isUnknownFlag(err) {
	const text = String(err?.message || err || "").toLowerCase();
	return /unknown flag|unrecognized|unexpected argument|no such flag|未知参数|无法识别/.test(text);
}

/**
 * 写操作共用通道：只把 `--data/--body/--json` 三种 body flag 依次试。
 * 「不认识这个 flag」的失败**没有发出请求**，所以重试不会写两遍；其余错误立刻上抛。
 */
async function writeTask(run, args, body, { timeoutMs = 30_000 } = {}) {
	let lastError = null;
	for (const flag of WRITE_BODY_FLAGS) {
		try {
			return await run([...args, flag, JSON.stringify(body)], { timeoutMs });
		} catch (err) {
			lastError = err;
			if (!isUnknownFlag(err)) break;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError?.message || lastError || "写飞书任务失败"));
}

/**
 * 任务体：只带**显式传入**的字段（缺省 = 不动飞书侧原值）。
 * `dueAt` 传 0 且不是 undefined 才算"清空截止"（`due: null`）—— 前端漏传字段不该把截止抹掉。
 * @returns {{task: object, fields: string[]}} fields = 需要写进 `update_fields` 的字段名
 */
export function taskBody({ title, detail, dueAt } = {}) {
	const task = {};
	const fields = [];
	if (title !== undefined) {
		const summary = text(title, 200);
		if (summary) {
			task.summary = summary;
			fields.push("summary");
		}
	}
	if (detail !== undefined) {
		task.description = text(detail, 4000);
		fields.push("description");
	}
	if (dueAt !== undefined) {
		const due = toMs(dueAt, 0);
		task.due = due > 0 ? { timestamp: String(Math.round(due)), is_all_day: false } : null;
		fields.push("due");
	}
	return { task, fields };
}

/**
 * 在飞书新建任务（用户勾「同步飞书」时才走这条路）。
 * @returns {Promise<{guid: string, created: boolean, writeBack: boolean, warning: string, task: object|null}>}
 */
export async function createTask(run, { title = "", detail = "", dueAt = 0, as = "user" } = {}) {
	const { task } = taskBody({ title, detail, dueAt: dueAt ? dueAt : undefined });
	if (!task.summary) return { guid: "", created: false, writeBack: false, task: null, warning: "飞书任务必须有标题" };
	try {
		const out = await writeTask(run, ["api", "POST", TASKS_PATH, "--as", as], { task });
		const normalized = normalizeCliTask(out?.data?.task ?? out?.data ?? {});
		const guid = normalized.guid;
		return {
			guid,
			created: Boolean(guid),
			writeBack: Boolean(guid),
			task: guid ? normalized : null,
			// 建成功了但没回 guid：飞书侧多了一条，本地却联不上 —— 必须说清楚，别当成功。
			warning: guid ? "" : "飞书已建任务但没返回 guid：本地无法联动，请手动核对",
		};
	} catch (err) {
		return {
			guid: "",
			created: false,
			writeBack: false,
			task: null,
			warning: `飞书任务没建成（本地已保存）：${text(err?.message || err, 200)}`,
		};
	}
}

/**
 * 更新任务字段（标题 / 描述 / 截止）。PATCH 天然幂等，自动同步重跑不会产生重复内容。
 * @returns {Promise<{guid: string, writeBack: boolean, updated: string[], warning: string}>}
 */
export async function updateTask(run, guid, { title, detail, dueAt } = {}, { as = "user" } = {}) {
	const id = text(guid, 128);
	if (!id) return { guid: "", writeBack: false, updated: [], warning: "缺少任务 guid" };
	const { task, fields } = taskBody({ title, detail, dueAt });
	if (!fields.length) return { guid: id, writeBack: true, updated: [], warning: "" };
	try {
		await writeTask(run, ["api", "PATCH", `${TASKS_PATH}/${encodeURIComponent(id)}`, "--as", as], {
			task,
			update_fields: fields,
		});
		return { guid: id, writeBack: true, updated: fields, warning: "" };
	} catch (err) {
		return {
			guid: id,
			writeBack: false,
			updated: [],
			warning: `飞书任务没改成功（本地已更新）：${text(err?.message || err, 200)}`,
		};
	}
}

/**
 * 更新一个任务的完成态（PATCH，天然幂等）。
 * @returns {Promise<{guid: string, done: boolean, writeBack: boolean, warning: string}>}
 */
export async function setTaskDone(run, guid, { done = true, as = "user" } = {}, { now = Date.now() } = {}) {
	const id = text(guid, 128);
	if (!id) return { guid: "", done: false, writeBack: false, warning: "缺少任务 guid" };
	// 飞书约定：completed_at 字符串毫秒时间戳，"0" = 未完成。
	const body = { task: { completed_at: done ? String(Math.round(now)) : "0" }, update_fields: ["completed_at"] };
	try {
		const out = await writeTask(run, ["api", "PATCH", `${TASKS_PATH}/${encodeURIComponent(id)}`, "--as", as], body);
		const task = normalizeCliTask(out?.data?.task ?? out?.data ?? {});
		return {
			guid: id,
			done: task.completedAt > 0 || done,
			writeBack: true,
			warning: "",
		};
	} catch (err) {
		return {
			guid: id,
			done: false,
			writeBack: false,
			warning: `飞书任务没改成功（本地已更新）：${text(err?.message || err, 200)}`,
		};
	}
}
