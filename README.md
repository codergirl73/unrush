# Unrush

**An assistant that speaks first, before your evening falls apart.**

Unrush is a proactive household assistant presented as a **simulated Alexa+ experience**. It watches your calendar, your kitchen and your groceries. When a late meeting squeezes your evening, it tells you when to leave, swaps tonight's dinner for something that fits, notices the eggs are out and the milk is about to run out, and drafts the grocery order. Nothing is bought until you say yes.

Built for **Build, Ship, Shape: Amazon Developer Hackathon** (Alexa+ track + AWS Builder mini challenge).

![Unrush demo: the 5:30 meeting runs late, Unrush speaks first with a leave-by time and a 15-minute dinner swap, picks the usual groceries, asks which pesto, and places a simulated order only after an explicit yes, with a link to each product on Amazon.](docs/media/unrush-demo.gif)

*Recorded locally on real Amazon Bedrock (Nova 2 Lite) with AgentCore Memory, using the guided demo: make the meeting run late → Unrush speaks first → say yes → pick a pesto → "Yes, place the order." To try it yourself, see [Setup](#setup) and [Run](#run).*

- **Self-hosted MCP server:** spec **2025-11-25** over **Streamable HTTP**, built with the official TypeScript SDK `@modelcontextprotocol/sdk` **1.32.1**.
- **MCP Apps:** the server ships interactive `ui://` views (evening timeline, grocery order) via the official `@modelcontextprotocol/ext-apps`.
- **Agent Skill:** `skills/unrush-evening-rescue/SKILL.md` (open Agent Skills format), loaded by the agent at runtime.
- **Amazon Bedrock:** the Converse API runs the agent loop and calls the MCP tools. **Amazon Bedrock AgentCore Memory** (optional) keeps the conversation and household preferences across sessions and restarts.
- TypeScript everywhere, Node 20+, npm workspaces, SQLite, Vitest. MIT licensed.

> **What is real and what is simulated?** See [Real vs simulated](#real-vs-simulated). In short, the MCP server, the Bedrock agent, the prediction logic and the memory are real. The calendar data, the travel times and the checkout are simulated and labelled **Simulated** in the UI.

---

## The hero flow

1. **A late meeting lands.** Your 5:30 Project sync now runs to 7:00, on an evening you planned to cook (`npm run demo:trigger`).
2. **Unrush speaks first:** *"Your 5:30pm Project sync now runs to 7pm. To reach your 7:30pm Study group you'll need to leave by 7:05pm."*
3. **The dinner swap.** Tonight's 45-minute chicken curry no longer fits; your longest free stretch is 40 minutes. Unrush offers a 15-minute tomato & garlic spaghetti made from what's in the pantry.
4. **Groceries.** Eggs are out (you said so this morning). Milk will run out tomorrow, predicted from six weeks of purchases.
5. **The order.** Unrush builds the order with **your usual products** from past orders, and **asks which one** for anything new ("Which pesto?"). It reads the order back and asks *"Shall I place the order?"* Nothing is bought without an explicit yes. On yes you get a **simulated** confirmation, plus **a link to each product on Amazon**, where you add it to your cart and check out yourself.
6. **Memory.** Reload the page, start a new session or restart the server, and Unrush still remembers everything, because the state lives in the MCP server's SQLite database.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser · React (simulated Alexa+ experience)"]
    UI["Voice orb · cards · agent activity panel"]
  end
  subgraph Web["Web backend · Express (packages/web/server)"]
    API["/api/chat · /api/state<br/>/api/events (SSE)"]
    Agent["Agent loop<br/>ConverseCommand ⇄ tools<br/>(≤ 8 iterations)"]
    Poller["Alert poller<br/>get_alerts every 3 s"]
    Skills["Agent Skill<br/>SKILL.md + load_skill"]
    AppsHost["MCP Apps host<br/>AppBridge (iframe)"]
    Bridge["McpBridge<br/>SDK Client +<br/>StreamableHTTPClientTransport"]
  end
  subgraph AWS["Amazon Bedrock"]
    Converse["Converse API<br/>(BEDROCK_MODEL_ID)"]
    ACMem["AgentCore Memory<br/>events + preferences<br/>(optional)"]
  end
  subgraph MCP["Unrush MCP server (packages/mcp-server)"]
    HTTP["POST/GET/DELETE /mcp<br/>Mcp-Session-Id · spec 2025-11-25"]
    Tools["17 tools · 2 resources<br/>2 MCP Apps ui:// views"]
    Engine["Proactive checker<br/>every 60 s + on every write"]
    Providers["CalendarProvider → SimulatedCalendar<br/>TravelProvider → SimulatedTravel<br/>Clock"]
    DB[("SQLite<br/>UNRUSH_DB_PATH")]
  end

  UI -- "text / speech" --> API
  API -- "SSE: proactive speech,<br/>tool calls, replies" --> UI
  API --> Agent
  Poller --> Agent
  Agent <--> Converse
  Agent --> Skills
  API <--> ACMem
  UI --> AppsHost
  AppsHost --> API
  Agent --> Bridge
  Poller --> Bridge
  Bridge <--> HTTP
  HTTP --> Tools
  Tools --> DB
  Tools --> Providers
  Engine --> DB
  Trigger["npm run demo:trigger<br/>(SDK client)"] --> HTTP
```

**How a proactive moment flows:**
1. `demo:trigger` (itself an MCP SDK client) calls `add_or_update_event`.
2. The MCP server's proactive checker runs immediately and writes `leave_by` and `meal_fit` alerts to SQLite.
3. The backend's poller claims them with `get_alerts {mark_delivered: true}`.
4. The poller runs the Bedrock agent with a *proactive instruction* ("speak first; explain, propose the fix, ask one yes/no question; don't act yet").
5. The agent calls MCP tools (`compute_leave_by`, `suggest_quick_meal`).
6. The backend streams every step to the browser over Server-Sent Events. The browser shows the banner, speaks the reply and fills the activity panel.

## MCP server

`packages/mcp-server` is the piece to read first. It is a self-hosted MCP server.

| | |
|---|---|
| Spec | **2025-11-25**. The negotiated version is logged at each session init and checked: `✓ session initialized {"requestedProtocol":"2025-11-25","negotiatedProtocol":"2025-11-25",…}` |
| Transport | **Streamable HTTP** at `/mcp`: `POST` (JSON-RPC), `GET` (SSE stream), `DELETE` (end session); `Mcp-Session-Id` session management; idle sessions reaped after 30 min; localhost DNS-rebinding protection via `createMcpExpressApp` |
| SDK | `@modelcontextprotocol/sdk` 1.32.1: `McpServer`, `registerTool`, `ResourceTemplate`, `StreamableHTTPServerTransport` on the server; `Client` and `StreamableHTTPClientTransport` in the web backend, the demo trigger and the tests |
| State | Everything is keyed by `household_id` and stored in SQLite (`UNRUSH_DB_PATH`, default `./data/unrush.db`). It survives sessions and restarts. |
| Logging | Every tool call is logged with its arguments and duration in ms; proactive alerts are logged when they fire |

**Tools.** Each tool has a zod input schema, a structured output schema and an LLM-oriented description.

| Area | Tool | What it does |
|---|---|---|
| Calendar | `get_schedule` | Events for a date (default today), with `leave_by` for events that need travel, plus `now` |
| | `add_or_update_event` | Create an event, or change one by id (the "late meeting") |
| | `compute_leave_by` | event start − travel (TravelProvider) − buffer; also the free minutes after the previous event, and any overlap |
| Pantry & meals | `get_pantry` / `update_pantry` | add / remove / set. "We're out of eggs" is `remove` with no quantity, which also records that the item ran out |
| | `get_preferences` / `set_preferences` | Diets, allergies, household size, usual and latest dinner time, leave buffer |
| | `get_meal_plan` / `save_meal_plan` | One dinner per date, with `prep_minutes` and ingredients. A swap by `recipe_id` keeps `previous_meal` |
| | `suggest_quick_meal` | Recipes ≤ `max_minutes` from a seeded library, filtered by diet and allergies, ranked by fewest missing pantry items |
| | `mark_meal_cooked` | Subtracts the dinner's ingredients from the pantry and logs the consumption. Idempotent |
| Groceries | `predict_runouts` | Per staple: predicted run-out date, confidence and a one-line reasoning, from purchase and usage history |
| | `build_grocery_order` | Missing meal ingredients + predicted run-outs + out-of-stock items, deduplicated and grouped by store section. Saved as a **draft** |
| | `place_order` | **Refuses unless `confirmed: true`.** Returns a simulated `SIM-XXXXXX` confirmation and ETA, and records the purchase so later predictions learn from it |
| | `choose_product` | Sets which store product to buy for an item the household has no history for (e.g. which pesto); placed choices become "your usual" |
| | `get_order` | The latest order (or one by id), with its read-back |
| Proactive | `get_alerts` | Re-evaluates the rules and returns pending alerts. `mark_delivered` stops an alert from repeating |

**Resources:**
- `unrush://households/{id}/pantry`
- `unrush://households/{id}/schedule/today`

**MCP Apps** (`@modelcontextprotocol/ext-apps` 1.7.5, the release line built for MCP SDK 1.x). The server registers two interactive views with `registerAppResource`, served as `text/html;profile=mcp-app`:

| View | Linked tools (`_meta.ui.resourceUri`) | What it shows |
|---|---|---|
| `ui://unrush/evening.html` | `get_schedule` | Tonight's events (moved meeting vs its old end), the leave-by time, and tonight's dinner before → after. It calls `get_meal_plan` itself through the host |
| `ui://unrush/order.html` | `build_grocery_order`, `get_order`, `place_order` | Items by aisle with reasons, plus a consent-first button |

Any MCP Apps-capable chat host renders these views inline. Each view is one self-contained HTML file that inlines the official `App` runtime, follows the host theme and auto-resizes. The order view's button **does not** call `place_order`: it sends *"Yes, place the order."* as a user message, so the normal consent path decides.

The Unrush web UI includes a small MCP Apps host (the official `AppBridge` + `PostMessageTransport`, in a sandboxed iframe). Flip **Cards → MCP Apps** in the header to see the same cards served by the MCP server. Tool calls from inside views are proxied for read-only tools only.

**Proactive checker.** The checker runs every 60 s and immediately after any calendar, pantry, plan or order write. Its rules:
- **(a) leave_by:** the departure is squeezed by the previous event (≤ 30 min of slack, or an overlap), or it is within 60 min.
- **(b) meal_fit:** tonight's dinner `prep_minutes` is longer than the longest free stretch. The stretch runs from `cook_window_start` to `latest_dinner_time`, minus events and travel.
- **(c) runout:** a staple is out, or is predicted to run out within 2 days.

Alerts are stored with dedupe keys and resolve themselves when the situation goes away (for example, the meeting moves back or the dinner is swapped).

**Run-out prediction.** For each staple bought at least 3 times:
- daily usage = (total bought − on hand) ÷ days since the first purchase
- days left = on hand ÷ daily usage
- confidence comes from the number of purchases and how regular the intervals were (coefficient of variation)

The reasoning string is meant to be read aloud, for example: *"Bought 11× in the last 6 weeks, about every 4 days (usually 2 l). Uses ~511 ml/day. 600 ml left → likely runs out tomorrow."*

**Providers.**
- `CalendarProvider`: the default is `SimulatedCalendar` (seeded events in SQLite).
- `TravelProvider`: the default is `SimulatedTravel` (fixed minutes per place, e.g. Library 20).
- `Clock`: real time, or `UNRUSH_NOW`.

A Google Calendar provider or a real maps API would implement the same interfaces. Both are on the roadmap and not built.

**Checking it with MCP Inspector:**

```bash
npm run dev
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: http://localhost:3001/mcp → Connect → Tools → get_alerts {household_id: "demo-household"}
```

## Agent Skill

[`skills/unrush-evening-rescue/SKILL.md`](skills/unrush-evening-rescue/SKILL.md) is written in the open Agent Skills format: YAML front matter with `name` and `description`, a playbook body, and `references/consent.md`. It encodes the rescue order: leave-by first, then the dinner swap, then groceries, ordering only on an explicit yes.

Any skills-aware agent can use it. In Unrush it is **loaded at runtime** by [`packages/web/server/skills.ts`](packages/web/server/skills.ts):
1. Skills are discovered and their front matter validated at startup.
2. The skill catalog (name + description) goes into the system prompt.
3. A local `load_skill` tool gives progressive disclosure, including referenced files (with a path-escape check).
4. Proactive turns activate the skill directly, so its playbook is always in context when Unrush speaks first.

## Where Amazon Bedrock is used

Bedrock is on the live code path for every conversation turn and every proactive moment. It is not optional decoration.

| File | What it does |
|---|---|
| [`packages/web/server/config.ts`](packages/web/server/config.ts) | Creates `BedrockRuntimeClient` from `@aws-sdk/client-bedrock-runtime` with `AWS_REGION`. Credentials come **only** from the default AWS credential chain |
| [`packages/web/server/mcpBridge.ts`](packages/web/server/mcpBridge.ts) | Converts the MCP `tools/list` result into a Converse `toolConfig` (`toolSpec.inputSchema.json`), hiding `household_id` from the model |
| [`packages/web/server/agent.ts`](packages/web/server/agent.ts) | Calls `ConverseCommand` with system prompt + history + tools. On `stopReason: "tool_use"` it runs each `toolUse` through MCP and sends back `toolResult` blocks (`json`, or `status: "error"`), repeating until `end_turn`. Capped at 8 model calls; `maxTokens` comes from `BEDROCK_MAX_TOKENS` |
| [`packages/web/server/app.ts`](packages/web/server/app.ts) | Runs the agent for chat turns (`POST /api/chat`) and for proactive turns (alert poller), streaming every step to the UI |
| [`packages/web/server/prompt.ts`](packages/web/server/prompt.ts) | Warm, brief voice persona anchored to the MCP server's clock: always use tools, short replies that can be spoken, never order without an explicit yes |
| [`packages/web/server/agentcore.ts`](packages/web/server/agentcore.ts) | **Amazon Bedrock AgentCore Memory** (`@aws-sdk/client-bedrock-agentcore`), optional, on when `AGENTCORE_MEMORY_ID` is set. Each turn is saved with `CreateEvent` (USER/ASSISTANT conversational payloads; actor = household, session = household + day). A new browser session or a restarted backend reloads the day with `ListEvents`. `RetrieveMemoryRecords` pulls preferences that the memory's user-preference strategy extracted into the system prompt. Every call is best-effort and shown in the activity panel |
| [`packages/web/server/agentcore-setup.ts`](packages/web/server/agentcore-setup.ts) | `npm run agentcore:setup` (`@aws-sdk/client-bedrock-agentcore-control`): `CreateMemory` with a user-preference strategy, then waits until it is ACTIVE and prints the `.env` line |

**AWS services used:** Amazon Bedrock (Converse API) for the agent and tool use, and Amazon Bedrock AgentCore (Memory, data plane and control plane) for conversation and preference memory.

The model is never hard-coded: set `BEDROCK_MODEL_ID` to a model or inference profile enabled in your account. Tool use is required. **Amazon Nova 2 Lite** (`us.amazon.nova-2-lite-v1:0`) is the recommended small, cheap default. In our live tests it chained the 5 tool calls of the hero flow in one turn and kept replies speakable; Nova Lite (`us.amazon.nova-lite-v1:0`) also works but tends to answer in bullet lists.

**Two locks on "nothing is bought without your yes":**
1. The MCP `place_order` tool refuses unless `confirmed === true`.
2. The backend blocks any `place_order {confirmed: true}` unless the assistant's previous turn asked about placing the order **and** the user's reply is an unambiguous yes ([`consent.ts`](packages/web/server/consent.ts)). Proactive turns can never place orders.

## Real vs simulated

| Piece | Status |
|---|---|
| MCP server, tools, Streamable HTTP sessions, SQLite memory | **Real** |
| Amazon Bedrock Converse agent loop with tool use | **Real** (needs your AWS account) |
| Leave-by math, free-time windows, quick-meal ranking, run-out prediction, order building | **Real** logic |
| Speech recognition and speech output | **Real** browser Web Speech APIs |
| Calendar events | **Simulated:** seeded demo data (`SimulatedCalendar`), labelled in the UI |
| Travel times | **Simulated:** fixed estimates per place (`SimulatedTravel`) |
| Grocery checkout, confirmation number, ETA | **Simulated:** Unrush never places a real order and no money moves. The UI labels it "Simulated checkout" |
| Store products and Amazon links | **Real:** Amazon's own grocery brands with real ASINs (`packages/mcp-server/src/domain/catalog.ts`). After "yes", each product links to its Amazon page (`amazon.com/dp/<ASIN>`, all 9 verified) where **you** add it to your cart and check out. Amazon's old bulk add-to-cart link redirected to an empty cart when tested signed in, so it isn't used. Prices shown are a snapshot estimate |
| Six weeks of purchase history | **Simulated:** seeded so the prediction has data to learn from |
| AgentCore Memory | **Real** when `AGENTCORE_MEMORY_ID` is set (your AWS account); otherwise in-process memory |
| MCP Apps views | **Real** MCP Apps resources; the in-app host is a minimal reference host |
| "Offline rehearsal" mode (`npm run dev:offline`) | A **scripted stand-in, not Bedrock**, for rehearsing the UI without AWS. Its MCP calls are real. The UI shows an orange "Offline rehearsal (not Bedrock)" badge whenever it is on |

This is a **simulated Alexa+ experience** in a web browser. It is not an Alexa skill and does not use any Amazon device or Alexa service.

## Privacy

- **Data stays local.** All household state is in a SQLite file on your machine. The only data that leaves it is the conversation and tool results sent to Amazon Bedrock and, if you turn it on, conversation turns stored in AgentCore Memory, both in your own AWS account.
- **Nothing is bought without explicit consent.** Two independent checks enforce this (see above). Checkout is simulated anyway.
- **No card data.** There are no payment fields or payment APIs anywhere, and nothing that stores card data. The simulated checkout only produces an order summary and a fake confirmation number.
- `.env` and `*.db` are gitignored. Credentials are never written by the app.

## Setup

**Prerequisites:** Node.js 20.6+ (developed on Node 24) and an AWS account.

1. **Enable a Bedrock model.** In the Amazon Bedrock console, pick your region (e.g. `us-east-1`), open **Model access** and enable a model that supports tool use. *Amazon Nova Lite* is cheap and fast. Many models must be called through a **cross-region inference profile** (IDs like `us.amazon.nova-lite-v1:0`); check **Cross-region inference** in the console for the exact ID available to you.
2. **Credentials** come from the default AWS credential chain. The simplest is `aws login` (AWS CLI 2.32+, browser sign-in, short-lived credentials); `aws configure`, `aws sso login`, `AWS_PROFILE`, environment variables or an IAM role also work. The identity needs `bedrock:InvokeModel` for that model or profile.
3. **Install and configure:**

```bash
git clone <this repo> && cd amazon-developer-hackathon
npm install
cp .env.example .env      # set AWS_REGION and BEDROCK_MODEL_ID; optionally UNRUSH_NOW=15:00
npm run seed              # create / reset the demo household
npm run agentcore:setup   # optional: create the AgentCore memory, then add AGENTCORE_MEMORY_ID to .env
```

AgentCore Memory needs `bedrock-agentcore:CreateMemory`, `GetMemory` and `ListMemories` for the setup script, and `CreateEvent`, `ListEvents` and `RetrieveMemoryRecords` at runtime. Without it, Unrush uses in-process conversation memory; household state is always kept in the MCP server.

## Run

```bash
npm run dev               # MCP server :3001 + API :3000 + UI http://localhost:5173
npm run demo:trigger      # in another terminal: the late meeting lands → Unrush speaks first
npm run seed              # reset everything for another take (also clears today's AgentCore conversation if enabled)
```

- `npm run chat` is a terminal REPL against Bedrock + MCP, useful to check your model before opening the UI.
- `npm run dev:offline` rehearses the UI without AWS, using the scripted stand-in (not Bedrock).
- **Recording tip:** the demo evening runs 5:30 to 9:30pm. If you record later in the day, set `UNRUSH_NOW=15:00` in `.env`, then reseed and restart, so the Unrush clock starts at 3pm and keeps ticking.
- **Voice:** hold the orb (or Space) to talk; Chrome has the best Web Speech support. Use the speaker toggle to mute spoken replies.
- **Guided demo:** the step bar under the header follows the story from the live state. **Make the meeting run late** does what `npm run demo:trigger` does, and **Start over** re-seeds the day at 3pm (no `UNRUSH_NOW` needed).

## Host it

`deploy/deploy.sh` puts a public demo on one EC2 t4g.micro in your account. It runs the MCP server, the web backend and Caddy, which gives it automatic HTTPS on an `<ip>.sslip.io` hostname.

```bash
./deploy/deploy.sh      # reads AWS_REGION, BEDROCK_MODEL_ID and AGENTCORE_MEMORY_ID from .env; prints the URL
./deploy/update.sh      # pull the latest main onto the instance and restart
./deploy/teardown.sh    # delete everything it created
```

- **A household per visitor.** With `UNRUSH_PUBLIC=1`, each browser gets its own household by cookie, seeded so its day starts at 3pm whenever the visitor arrives. Each household has its own alerts, conversation and AgentCore actor, and is deleted after 24 hours.
- **Capped Bedrock use.** Visitors get 40 messages an hour, an address can start 10 sessions an hour, and the whole site gets 1,500 Bedrock turns a day. Set these with `UNRUSH_TURNS_PER_HOUR`, `UNRUSH_HOUSEHOLDS_PER_IP_PER_HOUR` and `UNRUSH_TURNS_PER_DAY`. Past the daily cap, Unrush still speaks first using the alert text.
- **Least privilege, no keys.** The instance's IAM role allows only Converse with the configured model and the four AgentCore Memory calls ([deploy/iam-policy.json](deploy/iam-policy.json)). Only ports 80 and 443 are open, with no SSH; use Session Manager for a shell. The MCP server listens on localhost only.
- **Cost:** about $10 a month (t4g.micro, public IPv4 address, 8 GB disk) plus Bedrock usage.

## Test

```bash
npm test          # 104 Vitest tests across both workspaces
npm run typecheck
```

What the tests cover:
- **Every tool:** leave-by math and overlaps, free-time windows, quick-meal ranking with diet and allergy filters, run-out prediction (dates, confidence, reasoning), order building and dedupe, and `place_order` refusing without confirmation.
- **Proactive rules,** dedupe and self-resolution.
- **MCP integration:** the real HTTP server driven by the SDK client, checking that the negotiated protocol is `2025-11-25`, the tool and resource listing, the hero flow with the agent scripted, reconnect, and a server restart.
- **Agent loop:** a fake Converse client against the real MCP server, including the order-consent gate and the 8-iteration cap.
- **MCP Apps:** tool `_meta` links, resource MIME type and HTML, and host routes (views may call read-only tools only).
- **Agent Skill:** front-matter validation, `load_skill` (including path escapes), and activation on proactive turns.
- **AgentCore Memory:** command shapes against a fake data plane, continuity across a backend restart, recall in the prompt, and turns that still succeed when AgentCore fails.
- **Phase 3 end to end:** late meeting → SSE proactive speech → swap → read-back → explicit yes → simulated confirmation, plus the fallback that still speaks first when the model is unavailable.
- **Hosted demo:** separate households per browser, a 3pm clock whatever the real time, the late-meeting and reset endpoints, and the turn and session caps.

## Cost

A full hero run is about 6–8 Converse calls of a few thousand input tokens each (mostly the 16 tool schemas). With Amazon Nova Lite that is a fraction of a cent per run; check current Bedrock pricing for your model and region. `BEDROCK_MAX_TOKENS` caps output per call, and token usage is shown per turn in the agent activity panel. AgentCore Memory, if enabled, adds a small per-event and per-retrieval charge (two or three calls per turn); check current AgentCore pricing. Nothing else in the stack costs money.

## Project layout

```
packages/mcp-server   MCP server: transport, tools, proactive engine, providers, seed, demo trigger, tests
packages/web/server   Express backend: MCP client bridge, Bedrock agent loop, consent gate, SSE, CLI
packages/web/src      React UI: voice panel, cards, MCP Apps host, agent activity panel
skills/               Agent Skills (SKILL.md) loaded at runtime
docs/ALEXA_PLUS.md    Alexa+ MCP Toolkit readiness and path to a live add-on
DEMO_SCRIPT.md        2:45 video script
FRICTION_LOG.md       Friction hit with the MCP SDK, Streamable HTTP and Bedrock
FEEDBACK_NOTES.md     What worked well / what needs work
```

## Alexa+ readiness

Alexa+ add-ons connect through the **Alexa+ MCP Toolkit**, which requires an MCP server on spec **2025-11-25** over **Streamable HTTP**, and supports **MCP Apps**. Those are exactly what Unrush's server implements. What a live add-on still needs:
- a public HTTPS URL;
- OAuth 2.1 with PKCE for account linking;
- Amazon Wallet checkout endpoints in place of the simulated checkout;
- Private Preview access.

See **[docs/ALEXA_PLUS.md](docs/ALEXA_PLUS.md)** for a requirement-by-requirement comparison with Amazon's docs, the exact path (`alexa-ai new mcp … && alexa-ai deploy`), and draft add-on metadata.

## Coming next

Out of scope for the hackathon build and not implemented:
- **Live on Alexa+:** connect this MCP server through the Alexa+ MCP Toolkit (public hosting + OAuth 2.1), and move checkout to Amazon Wallet so Alexa+ handles payment and confirmation. See [docs/ALEXA_PLUS.md](docs/ALEXA_PLUS.md)
- **Real integrations:** Google Calendar (`CalendarProvider`) and live travel times (`TravelProvider`), behind env flags
- **Fitness and workouts**
- **Body tracking**
- **Habit and goal coaching**
- **Restaurant suggestions** when there's no time to cook at all
- **Ride booking** when the leave-by time is too tight

## License

[MIT](LICENSE)
