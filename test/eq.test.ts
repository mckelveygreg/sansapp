import { describe, expect, it } from "vitest";
import { highShelf, lowShelf, magnitudeDb, peaking } from "../src/dsp/biquad";
import { eqFilters, eqResponse } from "../src/dsp/eq";
import { logGrid } from "../src/dsp/ir";

const flat = { low: 64, mid: 64, high: 64, freq: 64, q: 64 };
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

describe("EQ tone curve (the pedal's own filter model)", () => {
  it("builds the pedal's cascade: low + mid + high ×2; presence overlays a ×2 bell", () => {
    expect(eqFilters(flat)).toHaveLength(4);
    expect(eqFilters({ ...flat, presence: 64 })).toHaveLength(6);
  });

  it("every knob at the 64 detent ⇒ exactly flat", () => {
    const db = eqResponse(flat, grid);
    for (const v of db) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it("boosting Low is a bell: peaks at its centre, releases the extreme bottom", () => {
    const db = eqResponse({ ...flat, low: 127 }, grid); // centre 120 Hz at the noon Freq
    expect(at(db, 120)).toBeGreaterThan(9);
    expect(at(db, 120)).toBeGreaterThan(at(db, 20) + 6);
    expect(at(db, 4000)).toBeLessThan(1);
  });

  it("cutting Low switches to a shelf: the cut holds all the way down", () => {
    const db = eqResponse({ ...flat, low: 0 }, grid);
    expect(at(db, 20)).toBeLessThan(-9);
  });

  it("boosting High is a bell around its centre, not a shelf to the rails", () => {
    const db = eqResponse({ ...flat, high: 127 }, grid); // centre 4500 Hz at the noon Freq
    expect(at(db, 4500)).toBeGreaterThan(12); // runs twice, with the 0.75 gain trim
    expect(at(db, 4500)).toBeGreaterThan(at(db, 19000) + 4);
    expect(at(db, 300)).toBeLessThan(1);
  });

  it("cutting High switches to a double shelf: well past −12 dB at the top", () => {
    const db = eqResponse({ ...flat, high: 0 }, grid);
    expect(at(db, 18000)).toBeLessThan(-18);
  });

  it("Presence is a 2500 Hz bell run twice — boost-only, it can never cut", () => {
    const noon = eqResponse({ ...flat, presence: 64 }, grid);
    expect(at(noon, 2500)).toBeGreaterThan(11); // +6 dB into each of the two sections
    expect(at(noon, 2500)).toBeGreaterThan(at(noon, 18000) + 6);
    expect(at(noon, 100)).toBeLessThan(0.5); // a bell, not a shelf: the low end stays flat
    for (const v of noon) expect(v).toBeGreaterThan(-1e-9);
    // value 0 is exactly flat — below-noon values are a smaller boost, never a cut
    const zero = eqResponse({ ...flat, presence: 0 }, grid);
    for (const v of zero) expect(Math.abs(v)).toBeLessThan(1e-9);
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
