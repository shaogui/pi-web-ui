/**
 * plugins/feishu-pro/client/contact-actions.mjs
 * 通讯录每行的两个动作：**发消息** / **在飞书中打开**。
 *
 * 为什么单独一个文件、且不改进 entry.mjs 的渲染函数：
 *   通讯录列表的渲染在 entry.mjs 里（另一个会话正在改那块），所以这里用
 *   **DOM 后置增强 + 事件委托**：监听 `.fp-contact-list` 的子节点变化，给每个联系人行
 *   补两个按钮。entry.mjs 只多两行（mount / destroy），冲突面最小。
 *
 * 两个动作各自解决一个真问题：
 *   1. 发消息 —— 飞书**发送**支持直接按 `open_id` 投递（`receive_id_type=open_id`），
 *      不需要先知道 chat_id；飞书会自动创建/复用「人 × 机器人」单聊，而响应里的
 *      `chat_id` 就是那条私聊的 id，服务端会顺手登记进会话列表。
 *      （这就是 TRAE / WorkBuddy 那类客户端私聊的实现方式。）
 *   2. 在飞书中打开 —— 用 applink 的 `openId` 形式直接跳到"和这个人的单聊"，
 *      不依赖我们是否已经知道 chat_id。
 */

const STYLE_ID = "fp-contact-actions-styles";
const MARK = "data-fp-contact-actions";

const STYLES = `
.fp-ca-bar{display:flex;flex-direction:column;gap:6px;margin:8px 10px 4px;padding:8px 10px;border-radius:9px;border:1px solid var(--accent);background:var(--accent-soft);}
.fp-ca-bar[hidden]{display:none;}
.fp-ca-title{font-size:11.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-ca-input{width:100%;min-height:48px;max-height:140px;resize:vertical;padding:6px 9px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12.5px;line-height:1.6;outline:none;}
.fp-ca-input:focus{border-color:var(--accent);}
.fp-ca-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-ca-hint{flex:1;min-width:0;font-size:11px;line-height:1.6;color:var(--text-dim);overflow-wrap:anywhere;}
.fp-ca-hint.err{color:var(--red);}
.fp-ca-hint.ok{color:var(--green);}
.fp-ca-btn{padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;white-space:nowrap;}
.fp-ca-btn.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);font-weight:600;}
.fp-ca-btn[disabled]{opacity:.55;cursor:not-allowed;}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLES;
	document.head.appendChild(style);
}

const esc = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);

/** 飞书 applink：直接打开与某人的单聊（不需要 chat_id）。 */
export function personChatLink(openId) {
	const id = String(openId ?? "").trim();
	if (!id) return "";
	return `https://applink.feishu.cn/client/chat/open?openId=${encodeURIComponent(id)}`;
}

/**
 * 行的展示名。
 * 注意：行首是**头像占位**（姓名首字），不能取 `querySelector("span")` —— 那会拿到"张"。
 * 这里在行内所有文本节点里取最长的那个（姓名通常比首字/徽标长），没有就回空。
 */
export function rowTitle(row) {
	const spans = Array.from(row?.querySelectorAll?.("span") ?? []);
	let best = "";
	for (const span of spans) {
		const text = String(span.textContent ?? "").trim();
		if (text.length > best.length) best = text;
	}
	return best;
}

/** 行对应的 open_id：复用 entry.mjs 行按钮上的 data-id。 */
export function rowOpenId(row) {
	const btn = row?.querySelector?.('[data-act="contact-insert"], [data-act="contact-msg"]');
	return String(btn?.getAttribute?.("data-id") ?? "").trim();
}

/**
 * 挂载后置增强。
 * @param {object} deps
 * @param {HTMLElement} deps.list  `.fp-contact-list`
 * @param {(path: string, init?: object) => Promise<any>} deps.call entry.mjs 的传输层
 * @param {(text: string, tone?: string) => void} [deps.say] 状态栏输出
 */
export function mountContactActions({ list, call, say } = {}) {
	if (!list || typeof list.querySelectorAll !== "function" || typeof call !== "function") {
		return { destroy() {} };
	}
	injectStyles();

	/** 发送条挂在列表面板里（列表上方的兄弟位置），列表重绘不会动到它。 */
	const bar = document.createElement("div");
	bar.className = "fp-ca-bar";
	bar.hidden = true;
	bar.innerHTML = `
		<div class="fp-ca-title"></div>
		<textarea class="fp-ca-input" rows="2" placeholder="发给对方的消息（Ctrl/⌘ + Enter 发送）"></textarea>
		<div class="fp-ca-row">
			<span class="fp-ca-hint">默认以**你本人**身份私聊发送（需个人授权 + 发送 scope；未授权时自动用机器人身份）；发送成功会顺手登记这条单聊会话。</span>
			<button class="fp-ca-btn primary fp-ca-send">发送</button>
			<button class="fp-ca-btn fp-ca-cancel">取消</button>
		</div>
	`;
	list.parentElement?.insertBefore(bar, list);

	const elTitle = bar.querySelector(".fp-ca-title");
	const elInput = bar.querySelector(".fp-ca-input");
	const elSend = bar.querySelector(".fp-ca-send");
	const elCancel = bar.querySelector(".fp-ca-cancel");
	const elHint = bar.querySelector(".fp-ca-hint");

	let target = { openId: "", title: "" };
	let sending = false;
	let disposed = false;

	const settle = (text, tone = "") => {
		elHint.textContent = text;
		elHint.className = `fp-ca-hint${tone ? ` ${tone}` : ""}`;
	};

	function openComposer(openId, title) {
		target = { openId, title };
		elTitle.textContent = `发送给 ${title || openId}`;
		elInput.value = "";
		elInput.disabled = false;
		elSend.disabled = false;
		settle("默认以你本人身份发送：消息会显示是你发的，对方不需要先加机器人。");
		bar.hidden = false;
		elInput.focus();
	}

	function closeComposer() {
		bar.hidden = true;
		target = { openId: "", title: "" };
	}

	async function send() {
		if (sending) return;
		const text = elInput.value.trim();
		if (!text) {
			settle("消息不能为空", "err");
			return;
		}
		if (!target.openId) {
			settle("缺少 open_id，无法发送", "err");
			return;
		}
		sending = true;
		elSend.disabled = true;
		elSend.textContent = "发送中…";
		try {
			const payload = await call("/chat/send", { method: "POST", body: { openId: target.openId, text } });
			const who = payload?.identity === "user" ? "你本人" : "机器人";
			if (payload?.chatId) {
				settle(`已以${who}身份发送；单聊会话已登记（${payload.chatId}）`, "ok");
				say?.(`已发给 ${target.title || target.openId}，可在「会话」页继续对话`, "ok");
			} else {
				settle(`已以${who}身份发送（飞书没回 chat_id，会话列表暂时看不到这条）`, "ok");
				say?.("消息已发送", "ok");
			}
			elInput.value = "";
		} catch (err) {
			// 服务端把飞书的错误码翻译成了可执行提示（开权限 / 机器人不在会话…），原样带出来。
			const hint = err?.detail?.hint || "";
			settle(hint ? `${err?.message || err} —— ${hint}` : `发送失败：${err?.message || err}`, "err");
			say?.(`发送失败：${err?.message || err}`, "error");
		} finally {
			sending = false;
			elSend.disabled = false;
			elSend.textContent = "发送";
		}
	}

	/** 给一行补按钮（幂等：已打过标记就跳过）。 */
	function enhanceRow(row) {
		if (!row || row.getAttribute(MARK) === "1") return;
		const openId = rowOpenId(row);
		if (!openId) return;
		const host = row.querySelector('[data-act="contact-insert"]')?.parentElement;
		if (!host) return;
		row.setAttribute(MARK, "1");

		const title = rowTitle(row);
		const msgBtn = document.createElement("button");
		msgBtn.className = "fp-ca-btn";
		msgBtn.dataset.act = "contact-msg";
		msgBtn.dataset.id = openId;
		msgBtn.dataset.name = title;
		msgBtn.textContent = "发消息";
		msgBtn.title = "发一条私聊（默认以你本人身份；未完成个人授权时用机器人）";

		const openBtn = document.createElement("button");
		openBtn.className = "fp-ca-btn";
		openBtn.dataset.act = "contact-open";
		openBtn.dataset.id = openId;
		openBtn.textContent = "打开飞书";
		openBtn.title = "在飞书客户端里打开与这个人的单聊";

		host.appendChild(msgBtn);
		host.appendChild(openBtn);
	}

	function enhanceAll() {
		if (disposed) return;
		for (const row of list.querySelectorAll(".fp-row")) enhanceRow(row);
	}

	// 列表每次重绘都重新补（entry.mjs 用 innerHTML 覆盖，所以必须监听而不是只做一次）。
	const observer = new MutationObserver(() => enhanceAll());
	observer.observe(list, { childList: true, subtree: true });
	enhanceAll();

	const onClick = (ev) => {
		const btn = ev.target?.closest?.("[data-act=contact-msg], [data-act=contact-open]");
		if (!btn) return;
		ev.preventDefault();
		ev.stopPropagation();
		const openId = String(btn.dataset.id || "").trim();
		if (!openId) return;
		if (btn.dataset.act === "contact-open") {
			const link = personChatLink(openId);
			window.open(link, "_blank", "noopener,noreferrer");
			say?.("已在飞书中打开该单聊（若没反应，检查飞书客户端是否已登录）", "info");
			return;
		}
		openComposer(openId, String(btn.dataset.name || "").trim());
	};
	// 捕获阶段先处理，避免被 entry.mjs 的 .fp-row-btn 委托再走一遍
	list.addEventListener("click", onClick, true);

	elSend.addEventListener("click", () => void send());
	elCancel.addEventListener("click", () => closeComposer());
	elInput.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			void send();
		}
		if (ev.key === "Escape") closeComposer();
	});

	return {
		destroy() {
			disposed = true;
			try {
				observer.disconnect();
			} catch {
				/* ignore */
			}
			list.removeEventListener("click", onClick, true);
			bar.remove();
		},
	};
}
