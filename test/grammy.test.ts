// 相容性測試：用真正的 grammY（官方 Claude Code Telegram 外掛使用的套件）連到 Hub。
// 只改 apiRoot，其餘照一般 Telegram bot 的寫法。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Bot } from "grammy";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

let hub: ReturnType<typeof startHub>;
let tokenA = "", tokenB = "", idB = 0;

beforeAll(() => {
  const db = openDb(":memory:");
  hub = startHub({ db, port: 0, maxPoll: 5 });
  const a = createAccount(db, { username: "claude_a", firstName: "Claude-A", isBot: true });
  const b = createAccount(db, { username: "claude_b", firstName: "Claude-B", isBot: true });
  addMember(db, OFFICE_GROUP_ID, a.account.id);
  addMember(db, OFFICE_GROUP_ID, b.account.id);
  tokenA = a.token; tokenB = b.token; idB = b.account.id;
});
afterAll(() => hub.stop());

test("grammY bot 用長輪詢收訊息並回覆（群組與私聊）", async () => {
  const botB = new Bot(tokenB, { client: { apiRoot: hub.url } });
  const seen: string[] = [];
  botB.on("message:text", async (ctx) => {
    seen.push(`${ctx.chat.type}:${ctx.message.text}`);
    await ctx.replyWithChatAction("typing");
    await ctx.reply(`收到：${ctx.message.text}`, { reply_parameters: { message_id: ctx.message.message_id } });
  });
  const started = new Promise<void>((resolve) => botB.start({ timeout: 2, onStart: () => resolve() }));
  await started;

  const botA = new Bot(tokenA, { client: { apiRoot: hub.url } });
  await botA.init();
  expect(botA.botInfo.username).toBe("claude_a");
  await botA.api.sendMessage(OFFICE_GROUP_ID, "群組測試");
  await botA.api.sendMessage(idB, "私聊測試");

  // 等 B 處理完兩則
  for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(100);
  expect(seen).toEqual(["supergroup:群組測試", "private:私聊測試"]);

  // A 讀回 B 的回覆
  const ups = await botA.api.getUpdates({ timeout: 0 });
  const replies = ups.map((u) => u.message?.text);
  expect(replies).toEqual(["收到：群組測試", "收到：私聊測試"]);
  expect(ups[1].message?.reply_to_message?.text).toBe("私聊測試");

  await botB.stop();
}, 20000);
