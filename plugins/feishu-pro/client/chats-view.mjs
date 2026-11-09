/**
 * plugins/feishu-pro/client/chats-view.mjs
 * 「会话」页签：左边会话列表，右边只读的消息流水。
 *
 * 为什么单独一个文件：entry.mjs 已经是一整段巨型模板字符串，再往里塞双栏布局 +
 * 按需拉消息 + 监听开关，改动面会失控。这里只依赖宿主传进来的 `call`（同一个传输层），
 * 自己管自己的 DOM 与状态。
 *
 * 设计约束（和 lib/chats.mjs 的注释对应）：
 *   - 飞书不给"未读数"和"我的会话列表"的稳定语义 → 列表上只显示能拿到的（名称/类型/是否监听），
 *     不显示假的未读数；
 *   - 单聊 name 常为空 → 用聊天标签 `chatLabel` 兜底，右侧标题在读到消息后升级成「与 X 的私聊」；
 *   - 任何失败都显示在行内提示里，不把页面清空。
 */

const STYLE_ID = "fp-chats-views-styles";
/** 图片/文件资源走插件自己的代理（同源 <img> 自带 Cookie，飞书 token 不出服务端）。 */
const MEDIA_BASE = "/plugins-api/feishu-pro";

const STYLES = `
.fp-cv{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;}
.fp-cv-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);}
.fp-cv-q{flex:1;min-width:160px;padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;outline:none;}
.fp-cv-q:focus{border-color:var(--accent);}
.fp-cv-count{font-size:11.5px;color:var(--text-dim);white-space:nowrap;}
.fp-cv-img{max-width:240px;max-height:240px;border-radius:8px;display:block;cursor:zoom-in;background:var(--bg-elev2);}
.fp-cv-cardpop{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.55);}
.fp-cv-cardpop-box{width:320px;max-width:100%;border-radius:12px;border:1px solid var(--border);background:var(--bg-elev);box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;}
.fp-cv-cardpop-head{display:flex;gap:10px;align-items:center;padding:14px;border-bottom:1px solid var(--border-soft);}
.fp-cv-cardpop-ava{flex:0 0 auto;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:var(--accent-contrast,#fff);background:var(--accent);}
.fp-cv-cardpop-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-cardpop-sub{font-size:11.5px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-cardpop-body{padding:10px 14px;display:flex;flex-direction:column;gap:6px;font-size:12px;}
.fp-cv-cardpop-kv{display:flex;gap:8px;min-width:0;margin:0;}
.fp-cv-cardpop-kv dt{flex:0 0 44px;color:var(--text-faint);margin:0;}
.fp-cv-cardpop-kv dd{margin:0;flex:1;min-width:0;overflow-wrap:anywhere;color:var(--text);}
.fp-cv-cardpop-actions{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border-soft);flex-wrap:wrap;}
.fp-cv-cardpop-btn{padding:5px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;text-decoration:none;cursor:pointer;}
.fp-cv-cardpop-btn:hover{border-color:var(--accent);}
.fp-cv-mention{color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:0 3px;cursor:pointer;white-space:nowrap;}
.fp-cv-mention:hover{text-decoration:underline;}
.fp-cv-card{border:1px solid var(--border);border-radius:8px;background:var(--bg-elev2);padding:8px 10px;font-size:12px;line-height:1.65;max-width:420px;}
.fp-cv-card-title{font-weight:600;margin-bottom:4px;overflow-wrap:anywhere;}
.fp-cv-card-body{color:var(--text-dim);overflow-wrap:anywhere;}
.fp-cv-rich a{color:var(--accent);text-decoration:none;}
.fp-cv-rich a:hover{text-decoration:underline;}
.fp-cv-rich strong{font-weight:600;color:var(--text);}
.fp-cv-unread{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--danger,#d0453a);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;flex:0 0 auto;}
.fp-cv-lightbox{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.78);cursor:zoom-out;}
.fp-cv-lightbox img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.55);}
.fp-cv-bubble-img{padding:4px;background:transparent;border:none;}
.fp-cv-segs{display:inline-flex;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elev2);}
.fp-cv-seg{border:none;background:transparent;color:var(--text-dim);font:inherit;font-size:11.5px;line-height:1.4;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;}
.fp-cv-seg:hover{color:var(--text);}
.fp-cv-seg.on{background:var(--bg);color:var(--text);font-weight:600;}
.fp-cv-seg[disabled]{opacity:.45;cursor:not-allowed;}
.fp-cv-group{display:flex;align-items:center;gap:6px;padding:8px 9px 4px;font-size:11px;font-weight:600;color:var(--text-dim);}
.fp-cv-group::after{content:"";flex:1;height:1px;background:var(--border-soft);}
.fp-cv-time{font-size:10.5px;color:var(--text-faint);font-variant-numeric:tabular-nums;white-space:nowrap;}
.fp-cv-body{display:flex;flex:1;min-height:0;}
.fp-cv-list{flex:0 0 300px;min-width:0;overflow:auto;border-right:1px solid var(--border);padding:6px;}
.fp-cv-row{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;cursor:pointer;min-width:0;}
.fp-cv-row:hover{background:var(--bg-elev2);}
.fp-cv-row.on{background:var(--accent-soft);}
.fp-cv-ava{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-soft);border:1px solid var(--border);}
.fp-cv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.fp-cv-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-sub{font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-tail{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:2px;}
.fp-cv-tag{font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;border:1px solid var(--border);color:var(--text-dim);}
.fp-cv-tag.p2p{color:var(--accent);border-color:var(--accent);}
.fp-cv-tag.watch{color:var(--green);border-color:var(--green);}
.fp-cv-reader{flex:1;min-width:0;display:flex;flex-direction:column;}
.fp-cv-rhead{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border-soft);flex-wrap:wrap;}
.fp-cv-rtitle{font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-rid{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;color:var(--text-faint);}
.fp-cv-msgs{flex:1;min-height:0;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;}
.fp-cv-msg{display:flex;flex-direction:column;gap:2px;max-width:min(680px,100%);}
.fp-cv-msg.self{align-self:flex-end;align-items:flex-end;}
.fp-cv-meta{font-size:10.5px;color:var(--text-faint);display:flex;gap:6px;align-items:baseline;}
.fp-cv-bubble{padding:6px 10px;border-radius:9px;border:1px solid var(--border-soft);background:var(--bg-elev);font-size:12px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap;}
.fp-cv-msg.self .fp-cv-bubble{background:var(--accent-soft);border-color:var(--accent);}
.fp-cv-note{font-size:11.5px;line-height:1.7;color:var(--text-dim);padding:8px 14px;overflow-wrap:anywhere;}
.fp-cv-note.err{color:var(--red);}
.fp-cv-empty{font-size:12px;color:var(--text-faint);padding:18px;text-align:center;}
.fp-cv-compose{display:flex;flex-direction:column;gap:6px;padding:8px 14px 12px;border-top:1px solid var(--border-soft);}
.fp-cv-compose textarea{width:100%;min-height:52px;max-height:160px;resize:vertical;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12.5px;line-height:1.6;outline:none;}
.fp-cv-compose textarea:focus{border-color:var(--accent);}
.fp-cv-compose textarea[disabled]{opacity:.55;cursor:not-allowed;}
.fp-cv-compose-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-cv-compose-hint{flex:1;min-width:0;font-size:11px;line-height:1.6;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-cv-compose-hint.err{color:var(--red);}
.fp-cv-send{padding:5px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);font:inherit;font-size:12px;font-weight:600;cursor:pointer;}
.fp-cv-send[disabled]{opacity:.5;cursor:not-allowed;}
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

const BUTTON =
	"padding:4px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:11.5px;cursor:pointer;";
const BUTTON_ON =
	"padding:4px 10px;border-radius:7px;border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent);font:inherit;font-size:11.5px;cursor:pointer;";

function clockOf(ms) {
	const t = Number(ms);
	if (!Number.isFinite(t) || t <= 0) return "";
	const d = new Date(t);
	const two = (n) => String(n).padStart(2, "0");
	return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 挂载会话视图。
 * @param {object} deps
 * @param {HTMLElement} deps.panel  页签容器（`[data-panel="chats"]`）
 * @param {(path: string, init?: object) => Promise<any>} deps.call entry.mjs 的传输层
 * @param {(text: string, tone?: string) => void} [deps.say] 状态栏输出（entry 的 status.show）
 */
/** 图片代理地址：任取一个 image key（富文本里的 `![Image](img_xxx)` 也走这里）。 */
function mediaKeyUrl(row, key) {
	return `${MEDIA_BASE}/chat/media?messageId=${encodeURIComponent(row.id)}&key=${encodeURIComponent(key)}&type=image`;
}

/**
 * 极简富文本渲染：先整体转义，再对**白名单模式**做替换（图片 / 链接 / 加粗 / 换行）。
 * 不引第三方 markdown 库，也不直接 innerHTML 原始内容 —— 消息来自企业 IM，属于不可信输入。
 */
function markdownInlineHtml(text, row) {
	let html = esc(String(text ?? ""));
	// ![Image](img_xxx) → 走 /chat/media 代理（消息里的图片 key 直接当 file-key）
	html = html.replace(/!\[([^\]]*)\]\((img_[A-Za-z0-9_-]+)\)/g, (_m, alt, key) => {
		return `<img class="fp-cv-img" loading="lazy" alt="${alt || "图片"}" src="${esc(mediaKeyUrl(row, key))}" />`;
	});
	// [text](https://…) → 只放行 http(s)
	html = html.replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
	);
	html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	html = mentionifyHtml(html, row);
	html = html.replace(/\n/g, "<br/>");
	return `<div class="fp-cv-bubble fp-cv-rich">${html}</div>`;
}

/** 消息气泡：普通文本 / 富文本（post）/ 卡片（`<card title="…">…</card>`）。 */
/**
 * `@名字` → 可点标签。
 * CLI 已经把 @提及渲染成 `@张三` 文本，但**只有 mentions 里带着 open_id 时**才做成可点标签
 * （点一下 = 打开与这个人的私聊）；拿不到 open_id 就保持纯文本，不造假按钮。
 */
function mentionifyHtml(html, row) {
	const list = Array.isArray(row?.mentions) ? row.mentions : [];
	let out = html;
	for (const item of list) {
		const name = String(item?.name ?? "").trim();
		const openId = String(item?.id ?? "").trim();
		if (!name || !openId) continue;
		const needle = `@${esc(name)}`;
		if (!out.includes(needle)) continue;
		const tag = `<span class="fp-cv-mention" data-open-id="${esc(openId)}" title="点击私聊 ${esc(name)}">${needle}</span>`;
		out = out.split(needle).join(tag);
	}
	return out;
}

export function richBubbleHtml(row) {
	const raw = String(row.richText || "");
	const type = String(row.msgType || "");
	const cardMatch = /^<card\b([^>]*)>([\s\S]*)<\/card>\s*$/i.exec(raw.trim());
	if (cardMatch || type === "interactive") {
		const title = /title="([^"]*)"/i.exec(cardMatch?.[1] || "")?.[1] || "";
		const body = cardMatch ? cardMatch[2] : raw;
		const titleHtml = title ? `<div class="fp-cv-card-title">${esc(title)}</div>` : "";
		return `<div class="fp-cv-card">${titleHtml}<div class="fp-cv-card-body">${markdownInlineHtml(body, row)}</div></div>`;
	}
	const looksRich = type === "post" || /!\[[^\]]*\]\(img_|\*\*[^*]+\*\*|^#{1,6}\s|\n\|/m.test(raw);
	if (raw && looksRich) return markdownInlineHtml(raw, row);
	return `<div class="fp-cv-bubble">${esc(row.preview || row.text || "")}</div>`;
}

export function mountChatsView({ panel, call, say } = {}) {
	if (!panel || typeof panel.appendChild !== "function" || typeof call !== "function") {
		return { refresh: async () => {}, destroy: () => {} };
	}
	injectStyles();

	const root = document.createElement("div");
	root.className = "fp-cv";
	root.innerHTML = `
		<div class="fp-cv-head">
			<div class="fp-cv-segs">
				<button class="fp-cv-seg on" data-seg="all">全部</button>
				<button class="fp-cv-seg" data-seg="p2p">私聊</button>
				<button class="fp-cv-seg" data-seg="group">群聊</button>
			</div>
			<input class="fp-cv-q" placeholder="筛选会话（名称 / oc_ 开头 ID）…" />
			<button class="fp-cv-refresh" style="${BUTTON}">刷新列表</button>
			<span class="fp-cv-count">未加载</span>
		</div>
		<div class="fp-cv-note fp-cv-hint" style="display:none"></div>
		<div class="fp-cv-body">
			<div class="fp-cv-list"><div class="fp-cv-empty">点「刷新列表」加载会话</div></div>
			<div class="fp-cv-reader">
				<div class="fp-cv-rhead" style="display:none">
					<span class="fp-cv-rtitle"></span>
					<span class="fp-cv-rid"></span>
					<span style="flex:1"></span>
					<button class="fp-cv-watch" style="${BUTTON}">监听</button>
					<button class="fp-cv-open" style="${BUTTON}">在飞书中打开</button>
				</div>
				<div class="fp-cv-msgs"><div class="fp-cv-empty">左侧选一个会话查看消息</div></div>
				<div class="fp-cv-compose">
					<textarea class="fp-cv-compose-input" rows="2" disabled placeholder="选一个会话后可以发消息（Ctrl/⌘ + Enter 发送）"></textarea>
					<div class="fp-cv-compose-bar">
						<div class="fp-cv-segs fp-cv-ident" role="group" aria-label="发送身份">
							<button class="fp-cv-iseg on" data-as="user" title="以你本人的名义发送（需要个人授权 + im:message.send_as_user）">我</button>
							<button class="fp-cv-iseg" data-as="tenant" title="以应用机器人身份发送（机器人必须在会话里）">机器人</button>
						</div>
						<span class="fp-cv-compose-hint"></span>
						<button class="fp-cv-send" disabled>发送</button>
					</div>
				</div>
			</div>
		</div>
	`;
	panel.appendChild(root);

	const $ = (sel) => root.querySelector(sel);
	const elQ = $(".fp-cv-q");
	const elList = $(".fp-cv-list");
	const elCount = $(".fp-cv-count");
	const elSegs = root.querySelectorAll(".fp-cv-seg");
	const elHint = $(".fp-cv-hint");
	const elReaderHead = $(".fp-cv-rhead");
	const elTitle = $(".fp-cv-rtitle");
	const elRid = $(".fp-cv-rid");
	const elMsgs = $(".fp-cv-msgs");
	const elInput = $(".fp-cv-compose-input");
	const elSend = $(".fp-cv-send");
	const elComposeHint = $(".fp-cv-compose-hint");
	const elIdents = root.querySelectorAll(".fp-cv-iseg");
	const elWatch = $(".fp-cv-watch");
	const elOpen = $(".fp-cv-open");

	let chats = [];
	let counts = { total: 0, p2p: 0, groups: 0 };
	let sections = { total: 0, p2p: 0, groups: 0, unknown: 0 };
	let seg = "all"; // all | p2p | group
	let filter = "";
	let selected = null; // { id, label, watched, link }
	let loading = false;
	let disposed = false;
	let hint = "";
	let currentRows = [];
	let sending = false;
	let busy = false;
	// 发送身份：user（以我本人名义，默认）| tenant（应用机器人）。
	// 初值只敢写“user”，真实可用性以 /state 的 scopes 报告为准（拿到前不拦）。
	let sendIdentity = "user";
	let scopeInfo = null;

	function setHint(text, err = false) {
		hint = text || "";
		elHint.textContent = hint;
		elHint.className = `fp-cv-note fp-cv-hint${err ? " err" : ""}`;
		elHint.style.display = hint ? "" : "none";
	}

	function composeHintText() {
		if (sendIdentity === "tenant") return "以**应用机器人**身份发送：机器人必须在这个会话里。";
		const cap = scopeInfo?.capabilities?.im_send;
		if (cap && cap.ok === false) {
			const missing = cap.missing.map((m) => `\`${m.scope}\``).join(" + ");
			return `以**你本人**身份发送：授权里缺少 ${missing}——去开放平台申请并重新授权，或切到「机器人」。`;
		}
		return "以**你本人**身份发送（对方会看到是你发的；不需要机器人进会话）。";
	}

	function paintIdentity() {
		for (const btn of elIdents) btn.classList.toggle("on", btn.dataset.as === sendIdentity);
		setComposeHint(composeHintText(), scopeInfo?.capabilities?.im_send?.ok === false);
	}

	/** 拉一次 /state：只为了知道「个人授权是否可用 / 缺哪些 scope」，失败不影响其它功能。 */
	async function refreshIdentity() {
		try {
			const state = await call("/state");
			scopeInfo = state?.scopes ?? null;
			const authorized = Boolean(state?.user?.authorized);
			for (const btn of elIdents) {
				if (btn.dataset.as !== "user") continue;
				btn.disabled = !authorized;
				btn.title = authorized
					? "以你本人的名义发送（需要 im:message + im:message.send_as_user）"
					: "未完成个人授权：到「设置 → 个人授权」登录后可用；现在只能以机器人身份发";
			}
			if (!authorized && sendIdentity === "user") sendIdentity = "tenant";
			paintIdentity();
		} catch {
			paintIdentity();
		}
	}

	for (const btn of elIdents) {
		btn.addEventListener("click", () => {
			if (btn.disabled) return;
			sendIdentity = btn.dataset.as === "tenant" ? "tenant" : "user";
			paintIdentity();
		});
	}

	// 首屏：先把身份提示画出来，再去问 /state（失败不影响发消息，只是少一层提示）。
	paintIdentity();
	void refreshIdentity();

	function setComposeHint(text, err = false) {
		elComposeHint.textContent = text || composeHintText();
		elComposeHint.className = `fp-cv-compose-hint${err ? " err" : ""}`;
	}

	/** 分段：私聊 = p2p 明确为 true；群聊 = 明确为群；未识别的只在「全部」里出现。 */
	function inSeg(chat) {
		if (seg === "p2p") return chat.p2p === true;
		if (seg === "group") return chat.p2p === false && chat.mode !== "unknown";
		return true;
	}

	function visibleChats() {
		const needle = filter.trim().toLowerCase();
		return chats.filter((c) => {
			if (!inSeg(c)) return false;
			if (!needle) return true;
			return (
				String(c.label ?? "")
					.toLowerCase()
					.includes(needle) ||
				String(c.id ?? "")
					.toLowerCase()
					.includes(needle) ||
				String(c.name ?? "")
					.toLowerCase()
					.includes(needle)
			);
		});
	}

	/** 列表里的时间：今天只显示时分，跨天显示月-日。 */
	function listTime(ms) {
		const t = Number(ms) || 0;
		if (!t) return "";
		const d = new Date(t);
		const now = new Date();
		const two = (n) => String(n).padStart(2, "0");
		const sameDay = d.toDateString() === now.toDateString();
		return sameDay ? `${two(d.getHours())}:${two(d.getMinutes())}` : `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
	}

	function rowHtml(chat) {
		const when = listTime(chat.lastMessageAt);
		const preview = chat.lastPreview
			? `${chat.lastMessageSelf ? "我：" : chat.lastSender ? `${chat.lastSender}：` : ""}${chat.lastPreview}`
			: chat.desc || chat.id;
		return `
			<div class="fp-cv-row${selected?.id === chat.id ? " on" : ""}" data-chat="${esc(chat.id)}">
				<span class="fp-cv-ava">${esc((chat.label || "?").slice(0, 1))}</span>
				<div class="fp-cv-main">
					<span class="fp-cv-name" title="${esc(chat.label)}">${esc(chat.label)}</span>
					<span class="fp-cv-sub" title="${esc(preview)}">${esc(preview)}</span>
				</div>
				<div class="fp-cv-tail">
					${when ? `<span class="fp-cv-time">${esc(when)}</span>` : ""}
					${Number(chat.unread) > 0 ? `<span class="fp-cv-unread" title="${Number(chat.unread)} 条新消息">${Number(chat.unread) > 99 ? "99+" : Number(chat.unread)}</span>` : ""}
					<span class="fp-cv-tag${chat.p2p ? " p2p" : ""}" title="${
						chat.inferred ? `按消息推断（${esc(chat.inferReason || "证据不足")}）` : "来自会话信息接口"
					}">${chat.p2p ? "私聊" : chat.mode === "group" ? "群" : "未识别"}${chat.inferred ? "~" : ""}</span>
					${chat.watched ? `<span class="fp-cv-tag watch">监听中</span>` : ""}
				</div>
			</div>`;
	}

	function paintList() {
		const items = visibleChats();
		// 0.10.27：CLI 已按 active_time 排好序，旧的"预热最后消息 / 机器人分页发现"两个进度提示已删除。
		elCount.textContent = `会话 ${sections.total}（私聊 ${sections.p2p} / 群 ${sections.groups}${
			sections.unknown ? ` / 未识别 ${sections.unknown}` : ""
		}）`;
		for (const btn of elSegs) {
			btn.classList.toggle("on", btn.dataset.seg === seg);
			// 空栏禁用，避免点进去看到空白却不知道为什么
			btn.disabled =
				(btn.dataset.seg === "p2p" && sections.p2p === 0) || (btn.dataset.seg === "group" && sections.groups === 0);
		}
		if (items.length === 0) {
			elList.innerHTML = `<div class="fp-cv-empty">${
				chats.length === 0 ? "没有会话：飞书没返回，或有权限未开通" : "没有匹配的会话"
			}</div>`;
			return;
		}
		// 服务端已按最后消息时间倒序；这里只在「全部」下加两段标题，让个人/群一眼分开。
		if (seg !== "all") {
			elList.innerHTML = items.map(rowHtml).join("");
			return;
		}
		const p2p = items.filter((c) => c.p2p === true);
		const groups = items.filter((c) => c.p2p === false && c.mode !== "unknown");
		const unknown = items.filter((c) => c.p2p !== true && (c.mode === "unknown" || c.p2p === undefined));
		const chunk = [];
		if (p2p.length) chunk.push(`<div class="fp-cv-group">私聊 · ${p2p.length}</div>`, ...p2p.map(rowHtml));
		if (groups.length) chunk.push(`<div class="fp-cv-group">群聊 · ${groups.length}</div>`, ...groups.map(rowHtml));
		if (unknown.length)
			chunk.push(`<div class="fp-cv-group">未识别 · ${unknown.length}</div>`, ...unknown.map(rowHtml));
		elList.innerHTML = chunk.join("");
	}

	/**
	 * 原地更新某一行的未读徽标。
	 * 不整表重绘：`paintList()` 会 `innerHTML = ...`，每 15s 闪一次还丢滚动位置。
	 */
	function paintUnread(chatId, count) {
		const row = elList?.querySelector?.(`.fp-cv-row[data-chat="${chatId}"]`);
		const tail = row?.querySelector(".fp-cv-tail");
		if (!tail) return;
		let badge = tail.querySelector(".fp-cv-unread");
		const n = Number(count) || 0;
		if (n <= 0) {
			badge?.remove();
			return;
		}
		if (!badge) {
			badge = document.createElement("span");
			badge.className = "fp-cv-unread";
			tail.prepend(badge);
		}
		badge.textContent = n > 99 ? "99+" : String(n);
		badge.title = `${n} 条新消息`;
	}

	/**
	 * 未读徽标刷新：只拉 `/dm/state` 的 `unread` 表，不重扫会话列表。
	 * 为什么需要它：`/chats` 只在挂载 / 手动刷新时拉，别人的新消息（轮询累计）以前永远不冒出来，
	 * 「未读数看着不对」有一半是这里 —— 数字是对的，只是**没刷新**。
	 */
	async function refreshUnread() {
		if (disposed) return;
		if (typeof document !== "undefined" && document.hidden) return;
		try {
			const payload = await call("/dm/state");
			const map = payload?.unread && typeof payload.unread === "object" ? payload.unread : {};
			for (const chat of chats) {
				const next = Number(map[chat.id]) || 0;
				if ((Number(chat.unread) || 0) === next) continue;
				chat.unread = next;
				paintUnread(chat.id, next);
			}
			// 正在看的会话又来了消息 → 用户就在屏幕前，立刻按已读处理
			if (selected?.id && Number(map[selected.id]) > 0) markChatRead(selected.id);
		} catch {
			/* 未读刷新失败静默：下次再试，别为几个数字打断阅读 */
		}
	}

	function paintReader() {
		if (!selected) {
			elReaderHead.style.display = "none";
			return;
		}
		elReaderHead.style.display = "";
		elTitle.textContent = selected.label;
		elRid.textContent = selected.id;
		elWatch.textContent = selected.watched ? "停止监听" : "监听此人";
		elWatch.setAttribute("style", selected.watched ? BUTTON_ON : BUTTON);
		// 发消息：只有选中会话才解锁（能不能真发出去由服务端/飞书决定）
		elInput.disabled = false;
		elSend.disabled = false;
		elInput.placeholder = "发一条文本消息（Ctrl/⌘ + Enter 发送）";
	}

	/** 当前打开的灯箱（切换/卸载时先关掉，避免残留在 body 上）。 */
	let activeLightbox = null;

	/**
	 * 图片灯箱：模态层 + 原图，点击任意处 / ESC 关闭。
	 * 挂在 `document.body` 上（不受会话面板滚动容器影响），z-index 高于宿主浮层。
	 */
	function openLightbox(src) {
		if (!src) return;
		closeLightbox();
		const box = document.createElement("div");
		box.className = "fp-cv-lightbox";
		const img = document.createElement("img");
		img.src = src;
		img.alt = "图片";
		box.appendChild(img);
		const onKey = (e) => {
			if (e.key === "Escape") closeLightbox();
		};
		box.addEventListener("click", () => closeLightbox());
		document.addEventListener("keydown", onKey);
		document.body.appendChild(box);
		activeLightbox = { box, onKey };
	}

	function closeLightbox() {
		if (!activeLightbox) return;
		const { box, onKey } = activeLightbox;
		activeLightbox = null;
		try {
			document.removeEventListener("keydown", onKey);
			box.remove();
		} catch {
			/* 容器已移除 */
		}
	}

	/** 图片/文件的代理地址（key 与 messageId 都 encode，避免拼串注入）。 */
	function mediaUrl(row, type = "image") {
		return `${MEDIA_BASE}/chat/media?messageId=${encodeURIComponent(row.id)}&key=${encodeURIComponent(row.imageKey)}&type=${type}`;
	}

	function paintMessages(rows, { keepScroll = false } = {}) {
		currentRows = Array.isArray(rows) ? rows : [];
		const prevTop = elMsgs.scrollTop;
		if (rows.length === 0) {
			elMsgs.innerHTML = `<div class="fp-cv-empty">这个会话里没有可读的消息（或没有 im:message:readonly 权限）</div>`;
			return;
		}
		// 接口倒序返回（最新在前），展示按时间正序。
		const ordered = [...rows].sort((a, b) => a.createTimeMs - b.createTimeMs);
		elMsgs.innerHTML = ordered
			.map((row) => {
				// 图片消息：CLI 的 content 只是 `[Image: img_xxx]` 占位，真正显示要回源拉二进制。
				// post（富文本）/ 卡片：CLI 给的是 markdown / `<card>` 包装，按类型渲染成富文本或卡片。
				const bubble = row.imageKey
					? `<div class="fp-cv-bubble fp-cv-bubble-img"><img class="fp-cv-img" loading="lazy" alt="图片" src="${esc(mediaUrl(row))}" /></div>`
					: richBubbleHtml(row);
				return `
			<div class="fp-cv-msg${row.self ? " self" : ""}">
				<span class="fp-cv-meta"><span>${esc(row.senderLabel)}</span><span>${esc(clockOf(row.createTimeMs))}</span></span>
				${bubble}
			</div>`;
			})
			.join("");
		elMsgs.scrollTop = keepScroll ? prevTop : elMsgs.scrollHeight;
	}

	/* ---------------------- 当前会话的自动刷新（5s） ---------------------- */
	//
	// 会话页没有推送通道，靠轮询当前会话做到「有新消息就自己冒出来」；
	// 只在 tab 可见 + 会话没换 时才拉，且**没有新消息就不重绘**（避免滚动位置被打断）。

	let refreshTimer = null;
	// 未读徽标单独一条定时器：15s 只拉 unread 表，跟消息轮询（5s）解耦。
	let unreadTimer = null;
	let lastTopId = "";

	function stopAutoRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	/**
	 * 打开会话 = 已读：清服务端累计 + 本地徽标。
	 * 两处都要调（打开时、会话开着又来新消息时），否则徽标会一直挂在「正在看的会话」上。
	 */
	function markChatRead(id) {
		const row = chats.find((c) => c.id === id);
		const had = Number(row?.unread) || Number(selected?.id === id ? selected.unread : 0) || 0;
		if (row) row.unread = 0;
		if (selected?.id === id) selected.unread = 0;
		if (had > 0) paintUnread(id, 0);
		void call("/dm/read", { method: "POST", body: { chatId: id } }).catch(() => {});
	}

	async function refreshMessages(chatId) {
		if (disposed || !chatId || chatId !== selected?.id) return;
		if (typeof document !== "undefined" && document.hidden) return;
		try {
			const payload = await call(`/chat/messages?chatId=${encodeURIComponent(chatId)}&limit=40`, {
				timeoutMs: 30000,
			});
			const rows = Array.isArray(payload.items) ? payload.items : [];
			const topId = rows[0]?.id || "";
			if (topId && topId === lastTopId) return; // 无新消息：不重绘
			// 有新消息落在这个打开着的会话里 → 立刻按已读处理（用户正看着，不该再计未读）
			if (chats.find((c) => c.id === chatId)?.unread || Number(selected?.unread) > 0) markChatRead(chatId);
			lastTopId = topId;
			if (payload.label && payload.label !== selected.label) {
				selected.label = payload.label;
				paintList();
				paintReader();
			}
			// 用户停在底部附近就跟随到底，翻历史时保持位置
			const nearBottom = elMsgs.scrollHeight - elMsgs.scrollTop - elMsgs.clientHeight < 60;
			paintMessages(rows, { keepScroll: !nearBottom });
		} catch {
			/* 轮询失败静默：手动切换会话时才显示错误 */
		}
	}

	function startAutoRefresh(chatId) {
		stopAutoRefresh();
		refreshTimer = setInterval(() => void refreshMessages(chatId), 5000);
		refreshTimer?.unref?.();
	}

	async function loadList() {
		if (disposed || loading) return;
		loading = true;
		elCount.textContent = "加载中…";
		try {
			const payload = await call("/chats");
			const unreadMap = payload.unread && typeof payload.unread === "object" ? payload.unread : {};
			chats = (Array.isArray(payload.items) ? payload.items : []).map((c) => ({
				...c,
				unread: Number(unreadMap[c.id]) || 0,
			}));
			counts = payload.counts && typeof payload.counts === "object" ? payload.counts : counts;
			// sections 是服务端口径（含"未识别"）；老/简版载荷只有 counts 时按条目推一次。
			sections =
				payload.sections && typeof payload.sections === "object"
					? payload.sections
					: {
							total: chats.length,
							p2p: chats.filter((c) => c.p2p === true).length,
							groups: chats.filter((c) => c.p2p === false && c.mode !== "unknown").length,
							unknown: chats.filter((c) => c.p2p !== true && (c.mode === "unknown" || c.p2p === undefined)).length,
						};
			paintList();
			setHint(payload.hint || payload.error || "");
			if (selected) {
				const fresh = chats.find((c) => c.id === selected.id);
				if (fresh) selected = { ...selected, ...fresh, label: selected.label };
				paintReader();
			}
		} catch (err) {
			chats = [];
			counts = { total: 0, p2p: 0, groups: 0 };
			paintList();
			setHint(`读取会话列表失败：${err?.message || err}`, true);
			say?.(`读取会话列表失败：${err?.message || err}`, "error");
		} finally {
			loading = false;
		}
	}

	async function openChat(id) {
		if (disposed) return;
		stopAutoRefresh();
		const chat = chats.find((c) => c.id === id);
		selected = {
			id,
			label: chat?.label || id,
			watched: Boolean(chat?.watched),
			link: chat?.link || "",
			unread: Number(chat?.unread) || 0,
		};
		paintList();
		paintReader();
		elInput.value = "";
		setComposeHint("");
		elMsgs.innerHTML = `<div class="fp-cv-empty">读取消息…</div>`;
		try {
			const payload = await call(`/chat/messages?chatId=${encodeURIComponent(id)}&limit=40`);
			// 打开会话**不改列表里的名字**（用户希望列表名保持原样，只在右侧标题按需展示）。
			// 打开即视为已读：清掉服务端累计 + 本地徽标（/dm/read 的语义就是「我看到了」）。
			markChatRead(id);
			const rows = Array.isArray(payload.items) ? payload.items : [];
			lastTopId = rows[0]?.id || "";
			paintMessages(rows);
			setHint(payload.namesError ? `发送人姓名查询失败（不影响内容）：${payload.namesError}` : "");
			startAutoRefresh(id);
		} catch (err) {
			elMsgs.innerHTML = "";
			setHint(`读取消息失败：${err?.message || err}`, true);
		}
	}

	// 点图片放大：在当前页开**灯箱**（不跳新标签，保留会话上下文）
	elMsgs.addEventListener("click", (ev) => {
		const img = ev.target?.closest?.(".fp-cv-img");
		if (img) {
			openLightbox(img.getAttribute("src") || "");
			return;
		}
		// 点 @提及：定位与该同事的私聊（0 副作用接口），找到就切过去
		const mention = ev.target?.closest?.(".fp-cv-mention");
		if (mention) {
			openMentionCard(mention.getAttribute("data-open-id") || "");
		}
	});

	/** 已打开的名片浮层（再次点击 / 卸载时先关掉，避免叠层）。 */
	let activeCardPop = null;

	function closeMentionCard() {
		if (!activeCardPop) return;
		const { box, onKey } = activeCardPop;
		activeCardPop = null;
		try {
			document.removeEventListener("keydown", onKey);
			box.remove();
		} catch {
			/* 容器已移除 */
		}
	}

	/**
	 * 「@某人」→ 名片浮层：首字母头像 + 姓名/部门/邮箱 + 「发消息」「在飞书中打开」。
	 * 先出壳再异步补数据（点一下立刻有反馈）；读不到名片也把原因显示在名片里。
	 */
	function openMentionCard(openId) {
		const id = String(openId ?? "").trim();
		if (!id || disposed) return;
		closeMentionCard();
		closeLightbox();
		const box = document.createElement("div");
		box.className = "fp-cv-cardpop";
		box.innerHTML = `
			<div class="fp-cv-cardpop-box">
				<div class="fp-cv-cardpop-head">
					<span class="fp-cv-cardpop-ava">…</span>
					<div style="min-width:0;flex:1;">
						<div class="fp-cv-cardpop-name">加载中…</div>
						<div class="fp-cv-cardpop-sub">${esc(id)}</div>
					</div>
				</div>
				<div class="fp-cv-cardpop-body"><div class="fp-cv-cardpop-sub">读取名片…</div></div>
				<div class="fp-cv-cardpop-actions"></div>
			</div>`;
		const onKey = (e) => {
			if (e.key === "Escape") closeMentionCard();
		};
		box.addEventListener("click", (e) => {
			if (e.target === box) closeMentionCard();
		});
		document.addEventListener("keydown", onKey);
		document.body.appendChild(box);
		activeCardPop = { box, onKey };

		void (async () => {
			let item = null;
			let error = "";
			try {
				const payload = await call(`/contacts/user?id=${encodeURIComponent(id)}`);
				item = payload?.item ?? null;
			} catch (err) {
				error = String(err?.message || err);
			}
			if (!activeCardPop || disposed) return;
			const name = String(item?.name || id);
			const ava = box.querySelector(".fp-cv-cardpop-ava");
			if (ava) ava.textContent = name.slice(0, 1) || "?";
			const nameEl = box.querySelector(".fp-cv-cardpop-name");
			if (nameEl) nameEl.textContent = name;
			const subEl = box.querySelector(".fp-cv-cardpop-sub");
			if (subEl) subEl.textContent = [item?.jobTitle, item?.department].filter(Boolean).join(" · ") || id;
			const body = box.querySelector(".fp-cv-cardpop-body");
			if (body) {
				body.innerHTML = error
					? `<div class="fp-cv-cardpop-sub" style="color:var(--danger,#d0453a);">名片读取失败：${esc(error.slice(0, 200))}</div>`
					: `
						<dl class="fp-cv-cardpop-kv"><dt>姓名</dt><dd>${esc(name)}</dd></dl>
						<dl class="fp-cv-cardpop-kv"><dt>部门</dt><dd>${esc(item?.department || "—")}</dd></dl>
						<dl class="fp-cv-cardpop-kv"><dt>邮箱</dt><dd>${esc(item?.email || "—")}</dd></dl>
						<dl class="fp-cv-cardpop-kv"><dt>open_id</dt><dd>${esc(id)}</dd></dl>`;
			}
			const actions = box.querySelector(".fp-cv-cardpop-actions");
			if (actions) {
				actions.innerHTML = `
					<button class="fp-cv-cardpop-btn fp-cv-cp-chat" type="button">发消息</button>
					<a class="fp-cv-cardpop-btn" href="https://applink.feishu.cn/client/chat/open?openId=${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">在飞书中打开</a>
					<button class="fp-cv-cardpop-btn fp-cv-cp-close" type="button">关闭</button>`;
				actions.querySelector(".fp-cv-cp-close")?.addEventListener("click", () => closeMentionCard());
				actions.querySelector(".fp-cv-cp-chat")?.addEventListener("click", () => {
					closeMentionCard();
					void openChatWith(openId);
				});
			}
		})();
	}

	/** 定位并打开与某人的私聊（0 副作用接口）；没有私聊时给可读提示。 */
	async function openChatWith(openId) {
		if (!openId || disposed) return;
		try {
			const payload = await call("/chat/p2p-resolve", { method: "POST", body: { openId } });
			const chatId = String(payload?.items?.[0]?.chatId ?? "");
			if (!chatId) {
				setComposeHint("还没和这位同事私聊过（飞书那边没有可用的单聊会话）", true);
				return;
			}
			setComposeHint("");
			await loadList();
			await openChat(chatId);
		} catch (err) {
			setComposeHint(`打开私聊失败：${err?.message || err}`, true);
		}
	}

	elList.addEventListener("click", (ev) => {
		const row = ev.target?.closest?.(".fp-cv-row");
		if (!row) return;
		const id = row.getAttribute("data-chat") || "";
		if (id) void openChat(id);
	});

	for (const btn of elSegs) {
		btn.addEventListener("click", () => {
			if (btn.disabled) return;
			seg = String(btn.dataset.seg || "all");
			paintList();
		});
	}

	elQ.addEventListener("input", () => {
		filter = elQ.value;
		paintList();
	});

	$(".fp-cv-refresh").addEventListener("click", () => void loadList());

	elOpen.addEventListener("click", () => {
		if (!selected) return;
		const link = selected.link || chats.find((c) => c.id === selected.id)?.link || "";
		if (link) window.open(link, "_blank", "noopener,noreferrer");
		else setHint("这个会话没有可用的飞书链接", true);
	});

	/** 发一条文本：成功就追加气泡（不整页重拉），失败把可执行提示写进输入框下方。 */
	async function sendDraft() {
		if (!selected || sending) return;
		const text = elInput.value.trim();
		if (!text) {
			setComposeHint("消息不能为空", true);
			return;
		}
		sending = true;
		elSend.disabled = true;
		elSend.textContent = "发送中…";
		try {
			const payload = await call("/chat/send", {
				method: "POST",
				body: { chatId: selected.id, text, as: sendIdentity },
			});
			const row = payload?.message;
			if (row) {
				currentRows = [...currentRows, row];
				paintMessages(currentRows);
			}
			elInput.value = "";
			const who = payload?.identity === "user" ? "你本人" : "机器人";
			setComposeHint(payload?.truncated ? `已发送（以${who}身份，内容过长已截断）` : `已发送（以${who}身份）`);
			say?.(`消息已发送（${who}）${payload?.truncated ? "，内容过长已截断" : ""}`, "ok");
			// 自己发的消息立刻反映到列表（别等 5s 轮询）
			if (selected?.id) void refreshMessages(selected.id);
		} catch (err) {
			// 飞书的失败原因基本都能落到"该开哪个权限 / 机器人为啥不在这个会话"，原样带上。
			const hintText = err?.detail?.hint || "";
			setComposeHint(hintText ? `${err?.message || err} —— ${hintText}` : `发送失败：${err?.message || err}`, true);
			say?.(`发送失败：${err?.message || err}`, "error");
		} finally {
			sending = false;
			elSend.disabled = false;
			elSend.textContent = "发送";
		}
	}

	elSend.addEventListener("click", () => void sendDraft());
	elInput.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			void sendDraft();
		}
	});

	elWatch.addEventListener("click", async () => {
		if (!selected) return;
		const watch = !selected.watched;
		try {
			const payload = await call("/chat/watch", { method: "POST", body: { chatId: selected.id, watch } });
			selected.watched = watch;
			const row = chats.find((c) => c.id === selected.id);
			if (row) row.watched = watch;
			paintList();
			paintReader();
			say?.(watch ? "已加入私聊提醒轮询" : "已从私聊提醒中移除", "ok");
			if (payload?.dm && !payload.dm.config?.enabled) {
				setHint("已加入监听名单，但轮询还没启用：到「设置 → 私聊提醒」勾上「启用轮询」");
			}
		} catch (err) {
			setHint(`监听设置失败：${err?.message || err}`, true);
		}
	});

	// 挂载即刷一次未读，之后每 15s 跟一次（`/dm/state` 是内存状态，很轻）。
	void refreshUnread();
	unreadTimer = setInterval(() => void refreshUnread(), 15000);
	unreadTimer?.unref?.();

	return {
		refresh: loadList,
		destroy() {
			disposed = true;
			stopAutoRefresh();
			if (unreadTimer) {
				clearInterval(unreadTimer);
				unreadTimer = null;
			}
			closeLightbox();
			closeMentionCard();
			root.remove();
		},
	};
}
