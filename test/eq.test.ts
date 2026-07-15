import { describe, expect, it } from "vitest";
import { highShelf, lowShelf, magnitudeDb, peaking } from "../src/dsp/biquad";
import { eqFilters, eqResponse } from "../src/dsp/eq";
import { logGrid } from "../src/dsp/ir";

const flat = { low: 64, mid: 64, high: 64, presence: 64, freq: 64, q: 64 };
const grid = logGrid(20, 20000, 200);
const at = (db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};

describe("biquad response", () => {
  it("a 0 dB peaking filter is flat", () => {
    const bq = peaking(500, 44100, 1, 0);
    expect(magnitudeDb(bq, 500, 44100)).toBeCloseTo(0, 4);
    expect(magnitudeDb(bq, 5000, 44100)).toBeCloseTo(0, 4);
  });

  it("a peaking boost peaks at its centre frequency", () => {
    const bq = peaking(500, 44100, 2, 9);
    expect(magnitudeDb(bq, 500, 44100)).toBeCloseTo(9, 1);
    expect(magnitudeDb(bq, 500, 44100)).toBeGreaterThan(magnitudeDb(bq, 2000, 44100));
  });

  it("low shelf lifts lows, leaves highs; high shelf the reverse", () => {
    const low = lowShelf(120, 44100, Math.SQRT1_2, 8);
    expect(magnitudeDb(low, 40, 44100)).toBeGreaterThan(6);
    expect(Math.abs(magnitudeDb(low, 8000, 44100))).toBeLessThan(0.5);
    const high = highShelf(3000, 44100, Math.SQRT1_2, 8);
    expect(magnitudeDb(high, 12000, 44100)).toBeGreaterThan(6);
    expect(Math.abs(magnitudeDb(high, 100, 44100))).toBeLessThan(0.5);
  });
});

describe("EQ tone curve", () => {
  it("builds a 4-band filter cascade (low · mid · high · presence)", () => {
    expect(eqFilters(flat)).toHaveLength(4);
  });

  it("all knobs centred ⇒ ~flat", () => {
    const db = eqResponse(flat, grid);
    for (const v of db) expect(Math.abs(v)).toBeLessThan(0.5);
  });

  it("boosting Low lifts the bottom, not the top", () => {
    const db = eqResponse({ ...flat, low: 127 }, grid);
    expect(at(db, 60)).toBeGreaterThan(6);
    expect(at(db, 60)).toBeGreaterThan(at(db, 4000) + 5);
  });

  it("cutting High drops the top", () => {
    const db = eqResponse({ ...flat, high: 0 }, grid);
    expect(at(db, 10000)).toBeLessThan(-6);
  });

  it("mid knob boosts near the swept centre frequency", () => {
    const lowMid = eqResponse({ ...flat, mid: 127, freq: 10 }, grid);
    const hiMid = eqResponse({ ...flat, mid: 127, freq: 120 }, grid);
    // low freq-knob peaks lower than high freq-knob
    const peakF = (db: readonly number[]): number => {
      let k = 0;
      for (let i = 0; i < db.length; i++) if (db[i]! > db[k]!) k = i;
      return grid[k]!;
    };
    expect(peakF(lowMid)).toBeLessThan(peakF(hiMid));
  });
});
