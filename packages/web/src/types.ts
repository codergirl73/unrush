/** Shapes of the backend API (mirrors MCP tool outputs). */

export type AgentEvent =
  | { type: "thinking"; iteration: number }
  | { type: "interim"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; ms: number; data: Record<string, unknown> }
  | { type: "reply"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number; ms: number }
  | { type: "memory"; action: "load" | "recall" | "save"; ok: boolean; detail: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface Alert {
  id: string;
  kind: "leave_by" | "meal_fit" | "runout";
  title: string;
  message: string;
  data: Record<string, unknown>;
  status?: "pending" | "delivered" | "resolved";
  created_at?: string;
}

export type ServerEvent =
  | { type: "status"; status: Status }
  | { type: "proactive_start"; runId: string; alerts: Alert[] }
  | { type: "agent"; runId: string; source: "proactive" | "chat"; event: AgentEvent }
  | { type: "proactive_end"; runId: string; reply: string; fallback: boolean; error?: string }
  | { type: "state_changed" };

export interface Status {
  mcpUrl: string;
  protocolVersion: string | null;
  tools: number;
  householdId: string;
  model: string;
  region: string;
  offline: boolean;
  problems: string[];
  memory?: string;
  skills?: string[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  previous_start: string | null;
  previous_end: string | null;
  leave_by: string | null;
}

export interface Qty {
  quantity: number;
  unit: string;
}

export interface PlanDay {
  date: string;
  weekday: string;
  meal: string;
  prep_minutes: number;
  ingredients: Array<{ item: string; quantity?: number; unit?: string }>;
  previous_meal: string | null;
  cooked: boolean;
}

export interface Prediction {
  item: string;
  status: "out" | "running_low" | "ok";
  current: Qty;
  daily_usage: Qty;
  days_left: number;
  predicted_runout_date: string;
  confidence: number;
  confidence_label: "high" | "medium" | "low";
  typical_purchase: Qty;
  reasoning: string;
}

export interface ProductChoice {
  asin: string;
  title: string;
  price_usd: number;
}

export interface OrderItem {
  item: string;
  quantity: number | null;
  unit: string | null;
  section: string;
  reasons: string[];
  product?: (ProductChoice & { packs: number; url: string; why: "usual" | "chosen" | "only" }) | null;
  choices?: ProductChoice[];
  search_url?: string;
}

export interface Order {
  order_id: string;
  status: "draft" | "placed";
  simulated: boolean;
  confirmation_number: string | null;
  created_at: string;
  placed_at: string | null;
  item_count: number;
  sections: Array<{ section: string; items: OrderItem[] }>;
  read_back: string;
  product_links: Array<{ item: string; title: string; packs: number; url: string }>;
  estimated_total_usd: number;
  needs_choice: Array<{ item: string; choices: ProductChoice[] }>;
}

export interface AppState {
  status: Status;
  schedule: { date: string; now: string; simulated: boolean; calendar_provider: string; events: CalendarEvent[] };
  leave: {
    event: CalendarEvent;
    leave_by: string;
    leave_by_spoken: string;
    travel_minutes: number;
    buffer_minutes: number;
    minutes_free_before_leaving: number | null;
    conflict: boolean;
    explanation: string;
    simulated: boolean;
  } | null;
  tonight: PlanDay | null;
  plan: { week_start: string; days: PlanDay[] };
  pantry: { item_count: number; items: Array<Qty & { item: string; section: string }> };
  runouts: { today: string; predictions: Prediction[] };
  order: Order | null;
  alerts: Alert[];
}
