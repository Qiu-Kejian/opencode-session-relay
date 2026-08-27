# 工作流程图

三类归一化流程：**决策**、**全自动交接**、**降级**。

## 总览

```mermaid
flowchart TD
    A[会话即将压缩<br/>experimental.session.compacting] --> B{该会话已归链?}
    B -- 否 --> C{同会话已首次强提醒?}
    B -- 是 --> D{该会话已交接过 used?}
    C -- 否 --> E[强提醒: 决策 toast<br/>回复「进入接力模式」=交接<br/>默认压缩]
    C -- 是 --> F[轻提醒: 默认压缩<br/>可随时切换接力]
    D -- 是 --> G[return 不重复交接]
    D -- 否 --> H[执行全自动交接]
    E --> I[放行压缩]
    F --> I
    I --> J[原生压缩]
```

## 全自动交接（核心路径）

```mermaid
flowchart TD
    A[归链会话压缩] --> B[写 state:<br/>used + docs 追加 docPath]
    B --> C[client.session.create<br/>接力会话]
    C --> D{create 成功且 sId 有效?}
    D -- 否 --> EF[降级: 输出半自动交接语<br/>warning toast]
    D -- 是 --> G[output.prompt = relayPrompt<br/>当前会话写交接文书<br/>到确定性 docsPath]
    G --> H[client.session.prompt 注入首消息<br/>含链标识 + 时序握手 sleep/重试]
    H --> I{注入成功?}
    I -- 否 --> J[保留已建会话 + warning<br/>提示手动打开读文书]
    I -- 是 --> K[toast: 自动接力已创建]
```

## 用户侧流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant C as 当前会话(旧)
    participant P as 插件
    participant N as 接力会话(新)
    U->>C: 回复「进入接力模式」
    P->>P: 建链 SR-xxxx, 归链
    C->>P: session.compacting
    P->>N: session.create 接力会话
    P->>C: 写交接文书 docs/xxx-交接-1.md
    P->>N: prompt 注入首消息(sleep+重试读文书)
    N->>N: 读到文书, 复述要点, 用户确认后继续
```

## `@relay` 命令

```mermaid
flowchart LR
    A[@relay status] --> B[显示当前链: 跳数/归链会话/文书索引]<br/>C[@relay leave] --> D[退链<br/>下次压缩重新提示决策]
```
