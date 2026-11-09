/**
 * 插件样式（注入到视图根节点内的 <style>）。
 *
 * 红线遵循：所有颜色走宿主令牌（--bg/--bg-elev/--border/--text/--accent…）；
 * 不使用 `background: var(--accent)` 实底 + 硬编码白字（强调色实底必须配
 * --accent-contrast），这里统一用 color-mix 染色底 + var(--text)。
 * 长路径/长文本按「min-width:0 + overflow-wrap:anywhere / 单行 ellipsis」处理。
 * overscroll-behavior: contain 只给独立滚动面板（侧栏树、菜单、浮层），
 * 正文与代码块不加，避免滚轮黑洞。
 */
export const CSS = `
.vpro { position: relative; display: grid; height: 100%; min-height: 420px; overflow: hidden;
  /* 侧栏宽度：默认值在这里声明，拖拽时由 JS 用 style.setProperty 覆盖 */
  --vpro-side-w: 248px;
  grid-template-columns: var(--vpro-side-w) 5px minmax(0, 1fr);
  background: var(--bg, #101016); color: var(--text, #e6e6ef); font-size: 13px;
  border-radius: inherit; }
.vpro * { box-sizing: border-box; }
.vpro-hidden { display: none !important; }
/* 宿主文件树里的查看器（fileHandlers）：只有内容区，没有侧栏/标签 */
.vpro-standalone { grid-template-columns: minmax(0, 1fr); min-height: 0; }

/* ---------------- 侧栏 ---------------- */
.vpro-side { display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  background: var(--bg-elev, #16161d); border-right: 1px solid var(--border, #333); }
.vpro-side-head { display: flex; align-items: center; gap: 2px; padding: 7px 8px 5px;
  font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-dim, #9a9ab0); }
.vpro-side-head b { flex: 1; min-width: 0; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.vpro-iconbtn { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px;
  font-size: 12px; line-height: 1.4; color: var(--text-dim, #9a9ab0); }
.vpro-iconbtn:hover { background: var(--bg-elev2, #20202b); color: var(--text, #e6e6ef); }
/* 侧栏折叠键只在窄屏可用（桌面端树常驻） */
.vpro-side-head .vpro-toggle-side { display: none; }
@media (max-width: 760px) { .vpro-side-head .vpro-toggle-side { display: block; } }
.vpro-filter { padding: 0 8px 6px; }
.vpro-filter input { width: 100%; padding: 4px 7px; font-size: 12px; border-radius: 5px;
  border: 1px solid var(--border, #333); background: var(--bg, #101016); color: var(--text, #e6e6ef); }
.vpro-filter input:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #7c5cff) 55%, transparent);
  outline-offset: -1px; }

/* 侧栏两个视图：资源管理器 / 搜索 */
.vpro-side-tabs { display: flex; gap: 2px; padding: 0 6px 5px; }
.vpro-sidtab { all: unset; cursor: pointer; flex: 1; min-width: 0; text-align: center;
  padding: 3px 4px; border-radius: 5px; font-size: 11.5px; color: var(--text-dim, #9a9ab0);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid transparent; }
.vpro-sidtab:hover { background: var(--bg-elev2, #20202b); color: var(--text, #e6e6ef); }
.vpro-sidtab.on { background: color-mix(in srgb, var(--accent, #7c5cff) 18%, transparent);
  color: var(--text, #e6e6ef); border-color: var(--border, #333); }
.vpro-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
.vpro-pane.on { display: flex; }

/* 搜索面板 */
.vpro-searchpane { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.vpro-sform { display: flex; flex-direction: column; gap: 4px; padding: 0 8px 6px; }
.vpro-srow { display: flex; align-items: center; gap: 4px; min-width: 0; }
.vpro-sinput { flex: 1; min-width: 0; padding: 4px 7px; font-size: 12px; border-radius: 5px;
  border: 1px solid var(--border, #333); background: var(--bg, #101016); color: var(--text, #e6e6ef); }
.vpro-sinput:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #7c5cff) 55%, transparent);
  outline-offset: -1px; }
.vpro-srow .vpro-tool { flex: none; }
.vpro-sflags { display: flex; align-items: center; gap: 3px; }
.vpro-flag { all: unset; cursor: pointer; padding: 1px 6px; border-radius: 4px; font-size: 11px;
  font-variant-numeric: tabular-nums; color: var(--text-dim, #9a9ab0);
  border: 1px solid var(--border, #333); }
.vpro-flag:hover { color: var(--text, #e6e6ef); background: var(--bg-elev2, #20202b); }
.vpro-flag.on { background: color-mix(in srgb, var(--accent, #7c5cff) 26%, transparent);
  color: var(--text, #e6e6ef); }
.vpro-sgap { flex: 1; }
.vpro-sstat { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 10px 5px; font-size: 11px;
  color: var(--text-faint, #818b98); overflow-wrap: anywhere; }
.vpro-sstat.error { color: var(--red, #f87171); }
.vpro-sstat .vpro-sflagtext { color: var(--amber, #fbbf24); }
.vpro-sresults { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding-bottom: 14px; scrollbar-width: thin; user-select: none; }
.vpro-sfile { display: flex; align-items: center; gap: 5px; padding: 3px 8px; cursor: pointer;
  font-size: 12px; min-width: 0; white-space: nowrap; }
.vpro-sfile:hover { background: var(--bg-elev2, #20202b); }
.vpro-sfile .vpro-caret { width: 11px; flex: none; text-align: center; font-size: 9px; opacity: .6; }
.vpro-sfile .vpro-sfile-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: none;
  max-width: 55%; }
.vpro-sfile .vpro-sfile-dir { min-width: 0; flex: 1; font-size: 10.5px; color: var(--text-faint, #818b98);
  overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.vpro-sfile .vpro-sfile-count { flex: none; font-size: 10.5px; padding: 0 5px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); color: var(--text, #e6e6ef); }
.vpro-smatch { display: flex; gap: 6px; align-items: baseline; padding: 2px 8px 2px 26px;
  cursor: pointer; font-size: 11.5px; line-height: 1.5; min-width: 0; }
.vpro-smatch:hover { background: var(--bg-elev2, #20202b); }
.vpro-smatch.active { background: color-mix(in srgb, var(--accent, #7c5cff) 20%, transparent); }
.vpro-smatch .vpro-sline { flex: none; min-width: 26px; text-align: right; font-size: 10.5px;
  color: var(--text-faint, #818b98); font-variant-numeric: tabular-nums; }
.vpro-smatch .vpro-sline-text { min-width: 0; font-family: var(--mono, ui-monospace, Menlo, monospace);
  white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.vpro-smatch mark { background: color-mix(in srgb, var(--amber, #fbbf24) 38%, transparent);
  color: inherit; border-radius: 2px; }
.vpro-tree { flex: 1; min-height: 0; overflow: auto; padding: 2px 0 14px; user-select: none;
  overscroll-behavior: contain; scrollbar-width: thin; }
.vpro-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
  line-height: 1.75; white-space: nowrap; min-width: 0; }
.vpro-row:hover { background: var(--bg-elev2, #20202b); }
.vpro-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 18%, transparent); }
.vpro-row.loading { opacity: .5; }
.vpro-row .vpro-caret { width: 11px; flex: none; text-align: center; font-size: 9px; opacity: .6; }
.vpro-row .vpro-name { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.vpro-row .vpro-size { margin-left: auto; flex: none; font-size: 10.5px; color: var(--text-faint, #818b98); }
.vpro-tree-empty { padding: 10px 12px; font-size: 12px; color: var(--text-dim, #9a9ab0);
  overflow-wrap: anywhere; }

.vpro-splitter { cursor: col-resize; background: transparent; }
.vpro-splitter:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent); }

/* ---------------- 主区 ---------------- */
.vpro-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.vpro-tabs { display: flex; align-items: stretch; overflow-x: auto; scrollbar-width: thin;
  border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
.vpro-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px 5px 11px;
  cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
  color: var(--text-dim, #9a9ab0); max-width: 220px; min-width: 0; font-size: 12.5px; }
.vpro-tab:hover { color: var(--text, #e6e6ef); }
.vpro-tab.active { background: var(--bg, #101016); color: var(--text, #e6e6ef);
  box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
.vpro-tab .vpro-tab-name { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.vpro-tab .vpro-dot { width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--amber, #fbbf24); }
.vpro-tab .vpro-close { all: unset; flex: none; cursor: pointer; padding: 0 4px; border-radius: 4px;
  font-size: 11px; opacity: .6; }
.vpro-tab .vpro-close:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
.vpro-tabs-empty { padding: 4px 10px; font-size: 11.5px; color: var(--text-faint, #818b98); }

.vpro-toolbar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; min-width: 0;
  border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); flex-wrap: wrap; }
.vpro-toolbar .vpro-crumb { min-width: 0; flex: 1; font-size: 12px; color: var(--text-dim, #9a9ab0);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.vpro-seg { display: inline-flex; border: 1px solid var(--border, #333); border-radius: 6px; overflow: hidden; }
.vpro-seg button { all: unset; cursor: pointer; padding: 2px 9px; font-size: 11.5px;
  color: var(--text-dim, #9a9ab0); }
.vpro-seg button.on { background: color-mix(in srgb, var(--accent, #7c5cff) 26%, transparent);
  color: var(--text, #e6e6ef); }
.vpro-seg button:not(:last-child) { border-right: 1px solid var(--border, #333); }
.vpro-tool { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 5px; font-size: 11.5px;
  border: 1px solid var(--border, #333); color: var(--text, #e6e6ef); background: var(--bg, #101016); }
.vpro-tool:hover { background: var(--bg-elev2, #20202b); }
.vpro-tool:disabled { opacity: .45; cursor: default; }
.vpro-btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 6px; font-size: 12px; border: 1px solid var(--border, #333);
  background: var(--bg, #101016); color: var(--text, #e6e6ef); text-decoration: none; }
.vpro-btn:hover { background: var(--bg-elev2, #20202b); }
.vpro-select, .vpro-input { padding: 3px 6px; font-size: 11.5px; border-radius: 5px;
  border: 1px solid var(--border, #333); background: var(--bg, #101016); color: var(--text, #e6e6ef); }
.vpro-input { width: 110px; }
.vpro-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px;
  color: var(--text-dim, #9a9ab0); cursor: pointer; }
.vpro-link { color: var(--link, #6ea8fe); text-decoration: none; }
.vpro-link:hover { text-decoration: underline; }

.vpro-content { position: relative; flex: 1; min-height: 0; min-width: 0; overflow: hidden;
  display: flex; flex-direction: column; background: var(--bg, #101016); }
.vpro-editor { flex: 1; min-height: 0; overflow: hidden; }
.vpro-editor .cm-editor { height: 100%; }
.vpro-editor .cm-scroller { font-size: 12.5px; line-height: 1.55; }

.vpro-status { display: flex; align-items: center; gap: 10px; padding: 3px 10px; flex-wrap: wrap;
  font-size: 11px; color: var(--text-dim, #9a9ab0); border-top: 1px solid var(--border, #333);
  background: var(--bg-elev, #16161d); }
.vpro-status .vpro-status-path { min-width: 0; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; flex: 1; }
.vpro-status .vpro-status-item { flex: none; }
.vpro-status .vpro-dirty { color: var(--amber, #fbbf24); }

.vpro-banner { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 11.5px;
  color: var(--text, #e6e6ef); background: color-mix(in srgb, var(--amber, #fbbf24) 16%, transparent);
  border-bottom: 1px solid var(--border, #333); overflow-wrap: anywhere; }

/* ---------------- 通用查看器 ---------------- */
.vpro-viewer { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column;
  overflow: auto; }
.vpro-vbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 10px;
  font-size: 11px; color: var(--text-dim, #9a9ab0); border-bottom: 1px solid var(--border, #333);
  background: var(--bg-elev, #16161d); }
.vpro-vbar-item { min-width: 0; overflow-wrap: anywhere; }
.vpro-hint { padding: 6px 12px; font-size: 11.5px; color: var(--text-faint, #818b98);
  overflow-wrap: anywhere; }
.vpro-empty { margin: auto; padding: 26px 22px; max-width: 620px; display: flex;
  flex-direction: column; gap: 10px; text-align: center; align-items: center; }
.vpro-empty-title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; max-width: 100%; }
.vpro-empty-sub { font-size: 12.5px; color: var(--text-dim, #9a9ab0); line-height: 1.6;
  overflow-wrap: anywhere; max-width: 100%; }
.vpro-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.vpro-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px;
  font-size: 12px; text-align: left; width: 100%; max-width: 520px; }
.vpro-kv span { color: var(--text-faint, #818b98); }
.vpro-kv b { font-weight: 500; overflow-wrap: anywhere; }
.vpro-wrap { overflow-wrap: anywhere; word-break: break-word; }

/* 图片 */
.vpro-image { position: relative; overflow: hidden; }
.vpro-img-viewport { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  display: block; scrollbar-width: thin; }
.vpro-img-stage { display: flex; align-items: center; justify-content: center; min-height: 100%;
  min-width: 100%; padding: 12px; }
.checker .vpro-img-stage { background-color: var(--bg-elev, #16161d);
  background-image: linear-gradient(45deg, var(--bg-elev2, #20202b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--bg-elev2, #20202b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--bg-elev2, #20202b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--bg-elev2, #20202b) 75%);
  background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0; }
.vpro-img { max-width: 100%; max-height: 100%; display: block; cursor: grab;
  box-shadow: 0 2px 16px rgba(0, 0, 0, .35); image-rendering: auto; }
.vpro-img.dragging { cursor: grabbing; }
.vpro-img-tools { position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center;
  gap: 2px; padding: 3px; border-radius: 8px; background: color-mix(in srgb, var(--bg, #101016) 88%, transparent);
  border: 1px solid var(--border, #333); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
.vpro-img-tools .vpro-tool { border: 0; background: transparent; }
.vpro-zoom { min-width: 46px; text-align: center; font-size: 11px; color: var(--text-dim, #9a9ab0);
  font-variant-numeric: tabular-nums; }
.vpro-img-err { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
  align-items: center; justify-content: center; padding: 20px; text-align: center;
  background: color-mix(in srgb, var(--bg, #101016) 92%, transparent); }

/* 音视频 */
.vpro-video, .vpro-audio { padding: 10px; gap: 10px; }
.vpro-media { width: 100%; max-height: 100%; flex: 1; min-height: 0; background: #000;
  border-radius: 8px; border: 1px solid var(--border, #333); }
.vpro-media-audio { width: 100%; max-width: 760px; margin: 8px auto; }
.vpro-media-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px;
  color: var(--text-dim, #9a9ab0); }

/* PDF */
.vpro-pdf { overflow: hidden; }
.vpro-pdf-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--bg-elev, #16161d); }

/* 字体 */
.vpro-font { padding: 10px; gap: 10px; }
.vpro-font-input { width: 100%; padding: 6px 9px; font-size: 13px; border-radius: 6px;
  border: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); color: var(--text, #e6e6ef); }
.vpro-font-rows { display: flex; flex-direction: column; gap: 8px; }
.vpro-font-row { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.vpro-font-size { flex: none; width: 44px; font-size: 10.5px; color: var(--text-faint, #818b98);
  font-variant-numeric: tabular-nums; }
.vpro-font-sample { min-width: 0; overflow-wrap: anywhere; line-height: 1.3; }

/* Markdown */
.vpro-md-body { padding: 16px 20px 26px; max-width: 900px; width: 100%; margin: 0 auto;
  overflow-wrap: anywhere; word-break: break-word; line-height: 1.68; font-size: 13.5px; }
.vpro-md-h { margin: 1.3em 0 .5em; line-height: 1.3; font-weight: 650; }
.vpro-md-body > :first-child { margin-top: 0; }
h1.vpro-md-h { font-size: 1.72em; }
h2.vpro-md-h { font-size: 1.42em; }
h3.vpro-md-h { font-size: 1.2em; }
h4.vpro-md-h, h5.vpro-md-h, h6.vpro-md-h { font-size: 1.04em; }
.vpro-md-p { margin: .62em 0; }
.vpro-md-code { font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: .9em;
  padding: .1em .34em; border-radius: 4px; background: color-mix(in srgb, var(--text, #e6e6ef) 10%, transparent); }
.vpro-md-pre { margin: .8em 0; border: 1px solid var(--border, #333); border-radius: 8px;
  overflow: hidden; background: var(--bg-elev, #16161d); }
.vpro-md-pre-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 3px 8px; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--text-faint, #818b98); border-bottom: 1px solid var(--border, #333); }
.vpro-md-pre-copy { all: unset; cursor: pointer; padding: 1px 6px; border-radius: 4px; font-size: 10.5px; }
.vpro-md-pre-copy:hover { background: var(--bg-elev2, #20202b); }
.vpro-md-pre-body { margin: 0; padding: 10px 12px; overflow: auto; font-size: 12.5px; line-height: 1.55; }
.vpro-md-pre-body code { font-family: var(--mono, ui-monospace, Menlo, monospace); }
.vpro-md-quote { margin: .7em 0; padding: .1em 0 .1em 12px; border-left: 3px solid var(--border, #333);
  color: var(--text-dim, #9a9ab0); }
.vpro-md-list { margin: .5em 0; padding-left: 1.5em; }
.vpro-md-list li { margin: .18em 0; }
.vpro-md-task { margin-right: 6px; }
.vpro-md-table { border-collapse: collapse; margin: .8em 0; font-size: 12.5px; display: block;
  overflow-x: auto; max-width: 100%; }
.vpro-md-table th, .vpro-md-table td { border: 1px solid var(--border, #333); padding: 4px 9px;
  text-align: left; }
.vpro-md-table th { background: var(--bg-elev, #16161d); font-weight: 600; }
.vpro-md-img { max-width: 100%; height: auto; border-radius: 6px; cursor: zoom-in; }
.vpro-md-link { color: var(--link, #6ea8fe); text-decoration: none; }
.vpro-md-link:hover { text-decoration: underline; }
.vpro-md-hr { border: 0; border-top: 1px solid var(--border, #333); margin: 1.2em 0; }

/* CSV */
.vpro-csv { overflow: hidden; }
.vpro-table-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px;
  border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
.vpro-table-status { font-size: 11px; color: var(--text-dim, #9a9ab0); margin-left: auto; }
.vpro-table-wrap { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  scrollbar-width: thin; }
.vpro-table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
.vpro-table th, .vpro-table td { border: 1px solid var(--border, #333); padding: 3px 8px;
  text-align: left; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.vpro-table thead th { position: sticky; top: 0; z-index: 1; background: var(--bg-elev2, #20202b);
  font-weight: 600; }
.vpro-table .vpro-th-index, .vpro-table .vpro-td-index { position: sticky; left: 0;
  background: var(--bg-elev, #16161d); color: var(--text-faint, #818b98); text-align: right;
  font-variant-numeric: tabular-nums; z-index: 1; }
.vpro-table thead .vpro-th-index { z-index: 2; }
.vpro-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.vpro-table tbody tr:hover td { background: color-mix(in srgb, var(--accent, #7c5cff) 9%, transparent); }

/* JSON */
.vpro-json-tree { padding: 10px 12px 26px; font-family: var(--mono, ui-monospace, Menlo, monospace);
  font-size: 12px; overflow-wrap: anywhere; }
.vpro-json-node { margin-left: 2px; }
.vpro-json-node > summary { cursor: pointer; list-style: none; display: inline-flex; gap: 6px;
  align-items: center; }
.vpro-json-node > summary::-webkit-details-marker { display: none; }
.vpro-json-node > summary::before { content: "▸"; font-size: 9px; opacity: .6; }
.vpro-json-node[open] > summary::before { content: "▾"; }
.vpro-json-children { margin-left: 14px; border-left: 1px solid var(--border, #333); padding-left: 10px; }
.vpro-json-row { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
.vpro-json-key { color: var(--text-dim, #9a9ab0); flex: none; }
.vpro-json-key::after { content: ":"; opacity: .5; }
.vpro-json-badge { padding: 0 6px; border-radius: 9px; font-size: 10.5px;
  background: color-mix(in srgb, var(--accent, #7c5cff) 20%, transparent); color: var(--text, #e6e6ef); }
.vpro-json-str { color: var(--green, #34d399); }
.vpro-json-num { color: var(--amber, #fbbf24); }
.vpro-json-bool { color: var(--plugin-purple, #c084fc); }
.vpro-json-null, .vpro-json-other { color: var(--text-faint, #818b98); }
.vpro-jsonl { padding: 8px 12px 24px; font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 12px; }
.vpro-jsonl-row { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px dashed var(--border, #333); }
.vpro-jsonl-idx { flex: none; width: 42px; text-align: right; color: var(--text-faint, #818b98); }
.vpro-jsonl-raw { overflow-wrap: anywhere; }

/* Hex */
.vpro-hex { overflow: hidden; }
.vpro-hex-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 20px;
  font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 12px; line-height: 1.5;
  overscroll-behavior: contain; scrollbar-width: thin; }
.vpro-hex-row { display: flex; gap: 14px; white-space: pre; }
.vpro-hex-off { color: var(--text-faint, #818b98); flex: none; }
.vpro-hex-bytes { color: var(--text, #e6e6ef); flex: none; }
.vpro-hex-ascii { color: var(--text-dim, #9a9ab0); flex: none; }

/* 快速打开 / 右键菜单 / toast（独立浮层：portal 到 body 之下仍是本视图的子节点） */
.vpro-quick { position: absolute; inset: 0; z-index: 40; display: flex; justify-content: center;
  align-items: flex-start; padding: 48px 16px 16px;
  background: color-mix(in srgb, var(--bg, #101016) 62%, transparent); }
.vpro-quick-panel { width: min(680px, 100%); max-height: 70%; display: flex; flex-direction: column;
  border-radius: 10px; border: 1px solid var(--border, #333); overflow: hidden;
  background: var(--bg-elev, #16161d); box-shadow: 0 18px 50px rgba(0, 0, 0, .45); }
.vpro-quick-panel input { border: 0; border-bottom: 1px solid var(--border, #333); padding: 10px 12px;
  font-size: 13px; background: var(--bg, #101016); color: var(--text, #e6e6ef); outline: none; }
.vpro-quick-list { overflow: auto; overscroll-behavior: contain; }
.vpro-quick-item { display: flex; align-items: center; gap: 8px; padding: 5px 12px; cursor: pointer;
  font-size: 12.5px; min-width: 0; }
.vpro-quick-item.active, .vpro-quick-item:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 18%, transparent); }
.vpro-quick-item .vpro-quick-name { flex: none; max-width: 45%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.vpro-quick-item .vpro-quick-dir { min-width: 0; font-size: 11px; color: var(--text-faint, #818b98);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }

.vpro-menu { position: fixed; z-index: 60; min-width: 168px; padding: 4px; border-radius: 8px;
  border: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
  box-shadow: 0 12px 34px rgba(0, 0, 0, .45); overscroll-behavior: contain; }
.vpro-menu-item { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 6px;
  font-size: 12.5px; cursor: pointer; color: var(--text, #e6e6ef); white-space: nowrap; }
.vpro-menu-item:hover { background: var(--bg-elev2, #20202b); }
.vpro-menu-item.danger { color: var(--red, #f87171); }
.vpro-menu-sep { height: 1px; margin: 3px 4px; background: var(--border, #333); }

.vpro-toast { position: absolute; right: 12px; bottom: 34px; z-index: 55; max-width: min(460px, 80%);
  padding: 7px 12px; border-radius: 8px; font-size: 12px; opacity: 0; transform: translateY(6px);
  transition: opacity .16s ease, transform .16s ease; pointer-events: none;
  background: var(--bg-elev2, #20202b); color: var(--text, #e6e6ef);
  border: 1px solid var(--border, #333); overflow-wrap: anywhere; }
.vpro-toast.on { opacity: 1; transform: translateY(0); }
.vpro-toast.error { border-color: color-mix(in srgb, var(--red, #f87171) 55%, transparent); }

@media (max-width: 760px) {
  .vpro { grid-template-columns: minmax(0, 1fr); }
  .vpro-side, .vpro-splitter { display: none; }
  .vpro.side-open .vpro-side { display: flex; position: absolute; z-index: 30; inset: 0 auto 0 0;
    width: min(80%, 300px); box-shadow: 0 0 0 100vmax color-mix(in srgb, #000 45%, transparent); }
  .vpro.side-open .vpro-splitter { display: none; }
}
`;
