/**
 * Clear today's AgentCore Memory conversation for the demo household, so every demo
 * take starts fresh. Runs as part of `npm run seed`; does nothing without
 * AGENTCORE_MEMORY_ID. Long-term extracted preferences are kept.
 */
import { clockFromEnv } from "../../mcp-server/src/time.js";
import { AgentCoreMemory, createAgentCoreClient } from "./agentcore.js";
import { loadConfig } from "./config.js";

const c = loadConfig();
if (!c.agentcoreMemoryId) process.exit(0);
const today = clockFromEnv().now().slice(0, 10);
try {
  const n = await new AgentCoreMemory(createAgentCoreClient(c.region), c.agentcoreMemoryId, c.householdId).clearDay(today);
  console.log(`AgentCore Memory: cleared ${n} conversation event(s) for ${c.householdId} on ${today}.`);
} catch (err) {
  const e = err as { name?: string; message?: string };
  console.warn(`⚠ AgentCore Memory reset skipped (${e.name ?? "Error"}: ${e.message ?? String(err)}). Seeding still succeeded.`);
}
