/**
 * The agent loop: Amazon Bedrock Converse API + MCP tools.
 *
 *   user text ─► ConverseCommand(messages, system, toolConfig)
 *                 │ stopReason = tool_use  → run each toolUse via MCP → toolResult blocks → loop
 *                 │ stopReason = end_turn  → final spoken reply
 *   capped at MAX_ITERATIONS model calls.
 */
import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message,
  type ToolResultBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { McpBridge } from "./mcpBridge.js";

export const MAX_ITERATIONS = 8;

export const ORDER_BLOCKED =
  "Blocked by the Unrush backend: the user has not explicitly said yes to placing this order. " +
  "Read the order back and ask 'Shall I place the order?', then wait for their answer.";

export type AgentEvent =
  | { type: "thinking"; iteration: number }
  | { type: "interim"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; ms: number; data: Record<string, unknown> }
  | { type: "reply"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number; ms: number }
  /** Conversation memory activity (AgentCore Memory load/recall/save), emitted by the web backend, not the loop. */
  | { type: "memory"; action: "load" | "recall" | "save"; ok: boolean; detail: string };

/** Only the piece of BedrockRuntimeClient we use — lets tests pass a fake. */
export type ConverseClient = Pick<BedrockRuntimeClient, "send">;

/** A finished turn kept as conversation memory (text only; tool traffic is not replayed). */
export interface Turn {
  user: string;
  assistant: string;
}

export interface RunAgentOptions {
  client: ConverseClient;
  modelId: string;
  bridge: Pick<McpBridge, "toolConfig" | "callTool">;
  system: string;
  history: Turn[];
  userText: string;
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  /**
   * Defence in depth for "never buy without an explicit yes": unless the backend saw the
   * user say yes to an order question (see consent.ts), place_order with confirmed=true is
   * blocked here and never reaches the MCP server. Proactive turns never allow it.
   */
  allowPlaceOrder?: boolean;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentResult {
  reply: string;
  iterations: number;
  toolCalls: number;
  stopReason?: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const emit = opts.onEvent ?? (() => {});
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const started = Date.now();

  const messages: Message[] = [];
  for (const t of opts.history) {
    messages.push({ role: "user", content: [{ text: t.user }] });
    messages.push({ role: "assistant", content: [{ text: t.assistant }] });
  }
  messages.push({ role: "user", content: [{ text: opts.userText }] });

  const toolConfig = opts.bridge.toolConfig();
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let lastStop: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    emit({ type: "thinking", iteration });
    const res: ConverseCommandOutput = await opts.client.send(
      new ConverseCommand({
        modelId: opts.modelId,
        system: [{ text: opts.system }],
        messages,
        toolConfig,
        inferenceConfig: { maxTokens: opts.maxTokens ?? 2048, temperature: opts.temperature ?? 0.3 },
      }),
    );
    inputTokens += res.usage?.inputTokens ?? 0;
    outputTokens += res.usage?.outputTokens ?? 0;
    lastStop = res.stopReason;

    const assistant = res.output?.message;
    if (!assistant?.content) throw new Error(`Bedrock returned no message (stopReason=${res.stopReason})`);
    messages.push(assistant);

    const text = textOf(assistant.content);
    const toolUses = assistant.content.flatMap((b) => (b.toolUse ? [b.toolUse] : []));

    if (res.stopReason !== "tool_use" || toolUses.length === 0) {
      const reply = text || fallbackReply(res.stopReason);
      emit({ type: "reply", text: reply });
      emit({ type: "usage", inputTokens, outputTokens, modelCalls: iteration, toolCalls, ms: Date.now() - started });
      return { reply, iterations: iteration, toolCalls, stopReason: res.stopReason };
    }

    if (text) emit({ type: "interim", text });

    // Execute every requested tool (sequentially: later calls may depend on earlier writes).
    const results: ContentBlock[] = [];
    for (const use of toolUses) {
      const id = use.toolUseId!;
      const name = use.name!;
      const input = (use.input ?? {}) as Record<string, unknown>;
      emit({ type: "tool_call", id, name, input });
      const t0 = Date.now();
      let block: ToolResultBlock;
      if (name === "place_order" && input.confirmed === true && !opts.allowPlaceOrder) {
        const message = ORDER_BLOCKED;
        emit({ type: "tool_result", id, name, ok: false, ms: 0, data: { blocked: true, error: message } });
        results.push({ toolResult: { toolUseId: id, content: [{ text: message }], status: "error" } });
        toolCalls++;
        continue;
      }
      try {
        const out = await opts.bridge.callTool(name, input);
        emit({ type: "tool_result", id, name, ok: out.ok, ms: Date.now() - t0, data: out.data });
        block = {
          toolUseId: id,
          content: out.ok ? [{ json: out.data as never }] : [{ text: out.text }],
          ...(out.ok ? {} : { status: "error" as const }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_result", id, name, ok: false, ms: Date.now() - t0, data: { error: message } });
        block = { toolUseId: id, content: [{ text: `Tool call failed: ${message}` }], status: "error" };
      }
      toolCalls++;
      results.push({ toolResult: block });
    }
    messages.push({ role: "user", content: results });
  }

  const reply = "Sorry, that took more steps than I'm allowed. Could you break it into smaller requests?";
  emit({ type: "reply", text: reply });
  emit({ type: "usage", inputTokens, outputTokens, modelCalls: maxIterations, toolCalls, ms: Date.now() - started });
  return { reply, iterations: maxIterations, toolCalls, stopReason: lastStop };
}

function textOf(blocks: ContentBlock[]): string {
  return stripThinking(
    blocks
      .map((b) => b.text ?? "")
      .join(" "),
  );
}

/** Some models (e.g. Amazon Nova) emit <thinking>…</thinking> before the answer; it must never be spoken. */
export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, "").trim();
}

function fallbackReply(stop?: string): string {
  if (stop === "max_tokens") return "Sorry, my answer got cut off. Could you ask that again more briefly?";
  if (stop === "guardrail_intervened" || stop === "content_filtered") return "Sorry, I can't help with that one.";
  return "Done.";
}

/** Map common Bedrock / AWS SDK errors to an actionable message for the UI and logs. */
export function explainBedrockError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);
  if (name === "CredentialsProviderError" || /Could not load credentials/i.test(msg)) {
    return "No AWS credentials found. Configure the default AWS credential chain (`aws configure`, `aws sso login`, AWS_PROFILE or env vars), then restart.";
  }
  if (name === "AccessDeniedException") {
    return `Bedrock access denied: ${msg}. Check that your IAM identity allows bedrock:InvokeModel and that model access is enabled in this region.`;
  }
  if (name === "ValidationException" && /on-demand throughput|inference profile/i.test(msg)) {
    return `This model has to be called through an inference profile. Set BEDROCK_MODEL_ID to the profile ID (e.g. "us.amazon.nova-lite-v1:0"). Details: ${msg}`;
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model identifier|model id/i.test(msg))) {
    return `Bedrock doesn't recognise BEDROCK_MODEL_ID in this region: ${msg}`;
  }
  if (name === "UnrecognizedClientException" || name === "ExpiredTokenException" || name === "InvalidSignatureException") {
    return `AWS rejected your IAM credentials (${name}). Refresh them with "aws sso login" or "aws configure".`;
  }
  if (name === "ThrottlingException") return "Bedrock is throttling requests. Wait a few seconds and try again.";
  return `${name || "Error"}: ${msg}`;
}
