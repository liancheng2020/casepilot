import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CaseService, actorById } from "../server/service.js";
import { MockProvider } from "../server/providers.js";
import { orderIds } from "../server/fixtures.js";
import { ToolExecutor } from "../server/tools.js";
import { assess } from "../server/assessment.js";

function observed(id: string) {
  const store = new Store();
  const service = new CaseService(store, { mock: new MockProvider() });
  const actor = actorById("service");
  const task = service.create(actor, {
    complaint: `订单 ${id} 请核查`,
    mode: "mock",
    requestId: randomUUID(),
  });
  const tools = new ToolExecutor(store);
  for (const name of ["get_order", "get_payment", "get_records", "get_policy"])
    tools.run(task, actor, name, JSON.stringify({ orderId: id }));
  return { store, actor, task, tools, refs: task.evidence.map((e) => e.id) };
}
for (const [id, wrong, correct] of [
  [orderIds.failed, "backend_paid", "payment_failed"],
  [orderIds.processing, "backend_paid", "payment_processing"],
  [orderIds.paid, "payment_failed", "backend_paid"],
] as const) {
  test(`结论与证据冲突被拒绝：${correct}`, () => {
    const { store, actor, task, tools, refs } = observed(id);
    try {
      assert.throws(
        () =>
          tools.run(
            task,
            actor,
            "finish",
            JSON.stringify({
              summary: "已经到账并完成所有操作",
              disposition: "resolved",
              finding: wrong,
              evidenceIds: refs,
            }),
          ),
        /结论类型与所引证据冲突/,
      );
      tools.run(
        task,
        actor,
        "finish",
        JSON.stringify({
          summary: "已经到账并完成所有操作",
          disposition: "resolved",
          finding: correct,
          evidenceIds: refs,
        }),
      );
      assert.equal(task.assessment?.finding, correct);
      assert.equal(task.summary, task.assessment?.summary);
      assert.equal(task.modelAnalysis, "已经到账并完成所有操作");
      assert.ok(
        task.assessment?.facts.every((f) => refs.includes(f.evidenceId)),
      );
      assert.equal(store.order(actor, id).version, 1);
      assert.notEqual(task.summary, task.modelAnalysis);
      if (correct === "payment_processing")
        assert.match(task.summary!, /不能认定已经到账/);
    } finally {
      store.close();
    }
  });
}
test("需要补偿的证据不能仅凭引用结束为已解决", () => {
  const { store, actor, task, tools, refs } = observed(orderIds.delayed);
  try {
    assert.throws(
      () =>
        tools.run(
          task,
          actor,
          "finish",
          JSON.stringify({
            summary: "支付异常已经完全解决",
            disposition: "resolved",
            finding: "reconciliation_needed",
            evidenceIds: refs,
          }),
        ),
      /不能直接认定调查完成/,
    );
    assert.equal(store.order(actor, orderIds.delayed).status, "pending");
    assert.match(assess(task, refs).uncertainties[0], /尚未引用回调记录/);
    const { evidence } = tools.run(
      task,
      actor,
      "get_callbacks",
      JSON.stringify({ orderId: orderIds.delayed }),
    );
    const assessment = assess(task, [...refs, evidence.id]);
    assert.ok(
      assessment.facts.some(
        (f) => f.label === "回调记录" && f.value === "未到达",
      ),
    );
    assert.match(assessment.uncertainties[0], /根因尚未确定/);
  } finally {
    store.close();
  }
});
test("失败渠道不能提出无依据的异常工单", () => {
  const { store, actor, task, tools, refs } = observed(orderIds.failed);
  try {
    assert.throws(
      () =>
        tools.run(
          task,
          actor,
          "propose_action",
          JSON.stringify({
            orderId: orderIds.failed,
            action: "create_ticket",
            reason: "随意创建一个异常工单",
            evidenceIds: refs,
          }),
        ),
      /不支持新建异常工单/,
    );
  } finally {
    store.close();
  }
});
test("未引用、失败、旧轮次证据不成为事实", () => {
  const { store, task, refs } = observed(orderIds.failed);
  try {
    assert.equal(assess(task, []).facts.length, 0);
    task.epoch++;
    assert.equal(assess(task, refs).finding, "insufficient_evidence");
    assert.equal(assess(task, refs).facts.length, 0);
  } finally {
    store.close();
  }
});
test("结束调查也必须复核观察版本", () => {
  const { store, actor, task, tools, refs } = observed(orderIds.paid);
  try {
    const order = store.order(actor, orderIds.paid);
    store.put("order", order.id, {
      ...order,
      status: "closed",
      version: order.version + 1,
    });
    assert.throws(
      () =>
        tools.run(
          task,
          actor,
          "finish",
          JSON.stringify({
            summary: "后台已经支付，无需修改",
            disposition: "resolved",
            finding: "backend_paid",
            evidenceIds: refs,
          }),
        ),
      /业务状态变化/,
    );
  } finally {
    store.close();
  }
});
test("重新查询不会让未更新的引用快照重新生效", () => {
  const { store, actor, task, tools, refs } = observed(orderIds.paid);
  try {
    const order = store.order(actor, orderIds.paid);
    store.put("order", order.id, {
      ...order,
      status: "closed",
      version: order.version + 1,
    });
    tools.run(task, actor, "get_order", JSON.stringify({ orderId: order.id }));
    assert.throws(
      () =>
        tools.run(
          task,
          actor,
          "finish",
          JSON.stringify({
            summary: "后台已经支付，无需修改",
            disposition: "resolved",
            finding: "backend_paid",
            evidenceIds: refs,
          }),
        ),
      /业务状态变化/,
    );
    const currentRefs = task.evidence.map((e) => e.id);
    assert.equal(assess(task, currentRefs).finding, "manual_review");
  } finally {
    store.close();
  }
});
