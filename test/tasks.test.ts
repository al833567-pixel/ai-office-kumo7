// 任務引擎、檔案、按鈕、hooks、狀態、MCP、WebSocket 的整合測試
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

let hub: ReturnType<typeof startHub>;
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, params: Record<string, unknown> = {}) {
  const kind = who === "boss" ? "user" : "bot";
  const res = await fetch(`${hub.url}/${kind}${tok[who]}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
  });
  return res.json() as Promise<any>;
}
async function ok(who: string, method: string, params: Record<string, unknown> = {}) {
  const r = await call(who, method, params);
  if (!r.ok) throw new Error(`${who}.${method}: ${r.description}`);
  return r.result;
}
async function drain(who: string) {
  const ups = await ok(who, "getUpdates", {});
  if (ups.length) await ok(who, "getUpdates", { offset: ups.at(-1).update_id + 1 });
  return ups as any[];
}
const lastMsg = async (who: string) => (await drain(who)).map((u) => u.message).filter(Boolean).at(-1);

beforeAll(() => {
  const db = openDb(":memory:");
  hub = startHub({ db, port: 0, maxPoll: 5, leaseSec: 1, stallSec: 2, offlineSec: 3, watchdogMs: 200 });
  const defs = [
    ["boss", false, "human", null], ["claude_a", true, "claude", "A"], ["claude_b", true, "claude", "B"],
    ["hermes_a", true, "hermes", "A"], ["hermes_b", true, "hermes", "B"],
  ] as const;
  for (const [u, isBot, kind, machine] of defs) {
    const { account, token } = createAccount(db, { username: u, firstName: u, isBot, kind, machine });
    tok[u] = token; ids[u] = account.id;
    addMember(db, OFFICE_GROUP_ID, account.id);
  }
});
afterAll(() => hub.stop());

describe("任務流程", () => {
  let goalId = 0;

  test("Claude 開目標：自己當主管，另一個 Claude 當審查", async () => {
    for (const u of ["claude_a", "claude_b", "hermes_a", "hermes_b", "boss"]) await drain(u);
    const g = await ok("claude_a", "createGoal", { title: "壓縮 B 機 log", detail: "每天 03:10" });
    goalId = g.goal_id;
    expect(g).toMatchObject({ lead: "claude_a", reviewer: "claude_b", status: "doing" });
    const seen = await lastMsg("boss");
    expect(seen.message_thread_id).toBe(goalId);
    expect(seen.data).toMatchObject({ type: "goal", lead: "claude_a" });
  });

  test("派工：被派的人收到 @mention 與任務卡 data；非主管不能派", async () => {
    const t = await ok("claude_a", "createTask", { goal_id: goalId, assignee: "hermes_b", title: "設定 cron", instructions: "crontab 加一行", verify: "true" });
    expect(t).toMatchObject({ status: "todo", assignee: "hermes_b", max_attempts: 2 });
    const m = await lastMsg("hermes_b");
    expect(m.text.startsWith("@hermes_b")).toBe(true);
    expect(m.entities[0]).toEqual({ type: "mention", offset: 0, length: 9 });
    expect(m.data).toMatchObject({ type: "task", task_id: t.task_id, verify: "true", lead: "claude_a" });
    expect((await call("claude_b", "createTask", { goal_id: goalId, assignee: "hermes_b", title: "x", instructions: "y" })).error_code).toBe(403);
  });

  test("Hermes 失敗兩次後自動改派給審查者 Claude-B", async () => {
    const t = (await ok("claude_a", "getTasks", { goal_id: goalId }))[0];
    expect((await call("hermes_a", "claimTask", { task_id: t.task_id })).error_code).toBe(403);
    await ok("hermes_b", "claimTask", { task_id: t.task_id });
    const r1 = await ok("hermes_b", "reportTask", { task_id: t.task_id, status: "failed", result: "permission denied" });
    expect(r1).toMatchObject({ status: "todo", attempts: 1, assignee: "hermes_b" });
    expect((await lastMsg("hermes_b")).text).toContain("重試");
    await ok("hermes_b", "claimTask", { task_id: t.task_id });
    const r2 = await ok("hermes_b", "reportTask", { task_id: t.task_id, status: "failed", result: "still denied" });
    expect(r2).toMatchObject({ status: "todo", assignee: "claude_b", attempts: 0 });
    const toB = await lastMsg("claude_b");
    expect(toB.text).toContain("@claude_b");
    expect(toB.data.task_id).toBe(t.task_id);
  });

  test("完成回報會通知主管，並解鎖依賴的任務", async () => {
    const first = (await ok("claude_a", "getTasks", { goal_id: goalId }))[0];
    const second = await ok("claude_a", "createTask", { goal_id: goalId, assignee: "hermes_a", title: "部署", instructions: "scp", depends_on: [first.task_id] });
    expect(second.status).toBe("blocked");
    await drain("hermes_a"); await drain("claude_a");
    await ok("claude_b", "claimTask", { task_id: first.task_id });
    const file = await uploadText("claude_b", "result.txt", "hello");
    await ok("claude_b", "reportTask", { task_id: first.task_id, status: "done", result: "已設定", files: [file.file_id] });
    const toLead = (await drain("claude_a")).map((u) => u.message).filter((m) => m?.data?.type === "report");
    expect(toLead[0].data).toMatchObject({ status: "done", files: [file.file_id] });
    const unblocked = await lastMsg("hermes_a");
    expect(unblocked.data).toMatchObject({ type: "task", task_id: second.task_id });
    expect((await ok("claude_a", "getTasks", { goal_id: goalId })).find((t: any) => t.task_id === second.task_id).status).toBe("todo");
  });

  test("審查退回會重新派給原執行者", async () => {
    const t = (await ok("claude_a", "getTasks", { goal_id: goalId, status: "done" }))[0];
    await drain("claude_b");
    const r = await ok("claude_b", "reviewTask", { task_id: t.task_id, verdict: "reject", comment: "少了 log 輪替" });
    expect(r.status).toBe("todo");
    expect((await lastMsg("claude_b")).text).toContain("審查退回");
  });

  test("租約到期自動退回待辦並通知", async () => {
    const t = await ok("claude_a", "createTask", { goal_id: goalId, assignee: "hermes_b", title: "慢工作", instructions: "sleep" });
    await ok("hermes_b", "claimTask", { task_id: t.task_id });
    await Bun.sleep(2300);
    const after = (await ok("claude_a", "getTasks", { goal_id: goalId })).find((x: any) => x.task_id === t.task_id);
    expect(after.status).toBe("todo");
    expect(after.note).toContain("租約到期");
  });

  test("真人開目標可指定主管；自動模式會依機器名稱挑主管", async () => {
    const g = await ok("boss", "createGoal", { title: "整理 B 機的磁碟", lead: "auto" });
    expect(g.lead).toBe("claude_b");
    const m = await lastMsg("claude_b");
    expect(m.text).toContain("@claude_b 你是這個目標的主管");
    const g2 = await ok("boss", "createGoal", { title: "隨便", lead: "claude_a" });
    expect(g2.lead).toBe("claude_a");
    const done = await ok("claude_a", "completeGoal", { goal_id: g2.goal_id, summary: "沒事" });
    expect(done.status).toBe("done");
  });
});

async function uploadText(who: string, name: string, text: string) {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  const r = await (await fetch(`${hub.url}/bot${tok[who]}/uploadFile`, { method: "POST", body: form })).json() as any;
  return r.result;
}

describe("檔案", () => {
  test("uploadFile → getFile → /file 下載；sendDocument 帶出 document 物件", async () => {
    const f = await uploadText("hermes_a", "報表.csv", "a,b\n1,2\n");
    expect(f).toMatchObject({ file_name: "報表.csv", file_size: 8 });
    const info = await ok("claude_a", "getFile", { file_id: f.file_id });
    const body = await (await fetch(`${hub.url}/file/bot${tok.claude_a}/${info.file_path}`)).text();
    expect(body).toBe("a,b\n1,2\n");
    expect((await fetch(`${hub.url}/file/botnope:xxxxxxxxxxxxxxxxxxxx/${info.file_path}`)).status).toBe(401);

    await drain("claude_a");
    const form = new FormData();
    form.append("chat_id", String(ids.claude_a));
    form.append("caption", "給你");
    form.append("document", new File(["zzz"], "x.log"));
    const sent = await (await fetch(`${hub.url}/bot${tok.hermes_a}/sendDocument`, { method: "POST", body: form })).json() as any;
    expect(sent.result.document.file_name).toBe("x.log");
    const got = await lastMsg("claude_a");
    expect(got).toMatchObject({ caption: "給你", document: { file_name: "x.log", file_size: 3 } });
  });
});

describe("按鈕（權限批准用）", () => {
  test("真人按 bot 訊息上的按鈕 → bot 收到 callback_query → answerCallbackQuery", async () => {
    const m = await ok("claude_a", "sendMessage", { chat_id: ids.boss, text: "🔐 Permission: Bash", reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: "perm:allow:abcde" }]] } });
    await drain("claude_a");
    const r = await ok("boss", "pressButton", { chat_id: ids.claude_a, message_id: m.message_id, data: "perm:allow:abcde" });
    const ups = await drain("claude_a");
    const cb = ups.at(-1).callback_query;
    expect(cb).toMatchObject({ id: r.callback_query_id, data: "perm:allow:abcde", from: { username: "boss" } });
    expect(await ok("claude_a", "answerCallbackQuery", { callback_query_id: cb.id, text: "Allowed" })).toBe(true);
    expect((await call("claude_b", "pressButton", { chat_id: ids.claude_a, message_id: m.message_id, data: "perm:allow:abcde" })).error_code).toBe(403);
    expect((await call("boss", "pressButton", { chat_id: ids.claude_a, message_id: m.message_id, data: "perm:allow:zzzzz" })).error_code).toBe(400);
  });
});

describe("狀態", () => {
  test("hooks 回報：工作中 → 等你批准 → 報錯；太久沒連線變離線", async () => {
    const hook = (body: object) => fetch(`${hub.url}/hooks`, { method: "POST", headers: { authorization: `Bearer ${tok.claude_a}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const state = async () => (await ok("boss", "getAgents")).find((a: any) => a.username === "claude_a");
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pytest -q" } });
    let s = await state();
    expect(["working", "review"]).toContain(s.state);
    expect(s.detail).toBe("Bash pytest -q");
    await hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    expect((await state()).state).toBe("waiting");
    await hook({ hook_event_name: "StopFailure", error: "overloaded" });
    expect((await state()).state).toBe("error");
    await hook({ hook_event_name: "UserPromptSubmit" });
    expect((await state()).state).not.toBe("error");
    expect((await fetch(`${hub.url}/hooks`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("做任務但很久沒動靜 → 卡住", async () => {
    const g = await ok("claude_a", "createGoal", { title: "卡住測試" });
    const t = await ok("claude_a", "createTask", { goal_id: g.goal_id, assignee: "hermes_a", title: "x", instructions: "y" });
    await ok("hermes_a", "claimTask", { task_id: t.task_id });
    await ok("hermes_a", "progressTask", { task_id: t.task_id, note: "跑 rsync" });
    expect((await ok("boss", "getAgents")).find((a: any) => a.username === "hermes_a").state).toBe("working");
    hub.db.query("UPDATE tasks SET lease_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) + 3600, t.task_id); // 避免租約先到期
    await Bun.sleep(2300);
    await ok("hermes_a", "heartbeat", {}); // 有連線但沒做事
    const s = (await ok("boss", "getAgents")).find((a: any) => a.username === "hermes_a");
    expect(s.state).toBe("stalled");
    expect(s.task.task_id).toBe(t.task_id);
  });
});

describe("MCP 入口（官方 SDK 客戶端）", () => {
  test("initialize、列工具、呼叫工具；沒帶 token 會被拒", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tok.claude_b}` } },
    });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("office-hub");
    expect(client.getInstructions()).toContain("office_new_goal");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("office_assign");
    const who = await client.callTool({ name: "office_whoami", arguments: {} });
    expect(JSON.parse((who.content as any)[0].text).username).toBe("claude_b");
    const g = await client.callTool({ name: "office_new_goal", arguments: { title: "MCP 開的目標" } });
    const goal = JSON.parse((g.content as any)[0].text);
    expect(goal.lead).toBe("claude_b");
    const bad = await client.callTool({ name: "office_claim", arguments: { task_id: 99999 } });
    expect(bad.isError).toBe(true);
    const sent = await client.callTool({ name: "office_send", arguments: { to: "office", text: "MCP 打招呼", goal_id: goal.goal_id } });
    expect(JSON.parse((sent.content as any)[0].text).message_thread_id).toBe(goal.goal_id);
    await client.close();

    const anon = await fetch(`${hub.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(anon.status).toBe(401);
  });
});

describe("UI WebSocket", () => {
  test("連線先收到快照，之後收到即時事件；bot token 不能連", async () => {
    const ws = new WebSocket(`${hub.url.replace("http", "ws")}/ws?token=${encodeURIComponent(tok.boss)}`);
    const msgs: any[] = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    for (let i = 0; i < 20 && !msgs.length; i++) await Bun.sleep(50);
    expect(msgs[0].type).toBe("snapshot");
    expect(msgs[0].agents.claude_a.username).toBe("claude_a");
    expect(msgs[0].goals.length).toBeGreaterThan(0);
    await ok("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "UI 看得到嗎" });
    for (let i = 0; i < 20 && !msgs.some((m) => m.event?.payload?.text === "UI 看得到嗎"); i++) await Bun.sleep(50);
    expect(msgs.some((m) => m.type === "event" && m.event.type === "message" && m.event.payload.text === "UI 看得到嗎")).toBe(true);
    ws.close();

    const res = await fetch(`${hub.url}/ws?token=${encodeURIComponent(tok.claude_a)}`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(res.status).toBe(401);
  });
});
