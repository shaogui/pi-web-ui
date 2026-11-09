# AI 待办（`待办` 页签，0.12.0）

> 目标：**和我有关的事，不用我记着**。插件盯着一份本地待办库，持续给「一句话判断 + 可执行步骤」，
> 需要动手时我点一个按钮，AI 就去做（对外发消息这类动作先给我看草稿）。

## 1. 为什么不是「飞书任务面板」

飞书任务（`task/v2`）能表达的东西只有：标题、描述、截止时间、完成态。这套语义装不下真正要的三件事：

| 要的东西                 | 飞书任务 | 本插件本地库 |
| ------------------------ | -------- | ------------ |
| AI 的处理判断与步骤      | ✗        | ✓ `advice`   |
| 建议附带的可执行动作     | ✗        | ✓ `actions`  |
| 谁在什么时候点了哪个动作 | ✗        | ✓ `history`  |

而且**待办大量来自消息**（"你明天把方案发我"），这些不会变成飞书任务。所以：

```
                     ┌──────────────────────────────┐
   飞书任务 ──合并──▶ │  本地待办库 (storage.json)   │ ◀──手动/消息提取/AI 记录
   (读 + 写回双向)    └──────────────┬───────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
              AI 建议（llm.complete）        一键处理（execute）
              判断 + 步骤 + 动作              reply / agent / insert / open
```

合并方向是**单向的**：飞书给标题/截止/完成，本地保建议/历史/优先级。同步只增改，不删本地条目。

**写**是另一条路（0.12.0）：本地新建时勾「飞书」→ `POST /task/v2/tasks`；之后改标题/描述/截止、
勾完成/重开 → `PATCH /task/v2/tasks/:guid`。两边的 `ref.kind = "task"` 就是联动凭证，
所以「飞书里有的」和「本地有的」不会各说各话。

## 2. 数据模型（`lib/todo-store.mjs`）

```jsonc
{
	"id": "td_mw6nc8z2_1yg0",
	"title": "给张总发周报",
	"detail": "他周四要，附上上周数据",
	"status": "open", // open | doing | done | dropped
	"priority": "high", // low | normal | high | urgent
	"source": "extract", // manual | feishu | extract | agent
	"dueAt": 1767225600000,
	"ref": { "kind": "chat", "id": "om_xxx", "chatId": "oc_xxx", "sender": "张三", "title": "", "url": "" },
	"advice": {
		"summary": "先把上周数据拉齐再写",
		"steps": ["跑一次统计脚本", "发给张总并约定评审时间"],
		"actions": [{ "id": "a0_reply", "kind": "reply", "label": "回张总", "text": "…", "chatId": "oc_xxx" }],
		"model": "…",
		"at": 1767225600000,
	},
	"adviceMutedAt": 0,
	"history": [{ "at": 1767225600000, "kind": "agent-done", "text": "已写完 notes.md", "ref": "run_xxx" }],
	"createdAt": 0,
	"updatedAt": 0,
	"doneAt": 0,
}
```

不变量（都有单测钉住）：

1. `normalizeTodo` 幂等，未知字段丢弃；`doneAt` 只跟 `status` 走；
2. `ref` 的 `kind:id` 是**跨同步去重键**（飞书任务按 `guid`、消息按 `messageId`），没有稳定 ID 就不去重；
3. 动作的 `ranAt` 必须活过每一次 normalize —— 丢了它，界面会让人把同一件事做第二遍；
4. 排序：未完成 → 有截止（早的靠前）→ 优先级 → 最近更新；完成/搁置沉底但**不隐藏**。

容量：单文件 `storage.json` 原子写，`TODO_LIMIT = 300` 条封顶。

另外两个存储键（与待办库分开，脏数据不互相拖累）：

| 键                 | 内容                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `todos.candidates` | 跟 `todos` 同文件内的 `candidates` 字段：**待采纳候选**（消息提取产出，最多 20 条，按标题去重、id 由标题哈希） |
| `todos.config`     | 自动获取配置：`{autoSync, autoExtract, intervalMin, lastRunAt, lastResult, lastError}`，默认全关               |

候选要落盘的理由：自动提取是在面板**没开着**的时候跑的，没落盘就等于白花一次模型额度
（而且用户还会从通知里知道「发现了 N 条」，回来看不到就成了假的）。

同文件内还有 `deletedTaskIds`（最多 100 条）：本地删掉的**联动任务** guid —— 飞书任务不跟着删，
但不记这一笔的话下一轮自动同步会把它拉回来，用户会以为删除失效了。

## 3. AI 建议（`lib/todo-ai.mjs` + `host.llm.complete`）

- **提示词里必须带今天的日期与星期**（`dayLabel()`）。不带的话"下周一"会被系统性算错，待办的截止时间就全废；
- 明确告诉模型「有没有可以直接发送的对话」：有 `ref.chatId` 才允许 `kind=reply`，否则只能 `insert`；
- 回包只要 JSON，但**解析不假设它干净**：先剥 ``` 围栏，再括号配平扫描（字符串里的 `}` 不会提前收尾），
  失败就退化成「首行=判断、其余=步骤」的纯文本建议（**没有动作按钮**，但面板照样能显示）；
- 动作类型是白名单：`ACTION_KINDS = reply | agent | insert | open`，模型吐的 `send_message` 之类一律丢弃；
- `reply` 缺收件人 → **降级成 `insert`**：「宁可让用户自己粘一下，也不要把消息发给模型猜出来的对象」；
- 预算：prompt ≤ 6000 字（`host.llm.complete` 硬上限 8000），`maxChars: 1600`，超时 75s。

调度策略：

| 场景                   | 行为                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| 打开「待办」页签       | 自动给「未完成 + 建议过期」的前 3 条生成建议（一次打开只跑一轮）     |
| 点「AI 建议」/「重算」 | `force: true`，只算这一条                                            |
| 点「AI 梳理」          | 同上，批量最多 3 条（逾期/今天优先）                                 |
| 6 小时内               | 不重复算（`ADVICE_TTL_MS`），不花用户额度                            |
| 点「没用」             | 清掉建议并记 `adviceMutedAt`，下次换说法（不会立刻重算，避免死循环） |

服务端还有一道 `advising` 集合：同一条待办在飞时直接跳过，连点两次不会烧两份额度。

## 4. 一键处理（`execute`）

| 动作     | 服务端行为                                                                             | 前端要求                       |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `reply`  | 用**服务端存的那份文本与收件人**调 `im +messages-send`，`uuid = f(todo.id, action.id)` | 先摊开草稿，点「确认发送」才发 |
| `agent`  | `host.chat({text: buildAgentTask(todo), accountId: "feishu-pro:todo"})`                | 先 `confirm`                   |
| `insert` | 只回 `{directive:{type:"insert"}}`，不产生副作用                                       | 插进对话输入框（失败落剪贴板） |
| `open`   | 只回 `{directive:{type:"open",url}}`                                                   | `window.open`                  |

三条红线：

1. **前端只能指定「哪一个动作」，不能指定「发什么」**：文本与收件人一律取服务端存过的那份（`/todos/execute` 只收 `{id, actionId}`）；
2. **幂等键稳定**：`replyUuidFor(todo, action)`，重试/连点在飞书侧被去重，不会发两遍（与 `im_send` 同一条铁律）；
3. **`agent` 的提示词由服务端固定生成**（`buildAgentTask`）：写清"只处理这一件事""收件人不明确就别发""用工具真做完，别只给计划"。

派出去的运行走独立账号 `feishu-pro:todo`，与「私聊自动问答」（`feishu-pro:auto`）的会话互不覆盖。
`onRunEvent` 按 `runId` 认领：assistant 文本攒着，`run_end` 时写进 `history` 并发一条通知，状态从 `doing` 回到 `open`
（**自动勾完成是越权**，要不要算完成由人决定）。

## 5. 从消息里提取待办

来源 = 「会话」页里**主动监听的会话**（飞书不给"我的全部私聊"，见 `docs/dm-watch-lark-cli-eval.md`）。
每个会话读 20 条、最多 3 个会话、总消息 60 条（超了从最早的丢：最近的对话才会产生新待办）。

回包是候选列表（不落库）：`{items:[{title, detail, dueAt, priority, reason}]}`。
界面上点「记下」才 `POST /todos/create`（`source: "extract"`），已在库里的同名标题会被服务端过滤掉。

## 6. 飞书任务：双向同步（`lib/cli-tasks.mjs`）

CLI 的快捷命令没有任务域，走 `api` 兜底：

```
GET   /open-apis/task/v2/tasks              → 只列未完成（completed=false 不传）
POST  /open-apis/task/v2/tasks              → { task: { summary, description, due } }
PATCH /open-apis/task/v2/tasks/:task_guid   → { task: {...}, update_fields: [...] }
```

读（`sync()`）：合并进本地库，只增改；读失败 → 返回 `warning`，面板显示
「读不到飞书任务，本地待办仍然可用」（**降级不是报错**）。

写（三条路，全部要求 `ref.kind === "task"`）：

| 触发                 | 调用                            | 备注                                     |
| -------------------- | ------------------------------- | ---------------------------------------- |
| 新建时勾「飞书」     | `POST`（`toFeishu: true`）      | 成功才把 guid 写进 `ref`；失败只留本地   |
| 改标题 / 描述 / 截止 | `PATCH`（只带**真改过**的字段） | 没改的字段不碰，不覆盖同事在飞书侧的编辑 |
| 勾完成 / 重新打开    | `PATCH`（`completed_at`）       | 与字段修改可以同轮发生                   |

- 写失败 → 本地已改，如实回 `writeBack: {writeBack:false, warning}`、写进 `history`，绝不假装成功；
- 删除待办**不删**飞书任务（破坏性操作得人去飞书里确认），只把 guid 记进 `deletedTaskIds`：
  行内提示「飞书任务还在」，且**下次同步不会把它拉回来**（删除就是删除）；
- 写操作的 body 参数名各版本 CLI 不一（`--data` / `--body` / `--json`）：只在错误明确是「不认识这个 flag」时换一个再试
  （那种失败**没有发出请求**，所以不会重复写）；
- `PATCH` 天然幂等：自动同步重跑不会造成重复任务或重复完成。

## 7. 自动获取（定时同步 + 定时提取）

**调度器在 `index.mjs`，不在服务层** —— 服务层保持纯函数 + 注入依赖，单测可以一行跑一轮
（`todoService.autoRun()`）；宿主侧只负责「什么时候跑」。

- 配置存 `todos.config`，默认 `{autoSync:false, autoExtract:false}`。「⏱ 自动」一开关同时管两件事，
  间隔可选 **15 / 30 / 60 / 120 分钟**（`normalizeTodoConfig` 夹在 15–360）；
- 一轮 = `sync()`（拉飞书任务）+ `extract()`（从监听会话提候选），候选落盘并 `notify` 一句；
- 时间口径是**纯函数** `autoNextAt()`：没跑过 → 立刻；过点（服务停了一晚）→ 立刻补一轮；否则 `lastRunAt + interval`；
- `lastRunAt` 失败也写 —— 否则过点后每个 tick 都会重跑，变成热循环；
- 定时器 `unref()`（不阻滞进程退出），插件卸载/重载时 `clearTimeout`；重复点击不会并发（服务层 `autoRunning` 门禁）；
- 顶栏「后台任务」看到「每 N 分钟 …」，面板上的「停止」= 关开关 + 撤定时器（真停，不是只隐藏）；
- 自动提取**只产候选，不自动入库**：模型从聊天里认出来的事，入库与否该由人点一下。

## 8. 路由与工具

| 方法 + 路径                    | 作用                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `GET /todos`                   | 快照（items / candidates / config / nextAutoAt / stats / capabilities）       |
| `POST /todos/create`           | 新增（title 必填；`toFeishu: true` 才在飞书建任务）                           |
| `POST /todos/update`           | `{id, patch}`，改过的字段 + 完成态写回飞书，失败回 `writeBack.warning`        |
| `POST /todos/delete`           | 删除（不删飞书任务；联动条目记 `deletedTaskIds`，不再被同步拉回）             |
| `POST /todos/sync`             | 合并飞书任务（只增改）                                                        |
| `POST /todos/config`           | `{autoSync?, autoExtract?, intervalMin?, restart?}` 自动获取配置（夹 15–360） |
| `POST /todos/advise`           | `{ids?, force?, limit≤3}` 生成建议                                            |
| `POST /todos/mute`             | 清掉这条建议并静音                                                            |
| `POST /todos/execute`          | `{id, actionId}` 执行动作                                                     |
| `POST /todos/extract`          | 从监听会话提取候选（同时落盘；回包带 `pending` 供前端直接渲染）               |
| `POST /todos/adopt`            | `{id}` 采纳一条候选（正文取服务端存过的那份）                                 |
| `POST /todos/candidates-clear` | 收起全部候选（不建待办）                                                      |

AI 工具 `feishu_todo`（与 `feishu_pro` 分开：一个"读飞书"、一个"管我自己的事"，参数面完全不同）：

```
action=list     看现在有哪些事（带 stats 与能力位）
action=add      记一条（to_feishu=true 时同时建飞书任务 —— 会真的在远程建东西，先确认）
action=update   改状态/优先级/截止（联动条目会回写飞书）
action=advise   生成建议（不执行）
action=handle   执行一个动作（kind=agent 会真跑一轮 —— 先确认）
action=mute     这条建议没用
action=sync     同步飞书任务
action=config   开关自动获取（auto_sync / auto_extract / interval_min）
```

## 9. 前端（`client/todo-view.mjs`）

**排版原则：一条待办 = 一行**（标题 + 截止 + 优先级 + 行尾图标操作），建议再占一行；
正文/步骤/历史/来源全部折叠到「▾ 展开」后面。这块不是文档阅读器，是扫一眼就要下手的清单。

| 元素        | 折叠态                                                                                   | 展开态                   |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| 标题        | 单行省略（`title` 兜底全文）                                                             | 允许换行                 |
| 正文        | 单行省略                                                                                 | 完整分行（左边框引用块） |
| AI 判断     | 单行省略 + `n 步` 小标签 + 生成时间                                                      | 完整换行                 |
| AI 步骤     | 不渲染（只显示条数）                                                                     | `<ol>` 全部              |
| 来源/发送者 | 不渲染                                                                                   | 追加到标签行             |
| 历史        | 不渲染                                                                                   | 最近 4 条                |
| 操作        | 行尾 21px 图标按钮（✦ 建议 / ✎ 编辑 / ⏸ 搁置 / ▾ 展开 / 🗑 删除），`title` + `aria-label` | 同左                     |

其它约束：

- **同步状态可见**：`ref.kind === "task"` 的条目紧凑行就有「飞书」小标签（同步了却没标出来，人会以为白联动）；
- **新建默认不同步**：输入框旁一个「飞书」勾选，默认不勾（建远程任务是显式动作）；
  `capabilities.taskWrite` 缺失时勾选框直接禁用 + `title` 说缺什么；
- **自动获取**：工具栏「⏱ 自动」+ 间隔 `select`；开启后按钮变「⏱ 自动 · 30分」并高亮，状态栏跟一行「自动每 N 分钟」；
- **候选常驻**：候选块从 `/todos` 快照渲染（不只在手动提取后），行内「记下」走 `/todos/adopt`，
  「收起」走 `/todos/candidates-clear`；
- 打字不整页重渲染：内联编辑期间 `editingId` 非空时跳过自动刷新；
- 危险动作的视觉分离：`reply` 用主色按钮（唯一会对外说话的动作），其余是普通按钮；
- 能力缺失就把按钮**禁用 + 说明缺什么**（没有 `llm` 就说"宿主未提供模型补全"），不是点了才报错；
- 派单后轮询（5s × 最多 30 次）等 `history` 里出现结果，跑完自动停并在状态栏说一句。

## 10. 回归测试

```bash
npx vitest run tests/unit/feishu-pro-todo.test.ts tests/unit/feishu-pro-todo-view.test.ts
```

`feishu-pro-todo.test.ts`（服务端与纯函数）：归一幂等、`doneAt` 与状态联动、来源去重、排序与统计、
合并飞书任务不覆盖建议、动作白名单与「无收件人不发」、`ranAt` 存活、回包解析（围栏/纯文本降级）、
CLI 适配的 flag 重试与 `writeBack:false`、**`createTask`/`updateTask` 的 body 形状与「只带显式字段」**、
**自动获取的配置夹取 / `autoNextAt` 口径 / 候选去重、落盘**、服务层的创建（含 `toFeishu` 成功与降级）、
编辑回写（只 PATCH 真改过的字段、完成走 `setDone`）、**`autoRun` 的开关门禁与失败不抛**、候选采纳。

`feishu-pro-todo-view.test.ts`（jsdom）：草稿二次确认、agent 的 confirm 取消、打勾改状态、回车新增、
候选采纳（走 `/todos/adopt`，不自己拼正文）、快照候选常驻渲染与收起、**自动开关/间隔发往 `/todos/config`**、
**新建勾「飞书」才带 `toFeishu`（无写权限则禁用）**、回写失败按错误色提示且不清列表、
同步 warning 着色、接口失败不清空列表、能力缺失时按钮禁用。
