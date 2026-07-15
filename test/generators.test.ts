import { describe, expect, it } from "vitest";
import { blendIr, cascadeIr, generateIr } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";

const grid = logGrid(20, 20000, 240);
const at = (db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};
const resp = (ir: ArrayLike<number>, band: [number, number] = [400, 2000]) =>
  frequencyResponse(ir, grid, { normalizeBand: band });

describe("IR generators", () => {
  it("highpass rolls off lows", () => {
    const db = resp(generateIr("highpass", { fc: 100, stages: 2, taps: 2000 }));
    expect(at(db, 40)).toBeLessThan(-12);
    expect(Math.abs(at(db, 1000))).toBeLessThan(1.5);
  });

  it("lowpass rolls off highs", () => {
    const db = resp(generateIr("lowpass", { fc: 1500, stages: 2, taps: 2000 }), [80, 300]);
    expect(at(db, 8000)).toBeLessThan(-12);
    expect(Math.abs(at(db, 120))).toBeLessThan(1.5);
  });

  it("notch dips at its centre", () => {
    const db = resp(generateIr("notch", { fc: 500, q: 4, taps: 2000 }));
    expect(at(db, 500)).toBeLessThan(at(db, 2000) - 6);
  });

  it("tilt lowers lows and lifts highs", () => {
    const db = resp(generateIr("tilt", { fc: 700, gainDb: 8, taps: 2000 }), [600, 900]);
    expect(at(db, 60)).toBeLessThan(-4);
    expect(at(db, 10000)).toBeGreaterThan(4);
  });

  it("lowshelf boost lifts the bottom", () => {
    const db = resp(generateIr("lowshelf", { fc: 120, gainDb: 9, taps: 2000 }), [1000, 4000]);
    expect(at(db, 50)).toBeGreaterThan(5);
  });
});

describe("blend + cascade", () => {
  const a = Float64Array.from([1, 0.5, 0.25]);
  const b = Float64Array.from([0, 1, 0]);

  it("blend at 0 = a, at 1 = b, at 0.5 = average", () => {
    expect([...blendIr(a, b, 0)]).toEqual([1, 0.5, 0.25]);
    expect([...blendIr(a, b, 1)]).toEqual([0, 1, 0]);
    expect([...blendIr(a, b, 0.5)]).toEqual([0.5, 0.75, 0.125]);
  });

  it("cascade with a delta is identity; cascade composes filters", () => {
    expect([...cascadeIr([1], [1, 2, 3], 8)]).toEqual([1, 2, 3]);
    // HP ⊛ LP = band-pass: both extremes attenuated vs the mid
    const bp = cascadeIr(
      generateIr("highpass", { fc: 150, taps: 1500 }),
      generateIr("lowpass", { fc: 1500, taps: 1500 }),
      1500,
    );
    const db = resp(bp, [400, 800]);
    expect(at(db, 40)).toBeLessThan(-6);
    expect(at(db, 12000)).toBeLessThan(-6);
  });
});
