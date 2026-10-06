import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CaseService, actorById } from "../server/service.js";
import { MockProvider } from "../server/providers.js";
import { orderIds, scenarios } from "../server/fixtures.js";
import { ToolExecutor } from "../server/tools.js";
import type { Actor, Order, Payment, Provider, Task } from "../server/types.js";
import { proposalDigest } from "../server/policy.js";

const operator = actorById("service"),
  approver = actorById("operations"),
  other = actorById("other-store");
function setup(
  provider: Provider = new MockProvider(),
  path = ":memory:",
  limits?: { modelRequests: number; toolCalls: number },
) {
  const store = new Store(path);
  const service = new CaseService(store, { mock: provider }, limits);
  return { store, service };
}
async function investigate(
  service: CaseService,
  scenario = "delayed",
  actor: Actor = operator,
) {
  const task = service.create(actor, {
    complaint: scenarios.find((s) => s.id === scenario)!.complaint,
    mode: "mock",
    requestId: randomUUID(),
  });
  return service.agent.investigate(task.id, actor);
}

test("支付成功且回调缺失：审批前无写入，审批后核验订单", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    assert.equal(task.status, "awaiting_approval");
    assert.equal(task.proposal?.action, "reconcile_payment");
    assert.equal(store.order(operator, orderIds.delayed).status, "pending");
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,
      0,
    );
    const result = service.approve(approver, task.id, task.proposal!.id);
    assert.equal(result.status, "completed");
    assert.equal(result.result?.verified, true);
    assert.equal(store.order(operator, orderIds.delayed).status, "paid");
    assert.equal(
      store.order(operator, orderIds.delayed).id,
      "9223372036854775801",
    );
  } finally {
    store.close();
  }
});

for (const [scenario, status, action] of [
  ["failed", "completed", undefined],
  ["processing", "completed", undefined],
  ["paid", "completed", undefined],
  ["closed", "awaiting_approval", "create_ticket"],
  ["mismatch", "awaiting_approval", "create_ticket"],
  ["refunded", "awaiting_approval", "create_ticket"],
  ["existing", "completed", undefined],
  ["missing", "needs_input", undefined],
  ["ambiguous", "needs_input", undefined],
  ["forbidden", "handoff", undefined],
] as const) {
  test(`反馈分支：${scenario}`, async () => {
    const { store, service } = setup();
    try {
      const task = await investigate(service, scenario);
      assert.equal(task.status, status);
      assert.equal(task.proposal?.action, action);
    } finally {
      store.close();
    }
  });
}

test("澄清后按用户选择的候选恢复，不擅自选择订单", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service, "ambiguous");
    assert.equal(task.orderId, undefined);
    service.reply(operator, task.id, orderIds.ambiguousB);
    const result = await service.agent.investigate(task.id, operator);
    assert.equal(result.orderId, orderIds.ambiguousB);
    assert.equal(result.status, "awaiting_approval");
  } finally {
    store.close();
  }
});

test("同一请求重投不创建第二个任务，不同参数拒绝复用请求ID", () => {
  const { store, service } = setup();
  try {
    const input = {
      complaint: "订单异常需要核查",
      mode: "mock" as const,
      requestId: randomUUID(),
    };
    const task = service.create(operator, input);
    assert.equal(service.create(operator, input).id, task.id);
    assert.equal(store.tasks(operator).length, 1);
    assert.throws(
      () => service.create(operator, { ...input, complaint: "不同的请求描述" }),
      /不同任务内容/,
    );
  } finally {
    store.close();
  }
});

test("客服不能批准，跨商家不能访问或批准任务", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    assert.throws(
      () => service.approve(operator, task.id, task.proposal!.id),
      /运营身份/,
    );
    assert.throws(
      () => service.approve(other, task.id, task.proposal!.id),
      /任务不存在/,
    );
    assert.throws(() => store.order(other, orderIds.delayed), /权限范围/);
  } finally {
    store.close();
  }
});

test("重复创建不会重新注入故障，幂等请求不能更换故障参数", () => {
  const { store, service } = setup();
  try {
    const input = {
      complaint: scenarios[0].complaint,
      mode: "mock" as const,
      requestId: randomUUID(),
      fault: "query_timeout" as const,
    };
    const task = service.create(operator, input);
    store.put("fault", `${task.id}:get_payment`, { remaining: 0 });
    service.create(operator, input);
    assert.equal(
      store.get<{ remaining: number }>("fault", `${task.id}:get_payment`)
        ?.remaining,
      0,
    );
    assert.throws(
      () => service.create(operator, { ...input, fault: "query_unavailable" }),
      /不同任务内容/,
    );
  } finally {
    store.close();
  }
});

test("重复审批只执行一次，稳定幂等键保留原结果", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    const first = service.approve(approver, task.id, task.proposal!.id);
    const second = service.approve(approver, task.id, task.proposal!.id);
    assert.equal(first.result?.actionId, second.result?.actionId);
    assert.equal(store.order(operator, orderIds.delayed).version, 2);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});

test("审批后并发关单使提案失效，重新调查不复用旧证据", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    service.fault(approver, task.id, "close_order");
    assert.equal(
      service.approve(approver, task.id, task.proposal!.id).status,
      "conflict",
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,
      0,
    );
    service.restart(operator, task.id);
    const next = await service.agent.investigate(task.id, operator);
    assert.equal(next.proposal?.action, "create_ticket");
    assert.equal(next.epoch, 2);
    assert.ok(
      next.proposal!.evidenceIds.every((id) =>
        next.evidence.some((e) => e.id === id && e.epoch === 2),
      ),
    );
  } finally {
    store.close();
  }
});

test("审批后退款同样使提案失效", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    service.fault(approver, task.id, "payment_refunded");
    assert.equal(
      service.approve(approver, task.id, task.proposal!.id).status,
      "conflict",
    );
    assert.equal(store.order(operator, orderIds.delayed).status, "pending");
  } finally {
    store.close();
  }
});

test("提案参数被修改会失效，过期提案不能执行", async () => {
  for (const mutate of [
    (task: Task) => {
      task.proposal!.reason = "被修改的动作内容";
    },
    (task: Task) => {
      task.proposal!.expiresAt = new Date(0).toISOString();
      const { digest: _, ...signed } = task.proposal!;
      task.proposal!.digest = proposalDigest(signed);
    },
  ]) {
    const { store, service } = setup();
    try {
      const task = await investigate(service);
      mutate(task);
      store.save(task);
      assert.equal(
        service.approve(approver, task.id, task.proposal!.id).status,
        "conflict",
      );
    } finally {
      store.close();
    }
  }
});

test("金额不一致即便模型伪造对账提案也被执行规则拒绝", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service, "mismatch");
    task.proposal!.action = "reconcile_payment";
    const { digest: _, ...signed } = task.proposal!;
    task.proposal!.digest = proposalDigest(signed);
    store.save(task);
    assert.throws(
      () => service.approve(approver, task.id, task.proposal!.id),
      /核验未通过/,
    );
    assert.equal(store.order(operator, orderIds.mismatch).status, "pending");
  } finally {
    store.close();
  }
});

test("错误提案ID被拒绝，拒绝后无法再批准", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    assert.throws(
      () => service.approve(approver, task.id, randomUUID()),
      /不匹配/,
    );
    service.reject(approver, task.id, task.proposal!.id);
    assert.throws(
      () => service.approve(approver, task.id, task.proposal!.id),
      /不能执行/,
    );
  } finally {
    store.close();
  }
});

test("创建工单不改变关闭订单，其他任务并发提案复用已有工单", async () => {
  const { store, service } = setup();
  try {
    const a = await investigate(service, "closed"),
      b = await investigate(service, "closed");
    const first = service.approve(approver, a.id, a.proposal!.id),
      second = service.approve(approver, b.id, b.proposal!.id);
    assert.equal(first.result!.ticketId, second.result!.ticketId);
    assert.equal(second.result!.duplicate, true);
    assert.equal(store.tickets(operator, orderIds.closed).length, 1);
    assert.equal(store.order(operator, orderIds.closed).status, "closed");
  } finally {
    store.close();
  }
});

test("模拟执行响应丢失：核对原结果而非重放", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    const unknown = service.approve(approver, task.id, task.proposal!.id, true);
    assert.equal(unknown.status, "result_unknown");
    assert.equal(unknown.result?.verified, false);
    assert.equal(store.order(operator, orderIds.delayed).status, "paid");
    const result = service.verify(operator, task.id);
    assert.equal(result.status, "completed");
    assert.equal(result.result?.verified, true);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});

const temp = mkdtempSync(join(tmpdir(), "casepilot-core-"));
after(() => rmSync(temp, { recursive: true, force: true }));
test("关闭并重新打开SQLite后恢复未知结果，不重复工单", async () => {
  const path = join(temp, "restore.sqlite");
  let { store, service } = setup(new MockProvider(), path);
  const task = await investigate(service, "closed");
  service.approve(approver, task.id, task.proposal!.id, true);
  store.close();
  ({ store, service } = setup(new MockProvider(), path));
  try {
    service.recover();
    assert.equal(store.task(task.id).status, "completed");
    assert.equal(store.tickets(operator, orderIds.closed).length, 1);
  } finally {
    store.close();
  }
});

test("调查重启保留调用预算，等待审批不自动执行", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    service.recover();
    assert.equal(store.task(task.id).status, "awaiting_approval");
    const queued = service.create(operator, {
      complaint: "请查订单",
      mode: "mock",
      requestId: randomUUID(),
    });
    queued.status = "investigating";
    queued.usage.requests = 4;
    store.save(queued);
    service.recover();
    assert.equal(store.task(queued.id).status, "queued");
    assert.equal(store.task(queued.id).usage.requests, 4);
  } finally {
    store.close();
  }
});

test("一次查询超时可恢复，持续超时进入人工接管", async () => {
  for (const [fault, expected] of [
    ["query_timeout", "awaiting_approval"],
    ["query_unavailable", "handoff"],
  ] as const) {
    const { store, service } = setup();
    try {
      const task = service.create(operator, {
        complaint: scenarios[0].complaint,
        mode: "mock",
        requestId: randomUUID(),
      });
      service.fault(operator, task.id, fault);
      const result = await service.agent.investigate(task.id, operator);
      assert.equal(result.status, expected);
      assert.ok(result.events.some((e) => e.title === "TOOL_TIMEOUT"));
    } finally {
      store.close();
    }
  }
});

test("模型循环和工具数量预算会终止任务", async () => {
  const endless: Provider = {
    mode: "mock",
    async decide() {
      return {
        content: "repeat",
        calls: [
          {
            id: randomUUID(),
            name: "get_order",
            arguments: JSON.stringify({ orderId: orderIds.delayed }),
          },
        ],
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
  const { store, service } = setup(endless, ":memory:", {
    modelRequests: 2,
    toolCalls: 2,
  });
  try {
    const task = await investigate(service);
    assert.equal(task.status, "handoff");
    assert.equal(task.usage.requests, 2);
  } finally {
    store.close();
  }
});

test("不存在的工具和非法参数不能执行，无审批写工具可调用", async () => {
  const { store, service } = setup();
  try {
    const task = service.create(operator, {
      complaint: scenarios[0].complaint,
      mode: "mock",
      requestId: randomUUID(),
    });
    const executor = new ToolExecutor(store);
    assert.throws(
      () => executor.run(task, operator, "set_order_status", "{}"),
      /允许列表/,
    );
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "get_order",
          JSON.stringify({ orderId: 9223372036854775801 }),
        ),
      /结构校验/,
    );
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "get_order",
          JSON.stringify({ orderId: orderIds.delayed, approved: true }),
        ),
      /结构校验/,
    );
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "get_order",
          JSON.stringify({ orderId: orderIds.ambiguousA }),
        ),
      /确认唯一/,
    );
  } finally {
    store.close();
  }
});

test("伪造证据、不足证据和跨订单工具都被拒绝", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    const executor = new ToolExecutor(store);
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "get_payment",
          JSON.stringify({ orderId: orderIds.closed }),
        ),
      /跨订单/,
    );
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "propose_action",
          JSON.stringify({
            orderId: orderIds.delayed,
            action: "reconcile_payment",
            reason: "申请直接修改订单状态",
            evidenceIds: [randomUUID()],
          }),
        ),
      /不存在/,
    );
    assert.throws(
      () =>
        executor.run(
          task,
          operator,
          "propose_action",
          JSON.stringify({
            orderId: orderIds.delayed,
            action: "reconcile_payment",
            reason: "申请直接修改订单状态",
            evidenceIds: [task.evidence[0].id],
          }),
        ),
      /提案必须引用/,
    );
  } finally {
    store.close();
  }
});

test("取消期间到达的模型响应不会覆盖取消状态", async () => {
  let resolveDecision:
    ((value: Awaited<ReturnType<Provider["decide"]>>) => void) | undefined;
  const delayed: Provider = {
    mode: "mock",
    decide: () =>
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
  };
  const { store, service } = setup(delayed);
  try {
    const task = service.create(operator, {
      complaint: scenarios[0].complaint,
      mode: "mock",
      requestId: randomUUID(),
    });
    const run = service.agent.investigate(task.id, operator);
    service.cancel(operator, task.id);
    resolveDecision!({
      content: "",
      calls: [
        {
          id: randomUUID(),
          name: "get_order",
          arguments: JSON.stringify({ orderId: orderIds.delayed }),
        },
      ],
      promptTokens: 0,
      completionTokens: 0,
    });
    await run;
    assert.equal(store.task(task.id).status, "cancelled");
    assert.equal(store.task(task.id).evidence.length, 0);
  } finally {
    store.close();
  }
});

test("无真实模型配置时不能悄悄返回模拟结果", () => {
  const { store, service } = setup();
  try {
    assert.throws(
      () =>
        service.create(operator, {
          complaint: "核查支付订单",
          mode: "deepseek",
          requestId: randomUUID(),
        }),
      /未配置真实模型/,
    );
  } finally {
    store.close();
  }
});

test("取消后迟到的模型错误也不能被调度器覆盖", async () => {
  let rejectDecision: ((reason: Error) => void) | undefined;
  const provider: Provider = {
    mode: "mock",
    decide: () =>
      new Promise((_, reject) => {
        rejectDecision = reject;
      }),
  };
  const { store, service } = setup(provider);
  try {
    const task = service.create(operator, {
      complaint: scenarios[0].complaint,
      mode: "mock",
      requestId: randomUUID(),
    });
    const run = service.drain();
    service.cancel(operator, task.id);
    rejectDecision!(new Error("late timeout"));
    await run;
    assert.equal(store.task(task.id).status, "cancelled");
    assert.equal(store.task(task.id).evidence.length, 0);
  } finally {
    store.close();
  }
});

test("写入回查不一致时不记录虚假成功，整笔事务回滚", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    const put = store.put.bind(store);
    store.put = (kind, id, value) => {
      if (kind !== "order") put(kind, id, value);
    };
    assert.throws(
      () => service.approve(approver, task.id, task.proposal!.id),
      /未通过回查/,
    );
    assert.equal(store.task(task.id).status, "awaiting_approval");
    assert.equal(store.order(operator, orderIds.delayed).status, "pending");
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,
      0,
    );
  } finally {
    store.close();
  }
});

test("持久化任务更新采用CAS，旧对象不会覆盖新状态", () => {
  const { store, service } = setup();
  try {
    const task = service.create(operator, {
      complaint: "核查支付订单",
      mode: "mock",
      requestId: randomUUID(),
    });
    const stale = store.task(task.id);
    service.cancel(operator, task.id);
    assert.throws(() => store.save(stale), /其他操作更新/);
  } finally {
    store.close();
  }
});

test("业务事务失败回滚订单、执行记录和审批状态", async () => {
  const { store, service } = setup();
  try {
    const task = await investigate(service);
    store.addAction = () => {
      throw new Error("simulated database failure");
    };
    assert.throws(
      () => service.approve(approver, task.id, task.proposal!.id),
      /database failure/,
    );
    assert.equal(store.order(operator, orderIds.delayed).status, "pending");
    assert.equal(store.task(task.id).status, "awaiting_approval");
  } finally {
    store.close();
  }
});
