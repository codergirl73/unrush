/** Starts the Unrush web backend: connects to the MCP server, polls for proactive alerts, serves the API (and the built UI). */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { configProblems, loadConfig } from "./config.js";
import { McpBridge } from "./mcpBridge.js";

const config = loadConfig();
const log = (m: string) => console.log(`[web] ${m}`);
const bridge = new McpBridge(config.mcpUrl, config.householdId, log);

// The MCP server may still be starting (npm run dev starts both): retry for a while.
for (let attempt = 1; ; attempt++) {
  try {
    await bridge.connect();
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    if (attempt === 1) log(`waiting for MCP server at ${config.mcpUrl} …`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const { app, pollAll } = createApp({ config, bridge, log });

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, "index.html")));
}

app.listen(config.port, config.host, () => {
  log(`API on http://${config.host}:${config.port}${config.publicDemo ? " (public demo: a household per visitor)" : ""}  model=${config.offline ? "OFFLINE REHEARSAL (not Bedrock)" : config.modelId} region=${config.region}`);
  for (const p of configProblems(config)) log(`⚠ ${p}`);
});

const timer = setInterval(() => {
  pollAll().catch((err) => log(`alert poll failed: ${(err as Error).message}`));
}, config.alertPollMs);
const shutdown = async () => {
  clearInterval(timer);
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
