/**
 * plugins/feishu-pro/client/settings-view.mjs
 * 设置页 shell：**左侧分区导航 + 右侧分组区**（原先是 3 张卡片平铺、40 多个控件十几屏滚不完）。
 *
 * 为什么要独立成模块：
 *   ① entry.mjs 已经 1200 行，设置页模板 + lark-cli 三态引导 + 设备码展示全在巨型模板串里，
 *      改一个栅格要从头数 div；
 *   ② 设置页的信息结构变了：从「卡片流」变成「分区（导航锚点）」，需要自己的滚动容器、
 *      自己的状态轮询（/sync/state 的缓存与诊断数据）和自己的就地反馈行。
 *
 * 分区（导航顺序 = 使用频率）：
 *   1 lark-cli 与身份   装 / 配 / 登 三态 + 设备码（唯一会卡住其他一切的一步）
 *   2 消息同步与提醒     后台轮询开关（sync-panel 托管）
 *   3 私聊自动问答       会以你本人名义开口，默认关（auto-reply-panel 托管）
 *   4 诊断与数据         缓存 / 发现 / 会话清单 / 提醒历史 + 危险操作（红框 + 二次确认）
 *   5 关于与排错         CLI 版本与路径、可复制的命令、通道边界说明
 *
 * 第 2/3 区**托管**两个面板的表单体（`sync-panel.mjs` / `auto-reply-panel.mjs` 只出控件，
 * 不再自己 append 卡片）：卡头、状态胶囊与**卡底动作条**（脏标记 → 撤销 / 保存并生效）都在这里，
 * 面板通过 `onDirty` 上报改动、`save()` / `revert()` 交回控制权。
 * 审计类数据（缓存体积、会话清单、提醒历史、危险操作）只在 ④ 画一次，面板里不再重复。
 *
 * 三条红线沿用 entry.mjs：主题令牌不写死颜色、插值一律 esc()、输入框不做整页重渲染。
 */

import { esc } from "@pi-web-ui/plugin-sdk/client";
import { mountSyncPanel } from "./sync-panel.mjs";
import { mountAutoReplyPanel } from "./auto-reply-panel.mjs";
// 诊断与数据（缓存 / 会话清单 / 提醒历史 / 危险操作）：同样只出表单体，数据由这里推。
import { mountDiagnosticsPanel } from "./diagnostics-panel.mjs";

const STYLE_ID = "fp-set-styles";
/** 分区表：id 同时是 DOM 锚点、导航高亮键与 aria-controls 的目标。 */
const SECTIONS = [
	{ id: "status", label: "lark-cli 与身份", icon: "🔑" },
	{ id: "sync", label: "消息同步与提醒", icon: "🔁" },
	{ id: "auto", label: "私聊自动问答", icon: "💬" },
	{ id: "diag", label: "诊断与数据", icon: "📊" },
	{ id: "about", label: "关于与排错", icon: "🧾" },
];
/** 诊断区的状态轮询间隔：`/sync/state` 是内存 + 缓存自述，很轻。 */
const STATE_REFRESH_MS = 15_000;
/** 配置/登录的设备码追踪：CLI 在后台等浏览器授权，这里替用户盯着。 */
const SETUP_POLL_MS = 3_000;
const SETUP_TTL_MS = 5 * 60_000;

const INSTALL_FALLBACK = "npx @larksuite/cli@latest install";
const CONFIG_FALLBACK = "lark-cli config init --new";

/* ------------------------------- 样式表 ------------------------------- */
/*
 * 只放设置页独有的规则（分区骨架 / 三格步骤 / 指标 / 表格 / 危险区 / 命令块）。
 * 表单栅格、折叠区、卡底动作条是共用原语，定义在 entry.mjs 的 STYLES 里（面板也会用到）。
 * 通用按钮、输入、胶囊、卡片、顶栏仍走 entry.mjs 注入的那张表 —— 少一份重复定义就少一处漂移。
 * 颜色一律用主题令牌：--bg / --bg-elev / --bg-elev2 / --border / --border-soft / --text-dim /
 * --text-faint / --accent / --accent-soft / --accent-contrast / --green / --red / --amber / --on-red。
 */
const STYLES = `
.fp-set{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"nav" "main";height:100%;min-height:0;overflow:hidden;background:var(--bg);color:var(--text);}
.fp-set *,.fp-set *::before,.fp-set *::after{box-sizing:border-box;}
.fp-set [hidden]{display:none !important;}
/* 导航：窄屏是顶部横排 chips，≥880px 变左侧竖排 */
.fp-set-nav{grid-area:nav;display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-elev);overflow-x:auto;scrollbar-width:thin;}
.fp-set-navitem{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:6px 11px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--text-dim);font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}
.fp-set-navitem:hover{background:var(--bg-elev2);color:var(--text);}
.fp-set-navitem:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
.fp-set-navitem.active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600;}
.fp-set-navitem-ico{font-size:12px;line-height:1;}
.fp-set-main{grid-area:main;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;width:100%;max-width:980px;margin:0 auto;padding:14px 16px 48px;}
.fp-set-sec{scroll-margin-top:8px;}
@media (min-width:880px){
	.fp-set{grid-template-columns:196px minmax(0,1fr);grid-template-rows:minmax(0,1fr);grid-template-areas:"nav main";}
	.fp-set-nav{flex-direction:column;gap:2px;padding:14px 10px;border-right:1px solid var(--border);border-bottom:none;overflow-x:hidden;overflow-y:auto;}
	.fp-set-navitem{width:100%;justify-content:flex-start;padding:7px 10px;border-radius:7px;}
	.fp-set-navitem.active{box-shadow:inset 2px 0 0 var(--accent);}
	.fp-set-main{padding:16px 20px 48px;}
}
/* 原生控件跟主题走：勾选框在不同系统的 prefers-color-scheme 下会变成白块/黑块，
   这里改成自绘（主题令牌 + accent-contrast 勾），与深/浅色主题都不冲突 */
.fp-set input[type="checkbox"],
.fp-set input[type="radio"]{
	appearance:none;-webkit-appearance:none;position:relative;flex:0 0 auto;width:14px;height:14px;margin:0;
	border:1px solid var(--border);border-radius:4px;background:var(--bg);cursor:pointer;transition:background .12s,border-color .12s;
}
.fp-set input[type="radio"]{border-radius:50%;}
.fp-set input[type="checkbox"]:hover,
.fp-set input[type="radio"]:hover{border-color:var(--accent);}
.fp-set input[type="checkbox"]:focus-visible,
.fp-set input[type="radio"]:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
.fp-set input[type="checkbox"]:checked{background:var(--accent);border-color:var(--accent);}
.fp-set input[type="checkbox"]:checked::after{
	content:"";position:absolute;left:4.5px;top:1.5px;width:3px;height:7px;
	border:solid var(--accent-contrast,#fff);border-width:0 2px 2px 0;transform:rotate(42deg);
}
.fp-set input[type="radio"]:checked{border-color:var(--accent);box-shadow:inset 0 0 0 3px var(--accent);}
.fp-set select{font:inherit;font-size:12.5px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:4px 8px;cursor:pointer;}
/* 卡头右侧：状态胶囊 + 高频小动作 */
.fp-set-sechead-right{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-top:1px;}
/* 三格步骤（装 / 配 / 登）：只有"下一步该做的"那格带按钮 */
.fp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px;}
.fp-step{display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-width:0;padding:10px 12px;border-radius:9px;border:1px solid var(--border);background:var(--bg);}
.fp-step[data-tone="ok"]{border-color:var(--green);}
.fp-step[data-tone="warn"]{border-color:var(--amber);}
.fp-step[data-tone="err"]{border-color:var(--red);}
.fp-step-head{display:flex;align-items:center;gap:7px;min-width:0;}
.fp-step-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--text-faint);}
.fp-step[data-tone="ok"] .fp-step-dot{background:var(--green);}
.fp-step[data-tone="warn"] .fp-step-dot{background:var(--amber);}
.fp-step[data-tone="err"] .fp-step-dot{background:var(--red);}
.fp-step-name{font-size:11.5px;font-weight:600;line-height:1.4;color:var(--text-dim);}
.fp-step-value{font-size:12.5px;font-weight:600;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
.fp-step-hint{font-size:11px;line-height:1.65;color:var(--text-faint);overflow-wrap:anywhere;}
/* 设备码 / 授权链接 */
.fp-set-device{display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px;border-radius:9px;border:1px dashed var(--accent);background:var(--accent-soft);}
.fp-set-codelabel{font-size:11px;line-height:1.65;color:var(--text-dim);text-align:center;overflow-wrap:anywhere;}
.fp-set-codelink{font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--accent);text-align:center;overflow-wrap:anywhere;word-break:break-all;}
.fp-set-usercode{font-family:var(--mono);font-size:20px;font-weight:700;letter-spacing:2px;line-height:1.5;color:var(--text);text-align:center;overflow-wrap:anywhere;}
.fp-set-transcript{width:100%;max-height:180px;overflow:auto;margin:0;padding:8px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text-dim);font-family:var(--mono);font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
/* 就地反馈：成功 3 秒淡出由脚本控制，错误常驻 */
.fp-set-note{font-size:11.5px;line-height:1.75;color:var(--text-dim);overflow-wrap:anywhere;}
.fp-set-note.ok{color:var(--green);}
.fp-set-note.err{color:var(--red);}
/* 可复制命令 */
.fp-set-cmd{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);}
.fp-set-cmd > code{flex:1;min-width:0;font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;}
.fp-set-cmd-label{flex:0 0 auto;font-size:11px;color:var(--text-dim);white-space:nowrap;}
/* 键值行（CLI 详情） */
.fp-set-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;margin:0;font-size:11.5px;line-height:1.7;}
.fp-set-kv dt{color:var(--text-dim);white-space:nowrap;}
.fp-set-kv dd{margin:0;min-width:0;overflow-wrap:anywhere;word-break:break-word;}
.fp-set-mono{font-family:var(--mono);font-size:11px;}
/* 2/3 区只放面板的"表单体"（卡头与卡底动作条由本模块的分区卡片提供） */
.fp-set-slot{display:flex;flex-direction:column;gap:12px;min-width:0;}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

/* -------------------------------- 小工具 -------------------------------- */

/** "3 分钟前"：诊断区只关心"多久以前"。 */
function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta <= 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(String(text ?? ""));
		return true;
	} catch {
		return false;
	}
}

/* -------------------------------- 视图 -------------------------------- */

/**
 * 挂载设置页。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panel 设置页签的面板容器（本模块会接管它的全部内容）
 * @param {(path: string, init?: object) => Promise<any>} opts.call 插件路由传输层（entry 提供）
 * @param {() => any} opts.getInfo 读取 `/state` 缓存（entry 持有，避免两处各拉一份）
 * @param {() => Promise<any>} opts.refreshInfo 重新拉 `/state`（顺带刷新顶栏两枚胶囊）
 * @returns {{ refresh: () => Promise<void>, focus: (id: string) => void, destroy: () => void }}
 */
export function mountSettingsView({ panel, call, getInfo, refreshInfo } = {}) {
	const noop = { refresh: async () => {}, focus: () => {}, destroy: () => {} };
	if (!panel || typeof panel.appendChild !== "function" || typeof call !== "function") return noop;

	injectStyles();

	panel.innerHTML = `
	<div class="fp-set">
		<nav class="fp-set-nav" aria-label="设置分区">
			${SECTIONS.map(
				(sec) =>
					`<button class="fp-set-navitem" type="button" data-target="${sec.id}" aria-controls="fp-set-${sec.id}"><span class="fp-set-navitem-ico" aria-hidden="true">${sec.icon}</span><span>${esc(sec.label)}</span></button>`,
			).join("")}
		</nav>

		<div class="fp-set-main">
			<!-- ① 概览与身份：装 / 配 / 登 三态，只有"下一步"那格出按钮 -->
			<section class="fp-card fp-set-sec" id="fp-set-status" data-sec="status">
				<div class="fp-card-head">
					<div class="fp-card-titles">
						<span class="fp-card-title">lark-cli 与身份</span>
						<span class="fp-card-desc">本插件只有一条通道：飞书官方 lark-cli（凭证与接口都在它里面，无 OpenAPI 回落）。装好 → 配置应用 → 登录个人账号，三步都绿了才算就绪。</span>
					</div>
					<div class="fp-set-sechead-right">
						<span class="fp-pill fp-set-cli-pill">检测中</span>
						<button class="fp-btn fp-btn-sm fp-set-refresh" type="button" title="重新探测 lark-cli（安装 / 配置 / 登录状态）">重新检测</button>
					</div>
				</div>
				<div class="fp-card-body">
					<div class="fp-steps">
						<div class="fp-step" data-step="install">
							<div class="fp-step-head"><span class="fp-step-dot"></span><span class="fp-step-name">1 · 安装 CLI</span></div>
							<div class="fp-step-value fp-step-value" data-field="install-value">检测中…</div>
							<div class="fp-step-hint" data-field="install-hint"></div>
							<button class="fp-btn fp-btn-sm fp-set-cli-install" type="button" hidden>复制安装命令</button>
						</div>
						<div class="fp-step" data-step="config">
							<div class="fp-step-head"><span class="fp-step-dot"></span><span class="fp-step-name">2 · 配置应用</span></div>
							<div class="fp-step-value" data-field="config-value">检测中…</div>
							<div class="fp-step-hint" data-field="config-hint"></div>
							<button class="fp-btn fp-btn-sm fp-set-cli-config" type="button" hidden>配置应用</button>
						</div>
						<div class="fp-step" data-step="login">
							<div class="fp-step-head"><span class="fp-step-dot"></span><span class="fp-step-name">3 · 登录个人账号</span></div>
							<div class="fp-step-value" data-field="login-value">检测中…</div>
							<div class="fp-step-hint" data-field="login-hint"></div>
							<button class="fp-btn fp-btn-sm fp-set-cli-login" type="button" hidden>登录账号</button>
						</div>
					</div>
					<div class="fp-set-device" hidden>
						<span class="fp-set-codelabel fp-set-codelabel-text"></span>
						<a class="fp-set-codelink" href="#" target="_blank" rel="noopener noreferrer"></a>
						<span class="fp-set-usercode" hidden></span>
						<pre class="fp-set-transcript" hidden></pre>
						<button class="fp-btn fp-btn-sm fp-set-device-close" type="button">收起</button>
					</div>
					<div class="fp-set-note fp-set-cli-note"></div>
				</div>
			</section>

			<!-- ② 消息同步与提醒（sync-panel 托管控件，状态与审计数据在 ④） -->
			<section class="fp-card fp-set-sec" id="fp-set-sync" data-sec="sync">
				<div class="fp-card-head">
					<div class="fp-card-titles">
						<span class="fp-card-title">消息同步与提醒</span>
						<span class="fp-card-desc">飞书不给「人类账号的消息」事件，只能按间隔拉增量。同一个引擎两件事：<b>同步</b>把消息落进本地缓存（列表预览、秒开会话、离线检索都靠它），<b>提醒</b>只对新消息弹通知。首次只建基线不弹。</span>
					</div>
					<div class="fp-set-sechead-right"><span class="fp-pill fp-set-sync-pill">检测中</span></div>
				</div>
				<div class="fp-card-body"><div class="fp-set-slot" data-slot="sync"></div></div>
				<div class="fp-card-foot" data-foot="sync" hidden>
					<span class="fp-card-foot-note">● 有未保存的修改</span>
					<span class="fp-card-foot-actions">
						<button class="fp-btn fp-btn-sm fp-set-revert" type="button" data-foot="sync">撤销</button>
						<button class="fp-btn fp-btn-sm fp-btn-primary fp-set-save" type="button" data-foot="sync">保存并生效</button>
					</span>
				</div>
			</section>

			<!-- ③ 私聊自动问答（auto-reply-panel 托管） -->
			<section class="fp-card fp-set-sec" id="fp-set-auto" data-sec="auto">
				<div class="fp-card-head">
					<div class="fp-card-titles">
						<span class="fp-card-title">私聊自动问答</span>
						<span class="fp-card-desc">轮询到白名单会话里的新消息 → 跑一轮 agent → 以「我 / 机器人」身份回包。<b>默认关闭，白名单为空则谁都不回</b>；建议先开「空跑」看一天话术。</span>
					</div>
					<div class="fp-set-sechead-right"><span class="fp-pill warn" title="用你的账号发出，收件人看到的是你本人">以你名义发言</span></div>
				</div>
				<div class="fp-card-body"><div class="fp-set-slot" data-slot="auto"></div></div>
				<div class="fp-card-foot" data-foot="auto" hidden>
					<span class="fp-card-foot-note">● 有未保存的修改</span>
					<span class="fp-card-foot-actions">
						<button class="fp-btn fp-btn-sm fp-set-revert" type="button" data-foot="auto">撤销</button>
						<button class="fp-btn fp-btn-sm fp-btn-primary fp-set-save" type="button" data-foot="auto">保存并生效</button>
					</span>
				</div>
			</section>

			<!-- ④ 诊断与数据：低频但排错必需，与"改开关"分开 -->
			<section class="fp-card fp-set-sec" id="fp-set-diag" data-sec="diag">
				<div class="fp-card-head">
					<div class="fp-card-titles">
						<span class="fp-card-title">诊断与数据</span>
						<span class="fp-card-desc">同步引擎的实际落盘情况：缓存有多大、上一轮什么时候跑、哪些会话同步失败。危险操作单独放在最下面。</span>
					</div>
					<div class="fp-set-sechead-right"><button class="fp-btn fp-btn-sm fp-set-diag-refresh" type="button">刷新</button></div>
				</div>
				<div class="fp-card-body"><div class="fp-set-slot" data-slot="diag"></div></div>
			</section>

			<!-- ⑤ 关于与排错：CLI 版本/路径/命令，排错时才有用 -->
			<section class="fp-card fp-set-sec" id="fp-set-about" data-sec="about">
				<div class="fp-card-head">
					<div class="fp-card-titles">
						<span class="fp-card-title">关于与排错</span>
						<span class="fp-card-desc">lark-cli 的版本、来源与可复制命令。装/配/登都对但功能报错时，先来这里确认"插件到底在调哪个二进制"。</span>
					</div>
				</div>
				<div class="fp-card-body">
					<details class="fp-fold">
						<summary>lark-cli 详情</summary>
						<div class="fp-fold-body">
							<dl class="fp-set-kv">
								<dt>版本</dt><dd data-field="about-version">—</dd>
								<dt>来源</dt><dd data-field="about-source">—</dd>
								<dt>二进制</dt><dd class="fp-set-mono" data-field="about-bin">—</dd>
								<dt>候选探测</dt><dd data-field="about-candidates">—</dd>
								<dt>检查时间</dt><dd data-field="about-checked">—</dd>
							</dl>
							<div class="fp-set-cmd">
								<span class="fp-set-cmd-label">安装</span>
								<code class="fp-set-cmd-install"></code>
								<button class="fp-btn fp-btn-sm fp-set-copy" type="button" data-copy="install">复制</button>
							</div>
							<div class="fp-set-cmd">
								<span class="fp-set-cmd-label">配置</span>
								<code class="fp-set-cmd-config"></code>
								<button class="fp-btn fp-btn-sm fp-set-copy" type="button" data-copy="config">复制</button>
							</div>
							<div class="fp-set-note">登录不走命令行：点 ① 里的「登录账号」，服务端会按本插件真正需要的 scope 组装 <code>lark-cli auth login</code>（域：docs,drive,wiki,contact,im,sheets,base）。本插件不发出站请求，域名与私有化网关由 CLI 的 profile 决定。</div>
						</div>
					</details>
					<div class="fp-set-note fp-set-copy-note" hidden></div>
				</div>
			</section>
		</div>
	</div>`;

	const $ = (sel) => panel.querySelector(sel);
	const elMain = $(".fp-set-main");
	const elNav = $(".fp-set-nav");
	// 胶囊的"底色类"先记下来：paintPill() 会重写 className，不记住就会把自己的锚点类一起冲掉。
	for (const el of panel.querySelectorAll(".fp-pill")) el.dataset.baseClass = el.className;
	const sections = new Map();
	for (const sec of SECTIONS) {
		const el = $(`#fp-set-${sec.id}`);
		if (el) sections.set(sec.id, el);
	}

	/* 2/3 区：两个面板只渲染表单体，外壳（卡头/胶囊/卡底动作条）由这里提供 */
	let syncPanel = null;
	let autoPanel = null;

	let diagnosticsPanel = null;

	/** 面板的脏标记 → 卡底动作条（只有"改了没存"时才出现）。 */
	function setFoot(name, dirty) {
		const foot = $(`.fp-card-foot[data-foot="${name}"]`);
		if (foot) foot.hidden = !dirty;
	}

	try {
		syncPanel = mountSyncPanel($('[data-slot="sync"]'), {
			call,
			onDirty: (dirty) => setFoot("sync", dirty),
			// 保存 / 立即同步后拿到的新状态回灌给 ② 的胶囊与 ④ 的指标，避免两处各拉一份。
			onState: (next) => {
				syncState = next;
				paintSyncPill();
				diagnosticsPanel?.apply?.(next);
			},
		});
	} catch (err) {
		$('[data-slot="sync"]').innerHTML = `<div class="fp-set-empty">同步面板加载失败：${esc(err?.message || err)}</div>`;
	}
	try {
		autoPanel = mountAutoReplyPanel($('[data-slot="auto"]'), {
			call,
			onDirty: (dirty) => setFoot("auto", dirty),
		});
	} catch (err) {
		$('[data-slot="auto"]').innerHTML =
			`<div class="fp-set-empty">自动问答面板加载失败：${esc(err?.message || err)}</div>`;
	}

	try {
		diagnosticsPanel = mountDiagnosticsPanel($('[data-slot="diag"]'), {
			call,
			// 危险操作（清空缓存 / 重新发现）动的是数据面：让设置页重拉一份再推给 ② ④。
			onChanged: () => refreshSyncState(),
		});
	} catch (err) {
		$('[data-slot="diag"]').innerHTML = `<div class="fp-set-empty">诊断面板加载失败：${esc(err?.message || err)}</div>`;
	}

	/* ------------------------------ 就地反馈 ------------------------------ */

	const noteTimers = new WeakMap();
	/** 各分区自己的反馈行：成功 3 秒淡出、错误常驻（取代原来那条跨页 4 秒消失的横幅）。 */
	function note(el, text, tone = "") {
		if (!el) return;
		const timer = noteTimers.get(el);
		if (timer) clearTimeout(timer);
		const base = el.dataset.noteClass || "";
		if (!text) {
			el.hidden = true;
			el.textContent = "";
			el.className = `fp-set-note ${base}`.trim();
			return;
		}
		el.hidden = false;
		el.textContent = text;
		el.className = `fp-set-note ${base} ${tone}`.trim();
		if (tone !== "err")
			noteTimers.set(
				el,
				setTimeout(() => note(el, ""), 4_000),
			);
	}
	// 反馈行自己的锚点类记在 data-note-class 上（与胶囊的 data-base-class 分开，别互相覆盖）。
	const elCliNote = $(".fp-set-cli-note");
	const elCopyNote = $(".fp-set-copy-note");
	for (const [el, name] of [
		[elCliNote, "fp-set-cli-note"],
		[elCopyNote, "fp-set-copy-note"],
	]) {
		if (el) el.dataset.noteClass = name;
	}

	/* --------------------------- ① lark-cli 与身份 --------------------------- */

	const stepEl = (name) => $(`.fp-step[data-step="${name}"]`);
	const field = (name) => $(`[data-field="${name}"]`);

	/** 三格步骤：tone 决定边框/圆点，按钮只出现在"下一步"那格。 */
	function paintStep(name, { tone = "", value = "", hint = "", action = false }) {
		const el = stepEl(name);
		if (!el) return;
		el.dataset.tone = tone;
		const valueEl = el.querySelector(".fp-step-value");
		const hintEl = el.querySelector(".fp-step-hint");
		if (valueEl) valueEl.textContent = value;
		if (hintEl) hintEl.textContent = hint;
		const btn = el.querySelector("button");
		if (btn) btn.hidden = !action;
	}

	let deviceInfo = null;
	let openedUrl = "";
	let setupPoll = null;
	/** 有没有真的拉过一次 `/state`：没试过 vs 试了没拿到，界面口径不一样。 */
	let refreshTried = false;

	function stopSetupPoll() {
		if (setupPoll) {
			clearInterval(setupPoll);
			setupPoll = null;
		}
	}

	/** 设备码 / 授权链接：CLI 在后台等浏览器里的那一步，这里把链接与原始输出摊开。 */
	function paintDevice() {
		const box = $(".fp-set-device");
		if (!box) return;
		const info = deviceInfo;
		if (!info || (!info.url && !info.userCode && !info.transcript)) {
			box.hidden = true;
			return;
		}
		box.hidden = false;
		const label = box.querySelector(".fp-set-codelabel-text");
		if (label) {
			label.textContent =
				info.step === "login"
					? "浏览器授权：若只看到「任务」，切到「全部权限」勾选云文档 / 云空间 / 知识库 / 通讯录 / 消息"
					: "在浏览器完成应用配置（新建或选择已有的飞书 CLI 应用）";
		}
		const link = box.querySelector(".fp-set-codelink");
		if (link) {
			link.textContent = info.url || "";
			link.hidden = !info.url;
			link.setAttribute("href", info.url || "#");
		}
		const code = box.querySelector(".fp-set-usercode");
		if (code) {
			code.textContent = info.userCode ? `设备码：${info.userCode}` : "";
			code.hidden = !info.userCode;
		}
		const pre = box.querySelector(".fp-set-transcript");
		if (pre) {
			pre.textContent = info.transcript || "";
			pre.hidden = !info.transcript;
		}
		// 同一个链接只自动打开一次：轮询每 3 秒跑一遍，不然会一直弹新标签页。
		if (info.url && info.url !== openedUrl) {
			openedUrl = info.url;
			try {
				window.open(info.url, "_blank", "noopener,noreferrer");
			} catch {
				/* 弹窗被拦就靠上面那个链接 */
			}
		}
	}

	/** 顶栏两枚胶囊与三格步骤，同一个数据源（entry 的 `/state`）。 */
	function paintIdentity() {
		const cli = getInfo()?.cli || null;
		paintPill(
			$(".fp-set-cli-pill"),
			!cli
				? refreshTried
					? "状态读取失败"
					: "检测中"
				: !cli.installed
					? "未安装 CLI"
					: !cli.configured
						? "未配置应用"
						: !cli.loggedIn
							? "未登录"
							: "就绪",
			!cli ? (refreshTried ? "err" : "") : !cli.installed || !cli.configured ? "err" : !cli.loggedIn ? "warn" : "ok",
		);
		const installCmd = cli?.installCommand || INSTALL_FALLBACK;
		const configCmd = cli?.configCommand || CONFIG_FALLBACK;

		if (!cli) {
			// 刚挂载时 /state 还没回来：说「检测中」而不是报错（真失败由 entry 的顶栏状态条负责）。
			const hint = refreshTried ? "插件服务端可能还是旧代码：到「插件」面板点「重新加载」" : "正在读取…";
			paintStep("install", { tone: refreshTried ? "warn" : "", value: "未知", hint });
			paintStep("config", { tone: "", value: "未知", hint: "先读到 CLI 状态" });
			paintStep("login", { tone: "", value: "未知", hint: "" });
			if (refreshTried)
				note(elCliNote, "读取 lark-cli 状态失败：插件服务端可能还是旧代码，到「插件」面板重新加载。", "err");
			return;
		}

		const user = (cli.users || [])[0] || null;
		const version = String(cli.version || "").trim();
		const source = String(cli.source || "").trim();
		paintStep("install", {
			tone: cli.installed ? "ok" : "err",
			value: cli.installed ? `${version || "已安装"}${source ? `（${source}）` : ""}` : "没找到 lark-cli",
			hint: cli.installed ? String(cli.bin || "") : `在服务器终端执行：${installCmd}`,
			action: !cli.installed,
		});
		paintStep("config", {
			tone: !cli.installed ? "" : cli.configured ? "ok" : "err",
			value: !cli.installed ? "等待 CLI" : cli.configured ? "应用已配置" : "还没配置应用",
			hint: !cli.installed
				? "先完成第 1 步"
				: cli.configured
					? "凭证在 CLI 的 profile 里（App ID / Secret）"
					: `点「配置应用」走官方设备码，或执行 ${configCmd}`,
			action: cli.installed && !cli.configured,
		});
		paintStep("login", {
			tone: !cli.configured ? "" : cli.loggedIn ? "ok" : "warn",
			value: !cli.configured ? "等待应用配置" : cli.loggedIn ? user?.name || "已登录" : "还没登录个人账号",
			hint: !cli.configured
				? "先完成第 2 步"
				: cli.loggedIn
					? String(user?.openId || cli.identity || "")
					: "云文档 / 通讯录 / 消息都需要个人身份",
			action: cli.configured && !cli.loggedIn,
		});

		note(
			elCliNote,
			!cli.installed
				? "下一步：安装 lark-cli（点第 1 步的「复制安装命令」，在服务器终端执行后点「重新检测」）。"
				: !cli.configured
					? "下一步：配置应用（点第 2 步的「配置应用」，浏览器里走官方设备码）。"
					: !cli.loggedIn
						? "下一步：登录个人账号（点第 3 步的「登录账号」，浏览器里勾选云文档 / 云空间 / 知识库 / 通讯录 / 消息）。"
						: "",
		);

		/* ⑤ 关于与排错：同一份 cli 数据，低频信息 */
		const candidates = (cli.candidates || []).map((c) => `${c.label || c.source}${c.ok ? ` ✓ ${c.version}` : " ✗"}`);
		setField("about-version", version || "—");
		setField("about-source", source || "—");
		setField("about-bin", cli.bin || "—");
		setField("about-candidates", candidates.length ? candidates.join(" · ") : "—");
		setField("about-checked", cli.checkedAt ? ago(cli.checkedAt) || "刚刚" : "—");
		const installCode = $(".fp-set-cmd-install");
		if (installCode) installCode.textContent = installCmd;
		const configCode = $(".fp-set-cmd-config");
		if (configCode) configCode.textContent = configCmd;
	}

	function setField(name, text) {
		const el = field(name);
		if (el) el.textContent = text;
	}

	function paintPill(el, text, tone = "") {
		if (!el) return;
		el.textContent = text;
		el.className = ["fp-pill", el.dataset.baseClass || "", tone].filter(Boolean).join(" ");
	}

	/* ------------------------------ ④ 诊断与数据 ------------------------------ */

	let syncState = null;

	// 指标 / 会话清单 / 提醒历史 / 危险操作都在 diagnostics-panel.mjs 里；
	// 这里只负责拉一份 `/sync/state` 并推给 ② 与 ④（同一份状态，不同视角）。
	/** ② 的卡头胶囊：和 ④ 共用同一份 `/sync/state`。 */
	function paintSyncPill() {
		const state = syncState;
		const cfg = state?.config || {};
		const error = String(state?.lastError || state?.discovered?.error || "");
		paintPill(
			$(".fp-set-sync-pill"),
			error ? "异常" : !state ? "检测中" : state.running ? "运行中" : cfg.enabled ? "已启用" : "未启用",
			error ? "err" : state?.running ? "ok" : cfg.enabled ? "warn" : "",
		);
	}

	async function refreshSyncState() {
		try {
			syncState = await call("/sync/state");
		} catch (err) {
			syncState = null;
			note(elCliNote, `读取同步状态失败：${err?.message || err}`, "err");
		}
		// 同一份状态喂三个地方：② 的胶囊、② 的面板、④ 的指标与清单。
		paintSyncPill();
		syncPanel?.apply?.(syncState);
		diagnosticsPanel?.apply?.(syncState);
	}

	/* -------------------------------- 分区导航 -------------------------------- */

	let activeId = SECTIONS[0]?.id || "status";

	function setActive(id, scroll = false) {
		if (!sections.has(id)) return;
		activeId = id;
		for (const btn of elNav.querySelectorAll(".fp-set-navitem")) {
			const on = btn.dataset.target === id;
			btn.classList.toggle("active", on);
			if (on) btn.setAttribute("aria-current", "true");
			else btn.removeAttribute("aria-current");
		}
		if (scroll) {
			const el = sections.get(id);
			el?.scrollIntoView({ block: "start", behavior: "smooth" });
		}
	}

	/** 滚动时高亮"当前看到的那一区"：只看各 section 的顶边，不引入 IntersectionObserver 的抖动。 */
	function syncActiveFromScroll() {
		const top = elMain.getBoundingClientRect().top;
		let current = activeId;
		for (const [id, el] of sections) {
			if (el.getBoundingClientRect().top - top <= 24) current = id;
		}
		if (current !== activeId) setActive(current);
	}

	/* --------------------------------- 事件 --------------------------------- */

	let rafPending = false;
	elMain.addEventListener(
		"scroll",
		() => {
			if (rafPending) return;
			rafPending = true;
			requestAnimationFrame(() => {
				rafPending = false;
				syncActiveFromScroll();
			});
		},
		{ passive: true },
	);

	elNav.addEventListener("click", (ev) => {
		const btn = ev.target instanceof Element ? ev.target.closest(".fp-set-navitem") : null;
		if (!btn) return;
		setActive(btn.dataset.target || "", true);
	});

	/** 有"未保存改动"时切区会丢东西 —— sync/auto 面板自己会提示，这里不拦（切区不卸载 DOM）。 */

	panel.addEventListener("click", async (ev) => {
		const target = ev.target instanceof Element ? ev.target : null;
		if (!target) return;

		/* ① 三个动作 + 重新检测 */
		if (target.closest(".fp-set-cli-install")) {
			const cmd = getInfo()?.cli?.installCommand || INSTALL_FALLBACK;
			const ok = await copyText(cmd);
			note(
				elCliNote,
				ok ? `已复制：${cmd}（在服务器终端执行后点「重新检测」）` : `请在服务器终端执行：${cmd}`,
				ok ? "ok" : "err",
			);
			return;
		}
		const setupBtn = target.closest(".fp-set-cli-config, .fp-set-cli-login");
		if (setupBtn) {
			const step = setupBtn.classList.contains("fp-set-cli-login") ? "login" : "config";
			setupBtn.disabled = true;
			note(elCliNote, step === "login" ? "正在申请登录链接…（CLI 在后台等浏览器授权）" : "正在启动 lark-cli 配置…");
			try {
				const payload = await call("/cli/setup", { method: "POST", body: { step }, timeoutMs: 90_000 });
				deviceInfo = payload.setup || null;
				paintDevice();
				note(elCliNote, payload.setup?.hint || "已启动，请在浏览器里完成");
				startSetupPoll(step);
			} catch (err) {
				note(elCliNote, `启动失败：${err?.message || err}`, "err");
			} finally {
				setupBtn.disabled = false;
			}
			return;
		}
		if (target.closest(".fp-set-device-close")) {
			deviceInfo = null;
			stopSetupPoll();
			paintDevice();
			return;
		}
		if (target.closest(".fp-set-refresh")) {
			const btn = target.closest(".fp-set-refresh");
			btn.disabled = true;
			note(elCliNote, "正在重新探测 lark-cli…");
			try {
				await call("/cli/refresh", { method: "POST", timeoutMs: 60_000 });
				await refreshInfo?.();
				paintIdentity();
				note(elCliNote, "已重新检测", "ok");
			} catch (err) {
				note(elCliNote, `检测失败：${err?.message || err}`, "err");
			} finally {
				btn.disabled = false;
			}
			return;
		}

		/* ④ 刷新 / 过滤开关 / 危险操作 */
		if (target.closest(".fp-set-diag-refresh")) {
			const btn = target.closest(".fp-set-diag-refresh");
			btn.disabled = true;
			await refreshSyncState();
			btn.disabled = false;
			return;
		}
		const revertBtn = target.closest(".fp-set-revert");
		if (revertBtn) {
			const name = revertBtn.dataset.foot === "auto" ? "auto" : "sync";
			(name === "auto" ? autoPanel : syncPanel)?.revert?.();
			setFoot(name, false);
			return;
		}
		const saveBtn = target.closest(".fp-set-save");
		if (saveBtn) {
			const name = saveBtn.dataset.foot === "auto" ? "auto" : "sync";
			const target2 = name === "auto" ? autoPanel : syncPanel;
			saveBtn.disabled = true;
			try {
				await target2?.save?.();
			} finally {
				saveBtn.disabled = false;
				setFoot(name, Boolean(target2?.isDirty?.()));
			}
			return;
		}
		const copyBtn = target.closest(".fp-set-copy");
		if (copyBtn) {
			const which = copyBtn.dataset.copy === "config" ? ".fp-set-cmd-config" : ".fp-set-cmd-install";
			const ok = await copyText($(which)?.textContent || "");
			note(elCopyNote, ok ? "已复制" : "复制失败（浏览器拒绝剪贴板权限）", ok ? "ok" : "err");
		}
	});

	/* ------------------------------ 设备码追踪 ------------------------------ */
	/*
	 * CLI 在后台等浏览器里的授权，之前必须用户自己回来点「重新检测」——
	 * 这里替用户盯着：每 3 秒问一次 /cli/setup（拿链接/设备码 + 原始输出）与 /state（拿装/配/登三态），
	 * 目标状态一到就停表并就地报喜，5 分钟没完成也停（不无限跑）。
	 */
	function startSetupPoll(targetStep) {
		stopSetupPoll();
		const deadline = Date.now() + SETUP_TTL_MS;
		setupPoll = setInterval(async () => {
			if (Date.now() > deadline) {
				stopSetupPoll();
				note(elCliNote, "没等到浏览器授权完成：可以稍后点「重新检测」，或到终端手动执行命令。", "err");
				return;
			}
			try {
				const payload = await call("/cli/setup", { timeoutMs: 20_000 });
				if (payload.setup) {
					deviceInfo = { ...(deviceInfo || {}), ...payload.setup };
					paintDevice();
				}
				await refreshInfo?.();
				const cli = getInfo()?.cli;
				paintIdentity();
				const done = targetStep === "login" ? cli?.loggedIn : cli?.configured;
				if (done) {
					stopSetupPoll();
					deviceInfo = null;
					paintDevice();
					note(elCliNote, targetStep === "login" ? "登录完成：个人身份已就绪" : "应用配置完成：可以登录账号了", "ok");
				}
			} catch {
				/* 一次拉取失败不打断追踪 */
			}
		}, SETUP_POLL_MS);
		setupPoll?.unref?.();
	}

	/* --------------------------------- 生命周期 --------------------------------- */

	let disposed = false;
	let timer = null;
	let refreshing = null;

	/** 进设置页 / 点刷新：先刷 /state（顶栏胶囊也一起更），再刷同步诊断。 */
	async function refresh() {
		if (disposed) return;
		if (refreshing) return refreshing;
		refreshing = (async () => {
			refreshTried = true;
			try {
				await refreshInfo?.();
			} catch {
				/* entry 自己会报 */
			}
			paintIdentity();
			await Promise.all([refreshSyncState(), autoPanel?.refresh?.()]);
		})().finally(() => {
			refreshing = null;
		});
		return refreshing;
	}

	// 只在"设置页确实看得见"时自刷新：用户待在别的页签就不该有定时器。
	timer = setInterval(() => {
		if (disposed) return;
		if (typeof document !== "undefined" && document.hidden) return;
		if (panel.offsetParent === null && panel.getClientRects().length === 0) return;
		void refreshSyncState();
	}, STATE_REFRESH_MS);
	timer?.unref?.();

	// 首次进入：先用 entry 已经拉过的 /state 画一遍（不发请求），同步诊断延后到第一次刷新。
	paintIdentity();
	diagnosticsPanel?.apply?.(null);
	setActive(activeId);

	return {
		refresh,
		focus(id) {
			setActive(id, true);
		},
		destroy() {
			disposed = true;
			stopSetupPoll();
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			try {
				syncPanel?.destroy?.();
			} catch {
				/* 容器已移除 */
			}
			try {
				autoPanel?.destroy?.();
			} catch {
				/* 容器已移除 */
			}
			try {
				panel.innerHTML = "";
			} catch {
				/* 容器已移除 */
			}
		},
	};
}
