/**
 * TravelProvider: how long it takes to get somewhere. The default SimulatedTravel
 * returns fixed, deterministic estimates per place so demo takes are repeatable.
 * A real maps API would implement the same interface.
 */
export interface TravelEstimate {
  minutes: number;
  provider: string;
  simulated: boolean;
  note: string;
}

export interface TravelProvider {
  estimate(from: string, to: string | null): TravelEstimate;
}

/** Places that need no travel from home. */
const NO_TRAVEL = /^(home|online|remote|video call|zoom|phone|call|virtual)$/i;

/** Fixed simulated door-to-door minutes from home, by keyword in the place name. */
export const SIMULATED_MINUTES: Array<[RegExp, number]> = [
  [/library/i, 20],
  [/campus|university|college|class/i, 15],
  [/gym/i, 10],
  [/office|work/i, 25],
  [/airport/i, 45],
  [/downtown|city/i, 30],
  [/friend|dinner|restaurant|cafe|bar/i, 20],
];
const DEFAULT_MINUTES = 20;

export class SimulatedTravel implements TravelProvider {
  estimate(from: string, to: string | null): TravelEstimate {
    const base = { provider: "simulated-travel", simulated: true };
    if (!to || NO_TRAVEL.test(to.trim()) || to.trim().toLowerCase() === from.trim().toLowerCase()) {
      return { ...base, minutes: 0, note: `No travel needed for "${to ?? "no location"}".` };
    }
    const hit = SIMULATED_MINUTES.find(([re]) => re.test(to));
    const minutes = hit ? hit[1] : DEFAULT_MINUTES;
    return { ...base, minutes, note: `Simulated estimate ${from} → ${to}: ${minutes} min${hit ? "" : " (default)"}.` };
  }
}
