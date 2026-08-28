# 架构设计

`session-relay` 的核心目标：**让一条接力链内的会话在连续工作时"零压缩劣化"。**

## 1. 要解决的问题

LLM 助手（如 OpenCode）上下文有上限，且公司模型上下文有限（如 deepseek-v4-flash 上限 200K）。会话过长触发**压缩（compaction）**时会生成摘要续跑，但摘要会丢失细节、让任务背景失真。本插件在最痛的时点——会话即将压缩前——截获它，改为**交接**：

- 把关键上下文落成一份**交接文书**（Markdown 文件）
- 文书写完后**全自动创建**一个新会话继续
- 用**接力链标识 `SR-{8hex}`** 把后续会话串成一条链，链内继续交接就不再询问

结果：同一条链内的工作在完整、未劣化（未压缩）的上下文中连续推进。

## 2. 核心概念

| 概念 | 说明 |
|------|------|
| **接力链 (chain)** | 一条连续工作的完整语义单元，标识 `SR-{8hex}`（8 位 hex）。链内所有会话自动接力。 |
| **跳 (hop/docNumber)** | 链内每次交接为「一跳」，产生一份文书，序号从 1 递增。 |
| **归链 (sessionChain)** | 会话 → 链 的映射。归链后的会话压缩走「自动交接」，不再询问。 |
| **决策 (denoise)** | 未归链会话压缩前提示「交接 / 压缩」；同会话首次强提醒(warning)，之后轻提醒(info)。 |
| **pendingHandoffs** | v3 两阶段挂起表：Phase A 挂起、Phase B（session.idle 或哨兵）触发后清除。 |

## 3. 数据模型

状态文件：`{项目根}/handoff/.relay-state.json`（全链共享）

```jsonc
{
  "chains": {
    "SR-xxxxxxxx": {
      "docs": [".../handoff/SR-xxxxxxxx/原始会话标题-20260827-交接-1.md"],
      "sessions": ["ses_..."],          // 归链会话 ID 列表
      "used": ["ses_..."]              // 已完成交接的会话（不重复交接）
    }
  },
  "sessionChain": { "ses_...": "SR-xxxxxxxx" },  // 会话 → 链 映射
  "counts": { "ses_...": 2 },                    // 各会话压缩次数
  "reminded": ["ses_..."],                        // 已做过首次强提醒的会话
  "pendingHandoffs": {                            // v3：Phase A 挂起表
    "ses_...": { "cid": "SR-xxxxxxxx", "docPath": "...", "docNumber": 1 }
  }
}
```

**文书路径（v2 起按链分目录）**：`handoff/{cid}/{原始会话标题}-{YYYYMMDD}-交接-{n}.md`。

- `cid` 用完整 `SR-{8hex}`，与 `chains` 键一致；`.relay-state.json` 状态文件仍留 `handoff/` 根。
- 原始标题经 `client.session.get({path:{id}})` 读取；读取失败/为空 → 回退：文书基名 `{cid}-{date}-交接-{n}.md`。

## 4. 事件/钩子处理

插件是 `function SessionRelay()` 配置函数，返回钩子对象：

| 入口 | 触发时机 | 职责 |
|------|---------|------|
| `event` | 会话事件 | `session.compacted` 累加 `counts`；**`session.idle` 全自动触发 Phase B** |
| `chat.message` | 用户消息 | ① 【兜底】捕获哨兵 `[RELAY_HANDOFF_DONE]` 触发 Phase B；② 识别「进入接力模式 / 接力模式」建链；③ `@relay status/leave/verify/refresh/handoff` 命令 |
| `experimental.chat.system.transform` | 未归链会话 | 注入 system 指令，引导模型压缩前用 `question` 工具弹「进入接力 / 直接压缩」框 |
| `experimental.session.compacting` | 归链会话即将压缩 | Phase A：seedDoc 骨架 + `output.prompt`(relayPrompt) 指挥写成品文书；**不建会话** |
| `@relay handoff` | 手动命令 | 手动两阶段交接，不依赖压缩临界，与 compacting 共用 `phaseA_startHandoff` |

## 5. 关键设计决策（ADR 精简）

### ADR-1 用接力链标识做路由，而非全局/按项目
- **问题**：如何识别"新会话应接哪条链"？
- **选择**：在交接语义内嵌 `SR-{8hex}`；新会话首条消息含该 token → 插件据此归链。
- **理由**：纯插件侧唯一可靠的跨会话路由信号；链间互不影响，可从各自压缩节点独立进入交接。

### ADR-2 两阶段全自动交接（v3）：文书先完成，会话后创建
- **问题**：新会话如何读到"还没写出的交接文书"？
- **选择**：Phase A 只落骨架 + 挂起 pending、设 `output.prompt` 指挥模型写成品文书；**先不建会话**。文书写好后会话进入空闲 → `event.session.idle` 触发 Phase B 建会话并注入真实交接语（用户无需操作）。
- **理由**：杜绝"文书未写完就建会话导致新会话读不到"的时序竞态；文档完成度由 `docIsComplete` 校验（非骨架标记）。

### ADR-3 部分失败分离（不留幽灵会话）
- **问题**：create 成功但注入失败，或 create 失败？
- **选择**：
  - create 失败 → 完整降级**半自动**（输出可复制交接语），不建会话。
  - create 成功 + 注入失败 → **保留已建会话** + warning 提示，不产生重复会话。
- **理由**：避免"建了会话却空转"或"提示用户再建一个"的矛盾。

### ADR-4 交接文书路径确定性
- **问题**：插件事先不知道文书最终路径，无法在注入时告诉新会话读哪个文件。
- **选择**：插件**接管路径命名**为 `handoff/{cid}/{原标题}-{date}-交接-{n}.md`（`n` 由 `docs.length+1` 确定性算出），`relayPrompt` 命令当前会话"必须写入该精确路径"。
- **理由**：新旧会话引用的路径完全一致，消除歧义。

### ADR-5 零硬编码 / 跨平台
- 路径一律用 `join(directory, ...)`；不再写死任何绝对盘符（如 `E:\dev`）。接链标识与触发词可配；不依赖具体项目目录。使包可通用发布。

## 6. 可靠性

- 状态读写单文件，`loadState` 损坏时安全重置。
- 所有入口 `try/catch`；异常双通道（`client.app.log`/console + toast）。
- `docIsComplete(docPath)` 校验文书为成品（去除骨架标记）才放行 Phase B；文书未补全 → 告警且不建会话（可重发哨兵重试）。
- 标题读取失败/为空 → 基名回退 cid，保证链路不中断。

## 7. 可扩展点

- 自定义交接模板：改 `index.js` 的 `relayPrompt` 系列函数。
- 新触发词：`config.enterRegex` / `config.compactRegex`（`examples/opencode.jsonc` 示例）。
- 自定义交接目录：`config.handoffDir`。
