import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * opencode-session-relay —— 会话接力赛跑（半自动 + 全自动）
 *
 * 问题背景：LLM 助手（如 opencode）上下文有上限，会话过长会被"压缩"，导致任务背景劣化、丢失。
 * 本插件在最痛的时点——会话即将被压缩前——截获并改为"交接接力"：
 * 把关键上下文落成一份交接文书，并（可自动）创建新会话延续，实现链内"零压缩劣化"。
 *
 * 核心语义：
 *   - 接力链：交接链标识 `SR-xxxxxxxx`。同一链内的所有会话自动接力，不再逐次询问；链间互不影响。
 *   - 决策时机：某会话即将压缩且尚未归属任何接力链时，toast 提示用户决策（交接 or 压缩）。
 *       - 交接：为该会话创建接力链，链内会话压缩时自动交接，不再询问。
 *       - 压缩：走原生压缩；后续压缩仍可再决策（随时可切换）。
 *       （已降噪：同一会话首次强提醒，之后轻提醒。）
 *   - 链识别：交接语义携带链标识；新会话首条消息含该标识 → 自动归入同链。
 *   - 全自动：归链会话压缩时，尝试 client.session.create 建接力会话 + 注入交接首条消息；
 *       create 失败 → 降级半自动（输出可复制交接语）；注入失败 → 保留已建会话并告警（不产生重复会话）。
 *
 * 配置（可选，经 ctx.config 传入）：
 *   {
 *     handoffDir: "handoff",            // 交接文书与状态文件存放目录（相对项目根）
 *     enterRegex: /进入接力|接力模式/,  // 显式进入接力的触发词
 *     compactRegex: /压缩模式|进入压缩|改用压缩|改为压缩/, // 显式走压缩的触发词
 *   }
 */

function defaults() {
  return {
    handoffDir: "handoff",
    enterRegex: /进入接力|接力模式/,
    compactRegex: /压缩模式|进入压缩|改用压缩|改为压缩/,
  };
}

export const SessionRelay = async (ctx) => {
  const { directory, client } = ctx;
  const config = { ...defaults(), ...(ctx.config || {}) };

  const statePath = (dir) => join(dir, config.handoffDir, ".relay-state.json");
  const handoffDir = (dir) => join(dir, config.handoffDir);

  const loadState = (dir) => {
    const p = statePath(dir);
    try {
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, "utf8"));
        return {
          // chains: { [chainId]: { docs: ["历史文书路径"], sessions: ["归链会话ID"], used: ["已交接会话ID"] } }
          chains: data.chains || {},
          // sessionChain: { [sessionID]: chainId }
          sessionChain: data.sessionChain || {},
          // counts: { [sessionID]: 压缩次数 }
          counts: data.counts || {},
          // reminded: [ {sessionID} 已做过首次强提醒 ]
          reminded: data.reminded || [],
        };
      }
    } catch {
      /* 状态文件损坏则重置 */
    }
    return { chains: {}, sessionChain: {}, counts: {}, reminded: [] };
  };

  const saveState = (dir, state) => {
    try {
      mkdirSync(handoffDir(dir), { recursive: true });
      writeFileSync(statePath(dir), JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.error(`[session-relay] 状态写入失败: ${e.message}`);
    }
  };

  // 骨架文书（R1+R3：插件先自行落盘，保证 docPath 一定存在，杜绝「docs 指针有、文件无」断链）。
  // 模型随后经 relayPrompt 用 Write 覆盖补全；即便未补，接手会话也能读到链上下文，不丢底。
  const seedDoc = (docPath, chainId, sessionID, docNumber) => {
    try {
      const skeleton = `# 会话接力交接文书（骨架 · 本链第 ${docNumber} 份）

> 由 session-relay 插件自动落盘，保证本交接文书文件存在。请模型（relayPrompt 特使）用 Write 工具**覆盖本文件**，补全以下研发交接内容。

## 链与会话跟踪信息

- 链标识：${chainId}
- 本会话 ID：${sessionID}
- 交接文书编号：第 ${docNumber} 份（本链）
- 落盘时间：${new Date().toISOString()}

## 待补充内容（模型按项目 AGENTS.md 交接规范撰写后覆盖）

### 一、任务背景与目标
### 二、根因结论（如适用）
### 三、已完成事项与结论（精确提交号/构建号/接口路径/回归结果）
### 四、架构决策与理由（关键取舍 + file:line 依据）
### 五、涉及仓库/分支对齐
### 六、未解决/新发现问题
### 七、下一步建议（可独立闭环）
### 八、关键文件清单（file:line）
### 九、git 状态快照（分支/提交/未推送）

## 交接语（模型补充后按项目规范在文书内或回复末尾输出）
`;
      mkdirSync(handoffDir(dir), { recursive: true });
      writeFileSync(docPath, skeleton, "utf8");
      return true;
    } catch (e) {
      console.error(`[session-relay] 骨架文书落盘失败: ${e.message}`);
      return false;
    }
  };

  const dateStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  };

  // 从文本里提取接力链 token（"SR-xxxxxxxx"）
  const extractChainId = (text) => {
    const m = /\bSR-([0-9a-f]{8})\b/i.exec(text || "");
    return m ? `SR-${m[1].toLowerCase()}` : null;
  };

  const userText = (parts) => {
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  };

  const notify = async (title, message, variant = "info") => {
    try {
      if (client && client.tui && client.tui.showToast) {
        await client.tui.showToast({ title, message, variant, duration: 15000 });
      }
    } catch (e) {
      console.error(`[session-relay] toast 通知失败: ${e.message}`);
    }
  };

  const chainOf = (state, sessionID) => state.sessionChain[sessionID] || null;

  return {
    event: async ({ event }) => {
      try {
        if (event && event.type === "session.compacted") {
          const sessionID = event.properties?.sessionID;
          if (!sessionID) return;
          const state = loadState(directory);
          state.counts[sessionID] = (state.counts[sessionID] || 0) + 1;
          saveState(directory, state);
        }
      } catch (e) {
        console.error(`[session-relay] event 处理失败: ${e.message}`);
        await notify("session-relay 错误", `session.compacted 处理失败: ${e.message}`, "error");
      }
    },

    // 捕获：1）新会话带链 token 归链；2）用户显式决策（接力/压缩）；3）@relay 命令
    "chat.message": async ({ sessionID }, { parts }) => {
      try {
        const text = userText(parts);
        if (!text) return;
        const state = loadState(directory);

        // 3) @relay 命令族（状态/退链）
        const cmd = /\B@relay\s+(\S+)/i.exec(text);
        if (cmd) {
          const action = cmd[1].toLowerCase();
          if (action === "status") {
            const cid = chainOf(state, sessionID);
            if (!cid || !state.chains[cid]) {
              await notify("relay 状态", "本会话当前未归属任何 relay 链。");
            } else {
              const c = state.chains[cid];
              await notify(
                "relay 状态",
                `链 ${cid}：跳数 ${c.docs.length}，归链会话 ${c.sessions.length}，文书索引 ${c.docs.length ? c.docs.join(" | ") : "（无）"}，已交接 ${c.used.length}。回「@relay leave」可退链。`,
              );
            }
            return;
          }
          if (action === "leave") {
            const cid = chainOf(state, sessionID);
            if (cid && state.chains[cid]) {
              delete state.sessionChain[sessionID];
              state.chains[cid].sessions = (state.chains[cid].sessions || []).filter((s) => s !== sessionID);
              saveState(directory, state);
              await notify("relay 退链", `本会话已退出链 ${cid}；下次压缩将重新提示决策。`);
            } else {
              await notify("relay 退链", "本会话未归属任何 relay 链，无需退出。");
            }
            return;
          }
          await notify("relay 命令", "支持 @relay status / @relay leave。", "warning");
          return;
        }

        // 1) 新会话首条消息若携带某 relay 链 token → 归链
        const cid = extractChainId(text);
        if (cid && state.chains[cid]) {
          if (!state.sessionChain[sessionID]) {
            state.sessionChain[sessionID] = cid;
            state.chains[cid].sessions = state.chains[cid].sessions || [];
            if (!state.chains[cid].sessions.includes(sessionID)) state.chains[cid].sessions.push(sessionID);
            saveState(directory, state);
            console.log(`[session-relay] 会话 ${sessionID} 归入 relay 链 ${cid}`);
          }
          return;
        }
        if (config.enterRegex.test(text)) {
          // 2) 用户显式进入接力
          if (!chainOf(state, sessionID)) {
            const newCid = `SR-${randomUUID().slice(0, 8)}`;
            state.chains[newCid] = { docs: [], sessions: [sessionID], used: [] };
            state.sessionChain[sessionID] = newCid;
            saveState(directory, state);
            console.log(`[session-relay] 用户在该会话启用接力，新建链 ${newCid}`);
          }
          await notify("会话接力模式", "本会话及后续交接出去的同链会话将自动接力，不再逐次询问。");
          return;
        }
        if (config.compactRegex.test(text)) {
          // 3) 用户显式走压缩
          if (chainOf(state, sessionID)) {
            delete state.sessionChain[sessionID];
            saveState(directory, state);
          }
          await notify("会话压缩模式", "本会话走原生压缩；下次压缩仍可再次决策是否切换接力。");
        }
      } catch (e) {
        console.error(`[session-relay] chat.message 处理失败: ${e.message}`);
        await notify("session-relay 错误", `chat.message 处理失败: ${e.message}`, "error");
      }
    },

    "experimental.session.compacting": async ({ sessionID }, output) => {
      try {
        if (!sessionID) return;
        const state = loadState(directory);
        const cid = chainOf(state, sessionID);

        if (cid && state.chains[cid]) {
          const chain = state.chains[cid];
          if (chain.used && chain.used.includes(sessionID)) {
            // 本会话已交接。若最近文书缺失（交接断链：指针有、文件无），静默放行会丢上下文 → 改为告警而非沉默。
            const usedDocs = chain.docs || [];
            if (usedDocs.length && !existsSync(usedDocs[usedDocs.length - 1])) {
              console.error(`[session-relay] 检测到交接文书缺失（已 used 会话 ${sessionID} 的最近文书未落盘）: ${usedDocs[usedDocs.length - 1]}`);
              await notify(
                "会话接力·文书缺失",
                `本会话已交接但其最近交接文书未落盘：${usedDocs[usedDocs.length - 1]}。请检查该文书是否存在，避免接手会话丢上下文；可在原会话重写补落盘。`,
                "warning",
              );
            }
            return; // 本会话已交接，放行压缩
          }
          chain.used = chain.used || [];
          chain.used.push(sessionID);
          const docs = (chain.docs = chain.docs || []);
          const docNumber = docs.length + 1;
          const docPath = join(handoffDir(directory), `${cid}-${dateStamp()}-交接-${docNumber}.md`);
          docs.push(docPath);
          saveState(directory, state);

          // R1+R3：插件先落盘骨架文书，保证 docPath 文件一定存在（杜绝「docs 指针有、文件无」断链）。
          seedDoc(docPath, cid, sessionID, docNumber);

          // --- 全自动：尝试创建接力会话（校验 sId）---
          let sId = null;
          try {
            const newSession = await client.session.create({
              body: { title: `[接力] ${cid} → ${docNumber}`, parentID: sessionID },
            });
            sId = newSession && (newSession.data?.id || newSession.id);
          } catch (e) {
            // create 失败 → 完整降级半自动（此时尚未建会话，无幽灵）
            console.error(`[session-relay] 自动创建会话失败，降级半自动: ${e.message}`);
            output.context = [];
            output.prompt = relayPrompt({ docPath, docNumber, docs, chainId: cid, newSessionId: null });
            await notify("自动接力降级", "自动创建接力会话失败，已改为半自动（请按交接语新建会话）。", "warning");
            return;
          }

          // 交接文书由本会话写（返回的 prompt 指挥）
          output.context = [];
          output.prompt = relayPrompt({ docPath, docNumber, docs, chainId: cid, newSessionId: sId });

          // --- 注入交接首条消息（时序握手 + 部分失败分离）---
          if (sId) {
            if (client.session && client.session.prompt) {
              const injectMsg = `你是接力接手会话（链标识 ${cid}）。
本会话由上一会话自动接力创建。交接文书将写入：${docPath}
请先等待该文书出现（由上一会话在交接时写入）：先 sleep 15 秒再尝试读取；若尚不存在，每 10 秒重试一次，最多重试 5 次。读到后通读并向用户复述要点——任务目标、已完成/未完成、当前分支与未推送提交、下一步第 1 件事；用户确认后按文书「下一步建议」继续。`;
              try {
                await client.session.prompt({ path: { id: sId }, body: { parts: [{ type: "text", text: injectMsg }], noReply: true } });
                await notify("自动接力已创建", `已自动创建接力会话「[接力] ${cid} → ${docNumber}」(id=${sId}) 并注入交接指令。可在桌面会话列表点开查看。`);
              } catch (e) {
                // create 成功但注入失败 → 保留已建会话，明确告警，不建重复会话
                console.error(`[session-relay] 注入交接指令失败（会话 ${sId} 已创建保留）: ${e.message}`);
                await notify(
                  "自动接力·注入失败",
                  `接力会话「[接力] ${cid} → ${docNumber}」(id=${sId}) 已创建，但交接指令注入失败。请手动打开该会话，让它读取文书 ${docPath}。`,
                  "warning",
                );
              }
            } else {
              await notify(
                "自动接力·注入不可用",
                `接力会话「[接力] ${cid} → ${docNumber}」(id=${sId}) 已创建；当前 client 不支持 prompt 注入，请手动打开该会话读取文书 ${docPath}。`,
                "warning",
              );
            }
          }
          return;
        }

        // 未归属 relay 链：决策提示（首次强提醒，之后轻提醒）
        if (state.reminded.includes(sessionID)) {
          await notify(
            "会话接力·提醒",
            "本会话再次压缩。回「进入接力模式」可随时切换为接力；默认走压缩。",
            "info",
          );
        } else {
          state.reminded = state.reminded || [];
          state.reminded.push(sessionID);
          saveState(directory, state);
          await notify(
            "会话接力·决策",
            "本会话即将压缩。选交接回复「进入接力模式」（本会话及同链续集自动接力）；默认走压缩。后续压缩仅轻提醒。",
            "warning",
          );
        }
        return; // 放行本次压缩
      } catch (e) {
        console.error(`[session-relay] compacting 处理失败（放行默认压缩）: ${e.message}`);
        try {
          await notify("session-relay 错误", `compacting 处理失败（已放行压缩）: ${e.message}`, "error");
        } catch (_) {}
      }
    },
  };
};

// 历史文书索引
function historyIndex(docs) {
  if (!docs || !docs.length) return "   （本链暂无历史文书）";
  return docs.map((p) => `   ${p}`).join("\n");
}

// 全自动模式文案
function autoNote(docPath, newSessionId) {
  return `
（注：本次为全自动接力——插件已创建接力会话 id=${newSessionId} 并注入交接指令。你只需把交接文书写入**精确路径** ${docPath} 即可，无需输出交接语。）`;
}

// 半自动交接语（create 失败降级时产出）
function semiHandoffBlock(chainId, docPath) {
  return `【输出交接语（新会话引导 prompt，必须携带链标识）】
在最终回复末尾，用一行分隔线 + 一个 fenced code block（语言标 text）输出一段可直接复制到新会话第一句的引导 prompt。交接语内必须包含链标识 ${chainId}（原样保留），它让插件识别新会话属于本 relay 链从而自动接力。交接语必须自包含，含两条关键指令：①先读文书再动手 ②读完向用户复述理解要点（含文件名、分支、下一步），确认无误才执行；并提示若文书缺细节可回原会话捞原文或回查本链历史文书。格式：

\`\`\`text
【新会话接力引导】请把下面整段粘贴到新会话第一句：

在 {项目目录} 继续任务「{任务简述}」。
链标识：${chainId}。
第一步：读取交接文书 ${docPath}，通读后向我复述——任务目标、已完成/未完成、当前分支与未推送提交、下一步第 1 件事，确认无误再动手。
如文书细节不足：先回查本链历史文书（见上方索引），仍不足再到原会话捞原文。
\`\`\`

规则：交接语必须自包含（含任务简述 + 文书绝对路径 + 明确指令），新会话零背景也能接手；不要真的执行任务，只产出交接物。`;
}

function relayPrompt({ docPath, docNumber, docs, chainId, newSessionId }) {
  const historyList = historyIndex(docs);
  const note = newSessionId ? autoNote(docPath, newSessionId) : "";
  const secondBlock = newSessionId
    ? "【第二件事已由插件自动完成】交接新会话（id=" + newSessionId + "）已由插件创建并注入交接首条消息，无需你再输出交接语。"
    : semiHandoffBlock(chainId, docPath);
  return `你是「会话接力」特使。当前会话上下文即将（首次）压缩。我们不执行这次会劣化上下文的常规压缩，而是改为产出接力交接物，让工作在新会话以完整、未劣化上下文干净续跑——本交接链（链标识 ${chainId}）内零压缩劣化。
你的交接物是新会话唯一依赖的上下文（原始会话已冻结用于回溯），文书质量决定任务成败——务必抓重点、写硬核、宁具体勿模糊。
${note}

【写作心法】
- 读者是接手的执行助手，目标是「不重读原文也能接着干」。写可执行的交接单，非聊天总结。
- 必要信息宁多写具体事实（file:line、接口路径、字段名、报错原文），不用"做了些改动"这类模糊话。
- 放弃：闲聊、已解决中间过程、过期的临时调试细节、明文凭证（只写凭证所在文档位置）。

【第一件事：写交接文书】
产出一份交接版 Markdown，写入精确路径 ${docPath}（不许改动路径，本链第 ${docNumber} 份文书，序号须保留，避免与同链历史文书撞名）。用 Write 工具写入，成功后回报「交接文书已写入: ${docPath}」。文书结构建议：背景与目标、已完成事项与结论（精确提交号/接口路径/验证方式）、架构决策与理由、涉及仓库/分支、未解决问题、环境凭证位置（不写明文）、关键文件清单(file:line)、下一步建议、git 状态快照。

本链历史文书（回源索引）：
${historyList}

${secondBlock}
`;
}

export default SessionRelay;
