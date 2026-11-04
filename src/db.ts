// SQLite 存取層：帳號、聊天室、訊息、更新佇列、事件。
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const OFFICE_GROUP_ID = -1001000000001;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY,
  username    TEXT    NOT NULL UNIQUE,
  first_name  TEXT    NOT NULL,
  is_bot      INTEGER NOT NULL,
  token_hash  TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'other',  -- claude | hermes | human | other
  machine     TEXT,                              -- A | B ...（agent 所在機器）
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id          INTEGER PRIMARY KEY,
  type        TEXT    NOT NULL,          -- 'supergroup'（私聊不建表，用 chat_key 表示）
  title       TEXT    NOT NULL,
  username    TEXT    UNIQUE,
  is_forum    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id     INTEGER NOT NULL REFERENCES chats(id),
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  role        TEXT    NOT NULL DEFAULT 'member',
  PRIMARY KEY (chat_id, account_id)
);

-- chat_key：群組 'g:<chat_id>'，私聊 'p:<小id>:<大id>'
CREATE TABLE IF NOT EXISTS chat_seq (
  chat_key    TEXT PRIMARY KEY,
  last_id     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  chat_key     TEXT    NOT NULL,
  message_id   INTEGER NOT NULL,
  from_id      INTEGER NOT NULL REFERENCES accounts(id),
  date         INTEGER NOT NULL,
  edit_date    INTEGER,
  thread_id    INTEGER NOT NULL DEFAULT 0,
  reply_to     INTEGER,
  text         TEXT,
  entities     TEXT,
  data         TEXT,                     -- 擴充：結構化資料（任務卡等），JSON
  reply_markup TEXT,
  media        TEXT,                     -- {"kind":"document"|"photo","file_id":"..."}
  PRIMARY KEY (chat_key, message_id)
);

CREATE TABLE IF NOT EXISTS updates (
  update_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  payload     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_by_account ON updates(account_id, update_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  actor_id    INTEGER,
  chat_key    TEXT,
  payload     TEXT
);

CREATE TABLE IF NOT EXISTS bot_commands (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id),
  commands    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  file_id        TEXT PRIMARY KEY,
  file_unique_id TEXT NOT NULL,
  owner_id       INTEGER NOT NULL REFERENCES accounts(id),
  name           TEXT,
  mime           TEXT,
  size           INTEGER NOT NULL,
  path           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS callbacks (
  id          TEXT PRIMARY KEY,
  from_id     INTEGER NOT NULL,
  bot_id      INTEGER NOT NULL,
  chat_key    TEXT NOT NULL,
  message_id  INTEGER NOT NULL,
  data        TEXT,
  answer      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  detail      TEXT,
  lead_id     INTEGER NOT NULL REFERENCES accounts(id),
  reviewer_id INTEGER REFERENCES accounts(id),
  created_by  INTEGER NOT NULL REFERENCES accounts(id),
  status      TEXT NOT NULL DEFAULT 'doing',   -- doing | done | failed | cancelled
  summary     TEXT,
  files       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER NOT NULL REFERENCES goals(id),
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  assignee_id   INTEGER NOT NULL REFERENCES accounts(id),
  created_by    INTEGER NOT NULL REFERENCES accounts(id),
  status        TEXT NOT NULL,                 -- blocked | todo | doing | review | done | failed | cancelled
  depends_on    TEXT NOT NULL DEFAULT '[]',
  verify        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 2,
  lease_until   INTEGER,
  result        TEXT,
  files         TEXT,
  note          TEXT,
  session_ref   TEXT,                          -- 執行者的工作階段編號（例如 Hermes 的 session_id），給人日後查詢
  log_ref       TEXT,                          -- 完整執行過程的紀錄位置（執行者機器上的檔案路徑）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  account_id    INTEGER PRIMARY KEY REFERENCES accounts(id),
  last_seen     INTEGER,      -- 任何 API 呼叫或心跳（毫秒）
  last_activity INTEGER,      -- 實際在做事的訊號：hook、chat action、進度回報（毫秒）
  hook_state    TEXT,         -- working | idle | waiting | error
  detail        TEXT,         -- 目前的工具或指令
  session_up    INTEGER,      -- office-node 回報 Claude session 是否在跑
  updated_at    INTEGER
);

-- office_wait 的讀取位置（給只用 MCP、不自己呼叫 getUpdates 的平台，例如當「櫃台」的 Hermes／Codex）
CREATE TABLE IF NOT EXISTS wait_cursor (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id),
  last_update_id INTEGER NOT NULL
);

-- 網頁登入（帳號密碼）產生的 session；token 格式與帳號 token 相同（<帳號 id>:<祕密>），只存雜湊
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  agent       TEXT
);

-- 新 agent 申請加入（office join）：網頁按確認後才建立帳號
CREATE TABLE IF NOT EXISTS join_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL,
  secret_hash TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  machine     TEXT,
  hostname    TEXT,
  platform    TEXT,
  ip          TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  username    TEXT,
  token       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  decided_by  INTEGER
);

CREATE TABLE IF NOT EXISTS loop_guard (
  chat_key    TEXT    NOT NULL,
  thread_id   INTEGER NOT NULL,
  bot_streak  INTEGER NOT NULL,
  last_sender INTEGER,
  PRIMARY KEY (chat_key, thread_id)
);
`;

export interface Account {
  id: number;
  username: string;
  first_name: string;
  is_bot: number;
  token_hash: string;
  kind: string;
  machine: string | null;
  disabled: number;
  password_hash?: string | null;
  created_at: number;
}

export interface Chat {
  id: number;
  type: string;
  title: string;
  username: string | null;
  is_forum: number;
  created_at: number;
}

export interface MessageRow {
  chat_key: string;
  message_id: number;
  from_id: number;
  date: number;
  edit_date: number | null;
  thread_id: number;
  reply_to: number | null;
  text: string | null;
  entities: string | null;
  data: string | null;
  reply_markup: string | null;
}

export const now = () => Math.floor(Date.now() / 1000);

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(SCHEMA);
  // 舊版資料庫補欄位
  const cols = (db.query("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("kind")) db.exec("ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
  if (!cols.includes("machine")) db.exec("ALTER TABLE accounts ADD COLUMN machine TEXT");
  if (!cols.includes("password_hash")) db.exec("ALTER TABLE accounts ADD COLUMN password_hash TEXT");
  const mcols = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes("media")) db.exec("ALTER TABLE messages ADD COLUMN media TEXT");
  const tcols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!tcols.includes("session_ref")) db.exec("ALTER TABLE tasks ADD COLUMN session_ref TEXT");
  if (!tcols.includes("log_ref")) db.exec("ALTER TABLE tasks ADD COLUMN log_ref TEXT");
  return db;
}

export function ensureOfficeGroup(db: Database): Chat {
  const existing = db.query("SELECT * FROM chats WHERE id = ?").get(OFFICE_GROUP_ID) as Chat | null;
  if (existing) return existing;
  db.query("INSERT INTO chats (id, type, title, username, is_forum, created_at) VALUES (?, 'supergroup', ?, 'office', 1, ?)")
    .run(OFFICE_GROUP_ID, "AI 辦公室", now());
  return db.query("SELECT * FROM chats WHERE id = ?").get(OFFICE_GROUP_ID) as Chat;
}

export function addMember(db: Database, chatId: number, accountId: number, role = "member") {
  db.query("INSERT OR IGNORE INTO chat_members (chat_id, account_id, role) VALUES (?, ?, ?)").run(chatId, accountId, role);
}

export type EventListener = (ev: { id: number; ts: number; type: string; actor_id: number | null; chat_key: string | null; payload: unknown }) => void;
const listeners = new Set<EventListener>();
export const onEvent = (fn: EventListener) => { listeners.add(fn); return () => listeners.delete(fn); };

export function logEvent(db: Database, type: string, actorId: number | null, chatKey: string | null, payload: unknown) {
  const ts = Date.now();
  const row = db.query("INSERT INTO events (ts, type, actor_id, chat_key, payload) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(ts, type, actorId, chatKey, JSON.stringify(payload ?? null)) as { id: number };
  for (const fn of listeners) {
    try { fn({ id: row.id, ts, type, actor_id: actorId, chat_key: chatKey, payload }); } catch { /* 監聽者錯誤不影響主流程 */ }
  }
}

export function getAccountBy(db: Database, key: number | string): Account | null {
  if (typeof key === "number" || /^\d+$/.test(String(key))) return db.query("SELECT * FROM accounts WHERE id = ?").get(Number(key)) as Account | null;
  return db.query("SELECT * FROM accounts WHERE username = ?").get(String(key).replace(/^@/, "")) as Account | null;
}
