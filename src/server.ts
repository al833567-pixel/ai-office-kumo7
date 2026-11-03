// Office Hub 入口：HTTP 伺服器。
//   /bot<token>/<方法>          agent（bot）用，相容 Telegram Bot API，加上任務擴充方法
//   /user<token>/<方法>         你（真人）和 UI 用，方法相同
//   /file/bot<token>/<路徑>     下載檔案（getFile 回傳的 file_path）
//   POST /mcp                   MCP 入口（Authorization: Bearer <token>）
//   POST /hooks                 Claude Code hooks（Authorization: Bearer <token>）
//   GET  /ws?token=<使用者token> UI 即時事件
//   GET  /                      像素辦公室 UI
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, ensureOfficeGroup, onEvent, type Account, OFFICE_GROUP_ID } from "./db";
import { authenticate, maskToken } from "./auth";
import { ApiError, callMethod, getFileRow, registerMethods, type Ctx, type HubOptions } from "./botapi";
import { UpdateQueue } from "./updates";
import { taskMethods, handleHook, startWatchdog, agentStates, goalObj, taskObj, type GoalRow, type TaskRow } from "./tasks";
import { handleMcp } from "./mcp";

registerMethods(taskMethods);

export interface HubConfig extends Partial<HubOptions> {
  host?: string;
  port?: number;
  dbPath?: string;
  db?: Database;
  log?: boolean;
  watchdogMs?: number;
  uiPath?: string;
}

const JSON_FIELDS = new Set(["reply_parameters", "entities", "caption_entities", "reply_markup", "data", "commands", "reaction", "allowed_updates", "depends_on", "files", "for_accounts"]);

async function readParams(req: Request, url: URL): Promise<Record<string, unknown>> {
  const p: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => (p[k] = v));
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await req.json().catch(() => {
        throw new ApiError(400, "Bad Request: invalid JSON body");
      });
      if (body && typeof body === "object") Object.assign(p, body);
    } else if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      form.forEach((v, k) => (p[k] = v));
    }
  }
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (JSON_FIELDS.has(k) && typeof v === "string" && /^[\[{]/.test(v.trim())) {
      try { p[k] = JSON.parse(v); } catch { /* 交給方法自己報錯 */ }
    }
  }
  return p;
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

export function startHub(cfg: HubConfig = {}) {
  const dbPath = cfg.dbPath ?? "data/office.db";
  const opts: HubOptions = {
    loopLimit: cfg.loopLimit ?? 30,
    maxPoll: cfg.maxPoll ?? 50,
    maxText: cfg.maxText ?? 65536,
    filesDir: cfg.filesDir ?? join(dbPath === ":memory:" ? `${process.env.TMPDIR ?? "/tmp"}/office-hub-files-${process.pid}` : join(dbPath, "..", "files")),
    maxFileBytes: cfg.maxFileBytes ?? 50 * 1024 * 1024,
    leaseSec: cfg.leaseSec ?? 15 * 60,
    stallSec: cfg.stallSec ?? 5 * 60,
    offlineSec: cfg.offlineSec ?? 120,
  };
  const db = cfg.db ?? openDb(dbPath);
  ensureOfficeGroup(db);
  const updates = new UpdateQueue(db);
  const log = cfg.log ?? false;
  const uiPath = cfg.uiPath ?? join(import.meta.dir, "..", "ui", "index.html");
  const stopWatchdog = startWatchdog({ db, updates, opts }, cfg.watchdogMs ?? 5000);

  const touch = (id: number) => {
    const t = Date.now();
    db.query(`INSERT INTO presence (account_id, last_seen, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, updated_at = excluded.updated_at`).run(id, t, t);
  };
  const auth = (token: string, kind?: "bot" | "user"): Account => {
    const me = authenticate(db, token);
    if (!me || (kind && (kind === "bot") !== !!me.is_bot)) throw new ApiError(401, "Unauthorized");
    touch(me.id);
    return me;
  };
  const ctxFor = (me: Account, signal?: AbortSignal): Ctx => ({ db, me, updates, opts, signal });

  function snapshot(me: Account) {
    const goals = db.query("SELECT * FROM goals ORDER BY id DESC LIMIT 30").all() as GoalRow[];
    const tasks = goals.length
      ? db.query(`SELECT * FROM tasks WHERE goal_id IN (${goals.map(() => "?").join(",")}) ORDER BY id`).all(...goals.map((g) => g.id)) as TaskRow[]
      : [];
    const events = (db.query(`SELECT * FROM events WHERE type IN ('message','edit','button','button_answer','hook','file','loop_guard')
                              ORDER BY id DESC LIMIT 400`).all() as { id: number; ts: number; type: string; actor_id: number | null; chat_key: string | null; payload: string }[])
      .reverse().filter((e) => visible(me, e.chat_key)).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    const accounts = (db.query("SELECT id, username, first_name, is_bot, kind, machine FROM accounts WHERE disabled = 0").all());
    return { type: "snapshot", me: { id: me.id, username: me.username, name: me.first_name }, office_chat_id: OFFICE_GROUP_ID,
      accounts, agents: agentStates(ctxFor(me)), goals: goals.map((g) => goalObj(db, g)), tasks: tasks.map((t) => taskObj(db, t)), events };
  }
  const visible = (me: Account, key: string | null) => !key || key.startsWith("g:") || key.split(":").slice(1).map(Number).includes(me.id);

  const sockets = new Set<{ me: Account; ws: { send: (s: string) => void } }>();
  const unsubscribe = onEvent((ev) => {
    if (!sockets.size) return;
    const msg = JSON.stringify({ type: "event", event: ev });
    for (const s of sockets) if (visible(s.me, ev.chat_key)) { try { s.ws.send(msg); } catch { /* 斷線的 socket 由 close 清掉 */ } }
  });

  const server = Bun.serve<{ me: Account }, object>({
    hostname: cfg.host ?? "127.0.0.1",
    port: cfg.port ?? 7070,
    idleTimeout: Math.min(255, opts.maxPoll + 30), // 長輪詢期間不能被斷線
    websocket: {
      open(ws) { const entry = { me: ws.data.me, ws }; (ws.data as { entry?: unknown }).entry = entry; sockets.add(entry); ws.send(JSON.stringify(snapshot(ws.data.me))); },
      close(ws) { sockets.delete((ws.data as { entry?: never }).entry!); },
      message(ws, raw) { if (String(raw) === "snapshot") ws.send(JSON.stringify(snapshot(ws.data.me))); },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const started = performance.now();
      try {
        if (path === "/health") return reply({ ok: true, result: { status: "up", time: Date.now() } });

        if (path === "/" || path === "/index.html") {
          if (!existsSync(uiPath)) return new Response("UI not found", { status: 404 });
          return new Response(readFileSync(uiPath), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
        }

        if (path === "/ws") {
          const me = auth(url.searchParams.get("token") ?? "", "user");
          if (srv.upgrade(req, { data: { me } })) return undefined as unknown as Response;
          throw new ApiError(400, "Bad Request: expected websocket");
        }

        if (path === "/mcp") {
          if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
          let me: Account;
          try { me = auth(bearer(req)); } catch {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: set header Authorization: Bearer <office token>" } }), { status: 401, headers: { "content-type": "application/json" } });
          }
          const body = await req.json().catch(() => null);
          return handleMcp(ctxFor(me), body);
        }

        if (path === "/hooks") {
          const me = auth(bearer(req), "bot");
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          handleHook(ctxFor(me), body);
          return reply({}); // 空 JSON：不影響 Claude Code 的行為
        }

        const fm = /^\/file\/(bot|user)([^/]+)\/([^/]+)(?:\/.*)?$/.exec(path);
        if (fm) {
          auth(decodeURIComponent(fm[2]), fm[1] as "bot" | "user");
          const f = getFileRow(db, decodeURIComponent(fm[3]));
          if (!f || !existsSync(f.path)) throw new ApiError(404, "Not Found: file");
          return new Response(Bun.file(f.path), { headers: {
            "content-type": f.mime ?? "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name ?? "file")}`,
          } });
        }

        const m = /^\/(bot|user)([^/]+)\/([A-Za-z]+)$/.exec(path);
        if (!m) return reply({ ok: false, error_code: 404, description: "Not Found" }, 404);
        const [, kind, token, method] = m;
        const me = auth(decodeURIComponent(token), kind as "bot" | "user");
        const params = await readParams(req, url);
        srv.timeout(req, 0); // 這個請求可能是長輪詢，取消個別逾時
        const result = await callMethod(ctxFor(me, req.signal), method, params);
        if (log && method !== "getUpdates") console.log(`${new Date().toISOString()} ${me.username} ${method} ok ${Math.round(performance.now() - started)}ms`);
        return reply({ ok: true, result });
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, `Internal Server Error: ${(e as Error).message}`);
        if (log || err.code >= 500) console.log(`${new Date().toISOString()} ${maskToken(path)} ${err.code} ${err.message}`);
        if (err.code >= 500) console.error(e);
        return reply({ ok: false, error_code: err.code, description: err.message, ...(err.parameters ? { parameters: err.parameters } : {}) }, err.code);
      }
    },
  });

  return {
    server,
    db,
    opts,
    url: `http://${server.hostname}:${server.port}`,
    stop: () => { stopWatchdog(); unsubscribe(); server.stop(true); },
  };
}

if (import.meta.main) {
  const hub = startHub({
    host: process.env.HUB_HOST ?? "127.0.0.1",
    port: Number(process.env.HUB_PORT ?? 7070),
    dbPath: process.env.HUB_DB ?? "data/office.db",
    loopLimit: Number(process.env.HUB_LOOP_LIMIT ?? 30),
    maxPoll: Number(process.env.HUB_MAX_POLL ?? 50),
    leaseSec: Number(process.env.HUB_LEASE_MIN ?? 15) * 60,
    stallSec: Number(process.env.HUB_STALL_MIN ?? 5) * 60,
    offlineSec: Number(process.env.HUB_OFFLINE_SEC ?? 120),
    log: process.env.HUB_LOG !== "0",
  });
  console.log(`Office Hub 已啟動：${hub.url}（UI：${hub.url}/）`);
}
