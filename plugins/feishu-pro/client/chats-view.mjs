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
.fp-cv-find{flex:0 1 220px;min-width:120px;padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;outline:none;}
.fp-cv-find:focus{border-color:var(--accent);}
.fp-cv-cache{font-size:10.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;}
.fp-cv-hit{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;cursor:pointer;min-width:0;}
.fp-cv-hit:hover{background:var(--bg-elev2);}
.fp-cv-hit-head{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;color:var(--text-faint);}
.fp-cv-hit-chat{color:var(--accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-hit-body{font-size:12px;line-height:1.55;color:var(--text);overflow-wrap:anywhere;}
.fp-cv-hit mark{background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 1px;}
.fp-cv-count{font-size:11.5px;color:var(--text-dim);white-space:nowrap;}
.fp-cv-sync{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(340px,40%);}
.fp-cv-sync-dot{width:7px;height:7px;border-radius:50%;background:var(--text-faint);flex:0 0 auto;}
.fp-cv-sync-dot.on{background:var(--accent);}
.fp-cv-sync-dot.err{background:var(--danger,#d0453a);}
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
.fp-cv-msg.ctx .fp-cv-bubble{outline:2px solid var(--accent);outline-offset:1px;}
.fp-cv-menu{position:fixed;z-index:9996;min-width:232px;max-width:min(320px,90vw);padding:4px;border-radius:10px;border:1px solid var(--border);background:var(--bg-elev);box-shadow:0 12px 36px rgba(0,0,0,.36);display:flex;flex-direction:column;gap:1px;}
.fp-cv-menu-item{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;padding:7px 9px;border:none;border-radius:7px;background:transparent;color:var(--text);font:inherit;cursor:pointer;}
.fp-cv-menu-item:hover,.fp-cv-menu-item:focus-visible{background:var(--accent-soft);outline:none;}
.fp-cv-menu-item b{font-size:12px;font-weight:600;line-height:1.5;}
.fp-cv-menu-item span{font-size:10.5px;line-height:1.5;color:var(--text-dim);}
.fp-cv-menu-sep{height:1px;margin:2px 4px;background:var(--border-soft);}
.fp-cv-menu-note{padding:7px 9px;font-size:10.5px;line-height:1.5;color:var(--text-faint);}
.fp-cv-aidraft-regen[disabled]{opacity:.5;cursor:not-allowed;}
.fp-cv-ai-tip{flex:1;min-width:0;font-size:10.5px;line-height:1.6;color:var(--text-faint);overflow-wrap:anywhere;}
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
.fp-cv-airow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-cv-ai-tag{flex:0 0 auto;font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:1px 5px;}
.fp-cv-ai-want{flex:1;min-width:150px;padding:5px 9px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:11.5px;outline:none;}
.fp-cv-ai-want:focus{border-color:var(--accent);}
.fp-cv-ai-want[disabled]{opacity:.55;cursor:not-allowed;}
.fp-cv-aidraft{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--accent);border-radius:9px;background:var(--accent-soft);}
.fp-cv-aidraft-head{display:flex;align-items:center;gap:8px;min-width:0;}
.fp-cv-aidraft-title{flex:0 0 auto;font-size:11.5px;font-weight:600;color:var(--accent);white-space:nowrap;}
.fp-cv-aidraft-meta{font-size:10.5px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-cv-aidraft textarea{width:100%;min-height:96px;max-height:220px;resize:vertical;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12.5px;line-height:1.6;outline:none;}
.fp-cv-aidraft textarea:focus{border-color:var(--accent);}
.fp-cv-aidraft-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-cv-aidraft-hint{flex:1;min-width:0;font-size:11px;line-height:1.6;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-cv-aidraft-hint.err{color:var(--red);}
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

/** 单行摘要：菜单/草稿标题只放一段，不能让换行把布局撑开。 */
const clip = (value, max = 28) => {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
};

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
 * @param {() => void} [deps.onOpenSettings] 切到设置页（同步开关在那里，状态条只做入口）
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

export function mountChatsView({ panel, call, say, onOpenSettings } = {}) {
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
			<input class="fp-cv-find" placeholder="搜索本地消息（回车 / 停一下自动搜）…" />
			<button class="fp-cv-refresh" style="${BUTTON}">刷新列表</button>
			<!-- 消息同步：状态 + 一键触发。开关在「设置 → 消息同步与提醒」（同一个引擎，不重复配置） -->
			<span class="fp-cv-sync" title="后台消息同步（私聊 + 群）">
				<span class="fp-cv-sync-dot"></span>
				<span class="fp-cv-sync-text">同步状态读取中…</span>
			</span>
			<button class="fp-cv-sync-run" style="${BUTTON}" title="不等下一轮，现在就把候选会话拉一遍增量">立即同步</button>
			<button class="fp-cv-sync-cfg" style="${BUTTON}" title="同步范围 / 间隔 / 提醒开关">同步设置</button>
			<span class="fp-cv-count">未加载</span>
		</div>
		<div class="fp-cv-note fp-cv-hint" style="display:none"></div>
		<div class="fp-cv-body">
			<div class="fp-cv-list"><div class="fp-cv-empty">点「刷新列表」加载会话</div></div>
			<div class="fp-cv-reader">
				<div class="fp-cv-rhead" style="display:none">
					<span class="fp-cv-rtitle"></span>
					<span class="fp-cv-rid"></span>
					<span class="fp-cv-cache"></span>
					<span style="flex:1"></span>
					<button class="fp-cv-reload" style="${BUTTON}" title="向飞书要最新的（不等后台轮询）">刷新</button>
					<button class="fp-cv-watch" style="${BUTTON}" title="加入后台同步名单：这个会话的新消息会同步进本地缓存并弹提醒">加入同步</button>
					<button class="fp-cv-open" style="${BUTTON}">在飞书中打开</button>
				</div>
				<div class="fp-cv-msgs"><div class="fp-cv-empty">左侧选一个会话查看消息</div></div>
				<div class="fp-cv-compose">
					<div class="fp-cv-airow">
						<span class="fp-cv-ai-tag" title="AI 会读这条消息之前的上下文，按当前发送身份回复">AI</span>
						<input class="fp-cv-ai-want" aria-label="AI 回复要点" placeholder="回复要点（可选，右键消息时生效）：想让 AI 说什么、什么语气" disabled />
						<span class="fp-cv-ai-tip">右键任意消息 → AI 直接回复 / AI 预览回复</span>
					</div>
					<div class="fp-cv-aidraft" style="display:none" role="group" aria-label="AI 回复预览">
						<div class="fp-cv-aidraft-head">
							<span class="fp-cv-aidraft-title">AI 回复预览</span>
							<span class="fp-cv-aidraft-meta"></span>
							<span style="flex:1"></span>
							<button class="fp-cv-aidraft-regen" style="${BUTTON}" title="按同样的要点再生成一版">再生成</button>
							<button class="fp-cv-aidraft-close" style="${BUTTON}">关闭</button>
						</div>
						<textarea class="fp-cv-aidraft-text" aria-label="AI 回复正文（可编辑）" rows="4" placeholder="AI 生成的回复会出现在这里，可以改完再发"></textarea>
						<div class="fp-cv-aidraft-bar">
							<button class="fp-cv-aidraft-send fp-cv-send" disabled>发送这条</button>
							<span class="fp-cv-aidraft-hint"></span>
						</div>
					</div>
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
	const elFind = $(".fp-cv-find");
	const elList = $(".fp-cv-list");
	const elCount = $(".fp-cv-count");
	const elSegs = root.querySelectorAll(".fp-cv-seg");
	const elHint = $(".fp-cv-hint");
	const elReaderHead = $(".fp-cv-rhead");
	const elCache = $(".fp-cv-cache");
	const elTitle = $(".fp-cv-rtitle");
	const elRid = $(".fp-cv-rid");
	const elMsgs = $(".fp-cv-msgs");
	const elInput = $(".fp-cv-compose-input");
	const elSend = $(".fp-cv-send");
	const elComposeHint = $(".fp-cv-compose-hint");
	const elIdents = root.querySelectorAll(".fp-cv-iseg");
	// AI 回复：右键消息触发（直接发 / 预览后发），这里是要点输入与预览面板。
	const elAiWant = $(".fp-cv-ai-want");
	const elAiTip = $(".fp-cv-ai-tip");
	const elAiDraft = $(".fp-cv-aidraft");
	const elAiDraftText = $(".fp-cv-aidraft-text");
	const elAiDraftMeta = $(".fp-cv-aidraft-meta");
	const elAiDraftSend = $(".fp-cv-aidraft-send");
	const elAiDraftRegen = $(".fp-cv-aidraft-regen");
	const elAiDraftClose = $(".fp-cv-aidraft-close");
	const elAiDraftHint = $(".fp-cv-aidraft-hint");
	const elWatch = $(".fp-cv-watch");
	const elOpen = $(".fp-cv-open");
	const elSyncText = $(".fp-cv-sync-text");
	const elSyncDot = $(".fp-cv-sync-dot");
	const elSyncRun = $(".fp-cv-sync-run");
	const elSyncCfg = $(".fp-cv-sync-cfg");

	let chats = [];
	// 本地消息检索（`/chat/search`，只翻缓存）：`hits = null` 表示没在搜索态。
	let hits = null;
	let hitsQuery = "";
	let hitsBusy = false;
	let findTimer = null;
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
	// AI 回复：aiBusy 期间右键菜单锁死（同一会话只允许一轮，服务端也会拦）。
	let aiBusy = false;
	let aiMode = "";
	// 这一轮回复的是哪条消息（右键选中的那条）：预览面板标出来，「再生成」沿用同一个锚点。
	let aiTarget = null; // { id, label, text }
	let activeMsgMenu = null;
	// 预览草稿属于哪个会话：切走就丢掉，避免把 A 的回复发到 B 里。
	let draftChatId = "";
	let draftRunId = "";
	// 直发失败转预览时复用服务端那次的幂等键：重发不会变成第二条。
	let draftUuid = "";
	// 记住生成时的原文：只有「原样重发」才复用上面那个 key；改过字就用新的 key（改动必须发出去）。
	let draftOriginal = "";
	let draftSending = false;

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
		// 预览里写着「以「我」身份发送」：切了身份就得跟着改，否则用户会按错的预期点发送。
		paintDraftMeta();
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
					: "未完成个人授权：到「设置 → lark-cli 与身份 → 登录账号」登录后可用；现在只能以机器人身份发";
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

	/* ---------------------- AI 回复（直接发 / 预览后发） ---------------------- */
	//
	// 为什么要有两种：直接发适合「我懒得打字，反正就是回一句收到」；预览适合
	// 「话一旦发出去就收不回」的场合 —— 生成完先摊在输入框上方，改完点「发送这条」。
	// 预览发送走 `/chat/send`（与手打发消息同一条路、同一套幂等键），不另造一条发送通道。

	function identityLabel(as = sendIdentity) {
		return as === "tenant" || as === "bot" ? "机器人" : "我";
	}

	function paintAiBusy() {
		const usable = Boolean(selected) && !aiBusy;
		elAiWant.disabled = !usable;
		elAiDraftRegen.disabled = !usable;
		elAiTip.textContent = aiBusy
			? aiMode === "direct"
				? "AI 正在生成并直接发送…"
				: "AI 正在生成预览…"
			: "右键任意消息 → AI 直接回复 / AI 预览回复";
	}

	function setDraftHint(text, err = false) {
		elAiDraftHint.textContent = text || "";
		elAiDraftHint.className = `fp-cv-aidraft-hint${err ? " err" : ""}`;
	}

	/** 预览面板的「回复谁 / 身份 / 字数」：换身份、改正文都要跟着变。 */
	function paintDraftMeta() {
		if (!elAiDraft || elAiDraft.style.display === "none") return;
		const target = aiTarget ? `回复 ${aiTarget.label || "这条消息"}：${clip(aiTarget.text, 20)} · ` : "";
		elAiDraftMeta.textContent = `${target}以「${identityLabel()}」身份发送 · ${elAiDraftText.value.length} 字 · 可编辑`;
	}

	function hideDraft() {
		elAiDraft.style.display = "none";
		elAiDraftText.value = "";
		elAiDraftSend.disabled = true;
		draftChatId = "";
		draftRunId = "";
		draftUuid = "";
		draftOriginal = "";
		setDraftHint("");
	}

	function showDraft(text, { runId = "", uuid = "", note = "", err = false } = {}) {
		draftChatId = selected?.id || "";
		draftRunId = String(runId || "");
		draftUuid = String(uuid || "");
		draftOriginal = String(text ?? "");
		elAiDraft.style.display = "";
		elAiDraftText.value = String(text ?? "");
		elAiDraftSend.disabled = !elAiDraftText.value.trim();
		setDraftHint(note || "Ctrl/⌘ + Enter 直接发送 · 内容可改", err);
		paintDraftMeta();
		try {
			elAiDraftText.focus();
			elAiDraftText.setSelectionRange(elAiDraftText.value.length, elAiDraftText.value.length);
		} catch {
			/* 焦点失败不影响发送 */
		}
	}

	/** 幂等键前缀：同一次生成的重试共用一个 runId 前缀（多分片时服务端再补序号）。 */
	function aiUuid(prefix = "ai") {
		const key = String(draftRunId || Date.now().toString(36))
			.replace(/[^\w.-]/g, "")
			.slice(0, 32);
		return `${prefix}-${key}`.slice(0, 50);
	}

	/**
	 * 触发一轮 AI 回复（右键某条消息 → 直接发 / 先预览）。
	 * @param {"preview"|"direct"} mode
	 * @param {{messageId?:string,target?:{id:string,label:string,text:string}|null}} [anchor]
	 */
	async function runAiReply(mode, { messageId = "", target = null } = {}) {
		if (!selected || aiBusy) return;
		const anchorId = String(messageId || target?.id || "").trim();
		const targetWho = String(target?.label || target?.senderLabel || "对方");
		if (mode === "direct") {
			const who = identityLabel();
			const where = target ? `回复 ${targetWho} 的那条「${clip(target.text, 36)}」` : "回复这个会话的最近消息";
			// 直发是不可撤销的对外动作：多问一句，成本远低于发错人。
			const ok =
				typeof window === "undefined" || typeof window.confirm !== "function"
					? true
					: window.confirm(`将以「${who}」身份${where}，内容不会先给你看。\n\n继续？`);
			if (!ok) return;
		}
		aiBusy = true;
		aiMode = mode;
		aiTarget = target
			? {
					id: String(target.id || ""),
					label: String(target.label || target.senderLabel || ""),
					text: String(target.text || ""),
				}
			: null;
		paintAiBusy();
		setComposeHint(
			mode === "preview"
				? `AI 正在读${target ? ` ${targetWho} 的这条消息` : "最近消息"}并起草回复…`
				: "AI 正在生成并直接发送…",
		);
		const chatId = selected.id;
		const identity = sendIdentity;
		try {
			const payload = await call("/chat/ai-reply", {
				method: "POST",
				timeoutMs: 240_000,
				body: {
					chatId,
					mode,
					as: identity,
					instruction: elAiWant.value.trim(),
					...(anchorId ? { messageId: anchorId } : {}),
					uuid: aiUuid("ai"),
				},
			});
			if (disposed || selected?.id !== chatId) return;
			// 生成成功、发送失败：正文不丢，放进预览让用户改完重发（服务端不自动重试）。
			if (payload.sent === false && payload.sendError) {
				const tail = payload.hint ? `（${payload.hint}）` : "";
				const part = payload.partial ? `已发出 ${payload.sentChunks}/${payload.chunks} 段，` : "";
				showDraft(payload.text, {
					runId: payload.runId,
					uuid: payload.uuidBase,
					note: `直接发送失败：${payload.sendError}${tail} —— ${part}剩下的正文已放进预览，改完可以再发`,
					err: true,
				});
				setComposeHint("");
				return;
			}
			if (mode === "preview") {
				showDraft(payload.text, { runId: payload.runId });
				setComposeHint("");
				return;
			}
			const who = identityLabel(payload.identity || identity);
			const extra = payload.chunked ? `，内容较长分 ${payload.chunks} 条` : "";
			setComposeHint(`AI 已直接回复（以${who}身份${extra}）`);
			say?.(`AI 回复已发送（${who}）${extra}`, "ok");
			void refreshMessages(chatId);
		} catch (err) {
			if (disposed) return;
			const hint = err?.cli?.hint || err?.detail?.hint || "";
			setComposeHint(`AI 回复失败：${err?.message || err}${hint ? ` —— ${hint}` : ""}`, true);
			say?.(`AI 回复失败：${err?.message || err}`, "error");
		} finally {
			if (!disposed) {
				aiBusy = false;
				aiMode = "";
				paintAiBusy();
			}
		}
	}

	/** 预览正文 → 真发送（可编辑；超长/为空在这里就拦住，不白跑一次服务端）。 */
	async function sendAiDraft() {
		if (!selected || draftSending) return;
		if (draftChatId && draftChatId !== selected.id) {
			hideDraft();
			setComposeHint("会话已经切走：预览草稿已丢弃（避免把回复发错人）", true);
			return;
		}
		const text = elAiDraftText.value.trim();
		if (!text) {
			setDraftHint("内容为空：写点东西再发", true);
			return;
		}
		if (text.length > 4000) {
			setDraftHint(`内容 ${text.length} 字，超过飞书单条 4000 字上限：删一点再发`, true);
			return;
		}
		draftSending = true;
		elAiDraftSend.disabled = true;
		const label = elAiDraftSend.textContent;
		elAiDraftSend.textContent = "发送中…";
		const identity = sendIdentity;
		const chatId = selected.id;
		// 原样重发 → 复用失败那次的 key（防重复）；改过字 → 新 key（改动必须发出去）。
		const uuid = draftUuid && text === draftOriginal.trim() ? draftUuid : aiUuid("draft-edit");
		try {
			await call("/chat/send", {
				method: "POST",
				body: { chatId, text, as: identity, uuid },
			});
			hideDraft();
			const who = identityLabel(identity);
			setComposeHint(`AI 回复已发送（以${who}身份）`);
			say?.(`AI 回复已发送（${who}）`, "ok");
			void refreshMessages(chatId);
		} catch (err) {
			setDraftHint(`发送失败：${err?.message || err}`, true);
			say?.(`发送失败：${err?.message || err}`, "error");
		} finally {
			draftSending = false;
			elAiDraftSend.textContent = label || "发送这条";
			elAiDraftSend.disabled = !elAiDraftText.value.trim();
		}
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
					${chat.watched ? `<span class="fp-cv-tag watch" title="在后台同步名单里">同步中</span>` : ""}
				</div>
			</div>`;
	}

	/** 检索命中行的渲染：会话名 + 谁说的 + 时间 + 高亮片段；点一下就跳到那个会话。 */
	function hitHtml(hit) {
		const needle = hitsQuery.trim();
		const raw = String(hit.snippet || hit.text || "");
		// 高亮只做「纯文本切分 + 转义」，不拼用户的原始字符串到 HTML 里。
		let body = esc(raw);
		if (needle) {
			const safe = esc(needle);
			body = body
				.split(new RegExp(`(${safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"))
				.map((part, i) => (i % 2 === 1 ? `<mark>${part}</mark>` : part))
				.join("");
		}
		return `
			<div class="fp-cv-hit" data-chat="${esc(hit.chatId)}">
				<div class="fp-cv-hit-head">
					<span class="fp-cv-hit-chat">${esc(hit.chatName || hit.chatId)}</span>
					<span>${esc(hit.from || "")}</span>
					<span style="flex:1"></span>
					<span class="fp-cv-time">${esc(clockOf(hit.at))}</span>
				</div>
				<div class="fp-cv-hit-body">${body || "（无正文）"}</div>
			</div>`;
	}

	/** 检索态的画法：结果列表 + 「命中 N 条 / 搜了 M 条」；清空输入即回到会话列表。 */
	function paintHits() {
		const items = Array.isArray(hits) ? hits : [];
		elCount.textContent = hitsBusy ? "检索本地缓存…" : `命中 ${items.length} 条 · 搜了本地缓存`;
		if (items.length === 0) {
			elList.innerHTML = `<div class="fp-cv-empty">${
				hitsBusy ? "检索中…" : "本地缓存里没有命中：先打开相关会话（会拉一批并缓存），或等后台轮询预热"
			}</div>`;
			return;
		}
		elList.innerHTML = items.map(hitHtml).join("");
	}

	function paintList() {
		if (hits !== null) {
			paintHits();
			return;
		}
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
	 * 轮询引擎状态的刷新：**一次请求两个用途** —— 未读徽标 + 顶部同步状态条。
	 * 为什么需要它：`/chats` 只在挂载 / 手动刷新时拉，别人的新消息（轮询累计）以前永远不冒出来，
	 * 「未读数看着不对」有一半是这里 —— 数字是对的，只是**没刷新**。
	 * 既然已经为此每 15s 问一次 `/dm/state`，就把「同步开没开 / 同步了几个会话」一并画上，
	 * 否则用户在 webui 里只能看到「未读」，看不到引擎本身（这正是 0.14.0 要修的那个缺口）。
	 */
	async function refreshPoller() {
		if (disposed) return;
		if (typeof document !== "undefined" && document.hidden) return;
		try {
			const payload = await call("/dm/state");
			paintSyncState(payload);
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
			/* 未读/状态刷新失败静默：下次再试，别为几个数字打断阅读 */
		}
	}

	/** 顶部同步状态条：开关 / 间隔 / 候选会话数 / 上轮结果（全部来自 /dm/state 的 candidates+lastPoll）。 */
	function paintSyncState(state) {
		if (!state) return;
		const cfg = state.config || {};
		const cand = state.candidates || {};
		const last = state.lastPoll || {};
		const err = state.lastError || "";
		elSyncDot.className = `fp-cv-sync-dot${err ? " err" : state.running ? " on" : ""}`;
		// 「立即同步」始终可用：它是 `/sync/run`（force），"不开定时同步、只想手动拉一把" 是正当用法。
		if (!cfg.enabled) {
			elSyncText.textContent = "同步未启用（可手动同步一次）";
			elSyncText.title = "到「设置 → 消息同步与提醒」勾上「启用后台同步」";
			return;
		}
		const parts = [`同步 ${cfg.intervalSec}s`];
		if (cand.total) {
			const bits = [];
			if (cand.p2p) bits.push(`${cand.p2p} 私聊`);
			if (cand.groups) bits.push(`${cand.groups} 群`);
			parts.push(bits.join(" / ") || `${cand.total} 会话`);
		} else {
			parts.push("0 会话");
		}
		if (last.at) parts.push(`上轮 ${last.rows} 条 / 新增 ${last.fresh}`);
		else if (state.lastPollAt) parts.push(`上次 ${ageLabel(state.lastPollAt)}`);
		if (err) parts.push("异常");
		elSyncText.textContent = parts.join(" · ");
		elSyncText.title = err || "";
	}

	function paintReader() {
		if (!selected) {
			elReaderHead.style.display = "none";
			return;
		}
		elReaderHead.style.display = "";
		elTitle.textContent = selected.label;
		elRid.textContent = selected.id;
		elWatch.textContent = selected.watched ? "移出同步" : "加入同步";
		elWatch.title = selected.watched
			? "移出同步名单（不再后台拉取 + 不再弹提醒）"
			: "加入同步名单：这个会话的新消息会同步进本地缓存并弹提醒";
		elWatch.setAttribute("style", selected.watched ? BUTTON_ON : BUTTON);
		// 发消息：只有选中会话才解锁（能不能真发出去由服务端/飞书决定）
		elInput.disabled = false;
		elSend.disabled = false;
		elInput.placeholder = "发一条文本消息（Ctrl/⌘ + Enter 发送）";
		// AI 回复按钮同理：选中会话 + 没有在生成时才能点。
		paintAiBusy();
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
			<div class="fp-cv-msg${row.self ? " self" : ""}" data-mid="${esc(row.id)}">
				<span class="fp-cv-meta"><span>${esc(row.senderLabel)}</span><span>${esc(clockOf(row.createTimeMs))}</span></span>
				${bubble}
			</div>`;
			})
			.join("");
		elMsgs.scrollTop = keepScroll ? prevTop : elMsgs.scrollHeight;
	}

	/* ---------------------- 消息右键菜单（AI 回复入口） ---------------------- */
	//
	// 为什么是右键而不是输入框上方的按钮：回复的对象是**某一条**消息，
	// 「回谁」只有在消息本身上点才说得清。菜单挂在 body 上（不被滚动容器裁剪），
	// 打开时给目标消息描边，关闭即撤掉。

	function closeMsgMenu() {
		if (!activeMsgMenu) return;
		const opened = activeMsgMenu;
		activeMsgMenu = null;
		for (const off of opened.offs) {
			try {
				off();
			} catch {
				/* 监听器已随节点销毁 */
			}
		}
		opened.el.remove();
		opened.node?.classList.remove("ctx");
	}

	function addMenuItem(menu, { label, hint, onSelect }) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "fp-cv-menu-item";
		item.setAttribute("role", "menuitem");
		const title = document.createElement("b");
		title.textContent = label;
		item.appendChild(title);
		if (hint) {
			const sub = document.createElement("span");
			sub.textContent = hint;
			item.appendChild(sub);
		}
		item.addEventListener("click", () => {
			closeMsgMenu();
			onSelect();
		});
		menu.appendChild(item);
		return item;
	}

	async function copyMessageText(text) {
		const raw = String(text ?? "");
		try {
			await navigator.clipboard.writeText(raw);
			return true;
		} catch {
			/* 非安全上下文 / 没有剪贴板权限：退回 execCommand */
		}
		try {
			const ta = document.createElement("textarea");
			ta.value = raw;
			ta.setAttribute("readonly", "");
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		} catch {
			return false;
		}
	}

	function openMsgMenu(ev, node, row) {
		closeMsgMenu();
		node.classList.add("ctx");
		const menu = document.createElement("div");
		menu.className = "fp-cv-menu";
		menu.setAttribute("role", "menu");
		menu.setAttribute("aria-label", "消息操作");
		if (aiBusy) {
			const note = document.createElement("div");
			note.className = "fp-cv-menu-note";
			note.textContent = "AI 正在生成这一轮回复，等它出来再试";
			menu.appendChild(note);
		} else {
			const who = identityLabel();
			addMenuItem(menu, {
				label: "AI 直接回复这条",
				hint: `生成后立即以「${who}」身份发出`,
				onSelect: () => void runAiReply("direct", { messageId: row.id, target: row }),
			});
			addMenuItem(menu, {
				label: "AI 预览回复这条",
				hint: "先生成，改完再点「发送这条」",
				onSelect: () => void runAiReply("preview", { messageId: row.id, target: row }),
			});
		}
		const sep = document.createElement("div");
		sep.className = "fp-cv-menu-sep";
		menu.appendChild(sep);
		addMenuItem(menu, {
			label: "复制文字",
			hint: clip(row.text, 36) || "（这条没有可复制的文本）",
			onSelect: () => {
				void copyMessageText(row.text).then((ok) => {
					say?.(ok ? "已复制这条消息" : "复制失败：浏览器拒绝了剪贴板", ok ? "ok" : "error");
				});
			},
		});
		document.body.appendChild(menu);
		// 先挂再量：位置按实际尺寸收进视口（右下角右键不会把菜单顶出屏幕）。
		const box = menu.getBoundingClientRect();
		const left = Math.max(8, Math.min(ev.clientX, window.innerWidth - box.width - 8));
		const top = Math.max(8, Math.min(ev.clientY, window.innerHeight - box.height - 8));
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;

		const offDown = (e) => {
			if (!menu.contains(e.target)) closeMsgMenu();
		};
		const offKey = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				closeMsgMenu();
			}
		};
		const offViewport = () => closeMsgMenu();
		document.addEventListener("pointerdown", offDown, true);
		document.addEventListener("keydown", offKey, true);
		window.addEventListener("scroll", offViewport, true);
		window.addEventListener("resize", offViewport);
		activeMsgMenu = {
			el: menu,
			node,
			offs: [
				() => document.removeEventListener("pointerdown", offDown, true),
				() => document.removeEventListener("keydown", offKey, true),
				() => window.removeEventListener("scroll", offViewport, true),
				() => window.removeEventListener("resize", offViewport),
			],
		};
		menu.querySelector(".fp-cv-menu-item")?.focus();
	}

	elMsgs.addEventListener("contextmenu", (ev) => {
		const target = ev.target instanceof Element ? ev.target : null;
		const node = target?.closest(".fp-cv-msg");
		if (!node || !elMsgs.contains(node)) return;
		// 选中的文字留给系统菜单（复制/搜索）；只有空白处右键才是「对这条消息做什么」。
		const picked = String(window.getSelection?.()?.toString() || "").trim();
		if (picked) return;
		const row = currentRows.find((r) => String(r.id) === node.getAttribute("data-mid"));
		if (!row) return;
		ev.preventDefault();
		openMsgMenu(ev, node, row);
	});

	/* ---------------------- 当前会话的自动刷新（5s） ---------------------- */
	//
	// 会话页没有推送通道，靠轮询当前会话做到「有新消息就自己冒出来」；
	// 只在 tab 可见 + 会话没换 时才拉，且**没有新消息就不重绘**（避免滚动位置被打断）。
	//
	// 服务端已经把这些请求变成「读缓存 + 后台补增量」（`GET /chat/messages` 返回 `cache.refreshing`
	// 表示它正在后台拉），所以这里的 5s 轮询几乎不产生 CLI 子进程；真正的体验瓶颈变成了
	// 「切换会话那一下」—— 由下面的内存 `rowCache` 解决。

	let refreshTimer = null;
	// 未读徽标单独一条定时器：15s 只拉 unread 表，跟消息轮询（5s）解耦。
	let unreadTimer = null;
	// 服务端说「后台正在补增量」时的一次性快速重试（不是定时器，拿到就走）。
	let followUpTimer = null;
	let lastTopId = "";
	// 会话 → 已渲染过的消息行：切回去先出内容，再等网络（这就是「切换会话不用再等」）。
	const rowCache = new Map();

	function stopAutoRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		if (followUpTimer) {
			clearTimeout(followUpTimer);
			followUpTimer = null;
		}
	}

	/** 缓存时间的人话：刚刚 / 23s 前 / 5 分钟前。 */
	function ageLabel(ms) {
		const n = Number(ms) || 0;
		if (!n) return "";
		if (n < 3000) return "刚刚";
		if (n < 60_000) return `${Math.round(n / 1000)}s 前`;
		if (n < 3600_000) return `${Math.round(n / 60_000)} 分钟前`;
		return `${Math.round(n / 3600_000)} 小时前`;
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

	/** 服务端说「后台在补增量」时，过一次就快速回来看一眼（新消息通常在几百毫秒内落库）。 */
	function scheduleFollowUp(chatId) {
		if (followUpTimer) clearTimeout(followUpTimer);
		followUpTimer = setTimeout(() => {
			followUpTimer = null;
			void refreshMessages(chatId);
		}, 800);
		followUpTimer?.unref?.();
	}

	/** 顶部的「本地缓存」标记：告诉用户这份内容是现拉的还是缓存里马上就有的。 */
	function paintCacheHint(payload) {
		const el = elCache;
		if (!el) return;
		const info = payload?.cache;
		if (!info) {
			el.textContent = "";
			return;
		}
		const age = ageLabel(info.ageMs);
		const parts = [];
		parts.push(age ? `本地缓存 · ${age}` : "本地缓存");
		if (Number(info.rows)) parts.push(`${Number(info.rows)} 条`);
		if (info.refreshing) parts.push("刷新中…");
		if (info.error) parts.push(`刷新失败：${info.error}`);
		el.textContent = parts.join(" · ");
		el.title = info.error
			? `后台刷新失败：${info.error}（下面显示的是本地缓存内容）`
			: "内容来自本地缓存；后台会自动补增量，点「刷新」立刻向飞书要最新的";
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
			paintCacheHint(payload);
			// 服务端在后台补增量 → 稍后再来一次（比等下个 5s 更跟手，也不会堆积请求）。
			if (payload.refreshing) scheduleFollowUp(chatId);
			if (topId && topId === lastTopId) return; // 无新消息：不重绘
			// 有新消息落在这个打开着的会话里 → 立刻按已读处理（用户正看着，不该再计未读）
			if (chats.find((c) => c.id === chatId)?.unread || Number(selected?.unread) > 0) markChatRead(chatId);
			lastTopId = topId;
			if (payload.label && payload.label !== selected.label) {
				selected.label = payload.label;
				paintList();
				paintReader();
			}
			rowCache.set(chatId, rows);
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

	async function openChat(id, { refresh = false } = {}) {
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
		// 换了会话：上一段的 AI 要点、目标消息与预览草稿都不再适用（发错人比重生成一次贵得多）。
		elAiWant.value = "";
		aiTarget = null;
		closeMsgMenu();
		hideDraft();
		setComposeHint("");
		if (elCache) elCache.textContent = "读取中…";
		// 切回去先显示上一次看到的那些（内存缓存）：一毫秒就有内容，再等网络补最新的。
		const remembered = rowCache.get(id) || [];
		if (remembered.length) {
			lastTopId = remembered[0]?.id || "";
			paintMessages(remembered);
		} else {
			elMsgs.innerHTML = `<div class="fp-cv-empty">读取消息…</div>`;
		}
		try {
			const payload = await call(
				`/chat/messages?chatId=${encodeURIComponent(id)}&limit=40${refresh ? "&refresh=1" : ""}`,
			);
			// 打开会话**不改列表里的名字**（用户希望列表名保持原样，只在右侧标题按需展示）。
			// 打开即视为已读：清掉服务端累计 + 本地徽标（/dm/read 的语义就是「我看到了」）。
			markChatRead(id);
			const rows = Array.isArray(payload.items) ? payload.items : [];
			lastTopId = rows[0]?.id || "";
			rowCache.set(id, rows);
			paintMessages(rows, { keepScroll: remembered.length > 0 });
			paintCacheHint(payload);
			if (payload.refreshing) scheduleFollowUp(id);
			setHint(payload.namesError ? `发送人姓名查询失败（不影响内容）：${payload.namesError}` : "");
			startAutoRefresh(id);
		} catch (err) {
			// 有内存缓存就别把内容清空：把失败原因写在标题旁边即可。
			if (!remembered.length) elMsgs.innerHTML = "";
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
		// 检索命中行：点一下就跳到那个会话（并退出检索态，不然列表还是命中列表）。
		const hit = ev.target?.closest?.(".fp-cv-hit");
		if (hit) {
			const id = hit.getAttribute("data-chat") || "";
			elFind.value = "";
			hits = null;
			hitsQuery = "";
			if (id) void openChat(id);
			return;
		}
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

	/* --------------------------- 本地消息检索 --------------------------- */
	//
	// 数据来自 `GET /chat/search`：只翻本地缓存（后台轮询 + 打开过的会话 + AI 读过的），
	// 不打飞书接口。所以它快、免费、离线也能用 —— 这是「拉回来的内容要能被二次检索」的落点。

	async function runLocalSearch(query) {
		const needle = String(query ?? "").trim();
		hitsQuery = needle;
		if (needle.length < 2) {
			hits = null;
			hitsBusy = false;
			paintList();
			return;
		}
		hitsBusy = true;
		if (hits === null) hits = [];
		paintHits();
		try {
			const payload = await call(`/chat/search?q=${encodeURIComponent(needle)}&limit=40`);
			if (disposed || hitsQuery !== needle) return; // 期间又改了关键词：丢掉这次结果
			hits = Array.isArray(payload.items) ? payload.items : [];
			hitsBusy = false;
			paintHits();
		} catch (err) {
			if (disposed) return;
			hitsBusy = false;
			hits = [];
			elCount.textContent = "检索失败";
			elList.innerHTML = `<div class="fp-cv-empty">本地检索失败：${esc(err?.message || err)}</div>`;
		}
	}

	elFind.addEventListener("input", () => {
		if (findTimer) clearTimeout(findTimer);
		findTimer = setTimeout(() => {
			findTimer = null;
			void runLocalSearch(elFind.value);
		}, 300);
		findTimer?.unref?.();
	});
	elFind.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			if (findTimer) {
				clearTimeout(findTimer);
				findTimer = null;
			}
			void runLocalSearch(elFind.value);
		}
		if (ev.key === "Escape") {
			elFind.value = "";
			void runLocalSearch("");
		}
	});

	$(".fp-cv-refresh").addEventListener("click", () => void loadList());

	/** 「刷新」按钮：向飞书要最新的（不等后台轮询），不清输入框里的草稿。 */
	async function reloadSelected() {
		if (!selected || busy) return;
		const id = selected.id;
		busy = true;
		if (elCache) elCache.textContent = "刷新中…";
		try {
			const payload = await call(`/chat/messages?chatId=${encodeURIComponent(id)}&limit=40&refresh=1`);
			if (disposed || selected?.id !== id) return;
			const rows = Array.isArray(payload.items) ? payload.items : [];
			lastTopId = rows[0]?.id || "";
			rowCache.set(id, rows);
			paintMessages(rows, { keepScroll: true });
			paintCacheHint(payload);
			setHint(payload.namesError ? `发送人姓名查询失败（不影响内容）：${payload.namesError}` : "");
		} catch (err) {
			setHint(`刷新失败：${err?.message || err}`, true);
		} finally {
			busy = false;
		}
	}

	$(".fp-cv-reload").addEventListener("click", () => void reloadSelected());

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

	/* ---------------------------- AI 回复的事件接线 ---------------------------- */

	// 「再生成」沿用同一锚点消息（回谁不变，只换措辞）；消息已被轮询刷掉时退回上次的快照。
	elAiDraftRegen.addEventListener("click", () => {
		const row = aiTarget ? currentRows.find((r) => String(r.id) === aiTarget.id) : null;
		void runAiReply("preview", { messageId: aiTarget?.id || "", target: row || aiTarget });
	});
	elAiDraftClose.addEventListener("click", () => hideDraft());
	elAiDraftSend.addEventListener("click", () => void sendAiDraft());
	elAiDraftText.addEventListener("input", () => {
		elAiDraftSend.disabled = !elAiDraftText.value.trim();
		paintDraftMeta();
	});
	elAiDraftText.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			void sendAiDraft();
		}
		if (ev.key === "Escape") hideDraft();
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
			// 监听名单 = 手填的会话清单：这些会话无论单聊群聊都会进后台同步并弹提醒。
			say?.(watch ? "已加入后台同步（这个会话的新消息会同步并提醒）" : "已从同步名单中移除", "ok");
			if (payload?.dm && !payload.dm.config?.enabled) {
				setHint("已加入同步名单，但同步还没启用：到「设置 → 消息同步与提醒」勾上「启用后台同步」");
			}
		} catch (err) {
			setHint(`监听设置失败：${err?.message || err}`, true);
		}
	});

	/**
	 * 同步跳过原因 → 人话（与设置页那张卡同一套口径）。
	 * `busy` 是正常结果：手动同步与定时轮询共用一条路径，上一轮没跑完就会跳过。
	 */
	function skipSyncText(reason) {
		switch (String(reason || "")) {
			case "busy":
				return "正在同步中（上一轮还没跑完），稍等一下";
			case "no-channel":
				return "lark-cli 未就绪：到「设置 → lark-cli」完成安装 / 配置 / 登录";
			case "no-chats":
				return "没有可同步的会话：到「同步设置」勾上同步范围或填 chat_id";
			default:
				return "没有新消息";
		}
	}

	/* ---------------------- 顶部「立即同步 / 同步设置」 ---------------------- */
	//
	// 为什么要在会话页放这两个按钮：用户日常待在这个页签，以前只能去「设置」里摸到轮询开关，
	// 在会话页看不到「同步到底开没开、刚同步了几条」—— 于是“新消息怎么不自己冒出来”只能靠猜。
	// 这里只做「状态 + 一键触发」，**开关仍然只有一个地方**（设置页那张卡），避免两处配置打架。

	let syncing = false;

	async function runSyncNow() {
		if (syncing) return;
		syncing = true;
		const label = elSyncRun.textContent;
		elSyncRun.textContent = "同步中…";
		elSyncRun.disabled = true;
		try {
			const payload = await call("/sync/run", { method: "POST", timeoutMs: 240_000 });
			paintSyncState(payload);
			const synced = payload?.synced || {};
			if (synced.skipped) say?.(skipSyncText(synced.skipped));
			else
				say?.(
					`${synced.waited ? "上一轮刚跑完" : "已同步"} ${synced.chats} 个会话 / ${synced.rows} 条消息，新增 ${
						synced.fresh
					} 条（首轮只建基线不提醒）`,
					"ok",
				);
			// 同步完列表上的「最后一条」可能变了：只重绘当前列表的预览，不重拉会话列表（那是 CLI 子进程）。
			await refreshPoller();
		} catch (err) {
			setHint(`同步失败：${err?.message || err}`, true);
		} finally {
			syncing = false;
			elSyncRun.textContent = label;
			elSyncRun.disabled = false;
		}
	}

	elSyncRun.addEventListener("click", () => void runSyncNow());
	elSyncCfg.addEventListener("click", () => {
		if (typeof onOpenSettings === "function") onOpenSettings();
		else setHint("到「设置 → 消息同步与提醒」里改同步范围与间隔", true);
	});

	// 挂载即刷一次（未读 + 同步状态），之后每 15s 跟一次（`/dm/state` 是内存状态，很轻）。
	void refreshPoller();
	unreadTimer = setInterval(() => void refreshPoller(), 15000);
	unreadTimer?.unref?.();

	return {
		refresh: loadList,
		/** 供其它页签跳转（待办的「看原话」要落到具体会话）。 */
		openChat,
		destroy() {
			disposed = true;
			stopAutoRefresh();
			if (unreadTimer) {
				clearInterval(unreadTimer);
				unreadTimer = null;
			}
			if (findTimer) {
				clearTimeout(findTimer);
				findTimer = null;
			}
			rowCache.clear();
			closeMsgMenu();
			closeLightbox();
			closeMentionCard();
			root.remove();
		},
	};
}
