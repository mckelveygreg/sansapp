import { describe, expect, it } from "vitest";
import { eqResponse } from "../src/dsp/eq";
import { logGrid } from "../src/dsp/ir";
import { fitDbWindow } from "../src/ui/graphWindow";

const flat = { low: 64, mid: 64, high: 64, freq: 64, q: 64 };
const grid = logGrid(30, 18000, 140);

describe("fitDbWindow", () => {
  it("keeps the minimum window when the data fits", () => {
    expect(fitDbWindow([[0, 8, -11.5]], 15, -15)).toEqual({ dbTop: 15, dbBot: -15 });
    expect(fitDbWindow([], 15, -15)).toEqual({ dbTop: 15, dbBot: -15 });
  });

  it("expands only the exceeded edge, snapped outward to 3 dB with 1 dB headroom", () => {
    expect(fitDbWindow([[17.7]], 15, -15)).toEqual({ dbTop: 21, dbBot: -15 });
    expect(fitDbWindow([[-23.9]], 15, -15)).toEqual({ dbTop: 15, dbBot: -27 });
  });

  it("spans all curves and ignores NaN", () => {
    expect(fitDbWindow([[16], [NaN, -20]], 15, -15)).toEqual({ dbTop: 18, dbBot: -21 });
  });

  it("fits the EQ chart's real extremes: a maxed High no longer clips at ±15", () => {
    // boost: a ~+17.7 dB bell (×2 cascade); cut: a −24 dB double shelf
    const boost = fitDbWindow([eqResponse({ ...flat, high: 127 }, grid)], 15, -15);
    expect(boost.dbTop).toBeGreaterThan(17.7);
    expect(boost.dbBot).toBe(-15);
    const cut = fitDbWindow([eqResponse({ ...flat, high: 0 }, grid)], 15, -15);
    expect(cut.dbBot).toBeLessThan(-23);
    expect(cut.dbTop).toBe(15);
  });
});
