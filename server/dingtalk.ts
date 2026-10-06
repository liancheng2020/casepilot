import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";
import { z } from "zod";
import { AppError, errorResult } from "./errors.js";
import { actorById, CaseService } from "./service.js";
import type { Config } from "./config.js";
import type { Mode, Task } from "./types.js";

const messageSchema = z.object({
  msgId: z.string().min(1),
  senderStaffId: z.string().min(1),
  senderCorpId: z.string().min(1),
  sessionWebhook: z.url(),
  sessionWebhookExpiredTime: z.number(),
  msgtype: z.literal("text"),
  text: z.object({ content: z.string().min(1).max(4000) }),
});
type BotMessage = z.infer<typeof messageSchema>;
type ReplyBinding = { url: string; expiresAt: number };
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
    `来源：${task.mode === "mock" ? "规则模拟器（非模型）" : "真实模型工具调用"} / 合成订单`,
    task.question ||
      task.summary ||
      proposal?.reason ||
      "任务已入队，调查完成后返回结果。",
    ...(task.status === "awaiting_approval" && proposal
      ? [
          `待确认动作：${proposal.action === "reconcile_payment" ? "演示对账补偿" : "创建异常工单"}`,
          `运营确认：确认 ${task.id} ${proposal.id}`,
          `拒绝：拒绝 ${task.id} ${proposal.id}`,
        ]
      : []),
    ...(task.status === "needs_input"
      ? [`补充：补充 ${task.id} 完整订单号或说明`]
      : []),
    ...(task.status === "result_unknown" ? [`核对：核对 ${task.id}`] : []),
    `详情：${new URL(`/?task=${task.id}`, baseURL).href}`,
  ].join("\n");
}

export class DingTalkAdapter {
  constructor(
    private service: CaseService,
    private config: Pick<
      Config,
      "actorMap" | "DINGTALK_CORP_ID" | "PUBLIC_BASE_URL" | "AGENT_MODE"
    >,
  ) {}
  accept(raw: unknown): { task: Task; binding: ReplyBinding } {
    const message = messageSchema.parse(raw);
    if (message.senderCorpId !== this.config.DINGTALK_CORP_ID)
      throw new AppError("DINGTALK_ORG_DENIED", "组织未授权。", 403);
    const actorId = this.config.actorMap[message.senderStaffId];
    if (!actorId)
      throw new AppError(
        "DINGTALK_USER_DENIED",
        "员工未授权；消息中的管理员声明不作为授权依据。",
        403,
      );
    const actor = actorById(actorId);
    const binding = {
      url: validatedWebhook(message.sessionWebhook),
      expiresAt: message.sessionWebhookExpiredTime,
    };
    const content = message.text.content.trim();
    const command = content.match(
      /^(补充|确认|拒绝|核对)\s+([0-9a-f-]{36})(?:\s+([\s\S]+))?$/i,
    );
    let task: Task;
    if (!command) {
      task = this.service.create(actor, {
        complaint: content,
        requestId: message.msgId,
        mode: this.config.AGENT_MODE as Mode,
        channel: "dingtalk",
      });
    } else {
      const [, action, id, rest = ""] = command;
      if (action === "补充") {
        if (!rest.trim())
          throw new AppError("MISSING_REPLY", "补充内容不能为空。");
        // A durable receipt makes redelivered follow-up messages harmless as well.
        const scope = `dingtalk-command:${actor.tenantId}:${actor.id}`;
        const received = this.service.store.receipt(
          scope,
          message.msgId,
          actor.id,
        );
        if (received) task = this.service.store.task(received, actor);
        else
          task = this.service.store.transaction(() => {
            const updated = this.service.reply(actor, id, rest.trim());
            this.service.store.addReceipt(scope, message.msgId, actor.id, id);
            return updated;
          });
      } else if (action === "确认")
        task = this.service.approve(actor, id, z.uuid().parse(rest));
      else if (action === "拒绝") {
        const current = this.service.store.task(id, actor);
        task =
          current.status === "cancelled" &&
          current.proposal?.id === rest &&
          actor.role === "approver"
            ? current
            : this.service.reject(actor, id, z.uuid().parse(rest));
      } else
        task =
          this.service.store.task(id, actor).status === "result_unknown"
            ? this.service.verify(actor, id)
            : this.service.store.task(id, actor);
    }
    this.service.store.put("dingtalk-binding", task.id, binding);
    return { task, binding };
  }
}

export function validatedWebhook(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "oapi.dingtalk.com" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.pathname !== "/robot/send"
  )
    throw new AppError(
      "INVALID_REPLY_ENDPOINT",
      "钉钉回复地址未通过安全校验。",
    );
  return url.href;
}

export async function startDingTalk(service: CaseService, config: Config) {
  if (config.DINGTALK_ENABLED !== "true") return { enabled: false, close() {} };
  const client = new DWClient({
    clientId: config.DINGTALK_CLIENT_ID,
    clientSecret: config.DINGTALK_CLIENT_SECRET,
    debug: false,
  });
  const adapter = new DingTalkAdapter(service, config);
  const send = async (binding: ReplyBinding, text: string) => {
    if (binding.expiresAt <= Date.now())
      throw new AppError(
        "DINGTALK_REPLY_EXPIRED",
        "钉钉会话回复地址已过期，请重新发消息查询任务。",
        502,
      );
    const response = await fetch(validatedWebhook(binding.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": String(await client.getAccessToken()),
      },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
    const result = (await response.json()) as { errcode?: number };
    if (!response.ok || result.errcode !== 0)
      throw new AppError(
        "DINGTALK_SEND_FAILED",
        "钉钉消息发送未成功，任务记录仍可在工作台核查。",
        502,
      );
  };
  const notify = async (task: Task) => {
    if (task.channel !== "dingtalk") return;
    const binding = service.store.get<ReplyBinding>(
      "dingtalk-binding",
      task.id,
    );
    if (!binding) return;
    try {
      await send(binding, taskReply(task, config.PUBLIC_BASE_URL));
    } catch (error) {
      console.warn("DingTalk notification:", errorResult(error).code);
    }
  };
  const unsubscribe = service.subscribe((task) => {
    void notify(task);
  });
  client.registerCallbackListener(
    TOPIC_ROBOT,
    (downstream: DWClientDownStream) => {
      void (async () => {
        let accepted: ReturnType<DingTalkAdapter["accept"]>;
        try {
          accepted = adapter.accept(JSON.parse(downstream.data));
          // ACK follows durable receipt/task storage, not the slower model or message send.
          client.socketCallBackResponse(downstream.headers.messageId, {
            success: true,
          });
        } catch (error) {
          console.warn("DingTalk incoming:", errorResult(error).code);
          client.socketCallBackResponse(downstream.headers.messageId, {
            success: false,
            message: errorResult(error).message,
          });
          return;
        }
        try {
          await send(
            accepted.binding,
            taskReply(accepted.task, config.PUBLIC_BASE_URL),
          );
        } catch (error) {
          console.warn("DingTalk reply:", errorResult(error).code);
        }
        void service.drain();
      })();
    },
  );
  await client.connect();
  return {
    enabled: true,
    close() {
      unsubscribe();
      client.disconnect();
    },
  };
}
