# 🪶 feishu-pro —— 飞书通讯录 / 云文档工作台

> **与 `plugins/feishu` 完全独立**：插件 id、数据目录、`host.secrets` 命名空间、视图 tab、AI 工具名（`feishu_pro`）
> 全都不重叠，两个插件可以同时安装、同时启用。原插件继续负责群聊/消息/机器人，本插件只做"读组织与人"和"读云文档"。

## 0. 0.9.0：lark-cli 驱动（新主路径）

> 架构与迁移进度见 [`docs/lark-cli.md`](docs/lark-cli.md)。一句话：**凭证与接口交给官方 lark-cli，文档正文走 markdown 富文本渲染**。

| 项         | 说明                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 二进制     | 自动发现：`PI_WEB_LARK_CLI_BIN` → 插件依赖 → `PATH` → **Trae 内置** → npx 缓存（`lark-cli --version` 探测） |
| 凭证       | `lark-cli config init --new`（应用设备码）+ `lark-cli auth login --recommend`（个人设备码），存 OS keychain |
| 文档阅读   | `docs +fetch --doc-format markdown` → 前端 markdown 渲染器（表格/标题/列表/代码块/待办/引用）               |
| 其它云文档 | `docs +search` / `drive files list` / `wiki +space-list` / `wiki +node-list`                                |
| 通讯录     | `contact +search-user`（搜人 + 批量回填姓名）/ `+get-user` / `api contact/v3/*`（部门与成员）               |
| 会话       | `im +chat-list --types p2p,group`（**一次拿到群 + 单聊**）/ `im +chat-messages-list` / `im +messages-send`  |
| 私聊定位   | `contact +search-user --user-ids` 返回的 `p2p_chat_id`（0 副作用，不发试探消息）                            |
| AI 工具    | `feishu_pro` 十二个 action 全部 CLI 优先；`doc_read` 给模型 markdown（12k 截断），返回体带 `via` 标记       |
| 唯一通道   | 只有 lark-cli：CLI 不可用就报可执行错误（装 / 配 / 登录），**没有 OpenAPI 回落**                            |
| 排障开关   | `PI_WEB_LARK_CLI_DISABLE=1` 模拟「没装 CLI」（不探测、不起子进程）；打开后所有能力都会报 CLI 不可用         |
| 设置页     | 新增「lark-cli」卡片：未安装 → 复制安装命令；未配置 → 配置应用；未登录 → 登录账号；就绪 → 显示版本与身份    |

安装/配置三步（也可在设置页点按钮）：

```bash
npx @larksuite/cli@latest install     # 1. 装 CLI
lark-cli config init --new            # 2. 配应用（浏览器完成）
lark-cli auth login --recommend       # 3. 登录个人账号（浏览器完成）
```

## 1. 它做什么

| 能力                           | 用什么身份      | 说明                                                                                                                                                                                                            |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话列表（**页签 1**）         | 个人 → 应用兜底 | `im/v1/chats` + `im/v1/messages`；左列表右消息，可发文本、可一键加入监听（见 §10）                                                                                                                              |
| 通讯录 · 按关键词搜同事        | **个人授权**    | `search/v1/user`，可搜企业内任意同事（跨应用可见范围）                                                                                                                                                          |
| 通讯录 · 行内「发消息」        | 应用身份        | 按 `open_id` 直发（`receive_id_type=open_id`），响应里的 `chat_id` 顺手登记为单聊                                                                                                                               |
| 通讯录 · 行内「打开飞书」      | —               | applink `chat/open?openId=`，直接跳到与这个人的单聊（不依赖 chat_id）                                                                                                                                           |
| 通讯录 · 可见范围 / 按部门浏览 | 应用身份        | 受应用「通讯录数据权限范围」限制；没配好时自动回落到个人身份，再不行就给可执行说明（不报红字）                                                                                                                  |
| 云文档 · 搜索我的文档          | **个人授权**    | `suite/docs-api/search/object`，搜的是"我有权限的文档"                                                                                                                                                          |
| 云文档 · 我的空间文件          | **个人授权**    | `drive/v1/files`（应用身份没有"我的空间"这个概念）                                                                                                                                                              |
| 云文档 · 知识库目录            | 应用身份        | `wiki/v2/spaces` + 节点树，受知识库成员策略约束                                                                                                                                                                 |
| 云文档 · 正文纯文本            | 有权限的那一方  | `docx/v1/documents/:id/raw_content`（只支持 docx）                                                                                                                                                              |
| 权限探针                       | 两种身份各一组  | 一个接口一行，把 `code/msg` 原样带回来                                                                                                                                                                          |
| `@` 提及补全                   | 同上            | 输入框里 `@` →「飞书文档」/「飞书通讯录」子菜单，选中后把引用写进光标处                                                                                                                                         |
| 私聊提醒（**轮询**）           | **个人授权**    | `im/v1/messages` 增量拉取；首次只建基线不通知（飞书无「人类账号私聊」事件）                                                                                                                                     |
| AI 工具 `feishu_pro`           | 同上            | `status/contacts/departments/doc_search/doc_list/doc_read/wikis/wiki_nodes/im_chats/im_messages/im_send/probe`                                                                                                  |
| 待办（**页签 2**，0.12.0）     | 本地库 + 个人   | 本地待办库 + 飞书任务**双向**同步（新建可选同步飞书 / 编辑即 PATCH 回写）+ **后台定时自动同步与自动提取**（默认关）+ AI 逐条建议 + 一键处理；发送类动作先看草稿（见 §11、[`docs/todo-ai.md`](docs/todo-ai.md)） |
| AI 工具 `feishu_todo`          | —               | `list/add/update/advise/handle/mute/sync/config`：让 AI 自己也能读写这份待办（`add` 可带 `to_feishu`）                                                                                                          |

**明确不做**（留给原插件或干脆不做）：机器人长连接（事件订阅）、Webhook 卡片。

> **2026-11 调研纠偏**：`消息检索`、`卡片/富文本/媒体发送`、以及「**以用户本人身份发消息**」都**是公开可用的**
> （`POST /im/v1/messages` 接受 `user_access_token`，需 `im:message` + `im:message.send_as_user`）。
> 详见 [`docs/send-as-user.md`](docs/send-as-user.md)（含 Trae Work 同款「CLI + Skills」路径与 lark-mcp 路径的对比）。
> 当前实现仍只发应用身份，属于**待落地**而非产品限制。

私聊提醒走的是**轮询**而不是事件订阅 —— 原因见 §9。

## 2. 身份模型（这是唯一的"难点"）

```
应用身份 tenant_access_token   ← App ID + App Secret（可随时重取，2h）
    ├─ 通讯录可见范围 / 部门树
    ├─ 知识库目录
    └─ 群聊（本插件不用）

个人身份 user_access_token     ← OAuth 授权（2h，refresh_token 一次性轮换，30 天）
    ├─ 全员搜索
    ├─ 我的空间文件
    └─ 云文档搜索
```

- 凭证与 token 全在 lark-cli 里（`storage` / `secrets` 都不再存密钥）；
  旧实现 `lib/tokens.mjs` / `lib/openapi.mjs` / `lib/oauth.mjs` 已删除，
  清单与替代见 [`docs/lark-cli.md`](docs/lark-cli.md) §6.3。

## 3. 接入：交给 lark-cli 三步

0.10.0 起插件不再自己建应用 / 拿 token / 起 OAuth 回调服务 —— 全部交给官方 `lark-cli`，
插件只负责「发现二进制 → 跑命令 → 渲染结果」。设置页「lark-cli」卡片按三态给按钮：

| 状态   | 按钮         | 等价命令                                       |
| ------ | ------------ | ---------------------------------------------- |
| 未安装 | 复制安装命令 | `npx @larksuite/cli@latest install`            |
| 未配置 | 配置应用     | `lark-cli config init --new`（浏览器设备码）   |
| 未登录 | 登录账号     | `lark-cli auth login --domain ... --scope ...` |

- 应用身份（App ID / Secret）与个人身份（`user_access_token`）都活在 CLI 自己的 profile / keychain 里，
  插件既不落盘也不回传浏览器；
- 取数只有 CLI 一条通道，**没有 OpenAPI 回落**：CLI 不可用时接口直接给出「装 / 配 / 登录」的可执行错误；
- 私有化 / 自建网关、重定向地址等参数请在 `lark-cli` 侧配置（`lark-cli config`），插件不再持有。

> 管理员策略是隐藏的一层：有的租户禁止三方应用获取用户身份，有的把通讯录可见范围收得很窄。
> 通不通**不要猜** —— 用 `feishu_pro` 工具的 `probe` action（或 `lark-cli auth list`）直接看真实状态。

## 4. 安装

```bash
# 本地目录（开发态；改完 reload 或重跑一次）
pi-web-ui install plugins/feishu-pro

# 覆盖更新
pi-web-ui install plugins/feishu-pro --force

# 直接拷进数据目录
cp -r plugins/feishu-pro ~/.pi-web/plugins/
```

装完后顶栏出现「🪶 飞书 Pro」。

> 迭代提示：宿主 reload 只给 `index.mjs` 加 `?e=<epoch>` 缓存击穿，**`lib/*.mjs` 会被 Node ESM 缓存**。
> 改了 `lib/` 下的文件要**重启服务**，只改 `index.mjs` / `client/entry.mjs` 用插件重载即可。

## 5. AI 工具 `feishu_pro`

```
action=status          当前双身份状态（不联网）
action=contacts        query 关键词搜人（未授权时降级为可见范围过滤，返回里带 degraded:true；
                       可见范围没覆盖到根部门时带 deptScopeDenied:true + note 教你怎么补权限）
action=departments     department_id（默认 0=根）列子部门
action=doc_search      query 搜云文档（需个人授权）
action=doc_list        folder_token 列我的空间（需个人授权）
action=doc_read        token + doc_type 读正文（docx 纯文本，超 2 万字截断）
action=wikis           知识库列表
action=wiki_nodes      space_id + parent_node 列知识库节点
action=im_chats        query/chat_types/limit/page_token 列会话（带 chatId、p2p|group、是否监听、未读数）
action=im_messages     chat_id 或 open_id + limit/page_token/since 读最近消息（时间升序，自带发送者名）
action=im_send         chat_id 或 open_id + text [as=user|bot] [uuid] [dry_run] 发文本
action=probe           跑两组探针，回报每个接口的真实可用性
```

工具提示词里明确要求：**不要**把返回的手机号/邮箱直接复述给用户，读文档后要引用 `url` 而不是粘贴长正文。

### 5.1 会话读写（`im_messages` / `im_send`）—— 自动化的执行器

上面这些 action 大多是「读」。要让 AI 真正**动手**（自动问答、定时提醒、定时推送；聚合类任务交给画布/DAG，不写进插件），需要两个写/读入口，
它们与界面上的按钮**共用同一套服务端封装**（`sendChatText` / `readChatMessages`），口径不会两边漂：

| 场景               | 调用                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| 先找到会话 id      | `{action:"im_chats", query:"产品", chat_types:"group"}` → `items[].chatId`                  |
| 看某人最近说了什么 | `{action:"im_messages", open_id:"ou_…", limit:20}` → `items[]` 按时间升序，`self:true` 是我 |
| 只看新的（增量）   | 加 `since:"2026-11-06T00:00:00Z"`（也接受秒/毫秒时间戳），或 `page_token` 往回翻页          |
| 以我本人身份回一句 | `{action:"im_send", chat_id:"oc_…", text:"…", uuid:"reply-2026-11-06"}`                     |
| 以机器人身份发     | 同上 + `as:"bot"`（机器人必须在会话里，否则 CLI 报错并被翻译成可执行提示）                  |
| 上线前先看会发什么 | 同上 + `dry_run:true`（只校验 + 回执，不调用 CLI）                                          |

约定：

- **写操作只有 lark-cli 一条路，失败不回落** —— 回落等于可能发两遍。`uuid` 是幂等键，自动化重试务必复用同一个值。
- 只给 `open_id` 时先用 `contact +search-user --user-ids` 解析出**已有单聊**（0 副作用，不发试探消息），
  解析结果顺手登记进 `chats_info`；群聊只能给 `chat_id`。
- 文本上限 4000 字、单条正文进模型前截 800 字、一批消息总预算 8k 字（从最旧的开始丢）——
  这是上下文预算，不是飞书限制。
- `im_send` 默认以**登录者本人**身份发出（与界面默认一致）。工具提示词已要求「先与用户确认对象与措辞」，
  自动化调用方还应自己做白名单与每日上限 —— 插件不替业务做这些判断。

## 6. 已知限制与取舍

- **飞书没有"全量通讯录"接口**：只能搜索 / 按部门逐层遍历 / 批量查 open_id，"显示整个通讯录"在产品上做不到。
- 旧版 `doc` / 表格 / 多维表格没有纯文本接口，正文预览会明确报"不支持"，并给出「在飞书中打开」的链接。
- 头像统一用姓名首字圆形占位，不加载远端图片：宿主 CSP 未必放行外域图片，且拉头像等于把"我在看谁"泄露给 CDN。
- PII 边界：通讯录的手机号/邮箱进上下文等于发给模型供应商，默认只在详情里展示，工具返回里也只有 email。
- 使用者不需要 App ID：应用注册 / 凭据保存全在 `lark-cli`（`config init --new` 的设备码流程），插件不碰。
- 应用身份与个人身份是两层：应用身份（CLI 的 config）+ 个人身份（`auth login` 拿到的 `user_access_token`，
  约 2 小时、CLI 自己续期）。两者都不在插件里落盘。
- **时间字段**：`drive/v1/files` 给的是**秒**（`"1767510632"`），搜索/知识库接口常缺时间 ——
  `toMs()` 统一成毫秒（否则页面上显示 1970 年）；CLI 已返回创建/修改时间的地方不再额外打一次 metas。
- **身份冷启动**（踩过）：`snapshot()` 只读内存，重启后若没人刷新，插件会一直自认"未登录"。
  现在 `dm-watch` 的 `snapshot()` 由 `statePayload/cliStatus` 预热（激活时先跑一次 CLI 状态），
  界面首屏也读同一份缓存，不会出现"界面已登录、轮询却说没登录"。
- **「最近访问」跟着飞书身份，不跟着机器**：桶键 = 当前 user token 的 `open_id`；未登录时进
  `__anon__` 桶（不知道你是谁就不猜），登录后**不会**把匿名记录并进你的身份（共用机器上那等于抄别人的历史）。
  「清空」只清当前身份的桶，别人名下不受影响。v1 的扁平记录在升级时归给当前身份，不丢。
  **注意**：记录存在本实例的数据目录（`~/.pi-web/plugins/feishu-pro/storage.json`），跨设备不同步 —— 飞书侧没有
  可写的"用户偏好"接口，要跨设备就让数据目录走共享盘/同步盘。
- **「最近访问」为什么是本地记录**（2026-11 逐条实测排除）：`drive/v1/files` 无访问时间字段；
  `order_by` 只认 `EditedTime`/`CreatedTime`（`OpenedTime`/`LastOpenTime`/`ViewTime` 全 99992402）；
  `files/:token/view_records` 是"该文件的访问明细"（多为空）而非"我看过什么"；`statistics` 只有 pv/uv/点赞；
  不存在 `/recent` 类端点。所以访问时间 = 本插件在本机记的，UI 上如实标注。
- **实测边界（2026-11，企业自建应用）**：云文档搜索应用身份就能用；**知识库必须个人身份**（企业内基本是
  private 空间，tenant 读到空数组）；通讯录除了 scope 还要配「数据权限范围」（否则 40004）；
  `我的空间`/`全员搜索` 必须是个人身份。插件已按这个真实口径分级，不再一刀切要求授权。
- **「续期失败」与「未授权」仍是两件事**：续期交给 CLI（token 过期它自己刷），插件只把 CLI 的
  真实错误原样翻译；判断"要不要登录"一律看 `cli.loggedIn`，不靠猜 token 字段。
- **`40004`（no dept authority）不是崩溃，是配置缺口**：「通讯录数据权限范围」没覆盖到目标部门时
  `find_by_department` 必回 40004。插件现在的处理是：用个人身份调（`--as user`），失败就回
  **空列表 + `deptScopeDenied:true` + `note`**（界面显示"怎么修"，不把配置问题渲染成一片红字）。
  工具返回里也带同一个标记，模型能分清"没人"和"没权限"。
- 设备码 / 授权流程由 `lark-cli` 自己维护（飞书账号中心的 CLI 协议若改版，升级 CLI 即可，插件不受影响）。
- 本插件不做出站请求（不申请 `net`/`netAllowlist`）：所有 API 调用都在 `lark-cli` 子进程里，
  出站域名与私有化网关由 CLI 的 profile 决定；插件只声明 `http` 以挂自己的 `/plugins-api` 路由。

## 7. 排错

| 现象                              | 含义与动作                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 「没找到 lark-cli」               | CLI 未安装 → 在终端跑设置页「复制安装命令」给的那行，装完点「重新检测」                                 |
| `not_configured`                  | CLI 装好了但没配应用 → 点「配置应用」走官方设备码（`lark-cli config init --new`）                       |
| 「没登录个人账号」                | 云文档 / 通讯录需要个人身份 → 点「登录账号」（`lark-cli auth login`）                                   |
| `[99991672]`                      | 应用没开通该接口所需权限 → 权限管理里申请后**创建版本并发布**（发消息还需要 `im:message.send_as_user`） |
| `[99991668]`                      | App ID/Secret 不对，或应用版本没发布（在 CLI 的 profile 里改）                                          |
| `[99991679]` / 「个人授权已失效」 | user token 过期 → 重新 `lark-cli auth login`                                                            |
| `[40004]`                         | 应用没通讯录数据权限 → 开放平台「通讯录数据权限范围」加目标部门，或改用个人身份登录                     |
| `[1061004]`                       | 文档没授权给应用 → 让文档所有者把应用加为协作者，或改用个人身份登录                                     |
| 输出被截断 / 参数里带空格         | 命令一律按数组传参（见 `lib/cli-bridge.mjs` 文件头），不要手工拼 shell                                  |

> 上述错误码由 CLI 的信封原样透传，插件只做「翻译 + 下一步动作」；完整错误分类见
> `lib/cli-bridge.mjs` 的 `cliActionFor()`。

## 8. 回归测试

```bash
npx vitest run tests/unit/feishu-pro-*.test.ts
```

| 文件                                                                            | 锁什么                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `feishu-pro-core.test.ts`                                                       | 配置归一化幂等/白名单、文档链接拼装、`/state` 只给 cli + user、路由表（没有 `/config` `/oauth/*` `/probe`）                                   |
| `feishu-pro-cli.test.ts`                                                        | CLI 发现/信封/错误分类/状态机/markdown 适配                                                                                                   |
| `feishu-pro-cli-im.test.ts`                                                     | `im` 子命令的参数与解析、身份分界                                                                                                             |
| `feishu-pro-cli-only.test.ts`                                                   | CLI 不可用时的可执行错误（install/config/login）、`/state` 无空壳字段、dm-watch 报 `no-channel`                                               |
| `feishu-pro-tool-cli.test.ts`                                                   | `feishu_pro` 工具的 action 契约与 `via` 标记                                                                                                  |
| `feishu-pro-dm-watch.test.ts`                                                   | 私聊提醒七条：首轮只建基线且落在最新一页、同一分钟不漏、seen 挤出后不重复计未读、积压只报最近几页并对齐水位、自己发的不报、单会话失败只落自己 |
| `feishu-pro-dm-panel.test.ts`                                                   | 面板与 `/dm/state` · `/dm/config` · `/dm/poll` 的字段契约（jsdom 真 DOM）                                                                     |
| `feishu-pro-chats.test.ts` / `-chats-view.test.ts` / `-contact-actions.test.ts` | 会话与联系人归一化、发送身份、列表/详情渲染                                                                                                   |
| `feishu-pro-auto-reply.test.ts`                                                 | 自动问答的白名单/冷却/限频/空跑                                                                                                               |
| `feishu-pro-settings-view.test.ts`                                              | 设置页三态按钮、旧卡片确实不在 DOM、无 CLI-only 勾选框                                                                                        |
| `feishu-pro-todo.test.ts`                                                       | 待办归一幂等、来源去重、合并飞书任务不覆盖建议、动作白名单/无收件人不发/`ranAt` 存活、建议缓存与执行幂等、run 回收、提取去重                  |
| `feishu-pro-todo-view.test.ts`                                                  | 待办页签：草稿二次确认、agent 的 confirm、打勾/回车/采纳候选、同步 warning、失败不清空列表                                                    |

## 9. 私聊提醒（轮询）

需求是「有人私聊我，插件要能知道」。飞书这条路是封的，先把边界说清：

- 事件订阅 `im.message.receive_v1` **只推机器人收到的消息**，人类账号的私聊没有事件；
- 没有「我的会话列表」「我的未读数」这类个人身份接口；
- 所以唯一可行路径是：`user_access_token` 按间隔拉 `im/v1/messages` 增量（实现：`lib/dm-watch.mjs`）。

| 项       | 取值 / 行为                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 入口     | 设置页「3 · 私聊提醒」（`client/dm-panel.mjs`，独立模块）                                              |
| 路由     | `GET /dm/state` · `POST /dm/config` · `POST /dm/poll` · `POST /dm/discover` · `POST /dm/read`          |
| 间隔     | 30–900 秒（默认 60）；每轮最多 30 个会话，≈0.9 QPS                                                     |
| 会话来源 | 手填 `oc_…`（逗号/换行分隔）+ 自动发现（`im +chat-list`，取 `chat_mode=p2p`）                          |
| 取数方向 | **永远降序（`ByCreateTimeDesc` / `--order desc`），从最新往回翻**；单会话最多 3 页 × 50 条             |
| 首次轮询 | **只建基线**：降序拿到的是最新一页 → 基线落在「现在」，不通知（否则一启用就刷屏）                      |
| 积压     | 超过 3 页就当积压：只报最近 150 条，**水位直接对齐到最新**（宁可漏报旧历史，也不让提醒永远追着历史跑） |
| 水位     | 毫秒存储 `{ ms, ids }`、`start_time` 传秒；不旧于水位即算候选（`<` 才丢）                              |
| 边界去重 | `ids` = **该毫秒上已处理过的 message_id**，跟着水位一起落盘（每会话 200 条上限）                       |
| 去重     | 另加全局 `seen`（600 条、跨会话滑动窗口）与基线页 id；自己发的不报                                     |
| 失败隔离 | 单会话错误只记在 `/dm/state` 的该会话 `lastError` 上，不影响其它会话与下一轮                           |

> **0.10.21 修的两条真 bug**（症状：新消息提示与未读数对不上、「拉的不是最近一段」）：
>
> 1. 旧实现用**升序** + `start_time`（`sort_type=ByCreateTimeAsc` / `--order asc`）。升序返回的是
>    「水位之后**最旧**的一页」：积压 100 条时只报最旧的 20 条，每轮前进 20 条，提醒与未读数永远滞后；
>    首次建基线更糟 —— 无 `start_time` 的升序返回的是**会话历史最旧一页**（实测 2025-08-08 的开群消息），
>    于是基线被钉在开聊那天，之后把整段历史当「新消息」一条条弹出来。
> 2. lark-cli 的 `create_time` 只到**分钟**（`"2026-11-06 23:51"`），旧判定是严格 `>`，
>    与水位同一分钟到达的消息时间戳相等 → 永久漏报（未读数偏少）。现在基线会把那一页的 id 写进 `seen`，
>    判定改成「不旧于水位」。
>
> **0.10.22 补的第三刀**（症状：会话明明打开过，过一会儿自动同步又变成未读）：
> 0.10.21 把边界去重交给了**全局** `seen`（600 条、跨会话滑动窗口）。忙群几十分钟就能把安静会话的
> 边界 id 挤出去，之后「与水位同一毫秒」的那条消息每轮都被当成新消息重新上报 → 已读又被标未读、
> 提示重复弹。现在水位是 `{ ms, ids }`：**边界去重按会话、跟水位一起落盘**，
> 全局 `seen` 只当第二道防线（重启 / 老数据迁移用）。实测：清空 `seen` 再轮询，边界消息不再复现。

**已实测（2026-11，个人身份，企业自建应用）**：`im/v1/chats` 返回 **100 个群、0 个单聊** ——
即使用 `user_access_token` 也**拿不到 p2p 会话**。所以「有人私聊我」这条路只能手填 `chat_id`
（或让机器人参与该会话），面板/页签会直接这样提示，不再让人以为是权限没开够。

## 9.1 私聊自动问答（可选，默认关）

把 §9 的轮询接上 agent 就是完整闭环：**新消息 → 跑一轮 agent → 以「我 / 机器人」身份回包**。
实现：`lib/auto-reply.mjs`（纯逻辑 + 引擎）· 接线 `index.mjs`（`onNew` / `onRunEvent`）· UI `client/auto-reply-panel.mjs`。

| 项       | 取值 / 行为                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 入口     | 设置页「私聊自动问答」卡片（紧跟在私聊提醒后面）                                                                |
| 路由     | `GET /auto/state` · `POST /auto/config` · `POST /auto/preview`                                                  |
| 权限     | 新增 `chat` 能力（`host.chat` 无头投递）；能力清单变更会弹一次确认提示                                          |
| 触发     | `dm-watch` 的 `onNew` → 引擎；**每轮只回每个会话的最后一条**（连发 3 条回 3 次是刷屏）                          |
| 安全闸   | 默认关闭 · **白名单空 = 一条都不回** · 空跑模式 · 每会话冷却（默认 20s）· 每小时上限（默认 20）· 签名           |
| 认领回包 | `host.chat` 回执的 `runId`（过户/改名不变）；回执迟到时先到的 `message`/`run_end` 进 `early` 缓冲，回执到手补齐 |
| 会话记忆 | 按 chatId 记住 `conversationId`，下一条消息复用（多轮连续）；被宿主回收时回落新会话，不丢消息                   |
| 幂等     | `uuid = auto-<runId>[-序号]`；回包失败**不重试**（与发送同一铁律：宁可少发，不可重发）                          |
| 不回答的 | 自己发的 · 机器人发的 · 系统消息 · 无正文且无附件 · 超过 `staleSec`（默认 300s）的旧消息 · 冷却/限频命中        |
| 回环     | 以 user 身份发 → dm-watch 用 `selfOpenId` 滤掉；以 bot 身份发 → `senderType === "app"` 滤掉。两侧都堵死         |
| 可观测   | 顶栏「后台任务」条（在跑几轮 / 本小时回复数 / 最近错误）+ 面板里的最近 20 条回复记录                            |

**上线顺序建议**：先开轮询 + 白名单 + **空跑**跑一天 → 看面板里「会发什么」是否可接受 → 再关空跑、加上签名。
`POST /auto/preview` 只拉最近 5 条消息拼提示词，不建运行、不发消息，可随时预览。

## 10. 会话列表

「会话」页签（`client/chats-view.mjs` + `lib/chats.mjs`）：左边会话、右边只读消息。

| 项       | 取值 / 行为                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 路由     | `GET /chats` · `GET /chat/messages?chatId=` · `POST /chat/watch` · `POST /chat/p2p-resolve`（open_id → 私聊 chat_id） |
| 身份     | 已登录个人身份 → `user_access_token`（能看到自己的会话）；未登录 → 应用身份兜底（只看群）                             |
| 展示名   | 飞书单聊的 `name` 常为空 → 用「单聊 · `oc_` 尾巴」兜底；读到消息后升级成「与 X 的私聊」                               |
| 消息     | `sort_type=ByCreateTimeDesc` 拉 40 条，界面展示时转成时间正序；自己的靠右                                             |
| 姓名     | `contact/v3/users/batch` 补齐；失败只降级成 `…open_id尾巴`，不影响正文（`namesError`）                                |
| 监听开关 | 直接改写 dm-watch 的 `chatIds`，所以列表里看到的就是轮询实际在看的会话                                                |
| 分类     | 页签内分 **私聊 / 群聊 / 未识别**：`chat_mode` 已知的按它分；手填但查不到元信息的进「未识别」                         |
| 排序     | **按最后一条消息时间倒序**（`im/v1/chats` 不给这个字段，只能逐会话拉 1 条，见下）                                     |
| 发消息   | `POST /chat/send`，纯文本；**发送身份可切**（`as=user｜tenant`，见下）                                                |

### 发消息：两种身份（M1 已落地）

> 官方文档写明 `POST /open-apis/im/v1/messages` 的 `Authorization` **同时接受** `tenant_access_token` 与
> `user_access_token`。用户身份需同时申请 `im:message` + `im:message.send_as_user`（应用侧留申请 + 发布版本 + 重新授权）。
> 完整事实核对、四种集成路径（原生 / lark-mcp / lark-cli+skills / skill 文件）见
> [`docs/send-as-user.md`](docs/send-as-user.md)。

| 身份           | 请求 `as` | 能做什么                                                 | 前置条件                                            |
| -------------- | --------- | -------------------------------------------------------- | --------------------------------------------------- |
| **我**（用户） | `user`    | **给任意同事发人与人私聊**（不靠机器人在会话里）、群消息 | 个人授权 + `im:message` + `im:message.send_as_user` |
| 机器人（应用） | `tenant`  | 机器人所在的群 / 人×机器人单聊                           | `im:message:send_as_bot` + 机器人已在会话           |

- 默认值：个人身份已授权 → 「我」；未授权 → 「机器人」。**失败不静默回落**（以谁的名义发不能靠猜）。
- 会话页输入框上方有「我 / 机器人」开关；缺 scope 时提示会点名缺哪条（红字）。
- `GET /state` 的 `scopes.capabilities.im_send` 就是 scope 体检结果（`known=false` 表示 token 没带 scope 信息，不诬告缺权限）。
- **定位私聊**现在走 `POST /im/v1/chat_p2p/batch_query`（0 副作用，不发消息）；只有它拿不到 id 时才退到“发一条再撤回”。
- `probeP2pChatId()` 返回 `via: "api" | "send"`，界面/日志能分清走的哪条。

以下是以**应用身份（机器人）**发消息时的真实边界：

- 群里：机器人得先被拉进群；单聊：得是「人与机器人」的会话。**人与人之间的私聊，机器人身份发不进去。**
- 应用要开 `im:message:send_as_bot`，然后**创建版本并发布**（否则 `99991672`）。
- `sendTextMessage()` 把这些失败翻译成 `hint`，路由层经 `detail.hint` 带回界面，
  输入框下方直接显示"该开哪个权限 / 机器人为啥不在这个会话"。
- 只发纯文本：卡片/富文本/媒体要走另一套 `content` 结构，先把"能回一句话"做扎实。

**私聊自动发现**（`collectAllChats` + `chatInfoFromEntry` + `mergeChatInfo`）三路合并：

| 来源                           | 能拿到什么                     | 备注                                             |
| ------------------------------ | ------------------------------ | ------------------------------------------------ |
| 个人身份完整分页（≤5 页）      | 你所在的**群**（飞书不回 p2p） | 不再只看第一页，万一某页有 p2p 就抓到            |
| **open_id → 私聊（正式接口）** | 点对点的 p2p `chat_id`         | `POST /im/v1/chat_p2p/batch_query`，0 消息副作用 |
| **应用身份（机器人）会话列表** | 机器人参与的群 **和 p2p**      | 唯一会返回 `chat_mode=p2p` 的列表接口            |
| `chats_info` 本地缓存          | 曾经打开过/查过的会话          | 打开一次即永久记住（含单聊/群判定）              |

三路都空时，「私聊」栏会说明原因（接口给 `hint`，界面直接照抄），而不是留一个空白栏让人猜。

### 从消息反推「私聊 / 群」（兜底，不是发现手段）

`inferChatMode()` 在读消息时给「未识别」的会话补一个类型，标签上带 `~` 与 tooltip 标注"按消息推断"。
权威来源仍是 `GET /im/v1/chats/:chat_id` 的 `chat_mode`（我们优先用它，只有查不到/未知时才反推）。

| 线索                                        | 判定 | 置信                       |
| ------------------------------------------- | ---- | -------------------------- |
| 系统消息含 `invited / joined / 群 / 加入`   | 群   | 高（单聊没有入群系统消息） |
| 除自己外 ≥2 个不同发送人                    | 群   | 高                         |
| `mentions` 里出现"非我、非唯一对方"的第三人 | 群   | 高                         |
| 只有 1 个对方、≥3 条消息、无上面任何反证    | 私聊 | 中（2 人群会被误判）       |

**反解不出新会话**：`im/v1/messages` 必须给 `chat_id` 才能查，所以"从消息反推"只能**分类**已有 id，
不能发现私聊。

### 私聊 chat_id 从哪来（现在只有一条正路）

飞书**没有** `p2p_chats` / `user_chats` 这类接口（探过，404），`im/v1/chats` 也只回群。所以私聊 id 靠这些：

| 路子                                                | 形态                                                                            | 副作用                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **`contact +search-user --user-ids`**（主路）       | 返回里直接带 `p2p_chat_id`                                                      | **无**（不发消息，`POST /chat/p2p-resolve` 就是它）    |
| **发消息给 `open_id`**（`receive_id_type=open_id`） | 飞书自动复用/创建「人 × 机器人」单聊，响应里带 `chat_id`                        | 会真发一条（`POST /chat/send {openId}` 成功后才登记）  |
| **私聊提醒的自动发现**                              | `im +chat-list --types p2p,group` + 手填 `chat_id`                              | 无，但受飞书"是否给单聊列表"的限制                     |
| 历史探针（已删除）                                  | 消息搜索 `search/v2/message`、`/chats/search`、`probeP2pChatId`（发一条秒撤回） | 前者参数形状无公开文档且返回空；后者有"收到又撤回"痕迹 |

> 2026-11 实测记录（留档）：
> `/im/v1/p2p_chats`、`/im/v1/user_chats`、`/im/v1/chat_p2p` → 404；`GET /im/v1/messages/search` 不存在
> （被当成 `/messages/:message_id`）；`POST /search/v2/message` 路由在但返回 0 条；
> `GET /im/v1/chats/search` 可用且比 `im/v1/chats` 覆盖广，但**不返回 `chat_mode`**，必须逐条再查类型 ——
> 这条组合探测（`deepDiscoverChats` / `discoverViaMessageSearch` / `POST /chats/discover` / 页面「深度发现」按钮）
> 已随 OpenAPI 通道一起删除，现在用 CLI 的 `im +chat-list` 与 `contact +search-user` 两步就够。

要**完全自动**发现个人私聊，最终仍然只有事件推送（`im.message.receive_v1` 的 `chat_type`）一条路。

**排序不再预热**：旧实现要逐会话打 `im/v1/messages?page_size=1` 才知道"最后消息时间"（限流风险大），
现在 `lark-cli im +chat-list` 直接按 `active_time` 排好序，`/chats` 一次就返回（旧的
`ACTIVITY_WARM_LIMIT` / `warming` 进度提示已删除）。

**如实不做**：飞书口径的未读数、已读回执。飞书没给个人身份可靠的未读接口，这里的徽标是
**私聊提醒轮询的本地累计**（只覆盖监听中的会话、打开会话即清零 `/dm/read`），不是飞书客户端的未读。

### 改这个插件的两个必踩坑（已固化到测试）

1. **`lib/*.mjs` 不会随「插件重新加载」更新**：宿主只给 `index.mjs` 加 `?e=<epoch>` 破缓存，
   子模块是普通 URL，Node 永久返回缓存副本 —— 症状是「代码改了、重新加载了、行为没变」。
   本插件对高频迭代的两个模块用 `?v=<manifest.version>` 静态 import 破缓存：
   **改 `lib/` 必须 bump `manifest.version` 并同步 `?v=`**（`feishu-pro-core.test.ts` 扫全插件钉死）。
2. **两个模块的 `?v=` 必须同值**：`chats.mjs?v=N` 引 `dm-watch.mjs?v=M` 若 `N≠M`，
   会拉到旧缓存副本并报 `does not provide an export named …`（加载期崩溃，页面整块空）。

其余实测记录：`contact/v3/users/batch` 是 **GET**（POST 会 `404 page not found`）；
`im/v1/messages` 对 `@_user_N` 占位符要用 `mentions` 映射还原成姓名；系统消息没有 `sender`。

## 11. AI 待办（`待办` 页签，0.12.0）

一句话：**和我有关的事不用我记着** —— 本地待办库盯着它们，AI 持续给「判断 + 步骤」，
需要动手时点一个按钮让它去做（对外发消息先给我看草稿）。

- **数据源**：本地库是事实源；飞书任务双向同步 ——
  读（`task/v2` 未完成任务合并进本地，飞书给标题/截止/完成，本地保建议/历史/优先级）、
  写（**新建时勾「飞书」**才建远程任务并把 guid 记进 `ref`；之后改标题/描述/截止、勾完成/重开都 PATCH 回写）。
  回写只动**真改过的字段**，失败只降级（本地已改 + 历史留 warning），CLI 不可用时面板照常可用。
- **自动获取**：面板上「⏱ 自动」+ 间隔（15/30/60/120 分钟，默认**关**）——
  后台定时拉飞书任务，并从监听的会话提取候选（候选落盘，回来点「记下」才入库）。
  顶栏「后台任务」里能看到下次时间，一键停止就是真停。
- **建议**：`host.llm.complete`，一次一条，6 小时内不重复算；打开页签自动算最该看的 3 条。
  回包解析不假设干净（围栏/纯文本都能降级），动作类型是白名单。
- **一键处理**：`reply`（先摊草稿再确认，幂等键防重发）/ `agent`（先 confirm，派一轮无头运行）/
  `insert`（插进对话输入框）/ `open`（打开链接）。
- **提取**：从「会话」页监听的会话里读最近消息，让 AI 找「需要我做的事」，点「记下」才入库。
- **AI 工具 `feishu_todo`**：让 agent 自己也能记账、查账、推进（`handle kind=agent` 是真跑一轮；
  `config` 开关自动获取，`add` 带 `to_feishu` 才建远程任务）。

完整设计（数据模型 / 双向同步边界 / 提示词口径 / 三条红线 / 降级策略 / 定时器位置）
见 [`docs/todo-ai.md`](docs/todo-ai.md)。
