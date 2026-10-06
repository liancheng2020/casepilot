import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RequestBudget } from "../server/request-budget.js";

test("总预算跨实例和重启保留，不能绕过或隐式增加上限", () => {
  const dir = mkdtempSync(join(tmpdir(), "casepilot-budget-")),
    path = join(dir, "budget.sqlite");
  const a = new RequestBudget(path, 3),
    b = new RequestBudget(path, 3);
  try {
    a.reserve();
    b.reserve();
    assert.equal(b.snapshot().used, 2);
    a.reserve();
    assert.throws(() => b.reserve(), /总请求预算已用尽/);
    assert.throws(() => new RequestBudget(path, 4), /不能隐式重置/);
  } finally {
    a.close();
    b.close();
  }
  const resumed = new RequestBudget(path, 3);
  try {
    assert.deepEqual(resumed.snapshot(), { limit: 3, used: 3, remaining: 0 });
  } finally {
    resumed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
