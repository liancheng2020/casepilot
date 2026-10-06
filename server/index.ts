import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import express from "express";
import lockfile from "proper-lockfile";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { CaseService } from "./service.js";
import { DeepSeekProvider, MockProvider } from "./providers.js";
import { createApp } from "./app.js";
import { startDingTalk } from "./dingtalk.js";

const cfg = loadConfig();
mkdirSync(cfg.DATA_DIR, { recursive: true });
let release: (() => Promise<void>) | undefined;
try {
  release = await lockfile.lock(cfg.DATA_DIR, { stale: 10000, retries: 0 });
} catch {
  console.error(
    "数据目录已被另一个 CasePilot 服务占用。请关闭旧服务，或使用不同 DATA_DIR；异常退出后等待约10秒重试。",
  );
  process.exit(1);
}
const store = new Store(resolve(cfg.DATA_DIR, "casepilot.sqlite"));
const service = new CaseService(
  store,
  {
    mock: new MockProvider(),
    ...(cfg.DEEPSEEK_API_KEY
      ? {
          deepseek: new DeepSeekProvider({
            apiKey: cfg.DEEPSEEK_API_KEY,
            baseURL: cfg.DEEPSEEK_BASE_URL,
            model: cfg.DEEPSEEK_MODEL,
            timeout: cfg.MODEL_TIMEOUT_MS,
          }),
        }
      : {}),
  },
  { modelRequests: cfg.MAX_MODEL_REQUESTS, toolCalls: cfg.MAX_TOOL_CALLS },
);
const app = createApp(service, cfg);
const server = createServer(app);
let closeVite: (() => Promise<void>) | undefined;
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get(/.*/, (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
let bot: Awaited<ReturnType<typeof startDingTalk>> | undefined;
server.on("error", async (error) => {
  console.error(
    "服务启动失败：",
    (error as NodeJS.ErrnoException).code || "unknown",
  );
  await release?.();
  store.close();
  process.exit(1);
});
server.listen(cfg.PORT, cfg.HOST, async () => {
  console.log(
    `CasePilot: http://${cfg.HOST}:${cfg.PORT} · 合成订单 · ${cfg.AGENT_MODE === "mock" ? "规则模拟器（非真实模型）" : "DeepSeek Tool Calling"}`,
  );
  service.recover();
  void service.drain();
  try {
    bot = await startDingTalk(service, cfg);
    if (bot.enabled)
      console.log("钉钉 Stream 已启动；真实平台联调需使用授权测试应用。");
  } catch {
    console.error(
      "钉钉连接失败，Web 工作台仍可使用；请检查应用配置与网络。密钥未记录。",
    );
  }
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  bot?.close();
  server.close();
  await closeVite?.();
  await release?.();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
