/**
 * plugins/feishu-pro/lib/config.mjs
 * 配置层：平台预设、字段归一化、脱敏。纯函数，单测友好。
 *
 * 设计要点（0.10.1 起）：
 *   - 凭证与应用注册全在 lark-cli 里，插件只留**展示项**（平台 / 文档域名）；
 *   - 旧凭证链的字段（appId / baseUrl / 回调地址 / scope）已随 `lib/openapi.mjs` 一起删除：
 *     留着只会让「设置页还能填、填了也没人用」的假象继续存在；
 *   - CLI-only 曾作为回落通道的坟墓开关；回落通道删完后它恒为真，已无意义 —— 一并删除；
 *   - 归一化必须幂等：normalizeConfig(normalizeConfig(x)) 等价于 normalizeConfig(x)。
 */

export const PLUGIN_ID = "feishu-pro";

/**
 * 平台预设：只决定**文档链接域名**（生成 https://<docHost>/docx/<token> 用）。
 * 接口地址由 lark-cli 自己的 profile 决定，插件不再持有 baseUrl。
 */
export const PRESETS = {
	feishu: {
		label: "飞书（国内版）",
		docHost: "feishu.cn",
	},
	lark: {
		label: "Lark（国际版）",
		docHost: "larksuite.com",
	},
	custom: {
		label: "私有化 / 自建网关",
		docHost: "feishu.cn",
	},
};

/** 默认配置（新增字段必须给缺省值，老数据缺字段时按它回落）。 */
export const DEFAULT_CONFIG = {
	preset: "feishu",
	/** 覆盖文档域名（生成文档链接用，例如 xxx.feishu.cn 的 feishu.cn 部分）。 */
	docHost: "",
};

/** 去掉尾部斜杠（"" 安全）。 */
export function trimSlash(url) {
	return String(url ?? "")
		.trim()
		.replace(/\/+$/, "");
}

/** 配置归一化：白名单字段 + 类型收敛 + 幂等。未知字段一律丢弃。 */
export function normalizeConfig(input = {}, prev = DEFAULT_CONFIG) {
	const src = input && typeof input === "object" ? input : {};
	const base = prev && typeof prev === "object" ? prev : DEFAULT_CONFIG;
	const preset = Object.hasOwn(PRESETS, String(src.preset ?? "")) ? String(src.preset) : base.preset;
	const text = (value, fallback) => {
		const out = typeof value === "string" ? value.trim() : undefined;
		return out === undefined ? fallback : out;
	};
	return {
		preset,
		docHost: trimSlash(text(src.docHost, base.docHost)),
	};
}

/** 文档链接的域名后缀（feishu.cn / larksuite.com / 自建）。 */
export function docHost(cfg = DEFAULT_CONFIG) {
	return trimSlash(cfg.docHost) || PRESETS[cfg.preset]?.docHost || PRESETS.feishu.docHost;
}

/** 文档 / 知识库对象链接（token 为空时返回空串）。 */
export function buildDocUrl({ cfg, type, token }) {
	const clean = String(token ?? "").trim();
	if (!clean) return "";
	const host = docHost(cfg);
	const kind = String(type ?? "").toLowerCase();
	// 飞书的 URL 路径前缀和 docs_type 不是一一对应（base/sheets/slides/mindnotes/docs/docx）。
	const prefix =
		{
			wiki: "wiki",
			sheet: "sheets",
			bitable: "base",
			slides: "slides",
			mindnote: "mindnotes",
			doc: "docs",
			docx: "docx",
		}[kind] ?? "docx";
	return `https://${host}/${prefix}/${encodeURIComponent(clean)}`;
}
