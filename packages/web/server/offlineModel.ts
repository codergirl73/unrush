/**
 * OFFLINE REHEARSAL MODE ONLY (UNRUSH_OFFLINE=1). THIS IS NOT AMAZON BEDROCK.
 *
 * A keyword-scripted stand-in that speaks the Converse request/response shape so
 * the UI and hero flow can be rehearsed without AWS credentials. Its MCP tool
 * calls are real; only the "reasoning" is scripted. The UI shows an
 * "Offline rehearsal" badge whenever this is active.
 */
import type { ContentBlock, ConverseCommand, ConverseCommandOutput, Message } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseClient } from "./agent.js";
import { PROACTIVE_MARKER } from "./proactive.js";

type Results = Array<Record<string, any>>;
type Step = { tools: (r: Results) => Array<[string, Record<string, unknown>]> } | { reply: (r: Results) => string };

const lower = (s: string) => s.toLowerCase();

function script(userText: string, lastAssistant: string, today: string): Step[] {
  const t = lower(userText);
  const yes = /\b(yes|yeah|yep|sure|ok|okay|go ahead|please|do it)\b/.test(t) && !/\b(no|don'?t|wait|not)\b/.test(t);

  if (userText.startsWith(PROACTIVE_MARKER)) {
    const max = Number(/max_minutes (\d+)/.exec(userText)?.[1] ?? 15);
    const leave = /leave_by: (.+)/.exec(userText)?.[1] ?? "";
    const hasMeal = userText.includes("meal_fit:");
    return [
      { tools: () => [["compute_leave_by", { event_id: "evt-study-group" }], ...(hasMeal ? ([["suggest_quick_meal", { max_minutes: max }]] as Array<[string, Record<string, unknown>]>) : [])] },
      {
        reply: (r) => {
          const quick = r.find((x) => x.suggestions)?.suggestions?.[0];
          const meal = quick ? ` Your curry won't fit tonight. Want me to swap in ${lower(quick.name)}? It takes ${quick.prep_minutes} minutes and you have everything.` : "";
          return `${leave}${meal}`.trim();
        },
      },
    ];
  }

  if (yes && /swap/.test(lower(lastAssistant))) {
    const recipe = "tomato-garlic-spaghetti"; // the scripted demo always offers this one
    return [
      { tools: () => [["save_meal_plan", { week_start: today, days: [{ date: today, recipe_id: recipe }] }]] },
      { tools: () => [["predict_runouts", { days_ahead: 2 }], ["build_grocery_order", {}]] },
      {
        reply: (r) => {
          const pred = r.find((x) => x.predictions)?.predictions ?? [];
          const out = pred.filter((p: any) => p.status === "out").map((p: any) => `${p.item}s are out`);
          const low = pred.filter((p: any) => p.status !== "out").map((p: any) => `${p.item} runs out tomorrow`);
          const order = r.find((x) => x.read_back !== undefined);
          return `Done, spaghetti it is. Heads up: ${[...out, ...low].join(" and ")}. I've drafted an order: ${order?.read_back}. Shall I place the order?`;
        },
      },
    ];
  }

  if (yes && /place the order/.test(lower(lastAssistant))) {
    return [
      { tools: () => [["get_order", {}]] },
      { tools: (r) => [["place_order", { order_id: r[0]?.order?.order_id, confirmed: true }]] },
      { reply: (r) => `Ordered! Simulated confirmation ${r.at(-1)?.confirmation_number}, arriving around ${r.at(-1)?.eta_spoken}.` },
    ];
  }

  const out = /(?:out of|ran out of|used (?:up )?(?:the last of |all )?(?:the )?)([a-z ]+?)(?:[.,!?]|$)/.exec(t);
  if (out) {
    return [
      { tools: () => [["update_pantry", { changes: [{ item: out[1]!.trim(), action: "remove" }] }]] },
      { reply: () => `Got it, I've marked ${out[1]!.trim()} as out and I'll add it to the next order.` },
    ];
  }

  if (/order|groceries|shopping|store|need/.test(t)) {
    return [
      { tools: () => [["predict_runouts", { days_ahead: 2 }], ["build_grocery_order", {}]] },
      { reply: (r) => `I'd get ${r.at(-1)?.read_back || "nothing right now"}. Shall I place the order?` },
    ];
  }

  if (/evening|tonight|schedule|leave|dinner/.test(t)) {
    return [
      { tools: () => [["get_schedule", {}], ["get_meal_plan", { week_start: today }]] },
      {
        reply: (r) => {
          const evts = (r[0]?.events ?? []).filter((e: any) => e.start.slice(11) >= "12:00");
          const dinner = (r[1]?.days ?? []).find((d: any) => d.date === today);
          return `Tonight: ${evts.map((e: any) => `${e.title} at ${e.start.slice(11)}`).join(", ") || "nothing booked"}. Dinner is ${dinner?.meal ?? "not planned"}.`;
        },
      },
    ];
  }

  return [{ reply: () => "I'm in offline rehearsal mode, so I only know the demo script. Connect Amazon Bedrock for real conversations." }];
}

/** Converse-shaped fake: picks the step from how many tool rounds already happened this turn. */
export function offlineModel(today: () => string): ConverseClient {
  let n = 0;
  return {
    send: (async (cmd: ConverseCommand) => {
      const messages = (cmd.input.messages ?? []) as Message[];
      // The turn starts at the last user message that carries text (tool results are also role "user").
      let lastUser = messages.length - 1;
      while (lastUser > 0 && (messages[lastUser]!.role !== "user" || messages[lastUser]!.content?.some((b) => b.toolResult))) lastUser--;
      const userText = messages[lastUser]?.content?.map((b) => b.text ?? "").join(" ") ?? "";
      const lastAssistant = [...messages.slice(0, lastUser)].reverse().find((m) => m.role === "assistant")?.content?.map((b) => b.text ?? "").join(" ") ?? "";
      const results: Results = messages
        .slice(lastUser + 1)
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content!.map((b) => (b.toolResult?.content?.[0]?.json as Record<string, any>) ?? {}));
      const round = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
      const steps = script(userText, lastAssistant, today());
      const step = steps[Math.min(round, steps.length - 1)]!;

      let content: ContentBlock[];
      let stopReason: string;
      if ("tools" in step) {
        content = step.tools(results).map(([name, input]) => ({ toolUse: { toolUseId: `off-${++n}`, name, input: input as never } }));
        stopReason = "tool_use";
      } else {
        content = [{ text: step.reply(results) }];
        stopReason = "end_turn";
      }
      await new Promise((r) => setTimeout(r, 250)); // feel like a model call in the activity panel
      return {
        output: { message: { role: "assistant", content } },
        stopReason,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: { latencyMs: 250 },
        $metadata: {},
      } as ConverseCommandOutput;
    }) as ConverseClient["send"],
  };
}
