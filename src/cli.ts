// 管理指令：
//   bun run src/cli.ts init                       建立資料庫、office 群組與預設帳號，印出 token
//   bun run src/cli.ts add <帳號> [--name 顯示名] [--kind claude|hermes|other] [--machine A] [--user]
//   bun run src/cli.ts token <帳號>               重新產生 token（舊的立即失效）
//   bun run src/cli.ts list                       列出帳號
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDb, ensureOfficeGroup, addMember, OFFICE_GROUP_ID, type Account } from "./db";
import { createAccount, rotateToken } from "./auth";

const DB_PATH = process.env.HUB_DB ?? "data/office.db";
const TOKENS_FILE = process.env.HUB_TOKENS_FILE ?? "data/tokens.local.json";

const DEFAULTS = [
  { username: "boss", firstName: "老闆", isBot: false, kind: "human", machine: null },
  { username: "claude_a", firstName: "Claude-A", isBot: true, kind: "claude", machine: "A" },
  { username: "claude_b", firstName: "Claude-B", isBot: true, kind: "claude", machine: "B" },
  { username: "hermes_a", firstName: "Hermes-A", isBot: true, kind: "hermes", machine: "A" },
  { username: "hermes_b", firstName: "Hermes-B", isBot: true, kind: "hermes", machine: "B" },
];

function saveToken(username: string, token: string) {
  const all: Record<string, string> = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {};
  all[username] = token;
  writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2) + "\n");
  chmodSync(TOKENS_FILE, 0o600);
}

const [cmd, ...args] = process.argv.slice(2);
const db = openDb(DB_PATH);
ensureOfficeGroup(db);

switch (cmd) {
  case "init": {
    const rows: string[] = [];
    for (const d of DEFAULTS) {
      const exists = db.query("SELECT id FROM accounts WHERE username = ?").get(d.username);
      if (exists) { rows.push(`  ${d.username.padEnd(10)} 已存在（略過）`); continue; }
      const { account, token } = createAccount(db, d);
      addMember(db, OFFICE_GROUP_ID, account.id, d.isBot ? "member" : "owner");
      saveToken(d.username, token);
      rows.push(`  ${d.username.padEnd(10)} ${token}`);
    }
    console.log(`資料庫：${DB_PATH}\n群組：office（chat_id ${OFFICE_GROUP_ID}）\n帳號與 token：\n${rows.join("\n")}`);
    console.log(`\ntoken 也存到 ${TOKENS_FILE}（權限 600）。只在這台電腦保管，不要傳到網路上。`);
    break;
  }
  case "add": {
    const username = args[0];
    if (!username) throw new Error("用法：add <帳號> [--name 顯示名] [--user]");
    const opt = (f: string) => { const i = args.indexOf(f); return i > 0 ? args[i + 1] : undefined; };
    const isBot = !args.includes("--user");
    const { account, token } = createAccount(db, { username, firstName: opt("--name") ?? username, isBot, kind: opt("--kind") ?? (isBot ? "other" : "human"), machine: opt("--machine") ?? null });
    addMember(db, OFFICE_GROUP_ID, account.id);
    saveToken(username, token);
    console.log(`已新增 ${isBot ? "bot" : "使用者"} ${username}（id ${account.id}），已加入 office 群組\ntoken：${token}`);
    break;
  }
  case "token": {
    const token = rotateToken(db, args[0]);
    saveToken(args[0], token);
    console.log(`新 token：${token}（舊 token 已失效）`);
    break;
  }
  case "list": {
    const rows = db.query("SELECT * FROM accounts ORDER BY is_bot DESC, id").all() as Account[];
    for (const a of rows) console.log(`${String(a.id).padEnd(11)} ${a.is_bot ? "bot " : "user"} ${a.username.padEnd(10)} ${a.kind.padEnd(7)} ${(a.machine ?? "-").padEnd(3)} ${a.first_name}${a.disabled ? "（停用）" : ""}`);
    break;
  }
  default:
    console.log("指令：init | add <帳號> [--name 顯示名] [--kind claude|hermes|other] [--machine A] [--user] | token <帳號> | list");
}
