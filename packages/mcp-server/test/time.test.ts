import { describe, expect, it } from "vitest";
import { addMinutes, clockFromEnv, fromMinutes, isLocalDateTime, spokenTime, toMinutes } from "../src/time.js";

describe("time helpers", () => {
  it("round-trips local wall-clock times through minutes", () => {
    expect(fromMinutes(toMinutes("2026-10-23T19:05"))).toBe("2026-10-23T19:05");
    expect(addMinutes("2026-10-23T19:30", -25)).toBe("2026-10-23T19:05");
    expect(addMinutes("2026-10-23T23:50", 20)).toBe("2026-10-24T00:10");
  });

  it("validates local times", () => {
    expect(isLocalDateTime("2026-10-23T19:05")).toBe(true);
    expect(isLocalDateTime("2026-10-23 19:05")).toBe(false);
    expect(isLocalDateTime("2026-02-30T10:00")).toBe(false);
    expect(isLocalDateTime("2026-10-23T24:00")).toBe(false);
  });

  it("formats times for speech", () => {
    expect(spokenTime("2026-10-23T19:05")).toBe("7:05pm");
    expect(spokenTime("2026-10-23T19:00")).toBe("7pm");
    expect(spokenTime("2026-10-23T00:30")).toBe("12:30am");
    expect(spokenTime("21:30")).toBe("9:30pm");
  });

  it("UNRUSH_NOW starts the clock at a chosen time and rejects garbage", () => {
    expect(clockFromEnv("15:00").now().slice(11)).toBe("15:00");
    expect(clockFromEnv("2026-10-23T15:00").now()).toBe("2026-10-23T15:00");
    expect(() => clockFromEnv("3pm")).toThrow(/UNRUSH_NOW/);
  });
});
