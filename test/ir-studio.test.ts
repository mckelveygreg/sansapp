/**
 * The IR Studio "HPF-cab" pipeline: load a cab, bake in a high-pass, export. Guards the whole
 * chain (generate → cascade → response) on a synthetic cab so no copyrighted factory WAV is
 * needed, and locks in the sample-rate fix — factory cabs are 48 kHz, and a filter must be
 * designed at the cab's rate or its corner lands in the wrong place once baked in.
 */
import { describe, expect, it } from "vitest";
import { cascadeIr, generateIr } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";

const grid = logGrid(30, 18000, 150);
const at = (db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};
const TAPS = 1000;

// A synthetic "cab": flat lows/mids, HF rolloff — the shape a real speaker cab has.
const syntheticCab = (sr: number) =>
  generateIr("lowpass", { fc: 3500, stages: 2, taps: TAPS, sampleRate: sr });

describe("IR Studio: bake HPF into a cab", () => {
  it("cuts lows and preserves the passband at 48 kHz", () => {
    const sr = 48000;
    const cab = syntheticCab(sr);
    const filter = generateIr("highpass", {
      fc: 80,
      q: Math.SQRT1_2,
      stages: 2,
      taps: TAPS,
      sampleRate: sr,
    });
    const baked = cascadeIr(cab, filter, TAPS);

    const opts = { sampleRate: sr, normalizeBand: [700, 1400] as [number, number] };
    const before = frequencyResponse(cab, grid, opts);
    const after = frequencyResponse(baked, grid, opts);

    // Strong high-pass action added below the corner…
    expect(at(before, 40) - at(after, 40)).toBeGreaterThan(12);
    // …4th-order corner (~ -6 dB) at fc…
    expect(at(before, 80) - at(after, 80)).toBeGreaterThan(4);
    // …and the passband is untouched.
    expect(Math.abs(at(after, 1000) - at(before, 1000))).toBeLessThan(0.5);
  });

  it("designs the filter at the cab's sample rate (regression guard for the 48 kHz fix)", () => {
    // Same fc, plotted at 48 kHz, but one filter is (wrongly) designed at 44.1 kHz. Its corner
    // lands ~8.8% high in Hz, so near the steep corner the two responses must differ. If the
    // sampleRate arg is ever dropped, both collapse to the default and this delta goes to ~0.
    const plot = { sampleRate: 48000, normalizeBand: [700, 1400] as [number, number] };
    const right = frequencyResponse(
      generateIr("highpass", { fc: 80, stages: 2, taps: TAPS, sampleRate: 48000 }),
      grid,
      plot,
    );
    const wrong = frequencyResponse(
      generateIr("highpass", { fc: 80, stages: 2, taps: TAPS, sampleRate: 44100 }),
      grid,
      plot,
    );
    expect(Math.abs(at(right, 80) - at(wrong, 80))).toBeGreaterThan(1);
  });
});
