# 🗃️ vscode-editor-pro —— 多格式文件工作台

[`@plugins/vscode-editor`](../vscode-editor) 的增强版：**同一套类 VSCode 工作台骨架，
但文件不再一律「当文本打开」**。图片、PDF、音视频、字体、Markdown、CSV、JSON、
二进制各走各的原生查看器；二进制内容经 HTTP raw 路由按需分段读取（Range），
不进 base64 报文，大文件也不会把内存打爆。

## 为什么单独做一个插件

`vscode-editor` 里 `read` 只区分「文本 / binary」，binary 就退回空文档 + 一句
「二进制文件暂不支持编辑」——PNG 打开是空白，PDF 打开是空白。要在那套 SSH /
xterm / 多根树上逐个格式加渲染器，改动面太大且和远端 SFTP 通道纠缠。本插件
从零起一套**查看器优先**的工作台：本地工作区 + 懒加载文件树 + 多标签 + 查看器注册表。

两插件可并存：`vscode-editor` 继续负责 Remote-SSH 与内置终端，本插件负责
「打开文件看得见」。

## 支持的格式与查看器

| 格式                                                                     | 查看器能力                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| png / jpg / jpeg / gif / webp / avif / bmp / ico / tif / heic…           | 原生解码；滚轮（Ctrl/⌘）或按钮缩放、适应窗口、1:1、拖拽平移、透明棋盘底、尺寸/体积/mime；解码失败时给下载入口                                                                                                                                                                        |
| svg                                                                      | **图像 / 源码双模**（图像走 `<img>`，不执行脚本）                                                                                                                                                                                                                                    |
| pdf                                                                      | 浏览器内置阅读器（iframe）+ 新标签打开 / 下载；禁用内嵌 PDF 时给出提示                                                                                                                                                                                                               |
| mp4 / webm / ogv / mov / mkv / mp3 / wav / flac / m4a / aac / ogg / opus | 原生 `<video>`/`<audio>`，Range 断点续传（可拖进度条）；编码不支持时给「下载原文件」                                                                                                                                                                                                 |
| ttf / otf / woff / woff2                                                 | `@font-face` 注入 + 可编辑样张（12–64px 六级）                                                                                                                                                                                                                                       |
| md / markdown / mdx                                                      | **预览 / 源码双模**；标题、列表（含任务框）、表格、引用、围栏代码（带语言标签与复制键）、图片、链接；相对图片与相对链接按当前文件目录解析                                                                                                                                            |
| csv / tsv                                                                | 分隔符自动识别（`,` `Tab` `;` `\|`，可手切）、表头固定、行列号、数字右对齐、5000 行 × 80 列上限提示                                                                                                                                                                                  |
| json                                                                     | **折叠树 / 源码双模**：类型着色、对象/数组计数、全部展开/折叠                                                                                                                                                                                                                        |
| jsonl / ndjson                                                           | 逐行解析成小树，坏行回退原文                                                                                                                                                                                                                                                         |
| 压缩包 / 可执行 / 未知二进制                                             | **信息卡 / Hex 双模**：Hex Dump 分页（每页 8KB）、偏移跳转、ASCII 列                                                                                                                                                                                                                 |
| docx / xlsx / pptx / odt…                                                | 信息卡（提示装 `@plugins/office`）+ 下载 / 新标签打开 / 切 Hex                                                                                                                                                                                                                       |
| 其余文本                                                                 | CodeMirror 6 编辑，**≈25 种语言高亮**（js/ts/jsx/tsx/json/css/scss/sass/less/html/xml/yaml/md/py/sql/rust/go/java/c/cpp/php + legacy-modes 的 shell/dockerfile/toml/properties/powershell/ruby/lua/perl/swift/haskell/erlang/clojure/diff），行号、折叠、搜索、自动补全、Ctrl+S 保存 |

只读防护：文件 > 4MB 只回前 4MB 并标记 `truncated`，编辑器切只读、禁止写回
（避免把截断内容覆盖回磁盘）；写盘走 `tmp + rename` 原子落盘。

## 工作台交互

- **左栏两个视图**：「文件」（资源管理器）/「搜索」（内容搜索），标题栏下方切换
- **左栏文件树**：懒加载（点目录才发请求）、按文件名过滤（回车打开首个结果）、
  图标按扩展名、`.git`/`node_modules`/`dist` 等噪音目录跳过、分隔把手拖宽度、
  窄屏（≤760px）自动折叠成抽屉（☰ 开关）
- **多标签**：脏标记 ●、中键关闭、右键「关闭 / 关闭其它 / 关闭全部 / 复制路径」、
  按工作区记住上次打开的标签（`restoreTabs` 可关）
- **快捷键**：`Ctrl/⌘+P` 快速打开（模糊匹配文件名）、`Ctrl/⌘+Shift+F` 内容搜索
  （有选中文本时自动预填）、`Ctrl/⌘+S` 保存、`Ctrl/⌘+W` 关标签、
  `Ctrl/⌘+Shift+E` 聚焦文件树、`Esc` 关浮层
- **右键菜单**：打开 / 以源码打开 / 下载到电脑 / 新建文件 / 新建文件夹 / **在此目录中搜索** /
  重命名 / 删除（目录递归）/ 复制路径 / 刷新；装了宿主集成时还能直接呼出**宿主统一文件
  右键菜单**（`window.__piWebUiHost.openFileContextMenu`），继承所有其它插件的能力
- **跟随工作区**：主应用 `set_cwd` 切项目后，文件树与新标签自动切到新根
  （有未保存修改时先确认），根目录名存在状态栏
- **外部改动**：切回标签时比对 mtime，变了就重读（`autoReload`，脏标签不覆盖）
- **主题**：跟随宿主明暗主题（CodeMirror 切 oneDark / 浅色壳），颜色全走宿主令牌

## 内容搜索（grep）与批量替换

左栏「搜索」页签（`Ctrl/⌘+Shift+F`）＝ VS Code 式的**全文搜索**，服务端 `search_content` 扫盘：

- **范围**：留空 = 全工作区；填子目录（如 `src/lib`）＝**只在指定目录内搜**；填文件＝只搜该文件；
  「选中」按钮直接取文件树当前选中的目录，「当前」＝只搜当前打开的文件，
  树右键「在此目录中搜索…」同效
- **开关**：`Aa` 区分大小写、`ab` 全字匹配（CJK 也准，不走 `\b`）、`.*` 正则
- **过滤**：包含 / 排除两栏 glob（`*.ts`、`src/**`、`*.{js,ts}`，逗号分隔）
- **结果树**：按文件分组（可折叠）、每行带行号与命中高亮、点击跳转到编辑器对应行列
  （非文本查看器自动切「源码」再定位）；`↑/↓` 选、`Enter` 开
- **替换**：展开「替换」输入框（正则模式下可用 `$1`），「全部替换」前弹确认，
  替换后自动刷新无未保存修改的标签并重跑搜索
- **默认安全阈值**：单文件 ≤ 2MB、总文件数 6000、总命中 2000、单轮墙钟 9s（超出标记「已截断」）；
  跳过二进制、`node_modules`/`.git`/`dist` 等噪音目录，以及 **`.gitignore` 命中的路径**
- **替换只动 UTF-8 文本**：二进制 / 非 UTF-8 / 超限文件跳过并在结果里报数量，写盘仍是 `tmp + rename`

## 同时给宿主文件树装查看器（fileHandlers）

manifest 里声明了 `fileHandlers`（priority 90，覆盖图片 / PDF / 音视频 / 字体）。
装了本插件后，**主应用右栏文件树**里点 PNG/PDF 也走这里渲染，而不是退回文本预览；
没有声明 handler 的扩展名（如 `.csv`/`.xlsx`）仍交给 `@plugins/office` 等已有插件。

## 与「源代码管理」（git-scm）的联动

两个插件互不 `import`，联动走**页内契约**，装没装都不影响本插件任何能力：

- **别人叫我打开文件**（A）：`window.__piVproEditor = { version, open(req) → boolean }` 在 mount 时登记，
  在 unmount 时只拆自己那份；另听 `pi:vpro:open` 事件（`preventDefault()` = 受理），并认领待办槽
  `window.__piVproPending`（bundle 晚挂载的竞态；30 秒过期）。
  `req = { source, path, absPath, line?, repoRoot?, workspace? }` —— 绝对路径经 `relInWorkspace()`
  折成本插件的工作区相对路径（越界/工作区外一律拒，同步回 `false`）。命中后走现成的
  `openAt()`：文本直接定位到行，双模格式（markdown/JSON/CSV…）自动切「源码」再定位。
- **我保存后叫它刷新**（C）：`saveActive()` 成功与批量替换后回叫 `window.__piGitScm?.refresh?.()`，
  源代码管理面板立即重取 status/diff，不用等它下个轮询周期。

## 目录结构

```
vscode-editor-pro/
├── manifest.json      # 插件清单（view + fileHandlers + 声明式设置）
├── index.mjs          # 服务端：action 协议（list/open/stat/read_bytes/write/…、search_content/replace_content）+ HTTP /raw（Range）
├── src/
│   ├── main.js        # 工作台骨架（树/标签/浮层/快捷键）+ 宿主 fileHandler 导出 + 跨插件桥
│   ├── search.js      # 搜索面板：内容搜索 + 批量替换（结果分组、点击定位、键盘上下选）
│   ├── code.js        # CodeMirror 封装（≈25 种语言、明暗主题、保存键位、gotoLine 定位）
│   ├── viewers.js     # 图片/媒体/PDF/字体/Markdown/CSV/JSON/Hex/信息卡
│   ├── md.js          # 零依赖 Markdown → DOM（不拼 innerHTML，无 XSS 面）
│   ├── styles.js      # 全部 CSS（宿主主题令牌，染色底不用硬编码白字）
│   └── util.js        # esc/体积格式化/应用根与 token/WS 请求封装/绝对路径→工作区相对/图标
├── build.mjs          # esbuild 打包（产物自包含，只暴露 client/）
├── client/entry.mjs   # 构建产物（浏览器直接加载）
└── package.json       # 构建依赖（不发布）
```

## 安装 / 开发

```bash
pi-web-ui install plugins/vscode-editor-pro            # 本地目录（开发态）
pi-web-ui plugins                                      # 确认已装
npm run typecheck && npx vitest run tests/unit/vscode-editor-pro.test.ts
cp -r plugins/vscode-editor-pro ~/.pi-web/plugins/     # 开发态手拷：改完先 npm run build
```

改 `src/` 后必须 `npm install && npm run build`（产物 `client/entry.mjs` 入库），
宿主只暴露 `<plugin>/client/*` 给浏览器；**只改 src 不重新构建 = 线上跑旧代码**。

## 与 vscode-editor 的能力对照

| 能力                                   | vscode-editor | 本插件                     |
| -------------------------------------- | ------------- | -------------------------- |
| 本地文件树 / 多标签 / Ctrl+P / Ctrl+S  | ✅            | ✅                         |
| 全工作区 / 指定目录内容搜索 + 批量替换 | ❌            | ✅                         |
| Remote-SSH / 内置终端 / 上传下载       | ✅            | ❌（继续用 vscode-editor） |
| 图片 / PDF / 音视频 / 字体渲染         | ❌（空白）    | ✅                         |
| Markdown / CSV / JSON / Hex 查看器     | ❌            | ✅                         |
| 语言高亮数量                           | 8             | ≈25                        |
| 宿主文件树接管（fileHandlers）         | ❌            | ✅                         |
| 单文件读取通道                         | base64 报文   | HTTP raw + Range           |
