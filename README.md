# opencode-session-relay

**会话接力赛跑** —— 让 OpenCode 在上下文压缩前"交接"而不是"压碎"。

LLM 助手的上下文有上限。会话太长时触发**压缩（compaction）**，背景会劣化、任务会失真。这个插件在最痛的时点——会话即将被压缩前——截获它，把关键上下文**落成一份交接文书**，并自动（或半自动）创建一个新会话继续，让一条**接力链**内的所有会话**零压缩劣化**地连续工作。

## 特性

- **决策时机**：未归属接力链的会话即将压缩时，toast 提示你选择「交接」或「压缩」。选压缩走原生流程，下次仍可再决策（不锁死）。
- **接力链**：进入交接会建立一条链（标识 `SR-xxxxxxxx`）。链内所有会话自动接力、不再询问；多链互不影响。
- **全自动**：归链会话压缩时，自动 `session.create` 创建接力会话并 `session.prompt` 注入交接指令（含时序握手：新会话等待并重试读取文书）。
- **可靠降级**：创建失败 → 输出可复制的半自动交接语；注入失败 → 保留已建会话并警告（不产生重复会话）。
- **状态可感知**：`@relay status` 查看当前链、`@relay leave` 退链。
- **降噪**：同一会话首次压缩强提醒，之后轻提醒。
- **跨平台**：路径用 `join()`；`handoffDir` 可配置。

## 安装

1. 把 `index.js` 复制到任意位置（例如放本项目内），或直接引用本仓库。
2. 在 `opencode.jsonc`（项目根或 `~/.config/opencode/opencode.jsonc`）的 `plugin` 数组注册：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./plugins/session-relay"
  ]
}
```

把路径指向包含 `index.js` 的目录。

## 配置（可选）

插件通过 `ctx.config` 接收配置，默认值如下：

| 键 | 默认 | 说明 |
|----|------|------|
| `handoffDir` | `handoff` | 交接文书与状态文件存放目录（相对项目根） |
| `enterRegex` | `/进入接力\|接力模式/` | 显式「进入接力」的触发词 |
| `compactRegex` | `/压缩模式\|进入压缩\|改用压缩\|改为压缩/` | 显式「走压缩」的触发词 |

示例（自定义交接目录）：

```jsonc
{
  "plugin": [{
    "path": "./plugins/session-relay",
    "config": {
      "handoffDir": ".handoff"
    }
  }]
}
```

> 具体配置注入方式以你的 OpenCode 版本/使用方式为准；`ctx.config` 为传入的配置对象。

## 使用

### 第一次：决策
未归属链的会话即将压缩时，弹出提示。你可以：

- 回复 **`进入接力模式`** → 建立接力链，此后同链会话自动接力。
- 回复 **`压缩模式`** → 走原生压缩，下次仍可再决策。
- 什么也不做 → 默认压缩，落一条文书由插件写入（半自动态仅供参考）。

### 全自动接力中
归链会话压缩时，插件自动创建 `[接力] SR-xxxx → n` 会话并注入交接首条消息。新会话会被识别为接力会话，通读交接文书后继续。

### 命令
- `@relay status` — 查看当前会话所属接力链的状态（跳数、归链会话、文书索引）。
- `@relay leave` — 本会话退出当前接力链；下次压缩会重新提示决策。

## 数据与文件

- 状态文件：`{项目根}/{handoffDir}/.relay-state.json`
- 交接文书：`{项目根}/{handoffDir}/{链标识}-{日期}-交接-{n}.md`（每跳一份，序号递增）
- 底层依赖：依赖 OpenCode 的 `client.session.create` / `client.session.prompt`（桌面版）。若不可用会自动降级半自动。

## 文档约定

交接文书模板：插件内嵌通用版。你可以结合自家 `AGENTS.md` 的交接规范，或自定义 `relayPrompt`（本项目 `index.js` 末端的模板函数）。

## 测试

```bash
node test/test.mjs
```

覆盖：建链/归链、自定义 `handoffDir`、全自动三态（成功 / 注入失败保留 / 创建失败降级）、`@relay` 命令、决策降噪、链内多跳状态机。

## 文档

- [架构设计](./docs/architecture.md) — 核心概念、数据模型、ADR、可扩展点
- [工作流程图](./docs/flow.md) — 决策 / 全自动交接 / 降级 / 命令（Mermaid）
- [依赖的能力](./docs/capabilities.md) — ctx、hook/event、SDK 方法、平台差异、能力矩阵
- [测试说明](./docs/testing.md) — 用例分组、mock、回归策略

## 许可

[MIT](./LICENSE)
