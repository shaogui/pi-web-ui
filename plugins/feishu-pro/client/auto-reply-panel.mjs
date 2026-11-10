/**
 * plugins/feishu-pro/client/auto-reply-panel.mjs
 * 「自动问答」（私聊 / 群聊）的**表单体**（不含卡片外壳 —— 外壳由设置页 ③ 区提供）。
 *
 * 为什么要有这块 UI：自动回复是**唯一会以你本人名义自动开口**的能力。
 * 默认关闭、范围与会话都为空则谁都不回 —— 打开它必须是人手动点的一次决定，
 * 所以面板上把「谁会被回 / 频率多少 / 会说什么」三件事都摊开给用户看。
 * 「谁」由两部分组成：**范围开关**（全部私聊 / 全部群组）+ 指定会话（oc_ 白名单）。
 *
 * 0.15.0 改版：外壳（卡头、状态胶囊、卡底动作条）交给 `settings-view.mjs`，
 * 这里只留控件 + 脏标记 + 保存；低频内容（预览、回复历史）收进折叠区。
 */

import { apiBase, esc } from "@pi-web-ui/plugin-sdk/client";

const BASE = apiBase("feishu-pro");
const STYLE_ID = "fp-auto-styles";

const STYLES = `
.fp-auto{display:flex;flex-direction:column;gap:12px;}
.fp-auto .fp-auto-num{width:78px;text-align:center;}
.fp-auto .fp-auto-ids{width:100%;min-height:58px;line-height:1.6;resize:vertical;word-break:break-all;}
.fp-auto .fp-auto-profile{width:100%;min-height:64px;line-height:1.6;resize:vertical;}
.fp-auto-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim);word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--text-faint);}
.fp-auto-dot.on{background:var(--green);}
.fp-auto-dot.err{background:var(--red);}
.fp-auto-msg{font-size:11.5px;line-height:1.7;color:var(--text-faint);word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-msg.err{color:var(--red);}
.fp-auto-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.fp-auto-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;}
.fp-auto-item{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border-radius:8px;background:var(--bg);border:1px solid var(--border-soft);min-width:0;}
.fp-auto-head{display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--text-faint);}
.fp-auto-who{font-size:12px;font-weight:600;color:var(--text);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fp-auto-ask,.fp-auto-reply{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-ask{color:var(--text-dim);}
.fp-auto-reply{color:var(--text);}
.fp-auto-dry{color:var(--text-faint);font-style:italic;}
.fp-auto-route{font-size:10.5px;padding:1px 6px;border-radius:6px;border:1px solid var(--border-soft);color:var(--text-dim);white-space:nowrap;}
.fp-auto-route.work{color:var(--accent);border-color:var(--accent);}
.fp-auto-route.escalate{color:var(--red);border-color:var(--red);}
.fp-auto-route.ignore{color:var(--text-faint);}
.fp-auto-trace{font-size:11px;line-height:1.7;color:var(--text-faint);word-break:break-word;overflow-wrap:anywhere;}
.fp-auto-dir{width:100%;}
.fp-auto-preview{width:100%;min-height:130px;line-height:1.6;resize:vertical;}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

/** 兜底传输层：见 sync-panel.mjs 同名字段的注释（设置页会注入自己的 `call`）。 */
async function localCall(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
	const init = { method, credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs) };
	if (method !== "GET" && body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const resp = await fetch(`${BASE}${path}`, init);
	let payload;
	try {
		payload = await resp.json();
	} catch {
		throw new Error(`服务端返回非 JSON（HTTP ${resp.status}）——插件服务端可能还是旧代码，到「插件」面板点「重新加载」`);
	}
	if (!payload || payload.ok !== true) throw new Error(payload?.error || `请求失败（HTTP ${resp.status}）`);
	return payload;
}

function ago(ms) {
	const delta = Date.now() - Number(ms || 0);
	if (!Number.isFinite(delta) || delta < 0) return "";
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 挂载表单体。
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {(path: string, init?: object) => Promise<any>} [opts.call] 传输层（不传就用自己的 fetch 封装）
 * @param {(dirty: boolean) => void} [opts.onDirty] 脏标记变化（设置页据此显示卡底动作条）
 * @returns {{ apply: (state: any) => void, refresh: () => Promise<any>, save: () => Promise<void>, revert: () => void, isDirty: () => boolean, destroy: () => void }}
 */
export function mountAutoReplyPanel(container, opts = {}) {
	const noop = {
		apply: () => {},
		refresh: async () => null,
		save: async () => {},
		revert: () => {},
		isDirty: () => false,
		destroy: () => {},
	};
	if (!container || typeof container.appendChild !== "function") return noop;
	injectStyles();
	const call = typeof opts.call === "function" ? opts.call : localCall;

	const wrap = document.createElement("div");
	wrap.className = "fp-auto";
	wrap.innerHTML = `
		<div class="fp-form">
			<div class="fp-field">
				<div class="fp-field-label">开关</div>
				<label class="fp-check"><input type="checkbox" class="fp-auto-enabled" /> 启用自动回复</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-dry" /> 空跑（只记录不发）</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-work" /> 允许 AI 动手（查文档 / 用工具把事办了）</label>
				<div class="fp-field-hint">关掉时只回「知道的事」；打开后每条消息先做一次前置分析，只有真需要动手的才起一轮 agent。默认关。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">它能做什么</div>
				<label class="fp-check">每小时最多动手 <input type="number" class="fp-input fp-auto-num fp-auto-workcap" min="0" max="100" step="1" aria-label="每小时动手上限" /> 次</label>
				<label class="fp-check">单轮运行上限 <input type="number" class="fp-input fp-auto-num fp-auto-runtimeout" min="0" max="900" step="10" aria-label="单轮运行上限秒数" /> 秒</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-esctodo" /> 高风险转人工时顺手记一条待办</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-redact" /> 出站脱敏（手机号 / 邮箱 / 证件 / 本机路径）</label>
				<div class="fp-field-hint">「动手」= 允许它检索飞书文档 / 历史消息、读素材目录、写本地待办。发送始终由插件完成，AI 不直接对外发消息。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">我的背景（AI 回复共用）</div>
				<textarea class="fp-input fp-auto-profile" rows="3" placeholder="例：我负责公司 GitLab 与账号权限审批；开通账号默认给 Developer 权限、账号绑对方邮箱。"></textarea>
				<div class="fp-field-hint">写清你的角色、能直接拍板的事和常用口径。会话页「AI 回复」与自动回复起草时都会参考；<b>别写密码等敏感信息</b>（它会进每一次生成的提示词）。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">对外素材目录（只读）</div>
				<input class="fp-input fp-mono fp-auto-library fp-auto-dir" spellcheck="false" placeholder="（留空 = 没有素材，只能查飞书）" />
				<div class="fp-field-hint">这个目录里的文件 AI 可以读、可以摘要给对方，但<b>不会写</b>。不能填根目录 / 主目录 / 数据目录。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">回包身份</div>
				<select class="fp-input fp-auto-as">
					<option value="user">我（本人）</option>
					<option value="bot">机器人</option>
				</select>
				<div class="fp-field-hint">以你本人身份回包时，对方看到的是你。</div>
			</div>
			<div class="fp-field">
				<div class="fp-field-label">频率与时效</div>
				<label class="fp-check">冷却 <input type="number" class="fp-input fp-auto-num fp-auto-cooldown" min="0" max="3600" step="5" aria-label="冷却秒数" /> 秒</label>
				<label class="fp-check">每小时上限 <input type="number" class="fp-input fp-auto-num fp-auto-cap" min="0" max="1000" step="1" aria-label="每小时上限" /></label>
				<label class="fp-check">旧消息超过 <input type="number" class="fp-input fp-auto-num fp-auto-stale" min="0" max="86400" step="10" aria-label="旧消息过期秒数" /> 秒不回</label>
				<div class="fp-field-hint">轮询有延迟：超过这个时长的消息视为历史积压，不自动补答。<b>0 = 不限时效</b>，重启后可能把积压的消息补答一遍。</div>
			</div>
		</div>
		<div class="fp-field">
			<div class="fp-field-label">允许自动回复的会话</div>
			<div class="fp-auto-row">
				<label class="fp-check"><input type="checkbox" class="fp-auto-all-dms" /> 全部私聊</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-all-groups" /> 全部群组</label>
				<label class="fp-check"><input type="checkbox" class="fp-auto-mention" /> 群里只回 @我 的消息</label>
			</div>
			<div class="fp-field-hint">两个范围都不勾时只回下面这些会话；<b>范围 + 会话都为空 = 一条都不回</b>。「只回 @我」约束的是「全部群组」范围；明确填在下面的群不受此限。建议先用「空跑」跑一天，确认话术没问题再关掉。</div>
			<textarea class="fp-input fp-mono fp-auto-ids" spellcheck="false" placeholder="指定会话（可选）：oc_0123456789abcdef0123456789abcdef"></textarea>
			<div class="fp-field-hint fp-auto-count"></div>
			<div class="fp-field-hint fp-auto-scope" hidden></div>
		</div>
		<div class="fp-field">
			<div class="fp-field-label">签名</div>
			<input class="fp-input fp-auto-signature" placeholder="（留空则不加，如：—— 由 AI 助理代回）" />
		</div>
		<details class="fp-fold">
			<summary>预览会发什么</summary>
			<div class="fp-fold-body">
				<div class="fp-auto-row">
					<button class="fp-btn fp-btn-sm fp-auto-preview-btn" type="button">预览一条消息</button>
				</div>
				<textarea class="fp-input fp-mono fp-auto-preview" readonly placeholder="点上面的按钮：取「指定会话」里的第一个（没填就用正在轮询的会话）拉最近一条消息，看看模型会收到什么提示词。"></textarea>
			</div>
		</details>
		<div class="fp-auto-state"><span class="fp-auto-dot"></span><span class="fp-auto-state-text">读取中…</span></div>
		<div class="fp-auto-msg fp-auto-hint"></div>
		<details class="fp-fold">
			<summary>最近自动回复</summary>
			<div class="fp-fold-body">
				<div class="fp-auto-list fp-auto-replies"><div class="fp-auto-msg">还没有记录</div></div>
			</div>
		</details>
		<details class="fp-fold">
			<summary>最近的判定（含没回的）</summary>
			<div class="fp-fold-body">
				<div class="fp-auto-list fp-auto-triage"><div class="fp-auto-msg">还没有记录</div></div>
			</div>
		</details>
	`;
	container.appendChild(wrap);

	const $ = (sel) => wrap.querySelector(sel);
	const elEnabled = $(".fp-auto-enabled");
	const elDry = $(".fp-auto-dry");
	const elWork = $(".fp-auto-work");
	const elAs = $(".fp-auto-as");
	const elCooldown = $(".fp-auto-cooldown");
	const elCap = $(".fp-auto-cap");
	const elStale = $(".fp-auto-stale");
	const elWorkCap = $(".fp-auto-workcap");
	const elRunTimeout = $(".fp-auto-runtimeout");
	const elEscTodo = $(".fp-auto-esctodo");
	const elRedact = $(".fp-auto-redact");
	const elProfile = $(".fp-auto-profile");
	const elLibrary = $(".fp-auto-library");
	const elAllDms = $(".fp-auto-all-dms");
	const elAllGroups = $(".fp-auto-all-groups");
	const elMention = $(".fp-auto-mention");
	const elIds = $(".fp-auto-ids");
	const elCount = $(".fp-auto-count");
	const elScope = $(".fp-auto-scope");
	const elSig = $(".fp-auto-signature");
	const elStateText = $(".fp-auto-state-text");
	const elDot = $(".fp-auto-dot");
	const elHint = $(".fp-auto-hint");
	const elPreview = $(".fp-auto-preview");
	const elList = $(".fp-auto-replies");
	const elTriage = $(".fp-auto-triage");
	const btnPreview = $(".fp-auto-preview-btn");

	let busy = false;
	let disposed = false;
	let state = null;
	let dirty = false;

	function markDirty(next) {
		if (dirty === next) return;
		dirty = next;
		opts.onDirty?.(dirty);
	}

	/** 白名单里到底有几个 oc_：省得用户自己数。 */
	function parseIds(value) {
		return String(value || "")
			.split(/[\s,;]+/)
			.map((s) => s.trim())
			.filter((s) => s.startsWith("oc_"));
	}

	/** 当前勾了哪些范围（顺序固定：先私聊后群组，和输入框里的顺序一致）。 */
	function scopeLabels() {
		return [elAllDms?.checked ? "全部私聊" : "", elAllGroups?.checked ? "全部群组" : ""].filter(Boolean);
	}

	/**
	 * 范围自述：**空范围 + 空会话 = 谁都不回**，这是最容易"看起来配好了"的坑，
	 * 所以这一行必须说人话，而不是只报个数。
	 */
	function paintCount(value) {
		const ids = parseIds(value);
		const scope = scopeLabels();
		if (!ids.length && !scope.length) {
			elCount.textContent = "范围没勾、会话也没填 → 谁都不会被自动回复";
			elCount.className = "fp-field-hint fp-auto-count err";
			return ids;
		}
		const extra = ids.length ? `已识别 ${ids.length} 个会话` : "";
		elCount.textContent = [extra, scope.length ? `范围：${scope.join(" + ")}` : ""].filter(Boolean).join(" · ");
		elCount.className = "fp-field-hint fp-auto-count";
		return ids;
	}

	/**
	 * 范围是否**真的能收到**：勾了「全部群组」但消息同步没开群聊，轮询里根本没有群消息。
	 * 这种「勾了不生效」必须就地说明，否则用户会以为是自动回复坏了。
	 */
	function paintScope() {
		if (!elScope) return;
		const sync = state?.sync || null;
		const scope = scopeLabels();
		const notes = [];
		if (scope.length && sync && !sync.enabled)
			notes.push("「消息同步与提醒」的后台同步没启用 → 收不到任何新消息，勾了范围也不会回。");
		if (elAllDms?.checked && sync && !sync.autoDiscover)
			notes.push("「全部私聊」要等「消息同步与提醒 → 同步范围」勾上「私聊（自动发现）」才覆盖得到。");
		if (elAllGroups?.checked && sync && !sync.syncGroups)
			notes.push("「全部群组」要等「消息同步与提醒 → 同步范围」勾上「群聊（自动发现）」才收得到群消息。");
		if (scope.length && sync) {
			const budget = sync.budget || {};
			const cap =
				budget.chats || budget.groups
					? `（单轮上限 ${budget.chats || 0} 私聊 / ${budget.groups || 0} 群，超出按最近活跃截断）`
					: "";
			notes.push(`轮询当前覆盖 ${sync.p2p || 0} 个私聊 / ${sync.groups || 0} 个群${cap}。`);
		}
		elScope.textContent = notes.join(" ");
		elScope.className = "fp-field-hint fp-auto-scope";
		elScope.hidden = notes.length === 0;
	}

	function paint() {
		if (!state) return;
		const cfg = state.config || {};
		if (!dirty) {
			elEnabled.checked = Boolean(cfg.enabled);
			elDry.checked = Boolean(cfg.dryRun);
			elWork.checked = Boolean(cfg.workEnabled);
			elAs.value = cfg.as === "bot" ? "bot" : "user";
			elCooldown.value = String(cfg.cooldownSec ?? 20);
			elCap.value = String(cfg.maxPerHour ?? 20);
			elStale.value = String(cfg.staleSec ?? 300);
			elWorkCap.value = String(cfg.maxWorkPerHour ?? 3);
			elRunTimeout.value = String(cfg.runTimeoutSec ?? 120);
			elEscTodo.checked = cfg.escalateTodo !== false;
			elRedact.checked = cfg.redact !== false;
			elProfile.value = String(cfg.ownerProfile ?? "");
			elLibrary.value = String(cfg.libraryDir ?? "");
			elAllDms.checked = Boolean(cfg.allDms);
			elAllGroups.checked = Boolean(cfg.allGroups);
			// 缺省 true：老配置里没有这个字段时，群里仍然只回 @我。
			elMention.checked = cfg.groupMentionOnly !== false;
			elIds.value = String(cfg.chatIds ?? "");
			elSig.value = String(cfg.signature ?? "");
		}
		paintCount(elIds.value);
		paintScope();

		const error = state.lastError || "";
		elDot.className = `fp-auto-dot${error ? " err" : cfg.enabled ? " on" : ""}`;
		const parts = [cfg.enabled ? "已启用" : "未启用"];
		// 用**表单当前值**判定（服务端那份可能正是用户刚改掉的那份）。
		if (cfg.enabled && !parseIds(elIds.value).length && !scopeLabels().length)
			parts.push("没有允许的会话 → 不会回任何会话");
		if (state.inflight) parts.push(`在跑 ${state.inflight}`);
		parts.push(`本小时已回 ${state.sentLastHour ?? 0}${cfg.maxPerHour ? `/${cfg.maxPerHour}` : ""}`);
		if (cfg.workEnabled)
			parts.push(`动手 ${state.worksLastHour ?? 0}${cfg.maxWorkPerHour ? `/${cfg.maxWorkPerHour}` : ""}`);
		if (state.lastReplyAt) parts.push(`上次 ${ago(state.lastReplyAt)}`);
		parts.push(
			`已绑定会话 ${state.conversations ?? 0}${state.workConversations ? ` · 动手会话 ${state.workConversations}` : ""}`,
		);
		if (error) parts.push(`错误：${error}`);
		elStateText.textContent = parts.join(" · ");

		if (state.hostChat === false) {
			elHint.textContent = "当前宿主没有注入 chat 通道（无头 agent 不可用），自动回复无法启动。";
			elHint.className = "fp-auto-msg fp-auto-hint err";
		} else {
			const notes = [];
			if (cfg.dryRun) notes.push("空跑模式：会跑 agent 并记录要发的内容，但不会真的发出去。");
			if (cfg.workEnabled && !String(cfg.libraryDir || "").trim())
				notes.push("动手已开启但没有配素材目录：只能查飞书文档/历史消息，读不到本地素材。");
			if (cfg.workEnabled && state.llm === false) notes.push("宿主没有注入 llm 通道：前置分析会降级成“只写正文”。");
			elHint.textContent = notes.join(" ");
			elHint.className = "fp-auto-msg fp-auto-hint";
		}

		const ROUTE_TEXT = {
			send: "直接答",
			reply: "直接答",
			compose: "代写",
			work: "动手",
			escalate: "转人工",
			ignore: "不回",
		};
		const replies = Array.isArray(state.replies) ? state.replies : [];
		elList.innerHTML = replies.length
			? replies
					.slice(0, 20)
					.map((r) => {
						const route = String(r.route || "");
						const badge = ROUTE_TEXT[route]
							? `<span class="fp-auto-route ${esc(route)}">${esc(ROUTE_TEXT[route])}</span>`
							: "";
						const trace =
							Array.isArray(r.trace) && r.trace.length
								? `<div class="fp-auto-trace">工具：${r.trace
										.map((t) => `${esc(t.name)}${t.ok === false ? "✗" : ""}${t.ms ? ` ${t.ms}ms` : ""}`)
										.join(" · ")}</div>`
								: "";
						return `<div class="fp-auto-item">
							<div class="fp-auto-head"><span>${esc(ago(r.at))}</span><span class="fp-auto-who">${esc(
								r.from || r.chatName || r.chatId,
							)}</span>${badge}${r.dryRun ? '<span class="fp-auto-dry">空跑</span>' : ""}${
								r.error ? `<span class="fp-auto-dry" style="color:var(--red)">${esc(r.error)}</span>` : ""
							}</div>
							<div class="fp-auto-ask">← ${esc(r.ask)}</div>
							<div class="fp-auto-reply">→ ${esc(r.reply || "（未发送）")}</div>
							${r.why ? `<div class="fp-auto-trace">${esc(r.why)}${r.sentBy === "agent" ? " · agent 自行发送" : ""}</div>` : ""}
							${trace}
						</div>`;
					})
					.join("")
			: `<div class="fp-auto-msg">还没有记录</div>`;

		// 判定记录比「发了什么」更重要：没回的那条为什么没回，全靠这里。
		const triage = Array.isArray(state.triage) ? state.triage : [];
		elTriage.innerHTML = triage.length
			? triage
					.slice(0, 20)
					.map((t) => {
						const route = String(t.route || "");
						const badge = ROUTE_TEXT[route]
							? `<span class="fp-auto-route ${esc(route)}">${esc(ROUTE_TEXT[route])}</span>`
							: "";
						return `<div class="fp-auto-item">
							<div class="fp-auto-head"><span>${esc(ago(t.at))}</span><span class="fp-auto-who">${esc(
								t.from || t.chatName || t.chatId,
							)}</span>${badge}${t.tier ? `<span class="fp-auto-dry">${esc(t.tier)}</span>` : ""}</div>
							<div class="fp-auto-ask">← ${esc(t.ask || "（无正文）")}</div>
							<div class="fp-auto-trace">${esc(t.why || "")}${t.intent ? ` · 意图：${esc(t.intent)}` : ""}</div>
						</div>`;
					})
					.join("")
			: `<div class="fp-auto-msg">还没有记录</div>`;
	}

	function apply(next) {
		if (!next) return;
		state = next;
		paint();
	}

	async function refresh() {
		if (disposed) return null;
		try {
			const payload = await call("/auto/state");
			apply(payload);
			return payload;
		} catch (err) {
			elHint.textContent = `读取失败：${err?.message || err}`;
			elHint.className = "fp-auto-msg fp-auto-hint err";
			return null;
		}
	}

	/** 过期时效：空/非法一律回到 300（把输入框清空不该等于「不限」，那会把积压全补答一遍）。 */
	function staleSecValue() {
		const raw = String(elStale.value ?? "").trim();
		if (!raw) return 300;
		const n = Math.round(Number(raw));
		if (!Number.isFinite(n) || n < 0) return 300;
		return Math.min(n, 86_400);
	}

	function patch() {
		return {
			enabled: elEnabled.checked,
			dryRun: elDry.checked,
			workEnabled: elWork.checked,
			as: elAs.value,
			cooldownSec: Number(elCooldown.value) || 0,
			maxPerHour: Number(elCap.value) || 0,
			staleSec: staleSecValue(),
			maxWorkPerHour: Number(elWorkCap.value) || 0,
			runTimeoutSec: Number(elRunTimeout.value) || 0,
			escalateTodo: elEscTodo.checked,
			redact: elRedact.checked,
			ownerProfile: elProfile.value,
			libraryDir: elLibrary.value,
			chatIds: elIds.value,
			allDms: elAllDms.checked,
			allGroups: elAllGroups.checked,
			groupMentionOnly: elMention.checked,
			signature: elSig.value,
		};
	}

	async function withBusy(fn) {
		if (busy || disposed) return;
		busy = true;
		try {
			await fn();
		} catch (err) {
			elHint.textContent = String(err?.message || err);
			elHint.className = "fp-auto-msg fp-auto-hint err";
		} finally {
			busy = false;
		}
	}

	/** 保存并生效：由设置页的卡底动作条调用。 */
	async function save() {
		await withBusy(async () => {
			const payload = await call("/auto/config", { method: "POST", body: patch() });
			markDirty(false);
			apply(payload);
			elHint.textContent = payload.config?.enabled ? "已保存并生效" : "已保存（当前是关闭状态）";
			elHint.className = "fp-auto-msg fp-auto-hint";
		});
	}

	function revert() {
		markDirty(false);
		paint();
	}

	btnPreview?.addEventListener("click", () =>
		withBusy(async () => {
			const ids = paintCount(elIds.value);
			// 勾了「全部」时白名单可以是空的：服务端会给几个正在轮询的会话当预览目标。
			const sample = (Array.isArray(state?.sync?.sample) ? state.sync.sample : []).find((row) => row?.id);
			const target = ids[0] || sample?.id || "";
			if (!target) {
				elHint.textContent = "预览要看一个具体会话：填一个 oc_ 会话 ID（或先保存，等轮询把会话列出来）。";
				elHint.className = "fp-auto-msg fp-auto-hint err";
				return;
			}
			const result = await call("/auto/preview", { method: "POST", body: { chatId: target } });
			// 判定走服务端**已保存**的配置：表单有未保存改动时必须说清楚，否则「我明明把过期改成 600 了」会反复出现。
			const staleNote = dirty ? "（按已保存的配置判定；刚才的改动先点「保存并生效」）" : "";
			const risk = result.risk?.reason || "无命中";
			const parts = [
				`[判定] ${result.accepted ? "会被回复" : `不会回（${result.reason}）`}${staleNote}`,
				`[风险词] ${risk}`,
				"",
				"── 前置分析提示词（模型只回 JSON，不调工具）──",
				result.triage || "（前置分析未启用）",
				"",
				"── 动手指令模板（只有 route=work 才会用到）──",
				result.work || "",
			];
			elPreview.value = parts.join("\n");
			elHint.textContent = result.accepted ? "" : `当前配置下这条消息不会触发回复：${result.reason}`;
			elHint.className = `fp-auto-msg fp-auto-hint${result.accepted ? "" : " err"}`;
		}),
	);

	for (const el of [
		elEnabled,
		elDry,
		elWork,
		elAs,
		elCooldown,
		elCap,
		elStale,
		elWorkCap,
		elRunTimeout,
		elEscTodo,
		elRedact,
		elProfile,
		elLibrary,
		elAllDms,
		elAllGroups,
		elMention,
		elIds,
		elSig,
	]) {
		const repaintScope = () => {
			if (el === elIds || el === elAllDms || el === elAllGroups) paintCount(elIds.value);
			if (el === elAllDms || el === elAllGroups) paintScope();
		};
		el?.addEventListener("input", () => {
			markDirty(true);
			repaintScope();
		});
		el?.addEventListener("change", () => {
			markDirty(true);
			repaintScope();
		});
	}

	void refresh();

	return {
		apply,
		refresh,
		save,
		revert,
		isDirty: () => dirty,
		destroy() {
			disposed = true;
			wrap.remove();
		},
	};
}
