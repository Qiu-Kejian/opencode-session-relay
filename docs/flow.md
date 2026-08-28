# 工作流程图

三类归一化流程：**决策**、**两阶段全自动交接（核心）**、**降级**。

## 总览

```mermaid
flowchart TD
    A[会话即将压缩<br/>experimental.session.compacting] --> B{该会话已归链?}
    B -- 否 --> C{同会话已首次强提醒?}
    B -- 是 --> D{该会话已交接过 used?}
    C -- 否 --> E[强提醒: 决策 toast<br/>回复「进入接力模式」=交接<br/>默认压缩]
    C -- 是 --> F[轻提醒: 默认压缩<br/>可随时切换接力]
    D -- 是 --> G[return 不重复交接]
    D -- 否 --> H[两阶段全自动交接 Phase A]
    E --> I[放行压缩]
    F --> I
    I --> J[原生压缩]
```

## 两阶段全自动交接（核心路径，v3）

```mermaid
flowchart TD
    A[归链会话压缩<br/>或 @relay handoff] --> B[Phase A<br/>seedDoc 骨架文书 + 挂起 pending]
    B --> C[设 output.prompt=relayPrompt<br/>指挥本会话模型<br/>Write 覆盖为成品文书]
    C --> D[Phase A 不建会话<br/>pending 挂起 state.pendingHandoffs]
    D --> E{文书被模型覆盖为成品?<br/>event.session.idle}
    E -- 是 --> F[Phase B 主通道<br/>docIsComplete 校验 → create 接力会话<br/>→ 注入真实交接语 → 清 pending]
    E -- 否/未触发 --> G[兜底: 用户回复哨兵<br/>[RELAY_HANDOFF_DONE]]
    G --> H{docIsComplete 校验}
    H -- 是 --> F
    H -- 否 --> I[告警: 文书未补全<br/>提示先补全, 可重发哨兵重试]
```

## 用户侧流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant C as 当前会话(旧)
    participant P as 插件
    participant N as 接力会话(新)
    U->>C: 回复「进入接力模式」
    P->>P: 建链 SR-{8hex}, 归链
    C->>P: session.compacting (Phase A)
    P->>C: output.prompt 指挥写交接文书
    C->>C: 模型 Write 覆盖为成品文书
    C->>P: session.idle
    P->>N: session.create 接力会话
    P->>N: prompt 注入首消息(真实交接语: 读文书+复述要点)
    N->>N: 读到文书, 复述要点, 用户确认后继续
```

## `@relay` 命令

```mermaid
flowchart LR
    A[@relay status] --> B[显示当前链: 跳数/归链会话/文书索引]
    C[@relay leave] --> D[退链<br/>下次压缩重新提示决策]
    E[@relay verify] --> F[自检: 探测 client 方法 + create→prompt→读回]
    G[@relay refresh] --> H[触发会话列表刷新]
    I[@relay handoff] --> J[手动两阶段交接<br/>不依赖压缩临界]
```
