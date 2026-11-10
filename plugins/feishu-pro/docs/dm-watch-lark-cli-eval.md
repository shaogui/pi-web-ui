# 私聊提醒 × lark-cli event —— 可行性评估（含 spawn 成本实测）

> **已落地（0.9.3，方案 A）**：`transport: "cli" | "openapi"` 开关 + 熔断降级 + 6 类单测（实际 12 例）已实现。
> 落地时踩到一个**真实的竞态**（详见 §7），比方案本身更值得记住。
>
> **0.14.0 补注**：同一个引擎已承担**群消息同步**（`syncGroups`，与单聊各自预算：30 单聊 + 20 群）。
> 控制面从「只有 `/dm/*`」扩成 `/sync/*`（引擎状态 + 缓存自述），界面从「私聊提醒」一张卡扩成
> 「消息同步与提醒」＋ 会话页状态条。轮询语义（降序取数 / 静默基线 / 水位严格推进）一条没动 ——
> 详见 [`message-sync.md`](message-sync.md)。
>
> **0.10.27 补注**：`lib/openapi.mjs` 删除后，`transport` 开关与熔断降级一并删除 ——
> 取数通道只剩 lark-cli 一条（`resolveChannel()` 只有 ready / 不可用两态），
> `status().transport` 换成 `status().channel{cli,ready}`。本文保留作选型记录。
>
> 结论先行：**`lark-cli event` 不能替代私聊提醒**（IM 事件只覆盖机器人身份，人类账号的私聊不产生事件）；
> **但轮询可以改走 CLI**，实测 spawn 成本 25ms/次、峰值 30MB，60 秒一轮 10 个会话 ≈ 每天 6 分钟 CPU（0.4% 单核）。
> 建议：保留轮询语义，把取数通道做成 `transport: "cli" | "openapi"` 可切换，默认 CLI、OpenAPI 兜底。

## 1. 事实核对：事件模型的边界

`lark-cli event list --domain im`（1.0.99 实测，权威枚举）：

| EventKey                           | AUTH | 说明                            |
| ---------------------------------- | ---- | ------------------------------- |
| `im.message.receive_v1`            | bot  | Receive IM messages             |
| `im.message.message_read_v1`       | bot  | 用户读了**机器人发的** P2P 消息 |
| `im.message.reaction.created_v1`   | bot  | 消息被加表情                    |
| `im.message.reaction.deleted_v1`   | bot  | 表情被移除                      |
| `im.chat.disbanded_v1`             | bot  | 群解散                          |
| `im.chat.member.bot.added_v1`      | bot  | 机器人被拉进群                  |
| `im.chat.member.bot.deleted_v1`    | bot  | 机器人被移出群                  |
| `im.chat.member.user.added_v1`     | bot  | 有用户入群                      |
| `im.chat.member.user.deleted_v1`   | bot  | 有用户退群                      |
| `im.chat.member.user.withdrawn_v1` | bot  | 邀请被撤回                      |
| `im.chat.updated_v1`               | bot  | 群设置变更                      |
| （其余 im 域）                     | bot  | **12/12 全是 bot**              |

`event schema im.message.receive_v1 --json` 的关键字段：

```json
{
	"auth_types": ["bot"],
	"scopes": ["im:message.p2p_msg:readonly"],
	"required_console_events": ["im.message.receive_v1"]
}
```

**结论**：飞书的事件订阅模型里，「消息」这件事的主体是**机器人**。以我本人身份收到的私聊/群聊消息
**不产生任何事件**（`--as user` 对 `im.message.receive_v1` 不合法）。这与 `lib/dm-watch.mjs` 文件头
写下的判断完全一致 —— 现在有了 CLI 侧的权威证据，不再依赖印象。

→ 想「实时知道有人私聊我」，**没有事件可用**，只能轮询。这个边界不是实现选择，是产品能力边界。

## 2. spawn 成本实测

环境：Linux x64，`lark-cli` 1.0.94（Trae 内置那份，49 151 462 B ≈ 47 MB），Node 26。

| 指标                               | 实测                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| 单次 `--version` 串行（20 次均值） | **25.2 ms**（总 505 ms）                                              |
| 10 个并发 spawn                    | **48 ms**（并行启动，不是 250 ms）                                    |
| 并发 10 期间的**事件循环最大延迟** | **2 ms**（不阻塞宿主主线程）                                          |
| 单个 CLI 进程 RSS                  | **~30 MB**（`--version` / `auth list` / `event schema` 都在这个量级） |
| 父进程（Node）RSS 变化             | 52 MB → 52 MB（子进程独立计）                                         |
| 二进制体积                         | 47 MB（首次 cold start 后进 page cache）                              |

> 关键点：**并发 10 会瞬时占 10 × 30 MB ≈ 300 MB**。所以轮询必须**串行**（或限并发 2），
> 峰值才是 30 MB。现有 `pollOnce()` 本来就是串行 for 循环，改造时保持这一点。

## 3. 现状 vs 改造：成本对照

现有 `lib/dm-watch.mjs` 一轮做的事（`pollOnce`）：

- `autoDiscover` 打开时：最多 5 页 `im/v1/chats`（`DISCOVER_MAX_PAGES`）
- 然后**串行**遍历最多 `MAX_CHATS_PER_POLL = 10` 个会话，每个 1 次 `im/v1/messages`（page_size 20）
- 间隔 `intervalSec`（默认 60，下限 30）

| 方案                         | 每轮调用                      | 每日 spawn 次数 | 每日额外 CPU              | 峰值内存 | 凭证                      |
| ---------------------------- | ----------------------------- | --------------- | ------------------------- | -------- | ------------------------- |
| **现状**（进程内 HTTP 轮询） | 10 次 fetch（0 spawn）        | 0               | ~0                        | 0        | 需自建 OAuth + token 续期 |
| **A. 轮询改走 CLI（串行）**  | 10 次 spawn + 10 次 HTTP      | 14 400          | **≈ 360 s**（0.42% 单核） | 30 MB    | 全部交给 lark-cli         |
| **B. event 替代**            | —                             | —               | —                         | —        | ❌ 不可行（见 §1）        |
| **C. event + 轮询并存**      | 机器人事件实时 + 人类私聊轮询 | 14 400          | 同 A                      | 30–60 MB | 同 A                      |

计算口径：`1440 轮/天 × 10 次 × 25 ms = 360 s/天`。换句话说，把私聊提醒交给 CLI，
代价是**每天 6 分钟 CPU 时间**（单核的 0.4%），换来的是「不再维护一套 OAuth/token 续期」。

> 补充：如果把间隔从 60s 放宽到 120s，成本减半到 0.2%；30s 间隔下限仍是 0.84%，都在可接受范围。

## 4. 三个可选方案

### 方案 A（推荐）：轮询取数改走 CLI，OpenAPI 保留为兜底

```
dm-watch(tick)
   ├─ transport = "cli" 且 CLI 就绪 → im +chat-list（发现 p2p）+ im +chat-messages-list --start <ISO>
   └─ 否则 → 现有 im/v1/chats + im/v1/messages（进程内 fetch）
```

- 收益：凭证统一（keychain），顺带修好「p2p 会话发现」——`im +chat-list --types p2p,group` 一次就能拿到单聊，
  而旧实现要靠机器人列表 + 消息反推。
- 成本：每天 6 分钟 CPU，峰值 30 MB。
- 实施要点：
  1. `im +chat-messages-list --start <ISO8601>`：水位是毫秒，转 ISO 即可；`--order asc` 对应现有的 `ByCreateTimeAsc`；
  2. **保持串行**，不要为了省时间并发 10 个 spawn（瞬时 300 MB）；
  3. `--no-reactions`（默认会额外查表情，轮询场景纯浪费）；
  4. 单会话失败只记 `lastError`（现有行为），**不要**因为一个会话 spawn 失败就让整轮降级成 OpenAPI；
  5. 首次仍然只建基线、水位严格递增、`seen` 去重 —— 这三条是现有单测钉住的，不许动。

### 方案 B：保持现状（OpenAPI 轮询）

- 优点：零新增成本，`dm-watch` 682 行一行不改。
- 缺点：`lib/oauth.mjs` / `tokens.mjs` / `app-registration.mjs`（约 1200 行）**永远删不掉**，
  设置页「连接应用 / 个人授权」两块旧卡片也得留着 —— 与「彻底改用 lark-cli」的目标冲突。
- 适合：短期不想动、或企业部署仍依赖自建 App 的场景。

### 方案 C：新增「机器人事件提醒」（可选增强，不是替代）

`lark-cli event consume im.message.receive_v1 --as bot` 可以**实时**收到机器人所在会话的消息
（群 @、人×机器人单聊），这是旧实现做不到的能力：

- 常驻一个 consume 进程：RSS ~30 MB（多个 EventKey 共享一个 bus daemon，UDS 本地 IPC）；
- 用 `--jq` 在 CLI 侧过滤，stdout 是 NDJSON，插件只需按行解析；
- 关闭时**必须 SIGTERM 或关 stdin**（stdin EOF = graceful exit），`kill -9` 会泄漏服务端订阅；
- 定位是**新能力**（机器人提醒），不能替代人类私聊轮询。

## 5. 建议

1. **不做 event 替代**（方案 B 与 §1 的结论存在硬冲突）。
2. **做方案 A**：`dm-watch` 增加 `transport` 开关，默认 `cli`、兜底 `openapi`；约 120 行改动 + 6 个单测
   （markdown→ISO 时间转换、串行保证、单会话失败隔离、CLI 不可用回落、`--no-reactions` 存在性、水位不变）。
3. **方案 C 单独立项**（可选）：新增「机器人提醒」开关，用事件；与私聊提醒并列，各自独立的开关和文案。
4. 方案 A 完成后，`lib/oauth.mjs` / `tokens.mjs` 仍**不能马上删** —— 它们还是所有 `viaCli` 失败时的回落路径。
   真正删除需要一个「CLI-only 模式」开关（`PI_WEB_LARK_CLI_ONLY=1`）和一次全链路验收。

## 6. 风险与反直觉项

| 风险              | 说明                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 并发 spawn 内存   | 10 并发 = 瞬时 300 MB，**必须串行**；这条比 CPU 更值得写进注释                                                                            |
| keychain 读取代价 | 每次 spawn 都会读一次凭证（Linux 走文件 / secret service），已含在 25 ms 内；若某环境 keychain 慢，24ms 会变成 200ms+，建议实测后再定间隔 |
| 水位精度          | CLI 的 `--start` 是 ISO 8601（秒级），现有水位是毫秒 → 转换时要向上取整（现有 `buildMessageQuery` 已有这个处理，别丢）                    |
| 进程风暴          | 若某轮 10 个会话都超时，会连开 10 个 CLI；给每次 spawn 加 20s 超时 + 熔断（连续 3 轮全失败 → 自动切回 `transport: openapi` 并在界面提示） |
| 事件泄漏订阅      | 只有方案 C 涉及；SIGTERM/关 stdin，绝不 `kill -9`                                                                                         |

## 7. 落地记录（0.9.3）

实现与上面方案的差异，以及踩到的坑：

1. **通道被抽成窄接口**：`createDmCliChannel({ run, isReady })` 只暴露 `ready / listChats / fetchMessages`，
   轮询引擎不知道 CLI 命令怎么拼；归一化仍走 `dm-watch` 的 `normalizeChatItems`（单一入口，两个通道行为一致）。
2. **身份要透传**：`listChats({ identity })` / `fetchMessages(chatId, { …, identity })` —— 机器人身份必须退回只列群
   （`--types group`），否则 CLI 直接拒绝。
3. **熔断是「整轮全失败」才计数**：单会话失败只记 `chatErrors[chatId]`（原有语义），
   连续 `CLI_FAIL_LIMIT = 3` 轮每一轮都全失败才降级，避免偶发抖动把提醒通道切走。
4. **`status().transport` 四个字段**：`configured`（用户选的）/ `effective`（现在会用的）/ `degraded`（熔断中）/
   `cliReady`（最近一次可用性观测）—— 界面据此显示「通道 lark-cli / 已回落 / 连续失败 N 轮已降级」，不静默切换。
5. **`--start` 的秒级口径**：`watermarkToIso()` 向下取整到秒（与 `buildMessageQuery` 的 `floor` 一致），
   宁可多取边界那一秒靠 `seen` 去重，也不向上取整漏消息。

### ⚠️ 踩到的坑：`polling` 占位晚了一步

改造前 `pollOnce` 的第一段没有 `await`：
`检查 enabled → 检查 client → 检查 polling → polling = true`。
改造后在 `polling = true` 之前插入了 `await resolveChannel()`（CLI 可用性探测），于是出现窗口：

```
pollOnce(A) ── await resolveChannel() ────────────────┐
whenIdle()  ── polling 还是 false → 立刻返回「已空闲」  │
pollOnce(B) ── 也看到 polling=false → 两个轮询并发拿同一水位
```

症状是**水位被覆盖 / 首次基线丢失**（现有 4 个 dm-watch 用例直接红了）。
修法：把 `polling = true` 提到 `resolveChannel()` **之前**，失败分支里手动 `polling = false`。
结论：任何「先 await 再置忙标志」的改法都是错的 —— 占位必须同步、最先。

## 8. 0.10.21 修正：取数方向反了（`--order asc` → `desc`）

上面 §4/§6 写的「`--order asc` 对应现有的 `ByCreateTimeAsc`」是**错的**，而且旧实现本身就是错的：

| 场景                                  | `asc`（0.10.20）                                                                   | `desc`（0.10.21）                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| 首次建基线（无 `--start`）            | 返回**会话历史最旧一页**（实测本机某群是 2025-08-08 的开群消息）→ 基线钉在开聊那天 | 返回最新一页 → 基线落在「现在」                    |
| 增量（有水位）                        | 返回水位之后**最旧一页**，积压 100 条只报最旧 20 条，每轮前进 20 条                | 返回**最新一页**，水位对齐最新，只能看见最近的消息 |
| 积压超过 3×50                         | 永远追不上（提醒与未读数持续滞后）                                                 | 只报最近 150 条 + 日志告警，剩余视为历史           |
| `create_time` 只有分钟精度 → 边界漏报 | 严格 `>` 会漏掉与水位**同一分钟**的消息                                            | 「不旧于水位」+ `seen` 去重（基线那一页也写 seen） |

实测（2026-11-06，真实账号）：`im +chat-messages-list --order desc --start <ISO>` 的 dry-run 请求为
`sort_type=ByCreateTimeDesc&start_time=<epoch 秒>`，分页靠 `--page-token`（`data.has_more` /
`data.page_token`）；翻到「本页最旧一条已在水平之前」就停，不白 spawn 一次 CLI。

**另一个已知坑（本插件改不了）**：CLI 的 `+chat-messages-list` 固定带 `only_thread_root_messages=true`，
即**话题（thread）里的回复不会出现在结果里**。所以群话题里的消息既不提醒也不计未读；
要覆盖它只能放弃 CLI 直连 OpenAPI（`transport: "openapi"`），代价是重新维护一套 OAuth/续期。
