import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";

// Reserve before external I/O; failed and interrupted requests also consume the ceiling.
export class RequestBudget {
  private db: DatabaseSync;
  constructor(path: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      throw new Error("Invalid request limit");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS request_budget (id INTEGER PRIMARY KEY CHECK(id=1), ceiling INTEGER NOT NULL, used INTEGER NOT NULL)",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO request_budget VALUES(1,?,0)")
      .run(limit);
    if (this.snapshot().limit !== limit) {
      this.db.close();
      throw new AppError(
        "BUDGET_SESSION_CONFLICT",
        "该预算文件已有不同上限，不能隐式重置或增加额度。",
      );
    }
  }
  reserve() {
    if (
      !this.db
        .prepare(
          "UPDATE request_budget SET used=used+1 WHERE id=1 AND used<ceiling RETURNING used",
        )
        .get()
    )
      throw new AppError(
        "MODEL_REQUEST_BUDGET",
        "本次验证的总请求预算已用尽，未继续发送模型请求。",
        429,
      );
  }
  snapshot() {
    const row = this.db
      .prepare("SELECT ceiling,used FROM request_budget WHERE id=1")
      .get()!;
    const limit = Number(row.ceiling),
      used = Number(row.used);
    return { limit, used, remaining: limit - used };
  }
  close() {
    this.db.close();
  }
}
