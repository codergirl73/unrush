# @unrush/mcp-server

Self-hosted MCP server for Unrush. It uses MCP spec **2025-11-25** over **Streamable HTTP** and is built with the official
TypeScript SDK (`@modelcontextprotocol/sdk` 1.x). All state is stored per `household_id` in SQLite (`UNRUSH_DB_PATH`).

```bash
npm run dev            # http://127.0.0.1:3001/mcp  (POST / GET / DELETE, Mcp-Session-Id sessions)
npm run seed           # reset the demo household
npm run demo:trigger   # the "late meeting" (an SDK client calls add_or_update_event)
npm test               # unit tests + SDK integration test
```

At each session init the server logs the negotiated protocol version, and it warns if that version is not `2025-11-25`:

```
✓ session initialized {"client":"…","requestedProtocol":"2025-11-25","negotiatedProtocol":"2025-11-25","target":"2025-11-25"}
```

## Tools (17)

| Area | Tools |
|---|---|
| Calendar | `get_schedule`, `add_or_update_event`, `compute_leave_by` |
| Pantry & meals | `get_pantry`, `update_pantry`, `get_preferences`, `set_preferences`, `get_meal_plan`, `save_meal_plan`, `suggest_quick_meal`, `mark_meal_cooked` |
| Groceries | `predict_runouts`, `build_grocery_order`, `place_order` (refuses unless `confirmed: true`; checkout is simulated), `get_order` |
| Proactive | `get_alerts` |

Every tool has a zod input schema and a structured output schema, and each call is logged with its duration.

**Resources:**
- `unrush://households/{household_id}/pantry`
- `unrush://households/{household_id}/schedule/today`

**MCP Apps** (`@modelcontextprotocol/ext-apps` 1.7.5):
- `ui://unrush/evening.html`, linked to `get_schedule`
- `ui://unrush/order.html`, linked to `build_grocery_order`, `get_order` and `place_order`

Both are self-contained HTML (`text/html;profile=mcp-app`) using the official `App` runtime. The order view asks for consent through a chat message; it never calls `place_order` itself.

## Proactive checker

The checker runs every 60 s inside the server. It also runs right after any calendar, pantry, plan or order write. Rules:

1. **leave_by:** an upcoming event's departure (start − travel − buffer) falls within 30 min of the previous event's end, or within the next 60 min.
2. **meal_fit:** tonight's planned dinner takes longer than the longest free stretch between `cook_window_start` and `latest_dinner_time`.
3. **runout:** a staple is out, or is predicted to run out within 2 days.

Alerts are deduplicated and resolve themselves when the situation goes away.

## Providers (simulated by default)

- `CalendarProvider` → `SimulatedCalendar`: seeded events stored in SQLite.
- `TravelProvider` → `SimulatedTravel`: fixed estimates per place (Library 20 min, Gym 10 min, …).
- `Clock` → real local time, or `UNRUSH_NOW=15:00` to start the clock at 3pm so the demo works at any hour.

## Verify with MCP Inspector

```bash
npm run dev                                   # in one terminal
npx @modelcontextprotocol/inspector           # in another
```

1. In the Inspector, choose transport **Streamable HTTP** and URL `http://localhost:3001/mcp`, then click **Connect**.
2. Open **Tools** → `get_alerts`, and use `household_id = demo-household`.
3. Run `npm run demo:trigger`, then call `get_alerts` again to see the leave-by and meal-fit alerts.

The server terminal shows the Inspector's negotiated protocol version.
