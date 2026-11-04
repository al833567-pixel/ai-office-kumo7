// 帳號密碼登入、agent 申請加入
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

let hub: ReturnType<typeof startHub>;
let bossToken = "";
const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  (await fetch(`${hub.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json() as Promise<any>;
const userCall = (token: string, method: string, p: unknown = {}) => post(`/user${token}/${method}`, p);

beforeAll(() => {
  const db = openDb(":memory:");
  hub = startHub({ db, port: 0 });
  const boss = createAccount(db, { username: "boss", firstName: "老闆", isBot: false, kind: "human" });
  addMember(db, OFFICE_GROUP_ID, boss.account.id);
  bossToken = boss.token;
  const c = createAccount(db, { username: "claude_a", firstName: "Claude-A", isBot: true, kind: "claude", machine: "A" });
  addMember(db, OFFICE_GROUP_ID, c.account.id);
});
afterAll(() => hub.stop());

describe("網頁登入", () => {
  let session = "";
  test("第一次：需要設定；在本機設定帳密後沿用原本的真人帳號（id 不變）", async () => {
    expect((await (await fetch(`${hub.url}/auth/status`)).json()).result).toEqual({ setup_needed: true, local: true });
    expect((await post("/auth/setup", { username: "kumo", password: "123" })).ok).toBe(false); // 密碼太短
    const r = await post("/auth/setup", { username: "kumo", name: "Kumo", password: "secret123" });
    expect(r.ok).toBe(true);
    expect(r.result.me).toMatchObject({ id: 1000000001, username: "kumo", name: "Kumo" });
    session = r.result.token;
    expect((await userCall(session, "getMe")).result).toMatchObject({ username: "kumo", is_bot: false });
    expect((await (await fetch(`${hub.url}/auth/status`)).json()).result.setup_needed).toBe(false);
    expect((await post("/auth/setup", { username: "evil", password: "secret123" })).error_code).toBe(409);
  });

  test("登入：密碼錯被拒；對了拿到 session；舊的帳號 token 仍可用；登出後 session 失效", async () => {
    expect((await post("/auth/login", { username: "kumo", password: "wrong!!" })).error_code).toBe(401);
    expect((await post("/auth/login", { username: "claude_a", password: "x" })).error_code).toBe(401);
    const r = await post("/auth/login", { username: "Kumo", password: "secret123" });
    expect(r.ok).toBe(true);
    const tok = r.result.token as string;
    expect((await userCall(tok, "getMe")).ok).toBe(true);
    expect((await userCall(bossToken, "getMe")).ok).toBe(true);
    await post("/auth/logout", {}, { authorization: `Bearer ${tok}` });
    expect((await userCall(tok, "getMe")).ok).toBe(false);
    expect((await userCall(session, "getMe")).ok).toBe(true); // 其他 session 不受影響
  });

  test("改密碼", async () => {
    expect((await userCall(session, "changePassword", { old_password: "nope", new_password: "newpass1" })).ok).toBe(false);
    expect((await userCall(session, "changePassword", { old_password: "secret123", new_password: "newpass1" })).ok).toBe(true);
    expect((await post("/auth/login", { username: "kumo", password: "newpass1" })).ok).toBe(true);
  });

  test("session 不能拿來當 bot 用；bot token 不能登入網頁 API", async () => {
    expect((await post(`/bot${session}/getMe`)).ok).toBe(false);
  });

  // 給下一組測試用
  afterAll(() => { bossToken = session; });
});

let oldHermesToken = "";
describe("agent 申請加入", () => {
  test("申請 → 網頁看到代碼 → 確認 → 申請者拿到 token（只拿一次）→ 可以用", async () => {
    const j = await post("/join", { kind: "hermes", name: "Hermes-B", machine: "B", hostname: "pc-b", platform: "win32" });
    expect(j.ok).toBe(true);
    expect(j.result.code).toMatch(/^\d{4}$/);
    const pending = (await userCall(bossToken, "getJoinRequests")).result;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ code: j.result.code, kind: "hermes", name: "Hermes-B", machine: "B", hostname: "pc-b", suggested_username: "hermes_b", existing_account: false });
    expect(pending[0].secret).toBeUndefined();

    // 還沒確認：等一下就回 pending
    expect((await post("/join/wait", { request_id: j.result.request_id, secret: j.result.secret, timeout: 1 })).result.status).toBe("pending");
    // 祕密錯誤拿不到
    expect((await post("/join/wait", { request_id: j.result.request_id, secret: "x", timeout: 0 })).ok).toBe(false);

    const waiting = post("/join/wait", { request_id: j.result.request_id, secret: j.result.secret, timeout: 10 });
    const ap = await userCall(bossToken, "approveJoin", { request_id: j.result.request_id });
    expect(ap.result).toMatchObject({ username: "hermes_b", kind: "hermes", machine: "B", rejoined: false });
    const w = (await waiting).result;
    expect(w).toMatchObject({ status: "approved", username: "hermes_b", kind: "hermes" });
    expect((await post(`/bot${w.token}/getMe`)).result.username).toBe("hermes_b");
    oldHermesToken = w.token;
    expect((await post("/join/wait", { request_id: j.result.request_id, secret: j.result.secret, timeout: 0 })).result).toEqual({ status: "delivered" });
    expect((await userCall(bossToken, "getJoinRequests")).result).toHaveLength(0);
  });

  test("拒絕；拒絕後不能再核准", async () => {
    const j = await post("/join", { kind: "codex", name: "Codex" });
    expect((await userCall(bossToken, "rejectJoin", { request_id: j.result.request_id })).ok).toBe(true);
    expect((await post("/join/wait", { request_id: j.result.request_id, secret: j.result.secret, timeout: 0 })).result.status).toBe("rejected");
    expect((await userCall(bossToken, "approveJoin", { request_id: j.result.request_id })).ok).toBe(false);
  });

  test("重新加入既有帳號：換新 token，舊的失效；種類不合法會被拒", async () => {
    expect((await post("/join", { kind: "gpt" })).ok).toBe(false);
    const j1 = await post("/join", { kind: "hermes", machine: "B" });
    expect((await userCall(bossToken, "getJoinRequests")).result[0]).toMatchObject({ suggested_username: "hermes_b", existing_account: true });
    const w1p = post("/join/wait", { request_id: j1.result.request_id, secret: j1.result.secret, timeout: 10 });
    expect((await userCall(bossToken, "approveJoin", { request_id: j1.result.request_id, username: "hermes_b", name: "赫米B" })).result).toMatchObject({ rejoined: true, name: "赫米B" });
    const w1 = (await w1p).result;
    expect((await post(`/bot${w1.token}/getMe`)).result).toMatchObject({ username: "hermes_b", first_name: "赫米B" });
    expect((await post(`/bot${oldHermesToken}/getMe`)).ok).toBe(false);
    // 不能把 agent 綁到真人帳號
    const j2 = await post("/join", { kind: "other" });
    expect((await userCall(bossToken, "approveJoin", { request_id: j2.result.request_id, username: "kumo" })).ok).toBe(false);
  });
});
