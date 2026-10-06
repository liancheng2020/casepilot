import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { CaseService } from "../server/service.js";
import { MockProvider } from "../server/providers.js";
import { createApp } from "../server/app.js";
import { scenarios } from "../server/fixtures.js";

test("API任务、访问控制、请求结构、同源检查和证据导出", async () => {
  const store = new Store();
  const service = new CaseService(store, { mock: new MockProvider() });
  const token = "synthetic-access-token-at-least-24";
  const server = createServer(
    createApp(service, {
      WEB_ACCESS_TOKEN: token,
      AGENT_MODE: "mock",
      FEISHU_ENABLED: "false",
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers })).status, 200);
    const input = {
      complaint: scenarios[0].complaint,
      mode: "mock",
      requestId: randomUUID(),
    };
    const response = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 202);
    const task = (await response.json()) as { id: string };
    await service.drain();
    assert.equal(
      (
        await fetch(`${base}/api/tasks/${task.id}`, {
          headers: { ...headers, "X-Demo-Actor": "other-store" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/api/tasks`, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/tasks`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, approve: true }),
        })
      ).status,
      400,
    );
    const record = service.store.task(task.id);
    assert.equal(
      (
        await fetch(`${base}/api/tasks/${task.id}/approve`, {
          method: "POST",
          headers,
          body: JSON.stringify({ proposalId: record.proposal!.id }),
        })
      ).status,
      403,
    );
    const exported = await fetch(`${base}/api/tasks/${task.id}/export`, {
      headers,
    });
    assert.match(exported.headers.get("content-disposition")!, /attachment/);
    assert.equal(
      ((await exported.json()) as { dataSource: string }).dataSource,
      "synthetic",
    );
    assert.equal((await fetch(`${base}/api/unknown`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
