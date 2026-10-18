/**
 * One-time setup: create the Amazon Bedrock AgentCore Memory resource Unrush uses,
 * wait until it is ACTIVE, and print the AGENTCORE_MEMORY_ID line for .env.
 * Idempotent: an existing ACTIVE memory with the same name prefix is reused.
 *
 *   npm run agentcore:setup        # uses AWS_REGION + the default AWS credential chain
 */
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  GetMemoryCommand,
  ListMemoriesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { loadConfig } from "./config.js";

export const MEMORY_NAME = "unrush_household_memory";

const c = loadConfig();
if (!c.region) {
  console.error("Set AWS_REGION in .env first.");
  process.exit(1);
}
const client = new BedrockAgentCoreControlClient({ region: c.region });

try {
  const { memories } = await client.send(new ListMemoriesCommand({ maxResults: 100 }));
  let id = memories?.find((m) => m.id?.startsWith(`${MEMORY_NAME}-`) && m.status === "ACTIVE")?.id;
  if (id) {
    console.log(`Reusing existing AgentCore memory ${id}`);
  } else {
    const { memory } = await client.send(
      new CreateMemoryCommand({
        name: MEMORY_NAME,
        description: "Unrush household conversation memory (short-term events + extracted preferences).",
        eventExpiryDuration: 30, // days
        memoryStrategies: [
          {
            userPreferenceMemoryStrategy: {
              name: "household_preferences",
              description: "Food, timing and shopping preferences stated by the household.",
              namespaces: ["/households/{actorId}/preferences"],
            },
          },
        ],
      }),
    );
    id = memory?.id;
    if (!id) throw new Error("CreateMemory returned no id");
    process.stdout.write(`Creating AgentCore memory ${id} `);
    for (let i = 0; i < 60; i++) {
      const { memory: m } = await client.send(new GetMemoryCommand({ memoryId: id }));
      if (m?.status === "ACTIVE") break;
      if (m?.status === "FAILED") throw new Error(`Memory ${id} failed: ${m.failureReason ?? "unknown reason"}`);
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(" ACTIVE");
  }
  console.log(`\nAdd this line to .env, then restart \`npm run dev\`:\n\nAGENTCORE_MEMORY_ID=${id}\n`);
} catch (err) {
  const e = err as { name?: string; message?: string };
  console.error(`✗ ${e.name ?? "Error"}: ${e.message ?? String(err)}`);
  if (e.name === "CredentialsProviderError") console.error("  Configure the default AWS credential chain (aws configure / aws sso login), then retry.");
  if (e.name === "AccessDeniedException") console.error("  Your identity needs bedrock-agentcore:CreateMemory, GetMemory and ListMemories.");
  process.exitCode = 1;
}
