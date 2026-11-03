#!/usr/bin/env bun
// office：每台 agent 機器上的工具（Bun 單檔，不需安裝套件；Windows 與 Linux 都能用）。
//
//   office run                       常駐：執行者接線（收派工→執行→驗收→回報）、心跳、Claude session 偵測
//                                    一台可同時接多個執行者（Hermes、Codex、Antigravity 或任何命令列 AI）
//   office ask "<目標>" [選項]         櫃台：把目標交給團隊，等到完成後印出總結（需要 boss_token）
//                                    選項：--lead auto|<claude 帳號>  --download <目錄>  --timeout <分鐘>
//   office upload <檔案>...           上傳檔案到 Hub，印出 file_id（給 office_report 的 files 用）
//   office download <file_id> [目錄]  從 Hub 下載檔案
//   office send <對象|office> <文字>  發訊息（對象是 username，office 代表群組）
//   office tasks [--mine]            列出任務
//   office agents                    列出所有 agent 狀態
//   office whoami                    顯示目前使用的帳號
//   office setup-claude [--as <帳號>] 寫入 Claude 端設定（channel .env、access.json、/office skill）並印出要執行的指令
//                                    同一台第二個以上的 Claude 用 --as（帳號 token 放在 claude_profiles）
//   office setup-desktop [--as <帳號>] 讓 Claude Code 桌面版直接當主管：加 office MCP、裝 /office skill
//   office doctor                    檢查設定、連線與每個執行者的指令
//
// 設定檔：~/.office/config.json（或環境變數 OFFICE_CONFIG 指定路徑）。
// 指令用哪個帳號：環境變數 OFFICE_AS（claude｜帳號名稱｜hermes），沒設就用 claude_token。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

interface WorkerConfig {
  token: string;                  // 這個執行者在 Hub 的 bot token
  name?: string;                  // 帳號名稱（例如 codex_a），給 OFFICE_AS 與日誌用；不填會自動查
  mode?: "cli" | "api";
  cmd?: string[];                 // cli：執行的指令。可用佔位字 {prompt_file} {answer_file} {cwd} {out_dir}
  prompt_via?: "arg" | "file" | "stdin"; // 沒用 {prompt_file} 時，提示詞怎麼給：最後一個參數／寫成檔案傳路徑／從 stdin 給
  api_url?: string;               // api：OpenAI 相容的 chat completions 端點根網址（例如 Hermes 的 http://127.0.0.1:8642）
  api_key?: string;
  model?: string;
  cwd?: string;                   // 任務工作目錄根目錄（預設 ~/office-work）
  timeout_min?: number;
  env?: Record<string, string>;
}

interface Config {
  hub: string;
  machine: string;
  claude_token?: string;                       // 這台的主要 Claude（office-claude 啟動的那個）
  claude_profiles?: Record<string, string>;    // 同一台的其他 Claude：帳號名稱 → token（office-claude <帳號> 啟動）
  boss_token?: string;                         // 真人帳號，給 office ask 用
  workers?: WorkerConfig[];                    // 執行者（Hermes、Codex、Antigravity…）
  hermes_token?: string;                       // 舊版寫法：等同 workers 只有一個 Hermes
  hermes?: Omit<WorkerConfig, "token">;
  approvers?: number[];                        // 可以批准權限的真人帳號 id
  verify_timeout_sec?: number;
  claude_process_pattern?: string;
  claude_mode?: "channel" | "desktop";         // desktop：用 Claude Code 桌面版當主管（office setup-desktop）
}

const CONFIG_PATH = process.env.OFFICE_CONFIG ?? join(homedir(), ".office", "config.json");
const OFFICE_GROUP = -1001000000001;
const IS_WIN = platform() === "win32";

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) die(`找不到設定檔 ${CONFIG_PATH}。請參考 node/ 裡的 config.*.example.json 建立。`);
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

/** 舊版的 hermes_token + hermes 轉成 workers */
function workersOf(cfg: Config): WorkerConfig[] {
  const list = [...(cfg.workers ?? [])];
  if (cfg.hermes_token && !list.some((w) => w.token === cfg.hermes_token)) {
    list.push({ cmd: ["hermes", "chat", "-Q", "-q"], ...(cfg.hermes ?? {}), token: cfg.hermes_token, name: cfg.hermes?.name ?? "hermes" });
  }
  return list;
}

function tokenFor(cfg: Config, who = process.env.OFFICE_AS ?? "claude"): string {
  if (who === "claude") { if (cfg.claude_token) return cfg.claude_token; }
  else if (cfg.claude_profiles?.[who]) return cfg.claude_profiles[who];
  else {
    const ws = workersOf(cfg);
    const w = ws.find((x) => x.name === who) ?? (who === "hermes" ? ws.find((x) => (x.name ?? "").startsWith("hermes")) : undefined);
    if (w) return w.token;
  }
  die(`設定檔裡找不到「${who}」的 token（OFFICE_AS=${who}）`);
}

class Hub {
  constructor(public base: string, public token: string, public kind: "bot" | "user" = "bot") {}
  async call<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/${this.kind}${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal,
    });
    const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!body.ok) { const e = new Error(body.description ?? "hub error") as Error & { code?: number }; e.code = body.error_code; throw e; }
    return body.result;
  }
  async upload(path: string): Promise<{ file_id: string; file_name?: string; file_size: number }> {
    const form = new FormData();
    form.append("file", Bun.file(path), basename(path));
    const res = await fetch(`${this.base}/${this.kind}${this.token}/uploadFile`, { method: "POST", body: form });
    const body = await res.json() as { ok: boolean; result: any; description?: string };
    if (!body.ok) throw new Error(body.description);
    return body.result;
  }
  async download(fileId: string, dir: string): Promise<string> {
    const info = await this.call<{ file_path: string; file_name?: string }>("getFile", { file_id: fileId });
    const res = await fetch(`${this.base}/file/${this.kind}${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`下載失敗 HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    const name = (info.file_name ?? fileId).replace(/[\\/]/g, "_");
    let out = join(dir, name);
    for (let i = 1; existsSync(out); i++) out = join(dir, name.replace(/(\.[^.]*)?$/, `-${i}$1`));
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    return out;
  }
}

// ---------------- 執行外部指令（Windows／Linux） ----------------

/** 找出 Windows 上指令的實際檔案（npm 裝的 codex 等 CLI 是 .cmd 包裝，不能直接 spawn） */
function whichWin(bin: string): string | null {
  if (/[\\/]/.test(bin)) return existsSync(bin) ? bin : null;
  const r = spawnSync("where", [bin], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  return lines.find((l) => /\.(exe|com)$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
}
const needsCmdShell = (bin: string) => IS_WIN && /\.(cmd|bat)$/i.test(whichWin(bin) ?? "");
const quoteCmd = (a: string) => (/^[A-Za-z0-9_\-+=.,:\/\\@%]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

function runProcess(cmd: string, args: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs: number; onOutput?: (chunk: string) => void; signal?: AbortSignal; verbatim?: boolean; input?: string }) {
  return new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolveP) => {
    let bin = cmd, argv = args, verbatim = !!o.verbatim;
    if (!verbatim && needsCmdShell(cmd)) {
      // .cmd／.bat 只能經由 cmd.exe 執行；參數各自加引號
      argv = ["/d", "/s", "/c", `"${[quoteCmd(whichWin(cmd)!), ...args.map(quoteCmd)].join(" ")}"`];
      bin = "cmd.exe"; verbatim = true;
    }
    const child = spawn(bin, argv, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], shell: false, windowsVerbatimArguments: verbatim });
    let out = ""; let timedOut = false;
    const add = (b: Buffer) => { const s = b.toString(); out = (out + s).slice(-200_000); o.onOutput?.(s); };
    child.stdout!.on("data", add); child.stderr!.on("data", add);
    if (o.input !== undefined) { child.stdin!.on("error", () => {}); child.stdin!.end(o.input, "utf8"); }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, o.timeoutMs);
    o.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); });
    child.on("error", (e) => { out += `\n[無法啟動 ${cmd}：${e.message}]`; });
    child.on("close", (code) => { clearTimeout(timer); resolveP({ code, out, timedOut }); });
  });
}

// Windows：cmd.exe 不認得反斜線跳脫的引號，所以整段命令原樣加一層引號交給 /s /c（與 cross-spawn 相同做法）
const shellArgs = (command: string): [string, string[], boolean] => IS_WIN
  ? ["cmd.exe", ["/d", "/s", "/c", `"chcp 65001 >nul & ${command}"`], true]
  : ["/bin/sh", ["-c", command], false];
const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s).trim();

/** 從原始輸出找工作階段編號（例如 "session_id: local-1a2b3c"、"session id: 0199…"），取最後一個 */
function findSessionId(raw: string): string | null {
  const plain = raw.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
  const all = [...plain.matchAll(/session[_ ]id\s*[:=]\s*([A-Za-z0-9._:-]+)/gi)];
  return all.length ? all[all.length - 1][1] : null;
}

/** 從整理過的輸出取「最後的結論」：最後一段（以空行分隔），太短就往前多帶一段 */
function lastAnswer(clean: string, max = 1500): string {
  const blocks = clean.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  let out = blocks.pop() ?? "";
  while (out.length < 12 && blocks.length) out = `${blocks.pop()}\n\n${out}`; // 最後一段太短（例如只有「完成」）才往前多帶
  return tail(out, max);
}

/** 整理終端機輸出：去掉 ANSI 跳脫碼（顏色、游標、OSC 標題）、\r 覆寫、只有框線的行、行首行尾的框線，以及 session_id 行 */
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
    .filter((line) => !/^\s*session[_ ]id\s*[:=]\s*\S+\s*$/i.test(line))
    .filter((line) => !boxOnly.test(line) || line.trim() === "")
    .map((line) => line.replace(edge, "").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 呼叫一個執行者（任何命令列 AI 或 OpenAI 相容 API） */
async function askWorker(w: WorkerConfig, prompt: string, o: { cwd: string; outDir?: string; answerFile?: string; env: Record<string, string>; onOutput?: (s: string) => void; signal?: AbortSignal }) {
  const timeoutMs = (w.timeout_min ?? 30) * 60_000;
  if ((w.mode ?? "cli") === "api") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    o.signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await fetch(`${(w.api_url ?? "http://127.0.0.1:8642").replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", ...(w.api_key ? { authorization: `Bearer ${w.api_key}` } : {}) },
        body: JSON.stringify({ model: w.model ?? "hermes-agent", messages: [{ role: "user", content: prompt }] }),
      });
      const body = await res.json() as any;
      const text = body?.choices?.[0]?.message?.content ?? JSON.stringify(body).slice(0, 2000);
      o.onOutput?.(text);
      return { code: res.ok ? 0 : 1, out: cleanOutput(String(text)), timedOut: false, sessionId: body?.session_id ?? body?.id ?? null };
    } catch (e) {
      return { code: 1, out: `API 錯誤：${(e as Error).message}`, timedOut: ctrl.signal.aborted, sessionId: null };
    } finally { clearTimeout(timer); }
  }
  const raw = (w.cmd ?? ["hermes", "chat", "-Q", "-q"]).map(expand);
  let via = w.prompt_via ?? "arg";
  // .cmd 包裝（npm 裝的 CLI）經過 cmd.exe 時，長提示詞放在參數裡會被引號與換行弄壞：改用 stdin
  if (via === "arg" && needsCmdShell(raw[0])) via = "stdin";
  let promptFile: string | null = null;
  const usesPromptFile = raw.some((a) => a.includes("{prompt_file}"));
  if (usesPromptFile || via === "file") {
    // 提示詞檔放在工作根目錄的 .prompts（不在任務資料夾裡，驗收或輸出不會看到它），跑完就刪
    const dir = join(expand(w.cwd ?? join(homedir(), "office-work")), ".prompts");
    mkdirSync(dir, { recursive: true });
    promptFile = join(dir, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(promptFile, prompt, "utf8");
  }
  const fill = (a: string) => a
    .replaceAll("{prompt_file}", promptFile ?? "")
    .replaceAll("{answer_file}", o.answerFile ?? join(o.cwd, "answer.md"))
    .replaceAll("{cwd}", o.cwd)
    .replaceAll("{out_dir}", o.outDir ?? join(o.cwd, "out"));
  const [bin, ...args] = raw.map(fill);
  const finalArgs = usesPromptFile ? args : via === "arg" ? [...args, prompt] : via === "file" ? [...args, promptFile!] : args;
  // Windows 上 Python 程式（Hermes）被導向輸出時預設用系統編碼（例如 cp950），強制 UTF-8 免得中文變亂碼
  const utf8 = IS_WIN ? { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } : {};
  // 請 CLI 不要輸出顏色與框線（多數 CLI 認得 NO_COLOR / TERM=dumb）；仍有的話由 cleanOutput 清掉
  const plain = { NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", COLUMNS: "200" };
  const r = await runProcess(bin, finalArgs, { cwd: o.cwd, env: { ...utf8, ...plain, ...(w.env ?? {}), ...o.env }, timeoutMs, onOutput: o.onOutput, signal: o.signal, input: via === "stdin" && !usesPromptFile ? prompt : undefined });
  if (promptFile) { try { unlinkSync(promptFile); } catch { /* 刪不掉就留著，不影響結果 */ } }
  return { ...r, out: cleanOutput(r.out), sessionId: findSessionId(r.out) };
}

function checkBinary(w: WorkerConfig): { ok: boolean; info: string } {
  if ((w.mode ?? "cli") === "api") return { ok: true, info: `API ${w.api_url ?? "http://127.0.0.1:8642"}` };
  const bin = expand((w.cmd ?? ["hermes"])[0]);
  if (IS_WIN && !whichWin(bin)) return { ok: false, info: `${bin}（找不到）` };
  const r = needsCmdShell(bin)
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${quoteCmd(whichWin(bin)!)} --version"`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 30_000 })
    : spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (r.error) return { ok: false, info: `${bin}（無法執行：${r.error.message}）` };
  return { ok: r.status === 0, info: `${bin} ${(r.stdout || r.stderr || "").trim().split("\n")[0]}` };
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
  for (const t of tasks) console.log(`#${String(t.task_id).padEnd(4)} ${t.status.padEnd(9)} ${String(t.assignee).padEnd(12)} 目標#${t.goal_id} ${t.title}`);
}

async function cmdAgents(cfg: Config) {
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const agents = await hub.call<any[]>("getAgents");
  for (const a of agents) console.log(`${a.username.padEnd(12)} ${String(a.kind).padEnd(11)} ${a.state.padEnd(8)} ${a.machine ?? "-"}  ${a.task ? `#${a.task.task_id} ${a.task.title}` : ""} ${a.detail ?? ""}`);
}

async function cmdWhoami(cfg: Config) {
  const hub = new Hub(cfg.hub, tokenFor(cfg));
  const me = await hub.call("getMe");
  console.log(`${me.username}（id ${me.id}）@ ${cfg.hub}`);
}

/** 櫃台：交目標、等完成、印總結。任何終端機（Windows／Linux）或任何能執行指令的 AI 都能用 */
async function cmdAsk(cfg: Config, args: string[]) {
  const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const lead = opt("--lead") ?? "auto";
  const dl = opt("--download");
  const timeoutMin = Number(opt("--timeout") ?? 120);
  const text = args.join(" ").trim();
  if (!text) die('用法：office ask "<目標>" [--lead auto|claude_a] [--download <目錄>] [--timeout <分鐘>]');
  if (!cfg.boss_token) die("office ask 需要設定檔裡的 boss_token（你的真人帳號 token）");
  const hub = new Hub(cfg.hub, cfg.boss_token, "user");
  const g = await hub.call("createGoal", { title: text.length > 60 ? text.slice(0, 60) + "…" : text, detail: text, lead });
  console.log(`🎯 目標 #${g.goal_id}：主管 ${g.lead}${g.reviewer ? `、審查 ${g.reviewer}` : ""}。等待完成（Ctrl+C 只停止等待，目標會繼續）…`);
  const deadline = Date.now() + timeoutMin * 60_000;
  for (;;) {
    const r = await hub.call<any>("waitEvents", { goal_id: g.goal_id, timeout: 100 });
    for (const m of r.messages) if (m.thread_id === g.goal_id || m.data?.goal_id === g.goal_id) console.log(`  · ${m.from}：${String(m.text).split("\n")[0].slice(0, 120)}`);
    if (r.done) {
      console.log(`\n${r.goal.status === "done" ? "🏁 完成" : `結束（${r.goal.status}）`}\n\n${r.goal.summary || "（主管沒有附總結）"}`);
      for (const f of r.goal.files ?? []) console.log(dl ? `📎 ${await hub.download(f, resolve(dl))}` : `📎 ${f}（office download ${f} <目錄>）`);
      return;
    }
    if (Date.now() > deadline) { console.log(`\n超過 ${timeoutMin} 分鐘，先停止等待。目標 #${g.goal_id} 仍在進行，可到 UI 查看。`); return; }
  }
}

async function cmdDoctor(cfg: Config) {
  const ok = (b: boolean, msg: string) => console.log(`${b ? "✅" : "❌"} ${msg}`);
  console.log(`作業系統：${platform()}　設定檔：${CONFIG_PATH}`);
  try { const r = await fetch(`${cfg.hub}/health`); ok(r.ok, `Hub 連線 ${cfg.hub}`); } catch (e) { ok(false, `Hub 連線失敗：${(e as Error).message}`); }
  const claudes: [string, string][] = [...(cfg.claude_token ? [["claude_token", cfg.claude_token] as [string, string]] : []), ...Object.entries(cfg.claude_profiles ?? {})];
  for (const [label, t] of claudes) {
    try { const me = await new Hub(cfg.hub, t).call("getMe"); ok(true, `${label} → @${me.username}`); } catch (e) { ok(false, `${label} 驗證失敗：${(e as Error).message}`); }
  }
  if (cfg.boss_token) { try { const me = await new Hub(cfg.hub, cfg.boss_token, "user").call("getMe"); ok(true, `boss_token → @${me.username}（office ask 可用）`); } catch (e) { ok(false, `boss_token 驗證失敗：${(e as Error).message}`); } }
  for (const w of workersOf(cfg)) {
    let who = w.name ?? "?";
    try { const me = await new Hub(cfg.hub, w.token).call("getMe"); who = me.username; ok(true, `執行者 token → @${me.username}`); } catch (e) { ok(false, `執行者 ${who} 的 token 驗證失敗：${(e as Error).message}`); }
    const b = checkBinary(w);
    ok(b.ok, `  @${who} 的指令：${b.info}`);
  }
  if (claudes.length) {
    const c = spawnSync("claude", ["--version"], { encoding: "utf8", shell: IS_WIN });
    ok(c.status === 0, `Claude Code 命令列版：${c.status === 0 ? c.stdout.trim() : "PATH 裡找不到 claude（只有桌面版時請執行 winget install Anthropic.ClaudeCode）"}`);
    const envFile = join(homedir(), ".claude", "channels", "office", ".env");
    ok(existsSync(envFile), `Claude channel 設定 ${envFile}`);
    ok(existsSync(join(homedir(), ".claude", "skills", "office", "SKILL.md")), "/office skill 已安裝");
  }
}

async function cmdSetupClaude(cfg: Config, args: string[]) {
  const i = args.indexOf("--as");
  const profile = i >= 0 ? args[i + 1] : null;
  const token = profile ? (cfg.claude_profiles?.[profile] ?? die(`設定檔的 claude_profiles 裡沒有 ${profile}`)) : tokenFor(cfg, "claude");
  const hub = new Hub(cfg.hub, token);
  const me = await hub.call("getMe");
  // 允許清單：真人批准者＋其他所有 agent
  const agents = await hub.call<any[]>("getAgents");
  const humans = cfg.approvers ?? [];
  const peers: string[] = [];
  for (const a of agents) if (a.username !== me.username) {
    const c = await hub.call("getChat", { chat_id: `@${a.username}` });
    peers.push(String(c.id));
  }
  if (!humans.length) die("設定檔請加上 approvers（你的 boss 帳號 id，例如 [1000000001]），這些人才能在 UI 上批准權限。");
  const dir = join(homedir(), ".claude", "channels", profile ? `office-${profile}` : "office");
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
  const skillSrc = join(import.meta.dir, "..", "claude", "skill-office", "SKILL.md");
  const skillDir = join(homedir(), ".claude", "skills", "office");
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(skillSrc, join(skillDir, "SKILL.md"));
  const market = resolve(import.meta.dir, "..", "claude");
  const launcher = `${resolve(import.meta.dir, "office-claude")}${IS_WIN ? ".cmd" : ""}${profile ? ` ${profile}` : ""}`;
  console.log(`已寫入（@${me.username}）：
  ${join(dir, ".env")}
  ${join(dir, "access.json")}（允許：${access.allowFrom.length} 個帳號；可批准權限：${humans.join(", ")}）
  ${join(skillDir, "SKILL.md")}

這台電腦第一次設定時執行（只需一次）：
  claude plugin marketplace add "${market}"
  claude plugin install office@office-local

office_* 工具由 office 外掛直接提供，不需要再 claude mcp add。
（之前加過 office-hub MCP 的話可以移除，避免工具重複：claude mcp remove office-hub -s user）

之後用這個指令啟動辦公室用的 Claude Code（會出現一次開發者頻道確認畫面）：
  ${launcher}`);
}

async function cmdSetupDesktop(cfg: Config, args: string[]) {
  const i = args.indexOf("--as");
  const profile = i >= 0 ? args[i + 1] : null;
  const token = profile ? (cfg.claude_profiles?.[profile] ?? die(`設定檔的 claude_profiles 裡沒有 ${profile}`)) : tokenFor(cfg, "claude");
  const hub = new Hub(cfg.hub, token);
  const me = await hub.call("getMe");
  const kind = (await hub.call<any[]>("getAgents")).find((a) => a.username === me.username)?.kind;
  if (kind && kind !== "claude") die(`@${me.username} 不是 claude 帳號，桌面版當主管要用 claude 帳號`);
  const name = "office-desktop";
  const url = `${cfg.hub.replace(/\/+$/, "")}/mcp`;
  // Windows 的 claude 可能是 .cmd，要經過 shell；參數含空白（Authorization 標頭），所以自己加引號
  const claude = (a: string[]) => IS_WIN
    ? spawnSync(["claude", ...a].map((x) => /[\s"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(" "), { encoding: "utf8", shell: true })
    : spawnSync("claude", a, { encoding: "utf8" });
  claude(["mcp", "remove", name, "-s", "user"]);
  // 舊版教學加過的 office-hub 跟 office-desktop 是同一組工具，留著會出現兩份
  const oldHub = claude(["mcp", "remove", "office-hub", "-s", "user"]).status === 0;
  const r = claude(["mcp", "add", "--transport", "http", "-s", "user", name, url, "--header", `Authorization: Bearer ${token}`]);
  const skillSrc = join(import.meta.dir, "..", "claude", "skill-office", "SKILL.md");
  const skillDir = join(homedir(), ".claude", "skills", "office");
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(skillSrc, join(skillDir, "SKILL.md"));
  const manual = `claude mcp add --transport http -s user ${name} ${url} --header "Authorization: Bearer <token>"`;
  console.log(`桌面版主管設定（@${me.username}）：
  MCP：${r.status === 0 ? `已加入 ${name} → ${url}` : `自動加入失敗（${(r.stderr || r.error?.message || "").trim()}），請手動執行：\n    ${manual}`}
  /office skill：${join(skillDir, "SKILL.md")}${oldHub ? "\n  已移除重複的舊 MCP：office-hub" : ""}
  office 外掛：桌面版用不到（沒有 OFFICE_SESSION=1 時不提供工具、hooks 也不動作），留著無害；
    不會再用終端機辦公室模式的話可以移除：claude plugin uninstall office@office-local

接下來：
  1. 設定檔加上 "claude_mode": "desktop"，再重新啟動 office-node（office run），UI 才會把 @${me.username} 顯示為在線。
  2. 重開 Claude Code 桌面版，開新的本機 session，輸入：/office <目標>
  3. 不要再同時開 office-claude（終端機辦公室 session）用同一個帳號，兩邊會搶派工訊息。`);
}

// ---------------- 常駐：執行者接線 ----------------
interface TaskData { type: "task"; task_id: number; goal_id: number; title: string; instructions: string; verify?: string | null; lead: string; attempt?: number }

async function runWorker(cfg: Config, w: WorkerConfig) {
  const hub = new Hub(cfg.hub, w.token);
  const me = await hub.call("getMe").catch((e) => { log(`❌ 執行者 ${w.name ?? ""} 的 token 無效：${e.message}`); return null; });
  if (!me) return;
  const bin = checkBinary(w);
  if (!bin.ok) { log(`⚠️ @${me.username} 的指令無法執行（${bin.info}），不送它的心跳，UI 會顯示離線。`); return; }
  const workRoot = expand(w.cwd ?? join(homedir(), "office-work"));
  mkdirSync(workRoot, { recursive: true });
  const beat = () => hub.call("heartbeat", {}).catch((e) => log(`@${me.username} 心跳失敗：`, (e as Error).message));
  await beat();
  setInterval(beat, 30_000);
  log(`🧑‍💻 @${me.username}（${me.first_name}）上線：${bin.info}`);

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
    try { await hub.call("claimTask", { task_id: d.task_id }); }
    catch (e) { log(`#${d.task_id} 無法領取：${(e as Error).message}`); return; }
    const dir = join(workRoot, `task-${d.task_id}`);
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    // 給主管的結論寫在這個檔案；過程不送出（完整過程另存 worker-*.log 給人查）
    const answerFile = join(dir, "answer.md");
    try { unlinkSync(answerFile); } catch { /* 沒有舊的 */ }
    const prompt = [
      `你是 ${me.first_name}，AI 辦公室裡負責執行的成員。只做下面任務要求的事，不要做額外的改動。`,
      "",
      `任務 #${d.task_id}：${d.title}`,
      "",
      d.instructions,
      "",
      `你在 ${IS_WIN ? "Windows（路徑像 D:\\data\\a.csv）" : "Linux"} 上執行。工作目錄：${dir}`,
      "任務說明裡提到的指令或工具只是建議；被你的安全規則擋下或無法執行時，改用其他方法達成同樣的結果，並在結論裡說明用了什麼方法。",
      `要交付的檔案請放在：${outDir}`,
      ...(d.verify ? [`完成後系統會執行驗收指令：${d.verify}（結束碼 0 才算完成）`] : []),
      "",
      `最後，把要交給主管的結論寫進檔案：${answerFile}`,
      "結論只寫兩三句：做了什麼、結果是什麼、檔案在哪裡；不要寫過程。如果做不到，寫清楚卡在哪一步。",
    ].join("\n");
    const ctrl = new AbortController();
    running = { taskId: d.task_id, abort: ctrl };
    let progressMsg: any = null;
    try { progressMsg = await hub.call("sendMessage", { chat_id: OFFICE_GROUP, message_thread_id: m.message_thread_id, text: `▶️ 開始 #${d.task_id}：${d.title}` }); } catch { /* 略過 */ }
    let buf = "";
    let lastEdit = "";
    const typing = setInterval(() => hub.call("sendChatAction", { chat_id: OFFICE_GROUP, action: "typing" }).catch(() => {}), 4000);
    const started = Date.now();
    const progress = setInterval(async () => {
      // 只回報「還在跑、跑了多久、最後一行」，不把過程貼到群組
      const line = tail(cleanOutput(buf), 300).split("\n").filter(Boolean).pop() ?? "執行中";
      hub.call("progressTask", { task_id: d.task_id, note: line.slice(0, 200) }).catch(() => {});
      const view = `▶️ #${d.task_id} 執行中…（${Math.round((Date.now() - started) / 60000)} 分鐘）`;
      if (progressMsg && view !== lastEdit) { lastEdit = view; hub.call("editMessageText", { chat_id: OFFICE_GROUP, message_id: progressMsg.message_id, text: view }).catch(() => {}); }
    }, 30_000);
    log(`▶️ @${me.username} 執行 #${d.task_id} ${d.title}`);
    const r = await askWorker(w, prompt, { cwd: dir, outDir, answerFile, env: { OFFICE_AS: me.username, OFFICE_TASK_ID: String(d.task_id), OFFICE_OUT: outDir, OFFICE_ANSWER: answerFile }, onOutput: (s) => { buf = (buf + s).slice(-50_000); }, signal: ctrl.signal });
    clearInterval(typing); clearInterval(progress);
    running = null;
    if (ctrl.signal.aborted) { log(`⛔ #${d.task_id} 已取消`); return; }

    // 完整過程存檔給人查（不送給主管）
    const logPath = join(dir, `worker-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    try { writeFileSync(logPath, `# 任務 #${d.task_id} ${d.title}（@${me.username}）\n# session_id: ${r.sessionId ?? "（未取得）"}\n\n${r.out}\n`, "utf8"); } catch (e) { log(`寫入過程紀錄失敗：${(e as Error).message}`); }

    let status: "done" | "failed" = r.code === 0 && !r.timedOut ? "done" : "failed";
    // 回報只放答案：優先用執行者寫的 answer.md；沒寫就取輸出最後一段。失敗時附上錯誤尾段，主管才能判斷
    let answer = "";
    try { answer = cleanOutput(readFileSync(answerFile, "utf8")).slice(0, 3000); } catch { /* 沒寫 */ }
    if (!answer) answer = lastAnswer(r.out);
    let result = r.timedOut
      ? `逾時（${w.timeout_min ?? 30} 分鐘）\n${tail(r.out, 800)}`
      : status === "failed" ? `${answer}\n\n錯誤（結束碼 ${r.code}）：\n${tail(r.out, 800)}` : answer;
    if (status === "done" && d.verify) {
      const [sh, args, verbatim] = shellArgs(d.verify);
      const v = await runProcess(sh, args, { cwd: dir, timeoutMs: (cfg.verify_timeout_sec ?? 120) * 1000, env: { OFFICE_OUT: outDir }, verbatim });
      if (v.code === 0) result += `\n\n驗收通過（${d.verify}）`;
      else {
        status = "failed";
        result += `\n\n驗收失敗：${d.verify}\n結束碼 ${v.code}${v.out.trim() ? `\n${tail(cleanOutput(v.out), 800)}` : ""}`;
      }
    }
    const files: string[] = [];
    for (const name of readdirSync(outDir).slice(0, 10)) {
      const p = join(outDir, name);
      try { if (statSync(p).isFile() && statSync(p).size <= 50 * 1024 * 1024) files.push((await hub.upload(p)).file_id); } catch (e) { log(`上傳 ${name} 失敗：${(e as Error).message}`); }
    }
    try {
      await hub.call("reportTask", { task_id: d.task_id, status, result, files, session_ref: r.sessionId ?? undefined, log_ref: `${cfg.machine} 機：${logPath}` });
      log(`${status === "done" ? "✅" : "❌"} @${me.username} #${d.task_id} 回報 ${status}${r.sessionId ? `（session ${r.sessionId}）` : ""}`);
    } catch (e) { log(`#${d.task_id} 回報失敗：${(e as Error).message}`); }
    if (progressMsg) hub.call("editMessageText", { chat_id: OFFICE_GROUP, message_id: progressMsg.message_id, text: `${status === "done" ? "✅" : "❌"} #${d.task_id} ${status === "done" ? "完成" : "失敗"}：${d.title}` }).catch(() => {});
  }

  async function handleChat(m: any) {
    const text: string = (m.text ?? m.caption ?? "").replace(new RegExp(`@${me.username}`, "ig"), "").trim();
    if (!text) return;
    const typing = setInterval(() => hub.call("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => {}), 4000);
    const chatDir = join(workRoot, ".chat");
    mkdirSync(chatDir, { recursive: true });
    const r = await askWorker(w, `${m.from.first_name} 對你說：${text}\n\n請簡短回答。`, { cwd: chatDir, env: { OFFICE_AS: me.username } });
    clearInterval(typing);
    const answer = lastAnswer(r.out, 3500) || "（沒有輸出）"; // 聊天也只回結論，不貼過程
    await hub.call("sendMessage", { chat_id: m.chat.id, text: answer, reply_parameters: { message_id: m.message_id } }).catch((e) => log("回覆失敗：", e.message));
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
      const ups = await hub.call<any[]>("getUpdates", { offset, timeout: 30 });
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
      log(`@${me.username} getUpdates 失敗，5 秒後重試：`, (e as Error).message);
      await Bun.sleep(5000);
    }
  }
}

async function cmdRun(cfg: Config) {
  const workers = workersOf(cfg);
  const claudeHub = cfg.claude_token ? new Hub(cfg.hub, cfg.claude_token) : null;
  if (!claudeHub && !workers.length) die("設定檔至少要有 claude_token 或 workers");

  // Claude session 偵測：只回報「辦公室用的 Claude session 有沒有在跑」，不把 Claude 標成在線；
  // 在線與否由頻道外掛的長輪詢和 hooks 決定，session 關掉時 UI 才會正確顯示離線。
  const pattern = cfg.claude_process_pattern ?? "office@office-local";
  const claudeUp = (): boolean | null => {
    if (IS_WIN) {
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
  if (claudeHub) {
    // 桌面版模式：桌面版沒有頻道外掛和 hooks，這台的 office-node 在跑就算 Claude 在線；
    // 有設 claude_process_pattern 時才改用程序偵測。
    const desktop = cfg.claude_mode === "desktop";
    const beat = async () => {
      if (desktop) {
        const up = cfg.claude_process_pattern ? claudeUp() : true;
        await claudeHub.call("heartbeat", up === false ? { claude_session: false, session_only: true } : { claude_session: true })
          .catch((e) => log("Claude 心跳失敗：", (e as Error).message));
        return;
      }
      const up = claudeUp();
      if (up !== null) await claudeHub.call("heartbeat", { claude_session: up, session_only: true }).catch((e) => log("Claude 心跳失敗：", (e as Error).message));
    };
    await beat();
    setInterval(beat, 30_000);
  }
  log(`office-node 已啟動：${cfg.machine} 機 → ${cfg.hub}（${IS_WIN ? "Windows" : platform()}，執行者 ${workers.length} 個）`);
  if (!workers.length) { log("沒有設定執行者，只回報 Claude session 狀態。"); return; }
  // 每個執行者各自一條迴圈，同時運作
  await Promise.all(workers.map((w) => runWorker(cfg, w).catch((e) => log(`執行者錯誤：${(e as Error).message}`))));
}

// ---------------- 入口 ----------------
const [cmd, ...args] = process.argv.slice(2);
const cfg = cmd && cmd !== "help" ? loadConfig() : (null as unknown as Config);
switch (cmd) {
  case "run": await cmdRun(cfg); break;
  case "ask": await cmdAsk(cfg, args); break;
  case "upload": await cmdUpload(cfg, args); break;
  case "download": await cmdDownload(cfg, args[0], args[1]); break;
  case "send": await cmdSend(cfg, args[0], args.slice(1).join(" ")); break;
  case "tasks": await cmdTasks(cfg, args.includes("--mine")); break;
  case "agents": await cmdAgents(cfg); break;
  case "whoami": await cmdWhoami(cfg); break;
  case "doctor": await cmdDoctor(cfg); break;
  case "setup-claude": await cmdSetupClaude(cfg, args); break;
  case "setup-desktop": await cmdSetupDesktop(cfg, args); break;
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
