/** Environment configuration for the web backend + agent. AWS credentials come only from the default provider chain. */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export interface Config {
  port: number;
  mcpUrl: string;
  householdId: string;
  region: string;
  modelId: string;
  maxTokens: number;
  historyTurns: number;
  /** How often the backend polls get_alerts (ms). */
  alertPollMs: number;
  /** AGENTCORE_MEMORY_ID: conversation memory in Amazon Bedrock AgentCore Memory (optional). */
  agentcoreMemoryId: string;
  /** UNRUSH_OFFLINE=1: scripted rehearsal model instead of Bedrock (clearly labelled in the UI). */
  offline: boolean;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.WEB_PORT ?? 3000),
    mcpUrl: env.MCP_SERVER_URL ?? `http://localhost:${env.MCP_PORT ?? 3001}/mcp`,
    householdId: env.HOUSEHOLD_ID ?? "demo-household",
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "",
    modelId: env.BEDROCK_MODEL_ID ?? "",
    maxTokens: Number(env.BEDROCK_MAX_TOKENS ?? 1024),
    historyTurns: Number(env.HISTORY_TURNS ?? 8),
    alertPollMs: Number(env.ALERT_POLL_MS ?? 3000),
    agentcoreMemoryId: env.AGENTCORE_MEMORY_ID?.trim() ?? "",
    offline: env.UNRUSH_OFFLINE === "1",
  };
}

/** Problems that would make every Bedrock call fail; reported at startup and in the UI. */
export function configProblems(c: Config): string[] {
  if (c.offline) return [];
  const p: string[] = [];
  if (!c.region) p.push("AWS_REGION is not set (see .env.example).");
  if (!c.modelId) p.push("BEDROCK_MODEL_ID is not set. Pick a model or inference profile enabled in your account/region (see README).");
  return p;
}

/** Bedrock Runtime client; credentials resolve through the AWS SDK default chain (env, ~/.aws, SSO, IAM role). */
export function createBedrockClient(c: Config): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region: c.region || undefined, maxAttempts: 3 });
}
