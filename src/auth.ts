// Token 格式與 Telegram 相同：<帳號 id>:<祕密字串>。資料庫只存祕密字串的 SHA-256。
import type { Database } from "bun:sqlite";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { type Account, now } from "./db";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newSecret(): string {
  return randomBytes(27).toString("base64url"); // 36 字元
}

export function createAccount(
  db: Database,
  opts: { username: string; firstName: string; isBot: boolean; kind?: string; machine?: string | null },
): { account: Account; token: string } {
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(opts.username)) {
    throw new Error(`帳號名稱 "${opts.username}" 不合法：只能用小寫英文、數字、底線，3–32 字，英文開頭`);
  }
  const secret = newSecret();
  const base = opts.isBot ? 7000000000 : 1000000000; // bot 與使用者分不同區段，方便辨認
  const maxRow = db.query("SELECT MAX(id) AS m FROM accounts WHERE is_bot = ?").get(opts.isBot ? 1 : 0) as { m: number | null };
  const id = Math.max(base, maxRow.m ?? 0) + 1;
  const kind = opts.kind ?? (opts.isBot ? "other" : "human");
  db.query("INSERT INTO accounts (id, username, first_name, is_bot, token_hash, kind, machine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, opts.username, opts.firstName, opts.isBot ? 1 : 0, sha256(secret), kind, opts.machine ?? null, now());
  const account = db.query("SELECT * FROM accounts WHERE id = ?").get(id) as Account;
  return { account, token: `${id}:${secret}` };
}

export function rotateToken(db: Database, username: string): string {
  const acc = db.query("SELECT * FROM accounts WHERE username = ?").get(username) as Account | null;
  if (!acc) throw new Error(`找不到帳號 ${username}`);
  const secret = newSecret();
  db.query("UPDATE accounts SET token_hash = ? WHERE id = ?").run(sha256(secret), acc.id);
  return `${acc.id}:${secret}`;
}

export function authenticate(db: Database, token: string): Account | null {
  const m = /^(\d+):([A-Za-z0-9_-]{16,})$/.exec(token);
  if (!m) return null;
  const acc = db.query("SELECT * FROM accounts WHERE id = ?").get(Number(m[1])) as Account | null;
  if (!acc || acc.disabled) return null;
  const a = Buffer.from(sha256(m[2]), "hex");
  const b = Buffer.from(acc.token_hash, "hex");
  if (a.length === b.length && timingSafeEqual(a, b)) return acc;
  // 網頁登入的 session（只有真人帳號）
  if (!acc.is_bot) {
    const s = db.query("SELECT expires_at FROM sessions WHERE token_hash = ? AND account_id = ?").get(sha256(m[2]), acc.id) as { expires_at: number } | null;
    if (s && s.expires_at > Date.now()) return acc;
  }
  return null;
}

/** 網頁登入成功後發 session token（格式同帳號 token） */
export function createSession(db: Database, acc: Account, days = 90, agent: string | null = null): string {
  const secret = newSecret();
  const t = Date.now();
  db.query("DELETE FROM sessions WHERE expires_at < ?").run(t);
  db.query("INSERT INTO sessions (token_hash, account_id, created_at, expires_at, agent) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(secret), acc.id, t, t + days * 86400_000, agent);
  return `${acc.id}:${secret}`;
}

export function deleteSession(db: Database, token: string) {
  const m = /^(\d+):([A-Za-z0-9_-]{16,})$/.exec(token);
  if (m) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(m[2]));
}

export const hashSecret = sha256;

/** 記錄用：只留 id，遮掉祕密字串 */
export const maskToken = (token: string) => token.replace(/:(.+)$/, ":***");
