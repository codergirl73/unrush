/**
 * MCP Apps UI resources (ui:// HTML, mime text/html;profile=mcp-app). Each view uses
 * the official App class: it receives the linked tool's result from the host,
 * renders a card, may call read-only server tools for more context, and sends chat
 * messages back to the host. It never places orders itself. The "Place order" button
 * sends "Yes, place the order." as a user message, so the normal consent path applies.
 */
import { appRuntimeScript } from "./runtime.js";

export const EVENING_VIEW_URI = "ui://unrush/evening.html";
export const ORDER_VIEW_URI = "ui://unrush/order.html";

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fc;--line:#e3e7f0;--text:#121826;--muted:#5a6478;--brand:#4f46e5;--ok:#0f9f6e;--okbg:rgba(15,159,110,.12);--bad:#dc2626;--badbg:rgba(220,38,38,.1);--warn:#b45309;--warnbg:rgba(217,119,6,.13)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#131926;--panel:#182032;--line:#2a3349;--text:#e8ecf4;--muted:#a6afc3;--brand:#818cf8;--ok:#34d399;--okbg:rgba(52,211,153,.14);--bad:#f87171;--badbg:rgba(248,113,113,.14);--warn:#fbbf24;--warnbg:rgba(251,191,36,.14)}}
:root[data-theme=dark]{--bg:#131926;--panel:#182032;--line:#2a3349;--text:#e8ecf4;--muted:#a6afc3;--brand:#818cf8;--ok:#34d399;--okbg:rgba(52,211,153,.14);--bad:#f87171;--badbg:rgba(248,113,113,.14);--warn:#fbbf24;--warnbg:rgba(251,191,36,.14)}
*{box-sizing:border-box}body{margin:0;padding:14px;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
h1{font-size:15px;margin:0 0 10px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.sim{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:6px;color:var(--warn);background:var(--warnbg);border:1px dashed var(--warn)}
.row{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.t{font-weight:700;min-width:96px}.muted{color:var(--muted);font-size:12.5px}
.leave{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--badbg);color:var(--bad);font-weight:700}
.meal{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--okbg)}.meal s{color:var(--muted)}
.sec{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-top:8px}
.q{color:var(--brand);font-weight:700;min-width:56px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:650;cursor:pointer}
.done{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--okbg);color:var(--ok);font-weight:700}
.empty{color:var(--muted)}`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body>${body}
<script>${appRuntimeScript()}</script>
<script type="module">
const { App, applyDocumentTheme } = globalThis.McpApps;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clock = (t) => { if (!t) return ""; const [h, m] = t.slice(-5).split(":").map(Number); return (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h >= 12 ? "pm" : "am"); };
const app = new App({ name: ${JSON.stringify(title)}, version: "0.1.0" });
const theme = (ctx) => { if (ctx?.theme) applyDocumentTheme(ctx.theme); };
app.onhostcontextchanged = theme;
${script}
await app.connect();
theme(app.getHostContext());
</script></body></html>`;
}

export function eveningViewHtml(): string {
  return page(
    "Unrush evening",
    `<h1>Tonight <span class="sim">Simulated calendar</span></h1><div id="events" class="empty">Waiting for the schedule…</div><div id="leave"></div><div id="meal"></div>`,
    `
let household = null;
app.ontoolinput = (p) => { household = p.arguments?.household_id ?? household; };
app.ontoolresult = async (p) => {
  const s = p.structuredContent;
  if (!s?.events) return;
  household = s.household_id ?? household;
  const evening = s.events.filter((e) => e.end.slice(11) >= "12:00");
  document.getElementById("events").innerHTML = evening.length
    ? evening.map((e) => '<div class="row"><span class="t">' + clock(e.start) + "–" + clock(e.end) + "</span><span>" + esc(e.title) +
        (e.location ? ' <span class="muted">· ' + esc(e.location) + "</span>" : "") +
        (e.previous_end && e.previous_end !== e.end ? ' <span class="muted">(was until ' + clock(e.previous_end) + ")</span>" : "") + "</span></div>").join("")
    : '<span class="empty">Nothing on this evening.</span>';
  const next = evening.find((e) => e.leave_by);
  document.getElementById("leave").innerHTML = next ? '<div class="leave">Leave by ' + clock(next.leave_by) + " for " + esc(next.title) + "</div>" : "";
  try {
    const plan = await app.callServerTool({ name: "get_meal_plan", arguments: { household_id: household, week_start: s.date } });
    const day = plan.structuredContent?.days?.find((d) => d.date === s.date);
    if (day) document.getElementById("meal").innerHTML = '<div class="meal">' + (day.previous_meal ? "<s>" + esc(day.previous_meal) + "</s> → " : "") +
      "<b>" + esc(day.meal) + '</b> <span class="muted">· ' + day.prep_minutes + " min</span></div>";
  } catch { /* the host may not allow tool calls from views */ }
};`,
  );
}

export function orderViewHtml(): string {
  return page(
    "Unrush grocery order",
    `<h1>Grocery order <span class="sim">Simulated checkout</span></h1><div id="items" class="empty">Waiting for the order…</div><div id="action"></div>`,
    `
app.ontoolresult = (p) => {
  const s = p.structuredContent ?? {};
  const o = s.order !== undefined ? s.order : s;
  if (!o || !o.sections) { document.getElementById("items").innerHTML = '<span class="empty">No order yet.</span>'; return; }
  document.getElementById("items").innerHTML = o.sections.map((sec) => '<div class="sec">' + esc(sec.section) + "</div>" +
    sec.items.map((i) => '<div class="row"><span class="q">' + (i.quantity == null ? "" : i.unit === "count" ? "× " + i.quantity : i.quantity + " " + esc(i.unit)) +
      "</span><span><b>" + esc(i.item) + '</b> <span class="muted">' + esc(i.reasons.join(" · ")) + "</span>" +
      (i.product ? '<br><span class="muted">' + esc(i.product.title) + " · $" + Number(i.product.price_usd).toFixed(2) + (i.product.why === "usual" ? " · your usual" : "") + "</span>"
        : i.choices ? '<br><span class="muted">Which one? ' + esc(i.choices.map((c) => c.title).join(" / ")) + "</span>" : "") +
      "</span></div>").join("")).join("");
  const action = document.getElementById("action");
  if (o.status === "placed") {
    action.innerHTML = '<div class="done">Order placed · ' + esc(o.confirmation_number) + (o.eta_spoken ? " · arriving around " + esc(o.eta_spoken) : "") +
      '<div class="muted">Simulated order recorded: no charge, no card data. Your Amazon cart is ready to review.</div></div>' +
      (o.cart_url ? '<button id="cart">Review in Amazon cart ↗</button>' : "");
    const cart = document.getElementById("cart");
    if (cart) cart.onclick = () => app.openLink({ url: o.cart_url });
  } else {
    const pending = (o.needs_choice || []).length;
    action.innerHTML = '<button id="yes"' + (pending ? " disabled" : "") + '>Yes, place the order</button><div class="muted">' +
      (pending ? "Choose a product first (ask Unrush). " : "About $" + Number(o.estimated_total_usd || 0).toFixed(2) + " at Amazon. ") +
      "Nothing is bought until you say yes. Unrush never pays.</div>";
    document.getElementById("yes").onclick = async (ev) => {
      ev.target.disabled = true;
      await app.sendMessage({ role: "user", content: [{ type: "text", text: "Yes, place the order." }] });
    };
  }
};`,
  );
}
