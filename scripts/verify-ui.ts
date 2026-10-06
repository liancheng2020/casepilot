import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { orderIds, scenarios } from "../server/fixtures.js";
import type { Task } from "../server/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "casepilot-ui-"));
const port = Number(process.env.UI_TEST_PORT || 5199);
const base = `http://127.0.0.1:${port}`;
const output = resolve("artifacts");
mkdirSync(output, { recursive: true });
let child: ChildProcess | undefined;
let serverOutput = "";
async function start() {
  serverOutput = "";
  child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--production"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: "127.0.0.1",
        AGENT_MODE: "mock",
        DEEPSEEK_API_KEY: "",
        WEB_ACCESS_TOKEN: "",
        FEISHU_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error(`Test server exited: ${serverOutput}`);
    if (!serverOutput.includes("CasePilot:")) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test server failed to start");
}
async function stop() {
  const current = child;
  child = undefined;
  if (!current || current.exitCode !== null) return;
  await new Promise<void>((done) => {
    current.once("exit", () => done());
    current.kill("SIGTERM");
  });
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Demo-Actor": "operations",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(res.ok, `${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const task = await api<Task>(`/tasks/${id}`);
    if (!["queued", "investigating"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Task did not settle");
}
let browser: Browser | undefined;
const errors: string[] = [];
const checks: string[] = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  await start();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "开始调查" }).click();
  await page.getByRole("heading", { name: "对账补偿提案" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "确认并执行" }).isDisabled(),
    true,
  );
  checks.push("客服不能审批");
  await page.locator(".actor-select select").selectOption("operations");
  await page.getByRole("button", { name: "确认并执行" }).waitFor();
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: /工具证据/ }).click();
  assert.ok((await page.locator(".evidence-list details").count()) >= 6);
  checks.push("工具证据可查看");
  await page.getByRole("tab", { name: /调查记录/ }).click();
  await page.getByLabel("模拟执行响应丢失").check();
  await page.getByRole("button", { name: "确认并执行" }).click();
  await page.getByRole("button", { name: "核对结果" }).waitFor();
  checks.push("响应丢失不声称完成");
  const task = (await api<Task[]>("/tasks"))[0];
  await stop();
  await start();
  await page.reload();
  await page.getByRole("heading", { name: "处理记录" }).waitFor();
  assert.equal((await api<Task>(`/tasks/${task.id}`)).result?.verified, true);
  checks.push("进程重启恢复并核验原执行记录");
  const changed = await api<Task>("/tasks", {
    complaint: scenarios[0].complaint.replace(
      orderIds.delayed,
      orderIds.ambiguousA,
    ),
    mode: "mock",
    requestId: randomUUID(),
  });
  const changedTask = await settled(changed.id);
  await api(`/tasks/${changed.id}/fault`, { fault: "close_order" });
  const conflict = await api<Task>(`/tasks/${changed.id}/approve`, {
    proposalId: changedTask.proposal!.id,
  });
  assert.equal(conflict.status, "conflict");
  checks.push("并发状态变化拒绝旧提案");
  await page.goto(`${base}/?task=${changed.id}`);
  await page.getByRole("button", { name: "重新调查" }).waitFor();
  await page.getByRole("button", { name: "重新调查" }).click();
  await page.getByRole("heading", { name: "异常工单提案" }).waitFor();
  checks.push("重新调查得到新处置分支");
  await page.getByRole("button", { name: "案例库" }).click();
  assert.ok((await page.locator("tbody tr").count()) >= 12);
  await page.getByRole("button", { name: "演示订单" }).click();
  assert.ok((await page.locator("tbody tr").count()) >= 10);
  await page.getByRole("button", { name: /处置工作台/ }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("导出执行记录").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /casepilot/);
  checks.push("执行记录可导出");
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
  });
  mobile.on("pageerror", (e) => errors.push(e.message));
  await mobile.goto(`${base}/?task=${changed.id}`);
  await mobile.getByRole("heading", { name: "异常工单提案" }).waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const icon = await mobile.getByTitle("刷新数据").boundingBox();
  const svg = await mobile.getByTitle("刷新数据").locator("svg").boundingBox();
  assert.ok(
    icon &&
      svg &&
      Math.abs(icon.x + icon.width / 2 - svg.x - svg.width / 2) < 1 &&
      Math.abs(icon.y + icon.height / 2 - svg.y - svg.height / 2) < 1,
  );
  await mobile.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  checks.push("390px移动视口无横向溢出，刷新图标居中");
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    errors,
    passed: errors.length === 0,
    dataSource: "synthetic",
    model: "mock",
    actualProcessRestart: true,
    browserVersion: browser.version(),
    nodeVersion: process.version,
    viewports: [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
  };
  writeFileSync(
    join(output, "ui-verification.json"),
    JSON.stringify(report, null, 2),
  );
  assert.deepEqual(errors, []);
  console.log(
    `UI: ${checks.length} checks passed, no browser errors. Screenshots: ${output}`,
  );
} finally {
  await browser?.close();
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
}
