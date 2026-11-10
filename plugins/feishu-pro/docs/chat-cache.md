# 会话消息本地缓存（`lib/chat-cache.mjs`，0.13.0）

需求原话（用户提的三点，逐条对应到实现）：

1. 「选中会话要等一会儿数据才出来」→ **缓存优先**：打开会话先渲染缓存，网络在后台补；
2. 「后台定时获取」和「点会话拉取」**重复了** → **一个落点**：谁拉到消息都写同一份缓存；
3. 「获取的内容要能被快速二次检索加工」→ 读出口统一 + `GET /chat/search` / `feishu_pro.im_search`。

## 1. 为什么以前慢

```
点会话 → GET /chat/messages
        ├─ lark-cli im +chat-messages-list   （子进程 + 网络，1–3s）
        └─ lark-cli contact +search-user     （再 1–3s，仅为了补发言人姓名）
切回来 → 同样的两条再来一遍
后台轮询 → 又是自己的一套（只算未读，内容丢在 `dm_watch_history` 里，界面用不上）
```

三个问题：**每次都现拉**、**同一批消息拉两遍**、**拉回来的内容只服务当下这一屏**。

## 2. 现在长什么样

```
                  ┌──────────────── chatCache (落盘: chats_msg_cache) ────────────────┐
dm-watch 轮询 ────┤ put(source=poll)   ← 私聊 + 群（同一个引擎，见 message-sync.md）    │
界面打开会话 ─────┤ put(source=ui)      ←── 只有一个写入点（put）                     │
AI im_messages ───┤ put(source=ui)                                                  │
                  └──────────────┬───────────────────────────────────────────────────┘
                                 │ 读
        ┌────────────────────────┼─────────────────────────┐
   GET /chat/messages      GET /chats（最后一条）     GET /chat/search / im_search
```

- **写**：`lib/dm-watch.mjs` 的 `onFetched` 钩子（后台每轮每个会话一页；0.14.0 起群聊也走这里，
  `kind: "p2p" | "group"` 随回调带出）、`fetchChatIntoCache`（界面 / AI）。
- **读**：`chatMessagesPayload()`（`index.mjs`）是唯一出口，路由、AI 工具、自动问答预览共用。
- **检索**：`searchChatCache()` 纯函数，界面搜索框与 `im_search` 都调它。

## 3. 关键取舍（照着改之前先读这一节）

| 取舍                                                               | 理由                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有缓存就立刻回，`cache.refreshing=true` 表示后台在补               | 前端收到后 800ms 再问一次，「秒开」与「新鲜」都要                                                                                                                                                                                 |
| **先补一屏，再谈增量**（`entry.full`）                             | 增量（`--start <缓存最新一条>`）只带得回「更新的那几条」，**补不进缓存里没有的历史**；而水位比缓存活得久（见 [`message-sync.md`](message-sync.md)）。没这个前提就会出现「同步一直在跑，缓存里每个会话却永远只有 1 条」（见 §4.2） |
| 增量拉取用 `--start <缓存最新一条>`                                | 刷新通常只回 1–3 条，不必每次搬整页 40 条 —— 但**只对已经补过一屏的会话成立**                                                                                                                                                     |
| 同一 chatId **单飞** + 3s 最小间隔                                 | 前端 5s 轮询 + 后台轮询 + 用户点击会同时打进来                                                                                                                                                                                    |
| 翻旧页（`pageToken`）**不走缓存**                                  | 缓存只有「最近一段」，且返回的必须是那一页，不是最新一屏                                                                                                                                                                          |
| 姓名只查**缺的**、查完记 7 天                                      | CLI 的消息里通常已带 `sender.name`；以前每次读消息都额外 spawn 一次 CLI                                                                                                                                                           |
| 每会话 60 条 / 单会话 32KB / 60 会话 / **整份 1.25MB** / 14 天 TTL | `host.storage` 是**一整个 JSON 文件**，同步整文件读改写；真机实测有会话 40 条就 260KB（单条 44KB 长推文），所以单条、单会话、整份三层都按字节裁；60 个会话是「一轮轮询 30 单聊 + 20 群」的容量下限（见 §4.1）                     |
| 单条 `text` ≤1200 字 / `richText` ≤1600 字                         | 界面一屏用不了那么长；更长的回源再看，别让一条长推文占满整个文件（0.14.1 从 2400 降到 1600：省下的字节换「更多会话留在缓存里」）                                                                                                  |
| 落盘防抖 5s + **内容没变不落盘** + 卸载时 flush                    | 运行时读内存，落盘只为「重启后还在」；增量轮询大多轮次拉回的是同几条（`--start` 边界重叠），不判重就会每轮白写一次 MB 级文件（真机实测：判重后 8 次落盘 → 3 次）                                                                  |
| 缓存读失败一律降级成空缓存                                         | 它只是加速层，任何异常都不该让「读消息」失败                                                                                                                                                                                      |

## 4. 接口

| 路由                                                     | 说明                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /chat/messages?chatId=&limit=&refresh=1&pageToken=` | 缓存优先；`refresh=1` 强制现拉；`pageToken` 翻旧页                                     |
| `GET /chat/search?q=&chatIds=&limit=&since=`             | 只翻本地缓存（<2 字不搜），返回命中片段 `snippet`                                      |
| `GET /chat/cache`                                        | 会话数 / 行数 / 时间跨度 / 占多大                                                      |
| `POST /chat/cache/clear`                                 | 清空（下次读会重新拉）                                                                 |
| `GET /sync/state` · `POST /sync/{config,run,clear}`      | 消息同步控制面：引擎状态 + 缓存自述合成一份（见 [`message-sync.md`](message-sync.md)） |

返回体里的 `cache` 字段是给界面看的自述：

```json
{ "rows": 120, "ageMs": 3200, "updatedAt": 1730000000000, "source": "poll", "refreshing": true, "error": "" }
```

AI 侧：

- `feishu_pro.im_messages` → 走同一条缓存路径，`via: "cache"` 表示**没有**打飞书接口；`refresh=true` 才强制拉；
- `feishu_pro.im_search` → 纯本地检索（`via: "cache"`），适合「刚才那句是谁说的 / 那条链接在哪」。

同步范围（哪些会话会被后台写进来）由 [`message-sync.md`](message-sync.md) 定义：手填 → 自动发现单聊 → 自动发现群。
群同步默认关，打开后群消息与私聊共用同一份水位与同一份缓存。

待办提取（`lib/todo-service.mjs` 的 `extract()`）也吃这份缓存：**来源是全局的**，不只看监听名单
（监听之外的群聊 / 私聊只要有缓存就能被找待办）。`readMessages({cacheOnly:true})` 读缓存零网络，
所以一次能扫 8 个会话；只有「本地一条都没有」的会话才回源 CLI，且一轮最多 2 个。

### 4.1 容量必须盖得住一轮轮询（0.14.1 修）

`CHAT_CACHE_CHATS` 曾固定 24，而一轮后台轮询会写 `30 单聊 + 20 群 = 50` 个会话。
候选顺序是 **手填 → 单聊 → 群**，于是每轮最后写进去的群刚好被 `pruneChatCache` 剪掉：
现象就是「同步日志在跑、缓存里却只有私聊」，群消息永远进不了缓存（列表没预览、搜不到）。

现在两道闸各管一段：**会话数 60**（≥ 一轮候选数，留余量给手动打开过的会话）、
**整份 1.25MB**（真正限制体积的那道）。不变式钉在
`tests/unit/feishu-pro-chat-cache.test.ts`：`CHAT_CACHE_CHATS >= MAX_CHATS_PER_POLL + MAX_GROUPS_PER_POLL`。

### 4.2 增量存储的前提：每个会话先补一屏（0.14.1 修）

真机看到的现象：同步日志每轮都在跑，但 `chats_msg_cache` 里 **24 个会话几乎全是 1 条**，
打开会话只看到一条消息，检索也翻不出东西。

根因不是「没写」，是「**只写了增量**」：

1. 水位（`dm_watch_state`）是 0.10 就有的，缓存是 0.13 才加的 —— 新装 / 升级时水位早就指向「现在」；
2. 于是首轮轮询走的是 `--start <水位>`：返回的只是「更新的那几条」（叠上边界重叠，正好 1 条）；
3. 写进缓存后 `newestMs` = 那一条，之后每次读会话又按 `newestMs` 走增量 —— 缓存里**原本没有的历史永远补不进来**。

所以每个会话多一个 `full` 标记（「整页拉过一次」）：

| 位置                               | 行为                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `chatCache.needsBackfill(chatId)`  | 没有条目 / 没有 `full`（且行数 < `CHAT_CACHE_FULL_ROWS=40`）→ `true`                                       |
| `dm-watch` 的 `needsBackfill` 钩子 | 这一轮对该会话**不带 `--start`**（拉最新一页，`maxPages=1`），`onFetched({backfill:true})` 让宿主置 `full` |
| `fetchChatIntoCache`（界面 / AI）  | 只在 `meta.full` 为真时才算增量；否则整页拉一次，并在「最新那一页」时置 `full`                             |
| `chatMessagesPayload`              | 缓存没满一屏就**必然**触发一次后台补拉（不管它「新不新」），前端 800ms 后拿到整屏                          |

成本：**0 次额外 CLI 调用** —— 这一轮本来就要拉这个会话，只是把「增量」换成「最新一页」；
通知口径也不变（`pickNewMessages` 仍按水位过滤，补屏带回来的历史不会被当成新消息弹出来）。
升级迁移：老缓存没有 `full`，`normalizeChatCache` 按行数反推（≥ 一屏就当补过），
只有真正「薄」的会话会被补一次；`POST /chat/cache/clear` 之后下一轮自然全部重补。

不变式：`tests/unit/feishu-pro-chat-cache.test.ts`（`full` 标记与 `needsBackfill`）+
`tests/unit/feishu-pro-message-sync.test.ts`（补屏时 `startMs=0`、带回 `backfill=true`、水位照推且不误报）。

## 5. 数据形状

```js
// chats_msg_cache
{
  version: 1,
  chats: {
    "oc_xxx": {
      id, rows: [ { id, chatId, senderId, senderType, senderName, msgType,
                    imageKey, richText, text, createTimeMs, mentions, systemTemplate } ],
      full, // 「整页拉过一次」→ 之后才允许走增量（见 §4.2）
      newestMs, hasMore, pageToken, source, selfOpenId, fetchedAt, updatedAt
    }
  }
}
// chats_names_cache
{ "ou_xxx": { name: "张三", at: 1730000000000 } }
```

行只留「界面 / 检索 / AI」真正要用的字段 —— 一条飞书消息整包几 KB；单条正文与单会话总量都截断，
否则一个长推文群就能把插件的 `storage.json` 顶到几 MB（而它每次写入都是整文件同步读改写）。
`self` / `senderLabel` / `preview` **不落盘**，读的时候按当前身份与姓名缓存重算（`decorateMessageRow`）。

## 6. 单测

`tests/unit/feishu-pro-chat-cache.test.ts`：合并去重、空字段不覆盖、上限裁剪、TTL、检索命中与片段、
姓名过期、坏数据不抛错、防抖落盘与重启读回、`full` 标记（含升级迁移）与 `needsBackfill()`。
