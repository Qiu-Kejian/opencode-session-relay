# 测试

运行方式：

```bash
node test/test.mjs
```

无外部框架，纯 Node 断言与 mock `client`，可在无 OpenCode 环境跑（用临时目录做状态沙盒）。

## 用例分组

### A. 全自动链路（create / 注入 / sId 校验）
- `0a/0b` 建链 + 归链
- `A1` 全自动成功：create 调用、注入调用、断言 `relayPrompt` 含链标识、标注"已由插件自动完成"、docPath 跨平台且无 `{任务}` 占位
- `A2` create 成功 + 注入失败 → 保留会话 + warning，**不降级半自动**
- `A3` create 失败 → 降级半自动（交接语）+ warning

### B. `@relay` 命令 + 决策降噪
- `B1` 未归链 `@relay status` → 提示未归属
- `B2` 归链后 `@relay status` → 显示链信息
- `B3` `@relay leave` → 清 sessionChain
- `B4` 首次压缩强提醒(warning) → 二次轻提醒(info)

### C. 通用性 / 去硬编码（源码静态断言）
- `C1` 无 `E:\dev` 硬编码；用 `join()` 拼 docPath

### D. 状态机多跳
- `D1` 第一跳 docs=1
- `D2` used 已含后 docs 不增、used 不重复
- `D3` 第二跳 docs=2

## mock 客户端

`makeClient()` 生成可控的 fake：可注入 `failCreate` / `failPrompt` / `noPrompt`，并记录调用次数与 toast，用于断言各分支。

## 回归策略

- 每次改动 `index.js`（尤其 `relayPrompt` / compacting 分支 / 归链逻辑）后跑一次 `node test/test.mjs`，26+ 用例须全绿。
- `experimental.session.compacting` 若随 OpenCode 版本变化，先更新本套件再改实现。
