import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { orderIds } from "../server/fixtures.js";

test(
  "隔离演示默认关闭模型与飞书，每次新建数据而不修改原目录",
  { timeout: 30000 },
  async () => {
    const original = mkdtempSync(join(tmpdir(), "casepilot-demo-test-"));
    const created: string[] = [];
    try {
      for (let run = 0; run < 2; run++) {
        const socket = createServer();
        await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
        const port = (socket.address() as { port: number }).port;
        await new Promise<void>((done) => socket.close(() => done()));
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/demo.ts", "--port", String(port)],
          {
            env: {
              ...process.env,
              DATA_DIR: original,
              FEISHU_ENABLED: "true",
              AGENT_MODE: "deepseek",
              DEEPSEEK_API_KEY: "test-key-must-not-be-used",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
        });
        try {
          const base = `http://127.0.0.1:${port}`;
          let ready = false;
          for (let i = 0; i < 100; i++) {
            assert.equal(child.exitCode, null, output);
            if (output.includes("CasePilot:")) {
              ready = true;
              break;
            }
            await new Promise((done) => setTimeout(done, 100));
          }
          assert.ok(ready, output);
          const dir = output.match(/隔离演示目录：([^\n]+)/)?.[1];
          assert.ok(dir);
          assert.ok(dir.startsWith(resolve("data/demos/session-")));
          assert.ok(!created.includes(dir));
          created.push(dir);
          const config = await (await fetch(`${base}/api/config`)).json();
          assert.equal(config.defaultMode, "mock");
          assert.equal(config.modelConfigured, false);
          assert.equal(config.feishu.enabled, false);
          assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), []);
          const orders = await (await fetch(`${base}/api/orders`)).json();
          assert.equal(
            orders.find((o: { id: string }) => o.id === orderIds.delayed)
              .status,
            "pending",
          );
          assert.equal(existsSync(join(original, "casepilot.sqlite")), false);
        } finally {
          if (child.exitCode === null) {
            await new Promise<void>((done) => {
              const force = setTimeout(() => child.kill("SIGKILL"), 3000);
              child.once("exit", () => {
                clearTimeout(force);
                done();
              });
              child.kill("SIGTERM");
            });
          }
        }
      }
    } finally {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
      rmSync(original, { recursive: true, force: true });
    }
  },
);
