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
  /** WEB_HOST: interface to listen on (default 127.0.0.1; a deployment behind a proxy keeps that). */
  host: string;
  /**
   * UNRUSH_PUBLIC=1: a hosted demo. Each browser gets its own household (cookie), seeded with a day that
   * starts at 3pm, and Bedrock use is capped by the limits below.
   */
  publicDemo: boolean;
  /** Chat turns one household may send per hour (public demo). */
  turnsPerHour: number;
  /** Bedrock-backed turns (chat + proactive) across everyone per UTC day (public demo). */
  turnsPerDay: number;
  /** New households one IP address may create per hour (public demo). */
  householdsPerIpPerHour: number;
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
    host: env.WEB_HOST ?? "127.0.0.1",
    publicDemo: env.UNRUSH_PUBLIC === "1",
    turnsPerHour: Number(env.UNRUSH_TURNS_PER_HOUR ?? 40),
    turnsPerDay: Number(env.UNRUSH_TURNS_PER_DAY ?? 1500),
    householdsPerIpPerHour: Number(env.UNRUSH_HOUSEHOLDS_PER_IP_PER_HOUR ?? 10),
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
