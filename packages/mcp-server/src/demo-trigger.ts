/**
 * Demo trigger: the "late meeting". Over a real MCP session (official SDK client,
 * Streamable HTTP), extend today's 5:30pm Project sync to run until 7pm. The MCP
 * server's proactive checker reacts immediately; the web app speaks first.
 *
 *   npm run demo:trigger                   # requires `npm run dev` (or the MCP server) running
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEMO_EVENT_IDS, DEMO_HOUSEHOLD } from "./seed.js";

const url = process.env.MCP_SERVER_URL ?? `http://localhost:${process.env.MCP_PORT ?? 3001}/mcp`;
const household_id = process.env.HOUSEHOLD_ID ?? DEMO_HOUSEHOLD;
const newEnd = process.argv[2] ?? "19:00";

const client = new Client({ name: "unrush-demo-trigger", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));
try {
  await client.connect(transport);
} catch (err) {
  console.error(`Could not reach the Unrush MCP server at ${url}. Start it with \`npm run dev\` first.\n`, err instanceof Error ? err.message : err);
  process.exit(1);
}

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name}: ${(r.content[0] as { text?: string })?.text}`);
  return r.structuredContent as Record<string, any>;
};

try {
  const schedule = await call("get_schedule", { household_id });
  const meeting = (schedule.events as Array<Record<string, string>>).find((e) => e.id === DEMO_EVENT_IDS.meeting);
  if (!meeting) throw new Error(`No "${DEMO_EVENT_IDS.meeting}" event today (${schedule.date}). Run \`npm run seed\` first.`);

  const updated = await call("add_or_update_event", {
    household_id,
    event: { ...meeting, end: `${schedule.date}T${newEnd}`, previous_start: undefined, previous_end: undefined, leave_by: undefined },
  });
  console.log(`⏰ Late meeting injected (MCP protocol ${transport.protocolVersion}): "${updated.event.title}" now ${updated.event.start.slice(11)}–${updated.event.end.slice(11)} [simulated calendar]`);

  const leave = await call("compute_leave_by", { household_id, event_id: DEMO_EVENT_IDS.plans });
  console.log(`🚶 ${leave.explanation}`);
  const { alerts } = await call("get_alerts", { household_id });
  for (const a of alerts) console.log(`⚑ ${a.kind}: ${a.message}`);
  if (alerts.length === 0) console.log("No new alerts (already delivered? run `npm run seed` to reset).");
} catch (err) {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.close();
}
