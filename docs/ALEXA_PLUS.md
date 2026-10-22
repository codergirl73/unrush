# Unrush on Alexa+: readiness and path

Unrush is a **simulated Alexa+ experience** today: it runs in a web browser and doesn't use an Alexa device or Alexa service. Its core, though, is a self-hosted MCP server, and that is the same thing Alexa+ add-ons connect through ([MCP Toolkit overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html)).

This page compares what the Alexa+ MCP Toolkit requires with what Unrush already does, and lists exactly what's left. Requirements are quoted from Amazon's Alexa+ developer docs (pages dated July–August 2026).

## Readiness

| Alexa+ MCP Toolkit requirement | Unrush today |
|---|---|
| "Alexa+ for Builders supports the **2025-11-25** version of the MCP specification." | ✅ Built and tested against 2025-11-25; the negotiated version is logged per session |
| "Your MCP server must support **Streamable HTTP**." | ✅ `POST`/`GET`/`DELETE /mcp`, `Mcp-Session-Id` sessions |
| "Alexa+ also supports the **MCP Apps** extension…" | ✅ Two `ui://` views (evening, grocery order) via the official `@modelcontextprotocol/ext-apps` |
| Checkout from an MCP App: the view sends a `ui/message` (e.g. "Pay for this order") and doesn't use `tools/call` for payment | ✅ Same pattern: the order view's button sends *"Yes, place the order."* as a message and never calls `place_order` itself |
| "Return **structured errors** with enough information for Alexa to ask specific follow-up questions." | ✅ Every tool returns actionable `isError` messages (e.g. which product choice is missing) |
| "Provide **stable IDs and option labels**…" | ✅ Recipe ids, event ids, order ids and product ASINs with labels (`needs_choice`) |
| "Design tools for **one-shot extraction**." | ✅ Mostly. `place_order` and `choose_product` default to the latest draft, so follow-up turns need no ids |
| Round-trip latency **< 500 ms** | ✅ Tool calls take about 0.2–4 ms locally (logged per call) |
| "Your MCP server must be accessible via a **remote URL**" (a tunnel such as cloudflared is fine during development) | ❌ Runs on `localhost` |
| **OAuth 2.1** authorization code + **PKCE (S256)**, a Protected Resource Metadata document (RFC 9728), `/.well-known/oauth-authorization-server`, and `401` *without* `WWW-Authenticate` for unauthenticated requests | ❌ No auth (local demo). `household_id` would come from the linked account instead of a tool argument |
| Checkout via **Amazon Wallet**: `POST /checkout-sessions` (create / get / update / complete / cancel) with idempotency keys. "Alexa+ handles voice PIN, payment instrument selection, and purchase confirmation" | ❌ Simulated checkout plus real Amazon product links (the user adds to cart). Alexa+ checkout would replace the simulated `place_order` |
| Add-on metadata (`addon.json`: name ≤ 30 chars, short description ≤ 123, 3–4 example phrases) and a privacy policy URL | ❌ Not created yet (drafts below) |

**Not covered by these docs:** proactive notifications, where Alexa speaks first. Unrush's "speak first" moment is a web-backend feature (alert polling + Server-Sent Events). On Alexa+ it would depend on whatever proactive mechanism Amazon offers add-ons. Until then, the same alerts can be surfaced when the customer next talks to Alexa (`get_alerts`).

## Path to a live Alexa+ add-on

1. **Request Private Preview access.** "After you decide to proceed, you request access to the Private Preview. After approval, you receive credentials and install the tooling" ([Development stages](https://developer.amazon.com/docs/alexaplus/add-ons/alexa-plus-add-on-development-stages.html)).
2. **Put the MCP server on a public HTTPS URL.** Use `cloudflared` for development, then a real deployment (for example AWS Lambda behind a function URL, or a container). SQLite would move to a managed store (for example DynamoDB) for multiple instances.
3. **Add OAuth 2.1 + PKCE** following the toolkit's authentication checklist ([QuickStart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)). The linked account identifies the household, so `household_id` disappears from tool inputs (our web backend already injects it rather than letting the model choose).
4. **Scaffold and deploy the add-on** with the Alexa-AI CLI or its Add-on Agent Skill:
   ```bash
   alexa-ai configure
   alexa-ai new mcp --name "Unrush" --locale en-US --mcp-server-url "https://<public-host>/mcp"
   alexa-ai deploy           # Alexa+ refreshes tool info only on deploy
   alexa-ai test --test-suite
   alexa-ai submit
   ```
5. **Replace the simulated checkout with Amazon Wallet checkout** ([Checkout endpoints](https://developer.amazon.com/docs/alexaplus/add-ons/implement-checkout-endpoints.html)). Implement `/checkout-sessions` (create, get, update with tax and shipping, complete, cancel) with 24-hour idempotency. Alexa+ owns payment selection and confirmation, so the consent model stays the same: nothing is bought without the customer's explicit confirmation, now enforced by Alexa+.
6. **Certify.** All golden tests pass, a privacy policy URL is provided, and the UI passes the automated Alexa UX guidelines check.

## Draft add-on metadata

- **name** (≤ 30): `Unrush`
- **shortDescription** (≤ 123): `Keeps your evening on track: leave-by alerts when plans change, a quick dinner that fits, and groceries from your usuals.`
- **examplePhrases** (3–4, ≤ 200 each):
  - "Alexa, ask Unrush when I need to leave."
  - "Alexa, ask Unrush what I can cook in fifteen minutes."
  - "Alexa, tell Unrush we're out of eggs."
  - "Alexa, ask Unrush what we need from the store."

## Why not the classic "Alexa Shopping Actions" add-to-cart?

Classic Alexa custom skills can hand Alexa a product with `connection://AMAZON.AddToShoppingCart/1`. We evaluated it and ruled it out:
- It takes **one product per request**.
- "Whole Foods and Prime Now grocery items" are listed as **ineligible**.
- Amazon requires the skill to be **certified and published** in each locale.
- The docs were last updated in 2024.

Until Alexa+ checkout is available, Unrush's real handoff is a link to each chosen product's Amazon page (the customer's usual products), where the customer adds it to their cart. Amazon's older bulk add-to-cart link (`/gp/aws/cart/add.html`) redirected to an empty cart when we tested it signed in ([Alexa Shopping Actions API reference](https://developer.amazon.com/en-US/docs/alexa/alexa-shopping/alexa-shopping-actions-for-alexa-skills-api-reference.html)).
