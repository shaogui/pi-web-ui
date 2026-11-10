/**
 * plugins/feishu-pro/lib/risk-lexicon.mjs
 * 入站风险词表：**只做触发端的判断**，不替代出站脱敏（那是 `redactOutgoing` 的事）。
 *
 * 为什么要有这一层：自动回复一旦能"动手"，最贵的错误不是答错话，而是替你把话说死
 * （报价、交期、承诺）或把不该给的东西给出去（凭据、涉密、他人信息）。模型判断不可靠且
 * 可被对方的话术诱导，所以先用一份**可编辑、可解释**的词表把高危请求挡在 agent 之前。
 *
 * 四个档位（优先级从高到低，见 `matchRisk`）：
 *   - ignore   广告/系统消息：连通知都不发，别用营销词把我吵醒；
 *   - block    资金/合同/报价/人事/凭据/涉密：不回包，只通知我 + 建待办；
 *   - overreach 越权动作（改群设置、拉人进群、代发代付…）：内容再无害也转人工；
 *   - review   可以回，但只许安全口径（不给具体时间/数字），且不许升级成 work。
 *
 * 调词表时只改下面的数组：`terms` 命中任一即算命中，`except` 命中任一则该条**整条跳过**
 * （用于「合同模板」这类误伤），`withAny` 要求同时出现（用于「明天 + 交付」这种组合）。
 */

export const RISK_TIERS = ["ignore", "block", "overreach", "review"];

export const RISK_TIER_LABEL = {
	ignore: "推广/系统消息",
	block: "高风险（需本人确认）",
	overreach: "越权动作",
	review: "需谨慎措辞",
};

export const RISK_LEXICON = {
	/** 广告/系统消息：静默处理。只放**营销专用**词，别把「加微信」「拉群」这类正常请求塞进来。 */
	ignore: [
		{
			id: "ads",
			label: "推广",
			terms: ["推广", "广告", "刷单", "兼职", "返利", "贷款", "开户", "代运营", "优惠券", "促销", "分销", "招商"],
		},
		{ id: "bulk", label: "群发/系统", terms: ["群公告", "系统消息", "自动回复", "退订", "unsubscribe"] },
	],

	/** 资金/合同/报价/人事/凭据/涉密：一律不回包。 */
	block: [
		{
			id: "money",
			label: "资金",
			terms: [
				"转账",
				"汇款",
				"打款",
				"收款",
				"付款",
				"退款",
				"发票",
				"开票",
				"报销",
				"押金",
				"定金",
				"尾款",
				"账期",
				"对公账户",
				"收款码",
				"银行卡",
				"支付宝",
				"微信支付",
				"银行账号",
			],
		},
		{
			id: "contract",
			label: "合同/法律",
			terms: ["合同", "协议", "签约", "盖章", "条款", "违约", "赔偿", "诉讼", "律师", "法务", "保密协议", "nda"],
			except: ["合同模板", "协议模板", "模板下载"],
		},
		{
			id: "price",
			label: "报价/让利",
			terms: ["报价", "底价", "折扣", "优惠", "返点", "佣金", "提成", "成本价", "预算上限", "最低价"],
			except: ["报价单模板", "价格表模板"],
		},
		{
			id: "hr",
			label: "人事",
			terms: ["薪资", "工资", "涨薪", "绩效", "考核", "裁员", "离职", "开除", "背调", "offer"],
			except: ["绩效考核制度", "考核模板"],
		},
		{
			id: "credential",
			label: "凭据/身份",
			terms: ["密码", "验证码", "校验码", "动态码", "密钥", "私钥", "token", "身份证", "护照", "银行卡号"],
		},
		{
			id: "confidential",
			label: "涉密",
			terms: ["机密", "涉密", "内部资料", "未公开", "招投标", "标书", "中标"],
		},
	],

	/** 越权动作：用短语而不是单个动词，避免「删」把「删掉这条消息」也拦进来。 */
	overreach: [
		{
			id: "group-ops",
			label: "群管理",
			terms: [
				"拉进群",
				"拉他进群",
				"拉人进群",
				"改群设置",
				"改群公告",
				"帮我@所有人",
				"替我@所有人",
				"@一下所有人",
				"转让群主",
			],
		},
		{
			id: "others-doc",
			label: "他人文档",
			terms: ["删掉别人的文档", "改别人的文档", "把别人的文档", "转移文档所有权"],
		},
		{ id: "proxy", label: "代发代付", terms: ["代发", "代付", "帮我授权", "开个权限", "导出成员名单", "导出通讯录"] },
	],

	/** 可以回，但只许安全口径。 */
	review: [
		{
			id: "deadline",
			label: "时间承诺",
			terms: ["今天", "明天", "后天", "本周", "下周", "周内", "月底", "尽快", "马上", "今晚", "下午", "上午"],
			withAny: ["交付", "完成", "上线", "给到", "回复", "提供", "发你", "发我", "处理", "出来", "搞定"],
		},
		{
			id: "schedule",
			label: "进度/排期",
			terms: ["进度", "排期", "什么时候", "还要多久", "上线时间", "延期", "delay", "里程碑", "milestone"],
		},
		{
			id: "pricing-ask",
			label: "价格询问",
			terms: ["多少钱", "怎么收费", "费用", "报价单", "价格"],
			withAny: ["多少", "怎么", "咨询", "问", "发", "报"],
			except: ["价格表模板"],
		},
		{ id: "personal", label: "他人信息", terms: ["手机号", "邮箱", "微信", "工号", "家庭地址", "住址"] },
		{ id: "forward", label: "对外引用", terms: ["发我一份", "原文", "附件", "发我看看", "传我"] },
	],
};

/**
 * 归一化：全角转半角、小写、去掉所有空白。
 *
 * 去空白是有意的：中文里「报 价」和「报价」应该命中同一条；英文 `N D A` 同理。
 * 副作用是 "1 2 3" 会变成 "123"，但这份词表只做子串匹配，不解析数字，可以接受。
 */
export function normalizeRiskText(value) {
	return String(value ?? "")
		.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
		.toLowerCase()
		.replace(/\s+/g, "");
}

/** 一条词条是否命中（except 优先：命中任何豁免词就整条跳过）。 */
function hitOf(entry, text) {
	const terms = Array.isArray(entry?.terms) ? entry.terms : [];
	const except = Array.isArray(entry?.except) ? entry.except : [];
	if (except.some((word) => word && text.includes(normalizeRiskText(word)))) return null;
	const withAny = Array.isArray(entry?.withAny) ? entry.withAny : [];
	if (withAny.length > 0 && !withAny.some((word) => word && text.includes(normalizeRiskText(word)))) return null;
	for (const term of terms) {
		const needle = normalizeRiskText(term);
		if (needle && text.includes(needle))
			return { id: String(entry.id || ""), label: String(entry.label || ""), term: String(term) };
	}
	return null;
}

/**
 * 判定一条入站文本的风险档位。
 *
 * 优先级刻意是 ignore → block → overreach → review：广告里出现「最低价」「贷款」时应该
 * **静默**，而不是升级成转人工把我吵醒；营销词命中即认定这条不值得看。
 *
 * @returns {{ tier: "" | "ignore" | "block" | "overreach" | "review", hits: Array<{id:string,label:string,term:string}>, reason: string }}
 */
export function matchRisk(value) {
	const text = normalizeRiskText(value);
	if (!text) return { tier: "", hits: [], reason: "" };
	for (const tier of RISK_TIERS) {
		const entries = Array.isArray(RISK_LEXICON[tier]) ? RISK_LEXICON[tier] : [];
		const hits = [];
		for (const entry of entries) {
			const hit = hitOf(entry, text);
			if (hit) hits.push(hit);
			if (hits.length >= 3) break;
		}
		if (hits.length > 0) {
			const label = hits[0].label || RISK_TIER_LABEL[tier];
			return { tier, hits, reason: `${RISK_TIER_LABEL[tier]}：${label}（${hits[0].term}）` };
		}
	}
	return { tier: "", hits: [], reason: "" };
}
