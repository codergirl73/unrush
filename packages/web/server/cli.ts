/**
 * Terminal chat with the Unrush agent (Amazon Bedrock Converse + MCP tools).
 * Tests the agent loop without the browser:
 *   npm run chat                       # interactive
 *   npm run chat -- "what's tonight?"  # one shot
 * The MCP server must be running (npm run dev, or npm run dev -w @unrush/mcp-server).
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configProblems, createBedrockClient, loadConfig } from "./config.js";
import { allowsOrder } from "./consent.js";
import { McpBridge } from "./mcpBridge.js";
import { explainBedrockError, runAgent, type Turn } from "./agent.js";
import { systemPrompt } from "./prompt.js";

const c = loadConfig();
const problems = configProblems(c);
if (problems.length || c.offline) {
  console.error(c.offline ? "npm run chat always uses Amazon Bedrock; unset UNRUSH_OFFLINE." : "Config problems:\n  " + problems.join("\n  "));
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const bridge = new McpBridge(c.mcpUrl, c.householdId, (m) => console.log(dim(m)));
await bridge.connect();
const bedrock = createBedrockClient(c);
console.log(dim(`[bedrock] model=${c.modelId} region=${c.region} household=${c.householdId}`));
console.log(`Unrush ready. Try "What's my evening look like?". Type "exit" to quit.\n`);

const history: Turn[] = [];
const rl = createInterface({ input, output });
const oneShot = process.argv.slice(2).join(" ").trim();

while (true) {
  const userText = oneShot || (await rl.question(cyan("you › "))).trim();
  if (!userText) continue;
  if (["exit", "quit"].includes(userText)) break;
  try {
    const { reply } = await runAgent({
      client: bedrock,
      modelId: c.modelId,
      bridge,
      system: systemPrompt(await bridge.now()),
      history: history.slice(-c.historyTurns),
      userText,
      maxTokens: c.maxTokens,
      allowPlaceOrder: allowsOrder(history.at(-1)?.assistant, userText),
      onEvent: (e) => {
        if (e.type === "tool_call") console.log(dim(`  → ${e.name} ${JSON.stringify(e.input).slice(0, 160)}`));
        if (e.type === "tool_result") console.log(dim(`  ← ${e.name} ${e.ok ? "ok" : "ERROR"} ${e.ms}ms ${JSON.stringify(e.data).slice(0, 160)}`));
        if (e.type === "usage") console.log(dim(`  [${e.modelCalls} model calls, ${e.toolCalls} tool calls, ${e.inputTokens}+${e.outputTokens} tokens, ${e.ms}ms]`));
      },
    });
    console.log(green("unrush › ") + reply + "\n");
    history.push({ user: userText, assistant: reply });
  } catch (err) {
    console.error(red("✗ " + explainBedrockError(err)) + "\n");
  }
  if (oneShot) break;
}
rl.close();
await bridge.close();
