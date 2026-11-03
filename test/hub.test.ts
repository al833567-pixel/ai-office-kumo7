import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

let hub: ReturnType<typeof startHub>;
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, params: Record<string, unknown> = {}, kind = "bot") {
  const res = await fetch(`${hub.url}/${kind}${tok[who]}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<any>;
}

beforeAll(() => {
  const db = openDb(":memory:");
  hub = startHub({ db, port: 0, loopLimit: 5, maxPoll: 10 });
  for (const [u, isBot] of [["claude_a", true], ["claude_b", true], ["hermes_b", true], ["boss", false], ["outsider", true]] as const) {
    const { account, token } = createAccount(db, { username: u, firstName: u, isBot });
    tok[u] = token;
    ids[u] = account.id;
    if (u !== "outsider") addMember(db, OFFICE_GROUP_ID, account.id);
  }
});
afterAll(() => hub.stop());

describe("身分", () => {
  test("getMe 回傳 bot 資料", async () => {
    const r = await call("claude_a", "getMe");
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ id: ids.claude_a, is_bot: true, username: "claude_a", can_read_all_group_messages: true });
  });
  test("錯誤 token 回 401", async () => {
    const r = await (await fetch(`${hub.url}/bot${ids.claude_a}:wrongwrongwrongwrongwrong/getMe`)).json() as any;
    expect(r).toMatchObject({ ok: false, error_code: 401 });
  });
  test("bot token 不能走 /user 路徑", async () => {
    const r = await call("claude_a", "getMe", {}, "user");
    expect(r.error_code).toBe(401);
  });
  test("不支援的方法回 404", async () => {
    const r = await call("claude_a", "sendSticker", { chat_id: OFFICE_GROUP_ID });
    expect(r).toMatchObject({ ok: false, error_code: 404 });
  });
});

describe("私聊", () => {
  test("A 傳給 B，B 收得到、A 自己收不到；chat.id 是對方的 id", async () => {
    const sent = await call("claude_a", "sendMessage", { chat_id: ids.claude_b, text: "幫我審查 #14" });
    expect(sent.ok).toBe(true);
    expect(sent.result.chat).toMatchObject({ id: ids.claude_b, type: "private" });

    const b = await call("claude_b", "getUpdates", {});
    const last = b.result.at(-1);
    expect(last.message).toMatchObject({ text: "幫我審查 #14", chat: { id: ids.claude_a, type: "private" }, from: { username: "claude_a" } });

    const a = await call("claude_a", "getUpdates", {});
    expect(a.result.length).toBe(0);
  });

  test("可用 @username 當 chat_id", async () => {
    const r = await call("claude_a", "sendMessage", { chat_id: "@hermes_b", text: "hi" });
    expect(r.ok).toBe(true);
  });

  test("回覆與結構化 data 欄位", async () => {
    const first = await call("claude_a", "sendMessage", {
      chat_id: ids.hermes_b, text: "任務 #16", data: { type: "task", task_id: 16, verify: "crontab -l" },
    });
    const ans = await call("hermes_b", "sendMessage", {
      chat_id: ids.claude_a, text: "完成", reply_parameters: { message_id: first.result.message_id }, data: { type: "report", task_id: 16, exit: 0 },
    });
    expect(ans.result.reply_to_message.text).toBe("任務 #16");
    expect(ans.result.reply_to_message.data).toEqual({ type: "task", task_id: 16, verify: "crontab -l" });
    expect(ans.result.data).toEqual({ type: "report", task_id: 16, exit: 0 });
  });
});

describe("群組", () => {
  test("群組訊息送給其他所有成員，包含其他 bot", async () => {
    for (const u of ["claude_a", "claude_b", "hermes_b", "boss"]) await drain(u);
    const r = await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "@hermes_b 請設定 cron", message_thread_id: 12 });
    expect(r.result.chat).toMatchObject({ id: OFFICE_GROUP_ID, type: "supergroup", is_forum: true });
    expect(r.result.message_thread_id).toBe(12);
    for (const u of ["claude_b", "hermes_b"]) {
      const up = await call(u, "getUpdates", {});
      expect(up.result.at(-1).message.text).toBe("@hermes_b 請設定 cron");
    }
    const boss = await call("boss", "getUpdates", {}, "user");
    expect(boss.result.at(-1).message.from.username).toBe("claude_a");
    expect((await call("claude_a", "getUpdates", {})).result.length).toBe(0);
  });

  test("非成員不能發到群組", async () => {
    const r = await call("outsider", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "嗨" });
    expect(r.error_code).toBe(403);
  });

  test("@office 可代表群組", async () => {
    const r = await call("claude_b", "sendMessage", { chat_id: "@office", text: "收到" });
    expect(r.result.chat.id).toBe(OFFICE_GROUP_ID);
  });
});

async function drain(who: string) {
  const kind = who === "boss" ? "user" : "bot";
  const r = await call(who, "getUpdates", {}, kind);
  const last = r.result.at(-1);
  if (last) await call(who, "getUpdates", { offset: last.update_id + 1 }, kind);
}

describe("getUpdates", () => {
  test("offset 確認後舊更新就不再回傳", async () => {
    await drain("claude_b");
    await call("claude_a", "sendMessage", { chat_id: ids.claude_b, text: "one" });
    await call("claude_a", "sendMessage", { chat_id: ids.claude_b, text: "two" });
    const r1 = await call("claude_b", "getUpdates", {});
    expect(r1.result.map((u: any) => u.message.text)).toEqual(["one", "two"]);
    const r2 = await call("claude_b", "getUpdates", { offset: r1.result[0].update_id + 1 });
    expect(r2.result.map((u: any) => u.message.text)).toEqual(["two"]);
  });

  test("長輪詢：有新訊息時立刻回傳", async () => {
    await drain("claude_b");
    const t0 = Date.now();
    const pending = call("claude_b", "getUpdates", { timeout: 8 });
    setTimeout(() => call("claude_a", "sendMessage", { chat_id: ids.claude_b, text: "wake up" }), 300);
    const r = await pending;
    expect(r.result.at(-1).message.text).toBe("wake up");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("長輪詢：沒有訊息時等到逾時回空陣列", async () => {
    await drain("claude_b");
    const t0 = Date.now();
    const r = await call("claude_b", "getUpdates", { timeout: 1 });
    expect(r.result).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("同一個 bot 開第二條長輪詢時，舊的那條會被接手並回空陣列", async () => {
    await drain("claude_b");
    const old = call("claude_b", "getUpdates", { timeout: 8 });
    await Bun.sleep(100);
    const fresh = call("claude_b", "getUpdates", { timeout: 8 });
    expect((await old).result).toEqual([]);
    setTimeout(() => call("claude_a", "sendMessage", { chat_id: ids.claude_b, text: "to fresh" }), 200);
    expect((await fresh).result.at(-1).message.text).toBe("to fresh");
  });
});

describe("編輯、狀態、反應、指令", () => {
  test("editMessageText 會送 edited_message 給對方；只有作者能改", async () => {
    await drain("hermes_b");
    const m = await call("claude_a", "sendMessage", { chat_id: ids.hermes_b, text: "進度 10%" });
    const e = await call("claude_a", "editMessageText", { chat_id: ids.hermes_b, message_id: m.result.message_id, text: "進度 80%" });
    expect(e.result).toMatchObject({ text: "進度 80%" });
    expect(e.result.edit_date).toBeGreaterThan(0);
    const up = await call("hermes_b", "getUpdates", {});
    expect(up.result.at(-1).edited_message.text).toBe("進度 80%");
    const bad = await call("hermes_b", "editMessageText", { chat_id: ids.claude_a, message_id: m.result.message_id, text: "改你的" });
    expect(bad.ok).toBe(false);
  });

  test("sendChatAction、setMessageReaction、setMyCommands", async () => {
    expect((await call("claude_a", "sendChatAction", { chat_id: OFFICE_GROUP_ID, action: "typing" })).result).toBe(true);
    expect((await call("claude_a", "sendChatAction", { chat_id: OFFICE_GROUP_ID, action: "dancing" })).ok).toBe(false);
    const m = await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "react me" });
    expect((await call("claude_b", "setMessageReaction", { chat_id: OFFICE_GROUP_ID, message_id: m.result.message_id, reaction: [{ type: "emoji", emoji: "👀" }] })).result).toBe(true);
    await call("claude_a", "setMyCommands", { commands: [{ command: "office", description: "交給團隊" }] });
    expect((await call("claude_a", "getMyCommands")).result).toEqual([{ command: "office", description: "交給團隊" }]);
  });

  test("deleteWebhook / getWebhookInfo 可呼叫（長輪詢客戶端啟動時需要）", async () => {
    expect((await call("claude_a", "deleteWebhook", { drop_pending_updates: false })).result).toBe(true);
    expect((await call("claude_a", "getWebhookInfo")).result.url).toBe("");
  });
});

describe("防循環", () => {
  test("同一個 bot 連發多則不算循環", async () => {
    for (let i = 0; i < 8; i++) {
      expect((await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: 98, text: `連發 ${i}` })).ok).toBe(true);
    }
  });

  test("bot 之間來回達上限會被擋，真人發言後解除", async () => {
    const thread = 99;
    for (let i = 0; i < 5; i++) {
      const r = await call(i % 2 ? "claude_a" : "claude_b", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: thread, text: `來回 ${i}` });
      expect(r.ok).toBe(true);
    }
    const blocked = await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: thread, text: "再一句" });
    expect(blocked).toMatchObject({ ok: false, error_code: 403 });
    // 其他串不受影響
    expect((await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: 100, text: "別串" })).ok).toBe(true);
    // 真人發言後解除
    expect((await call("boss", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: thread, text: "繼續" }, "user")).ok).toBe(true);
    expect((await call("claude_a", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: thread, text: "好的" })).ok).toBe(true);
  });
});

describe("參數格式", () => {
  test("支援 form-urlencoded 與 query string（curl 常用）", async () => {
    const body = new URLSearchParams({ chat_id: String(ids.claude_b), text: "form 格式", data: JSON.stringify({ k: 1 }) });
    const r = await (await fetch(`${hub.url}/bot${tok.claude_a}/sendMessage`, { method: "POST", body })).json() as any;
    expect(r.result).toMatchObject({ text: "form 格式", data: { k: 1 } });
    const q = await (await fetch(`${hub.url}/bot${tok.claude_a}/sendMessage?chat_id=${ids.claude_b}&text=query`)).json() as any;
    expect(q.result.text).toBe("query");
  });
});
