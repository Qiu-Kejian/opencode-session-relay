# session-relay

opencode 插件：**会话接力赛跑**。处理上下文压缩临界、决策交互（进入接力模式）、链内自动交接，避免长会话被压缩劣化上下文。

- 链标识：`SR-{8hex}`，交接语内嵌链 token，新会话首条消息带 token 自动归链。
- 归链会话压缩时自动交接；未归链会话压缩前引导模型用 `question` 工具弹「进入接力 / 直接压缩」框。
- 每条交接写独立文书 `handoff/{cid}/{原始会话标题}-{日期}-交接-{n}.md`，按链分目录、链内序号递增。

## 两阶段全自动交接（v3，2026-08-27 卍解）

**核心约束**：成品交接文书由旧会话模型写（经 compacting 的 `output.prompt`），必须在**文书输出完成后**才创建新会话；且注入新会话的首条消息必须是 work-handoff skill 产出的**真实交接语**，而非硬编码话术。

| 阶段 | 触发 | 动作 |
|------|------|------|
| **Phase A** | `experimental.session.compacting`（归链会话）或 `@relay handoff` | seedDoc 骨架文书 → 设 `output.prompt`（relayPrompt）指挥本会话模型把成品文书用 Write 覆盖到精确路径。**此时不建会话**，pending 挂起在 `state.pendingHandoffs[sessionID]` |
| **Phase B（主·全自动）** | `event` 钩子监听 **`session.idle`** | 模型写完成品文书后会话进入空闲 → 自动校验文书为成品（`docIsComplete`）→ create 接力会话 → 注入交接语 → 清 pending。**用户无需任何操作** |
| **Phase B（兜底）** | `chat.message` 捕获**用户**发送的哨兵 `[RELAY_HANDOFF_DONE]` | 全自动偶发未触发时，用户可手动回复哨兵触发同一建会话+注入逻辑；文书未补全则告警且不建会话（可重发哨兵重试） |

> **全自动（2026-08-27 卍解）**：Phase B 主通道由 `event.session.idle` 触发——模型被 relayPrompt 指挥写好成品文书写后会话进入空闲，插件自动建接力会话并注入交接语，用户不再需要回复哨兵。哨兵仍保留为兜底通道（`@relay handoff` 提示也改为「写完后全自动，哨兵仅兜底」）。交接语来源优先级：①通话消息内附带的交接语 ②文书「## 交接语」节（fenced code block）③默认引导（读文书+复述要点）。

## 五大钩子（index.js）

| 钩子 | 作用 |
|------|------|
| `event` | 会话事件处理 / 状态落盘；监听 `session.idle` **全自动触发 Phase B**（校验文书成品 → 建会话 → 注入交接语） |
| `chat.message` | ① 【兜底】捕获哨兵 `[RELAY_HANDOFF_DONE]` 触发 Phase B；② 识别「进入接力模式 / 接力模式」建链；③ `@relay status` / `@relay leave` / `@relay verify` / `@relay refresh` / `@relay handoff` 命令 |
| `experimental.chat.system.transform` | 未归链会话注入 system 指令，引导模型压缩前用 `question` 工具弹接力/压缩选择框 |
| `experimental.session.compacting` | 归链会话压缩时 Phase A：seedDoc 骨架 + relayPrompt 指挥写成品文书 + 哨兵；不建会话 |
| `@relay handoff` | 手动两阶段交接命令，不依赖压缩临界，与 compacting 共用 `phaseA_startHandoff` |

核心函数：`phaseA_startHandoff(sessionID, cid)`（Phase A：骨架 + pending + 返回 relayPrompt 输入）、`phaseB_completeHandoff(sessionID, cid, docPath, docNumber, sentinelText)`（Phase B：校验成品 → create → 注入真实交接语）、`docIsComplete(docPath)`（成品校验：非骨架标记）。

## 安装（部署到桌面版）

桌面版从用户配置目录加载活插件：

```bash
# 复制项目文件到配置目录（部署位置）
cp -r index.js package.json "$HOME/.config/opencode/plugins/session-relay/"
```

在 `opencode.jsonc` 的 `plugin` 数组注册 `./plugins/session-relay`，重启桌面版生效。

> 变更流程：**在项目改 → 跑测试 → 复制回配置目录 → 重启桌面版**。
> ⚠️ 同步必须**同时包含 `index.js` 和 `package.json`**（版本号/描述与 index.js 一起演进，2026-08-27 曾漏同步 package.json 导致生产停留在 1.0.3）。同步后跑一次 `node test/test.mjs` 确认哈希一致（生产版验证：`RELAY_MAIN=<生产路径> node test/test.mjs`）。

## 开发与测试

```bash
node test/test.mjs        # 68 用例（A-I 组，两阶段）
```

- `test/test.mjs` 通过相对路径 `../index.js` 引用项目版本；用环境变量 `RELAY_MAIN` 覆盖可测其他路径（如配置目录活实例）。
- 设置 `SESSION_RELAY_DEBUG=1` 开启 compacting 钩子的 `[probe]` 探测调试日志（默认静默）。
- 故意抛错的用例（PROMPT_FAIL/CREATE_FAIL）输出 `[FAIL]` 行为预期，以尾部 `==== 结果: N 通过, 0 失败 ====` 为准。

## 自检

会话内发 `@relay verify`：探测 client 方法 + create → prompt → 轮询读回 → 写 `handoff/verify-result.json` + toast。

## 已知限制

- 会话列表 UI 不实时刷新，仅在某些自然事件或重启时 refetch；顶层会话重启后一定可见。
- 压缩临界完整端到端（真实 compacting 触发）尚未在桌面版整链实测。
- 不提交任何 token/密码；自测凭据靠环境变量。
- Phase B 主通道依赖 `session.idle` 事件在「relayPrompt 指挥写文书」这一轮结束后可靠触发；若该事件偶发未触发（或文书未被覆盖为成品），用户可回复 `[RELAY_HANDOFF_DONE]` 哨兵兜底。

## 命名约定（2026-08-27 修改）

- **接力新会话标题** = `[接力]{原始会话标题}[{n}棒]`（如 `[接力]某任务[1棒]`、`[接力]某任务[2棒]`），前缀固定 `[接力]`、后缀 `[n棒]` 标识跳号。**原始标题如已含旧 `[n棒]` 后缀会自动剥离防叠加**（2 棒标题为 `[接力]某任务[2棒]` 而非 `[接力]某任务[1棒][2棒]`）。
- **交接文书文件名** = `{原始会话标题}-{日期(YYYYMMDD)}-交接-{n}.md`（去掉 `SR-{cid}` 前缀），按链分目录置于 `handoff/{cid}/`（与 chains 键一致用完整 `SR-{8hex}`；`.relay-state.json` 状态文件仍留 `handoff/` 根，全链共享）。
- 原始标题经 `client.session.get({ path:{id} })` 读取；读取失败/为空 → 回退（标题 `[接力]{cid}[{n}棒]`、文书 `{cid}-{date}-交接-{n}.md`）。

helper：`getSessionTitle(client, sessionID)`、`sanitizeFileBase(title)`（清洗 Windows 非法字符 `<>:"/\|?*`/控制符/首尾空格点，截断 60 字符）。

## 状态文件字段（.relay-state.json）

`chains`（链 → {docs, sessions, used}）、`sessionChain`（会话 → 链）、`counts`（压缩次数）、`reminded`（已强提醒）、**`pendingHandoffs`**（v3：{sessionID → {cid, docPath, docNumber}}，Phase A 挂起、Phase B 哨兵触发后清除）。

## 运行时产物（不进项目）

`.relay-state.json` / `verify-result.json` / `refresh-result.json` / `.relay-ask.json` 生成于 opencode 项目根 `handoff/` 或 `project.root/handoff/`，由插件运行时写入。
