import { randomUUID } from "node:crypto";
import { Agent } from "./agent.js";
import { AppError } from "./errors.js";
import { actors } from "./fixtures.js";
import {
  policyVersion,
  proposalDigest,
  reconciliationPolicy,
} from "./policy.js";
import { event, Store } from "./store.js";
import type {
  ActionRecord,
  Actor,
  Mode,
  Order,
  Proposal,
  Provider,
  Task,
  Ticket,
} from "./types.js";

export function actorById(id: string): Actor {
  const actor = actors.find((item) => item.id === id);
  if (!actor) throw new AppError("ACTOR_NOT_ALLOWED", "演示身份未授权。", 403);
  return actor;
}

export class CaseService {
  readonly agent: Agent;
  private running = false;
  private listeners = new Set<(task: Task) => void>();
  constructor(
    readonly store: Store,
    readonly providers: Partial<Record<Mode, Provider>>,
    limits = { modelRequests: 12, toolCalls: 24 },
  ) {
    this.agent = new Agent(store, providers, limits);
  }

  subscribe(listener: (task: Task) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(task: Task) {
    this.listeners.forEach((listener) => listener(task));
  }

  create(
    actor: Actor,
    input: {
      complaint: string;
      mode: Mode;
      requestId: string;
      channel?: Task["channel"];
      fault?: Task["initialQueryFault"];
    },
  ) {
    if (!this.providers[input.mode])
      throw new AppError(
        "MODEL_NOT_CONFIGURED",
        "未配置真实模型，请明确选择规则模拟模式。",
        503,
      );
    return this.store.transaction(() => {
      const channel = input.channel || "web";
      // Receipt scopes separate merchants/users even when clients accidentally reuse an ID.
      const receiptChannel = `${channel}:${actor.tenantId}:${actor.id}`;
      const previous = this.store.receipt(
        receiptChannel,
        input.requestId,
        actor.id,
      );
      if (previous) {
        const task = this.store.task(previous, actor);
        if (
          task.complaint !== input.complaint ||
          task.mode !== input.mode ||
          task.initialQueryFault !== input.fault
        )
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "同一请求标识不能用于不同任务内容。",
            409,
          );
        return task;
      }
      if (
        this.store
          .tasks(actor)
          .filter((t) => ["queued", "investigating"].includes(t.status))
          .length >= 30
      )
        throw new AppError("QUEUE_FULL", "演示调查队列已满，请稍后重试。", 429);
      const now = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        tenantId: actor.tenantId,
        ownerId: actor.id,
        complaint: input.complaint,
        channel,
        mode: input.mode,
        initialQueryFault: input.fault,
        status: "queued",
        messages: [{ role: "user", content: input.complaint }],
        evidence: [],
        events: [],
        usage: {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          toolCalls: 0,
        },
        epoch: 1,
        toolErrors: 0,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      event(task, "state", "已接收任务", "合成业务数据；无生产订单接入");
      if (input.fault) {
        this.store.put("fault", `${task.id}:get_payment`, {
          remaining: input.fault === "query_timeout" ? 1 : 5,
        });
        event(task, "state", "注入演示故障", input.fault);
      }
      this.store.insert(task);
      this.store.addReceipt(receiptChannel, input.requestId, actor.id, task.id);
      return task;
    });
  }

  reply(actor: Actor, id: string, content: string) {
    const task = this.store.task(id, actor);
    if (task.status !== "needs_input")
      throw new AppError(
        "INVALID_TASK_STATE",
        "任务当前不在等待补充信息。",
        409,
      );
    task.messages.push({ role: "user", content });
    task.question = undefined;
    task.status = "queued";
    event(task, "state", "收到补充信息", content);
    this.store.save(task);
    this.changed(task);
    return task;
  }

  restart(actor: Actor, id: string) {
    const task = this.store.task(id, actor);
    if (!["conflict", "handoff"].includes(task.status))
      throw new AppError(
        "INVALID_TASK_STATE",
        "只有状态冲突或人工接管任务可以重新调查。",
        409,
      );
    task.epoch++;
    task.toolErrors = 0;
    task.status = "queued";
    task.proposal = undefined;
    task.summary = undefined;
    task.assessment = undefined;
    task.modelAnalysis = undefined;
    task.messages = [
      {
        role: "user",
        content:
          task.complaint +
          (task.orderId ? `\n已由用户确认的目标订单：${task.orderId}` : ""),
      },
    ];
    event(
      task,
      "state",
      "重新调查",
      "旧证据保留用于审计，但不再参与本轮处置；总调用预算不重置",
    );
    this.store.save(task);
    this.changed(task);
    return task;
  }

  cancel(actor: Actor, id: string) {
    const task = this.store.task(id, actor);
    if (
      !["queued", "investigating", "needs_input", "awaiting_approval"].includes(
        task.status,
      )
    )
      throw new AppError(
        "INVALID_TASK_STATE",
        "当前任务不能取消，请核对执行结果。",
        409,
      );
    task.status = "cancelled";
    task.summary = "任务已取消，未执行提案中的业务动作。";
    event(task, "state", "取消任务", task.summary);
    this.store.save(task);
    this.changed(task);
    return task;
  }

  approve(
    actor: Actor,
    id: string,
    proposalId: string,
    simulateLostResponse = false,
  ) {
    if (actor.role !== "approver")
      throw new AppError(
        "APPROVAL_FORBIDDEN",
        "当前身份只能调查，需运营身份确认处置。",
        403,
      );
    const task = this.store.transaction(() => {
      const current = this.store.task(id, actor);
      const proposal = current.proposal;
      if (!proposal || proposal.id !== proposalId)
        throw new AppError(
          "APPROVAL_MISMATCH",
          "审批与当前处置提案不匹配。",
          409,
        );
      const previous = this.store.action(proposalId);
      if (previous) {
        if (previous.taskId !== current.id)
          throw new AppError("APPROVAL_MISMATCH", "审批与任务不匹配。", 409);
        return current;
      }
      if (current.status !== "awaiting_approval")
        throw new AppError("INVALID_TASK_STATE", "提案当前不能执行。", 409);
      const { digest, ...signed } = proposal;
      const order = this.store.order(actor, proposal.orderId);
      const payment = this.store.payment(actor, proposal.orderId);
      const invalid =
        digest !== proposalDigest(signed) ||
        proposal.policyVersion !== policyVersion ||
        Date.parse(proposal.expiresAt) <= Date.now() ||
        order.version !== proposal.orderVersion ||
        payment.version !== proposal.paymentVersion;
      if (invalid) {
        current.status = "conflict";
        current.summary =
          "提案已过期或业务状态已变化，未执行；请重新调查并确认新的提案。";
        event(current, "approval", "原提案失效", current.summary);
        this.store.save(current);
        return current;
      }
      if (
        proposal.action === "reconcile_payment" &&
        !reconciliationPolicy(order, payment).eligible
      )
        throw new AppError(
          "POLICY_DENIED",
          "执行前重新核验未通过，不允许对账补偿。",
          409,
        );
      event(
        current,
        "approval",
        `${actor.name}确认处置`,
        `提案 ${proposal.id} · 订单 v${proposal.orderVersion} · ${proposal.policyVersion}`,
      );
      current.status = "executing";
      event(current, "execution", "执行业务动作", proposal.action);
      let result: NonNullable<Task["result"]>;
      if (proposal.action === "reconcile_payment") {
        this.store.put("order", order.id, {
          ...order,
          status: "paid",
          version: order.version + 1,
        });
        this.store.put("callback", order.id, {
          orderId: order.id,
          status: "processed",
          note: "通过模拟渠道核验后执行演示对账补偿",
        });
        const observed = this.store.order(actor, order.id);
        if (
          observed.status !== "paid" ||
          observed.version !== order.version + 1
        )
          throw new AppError(
            "WRITE_VERIFICATION_FAILED",
            "对账写入未通过回查，事务已回滚。",
            500,
          );
        result = { orderStatus: observed.status, verified: true };
      } else {
        const existing = this.store.tickets(actor, order.id)[0];
        const ticket: Ticket = existing || {
          id: randomUUID(),
          orderId: order.id,
          tenantId: actor.tenantId,
          category: "payment_exception",
          reason: proposal.reason,
          status: "open",
          taskId: id,
        };
        if (!existing) this.store.put("ticket", ticket.id, ticket);
        const observed = this.store
          .tickets(actor, order.id)
          .find((t) => t.id === ticket.id);
        const currentOrder = this.store.order(actor, order.id);
        if (
          !observed ||
          currentOrder.status !== order.status ||
          currentOrder.version !== order.version
        )
          throw new AppError(
            "WRITE_VERIFICATION_FAILED",
            "工单写入未通过回查，事务已回滚。",
            500,
          );
        result = {
          ticketId: observed.id,
          orderStatus: currentOrder.status,
          duplicate: Boolean(existing),
          verified: true,
        };
      }
      const record: ActionRecord = {
        id: randomUUID(),
        taskId: id,
        proposalId,
        actorId: actor.id,
        idempotencyKey: `casepilot:${id}:${proposalId}`,
        status: "completed",
        result,
        createdAt: new Date().toISOString(),
      };
      this.store.addAction(record);
      current.status = simulateLostResponse ? "result_unknown" : "completed";
      current.result = simulateLostResponse
        ? { actionId: record.id, verified: false }
        : { ...result, actionId: record.id };
      current.summary = simulateLostResponse
        ? "演示响应丢失：业务事务可能已经完成，不能重新执行；请按原提案核对执行记录。"
        : proposal.action === "reconcile_payment"
          ? "对账补偿完成并回查，演示订单已支付。"
          : result.duplicate
            ? "发现已有工单，复用原处理记录，未创建重复工单。"
            : "异常工单已创建并回查，订单状态保持不变。";
      event(
        current,
        "execution",
        simulateLostResponse ? "响应丢失 · 待核对" : "结果已核验",
        current.summary,
      );
      this.store.save(current);
      return current;
    });
    this.changed(task);
    return task;
  }

  reject(actor: Actor, id: string, proposalId: string) {
    if (actor.role !== "approver")
      throw new AppError("APPROVAL_FORBIDDEN", "需运营身份拒绝提案。", 403);
    const task = this.store.task(id, actor);
    if (task.status !== "awaiting_approval" || task.proposal?.id !== proposalId)
      throw new AppError("APPROVAL_MISMATCH", "提案已失效或不匹配。", 409);
    task.status = "cancelled";
    task.summary = "运营已拒绝处置，未执行业务写入。";
    event(task, "approval", `${actor.name}拒绝处置`, task.summary);
    this.store.save(task);
    this.changed(task);
    return task;
  }

  verify(actor: Actor, id: string) {
    const task = this.store.task(id, actor);
    if (task.status !== "result_unknown" || !task.proposal)
      throw new AppError("INVALID_TASK_STATE", "任务无需核对未知结果。", 409);
    const record = this.store.action(task.proposal.id);
    if (!record) {
      task.status = "handoff";
      task.summary = "未找到可核实的原操作结果，转人工，禁止盲目重放。";
    } else {
      const order = this.store.order(actor, task.proposal.orderId);
      const ticket = record.result.ticketId
        ? this.store.get<Ticket>("ticket", record.result.ticketId)
        : undefined;
      const verified =
        task.proposal.action === "reconcile_payment"
          ? order.status === "paid"
          : ticket?.orderId === order.id && ticket.tenantId === actor.tenantId;
      task.status = verified ? "completed" : "handoff";
      task.result = { ...record.result, actionId: record.id, verified };
      task.summary = verified
        ? "按原幂等记录查回执行结果并核验，未重放业务动作。"
        : "已找到原执行记录，但当前业务状态不一致，转人工核查。";
    }
    event(task, "execution", "核对原操作结果", task.summary);
    this.store.save(task);
    this.changed(task);
    return task;
  }

  fault(
    actor: Actor,
    id: string,
    fault:
      | "close_order"
      | "payment_refunded"
      | "query_timeout"
      | "query_unavailable",
  ) {
    const task = this.store.task(id, actor);
    if (fault.startsWith("query_")) {
      if (task.status !== "queued")
        throw new AppError(
          "INVALID_TASK_STATE",
          "查询故障需在调查开始前设置。",
          409,
        );
      this.store.put("fault", `${id}:get_payment`, {
        remaining: fault === "query_timeout" ? 1 : 5,
      });
    } else {
      if (actor.role !== "approver")
        throw new AppError(
          "FAULT_FORBIDDEN",
          "演示业务状态变更需要运营身份。",
          403,
        );
      if (!task.orderId)
        throw new AppError(
          "ORDER_NOT_CONFIRMED",
          "任务尚未确认目标订单。",
          409,
        );
      const order = this.store.order(actor, task.orderId);
      if (fault === "close_order")
        this.store.put("order", order.id, {
          ...order,
          status: "closed",
          version: order.version + 1,
          closedReason: "演示并发关单，库存已释放",
        });
      else {
        const payment = this.store.payment(actor, order.id);
        this.store.put("payment", order.id, {
          ...payment,
          status: "refunded",
          version: payment.version + 1,
        });
      }
    }
    event(task, "state", "注入演示故障", fault);
    this.store.save(task);
    this.changed(task);
    return task;
  }

  recover() {
    for (const task of this.store.tasks()) {
      const actor = actorById(task.ownerId);
      if (task.status === "result_unknown") this.verify(actor, task.id);
      else if (["investigating", "executing"].includes(task.status)) {
        if (task.status === "executing") {
          task.status = "result_unknown";
          this.store.save(task);
          this.verify(actor, task.id);
        } else {
          task.status = "queued";
          event(
            task,
            "state",
            "重启后恢复调查",
            "复用已保存工具结果；保留原调用预算",
          );
          this.store.save(task);
        }
      }
    }
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let task: Task | undefined;
      while (
        (task = this.store
          .tasks()
          .reverse()
          .find((t) => t.status === "queued"))
      ) {
        try {
          const result = await this.agent.investigate(
            task.id,
            actorById(task.ownerId),
          );
          this.changed(result);
        } catch (error) {
          const current = this.store.task(task.id);
          if (!["queued", "investigating"].includes(current.status)) continue;
          current.status = "handoff";
          current.summary =
            error instanceof AppError
              ? error.message
              : "调查异常，转人工处理。";
          event(current, "error", "调查中断", current.summary);
          this.store.save(current);
          this.changed(current);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
