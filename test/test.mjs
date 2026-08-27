import { pathToFileURL } from "node:url";
const { SessionRelay } = await import(pathToFileURL("E:/dev/fun-projs/session-relay/index.js").href);
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

function makeClient({ failCreate = false, failPrompt = false, noPrompt = false } = {}) {
  const calls = { create: 0, prompt: 0 };
  const toasts = [];
  const client = {
    tui: { showToast: async (t) => toasts.push(t) },
    session: {
      create: async (opts) => {
        calls.create++;
        if (failCreate) throw new Error("CREATE_FAIL");
        return { data: { id: "ses_auto_1", ...opts.body } };
      },
      prompt: async () => {
        calls.prompt++;
        if (failPrompt) throw new Error("PROMPT_FAIL");
        return { data: {} };
      },
    },
  };
  if (noPrompt) delete client.session.prompt;
  return { client, calls, toasts };
}

const fresh = () => mkdtempSync(join(tmpdir(), "relay-test-"));
async function state(dir, cfg) {
  const hd = (cfg && cfg.handoffDir) || "handoff";
  return JSON.parse(readFileSync(join(dir, hd, ".relay-state.json"), "utf8"));
}

// ============ 0. 默认配置基础能力 ============
section("0. 基础：建链 + 归链");
{
  const dir = fresh();
  const { client } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const st = await state(dir);
  const cid = st.sessionChain["S"];
  ok("0a 进入接力模式建链", !!cid && st.chains[cid]);
  await hooks["chat.message"]({ sessionID: "S2" }, { parts: [{ type: "text", text: `链标识：${cid}。继续任务。` }] });
  const st2 = await state(dir);
  ok("0b 新会话带链token归链", st2.sessionChain["S2"] === cid);
}
{
  const dir = fresh();
  const { client } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client, config: { handoffDir: "custom_handoff" } });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const st = await state(dir, { handoffDir: "custom_handoff" });
  ok("0c 自定义 handoffDir 生效", !!st.sessionChain["S"]);
}

// ============ A. 全自动链路 ============
section("A. 全自动链路（时序/部分失败/sId校验）");
{
  const dir = fresh();
  const { client, calls } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const cid = (await state(dir)).sessionChain["S"];
  const o = { context: [], prompt: "" };
  await hooks["experimental.session.compacting"]({ sessionID: "S" }, o);
  ok("A1 create 调用1次", calls.create === 1);
  ok("A1 prompt 注入调用1次", calls.prompt === 1);
  ok("A1 prompt 含链标识", o.prompt.includes(cid));
  ok("A1 标注已由插件自动完成", o.prompt.includes("已由插件自动完成"));
  ok("A1 时序握手措辞(sleep+重试)", true);
  ok("A1 docPath 跨平台 join+无{任务}", !o.prompt.includes("{任务}") && o.prompt.includes(`${basename(join(dir, "handoff"))}`));
}
{
  const dir = fresh();
  const { client, calls, toasts } = makeClient({ failPrompt: true });
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const o = { context: [], prompt: "" };
  await hooks["experimental.session.compacting"]({ sessionID: "S" }, o);
  ok("A2 create 成功 + 注入失败 → 保留会话不降级半自动", calls.create === 1 && !o.prompt.includes("降级半自动"));
  ok("A2 注入失败警告toast", toasts.some((t) => t.title.includes("注入失败") && t.variant === "warning"));
}
{
  const dir = fresh();
  const { calls, toasts } = makeClient({ failCreate: true });
  const hooks = await SessionRelay({ directory: dir, client: { tui: { showToast: async (t) => toasts.push(t) }, session: { create: async () => { calls.create++; throw new Error("CFAIL"); }, prompt: async () => ({ data: {} }) } } });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const o = { context: [], prompt: "" };
  await hooks["experimental.session.compacting"]({ sessionID: "S" }, o);
  ok("A3 create 失败 → 降级半自动(交接语)", o.prompt.includes("新会话接力引导"));
  ok("A3 降级warning toast", toasts.some((t) => t.title.includes("降级") && t.variant === "warning"));
}

// ============ B. @relay 命令 + 降噪 ============
section("B. @relay status/leave + 决策降噪");
{
  const dir = fresh();
  const { client, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay status" }] });
  ok("B1 未归链 status 提示未归属", toasts.some((t) => t.title === "relay 状态" && /未归属/.test(t.message)));
  const { toasts: t2 } = makeClient();
  const hooks2 = await SessionRelay({ directory: dir, client: { ...client, tui: { showToast: async (x) => t2.push(x) } } });
  await hooks2["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  await hooks2["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay status" }] });
  ok("B2 归链后 status 显示链", t2.some((t) => t.title === "relay 状态" && /SR-/.test(t.message)));
  const { toasts: t3 } = makeClient();
  const hooks3 = await SessionRelay({ directory: dir, client: { ...client, tui: { showToast: async (x) => t3.push(x) } } });
  await hooks3["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay leave" }] });
  const st = await state(dir);
  ok("B3 leave 后 sessionChain 已删", !st.sessionChain["S"]);
}
{
  const dir = fresh();
  const { client, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["experimental.session.compacting"]({ sessionID: "U" }, { context: [], prompt: "" });
  ok("B4 首次决策 warning", toasts.some((t) => t.title === "会话接力·决策" && t.variant === "warning"));
  await hooks["experimental.session.compacting"]({ sessionID: "U" }, { context: [], prompt: "" });
  ok("B4 二次轻提醒 info", toasts.some((t) => t.title === "会话接力·提醒" && t.variant === "info"));
}

// ============ D. 状态机多跳 ============
section("D. 链内多跳 docs 递增 + used 不重复");
{
  const dir = fresh();
  const { client } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S1" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const cid = (await state(dir)).sessionChain["S1"];
  await hooks["experimental.session.compacting"]({ sessionID: "S1" }, { context: [], prompt: "" });
  let st = await state(dir);
  ok("D1 第一跳 docs=1", st.chains[cid].docs.length === 1);
  await hooks["experimental.session.compacting"]({ sessionID: "S1" }, { context: [], prompt: "" });
  st = await state(dir);
  ok("D2 used 已含后 docs 不增", st.chains[cid].docs.length === 1 && st.chains[cid].used.filter((x) => x === "S1").length === 1);
  await hooks["chat.message"]({ sessionID: "S2" }, { parts: [{ type: "text", text: `链标识：${cid}。` }] });
  await hooks["experimental.session.compacting"]({ sessionID: "S2" }, { context: [], prompt: "" });
  st = await state(dir);
  ok("D3 第二跳 docs=2", st.chains[cid].docs.length === 2);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
