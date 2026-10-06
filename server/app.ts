import express from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { actors, scenarios } from "./fixtures.js";
import { AppError, errorResult } from "./errors.js";
import { actorById, CaseService } from "./service.js";
import type { Config } from "./config.js";

export function createApp(
  service: CaseService,
  cfg: Pick<Config, "WEB_ACCESS_TOKEN" | "AGENT_MODE" | "DINGTALK_ENABLED">,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (!req.path.startsWith("/api")) return next();
    res.setHeader("Cache-Control", "no-store");
    if (cfg.WEB_ACCESS_TOKEN) {
      const supplied = Buffer.from(
        req.get("Authorization")?.replace(/^Bearer /, "") || "",
      );
      const expected = Buffer.from(cfg.WEB_ACCESS_TOKEN);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return res
          .status(401)
          .json({
            error: {
              code: "ACCESS_TOKEN_REQUIRED",
              message: "请输入演示访问令牌。",
            },
          });
    }
    if (req.method !== "GET") {
      const origin = req.get("Origin");
      if (origin && new URL(origin).host !== req.get("Host"))
        return res
          .status(403)
          .json({
            error: {
              code: "ORIGIN_DENIED",
              message: "不允许跨站修改演示数据。",
            },
          });
      if (!req.is("application/json"))
        return res
          .status(415)
          .json({
            error: { code: "JSON_REQUIRED", message: "仅接受 JSON 请求。" },
          });
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const actor = (req: express.Request) =>
    actorById(req.get("X-Demo-Actor") || "service");
  app.get("/api/config", (_req, res) =>
    res.json({
      actors,
      scenarios,
      defaultMode: cfg.AGENT_MODE,
      modelConfigured: Boolean(service.providers.deepseek),
      dataSource: "synthetic",
      dingtalk: {
        enabled: cfg.DINGTALK_ENABLED === "true",
        transport: "stream",
        interaction: "text_commands",
        liveVerified: false,
      },
      auth: "shared_demo_access_and_demo_actors_not_production_auth",
    }),
  );
  app.get("/api/tasks", (req, res) =>
    res.json(service.store.tasks(actor(req))),
  );
  app.get("/api/tasks/:id", (req, res) =>
    res.json(service.store.task(String(req.params.id), actor(req))),
  );
  app.get("/api/orders", (req, res) =>
    res.json(
      service.store
        .all<import("./types.js").Order>("order")
        .filter((o) => o.tenantId === actor(req).tenantId),
    ),
  );
  app.post("/api/tasks", (req, res) => {
    const input = z
      .object({
        complaint: z.string().trim().min(4).max(4000),
        mode: z.enum(["mock", "deepseek"]),
        requestId: z.string().min(8).max(100),
        fault: z.enum(["query_timeout", "query_unavailable"]).optional(),
      })
      .strict()
      .parse(req.body);
    const task = service.create(actor(req), input);
    res.status(202).json(service.store.task(task.id, actor(req)));
    void service.drain();
  });
  app.post("/api/tasks/:id/reply", (req, res) => {
    const { content } = z
      .object({ content: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(req.body);
    res.json(service.reply(actor(req), String(req.params.id), content));
    void service.drain();
  });
  app.post("/api/tasks/:id/restart", (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(service.restart(actor(req), String(req.params.id)));
    void service.drain();
  });
  app.post("/api/tasks/:id/cancel", (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(service.cancel(actor(req), String(req.params.id)));
  });
  app.post("/api/tasks/:id/approve", (req, res) => {
    const { proposalId, simulateLostResponse } = z
      .object({
        proposalId: z.uuid(),
        simulateLostResponse: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    res.json(
      service.approve(
        actor(req),
        String(req.params.id),
        proposalId,
        simulateLostResponse,
      ),
    );
  });
  app.post("/api/tasks/:id/reject", (req, res) => {
    const { proposalId } = z
      .object({ proposalId: z.uuid() })
      .strict()
      .parse(req.body);
    res.json(service.reject(actor(req), String(req.params.id), proposalId));
  });
  app.post("/api/tasks/:id/verify", (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(service.verify(actor(req), String(req.params.id)));
  });
  app.post("/api/tasks/:id/fault", (req, res) => {
    const { fault } = z
      .object({ fault: z.enum(["close_order", "payment_refunded"]) })
      .strict()
      .parse(req.body);
    res.json(service.fault(actor(req), String(req.params.id), fault));
  });
  app.get("/api/tasks/:id/export", (req, res) => {
    const task = service.store.task(String(req.params.id), actor(req));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="casepilot-${task.id}.json"`,
    );
    res.json({
      exportedAt: new Date().toISOString(),
      dataSource: "synthetic",
      modelMode: task.mode,
      task,
    });
  });
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return res
          .status(400)
          .json({
            error: {
              code: "INVALID_REQUEST",
              message: "请求字段或 JSON 格式不正确。",
            },
          });
      res
        .status(error instanceof AppError ? error.status : 500)
        .json({ error: errorResult(error) });
    },
  );
  return app;
}
