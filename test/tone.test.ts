/**
 * Tone Shaper model: the master curve is the exact pointwise sum of the drive + EQ stages,
 * Presence is counted exactly once (in the drive stage), and the cab helpers reproduce the IR
 * page's display convention and morph rules.
 */
import { describe, expect, it } from "vitest";
import { driveResponse } from "../src/dsp/drive";
import { eqResponse } from "../src/dsp/eq";
import { logGrid } from "../src/dsp/ir";
import { blendDb, cabCurveDb, cabResponseAt, toneResponse } from "../src/dsp/tone";

const grid = logGrid(30, 18000, 140);
const at = (db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};
const NOON = { low: 64, mid: 64, high: 64, freq: 64, q: 64, buzz: 64, punch: 64, presence: 64 };

describe("toneResponse (master = drive + EQ)", () => {
  it("master is the pointwise sum of the two stages, each the standalone model's curve", () => {
    const k = { ...NOON, low: 96, high: 20, presence: 100, punch: 30 };
    const { eq, drive, master } = toneResponse(k, grid);
    expect(eq).toEqual(
      eqResponse({ low: 96, mid: 64, high: 20, freq: 64, q: 64 }, grid), // no presence key
    );
    expect(drive).toEqual(driveResponse({ buzz: 64, punch: 30, presence: 100 }, grid));
    master.forEach((v, i) => expect(v).toBeCloseTo(eq[i]! + drive[i]!, 12));
  });

  it("counts Presence once: it moves the drive stage, never the EQ stage", () => {
    const base = toneResponse(NOON, grid);
    const hot = toneResponse({ ...NOON, presence: 127 }, grid);
    expect(hot.eq).toEqual(base.eq); // the Crunch bell must not leak into the EQ component
    expect(at(hot.drive, 2500)).toBeGreaterThan(at(base.drive, 2500) + 6);
    expect(at(hot.master, 2500)).toBeGreaterThan(at(base.master, 2500) + 6);
  });

  it("with the EQ at the flat detent the master IS the drive curve", () => {
    const { eq, drive, master } = toneResponse(NOON, grid);
    for (const v of eq) expect(Math.abs(v)).toBeLessThan(1e-6); // all-64 EQ is exactly flat
    master.forEach((v, i) => expect(v).toBeCloseTo(drive[i]!, 9));
  });
});

describe("cab display helpers", () => {
  it("cabCurveDb of a unit impulse is the flat 0 dB line (normalized, relative)", () => {
    const ir = new Float64Array(2400);
    ir[0] = 1;
    for (const v of cabCurveDb(ir, grid)) expect(Math.abs(v)).toBeLessThan(0.1);
  });

  it("blendDb interpolates, falls back to the known side, and is null only when both are", () => {
    const a = [0, -6];
    const b = [6, 0];
    expect(blendDb(a, b, 0.5)).toEqual([3, -3]);
    expect(blendDb(a, null, 0.5)).toEqual(a);
    expect(blendDb(null, b, 0.5)).toEqual(b);
    expect(blendDb(null, null, 0.5)).toBeNull();
    expect(blendDb(a, null, 0.5)).not.toBe(a); // always a copy
  });

  it("cabResponseAt follows the IR-select morph rules (Off, exact slot, halfway, Off↔1)", () => {
    const flat = grid.map(() => 0);
    const cabs: Record<number, number[]> = {
      1: grid.map(() => -3),
      2: grid.map(() => 6),
    };
    const dbAt = (s: number) => cabs[s] ?? null;
    expect(cabResponseAt(0, dbAt, flat)).toEqual(flat); // value 0 = Off (flat)
    expect(cabResponseAt(0, dbAt, flat)).not.toBe(flat); // and it's a copy
    expect(cabResponseAt(16, dbAt, flat)).toEqual(cabs[1]); // slot n at n·16
    expect(cabResponseAt(24, dbAt, flat)![0]).toBeCloseTo(1.5); // halfway 1↔2
    expect(cabResponseAt(8, dbAt, flat)![0]).toBeCloseTo(-1.5); // halfway Off↔1 blends flat in
  });

  it("cabResponseAt handles unknown slots like the IR page: fall back, or null when unknowable", () => {
    const flat = grid.map(() => 0);
    const cabs: Record<number, number[]> = { 2: grid.map(() => 6) };
    const dbAt = (s: number) => cabs[s] ?? null;
    expect(cabResponseAt(40, dbAt, flat)).toEqual(cabs[2]); // 2↔3 with 3 unknown → show 2
    expect(cabResponseAt(48, dbAt, flat)).toBeNull(); // exactly on unknown slot 3
    expect(cabResponseAt(56, dbAt, flat)).toBeNull(); // 3↔4, both unknown
  });
});
