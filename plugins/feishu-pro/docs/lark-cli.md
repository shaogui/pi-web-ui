# feishu-pro × lark-cli 重构（0.9.0）

> 目标：**插件不再维护自己的飞书身份体系**，凭证与接口全部交给官方 `lark-cli`；
> 文档阅读改用 `docs +fetch --doc-format markdown`，从根上解决「正文格式塌陷」。

## 1. 为什么要换

| 维度     | 重构前（0.8.x）                                                                            | 重构后（0.9.x）                                           |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 应用凭证 | 插件自建：设备码注册 + `host.secrets` 存 Secret + 连接状态机（`lib/app-registration.mjs`） | `lark-cli config init --new`（官方设备码）                |
| 个人授权 | 插件自建 OAuth：本地回调服务 + 2h token + 单飞刷新（`lib/oauth.mjs` / `lib/tokens.mjs`）   | `lark-cli auth login --recommend --no-wait`（官方设备码） |
| 存储     | AES-256-GCM（宿主 secrets）                                                                | OS keychain（CLI 自管）                                   |
| 文档正文 | `docx/raw_content` → **拍平纯文本**（表格塌成多行、标题层级消失）                          | `docs +fetch --doc-format markdown` → 真结构              |
| 接口覆盖 | 写在插件里的十几个接口                                                                     | 200+ 快捷命令 / 2500+ API（`lark-cli api` 兜底）          |

## 2. 通道与执行

### 2.1 二进制发现（优先级从高到低）

1. 环境变量 `PI_WEB_LARK_CLI_BIN` / `LARK_CLI_BIN`
2. 插件自带依赖 `plugins/feishu-pro/node_modules/@larksuite/cli/bin/lark-cli`
3. `PATH` 里的 `lark-cli`
4. **Trae 内置**：`~/.trae-cn/plugins/trae-remote-official/lark/<version>/bin/lark-cli`（版本降序）
5. **npx 缓存**：`~/.npm/_npx/*/node_modules/@larksuite/cli/bin/lark-cli`

找到第一个可执行的即停；探测方式固定为 `<bin> --version`（4s 超时）。

> Trae 排在 npx 之前是刻意的：Trae 那份**可能已经登录过**，复用它 = 零配置可用；
> 版本略旧（实测 1.0.94）也支持 `docs +fetch --doc-format markdown`。

### 2.2 为什么不用 `host.bash`

`server/plugins.ts` 的 `host.bash` 有三个硬限制，会让 lark-cli 无法正常工作：

1. 命令按**空白字符切分**（`split(/\s+/)`）—— `--doc "https://…?a=b"`、`--params '{"page_size":50}'` 会被切碎；
2. `cwd` 必须落在工作区内，CLI 配置想固定在工作区外就做不到；
3. 输出截断到 256KB，长文档 markdown 直接被砍。

因此插件内直接用 `node:child_process`（**既有惯例**：`desktop-use` / `imessage` / `webmail` / `vscode-editor` 都这么干），
并自加约束：只执行探测到的绝对路径、参数数组传递（不经 shell）、8MB 缓冲、30s 默认 / 300s 上限超时。

### 2.3 输出契约

```
成功：stdout  { "ok": true, "identity": "user", "data": {...}, "meta": {...} }   退出码 0
失败：stderr  { "ok": false, "error": { "type","subtype","code","message","hint" } }  退出码非 0
```

**不要用 `code == 0` 判断**（成功信封没有 `code` 字段）。非 JSON 输出（help 文本）在退出码 0 时按纯文本返回。

`type/subtype` → 插件动作映射：

| CLI 错误                       | 插件动作                                      |
| ------------------------------ | --------------------------------------------- |
| `config / not_configured`      | `action: "config"` → 引导 `config init --new` |
| `auth / unauthorized`          | `action: "login"` → 引导设备码登录            |
| 其它（api/permission/network） | 原样透出 message + hint                       |

## 3. 能力映射

| 插件能力         | CLI 命令                                                          | 适配器                               |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------ |
| 读文档正文       | `docs +fetch --doc <token> --doc-format markdown --detail simple` | `lib/cli-docs.mjs` `fetchDoc`        |
| 云文档搜索       | `docs +search --query <q> --page-size N`                          | `searchDocs`                         |
| 我的空间         | `drive files list --params '{...}'`                               | `listDriveFiles`                     |
| 知识库列表       | `wiki +space-list --page-size 50`                                 | `listWikiSpaces`                     |
| 知识库节点       | `wiki +node-list --space-id <id>`                                 | `listWikiNodes`                      |
| 状态             | `--version` / `whoami` / `auth list --json`                       | `lib/cli-status.mjs` `readCliStatus` |
| 任意 API（兜底） | `api GET /open-apis/...` / `--jq` / `--page-all`                  | 直接 `cliRunner.run`                 |

## 4. 状态机

```
未安装 ──安装命令──▶ 已安装未配置 ──config init──▶ 未登录 ──auth login──▶ 就绪
   ▲                      │                          │                    │
   └──── 重新检测 ◀───────┴──────────────────────────┴────────────────────┘
```

- `GET /cli/status` → `{ cli: { installed, configured, loggedIn, action, version, source, bin, users, candidates } }`
- `POST /cli/refresh` → 清缓存后重新探测
- `POST /cli/setup { step: "config" | "login" }` → 后台启动 CLI，抓验证链接立刻回前端
- `GET /cli/setup` → 当前 setup 会话（url / userCode）

`config init` 会阻塞等浏览器：服务端用 `spawn` 边跑边抓链接（20s 没抓到就提示去终端手动执行），
进程继续在后台等，结束后自动失效状态缓存。`auth login --no-wait --json` 是立即返回的，直接取 URL + 设备码。

## 5. 文档渲染

```
lark-cli docs +fetch（markdown）
        │
        ▼
client/doc-reader.mjs
  markdownToNodes()   → 中间节点（heading/code/table/list/todo/quote/hr）
  renderDocNodes()    → vnode → DOM（createElement + createTextNode，零 innerHTML）
```

- 表格按 `| a | b |` 解析成真 `<table>`（表头 + 单元格，单元格内纯文本**不再包 `<p>`**）；
- 代码块保留语言角标；待办有勾选态；引用/分割线/有序无序列表都走同一套样式；
- 图片：飞书图片需要鉴权，`<img>` 必然 403 → 渲染成 `📷 alt` 占位（带链接时可在新窗口打开）；
- 链接双重白名单（服务端 `safeLink` + 前端 `safeHref`），只放行 http(s)；
- 大文档分帧插入（每帧 200 块），不阻塞输入。

## 6. 迁移进度

| 域                                              | 状态                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 底座（发现 / 执行 / 信封 / 错误 / 状态机）  | ✅ 0.9.0                                                                                                                                  |
| 云文档读 / 搜 / 我的空间 / 知识库               | ✅ 0.9.0（全部 lark-cli，无回落）                                                                                                         |
| 文档富文本渲染（markdown）                      | ✅ 0.9.0                                                                                                                                  |
| 设置页 CLI 卡片（状态 + 安装/配置/登录）        | ✅ 0.9.0                                                                                                                                  |
| **通讯录**（搜人 / 批量取人 / 部门 / 部门成员） | ✅ 0.9.1（`contact +search-user` / `+get-user` / `api contact/v3/*`）                                                                     |
| **会话列表（含 p2p 单聊）**                     | ✅ 0.9.1（`im +chat-list --types p2p,group`，旧实现靠机器人列表 + 消息反推）                                                              |
| **消息读取 / 发送者姓名补全**                   | ✅ 0.9.1（`im +chat-messages-list --no-reactions`）                                                                                       |
| **发文本（我 / 机器人）**                       | ✅ 0.9.1（`im +messages-send`；写操作**不回落**，避免重复发送）                                                                           |
| **open_id → 私聊 chat_id**                      | ✅ 0.9.1（`contact +search-user --user-ids` 直接回 `p2p_chat_id`，0 副作用）                                                              |
| 私聊提醒（增量轮询）                            | ✅ 0.9.3 `transport: cli\|openapi`；0.10.27 起只剩 CLI（回落通道已删）；可行性见 [`dm-watch-lark-cli-eval.md`](dm-watch-lark-cli-eval.md) |
| AI 工具 `feishu_pro`                            | ✅ 0.9.2（九个 action 全部 CLI 优先，返回体带 `via` 标记）                                                                                |
| CLI-only 模式（开关 + 不回落 + 隐藏旧卡片）     | ✅ 0.9.4（`PI_WEB_LARK_CLI_ONLY=1` 可强制；默认关闭）                                                                                     |
| **AI 待办（`待办` 页签）**                      | ✅ 0.11.0（本地库为事实源；飞书任务走 `api` 兜底合并，写回失败如实回报；见 [`todo-ai.md`](todo-ai.md)）                                   |
| **删除自建凭证链（~1450 行）**                  | ✅ 0.10.0 已删：`oauth` / `tokens` / `app-registration` / `app-credentials` / `openapi` / `app-info` / `probe` + 前端三张旧卡片           |

## 6.1 AI 工具 `feishu_pro`

- 九个 action（status / contacts / departments / doc_search / doc_list / doc_read / wikis / wiki_nodes / probe）
  一律**只走 lark-cli**，返回体带 `via: "lark-cli"`，模型能直观看数据走的哪条路。
- `doc_read` 给模型的正文**只有一份**：markdown（结构化）优先，12k 字符截断，附带 `hover/hide` 的
  `chars/truncated/format` —— 绝不会把 markdown + plain + content 三份塞进上下文。
- `status` 的 `larkCli` 块（installed / configured / loggedIn / version / users / action）就是「下一步该做什么」。
- `probe` 也走 CLI（`auth list` + 一次轻量调用），额外带上 CLI 三态，方便模型判断该建议装 CLI 还是补 scope。

## 6.2 只有一条通道（CLI-only 的历史与收尾）

| 阶段    | 形态                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| 0.9.4   | `cliOnly` 开关（设置页勾选 / `PI_WEB_LARK_CLI_ONLY=1`）：打开后不回落旧 OpenAPI       |
| 0.10.1  | `lib/openapi.mjs` 删除 → 任何情况下都没有回落通道，`cliOnly` 恒为真                   |
| 0.10.27 | `cliOnly` 配置字段、`PI_WEB_LARK_CLI_ONLY`、`state.cliOnly`、设置页勾选框**全部删除** |

现在的不变量（`feishu-pro-cli-only.test.ts` 锁住）：

| 面       | 行为                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 路由     | `viaCli()` 在 CLI 未就绪时抛 `cli_not_ready` 错误，载荷带 `cli.action`（install / config / login）与人话 `hint`         |
| `/state` | 只下发 `cli`（三态）与 `user`（当前 CLI 登录人），没有任何旧凭证链空壳字段                                              |
| 私聊提醒 | `dm-watch` 只有 CLI 一条通道，不可用时 `skipped: "no-channel"` 且原因写进 `lastError`（`status().channel.ready=false`） |
| 排障     | `PI_WEB_LARK_CLI_DISABLE=1` 只是「模拟没装 CLI」，打开后所有能力都会报不可用                                            |

## 6.3 0.10.0：自建凭证链已删除

删掉的文件（共 ~1450 行）与替代：

| 删除                             | 原职责                               | 现在由谁负责                                    |
| -------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `lib/oauth.mjs` (235)            | 个人 OAuth + 本地回调服务            | `lark-cli auth login`（设备码）                 |
| `lib/tokens.mjs` (379)           | tenant/user token 缓存 + 单飞续期    | CLI 自己（OS keychain）                         |
| `lib/app-registration.mjs` (178) | 设备码自动建应用                     | `lark-cli config init --new`                    |
| `lib/app-credentials.mjs` (109)  | 凭证来源解析（env / provision.json） | CLI 的 profile / config                         |
| `lib/openapi.mjs` (215)          | HTTP 传输 + 错误翻译                 | 已删（改由 `lib/cli-bridge.mjs` 解析 CLI 信封） |
| `lib/app-info.mjs` (151)         | 权限/安全页 URL + 登录预检           | CLI 的错误 hint                                 |
| `lib/probe.mjs` (179)            | 权限探针                             | `feishu_pro` 工具的 `probe`（CLI 健康检查）     |

index.mjs 同步删掉的路由：`/config`、`/test`、`/probe`、`/connect/start`、`/login/check|adopt`、`/oauth/start|finish`、`/chats/discover`、`/chat/probe-p2p`（34 → 24 条；0.10.26 又加回私聊自动问答与 `im_chats` 工具，现 31 条）。
前端删掉的 UI：设置页「1 连接应用」「2 登录账号」「3 部署配置」三块 + 连接/授权两个轮询器。

过渡期的 `/state` 空壳字段（`app` / `appConfigured` / `connect` / `oauth` / `presets` / `cliOnly`）
已于 0.10.27 删除，现在 `/state` 只有 `cli` 与 `user` 两个面。

### 6.3.1 死代码清理（0.10.1）

`lib/chats.mjs` / `lib/contacts.mjs` / `lib/docs.mjs` 里的旧 HTTP 实现也已删除：

| 文件               | 行数                     | 删掉的                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/chats.mjs`    | 1122 → **533** → **331** | `fetchChats` / `fetchChatMessages` / `fetchUserNames` / `sendTextMessage` / `sendToOpenId` / `probeP2pChatId` / `resolveP2pChatId` / `fetchChatInfo` / `fetchLatestMessage` / `collectAllChats` / `deepDiscoverChats` / `discoverViaMessageSearch` / `harvestChatsFromSearch` / `runBatched` / `explainReadFailure` + 8 个只服务它们的常量 |
| `lib/contacts.mjs` | 190 → **47**             | `searchUsers` / `listDepartmentUsers(Safe)` / `batchUsers` / `listDepartments` / `getUserInfo` + 3 个 40004 兜底常量                                                                                                                                                                                                                       |
| `lib/docs.mjs`     | 314 → **94**             | `listWikiSpaces` / `listWikiNodes` / `listDriveFiles` / `searchDocs` / `enrichWithMetas` / `getDocMeta` / `readDocContent` / `metasDocType`                                                                                                                                                                                                |

三个文件现在只剩**纯函数与常量**（归一化、分桶、排序、分类、请求体构造），
测试 `feishu-pro-chats.test.ts` 也从 ~1020 行精简到 322 行（只测这些纯函数）。

### 6.3.2 OpenAPI 残留清理（0.10.27）

凭证链删完之后，下面这些「以为自己还在用 OpenAPI」的壳还活着 —— 全部不可达，一并删除：

| 位置                                         | 删掉的                                                                                                                                                                                                                                                                                                                                    | 为什么不可达                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `lib/doc-blocks.mjs`（**整文件 899 行**）    | `fetchDocBlocks()` 直连 `/open-apis/docx/v1/*/blocks`、`readDocTree()`、blocks→Node 归一化                                                                                                                                                                                                                                                | 服务端零引用；正文早已改 `docs +fetch` → markdown                                                   |
| `lib/dm-watch.mjs`                           | `client` 注入参数、`resolveChannel()` 的 openapi 分支、`effectiveTransportKind()`、`CLI_FAIL_LIMIT` / `failStreak` / `transport.degraded`、配置里的 `transport`、`oldestCreateMs()`                                                                                                                                                       | `index.mjs` 从不传 `client` → 永远命中「没有 OpenAPI 客户端」                                       |
| `lib/config.mjs`                             | `openApiBase()` / `accountsBase()` / `PRESETS.*.accountsBase` / `isLoopbackHost()` / `usesLoopbackCallback()` / `maskAppId()` / `isAppConfigured()` / `resolveRedirectUri()` / `CALLBACK_PATH`；`DEFAULT_CONFIG` 与 `normalizeConfig` 的 `appId` / `baseUrl` / `callbackHost` / `callbackPort` / `redirectUri` / `callbackPath` / `scope` | 无调用点（`config.*` 除 `docHost` 外一次没读）                                                      |
| `client/dm-panel.mjs`                        | 「通道」下拉的 `openapi = OpenAPI 直连` 选项 + 回落/降级文案                                                                                                                                                                                                                                                                              | 选了只会得到「没有 OpenAPI 客户端」                                                                 |
| `client/entry.mjs`（41 行）                  | `fp-redirect-*` / `fp-connect-*` / `fp-cfg-save`、`fp-cfg-test`、`fp-cfg-probe-*` / `fp-oauth-*` 分支                                                                                                                                                                                                                                     | 回调的函数（`saveConfig` / `runProbe` / `startOauth` …）根本不存在，按钮 class 也不渲染（纯死分支） |
| `tests/unit/feishu-pro-doc-blocks.test.ts`   | 整个文件（456 行）                                                                                                                                                                                                                                                                                                                        | 测的就是已删模块                                                                                    |
| `tests/unit/feishu-pro-dm-transport.test.ts` | 整个文件（329 行）                                                                                                                                                                                                                                                                                                                        | 测的就是已删的双通道/熔断                                                                           |

`dm-watch` 的运行态字段：`status().transport{configured,effective,degraded,failStreak}`
→ `status().channel{cli,ready}`（只区分「CLI 注入没注入 / 就绪没就绪」）。

**第二批（同一版本内完成）**：`index.mjs` 的 `statePayload` 空壳字段（`app` / `appConfigured` /
`connect` / `oauth` / `presets` / `cliOnly`）、`isCliOnly()` 与 `cliOnlyError` 改名 `cliSetupError`、
`PI_WEB_LARK_CLI_DISABLE` 的「纯 OpenAPI 模式」注释、设置页 `fp-cli-only` 勾选框（改为一行状态文字）、
`config.mjs` 的 `cliOnly` / `resolveCliOnly` / `isCliOnlyForcedByEnv` / `redactConfig`、`manifest.json`
去掉未使用的 `secrets` 权限；插件版本 `0.10.26 → 0.10.27`（同时 bump 全部 `?v=`）。

### 6.3.3 第三批：`lib/chats.mjs` 的活跃度预热与旧发送助手（0.10.27）

`/chats` 改成 `lark-cli im +chat-list`（CLI 已按 `active_time` 排序）后，「逐会话拉一条消息算最后时间」
这套设计整块作废；随之无用的纯函数一并删除 —— 它们此前只剩单测在调用：

| 删除                                                                               | 原职责                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `sortChatsByActivity()` / `decorateChats()`                                        | 按最后消息时间排序、给每行挂 `lastMessageAt` / 过期标记 |
| `pickWarmupTargets()` / `activityFromMessage()` / `isStale()`                      | 挑选要预热的会话、消息行 → 活跃度条目、TTL 判定         |
| `ACTIVITY_WARM_LIMIT` / `ACTIVITY_TTL_MS` / `CHAT_PAGE_SIZE` / `MESSAGE_PAGE_SIZE` | 预热与分页常量                                          |
| `normalizeDraft()` / `buildSendPayload()` / `describeSendError()` + 两张错误码表   | 发送草稿归一化、请求体构造、错误码翻译（现全在 CLI 侧） |
| `buildOpenIdSendPayload()` / `findFirstChatNode()` / `pick()`                      | 发给 open_id 拿 chat_id、诊断样本                       |
| `normalizeUserNames()`                                                             | 批量查姓名（CLI 自己回 `sender_name`）                  |

`lib/chats.mjs` 现在 **331 行、20 个导出，全部是纯函数**（归一化 / 分类 / 合并 / `inferChatMode`），
测试 `feishu-pro-chats.test.ts` 同步删掉 8 个 describe，从 449 → 322 行。

### 6.3.4 前端死 UI（0.10.27）

| 位置                    | 删掉的                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `client/chats-view.mjs` | 「深度发现」按钮 + 30 行 handler（调 0.10.0 就删掉的 `POST /chats/discover`，点了必报错）                     |
| 同上                    | 计数行的「还有 N 个待更新 / 自动发现：个人 X 页」两个进度提示（读服务端已不再返回的 `warming` / `discovery`） |
| `index.mjs` `/chats`    | 响应里的 `warming: { pending: 0, done: 0, ttlMs: 0, warmLimit: 0 }` 占位字段                                  |

现在 `client/*.mjs` 调用的每个路由都在服务端注册表里（脚本比对差集为空）。

## 7. 已知约束

1. **单实例单身份**：CLI 的登录态是进程级/keychain 级，多人共用一台 pi-web 会串号。部署侧应保证「一台实例一个使用者」。
2. **container / 无 keychain**：CLI 可能退回本地文件存 token（官方有 `config keychain-downgrade`），插件不做额外处理，只显示登录状态。
3. **Agent 上下文限制**：`config init` 在 `OPENCLAW_HOME` / `HERMES_HOME` 存在时默认拒绝，需要 `--force-init` 或 `config bind`；插件不主动加这些 flag，失败时把 CLI 原文提示给用户。
4. **长文档**：默认截断 400k 字符；更大文档用 `--scope section|keyword`（适配器已留参数位，UI 暂未暴露）。
5. **装配**：插件**不自动安装** CLI（避免静默下载 49MB）。安装 = 用户点「复制安装命令」在终端执行。
6. **总开关**：设 `PI_WEB_LARK_CLI_DISABLE=1` 可显式关掉 CLI 通道（不探测、不起子进程）——
   0.10.27 起已无 OpenAPI 回落通道，这个开关现在只用于「模拟 CLI 缺失」排障与单测，
   打开后所有能力都按 CLI 不可用报错。

## 8. 验证

```bash
npx vitest run tests/unit/feishu-pro-cli.test.ts        # 27 例：发现/信封/错误/适配/状态机/markdown
npm run typecheck                                       # 5 个 tsconfig
```

真机探测（本机）：`Trae 1.0.94` 被发现 → `whoami` 返回 `not_configured` → 状态机给出 `action: "config"`，
设置页显示「未配置应用 + 配置应用按钮」。
