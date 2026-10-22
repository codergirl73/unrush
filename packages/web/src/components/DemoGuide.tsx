import type { AppState } from "../types";
import { PlayIcon, RefreshIcon } from "./icons";

/**
 * The guided demo: where the visitor is in the story, worked out from the
 * household's live state (so it survives a reload), and the one thing to do next.
 */
export interface DemoStep {
  index: number;
  /** What to do now, shown beside the steps. */
  hint: string;
  /** The message that moves the story on, if saying something does. */
  say?: string;
  /** Replies offered as chips in the conversation. */
  suggestions: string[];
}

export const STEPS = ["Meeting runs late", "Unrush speaks first", "Pick your groceries", "Confirm the order", "Open on Amazon"];

export function demoStep(state: AppState): DemoStep {
  const meeting = state.schedule.events.find((e) => e.id === "evt-project-sync");
  const late = !!meeting?.previous_end && meeting.end > meeting.previous_end;
  const swapped = !!state.tonight?.previous_meal;
  const order = state.order;
  if (!late) return { index: 0, hint: "It's 3pm. Make the 5:30 meeting run late and watch Unrush react.", suggestions: ["What's my evening look like?", "What's for dinner tonight?"] };
  if (!swapped) return { index: 1, hint: "Unrush suggested a quicker dinner. Say yes.", say: "Yes please", suggestions: ["Yes please", "When do I need to leave?"] };
  if (!order || (order.status === "placed" && !order.product_links.length)) {
    return { index: 2, hint: "Ask what you need from the store.", say: "What do we need from the store?", suggestions: ["What do we need from the store?"] };
  }
  if (order.status === "draft" && order.needs_choice.length) {
    const first = order.needs_choice[0]!;
    return {
      index: 2,
      hint: `Unrush picked your usual products. It needs you to choose a ${first.item}.`,
      suggestions: first.choices.map((c) => `For ${first.item}, I'll take the ${c.title}.`),
    };
  }
  if (order.status === "draft") return { index: 3, hint: "Unrush read the order back. Nothing is bought until you say yes.", say: "Yes, place the order.", suggestions: ["Yes, place the order.", "What's in the order?"] };
  return { index: 4, hint: "Done. Open each product on Amazon, or reload the page: Unrush remembers.", suggestions: ["When do I need to leave?", "What did I order?"] };
}

interface Props {
  step: DemoStep;
  /** Unrush is talking or a request is in flight. */
  working: boolean;
  onLate: () => void;
  onSay: (text: string) => void;
  onReset: () => void;
}

export function DemoGuide({ step, working, onLate, onSay, onReset }: Props) {
  return (
    <nav className="guide" aria-label="Guided demo">
      <ol className="guide-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step.index ? "done" : i === step.index ? "current" : ""} aria-current={i === step.index ? "step" : undefined}>
            <span className="guide-num">{i < step.index ? "✓" : i + 1}</span>
            <span className="guide-label">{label}</span>
          </li>
        ))}
      </ol>
      <div className="guide-now">
        <span className="guide-hint">{working ? "Unrush is working…" : step.hint}</span>
        {step.index === 0 ? (
          <button className="primary-btn" onClick={onLate} disabled={working}>
            <PlayIcon width={16} height={16} /> Make the meeting run late
          </button>
        ) : step.say ? (
          <button className="primary-btn" onClick={() => onSay(step.say!)} disabled={working}>
            Say “{step.say}”
          </button>
        ) : null}
        <button className="ghost" onClick={onReset} disabled={working} title="Start the demo day again at 3pm">
          <RefreshIcon width={15} height={15} /> Start over
        </button>
      </div>
    </nav>
  );
}
