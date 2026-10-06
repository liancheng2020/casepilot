import type {
  Assessment,
  Callback,
  Evidence,
  Order,
  Payment,
  Task,
  Ticket,
} from "./types.js";
import { reconciliationPolicy } from "./policy.js";

export const findings = [
  "payment_failed",
  "payment_processing",
  "backend_paid",
  "existing_ticket",
  "reconciliation_needed",
  "manual_review",
  "insufficient_evidence",
] as const;
const orderNames = { pending: "待支付", paid: "已支付", closed: "已关闭" };
const paymentNames = {
  success: "成功",
  failed: "失败",
  processing: "处理中",
  refunded: "已退款",
};
const callbackNames = {
  missing: "未到达",
  processed: "已处理",
  rejected: "被拒绝",
};

// Only cited, successful observations in this investigation can become displayed facts.
export function assess(task: Task, references: string[]): Assessment {
  const available = task.evidence.filter(
    (e) =>
      e.epoch === task.epoch &&
      references.includes(e.id) &&
      !(e.result as { error?: unknown })?.error,
  );
  const observation = <T>(
    tool: string,
  ): { evidence: Evidence; data: T } | undefined => {
    const evidence = available.findLast((e) => e.tool === tool);
    return evidence ? { evidence, data: evidence.result as T } : undefined;
  };
  const order = observation<{ order: Order }>("get_order");
  const payment = observation<{ payment: Payment }>("get_payment");
  const records = observation<{ tickets: Ticket[] }>("get_records");
  const callback = observation<{ callback: Callback | null }>("get_callbacks");
  const facts: Assessment["facts"] = [];
  const add = (label: string, value: string, evidence: Evidence) =>
    facts.push({
      label,
      value,
      evidenceId: evidence.id,
      observedAt: evidence.at,
    });
  if (order) {
    add(
      "订单状态",
      `${orderNames[order.data.order.status]} · v${order.data.order.version}`,
      order.evidence,
    );
    add(
      "订单金额",
      `${(order.data.order.amountCents / 100).toFixed(2)} ${order.data.order.currency}`,
      order.evidence,
    );
  }
  if (payment) {
    add(
      "沙盒渠道状态",
      `${paymentNames[payment.data.payment.status]} · v${payment.data.payment.version}`,
      payment.evidence,
    );
    add(
      "渠道金额",
      `${(payment.data.payment.amountCents / 100).toFixed(2)} ${payment.data.payment.currency}`,
      payment.evidence,
    );
  }
  if (records)
    add("已有异常工单", String(records.data.tickets.length), records.evidence);
  if (callback)
    add(
      "回调记录",
      callback.data.callback
        ? callbackNames[callback.data.callback.status]
        : "未找到",
      callback.evidence,
    );
  const result: Assessment = {
    finding: "insufficient_evidence",
    summary: "有效订单或支付证据不足，不能认定到账或完成处置。",
    evidenceIds: [...references],
    facts,
    uncertainties: ["客户的付款描述不等于渠道到账记录。"],
  };
  if (!order || !payment) return result;
  const o = order.data.order,
    p = payment.data.payment;
  if (records?.data.tickets.length) {
    result.finding = "existing_ticket";
    result.summary = `已有异常工单 ${records.data.tickets[0].id}，无需重复创建；不代表该工单已解决。`;
    result.uncertainties = ["工单后续处理进度仍需人工核查。"];
  } else if (p.status === "failed") {
    result.finding = "payment_failed";
    result.summary =
      "沙盒支付渠道记录为失败；未执行对账补偿，请核对客户付款凭证。";
  } else if (p.status === "processing") {
    result.finding = "payment_processing";
    result.summary =
      "沙盒支付渠道仍在处理中，不能认定已经到账；未执行对账补偿。";
  } else if (
    o.status === "paid" &&
    p.status === "success" &&
    o.amountCents === p.amountCents &&
    o.currency === p.currency
  ) {
    result.finding = "backend_paid";
    result.summary = "后台订单已支付，沙盒渠道记录为成功；无需重复修改订单。";
    result.uncertainties = ["缺少客户端证据，不能认定缓存或页面逻辑是根因。"];
  } else if (reconciliationPolicy(o, p).eligible) {
    result.finding = "reconciliation_needed";
    result.summary =
      "沙盒渠道成功且金额一致，订单仍待支付；可申请对账补偿，批准前不执行。";
    result.uncertainties = [
      callback
        ? "状态不同步的根因尚未确定；回调快照不能证明具体故障，执行前仍须复核业务版本和规则。"
        : "尚未引用回调记录，不能认定回调缺失；执行前仍须复核业务版本和规则。",
    ];
  } else {
    result.finding = "manual_review";
    result.summary = `支付与订单存在异常：${reconciliationPolicy(o, p).reasons.join(" ")} 可申请人工异常工单，不直接恢复订单。`;
    result.uncertainties = ["异常根因和后续处置仍需人工确认，不自动退款。"];
  }
  return result;
}
