import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DeepSeekProvider, MockProvider } from "../server/providers.js";
import { Store } from "../server/store.js";
import { actorById, CaseService } from "../server/service.js";
import { scenarios } from "../server/fixtures.js";

test("DeepSeek协议：非思考模式、工具映射、用量和请求预算（本地模拟API）", async () => {
  let count = 0;
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    count++;
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_fixture",
                  type: "function",
                  function: {
                    name: "get_order",
                    arguments: JSON.stringify({
                      orderId: "9223372036854775801",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new Store();
  try {
    const service = new CaseService(store, { mock: new MockProvider() });
    const task = service.create(actorById("service"), {
      complaint: scenarios[0].complaint,
      mode: "mock",
      requestId: randomUUID(),
    });
    const provider = new DeepSeekProvider({
      apiKey: "test-only-not-a-real-key",
      model: "deepseek-flash",
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      requestBudget: 1,
    });
    const response = await provider.decide(task);
    assert.equal(requests[0].reasoning_effort, "none");
    assert.equal(requests[0].tool_choice, "required");
    assert.equal(response.calls[0].name, "get_order");
    assert.equal(response.promptTokens, 80);
    assert.equal(response.completionTokens, 20);
    await assert.rejects(provider.decide(task), /验证预算/);
    assert.equal(count, 1);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("模型API失败不隐藏重试、不泄漏响应里的密钥、不回退模拟器", async () => {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "private-test-secret" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new Store();
  try {
    const provider = new DeepSeekProvider({
      apiKey: "test-only-not-a-real-key",
      model: "deepseek-flash",
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const service = new CaseService(store, { deepseek: provider });
    const actor = actorById("service");
    const task = service.create(actor, {
      complaint: scenarios[0].complaint,
      mode: "deepseek",
      requestId: randomUUID(),
    });
    const result = await service.agent.investigate(task.id, actor);
    assert.equal(result.status, "handoff");
    assert.equal(result.usage.toolCalls, 0);
    assert.equal(count, 1);
    assert.equal(JSON.stringify(result).includes("private-test-secret"), false);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
