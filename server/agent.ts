import { randomUUID } from "node:crypto";
import { AppError, errorResult } from "./errors.js";
import { event, Store } from "./store.js";
import { terminalTools, ToolExecutor } from "./tools.js";
import type { Actor, Evidence, Provider } from "./types.js";

export class Agent {
  private tools: ToolExecutor;
  constructor(
    private store: Store,
    private providers: Partial<Record<Provider["mode"], Provider>>,
    private limits = { modelRequests: 12, toolCalls: 24 },
  ) {
    this.tools = new ToolExecutor(store);
  }

  async investigate(taskId: string, actor: Actor) {
    let task = this.store.task(taskId, actor);
    if (!["queued", "investigating"].includes(task.status)) return task;
    const provider = this.providers[task.mode];
    if (!provider)
      throw new AppError(
        "MODEL_NOT_CONFIGURED",
        "真实模型未配置，任务不会自动降级为模拟模式。",
        503,
      );
    task.status = "investigating";
    event(
      task,
      "state",
      "开始调查",
      task.mode === "mock"
        ? "规则模拟器，不调用模型"
        : "真实 DeepSeek Tool Calling",
    );
    this.store.save(task);
    while (task.status === "investigating") {
      if (
        task.usage.requests >= this.limits.modelRequests ||
        task.usage.toolCalls >= this.limits.toolCalls ||
        task.toolErrors >= 3
      ) {
        task.status = "handoff";
        task.summary = "调查达到请求、工具或错误预算，停止自动处理并转人工。";
        event(task, "error", "预算达到上限", task.summary);
        this.store.save(task);
        break;
      }
      // Reserve a request before I/O: a crash must not reset or undercount its budget.
      task.usage.requests++;
      this.store.save(task);
      try {
        const decision = await provider.decide(task);
        const latest = this.store.task(task.id, actor);
        if (
          latest.revision !== task.revision ||
          latest.status !== "investigating"
        )
          return latest;
        task.usage.promptTokens += decision.promptTokens;
        task.usage.completionTokens += decision.completionTokens;
        if (
          !decision.calls.length ||
          decision.calls.length > 4 ||
          new Set(decision.calls.map((c) => c.id)).size !==
            decision.calls.length ||
          (decision.calls.length > 1 &&
            decision.calls.some((c) => terminalTools.has(c.name)))
        )
          throw new AppError(
            "INVALID_MODEL_DECISION",
            "模型调用批次不符合约束，停止自动处理。",
          );
        task.messages.push({
          role: "assistant",
          content: decision.content,
          tool_calls: decision.calls,
        });
        event(
          task,
          "decision",
          decision.calls.map((c) => c.name).join(" → "),
          decision.content || "选择工具；内部推理不采集、不展示",
        );
        for (const call of decision.calls) {
          task.usage.toolCalls++;
          let result: Record<string, unknown>;
          try {
            if (task.usage.toolCalls > this.limits.toolCalls)
              throw new AppError("TOOL_BUDGET", "工具预算已用尽。");
            result = this.tools.run(
              task,
              actor,
              call.name,
              call.arguments,
            ).result;
            event(task, "tool", call.name, "工具返回已记录，可在证据区核查");
          } catch (error) {
            task.toolErrors++;
            const failure = errorResult(error);
            const evidence: Evidence = {
              id: randomUUID(),
              tool: call.name,
              args: {},
              result: { error: failure },
              at: new Date().toISOString(),
              epoch: task.epoch,
            };
            task.evidence.push(evidence);
            result = { error: failure, evidence_id: evidence.id };
            event(task, "error", failure.code, failure.message);
          }
          task.messages.push({
            role: "tool",
            content: JSON.stringify(result),
            tool_call_id: call.id,
          });
        }
        this.store.save(task);
      } catch (error) {
        const latest = this.store.task(task.id, actor);
        if (
          latest.revision !== task.revision ||
          latest.status !== "investigating"
        )
          return latest;
        task.status = "handoff";
        task.summary = errorResult(error).message;
        event(task, "error", errorResult(error).code, task.summary);
        this.store.save(task);
      }
    }
    return task;
  }
}
