// 每個帳號一條更新佇列（存在 SQLite），getUpdates 用長輪詢等待新更新。
import type { Database } from "bun:sqlite";

interface Waiter {
  wake: (reason: "update" | "takeover" | "timeout" | "abort") => void;
}

export class UpdateQueue {
  private waiters = new Map<number, Waiter>();
  constructor(private db: Database) {}

  push(accountId: number, update: Record<string, unknown>) {
    this.db.query("INSERT INTO updates (account_id, payload, created_at) VALUES (?, ?, ?)")
      .run(accountId, JSON.stringify(update), Date.now());
    this.waiters.get(accountId)?.wake("update");
  }

  drop(accountId: number) {
    this.db.query("DELETE FROM updates WHERE account_id = ?").run(accountId);
  }

  pendingCount(accountId: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM updates WHERE account_id = ?").get(accountId) as { n: number }).n;
  }

  private fetch(accountId: number, offset: number | undefined, limit: number) {
    let rows: { update_id: number; payload: string }[];
    if (offset !== undefined && offset < 0) {
      // 與 Telegram 相同：負的 offset 代表「最後 N 筆」
      rows = (this.db.query("SELECT update_id, payload FROM updates WHERE account_id = ? ORDER BY update_id DESC LIMIT ?")
        .all(accountId, Math.min(-offset, limit)) as { update_id: number; payload: string }[]).reverse();
    } else {
      rows = this.db.query("SELECT update_id, payload FROM updates WHERE account_id = ? AND update_id >= ? ORDER BY update_id LIMIT ?")
        .all(accountId, offset ?? 0, limit) as { update_id: number; payload: string }[];
    }
    return rows.map((r) => ({ update_id: r.update_id, ...JSON.parse(r.payload) }));
  }

  async poll(accountId: number, o: { offset?: number; limit: number; timeout: number; signal?: AbortSignal }) {
    // 帶 offset 代表 offset 之前的更新都已處理，可以刪掉
    if (o.offset !== undefined && o.offset > 0) {
      this.db.query("DELETE FROM updates WHERE account_id = ? AND update_id < ?").run(accountId, o.offset);
    }
    let result = this.fetch(accountId, o.offset, o.limit);
    if (result.length || o.timeout === 0) return result;

    // 同一帳號只保留最新的長輪詢（客戶端重啟時舊連線會被接手，不回 409）
    this.waiters.get(accountId)?.wake("takeover");
    const reason = await new Promise<string>((resolve) => {
      let done = false;
      const finish = (r: "update" | "takeover" | "timeout" | "abort") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (this.waiters.get(accountId) === waiter) this.waiters.delete(accountId);
        resolve(r);
      };
      const waiter: Waiter = { wake: finish };
      const timer = setTimeout(() => finish("timeout"), o.timeout * 1000);
      const onAbort = () => finish("abort");
      o.signal?.addEventListener("abort", onAbort);
      this.waiters.set(accountId, waiter);
    });
    if (reason !== "update") return [];
    result = this.fetch(accountId, o.offset, o.limit);
    return result;
  }
}
