import { createHash } from "node:crypto";
import type { Order, Payment, Proposal } from "./types.js";

export const policyVersion = "payment-exception-1";
export function reconciliationPolicy(order: Order, payment: Payment) {
  const reasons: string[] = [];
  if (order.status !== "pending")
    reasons.push("订单不是待支付状态，禁止直接恢复或重复标记支付。");
  if (payment.status !== "success")
    reasons.push("支付渠道未确认成功，处理中、失败或已退款均不能补偿。");
  if (payment.orderId !== order.id || payment.tenantId !== order.tenantId)
    reasons.push("支付交易与订单归属不一致。");
  if (
    payment.amountCents !== order.amountCents ||
    payment.currency !== order.currency
  )
    reasons.push("金额或币种不一致。");
  if (!payment.transactionId) reasons.push("缺少支付渠道交易标识。");
  return {
    version: policyVersion,
    eligible: reasons.length === 0,
    reasons,
    source: "server_policy",
    scope: "synthetic_orders_only",
    noAutomaticRefund: true,
  };
}
export function proposalDigest(proposal: Omit<Proposal, "digest">) {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}
