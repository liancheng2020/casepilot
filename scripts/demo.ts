import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    model: { type: "boolean" },
    feishu: { type: "boolean" },
    "reuse-sift-key": { type: "boolean" },
    port: { type: "string", default: "5190" },
    "budget-file": { type: "string", default: "artifacts/model-budget.sqlite" },
    "max-requests": { type: "string", default: "10" },
  },
});
if (values["reuse-sift-key"] && !values.model)
  throw new Error("复用 Key 必须显式选择模型模式");
const port = z.coerce.number().int().min(1).max(65535).parse(values.port);
const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(10000)
  .parse(values["max-requests"]);
const credentials = values["reuse-sift-key"]
  ? parse(readFileSync(resolve("../sift/.env"), "utf8"))
  : process.env;
if (values.model && !credentials.DEEPSEEK_API_KEY)
  throw new Error("真实模型未配置，未降级为规则模式");
if (
  values.feishu &&
  (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
)
  throw new Error("飞书应用凭证缺失");
const root = resolve("data/demos");
mkdirSync(root, { recursive: true });
const dataDir = mkdtempSync(join(root, "session-"));
console.log(
  `隔离演示目录：${dataDir}\n工作台：http://localhost:${port}\n不会清空已有数据；退出后保留本次演示记录。${values.feishu ? " 请先停止使用同一飞书应用的旧服务。" : " 飞书在本次演示中关闭。"}`,
);
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    AGENT_MODE: values.model ? "deepseek" : "mock",
    DEEPSEEK_API_KEY: values.model ? credentials.DEEPSEEK_API_KEY : "",
    WEB_ACCESS_TOKEN: "",
    FEISHU_ENABLED: values.feishu ? "true" : "false",
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    MODEL_BUDGET_FILE: values.model ? resolve(values["budget-file"]!) : "",
    MAX_TOTAL_MODEL_REQUESTS: String(limit),
  },
});
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", () => {
  console.error("隔离演示服务启动失败");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
