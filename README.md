# CasePilot

面向订单支付异常的垂直 Agent：把客户描述转成可核查的调查过程，依据工具反馈选择后续查询，提出处置建议，经运营确认后执行并回查结果。

**个人项目，借鉴拾味篮子业务场景；订单、支付渠道和工单均为合成沙盒，不代表公司上线或真实支付接入。** 默认运行规则模拟器，界面明确标识来源；真实模式使用 DeepSeek 原生 Tool Calling，不自动降级。

![订单异常处置工作台](docs/assets/workbench.png)

[观看三段操作演示](docs/assets/interview-demo.webm) · [验证范围与结果](docs/VALIDATION.md)

## 快速运行

需要 Node.js >=22.13，推荐 Node.js 24；Node.js 16 不支持本项目使用的 `node:sqlite`。

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

打开 http://localhost:5188。不配 Key 也可以演示规则基线；它不等于模型 Agent。

真实模型：在 `.env` 设置 `DEEPSEEK_API_KEY` 和 `AGENT_MODE=deepseek`，重启服务。默认模型 `deepseek-flash`，单任务最多 12 次请求、24 次工具调用；错误不会伪装为模拟成功。不要提交 `.env`。

## 演示主线

```bash
npm run demo
```

打开 http://localhost:5190。每次启动新建独立数据目录，保留旧记录；默认关闭模型调用和飞书，不会清空已有订单。

1. **正常闭环**：调查回调缺失订单，查看有来源的事实与尚未确定项；运营确认后回查订单。
2. **结果未知**：使用新订单，模拟响应丢失；重启或核对原执行记录，不重放写操作。
3. **过期审批**：使用另一新订单，注入并发关单；旧提案失效，重新调查后转为人工工单。

具体订单与操作见[面试与演示](docs/INTERVIEW.md#三分钟演示)。录制视频使用规则模式；真实模型评测单独记录，不混淆来源。

展示结论由后端依据所引工具快照生成；模型自由解释另列且标明未做逐句语义核验。调查时事实与实际执行结果分开，不把“提出建议”说成“已处理成功”。

## 验证

```bash
npm test
npm run build
npm run eval
npx playwright install chromium
npm run test:ui
# 需要自己的模型配置，会产生费用；默认共享持久预算最多10次请求
npm run eval:model
```

模型评测支持案例筛选、重复运行与共享 SQLite 请求预算；失败也计数，重启不自动重置，额度不足的案例标为跳过，不能冒充通过。首次完整评测需要显式配置充足预算，示例见验证记录。基线、模型、界面报告及录屏保存到 `artifacts/`，不自动提交。

## 飞书与部署

飞书使用官方 SDK 长连接，无需公网回调地址。创建自建机器人，开通私聊接收和发送权限，订阅 `im.message.receive_v1`。填写 `.env.example` 中的 `FEISHU_*` 配置，设置 `FEISHU_ENABLED=true`；发送“身份”获取自身标识，明确配置角色映射后才能调查和审批。支持“补充 / 确认 / 拒绝 / 核对 / 查询”及对应 `reply / approve / reject / verify / query` 命令，不接收群聊。详见[飞书配置](docs/ARCHITECTURE.md#飞书入口)；实际联调范围见验证记录。

部署到可常驻的 Node.js 服务，挂载持久数据目录：`npm ci && npm run build && npm start`。非本机监听必须设置至少 24 位 `WEB_ACCESS_TOKEN`，并使用 HTTPS 反向代理。身份切换只是演示机制，不能接入真实业务数据。SQLite 文件、进程锁与飞书长连接不适合直接当作 Vercel Serverless 部署。

技术栈：TypeScript、Vue 3、Express、Node.js SQLite、Zod、DeepSeek Tool Calling、飞书 WebSocket。

[架构与边界](docs/ARCHITECTURE.md) · [面试与演示](docs/INTERVIEW.md)
