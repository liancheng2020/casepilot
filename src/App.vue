<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Download,
  FlaskConical,
  Inbox,
  Layers,
  LoaderCircle,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Square,
  X,
} from "@lucide/vue";
import type { Actor, Order, Scenario, Status, Task } from "../server/types";

type Config = {
  actors: Actor[];
  scenarios: Scenario[];
  defaultMode: "mock" | "deepseek";
  modelConfigured: boolean;
  feishu: { enabled: boolean; state: string };
};
const config = ref<Config>();
const tasks = ref<Task[]>([]),
  orders = ref<Order[]>([]);
const actorId = ref("service"),
  view = ref("tasks"),
  selectedId = ref(new URLSearchParams(location.search).get("task") || "");
const complaint = ref(""),
  mode = ref<"mock" | "deepseek">("mock"),
  scenarioId = ref("delayed"),
  fault = ref("");
const filter = ref("all"),
  search = ref(""),
  detailTab = ref("timeline"),
  reply = ref("");
const showCreate = ref(true),
  busy = ref(false),
  error = ref(""),
  lostResponse = ref(false);
const token = ref(sessionStorage.getItem("casepilot-token") || ""),
  requireToken = ref(false);
const actor = computed(() =>
  config.value?.actors.find((a) => a.id === actorId.value),
);
const selected = computed(() =>
  tasks.value.find((t) => t.id === selectedId.value),
);
const selectedOrder = computed(() =>
  orders.value.find((o) => o.id === selected.value?.orderId),
);
const counts = computed(() => ({
  all: tasks.value.length,
  approval: tasks.value.filter((t) => t.status === "awaiting_approval").length,
  complete: tasks.value.filter((t) => t.status === "completed").length,
  handoff: tasks.value.filter((t) =>
    ["handoff", "conflict", "result_unknown"].includes(t.status),
  ).length,
}));
const filteredTasks = computed(() =>
  tasks.value.filter(
    (t) =>
      (filter.value === "all" || t.status === filter.value) &&
      `${t.complaint}${t.orderId || ""}`.includes(search.value),
  ),
);
const statuses: Record<Status, string> = {
  queued: "排队中",
  investigating: "调查中",
  needs_input: "待补充",
  awaiting_approval: "待确认",
  executing: "执行中",
  result_unknown: "待核对",
  completed: "已完成",
  handoff: "转人工",
  conflict: "提案失效",
  cancelled: "已取消",
};
const toolNames: Record<string, string> = {
  find_orders: "查找候选订单",
  get_order: "读取订单",
  get_payment: "查询支付渠道",
  get_callbacks: "核查回调",
  get_records: "查询已有工单",
  get_policy: "核对处置规则",
  propose_action: "提出处置建议",
  ask_user: "请求补充信息",
  finish: "结束调查",
};
const orderStatuses = { pending: "待支付", paid: "已支付", closed: "已关闭" };
const money = (cents: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    cents / 100,
  );
const time = (at: string) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

async function api<T>(
  path: string,
  body?: unknown,
  identity = actorId.value,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Demo-Actor": identity,
      ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) requireToken.value = true;
    throw new Error(data.error?.message || "请求失败");
  }
  return data as T;
}
async function refresh() {
  const identity = actorId.value;
  try {
    const currentTasks = await api<Task[]>("/tasks", undefined, identity);
    const currentOrders = await api<Order[]>("/orders", undefined, identity);
    if (identity !== actorId.value) return;
    tasks.value = currentTasks;
    orders.value = currentOrders;
    if (!selectedId.value && tasks.value[0])
      selectedId.value = tasks.value[0].id;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function load() {
  try {
    config.value = await api<Config>("/config");
    mode.value = config.value.defaultMode;
    pickScenario();
    await refresh();
    requireToken.value = false;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function pickScenario() {
  complaint.value =
    config.value?.scenarios.find((s) => s.id === scenarioId.value)?.complaint ||
    "";
}
function openScenario(scenario: Scenario) {
  scenarioId.value = scenario.id;
  complaint.value = scenario.complaint;
  showCreate.value = true;
  view.value = "tasks";
}
async function createTask() {
  busy.value = true;
  error.value = "";
  try {
    const task = await api<Task>("/tasks", {
      complaint: complaint.value,
      mode: mode.value,
      requestId: crypto.randomUUID(),
      ...(fault.value ? { fault: fault.value } : {}),
    });
    selectedId.value = task.id;
    detailTab.value = "timeline";
    lostResponse.value = false;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function action(name: string, body: unknown = {}) {
  if (!selected.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/tasks/${selected.value.id}/${name}`, body);
    reply.value = "";
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function selectTask(task: Task) {
  selectedId.value = task.id;
  lostResponse.value = false;
  detailTab.value = "timeline";
}
async function exportTask() {
  if (!selected.value) return;
  try {
    const data = await api(`/tasks/${selected.value.id}/export`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `casepilot-${selected.value.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function saveToken() {
  sessionStorage.setItem("casepilot-token", token.value);
  error.value = "";
  void load();
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!requireToken.value && !document.hidden) void refresh();
  }, 1500);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="CasePilot 首页"
        ><span class="brand-symbol"><Layers :size="22" /></span
        ><span>CasePilot<small>ORDER OPERATIONS</small></span></a
      >
      <nav aria-label="主导航">
        <button :class="{ active: view === 'tasks' }" @click="view = 'tasks'">
          <Inbox :size="18" /> 处置工作台
          <span class="nav-count">{{ counts.all }}</span>
        </button>
        <button :class="{ active: view === 'cases' }" @click="view = 'cases'">
          <FlaskConical :size="18" /> 案例库
        </button>
        <button :class="{ active: view === 'orders' }" @click="view = 'orders'">
          <ShoppingBag :size="18" /> 演示订单
        </button>
      </nav>
      <div class="sidebar-bottom">
        <span class="source-dot"></span> 独立业务沙盒
        <small>合成订单 · 无生产接入</small>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb">
          拾味订单场景 <ChevronRight :size="14" /><strong>{{
            view === "tasks"
              ? "处置工作台"
              : view === "cases"
                ? "案例库"
                : "演示订单"
          }}</strong>
        </div>
        <div class="topbar-right">
          <span class="channel-label"
            ><MessageSquare :size="14" />
            {{
              config?.feishu.state === "connected"
                ? "飞书已连接"
                : config?.feishu.enabled
                  ? "飞书未连接"
                  : "Web 演示"
            }}</span
          ><label class="actor-select"
            ><span>演示身份</span
            ><select
              v-model="actorId"
              @change="
                selectedId = '';
                refresh();
              "
            >
              <option
                v-for="person in config?.actors"
                :key="person.id"
                :value="person.id"
              >
                {{ person.name }} ·
                {{ person.role === "approver" ? "运营" : "客服" }}
              </option>
            </select></label
          >
        </div>
      </header>
      <main>
        <div v-if="error" class="error-banner" role="alert">
          <CircleAlert :size="17" /><span>{{ error }}</span
          ><button class="icon-button" title="关闭提示" @click="error = ''">
            <X :size="16" />
          </button>
        </div>
        <section class="page-heading">
          <div>
            <p class="eyebrow">CASE OPERATIONS</p>
            <h1>
              {{
                view === "tasks"
                  ? "订单异常处置"
                  : view === "cases"
                    ? "验证案例"
                    : "演示订单"
              }}
            </h1>
          </div>
          <div class="heading-actions">
            <span class="badge neutral">合成业务数据</span
            ><button class="icon-button" title="刷新数据" @click="refresh">
              <RefreshCw :size="18" /></button
            ><button
              v-if="view === 'tasks'"
              class="primary"
              @click="showCreate = !showCreate"
            >
              <ClipboardList :size="16" /> 新建调查
            </button>
          </div>
        </section>

        <template v-if="view === 'tasks'">
          <section class="metrics" aria-label="任务统计">
            <div>
              <span>全部任务</span
              ><strong>{{ counts.all.toString().padStart(2, "0") }}</strong>
            </div>
            <div>
              <span>等待运营确认</span
              ><strong class="amber">{{
                counts.approval.toString().padStart(2, "0")
              }}</strong>
            </div>
            <div>
              <span>已完成</span
              ><strong class="green">{{
                counts.complete.toString().padStart(2, "0")
              }}</strong>
            </div>
            <div>
              <span>需核查 / 人工接管</span
              ><strong>{{ counts.handoff.toString().padStart(2, "0") }}</strong>
            </div>
          </section>
          <div class="workbench">
            <div class="task-column">
              <form
                v-if="showCreate"
                class="new-task panel"
                @submit.prevent="createTask"
              >
                <div class="panel-title">
                  <h2>新建调查</h2>
                  <button
                    class="icon-button"
                    type="button"
                    title="收起新建调查"
                    @click="showCreate = false"
                  >
                    <X :size="16" />
                  </button>
                </div>
                <label
                  >案例<select v-model="scenarioId" @change="pickScenario">
                    <option
                      v-for="scenario in config?.scenarios"
                      :key="scenario.id"
                      :value="scenario.id"
                    >
                      {{ scenario.label }}
                    </option>
                  </select></label
                >
                <label
                  >问题描述<textarea
                    v-model="complaint"
                    rows="4"
                    minlength="4"
                    maxlength="4000"
                    required
                  />
                </label>
                <div class="form-grid">
                  <label
                    >决策来源<select v-model="mode">
                      <option value="mock">规则模拟器</option>
                      <option
                        value="deepseek"
                        :disabled="!config?.modelConfigured"
                      >
                        DeepSeek 模型
                      </option>
                    </select></label
                  ><label
                    >查询故障<select v-model="fault">
                      <option value="">无</option>
                      <option value="query_timeout">超时一次</option>
                      <option value="query_unavailable">持续超时</option>
                    </select></label
                  >
                </div>
                <button
                  class="primary full"
                  :disabled="busy || complaint.trim().length < 4"
                >
                  <LoaderCircle v-if="busy" :size="16" class="spin" /><Play
                    v-else
                    :size="16"
                  />
                  开始调查 <ArrowRight :size="16" class="push-right" />
                </button>
              </form>
              <section class="task-list panel">
                <div class="panel-title">
                  <h2>最近任务</h2>
                  <span class="counter">{{ filteredTasks.length }}</span>
                </div>
                <div class="list-controls">
                  <div class="search-field">
                    <Search :size="15" /><input
                      v-model="search"
                      aria-label="搜索任务"
                      placeholder="搜索问题或订单号"
                    />
                  </div>
                  <select v-model="filter" aria-label="筛选任务状态">
                    <option value="all">全部</option>
                    <option value="awaiting_approval">待确认</option>
                    <option value="needs_input">待补充</option>
                    <option value="completed">已完成</option>
                    <option value="handoff">转人工</option>
                    <option value="conflict">提案失效</option>
                    <option value="result_unknown">待核对</option>
                  </select>
                </div>
                <div class="task-items">
                  <button
                    v-for="task in filteredTasks"
                    :key="task.id"
                    class="task-item"
                    :class="{ selected: selectedId === task.id }"
                    @click="selectTask(task)"
                  >
                    <div class="task-item-top">
                      <span class="mono">{{ shortId(task.id) }}</span
                      ><span class="badge" :class="task.status">{{
                        statuses[task.status]
                      }}</span>
                    </div>
                    <p>{{ task.complaint }}</p>
                    <div class="task-item-meta">
                      <span>{{
                        task.mode === "mock" ? "规则模拟" : "DeepSeek"
                      }}</span
                      ><time>{{ time(task.createdAt) }}</time>
                    </div>
                  </button>
                  <p v-if="!filteredTasks.length" class="empty-list">
                    暂无任务
                  </p>
                </div>
              </section>
            </div>

            <section class="detail panel">
              <template v-if="selected">
                <div class="detail-heading">
                  <div>
                    <p class="eyebrow">CASE / {{ shortId(selected.id) }}</p>
                    <h2>调查与处置</h2>
                  </div>
                  <div class="detail-heading-right">
                    <span class="badge" :class="selected.status">{{
                      statuses[selected.status]
                    }}</span
                    ><button
                      class="icon-button"
                      title="导出执行记录"
                      @click="exportTask"
                    >
                      <Download :size="18" />
                    </button>
                  </div>
                </div>
                <p class="complaint">{{ selected.complaint }}</p>
                <div class="detail-meta">
                  <span>{{
                    selected.mode === "mock"
                      ? "规则模拟器 · 非真实模型"
                      : "DeepSeek · 真实工具调用"
                  }}</span
                  ><span
                    >{{ selected.usage.requests }}
                    {{ selected.mode === "mock" ? "决策轮次" : "模型请求" }} /
                    {{ selected.usage.toolCalls }} 次工具</span
                  ><span v-if="selected.mode === 'deepseek'"
                    >{{
                      selected.usage.promptTokens +
                      selected.usage.completionTokens
                    }}
                    tokens</span
                  >
                </div>
                <div v-if="selectedOrder" class="order-facts">
                  <div>
                    <span>目标订单</span
                    ><strong class="mono order-id">{{
                      selectedOrder.id
                    }}</strong>
                  </div>
                  <div>
                    <span>当前业务状态</span
                    ><strong
                      >{{ orderStatuses[selectedOrder.status] }}
                      <small>v{{ selectedOrder.version }}</small></strong
                    >
                  </div>
                  <div>
                    <span>订单金额</span
                    ><strong>{{ money(selectedOrder.amountCents) }}</strong>
                  </div>
                </div>
                <div
                  v-if="
                    selected.status === 'investigating' ||
                    selected.status === 'queued'
                  "
                  class="outcome investigating"
                >
                  <LoaderCircle :size="20" class="spin" />
                  <div>
                    <h3>正在调查</h3>
                    <p>
                      {{ selected.events.at(-1)?.title || "任务已进入队列" }}
                    </p>
                  </div>
                  <button
                    class="secondary compact"
                    :disabled="busy"
                    @click="action('cancel')"
                  >
                    <Square :size="13" /> 停止
                  </button>
                </div>
                <form
                  v-else-if="selected.status === 'needs_input'"
                  class="outcome needs_input"
                  @submit.prevent="action('reply', { content: reply })"
                >
                  <MessageSquare :size="20" />
                  <div class="grow">
                    <h3>需要补充信息</h3>
                    <p>{{ selected.question }}</p>
                    <div class="reply-row">
                      <input
                        v-model="reply"
                        aria-label="补充订单信息"
                        placeholder="完整订单号或补充说明"
                        required
                        maxlength="2000"
                      /><button
                        class="primary"
                        :disabled="busy || !reply.trim()"
                      >
                        提交 <ArrowRight :size="15" />
                      </button>
                    </div>
                  </div>
                </form>
                <div
                  v-else-if="
                    selected.status === 'awaiting_approval' && selected.proposal
                  "
                  class="approval-section"
                >
                  <div class="section-label">
                    <ShieldCheck :size="18" />
                    <h3>
                      {{
                        selected.proposal.action === "reconcile_payment"
                          ? "对账补偿提案"
                          : "异常工单提案"
                      }}
                    </h3>
                    <span class="badge awaiting_approval">待确认</span>
                  </div>
                  <p>{{ selected.proposal.reason }}</p>
                  <div class="approval-meta">
                    订单 v{{ selected.proposal.orderVersion }} · 支付 v{{
                      selected.proposal.paymentVersion
                    }}
                    · {{ selected.proposal.evidenceIds.length }} 条引用 · 有效至
                    {{ time(selected.proposal.expiresAt) }}
                  </div>
                  <div class="approval-options">
                    <label class="checkbox-label"
                      ><input v-model="lostResponse" type="checkbox" />
                      模拟执行响应丢失</label
                    ><select
                      aria-label="注入审批后故障"
                      :disabled="busy || actor?.role !== 'approver'"
                      @change="
                        action('fault', {
                          fault: ($event.target as HTMLSelectElement).value,
                        });
                        ($event.target as HTMLSelectElement).value = '';
                      "
                    >
                      <option value="">故障注入</option>
                      <option value="close_order">订单被并发关闭</option>
                      <option value="payment_refunded">支付被并发退款</option>
                    </select>
                  </div>
                  <div class="approval-actions">
                    <button
                      class="primary"
                      :disabled="busy || actor?.role !== 'approver'"
                      @click="
                        action('approve', {
                          proposalId: selected.proposal.id,
                          simulateLostResponse: lostResponse,
                        })
                      "
                    >
                      <Check :size="16" /> 确认并执行</button
                    ><button
                      class="secondary"
                      :disabled="busy || actor?.role !== 'approver'"
                      @click="
                        action('reject', { proposalId: selected.proposal.id })
                      "
                    >
                      <X :size="16" /> 拒绝</button
                    ><span
                      v-if="actor?.role !== 'approver'"
                      class="permission-note"
                      >需运营身份确认</span
                    >
                  </div>
                </div>
                <div v-else class="outcome" :class="selected.status">
                  <CheckCheck
                    v-if="selected.status === 'completed'"
                    :size="22"
                  /><CircleAlert v-else :size="22" />
                  <div class="grow">
                    <h3>
                      {{
                        selected.status === "completed"
                          ? "处理记录"
                          : statuses[selected.status]
                      }}
                    </h3>
                    <p>{{ selected.summary }}</p>
                    <p v-if="selected.result?.ticketId" class="mono result-id">
                      工单 {{ selected.result.ticketId }}
                    </p>
                  </div>
                  <button
                    v-if="selected.status === 'result_unknown'"
                    class="primary"
                    :disabled="busy"
                    @click="action('verify')"
                  >
                    <RefreshCw :size="16" /> 核对结果</button
                  ><button
                    v-if="['conflict', 'handoff'].includes(selected.status)"
                    class="secondary"
                    :disabled="busy"
                    @click="action('restart')"
                  >
                    <RefreshCw :size="16" /> 重新调查
                  </button>
                </div>
                <div class="tabs" role="tablist" aria-label="任务详情">
                  <button
                    role="tab"
                    :aria-selected="detailTab === 'timeline'"
                    :class="{ active: detailTab === 'timeline' }"
                    @click="detailTab = 'timeline'"
                  >
                    调查记录 <span>{{ selected.events.length }}</span></button
                  ><button
                    role="tab"
                    :aria-selected="detailTab === 'evidence'"
                    :class="{ active: detailTab === 'evidence' }"
                    @click="detailTab = 'evidence'"
                  >
                    工具证据 <span>{{ selected.evidence.length }}</span>
                  </button>
                </div>
                <div
                  v-if="detailTab === 'timeline'"
                  class="timeline"
                  role="tabpanel"
                >
                  <div
                    v-for="entry in selected.events"
                    :key="entry.id"
                    class="timeline-row"
                    :class="entry.kind"
                  >
                    <div class="timeline-marker">
                      <Check
                        v-if="
                          entry.kind === 'execution' || entry.kind === 'tool'
                        "
                        :size="12"
                      /><CircleAlert
                        v-else-if="entry.kind === 'error'"
                        :size="12"
                      /><span v-else></span>
                    </div>
                    <div class="timeline-content">
                      <div>
                        <strong>{{ entry.title }}</strong
                        ><time>{{ time(entry.at) }}</time>
                      </div>
                      <p>{{ entry.detail }}</p>
                    </div>
                  </div>
                </div>
                <div v-else class="evidence-list" role="tabpanel">
                  <details
                    v-for="item in selected.evidence"
                    :key="item.id"
                    :open="item === selected.evidence.at(-1)"
                  >
                    <summary>
                      <span>{{ toolNames[item.tool] || item.tool }}</span
                      ><span class="mono">{{ item.tool }}</span
                      ><span
                        v-if="item.epoch !== selected.epoch"
                        class="badge neutral"
                        >旧轮次</span
                      ><time>{{ time(item.at) }}</time>
                    </summary>
                    <div class="evidence-body">
                      <p class="mono">{{ item.id }}</p>
                      <h4>参数</h4>
                      <pre>{{ JSON.stringify(item.args, null, 2) }}</pre>
                      <h4>结果</h4>
                      <pre>{{ JSON.stringify(item.result, null, 2) }}</pre>
                    </div>
                  </details>
                  <p v-if="!selected.evidence.length" class="empty-list">
                    暂无工具证据
                  </p>
                </div>
              </template>
              <div v-else class="empty-detail">
                <div class="empty-visual">
                  <ClipboardList :size="42" /><span class="empty-line"></span
                  ><span class="empty-line short"></span>
                </div>
                <h2>暂无调查任务</h2>
                <p>合成订单沙盒</p>
                <button class="primary" :disabled="busy" @click="createTask">
                  <Play :size="16" /> 调查支付异常
                </button>
              </div>
            </section>
          </div>
        </template>

        <section v-else-if="view === 'cases'" class="case-table panel">
          <table>
            <thead>
              <tr>
                <th>案例</th>
                <th>类型</th>
                <th>验收预期</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="scenario in config?.scenarios" :key="scenario.id">
                <td>
                  <strong>{{ scenario.label }}</strong
                  ><small class="mono">{{ scenario.id }}</small>
                </td>
                <td>{{ scenario.category }}</td>
                <td>{{ scenario.expected }}</td>
                <td>
                  <button
                    class="secondary compact"
                    @click="openScenario(scenario)"
                  >
                    载入 <ArrowRight :size="15" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <section v-else class="orders-table panel">
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>商品 / 客户标识</th>
                <th>金额</th>
                <th>状态</th>
                <th>版本</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in orders" :key="order.id">
                <td class="mono">{{ order.id }}</td>
                <td>
                  {{ order.items }}<small>{{ order.customerRef }}</small>
                </td>
                <td>{{ money(order.amountCents) }}</td>
                <td>
                  <span
                    class="badge"
                    :class="order.status === 'paid' ? 'completed' : 'neutral'"
                    >{{ orderStatuses[order.status] }}</span
                  >
                </td>
                <td class="mono">v{{ order.version }}</td>
                <td>
                  <button
                    class="icon-button"
                    title="调查此订单"
                    @click="
                      complaint = `订单 ${order.id}，请核查支付与订单状态。`;
                      view = 'tasks';
                      showCreate = true;
                    "
                  >
                    <ArrowRight :size="17" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
      <footer>
        CasePilot
        <span
          >合成业务 ·
          {{ config?.modelConfigured ? "模型可用" : "模型未配置" }}</span
        >
      </footer>
    </div>
    <div v-if="requireToken" class="modal-overlay">
      <form class="token-modal" @submit.prevent="saveToken">
        <ShieldCheck :size="26" />
        <h2>演示访问验证</h2>
        <label
          >访问令牌<input
            v-model="token"
            type="password"
            autocomplete="off"
            required /></label
        ><button class="primary full">
          进入工作台 <ArrowRight :size="16" />
        </button>
      </form>
    </div>
  </div>
</template>
