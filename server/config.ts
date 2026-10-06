import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5188),
  DATA_DIR: z.string().default("./data"),
  AGENT_MODE: z.enum(["mock", "deepseek"]).default("mock"),
  MAX_MODEL_REQUESTS: z.coerce.number().int().min(1).max(30).default(12),
  MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(60).default(24),
  MODEL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(25000),
  DEEPSEEK_API_KEY: z.string().default(""),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-flash"),
  WEB_ACCESS_TOKEN: z.string().default(""),
  DINGTALK_ENABLED: z.enum(["true", "false"]).default("false"),
  DINGTALK_CLIENT_ID: z.string().default(""),
  DINGTALK_CLIENT_SECRET: z.string().default(""),
  DINGTALK_CORP_ID: z.string().default(""),
  DINGTALK_ACTOR_MAP: z.string().default("{}"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:5188"),
});
export function loadConfig(env = process.env) {
  const cfg = schema.parse(env);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(cfg.HOST) &&
    cfg.WEB_ACCESS_TOKEN.length < 24
  )
    throw new Error(
      "非本机部署必须设置至少24位 WEB_ACCESS_TOKEN；本项目不是生产身份认证系统。",
    );
  if (cfg.AGENT_MODE === "deepseek" && !cfg.DEEPSEEK_API_KEY)
    throw new Error(
      "真实模型模式缺少 DEEPSEEK_API_KEY；不能自动降级为模拟模式。",
    );
  if (
    cfg.DINGTALK_ENABLED === "true" &&
    (!cfg.DINGTALK_CLIENT_ID || !cfg.DINGTALK_CLIENT_SECRET)
  )
    throw new Error("钉钉启用但缺少应用凭证。");
  const actorMap = z
    .record(z.string(), z.enum(["service", "operations", "other-store"]))
    .parse(JSON.parse(cfg.DINGTALK_ACTOR_MAP));
  if (
    cfg.DINGTALK_ENABLED === "true" &&
    (!cfg.DINGTALK_CORP_ID || !Object.keys(actorMap).length)
  )
    throw new Error("钉钉启用需配置组织 ID 和明确的员工身份映射。");
  return { ...cfg, DATA_DIR: resolve(cfg.DATA_DIR), actorMap };
}
export type Config = ReturnType<typeof loadConfig>;
