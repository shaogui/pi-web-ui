/**
 * plugins/feishu-pro/lib/json-text.mjs
 * 从模型的自由文本里抠出第一个完整 JSON 值（纯函数）。
 *
 * 为什么手写扫描而不是正则：字符串里出现的 `}` / `]` 会让正则提前收尾（真实踩过）。
 * 为什么单独一个模块：待办建议（todo-ai）与自动回复的前置分析（auto-reply）都要解析
 * 「说好只输出 JSON」的回包；两处各写一份，结果必然是其中一处先退化。
 */

/**
 * 从 `start` 位置开始做括号配平扫描，返回解析成功的值；失败返回 undefined。
 * 只认 `{`/`[` 起始，字符串内的括号一律不算数。
 */
function scanJson(body, start, closer) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < body.length; i += 1) {
		const ch = body[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth += 1;
		else if (ch === "}" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				if (ch !== closer) return undefined;
				try {
					return JSON.parse(body.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * 取第一个可解析的 JSON 对象/数组。
 * 先剥 ```json 围栏（小模型最爱加），再按 `{` / `[` 各试一次。
 */
export function extractJson(text) {
	const raw = String(text ?? "").replace(/^\uFEFF/, "");
	const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(raw);
	const body = fence ? fence[1] : raw;
	for (const open of ["{", "["]) {
		const start = body.indexOf(open);
		if (start < 0) continue;
		const parsed = scanJson(body, start, open === "{" ? "}" : "]");
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}
