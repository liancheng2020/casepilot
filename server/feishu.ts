import * as Lark from "@larksuiteoapi/node-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, errorResult } from "./errors.js";
import { actorById, CaseService } from "./service.js";
import type { Config } from "./config.js";
import type { Task } from "./types.js";

const messageSchema = z.object({
  sender: z.object({
    sender_id: z.object({ open_id: z.string().regex(/^ou_[\w]+$/) }),
    sender_type: z.literal("user"),
    tenant_key: z.string().min(1),
  }),
  message: z.object({
    message_id: z.string().regex(/^om_[\w]+$/),
    chat_id: z.string().regex(/^oc_[\w]+$/),
    chat_type: z.literal("p2p"),
    message_type: z.literal("text"),
    content: z.string().max(16000),
  }),
});
export function parseMessage(raw: unknown) {
  const event = messageSchema.parse(raw);
  const { text } = z
    .object({ text: z.string().trim().min(1).max(4000) })
    .parse(JSON.parse(event.message.content));
  return {
    text,
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    openId: event.sender.sender_id.open_id,
    tenantKey: event.sender.tenant_key,
  };
}
type Binding = { chatId: string; openId: string; tenantKey: string };
const statusNames: Record<Task["status"], string> = {
  queued: "已接收",
  investigating: "调查中",
  needs_input: "等待补充",
  awaiting_approval: "待运营确认",
  executing: "执行中",
  result_unknown: "待核对执行结果",
  completed: "完成",
  handoff: "转人工",
  conflict: "提案失效",
  cancelled: "已取消",
};
export function taskReply(task: Task, baseURL: string) {
  const proposal = task.proposal;
  return [
    `CasePilot · ${statusNames[task.status]}`,
    `任务：${task.id}`,
    ...(task.orderId ? [`订单：${task.orderId}`] : []),
    `来源：${task.mode === "mock" ? "规则模拟器（非模型）" : "真实模型工具调用"} / 合成订单`,
    task.question ||
      task.summary ||
      (proposal
        ? `依据：${proposal.reason}`
        : "任务已入队，调查完成后返回结果。"),
    ...(task.status === "awaiting_approval" && proposal
      ? [
          `待确认动作：${proposal.action === "reconcile_payment" ? "演示对账补偿" : "创建异常工单"}`,
          `有效期：${proposal.expiresAt}（UTC）`,
          `运营确认：确认 ${task.id} ${proposal.id}`,
          `拒绝：拒绝 ${task.id} ${proposal.id}`,
        ]
      : []),
    ...(task.status === "needs_input"
      ? [`补充：补充 ${task.id} 完整订单号或说明`]
      : []),
    ...(task.status === "result_unknown" ? [`核对：核对 ${task.id}`] : []),
    `查询：查询 ${task.id}`,
    `详情：${new URL(`/?task=${task.id}`, baseURL).href}`,
  ].join("\n");
}

export class FeishuAdapter {
  constructor(
    private service: CaseService,
    private config: Pick<
      Config,
      "actorMap" | "FEISHU_TENANT_KEY" | "AGENT_MODE"
    >,
  ) {}

  accept(raw: unknown) {
    const message = parseMessage(raw);
    if (message.tenantKey !== this.config.FEISHU_TENANT_KEY)
      throw new AppError("FEISHU_ORG_DENIED", "组织未授权。", 403);
    const actorId = Object.hasOwn(this.config.actorMap, message.openId)
      ? this.config.actorMap[message.openId]
      : undefined;
    if (!actorId)
      throw new AppError(
        "FEISHU_USER_DENIED",
        "用户未授权；请发送“身份”，由项目维护者配置身份映射。",
        403,
      );
    const actor = actorById(actorId);
    const command = message.text.match(
      /^(补充|确认|拒绝|核对|查询)\s+([0-9a-f-]{36})(?:\s+([\s\S]+))?$/i,
    );
    if (/^(补充|确认|拒绝|核对|查询)(?:\s|$)/.test(message.text) && !command)
      throw new AppError(
        "INVALID_COMMAND",
        "命令格式错误，请使用完整任务 ID 和提案 ID。",
      );
    let task: Task;
    let previousRevision: number | undefined;
    if (!command) {
      task = this.service.create(actor, {
        complaint: message.text,
        requestId: message.messageId,
        mode: this.config.AGENT_MODE,
        channel: "feishu",
      });
    } else {
      const [, action, id, rest = ""] = command;
      z.uuid().parse(id);
      previousRevision = this.service.store.task(id, actor).revision;
      if (action === "补充") {
        if (!rest.trim())
          throw new AppError("MISSING_REPLY", "补充内容不能为空。");
        const scope = `feishu-command:${actor.tenantId}:${actor.id}`;
        const received = this.service.store.receipt(
          scope,
          message.messageId,
          actor.id,
        );
        task = received
          ? this.service.store.task(received, actor)
          : this.service.store.transaction(() => {
              const updated = this.service.reply(actor, id, rest.trim());
              this.service.store.addReceipt(
                scope,
                message.messageId,
                actor.id,
                id,
              );
              return updated;
            });
      } else if (action === "确认") {
        task = this.service.approve(actor, id, z.uuid().parse(rest));
      } else if (action === "拒绝") {
        const proposalId = z.uuid().parse(rest);
        const current = this.service.store.task(id, actor);
        task =
          current.status === "cancelled" &&
          current.proposal?.id === proposalId &&
          actor.role === "approver"
            ? current
            : this.service.reject(actor, id, proposalId);
      } else {
        if (rest.trim())
          throw new AppError("INVALID_COMMAND", "查询或核对只需任务 ID。");
        const current = this.service.store.task(id, actor);
        task =
          action === "核对" && current.status === "result_unknown"
            ? this.service.verify(actor, id)
            : current;
      }
    }
    const binding: Binding = {
      chatId: message.chatId,
      openId: message.openId,
      tenantKey: message.tenantKey,
    };
    const bindings =
      this.service.store.get<Record<string, Binding>>(
        "feishu-binding",
        task.id,
      ) || {};
    bindings[message.openId] = binding;
    this.service.store.put("feishu-binding", task.id, bindings);
    return {
      task,
      binding,
      updated: Boolean(command && task.revision !== previousRevision),
    };
  }
}

// Stable per-message UUIDs let Feishu deduplicate notification retries too.
export function notificationId(binding: Binding, key: string) {
  return createHash("sha256")
    .update(`${binding.tenantKey}:${binding.openId}:${binding.chatId}:${key}`)
    .digest("hex")
    .slice(0, 40);
}
export function startFeishu(service: CaseService, config: Config) {
  if (config.FEISHU_ENABLED !== "true")
    return {
      enabled: false,
      state: () => "disabled",
      close() {},
    };
  // SDK error objects can contain credentials/request bodies. Do not forward them to logs.
  const logger = {
    error: () =>
      console.warn("Feishu SDK: request/connection error (details redacted)"),
    warn() {},
    info() {},
    debug() {},
    trace() {},
  };
  const credentials = {
    appId: config.FEISHU_APP_ID,
    appSecret: config.FEISHU_APP_SECRET,
    logger,
    loggerLevel: Lark.LoggerLevel.error,
  };
  // Retain SDK response interceptors while bounding token and message requests.
  Lark.defaultHttpInstance.defaults.timeout = 10000;
  const client = new Lark.Client(credentials);
  const ws = new Lark.WSClient({ ...credentials, handshakeTimeoutMs: 10000 });
  const adapter = new FeishuAdapter(service, config);
  let closed = false;
  const send = async (binding: Binding, text: string, key: string) => {
    if (closed) return;
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: binding.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid: notificationId(binding, key),
      },
    });
    if (result.code !== 0)
      throw new AppError(
        "FEISHU_SEND_FAILED",
        "飞书回复未成功，请在工作台查看任务。",
        502,
      );
  };
  const safeSend = async (binding: Binding, text: string, key: string) => {
    try {
      await send(binding, text, key);
    } catch {
      console.warn("Feishu notification: FEISHU_SEND_FAILED");
    }
  };
  const unsubscribe = service.subscribe((task) => {
    if (
      task.channel !== "feishu" ||
      ["queued", "investigating", "executing"].includes(task.status)
    )
      return;
    setImmediate(() => {
      if (closed) return;
      const bindings =
        service.store.get<Record<string, Binding>>("feishu-binding", task.id) ||
        {};
      for (const binding of Object.values(bindings)) {
        if (
          binding.tenantKey !== config.FEISHU_TENANT_KEY ||
          !Object.hasOwn(config.actorMap, binding.openId)
        )
          continue;
        const actor = actorById(config.actorMap[binding.openId]);
        if (actor.tenantId !== task.tenantId) continue;
        void safeSend(
          binding,
          taskReply(task, config.PUBLIC_BASE_URL),
          `${task.id}:${task.revision}`,
        );
      }
    });
  });
  const dispatcher = new Lark.EventDispatcher({ logger }).register({
    "im.message.receive_v1": (raw) => {
      if (closed) return;
      let message: ReturnType<typeof parseMessage>;
      try {
        message = parseMessage(raw);
      } catch {
        return;
      } // Ignore non-text, group messages and bots, without echoing them.
      const binding = {
        chatId: message.chatId,
        openId: message.openId,
        tenantKey: message.tenantKey,
      };
      if (message.text === "身份") {
        setImmediate(
          () =>
            void safeSend(
              binding,
              `CasePilot 身份信息\nFEISHU_TENANT_KEY=${message.tenantKey}\nopen_id=${message.openId}\n此命令不授予业务权限，请由维护者配置身份映射。`,
              message.messageId,
            ),
        );
        return;
      }
      try {
        const accepted = adapter.accept(raw);
        // Return promptly after durable storage. API sends/model calls never delay the event ACK.
        setImmediate(() => {
          if (closed) return;
          // Changed terminal states already notify all bound participants.
          if (
            !accepted.updated ||
            ["queued", "investigating", "executing"].includes(
              accepted.task.status,
            )
          )
            void safeSend(
              binding,
              taskReply(accepted.task, config.PUBLIC_BASE_URL),
              message.messageId,
            );
          void service.drain();
        });
      } catch (error) {
        const result = errorResult(error);
        setImmediate(
          () =>
            void safeSend(
              binding,
              `CasePilot · ${result.message}`,
              message.messageId,
            ),
        );
      }
    },
  });
  void ws.start({ eventDispatcher: dispatcher }).catch(() => {
    console.warn("Feishu: connection failed; Web workspace remains available.");
  });
  return {
    enabled: true,
    state: () => ws.getConnectionStatus().state,
    close() {
      closed = true;
      unsubscribe();
      ws.close({ force: true });
    },
  };
}
