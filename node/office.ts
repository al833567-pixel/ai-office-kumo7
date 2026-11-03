#!/usr/bin/env bun
// office：每台 agent 機器上的工具（Bun 單檔，不需安裝套件）。
//
//   office run                       常駐：Hermes 接線（收派工→跑 Hermes→驗收→回報）、心跳、Claude session 偵測
//   office upload <檔案>...           上傳檔案到 Hub，印出 file_id（給 office_report 的 files 用）
//   office download <file_id> [目錄]  從 Hub 下載檔案
//   office send <對象|office> <文字>  發訊息（對象是 username，office 代表群組）
//   office tasks [--mine]            列出任務
//   office agents                    列出所有 agent 狀態
//   office whoami                    顯示目前使用的帳號
//   office setup-claude              寫入 Claude 端設定（channel .env、access.json、/office skill），並印出要執行的指令
//   office doctor                    檢查設定與連線
//
// 設定檔：~/.office/config.json（或環境變數 OFFICE_CONFIG 指定路徑）
// 身分：預設用 claude_token；環境變數 OFFICE_AS=hermes 時用 hermes_token。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

interface Config {
  hub: string;
  machine: string;
  claude_token?: string;
  hermes_token?: string;
  approvers?: number[];          // 可以批准權限的真人帳號 id（預設：hub 上所有真人）
  hermes?: {
    mode?: "cli" | "api";
    cmd?: string[];              // cli 模式：最後會附上提示詞（或提示詞檔案路徑），例如 ["hermes","chat","-Q","-q"]
    prompt_via?: "arg" | "file"; // arg：提示詞當最後一個參數；file：寫成檔案，最後一個參數是檔案路徑（搭配 --query-file，Windows 建議）
    api_url?: string;            // api 模式：Hermes API server，例如 http://127.0.0.1:8642
    api_key?: string;
    model?: string;
    cwd?: string;                // 任務工作目錄根目錄
    timeout_min?: number;
    env?: Record<string, string>;
  };
  verify_timeout_sec?: number;
  claude_process_pattern?: string;
}

const CONFIG_PATH = process.env.OFFICE_CONFIG ?? join(homedir(), ".office", "config.json");
const OFFICE_GROUP = -1001000000001;

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) die(`找不到設定檔 ${CONFIG_PATH}。請參考 node/config.windows-A.example.json、config.windows-B.example.json 或 config.wsl.example.json 建立。`);
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  if (!cfg.hub) die("設定檔缺少 hub（例如 http://100.64.0.11:7070）");
  cfg.hub = cfg.hub.replace(/\/+$/, "");
  return cfg;
}
function die(msg: string): never { console.error(msg); process.exit(1); }
// 展開 ~ 與 Windows 的 %VAR%（例如 %LOCALAPPDATA%），讓設定檔不必寫死使用者名稱
const expand = (p: string) => p
  .replace(/^~(?=$|[\\/])/, homedir())
  .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? process.env[k.toUpperCase()] ?? m);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function tokenFor(cfg: Config, who = process.env.OFFICE_AS ?? "claude"): string {
  const t = who === "hermes" ? cfg.hermes_token : cfg.claude_token;
  if (!t) die(`設定檔缺少 ${who}_token`);
  return t;
}

class Hub {
  constructor(public base: string, public token: string) {}
  async call<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal,
    });
    const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!body.ok) { const e = new Error(body.description ?? "hub error") as Error & { code?: number }; e.code = body.error_code; throw e; }
    return body.result;
  }
  async upload(path: string): Promise<{ file_id: string; file_name?: string; file_size: number }> {
    const form = new FormData();
    form.append("file", Bun.file(path), basename(path));
    const res = await fetch(`${this.base}/bot${this.token}/uploadFile`, { method: "POST", body: form });
    const body = await res.json() as { ok: boolean; result: any; description?: string };
    if (!body.ok) throw new Error(body.description);
    return body.result;
  }
  async download(fileId: string, dir: string): Promise<string> {
    const info = await this.call<{ file_path: string; file_name?: string }>("getFile", { file_id: fileId });
    const res = await fetch(`${this.base}/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    let name = (info.file_name ?? fileId).replace(/[\\/]/g, "_");
    let out = join(dir, name);
    for (let i = 1; existsSync(out); i++) out = join(dir, name.replace(/(\.[^.]*)?$/, `-${i}$1`));
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    return out;
  }
}

// ---------------- CLI 子指令 ----------------
async function cmdUpload(cfg: Config, files: string[]) {
  if (!files.length) die("用法：office upload <檔案>...");
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  for (const f of files) {
    const p = resolve(f);
    if (!existsSync(p) || !statSync(p).isFile()) die(`不是檔案：${f}`);
    const r = await hub.upload(p);
    console.log(`${r.file_id}\t${r.file_name ?? basename(p)}\t${r.file_size} bytes`);
  }
}

async function cmdDownload(cfg: Config, fileId?: string, dir = ".") {
  if (!fileId) die("用法：office download <file_id> [目錄]");
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  console.log(await hub.download(fileId, resolve(dir)));
}

async function cmdSend(cfg: Config, to?: string, text?: string) {
  if (!to || !text) die("用法：office send <username|office> <文字>");
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const r = await hub.call("sendMessage", { chat_id: to === "office" ? OFFICE_GROUP : `@${to.replace(/^@/, "")}`, text });
  console.log(`已送出 message_id ${r.message_id}`);
}

async function cmdTasks(cfg: Config, mine: boolean) {
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const tasks = await hub.call<any[]>("getTasks", mine ? { mine: true } : {});
  for (const t of tasks) console.log(`#${String(t.task_id).padEnd(4)} ${t.status.padEnd(9)} ${String(t.assignee).padEnd(10)} 目標#${t.goal_id} ${t.title}`);
}

async function cmdAgents(cfg: Config) {
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const agents = await hub.call<any[]>("getAgents");
  for (const a of agents) console.log(`${a.username.padEnd(10)} ${a.state.padEnd(8)} ${a.machine ?? "-"}  ${a.task ? `#${a.task.task_id} ${a.task.title}` : ""} ${a.detail ?? ""}`);
}

async function cmdWhoami(cfg: Config) {
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const me = await hub.call("getMe");
  console.log(`${me.username}（id ${me.id}）@ ${cfg.hub}`);
}

async function cmdDoctor(cfg: Config) {
  const ok = (b: boolean, msg: string) => console.log(`${b ? "✅" : "❌"} ${msg}`);
  try { const r = await fetch(`${cfg.hub}/health`); ok(r.ok, `Hub 連線 ${cfg.hub}`); } catch (e) { ok(false, `Hub 連線失敗：${(e as Error).message}`); }
  for (const who of ["claude", "hermes"] as const) {
    const t = who === "claude" ? cfg.claude_token : cfg.hermes_token;
    if (!t) { console.log(`➖ 沒設定 ${who}_token`); continue; }
    try { const me = await new Hub(cfg.hub, t).call("getMe"); ok(true, `${who}_token → @${me.username}`); } catch (e) { ok(false, `${who}_token 驗證失敗：${(e as Error).message}`); }
  }
  if (cfg.hermes_token) {
    const mode = cfg.hermes?.mode ?? "cli";
    if (mode === "cli") {
      const bin = expand((cfg.hermes?.cmd ?? ["hermes"])[0]);
      const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
      ok(r.status === 0, `Hermes CLI：${bin} ${r.status === 0 ? r.stdout.trim() : "（找不到或無法執行）"}`);
    } else {
      try { const r = await fetch(`${cfg.hermes?.api_url ?? "http://127.0.0.1:8642"}/health`); ok(r.ok, "Hermes API server"); } catch { ok(false, "Hermes API server 連不到"); }
    }
  }
  const envFile = join(homedir(), ".claude", "channels", "office", ".env");
  ok(existsSync(envFile), `Claude channel 設定 ${envFile}`);
  ok(existsSync(join(homedir(), ".claude", "skills", "office", "SKILL.md")), "/office skill 已安裝");
}

async function cmdSetupClaude(cfg: Config) {
  const token = tokenFor(cfg, "claude");
  const hub = new Hub(cfg.hub, token);
  const me = await hub.call("getMe");
  // 找出群組成員與真人，產生 access.json
  const agents = await hub.call<any[]>("getAgents");
  const humans = cfg.approvers ?? [];
  const peers: string[] = [];
  for (const a of agents) if (a.username !== me.username) {
    // getAgents 不含 id，改用 getChat 取 id
    const c = await hub.call("getChat", { chat_id: `@${a.username}` });
    peers.push(String(c.id));
  }
  if (!humans.length) die("設定檔請加上 approvers（你的 boss 帳號 id，例如 [1000000001]），這些人才能在 UI 上批准權限。");
  const dir = join(homedir(), ".claude", "channels", "office");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), `OFFICE_HUB_URL=${cfg.hub}\nOFFICE_BOT_TOKEN=${token}\n`);
  chmodSync(join(dir, ".env"), 0o600);
  const access = {
    dmPolicy: "allowlist",
    allowFrom: [...humans.map(String), ...peers],
    approvers: humans.map(String),
    groups: { [String(OFFICE_GROUP)]: { requireMention: true, allowFrom: [] } },
    pending: {},
    replyToMode: "first",
  };
  writeFileSync(join(dir, "access.json"), JSON.stringify(access, null, 2) + "\n");
  chmodSync(join(dir, "access.json"), 0o600);
  // 安裝 /office skill
  const skillSrc = join(import.meta.dir, "..", "claude", "skill-office", "SKILL.md");
  const skillDir = join(homedir(), ".claude", "skills", "office");
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(skillSrc, join(skillDir, "SKILL.md"));
  const market = resolve(import.meta.dir, "..", "claude");
  console.log(`已寫入：
  ${join(dir, ".env")}
  ${join(dir, "access.json")}（允許：${access.allowFrom.length} 個帳號；可批准權限：${humans.join(", ")}）
  ${join(skillDir, "SKILL.md")}

接著在這台電腦執行（只需一次）：
  claude plugin marketplace add "${market}"
  claude plugin install office@office-local
  claude mcp add --transport http --scope user office-hub ${cfg.hub}/mcp --header "Authorization: Bearer ${token}"

之後用這個指令啟動辦公室用的 Claude Code（會出現一次開發者頻道確認畫面）：
  ${resolve(import.meta.dir, "office-claude")}${platform() === "win32" ? ".cmd" : ""}`);
}

// ---------------- 常駐：Hermes 接線 ----------------
interface TaskData { type: "task"; task_id: number; goal_id: number; title: string; instructions: string; verify?: string | null; lead: string; attempt?: number }

function runProcess(cmd: string, args: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs: number; onOutput?: (chunk: string) => void; signal?: AbortSignal; verbatim?: boolean }) {
  return new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolveP) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsVerbatimArguments: !!o.verbatim });
    let out = ""; let timedOut = false;
    const add = (b: Buffer) => { const s = b.toString(); out = (out + s).slice(-200_000); o.onOutput?.(s); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, o.timeoutMs);
    o.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); });
    child.on("error", (e) => { out += `\n[無法啟動 ${cmd}：${e.message}]`; });
    child.on("close", (code) => { clearTimeout(timer); resolveP({ code, out, timedOut }); });
  });
}

// Windows：cmd.exe 不認得反斜線跳脫的引號，所以整段命令原樣加一層引號交給 /s /c（與 cross-spawn 相同做法）
const shellArgs = (command: string): [string, string[], boolean] => platform() === "win32"
  ? ["cmd.exe", ["/d", "/s", "/c", `"chcp 65001 >nul & ${command}"`], true]
  : ["/bin/sh", ["-c", command], false];
const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s).trim();

/** 整理 Hermes 的終端機輸出，讓回報文字乾淨：
 *  去掉 ANSI 跳脫碼（顏色、游標、OSC 標題）、\r 覆寫、只有框線的行、行首行尾的框線，以及 session_id 行。 */
function cleanOutput(raw: string): string {
  const BOX = "─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╴╵╶╷";
  const boxOnly = new RegExp(`^[\\s${BOX}]*$`);
  const edge = new RegExp(`^\\s*[${BOX}]\\s?|\\s?[${BOX}]\\s*$`, "g");
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")          // OSC（視窗標題、超連結）
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")                      // CSI（顏色、游標移動）
    .replace(/\x1b[@-Z\\-_]/g, "")                                // 其他兩字元跳脫
    .split("\n")
    .map((line) => (line.includes("\r") ? line.split("\r").filter(Boolean).pop() ?? "" : line)) // 進度列覆寫只留最後一次
    .filter((line) => !/^\s*session_id\s*[:=]\s*\S+\s*$/i.test(line))
    .filter((line) => !boxOnly.test(line) || line.trim() === "")
    .map((line) => line.replace(edge, "").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function askHermes(cfg: Config, prompt: string, o: { cwd: string; env: Record<string, string>; onOutput?: (s: string) => void; signal?: AbortSignal }) {
  const h = cfg.hermes ?? {};
  const timeoutMs = (h.timeout_min ?? 30) * 60_000;
  if ((h.mode ?? "cli") === "api") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    o.signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await fetch(`${(h.api_url ?? "http://127.0.0.1:8642").replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", ...(h.api_key ? { authorization: `Bearer ${h.api_key}` } : {}) },
        body: JSON.stringify({ model: h.model ?? "hermes-agent", messages: [{ role: "user", content: prompt }] }),
      });
      const body = await res.json() as any;
      const text = body?.choices?.[0]?.message?.content ?? JSON.stringify(body).slice(0, 2000);
      o.onOutput?.(text);
      return { code: res.ok ? 0 : 1, out: cleanOutput(String(text)), timedOut: false };
    } catch (e) {
      return { code: 1, out: `Hermes API 錯誤：${(e as Error).message}`, timedOut: ctrl.signal.aborted };
    } finally { clearTimeout(timer); }
  }
  const [bin, ...args] = (h.cmd ?? ["hermes", "chat", "-Q", "-q"]).map(expand);
  let last = prompt;
  if (h.prompt_via === "file") {
    last = join(o.cwd, `prompt-${Date.now()}.txt`);
    writeFileSync(last, prompt, "utf8");
  }
  // Windows 上 Python 程式（Hermes）被導向輸出時預設用系統編碼（例如 cp950），強制 UTF-8 免得中文變亂碼
  const utf8 = platform() === "win32" ? { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } : {};
  // 請 Hermes 不要輸出顏色與框線（多數 CLI 認得 NO_COLOR / TERM=dumb）；仍有的話由 cleanOutput 清掉
  const plain = { NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", COLUMNS: "200" };
  const r = await runProcess(bin, [...args, last], { cwd: o.cwd, env: { ...utf8, ...plain, ...(h.env ?? {}), ...o.env }, timeoutMs, onOutput: o.onOutput, signal: o.signal });
  return { ...r, out: cleanOutput(r.out) };
}

async function cmdRun(cfg: Config) {
  const claudeHub = cfg.claude_token ? new Hub(cfg.hub, cfg.claude_token) : null;
  const hermesHub = cfg.hermes_token ? new Hub(cfg.hub, cfg.hermes_token) : null;
  if (!claudeHub && !hermesHub) die("設定檔至少要有 claude_token 或 hermes_token");
  const workRoot = expand(cfg.hermes?.cwd ?? join(homedir(), "office-work"));
  mkdirSync(workRoot, { recursive: true });

  // 檢查 Hermes 可用：不可用就不送它的心跳（UI 會顯示離線），避免派工給壞掉的 agent
  // hermes.cmd 可以是 ["hermes","chat","-Q","-q"]，也可以是 ["bun","腳本.ts"] 這類包裝
  let hermesOk = false;
  let hermesMe: any = null;
  if (hermesHub) {
    hermesMe = await hermesHub.call("getMe").catch((e) => die(`hermes_token 無效：${e.message}`));
    if ((cfg.hermes?.mode ?? "cli") === "cli") {
      const bin = expand((cfg.hermes?.cmd ?? ["hermes"])[0]);
      const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
      hermesOk = r.status === 0 || !r.error;
      if (!hermesOk) log(`⚠️ 找不到 Hermes CLI（${bin}），Hermes 會顯示離線。`);
    } else hermesOk = true;
  }

  // 心跳：每 30 秒。兩種角色分開送：
  // - claude_token（Windows 端）：只回報「辦公室用的 Claude session 有沒有在跑」，不把 Claude 標成在線；
  //   在線與否由頻道外掛的長輪詢和 hooks 決定，session 關掉時 UI 才會正確顯示離線。
  // - hermes_token（WSL 端）：回報 Hermes 在線。
  const pattern = cfg.claude_process_pattern ?? "office@office-local";
  const claudeUp = (): boolean | null => {
    if (platform() === "win32") {
      // wmic 在新版 Windows 已移除，改用 PowerShell 的 Get-CimInstance；排除 powershell 自己（它的命令列也含關鍵字）
      const q = `@(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${pattern}%' AND Name <> 'powershell.exe' AND Name <> 'pwsh.exe'").Count`;
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", q], { encoding: "utf8", timeout: 20_000 });
      if (r.status !== 0) return null;
      const n = Number(String(r.stdout).trim());
      return Number.isFinite(n) ? n > 0 : null;
    }
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return r.error ? null : r.status === 0;
  };
  const beat = async () => {
    if (claudeHub) {
      const up = claudeUp();
      if (up !== null) await claudeHub.call("heartbeat", { claude_session: up, session_only: true }).catch((e) => log("Claude 心跳失敗：", (e as Error).message));
    }
    if (hermesHub && hermesOk) await hermesHub.call("heartbeat", {}).catch((e) => log("Hermes 心跳失敗：", (e as Error).message));
  };
  await beat();
  setInterval(beat, 30_000);
  log(`office-node 已啟動：${cfg.machine} 機 → ${cfg.hub}${hermesHub ? `，Hermes 帳號 @${hermesMe.username}` : ""}`);

  if (!hermesHub || !hermesOk) { log("沒有可用的 Hermes，只送心跳。"); return; }

  const me = hermesMe;
  const queue: { kind: "task" | "chat"; msg: any }[] = [];
  let running: { taskId?: number; abort: AbortController } | null = null;

  const mentioned = (m: any) => {
    const text: string = m.text ?? m.caption ?? "";
    if (m.chat?.type === "private") return true;
    if (m.reply_to_message?.from?.username === me.username) return true;
    return (m.entities ?? []).some((e: any) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me.username}`.toLowerCase());
  };

  async function handleTask(m: any) {
    const d = m.data as TaskData;
    try { await hermesHub!.call("claimTask", { task_id: d.task_id }); }
    catch (e) { log(`#${d.task_id} 無法領取：${(e as Error).message}`); return; }
    const dir = join(workRoot, `task-${d.task_id}`);
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    const prompt = [
      `你是 ${me.first_name}，AI 辦公室裡負責執行的成員。只做下面任務要求的事，不要做額外的改動。`,
      "",
      `任務 #${d.task_id}：${d.title}`,
      "",
      d.instructions,
      "",
      `你在 ${platform() === "win32" ? "Windows（指令用 PowerShell 或 cmd，路徑像 D:\\data\\a.csv）" : "Linux"} 上執行。工作目錄：${dir}`,
      `要交付的檔案請放在：${outDir}`,
      ...(d.verify ? [`完成後系統會執行驗收指令：${d.verify}（結束碼 0 才算完成）`] : []),
      "",
      "完成後用兩三句話說明你做了什麼、結果在哪裡。如果做不到，清楚說明卡在哪一步。",
    ].join("\n");
    const ctrl = new AbortController();
    running = { taskId: d.task_id, abort: ctrl };
    const thread = m.message_thread_id;
    let progressMsg: any = null;
    try { progressMsg = await hermesHub!.call("sendMessage", { chat_id: OFFICE_GROUP, message_thread_id: thread, text: `▶️ 開始 #${d.task_id}：${d.title}` }); } catch { /* 略過 */ }
    let buf = "";
    let lastEdit = "";
    const typing = setInterval(() => hermesHub!.call("sendChatAction", { chat_id: OFFICE_GROUP, action: "typing" }).catch(() => {}), 4000);
    const progress = setInterval(async () => {
      const line = tail(cleanOutput(buf), 300).split("\n").filter(Boolean).pop() ?? "執行中";
      hermesHub!.call("progressTask", { task_id: d.task_id, note: line.slice(0, 200) }).catch(() => {});
      const view = `▶️ #${d.task_id} 執行中…\n\n${tail(cleanOutput(buf), 1500) || "（尚無輸出）"}`;
      if (progressMsg && view !== lastEdit) { lastEdit = view; hermesHub!.call("editMessageText", { chat_id: OFFICE_GROUP, message_id: progressMsg.message_id, text: view }).catch(() => {}); }
    }, 30_000);
    log(`▶️ 執行 #${d.task_id} ${d.title}`);
    const r = await askHermes(cfg, prompt, { cwd: dir, env: { OFFICE_AS: "hermes", OFFICE_TASK_ID: String(d.task_id), OFFICE_OUT: outDir }, onOutput: (s) => { buf = (buf + s).slice(-50_000); }, signal: ctrl.signal });
    clearInterval(typing); clearInterval(progress);
    running = null;
    if (ctrl.signal.aborted) { log(`⛔ #${d.task_id} 已取消`); return; }

    let status: "done" | "failed" = r.code === 0 && !r.timedOut ? "done" : "failed";
    let result = r.timedOut ? `逾時（${cfg.hermes?.timeout_min ?? 30} 分鐘）\n${tail(r.out, 1500)}` : tail(r.out, 3000);
    if (status === "done" && d.verify) {
      const [sh, args, verbatim] = shellArgs(d.verify);
      const v = await runProcess(sh, args, { cwd: dir, timeoutMs: (cfg.verify_timeout_sec ?? 120) * 1000, env: { OFFICE_OUT: outDir }, verbatim });
      result += `\n\n驗收：${d.verify}\n結束碼 ${v.code}${v.out.trim() ? `\n${tail(cleanOutput(v.out), 1000)}` : ""}`;
      if (v.code !== 0) status = "failed";
    }
    const files: string[] = [];
    for (const name of readdirSync(outDir).slice(0, 10)) {
      const p = join(outDir, name);
      try { if (statSync(p).isFile() && statSync(p).size <= 50 * 1024 * 1024) files.push((await hermesHub!.upload(p)).file_id); } catch (e) { log(`上傳 ${name} 失敗：${(e as Error).message}`); }
    }
    try { await hermesHub!.call("reportTask", { task_id: d.task_id, status, result, files }); log(`${status === "done" ? "✅" : "❌"} #${d.task_id} 回報 ${status}`); }
    catch (e) { log(`#${d.task_id} 回報失敗：${(e as Error).message}`); }
    if (progressMsg) hermesHub!.call("editMessageText", { chat_id: OFFICE_GROUP, message_id: progressMsg.message_id, text: `${status === "done" ? "✅" : "❌"} #${d.task_id} ${status === "done" ? "完成" : "失敗"}：${d.title}` }).catch(() => {});
  }

  async function handleChat(m: any) {
    const text: string = (m.text ?? m.caption ?? "").replace(new RegExp(`@${me.username}`, "ig"), "").trim();
    if (!text) return;
    const typing = setInterval(() => hermesHub!.call("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => {}), 4000);
    const r = await askHermes(cfg, `${m.from.first_name} 對你說：${text}\n\n請簡短回答。`, { cwd: workRoot, env: { OFFICE_AS: "hermes" } });
    clearInterval(typing);
    const answer = tail(r.out, 3500) || "（沒有輸出）";
    await hermesHub!.call("sendMessage", { chat_id: m.chat.id, text: answer, reply_parameters: { message_id: m.message_id } }).catch((e) => log("回覆失敗：", e.message));
  }

  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue.shift()!;
        try { item.kind === "task" ? await handleTask(item.msg) : await handleChat(item.msg); }
        catch (e) { log("處理失敗：", (e as Error).message); }
      }
    } finally { busy = false; }
  }

  let offset = 0;
  for (;;) {
    try {
      const ups = await hermesHub.call<any[]>("getUpdates", { offset, timeout: 30 });
      for (const u of ups) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !mentioned(m)) continue;
        if (m.data?.type === "cancel") {
          if (running?.taskId === m.data.task_id) running.abort.abort();
          const i = queue.findIndex((q) => q.msg.data?.task_id === m.data.task_id);
          if (i >= 0) queue.splice(i, 1);
          continue;
        }
        if (m.data?.type === "task") queue.push({ kind: "task", msg: m });
        else if (m.from?.is_bot === false || m.chat?.type === "private") queue.push({ kind: "chat", msg: m });
        // 其他 bot 在群組裡的非任務訊息：不回，避免 bot 互相閒聊
      }
      void pump();
    } catch (e) {
      log("getUpdates 失敗，5 秒後重試：", (e as Error).message);
      await Bun.sleep(5000);
    }
  }
}

// ---------------- 入口 ----------------
const [cmd, ...args] = process.argv.slice(2);
const cfg = cmd && cmd !== "help" ? loadConfig() : (null as unknown as Config);
switch (cmd) {
  case "run": await cmdRun(cfg); break;
  case "upload": await cmdUpload(cfg, args); break;
  case "download": await cmdDownload(cfg, args[0], args[1]); break;
  case "send": await cmdSend(cfg, args[0], args.slice(1).join(" ")); break;
  case "tasks": await cmdTasks(cfg, args.includes("--mine")); break;
  case "agents": await cmdAgents(cfg); break;
  case "whoami": await cmdWhoami(cfg); break;
  case "doctor": await cmdDoctor(cfg); break;
  case "setup-claude": await cmdSetupClaude(cfg); break;
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
