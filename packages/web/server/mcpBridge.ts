/**
 * MCP client side of the web backend. Connects to the Unrush MCP server over
 * Streamable HTTP with the official SDK, lists its tools, converts them into a
 * Bedrock Converse `toolConfig`, and executes tool calls.
 *
 * household_id is injected here rather than exposed to the model: the model
 * never sees or chooses it, so it can't act on the wrong household.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool as BedrockTool, ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";

export interface ToolCallOutcome {
  ok: boolean;
  /** structuredContent when present, else { text } */
  data: Record<string, unknown>;
  text: string;
}

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/** One MCP session, shared by every household's bridge. */
interface Connection {
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  tools: McpTool[];
}

export class McpBridge {
  private readonly conn: Connection;

  constructor(
    private readonly url: string,
    readonly householdId: string,
    private readonly log: (msg: string) => void = (m) => console.log(m),
    conn?: Connection,
  ) {
    this.conn = conn ?? { tools: [] };
  }

  /** The same MCP session, acting for another household (public demo: one per visitor). */
  forHousehold(householdId: string): McpBridge {
    return householdId === this.householdId ? this : new McpBridge(this.url, householdId, this.log, this.conn);
  }

  private get client() {
    return this.conn.client;
  }

  private get tools() {
    return this.conn.tools;
  }

  get protocolVersion(): string | undefined {
    return this.conn.transport?.protocolVersion;
  }

  async connect(): Promise<void> {
    const client = new Client({ name: "unrush-web", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    await client.connect(transport);
    const { tools } = await client.listTools();
    Object.assign(this.conn, { client, transport, tools });
    this.log(`[mcp] connected ${this.url} session=${transport.sessionId?.slice(0, 8)} protocol=${transport.protocolVersion} tools=${tools.length}`);
  }

  async close(): Promise<void> {
    await this.conn.transport?.terminateSession().catch(() => {});
    await this.conn.client?.close().catch(() => {});
  }

  // ---------- demo households (plain HTTP beside /mcp on the MCP server; never exposed to the model) ----------

  /** Seed (or re-seed) a household. No id: the MCP server creates a new visitor household. */
  async seedHousehold(householdId?: string, startAt?: string): Promise<{ household_id: string; now: string }> {
    const res = await fetch(new URL("/demo/households", this.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ household_id: householdId, start_at: startAt }),
    });
    const body = (await res.json()) as { household_id: string; now: string; error?: string };
    if (!res.ok) throw Object.assign(new Error(body.error ?? `Seeding failed (${res.status})`), { status: res.status });
    return body;
  }

  async householdExists(householdId: string): Promise<boolean> {
    const res = await fetch(new URL(`/demo/households/${encodeURIComponent(householdId)}`, this.url));
    return res.ok;
  }

  /** Call a tool for the backend itself (not the model), e.g. polling alerts or reading state for the UI. */
  async read(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const out = await this.callTool(name, input);
    if (!out.ok) throw new Error(`${name}: ${out.text}`);
    return out.data;
  }

  /** Raw MCP calls for the MCP Apps host (household_id injected like any other call). */
  async callToolRaw(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
    const args = this.takesHousehold(name) ? { ...input, household_id: this.householdId } : input;
    return this.rawCall(name, args);
  }

  async readResource(uri: string): Promise<string> {
    if (!this.client) await this.connect();
    const r = await this.client!.readResource({ uri });
    const c = r.contents[0] as { text?: string } | undefined;
    if (!c?.text) throw new Error(`Resource ${uri} has no text content`);
    return c.text;
  }

  /** Tools that declare an MCP Apps view (_meta.ui.resourceUri). */
  appViews(): Array<{ tool: string; resourceUri: string; readOnly: boolean }> {
    return this.tools.flatMap((t) => {
      const uri = (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
      return uri ? [{ tool: t.name, resourceUri: uri, readOnly: !!t.annotations?.readOnlyHint }] : [];
    });
  }

  isReadOnly(name: string): boolean {
    return !!this.tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
  }

  /** Current local time on the Unrush clock ("YYYY-MM-DDTHH:MM"). */
  async now(): Promise<string> {
    return String((await this.read("get_schedule")).now);
  }

  listMcpTools(): McpTool[] {
    return this.tools;
  }

  /** MCP tool list → Bedrock Converse toolConfig. */
  toolConfig(): ToolConfiguration {
    return { tools: this.tools.map((t) => toBedrockTool(t)) };
  }

  /** Call an MCP tool on behalf of the model, injecting household_id. Retries once after a reconnect. */
  async callTool(name: string, input: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
    const args = this.takesHousehold(name) ? { ...input, household_id: this.householdId } : input;
    try {
      return toOutcome(await this.rawCall(name, args));
    } catch (err) {
      // Typically the MCP server restarted and our session is gone (HTTP 404). Reconnect once.
      this.log(`[mcp] call ${name} failed (${(err as Error).message}); reconnecting`);
      await this.connect();
      return toOutcome(await this.rawCall(name, args));
    }
  }

  private async rawCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) await this.connect();
    return (await this.client!.callTool({ name, arguments: args })) as CallToolResult;
  }

  private takesHousehold(name: string): boolean {
    const t = this.tools.find((x) => x.name === name);
    return !!(t?.inputSchema.properties && "household_id" in t.inputSchema.properties);
  }
}

export function toBedrockTool(t: McpTool): BedrockTool {
  const schema = structuredClone(t.inputSchema) as JsonSchema;
  delete schema.$schema; // draft marker isn't needed by Bedrock
  if (schema.properties && "household_id" in schema.properties) {
    delete schema.properties.household_id;
    schema.required = (schema.required ?? []).filter((r) => r !== "household_id");
  }
  return {
    toolSpec: {
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      inputSchema: { json: schema as never },
    },
  };
}

function toOutcome(r: CallToolResult): ToolCallOutcome {
  const text = r.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
  const data = (r.structuredContent as Record<string, unknown> | undefined) ?? { text };
  return { ok: !r.isError, data, text };
}
