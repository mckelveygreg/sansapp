import { describe, expect, it } from "vitest";
import { driveFilters, driveResponse } from "../src/dsp/drive";
import { logGrid } from "../src/dsp/ir";

// Reference magnitudes are the lab oracle's (fw_filters.py --response, freq/Q knobs at 64), the same
// hardware-verified numbers eliteFilters.ts is golden-tested against.
const grid = logGrid(20, 20000, 400);
const at = (db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};
const flat = { buzz: 64, punch: 64, presence: 64 };

describe("drive voice-print model (the pedal's own filters)", () => {
  it("builds the cascade Buzz + Punch ×2 + Crunch ×2", () => {
    expect(driveFilters(flat)).toHaveLength(5);
  });

  it("Buzz's unity point is off-centre: a centred Buzz cuts ~3 dB, ~value 73 is flat", () => {
    // value 64 is a low-shelf CUT (the trap a centred-knob assumption gets wrong)
    const centred = driveResponse({ ...flat, presence: 0 }, grid); // isolate Buzz (Crunch flat at 0)
    expect(at(centred, 20)).toBeLessThan(-2.5);
    expect(at(centred, 20)).toBeGreaterThan(-3.5);
    // ~value 73 is unity; the low end sits at 0 dB there
    const unity = driveResponse({ ...flat, buzz: 73, presence: 0 }, grid);
    expect(Math.abs(at(unity, 20))).toBeLessThan(0.15);
  });

  it("Crunch cannot cut: value 0 is exactly flat, value 64 is a +12 dB (×2) lift at 2500 Hz", () => {
    // isolate Crunch by putting Buzz at its unity point (~73) and Punch flat
    const flatCrunch = driveResponse({ buzz: 73, punch: 64, presence: 0 }, grid);
    for (const b of flatCrunch) expect(b).toBeGreaterThan(-0.2); // never cuts
    expect(Math.abs(at(flatCrunch, 2500))).toBeLessThan(0.15); // value 0 ⇒ flat
    const lift = driveResponse({ buzz: 73, punch: 64, presence: 64 }, grid);
    expect(at(lift, 2500)).toBeGreaterThan(11); // +6 dB into each of the two sections
    expect(at(lift, 2500)).toBeGreaterThan(at(lift, 200) + 6); // a bell, not a shelf
  });

  it("Punch is a swept bell run twice: value 0 digs a ~24 dB notch at 500 Hz", () => {
    const dip = driveResponse({ buzz: 73, punch: 0, presence: 0 }, grid);
    expect(at(dip, 500)).toBeLessThan(-20);
    expect(at(dip, 500)).toBeLessThan(at(dip, 2000) - 10);
  });
});
