/**
 * plugins/feishu-pro/client/capture-parse.mjs
 * 「记一条」的自然语言解析：**纯函数、离线、不花模型额度**。
 *
 * 为什么不用模型：捕获必须是「打字就有反馈」的动作，一次 75s 的补全不适合这里；
 * 而且解析错了用户能看见（chips 可删可改），比一个看不见的猜测安全得多。
 *
 * 只认三类东西，其余原样留在标题里：
 *   1. 优先级：`!!` / `!急` / `!高` / `!低` / `紧急` / `加急`；
 *   2. 日期：今天 / 明天 / 后天 / 周X / 下周X / 3 天后 / 3月5日 / 2026-03-05；
 *   3. 时间：10:30 / 10点 / 10点半 / 下午 3 点 / 晚上 8 点（可带「前 / 之前 / 以前」）。
 *
 * 没有时间的日期落在当天 00:00（`formatDue` 会只显示日期，不编一个假钟点）。
 */

const WEEKDAY = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const DAY_MS = 86_400_000;

const startOfDay = (ms) => {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d;
};

const atClock = (dayMs, hour, minute = 0) => {
	const d = new Date(dayMs);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
};

const clampClock = (value) => {
	const n = Math.round(Number(value));
	return Number.isFinite(n) && n >= 0 && n <= 23 ? n : -1;
};

const pad = (n) => String(n).padStart(2, "0");

/** 优先级识别：只认带 `!` 的显式标记，以及「紧急/加急」这种几乎不会误伤的词。 */
function takePriority(text) {
	const rules = [
		{ re: /\s*(?:!!|！!|!急|！急|紧急|加急)\s*/, value: "urgent" },
		{ re: /\s*(?:!高|！高|!重要)\s*/, value: "high" },
		{ re: /\s*(?:!低|！低)\s*/, value: "low" },
	];
	for (const rule of rules) {
		if (rule.re.test(text)) return { text: text.replace(rule.re, " "), priority: rule.value };
	}
	return { text, priority: "" };
}

/** 日期：绝对日期 → 相对日 → 星期。命中一个就够。 */
function takeDate(text, now) {
	const today = startOfDay(now);

	const absolute =
		text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/) ||
		text.match(/(\d{1,2})月(\d{1,2})[日号]?/) ||
		text.match(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/);
	if (absolute) {
		const hasYear = absolute.length > 3 && Number(absolute[1]) > 1900;
		const year = hasYear ? Number(absolute[1]) : new Date(now).getFullYear();
		const month = Number(absolute[hasYear ? 2 : 1]);
		const date = Number(absolute[hasYear ? 3 : 2]);
		if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
			let ms = new Date(year, month - 1, date).getTime();
			// 只写「3月5日」但今年已经过了 → 指明年（用户不会给过去的日子）。
			if (!hasYear && ms < today.getTime()) ms = new Date(year + 1, month - 1, date).getTime();
			return { text: text.replace(absolute[0], " "), day: startOfDay(ms).getTime(), label: "" };
		}
	}

	const relative = text.match(/(大后天|后天|明天|明日|今天|今日|明早|明晚|今晚)/);
	if (relative) {
		const word = relative[1];
		const offset =
			word === "大后天"
				? 3
				: word === "后天"
					? 2
					: word === "明天" || word === "明日" || word === "明早" || word === "明晚"
						? 1
						: 0;
		const day = today.getTime() + offset * DAY_MS;
		let clock = -1;
		if (word === "明早") clock = 9;
		if (word === "今晚" || word === "明晚") clock = 20;
		return { text: text.replace(relative[0], " "), day, clock, label: "" };
	}

	// `(?<!上)`：把「上周五」留给标题，不要当成下一个周五（猜错比不猜更糟）。
	const week = text.match(/(?<!上)(下周|下星期|下礼拜|本周|这周|这星期|周|星期|礼拜)([一二三四五六日天])/);
	if (week) {
		const prefix = week[1] || "";
		const target = WEEKDAY[week[2]];
		const current = new Date(now).getDay();
		let diff = (target - current + 7) % 7;
		if (prefix.startsWith("下")) {
			// 「下周一」= 下一个自然周的周一（不是「7 天后」）。
			const toMonday = (8 - current) % 7 || 7;
			diff = toMonday + (target === 0 ? 6 : target - 1);
		}
		return { text: text.replace(week[0], " "), day: today.getTime() + diff * DAY_MS, label: "" };
	}

	const days = text.match(/(\d{1,2})\s*天(?:以)?后/);
	if (days) {
		const n = Number(days[1]);
		if (n > 0 && n <= 365) {
			return { text: text.replace(days[0], " "), day: today.getTime() + n * DAY_MS, label: "" };
		}
	}

	return { text, day: 0, label: "" };
}

/** 时间：`10:30` / `10点半` / `下午 3 点`；「10 点前」的「前」一并吃掉。 */
function takeClock(text) {
	const colon = text.match(/(上午|下午|中午|晚上|早上|凌晨)?\s*(\d{1,2})[:：](\d{2})\s*(?:之前|以前|前)?/);
	if (colon) {
		const hour = clockHour(colon[1], Number(colon[2]));
		const minute = Number(colon[3]);
		if (hour >= 0 && minute >= 0 && minute <= 59) {
			return { text: text.replace(colon[0], " "), hour, minute };
		}
	}
	const point = text.match(
		/(上午|下午|中午|晚上|早上|凌晨)?\s*(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?\s*(?:之前|以前|前)?/,
	);
	if (point) {
		const hour = clockHour(point[1], Number(point[2]));
		const minute = !point[3] ? 0 : point[3] === "半" ? 30 : Number(String(point[3]).replace(/\D/g, ""));
		if (hour >= 0 && minute >= 0 && minute <= 59) {
			return { text: text.replace(point[0], " "), hour, minute };
		}
	}
	return { text, hour: -1, minute: 0 };
}

function clockHour(prefix, hour) {
	const h = clampClock(hour);
	if (h < 0) return -1;
	const word = prefix || "";
	if ((word === "下午" || word === "晚上") && h < 12) return h + 12;
	if (word === "中午" && h < 12) return h + 12;
	if (word === "凌晨" && h === 12) return 0;
	return h;
}

/** 去掉被吃掉 token 后残留的空白与首尾标点。 */
function cleanTitle(text) {
	return String(text ?? "")
		.replace(/[\u0000]+/g, " ")
		.replace(/[ \t\u3000]+/g, " ")
		.replace(/^[\s，。、；;：:,.\-—]+/, "")
		.replace(/[\s，。、；;：:,.\-—]+$/, "")
		.trim();
}

/**
 * @param {string} raw 用户输入的原文
 * @param {{now?: number}} [opts]
 * @returns {{title: string, dueAt: number, priority: string, hasDate: boolean, hasClock: boolean}}
 */
export function parseCapture(raw, { now = Date.now() } = {}) {
	const source = String(raw ?? "").trim();
	if (!source) return { title: "", dueAt: 0, priority: "normal", hasDate: false, hasClock: false };

	const pri = takePriority(source);
	const date = takeDate(pri.text, now);
	const clock = takeClock(date.text);

	let dueAt = 0;
	const hasDate = date.day > 0;
	let hour = clock.hour;
	let minute = clock.minute;
	// 「明晚」「今晚」自带默认钟点（20:00 / 09:00），用户没写具体时间时用它。
	if (hour < 0 && date.clock >= 0) hour = date.clock;
	if (!hasDate && hour >= 0) {
		// 只给了「10 点」：今天还没到就今天，已经过了就明天（避免刚记下就逾期）。
		const todayAt = atClock(startOfDay(now).getTime(), hour, minute);
		dueAt = todayAt >= now ? todayAt : atClock(startOfDay(now).getTime() + DAY_MS, hour, minute);
	} else if (hasDate) {
		dueAt = hour >= 0 ? atClock(date.day, hour, minute) : atClock(date.day, 0, 0);
	}

	return {
		title: cleanTitle(clock.text),
		dueAt,
		priority: pri.priority || "normal",
		hasDate,
		hasClock: hour >= 0,
	};
}

/** 给界面的 chip 文案（时间口径与 formatDue 一致：00:00 视为"没有钟点"）。 */
export function captureChips(parsed, { now = Date.now() } = {}) {
	const chips = [];
	if (parsed?.dueAt) {
		const d = new Date(parsed.dueAt);
		const day = startOfDay(d.getTime()).getTime();
		const diff = Math.round((day - startOfDay(now).getTime()) / DAY_MS);
		const clock = d.getHours() || d.getMinutes() ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
		const label =
			diff === 0
				? `今天${clock}`
				: diff === 1
					? `明天${clock}`
					: diff === 2
						? `后天${clock}`
						: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}${clock}`;
		chips.push({ kind: "due", label });
	}
	const priorityLabel = { urgent: "紧急", high: "重要", low: "低", normal: "" }[parsed?.priority || "normal"];
	if (priorityLabel) chips.push({ kind: "priority", label: priorityLabel });
	return chips;
}
