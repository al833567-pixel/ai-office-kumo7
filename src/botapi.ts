// 相容 Telegram Bot API 的方法實作。
// 與 Telegram 的差異：bot 之間互相看得到訊息；訊息多一個 `data` 欄位放結構化資料；
// 同一串對話若 bot 之間來回超過上限，會被「防循環」擋下，直到有真人發言。
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { type Account, type Chat, type MessageRow, OFFICE_GROUP_ID, logEvent, now } from "./db";
import type { UpdateQueue } from "./updates";

export class ApiError extends Error {
  constructor(public code: number, description: string, public parameters?: Record<string, unknown>) {
    super(description);
  }
}

export interface HubOptions {
  loopLimit: number;     // 同一串對話 bot 之間來回上限
  maxPoll: number;       // getUpdates 長輪詢最長秒數
  maxText: number;       // 單則訊息文字上限
  filesDir: string;      // 檔案存放目錄
  maxFileBytes: number;  // 單檔上限
  leaseSec: number;      // 任務租約秒數
  stallSec: number;      // 多久沒動靜算「卡住」
  offlineSec: number;    // 多久沒連線算「離線」
}

export type Params = Record<string, unknown>;

export interface Ctx {
  db: Database;
  me: Account;
  updates: UpdateQueue;
  opts: HubOptions;
  signal?: AbortSignal;
}

// ---------- 參數工具 ----------
export function int(v: unknown, name: string, required = false): number | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ApiError(400, `Bad Request: ${name} is required`);
    return undefined;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new ApiError(400, `Bad Request: ${name} must be an integer`);
  return n;
}
export function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}
export function json<T = unknown>(v: unknown, name: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") {
    try { return JSON.parse(v) as T; } catch { throw new ApiError(400, `Bad Request: can't parse ${name} JSON`); }
  }
  return v as T;
}

// ---------- 物件格式（Telegram 形狀）----------
export function userObj(a: Account) {
  return { id: a.id, is_bot: !!a.is_bot, first_name: a.first_name, username: a.username };
}

function groupChatObj(c: Chat) {
  return { id: c.id, type: c.type, title: c.title, ...(c.username ? { username: c.username } : {}), ...(c.is_forum ? { is_forum: true } : {}) };
}

function privateChatObj(other: Account) {
  return { id: other.id, type: "private", first_name: other.first_name, username: other.username };
}

export const privateKey = (a: number, b: number) => `p:${Math.min(a, b)}:${Math.max(a, b)}`;

export interface Target {
  key: string;
  group?: Chat;
  other?: Account;          // 私聊時，從「我」看過去的對方
  recipients: number[];     // 除了自己以外會收到更新的帳號
}

function getAccount(db: Database, id: number) {
  return db.query("SELECT * FROM accounts WHERE id = ?").get(id) as Account | null;
}

/** 依 chat_id（數字或 @username）找出聊天室 */
export function resolveChat(ctx: Ctx, raw: unknown): Target {
  const { db, me } = ctx;
  if (raw === undefined || raw === null || raw === "") throw new ApiError(400, "Bad Request: chat_id is required");
  let chat: Chat | null = null;
  let other: Account | null = null;
  const s = String(raw);
  if (s.startsWith("@")) {
    const name = s.slice(1);
    chat = db.query("SELECT * FROM chats WHERE username = ?").get(name) as Chat | null;
    if (!chat) other = db.query("SELECT * FROM accounts WHERE username = ?").get(name) as Account | null;
  } else {
    const id = Number(s);
    if (!Number.isInteger(id)) throw new ApiError(400, "Bad Request: chat_id is invalid");
    if (id < 0) chat = db.query("SELECT * FROM chats WHERE id = ?").get(id) as Chat | null;
    else other = getAccount(db, id);
  }
  if (chat) {
    const members = db.query("SELECT account_id FROM chat_members WHERE chat_id = ?").all(chat.id) as { account_id: number }[];
    if (!members.some((m) => m.account_id === me.id)) throw new ApiError(403, "Forbidden: bot is not a member of the supergroup chat");
    return { key: `g:${chat.id}`, group: chat, recipients: members.map((m) => m.account_id).filter((id) => id !== me.id) };
  }
  if (other && !other.disabled) {
    if (other.id === me.id) throw new ApiError(400, "Bad Request: can't send messages to yourself");
    return { key: privateKey(me.id, other.id), other, recipients: [other.id] };
  }
  throw new ApiError(400, "Bad Request: chat not found");
}

/** 依 chat_key 找出聊天室（從某帳號的角度），用在按鈕等只有 chat_key 的情境 */
function targetFromKey(db: Database, key: string, viewer: Account): Target {
  if (key.startsWith("g:")) {
    const chat = db.query("SELECT * FROM chats WHERE id = ?").get(Number(key.slice(2))) as Chat;
    const members = db.query("SELECT account_id FROM chat_members WHERE chat_id = ?").all(chat.id) as { account_id: number }[];
    return { key, group: chat, recipients: members.map((m) => m.account_id).filter((id) => id !== viewer.id) };
  }
  const [, a, b] = key.split(":").map(Number);
  const other = getAccount(db, viewer.id === a ? b : a)!;
  return { key, other, recipients: [other.id] };
}

/** 依 chat_key 算出「某個帳號」看到的 chat 物件 */
function chatFor(db: Database, key: string, viewerId: number) {
  if (key.startsWith("g:")) {
    const chat = db.query("SELECT * FROM chats WHERE id = ?").get(Number(key.slice(2))) as Chat;
    return groupChatObj(chat);
  }
  const [, a, b] = key.split(":").map(Number);
  const otherId = viewerId === a ? b : a;
  return privateChatObj(getAccount(db, otherId)!);
}

export function getMessage(db: Database, key: string, id: number) {
  return db.query("SELECT * FROM messages WHERE chat_key = ? AND message_id = ?").get(key, id) as (MessageRow & { media: string | null }) | null;
}

interface FileRow { file_id: string; file_unique_id: string; owner_id: number; name: string | null; mime: string | null; size: number; path: string; created_at: number }

export function getFileRow(db: Database, fileId: string) {
  return db.query("SELECT * FROM files WHERE file_id = ?").get(fileId) as FileRow | null;
}

function fileObj(f: FileRow) {
  return { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.size, ...(f.name ? { file_name: f.name } : {}), ...(f.mime ? { mime_type: f.mime } : {}) };
}

export function messageObj(db: Database, row: MessageRow & { media?: string | null }, viewerId: number, withReply = true): Record<string, unknown> {
  const from = getAccount(db, row.from_id)!;
  const m: Record<string, unknown> = {
    message_id: row.message_id,
    from: userObj(from),
    chat: chatFor(db, row.chat_key, viewerId),
    date: row.date,
  };
  if (row.thread_id) { m.message_thread_id = row.thread_id; m.is_topic_message = true; }
  if (row.edit_date) m.edit_date = row.edit_date;
  const media = row.media ? JSON.parse(row.media) as { kind: "document" | "photo"; file_id: string } : null;
  if (media) {
    const f = getFileRow(db, media.file_id);
    if (f) {
      if (media.kind === "photo") m.photo = [{ ...fileObj(f), width: 0, height: 0 }];
      else m.document = fileObj(f);
    }
    if (row.text !== null) m.caption = row.text;
    if (row.entities) m.caption_entities = JSON.parse(row.entities);
  } else {
    if (row.text !== null) m.text = row.text;
    if (row.entities) m.entities = JSON.parse(row.entities);
  }
  if (row.reply_markup) m.reply_markup = JSON.parse(row.reply_markup);
  if (row.data) m.data = JSON.parse(row.data);
  if (withReply && row.reply_to) {
    const r = getMessage(db, row.chat_key, row.reply_to);
    if (r) m.reply_to_message = messageObj(db, r, viewerId, false);
  }
  return m;
}

/** 沒給 entities 時，自動標出 @username（Telegram 伺服器也是這樣做），偏移量用 UTF-16，與 JS 字串相同 */
export function mentionEntities(text: string) {
  const out: { type: string; offset: number; length: number }[] = [];
  for (const m of text.matchAll(/(^|[^A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{2,31})/g)) {
    const offset = (m.index ?? 0) + m[1].length;
    out.push({ type: "mention", offset, length: m[2].length + 1 });
  }
  return out;
}

// ---------- 防循環 ----------
// 只計算「bot 之間換人回話」的次數：同一個 bot 連發多則不算循環；真人發言就歸零。
function checkLoopGuard(ctx: Ctx, key: string, threadId: number) {
  const { db, me, opts } = ctx;
  const row = db.query("SELECT bot_streak, last_sender FROM loop_guard WHERE chat_key = ? AND thread_id = ?")
    .get(key, threadId) as { bot_streak: number; last_sender: number | null } | null;
  const streak = row?.bot_streak ?? 0;
  const isTurn = !!me.is_bot && row?.last_sender !== me.id;
  if (isTurn && streak >= opts.loopLimit) {
    logEvent(db, "loop_guard", me.id, key, { thread_id: threadId, streak });
    throw new ApiError(403, `Forbidden: loop guard — bots replied to each other ${streak} times in a row here; waiting for a human message`);
  }
  const next = !me.is_bot ? 0 : isTurn ? streak + 1 : streak;
  db.query(`INSERT INTO loop_guard (chat_key, thread_id, bot_streak, last_sender) VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_key, thread_id) DO UPDATE SET bot_streak = excluded.bot_streak, last_sender = excluded.last_sender`)
    .run(key, threadId, next, me.id);
}

function nextMessageId(db: Database, key: string): number {
  const row = db.query("INSERT INTO chat_seq (chat_key, last_id) VALUES (?, 1) ON CONFLICT(chat_key) DO UPDATE SET last_id = last_id + 1 RETURNING last_id").get(key) as { last_id: number };
  return row.last_id;
}

function fanOut(ctx: Ctx, target: Target, kind: "message" | "edited_message", row: MessageRow) {
  for (const rid of target.recipients) {
    ctx.updates.push(rid, { [kind]: messageObj(ctx.db, row, rid) });
  }
}

export function touchActivity(db: Database, accountId: number, detail?: string) {
  const t = Date.now();
  db.query(`INSERT INTO presence (account_id, last_seen, last_activity, detail, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, last_activity = excluded.last_activity,
            detail = COALESCE(excluded.detail, presence.detail), updated_at = excluded.updated_at`).run(accountId, t, t, detail ?? null, t);
}

// ---------- 檔案 ----------
export async function storeUpload(ctx: Ctx, input: unknown, fallbackName: string): Promise<FileRow> {
  const { db, me, opts } = ctx;
  if (typeof input === "string") {
    const existing = getFileRow(db, input);
    if (!existing) throw new ApiError(400, "Bad Request: wrong file identifier/HTTP URL specified");
    return existing;
  }
  if (!(input instanceof Blob)) throw new ApiError(400, "Bad Request: there is no file in the request");
  if (input.size > opts.maxFileBytes) throw new ApiError(413, `Request Entity Too Large: max ${Math.round(opts.maxFileBytes / 1048576)}MB`);
  const rawName = (input as File).name || fallbackName;
  const name = rawName.replace(/[\\/\r\n<>:"|?*\x00-\x1f]/g, "_").slice(0, 200) || fallbackName;
  const uid = randomBytes(9).toString("base64url");
  const fileId = `F${randomBytes(18).toString("base64url")}`;
  const ext = extname(name).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
  const dir = join(opts.filesDir, uid.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${uid}${ext}`);
  writeFileSync(path, new Uint8Array(await input.arrayBuffer()));
  db.query("INSERT INTO files (file_id, file_unique_id, owner_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fileId, uid, me.id, name, input.type || null, input.size, path, now());
  logEvent(db, "file", me.id, null, { file_id: fileId, name, size: input.size });
  return getFileRow(db, fileId)!;
}

// ---------- 發訊息（也給任務引擎內部使用）----------
export interface PostOptions {
  text?: string;
  threadId?: number;
  replyTo?: number;
  entities?: unknown;
  replyMarkup?: unknown;
  data?: unknown;
  media?: { kind: "document" | "photo"; file_id: string };
  internal?: boolean; // 任務引擎發的結構化訊息，不計入防循環
}

export function postMessage(ctx: Ctx, chatRaw: unknown, o: PostOptions) {
  const { db, me, opts } = ctx;
  const target = resolveChat(ctx, chatRaw);
  const text = o.text;
  if (!o.media && (!text || !text.trim())) throw new ApiError(400, "Bad Request: message text is empty");
  if (text && text.length > opts.maxText) throw new ApiError(400, `Bad Request: message is too long (max ${opts.maxText})`);
  let threadId = o.threadId ?? 0;
  if (o.replyTo !== undefined) {
    const replied = getMessage(db, target.key, o.replyTo);
    if (!replied) throw new ApiError(400, "Bad Request: message to be replied not found");
    if (!threadId) threadId = replied.thread_id; // 回覆時沿用原訊息的討論串
  }
  if (!o.internal) checkLoopGuard(ctx, target.key, threadId);
  const entities = o.entities ?? (text ? mentionEntities(text) : []);
  const row = {
    chat_key: target.key,
    message_id: nextMessageId(db, target.key),
    from_id: me.id,
    date: now(),
    edit_date: null,
    thread_id: threadId,
    reply_to: o.replyTo ?? null,
    text: text ?? null,
    entities: Array.isArray(entities) && entities.length ? JSON.stringify(entities) : null,
    data: o.data !== undefined ? JSON.stringify(o.data) : null,
    reply_markup: o.replyMarkup ? JSON.stringify(o.replyMarkup) : null,
    media: o.media ? JSON.stringify(o.media) : null,
  };
  db.query(`INSERT INTO messages (chat_key, message_id, from_id, date, edit_date, thread_id, reply_to, text, entities, data, reply_markup, media)
            VALUES ($chat_key, $message_id, $from_id, $date, $edit_date, $thread_id, $reply_to, $text, $entities, $data, $reply_markup, $media)`).run(row);
  fanOut(ctx, target, "message", row);
  logEvent(db, "message", me.id, target.key, {
    message_id: row.message_id, thread_id: threadId, to: target.recipients, from: me.username,
    text: (text ?? "").slice(0, 500), data: o.data ?? null, media: o.media ?? null,
    buttons: o.replyMarkup ?? null,
  });
  return messageObj(db, row, me.id);
}

// ---------- 方法 ----------
type Method = (ctx: Ctx, p: Params) => unknown | Promise<unknown>;

export const methods: Record<string, Method> = {
  getMe(ctx) {
    return {
      ...userObj(ctx.me),
      ...(ctx.me.is_bot ? { can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } : {}),
    };
  },

  async getUpdates(ctx, p) {
    const offset = int(p.offset, "offset");
    const limit = Math.min(Math.max(int(p.limit, "limit") ?? 100, 1), 100);
    const timeout = Math.min(Math.max(int(p.timeout, "timeout") ?? 0, 0), ctx.opts.maxPoll);
    return ctx.updates.poll(ctx.me.id, { offset, limit, timeout, signal: ctx.signal });
  },

  sendMessage(ctx, p) {
    const replyParams = json<{ message_id?: number }>(p.reply_parameters, "reply_parameters");
    return postMessage(ctx, p.chat_id, {
      text: str(p.text),
      threadId: int(p.message_thread_id, "message_thread_id"),
      replyTo: int(p.reply_to_message_id, "reply_to_message_id") ?? replyParams?.message_id,
      entities: json(p.entities, "entities"),
      replyMarkup: json(p.reply_markup, "reply_markup"),
      data: json(p.data, "data"),
    });
  },

  async sendDocument(ctx, p) {
    const f = await storeUpload(ctx, p.document, "file.bin");
    const replyParams = json<{ message_id?: number }>(p.reply_parameters, "reply_parameters");
    return postMessage(ctx, p.chat_id, {
      text: str(p.caption), threadId: int(p.message_thread_id, "message_thread_id"),
      replyTo: int(p.reply_to_message_id, "reply_to_message_id") ?? replyParams?.message_id,
      entities: json(p.caption_entities, "caption_entities"), replyMarkup: json(p.reply_markup, "reply_markup"),
      data: json(p.data, "data"), media: { kind: "document", file_id: f.file_id },
    });
  },

  async sendPhoto(ctx, p) {
    const f = await storeUpload(ctx, p.photo, "photo.jpg");
    const replyParams = json<{ message_id?: number }>(p.reply_parameters, "reply_parameters");
    return postMessage(ctx, p.chat_id, {
      text: str(p.caption), threadId: int(p.message_thread_id, "message_thread_id"),
      replyTo: int(p.reply_to_message_id, "reply_to_message_id") ?? replyParams?.message_id,
      entities: json(p.caption_entities, "caption_entities"), replyMarkup: json(p.reply_markup, "reply_markup"),
      data: json(p.data, "data"), media: { kind: "photo", file_id: f.file_id },
    });
  },

  /** 擴充：只上傳不發訊息，回傳 file 物件（給 office CLI 與任務回報用） */
  async uploadFile(ctx, p) {
    const f = await storeUpload(ctx, p.file ?? p.document, "file.bin");
    return fileObj(f);
  },

  getFile(ctx, p) {
    const id = str(p.file_id);
    const f = id ? getFileRow(ctx.db, id) : null;
    if (!f) throw new ApiError(400, "Bad Request: invalid file_id");
    return { ...fileObj(f), file_path: `${f.file_id}/${encodeURIComponent(f.name ?? "file")}` };
  },

  editMessageText(ctx, p) {
    const { db, me } = ctx;
    if (p.inline_message_id) throw new ApiError(400, "Bad Request: inline messages are not supported");
    const target = resolveChat(ctx, p.chat_id);
    const id = int(p.message_id, "message_id", true)!;
    const row = getMessage(db, target.key, id);
    if (!row) throw new ApiError(400, "Bad Request: message to edit not found");
    if (row.from_id !== me.id) throw new ApiError(400, "Bad Request: message can't be edited");
    const text = str(p.text);
    if (!text || !text.trim()) throw new ApiError(400, "Bad Request: message text is empty");
    const entities = json(p.entities, "entities") ?? mentionEntities(text);
    const replyMarkup = json(p.reply_markup, "reply_markup");
    if (text === row.text && !replyMarkup && row.reply_markup === null) throw new ApiError(400, "Bad Request: message is not modified");
    row.text = text;
    row.edit_date = now();
    row.entities = Array.isArray(entities) && entities.length ? JSON.stringify(entities) : null;
    // Telegram：編輯時沒帶 reply_markup 會移除按鈕
    row.reply_markup = replyMarkup ? JSON.stringify(replyMarkup) : null;
    db.query("UPDATE messages SET text = ?, edit_date = ?, entities = ?, reply_markup = ? WHERE chat_key = ? AND message_id = ?")
      .run(row.text, row.edit_date, row.entities, row.reply_markup, row.chat_key, row.message_id);
    fanOut(ctx, target, "edited_message", row);
    logEvent(db, "edit", me.id, target.key, { message_id: id, text: text.slice(0, 500), buttons: replyMarkup ?? null });
    return messageObj(db, row, me.id);
  },

  sendChatAction(ctx, p) {
    const target = resolveChat(ctx, p.chat_id);
    const action = str(p.action);
    const allowed = ["typing", "upload_document", "upload_photo", "record_voice", "choose_sticker", "find_location"];
    if (!action || !allowed.includes(action)) throw new ApiError(400, "Bad Request: wrong parameter action in request");
    touchActivity(ctx.db, ctx.me.id);
    logEvent(ctx.db, "chat_action", ctx.me.id, target.key, { action });
    return true;
  },

  setMessageReaction(ctx, p) {
    const target = resolveChat(ctx, p.chat_id);
    const id = int(p.message_id, "message_id", true)!;
    if (!getMessage(ctx.db, target.key, id)) throw new ApiError(400, "Bad Request: message to react not found");
    const reaction = json(p.reaction, "reaction") ?? [];
    logEvent(ctx.db, "reaction", ctx.me.id, target.key, { message_id: id, reaction });
    return true;
  },

  /** 擴充（真人與 UI 用）：按下 bot 訊息上的按鈕，bot 會收到 callback_query */
  pressButton(ctx, p) {
    const { db, me } = ctx;
    if (me.is_bot) throw new ApiError(403, "Forbidden: only humans can press buttons");
    const target = resolveChat(ctx, p.chat_id);
    const id = int(p.message_id, "message_id", true)!;
    const data = str(p.data);
    const row = getMessage(db, target.key, id);
    if (!row) throw new ApiError(400, "Bad Request: message not found");
    const markup = row.reply_markup ? JSON.parse(row.reply_markup) as { inline_keyboard?: { callback_data?: string }[][] } : null;
    const ok = markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === data));
    if (!ok) throw new ApiError(400, "Bad Request: button not found on that message");
    const bot = getAccount(db, row.from_id)!;
    const cbId = randomBytes(8).toString("hex");
    db.query("INSERT INTO callbacks (id, from_id, bot_id, chat_key, message_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cbId, me.id, bot.id, target.key, id, data ?? null, now());
    ctx.updates.push(bot.id, {
      callback_query: { id: cbId, from: userObj(me), message: messageObj(db, row, bot.id), chat_instance: target.key, data },
    });
    logEvent(db, "button", me.id, target.key, { message_id: id, data, bot: bot.username });
    return { callback_query_id: cbId };
  },

  answerCallbackQuery(ctx, p) {
    const id = str(p.callback_query_id);
    const cb = id ? ctx.db.query("SELECT * FROM callbacks WHERE id = ?").get(id) as { from_id: number; bot_id: number } | null : null;
    if (!cb || cb.bot_id !== ctx.me.id) throw new ApiError(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
    const text = str(p.text) ?? "";
    ctx.db.query("UPDATE callbacks SET answer = ? WHERE id = ?").run(text, id);
    logEvent(ctx.db, "button_answer", ctx.me.id, null, { callback_query_id: id, to: cb.from_id, text });
    return true;
  },

  /** 顯示名稱（Telegram 相容：bot 改自己的名字） */
  setMyName(ctx, p) {
    return renameAccount(ctx, ctx.me, str(p.name));
  },

  /** 擴充（真人與 UI 用）：改任何帳號的顯示名稱 */
  renameAccount(ctx, p) {
    if (ctx.me.is_bot) throw new ApiError(403, "Forbidden: only humans can rename other accounts");
    const u = str(p.username)?.replace(/^@/, "");
    const target = u ? ctx.db.query("SELECT * FROM accounts WHERE username = ?").get(u) as Account | null : null;
    if (!target) throw new ApiError(400, "Bad Request: account not found");
    return renameAccount(ctx, target, str(p.name));
  },

  setMyCommands(ctx, p) {
    const commands = json(p.commands, "commands");
    if (!Array.isArray(commands)) throw new ApiError(400, "Bad Request: commands must be an array");
    ctx.db.query("INSERT INTO bot_commands (account_id, commands) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET commands = excluded.commands")
      .run(ctx.me.id, JSON.stringify(commands));
    return true;
  },

  getMyCommands(ctx) {
    const row = ctx.db.query("SELECT commands FROM bot_commands WHERE account_id = ?").get(ctx.me.id) as { commands: string } | null;
    return row ? JSON.parse(row.commands) : [];
  },

  deleteMyCommands(ctx) {
    ctx.db.query("DELETE FROM bot_commands WHERE account_id = ?").run(ctx.me.id);
    return true;
  },

  getChat(ctx, p) {
    const target = resolveChat(ctx, p.chat_id);
    return target.group ? groupChatObj(target.group) : privateChatObj(target.other!);
  },

  // Hub 只支援長輪詢；客戶端啟動時常會先呼叫這兩個
  deleteWebhook(ctx, p) {
    if (p.drop_pending_updates === true || p.drop_pending_updates === "true") ctx.updates.drop(ctx.me.id);
    return true;
  },
  getWebhookInfo(ctx) {
    return { url: "", has_custom_certificate: false, pending_update_count: ctx.updates.pendingCount(ctx.me.id) };
  },
  setWebhook() {
    throw new ApiError(400, "Bad Request: webhooks are not supported by this hub; use getUpdates");
  },
  logOut: () => true,
  close: () => true,
};

function renameAccount(ctx: Ctx, target: Account, raw: string | undefined) {
  const name = (raw ?? "").replace(/[\r\n\t]/g, " ").trim();
  if (!name || [...name].length > 24) throw new ApiError(400, "Bad Request: name must be 1-24 characters");
  ctx.db.query("UPDATE accounts SET first_name = ? WHERE id = ?").run(name, target.id);
  logEvent(ctx.db, "account", ctx.me.id, null, { id: target.id, username: target.username, first_name: name, kind: target.kind, machine: target.machine, is_bot: !!target.is_bot });
  return true;
}

export function registerMethods(extra: Record<string, Method>) {
  Object.assign(methods, extra);
}

export async function callMethod(ctx: Ctx, name: string, params: Params) {
  const fn = methods[name];
  if (!fn) throw new ApiError(404, `Not Found: method ${name} is not supported by this hub yet`);
  return fn(ctx, params);
}

export { targetFromKey, OFFICE_GROUP_ID };
