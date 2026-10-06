import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CaseService, actorById } from "../server/service.js";
import { MockProvider } from "../server/providers.js";
import {
  FeishuAdapter,
  parseMessage,
  notificationId,
  taskReply,
} from "../server/feishu.js";
import { orderIds } from "../server/fixtures.js";
import { loadConfig } from "../server/config.js";

function setup() {
  const store = new Store();
  const service = new CaseService(store, { mock: new MockProvider() });
  const adapter = new FeishuAdapter(service, {
    FEISHU_TENANT_KEY: "demo_org",
    AGENT_MODE: "mock",
    actorMap: {
      ou_service: "service",
      ou_operations: "operations",
      ou_other: "other-store",
    },
  });
  return { store, service, adapter };
}
const message = (text: string, openId = "ou_service") => ({
  sender: {
    sender_id: { open_id: openId },
    sender_type: "user",
    tenant_key: "demo_org",
  },
  message: {
    message_id: `om_${randomUUID().replaceAll("-", "")}`,
    chat_id: `oc_${openId}`,
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text }),
  },
});

test("飞书消息重投使用同一任务，未知用户和组织被拒绝", () => {
  const { store, adapter } = setup();
  try {
    const input = message(`订单 ${orderIds.delayed} 支付异常`);
    const first = adapter.accept(input);
    assert.equal(first.task.channel, "feishu");
    assert.equal(adapter.accept(input).task.id, first.task.id);
    assert.throws(
      () => adapter.accept(message("支付异常", "ou_unknown")),
      /用户未授权/,
    );
    assert.throws(
      () =>
        adapter.accept({
          ...input,
          sender: { ...input.sender, tenant_key: "another_org" },
        }),
      /组织未授权/,
    );
    assert.equal(store.tasks().length, 1);
  } finally {
    store.close();
  }
});

test("飞书补充与确认复用后端授权，命令重投不重复处置", async () => {
  const { store, service, adapter } = setup();
  try {
    const initial = adapter.accept(message("客户说已经付款了，帮忙查一下"));
    await service.drain();
    const reply = message(`补充 ${initial.task.id} ${orderIds.delayed}`);
    adapter.accept(reply);
    adapter.accept(reply);
    await service.drain();
    const task = store.task(initial.task.id);
    assert.equal(task.status, "awaiting_approval");
    assert.throws(
      () => adapter.accept(message(`确认 ${task.id} ${task.proposal!.id}`)),
      /运营身份/,
    );
    const approval = message(
      `确认 ${task.id} ${task.proposal!.id}`,
      "ou_operations",
    );
    const approved = adapter.accept(approval);
    assert.equal(approved.task.status, "completed");
    assert.equal(approved.updated, true);
    assert.equal(adapter.accept(approval).updated, false);
    assert.equal(
      store.order(actorById("service"), orderIds.delayed).version,
      2,
    );
    assert.match(
      taskReply(task, "http://localhost:5188"),
      /规则模拟器（非模型）/,
    );
    const preview = taskReply(task, "http://localhost:5188");
    assert.ok(preview.includes(`订单：${orderIds.delayed}`));
    assert.ok(preview.includes(`依据：${task.proposal!.reason}`));
    assert.ok(preview.includes(`有效期：${task.proposal!.expiresAt}`));
    const bindings = store.get<Record<string, unknown>>(
      "feishu-binding",
      task.id,
    )!;
    assert.deepEqual(Object.keys(bindings).sort(), [
      "ou_operations",
      "ou_service",
    ]);
    assert.equal(
      adapter.accept(message(`查询 ${task.id}`, "ou_operations")).task.status,
      "completed",
    );
    assert.throws(
      () => adapter.accept(message(`查询 ${task.id}`, "ou_other")),
      /任务不存在/,
    );
  } finally {
    store.close();
  }
});

test("机器人和群聊不进入业务，畸形内容不创建任务", () => {
  const { store, adapter } = setup();
  try {
    const input = message("支付异常");
    assert.throws(() =>
      adapter.accept({
        ...input,
        sender: { ...input.sender, sender_type: "app" },
      }),
    );
    for (const change of [
      { chat_type: "group" },
      { message_type: "image" },
      { content: "not JSON" },
      { content: JSON.stringify({ text: " " }) },
      { chat_id: "https://evil.test" },
    ])
      assert.throws(() =>
        adapter.accept({ ...input, message: { ...input.message, ...change } }),
      );
    assert.throws(() => adapter.accept(message("确认 broken id")), /命令格式/);
    assert.throws(
      () => adapter.accept(message(`${randomUUID()} ${orderIds.delayed}`)),
      /缺少动作/,
    );
    assert.throws(() => adapter.accept(message("reply broken id")), /命令格式/);
    assert.equal(store.tasks().length, 0);
  } finally {
    store.close();
  }
});

test("英文命令与中文命令共用权限、补充去重和审批幂等", async () => {
  const { store, service, adapter } = setup();
  try {
    const initial = adapter.accept(message("付款后未更新，请帮忙查询"));
    await service.drain();
    const reply = message(`REPLY ${initial.task.id} ${orderIds.delayed}`);
    adapter.accept(reply);
    adapter.accept(reply);
    await service.drain();
    const task = store.task(initial.task.id);
    assert.equal(task.status, "awaiting_approval");
    assert.throws(
      () => adapter.accept(message(`approve ${task.id} ${task.proposal!.id}`)),
      /运营身份/,
    );
    const approved = adapter.accept(
      message(`approve ${task.id} ${task.proposal!.id}`, "ou_operations"),
    );
    assert.equal(approved.task.result?.verified, true);
    assert.equal(
      adapter.accept(
        message(`确认 ${task.id} ${task.proposal!.id}`, "ou_operations"),
      ).task.result?.actionId,
      approved.task.result?.actionId,
    );
    assert.equal(
      adapter.accept(message(`query ${task.id}`)).task.status,
      "completed",
    );
    assert.equal(
      store.order(actorById("service"), orderIds.delayed).version,
      2,
    );
  } finally {
    store.close();
  }
});

test("空授权名单只能发现自己的身份，不能执行业务", () => {
  const store = new Store();
  const service = new CaseService(store, { mock: new MockProvider() });
  const adapter = new FeishuAdapter(service, {
    FEISHU_TENANT_KEY: "",
    actorMap: {},
    AGENT_MODE: "mock",
  });
  try {
    assert.equal(parseMessage(message("身份")).openId, "ou_service");
    assert.throws(() => adapter.accept(message("支付异常")), /组织未授权/);
    assert.equal(store.tasks().length, 0);
  } finally {
    store.close();
  }
});

test("通知去重 ID 稳定且不同用户和版本相互隔离", () => {
  const binding = {
    chatId: "oc_service",
    openId: "ou_service",
    tenantKey: "demo_org",
  };
  const id = notificationId(binding, "task:1");
  assert.equal(id, notificationId(binding, "task:1"));
  assert.notEqual(id, notificationId(binding, "task:2"));
  assert.notEqual(
    id,
    notificationId({ ...binding, openId: "ou_operations" }, "task:1"),
  );
  assert.ok(id.length <= 50);
});

test("非本机部署必须设置访问令牌，配置错误不能自动降级", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /WEB_ACCESS_TOKEN/);
  assert.throws(
    () => loadConfig({ AGENT_MODE: "deepseek" }),
    /DEEPSEEK_API_KEY/,
  );
  assert.throws(() => loadConfig({ FEISHU_ENABLED: "true" }), /应用凭证/);
  const cfg = loadConfig({
    FEISHU_ENABLED: "true",
    FEISHU_APP_ID: "test",
    FEISHU_APP_SECRET: "test",
  });
  assert.deepEqual(cfg.actorMap, {});
});
