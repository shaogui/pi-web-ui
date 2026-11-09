# 飞书 Pro · 文档阅读器富文本渲染方案（v0.9.0 目标）

> **历史文档（0.10.27 补注）**：本文描述的 `lib/doc-blocks.mjs`（docx blocks 拉取 + 规范化）那条路径**已删除**。
> 云文档正文现在统一走 `lark-cli docs +fetch` → markdown（`lib/cli-docs.mjs`），再由 `client/doc-reader.mjs`
> 现场把 markdown 转成 Node[] 渲染 —— 即本文提到的 `buildNodes(tree)` 前端部分仍然有效，只是数据源从 blocks 换成了 markdown。
> 本文保留作决策记录（为什么当初不再用 `raw_content` 纯文本）。

> 状态：**设计方案，未落地代码**（本文档只是方案，改动代码前先与并行任务确认文件归属）。
> 触发问题：知识库文档「内部向公开」在右栏阅读时格式异常 —— 表格塌成逐行文字、标题层级消失、空行错乱。

## 0. 根因（已定位，三处叠加）

| #   | 位置                                           | 问题                                                                                                                                   |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `lib/docs.mjs` `readDocContent()`（约 154 行） | 只调 `GET /open-apis/docx/v1/documents/{doc}/raw_content`，该接口返回**拍平纯文本**：表格每行变一行文字、标题/列表/引用/代码块结构全丢 |
| 2   | `client/entry.mjs:388`                         | `.fp-reader-body` 是 `white-space:pre-wrap` 的纯文本容器                                                                               |
| 3   | `client/entry.mjs:972`                         | `readerBody.textContent = doc.content` —— 即使后端给结构化数据也渲染不出来                                                             |

后果：`内部向公开` 这种「正文大量表格」的文档几乎不可读；`复制` 拿到的也是塌陷文本。

## 1. 目标与验收

**目标**：`阅读` 按钮产出「所见即所得」的只读渲染 —— 标题 / 段落 / 有序无序列表 / 待办 / 引用 / 代码块 / 分割线 / 表格（含合并单元格）/ 图片内嵌 / 分栏 / 折叠块 / 电子表格预览 / 多维表格预览，未知块降级为可读占位。

**验收（可测）**

1. 表 `内部向公开` 的「服务器规格 / 数据库 / 公网带宽」以**三行两列表格**呈现，而非逐行文字；
2. H1/H2/H3 有字号层级，列表有 `•` / `1.` 标记，待办有勾选态；
3. 图片用 `<img>` 直接显示（不是链接），失败时是占位卡 + 「在飞书中打开」；
4. docx 内嵌 sheet 块显示「表格 24×9 · 点击预览」，点击后渲染前 60 行；
5. 2000 块 / 800KB 的文档首屏 < 400ms（含网络），滚动不掉帧；
6. 全文复制得到**结构保序**的纯文本（表格用 `\t` 分列），且与 `raw_content` 语义一致；
7. 权限不足 / 未授权账号时仍是可执行提示（沿用 `needUser` 文案），不抛裸 400。

## 2. 架构

```
客户端 client/entry.mjs ── readDoc() ──► GET /docs/read?token&type&render=rich
                                                   │
                                    index.mjs readDoc()（身份：user>tenant）
                                                   │
                          ┌────────────────────────┼─────────────────────────┐
                          ▼                        ▼                         ▼
             lib/doc-blocks.mjs          lib/docs.mjs(readDocContent)   lib/doc-media.mjs
             fetchDocBlocks()            raw_content（保留，给 plain）    downloadMedia()
             normalizeBlocks()                  │                       （图片/附件二进制）
                          └────────────► { blocks: TreeNode[], plain, stats }
                                                   │
客户端 client/doc-reader.mjs ◄──────────────────────┘
   buildNodes(tree) → DOM（createElement + createTextNode，禁 innerHTML）
                                │
                                ├─ 图片/附件懒加载 → GET /docs/media?token=…
                                ├─ sheet 块懒加载 → GET /docs/sheet?token=…
                                └─ bitable 块懒加载 → GET /docs/bitable?token=…
```

**新增文件**

| 文件                    | 职责                                           | 规模估计 |
| ----------------------- | ---------------------------------------------- | -------- |
| `lib/doc-blocks.mjs`    | 拉块 + 规范化（纯函数为主，可单测）            | ~320 行  |
| `lib/doc-media.mjs`     | 媒体下载 + 类型白名单 + LRU                    | ~120 行  |
| `lib/doc-sheet.mjs`     | sheet 元信息与网格读取（docx 内嵌 + 独立表格） | ~110 行  |
| `lib/doc-bitable.mjs`   | 多维表格 tables/records 归一化                 | ~130 行  |
| `client/doc-reader.mjs` | DOM 渲染器（唯一新增前端模块）                 | ~380 行  |

**改动文件**（都是小改）

- `lib/docs.mjs`：`readDocContent` 增加 `render` 分支，返回 `blocks`/`plain`/`stats`；
- `index.mjs`：`/docs/read` 传 `render=rich`；新增 `/docs/media`、`/docs/sheet`、`/docs/bitable`；`readDoc()` 记 `reading` 快照带 blocks；
- `client/entry.mjs`：`readDoc()` 改调用 `mountDocReader(readerBody, doc)`；复制走 `doc.plain || doc.content`；reader 宽度可拖拽；
- `manifest.json`：`0.8.6 → 0.9.0`（新增 4 个路由 + 渲染能力 = minor）。

## 3. 服务端设计

### 3.1 拉块

```
GET /open-apis/docx/v1/documents/{document_id}/blocks
    ?page_size=500&document_revision_id=-1&page_token=…
```

- 分页循环（`has_more` / `page_token`），**最多 8 页 / 4000 块**，超出置 `truncated: true`；
- 单页超时 15s，整体超时 25s（与现有 `/docs/read` 的 25s 前端超时对齐）；
- 身份沿用现有口径：`tokens.snapshot().authorized ? user : tenant`；
- 错误交给 `openapi.mjs` 统一翻译（`1061004` → 「把应用加为协作者或改用个人授权」已经覆盖）。

```js
export async function fetchDocBlocks(client, { token, identity, maxBlocks = 4000, maxPages = 8 }) {
	const items = [];
	let pageToken = "";
	for (let page = 0; page < maxPages; page++) {
		const data = await client.get(`/open-apis/docx/v1/documents/${encodeURIComponent(token)}/blocks`, {
			...(identity ? { identity } : {}),
			query: { page_size: 500, document_revision_id: -1, page_token: pageToken },
			timeoutMs: 15000,
		});
		items.push(...(Array.isArray(data?.items) ? data.items : []));
		if (!data?.has_more || items.length >= maxBlocks) break;
		pageToken = String(data.page_token ?? "");
		if (!pageToken) break;
	}
	return { items: items.slice(0, maxBlocks), truncated: items.length >= maxBlocks };
}
```

### 3.2 规范化：扁平 items → 轻量树

飞书块是**扁平数组 + `children: string[]`**，需两次遍历建树。

```js
export function normalizeBlocks(items, { token }) {
	const byId = new Map(items.map((b) => [String(b.block_id ?? ""), b]));
	const rootId = items.find((b) => Number(b.block_type) === 1)?.block_id ?? token; // 1 = page
	const seen = new Set();
	const walk = (id, depth) => {
		if (seen.has(id) || depth > 64) return []; // 环与深防炸
		seen.add(id);
		const raw = byId.get(id);
		if (!raw) return [];
		return [{ ...normalizeOne(raw, token), children: (raw.children ?? []).flatMap((c) => walk(String(c), depth + 1)) }];
	};
	return { nodes: walk(String(rootId), 0), tree: ... };
}
```

**类型判定＝双重兜底**（关键稳健性设计，规避枚举漂移）：

1. `block_type` 数字 → 名称（表见 3.4）；
2. 若数字未知，扫块对象上除 `block_id/block_type/children/parent_id` 外的**唯一键名**（`heading1`/`table`/`callout`/`agenda_item_title`…）；
3. 仍未知 → `unknown`，渲染成「未支持的块类型 N」占位，不丢文字（若存在 `elements` 则按文本渲染）。

### 3.3 行内元素归一化

飞书 `elements[]` 每项是单一键对象，统一压成 `Run`：

```js
// Run = { t: "text"|"mention_doc"|"mention_user"|"equation"|"reminder"|"file"|"link_preview",
//         text, style: { b,i,s,u,code,color,bg,link }, token?, title?, url? }
export function normalizeInline(elements = []) {
	const out = [];
	for (const el of elements) {
		if (!el || typeof el !== "object") continue;
		if (el.text_run) {
			const st = el.text_run.text_element_style ?? {};
			out.push({
				t: "text",
				text: String(el.text_run.content ?? ""),
				style: {
					b: Boolean(st.bold),
					i: Boolean(st.italic),
					s: Boolean(st.strikethrough),
					u: Boolean(st.underline),
					code: Boolean(st.inline_code),
					color: Number(st.text_color ?? 1),
					bg: Number(st.background_color ?? 1),
					link: String(st.link?.url ?? "") || "",
				},
			});
		} else if (el.mention_doc) {
			out.push({
				t: "mention_doc",
				text: String(el.mention_doc.title ?? ""),
				token: String(el.mention_doc.token ?? ""),
				url:
					String(el.mention_doc.url ?? "") ||
					buildDocUrl({ cfg: null, type: el.mention_doc.obj_type, token: el.mention_doc.token }),
			});
		} else if (el.mention_user) {
			/* @某人 → 文本 @名字（不可点，避免权限泄露） */
		} else if (el.equation) {
			out.push({ t: "equation", text: String(el.equation.content ?? "") });
		} else if (el.reminder) {
			out.push({ t: "text", text: `⏰ ${el.reminder.notify_time ?? ""}`, style: {} });
		} else if (el.file) {
			out.push({ t: "file", text: String(el.file.name ?? "附件"), token: String(el.file.token ?? "") });
		}
	}
	return mergeAdjacentText(out); // 相邻同样式 text 合并，减少节点数
}
```

> 颜色/背景色（`text_color` 1–15）→ CSS 类 `fp-dc-1…15`，**必须在 `styles.css` 或插件注入样式里给出主题双模值**（亮/暗各一套），否则暗色下 5/6/7 号色（深蓝/深灰）不可读。

### 3.4 块类型映射（`block_type` → 渲染）

| #     | 类型                   | 渲染                                         | 说明                                                                |
| ----- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| 1     | `page`                 | `<h1>` 或**隐藏**                            | 正文首块=标题，reader 头部已显示；建议隐藏并在 `stats.title` 里给出 |
| 2-11  | `text`, `heading1-9`   | `<p>` / `<h1>-<h6>`（7-9 降级 h6）           |                                                                     |
| 12    | `bullet`               | `<li>` + `list-style: disc`                  | 按 `parent` 深度决定缩进层                                          |
| 13    | `ordered`              | `<ol>`                                       | 飞书有序列表有 `sequence` 字段可作 `start`                          |
| 14    | `code`                 | `<pre><code class="lang-x">`                 | `language` 数字 → 语言名表（3.4.1）；不做高亮（不引依赖）           |
| 15    | `quote`                | `<blockquote>`                               |                                                                     |
| 16    | `equation`             | `<div class="fp-dc-eq">`                     | 原样文本（不解析 LaTeX）                                            |
| 17    | `todo`                 | `<li>` + `☐/☑`（`style.done`）               |                                                                     |
| 18    | `bitable`              | 懒加载卡 → `/docs/bitable`                   |                                                                     |
| 19    | `callout`              | 带色边框卡 + emoji                           | `background_color`/`border_color`/`emoji_id`                        |
| 20    | `chat_card`            | 占位卡                                       |                                                                     |
| 21    | `diagram`              | 占位卡（脑图/流程图）                        | 需「在飞书中打开」                                                  |
| 22    | `divider`              | `<hr>`                                       |                                                                     |
| 23    | `file`                 | 附件卡（名称+大小+下载）                     | 走 `/docs/media?kind=file`                                          |
| 24/25 | `grid` / `grid_column` | `display:flex` 分栏                          | 列宽按 `width_ratio`                                                |
| 26    | `iframe`               | **只显示 URL 链接**                          | 绝不内嵌（XSS/SSRF）                                                |
| 27    | `image`                | `<img loading="lazy" src="/docs/media?…">`   | 宽高来自 `image.width/height`，点击放大                             |
| 28    | `isv`                  | 占位                                         |                                                                     |
| 29    | `mindnote`             | 占位 + 打开链接                              |                                                                     |
| 30    | `sheet`                | 懒加载卡 → `/docs/sheet`                     | `sheet.token` = spreadsheet token                                   |
| 31/32 | `table` / `table_cell` | `<table>`                                    | 见 3.5                                                              |
| 33    | `view`                 | 透传内部文字                                 |                                                                     |
| 34    | `quote_container`      | `<blockquote class="container">` 包 children |                                                                     |
| 35    | `task`                 | 占位（标题或「任务块」）                     |                                                                     |
| 36-39 | `okr*`                 | 占位「OKR」                                  |                                                                     |
| 40    | `add_ons`              | 占位                                         |                                                                     |
| 41    | `jira_issue`           | 占位（key + 状态文本）                       |                                                                     |
| 42    | `wiki_catalog`         | 占位（知识库目录）                           |                                                                     |
| 43    | `board`                | 占位（画板）                                 |                                                                     |
| 44-47 | `agenda*`              | 议程块：标题加粗 + 内容缩进                  |                                                                     |
| 48    | `link_preview`         | 链接卡（url + 标题）                         |                                                                     |
| 49    | `source_synced`        | 占位「同步块」                               |                                                                     |
| 50    | `sub_page_list`        | 懒加载：子文档标题列表                       | `children` 为空时需另调接口，先做占位                               |
| 51    | `ai_template`          | 占位                                         |                                                                     |

> **枚举以官方文档为准**：落地第一步跑一次 dump（临时脚本打印真实文档的 `block_type` → 命中键名分布），把表补全；未知一律 `unknown` 占位（有 `elements` 就渲染文字），**绝不丢内容**。

#### 3.4.1 代码块语言映射（`code.style.language`）

1 PlainText, 2 ABAP, 3 Ada, 4 Apache, 5 Apex, 6 Assembly, 7 Bash, 8 CSharp, 9 C++, 10 C, 11 COBOL, 12 CSS, 13 CoffeeScript, 14 D, 15 Dart, 16 Delphi, 17 Django, 18 Dockerfile, 19 Erlang, 20 Fortran, 21 FoxPro, 22 Go, 23 Groovy, 24 HTML, 25 HTMLBars, 26 HTTP, 27 Haskell, 28 JSON, 29 Java, 30 JavaScript, 31 Julia, 32 Kotlin, 33 LateX, 34 Lisp, 35 Logo, 36 Lua, 37 MATLAB, 38 Makefile, 39 Markdown, 40 Nginx, 41 Objective-C, 42 OpenGL Shading Language, 43 PHP, 44 Perl, 45 PostScript, 46 PowerShell, 47 Prolog, 48 ProtoBuf, 49 Python, 50 R, 51 RPG, 52 Ruby, 53 Rust, 54 SAS, 55 SCSS, 56 SQL, 57 Scala, 58 Scheme, 59 Scratch, 60 Shell, 61 Swift, 62 Thrift, 63 TypeScript, 64 VBScript, 65 Visual Basic, 66 XML, 67 YAML, 68 CMake, 69 Diff, 70 Gherkin, 71 GraphQL, 72 OpenGL Shading Language, 73 Properties, 74 Solidity, 75 TOML。

### 3.5 表格

```js
// 新版：table.cells 是 block_id 数组（row-major，长度 = row_size × column_size）
// 旧版：table.children = [table_cell...]（同样 row-major）
// 更旧：table.children = [table_row...]，每 row.children = [table_cell...]
const cells = table.cells?.length ? table.cells : table.children;
const columns = table.property?.column_size ?? 1;
```

- `merge_info[i]`（每格）给 `{ row_span, col_span }`：渲染时把跨行列的空洞跳过（用 `Set` 记录已占用的 `r,c`）；
- `header_row: true` → 首行 `<th>`（保留 `scope="col"`）；
- 单元格内是块数组 → 递归渲染（段落不额外包 `<p>` 间距）；
- 宽表格：`<div class="fp-dc-tablewrap">` 横向滚动 + `table-layout: auto`，单元格 `min-width: 8em`、`max-width: 28em`、`overflow-wrap: anywhere`；
- 空单元格 → `&nbsp;`（保证边框可见）。

### 3.6 媒体代理

```
GET /plugins-api/feishu-pro/docs/media?token=<file_token>&kind=image|file&name=<urlencoded>
```

- 上游：`GET /open-apis/drive/v1/medias/{token}/download`（图片/附件通用，需 `drive:drive:readonly` 或文档协作者权限）；
- 校验：`token` 必须匹配 `/^[A-Za-z0-9_-]{1,200}$/`，`kind ∈ {image,file}`；不合法 → 400 纯文本；
- 响应头：`Content-Type`（上游白名单：`image/(png|jpe?g|gif|webp|bmp)`、`application/pdf`、`text/plain`，其它强制 `application/octet-stream` + `Content-Disposition: attachment; filename*=UTF-8''…`）、`Content-Length`、`Cache-Control: private, max-age=1800`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'`；
- 大小上限 25MB（超限 413），超时 20s；
- 失败：`404`/`415`/`502` + 纯文本（img 无法解析 JSON），前端 `onerror` → 占位卡；
- 服务端 LRU 缓存：`Map<token, {buf, type, at}>`，上限 20MB / 64 项，`at` 超 10 分钟淘汰；
- **鉴权**：主站 `PI_WEB_TOKEN` Cookie 自动覆盖 `/plugins-api/*`，`<img>` 同源请求自带 Cookie，因此可直接用 `src`（禁止把飞书 token 拼进对外 URL）；
- **降级**：上游 403/权限不足 → 返回 302 到「在飞书中打开」？不：`<img>` 跟随重定向不合适，统一 404 + 前端占位。

### 3.7 sheet 预览

- 元信息：`GET /open-apis/sheets/v3/spreadsheets/{token}/sheets/query` → `sheets[{sheet_id,title,grid_properties{row_count,column_count},merges,frozen_row_count,frozen_column_count}]`；
- 值：`GET /open-apis/sheets/v2/spreadsheets/{token}/values/{sheetId}!A1:{col}{row}`，`rows ≤ 60`、`cols ≤ 12`（v2 上限内），返回 `valueRange.values`；
- 归一化：二维数组 → `string | number | {text, link, bold, bg}` 的单元格 `{v, s?}`；富文本段（`segmentStyle`）只取 `text`；
- 路由：`GET /docs/sheet?token=…&sheet=&rows=60&cols=12` → `{sheets, active, grid:{values, range, truncated}}`；
- 权限：`sheets:spreadsheet:readonly`；失败 → `needUser` 提示沿用统一翻译；
- **独立 sheet 文档**（在列表里点「阅读」的 `type=sheet`）也复用此路由，前端把返回渲染成只读网格（替换当前「暂不支持纯文本预览」）。

### 3.8 bitable 预览

- 表清单：`GET /open-apis/bitable/v1/apps/{app_token}/tables?page_size=20`；
- 记录：`POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search?page_size=20`（body `{}`，`user_id_type=open_id`）；
- 字段值归一化（前端渲染前完成，服务端做）：
  - 文本/电话/URL → `string`；多行文本 → 数组 join `\n`；
  - 单选/多选 → `text`；人员 → `name[]`；日期 → `ms → YYYY-MM-DD`；
  - 附件 → `{name, token}`（渲染成小缩略图，走 media）；
  - 公式/查找引用 → `{type:"complex", text}` 取 `text`/`value`；
  - 空 → `-`；
- 路由：`GET /docs/bitable?token=…&table=…&limit=20` → `{tables, active, fields, rows, truncated}`；
- 权限：`bitable:app:readonly`。

### 3.9 缓存 / 限流 / 上限

| 项           | 值                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------- |
| 块树缓存     | `Map<"token                                                                              | identity | revision", {at, payload}>`，TTL 5 分钟，LRU 16 条 |
| 并发合并     | 同 key 的 in-flight Promise 复用（连点「阅读」不重复打飞书）                             |
| 块数上限     | 4000 块 / 树深 64 / 单块 children 512                                                    |
| payload 上限 | 规范化后序列化 > 4MB → 截断并置 `truncated: true`（前端显示「内容过大，仅显示前 N 块」） |
| 媒体缓存     | 20MB LRU（见 3.6）                                                                       |
| 飞书限流     | 每个路由 60 次/分钟/进程（简单令牌桶），429 → 「飞书限流，请稍后」                       |

### 3.10 协议（`/docs/read` 增量，向后兼容）

```jsonc
{
  "ok": true,
  "doc": {
    "ok": true,
    "token": "doxcn…", "type": "docx",
    "title": "内部向公开",
    "url": "https://…feishu.cn/docx/doxcn…",
    "content": "纯文本（raw_content，保留：复制兜底 / AI 工具）",
    "plain": "从块树生成的保序纯文本（表格用 \t 分列）",
    "chars": 8123, "truncated": false,
    "blocks": [ { "k": "heading1", "runs": [...], "children": [] }, … ],  // render=rich 时才有
    "stats": { "blockCount": 412, "blockTypes": { "text": 300, "table": 6 }, "elapsedMs": 320 }
  }
}
```

- 不带 `render=rich` 时行为与现在**完全一致**（AI 工具 `feishu_pro` 不受影响）；
- 前端旧版本（未更新）读到多余字段无副作用。

`TreeNode` 精简 schema（参考）

```ts
type Run = {
	t: "text" | "mention_doc" | "mention_user" | "equation" | "file" | "link";
	text: string;
	style?: { b?; i?; s?; u?; code?; color?; bg?; link? };
	url?: string;
	token?: string;
};
type Node = {
	k: string; // page|text|heading1..9|bullet|ordered|code|quote|todo|divider|table|...
	runs?: Run[]; // 叶子文本
	children?: Node[]; // 容器
	lvl?: number; // 列表层级（0 起）
	seq?: number; // 有序列表起始号
	lang?: string; // code
	done?: boolean; // todo
	table?: { rows: number; cols: number; header: boolean; merge: Array<{ r; c; rs; cs }> };
	media?: { token: string; name?: string; w?: number; h?: number; kind: "image" | "file" };
	sheet?: { token: string; rows: number; cols: number };
	bitable?: { token: string };
	callout?: { emoji?: string; bg?: number; border?: number; text?: number };
	text?: string; // 占位/equation/iframe/link_preview
	raw?: number; // unknown 的原始 block_type
};
```

## 4. 客户端渲染器 `client/doc-reader.mjs`

### 4.1 原则

1. **绝不 `innerHTML` 拼文档内容**：`el(tag, attrs, ...children)` + `document.createTextNode`，文本天然不解析标签 → XSS 面归零（`esc()` 只用于属性值场景，如 `href`、`title`）；
2. 链接只允许 `http:`/`https:`（`new URL` 校验），其余渲染成纯文本；
3. 图片只允许同源 `/plugins-api/`；
4. 渲染函数**纯函数化**：`renderNode(node) → HTMLElement`，便于单测（jsdom 或 happy-dom 已有？若无则只测服务端纯函数 + 前端快照用字符串形式）；
5. 大文档分批：`requestIdleCallback` 每帧最多 200 块，其余追加（首屏先出标题 + 前 200 块）。

### 4.2 结构

```js
export function mountDocReader(container, doc) {
	container.textContent = "";
	container.classList.add("fp-doc-render"); // 关掉父级 pre-wrap
	if (!doc?.ok || !doc.blocks?.length) {
		// 降级：纯文本（老行为）
		container.textContent = doc?.content || doc?.error || "（没有内容）";
		return;
	}
	const frag = document.createDocumentFragment();
	for (const node of doc.blocks) frag.appendChild(renderNode(node, { doc }));
	container.appendChild(frag);
	if (doc.truncated) container.appendChild(hint("内容过大，已截断显示"));
}
```

### 4.3 交互

- **图片**：`loading="lazy"`、`onerror` → 占位卡（含「在飞书中打开」）；点击 → 轻量 lightbox（`position:fixed` + `Esc` 关闭，无依赖）；
- **sheet / bitable 块**：首屏只渲染「卡片 + 尺寸」；点击卡片才 `fetch` `/docs/sheet`，渲染只读网格（横向滚动、首行/首列粘性 `position:sticky`）；
- **折叠块（`grid`/`callout` 内的 `fold`）**：暂不做；
- **复制**：`doc.plain || doc.content`（保持现有行为语义）；「引用」仍用 `【飞书文档】标题 URL`；
- **reader 宽度**：由 44% 提到 `48%` 并支持左边界拖拽（`min 320px / max 70%`），表格才有横向空间。

### 4.4 样式（全部走现有主题 token）

```css
.fp-doc-render {
	white-space: normal;
	font-size: 13px;
	line-height: 1.7;
	color: var(--text);
}
.fp-doc-render h1,
h2,
h3 {
	margin: 14px 0 8px;
	line-height: 1.35;
}
.fp-doc-render h1 {
	font-size: 20px;
}
h2 {
	font-size: 17px;
}
h3 {
	font-size: 15px;
}
.fp-doc-render h4,
h5,
h6 {
	font-size: 13px;
	color: var(--text-dim);
}
.fp-doc-render p {
	margin: 6px 0;
}
.fp-doc-render ul,
ol {
	margin: 6px 0;
	padding-left: 20px;
}
.fp-doc-render blockquote {
	margin: 8px 0;
	padding: 2px 0 2px 10px;
	border-left: 3px solid var(--border);
	color: var(--text-dim);
}
.fp-doc-render pre {
	margin: 8px 0;
	padding: 8px 10px;
	border-radius: 6px;
	background: var(--bg-elev2);
	border: 1px solid var(--border);
	overflow: auto;
}
.fp-doc-render code {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
}
.fp-doc-render .fp-dc-tablewrap {
	max-width: 100%;
	overflow: auto;
	margin: 8px 0;
}
.fp-doc-render table {
	border-collapse: collapse;
	font-size: 12px;
}
.fp-doc-render td,
th {
	border: 1px solid var(--border);
	padding: 4px 8px;
	min-width: 6em;
	max-width: 28em;
	overflow-wrap: anywhere;
	vertical-align: top;
}
.fp-doc-render th {
	background: var(--bg-elev2);
	font-weight: 600;
}
.fp-doc-render img {
	max-width: 100%;
	height: auto;
	border-radius: 4px;
	display: block;
	margin: 8px 0;
}
.fp-doc-render .fp-dc-placeholder {
	padding: 8px 10px;
	border: 1px dashed var(--border);
	border-radius: 6px;
	color: var(--text-dim);
	font-size: 12px;
}
```

**红线对齐**

- 不使用 `--accent` 实底配白字（若做「加载更多」按钮，文字色用 `var(--accent-contrast)`）；
- 长文本/URL 三件套：`overflow-wrap:anywhere` + `word-break:break-word` + `min-width:0`（表格单元格、代码块、链接卡都加）；
- 深色模式：所有颜色走 token，不写死色值（现有插件里内联色值已经在用 `var(--red,#f87171)` 的兜底写法，渲染器统一改为类名 + token）。

## 5. 降级矩阵

| 场景                       | 行为                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `docx` + 有权限            | 富文本完整渲染                                                                        |
| `docx` + 无权限（1061004） | 单块占位 + 「在飞书中打开」+ needUser 提示（沿用现文案）                              |
| `doc`（旧版）/ `file`      | 无块接口 → 保持「该类型暂不支持预览」，给「打开」按钮                                 |
| `sheet` 独立文档           | 新增只读网格（`/docs/sheet`），失败回落提示                                           |
| `bitable` 独立文档         | 新增表格预览（`/docs/bitable`）                                                       |
| 未登录个人账号（tenant）   | 块接口可用但只读到应用可见范围；结果为空时明确提示「把应用加为协作者 / 登录个人账号」 |
| 块接口整体失败             | 回落 `raw_content` 纯文本（**保证不白屏**）                                           |
| 单块渲染抛错               | `try/catch` 包单块 → 占位「该块无法显示」，不影响其它块                               |

> 关键设计：**富文本失败必须回落纯文本**，不能让用户比现在更糟。

## 6. 测试清单（`npm test` 里的 vitest）

| 文件                                        | 用例                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/feishu-pro-doc-blocks.test.ts`  | ①扁平 items → 树（含孤儿块、环、深 100 递进保护）②`block_type` 数字与键名双判 ③相邻同格式 text 合并 ④未知块保留文字 ⑤表格 `cells` 新接口 / `children` 旧接口 / `table_row` 更旧接口三种建表 + `merge_info` 跨度 ⑥`truncated` 触发 |
| `tests/unit/feishu-pro-doc-media.test.ts`   | token 白名单、Content-Type 白名单、超限 413、LRU 淘汰、上游 403 → 404                                                                                                                                                             |
| `tests/unit/feishu-pro-doc-sheet.test.ts`   | 范围拼装（`A1:L60`）、二维值归一化（富文本段/链接/数字）、truncated                                                                                                                                                               |
| `tests/unit/feishu-pro-doc-bitable.test.ts` | 字段类型归一化（人员/日期/附件/公式）、空值                                                                                                                                                                                       |
| `tests/unit/feishu-pro-doc-render.test.ts`  | 纯函数 `renderToString(node)`（渲染器内部同时维护一个字符串序列化用于断言）：表格 rowspan 输出、链接协议过滤、未知块占位                                                                                                          |
| 现有 `feishu-pro-core.test.ts`              | 追加：`/docs/read` 不带 `render=rich` 时 payload 与旧版等价；带时 `doc.blocks` 存在且 `doc.content` 仍在                                                                                                                          |

> 新增可开关工具/路由不涉及 `tool-registration` 红线；`manifest.json` 版本必须 bump（`plugin-version-bump-guard`）。

## 7. 性能预算

| 指标                        | 目标                                |
| --------------------------- | ----------------------------------- |
| 400 块文档：块拉取 + 规范化 | < 250ms（不含网络往返）             |
| 2000 块文档（800KB）        | 规范化 < 600ms，payload < 1.2MB     |
| 首屏渲染                    | < 400ms（首 200 块）                |
| 滚动                        | 60fps（DOM 节点 < 6000）            |
| 图片                        | 懒加载，单张 < 25MB，视口内并发 ≤ 6 |

## 8. 版本 / 同步 / 文档登记（本项目硬门禁）

1. `manifest.json`：`0.8.6 → 0.9.0`（同时更新 `description`：加「富文本阅读（表格/图片/标题层级）」）；
2. 宿主 `syncBuiltinPlugins` 按版本自动同步到 `~/.pi-web/plugins/feishu-pro`，验证 `manifest.json` 版本已变；
3. 更新 `plugins/feishu-pro/README.md` 能力清单 + 本文件（`docs/`）；
4. 若目录能力有变化，登记到 `AGENTS.md` §1 表格（当前 feishu-pro 未单独列行，可并入「插件体系」）；
5. 提交前三连验：`npx prettier --write <改动>` → `npm run typecheck` → `npx vitest run tests/unit/feishu-pro-*.test.ts`；
6. `AGENTS.md` 红线：**插件文件改完必须 `/plugins:reload`（或刷新页面会 404 提示）**，客户端模块是动态 `import()`，改动后需硬刷。

## 9. 分阶段落地（建议 4 个 PR）

| 阶段 | 内容                                                                                                               | 可独立验收           |
| ---- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| P1   | `doc-blocks.mjs` + `/docs/read?render=rich` + `client/doc-reader.mjs`（文字/标题/列表/引用/代码/分割线/表格/待办） | 截图里那张表正确显示 |
| P2   | 媒体代理 + 图片内嵌 + 附件卡 + lightbox                                                                            | 图片可见             |
| P3   | sheet 预览（docx 内嵌 + 独立 sheet 文档）                                                                          | 表格块可点开         |
| P4   | bitable 预览 + 剩余占位块（mindnote/board/okr/jira/agenda/iframe 等）+ 语言映射表 + 分批渲染                       | 全量块覆盖           |

## 10. 风险与已知坑

1. **枚举漂移**：`block_type` 数字官方会新增，必须「数字 + 键名 + unknown 占位」三层兜底，且新增类型不能导致整篇渲染失败（单块 try/catch）；
2. **`raw_content` 与块树不一致**：飞书两接口取值时刻可能差一拍（`document_revision_id=-1` 表示最新），以块树为准，`plain` 由块树生成以免复制内容与显示不一致；
3. **表格 `cells` 顺序假设**：row-major 是官方口径，但旧文档可能整块无 `cells` 只有 `children`，必须三路兼容（3.5）；
4. **图片权限**：`drive:drive:readonly` 未开通时图片一律 403 → 必须占位而非破图（`onerror`）；
5. **自建网关 baseUrl**：`openapi.mjs` 已支持自定义 baseUrl，媒体下载**必须复用同一 `client`**（同一 token/身份/超时），否则绕过网关；
6. **SVG / HTML 附件**：不得内联渲染，强制 `attachment` + `nosniff`；
7. **payload 体积**：主站 Express 默认无响应上限，但浏览器内存/JSON.parse 有成本 —— 4MB 截断；
8. **不要把飞书 token 写进前端 localStorage**（媒体 URL 里的 token 是文档内媒体 token，非凭据，但仍应只放相对路径）；
9. **不要改 `entry.mjs` 的巨型模板字符串结构**：渲染器独立模块 + `mountDocReader()`，避免与并行任务在同一段模板里冲突；
10. **并行任务共存**：`client/entry.mjs`、`lib/docs.mjs`、`index.mjs`、`plugins/catalog.json` 是与另一 run 的高冲突文件 —— 落地前先确认归属，或按 P1-P4 拆分提交。

## 11. 附：宿主机制的对齐

- 路由挂载在 `host.route()`（`/plugins-api/feishu-pro/*`），主站 `PI_WEB_TOKEN` 鉴权自动覆盖，二进制响应直接在 handler 里 `res.setHeader` + `res.end(Buffer)`（`server/plugins.ts:2269` 只兜错误，不限制 body 类型）；
- 前端相对路径用 `apiBase("feishu-pro")`（已定义 `BASE`），不要硬编码 `/plugins-api/...`；
- 插件 `permissions` 已含 `http`，无需新增；
- 客户端导入共享库走 `@pi-web-ui/plugin-sdk/client`（宿主 `/plugins-shared/*` + import map），新模块 `client/doc-reader.mjs` 从 `./entry.mjs` 相对导入即可（**不要**放 `client/sdk/` 外）。
