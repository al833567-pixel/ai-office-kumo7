// office-node：用假的 Hermes 指令跑完整個「收派工 → 執行 → 驗收 → 上傳檔案 → 回報」流程，以及 CLI。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../src/server";
import { openDb, addMember, OFFICE_GROUP_ID } from "../src/db";
import { createAccount } from "../src/auth";

const OFFICE = join(import.meta.dir, "..", "node", "office.ts");
let hub: ReturnType<typeof startHub>;
const tok: Record<string, string> = {};
let dir = "";
let cfgPath = "";
let node: ChildProcess;
let nodeLog = "";
let checkScript = "";
const BUN = process.execPath; // 用目前執行測試的 bun，Windows 不必依賴 PATH 或 shebang

async function ok(who: string, method: string, params: Record<string, unknown> = {}) {
  const kind = who === "boss" ? "user" : "bot";
  const r = await (await fetch(`${hub.url}/${kind}${tok[who]}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })).json() as any;
  if (!r.ok) throw new Error(`${who}.${method}: ${r.description}`);
  return r.result;
}
async function waitTask(id: number, statuses: string[], ms = 15000) {
  for (let t = 0; t < ms; t += 100) {
    const task = (await ok("claude_b", "getTasks", {})).find((x: any) => x.task_id === id);
    if (statuses.includes(task.status)) return task;
    await Bun.sleep(100);
  }
  throw new Error(`task ${id} 沒有變成 ${statuses}；office-node 輸出：\n${nodeLog}`);
}

async function waitReassigned(id: number, ms = 15000) {
  for (let t = 0; t < ms; t += 100) {
    const task = (await ok("claude_b", "getTasks", {})).find((x: any) => x.task_id === id);
    if (task.assignee === "claude_b" && task.status === "todo") return task;
    await Bun.sleep(100);
  }
  throw new Error(`task ${id} 沒有改派給主管；office-node 輸出：\n${nodeLog}`);
}

beforeAll(async () => {
  hub = startHub({ db: openDb(":memory:"), port: 0, maxPoll: 2 });
  for (const [u, isBot, kind, machine] of [["boss", false, "human", null], ["claude_b", true, "claude", "B"], ["hermes_b", true, "hermes", "B"]] as const) {
    const { account, token } = createAccount(hub.db, { username: u, firstName: u, isBot, kind, machine });
    tok[u] = token; addMember(hub.db, OFFICE_GROUP_ID, account.id);
  }
  dir = mkdtempSync(join(tmpdir(), "office-node-"));
  // 假 Hermes（Bun 腳本，Windows 也能跑）：最後一個參數是提示詞；提示詞含 FAIL 就失敗，否則在 $OFFICE_OUT 寫一個檔案
  const fake = join(dir, "fake-hermes.ts");
  writeFileSync(fake, `const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake-hermes 0.1"); process.exit(0); }
const qi = args.indexOf("--query-file");
const prompt = qi >= 0 ? require("fs").readFileSync(args[qi + 1], "utf8") : (args.at(-1) ?? "");
console.log(qi >= 0 ? "收到任務（檔案），開始處理" : "收到任務，開始處理");
if (prompt.includes("FAIL")) { console.error("做不到"); process.exit(3); }
if (process.env.OFFICE_OUT) require("fs").writeFileSync(require("path").join(process.env.OFFICE_OUT, "report.txt"), "報表內容\\n");
// 模仿 Hermes 的終端機輸出：顏色碼、框線、session_id
console.log("\\x1b[2m╭──────────╮\\x1b[0m");
console.log("\\x1b[2m│\\x1b[0m 已完成：寫了 \\x1b[1;32mreport.txt\\x1b[0m \\x1b[2m│\\x1b[0m");
console.log("\\x1b[2m╰──────────╯\\x1b[0m");
console.log("session_id: local-1a2b3c");
// 照提示把結論寫進指定檔案（模擬 Hermes 聽話）；FAKE_NO_ANSWER=1 時不寫，測試退回「取最後一段」
const m = prompt.match(/結論寫進檔案：(.+)$/m);
if (m && !process.env.FAKE_NO_ANSWER) require("fs").writeFileSync(m[1].trim(), "報表已寫好，在 out/report.txt。");
`);
  // 驗收用的小腳本：out/report.txt 存在且非空就成功（cmd.exe 與 sh 都能執行）
  checkScript = join(dir, "check-report.ts");
  writeFileSync(checkScript, `const fs = require("fs"); process.exit(fs.existsSync("out/report.txt") && fs.statSync("out/report.txt").size > 0 ? 0 : 1);`);
  cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    hub: hub.url, machine: "B", claude_token: tok.claude_b, hermes_token: tok.hermes_b, approvers: [1000000001],
    // Windows 建議的寫法：提示詞用 --query-file 傳；指令路徑可用 %VAR%
    hermes: { mode: "cli", cmd: ["%OFFICE_TEST_BUN%", fake, "--query-file"], prompt_via: "file", cwd: join(dir, "work"), timeout_min: 1 },
  }));
  node = spawn(BUN, [OFFICE, "run"], { env: { ...process.env, OFFICE_CONFIG: cfgPath, OFFICE_TEST_BUN: BUN } });
  node.stdout!.on("data", (b) => (nodeLog += b));
  node.stderr!.on("data", (b) => (nodeLog += b));
  for (let i = 0; i < 100 && !nodeLog.includes("office-node 已啟動"); i++) await Bun.sleep(100);
}, 20000);

afterAll(() => { node?.kill(); argNode?.kill(); hub.stop(); });
let argNode: ChildProcess | undefined;

describe("office run（Hermes 接線）", () => {
  test("心跳讓 Hermes 顯示在線", async () => {
    const s = (await ok("boss", "getAgents")).find((a: any) => a.username === "hermes_b");
    expect(s.state).not.toBe("offline");
  });

  test("派工 → 假 Hermes 執行 → 驗收通過 → 上傳檔案 → 回報 done", async () => {
    const g = await ok("claude_b", "createGoal", { title: "產生報表" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "寫報表", instructions: "在輸出目錄寫 report.txt", verify: `"${BUN}" "${checkScript}"` });
    const done = await waitTask(t.task_id, ["done", "failed"]);
    expect(done.status).toBe("done");
    // 回報只有答案與驗收結果，沒有過程
    expect(done.result).toContain("報表已寫好，在 out/report.txt。");
    expect(done.result).toContain("驗收通過");
    expect(done.result).not.toContain("收到任務");    // 過程不送給主管
    expect(done.result).not.toContain("\x1b");      // 沒有 ANSI 色碼
    expect(done.result).not.toContain("session_id"); // 沒有 session_id 行
    expect(done.result).not.toMatch(/[│╭╰]/);         // 沒有框線
    // 工作階段與完整過程記在任務上，給人日後查
    expect(done.session_ref).toBe("local-1a2b3c");
    expect(done.log_ref).toMatch(/^B 機：.*worker-.*\.log$/);
    const logFile = done.log_ref.replace(/^B 機：/, "");
    expect(readFileSync(logFile, "utf8")).toContain("收到任務（檔案）"); // 走 --query-file，過程完整保存
    expect(readFileSync(logFile, "utf8")).toContain("session_id: local-1a2b3c");
    expect(done.result).not.toContain("prompt-");      // 提示詞檔不在任務資料夾
    expect(existsSync(join(dir, "work", ".prompts")) ? readdirSync(join(dir, "work", ".prompts")).length : 0).toBe(0); // 用完已刪
    expect(done.files.length).toBe(1);
    const info = await ok("claude_b", "getFile", { file_id: done.files[0] });
    expect(info.file_name).toBe("report.txt");
  });

  // 這兩個目標沒有在線的審查者：Hermes 用完重試次數後，任務改派給主管（claude_b）
  test("驗收失敗：Hermes 回報 failed，用完次數後改派給主管", async () => {
    const g = await ok("claude_b", "createGoal", { title: "驗收失敗" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "驗收會失敗", instructions: "隨便", verify: "exit 7", max_attempts: 1 });
    const r = await waitReassigned(t.task_id);
    expect(r.result).toContain("結束碼 7");
  });

  test("Hermes 執行失敗（非 0 結束碼）：改派給主管並附上錯誤", async () => {
    const g = await ok("claude_b", "createGoal", { title: "執行失敗" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "會失敗", instructions: "請 FAIL", max_attempts: 1 });
    const r = await waitReassigned(t.task_id);
    expect(r.result).toContain("做不到");
  });

  test("在群組 @hermes_b 聊天（真人）會得到回覆", async () => {
    await ok("boss", "getUpdates", { offset: -1 });
    const sent = await ok("boss", "sendMessage", { chat_id: OFFICE_GROUP_ID, text: "@hermes_b 你好" });
    let reply: any = null;
    for (let i = 0; i < 100 && !reply; i++) {
      const ups = await ok("boss", "getUpdates", {});
      reply = ups.map((u: any) => u.message).find((m: any) => m?.reply_to_message?.message_id === sent.message_id);
      if (!reply) await Bun.sleep(100);
    }
    expect(reply.from.username).toBe("hermes_b");
    expect(reply.text).toContain("收到任務");
  });
});

describe("提示詞當參數（arg 模式）", () => {
  test("另一個 Hermes 用 arg 模式也能完成任務", async () => {
    const { account, token } = createAccount(hub.db, { username: "hermes_c", firstName: "Hermes-C", isBot: true, kind: "hermes", machine: "C" });
    addMember(hub.db, OFFICE_GROUP_ID, account.id);
    tok.hermes_c = token;
    const cfg2 = join(dir, "config-arg.json");
    writeFileSync(cfg2, JSON.stringify({ hub: hub.url, machine: "C", hermes_token: token, hermes: { mode: "cli", cmd: [BUN, join(dir, "fake-hermes.ts")], cwd: join(dir, "work-c"), timeout_min: 1, env: { FAKE_NO_ANSWER: "1" } } }));
    let log2 = "";
    argNode = spawn(BUN, [OFFICE, "run"], { env: { ...process.env, OFFICE_CONFIG: cfg2 } });
    argNode.stdout!.on("data", (b) => (log2 += b));
    for (let i = 0; i < 100 && !log2.includes("office-node 已啟動"); i++) await Bun.sleep(100);
    const g = await ok("claude_b", "createGoal", { title: "arg 模式" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_c", title: "arg 測試", instructions: "寫報表" });
    const r = await waitTask(t.task_id, ["done", "failed"]);
    expect(r.status).toBe("done");
    // Hermes 沒寫 answer.md：退回取輸出最後一段（這個假 Hermes 的輸出只有一段）
    expect(r.result).toContain("已完成：寫了 report.txt");
    expect(r.session_ref).toBe("local-1a2b3c");
  }, 20000);
});

describe("一台多個執行者（假 Codex／假 Gemini，提示詞走 stdin）", () => {
  let multi: ChildProcess | undefined;
  let mlog = "";
  afterAll(() => multi?.kill());

  test("同一個 office-node 同時接兩個執行者；{answer_file} 佔位字讓 CLI 直接寫結論", async () => {
    const mk = (u: string, kind: string) => { const r = createAccount(hub.db, { username: u, firstName: u, isBot: true, kind, machine: "M" }); addMember(hub.db, OFFICE_GROUP_ID, r.account.id); tok[u] = r.token; return r.token; };
    const tCodex = mk("codex_m", "codex"), tGem = mk("gemini_m", "antigravity");
    // 假 Codex：codex exec -o <檔> -（提示詞從 stdin），最後的回答寫進 -o 指定的檔案
    const fakeCodex = join(dir, "fake-codex.ts");
    writeFileSync(fakeCodex, `const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
const prompt = await Bun.stdin.text();
console.log("session id: 0199-fake-codex");
console.log("thinking…");
const o = a[a.indexOf("-o") + 1];
require("fs").writeFileSync(o, prompt.includes("任務") ? "Codex 完成：已修改 3 個檔案。" : "?");`);
    // 假 Gemini：gemini -p "<指示>"，stdin 的內容接在後面
    const fakeGem = join(dir, "fake-gemini.ts");
    writeFileSync(fakeGem, `const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("0.0.0-fake"); process.exit(0); }
const stdin = await Bun.stdin.text();
console.log("過程…");
console.log("");
console.log(stdin.includes("任務") && a.includes("-p") ? "Gemini 完成：整理好表格。" : "沒收到提示詞");`);
    const cfg3 = join(dir, "config-multi.json");
    writeFileSync(cfg3, JSON.stringify({ hub: hub.url, machine: "M", workers: [
      { token: tCodex, name: "codex_m", cmd: [BUN, fakeCodex, "-o", "{answer_file}", "-"], prompt_via: "stdin", cwd: join(dir, "work-m"), timeout_min: 1 },
      { token: tGem, name: "gemini_m", cmd: [BUN, fakeGem, "-p", "請依照下面 stdin 的任務執行"], prompt_via: "stdin", cwd: join(dir, "work-m"), timeout_min: 1 },
    ] }));
    multi = spawn(BUN, [OFFICE, "run"], { env: { ...process.env, OFFICE_CONFIG: cfg3 } });
    multi.stdout!.on("data", (b) => (mlog += b)); multi.stderr!.on("data", (b) => (mlog += b));
    for (let i = 0; i < 100 && !(mlog.includes("@codex_m") && mlog.includes("@gemini_m")); i++) await Bun.sleep(100);
    const g = await ok("claude_b", "createGoal", { title: "多執行者" });
    const t1 = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "codex_m", title: "改程式", instructions: "改三個檔" });
    const t2 = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "gemini_m", title: "整理表格", instructions: "整理" });
    const [r1, r2] = await Promise.all([waitTask(t1.task_id, ["done", "failed"]), waitTask(t2.task_id, ["done", "failed"])]);
    expect(r1.status).toBe("done");
    expect(r1.result).toBe("Codex 完成：已修改 3 個檔案。");   // 只有 -o 寫的結論
    expect(r1.session_ref).toBe("0199-fake-codex");
    expect(r2.status).toBe("done");
    expect(r2.result).toBe("Gemini 完成：整理好表格。");       // 沒寫 answer.md：取最後一段
    const states = await ok("boss", "getAgents");
    expect(states.find((a: any) => a.username === "codex_m").state).not.toBe("offline");
  }, 30000);
});

describe("office ask（櫃台）", () => {
  test("交目標、等主管結案，印出總結", async () => {
    const cfgAsk = join(dir, "config-ask.json");
    writeFileSync(cfgAsk, JSON.stringify({ hub: hub.url, machine: "B", boss_token: tok.boss }));
    const p = Bun.spawn([BUN, OFFICE, "ask", "整理兩台電腦的磁碟報告", "--lead", "claude_b"], { env: { ...process.env, OFFICE_CONFIG: cfgAsk }, stdout: "pipe", stderr: "pipe" });
    let goal: any = null;
    for (let i = 0; i < 50 && !goal; i++) { goal = (await ok("boss", "getGoals", {})).find((g: any) => g.detail === "整理兩台電腦的磁碟報告"); if (!goal) await Bun.sleep(100); }
    expect(goal.lead).toBe("claude_b");
    await ok("claude_b", "sendMessage", { chat_id: OFFICE_GROUP_ID, message_thread_id: goal.goal_id, text: "開始處理" });
    await ok("claude_b", "completeGoal", { goal_id: goal.goal_id, summary: "A 機 C 槽剩 313 GB；B 機 D 槽剩 120 GB。" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain(`目標 #${goal.goal_id}`);
    expect(out).toContain("claude_b：開始處理");
    expect(out).toContain("🏁 完成");
    expect(out).toContain("A 機 C 槽剩 313 GB");
  }, 20000);
});

describe("office CLI", () => {
  // 非同步執行：Hub 跑在測試程式裡，同步等待會卡住 Hub
  const run = async (...args: string[]) => {
    const p = Bun.spawn([BUN, OFFICE, ...args], { env: { ...process.env, OFFICE_CONFIG: cfgPath, OFFICE_TEST_BUN: BUN }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { status: await p.exited, stdout, stderr };
  };

  test("upload → download 往返", async () => {
    const src = join(dir, "上傳測試.txt");
    writeFileSync(src, "abc123");
    const up = await run("upload", src);
    expect(up.status).toBe(0);
    const fileId = up.stdout.split("\t")[0];
    expect(fileId).toMatch(/^F/);
    const down = await run("download", fileId, join(dir, "dl"));
    expect(down.status).toBe(0);
    const path = down.stdout.trim();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("abc123");
  });

  test("whoami、agents、tasks、send、doctor", async () => {
    expect((await run("whoami")).stdout).toContain("claude_b");
    expect((await run("agents")).stdout).toContain("hermes_b");
    expect((await run("tasks")).stdout).toContain("寫報表");
    expect((await run("send", "office", "CLI 測試")).stdout).toContain("已送出");
    const doc = await run("doctor");
    expect(doc.stdout).toContain("✅ Hub 連線");
    expect(doc.stdout).toContain("執行者 token → @hermes_b");
    expect(doc.stdout).toContain("✅   @hermes_b 的指令：");
  });
});
