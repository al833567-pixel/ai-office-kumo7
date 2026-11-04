// 登入與加入：
//   網頁：真人用帳號密碼登入（第一次開啟時設定管理者帳密），登入後拿到 session token，之後的 API 用法不變。
//   agent：新機器執行 office join，Hub 建立「加入申請」，網頁上按確認後才建立帳號，token 自動交給那台機器。
import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import { type Account, addMember, logEvent, OFFICE_GROUP_ID } from "./db";
import { authenticate, createAccount, createSession, deleteSession, hashSecret, newSecret, rotateToken } from "./auth";
import { ApiError, type Ctx } from "./botapi";
import { agentStates, taskMethods } from "./tasks";

export const KINDS = ["claude", "hermes", "codex", "antigravity", "other"] as const;
const JOIN_TTL_MS = 15 * 60_000;
const USERNAME_RE = /^[a-z][a-z0-9_]{2,31}$/;

type Json = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v));

export function isLocalIp(ip: string | null | undefined) {
  return !!ip && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
}

// ---------- 登入失敗次數限制（每個來源 IP：10 分鐘內最多 10 次） ----------
const failures = new Map<string, number[]>();
function tooMany(ip: string) {
  const t = Date.now();
  const list = (failures.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
  failures.set(ip, list);
  return list.length >= 10;
}
const fail = (ip: string) => { (failures.get(ip) ?? failures.set(ip, []).get(ip)!).push(Date.now()); };

const humans = (db: Database) => db.query("SELECT * FROM accounts WHERE is_bot = 0 AND disabled = 0 ORDER BY id").all() as Account[];
export const setupNeeded = (db: Database) => !humans(db).some((a) => a.password_hash);
const meObj = (a: Account) => ({ id: a.id, username: a.username, name: a.first_name });

function checkPassword(pw: string | undefined) {
  if (!pw || pw.length < 6) throw new ApiError(400, "Bad Request: 密碼至少 6 個字元");
  if (pw.length > 200) throw new ApiError(400, "Bad Request: 密碼太長");
  return pw;
}

/** /auth/*：status（GET）、setup、login、logout */
export async function handleAuth(db: Database, action: string, body: Json, ip: string, bearer: string, userAgent: string | null) {
  switch (action) {
    case "status":
      return { setup_needed: setupNeeded(db), local: isLocalIp(ip) };

    case "setup": {
      if (!setupNeeded(db)) throw new ApiError(409, "Conflict: 已經設定過帳號密碼，請直接登入");
      // 第一次設定只能在 Hub 那台電腦（127.0.0.1）做，或附上真人帳號的舊 token，避免別台搶先設定
      const viaToken = bearer ? authenticate(db, bearer) : null;
      if (!isLocalIp(ip) && !(viaToken && !viaToken.is_bot)) {
        throw new ApiError(403, "Forbidden: 第一次設定請在 Hub 那台電腦開 http://127.0.0.1:7070 進行");
      }
      const username = (s(body.username) ?? "").trim().toLowerCase();
      if (!USERNAME_RE.test(username)) throw new ApiError(400, "Bad Request: 帳號只能用小寫英文、數字、底線，3–32 字，英文開頭");
      const name = (s(body.name) ?? "").trim() || username;
      if ([...name].length > 24) throw new ApiError(400, "Bad Request: 顯示名稱最多 24 個字");
      const hash = await Bun.password.hash(checkPassword(s(body.password)));
      // 沿用既有的真人帳號（例如 init 建立的 boss），保留它的 id（設定檔 approvers 用的是 id）
      let acc = viaToken && !viaToken.is_bot ? viaToken : humans(db)[0] ?? null;
      const taken = db.query("SELECT id FROM accounts WHERE username = ?").get(username) as { id: number } | null;
      if (taken && taken.id !== acc?.id) throw new ApiError(400, "Bad Request: 這個帳號名稱已被 agent 使用");
      if (acc) {
        db.query("UPDATE accounts SET username = ?, first_name = ?, password_hash = ? WHERE id = ?").run(username, name, hash, acc.id);
        acc = db.query("SELECT * FROM accounts WHERE id = ?").get(acc.id) as Account;
      } else {
        acc = createAccount(db, { username, firstName: name, isBot: false, kind: "human" }).account;
        db.query("UPDATE accounts SET password_hash = ? WHERE id = ?").run(hash, acc.id);
        addMember(db, OFFICE_GROUP_ID, acc.id);
      }
      logEvent(db, "account", acc.id, null, { id: acc.id, username: acc.username, first_name: acc.first_name, kind: acc.kind, machine: acc.machine, is_bot: false });
      return { token: createSession(db, acc, 90, userAgent), me: meObj(acc) };
    }

    case "login": {
      if (tooMany(ip)) throw new ApiError(429, "Too Many Requests: 失敗太多次，請 10 分鐘後再試");
      const username = (s(body.username) ?? "").trim().toLowerCase().replace(/^@/, "");
      const acc = db.query("SELECT * FROM accounts WHERE username = ? AND is_bot = 0 AND disabled = 0").get(username) as Account | null;
      const ok = !!acc?.password_hash && await Bun.password.verify(s(body.password) ?? "", acc.password_hash);
      if (!acc || !ok) { fail(ip); throw new ApiError(401, "Unauthorized: 帳號或密碼不正確"); }
      return { token: createSession(db, acc, 90, userAgent), me: meObj(acc) };
    }

    case "logout":
      if (bearer) deleteSession(db, bearer);
      return true;
  }
  throw new ApiError(404, "Not Found");
}

// ---------- agent 加入申請 ----------
interface JoinRow {
  id: number; code: string; secret_hash: string; kind: string; name: string; machine: string | null; hostname: string | null; platform: string | null;
  ip: string | null; status: string; username: string | null; token: string | null; created_at: number; expires_at: number; decided_by: number | null;
}
export function joinObj(db: Database, r: JoinRow) {
  // 建議帳號：同種類、同機器的既有 agent（例如 init 建好的 claude_b）就沿用它＝重新加入、換新 token
  const suggested = r.status === "pending" ? suggestUsername(null, r.kind, r.machine) : null;
  const existing = suggested ? db.query("SELECT kind, is_bot FROM accounts WHERE username = ?").get(suggested) as { kind: string; is_bot: number } | null : null;
  const reuse = !!existing && !!existing.is_bot && existing.kind === r.kind;
  return {
    request_id: r.id, code: r.code, kind: r.kind, name: r.name, machine: r.machine, hostname: r.hostname, platform: r.platform, ip: r.ip,
    status: r.status === "pending" && r.expires_at < Date.now() ? "expired" : r.status, username: r.username,
    suggested_username: suggested ? (existing && !reuse ? suggestUsername(db, r.kind, r.machine) : suggested) : null,
    existing_account: reuse, created_at: r.created_at, expires_at: r.expires_at,
  };
}
const getJoin = (db: Database, id: number) => db.query("SELECT * FROM join_requests WHERE id = ?").get(id) as JoinRow | null;
export const pendingJoins = (db: Database) =>
  (db.query("SELECT * FROM join_requests WHERE status = 'pending' AND expires_at > ? ORDER BY id").all(Date.now()) as JoinRow[]).map((r) => joinObj(db, r));

function suggestUsername(db: Database | null, kind: string, machine: string | null) {
  const base = (kind === "antigravity" ? "agy" : kind) + (machine ? "_" + machine.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : "");
  const root = USERNAME_RE.test(base) ? base : `${kind}_agent`;
  if (!db) return root;
  let u = root, n = 2;
  while (db.query("SELECT 1 FROM accounts WHERE username = ?").get(u)) u = `${root}_${n++}`;
  return u;
}

/** POST /join：不需要 token。建立申請，回傳代碼（網頁上會顯示同一組代碼）與取回 token 用的祕密 */
export function createJoin(db: Database, body: Json, ip: string) {
  const kind = (s(body.kind) ?? "").trim().toLowerCase();
  if (!(KINDS as readonly string[]).includes(kind)) throw new ApiError(400, `Bad Request: kind 要是 ${KINDS.join("、")} 其中之一`);
  const name = ((s(body.name) ?? "").replace(/[\r\n\t]/g, " ").trim() || kind).slice(0, 24);
  const machine = (s(body.machine) ?? "").trim().slice(0, 16) || null;
  if (machine && !/^[A-Za-z0-9_-]+$/.test(machine)) throw new ApiError(400, "Bad Request: machine 只能用英數字、-、_");
  const t = Date.now();
  const pending = (db.query("SELECT COUNT(*) AS n FROM join_requests WHERE status = 'pending' AND expires_at > ? AND ip = ?").get(t, ip) as { n: number }).n;
  if (pending >= 5) throw new ApiError(429, "Too Many Requests: 這台已經有太多待確認的申請");
  const secret = newSecret();
  const code = String(randomInt(0, 10000)).padStart(4, "0");
  const row = db.query(`INSERT INTO join_requests (code, secret_hash, kind, name, machine, hostname, platform, ip, created_at, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(code, hashSecret(secret), kind, name, machine, (s(body.hostname) ?? "").slice(0, 64) || null, (s(body.platform) ?? "").slice(0, 16) || null, ip, t, t + JOIN_TTL_MS) as JoinRow;
  logEvent(db, "join", null, null, joinObj(db, row));
  return { request_id: row.id, code, secret, expires_in: JOIN_TTL_MS / 1000 };
}

/** POST /join/wait：申請者等結果。核准後只交出一次 token */
export async function waitJoin(db: Database, body: Json, signal?: AbortSignal) {
  const id = Number(body.request_id);
  const timeout = Math.min(Math.max(Number(body.timeout ?? 30) || 0, 0), 50);
  const deadline = Date.now() + timeout * 1000;
  const check = () => {
    const r = getJoin(db, id);
    if (!r || r.secret_hash !== hashSecret(s(body.secret) ?? "")) throw new ApiError(404, "Not Found: 找不到這個申請");
    return r;
  };
  let r = check();
  while (r.status === "pending" && r.expires_at > Date.now() && Date.now() < deadline && !signal?.aborted) {
    await Bun.sleep(500);
    r = check();
  }
  const status = joinObj(db, r).status;
  if (r.status === "approved" && r.token) {
    db.query("UPDATE join_requests SET token = NULL, status = 'delivered' WHERE id = ?").run(r.id);
    const acc = db.query("SELECT username, first_name, kind, machine FROM accounts WHERE username = ?").get(r.username) as Json | null;
    return { status: "approved", token: r.token, username: r.username, name: acc?.first_name, kind: acc?.kind, machine: acc?.machine };
  }
  return { status: status === "approved" ? "delivered" : status };
}

// ---------- 給網頁（真人）用的方法 ----------
const humanOnly = (ctx: Ctx) => { if (ctx.me.is_bot) throw new ApiError(403, "Forbidden: only humans"); };

export const accessMethods: Record<string, (ctx: Ctx, p: Json) => unknown> = {
  getJoinRequests(ctx) { humanOnly(ctx); return pendingJoins(ctx.db); },

  approveJoin(ctx, p) {
    humanOnly(ctx);
    const { db } = ctx;
    const r = getJoin(db, Number(p.request_id));
    if (!r || r.status !== "pending") throw new ApiError(400, "Bad Request: 這個申請已經處理過了");
    if (r.expires_at < Date.now()) throw new ApiError(400, "Bad Request: 申請已過期，請在那台電腦重新執行 office join");
    const kind = s(p.kind) && (KINDS as readonly string[]).includes(s(p.kind)!) ? s(p.kind)! : r.kind;
    const machine = (s(p.machine) ?? r.machine ?? "").trim().slice(0, 16) || null;
    const name = ((s(p.name) ?? r.name).replace(/[\r\n\t]/g, " ").trim() || r.name).slice(0, 24);
    // 沒指定帳號就用卡片上的建議（同種類同機器的既有帳號＝重新加入）
    let username = (s(p.username) ?? "").trim().toLowerCase().replace(/^@/, "") || joinObj(db, r).suggested_username || "";
    let token: string;
    const existing = username ? db.query("SELECT * FROM accounts WHERE username = ?").get(username) as Account | null : null;
    if (existing) {
      // 同一個 agent 重新加入（重灌、換電腦）：沿用帳號，換新 token（舊的立即失效）
      if (!existing.is_bot) throw new ApiError(400, "Bad Request: 不能把 agent 加到真人帳號");
      token = rotateToken(db, existing.username);
      db.query("UPDATE accounts SET first_name = ?, kind = ?, machine = ?, disabled = 0 WHERE id = ?").run(name, kind, machine, existing.id);
      addMember(db, OFFICE_GROUP_ID, existing.id);
    } else {
      username ||= suggestUsername(db, kind, machine);
      if (!USERNAME_RE.test(username)) throw new ApiError(400, "Bad Request: 帳號只能用小寫英文、數字、底線，3–32 字，英文開頭");
      const created = createAccount(db, { username, firstName: name, isBot: true, kind, machine });
      addMember(db, OFFICE_GROUP_ID, created.account.id);
      token = created.token;
    }
    db.query("UPDATE join_requests SET status = 'approved', username = ?, token = ?, decided_by = ? WHERE id = ?").run(username, token, ctx.me.id, r.id);
    const acc = db.query("SELECT * FROM accounts WHERE username = ?").get(username) as Account;
    logEvent(db, "account", ctx.me.id, null, { id: acc.id, username, first_name: acc.first_name, kind: acc.kind, machine: acc.machine, is_bot: true, joined: true });
    logEvent(db, "join", ctx.me.id, null, joinObj(db, getJoin(db, r.id)!));
    return { username, name: acc.first_name, kind: acc.kind, machine: acc.machine, rejoined: !!existing };
  },

  rejectJoin(ctx, p) {
    humanOnly(ctx);
    const r = getJoin(ctx.db, Number(p.request_id));
    if (!r || r.status !== "pending") throw new ApiError(400, "Bad Request: 這個申請已經處理過了");
    ctx.db.query("UPDATE join_requests SET status = 'rejected', decided_by = ? WHERE id = ?").run(ctx.me.id, r.id);
    logEvent(ctx.db, "join", ctx.me.id, null, joinObj(ctx.db, getJoin(ctx.db, r.id)!));
    return true;
  },

  // ---------- 成員管理（網頁）----------
  getMembers(ctx) {
    humanOnly(ctx);
    const { db } = ctx;
    const states = agentStates(ctx);
    const rows = db.query("SELECT * FROM accounts WHERE deleted = 0 ORDER BY is_bot DESC, disabled, id").all() as Account[];
    return rows.map((a) => {
      const st = states[a.username];
      const openTasks = (db.query("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status IN ('todo','doing','blocked')").get(a.id) as { n: number }).n;
      const leading = (db.query("SELECT COUNT(*) AS n FROM goals WHERE lead_id = ? AND status = 'doing'").get(a.id) as { n: number }).n;
      return { id: a.id, username: a.username, name: a.first_name, kind: a.kind, machine: a.machine, is_bot: !!a.is_bot, disabled: !!a.disabled,
        is_me: a.id === ctx.me.id, state: a.is_bot && !a.disabled ? st?.state ?? "offline" : null, last_seen: st?.last_seen ?? null,
        notes: a.notes ?? null, notes_by: a.notes_by ?? null, notes_at: a.notes_at ?? null,
        open_tasks: openTasks, leading_goals: leading, created_at: (a as Account & { created_at?: number }).created_at ?? null };
    });
  },

  updateMember(ctx, p) {
    humanOnly(ctx);
    const a = memberBot(ctx, p.username);
    const name = s(p.name) !== undefined ? (s(p.name) ?? "").replace(/[\r\n\t]/g, " ").trim() : a.first_name;
    if (!name || [...name].length > 24) throw new ApiError(400, "Bad Request: 名稱要 1–24 個字");
    const machine = s(p.machine) !== undefined ? (s(p.machine) ?? "").trim().slice(0, 16) || null : a.machine;
    if (machine && !/^[A-Za-z0-9_-]+$/.test(machine)) throw new ApiError(400, "Bad Request: 機器代號只能用英數字、-、_");
    const kind = s(p.kind) !== undefined ? s(p.kind)! : a.kind;
    if (!(KINDS as readonly string[]).includes(kind)) throw new ApiError(400, `Bad Request: 種類要是 ${KINDS.join("、")} 其中之一`);
    ctx.db.query("UPDATE accounts SET first_name = ?, machine = ?, kind = ? WHERE id = ?").run(name, machine, kind, a.id);
    memberEvent(ctx, a.id, { changed: true });
    return true;
  },

  /** 停用：token 立即失效、從辦公室畫面拿掉，可重新啟用；手上未完成的任務改派給各目標的主管 */
  disableMember(ctx, p) {
    humanOnly(ctx);
    const a = memberBot(ctx, p.username);
    ctx.db.query("UPDATE accounts SET disabled = 1 WHERE id = ?").run(a.id);
    const moved = handOver(ctx, a);
    memberEvent(ctx, a.id, { changed: true, disabled: true });
    return { reassigned: moved.reassigned, left: moved.left };
  },

  enableMember(ctx, p) {
    humanOnly(ctx);
    const a = memberBot(ctx, p.username);
    ctx.db.query("UPDATE accounts SET disabled = 0 WHERE id = ?").run(a.id);
    addMember(ctx.db, OFFICE_GROUP_ID, a.id);
    memberEvent(ctx, a.id, { changed: true, disabled: false });
    return true;
  },

  /** 刪除：永久作廢 token，帳號名稱空出來可再用；聊天與任務歷史仍顯示原本的名字 */
  deleteMember(ctx, p) {
    humanOnly(ctx);
    const a = memberBot(ctx, p.username);
    ctx.db.query("UPDATE accounts SET disabled = 1 WHERE id = ?").run(a.id);
    const moved = handOver(ctx, a);
    const freed = `${a.username.slice(0, 20)}_del${a.id}`.slice(0, 32);
    ctx.db.query("UPDATE accounts SET deleted = 1, username = ?, token_hash = ? WHERE id = ?").run(freed, hashSecret(newSecret()), a.id);
    ctx.db.query("DELETE FROM chat_members WHERE account_id = ?").run(a.id);
    ctx.db.query("DELETE FROM updates WHERE account_id = ?").run(a.id);
    ctx.db.query("DELETE FROM presence WHERE account_id = ?").run(a.id);
    logEvent(ctx.db, "account", ctx.me.id, null, { id: a.id, username: a.username, first_name: a.first_name, kind: a.kind, machine: a.machine, is_bot: true, changed: true, deleted: true });
    return { reassigned: moved.reassigned, left: moved.left };
  },

  async changePassword(ctx, p) {
    humanOnly(ctx);
    const acc = ctx.db.query("SELECT * FROM accounts WHERE id = ?").get(ctx.me.id) as Account;
    if (acc.password_hash && !await Bun.password.verify(s(p.old_password) ?? "", acc.password_hash)) throw new ApiError(400, "Bad Request: 舊密碼不正確");
    ctx.db.query("UPDATE accounts SET password_hash = ? WHERE id = ?").run(await Bun.password.hash(checkPassword(s(p.new_password))), acc.id);
    return true;
  },
};

function memberBot(ctx: Ctx, username: unknown) {
  const u = (s(username) ?? "").replace(/^@/, "");
  const a = ctx.db.query("SELECT * FROM accounts WHERE username = ? AND deleted = 0").get(u) as Account | null;
  if (!a) throw new ApiError(400, "Bad Request: 找不到這個成員");
  if (!a.is_bot) throw new ApiError(400, "Bad Request: 真人帳號不能在這裡停用或刪除");
  return a;
}

function memberEvent(ctx: Ctx, id: number, extra: Json) {
  const a = ctx.db.query("SELECT * FROM accounts WHERE id = ?").get(id) as Account;
  logEvent(ctx.db, "account", ctx.me.id, null, { id: a.id, username: a.username, first_name: a.first_name, kind: a.kind, machine: a.machine, is_bot: !!a.is_bot, ...extra });
}

/** 停用或刪除前：未完成的任務改派給該目標的主管（主管就是自己或也不能用時留著，回報數量給網頁提示） */
function handOver(ctx: Ctx, a: Account) {
  const { db } = ctx;
  const tasks = db.query(`SELECT t.id, g.lead_id FROM tasks t JOIN goals g ON g.id = t.goal_id
                          WHERE t.assignee_id = ? AND t.status IN ('todo','doing','blocked')`).all(a.id) as { id: number; lead_id: number }[];
  let reassigned = 0, left = 0;
  for (const t of tasks) {
    const lead = db.query("SELECT * FROM accounts WHERE id = ? AND disabled = 0").get(t.lead_id) as Account | null;
    if (!lead || lead.id === a.id) { left++; continue; }
    try { taskMethods.reassignTask(ctx, { task_id: t.id, assignee: lead.username }); reassigned++; } catch { left++; }
  }
  left += (db.query("SELECT COUNT(*) AS n FROM goals WHERE lead_id = ? AND status = 'doing'").get(a.id) as { n: number }).n;
  return { reassigned, left };
}
