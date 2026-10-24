const API_BASE = import.meta.env.VITE_API_URL ?? "";
const API = API_BASE ? `${API_BASE.replace(/\/$/, "")}/api` : "/api";
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN ?? "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (ADMIN_TOKEN) headers["X-Admin-Token"] = ADMIN_TOKEN;
  return headers;
}

// --------------- Price ---------------

export type PriceResponse = { symbol: string; price: number };
export type PriceErrorResponse = { error: string };

export async function fetchCurrentPrice(
  symbol: string
): Promise<{ symbol: string; price: number } | { error: string }> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return { error: "Symbol is required" };
  const res = await fetch(`${API}/price?symbol=${encodeURIComponent(sym)}`);
  const data = await res.json();
  if (!res.ok)
    return {
      error: (data as PriceErrorResponse).error ?? "Failed to get price",
    };
  return data as PriceResponse;
}

// --------------- Task Engine ---------------

export type TaskEngineState = {
  symbol: string;
  x0: number;
  current_x: number;
  current_pct: number;
  seeded: boolean;
  coin_qty: number;
};

export type TaskQueueItem = {
  id: number;
  symbol: string;
  direction: "UP" | "DOWN";
  target_pct: number;
  action: "BUY" | "SELL";
  note: string;
  sibling_id?: number | null;
  sell_origin?: string;
};

export type PassedTaskItem = {
  id: number;
  symbol: string;
  task_id?: number | null;
  direction: "UP" | "DOWN";
  action: "BUY" | "SELL";
  target_pct: number;
  hit_pct: number;
  hit_price: number;
  note: string;
  at: string;
  sell_origin?: string;
};

export type ClosedTaskItem = {
  id: number;
  symbol: string;
  closed_task_id: number;
  sibling_triggered_id: number | null;
  direction: "UP" | "DOWN";
  action: "BUY" | "SELL";
  target_pct: number;
  at_pct: number;
  at_price: number;
  reason: string;
  note: string;
  at: string;
};

export type TaskEngineInfoResponse = {
  state: TaskEngineState | null;
  up_tasks: TaskQueueItem[];
  down_tasks: TaskQueueItem[];
  passed_tasks: PassedTaskItem[];
  closed_tasks: ClosedTaskItem[];
};

export type TaskEnginePriceResponse = {
  ok?: boolean;
  error?: string;
  state?: TaskEngineState;
  delta_pct?: number;
  triggered?: TaskQueueItem[];
  spawned?: TaskQueueItem[];
  up_tasks?: TaskQueueItem[];
  down_tasks?: TaskQueueItem[];
  passed_tasks?: PassedTaskItem[];
  closed_tasks?: ClosedTaskItem[];
  message?: string;
};

// --------------- Command queue ---------------

export type CommandStatus =
  | "PENDING"
  | "PROCESSING"
  | "DONE"
  | "FAILED"
  | "NEEDS_REVIEW";

export type CommandRecord = {
  id: number;
  command_type: string;
  status: CommandStatus;
  result?: unknown;
  error?: string;
  attempts?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function enqueueCommand(
  type: string,
  payload: Record<string, unknown>
): Promise<{ command_id: number; status: CommandStatus; error?: string }> {
  const res = await fetch(`${API}/task-engine/commands`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ type, payload }),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      command_id: 0,
      status: "FAILED",
      error: data.error ?? "Failed to enqueue command",
    };
  }
  return {
    command_id: data.command_id,
    status: (data.status ?? "PENDING") as CommandStatus,
  };
}

async function waitForCommand(
  commandId: number,
  timeoutMs: number = 90_000
): Promise<CommandRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${API}/task-engine/commands/${commandId}`);
    if (!res.ok) {
      return {
        id: commandId,
        command_type: "",
        status: "FAILED",
        error: res.status === 401 ? "Unauthorized" : "Command not found",
      };
    }
    const record = (await res.json()) as CommandRecord;
    if (record.status !== "PENDING" && record.status !== "PROCESSING") {
      return record;
    }
    await sleep(700);
  }
  return {
    id: commandId,
    command_type: "",
    status: "FAILED",
    error: "Timed out waiting for the worker. The command stays queued.",
  };
}

async function runCommand<T extends { error?: string }>(
  type: string,
  payload: Record<string, unknown>
): Promise<T> {
  const queued = await enqueueCommand(type, payload);
  if (queued.error || !queued.command_id) {
    return { error: queued.error ?? "Failed to enqueue command" } as T;
  }
  const record = await waitForCommand(queued.command_id);
  if (record.status !== "DONE") {
    const failure = record.error || `Command ${record.status}`;
    const result = (record.result ?? {}) as T;
    return { ...result, error: failure };
  }
  return (record.result ?? { ok: true }) as T;
}

export async function fetchTaskEngineSymbols(): Promise<string[]> {
  const res = await fetch(`${API}/task-engine/symbols`);
  const data = await res.json();
  return data.symbols ?? [];
}

export async function initTaskEngine(
  symbol: string,
  x0: number,
  coin_qty: number = 0
): Promise<TaskEnginePriceResponse> {
  return runCommand<TaskEnginePriceResponse>("init_engine", {
    symbol: symbol.trim().toUpperCase(),
    x0,
    coin_qty,
  });
}

export async function submitTaskEnginePrice(
  symbol: string,
  price: number
): Promise<TaskEnginePriceResponse> {
  return runCommand<TaskEnginePriceResponse>("process_price", {
    symbol: symbol.trim().toUpperCase(),
    price,
  });
}

export async function fetchTaskEngineInfo(
  symbol: string
): Promise<TaskEngineInfoResponse> {
  const res = await fetch(
    `${API}/task-engine/info?symbol=${encodeURIComponent(
      symbol.trim().toUpperCase()
    )}`
  );
  return await res.json();
}

export type LivePrices = Record<string, number>;

export async function fetchLivePrices(): Promise<LivePrices> {
  const res = await fetch(`${API}/task-engine/live-prices`);
  return await res.json();
}

// --------------- Settings ---------------

export type SettingsItem = {
  symbol: string;
  sell_down_pct: number;
  sell_up_pct: number;
  sell_down_offset_pct: number;
  sell_up_offset_pct: number;
  buy_after_sell_down_offset_pct: number;
  buy_after_sell_up_offset_pct: number;
  supplement_sell_up_offset_pct: number;
  grid_step_pct: number;
  buy_cancel_distance_pct: number;
};

export type SettingsPayload = Omit<SettingsItem, "symbol">;

export async function fetchSettings(): Promise<SettingsItem[]> {
  const res = await fetch(`${API}/task-engine/settings`);
  const data = await res.json();
  return data.settings ?? [];
}

export async function saveSettings(
  symbol: string,
  payload: SettingsPayload
): Promise<{ ok?: boolean; error?: string; settings?: SettingsItem }> {
  const res = await fetch(`${API}/task-engine/settings`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      symbol: symbol.trim().toUpperCase(),
      ...payload,
    }),
  });
  return await res.json();
}

// --------------- Summary ---------------

export type SummaryRow = TaskQueueItem & {
  coin_qty: number;
  coins_to_trade: number;
  target_price: number;
  section_id: number;
  section_name: string;
};

export type SummarySymbol = {
  symbol: string;
  state: TaskEngineState;
  settings: SettingsItem;
  sell_down: SummaryRow[];
  buy_down: SummaryRow[];
  sell_up: SummaryRow[];
  total_sell_down_coins: number;
  total_buy_down_coins: number;
  total_sell_up_coins: number;
};

export async function fetchSummary(): Promise<SummarySymbol[]> {
  const res = await fetch(`${API}/task-engine/summary`);
  const data = await res.json();
  return data.summary ?? [];
}

// --------------- Sections ---------------

export type Section = {
  id: number;
  name: string;
  symbol: string;
  x0: number;
  coin_qty: number;
  current_x: number;
  current_pct: number;
  seeded: boolean;
};

export type SectionInfoResponse = {
  section: Section | null;
  up_tasks: TaskQueueItem[];
  down_tasks: TaskQueueItem[];
  passed_tasks: PassedTaskItem[];
  closed_tasks: ClosedTaskItem[];
};

export type CreateSectionResponse = {
  ok?: boolean;
  error?: string;
  section?: Section;
  up_tasks?: TaskQueueItem[];
  down_tasks?: TaskQueueItem[];
  nearest_prices?: ValidX0Item[];
  base_x0?: number;
  grid_step_pct?: number;
  first_section_name?: string;
};

export interface ValidX0Item {
  target_x: number;
  n: number;    // grid step index: negative = below base, positive = above
  pct: number;  // = n × grid_step_pct
}

export interface ValidX0Response {
  requires_validation: boolean;
  first_section: { id: number; name: string } | null;
  base_x0: number | null;
  grid_step_pct: number;
  sample_prices: ValidX0Item[];
}

export type PriceBroadcastResult = {
  section_id: number;
  section_name: string;
  current_pct: number;
  delta_pct: number;
  triggered: TaskQueueItem[];
  spawned: TaskQueueItem[];
};

export type PriceBroadcastResponse = {
  ok?: boolean;
  error?: string;
  symbol?: string;
  price?: number;
  sections_updated?: number;
  total_triggered?: number;
  results?: PriceBroadcastResult[];
};

export async function fetchSections(
  symbol?: string
): Promise<Section[]> {
  const url = symbol
    ? `${API}/task-engine/sections?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`
    : `${API}/task-engine/sections`;
  const res = await fetch(url);
  const data = await res.json();
  return data.sections ?? [];
}

export async function fetchValidX0(symbol: string): Promise<ValidX0Response> {
  const res = await fetch(
    `${API}/task-engine/sections/valid-x0?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`
  );
  return await res.json();
}

export async function createSection(
  symbol: string,
  name: string,
  x0: number,
  coin_qty: number = 0
): Promise<CreateSectionResponse> {
  return runCommand<CreateSectionResponse>("create_section", {
    symbol: symbol.trim().toUpperCase(),
    name: name.trim(),
    x0,
    coin_qty,
  });
}

export async function fetchSectionInfo(
  sectionId: number
): Promise<SectionInfoResponse> {
  const res = await fetch(`${API}/task-engine/sections/${sectionId}`);
  return await res.json();
}

export async function deleteSection(
  sectionId: number
): Promise<{ ok?: boolean; error?: string }> {
  return runCommand<{ ok?: boolean; error?: string }>("delete_section", {
    section_id: sectionId,
  });
}

export async function deleteTask(
  taskId: number
): Promise<{ ok?: boolean; error?: string }> {
  return runCommand<{ ok?: boolean; error?: string }>("delete_task", {
    task_id: taskId,
  });
}

export async function deleteAllBuyTasks(
  symbol: string
): Promise<{ ok?: boolean; error?: string; deleted_count?: number }> {
  return runCommand<{ ok?: boolean; error?: string; deleted_count?: number }>(
    "delete_all_buy",
    { symbol: symbol.trim().toUpperCase() }
  );
}

export async function priceBroadcast(
  symbol: string,
  price: number
): Promise<PriceBroadcastResponse> {
  return runCommand<PriceBroadcastResponse>("process_price", {
    symbol: symbol.trim().toUpperCase(),
    price,
  });
}

export async function deleteEngine(
  symbol: string
): Promise<{ ok?: boolean; error?: string }> {
  return runCommand<{ ok?: boolean; error?: string }>("delete_engine", {
    symbol: symbol.trim().toUpperCase(),
  });
}

// --------------- Orders / worker (debug) ---------------

export type OrderRow = {
  id: number;
  task_id: number;
  section_id: number;
  symbol: string;
  exchange_symbol: string;
  client_order_id: string;
  exchange_order_id?: string | null;
  side: "buy" | "sell";
  direction: "UP" | "DOWN";
  order_type: string;
  amount: number;
  price: number;
  stop_price?: number | null;
  target_pct: number;
  target_price: number;
  sell_origin?: string;
  status: string;
  filled_amount: number;
  avg_fill_price?: number | null;
  attempts: number;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
};

export type WorkerStatus = {
  worker_id: string;
  last_seen: string;
  version: string;
  mode: string;
  last_error: string;
  online: boolean;
};

export async function fetchOrders(params?: {
  symbol?: string;
  section_id?: number;
  status?: string;
}): Promise<OrderRow[]> {
  const query = new URLSearchParams();
  if (params?.symbol) query.set("symbol", params.symbol);
  if (params?.section_id) query.set("section_id", String(params.section_id));
  if (params?.status) query.set("status", params.status);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(`${API}/task-engine/orders${suffix}`, {
    headers: authHeaders(),
  });
  const data = await res.json();
  return data.orders ?? [];
}

export async function fetchWorkerStatus(): Promise<{
  online: boolean;
  workers: WorkerStatus[];
}> {
  const res = await fetch(`${API}/task-engine/worker`, {
    headers: authHeaders(),
  });
  if (!res.ok) return { online: false, workers: [] };
  return await res.json();
}

// --------------- Price History ---------------

export type PriceHistoryItem = {
  id?: number;
  symbol: string;
  price: number;
  at: string;
};

export async function fetchPriceHistory(
  symbol: string,
  limit: number = 20
): Promise<PriceHistoryItem[]> {
  const res = await fetch(
    `${API}/task-engine/price-history?symbol=${encodeURIComponent(
      symbol.trim().toUpperCase()
    )}&limit=${limit}`
  );
  const data = await res.json();
  return data.history ?? [];
}
