import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { businessFixtures } from "./fixtures.js";
import type {
  ActionRecord,
  Actor,
  Callback,
  Order,
  Payment,
  Task,
  Ticket,
} from "./types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS business (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, proposal_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (channel TEXT NOT NULL, event_id TEXT NOT NULL, actor_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(channel,event_id));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare("SELECT value FROM meta WHERE key='seeded'").get())
      this.seed();
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private seed() {
    this.transaction(() => {
      const data = businessFixtures();
      data.orders.forEach((item) => this.put("order", item.id, item));
      data.payments.forEach((item) => this.put("payment", item.orderId, item));
      data.callbacks.forEach((item) =>
        this.put("callback", item.orderId, item),
      );
      data.tickets.forEach((item) => this.put("ticket", item.id, item));
      this.db
        .prepare("INSERT OR IGNORE INTO meta VALUES ('seeded','synthetic-v1')")
        .run();
    });
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO business VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(value));
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM business WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.body)) as T) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM business WHERE kind=? ORDER BY id")
      .all(kind)
      .map((row) => JSON.parse(String(row.body)) as T);
  }
  order(actor: Actor, id: string): Order {
    const order = this.get<Order>("order", id);
    if (!order || order.tenantId !== actor.tenantId)
      throw new AppError(
        "ORDER_NOT_ACCESSIBLE",
        "订单不存在或不在当前商家权限范围内。",
        404,
      );
    return order;
  }
  payment(actor: Actor, id: string): Payment {
    this.order(actor, id);
    const payment = this.get<Payment>("payment", id);
    if (!payment || payment.tenantId !== actor.tenantId)
      throw new AppError("PAYMENT_UNAVAILABLE", "支付渠道记录暂不可用。", 503);
    return payment;
  }
  callback(actor: Actor, id: string) {
    this.order(actor, id);
    return this.get<Callback>("callback", id);
  }
  tickets(actor: Actor, id: string) {
    this.order(actor, id);
    return this.all<Ticket>("ticket").filter(
      (t) => t.tenantId === actor.tenantId && t.orderId === id,
    );
  }
  save(task: Task) {
    const previous = task.revision;
    const next = {
      ...task,
      revision: previous + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = this.db
      .prepare("UPDATE tasks SET revision=?,body=? WHERE id=? AND revision=?")
      .run(next.revision, JSON.stringify(next), task.id, previous);
    if (result.changes !== 1)
      throw new AppError(
        "TASK_CONFLICT",
        "任务已被其他操作更新，请刷新后重试。",
        409,
      );
    Object.assign(task, next);
  }
  insert(task: Task) {
    this.db
      .prepare("INSERT INTO tasks VALUES (?,?,?,?)")
      .run(task.id, task.tenantId, task.revision, JSON.stringify(task));
  }
  task(id: string, actor?: Actor): Task {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    if (!row) throw new AppError("TASK_NOT_FOUND", "任务不存在。", 404);
    const task = JSON.parse(String(row.body)) as Task;
    if (actor && actor.tenantId !== task.tenantId)
      throw new AppError("TASK_NOT_FOUND", "任务不存在。", 404);
    return task;
  }
  tasks(actor?: Actor): Task[] {
    return this.db
      .prepare("SELECT body FROM tasks ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Task)
      .filter((t) => !actor || t.tenantId === actor.tenantId);
  }
  action(proposalId: string): ActionRecord | undefined {
    const row = this.db
      .prepare("SELECT body FROM actions WHERE proposal_id=?")
      .get(proposalId);
    return row ? (JSON.parse(String(row.body)) as ActionRecord) : undefined;
  }
  addAction(record: ActionRecord) {
    this.db
      .prepare("INSERT INTO actions VALUES (?,?,?,?,?)")
      .run(
        record.id,
        record.idempotencyKey,
        record.taskId,
        record.proposalId,
        JSON.stringify(record),
      );
  }
  receipt(
    channel: string,
    eventId: string,
    actorId: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        "SELECT actor_id,task_id FROM receipts WHERE channel=? AND event_id=?",
      )
      .get(channel, eventId);
    if (!row) return;
    if (row.actor_id !== actorId)
      throw new AppError(
        "RECEIPT_OWNER_MISMATCH",
        "重复请求的身份不一致。",
        409,
      );
    return String(row.task_id);
  }
  addReceipt(
    channel: string,
    eventId: string,
    actorId: string,
    taskId: string,
  ) {
    this.db
      .prepare("INSERT INTO receipts VALUES (?,?,?,?)")
      .run(channel, eventId, actorId, taskId);
  }
  close() {
    this.db.close();
  }
}

export function event(
  task: Task,
  kind: Task["events"][number]["kind"],
  title: string,
  detail = "",
) {
  task.events.push({
    id: randomUUID(),
    kind,
    title,
    detail,
    at: new Date().toISOString(),
  });
}
