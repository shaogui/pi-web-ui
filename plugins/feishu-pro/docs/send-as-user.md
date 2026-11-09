# 直发消息：与 Trae Work 对齐的实现研究（feishu-pro）

> 结论先行 · 调研时间 2026-11 · 所有"事实"都附官方文档原文出处，未验证的一律进 §10「待实测」，不写成结论。

---

## 0. TL;DR

1. **插件现在那句"飞书只允许机器人发消息"是错的。** 官方文档明确：
   `POST /open-apis/im/v1/messages` 的 `Authorization` 接受 `user_access_token`，
   用户身份发消息只需**同时**申请 `im:message` + `im:message.send_as_user`。
   我们一直只发应用身份（`lib/chats.mjs` 里写死 `identity: IDENTITY_TENANT`），所以撞的是 230002/230013
   （机器人不在会话里），而不是"产品限制"。
2. **Trae Work 的真实做法不是 MCP，而是「用户 OAuth + 本地 CLI + 官方 Skills」。**
   飞书官方文章写得很直白：`管理账号 → 外部应用授权 → 飞书「连接」→ 授权`，
   然后 _"Trae Work 会自动安装本地 CLI 和飞书相关 Skills"_，技能页里能看到
   `lark-doc / lark-base / lark-calendar / lark-im / lark-task / lark-wiki`。
   MCP（`trae://trae.ai-ide/mcp-import` 一键导入 `lark-mcp`）是 **Trae IDE** 那条线，两者并存但不同。
3. 我们**已经有 Trae 最难的两半**：设备码自动建应用（`lib/app-registration.mjs`）、
   个人 OAuth + 单飞刷新（`lib/oauth.mjs` / `lib/tokens.mjs`）。缺的只有三块：
   **用户身份发送**、**p2p 会话发现**、**技能/话术层**。
4. 推荐分层：**A 原生 HTTP（用户身份）做主干** → **D skill 文件做话术** →
   **B(lark-mcp) / C(lark-cli) 做成"可选外挂"**（检测 + 一键接入 + 明确告警），
   不把"能不能发"这条命脉交给外部进程与第二套凭证。

---

## 1. 事实核对（官方文档原文，勿凭印象）

> 抓取技巧（对 Agent 很有用）：开放平台任意文档 URL **加 `.md` 后缀**直接返回原始 Markdown。
> 例：`https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create.md`
> 二进制的 `.md` 路径与网页路径一致；旧的 `server-docs/...` 路径部分已 404，用 `uAjLw4CM/.../reference/...` 那套。

| 能力                      | 接口                                                                 | 身份               | 必需 scope                                                                                                                                                             | 关键点                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发消息                    | `POST /open-apis/im/v1/messages`                                     | tenant **或 user** | 应用：`im:message` / `im:message:send_as_bot` / `im:message:send` 之一<br>**用户：`im:message` + `im:message.send_as_user`**                                           | `receive_id_type` 支持 `open_id/union_id/user_id/email/chat_id`；`uuid` 幂等（1h 内同 uuid 至多 1 条）；body 上限 text 150KB / post·card 30KB                                     |
| 回复                      | `POST /open-apis/im/v1/messages/:message_id/reply`                   | tenant **或 user** | 同上                                                                                                                                                                   | 语义比"再发一条"更正确（引用关系不丢）                                                                                                                                            |
| 读历史消息                | `GET /open-apis/im/v1/messages`                                      | tenant **或 user** | `im:message` / `im:message:readonly` / `im:message.history:readonly`；**用户身份另加**：单聊 `im:message.p2p_msg:get_as_user`、群聊 `im:message.group_msg:get_as_user` | 单聊/群聊补充 scope 刻意分开，只开一个就只能读一类                                                                                                                                |
| 搜消息                    | `POST /open-apis/im/v1/messages/search`                              | **仅 user**        | `search:message`                                                                                                                                                       | 文档化过滤器：`chat_type=p2p\|group`、`from_ids`、`chat_ids`、`time_range`、`is_at_me`、`from_types`、`include_attachment_types`；page_size ≤ 30                                  |
| 会话列表                  | `GET /open-apis/im/v1/chats`                                         | tenant 或 user     | `im:chat` / `im:chat:readonly` / `im:chat:read` / `im:chat.group_info:readonly`                                                                                        | 文档明写"**不包含单聊**"；但官方 CLI 用 `types=p2p,group`（**仅用户身份**）能拿到 p2p 行，附 `chat_mode=p2p`、`p2p_target_type`、`p2p_target_id`、`name`=对方昵称 → 见 §10 待实测 |
| **open_id → p2p chat_id** | `POST /open-apis/im/v1/chat_p2p/batch_query?chatter_id_type=open_id` | user               | 见 §10（待实测）                                                                                                                                                       | body `{"chatter_ids":["ou_x"]}` → `data.p2p_chats[].chat_id`。**官方 CLI 的 `--user-id` 就是靠它**，不用"发一条再撤回"                                                            |
| 批量会话详情              | `POST /open-apis/im/v1/chats/batch_query?user_id_type=open_id`       | tenant 或 user     | `im:chat:read`                                                                                                                                                         | body `{"chat_ids":[...]}`，50/次；返回 `chat_mode`、`p2p_target_id`、`description`… **替掉现在逐条 `GET /chats/:id` 的 N 次请求**                                                 |
| 发图片/文件               | `POST /open-apis/im/v1/images` · `/files`                            | tenant **或 user** | `im:resource` / `im:resource:upload`                                                                                                                                   | 先传后发（`image_key` / `file_key`）                                                                                                                                              |
| 收消息（事件）            | `im.message.receive_v1`                                              | **仅机器人**       | —                                                                                                                                                                      | 人类账号私聊没有事件。实时性只能靠"机器人长连接"（`@larksuiteoapi/node-sdk` 的 WSClient，本仓库 `plugins/feishu/bot-bridge.mjs` 已经在用 `host.ensureDeps` 装它）                 |

补充硬约束：

- **发消息接口的前提条件**（对两种身份都成立）：应用要**开启机器人能力并发布版本**。
  设备码建的 CLI 应用通常已开；自建老应用别忘了这一条。
- 限频：整体 1000 次/分、50 次/秒；**同一接收者 5 QPS**。
- 错误码：`230002/230013`=机器人不在会话；`230034`=receive_id 与类型不匹配；
  `231204`=**开启对外共享 / 关联组织的应用不支持以用户身份调该接口**；`230020`=限流。

---

## 2. Trae Work 到底做了什么

飞书官方文章《Trae Work 怎么接入飞书》（`feishu.cn/content/article/7652246966524562399`）原文要点：

1. Trae Work → 左下角头像 →「管理账号」→「外部应用授权」→ 飞书「连接」；
2. 跳飞书授权页，页面列出**云文档 / 多维表格 / 日历 / 通讯录 / 云空间 / 消息与群组 / 邮箱 / 会议 / 电子表格 / 任务 / 知识库**，
   一键「授权并连接飞书」——**不需要用户逐项配 scope**；
3. 回到 Trae Work，显示"已与 Trae 集成"，并**自动安装本地 CLI 和飞书相关 Skills**
   （技能页可见 `lark-*`）；
4. 之后自然语言驱动 → Agent 跑 `lark-cli` 命令（文章第 4 步列的就是"读取 PRD / 查多维表格 / 整理妙记 / 查日程建会议 / 检索知识库"）。

所以它的三件套是：

```
飞书账号中心 OAuth（user_access_token，服务端保管）
        ↓
本地 CLI 二进制（lark-cli，Go，随 agent 安装；凭证进 OS keychain）
        ↓
26 个 Skills（lark-im / lark-doc / lark-base / … 就是 Markdown 剧本，教 Agent 怎么用这个 CLI）
```

**它为什么能"以你身份发消息"**：`lark-cli im +messages-send --as user --user-id ou_xxx`
内部就是 `POST /im/v1/messages?receive_id_type=open_id` + `Authorization: Bearer <user_access_token>`，
scope 要 `im:message` + `im:message.send_as_user`（`shortcuts/im/im_messages_send.go` 里
`UserScopes: []string{"im:message.send_as_user","im:message"}`）。**协议层没有任何魔法。**

> 顺带一个纠偏：Trae 的官方能力表把"消息与群组"写成"读取群消息，管理群信息和**部分**消息互动"，
> 并没有承诺"给任意同事发人与人私聊"。`--as user` 发送是 CLI 提供的能力，是否全员可用仍受
> 应用已申请 scope、企业策略、`231204`（对外共享/关联组织应用）限制。

---

## 3. 四条路径对比

| 维度                       | **A 原生 HTTP（本插件）**                     | **B lark-mcp**                                                                                                                     | **C lark-cli + Skills**                                                                                                            | **D pi skill（话术层）** |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 能否以"我"身份发人与人私聊 | ✅ 能（scope 到位即可）                       | ✅ 能（`--token-mode user_access_token`）                                                                                          | ✅ 能（`--as user`）                                                                                                               | ❌ 自己不调 API          |
| 依赖                       | 零（宿主内置 fetch）                          | `@larksuiteoapi/lark-mcp` + Node                                                                                                   | **lark-cli 二进制**（Go，`npx @larksuite/cli install`）                                                                            | 无（纯 Markdown）        |
| 凭证                       | 已有：`host.secrets`（AES-256-GCM）+ 单飞刷新 | **第二套**：app id/secret 进 `mcp.json` 明文 + 自登录 `localhost:3000/callback` + **keytar 系统钥匙串**（容器/无 keychain 直接炸） | **第二套**：`lark-cli config init` + OS keychain                                                                                   | 无                       |
| token 复用                 | —                                             | ❌ 我们的 user token 不能塞给它（2h 一轮换；`-u` 传值也只能撑 2h，得重启子进程）                                                   | ❌ 同上                                                                                                                            | —                        |
| 覆盖度                     | 我们写多少有多少                              | 2500+ API 的 **preset 子集**（`preset.im.default` 只有 6 个 IM 工具）                                                              | **200+ 快捷命令 / 2500 API / 26 skills**（最广）                                                                                   | —                        |
| 失败面                     | 自己的错误翻译与探针                          | MCP 子进程崩溃、keytar、登录态、版本漂移                                                                                           | CLI 版本、exit 10 高风险门禁、相对路径限制、双份凭证                                                                               | 无                       |
| 插件可控性                 | 完全可控（UI / 审计 / 审批 / 日志）           | 只能看工具结果                                                                                                                     | **插件没有 exec 能力**（`plugin-sdk/index.d.ts` 无 spawn），只能由 **agent 用 bash 跑** → 发送动作跑到 shell 里，脱离插件的确认 UI | —                        |
| 落地成本                   | 中（§5）                                      | 低（`host.mcp.install()` 一行）                                                                                                    | 中高（安装 + 授权 + 教模型）                                                                                                       | 极低                     |

**取舍**：

- **B/C 不是"更好的实现"，是"另外一套身份与凭证"**。同一个用户在企业里会变成"两处授权、两处失效"。
- **C 的价值是覆盖面 + 官方维护的 skill 话术**，适合做"进阶用户可选"，不适合做默认路径：
  插件无法 spawn 进程，等于把发送挪到 bash，还要吃审批门禁（`server/tool-approval.ts` 对 bash 的规则）。
- **B 的价值是"团队已经有 lark-mcp 配置"** 时的零成本复用，适合做检测 + 一键写入。

---

## 4. 推荐架构（分层，逐层可独立上线）

```
L0 身份/scope 层   tokens.mjs + oauth.mjs + settings
   ├ 推荐 scope 清单（常量，UI 展示勾选状态）
   ├ 授权时显式带 scope（config.scope 为空 → 用清单；已申请但未授权的会被飞书拒，需先发布版本）
   └ 失败即给"补哪个 scope + 重新授权"的可执行提示（NEED_SCOPE，与现有 NEED_USER 同构）
L1 传输层          lib/chats.mjs（拆出 lib/im.mjs）
   ├ send({identity, to:{chatId|openId|email}, msgType:text|post, uuid})
   ├ reply(messageId, ...) / uploadImage / uploadFile
   ├ 限流队列（同接收者 ≥200ms 间隔，230020 退避重试 1 次）
   └ 错误翻译表补 231204 / 230034 / missing-scope
L2 发现层          lib/chats.mjs
   ├ resolveP2pChatId(openId) → POST /chat_p2p/batch_query
   ├ listp2pChats() → GET /chats?types=p2p&sort_type=ByActiveTimeDesc
   ├ batchChatInfo(ids) → POST /chats/batch_query（替掉 N 次 GET）
   └ searchMessages({chatType:"p2p", fromIds, timeRange}) → POST /messages/search
L3 工具/路由层     index.mjs
   ├ 路由：/chat/send（as=user|bot）、/chat/reply、/chat/p2p-resolve、/chat/message-search
   └ 工具：feishu_pro 新增 send_message / reply_message / chat_history / message_search
L4 技能层          plugins/feishu-pro/skills/*.md（+ 可选同步到 <dataDir>/skills）
L5 外挂层          设置页「接入方式」卡片：检测 lark-mcp / lark-cli → 一键安装 / 复制命令
```

---

## 5. A 路径详细实现（对着现有文件改）

| 文件                                         | 改什么                                                                                                                                                                                                      | 关键点                                                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/tokens.mjs`                             | 新增 `RECOMMENDED_SCOPES` 常量与 `describeMissingScopes(granted)`                                                                                                                                           | 已存 `user.scope`（授权返回的 granted 列表），直接做差集 → UI 打勾清单                                                                                                                                                                         |
| `lib/oauth.mjs`                              | `buildAuthorizeUrl` 已支持 `scope`；补 `prompt`/`scope` 归一化 + 单测                                                                                                                                       | scope 之间用**空格**分隔                                                                                                                                                                                                                       |
| `lib/chats.mjs`（建议改名 `lib/im.mjs`）     | `buildSendPayload(chatId,text)` → `buildSendPayload({to, msgType, content, uuid})`；`sendTextMessage({identity})`；`sendToOpenId({identity})`；新增 `resolveP2pChatId` / `batchChatInfo` / `searchMessages` | ① `identity` 默认 `user`，失败可降级 `tenant` 并把降级原因带回去（现有 `fetchUserNames` 的"双身份轮询"就是这个模式）<br>② `content` 必须是**字符串化 JSON**（现有注释已踩过）<br>③ 返回体字段不稳，照现有 `merged` 兜底补 `sender_type:"user"` |
| `index.mjs`                                  | `/chat/send` 增 `as` 参数（默认 user）；`/chat/reply`；`/chat/p2p-resolve`；`/chat/message-search`；tool action 扩容                                                                                        | **路由契约别破坏**：老客户端不传 `as` 时行为要可预测（建议默认 `user` + 失败自动回落 `tenant` 并在 `detail.degraded` 说明）                                                                                                                    |
| `lib/probe.mjs`                              | 补 4 条探针：`im_send_user`（真发一条到"给自己"？不行 → 用 `GET /im/v1/messages?page_size=1` 代替）/ `chat_p2p_batch_query` / `messages_search` / `chats_batch_query`                                       | 探针只做**只读**，别在探针里真发消息（会打扰同事）                                                                                                                                                                                             |
| `client/entry.mjs` + `client/chats-view.mjs` | 输入框上方身份切换「我 / 机器人」；失败提示带"补 scope / 重新授权"直达按钮                                                                                                                                  | 默认「我」；机器人身份旁注明"只在机器人所在会话可用"                                                                                                                                                                                           |
| `client/dm-panel.mjs` + `lib/dm-watch.mjs`   | 私聊发现从"手填 chat_id + 机器人会话"升级为 `types=p2p` 自动列表（用户身份），保留手填兜底                                                                                                                  | 有 p2p 历史扫描能力后，"有人私聊我"才不再依赖手填                                                                                                                                                                                              |

### 5.1 发送语义与内容格式

| 场景                          | 用什么                        | 备注                                                                                                                                                                                 |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 一句话                        | `msg_type=text`               | 现有行为                                                                                                                                                                             |
| Markdown / 列表 / 链接 / 周报 | `msg_type=post`（飞书富文本） | 需要 markdown→post 的转换器；可直接照抄 `lark-cli` 的 `shortcuts/im/convert_lib/text.go`（MIT）逻辑要点：标题→`**bold**` 段落、列表→带 `•` 的行、代码块→`text` 风格段、链接→`a` 元素 |
| 卡片（带按钮回调）            | `msg_type=interactive`        | 需要 schema 2.0 JSON + `card.action.trigger` 回调，**二期再做**（回调依赖事件订阅 = 机器人）                                                                                         |
| 图片/文件                     | `POST /im/v1/images           | files`→`image_key`/`file_key`                                                                                                                                                        | 用户身份也可上传（`im:resource`） |

### 5.2 安全与体验（这是"能不能给出去"的关键）

- **发送必须两步**：AI 工具只产出起草（`draft:true`）→ UI 上人点「发送」。
  插件的 `registerTool` **没有 `dangerous` 标记**（宿主只对 `write/edit/patch/bash` 有审批规则），
  所以确认只能在插件层做；`promptGuidelines` 里同时写死"未经用户明确同意不得发送"。
- **审计**：`host.storage` 环形日志（时间 / 身份 / 目标 / 长度 / message_id / 结果码），**不落正文**。
- **限流**：同接收者 200ms 间隔；批量群发一次 ≤5 人且必须二次确认（`im:message.send_as_user` 是"以你名义"）。
- **PII**：沿用现有口径——手机号/邮箱不进上下文、不复述。

---

## 6. B 路径：lark-mcp 的落地方式（可选外挂）

```js
// 插件内一行（需 "tools" 权限；已存在 host.mcp.install）
await host.mcp.install({
	name: "lark",
	package: "@larksuiteoapi/lark-mcp",
	args: ["mcp", "-a", appId, "-s", appSecret, "--token-mode", "user_access_token", "-t", "preset.im.default"],
});
```

事实与坑（来自官方 README / 代码）：

- 启动形态：`npx -y @larksuiteoapi/lark-mcp mcp -a <id> -s <secret> [--oauth --token-mode user_access_token] [--domain https://open.larksuite.com] [-t preset.x,tool]`
- 工具粒度：`im.v1.message.create` / `im.v1.message.list` / `im.v1.chat.create` / `im.v1.chat.list` / `im.v1.chat.search` / `im.v1.chatMembers.get`；presets：`preset.light` / `preset.default` / `preset.im.default` / `preset.base.default` / `preset.doc.default` / `preset.task.default` / `preset.calendar.default`
- 用户身份要先 `npx -y @larksuiteoapi/lark-mcp login -a ... -s ... [--scope ...]`，默认回调 `http://localhost:3000/callback`，需要用户在开放平台登记该地址
- 依赖里有 **keytar**（OS 钥匙串）→ Linux 无 dbus / 容器 / 无桌面环境会失败；这是"一键安装后第一次调用就报错"的最常见原因
- **我们的 user token 传不进去**（只能 `-u <token>` 硬塞，2h 过期且刷新权在我们手里）
- 结论：**做成"用户点一下、我们写好 mcp.json、并明确告知会多一套凭证"的卡片**，默认关闭；不要静默安装。

---

## 7. C 路径：lark-cli + Skills（Trae 的同款）

**先明确一个硬约束**：`plugin-sdk/index.d.ts` 里插件**没有** exec/spawn 能力（`host.ensureDeps` 只装 npm 依赖，
`host.fs` 只读写工作区/插件目录）。所以"插件内跑 lark-cli"是**做不到的**，
能做的是让 **Agent 用 bash 跑**——这正是 Trae 的形态（Agent + CLI + Skills），只是把执行者从"插件"换成"模型 + 终端"。

最小可用链路：

```bash
npx @larksuite/cli@latest install            # 装 lark-cli（Go 二进制，MIT）
lark-cli config init --new                   # 输出授权链接（设备码式），用户浏览器完成
lark-cli auth login --recommend              # 拿 user token（存 OS keychain）
lark-cli auth status                         # 验证
npx skills add larksuite/cli -y -g           # 装 26 个 lark-* skills
lark-cli im +messages-send --as user --user-id ou_xxx --text "你好"
lark-cli im +chat-messages-list --as user --user-id ou_xxx   # 自动解析 p2p chat_id
lark-cli event consume im.message.receive_v1 --as bot        # 实时事件（仅机器人）
```

需要 Agent 知道的契约（抄进 skill 里，别让模型猜）：

- JSON 信封：成功 `{"ok":true,"identity":"user","data":{...}}` 走 stdout / exit 0；
  失败 `{"ok":false,"error":{type,subtype,code,hint}}` 走 stderr / 非 0。**判成功用 `ok == true`，不是 `code == 0`**。
- **exit 10 = 高风险写入门禁**（不是错误）：要停下来问用户，再把 hint 指的确认 flag 追加到 argv 末尾重试。
- 文件参数**只接受 cwd 相对路径**，绝对路径/`..` 直接被拒。
- `--as user` vs `--as bot` 决定"代表谁"；bot 查用户资源常常"空成功"，别当成"没数据"。

pi 侧的 skill 发现目录（`server/skill-discovery.ts`）：`~/.pi/agent/skills`、`.pi/skills`、`<dataDir>/skills`、
`~/.agents/skills`、`~/.claude/skills`、`.cursor/.windsurf/.github/.opencode/skills`、以及 npm 包内 `skills/`。
→ 所以"让 Trae 同款 skills 在 pi 里生效"是**一行安装命令**的事，不需要我们重写。

---

## 8. D 路径：插件自带的 skill（成本最低、收益立竿见影）

插件已经在 `registerTool` 里带 `promptSnippet` / `promptGuidelines`。再加一层"按需加载的详细剧本"：

```
plugins/feishu-pro/skills/feishu-im/SKILL.md        # 发送/回复/读取/搜索的完整参数矩阵与禁忌
plugins/feishu-pro/skills/feishu-docs/SKILL.md      # 文档读取与引用规范（现有能力）
```

- 放插件目录内 → 版本随插件走、跟着插件更新，**不污染用户全局 skills**；
  在工具的 `promptGuidelines` 里写一句"复杂发送/批量操作前先读 `<pluginDir>/skills/feishu-im/SKILL.md`"即可（Agent 用 `read` 打开）。
- 想让它出现在技能面板：`<dataDir>/skills/` 是宿主发现目录之一，激活时拷贝一份（幂等 + 版本戳），
  但这属于"写插件目录外的文件"，建议做成**设置开关**（默认关）。

---

## 9. 里程碑与验收

| 里程碑         | 内容                                                                                            | 版本   | 测试                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **M1（主干）** | scope 清单 + 用户身份 `send`/`sendToOpenId` + `resolveP2pChatId` + 错误翻译 + 探针              | 0.9.0  | `feishu-pro-chats.test.ts`（payload/receive_id_type/identity/uuid）、`feishu-pro-core.test.ts`（scope 差集、NEED_SCOPE、`?v=` 同步） |
| **M2（体验）** | post/markdown、reply、图片、消息搜索、p2p 自动发现、UI 身份切换、审计                           | 0.9.x  | `feishu-pro-chats-view.test.ts`、`feishu-pro-dm-watch.test.ts`（p2p 自动发现）、新 `feishu-pro-im-send.test.ts`                      |
| **M3（生态）** | 自带 skill + 设置页外挂卡片（检测 `lark-mcp` / `lark-cli`，一键 `host.mcp.install` / 复制命令） | 0.10.0 | 设置页渲染 + `host.mcp.install` 调用参数快照                                                                                         |

**改 `lib/*.mjs` 的硬规矩**（README §11 已记）：必须 `bump manifest.version` + 同步 `index.mjs` 里的
`?v=`（`chats.mjs?v=0.8.6`、`dm-watch.mjs?v=0.8.6`），两个 `?v=` 必须**同值**，否则会拉到旧缓存副本。

---

## 10. 待实测（文档没写死 / 只有官方 CLI 代码里有）

用现有 token 就能验，建议按顺序打（$UAT = user_access_token）：

```bash
# 1) 用户身份发消息（最关键，发给自己最安全：先取自己的 open_id）
curl -sS -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
  -H "Authorization: Bearer $UAT" -H "Content-Type: application/json" \
  -d '{"receive_id":"ou_self","msg_type":"text","content":"{\"text\":\"probe\"}","uuid":"probe-'$RANDOM'"}'
# 期望：code=0，sender.sender_type=user；若 99991672 → 缺 im:message.send_as_user（申请人+发布版本+重授权）

# 2) open_id → p2p chat_id（官方 CLI 靠它，scope 未知）
curl -sS -X POST "https://open.feishu.cn/open-apis/im/v1/chat_p2p/batch_query?chatter_id_type=open_id" \
  -H "Authorization: Bearer $UAT" -H "Content-Type: application/json" -d '{"chatter_ids":["ou_peer"]}'
# 期望：data.p2p_chats[].chat_id

# 3) 用用户身份列 p2p（公开文档说"不含单聊"，官方 CLI 说 types=p2p 可以）
curl -sS "https://open.feishu.cn/open-apis/im/v1/chats?types=p2p&user_id_type=open_id&sort_type=ByActiveTimeDesc&page_size=20" \
  -H "Authorization: Bearer $UAT"
# 期望：items[].chat_mode=p2p + p2p_target_id；若报参数错 → 该开关对我们这类应用不可用，退回路子 2

# 4) 用户身份读单聊历史（要 im:message.p2p_msg:get_as_user）
curl -sS "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_xxx&page_size=5&sort_type=ByCreateTimeDesc" \
  -H "Authorization: Bearer $UAT"

# 5) 消息搜索（仅用户身份）
curl -sS -X POST "https://open.feishu.cn/open-apis/im/v1/messages/search?page_size=10" \
  -H "Authorization: Bearer $UAT" -H "Content-Type: application/json" \
  -d '{"query":"","filter":{"chat_type":"p2p"}}'
```

已知会踩的：

- `231204`：应用开了**对外共享 / 关联组织** → 用户身份直接被拒（文档明写），只能换应用或走机器人。
- 用户 token 的 scope 是**授权那一刻**定死的：先申请 scope/发布版本、**再**重新授权，旧 token 不会自己长出权限。
- `99991679` 既可能是"token 失效"也可能是"这个接口的 scope 没开"——别一律当掉线（`lib/tokens.mjs` 已有此注释）。

---

## 11. 一句话回答"能不能和 Trae 一样直接发"

**能，而且不需要装 CLI**：把 `identity` 从"写死 tenant"改成"可传 user"，
申请 `im:message` + `im:message.send_as_user` 两个 scope 并重新授权，
`POST /im/v1/messages?receive_id_type=open_id` 就是"以我的名义发一条私聊"。
precise 的 p2p `chat_id` 由 `chat_p2p/batch_query` 给，读历史用用户身份 + `p2p_msg:get_as_user`。
Trae 的 CLI+Skills 是"覆盖面更大、凭证更多"的另一条路，适合做成可选项，不适合当主干。

---

## 12. 已落地（M1，插件 0.8.7）

M1 的四件事全部落地，并且**默认行为对老调用方保持兼容**（不传 `as` 且个人身份已授权 → 以「我」发送；
未授权 → 机器人），唯一的语义变化是"身份不再写死"。

| 层            | 落地内容                                                                                                                                                                    | 位置                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| L0 scope 体检 | `REQUIRED_USER_SCOPES` / `normalizeScopeList` / `scopeReport`；`/state` 新增 `scopes`（`known=false` 时不诬报缺权限）                                                       | `lib/tokens.mjs`、`index.mjs` `oauthStatePayload()` |
| L1 发送       | `sendTextMessage` / `sendToOpenId` 新增 `identity` / `uuid`；回包 `identity` 与 `sender_type` 正确；错误建议按身份分表（`USER_SEND_ERROR_HINTS`，含 `231204` 对外共享应用） | `lib/chats.mjs`                                     |
| L1 路由       | `POST /chat/send` 接受 `as: "user"｜"tenant"`；**失败不静默回落**（以谁的名义发不能靠猜）                                                                                   | `index.mjs`                                         |
| L2 发现       | `resolveP2pChatId()`（`POST /im/v1/chat_p2p/batch_query`，0 副作用）+ `POST /chat/p2p-resolve`；命中后自动登记进 `chats_info`                                               | `lib/chats.mjs`、`index.mjs`                        |
| L2 兜底改造   | `probeP2pChatId()` 改为 **API 先行**：正式接口拿到 id 就一条消息都不发，拿不到才退"发一条再撤回"；返回带 `via: "api"｜"send"`                                               | `lib/chats.mjs`、`index.mjs`                        |
| L3 探针       | 新增 `chat_p2p_batch_query`（用你自己的 open_id 探，不发消息）与 `messages_p2p_read`；缺 `selfOpenId` 时 `skipped` 且**不计入分母**                                         | `lib/probe.mjs`、`index.mjs` `/probe`               |
| L4 UI         | 会话页输入框上方「我 / 机器人」开关：默认「我」、未授权时禁用「我」并退回机器人、缺 scope 时提示点名缺哪条（红字）                                                          | `client/chats-view.mjs`                             |
| 通讯录        | 「发消息」不再写死机器人身份；成功后按真实身份回报（"已以你本人身份发送"）                                                                                                  | `client/contact-actions.mjs`                        |

测试：

- `tests/unit/feishu-pro-chats.test.ts`：身份透传、`uuid` 截断、两套错误建议、`resolveP2pChatId` 解析/容错、`probeP2pChatId` API 先行。
- `tests/unit/feishu-pro-im-identity.test.ts`（新）：scope 体检三态（齐全/缺一条/未知）、探针 skip 语义、`/chat/send` 真用 `Bearer u-test`、失败不回落、`/chat/p2p-resolve` 登记。
- `tests/unit/feishu-pro-chats-view.test.ts`：身份开关默认值、"缺 scope 红字"、未授权禁用。

### 12.1 怎么验证（不用改代码）

1. **看 scope 有没有到位**：`GET /plugins-api/feishu-pro/state` → `scopes.capabilities.im_send`。
   `ok=false` 时 `missing` 就是要在开放平台补的那几条（补完必须**重新授权**）。
2. **探针**：设置页「权限探针 → 个人身份」应看到
   `会话 · open_id 解析私聊（不发消息）` 通过（返回 0 条也算通）。
3. **真发一条**：会话页选一个和同事的单聊 → 身份保持「我」→ 发送。对方看到的是**你**发的。

### 12.2 明确没做（留给 M2 / M3）

- 富文本（`post`）/ 卡片（`interactive`）/ 图片文件上传 → M2；
- `im/v1/messages/search` 的文档化搜索（`chat_type=p2p`）与 `GET /im/v1/chats?types=p2p` 列表 → M2；
- 设置页把 scope 报告渲染成勾选清单（现在只在会话页提示里体现）→ M2；
- AI 工具 `feishu_pro` 的 `send_message` 动作（**AI 直接发消息**）→ M2，且必须带"先起草、人确认"的两步；
- 自带 skill 文件 + lark-mcp / lark-cli 外挂卡片 → M3。
