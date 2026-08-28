import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * session-relay —— 会话接力赛跑（半自动 + 全自动）
 *
 * 核心语义（2026-08-27 定稿）：
 *   - 「所有会话」不是全局所有会话，而是同一条接力链内的相关会话。
 *   - 决策时机：某会话即将压缩且尚未归属任何 relay 链时，toast 提示用户决策（压缩 or 交接）。
 *     - 「压缩」→ 走原生压缩；「交接」→ 为该会话创建一条 relay 链，链内全部会话自动交接，不再询问。
 *     - 决策提示已降噪：每会话压缩时仅在首次强提醒，后续压缩轻提醒（不锁死，可随时回「进入接力模式」切换）。
 *   - 链识别：交接时生成唯一 chainId，内嵌于交接语与注入消息；新会话据此归同链自动接力。链间互不影响。
 *
 * v3（2026-08-27 卍解）全自动：Phase B 主通道由 `event.session.idle` 触发（模型写完文书后自动建会话+注入，用户无需回复哨兵）；
 *   【保留兜底】聊天消息哨兵 `[RELAY_HANDOFF_DONE]` 仍在，全自动偶发未触发时可手动触发。
 *
 * v2（2026-08-27）优化：
 *   - 全自动链路正确性：时序握手（新会话明确 sleep+重试读文书）、部分失败分离（create成功但注入失败→保留已建会话并告警，
 *     不产生重复会话；create失败→完整降级半自动）、create 返回结构校验（避免 id=undefined 空会话）。
 *   - 状态可感知：`@relay status` / `@relay leave` 命令；决策提示降噪。
 *   - 通用性：路径用 join() 跨平台；relayPrompt 模板函数化、去硬编码项目路径；异常双通道（console+toast）。
 */

function statePath(directory) {
  return join(directory, "handoff", ".relay-state.json");
}

function loadState(directory) {
  const p = statePath(directory);
  try {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, "utf8"));
      return {
        // chains: { [chainId]: { docs: ["历史文书路径..."], sessions: ["归链会话ID..."], used: [已交接会话ID] } }
        chains: data.chains || {},
        // sessionChain: { [sessionID]: chainId }
        sessionChain: data.sessionChain || {},
        // counts: { [sessionID]: 压缩次数 }
        counts: data.counts || {},
        // reminded: [ {sessionID} 已做过首次强提醒 ]
        reminded: data.reminded || [],
        // pendingHandoffs: { [sessionID]: { cid, docPath, docNumber } }（两阶段 v3：Phase A 挂起，哨兵触发 Phase B）
        pendingHandoffs: data.pendingHandoffs || {},
      };
    }
  } catch {
    /* 状态文件损坏则重置 */
  }
  return { chains: {}, sessionChain: {}, counts: {}, reminded: [], pendingHandoffs: {} };
}

function saveState(directory, state) {
  try {
    mkdirSync(join(directory, "handoff"), { recursive: true });
    writeFileSync(statePath(directory), JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error(`[session-relay] 状态写入失败: ${e.message}`);
  }
}

// 骨架文书（R1+R3 修复：先由插件落盘，保证 docPath 文件一定存在，杜绝「docs 指针有、文件无」的断链）。
// 骨架含链标识/本会话上下文/交接指令模板；模型随后经 relayPrompt 用 Write 覆盖补充具体内容。
// 即便模型未补充，接手会话也能读到链上下文，不丢底。
function seedDoc(directory, docPath, chainId, sessionID, docNumber) {
  try {
    const skeleton = `# 会话接力交接文书（骨架 · 本链第 ${docNumber} 份）

> 由 session-relay 插件自动落盘，保证本交接文书文件存在。请模型（relayPrompt 特使）用 Write 工具**覆盖本文件**，补全以下研发交接内容。

## 链与会话跟踪信息

- 链标识：${chainId}
- 本会话 ID：${sessionID}
- 交接文书编号：第 ${docNumber} 份（本链）
- 落盘时间：${new Date().toISOString()}

## 待补充内容（以下为研发交接模板，模型按项目 AGENTS.md 交接规范撰写后覆盖）

### 一、任务背景与目标
### 二、根因结论（如适用）
### 三、已完成事项与结论（精确提交号/构建号/接口路径/回归结果）
### 四、架构决策与理由（关键取舍 + file:line 依据）
### 五、涉及仓库/分支对齐
### 六、未解决/新发现问题
### 七、下一步建议（2-5 条可执行、可独立闭环）
### 八、关键文件清单（file:line）
### 九、git 状态快照（分支/提交/未推送）

## 交接语（模型补充后按项目规范在文书内或回复末尾输出）
`;
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, skeleton, "utf8");
    return true;
  } catch (e) {
    console.error(`[session-relay] 骨架文书落盘失败: ${e.message}`);
    return false;
  }
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function justify(directory) {
  // handoff 目录（跨平台路径）
  return join(directory, "handoff");
}

// 从文本里提取交接链 token（“SR-xxxx”）
function extractChainId(text) {
  const m = /\bSR-([0-9a-f]{8})\b/i.exec(text || "");
  return m ? `SR-${m[1].toLowerCase()}` : null;
}

function userText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ");
}

// 取原始会话标题（SDK hey-api：client.session.get({ path: { id } }) → res.data.title）。
// 失败/空 → 返回空串，调用方回退 cid。
async function getSessionTitle(client, sessionID) {
  try {
    if (!client || !client.session || typeof client.session.get !== "function" || !sessionID) return "";
    const res = await client.session.get({ path: { id: sessionID } });
    const t = (res && (res.data?.title || res.title)) || "";
    return typeof t === "string" ? t : "";
  } catch (e) {
    console.error(`[session-relay] 读取会话标题失败: ${e.message}`);
    return "";
  }
}

// 标题 → 文件名基名：去 Windows 非法字符 <>:"/\|?* / 控制符 / 首尾空格点，截断 60 字符。
function sanitizeFileBase(title) {
  return String(title || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
}

// 剥离接力标题中的历史残留标记，避免 [接力] / [接力N]（旧格式 [接力5]）/ [N棒] 逐跳叠加。
// 输入如 "[接力][接力]某任务[接力5][1棒]" → 输出 "某任务"；空/全标记 → 空串（调用方回退 cid）。
function stripRelayMarks(title) {
  return String(title || "")
    .replace(/\[接力\d*\]/g, "")   // 去 [接力]、旧格式 [接力5]
    .replace(/\[\d+棒\]/g, "")     // 去 [1棒] / [7棒] 新旧后缀
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[->\s]+/, "")
    .trim();
}

export const SessionRelay = async (ctx) => {
  const { directory, client } = ctx;

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

  // ============ 两阶段全自动交接（2026-08-27 卍解 v3） ============
  // 核心修复（用户 issue 1/2）：成品交接文书由旧会话模型写（经 output.prompt），必须「文书输出完成 → 再建新会话」。
  //   Phase A（compacting 钩子）：seedDoc 骨架 + output.prompt 命令旧模型把成品文书写到精确路径，再回复 WITH 哨兵；
  //                             此时【不建会话】。pending 挂起在 state.pendingHandoffs[sessionID]。
  //   Phase B（chat.message 捕获哨兵）：旧模型写完并回复哨兵 → 校验文书为成品（非骨架）→ create 新会话 →
  //                             注入【真实交接语】（= 哨兵后的那段 work-handoff 交接语），清 pending。
  // 手动 `@relay handoff` 也走两阶段：Phase A 提示写文书 → 当前会话回复哨兵 → phaseB 完成。
  const HANDOFF_SENTINEL = "[RELAY_HANDOFF_DONE]";

  // 校验文书是否为「成品」：非骨架（已由模型用 Write 覆盖，去掉「由 session-relay 插件自动落盘」骨架标记）
  function docIsComplete(docPath) {
    try {
      if (!existsSync(docPath)) return false;
      const c = readFileSync(docPath, "utf8");
      return c.includes("由 session-relay 插件自动落盘") === false && c.trim().length > 0;
    } catch (_) {
      return false;
    }
  }

  // Phase A：准备文书 → 产出 sentinel 交接指令（本会话模型把文书补成成品并回复哨兵）。压缩与手动手动共用。
  // 返回 { docPath, docNumber, sentinel: relayPromptInput }；不建会话。
  async function phaseA_startHandoff(sessionID, cid) {
    const state = loadState(directory);
    const chain = state.chains[cid];
    if (!chain) throw new Error(`链 ${cid} 不存在`);
    const docs = (chain.docs = chain.docs || []);
    const docNumber = docs.length + 1;
    const base = sanitizeFileBase(stripRelayMarks(await getSessionTitle(client, sessionID))) || cid;
    const docPath = join(justify(directory), cid, `${base}-${dateStamp()}-交接-${docNumber}.md`);
    docs.push(docPath);
    state.pendingHandoffs = state.pendingHandoffs || {};
    state.pendingHandoffs[sessionID] = { cid, docPath, docNumber };
    saveState(directory, state);

    // 骨架文书先落盘，保证 docPath 存在（杜绝「docs 指针有、文件无」断链；模型随后覆盖为成品）
    seedDoc(directory, docPath, cid, sessionID, docNumber);
    return { docPath, docNumber, docs };
  }

  // Phase B：哨兵已到（用户发送）→ 校验成品 → create 新会话 → 注入真实交接语。
  // 交接语来源优先级：①哨兵消息内附带的交接语 ②文书「## 交接语」节内容 ③默认引导（读文书+复述要点）。
  // 仅当文书为成品（非骨架）才建会话；仍骨架 → 告警且【不建】= 满足「文书输出完成才建会话」。
  async function phaseB_completeHandoff(sessionID, cid, docPath, docNumber, sentinelText) {
    const state = loadState(directory);
    // ① 哨兵消息内附带的交接语（用户可能复制了旧式「哨兵+交接语」）
    const idx = sentinelText.indexOf(HANDOFF_SENTINEL);
    let handoffText = (idx >= 0 ? sentinelText.slice(idx + HANDOFF_SENTINEL.length) : sentinelText).trim();

    if (!docIsComplete(docPath)) {
      await notify(
        "自动接力·文书未补全",
        `交接文书仍为骨架未补全：${docPath}。未创建新会话。请确认文书已用 Write 覆盖为成品后，再次回复 ${HANDOFF_SENTINEL} 完成建会话。`,
        "warning",
      );
      return { docPath, docNumber, docs: state.chains[cid]?.docs || [], sId: null, skipped: true };
    }

    const chain = state.chains[cid];
    if (chain) {
      chain.used = chain.used || [];
      if (!chain.used.includes(sessionID)) chain.used.push(sessionID);
    }
    delete state.pendingHandoffs[sessionID];
    saveState(directory, state);

    // ② 从文书「## 交接语」节提取（v3.1：用户只发哨兵，交接语在文书内）
    if (!handoffText || handoffText === HANDOFF_SENTINEL) {
      try {
        const doc = readFileSync(docPath, "utf8");
        const m = doc.match(/##\s*交接语\s*\n+```text\s*\n([\s\S]*?)```/);
        if (m && m[1].trim()) handoffText = m[1].trim();
      } catch (_) {}
    }

    // 清洗接力标题中的历史残留标记，避免 [接力] / [接力N] / [N棒] 逐跳叠加。前缀固定 [接力]（无数字），后缀 [N棒]。
    const core = stripRelayMarks(String(await getSessionTitle(client, sessionID) || ""));
    const relayTitle = core ? `[接力]${core}[${docNumber}棒]` : `[接力]${cid}[${docNumber}棒]`;

    // ③ 默认引导：新会话读取刚完成的文书（其内容即 work-handoff 交接语的落盘版）。
    const injectMsg = `你是「会话接力」接手会话（链标识 ${cid}）。
本会话由上一会话自动交接创建（上一会话已完成交接文书的输出后才创建本会话）。
你的交接文书已就绪：${docPath}
第一步：读取该文书，通读后向我复述要点——任务目标、已完成/未完成、当前分支与未推送提交、下一步第 1 件事；用户确认后按文书「下一步建议」继续。`;

    let sId = null;
    try {
      const newSession = await client.session.create({ body: { title: relayTitle } });
      sId = newSession && (newSession.data?.id || newSession.id);
    } catch (e) {
      console.error(`[session-relay] 建会话失败，降级半自动: ${e.message}`);
      await notify("自动交接降级", "文书已完成但建会话失败，请手动新建会话并读取文书 " + docPath, "warning");
      return { docPath, docNumber, docs: chain?.docs || [], sId: null };
    }

    const toInject = (handoffText && handoffText !== HANDOFF_SENTINEL && !handoffText.startsWith("你是「会话接力」接手会话")) ? handoffText : injectMsg;
    try {
      await client.session.prompt({
        path: { id: sId },
        body: { parts: [{ type: "text", text: toInject }] },
      });
      await notify("自动接力已创建", `已创建接力会话「${relayTitle}」(id=${sId}) 并注入交接指令（文书：${docPath}）。可在桌面会话列表点开。`);
    } catch (e) {
      console.error(`[session-relay] 注入失败（会话 ${sId} 已建保留）: ${e.message}`);
      await notify("自动接力·注入失败", `接力会话「${relayTitle}」(id=${sId}) 已创建但交接指令注入失败，请手动打开它读取文书 ${docPath}。`, "warning");
    }
    return { docPath, docNumber, docs: chain?.docs || [], sId };
  }

  return {
    event: async ({ event }) => {
      try {
        if (!event || !event.type) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        if (event.type === "session.compacted") {
          const state = loadState(directory);
          state.counts[sessionID] = (state.counts[sessionID] || 0) + 1;
          saveState(directory, state);
          return;
        }

        // 全自动 Phase B（2026-08-27 卍解）：模型被 relayPrompt 指挥写完交接文书后，会话进入 idle →
        // 自动校验成品并建会话+注入交接语，用户无需手动回复哨兵。pending 存在 + 文书为成品才触发。
        // 兜底：若此处未触发（idle 事件缺失等），chat.message 的哨兵捕获仍可用。
        if (event.type === "session.idle") {
          const pending = (loadState(directory).pendingHandoffs || {})[sessionID];
          if (pending) {
            await phaseB_completeHandoff(sessionID, pending.cid, pending.docPath, pending.docNumber, "");
            return;
          }
        }
      } catch (e) {
        console.error(`[session-relay] event 处理失败: ${e.message}`);
        await notify("session-relay 错误", `event 处理失败: ${e.message}`, "error");
      }
    },

    // 捕获：1）新会话带链 token 归链；2）用户显式决策（交接/压缩）；3）@relay 命令
    "chat.message": async ({ sessionID }, { parts }) => {
      try {
        const text = userText(parts);
        if (!text) return;
        const state = loadState(directory);

        // 0) 两阶段 Phase B【兜底通道】：主通道为 event.session.idle 全自动（模型写完文书后自动建会话，无需用户操作）；
        //    此处哨兵捕获仅在全自动偶发未触发时由用户手动回复 [RELAY_HANDOFF_DONE] 兜底完成建会话+注入真实交接语。
        const sentinelAt = text.indexOf(HANDOFF_SENTINEL);
        const pending = (state.pendingHandoffs || {})[sessionID];
        if (sentinelAt >= 0 && pending) {
          const b = await phaseB_completeHandoff(sessionID, pending.cid, pending.docPath, pending.docNumber, text);
          if (!b.skipped && b.sId) {
            // 已建会话，无需再当普通文本处理
            return;
          }
          // skipped（文书仍骨架）：已告警且未建会话 → 吞掉哨兵，避免当作普通消息
          if (b.skipped) return;
        }

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
                `链 ${cid}：跳数 ${c.docs.length}，归链会话 ${c.sessions.length}，本次会话含文书索引 ${c.docs.length ? c.docs.join(" | ") : "（无）"}，已交接 ${c.used.length}。回「@relay leave」可退链。`,
              );
            }
            return;
          }
          if (action === "refresh") {
            // [实测] 尝试触发桌面刷新会话列表（openSessions / 相关 UI 刷新）
            const report = { when: new Date().toISOString(), done: false, error: "" };
            try {
              if (client && client.tui) {
                for (const m of ["openSessions", "publish"]) {
                  try {
                    if (typeof client.tui[m] === "function") { await client.tui[m](); report[m] = "called"; }
                  } catch (e) { report[m + "Err"] = e.message; }
                }
                report.done = true;
                if (typeof client.tui.publish === "function") { try { await client.tui.publish({ type: "session.reload" }); report.reload = "published"; } catch (e) { report.reloadErr = e.message; } }
              } else {
                report.error = "client.tui 不可用";
              }
            } catch (e) { report.error = e.message; }
            try { mkdirSync(join(directory, "handoff"), { recursive: true }); writeFileSync(join(directory, "handoff", "refresh-result.json"), JSON.stringify(report, null, 2), "utf8"); } catch (_) {}
            console.error("[session-relay][refresh] " + JSON.stringify(report));
            await notify("relay refresh", "已尝试触发会话列表刷新（openSessions/publish）。", "info");
            return;
          }
          if (action === "verify") {
            // 自检：用修复后的 SDK 签名真机走 create+prompt+读回，验证自动交接链路是否真正执行。
            // 签名依据（generated types）：SessionsCreateInput={id?,agent?,model?,location?}（无 body/title）；
            // SessionsPromptInput={sessionID, prompt:{text,...}, delivery?, resume?}（无 path/body；delivery:"steer" 触发执行）。
            const report = { sessionID, at: new Date().toISOString(), newSessionId: "", promptOk: false, executed: false, msgs: [], err: "", probe: {} };
            try {
              if (!client || !client.session) throw new Error("client.session 不可用");
              // [探测] client 真实结构：输出顶层与 session 命名空间的方法名，供验证可用通道
              try {
                report.probe.client = Object.keys(client).filter((k) => !k.startsWith("_"));
                report.probe.session = Object.keys(client.session).filter((k) => !k.startsWith("_"));
                // 类方法在原型上，Object.keys 取不到 → 用 getOwnPropertyNames 取原型链方法名
                const protoMethods = (obj) => {
                  const names = [];
                  let p = obj && Object.getPrototypeOf(obj);
                  while (p && p !== Object.prototype) {
                    names.push(...Object.getOwnPropertyNames(p).filter((n) => n !== "constructor"));
                    p = Object.getPrototypeOf(p);
                  }
                  return names;
                };
                report.probe.sessionProto = protoMethods(client.session);
                report.probe.clientProto = protoMethods(client);
                if (client.session && client.session.messages) report.probe.sessionMessages = Object.keys(client.session.messages).filter((k) => !k.startsWith("_"));
                if (client.messages) report.probe.topMessages = Object.keys(client.messages).filter((k) => !k.startsWith("_"));
                if (client.session && client.session.message) report.probe.sessionMessage = Object.keys(client.session.message).filter((k) => !k.startsWith("_"));
              } catch (pe) { report.probe.err = pe.message; }
              const created = await client.session.create({
                body: { title: `[relay verify] ${new Date().toISOString().slice(0, 16)}` },
              });
              report.newSessionId = created && (created.data?.id || created.id);
              if (!report.newSessionId) throw new Error("create 未返回 id");
              if (!client.session.prompt) throw new Error("client.session.prompt 不存在");
              // SDK js（hey-api）签名：prompt({ path: { id }, body: { parts: [...] } })。
              // 关键：不能传 noReply:true（server 端 prompt.ts:1069 直接 return 不启动 loop = 不执行）。
              await client.session.prompt({
                path: { id: report.newSessionId },
                body: { parts: [{ type: "text", text: "[relay verify] 自检注入。请只回复一行：VERIFY_EXECUTED" }] },
              });
              report.promptOk = true;
              // 多通道读回：session.messages({ path:{id}, query })（SDK hey-api，原型方法）；兼容其他形态
              const readMsg = async () => {
                let arr = null;
                if (client.session.messages && typeof client.session.messages === "function") {
                  const res = await client.session.messages({ path: { id: report.newSessionId }, query: { limit: 10, order: "asc" } });
                  arr = res?.data ?? res;
                } else if (client.session.messages && client.session.messages.list) arr = await client.session.messages.list({ sessionID: report.newSessionId, limit: 10, order: "asc" });
                else if (client.messages && typeof client.messages === "function") {
                  const res = await client.messages({ path: { id: report.newSessionId }, query: { limit: 10, order: "asc" } });
                  arr = res?.data ?? res;
                }
                if (arr === null) throw new Error("无可用读回通道");
                return Array.isArray(arr) ? arr : (arr?.data ?? []);
              };
              for (let i = 0; i < 6; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                try {
                  const arr = await readMsg();
                  report.msgs = arr.map((m) => m?.info?.role ?? m?.role ?? "?");
                  if (report.msgs.includes("assistant")) { report.executed = true; break; }
                } catch (re) { report.err = `读回失败(${i}): ${re.message}`; break; }
              }
            } catch (e) {
              report.err = e.message;
            }
            try { mkdirSync(join(directory, "handoff"), { recursive: true }); writeFileSync(join(directory, "handoff", "verify-result.json"), JSON.stringify(report, null, 2), "utf8"); } catch (_) {}
            console.error("[session-relay][verify] " + JSON.stringify(report));
            const exec = report.executed ? "已执行" : report.err ? `异常(${report.err})` : "未观察到执行";
            await notify("relay verify", `新会话 ${report.newSessionId}：prompt ${report.promptOk ? "OK" : "失败"}；执行=${exec}；消息角色=${report.msgs.join(",") || "无"}。详见 handoff/verify-result.json。`, report.executed ? "info" : "warning");
            return;
          }
          if (action === "handoff") {
            // 手动触发全自动交接（两阶段 v3.1）：建链（若未归链）→ Phase A seedDoc + 本会话写成品文书 →
            // 模型提示 → 用户回复哨兵 → chat.message 捕获（仅用户消息触发）→ Phase B 建会话 + 注入真实交接语。
            try {
              let st = loadState(directory);
              let cid = chainOf(st, sessionID);
              if (!cid || !st.chains[cid]) {
                cid = `SR-${randomUUID().slice(0, 8)}`;
                st.chains[cid] = { docs: [], sessions: [sessionID], used: [] };
                st.sessionChain[sessionID] = cid;
                saveState(directory, st);
              }
              const r = await phaseA_startHandoff(sessionID, cid);
              await notify(
                "手动交接·第一阶段",
                `请在文书 ${r.docPath} 里补全交接内容（须用 Write 覆盖取消骨架标记，见文书模板），写完后插件将全自动创建接力会话并注入交接语（session.idle 触发，无需操作）；若偶发未自动，可回复哨兵 ${HANDOFF_SENTINEL} 手动触发作兜底。`,
                "warning",
              );
            } catch (e) {
              console.error(`[session-relay] handoff 失败: ${e.message}`);
              await notify("手动交接", `交接失败: ${e.message}`, "error");
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
          await notify("relay 命令", "支持 @relay status / @relay leave / @relay handoff / @relay refresh / @relay verify。", "warning");
          return;
        }

        // 1) 新会话首条消息若携带某 relay 链 token → 归链，后续自动接力
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
        if (/进入接力|接力模式/.test(text)) {
          // 2) 用户显式进入交接
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
        if (/压缩模式|进入压缩|改用压缩|改为压缩/.test(text)) {
          // 3) 用户显式选压缩：此会话不归 relay 链
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

    // 初心弹框正路（2026-08-27 交接-1 结论）：压缩临界瞬间模型 tools:{} 无法弹框，
    // 改为对「未归链」会话注入 system 指令，引导模型在对话中接近压缩时主动调 question 工具
    // 弹「进入接力/直接压缩」多选框（question 框只有模型有工具时可达；建链复用 chat.message 的
    // 「进入接力模式」正则）。已归链会话无需询问（自动交接），不注入。
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      try {
        if (!sessionID || !output || !Array.isArray(output.system)) return;
        const state = loadState(directory);
        // 已归链：链内自动交接，无需提问 → 不注入
        if (chainOf(state, sessionID)) return;
        output.system.push(
          `[会话接力] 本会话上下文可能接近压缩临界。当上下文已较满（例如出现自动续写/信息量大/接近上限）且本会话尚未进入接力时，请用 question 工具主动向用户弹出选择框，提交一个问题：
问题：「本会话即将到达上下文上限。选择如何处理？」
选项：1) 进入接力（建接力链，后续会话自动交接，避免上下文劣化）——选中后请提示用户回复「进入接力模式」以建立接力链；2) 直接压缩。
只在本会话真正接近压缩边界时弹，避免打扰。本指令不要求你立即行动。`.trim(),
        );
      } catch (e) {
        console.error(`[session-relay] system.transform 处理失败: ${e.message}`);
      }
    },

    "experimental.session.compacting": async ({ sessionID }, output) => {
      try {
        if (!sessionID) return;

        // [探针] 探测 client 是否有可阻塞提问的能力（桌面版实测）——调试用，仅 SESSION_RELAY_DEBUG=1 时输出，运行默认静默
        try {
          if (process.env.SESSION_RELAY_DEBUG === "1" && client && typeof client === "object") {
            const ck = Object.keys(client).filter((k) => !k.startsWith("_"));
            console.error(`[session-relay][probe] client keys: ${ck ? ck.join(",") : "(none)"}`);
            console.error(`[session-relay][probe] client.question type: ${client.question ? typeof client.question : "(undefined)"}`);
            if (client.tui) console.error(`[session-relay][probe] client.tui keys: ${Object.keys(client.tui).join(",")}`);
            if (client && typeof client.question === "object") console.error(`[session-relay][probe] question obj keys: ${Object.keys(client.question).join(",")}`);
          }
        } catch (pe) {
          console.error(`[session-relay][probe] 探测失败: ${pe.message}`);
        }

        const state = loadState(directory);
        const cid = chainOf(state, sessionID);

        if (cid && state.chains[cid]) {
          const chain = state.chains[cid];
          if (chain.used && chain.used.includes(sessionID)) {
            // 本会话已交接。若最近一份文书缺失（交接断链：指针有、文件无），静默放行会丢上下文 → 改为告警而不是沉默。
            const docs = chain.docs || [];
            if (docs.length && !existsSync(docs[docs.length - 1])) {
              console.error(`[session-relay] 检测到交接文书缺失（已 used 会话 ${sessionID} 的最近文书未落盘）: ${docs[docs.length - 1]}`);
              await notify(
                "会话接力·文书缺失",
                `本会话已交接但其最近交接文书未落盘：${docs[docs.length - 1]}。请检查该文书是否存在，避免接手会话丢上下文；可在原会话重写补落盘。`,
                "warning",
              );
            }
            return; // 本会话已交接，放行压缩
          }
          // 已归链两阶段 Phase A：只准备文书 → compacting 返回后本会话模型执行 relayPrompt，把成品文书写完并回复哨兵。
          // 建会话推迟到 chat.message 捕获哨兵的 Phase B（用户 issue 1：文书输出完成才建新会话）。
          const r = await phaseA_startHandoff(sessionID, cid);
          output.context = [];
          // sentinelPrompt = relayPrompt 引导本会话写文书，并把交接语 + 哨兵作为最终回复（Phase B 据此建会话+注入真实交接语）
          output.prompt = relayPrompt({
            docPath: r.docPath, docNumber: r.docNumber, docs: r.docs, chainId: cid, sentinel: HANDOFF_SENTINEL,
          });
          return;
        }

        // 未归属 relay 链：压缩临界时标记本次压缩。toast/弹框在桌面版不可见，
        // 决策采用纯文字交互：压缩照常进行；如想交接，随时回复「进入接力模式」即建链并转全自动接力。
        try {
          const askPath = join(directory, "handoff", ".relay-ask.json");
          mkdirSync(join(directory, "handoff"), { recursive: true });
          writeFileSync(askPath, JSON.stringify({ sessionID, scope: "compressing", createdAt: Date.now(), answered: false, answer: "" }, null, 2), "utf8");
        } catch (fe) {
          console.error(`[session-relay] 写待决策标记失败: ${fe.message}`);
        }
        await notify(
          "会话接力·决策",
          "本会话已到压缩临界。压缩照常进行；如需接力交接以免上下文劣化，请任意回复「进入接力模式」即可建链并转全自动交接。",
          "warning",
        );
        return; // 放行本次压缩（决策走纯文字交互）
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

// 两阶段 v3：Phase A 不建会话。本会话模型先把成品文书写好，随后 event 钩子的 session.idle 监听
// 全自动触发 Phase B（校验成品 → 建会话 → 注入交接语），用户【无需任何操作】。
// 兜底：若 session.idle 偶发未触发，保留用户手动回复哨兵 [RELAY_HANDOFF_DONE] 的 chat.message 触发通道。
function sentinelReply(docPath, docNumber, chainId, sentinel) {
  return `【收尾（Phase B · 全自动触发）】
交接文书写好（已用 Write 覆盖 ${docPath}，非骨架）后，向用户输出一句话提示：
「交接文书已写好：${docPath}。插件将全自动创建接力会话并注入交接语，无需操作。若几秒后未见自动创建，可回复哨兵 ${sentinel} 手动触发。」
【不要自行输出 ${sentinel}】——全自动由 session.idle 事件触发（会话空闲即建）。哨兵仅是兜底，正常情况不劳用户动手。插件会：校验文书为成品 → 创建接力会话 → 把交接语注入为新会话首条消息。`;
}

function relayPrompt({ docPath, docNumber, docs, chainId, sentinel }) {
  const historyList = historyIndex(docs);
  return `你是「会话接力」特使。当前会话上下文即将（首次）压缩。我们不执行这次会劣化上下文的常规压缩，而是改为产出接力交接物，让工作在新会话以完整、未劣化上下文干净续跑——本交接链（链标识 ${chainId}）内零压缩劣化。
你的交接物是新会话唯一依赖的上下文（原始会话已冻结用于回溯），文书质量决定任务成败——务必抓重点、写硬核、宁具体勿模糊。

【写作心法】
- 读者是接手的执行助手，目标是「不重读原文也能接着干」。写可执行的研发交接单，非聊天总结。
- 必要信息宁多写具体事实（file:line、提交号、接口路径、字段名、报错原文），不用"做了些改动"这类模糊话。
- 放弃：闲聊、已解决中间过程、过期的临时调试细节、明文凭证（只写凭证所在文档位置）。

【第一件事：写交接文书】
按项目既有约定（项目根 AGENTS.md 的「交接文档（handoff）」规范 + work-handoff 技能模板）产出研发交接版 Markdown，写入精确路径 ${docPath}（不许改动路径，本链第 ${docNumber} 份文书，序号须保留，避免与同链历史文书撞名）。用 Write 工具写入，成功后回报「交接文书已写入: ${docPath}」。

本链历史文书（回源索引）：
${historyList}

${sentinelReply(docPath, docNumber, chainId, sentinel)}
`;
}

export default SessionRelay;
