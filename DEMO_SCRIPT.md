# Unrush: demo video script (2:45)

**Before recording:**
- Set `UNRUSH_NOW=15:00` in `.env`, then run `npm run seed && npm run dev`.
- Open http://localhost:5173 in Chrome at 1920×1080, light mode, voice on, with the agent activity panel visible.
- Keep a second terminal ready with `npm run demo:trigger` typed but not run.
- Do one dry run, then `npm run seed` again and reload the page.

| Time | On screen | Voice-over / action |
|---|---|---|
| **0:00–0:05** | The full UI: the evening timeline shows Project sync 5:30–6:00, Study group 7:30 at the Library, and tonight's 45-min curry | "It's 3pm. Maya has a call at 5:30, study group at 7:30, and she planned to cook a curry in between." |
| **0:05–0:10** | Run `npm run demo:trigger` in the terminal (the frame can show both) | "Then her 5:30 meeting gets pushed to run until 7." |
| **0:10–0:22** | The banner drops in and Unrush **speaks first**. The timeline shows the meeting stretching over its old slot, the red **Leave by 7:05** marker and the dinner card's **Won't fit** badge. The activity panel shows the bolt turn with `compute_leave_by` → `suggest_quick_meal` | (Let Unrush speak:) *"Your 5:30pm Project sync now runs to 7pm. To reach your 7:30pm Study group you'll need to leave by 7:05pm. Your curry won't fit tonight. Want me to swap in tomato and garlic spaghetti? It takes 15 minutes…"* |
| **0:22–0:30** | Hold the orb and say **"Yes please."** The dinner card flips: curry struck through → spaghetti, 15 min | "Nobody asked it anything. Unrush noticed the conflict, did the math and offered a fix." |
| **0:30–1:00** | The reply mentions eggs out and milk running out tomorrow and reads the order back. Zoom on **Running low**: the milk reasoning (*"Bought 11× in the last 6 weeks, about every 4 days… runs out tomorrow"*) and the confidence bar. Pan to the activity panel: `save_meal_plan`, `predict_runouts`, `build_grocery_order`, each with its result | "In the same turn it saved the swap and checked the kitchen. Eggs: Maya told it this morning they were out. Milk: it predicted tomorrow's run-out from six weeks of purchases, with its reasoning shown. Then it drafted an order and asked first." |
| **1:00–1:25** | Show the order card (Simulated store badge, items grouped by aisle with reasons). Say **"Yes, go ahead."** The activity panel shows `get_order` → `place_order` ok; the card turns green: **Order placed · SIM-XXXXXX** | "Nothing gets bought without an explicit yes. The MCP tool refuses unless `confirmed` is true, and the backend separately blocks the call unless you actually said yes to the order question. Checkout here is simulated: no store, no card data, just a confirmation." |
| **1:25–1:45** | Expand one tool call in the activity panel to show its JSON input and result. Point at the header chip: **MCP 2025-11-25 · Streamable HTTP · 16 tools** and **Amazon Bedrock · nova-lite** | "Every step you see is a real Amazon Bedrock Converse call driving tools on our own MCP server: spec 2025-11-25 over Streamable HTTP, built on the official TypeScript SDK." |
| **1:45–2:10** | **Reload the page.** The welcome-back bubble appears: *"I still remember tonight's swap to Tomato & garlic spaghetti, your order SIM-…, the meeting that ran late."* All cards are restored. Optionally restart `npm run dev` and reload again | "Reload, new session, even a server restart: Unrush still remembers, because the state lives in the MCP server's SQLite store, keyed to the household." |
| **2:10–2:30** | Quick architecture view (README Mermaid diagram) | "Browser, then a Bedrock agent loop that's an MCP client, then our MCP server with a proactive checker that runs every minute and on every change. Calendar and travel are simulated providers behind interfaces, ready for real ones." |
| **2:30–2:40** | The "Coming next" list | "Next: real calendars and live travel, then restaurants and rides for the nights there's no time at all." |
| **2:40–2:45** | Logo + tagline | **"Unrush. It speaks first, so your evening doesn't fall apart."** |

**Fallbacks while recording:**
- If the mic misfires, type the same words into the text box.
- If Bedrock is unavailable, Unrush still speaks first using the server-written alert text. For a full rehearsal without AWS, use `npm run dev:offline`, which is clearly badged as not Bedrock. Don't use it for the final take.
