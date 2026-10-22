import type { ReactNode } from "react";
import { clock, minutesOf } from "../api";
import type { Alert, AppState, Order, PlanDay, Prediction } from "../types";
import { AlertIcon, CalendarIcon, CartIcon, CheckIcon, ClockIcon, JarIcon, LeafIcon, TrendIcon } from "./icons";

function Sim({ label = "Simulated" }: { label?: string }) {
  return (
    <span className="sim" title="Simulated data for the demo, not a real service">
      {label}
    </span>
  );
}

function Card({ title, icon, badge, className = "", children, flash }: {
  title: string;
  icon: ReactNode;
  badge?: ReactNode;
  className?: string;
  flash?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className} ${flash ? "flash" : ""}`}>
      <header className="card-head">
        <div className="card-title">
          {icon} {title}
        </div>
        {badge}
      </header>
      {children}
    </section>
  );
}

// ---------- timeline ----------

const START = 16 * 60;
const END = 22 * 60;
const pct = (min: number) => `${Math.min(100, Math.max(0, ((min - START) / (END - START)) * 100))}%`;

export function TimelineCard({ state, flash }: { state: AppState; flash?: boolean }) {
  const { schedule, leave } = state;
  const now = minutesOf(schedule.now);
  const events = schedule.events.filter((e) => minutesOf(e.end) > START && e.start.slice(0, 10) === schedule.date);
  const hours = Array.from({ length: (END - START) / 60 + 1 }, (_, i) => START + i * 60);
  return (
    <Card title="Today's evening" icon={<CalendarIcon />} badge={<Sim label="Simulated calendar" />} className="timeline-card" flash={flash}>
      <div className="timeline">
        <div className="tl-hours">
          {hours.map((h) => (
            <span key={h} style={{ left: pct(h) }}>
              {clock(`${String(h / 60).padStart(2, "0")}:00`)}
            </span>
          ))}
        </div>
        <div className="tl-track">
          {hours.map((h) => (
            <i key={h} className="tl-grid" style={{ left: pct(h) }} />
          ))}
          {events.map((e) => {
            const s = minutesOf(e.start);
            const en = minutesOf(e.end);
            const changed = e.previous_end && e.previous_end !== e.end;
            return (
              <div key={e.id}>
                {changed && (
                  <div className="tl-ghost" style={{ left: pct(minutesOf(e.previous_start ?? e.start)), width: `calc(${pct(minutesOf(e.previous_end!))} - ${pct(minutesOf(e.previous_start ?? e.start))})` }} />
                )}
                {e.leave_by && (
                  <div className="tl-travel" style={{ left: pct(minutesOf(e.leave_by)), width: `calc(${pct(s)} - ${pct(minutesOf(e.leave_by))})` }} title="Travel + buffer (simulated)" />
                )}
                <div className={`tl-event ${changed ? "changed" : ""}`} style={{ left: pct(s), width: `calc(${pct(en)} - ${pct(s)})` }}>
                  <strong>{e.title}</strong>
                  <span>
                    {clock(e.start)}–{clock(e.end)}
                    {changed && <s> {clock(e.previous_end)}</s>}
                  </span>
                </div>
              </div>
            );
          })}
          {leave && (
            <div className={`tl-leave ${leave.conflict ? "conflict" : ""}`} style={{ left: pct(minutesOf(leave.leave_by)) }}>
              <span>Leave by {leave.leave_by_spoken}</span>
            </div>
          )}
          {now >= START && now <= END && <div className="tl-now" style={{ left: pct(now) }} title={`Now ${clock(schedule.now)}`} />}
        </div>
      </div>
      {leave && (
        <div className="leave-row">
          <ClockIcon />
          <div>
            <div className="leave-big">Leave by {leave.leave_by_spoken}</div>
            <div className="muted">
              {leave.event.title} at {leave.event.location} {clock(leave.event.start)} · {leave.travel_minutes} min travel (simulated) + {leave.buffer_minutes} min buffer
              {leave.minutes_free_before_leaving !== null &&
                (leave.conflict ? ` · overlaps by ${-leave.minutes_free_before_leaving} min` : ` · ${leave.minutes_free_before_leaving} min free before you go`)}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- tonight's dinner ----------

export function DinnerCard({ tonight, alerts, flash }: { tonight: PlanDay | null; alerts: Alert[]; flash?: boolean }) {
  const conflict = alerts.find((a) => a.kind === "meal_fit" && a.status !== "resolved" && a.data.meal === tonight?.meal);
  return (
    <Card title="Tonight's dinner" icon={<LeafIcon />} className="dinner-card" flash={flash}
      badge={tonight?.previous_meal ? <span className="pill ok">Swapped</span> : conflict ? <span className="pill warn">Won't fit</span> : tonight ? <span className="pill">Planned</span> : null}>
      {!tonight && <div className="empty">Nothing planned tonight.</div>}
      {tonight && (
        <div className="swap">
          {tonight.previous_meal && (
            <>
              <div className="meal before">
                <div className="meal-name">{tonight.previous_meal}</div>
                <div className="muted">no longer fits</div>
              </div>
              <div className="arrow">→</div>
            </>
          )}
          <div className={`meal after ${conflict ? "bad" : ""}`}>
            <div className="meal-name">{tonight.meal}</div>
            <div className="meal-meta">
              <ClockIcon width={14} height={14} /> {tonight.prep_minutes} min{tonight.cooked ? " · cooked" : ""}
            </div>
            {conflict && <div className="muted">{String(conflict.message)}</div>}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- grocery order ----------

export function OrderCard({ order, onConfirm, onChoose, busy, flash }: {
  order: Order | null;
  onConfirm: () => void;
  onChoose: (item: string, title: string) => void;
  busy: boolean;
  flash?: boolean;
}) {
  const pending = order?.needs_choice?.length ?? 0;
  return (
    <Card title="Grocery order" icon={<CartIcon />} badge={<Sim label="Simulated checkout" />} className="order-card" flash={flash}>
      {!order && <div className="empty">No order yet. Ask “what do we need from the store?”</div>}
      {order && (
        <>
          {order.sections.map((s) => (
            <div key={s.section} className="section">
              <div className="section-name">{s.section}</div>
              {s.items.map((i) => (
                <div key={i.item} className="order-item">
                  <span className="qty">{i.quantity === null ? "" : i.unit === "count" ? `× ${i.quantity}` : `${i.quantity} ${i.unit}`}</span>
                  <span className="item">{i.item}</span>
                  <span className="reasons">{i.reasons.join(" · ")}</span>
                  {i.product && (
                    <span className="product">
                      {i.product.packs > 1 ? `${i.product.packs} × ` : ""}
                      {i.product.title} · ${i.product.price_usd.toFixed(2)}
                      <span className={`pill ${i.product.why === "usual" ? "ok" : ""}`}>{i.product.why === "usual" ? "your usual" : i.product.why === "chosen" ? "you chose" : "only option"}</span>
                    </span>
                  )}
                  {!i.product && i.choices && (
                    <span className="product choices">
                      <span className="pill warn">Which one?</span>
                      {i.choices.map((c) => (
                        <button key={c.asin} className="choice" disabled={busy} onClick={() => onChoose(i.item, c.title)}>
                          {c.title} · ${c.price_usd.toFixed(2)}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {order.status === "draft" ? (
            <div className="checkout">
              <div className="muted">
                {pending ? `Choose ${pending === 1 ? "a product" : `${pending} products`} first. ` : `About $${order.estimated_total_usd.toFixed(2)} at Amazon. `}
                Nothing is bought until you say yes. Unrush never pays.
              </div>
              <button className="primary-btn" onClick={onConfirm} disabled={busy || pending > 0}>
                <CartIcon width={16} height={16} /> Yes, place order
              </button>
            </div>
          ) : (
            <div className="confirmed">
              <CheckIcon />
              <div>
                <div className="confirm-num">Order placed · {order.confirmation_number}</div>
                <div className="muted">Simulated order recorded: no charge, no card data. Open each product on Amazon and add it to your cart yourself.</div>
                <div className="cart-links">
                  {order.product_links.map((l) => (
                    <a key={l.url} className="cart-link" href={l.url} target="_blank" rel="noopener noreferrer">
                      {l.packs > 1 ? `${l.packs} × ` : ""}
                      {l.title} ↗
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------- run-out predictions ----------

export function RunoutCard({ predictions, today, flash }: { predictions: Prediction[]; today: string; flash?: boolean }) {
  const when = (p: Prediction) => (p.status === "out" ? "Out now" : p.predicted_runout_date === today ? "Today" : `${new Date(`${p.predicted_runout_date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}`);
  return (
    <Card title="Running low" icon={<TrendIcon />} badge={<span className="muted small">from 6 weeks of purchases</span>} className="runout-card" flash={flash}>
      {predictions.length === 0 && <div className="empty">Nothing running out in the next 3 days.</div>}
      {predictions.map((p) => (
        <div key={p.item} className="runout">
          <div className="runout-top">
            <span className="item">{p.item}</span>
            <span className={`pill ${p.status === "out" ? "bad" : p.status === "running_low" ? "warn" : ""}`}>{when(p)}</span>
            <span className="conf" title={`Confidence ${Math.round(p.confidence * 100)}%`}>
              <i style={{ width: `${p.confidence * 100}%` }} />
            </span>
            <span className="muted small">{p.confidence_label}</span>
          </div>
          <div className="reason">{p.reasoning}</div>
        </div>
      ))}
    </Card>
  );
}

// ---------- pantry ----------

export function PantryCard({ pantry, flash }: { pantry: AppState["pantry"]; flash?: boolean }) {
  return (
    <Card title="Pantry" icon={<JarIcon />} badge={<span className="muted small">{pantry.item_count} items</span>} className="pantry-card" flash={flash}>
      <div className="chips">
        {pantry.items.map((i) => (
          <span key={i.item} className="chip">
            {i.item} <b>{i.unit === "count" ? i.quantity : `${i.quantity} ${i.unit}`}</b>
          </span>
        ))}
      </div>
    </Card>
  );
}

export function AlertBanner({ alerts, text, onClose }: { alerts: Alert[]; text: string | null; onClose: () => void }) {
  return (
    <div className="banner" role="alert">
      <div className="banner-icon">
        <AlertIcon width={22} height={22} />
      </div>
      <div className="banner-body">
        <div className="banner-kicker">Unrush noticed {alerts.length === 1 ? "something" : `${alerts.length} things`} · speaking first</div>
        <div className="banner-text">{text ?? alerts.map((a) => a.message).join(" ")}</div>
      </div>
      <button className="ghost" onClick={onClose} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
