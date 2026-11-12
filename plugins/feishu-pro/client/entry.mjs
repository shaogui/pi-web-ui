/**
 * plugins/feishu-pro/client/entry.mjs
 * 飞书 Pro 工作台：通讯录 / 云文档（搜索·我的空间·知识库）/ 设置（双身份配置与授权）。
 *
 * 三条设计红线（都是前人踩过的）：
 *   1. 头像不用远端 <img>：宿主 CSP 未必放行外域图片，且拉远端图片等于把"我正在看谁"
 *      泄露给飞书 CDN —— 统一用姓名首字圆形头像；
 *   2. 所有插值一律 esc()：文档标题/姓名来自企业数据，属于不可信输入；
 *   3. 输入框类控件**不做整页重渲染**：只更新列表/状态容器，否则打字时光标会跳。
 *
 * 与服务端的契约：/plugins-api/feishu-pro/* + {ok:true,...} / {ok:false,error,needUser}。
 * `@` 提及补全（composerProviders）在模块顶层注册，这样不打开本视图也能用。
 */

import { apiBase, esc, hostApi } from "@pi-web-ui/plugin-sdk/client";
// 文档渲染器：lark-cli 的 markdown / docx blocks 两种形态都能画（纯 vnode 层，无 innerHTML）。
import { docPlainText, mountDocReader } from "./doc-reader.mjs";
// 设置页：分区导航 + 分组区（lark-cli 三态 / 同步 / 自动问答 / 诊断 / 关于）自己管 DOM，
// entry 只提供传输层与 `/state` 缓存 —— 设置页的模板不再塞进这里那个巨型字符串。
import { mountSettingsView } from "./settings-view.mjs";
import { mountChatsView } from "./chats-view.mjs";
// AI 待办页签：本地待办库 + AI 建议 + 一键让 AI 处理（独立模块，不塞进下面的巨型模板字符串）。
import { mountTodoView } from "./todo-view.mjs";
// 通讯录行内的「发消息 / 打开飞书」：独立模块 + DOM 后置增强，避免改动下面的渲染函数。
import { mountContactActions } from "./contact-actions.mjs";

const PLUGIN_ID = "feishu-pro";
const BASE = apiBase(PLUGIN_ID);
const DEBOUNCE_MS = 250;

/* ------------------------------- 传输层 ------------------------------- */

async function call(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
	const init = {
		method,
		credentials: "same-origin",
		signal: AbortSignal.timeout(timeoutMs),
	};
	// GET 禁止带 body（fetch 会直接抛 TypeError）；只有写操作才加头与载荷。
	if (method !== "GET" && body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const resp = await fetch(`${BASE}${path}`, init);
	let payload;
	try {
		payload = await resp.json();
	} catch {
		// 插件路由 404 = 服务端还在跑旧代码（热改插件文件不会自动重载），提示可执行动作。
		const stale = resp.status === 404 ? "——插件服务端可能还是旧代码，到「插件」面板点「重新加载」" : "";
		throw Object.assign(new Error(`服务端返回非 JSON（HTTP ${resp.status}）${stale}`), { needUser: false });
	}
	if (!payload || payload.ok !== true) {
		throw Object.assign(new Error(payload?.error || `请求失败（HTTP ${resp.status}）`), {
			needUser: Boolean(payload?.needUser),
			code: payload?.code ?? null,
			detail: payload?.detail ?? null,
			// CliError 的「下一步该做什么」在 `cli.hint`：不带出来，界面只剩一句英文权限码。
			cli: payload?.cli ?? null,
		});
	}
	return payload;
}

const q = (value) => encodeURIComponent(String(value ?? ""));

/* --------------------------- `@` 提及补全提供者 --------------------------- */

let providersRegistered = false;

function hintHit(prefix, err) {
	const text = String(err?.message || err);
	return [{ title: `${prefix}：${text.slice(0, 60)}`, text: "" }];
}

async function searchDocHits(query) {
	const keyword = String(query ?? "").trim();
	if (!keyword) return [];
	try {
		const r = await call(`/docs/search?q=${q(keyword)}&count=8`, { timeoutMs: 1600 });
		return (r.items || []).slice(0, 8).map((doc) => ({
			title: doc.title,
			hint: [doc.typeLabel, doc.updatedAt ? formatDay(doc.updatedAt) : ""].filter(Boolean).join(" · "),
			text: `【飞书文档】${doc.title}${doc.url ? ` ${doc.url}` : ""}`,
		}));
	} catch (err) {
		return hintHit("飞书文档", err);
	}
}

async function searchContactHits(query) {
	const keyword = String(query ?? "").trim();
	if (!keyword) return [];
	try {
		const r = await call(`/contacts/search?q=${q(keyword)}&limit=8`, { timeoutMs: 1600 });
		return (r.items || []).slice(0, 8).map((user) => ({
			title: user.name || user.openId,
			hint: [user.jobTitle, user.email].filter(Boolean).join(" · ") || user.openId,
			text: `【飞书通讯录】${user.name}${user.jobTitle ? `（${user.jobTitle}）` : ""} open_id: ${user.openId}`,
		}));
	} catch (err) {
		return hintHit("飞书通讯录", err);
	}
}

/** 注册 `@` 提供者：宿主 API 还没装好时退避重试（页面刚启动的竞态）。 */
function ensureComposerProviders(attempt = 0) {
	if (providersRegistered) return;
	const host = hostApi();
	const register = host?.composerProviders?.register;
	if (typeof register !== "function") {
		if (attempt < 20) setTimeout(() => ensureComposerProviders(attempt + 1), 500);
		return;
	}
	try {
		register({ id: "feishu-pro:docs", label: "飞书文档", search: searchDocHits });
		register({ id: "feishu-pro:contacts", label: "飞书通讯录", search: searchContactHits });
		providersRegistered = true;
	} catch {
		if (attempt < 20) setTimeout(() => ensureComposerProviders(attempt + 1), 500);
	}
}

/* -------------------------------- 工具函数 -------------------------------- */

/** 相对时间（"3 分钟前"），超过一天回落到 formatDay。访问时间用这个最直观。 */
function formatAgo(ms) {
	const value = Number(ms);
	if (!value) return "";
	const diff = Date.now() - value;
	if (diff < 0) return formatDay(value);
	const min = Math.floor(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	const day = Math.floor(hour / 24);
	if (day < 7) return `${day} 天前`;
	return formatDay(value);
}

/** 三个时间拼成一行：访问（本插件记）· 创建 · 修改。 */
function timesLine(doc) {
	const parts = [];
	if (doc.accessedAt) parts.push(`访问 ${formatAgo(doc.accessedAt)}`);
	if (doc.createdAt) parts.push(`创建 ${formatDay(doc.createdAt)}`);
	if (doc.modifiedAt) parts.push(`修改 ${formatDay(doc.modifiedAt)}`);
	return parts.join(" · ");
}

function formatDay(ms) {
	const value = Number(ms);
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (sameDay) return `今天 ${time}`;
	const sameYear = date.getFullYear() === now.getFullYear();
	return `${sameYear ? "" : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function initialOf(name) {
	const text = String(name ?? "").trim();
	if (!text) return "?";
	return [...text][0] ?? "?";
}

function colorOf(seed) {
	const palette = ["#5b8ff9", "#61ddaa", "#f6bd16", "#7262fd", "#78d3f8", "#9661bc", "#f6903d", "#008685"];
	let hash = 0;
	for (const ch of String(seed ?? "")) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
	return palette[hash % palette.length];
}

function avatarHtml(name, seed) {
	return `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;flex:0 0 auto;font-size:12px;font-weight:600;color:#fff;background:${colorOf(seed || name)}">${esc(initialOf(name))}</span>`;
}

/** 一行：主标题 + 次要说明，行尾动作按钮。长文本按三件套收敛，不许把布局顶破。 */
function rowHtml({ avatar, title, subtitle, badge, actions }) {
	return `<div class="fp-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;">
		${avatar || ""}
		<div style="flex:1;min-width:0;">
			<div style="display:flex;align-items:center;gap:6px;min-width:0;">
				<span style="font-size:13px;font-weight:520;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(title)}</span>
				${badge ? `<span style="flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid var(--border);color:var(--text-dim);">${esc(badge)}</span>` : ""}
			</div>
			${subtitle ? `<div title="${esc(subtitle)}" style="font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(subtitle)}</div>` : ""}
		</div>
		<div style="display:flex;gap:6px;flex:0 0 auto;">${actions}</div>
	</div>`;
}

const BTN =
	"padding:5px 11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);cursor:pointer;font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;";
const BTN_PRIMARY =
	"padding:5px 11px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-contrast,#fff);cursor:pointer;font:inherit;font-size:12px;line-height:1.4;font-weight:600;white-space:nowrap;";
const INPUT =
	"width:100%;min-width:0;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;line-height:1.5;outline:none;";

/*
 * 样式表：设置页要的是「卡片 + 栅格 + 层级」，靠内联 style 拼不出来（且行高/间距会各写各的），
 * 因此统一收进一张前缀 fp- 的样式表按 id 幂等注入（只注入一次，卸载视图不摘）。
 * 三条约束：① 只用主题令牌（--bg/--border/--accent…），不写死颜色，跟随主题切换；
 * ② 实底强调色文字走 --accent-contrast；③ 长文本一律 overflow-wrap/word-break 兜底。
 */
const STYLE_ID = "fp-pro-styles";
const STYLES = `
.fp-root{display:flex;flex-direction:column;height:100%;width:100%;background:var(--bg);color:var(--text);font-size:13px;overflow:hidden;box-sizing:border-box;}
.fp-root *,.fp-root *::before,.fp-root *::after{box-sizing:border-box;}
.fp-topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg-elev);flex-wrap:wrap;}
.fp-brand{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:600;flex:0 0 auto;}
.fp-brand-ico{font-size:17px;line-height:1;}
.fp-status{display:none;padding:7px 16px;font-size:12px;line-height:1.6;border-bottom:1px solid var(--border);background:var(--bg-elev);color:var(--text-dim);overflow-wrap:anywhere;}
.fp-status[data-tone="ok"]{color:var(--green);}
.fp-status[data-tone="error"]{color:var(--red);}
/* 状态胶囊 */
.fp-pill{flex:0 0 auto;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.7;padding:2px 9px;border-radius:999px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);}
.fp-pill.ok{color:var(--green);border-color:var(--green);background:var(--green-soft);}
.fp-pill.warn{color:var(--amber);border-color:var(--amber);background:rgba(251,191,36,.12);}
.fp-pill.err{color:var(--red);border-color:var(--red);background:var(--red-soft);}
.fp-pill.accent{color:var(--accent);border-color:var(--accent);background:var(--accent-soft);}
/* 分段式页签 */
.fp-tabs{display:inline-flex;gap:2px;padding:3px;border-radius:9px;border:1px solid var(--border);background:var(--bg-elev2);}
.fp-tab{border:none;background:transparent;color:var(--text-dim);font:inherit;font-size:12px;line-height:1.4;padding:5px 13px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s;}
.fp-tab:hover{color:var(--text);}
.fp-tab.active{background:var(--bg);color:var(--text);font-weight:600;}
/* 按钮 / 输入 */
.fp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text);font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s;}
.fp-btn:hover{border-color:var(--accent);color:var(--accent);}
.fp-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
.fp-btn[disabled]{opacity:.55;cursor:not-allowed;}
.fp-btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast,#fff);font-weight:600;}
.fp-btn-primary:hover{border-color:var(--accent);color:var(--accent-contrast,#fff);filter:brightness(1.08);}
.fp-btn-danger:hover{border-color:var(--red);color:var(--red);}
.fp-btn-sm{padding:3px 9px;font-size:11px;}
.fp-input{width:100%;min-width:0;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;font-size:12px;line-height:1.5;outline:none;transition:border-color .15s,box-shadow .15s;}
.fp-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
.fp-input::placeholder{color:var(--text-faint);}
textarea.fp-input{resize:vertical;}
select.fp-input{cursor:pointer;}
/* 卡片（同步 / 自动问答面板与设置页分区共用骨架） */
.fp-card{border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);min-width:0;}
.fp-card-head{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border-soft);}
.fp-card-titles{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.fp-card-title{font-size:13px;font-weight:600;}
.fp-card-desc{font-size:11.5px;line-height:1.6;color:var(--text-dim);}
.fp-card-body{display:flex;flex-direction:column;gap:12px;padding:14px;}
/* 卡底动作条：只有"改了但还没保存"时才出现（sticky 在卡内，不遮住上方控件） */
.fp-card-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 14px;border-top:1px solid var(--border);border-radius:0 0 10px 10px;background:var(--bg-elev);}
.fp-card-foot-note{font-size:11.5px;line-height:1.6;color:var(--amber);}
.fp-card-foot-actions{display:flex;gap:8px;margin-left:auto;}
/* 表单栅格：标签在上、控件在下（窄屏自动单列，标签不再被压成一行挤输入框） */
.fp-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 16px;align-items:start;}
.fp-field{display:flex;flex-direction:column;gap:5px;min-width:0;}
.fp-field-wide{grid-column:1/-1;}
.fp-field-label{font-size:11px;font-weight:600;line-height:1.6;color:var(--text-dim);}
.fp-field-hint{font-size:11px;line-height:1.65;color:var(--text-faint);overflow-wrap:anywhere;}
.fp-field-hint.err{color:var(--red);}
.fp-field-hint code,.fp-field-hint b{color:var(--text-dim);}
.fp-check{display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:12.5px;line-height:1.5;color:var(--text-dim);cursor:pointer;}
.fp-mono{font-family:var(--mono);font-size:11.5px;}
/* 折叠区（低频内容：手填 ID / 预览 / 历史） */
.fp-fold{border:1px solid var(--border);border-radius:9px;background:var(--bg);overflow:hidden;}
.fp-fold > summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;font-size:11.5px;font-weight:600;line-height:1.6;color:var(--text-dim);list-style:none;}
.fp-fold > summary::-webkit-details-marker{display:none;}
.fp-fold > summary::after{content:"▾";margin-left:auto;font-size:11px;color:var(--text-faint);transition:transform .15s;}
.fp-fold[open] > summary::after{transform:rotate(180deg);}
.fp-fold > summary:hover{color:var(--text);}
.fp-fold-body{display:flex;flex-direction:column;gap:9px;padding:0 12px 12px;}
`;

/** 幂等注入样式表：视图被反复打开也只留一份。 */
function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

function insertToComposer(text) {
	const compose = hostApi()?.compose;
	if (typeof compose === "function") {
		try {
			if (compose({ text })) return Promise.resolve(true);
		} catch {
			/* 落到剪贴板 */
		}
	}
	return copyText(text);
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/* --------------------------------- 视图 --------------------------------- */

function renderWorkbench(container) {
	container.innerHTML = `
	<div class="fp-root" style="display:flex;flex-direction:column;height:100%;width:100%;background:var(--bg);color:var(--text);font-size:13px;overflow:hidden;box-sizing:border-box;">
		<div class="fp-topbar">
			<div class="fp-brand"><span class="fp-brand-ico">🪶</span><span>飞书 Pro</span></div>
			<span class="fp-pill fp-badge-app">应用身份：检测中</span>
			<span class="fp-pill fp-badge-user">个人身份：未登录</span>
			<div style="flex:1;min-width:8px;"></div>
			<div class="fp-tabs">
				<button class="fp-tab" data-tab="chats">会话</button>
				<button class="fp-tab" data-tab="todos">待办</button>
				<button class="fp-tab" data-tab="contacts">通讯录</button>
				<button class="fp-tab" data-tab="docs">云文档</button>
				<button class="fp-tab" data-tab="settings">设置</button>
			</div>
		</div>
		<div class="fp-status" data-tone="info" style="display:none;"></div>

		<!-- 会话（左列表 + 右只读消息） -->
		<div class="fp-panel" data-panel="chats" style="flex:1;min-height:0;display:none;flex-direction:column;">
			<div class="fp-chats-slot" style="display:flex;flex:1;min-height:0;"></div>
		</div>

		<!-- 待办（AI 盯着的事：建议 + 一键处理） -->
		<div class="fp-panel" data-panel="todos" style="flex:1;min-height:0;display:none;flex-direction:column;">
			<div class="fp-todos-slot" style="display:flex;flex:1;min-height:0;"></div>
		</div>

		<!-- 通讯录 -->
		<div class="fp-panel" data-panel="contacts" style="flex:1;min-height:0;display:flex;flex-direction:column;">
			<div style="display:flex;gap:8px;padding:10px 16px;align-items:center;flex-wrap:wrap;">
				<input class="fp-contact-q" placeholder="搜索同事（姓名 / 邮箱）…" style="${INPUT}flex:1;min-width:180px;" />
				<button class="fp-contact-go" style="${BTN_PRIMARY}">搜索</button>
				<button class="fp-contact-root" style="${BTN}">可见范围</button>
			</div>
			<div class="fp-contact-hint" style="padding:0 16px 6px;font-size:11px;color:var(--text-dim);"></div>
			<div class="fp-contact-list" style="flex:1;min-height:0;overflow:auto;padding:0 8px 12px;"></div>
		</div>

		<!-- 云文档 -->
		<div class="fp-panel" data-panel="docs" style="flex:1;min-height:0;display:none;flex-direction:row;">
			<div style="flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--border);">
				<div style="display:flex;gap:8px;padding:10px 16px;align-items:center;flex-wrap:wrap;">
					<button class="fp-doc-mode" data-mode="recent" style="${BTN}">最近访问</button>
					<button class="fp-doc-mode" data-mode="drive" style="${BTN}">我的空间</button>
					<button class="fp-doc-mode" data-mode="wiki" style="${BTN}">知识库</button>
					<button class="fp-doc-mode" data-mode="search" style="${BTN}">搜索</button>
					<select class="fp-drive-order" title="我的空间排序" style="${INPUT}display:none;">
						<option value="EditedTime">按修改时间</option>
						<option value="CreatedTime">按创建时间</option>
					</select>
					<button class="fp-recent-clear" style="${BTN}display:none;">清空记录</button>
					<div style="flex:1;"></div>
					<input class="fp-doc-q" placeholder="搜索云文档…" style="${INPUT}width:200px;display:none;" />
					<button class="fp-doc-go" style="${BTN_PRIMARY}display:none;">搜索</button>
				</div>
				<div class="fp-doc-hint" style="padding:0 16px 6px;font-size:11px;color:var(--text-dim);"></div>
				<div class="fp-doc-list" style="flex:1;min-height:0;overflow:auto;padding:0 8px 12px;"></div>
			</div>
			<div class="fp-reader" style="width:44%;min-width:240px;display:none;flex-direction:column;">
				<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);">
					<span class="fp-reader-title" style="flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
					<button class="fp-reader-insert" style="${BTN}">引用</button>
					<button class="fp-reader-copy" style="${BTN}">复制</button>
					<button class="fp-reader-close" style="${BTN}">✕</button>
				</div>
				<div style="padding:6px 14px;font-size:11px;color:var(--text-dim);" class="fp-reader-url"></div>
				<div class="fp-reader-body" style="flex:1;min-height:0;overflow:auto;padding:8px 14px 16px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.65;"></div>
			</div>
		</div>

		<!-- 设置：分区导航 + 分组区，全部逻辑在 client/settings-view.mjs（entry 只给一个槽） -->
		<div class="fp-panel" data-panel="settings" style="flex:1;min-height:0;display:none;overflow:hidden;">
			<div class="fp-settings-slot" style="height:100%;min-height:0;"></div>
		</div>
	</div>`;
	return container.querySelector(".fp-root");
}

function statusWriter(root) {
	const box = root.querySelector(".fp-status");
	let timer = null;
	const api = {
		show(text, tone = "info") {
			if (!box) return;
			if (!text) {
				box.style.display = "none";
				box.textContent = "";
				return;
			}
			box.style.display = "block";
			box.textContent = text;
			box.dataset.tone = tone === "error" ? "error" : tone === "ok" ? "ok" : "info";
			if (timer) clearTimeout(timer);
			if (tone !== "error") timer = setTimeout(() => api.show(""), 4000);
		},
	};
	return api;
}

function mount(el, _ctx) {
	injectStyles();
	const root = renderWorkbench(el);
	const status = statusWriter(root);

	const state = {
		info: null,
		tab: "contacts",
		contactQuery: "",
		docMode: "recent",
		driveOrder: "EditedTime",
		docQuery: "",
		driveStack: [],
		wikiStack: [],
		reading: null,
	};

	// 记住上次停留的页签：顶栏「飞书 Pro」入口（带待办徽标）打开的是整个工作台，
	// 不记的话每次回来都会落回默认页（默认页现在是待办本身）。
	const TAB_KEY = "fp.tab";
	const readTab = () => {
		try {
			const saved = localStorage.getItem(TAB_KEY) || "";
			return ["chats", "todos", "contacts", "docs", "settings"].includes(saved) ? saved : "";
		} catch {
			return "";
		}
	};

	const contactsPanel = root.querySelector('[data-panel="contacts"]');
	const chatsPanel = root.querySelector('[data-panel="chats"]');
	// 会话页：双栏（列表 + 只读消息）自己管 DOM，entry 只提供传输层。
	const chatsView = mountChatsView({
		panel: chatsPanel?.querySelector(".fp-chats-slot") ?? chatsPanel,
		call,
		say: (text, tone) => status.show(text, tone),
		// 「会话」页的同步状态条需要“跳去设置改开关”：两个页签之间只有 entry 知道怎么切。
		onOpenSettings: () => switchTab("settings"),
	});
	const docsPanel = root.querySelector('[data-panel="docs"]');
	// 待办页：本地库 + AI 建议 + 动作执行，自己管 DOM；entry 只提供传输层与「插入输入框」。
	const todosPanel = root.querySelector('[data-panel="todos"]');
	const todoView = mountTodoView({
		panel: todosPanel?.querySelector(".fp-todos-slot") ?? todosPanel,
		call,
		say: (text, tone) => status.show(text, tone),
		compose: (text) => insertToComposer(text),
		// 「看原话」：切到会话页并打开来件会话（两个页签之间只有 entry 知道怎么切）。
		onOpenChat: (chatId) => {
			if (!chatId) return;
			switchTab("chats");
			void chatsView.openChat?.(chatId);
		},
	});
	const settingsPanel = root.querySelector('[data-panel="settings"]');
	// 设置页：分区导航 + 分组区（lark-cli 三态 / 同步 / 自动问答 / 诊断 / 关于），自己管 DOM。
	// 只把传输层和 `/state` 缓存递进去：`/state` 只有一份（顶栏两枚胶囊也读它）。
	const settingsView = mountSettingsView({
		panel: settingsPanel?.querySelector(".fp-settings-slot") ?? settingsPanel,
		call,
		getInfo: () => state.info,
		refreshInfo: () => refreshState(),
	});
	const contactList = root.querySelector(".fp-contact-list");
	// 给每个联系人行补「发消息 / 打开飞书」两个动作（不侵入渲染函数）。
	const contactActions = mountContactActions({
		list: contactList,
		call,
		say: (text, tone) => status.show(text, tone),
	});
	const contactHint = root.querySelector(".fp-contact-hint");
	const contactInput = root.querySelector(".fp-contact-q");
	const docList = root.querySelector(".fp-doc-list");
	const docHint = root.querySelector(".fp-doc-hint");
	const docInput = root.querySelector(".fp-doc-q");
	const docGo = root.querySelector(".fp-doc-go");
	const reader = root.querySelector(".fp-reader");
	const readerTitle = root.querySelector(".fp-reader-title");
	const readerUrl = root.querySelector(".fp-reader-url");
	const readerBody = root.querySelector(".fp-reader-body");
	const badgeApp = root.querySelector(".fp-badge-app");
	const badgeUser = root.querySelector(".fp-badge-user");

	/* ------------------------------ 顶部状态 ------------------------------ */

	/** 胶囊状态位：文案 + 语义色统一走 fp-pill 类，避免各处内联色值漂移。 */
	function paintPill(el, base, text, tone = "") {
		if (!el) return;
		el.textContent = text;
		el.className = ["fp-pill", base, tone].filter(Boolean).join(" ");
	}

	/** 应用来源一句话：使用者只看这行就知道“要不要自己配应用”。 */
	function paintHeader() {
		const info = state.info;
		if (!info) return;
		// 0.10.0 起身份只剩 lark-cli 一套：应用 = CLI 的 config，个人 = CLI 的 auth list。
		const cli = info.cli || {};
		const user = (cli.users || [])[0] || null;
		paintPill(
			badgeApp,
			"fp-badge-app",
			!cli.installed ? "应用身份：未安装 CLI" : cli.configured ? "应用身份：已就绪" : "应用身份：未配置",
			cli.installed && cli.configured ? "ok" : "warn",
		);
		paintPill(
			badgeUser,
			"fp-badge-user",
			user ? `个人身份：${user.name || user.openId || "已登录"}` : "个人身份：未登录",
			user ? "accent" : "",
		);
	}

	async function refreshState() {
		try {
			const payload = await call("/state");
			state.info = payload;
			paintHeader();
			return payload;
		} catch (err) {
			status.show(`读取插件状态失败：${err.message}`, "error");
			return null;
		}
	}

	/* ------------------------------- 通讯录 ------------------------------- */

	async function loadContacts(query = state.contactQuery) {
		state.contactQuery = query;
		contactList.innerHTML = `<div style="padding:16px;color:var(--text-dim);font-size:12px;">加载中…</div>`;
		try {
			const payload = await call(`/contacts/search?q=${q(query)}&limit=30`);
			renderContacts(payload);
		} catch (err) {
			contactList.innerHTML = `<div style="padding:16px;color:var(--red,#f87171);font-size:12px;">${esc(err.message)}</div>`;
		}
	}

	async function loadDepartmentUsers(departmentId = "0") {
		contactList.innerHTML = `<div style="padding:16px;color:var(--text-dim);font-size:12px;">加载中…</div>`;
		try {
			const payload = await call(`/contacts/department-users?department=${q(departmentId)}&limit=50`);
			renderContacts({
				items: payload.items || [],
				degraded: payload.degraded !== false,
				identity: payload.identity || "tenant",
				hasMore: payload.hasMore,
				deptScopeDenied: Boolean(payload.deptScopeDenied),
				note: payload.note || "",
			});
		} catch (err) {
			contactList.innerHTML = `<div style="padding:16px;color:var(--red,#f87171);font-size:12px;">${esc(err.message)}</div>`;
		}
	}

	function renderContacts(payload) {
		const items = payload.items || [];
		contactHint.textContent = payload.deptScopeDenied
			? "应用没有该部门的数据权限"
			: payload.note
				? payload.note
				: payload.identity === "user"
					? "个人身份：企业内全员搜索"
					: "应用身份：仅可见范围成员";
		if (!items.length) {
			// 没读到人先分清两种原因：可见范围没配（40004，能自己修）还是真的搜不到。
			contactList.innerHTML = payload.deptScopeDenied
				? `<div style="padding:16px;color:var(--text-dim);font-size:12px;line-height:1.7;">${esc(
						payload.note || "应用没有通讯录数据权限",
					)}</div>`
				: `<div style="padding:16px;color:var(--text-dim);font-size:12px;">没有匹配的成员。${
						payload.degraded ? "（未授权个人身份时只能看到应用可见范围内的成员）" : ""
					}</div>`;
			return;
		}
		contactList.innerHTML = items
			.map((user) =>
				rowHtml({
					avatar: avatarHtml(user.name, user.openId),
					title: user.name || user.openId,
					subtitle: [user.jobTitle, user.email, user.mobile, user.openId].filter(Boolean).join(" · "),
					badge: user.frozen ? "已离职/冻结" : "",
					actions: `<button class="fp-row-btn" data-act="contact-insert" data-id="${esc(user.openId)}" style="${BTN}">插入</button>
						<button class="fp-row-btn" data-act="contact-copy" data-id="${esc(user.openId)}" style="${BTN}">复制 ID</button>`,
				}),
			)
			.join("");
		state.contacts = items;
	}

	/* ------------------------------- 云文档 ------------------------------- */

	function paintDocMode() {
		for (const btn of root.querySelectorAll(".fp-doc-mode")) {
			const active = btn.dataset.mode === state.docMode;
			btn.style.borderColor = active ? "var(--accent)" : "var(--border)";
			btn.style.color = active ? "var(--accent)" : "var(--text)";
			btn.style.background = active ? "var(--accent-soft)" : "var(--bg-elev2)";
			btn.style.fontWeight = active ? "600" : "400";
		}
		const isSearch = state.docMode === "search";
		docInput.style.display = isSearch ? "" : "none";
		docGo.style.display = isSearch ? "" : "none";
		const orderSel = root.querySelector(".fp-drive-order");
		if (orderSel) {
			orderSel.style.display = state.docMode === "drive" ? "" : "none";
			orderSel.value = state.driveOrder;
		}
		const clearBtn = root.querySelector(".fp-recent-clear");
		if (clearBtn) clearBtn.style.display = state.docMode === "recent" ? "" : "none";
	}

	async function loadDocs() {
		paintDocMode();
		docList.innerHTML = `<div style="padding:16px;color:var(--text-dim);font-size:12px;">加载中…</div>`;
		try {
			if (state.docMode === "recent") {
				const payload = await call("/docs/recent?limit=50");
				const scope = payload.scope || {};
				// 记录跟着飞书身份走，不是"这台机器"：共用实例上每人各看各的。
				const who = scope.anonymous ? "" : scope.name || "当前飞书账号";
				docHint.textContent = scope.anonymous
					? payload.total
						? `匿名身份下 ${payload.total} 篇（未登录飞书账号）。登录后记录会跟着你的飞书账号走，与这里的匿名记录分开`
						: "还没有访问记录。提示：未登录飞书账号时记录归到匿名身份，登录后会跟着你的飞书账号走"
					: payload.total
						? `${who} 的最近访问：${payload.total} 篇（最多保留 ${payload.limit} 条）—— 访问时间由插件按你的飞书身份记录，创建/修改时间来自飞书`
						: `${who} 还没有访问记录：读一篇文档或点「打开」之后就会出现在这里（记录跟着你的飞书账号，别人看不到）`;
				const clearBtn = root.querySelector(".fp-recent-clear");
				if (clearBtn) clearBtn.textContent = scope.anonymous ? "清空匿名记录" : "清空我的记录";
				renderDocs(payload.items || [], "recent");
				return;
			}
			if (state.docMode === "search") {
				const keyword = state.docQuery.trim();
				if (!keyword) {
					docHint.textContent = state.info?.user?.authorized
						? "输入关键词，搜索你有权限的云文档"
						: "输入关键词搜索：当前用应用身份（结果只含应用可见/被授权过的文档；登录个人账号后可搜全你名下的文档）";
					docList.innerHTML = "";
					return;
				}
				const payload = await call(`/docs/search?q=${q(keyword)}&count=30`);
				docHint.textContent =
					`共 ${payload.total ?? (payload.items || []).length} 条` +
					(payload.degraded ? "（应用身份：只含应用可见的文档）" : "（个人身份：你名下的全部文档）");
				renderDocs(payload.items || [], "search");
			} else if (state.docMode === "drive") {
				const folder = state.driveStack.length ? state.driveStack[state.driveStack.length - 1].token : "";
				const payload = await call(`/docs/files?folder=${q(folder)}&limit=50&order_by=${q(state.driveOrder)}`);
				const orderLabel = state.driveOrder === "CreatedTime" ? "按创建时间" : "按修改时间";
				docHint.textContent = state.driveStack.length
					? `我的空间 / ${state.driveStack.map((d) => d.title).join(" / ")}（${orderLabel}）`
					: `我的空间（${orderLabel}；需要登录飞书账号）`;
				renderDocs(payload.items || [], "drive");
			} else {
				if (!state.wikiStack.length) {
					const payload = await call("/docs/wikis");
					// 企业知识库基本都是 private：只有个人身份能看到"我被授权访问的"，
					// 应用身份读到的是空数组 —— 空列表时必须把这点说清楚，否则像是坏了。
					docHint.textContent =
						payload.identity === "user"
							? "知识库（以你的身份可见的全部知识库）"
							: "知识库：当前用应用身份，私有知识库一律读不到 —— 登录飞书账号后才能列出你可见的知识库";
					renderWikis(payload.items || [], payload.identity === "user");
					return;
				}
				const top = state.wikiStack[state.wikiStack.length - 1];
				const payload = await call(
					`/docs/wiki-nodes?space=${q(top.spaceId)}&parent=${q(top.parentNodeToken || "")}&limit=50`,
				);
				docHint.textContent = `知识库 / ${state.wikiStack.map((n) => n.title).join(" / ")}${
					payload.degraded ? "（应用身份：私有知识库内容需登录后可见）" : ""
				}`;
				renderDocs(payload.items || [], "wiki");
			}
		} catch (err) {
			docHint.textContent = err.needUser ? "这一步需要登录飞书账号：到「设置 → lark-cli 与身份 → 登录账号」" : "";
			docList.innerHTML = `<div style="padding:16px;color:var(--red,#f87171);font-size:12px;line-height:1.6;">${esc(err.message)}</div>`;
		}
	}

	function renderWikis(spaces, asUser) {
		if (!spaces.length) {
			docList.innerHTML = asUser
				? `<div style="padding:16px;color:var(--text-dim);font-size:12px;line-height:1.7;">你已经登录了飞书账号，但没有返回任何知识库。<br/>可能原因：该账号确实不在任何知识库成员里，或管理员限制了知识库接口。</div>`
				: `<div style="padding:16px;color:var(--text-dim);font-size:12px;line-height:1.7;">应用身份读不到知识库列表。<br/>企业知识库通常是「私有」的，只有个人身份才能列出你被授权的那些 —— 去「设置 → lark-cli 与身份 → 登录账号」。</div>`;
			return;
		}
		docList.innerHTML = spaces
			.map((space) =>
				rowHtml({
					avatar: avatarHtml(space.name, space.id),
					title: space.name,
					subtitle: [space.description, space.visibility].filter(Boolean).join(" · ") || space.id,
					badge: "知识库",
					actions: `<button class="fp-row-btn" data-act="wiki-open" data-space="${esc(space.id)}" data-title="${esc(space.name)}" style="${BTN}">打开</button>`,
				}),
			)
			.join("");
	}

	function renderDocs(items, mode) {
		if (!items.length) {
			docList.innerHTML = `<div style="padding:16px;color:var(--text-dim);font-size:12px;">没有结果</div>`;
			return;
		}
		const header =
			mode === "drive" && state.driveStack.length
				? `<button class="fp-row-btn" data-act="drive-up" style="${BTN}margin:4px 10px;">↑ 返回上级</button>`
				: mode === "wiki" && state.wikiStack.length
					? `<button class="fp-row-btn" data-act="wiki-up" style="${BTN}margin:4px 10px;">↑ 返回上级</button>`
					: "";
		docList.innerHTML =
			header +
			items
				.map((doc) =>
					rowHtml({
						avatar: avatarHtml(doc.title, doc.token),
						title: doc.title,
						// 三个时间一行：访问（本插件记）· 创建 · 修改。缺哪个就不显示哪个。
						subtitle: [doc.typeLabel, timesLine(doc)].filter(Boolean).join("  ·  "),
						badge: doc.isFolder ? "文件夹" : doc.accessCount > 1 ? `访问 ${doc.accessCount} 次` : "",
						actions: doc.isFolder
							? `<button class="fp-row-btn" data-act="folder-open" data-token="${esc(doc.token)}" data-title="${esc(doc.title)}" data-mode="${mode}" style="${BTN}">进入</button>`
							: `<button class="fp-row-btn" data-act="doc-read" data-token="${esc(doc.token)}" data-type="${esc(doc.type)}" data-title="${esc(doc.title)}" style="${BTN}">阅读</button>
								<button class="fp-row-btn" data-act="doc-open" data-token="${esc(doc.token)}" data-type="${esc(doc.type)}" data-title="${esc(doc.title)}" data-url="${esc(doc.url)}" data-created-at="${esc(doc.createdAt || 0)}" data-modified-at="${esc(doc.modifiedAt || 0)}" style="${BTN}">打开</button>
								<button class="fp-row-btn" data-act="doc-insert" data-token="${esc(doc.token)}" data-type="${esc(doc.type)}" data-title="${esc(doc.title)}" data-url="${esc(doc.url)}" style="${BTN}">引用</button>`,
					}),
				)
				.join("");
	}

	function docLink(doc) {
		return `【飞书文档】${doc.title || doc.token}${doc.url ? ` ${doc.url}` : ""}`;
	}

	async function readDoc({ token, type, title }) {
		reader.style.display = "flex";
		readerTitle.textContent = title || token;
		readerUrl.textContent = "";
		readerBody.textContent = "读取中…";
		try {
			const payload = await call(`/docs/read?token=${q(token)}&type=${q(type || "docx")}`, { timeoutMs: 60000 });
			const doc = payload.doc || {};
			state.reading = { ...doc, title: doc.title || title };
			readerTitle.textContent = state.reading.title || token;
			readerUrl.textContent = doc.url || "";
			// 富文本：markdown（lark-cli）或 blocks 树都交给同一个渲染器；不可用时它自己回落纯文本。
			mountDocReader(readerBody, doc, { call, onSay: (text, tone) => status.show(text, tone) });
			if (doc.error && !doc.ok) {
				status.show(doc.error, "error");
			}
		} catch (err) {
			state.reading = { token, type, title };
			readerBody.classList.remove("fp-doc-render");
			readerBody.style.color = "var(--red,#f87171)";
			readerBody.textContent = err.needUser
				? `${err.message}\n\n提示：应用身份读不到这篇文档时，通常需要文档所有者把应用加为协作者，或改用「登录个人账号」（设置 → lark-cli 与身份）。`
				: err.message;
		}
	}

	/* --------------------------------- 事件 --------------------------------- */

	function switchTab(tab) {
		state.tab = tab;
		try {
			localStorage.setItem(TAB_KEY, tab);
		} catch {
			/* 隐私模式下写不了：不影响切换 */
		}
		const panels = [
			[chatsPanel, "chats", "flex"],
			[todosPanel, "todos", "flex"],
			[contactsPanel, "contacts", "flex"],
			[docsPanel, "docs", "flex"],
			[settingsPanel, "settings", "block"],
		];
		for (const [panel, name, display] of panels) {
			if (panel) panel.style.display = name === tab ? display : "none";
		}
		for (const btn of root.querySelectorAll(".fp-tab")) btn.classList.toggle("active", btn.dataset.tab === tab);
		if (tab === "chats") void chatsView.refresh();
		if (tab === "todos") void todoView.resume();
		if (tab === "docs") void loadDocs();
		// 设置页自己拉 /state（顶栏胶囊也随之更新）与 /sync/state（诊断区）。
		if (tab === "settings") void settingsView.refresh();
	}

	let debounce = null;
	contactInput?.addEventListener("input", () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => void loadContacts(contactInput.value.trim()), DEBOUNCE_MS);
	});
	contactInput?.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") void loadContacts(contactInput.value.trim());
	});
	root.querySelector(".fp-contact-go")?.addEventListener("click", () => void loadContacts(contactInput.value.trim()));
	root.querySelector(".fp-contact-root")?.addEventListener("click", () => void loadDepartmentUsers("0"));
	docGo?.addEventListener("click", () => {
		state.docQuery = docInput.value.trim();
		state.driveStack = [];
		state.wikiStack = [];
		void loadDocs();
	});
	docInput?.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			state.docQuery = docInput.value.trim();
			void loadDocs();
		}
	});

	root.addEventListener("click", async (ev) => {
		const target = ev.target;
		if (!(target instanceof HTMLElement)) return;
		const button = target.closest("button");
		const tabBtn = target.closest(".fp-tab");
		if (tabBtn) {
			switchTab(tabBtn.dataset.tab || "todos");
			return;
		}
		const modeBtn = target.closest(".fp-doc-mode");
		if (modeBtn) {
			state.docMode = modeBtn.dataset.mode || "search";
			state.driveStack = [];
			state.wikiStack = [];
			void loadDocs();
			return;
		}
		const rowBtn = target.closest(".fp-row-btn");
		const act = rowBtn?.dataset.act;
		const dataset = rowBtn?.dataset ?? {};
		if (act === "contact-insert") {
			const user = (state.contacts || []).find((item) => item.openId === dataset.id);
			if (!user) return;
			const ok = await insertToComposer(
				`【飞书通讯录】${user.name}${user.jobTitle ? `（${user.jobTitle}）` : ""} open_id: ${user.openId}\n`,
			);
			status.show(ok ? "已插入对话输入框" : "输入框不可用，已复制到剪贴板", ok ? "ok" : "error");
			return;
		}
		if (act === "contact-copy") {
			const ok = await copyText(dataset.id || "");
			status.show(ok ? "open_id 已复制" : "复制失败", ok ? "ok" : "error");
			return;
		}
		if (act === "doc-read") {
			void readDoc({ token: dataset.token, type: dataset.type, title: dataset.title });
			return;
		}
		if (act === "doc-open") {
			// 点「打开」也算一次访问：先记一笔再跳转（跳走之后就没机会了）。
			const doc = {
				token: dataset.token,
				title: dataset.title,
				type: dataset.type,
				url: dataset.url,
				createdAt: Number(dataset.createdAt) || 0,
				modifiedAt: Number(dataset.modifiedAt) || 0,
			};
			try {
				await call("/docs/touch", { method: "POST", body: { doc, source: "open" }, timeoutMs: 12000 });
			} catch {
				/* 记录失败不影响打开 */
			}
			const url = dataset.url || "";
			if (url) window.open(url, "_blank", "noopener,noreferrer");
			else status.show("这条没有可打开的链接", "error");
			if (state.docMode === "recent") void loadDocs();
			return;
		}
		if (act === "doc-insert") {
			const ok = await insertToComposer(
				`${docLink({ title: dataset.title, token: dataset.token, url: dataset.url })}\n`,
			);
			status.show(ok ? "已插入对话输入框" : "输入框不可用，已复制到剪贴板", ok ? "ok" : "error");
			return;
		}
		if (act === "folder-open") {
			const token = dataset.token || "";
			const title = dataset.title || token;
			if (dataset.mode === "drive") state.driveStack.push({ token, title });
			else {
				const top = state.wikiStack[state.wikiStack.length - 1];
				state.wikiStack.push({ spaceId: top?.spaceId || "", parentNodeToken: token, title });
			}
			void loadDocs();
			return;
		}
		if (act === "drive-up") {
			state.driveStack.pop();
			void loadDocs();
			return;
		}
		if (act === "wiki-up") {
			state.wikiStack.pop();
			void loadDocs();
			return;
		}
		if (act === "wiki-open") {
			state.wikiStack = [{ spaceId: dataset.space || "", parentNodeToken: "", title: dataset.title || "" }];
			void loadDocs();
			return;
		}
		if (button?.classList.contains("fp-reader-close")) {
			reader.style.display = "none";
			state.reading = null;
			return;
		}
		if (button?.classList.contains("fp-reader-insert")) {
			if (!state.reading) return;
			const ok = await insertToComposer(`${docLink(state.reading)}\n`);
			status.show(ok ? "已插入对话输入框" : "输入框不可用，已复制到剪贴板", ok ? "ok" : "error");
			return;
		}
		if (button?.classList.contains("fp-reader-copy")) {
			const ok = await copyText(docPlainText(state.reading) || readerBody.textContent || "");
			status.show(ok ? "正文已复制" : "复制失败", ok ? "ok" : "error");
			return;
		}
		if (button?.classList.contains("fp-recent-clear")) {
			try {
				const payload = await call("/docs/recent", { method: "DELETE" });
				docHint.textContent = payload.scope?.anonymous
					? "已清空匿名记录（其他人名下不受影响）"
					: `已清空 ${payload.scope?.name || "你"} 的访问记录（共用实例上其他人名下不受影响）`;
				renderDocs(payload.items || [], "recent");
			} catch (err) {
				status.show(`清空失败：${err.message}`, "error");
			}
			return;
		}
	});

	/* --------------------------------- 启动 --------------------------------- */

	// 默认落在「待办」：这是每天要看的清单；上次停在哪个页签就回哪个（顶栏入口依赖它）。
	switchTab(readTab() || "todos");
	void refreshState().then(() => {
		// 0.10.0 起只有 lark-cli 一条通道：按 install → config → login 三态引导，别让人在这里空等。
		const cli = state.info?.cli;
		if (!cli?.installed) {
			status.show(
				"没找到 lark-cli：到「设置 → lark-cli 与身份」点第 1 步的「复制安装命令」，装完点「重新检测」",
				"error",
			);
			switchTab("settings");
			return;
		}
		if (!cli.configured) {
			status.show(
				"lark-cli 还没配置应用：到「设置 → lark-cli 与身份」点第 2 步的「配置应用」（浏览器里走官方设备码）",
				"warn",
			);
			switchTab("settings");
			return;
		}
		if (!cli.loggedIn) {
			status.show("lark-cli 还没登录个人账号：到「设置 → lark-cli 与身份」点第 3 步的「登录账号」", "warn");
			switchTab("settings");
			return;
		}
		void loadContacts("");
	});

	return () => {
		try {
			contactActions?.destroy?.();
		} catch {
			/* 容器已移除 */
		}
		try {
			chatsView?.destroy?.();
		} catch {
			/* 容器已移除 */
		}
		try {
			settingsView?.destroy?.();
		} catch {
			/* 容器已移除 */
		}
		try {
			todoView?.destroy?.();
		} catch {
			/* 容器已移除 */
		}
		try {
			el.innerHTML = "";
		} catch {
			/* 容器已被移除 */
		}
	};
}

/* -------------------------------- 契约导出 -------------------------------- */

// 新版宿主只认 default.mount；旧版宿主走 activate(ctx.ui.registerView)。
function activate(ctx) {
	ctx?.ui?.registerView?.({
		id: PLUGIN_ID,
		label: "飞书 Pro",
		icon: "🪶",
		render(container) {
			mount(container, ctx);
		},
	});
}

activate.mount = mount;

export default activate;

// 不打开视图也要能用：`@飞书文档` / `@飞书通讯录` 的补全在页面加载时就注册。
ensureComposerProviders();
