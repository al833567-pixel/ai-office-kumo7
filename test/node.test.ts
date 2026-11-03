// office-node：用假的 Hermes 指令跑完整個「收派工 → 執行 → 驗收 → 上傳檔案 → 回報」流程，以及 CLI。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
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

beforeAll(async () => {
  hub = startHub({ db: openDb(":memory:"), port: 0, maxPoll: 2 });
  for (const [u, isBot, kind, machine] of [["boss", false, "human", null], ["claude_b", true, "claude", "B"], ["hermes_b", true, "hermes", "B"]] as const) {
    const { account, token } = createAccount(hub.db, { username: u, firstName: u, isBot, kind, machine });
    tok[u] = token; addMember(hub.db, OFFICE_GROUP_ID, account.id);
  }
  dir = mkdtempSync(join(tmpdir(), "office-node-"));
  // 假 Hermes：最後一個參數是提示詞；提示詞含 FAIL 就失敗，否則在 $OFFICE_OUT 寫一個檔案
  const fake = join(dir, "fake-hermes");
  writeFileSync(fake, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "fake-hermes 0.1"; exit 0; fi
prompt="\${@: -1}"
echo "收到任務，開始處理"
if echo "$prompt" | grep -q "FAIL"; then echo "做不到" >&2; exit 3; fi
if [ -n "$OFFICE_OUT" ]; then echo "報表內容" > "$OFFICE_OUT/report.txt"; fi
echo "已完成：寫了 report.txt"
`);
  chmodSync(fake, 0o755);
  cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    hub: hub.url, machine: "B", claude_token: tok.claude_b, hermes_token: tok.hermes_b, approvers: [1000000001],
    hermes: { mode: "cli", cmd: [fake], cwd: join(dir, "work"), timeout_min: 1 },
  }));
  node = spawn("bun", [OFFICE, "run"], { env: { ...process.env, OFFICE_CONFIG: cfgPath } });
  node.stdout!.on("data", (b) => (nodeLog += b));
  node.stderr!.on("data", (b) => (nodeLog += b));
  for (let i = 0; i < 100 && !nodeLog.includes("office-node 已啟動"); i++) await Bun.sleep(100);
}, 20000);

afterAll(() => { node?.kill(); hub.stop(); });

describe("office run（Hermes 接線）", () => {
  test("心跳讓 Hermes 顯示在線", async () => {
    const s = (await ok("boss", "getAgents")).find((a: any) => a.username === "hermes_b");
    expect(s.state).not.toBe("offline");
  });

  test("派工 → 假 Hermes 執行 → 驗收通過 → 上傳檔案 → 回報 done", async () => {
    const g = await ok("claude_b", "createGoal", { title: "產生報表" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "寫報表", instructions: "在輸出目錄寫 report.txt", verify: "test -s out/report.txt" });
    const done = await waitTask(t.task_id, ["done", "failed"]);
    expect(done.status).toBe("done");
    expect(done.result).toContain("已完成");
    expect(done.result).toContain("結束碼 0");
    expect(done.files.length).toBe(1);
    const info = await ok("claude_b", "getFile", { file_id: done.files[0] });
    expect(info.file_name).toBe("report.txt");
  });

  test("驗收失敗會回報 failed，主管收到通知並自動重試", async () => {
    const g = await ok("claude_b", "createGoal", { title: "驗收失敗" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "驗收會失敗", instructions: "隨便", verify: "exit 7", max_attempts: 1 });
    const r = await waitTask(t.task_id, ["failed"]);
    expect(r.result).toContain("結束碼 7");
  });

  test("Hermes 執行失敗（非 0 結束碼）會回報 failed", async () => {
    const g = await ok("claude_b", "createGoal", { title: "執行失敗" });
    const t = await ok("claude_b", "createTask", { goal_id: g.goal_id, assignee: "hermes_b", title: "會失敗", instructions: "請 FAIL", max_attempts: 1 });
    const r = await waitTask(t.task_id, ["failed"]);
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

describe("office CLI", () => {
  // 非同步執行：Hub 跑在測試程式裡，同步等待會卡住 Hub
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", OFFICE, ...args], { env: { ...process.env, OFFICE_CONFIG: cfgPath }, stdout: "pipe", stderr: "pipe" });
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
    expect(doc.stdout).toContain("hermes_token → @hermes_b");
  });
});
