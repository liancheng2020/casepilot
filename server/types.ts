export type Mode = "mock" | "deepseek";
export type Status =
  | "queued"
  | "investigating"
  | "needs_input"
  | "awaiting_approval"
  | "executing"
  | "result_unknown"
  | "completed"
  | "handoff"
  | "conflict"
  | "cancelled";
export type Action = "reconcile_payment" | "create_ticket";
export type OrderStatus = "pending" | "paid" | "closed";

export interface Actor {
  id: string;
  name: string;
  tenantId: string;
  role: "operator" | "approver";
}
export interface Order {
  id: string;
  tenantId: string;
  customerRef: string;
  customerName: string;
  items: string;
  amountCents: number;
  currency: "CNY";
  status: OrderStatus;
  version: number;
  closedReason?: string;
}
export interface Payment {
  orderId: string;
  tenantId: string;
  transactionId: string;
  amountCents: number;
  currency: "CNY";
  status: "success" | "failed" | "processing" | "refunded";
  version: number;
  source: "simulated_gateway";
}
export interface Callback {
  orderId: string;
  status: "missing" | "processed" | "rejected";
  note: string;
}
export interface Ticket {
  id: string;
  orderId: string;
  tenantId: string;
  category: "payment_exception";
  reason: string;
  status: "open";
  taskId: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Evidence {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  at: string;
  epoch: number;
}
export interface Event {
  id: string;
  kind: "state" | "decision" | "tool" | "approval" | "execution" | "error";
  title: string;
  detail: string;
  at: string;
}
export interface Proposal {
  id: string;
  action: Action;
  orderId: string;
  orderVersion: number;
  paymentVersion: number;
  reason: string;
  evidenceIds: string[];
  policyVersion: string;
  expiresAt: string;
  digest: string;
}
export interface Usage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
}
export interface Task {
  id: string;
  tenantId: string;
  ownerId: string;
  complaint: string;
  channel: "web" | "dingtalk";
  mode: Mode;
  status: Status;
  orderId?: string;
  messages: Message[];
  evidence: Evidence[];
  initialQueryFault?: "query_timeout" | "query_unavailable";
  events: Event[];
  proposal?: Proposal;
  question?: string;
  summary?: string;
  result?: {
    actionId?: string;
    ticketId?: string;
    orderStatus?: OrderStatus;
    duplicate?: boolean;
    verified: boolean;
  };
  usage: Usage;
  epoch: number;
  toolErrors: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ActionRecord {
  id: string;
  taskId: string;
  proposalId: string;
  actorId: string;
  idempotencyKey: string;
  status: "completed";
  result: NonNullable<Task["result"]>;
  createdAt: string;
}
export interface Decision {
  content: string | null;
  calls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
}
export interface Provider {
  readonly mode: Mode;
  decide(task: Task): Promise<Decision>;
}
export interface Scenario {
  id: string;
  label: string;
  category: string;
  complaint: string;
  expected: string;
  orderId?: string;
}
