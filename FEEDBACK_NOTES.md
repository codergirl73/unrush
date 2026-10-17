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

## Amazon Bedrock (Converse API)

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
