import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CaseService, actorById } from "../server/service.js";
import { MockProvider } from "../server/providers.js";
import {
  DingTalkAdapter,
  taskReply,
  validatedWebhook,
} from "../server/dingtalk.js";
import { orderIds } from "../server/fixtures.js";
import { loadConfig } from "../server/config.js";

function setup() {
  const store = new Store();
  const service = new CaseService(store, { mock: new MockProvider() });
  const adapter = new DingTalkAdapter(service, {
    DINGTALK_CORP_ID: "demo-corp",
    actorMap: { "staff-service": "service", "staff-operations": "operations" },
    AGENT_MODE: "mock",
    PUBLIC_BASE_URL: "http://localhost:5188",
  });
  return { store, service, adapter };
}
const message = (content: string, staff = "staff-service") => ({
  msgId: randomUUID(),
  senderStaffId: staff,
  senderCorpId: "demo-corp",
  sessionWebhook: "https://oapi.dingtalk.com/robot/send?access_token=synthetic",
  sessionWebhookExpiredTime: Date.now() + 100000,
  msgtype: "text",
  text: { content },
});

test("钉钉消息重投使用同一任务，未知员工和组织被拒绝", () => {
  const { store, adapter } = setup();
  try {
    const input = message(`订单 ${orderIds.delayed} 支付异常`);
    const first = adapter.accept(input);
    assert.equal(adapter.accept(input).task.id, first.task.id);
    assert.throws(
      () =>
        adapter.accept({ ...input, senderStaffId: "unknown", isAdmin: true }),
      /员工未授权/,
    );
    assert.throws(
      () => adapter.accept({ ...input, senderCorpId: "another-corp" }),
      /组织未授权/,
    );
  } finally {
    store.close();
  }
});

test("钉钉补充信息与确认复用后端授权，命令重投不重复处置", async () => {
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
      "staff-operations",
    );
    assert.equal(adapter.accept(approval).task.status, "completed");
    adapter.accept(approval);
    assert.equal(
      store.order(actorById("service"), orderIds.delayed).version,
      2,
    );
    assert.match(
      taskReply(task, "http://localhost:5188"),
      /规则模拟器（非模型）/,
    );
  } finally {
    store.close();
  }
});

test("回复地址拒绝SSRF、重定向目标和非钉钉域名", () => {
  assert.throws(
    () => validatedWebhook("http://127.0.0.1:8080/robot/send"),
    /安全校验/,
  );
  assert.throws(
    () => validatedWebhook("https://oapi.dingtalk.com.evil.test/robot/send"),
    /安全校验/,
  );
  assert.throws(
    () => validatedWebhook("https://oapi.dingtalk.com/other"),
    /安全校验/,
  );
});

test("非本机部署必须设置访问令牌，配置错误不能自动降级", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /WEB_ACCESS_TOKEN/);
  assert.throws(
    () => loadConfig({ AGENT_MODE: "deepseek" }),
    /DEEPSEEK_API_KEY/,
  );
  assert.throws(() => loadConfig({ DINGTALK_ENABLED: "true" }), /应用凭证/);
});
