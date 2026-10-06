import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";
import {
  reconciliationPolicy,
  policyVersion,
  proposalDigest,
} from "./policy.js";
import { Store, event } from "./store.js";
import type { Actor, Evidence, Order, Proposal, Task } from "./types.js";

const orderId = z
  .string()
  .regex(/^\d{19}$/, "订单 ID 必须是完整的 19 位字符串");
const evidenceIds = z.array(z.string().uuid()).min(1).max(24);
const args = {
  find_orders: z.object({ customerRef: z.string().min(2).max(100) }).strict(),
  get_order: z.object({ orderId }).strict(),
  get_payment: z.object({ orderId }).strict(),
  get_callbacks: z.object({ orderId }).strict(),
  get_records: z.object({ orderId }).strict(),
  get_policy: z.object({ orderId }).strict(),
  ask_user: z.object({ question: z.string().min(4).max(500) }).strict(),
  propose_action: z
    .object({
      orderId,
      action: z.enum(["reconcile_payment", "create_ticket"]),
      reason: z.string().min(8).max(1000),
      evidenceIds,
    })
    .strict(),
  finish: z
    .object({
      summary: z.string().min(8).max(1500),
      disposition: z.enum(["resolved", "handoff"]),
      evidenceIds: z.array(z.string().uuid()).max(24),
    })
    .strict(),
};
export type ToolName = keyof typeof args;
const descriptions: Record<ToolName, string> = {
  find_orders:
    "按用户已提供的客户标识查询当前商家候选订单，不支持全库搜索。多个候选必须澄清。",
  get_order:
    "读取用户明确指定或唯一候选订单，记录状态、版本、金额（分）。订单 ID 是字符串。",
  get_payment: "查询模拟支付渠道的权威记录；用户描述和截图不能替代它。",
  get_callbacks: "查询回调到达与处理记录；缺少回调不能证明支付失败。",
  get_records: "查询已有支付异常工单和处置记录，避免重复处理。",
  get_policy: "读取后端对当前订单与支付的对账资格判断，禁止模型修改业务规则。",
  ask_user: "信息不足或多订单时暂停任务并向用户提问，等待真实补充后恢复。",
  propose_action:
    "提出需审批的对账补偿或异常工单建议。不会执行写操作。必须引用当前调查工具返回的 evidence_id。",
  finish:
    "根据当前证据结束调查或转人工。不修改订单。未访问订单只能转人工，不能声称已解决。",
};
export const toolDefinitions = Object.entries(args).map(([name, schema]) => ({
  type: "function" as const,
  function: {
    name,
    description: descriptions[name as ToolName],
    parameters: z.toJSONSchema(schema),
  },
}));
export const terminalTools = new Set(["ask_user", "propose_action", "finish"]);

export function currentEvidence(task: Task) {
  return task.evidence.filter((e) => e.epoch === task.epoch);
}
export function latestEvidence(task: Task, tool: string): Evidence | undefined {
  return currentEvidence(task).findLast((e) => e.tool === tool);
}

function userOrderIds(task: Task): string[] {
  for (const message of [...task.messages].reverse()) {
    if (message.role !== "user") continue;
    const ids = [...new Set(message.content?.match(/\b\d{19}\b/g) ?? [])];
    if (ids.length) return ids;
  }
  return [];
}
function ensureBoundOrder(task: Task, id: string) {
  if (task.orderId !== id)
    throw new AppError(
      "ORDER_NOT_CONFIRMED",
      "请先读取并确认目标订单，不能跨订单使用工具。",
    );
}
function validateReferences(task: Task, ids: string[]) {
  const available = currentEvidence(task);
  if (
    ids.some(
      (id) =>
        !available.some(
          (e) => e.id === id && !(e.result as { error?: unknown })?.error,
        ),
    )
  ) {
    throw new AppError(
      "INVALID_EVIDENCE",
      "引用不存在、失败或已过期的工具证据。",
    );
  }
}

export class ToolExecutor {
  constructor(private store: Store) {}

  run(
    task: Task,
    actor: Actor,
    name: string,
    raw: string,
  ): { result: Record<string, unknown>; evidence: Evidence } {
    if (!Object.hasOwn(args, name))
      throw new AppError("TOOL_NOT_ALLOWED", "工具不在允许列表中。");
    const parsed = args[name as ToolName].safeParse(JSON.parse(raw));
    if (!parsed.success)
      throw new AppError("INVALID_TOOL_ARGUMENTS", "工具参数未通过结构校验。");
    const input = parsed.data as Record<string, unknown>;
    const result = this.perform(task, actor, name as ToolName, input);
    const evidence: Evidence = {
      id: randomUUID(),
      tool: name,
      args: input,
      result,
      at: new Date().toISOString(),
      epoch: task.epoch,
    };
    task.evidence.push(evidence);
    return { result: { ...result, evidence_id: evidence.id }, evidence };
  }

  private perform(
    task: Task,
    actor: Actor,
    name: ToolName,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const id = input.orderId as string;
    if (
      [
        "get_payment",
        "get_callbacks",
        "get_records",
        "get_policy",
        "propose_action",
      ].includes(name)
    )
      ensureBoundOrder(task, id);
    const fault = this.store.get<{ remaining: number }>(
      "fault",
      `${task.id}:${name}`,
    );
    if (fault?.remaining) {
      this.store.put("fault", `${task.id}:${name}`, {
        remaining: fault.remaining - 1,
      });
      throw new AppError(
        "TOOL_TIMEOUT",
        "演示查询超时，未产生业务写入。可以有限重试或转人工。",
        504,
      );
    }
    switch (name) {
      case "find_orders": {
        const ref = input.customerRef as string;
        const normalize = (s: string) => s.replace(/\s/g, "");
        if (
          !task.messages.some(
            (m) =>
              m.role === "user" &&
              normalize(m.content ?? "").includes(normalize(ref)),
          )
        )
          throw new AppError(
            "MISSING_CUSTOMER_REF",
            "客户标识必须来自用户提供的信息。",
          );
        const candidates = this.store
          .all<Order>("order")
          .filter(
            (o) =>
              o.tenantId === actor.tenantId &&
              normalize(o.customerRef) === normalize(ref),
          )
          .map((o) => ({
            id: o.id,
            items: o.items,
            amountCents: o.amountCents,
            status: o.status,
          }));
        return {
          candidates,
          requiresClarification: candidates.length !== 1,
          source: "synthetic_business",
        };
      }
      case "get_order": {
        const ids = userOrderIds(task);
        const found = latestEvidence(task, "find_orders")?.result as
          { candidates?: { id: string }[] } | undefined;
        if (
          !(ids.length === 1 && ids[0] === id) &&
          !(
            ids.length === 0 &&
            found?.candidates?.length === 1 &&
            found.candidates[0].id === id
          )
        )
          throw new AppError(
            "ORDER_NOT_CONFIRMED",
            "请让用户确认唯一目标订单，不允许猜测候选。",
          );
        const order = this.store.order(actor, id);
        if (task.orderId && task.orderId !== id)
          throw new AppError(
            "ORDER_SWITCH_NOT_ALLOWED",
            "当前任务已绑定订单，请为其他订单创建新任务。",
          );
        task.orderId = id;
        return { order, source: "synthetic_business" };
      }
      case "get_payment":
        return { payment: this.store.payment(actor, id) };
      case "get_callbacks":
        return {
          callback: this.store.callback(actor, id) ?? null,
          source: "synthetic_business",
        };
      case "get_records":
        return {
          tickets: this.store.tickets(actor, id),
          source: "synthetic_business",
        };
      case "get_policy":
        return {
          policy: reconciliationPolicy(
            this.store.order(actor, id),
            this.store.payment(actor, id),
          ),
        };
      case "ask_user":
        task.status = "needs_input";
        task.question = input.question as string;
        event(task, "state", "等待补充信息", task.question);
        return { waitingForUser: true, question: task.question };
      case "propose_action":
        return this.propose(task, actor, input);
      case "finish": {
        validateReferences(task, input.evidenceIds as string[]);
        if (
          input.disposition === "resolved" &&
          (!task.orderId ||
            ["get_order", "get_payment"].some(
              (tool) =>
                !currentEvidence(task).some(
                  (e) =>
                    e.tool === tool &&
                    (input.evidenceIds as string[]).includes(e.id) &&
                    !(e.result as { error?: unknown })?.error,
                ),
            ))
        )
          throw new AppError(
            "INSUFFICIENT_EVIDENCE",
            "必须引用有效订单和支付证据，不能认定调查完成。",
          );
        task.status = input.disposition === "handoff" ? "handoff" : "completed";
        task.summary = input.summary as string;
        event(
          task,
          "state",
          task.status === "handoff" ? "转人工处理" : "调查完成",
          task.summary,
        );
        return {
          disposition: input.disposition,
          summary: task.summary,
          businessWrite: false,
        };
      }
    }
  }

  private propose(task: Task, actor: Actor, input: Record<string, unknown>) {
    const refs = input.evidenceIds as string[];
    validateReferences(task, refs);
    const required = ["get_order", "get_payment", "get_records", "get_policy"];
    if (input.action === "reconcile_payment") required.push("get_callbacks");
    if (
      required.some(
        (name) =>
          !currentEvidence(task).some(
            (e) =>
              e.tool === name &&
              refs.includes(e.id) &&
              !(e.result as { error?: unknown })?.error,
          ),
      )
    )
      throw new AppError(
        "INSUFFICIENT_EVIDENCE",
        "提案必须引用订单、支付、已有记录和规则证据；对账还需回调证据。",
      );
    const order = this.store.order(actor, input.orderId as string);
    const payment = this.store.payment(actor, order.id);
    const observedOrder = latestEvidence(task, "get_order")?.result as {
      order: Order;
    };
    const observedPayment = latestEvidence(task, "get_payment")?.result as {
      payment: { version: number };
    };
    if (
      observedOrder.order.version !== order.version ||
      observedPayment.payment.version !== payment.version
    )
      throw new AppError(
        "STALE_EVIDENCE",
        "调查期间业务状态已变化，请重新读取证据。",
      );
    if (this.store.tickets(actor, order.id).length)
      throw new AppError(
        "EXISTING_TICKET",
        "已有异常工单，请返回原工单，不重复处置。",
      );
    if (
      input.action === "reconcile_payment" &&
      !reconciliationPolicy(order, payment).eligible
    )
      throw new AppError(
        "POLICY_DENIED",
        "不符合后端对账条件，只能提出人工工单或结束调查。",
      );
    const proposal: Omit<Proposal, "digest"> = {
      id: randomUUID(),
      action: input.action as Proposal["action"],
      orderId: order.id,
      orderVersion: order.version,
      paymentVersion: payment.version,
      reason: input.reason as string,
      evidenceIds: refs,
      policyVersion,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    task.proposal = { ...proposal, digest: proposalDigest(proposal) };
    task.status = "awaiting_approval";
    event(task, "approval", "处置提案待确认", task.proposal.reason);
    return { proposal: task.proposal, executed: false };
  }
}
