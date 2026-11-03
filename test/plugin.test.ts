// 端對端：啟動 claude/office/server.ts（改寫自官方 Telegram 外掛），用 MCP 客戶端扮演 Claude Code。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

const PLUGIN_DIR = join(import.meta.dir, "..", "claude", "office");
let hub: ReturnType<typeof startHub>;
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};
let client: Client;
const channel: any[] = [];
const verdicts: any[] = [];

async function ok(who: string, method: string, params: Record<string, unknown> = {}) {
  const kind = who === "boss" ? "user" : "bot";
  const r = await (await fetch(`${hub.url}/${kind}${tok[who]}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })).json() as any;
  if (!r.ok) throw new Error(`${who}.${method}: ${r.description}`);
  return r.result;
}
async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  for (let t = 0; t < ms; t += 50) { const v = fn(); if (v) return v; await Bun.sleep(50); }
  throw new Error("timeout");
}

beforeAll(async () => {
  hub = startHub({ db: openDb(":memory:"), port: 0, maxPoll: 2 });
  for (const [u, isBot, kind] of [["boss", false, "human"], ["claude_a", true, "claude"], ["hermes_b", true, "hermes"]] as const) {
    const { account, token } = createAccount(hub.db, { username: u, firstName: u, isBot, kind });
    tok[u] = token; ids[u] = account.id; addMember(hub.db, OFFICE_GROUP_ID, account.id);
  }
  const state = mkdtempSync(join(tmpdir(), "office-state-"));
  writeFileSync(join(state, ".env"), `OFFICE_HUB_URL=${hub.url}\nOFFICE_BOT_TOKEN=${tok.claude_a}\n`);
  writeFileSync(join(state, "access.json"), JSON.stringify({
    dmPolicy: "allowlist", allowFrom: [String(ids.boss), String(ids.hermes_b)], approvers: [String(ids.boss)],
    groups: { [String(OFFICE_GROUP_ID)]: { requireMention: true, allowFrom: [] } }, pending: {},
  }));
  client = new Client({ name: "fake-claude-code", version: "1.0.0" });
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), async (n) => { channel.push(n.params); });
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel/permission"), params: z.any() }), async (n) => { verdicts.push(n.params); });
  const transport = new StdioClientTransport({
    command: "bun", args: ["server.ts"], cwd: PLUGIN_DIR, stderr: "pipe",
    env: { ...process.env as Record<string, string>, OFFICE_SESSION: "1", OFFICE_STATE_DIR: state },
  });
  await client.connect(transport);
  // 等外掛開始長輪詢
  await waitFor(() => (hub.db.query("SELECT last_seen FROM presence WHERE account_id = ?").get(ids.claude_a) as any)?.last_seen);
}, 20000);

afterAll(async () => { await client?.close(); hub.stop(); });

describe("office 頻道外掛", () => {
  test("工具清單：頻道工具＋由外掛轉送的 office_* 工具，以自己的帳號執行", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.slice(0, 4)).toEqual(["reply", "react", "download_attachment", "edit_message"]);
    for (const t of ["office_new_goal", "office_assign", "office_report", "office_wait", "office_agents"]) expect(tools).toContain(t);
    expect(client.getInstructions()).toContain("AI office");
    const who = await client.callTool({ name: "office_whoami", arguments: {} });
    expect(JSON.parse((who.content as any)[0].text).username).toBe("claude_a");
    const bad = await client.callTool({ name: "office_claim", arguments: { task_id: 99999 } });
    expect(bad.isError).toBe(true);
  });

  test("群組裡 @claude_a 的派工 → 推進 session，帶 thread、data_type、task_id 與 office-data", async () => {
    await ok("hermes_b", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: 7, text: "@claude_a 請接 #5", data: { type: "task", task_id: 5, goal_id: 7 } });
    const n = await waitFor(() => channel.find((c) => c.content.startsWith("@claude_a 請接 #5")));
    expect(n.meta).toMatchObject({ chat_id: String(OFFICE_GROUP_ID), chat_type: "supergroup", from_bot: "true", thread_id: "7", data_type: "task", task_id: "5", goal_id: "7", user: "hermes_b" });
    expect(n.content).toContain("```office-data");
  });

  test("沒有 @ 它的群組訊息不會推進來", async () => {
    const before = channel.length;
    await ok("hermes_b", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "大家好" });
    await Bun.sleep(1500);
    expect(channel.length).toBe(before);
  });

  test("reply 工具：回覆會留在原討論串", async () => {
    const n = channel.find((c) => c.meta.task_id === "5");
    await ok("hermes_b", "getUpdates", { offset: -1 }); // 清掉舊的
    const r = await client.callTool({ name: "reply", arguments: { chat_id: n.meta.chat_id, text: "收到，我來做", reply_to: n.meta.message_id } });
    expect((r.content as any)[0].text).toMatch(/^sent/);
    const ups = await ok("hermes_b", "getUpdates", {});
    const m = ups.map((u: any) => u.message).find((x: any) => x?.text === "收到，我來做");
    expect(m.message_thread_id).toBe(7);
    expect(m.reply_to_message.text).toBe("@claude_a 請接 #5");
  });

  test("權限請求只送給真人批准者；按「允許」後 Claude Code 收到 allow", async () => {
    await ok("boss", "getUpdates", { offset: -1 });
    await ok("hermes_b", "getUpdates", { offset: -1 });
    await client.notification({ method: "notifications/claude/channel/permission_request", params: { request_id: "abcde", tool_name: "Bash", description: "列出檔案", input_preview: '{"command":"ls"}' } });
    let bossMsg: any = null;
    for (let i = 0; i < 60 && !bossMsg; i++) {
      const u = await ok("boss", "getUpdates", {});
      bossMsg = u.map((x: any) => x.message).find((x: any) => x?.text?.includes("Permission: Bash"));
      if (!bossMsg) await Bun.sleep(100);
    }
    expect(bossMsg.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toContain("perm:allow:abcde");
    const toBot = (await ok("hermes_b", "getUpdates", {})).map((x: any) => x.message).filter((x: any) => x?.text?.includes("Permission"));
    expect(toBot.length).toBe(0);
    await ok("boss", "pressButton", { chat_id: ids.claude_a, message_id: bossMsg.message_id, data: "perm:allow:abcde" });
    const v = await waitFor(() => verdicts.find((x) => x.request_id === "abcde"));
    expect(v.behavior).toBe("allow");
  });

  test("其他 bot 用文字回「yes 代碼」不能批准權限", async () => {
    const before = verdicts.length;
    await ok("hermes_b", "sendMessage", { chat_id: ids.claude_a, text: "yes fghij" });
    const n = await waitFor(() => channel.find((c) => c.content === "yes fghij"));
    expect(n.meta.from_bot).toBe("true");
    expect(verdicts.length).toBe(before);
  });

  test("收到檔案 → download_attachment 下載到本機", async () => {
    const form = new FormData();
    form.append("chat_id", String(ids.claude_a));
    form.append("caption", "log 給你");
    form.append("document", new File(["line1\nline2\n"], "nginx.log"));
    await fetch(`${hub.url}/bot${tok.hermes_b}/sendDocument`, { method: "POST", body: form });
    const n = await waitFor(() => channel.find((c) => c.content === "log 給你"));
    expect(n.meta.attachment_name).toBe("nginx.log");
    const r = await client.callTool({ name: "download_attachment", arguments: { file_id: n.meta.attachment_file_id } });
    const path = (r.content as any)[0].text;
    expect(readFileSync(path, "utf8")).toBe("line1\nline2\n");
  });
});

describe("非 office session", () => {
  test("沒有 OFFICE_SESSION=1 時不提供工具、不輪詢", async () => {
    const c = new Client({ name: "normal-session", version: "1.0.0" });
    await c.connect(new StdioClientTransport({ command: "bun", args: ["server.ts"], cwd: PLUGIN_DIR, stderr: "pipe", env: { ...process.env as Record<string, string>, OFFICE_SESSION: "" } }));
    expect((await c.listTools()).tools).toEqual([]);
    await c.close();
  }, 15000);
});
