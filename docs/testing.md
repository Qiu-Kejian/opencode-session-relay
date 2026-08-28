# 测试

运行方式：

```bash
node test/test.mjs
```

无外部框架，纯 Node 断言与 mock `client`，可在无 OpenCode 环境跑（用临时目录做状态沙盒）。

- `test/test.mjs` 通过相对路径 `../index.js` 引用项目版本；用环境变量 `RELAY_MAIN` 覆盖可测其他路径（如配置目录活实例）。
- 设置 `SESSION_RELAY_DEBUG=1` 开启 `experimental.session.compacting` 钩子的 `[probe]` 探测调试日志（默认静默）。
- 故意抛错的用例（PROMPT_FAIL/CREATE_FAIL）会输出 `[FAIL]` 日志，属预期行为；以尾部 `==== 结果: 68 通过, 0 失败 ====` 为准。

## 用例分组（A-I，68 用例）

### A. 两阶段全自动链路（v3）
- `0a/0b` 建链 + 归链
- `A1` Phase A：seedDoc 骨架、pending 挂起、docPath 用 `handoff/{cid}/{原标题}-{date}-交接-{n}.md`（含 cid 目录层）、不建会话（create=0）、后经 session.idle 全自动 Phase B（create=1）并清 pending
- `A2` create 成功 + 注入失败 → 保留会话 + warning，**不降级半自动**
- `A3` create 失败 → 降级半自动（交接语）+ warning，清 pending
- `A4`（全自动）压缩→Phase A→模型写完文书→`session.idle` 自动 Phase B，**无需用户哨兵**

### B. `@relay` 命令 + 决策降噪
- `B1` 未归链 `@relay status` → 提示未归属
- `B2` 归链后 `@relay status` → 显示链信息（含 `SR-`）
- `B3` `@relay leave` → 清 sessionChain
- `B4/f` 首次压缩强提醒(warning) → 二次轻提醒(info)；归链会话不注入决策

### C. 通用性 / 去硬编码（源码静态断言）
- `C1` 无 `E:\dev` 硬编码；用 `join(directory, ...)` 拼 docPath；防双反斜杠规避

### D. 状态机多跳
- `D1` 第一跳 docs=1
- `D2` used 已含后 docs 不增、used 不重复
- `D3` 第二跳 docs=2

### E. 系统指令决策注入
- `E1` 未归链会话注入决策指令（含「进入接力 / 直接压缩」选项）
- `E2` 不注 SessionID 保持单分派
- `E3` system 非数组不注入（不抛错）

### F. 归链自动接力
- `F1/f2/f3/f4` 携带 `SR-{8hex}` token 首消息自动归链并接力

### G. `@relay verify` 自检（签名 create+prompt+读回）
- `G1` verify create 的 body.title 顶层会话（无 parentID）
- `G2` verify prompt 带 `path.id` + `body.parts` 且无 `noReply`
- `G3` verify messages 会话方法 `path.id`（SDK hey-api）
- `G4` detect 执行（executed=true）
- `G5` 消息角色 user/assistant

### H. `@relay handoff` 手动两阶段交接
- `H1` 未归链会话 handoff 自动建链；Phase A 未建会话（create=0）；docs 递增 1；文书已落（骨架）
- `H2` 归链会话 handoff 复用（docs=2）；Phase A 仍未建会话
- `H3` Phase B create 调用 1 次；弹「自动接力已创建」

### I. 标题读取失败/空 → 文书基名回退 cid
- `I1` Phase A docPath 基名回退 cid（含 cid 且非会话标题）；Phase B create 标题回退格式 `[接力]{cid}[n棒]`
- `I2` 标题已含 `[1棒]` → 剥离旧后缀 + `[2棒]` 不叠加；docPath 用 `handoff/{cid}/` 子目录
- `I3` 多重 `[接力][接力][接力5]` → 只包一个 `[接力]` 不叠加

## mock 客户端

`makeClient()` 生成可控的 fake：可注入 `failCreate` / `failPrompt` / `noPrompt` / `GET_FAIL`，并记录调用次数与 toast，用于断言各分支。

## 回归策略

- 每次改动 `index.js`（尤其 `relayPrompt` / compacting 分支 / 归链逻辑 / session.idle 处理）后跑一次 `node test/test.mjs`，68 用例须全绿。
- `experimental.session.compacting` / `session.idle` 若随 OpenCode 版本变化，先更新本套件再改实现。
