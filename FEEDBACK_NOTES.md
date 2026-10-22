# Product Feedback Notes

These are running notes from the Unrush build. The detailed issues are in [FRICTION_LOG.md](FRICTION_LOG.md).

## MCP TypeScript SDK (1.32.1, spec 2025-11-25, Streamable HTTP)

### What worked well
- **`registerTool` with zod `inputSchema` + `outputSchema`.** One definition gives the model-facing JSON Schema, runtime input validation and output validation of `structuredContent`. Bad arguments come back as `isError` tool results, so the agent can correct itself.
- **Structured outputs work across protocol and UI.** `structuredContent` passes straight into Bedrock `toolResult.json` and into our UI cards, so there was no ad-hoc parsing anywhere.
- **`createMcpExpressApp()`** comes with localhost DNS-rebinding protection by default.
- **The Streamable HTTP session model is small:** about 40 lines for `Mcp-Session-Id` sessions, including the negotiated-version log and the idle reaper.
- **Client/server symmetry made strong tests cheap.** The real server on port 0 plus `Client` and `StreamableHTTPClientTransport` let us integration-test the hero flow, a reload (new session) and a server restart in one file. The demo trigger is also just an SDK client.
- **Resource templates with a `list` callback** made per-household resources discoverable in the Inspector.

### What needs work
- There's no public way to read the negotiated protocol version on the server (friction #1), and the `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` name is misleading (#2).
- There's no idle-session expiry, and the Inspector CLI leaks sessions (#3).
- The README's relative links are dead inside `node_modules` (#4), and the v1/v2 naming is confusing (#5).
- zod 4 record schemas can silently become "all keys required" (#6).
- **Proactive servers need push.** Resource subscriptions aren't available on the high-level `McpServer` (#7). For an assistant whose whole point is to speak first, a first-class "notify subscribers" API would remove the polling layer.
- Needing a fresh server per session is fine once you know it, but it should be documented up front (#8).
- **Feature idea:** a way to mark a tool argument as "client-supplied context, hidden from the model". We inject `household_id` in the bridge and strip it from the schema the model sees. That pattern is common enough to deserve protocol or SDK support.

## MCP Apps (`@modelcontextprotocol/ext-apps` 1.7.5)

**What we used it for:** two interactive views served by our MCP server (`registerAppTool` / `registerAppResource`), plus a minimal host in our web UI (`AppBridge` + `PostMessageTransport`).

### What worked well
- **Server side is two calls.** `registerAppTool` adds the `_meta.ui.resourceUri` link to the existing zod-typed tool, and `registerAppResource` serves the HTML with the right MIME type.
- **The `App` view API is pleasant.** `ontoolresult`, `callServerTool`, `sendMessage` and `applyDocumentTheme` covered everything, and auto-resize just worked.
- **`sendMessage` fits consent-first design.** The order button posts *"Yes, place the order."* into the conversation instead of calling a write tool, so every safety check still applies.
- **`AppBridge` with a `null` client** made a custom host easy: we route `oncalltool` to our backend and enforce read-only tools there.

### What needs work
- Which ext-apps line works with which SDK (#11), single-file bundling (#13), and host connection timing (#14).

## Agent Skills (SKILL.md)

- **Worked well:** the format is tiny and model-agnostic. Front matter, a markdown body and a `references/` folder gave us a reusable playbook. Any skills-aware agent can use it, and our Bedrock agent loads it at runtime with a 100-line loader.
- **Needs work:** there is no official TypeScript loader or validator package, so every agent reimplements discovery, front-matter validation and progressive disclosure.

## Amazon Bedrock AgentCore (Memory)

**What we used it for:**
- **Data plane** (`CreateEvent`, `ListEvents`, `RetrieveMemoryRecords`): conversation turns per household-day, and recall of household preferences.
- **Control plane** (`CreateMemory`, `GetMemory`, `ListMemories`): an idempotent setup script with a user-preference strategy.

### What worked well
- **Conversational payloads (USER/ASSISTANT)** map one-to-one onto agent turns, so persisting and replaying a conversation took about 30 lines.
- **Strategies extract long-term memory server-side**, so we get "what this household prefers" without writing an extraction pipeline.
- **It sits naturally next to the Converse API:** same SDK family, same credential chain, same error style.

### What needs work
- `ListMemories` summaries have no name (#15), and there's no local emulator (#16).
- Namespace templates (`{actorId}`) are powerful but easy to get subtly wrong, and errors only show up at runtime.

## Amazon Bedrock (Converse API)

**Live verification:** the full hero flow ran on `us.amazon.nova-2-lite-v1:0` in us-east-1:
1. The proactive turn: `suggest_quick_meal`.
2. "Yes": `get_meal_plan`, `suggest_quick_meal`, `save_meal_plan`, `predict_runouts`, `build_grocery_order`.
3. "Yes": `place_order`.

Credentials came from `aws login`, which the JS SDK v3 default chain picked up with no code changes.

### What worked well
- **The Converse API fits MCP closely.** `toolSpec.inputSchema.json` accepts the MCP tool JSON Schema almost unchanged (we drop `$schema` and the hidden `household_id`). The whole adapter is about 20 lines.
- **One request shape for all models.** Switching models is an env-var change (`BEDROCK_MODEL_ID`).
- **Tool results accept `{ json }`.** `status: "error"` lets the model see a refused `place_order` ("Order NOT placed: confirmed must be true…") and recover by asking the user, which is exactly the behaviour a consent-first design needs.
- **`stopReason` makes the loop trivial** (`tool_use` vs `end_turn`), and the 8-iteration cap is easy to enforce.
- **Typed errors** (`AccessDeniedException`, `ValidationException`, `ThrottlingException`, `CredentialsProviderError`) map cleanly to spoken, actionable messages.
- **Per-response `usage` tokens** made it easy to show the cost per turn in the agent activity panel.

### What needs work
- There's no offline validation or dry run for Converse requests (#9).
- Inference-profile versus model-ID confusion is the most likely first-run failure (#10).
- `ContentBlock` / `ToolResultContentBlock` unions with `$unknown` members are type-safe but verbose; passing a typed object as `json: DocumentType` needs a cast.

## Cross-cutting: building a proactive voice agent

- Streaming the agent's internals (every Converse call, `toolUse` and MCP result) over SSE to an on-screen activity panel was both the best debugging tool and the best demo asset.
- **Two independent consent locks** worked well and cost little: the MCP tool refuses without `confirmed`, and the backend gate requires an explicit yes to an order question. With both in place, a model mistake can't spend money.
- **Graceful degradation.** The MCP server writes alert text that can be spoken as-is, so Unrush still speaks first if the model call fails.

## Onboarding and "would you build with it again?"

| Tool | Onboarding (zero to hello world) | Build again? |
|---|---|---|
| MCP TypeScript SDK 1.x | Under an hour to a working Streamable HTTP server with sessions; the friction was version and doc discovery (#4, #5) | **Yes.** Typed tools with output schemas and a real client for tests make agent backends easy to trust |
| MCP Apps (ext-apps) | About an hour for both views plus a host, once we found the 1.x-compatible release (#11) | **Yes.** Shipping UI with the tools is a strong pattern for voice + screen assistants |
| Agent Skills | Minutes: write a SKILL.md | **Yes.** It's the cheapest way to make agent behaviour reviewable and portable |
| Amazon Bedrock (Converse) | Fast once model access and the inference-profile id were right (#10) | **Yes.** One API across models, and native tool use maps cleanly onto MCP |
| Amazon Bedrock AgentCore Memory | Quick to integrate; verifying it needs a live account (#16) | **Yes.** Managed short- and long-term memory removes a whole storage-and-extraction subsystem |

## Feature requests

| Request | Why it matters for Unrush | Priority |
|---|---|---|
| `McpServer` resource subscriptions (`notifyResourceUpdated`) | Unrush's whole point is speaking first. Push would replace our 3 s alert polling | Important |
| Public `Server.getProtocolVersion()` | Proving the negotiated spec version without wrapping `send()` | Nice-to-have |
| ext-apps IIFE build + SDK compatibility table | Single-file views without bundler tricks; picking the right release line | Important |
| Optional MCP peer in the Strands TS SDK | Lets Strands run in projects pinned to MCP SDK 1.x | Important |
| AgentCore Memory local emulator | Test memory flows in CI without an AWS account | Nice-to-have |
| Converse request validator / dry run | Catch `toolConfig` schema issues before you have model access | Nice-to-have |
