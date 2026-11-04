// 任務引擎：目標（goal）、任務（task）、派工、領取租約、回報、審查、改派、依賴解鎖，
// 以及 agent 狀態計算（給 UI 的狀態燈與「走去哪個房間」）。
// 所有對外動作都透過一般訊息發到 office 群組裡「以目標編號為討論串」的位置，
// 被 @ 到的 agent 會經由 getUpdates（Claude 的 Channel、Hermes 的 office-node）收到。
import type { Database } from "bun:sqlite";
import { type Account, OFFICE_GROUP_ID, getAccountBy, logEvent, now } from "./db";
import { ApiError, type Ctx, type Params, int, json, postMessage, str, touchActivity, getFileRow } from "./botapi";

export interface GoalRow {
  id: number; title: string; detail: string | null; lead_id: number; reviewer_id: number | null; created_by: number;
  status: string; summary: string | null; files: string | null; created_at: number; updated_at: number;
}
export interface TaskRow {
  id: number; goal_id: number; title: string; instructions: string; assignee_id: number; created_by: number;
  status: string; depends_on: string; verify: string | null; attempts: number; max_attempts: number;
  lease_until: number | null; result: string | null; files: string | null; note: string | null;
  session_ref: string | null; log_ref: string | null;
  created_at: number; updated_at: number;
}

const OFFICE = OFFICE_GROUP_ID;

const getGoal = (db: Database, id: number) => db.query("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | null;
const getTask = (db: Database, id: number) => db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
const acc = (db: Database, id: number | null) => (id ? getAccountBy(db, id) : null);
const at = (a: Account | null) => (a ? `@${a.username}` : "（無）");

function requireGoal(db: Database, id: number | undefined) {
  const g = id !== undefined ? getGoal(db, id) : null;
  if (!g) throw new ApiError(400, "Bad Request: goal not found");
  return g;
}
function requireTask(db: Database, id: number | undefined) {
  const t = id !== undefined ? getTask(db, id) : null;
  if (!t) throw new ApiError(400, "Bad Request: task not found");
  return t;
}
function requireAgent(db: Database, key: unknown, field: string) {
  if (key === undefined || key === null || key === "") throw new ApiError(400, `Bad Request: ${field} is required`);
  const a = getAccountBy(db, key as string);
  if (!a || a.disabled || !a.is_bot) throw new ApiError(400, `Bad Request: ${field} must be an agent (bot) username`);
  return a;
}
const isLeadOrHuman = (me: Account, g: GoalRow) => !me.is_bot || me.id === g.lead_id;

function files(db: Database, raw: unknown): string[] {
  const list = json<string[]>(raw, "files") ?? [];
  if (!Array.isArray(list)) throw new ApiError(400, "Bad Request: files must be an array of file_id");
  for (const id of list) if (!getFileRow(db, String(id))) throw new ApiError(400, `Bad Request: unknown file_id ${id}`);
  return list.map(String);
}

export function taskObj(db: Database, t: TaskRow) {
  return {
    task_id: t.id, goal_id: t.goal_id, title: t.title, instructions: t.instructions,
    assignee: acc(db, t.assignee_id)?.username, created_by: acc(db, t.created_by)?.username,
    status: t.status, depends_on: JSON.parse(t.depends_on), verify: t.verify, attempts: t.attempts, max_attempts: t.max_attempts,
    lease_until: t.lease_until, result: t.result, files: t.files ? JSON.parse(t.files) : [], note: t.note,
    session_ref: t.session_ref ?? null, log_ref: t.log_ref ?? null,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}
export function goalObj(db: Database, g: GoalRow) {
  return {
    goal_id: g.id, title: g.title, detail: g.detail, lead: acc(db, g.lead_id)?.username, reviewer: acc(db, g.reviewer_id)?.username ?? null,
    created_by: acc(db, g.created_by)?.username, status: g.status, summary: g.summary, files: g.files ? JSON.parse(g.files) : [],
    thread_id: g.id, created_at: g.created_at, updated_at: g.updated_at,
  };
}

function setTask(ctx: Ctx, t: TaskRow, patch: Partial<TaskRow>, eventType = "task") {
  Object.assign(t, patch, { updated_at: now() });
  ctx.db.query(`UPDATE tasks SET status=$status, assignee_id=$assignee_id, attempts=$attempts, lease_until=$lease_until,
                result=$result, files=$files, note=$note, session_ref=$session_ref, log_ref=$log_ref, updated_at=$updated_at WHERE id=$id`).run({
    status: t.status, assignee_id: t.assignee_id, attempts: t.attempts, lease_until: t.lease_until,
    result: t.result, files: t.files, note: t.note, session_ref: t.session_ref ?? null, log_ref: t.log_ref ?? null, updated_at: t.updated_at, id: t.id,
  });
  logEvent(ctx.db, eventType, ctx.me.id, null, taskObj(ctx.db, t));
}

/** 用某個帳號的身分發訊息（例如派工由主管發出） */
function postAs(ctx: Ctx, who: Account, text: string, o: { threadId: number; data?: unknown; replyMarkup?: unknown }) {
  return postMessage({ ...ctx, me: who }, OFFICE, { text, threadId: o.threadId, data: o.data, replyMarkup: o.replyMarkup, internal: true });
}

/** 重新派出時附帶的原因：退回說明全文、上次的結果（含驗收失敗輸出）尾段 */
interface DispatchExtra { reason?: "retry" | "reject" | "reassign" | "rerun"; review_note?: string | null; prev_result?: string | null }
const prevTail = (s: string | null | undefined) => (s ? (s.length > 1500 ? "…" + s.slice(-1500) : s) : null);

function dispatch(ctx: Ctx, t: TaskRow, prefix = "📋 任務", extra: DispatchExtra = {}) {
  const db = ctx.db;
  const g = getGoal(db, t.goal_id)!;
  const lead = acc(db, g.lead_id)!;
  const assignee = acc(db, t.assignee_id)!;
  const deps = JSON.parse(t.depends_on) as number[];
  const lines = [
    `${at(assignee)} ${prefix} #${t.id}：${t.title}`,
    "",
    ...(extra.review_note ? ["↩️ 退回說明（請先照這些修正）：", extra.review_note, ""] : []),
    ...(extra.prev_result ? ["上次的結果／失敗原因（尾段）：", extra.prev_result, ""] : []),
    t.instructions,
    ...(t.verify ? ["", `驗收指令：${t.verify}`] : []),
    ...(deps.length ? [`前置任務：${deps.map((d) => "#" + d).join("、")}（已完成）`] : []),
    "",
    `目標 #${g.id} · 主管 ${at(lead)} · 第 ${t.attempts + 1}/${t.max_attempts} 次`,
    `開始時呼叫 office_claim(${t.id})，完成後 office_report(${t.id}, "done"|"failed", 結果)。`,
  ];
  // 一般由主管發出派工訊息；任務派給主管自己時，改由觸發者（真人或系統）發；主管自己派給自己就不必發
  const sender: Account | null = assignee.id !== lead.id ? lead : ctx.me.id !== assignee.id ? ctx.me : null;
  if (sender) {
    postAs(ctx, sender, lines.join("\n"), {
      threadId: g.id,
      data: { type: "task", task_id: t.id, goal_id: g.id, title: t.title, instructions: t.instructions, verify: t.verify, lead: lead.username, attempt: t.attempts + 1,
        ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.review_note ? { review_note: extra.review_note } : {}), ...(extra.prev_result ? { prev_result: extra.prev_result } : {}) },
    });
  }
  logEvent(db, "task_dispatch", ctx.me.id, null, taskObj(db, t));
}

/** 次數用完（失敗或被退回太多次）：執行者改派給在線的審查者 Claude，否則主管；Claude 就標成失敗通知主管 */
function exhausted(ctx: Ctx, t: TaskRow, g: GoalRow, assignee: Account, attempts: number, lastError: string, extra: DispatchExtra) {
  const db = ctx.db;
  const lead = acc(db, g.lead_id)!;
  if (assignee.kind !== "claude") {
    const states = agentStates(ctx);
    const reviewer = acc(db, g.reviewer_id);
    const helper = reviewer && reviewer.id !== assignee.id && states[reviewer.username]?.state !== "offline" ? reviewer : lead;
    setTask(ctx, t, { status: "todo", attempts: 0, assignee_id: helper.id, lease_until: null, note: `由 ${assignee.username} 改派（${attempts} 次未通過）` });
    postMessage(ctx, OFFICE, { text: `${at(lead)} ⚠️ #${t.id} 在 ${assignee.first_name} ${attempts} 次未通過，已自動改派給 ${helper.first_name}。\n最後原因：${lastError.slice(0, 500)}`, threadId: g.id, internal: true,
      data: { type: "report", task_id: t.id, goal_id: g.id, status: "reassigned", to: helper.username } });
    dispatch(ctx, t, "🆘 改派任務", { ...extra, reason: "reassign" });
  } else {
    setTask(ctx, t, { status: "failed", attempts, lease_until: null });
    postMessage(ctx, OFFICE, {
      text: `${at(lead)} ❌ 任務 #${t.id} 失敗（${attempts}/${t.max_attempts}）：${t.title}\n\n${lastError || "（沒有附原因）"}\n\n可以用 office_reassign 改派或 office_retry 重試。`,
      threadId: g.id, internal: true, data: { type: "report", task_id: t.id, goal_id: g.id, status: "failed" },
    });
  }
}

function unblockDependents(ctx: Ctx, goalId: number) {
  const db = ctx.db;
  const blocked = db.query("SELECT * FROM tasks WHERE goal_id = ? AND status = 'blocked'").all(goalId) as TaskRow[];
  for (const t of blocked) {
    const deps = JSON.parse(t.depends_on) as number[];
    const ok = deps.every((d) => getTask(db, d)?.status === "done");
    if (ok) { setTask(ctx, t, { status: "todo" }); dispatch(ctx, t); }
  }
}

/** 自動選主管：沒有指定時，挑空閒的 Claude；都忙就挑手上任務最少的 */
function pickLead(ctx: Ctx, detail: string) {
  const db = ctx.db;
  const claudes = db.query("SELECT * FROM accounts WHERE kind = 'claude' AND disabled = 0 AND is_bot = 1 ORDER BY id").all() as Account[];
  if (!claudes.length) throw new ApiError(400, "Bad Request: no claude agents registered");
  const named = claudes.find((c) => c.machine && new RegExp(`${c.machine}\\s*機`).test(detail));
  if (named) return { lead: named, why: `目標提到 ${named.machine} 機` };
  const states = agentStates(ctx);
  const idle = claudes.find((c) => states[c.username]?.state === "idle");
  if (idle) return { lead: idle, why: `${idle.first_name} 空閒` };
  const load = (c: Account) => (db.query("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status IN ('todo','doing','blocked')").get(c.id) as { n: number }).n
    + (db.query("SELECT COUNT(*) AS n FROM goals WHERE lead_id = ? AND status = 'doing'").get(c.id) as { n: number }).n;
  const best = [...claudes].sort((a, b) => load(a) - load(b))[0];
  return { lead: best, why: "手上工作最少" };
}

// ---------- 方法（HTTP 與 MCP 共用）----------
export const taskMethods: Record<string, (ctx: Ctx, p: Params) => unknown> = {
  createGoal(ctx, p) {
    const { db, me } = ctx;
    const title = str(p.title)?.trim();
    if (!title) throw new ApiError(400, "Bad Request: title is required");
    const detail = str(p.detail)?.trim() || null;
    let lead: Account, why: string;
    if (p.lead && p.lead !== "auto") { lead = requireAgent(db, p.lead, "lead"); why = "指定"; }
    else if (me.is_bot && me.kind === "claude") { lead = me; why = "收到輸入的人當主管"; }
    else ({ lead, why } = pickLead(ctx, `${title} ${detail ?? ""}`));
    let reviewer: Account | null = null;
    if (p.reviewer === "none") reviewer = null;
    else if (p.reviewer) reviewer = requireAgent(db, p.reviewer, "reviewer");
    else {
      // 預設審查者：另一位「在線」的 Claude；都不在線就不設（主管自己審），避免任務卡在不在線的人身上
      const states = agentStates(ctx);
      const others = db.query("SELECT * FROM accounts WHERE kind = 'claude' AND disabled = 0 AND id != ? ORDER BY id").all(lead.id) as Account[];
      reviewer = others.find((c) => states[c.username] && states[c.username].state !== "offline") ?? null;
    }

    const ts = now();
    const g = db.query(`INSERT INTO goals (title, detail, lead_id, reviewer_id, created_by, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'doing', ?, ?) RETURNING *`).get(title, detail, lead.id, reviewer?.id ?? null, me.id, ts, ts) as GoalRow;
    const text = [
      `🎯 目標 #${g.id}：${title}`,
      ...(detail ? ["", detail] : []),
      "",
      me.id === lead.id ? `主管：${lead.first_name}（${why}）` : `${at(lead)} 你是這個目標的主管（${why}），請拆解並用 office_assign 派工。`,
      `審查：${reviewer ? reviewer.first_name : "無（另一位 Claude 不在線，由主管自行審查）"}`,
    ].join("\n");
    postMessage(ctx, OFFICE, { text, threadId: g.id, internal: true, data: { type: "goal", goal_id: g.id, lead: lead.username, reviewer: reviewer?.username ?? null, title } });
    logEvent(db, "goal", me.id, null, goalObj(db, g));
    return goalObj(db, g);
  },

  createTask(ctx, p) {
    const { db, me } = ctx;
    const g = requireGoal(db, int(p.goal_id, "goal_id", true));
    if (g.status !== "doing") throw new ApiError(400, "Bad Request: goal is not active");
    if (!isLeadOrHuman(me, g)) throw new ApiError(403, `Forbidden: only the goal lead (@${acc(db, g.lead_id)?.username}) can assign tasks`);
    const assignee = requireAgent(db, p.assignee, "assignee");
    const title = str(p.title)?.trim();
    // 固定格式派工（MCP 的 office_assign 一律走這裡）：五個欄位都要填，由 Hub 組成固定格式的說明交給執行者
    const structured = p._structured === true || p.objective !== undefined;
    let instructions = str(p.instructions)?.trim();
    if (structured) {
      const fields: [string, string][] = [["objective", "目標"], ["inputs", "輸入"], ["deliverable", "交付物"], ["out_of_scope", "不要做什麼"], ["verify", "驗收"]];
      const missing = fields.filter(([k]) => !str(p[k])?.trim());
      if (missing.length) {
        throw new ApiError(400, `Bad Request: office_assign 缺少必填欄位：${missing.map(([k, zh]) => `${zh}（${k}）`).join("、")}。`
          + "每張派工都要寫：objective 要達成什麼、inputs 用到哪些輸入（路徑、file_id、前置任務的產出；沒有就寫「無」）、"
          + "deliverable 交付什麼（檔名、格式、放在 out/，或結論要包含什麼）、out_of_scope 不要做什麼、verify 驗收方式（執行者是 Hermes 等命令列 AI 時是一行指令，結束碼 0 代表完成）。"
          + "如果你的 office_assign 工具定義裡沒有這些欄位，是這個 session 還在用 Hub 更新前的舊工具清單：照上面補上欄位重送即可，或請使用者重開 Claude Code session。");
      }
      const f = (k: string) => str(p[k])!.trim();
      instructions = [
        `【目標】${f("objective")}`,
        `【輸入】${f("inputs")}`,
        ...(str(p.steps)?.trim() ? [`【建議做法】${str(p.steps)!.trim()}（做法不限，結果對就好）`] : []),
        `【交付物】${f("deliverable")}`,
        `【不要做】${f("out_of_scope")}`,
        ...(str(p.instructions)?.trim() ? [`【補充】${str(p.instructions)!.trim()}`] : []),
      ].join("\n");
    }
    if (!title || !instructions) throw new ApiError(400, "Bad Request: title and instructions are required");
    const deps = (json<number[]>(p.depends_on, "depends_on") ?? []).map(Number);
    for (const d of deps) {
      const dt = getTask(db, d);
      if (!dt || dt.goal_id !== g.id) throw new ApiError(400, `Bad Request: depends_on #${d} is not a task of goal #${g.id}`);
    }
    const ready = deps.every((d) => getTask(db, d)!.status === "done");
    const maxAttempts = Math.min(Math.max(int(p.max_attempts, "max_attempts") ?? (assignee.kind === "claude" ? 3 : 2), 1), 5);
    const ts = now();
    const t = db.query(`INSERT INTO tasks (goal_id, title, instructions, assignee_id, created_by, status, depends_on, verify, max_attempts, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(g.id, title, instructions, assignee.id, me.id, ready ? "todo" : "blocked", JSON.stringify(deps), str(p.verify)?.trim() || null, maxAttempts, ts, ts) as TaskRow;
    logEvent(db, "task", me.id, null, taskObj(db, t));
    if (ready) dispatch(ctx, t);
    return taskObj(db, t);
  },

  claimTask(ctx, p) {
    const { db, me, opts } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    if (t.assignee_id !== me.id) throw new ApiError(403, `Forbidden: task #${t.id} is assigned to @${acc(db, t.assignee_id)?.username}`);
    if (!["todo", "doing"].includes(t.status)) throw new ApiError(409, `Conflict: task #${t.id} is ${t.status}`);
    // 原子領取：只有 todo 或自己正在做的才能領
    const res = db.query("UPDATE tasks SET status = 'doing', lease_until = ?, updated_at = ? WHERE id = ? AND assignee_id = ? AND status IN ('todo','doing')")
      .run(now() + opts.leaseSec, now(), t.id, me.id);
    if (res.changes !== 1) throw new ApiError(409, "Conflict: task was taken or changed");
    touchActivity(db, me.id, `領取 #${t.id}`);
    const fresh = getTask(db, t.id)!;
    logEvent(db, "task", me.id, null, taskObj(db, fresh));
    return taskObj(db, fresh);
  },

  progressTask(ctx, p) {
    const { db, me, opts } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    if (t.assignee_id !== me.id) throw new ApiError(403, "Forbidden: not your task");
    if (t.status !== "doing") throw new ApiError(409, `Conflict: task #${t.id} is ${t.status}; claim it first`);
    const note = str(p.note)?.slice(0, 500) ?? null;
    setTask(ctx, t, { lease_until: now() + opts.leaseSec, note }, "task_progress");
    touchActivity(db, me.id, note ?? undefined);
    return taskObj(db, t);
  },

  reportTask(ctx, p) {
    const { db, me } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    if (t.assignee_id !== me.id && me.is_bot) throw new ApiError(403, "Forbidden: not your task");
    if (!["doing", "todo"].includes(t.status)) throw new ApiError(409, `Conflict: task #${t.id} is ${t.status}`);
    const status = str(p.status);
    if (status !== "done" && status !== "failed") throw new ApiError(400, 'Bad Request: status must be "done" or "failed"');
    const result = (str(p.result) ?? "").slice(0, 20000);
    const fileIds = files(db, p.files);
    const g = getGoal(db, t.goal_id)!;
    const lead = acc(db, g.lead_id)!;
    touchActivity(db, me.id, `回報 #${t.id} ${status}`);
    // 工作階段編號與過程紀錄位置：只存在任務上給人查（UI 顯示），不放進給主管的回報訊息
    const sessionRef = str(p.session_ref)?.trim().slice(0, 200);
    const logRef = str(p.log_ref)?.trim().slice(0, 500);
    if (sessionRef) t.session_ref = sessionRef;
    if (logRef) t.log_ref = logRef;

    if (status === "done") {
      setTask(ctx, t, { status: "done", result, files: JSON.stringify(fileIds), lease_until: null });
      if (me.id !== lead.id) {
        postMessage(ctx, OFFICE, {
          text: `${at(lead)} ✅ 任務 #${t.id} 完成：${t.title}\n\n${result || "（沒有附說明）"}${fileIds.length ? `\n\n檔案：${fileIds.join("、")}（用 office download <file_id> 取得）` : ""}`,
          threadId: g.id, internal: true, data: { type: "report", task_id: t.id, goal_id: g.id, status: "done", files: fileIds },
        });
      }
      unblockDependents(ctx, g.id);
    } else {
      const attempts = t.attempts + 1;
      if (attempts < t.max_attempts) {
        setTask(ctx, t, { status: "todo", attempts, result, lease_until: null, note: "失敗，自動重試" });
        dispatch(ctx, t, "🔁 重試任務", { reason: "retry", prev_result: prevTail(result) });
      } else {
        setTask(ctx, t, { result, attempts });
        exhausted(ctx, t, g, me, attempts, result, { prev_result: prevTail(result) });
      }
    }
    return taskObj(db, getTask(db, t.id)!);
  },

  reviewTask(ctx, p) {
    const { db, me } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    const g = getGoal(db, t.goal_id)!;
    if (me.is_bot && me.id !== g.lead_id && me.id !== g.reviewer_id) throw new ApiError(403, "Forbidden: only the lead or reviewer can review");
    const verdict = str(p.verdict);
    if (verdict !== "approve" && verdict !== "reject") throw new ApiError(400, 'Bad Request: verdict must be "approve" or "reject"');
    const comment = (str(p.comment) ?? "").slice(0, 5000);
    if (verdict === "approve") {
      setTask(ctx, t, { note: `審查通過：${comment}`.slice(0, 500) }, "task_review");
      if (me.id !== g.lead_id) postMessage(ctx, OFFICE, { text: `${at(acc(db, g.lead_id))} 👀 #${t.id} 審查通過${comment ? "：" + comment : ""}`, threadId: g.id, internal: true, data: { type: "review", task_id: t.id, verdict } });
    } else {
      // 退回也算一次：超過次數就照失敗流程改派或通知主管，避免無限退回
      const note = comment || "請修正";
      const attempts = t.attempts + 1;
      const assignee = acc(db, t.assignee_id)!;
      const extra: DispatchExtra = { reason: "reject", review_note: note, prev_result: prevTail(t.result) };
      if (attempts < t.max_attempts) {
        setTask(ctx, t, { status: "todo", attempts, lease_until: null, note: `審查退回：${note}`.slice(0, 500) }, "task_review");
        dispatch(ctx, t, "↩️ 審查退回", extra);
      } else {
        setTask(ctx, t, { attempts, note: `審查退回：${note}`.slice(0, 500) }, "task_review");
        exhausted(ctx, t, g, assignee, attempts, `審查退回：${note}`, extra);
      }
    }
    return taskObj(db, getTask(db, t.id)!);
  },

  reassignTask(ctx, p) {
    const { db, me } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    const g = getGoal(db, t.goal_id)!;
    if (!isLeadOrHuman(me, g)) throw new ApiError(403, "Forbidden: only the lead or a human can reassign");
    const to = requireAgent(db, p.assignee, "assignee");
    const deps = JSON.parse(t.depends_on) as number[];
    const ready = deps.every((d) => getTask(db, d)?.status === "done");
    setTask(ctx, t, { assignee_id: to.id, status: ready ? "todo" : "blocked", attempts: 0, lease_until: null, note: `改派給 ${to.username}` });
    if (ready) dispatch(ctx, t, "🔀 改派任務", { reason: "reassign", prev_result: prevTail(t.result) });
    return taskObj(db, t);
  },

  retryTask(ctx, p) {
    const { db, me } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    const g = getGoal(db, t.goal_id)!;
    if (!isLeadOrHuman(me, g)) throw new ApiError(403, "Forbidden: only the lead or a human can retry");
    setTask(ctx, t, { status: "todo", attempts: 0, lease_until: null, note: "重新執行" });
    dispatch(ctx, t, "🔁 重新執行任務", { reason: "rerun", prev_result: prevTail(t.result) });
    return taskObj(db, t);
  },

  cancelTask(ctx, p) {
    const { db, me } = ctx;
    const t = requireTask(db, int(p.task_id, "task_id", true));
    const g = getGoal(db, t.goal_id)!;
    if (!isLeadOrHuman(me, g)) throw new ApiError(403, "Forbidden: only the lead or a human can cancel");
    const wasActive = ["doing", "todo"].includes(t.status);
    setTask(ctx, t, { status: "cancelled", lease_until: null, note: str(p.reason) ?? "取消" });
    const assignee = acc(db, t.assignee_id)!;
    if (wasActive && assignee.id !== me.id) {
      postMessage(ctx, OFFICE, { text: `${at(assignee)} ⛔ 任務 #${t.id} 已取消，請停止這項工作。${p.reason ? "\n原因：" + p.reason : ""}`, threadId: g.id, internal: true, data: { type: "cancel", task_id: t.id } });
    }
    return taskObj(db, t);
  },

  completeGoal(ctx, p) {
    const { db, me } = ctx;
    const g = requireGoal(db, int(p.goal_id, "goal_id", true));
    if (!isLeadOrHuman(me, g)) throw new ApiError(403, "Forbidden: only the goal lead can complete it");
    const status = str(p.status) ?? "done";
    if (!["done", "failed", "cancelled"].includes(status)) throw new ApiError(400, "Bad Request: status must be done, failed or cancelled");
    const summary = (str(p.summary) ?? "").slice(0, 20000);
    const fileIds = files(db, p.files);
    db.query("UPDATE goals SET status = ?, summary = ?, files = ?, updated_at = ? WHERE id = ?").run(status, summary, JSON.stringify(fileIds), now(), g.id);
    const open = db.query("SELECT * FROM tasks WHERE goal_id = ? AND status IN ('todo','blocked','doing')").all(g.id) as TaskRow[];
    for (const t of open) setTask(ctx, t, { status: "cancelled", lease_until: null, note: "目標結束" });
    const icon = status === "done" ? "🏁" : status === "failed" ? "💥" : "⛔";
    postMessage(ctx, OFFICE, { text: `${icon} 目標 #${g.id} ${status === "done" ? "完成" : status === "failed" ? "失敗" : "取消"}：${g.title}\n\n${summary}${fileIds.length ? `\n\n檔案：${fileIds.join("、")}` : ""}`,
      threadId: g.id, internal: true, data: { type: "goal_done", goal_id: g.id, status, files: fileIds } });
    const fresh = getGoal(db, g.id)!;
    logEvent(db, "goal", me.id, null, goalObj(db, fresh));
    return goalObj(db, fresh);
  },

  getGoals(ctx, p) {
    const status = str(p.status);
    const rows = (status
      ? ctx.db.query("SELECT * FROM goals WHERE status = ? ORDER BY id DESC LIMIT 50").all(status)
      : ctx.db.query("SELECT * FROM goals ORDER BY id DESC LIMIT 50").all()) as GoalRow[];
    return rows.map((g) => goalObj(ctx.db, g));
  },

  getTasks(ctx, p) {
    const { db, me } = ctx;
    const where: string[] = []; const args: (string | number)[] = [];
    const goalId = int(p.goal_id, "goal_id");
    if (goalId !== undefined) { where.push("goal_id = ?"); args.push(goalId); }
    if (p.mine === true || p.mine === "true") { where.push("assignee_id = ?"); args.push(me.id); }
    if (p.assignee) { const a = requireAgent(db, p.assignee, "assignee"); where.push("assignee_id = ?"); args.push(a.id); }
    const status = str(p.status);
    if (status) { where.push("status = ?"); args.push(status); }
    const rows = db.query(`SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`).all(...args) as TaskRow[];
    return rows.map((t) => taskObj(db, t));
  },

  /** 給「櫃台」用的等待：最多等 timeout 秒，回傳期間收到、跟我有關的新訊息；
   *  帶 goal_id 時，目標一結束就連同總結一起回傳。讀取位置存在 Hub（wait_cursor），呼叫端不用管 offset。
   *  注意：同一個帳號不要同時用 getUpdates 與 office_wait，兩者共用同一條佇列。 */
  async waitEvents(ctx, p) {
    const { db, me, updates, opts } = ctx;
    const timeout = Math.min(Math.max(int(p.timeout, "timeout") ?? 60, 0), Math.min(110, opts.maxPoll * 3));
    const goalId = int(p.goal_id, "goal_id");
    const goalState = () => {
      if (goalId === undefined) return null;
      const g = getGoal(db, goalId);
      if (!g) throw new ApiError(400, "Bad Request: goal not found");
      return goalObj(db, g);
    };
    const simplify = (u: Record<string, any>) => {
      const m = u.message ?? u.edited_message;
      if (!m) return null;
      return { from: m.from?.username, text: m.text ?? m.caption ?? "", thread_id: m.message_thread_id ?? null, data: m.data ?? null,
        file_id: m.document?.file_id ?? m.photo?.[0]?.file_id ?? null, date: m.date, edited: !!u.edited_message };
    };
    const g0 = goalState();
    if (g0 && g0.status !== "doing") return { goal: g0, messages: [], done: true };
    // 沒有頻道的主管（Claude Code 桌面版）靠 office_wait 收回報：記成活動，UI 才會顯示它在開會／等回報，而不是閒晃
    touchActivity(db, me.id, goalId !== undefined ? `等回報：目標 #${goalId}` : "等訊息");
    const cur = (db.query("SELECT last_update_id FROM wait_cursor WHERE account_id = ?").get(me.id) as { last_update_id: number } | null)?.last_update_id ?? 0;
    const deadline = Date.now() + timeout * 1000;
    let got: Record<string, any>[] = [];
    let offset = cur + 1;
    // 分段等待：每段最多 maxPoll 秒，期間目標結束也能及時回傳
    while (true) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      got = await updates.poll(me.id, { offset, limit: 50, timeout: Math.min(left, opts.maxPoll), signal: ctx.signal }) as Record<string, any>[];
      const g = goalState();
      if (got.length || (g && g.status !== "doing") || left === 0 || ctx.signal?.aborted) break;
    }
    if (got.length) {
      const last = got[got.length - 1].update_id as number;
      db.query("INSERT INTO wait_cursor (account_id, last_update_id) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET last_update_id = excluded.last_update_id").run(me.id, last);
      db.query("DELETE FROM updates WHERE account_id = ? AND update_id <= ?").run(me.id, last);
    }
    const goal = goalState();
    // 只回傳跟我有關的：私訊、@我、我開的目標底下的訊息
    const myGoals = new Set((db.query("SELECT id FROM goals WHERE created_by = ? OR lead_id = ?").all(me.id, me.id) as { id: number }[]).map((r) => r.id));
    // 編輯過的訊息（執行者每 30 秒更新的「執行中（N 分鐘）」進度）不回傳：它們帶著舊日期一直重送，會淹沒真正的回報。
    // 其他目標的新訊息照常回傳（同一個主管可能同時帶好幾個目標；這裡丟掉的話佇列已前進，之後就收不到了）。
    const mine = got.filter((u) => {
      const m = u.message;
      if (!m) return false;
      if (m.chat?.type === "private") return true;
      if ((m.text ?? m.caption ?? "").includes(`@${me.username}`)) return true;
      const gid = m.data?.goal_id ?? m.message_thread_id;
      return gid !== undefined && myGoals.has(gid);
    });
    return { goal, messages: mine.map(simplify).filter(Boolean), done: goal ? goal.status !== "doing" : false };
  },

  getAgents(ctx) {
    return Object.values(agentStates(ctx));
  },

  /** 成員說明：真人（網頁）或 Claude（主管）可寫；給主管派工參考，例如「跑在 B 機 WSL（Linux），驗收用 sh；適合查檔、整理表格」 */
  setAgentNotes(ctx, p) {
    const { db, me } = ctx;
    if (me.is_bot && me.kind !== "claude") throw new ApiError(403, "Forbidden: only humans and Claude agents can edit agent notes");
    const target = getAccountBy(db, str(p.username)?.replace(/^@/, "") ?? "");
    if (!target || !target.is_bot || target.disabled) throw new ApiError(400, "Bad Request: username must be an active agent");
    const notes = (str(p.notes) ?? "").replace(/\r\n/g, "\n").trim();
    if ([...notes].length > 2000) throw new ApiError(400, "Bad Request: notes must be at most 2000 characters");
    const t = Date.now();
    db.query("UPDATE accounts SET notes = ?, notes_by = ?, notes_at = ? WHERE id = ?").run(notes || null, notes ? me.username : null, notes ? t : null, target.id);
    logEvent(db, "account", me.id, null, { id: target.id, username: target.username, first_name: target.first_name, kind: target.kind, machine: target.machine, is_bot: true, notes: notes || null, notes_by: notes ? me.username : null, notes_at: notes ? t : null });
    return { username: target.username, notes: notes || null, notes_by: notes ? me.username : null, notes_at: notes ? t : null };
  },

  /** office-node 定期呼叫。
   *  一般：更新自己的在線時間。
   *  session_only=true（Windows 端用 claude_token）：只記錄 Claude session 是否在跑，不更新在線時間。 */
  heartbeat(ctx, p) {
    const t = Date.now();
    const sessionOnly = p.session_only === true || p.session_only === "true";
    const sessionUp = p.claude_session === undefined ? null : (p.claude_session === true || p.claude_session === "true") ? 1 : 0;
    if (!sessionOnly) {
      ctx.db.query(`INSERT INTO presence (account_id, last_seen, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, updated_at = excluded.updated_at`).run(ctx.me.id, t, t);
    }
    if (sessionUp !== null) {
      const claude = ctx.me.kind === "claude" ? { id: ctx.me.id }
        : ctx.db.query("SELECT id FROM accounts WHERE kind = 'claude' AND machine = ? AND disabled = 0").get(ctx.me.machine) as { id: number } | null;
      if (claude) {
        ctx.db.query(`INSERT INTO presence (account_id, session_up, updated_at) VALUES (?, ?, ?)
                      ON CONFLICT(account_id) DO UPDATE SET session_up = excluded.session_up, updated_at = excluded.updated_at`).run(claude.id, sessionUp, t);
      }
    }
    return true;
  },
};

// ---------- Claude Code hooks ----------
export function handleHook(ctx: Ctx, body: Record<string, unknown>) {
  const { db, me } = ctx;
  const ev = String(body.hook_event_name ?? "");
  const t = Date.now();
  let state: string | null = null;
  let detail: string | null = null;
  let activity = false;
  const input = (body.tool_input ?? {}) as Record<string, unknown>;
  const toolDetail = () => {
    const name = String(body.tool_name ?? "");
    const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? "";
    return `${name.replace(/^mcp__/, "")}${arg ? " " + String(arg).replace(/\s+/g, " ").slice(0, 80) : ""}`;
  };
  switch (ev) {
    case "SessionStart": state = "idle"; detail = "session 啟動"; break;
    case "UserPromptSubmit": state = "working"; detail = "收到輸入"; activity = true; break;
    case "PreToolUse": state = "working"; detail = toolDetail(); activity = true; break;
    case "PostToolUse": case "PostToolUseFailure": state = "working"; activity = true; break;
    case "SubagentStart": case "SubagentStop": state = "working"; activity = true; break;
    case "Notification": {
      const kind = String(body.notification_type ?? "");
      const msg = String(body.message ?? "");
      if (kind === "permission_prompt" || /permission/i.test(msg)) { state = "waiting"; detail = `等你批准：${msg.slice(0, 80)}`; }
      else if (kind === "idle_prompt") { state = "idle"; }
      break;
    }
    case "Stop": state = "idle"; detail = String(body.last_assistant_message ?? "").replace(/\s+/g, " ").slice(0, 80) || null; break;
    case "StopFailure": state = "error"; detail = String(body.error ?? body.message ?? "API 錯誤").slice(0, 120); break;
    case "SessionEnd": state = "idle"; detail = "session 結束"; break;
    default: break;
  }
  db.query(`INSERT INTO presence (account_id, last_seen, last_activity, hook_state, detail, session_up, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen,
              last_activity = COALESCE(excluded.last_activity, presence.last_activity),
              hook_state = COALESCE(excluded.hook_state, presence.hook_state),
              detail = COALESCE(excluded.detail, presence.detail),
              session_up = COALESCE(excluded.session_up, presence.session_up),
              updated_at = excluded.updated_at`)
    .run(me.id, t, activity ? t : null, state, detail, ev === "SessionEnd" ? 0 : ev === "SessionStart" ? 1 : null, t);
  if (ev !== "PostToolUse") logEvent(db, "hook", me.id, null, { event: ev, state, detail, session_id: body.session_id ?? null });
  return true;
}

// ---------- agent 狀態 ----------
export type AgentState = "working" | "review" | "idle" | "queued" | "stalled" | "error" | "offline" | "waiting";

export function agentStates(ctx: Ctx) {
  const { db, opts } = ctx;
  const t = Date.now();
  const agents = db.query("SELECT * FROM accounts WHERE is_bot = 1 AND disabled = 0 ORDER BY id").all() as Account[];
  const out: Record<string, {
    username: string; name: string; kind: string; machine: string | null; state: AgentState; status: AgentState; detail: string | null;
    task: ReturnType<typeof taskObj> | null; queued: number; last_seen: number | null; last_activity: number | null; session_up: boolean | null; roles: string[];
    notes: string | null; notes_by: string | null; notes_at: number | null;
  }> = {};
  for (const a of agents) {
    const pr = db.query("SELECT * FROM presence WHERE account_id = ?").get(a.id) as
      { last_seen: number | null; last_activity: number | null; hook_state: string | null; detail: string | null; session_up: number | null } | null;
    const doing = db.query("SELECT * FROM tasks WHERE assignee_id = ? AND status = 'doing' ORDER BY updated_at DESC LIMIT 1").get(a.id) as TaskRow | null;
    const queued = (db.query("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status IN ('todo','blocked')").get(a.id) as { n: number }).n;
    const leads = db.query("SELECT id FROM goals WHERE lead_id = ? AND status = 'doing'").all(a.id) as { id: number }[];
    const reviews = db.query("SELECT id FROM goals WHERE reviewer_id = ? AND status = 'doing'").all(a.id) as { id: number }[];
    const roles = [...leads.map((g) => `lead:${g.id}`), ...reviews.map((g) => `reviewer:${g.id}`)];
    const lastSeen = pr?.last_seen ?? null;
    const lastAct = pr?.last_activity ?? null;
    let state: AgentState;
    if (!lastSeen || t - lastSeen > opts.offlineSec * 1000) state = "offline";
    else if (a.kind === "claude" && pr?.session_up === 0) state = "offline"; // office-node 回報 session 沒在跑
    else if (pr?.hook_state === "error") state = "error";
    else if (pr?.hook_state === "waiting") state = "waiting";
    else if (doing) state = !lastAct || t - lastAct > opts.stallSec * 1000 ? "stalled" : "working";
    else if (pr?.hook_state === "working" && lastAct && t - lastAct < opts.stallSec * 1000) state = roles.length ? "review" : "working";
    // 帶著進行中的目標、最近有呼叫 office 工具（例如桌面版主管在 office_wait 等回報）→ 開會／審查。
    // 桌面版沒有 hooks，但之前用終端機模式留下的 hook_state（通常是 idle）會一直留著，所以不能只認 hook_state 為空。
    else if (a.kind === "claude" && roles.length && lastAct && t - lastAct < opts.stallSec * 1000) state = "review";
    else if (queued) state = "queued";
    else state = "idle";
    out[a.username] = {
      username: a.username, name: a.first_name, kind: a.kind, machine: a.machine, state, status: state, detail: pr?.detail ?? null,
      task: doing ? taskObj(db, doing) : null, queued, last_seen: lastSeen, last_activity: lastAct,
      session_up: pr?.session_up === null || pr?.session_up === undefined ? null : !!pr.session_up, roles,
      notes: a.notes ?? null, notes_by: a.notes_by ?? null, notes_at: a.notes_at ?? null,
    };
  }
  return out;
}

// ---------- 監看排程 ----------
export function startWatchdog(ctx: Omit<Ctx, "me">, intervalMs = 5000) {
  const prev = new Map<string, string>();
  const system = () => (ctx.db.query("SELECT * FROM accounts WHERE is_bot = 0 ORDER BY id LIMIT 1").get() as Account | null);
  const tick = () => {
    const db = ctx.db;
    const me = system();
    if (!me) return;
    const c: Ctx = { ...ctx, me };
    // 1) 租約到期：退回待辦，通知主管
    const expired = db.query("SELECT * FROM tasks WHERE status = 'doing' AND lease_until IS NOT NULL AND lease_until < ?").all(now()) as TaskRow[];
    for (const t of expired) {
      setTask(c, t, { status: "todo", lease_until: null, note: "租約到期，退回待辦" }, "task_expired");
      const g = getGoal(db, t.goal_id)!;
      const lead = acc(db, g.lead_id)!;
      const assignee = acc(db, t.assignee_id)!;
      try {
        postMessage({ ...c, me: lead.id === assignee.id ? me : lead }, OFFICE, {
          text: `${lead.id === assignee.id ? at(lead) : at(assignee)} ⏰ 任務 #${t.id} 租約到期（太久沒回報進度），已退回待辦。${lead.id === assignee.id ? "" : "請重新 office_claim 再繼續，或由主管改派。"}`,
          threadId: g.id, internal: true, data: { type: "expired", task_id: t.id },
        });
      } catch { /* 防循環擋下時略過 */ }
    }
    // 2) 狀態變化事件（UI 用）
    const states = agentStates(c);
    for (const s of Object.values(states)) {
      const key = `${s.state}|${s.detail ?? ""}|${s.task?.task_id ?? ""}`;
      if (prev.get(s.username) !== key) {
        const changedState = prev.get(s.username)?.split("|")[0] !== s.state;
        prev.set(s.username, key);
        logEvent(db, "agent", null, null, { ...s, changed_state: changedState });
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
