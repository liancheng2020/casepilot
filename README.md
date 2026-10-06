# CasePilot

面向客服与运营的订单支付异常调查与处置 Agent。根据客户描述和工具反馈开展多轮调查，信息不足时追问，经运营确认后执行处置并核验结果。

内置独立测试订单与模拟支付接口，支持 DeepSeek 原生 Tool Calling 和飞书私聊；未连接生产订单或真实支付渠道。不配 Key 时使用明确标识的规则基线，不冒充模型决策。

![订单支付异常工作台](docs/assets/workbench.png)

[观看三段操作演示](docs/assets/interview-demo.webm) · [验证范围与结果](docs/VALIDATION.md)

## 快速运行

需要 Node.js >=22.13，推荐 Node.js 24。

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

打开 http://localhost:5188。真实模型模式需在 `.env` 设置 `DEEPSEEK_API_KEY` 和 `AGENT_MODE=deepseek` 后重启。默认模型为 `deepseek-flash`；不要提交 `.env`。

独立演示：`npm run demo`，打开 http://localhost:5190。每次新建数据目录，默认关闭模型与飞书，保留已有记录。

## 核心能力

- **多轮调查**：查询订单、支付、回调与工单；缺号或多个候选时暂停并追问。
- **受控处置**：符合规则才建议对账补偿；关单、退款或金额冲突转异常工单。模型无直接写入权限。
- **审批与恢复**：执行前复核身份、版本和规则；重复确认复用原动作，结果未知时查账本，不盲目重放。
- **证据工作台**：事实、判断、未确定项与执行结果分开展示；模型原始解释另列，不作为权威结论。

演示覆盖正常处置、响应丢失恢复、审批时状态变化；具体步骤见[演示指南](docs/INTERVIEW.md#三分钟演示)。不包含完整退货、物流或自动退款业务。

## 验证

运行 `npm test`、`npm run build` 和 `npm run eval`；界面验证先运行 `npx playwright install chromium`，再运行 `npm run test:ui`。

已验证 55 项测试、12 个规则案例、16 次真实模型调查及飞书完整闭环，详见[验证记录](docs/VALIDATION.md)。`npm run eval:model` 需要模型配置并产生费用，默认最多 10 次请求；失败计数、重启不清零，报告保存至 `artifacts/`。

## 飞书与部署

飞书采用 SDK 长连接与私聊文字命令，无需公网回调；按[飞书配置](docs/ARCHITECTURE.md#飞书入口)设置应用权限和身份映射。

部署需要常驻 Node.js 服务与持久数据目录，不适合直接部署到 Vercel Serverless。远程运行须配置访问令牌和 HTTPS；详见[部署说明](docs/ARCHITECTURE.md#部署)。

技术栈：TypeScript、Vue 3、Express、Node.js SQLite、Zod、DeepSeek Tool Calling、飞书 WebSocket。

[架构与边界](docs/ARCHITECTURE.md) · [面试与演示](docs/INTERVIEW.md)
