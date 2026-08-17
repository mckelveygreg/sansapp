import { describe, expect, it } from "vitest";
import { fftInPlace, magnitudeSpectrum } from "../src/dsp/fft";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { generateIr } from "../src/dsp/generators";
import { convolve, highpassImpulse, makeHighpassIr } from "../src/dsp/hpf";
import { floatToPcm } from "../src/protocol/wav";

const dbAt = (grid: readonly number[], db: readonly number[], f: number): number => {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - f) < Math.abs(grid[k]! - f)) k = i;
  return db[k]!;
};

describe("fft", () => {
  it("rejects non-power-of-two lengths", () => {
    expect(() => fftInPlace(new Float64Array(3), new Float64Array(3))).toThrow();
  });

  it("delta has a flat magnitude spectrum", () => {
    const mag = magnitudeSpectrum([1], 1024);
    for (const m of mag) expect(m).toBeCloseTo(1, 6);
  });

  it("a pure bin shows energy at that bin only", () => {
    const n = 64;
    const bin = 5;
    const sig = Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * bin * i) / n));
    const mag = magnitudeSpectrum(sig, n);
    let peak = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i]! > mag[peak]!) peak = i;
    expect(peak).toBe(bin);
  });
});

describe("frequency response", () => {
  const grid = logGrid(20, 20000, 200);

  it("a delta (flat IR) is ~0 dB everywhere", () => {
    const db = frequencyResponse([1], grid);
    for (const v of db) expect(Math.abs(v)).toBeLessThan(0.5);
  });

  it("logGrid spans the requested range", () => {
    expect(grid[0]).toBeCloseTo(20, 6);
    expect(grid.at(-1)).toBeCloseTo(20000, 6);
  });

  it("never returns non-finite values, even for a degenerate IR (guards the iOS SVG graph)", () => {
    const db = frequencyResponse([Number.NaN, Infinity, -Infinity, 0, 1], grid);
    for (const v of db) expect(Number.isFinite(v)).toBe(true);
  });

  // The IR Studio bug reported on hardware 2026-08-17: a low-pass cornered below the 700–1400 Hz
  // reference band has that whole band in its STOPBAND, so band-normalizing references the stopband
  // and lifts the passband far above 0 dB — the lows pin to the top of the graph and the preview is
  // useless for the filter it is previewing.
  const lowpassAt = (fc: number) =>
    generateIr("lowpass", { fc, q: Math.SQRT1_2, stages: 1, taps: 2000, sampleRate: 44100 });

  it("band-normalizing a sub-band low-pass pushes the passband way above 0 dB", () => {
    const db = frequencyResponse(lowpassAt(200), grid, { normalizeBand: [700, 1400] });
    const lows = db.filter((_, k) => grid[k]! < 100);
    expect(Math.max(...lows)).toBeGreaterThan(12); // the symptom, pinned so the fix can't regress
  });

  it("normalizePeak keeps the peak at 0 dB and everything else below it", () => {
    for (const fc of [200, 1000, 5000]) {
      const db = frequencyResponse(lowpassAt(fc), grid, { normalizePeak: true });
      expect(Math.max(...db)).toBeCloseTo(0, 6);
      for (const v of db) expect(v).toBeLessThanOrEqual(1e-9);
    }
  });

  it("normalizePeak takes precedence over normalizeBand", () => {
    const both = frequencyResponse(lowpassAt(200), grid, {
      normalizePeak: true,
      normalizeBand: [700, 1400],
    });
    expect(Math.max(...both)).toBeCloseTo(0, 6);
  });
});

describe("high-pass as IR", () => {
  const grid = logGrid(20, 20000, 240);

  it("rolls off lows and preserves the passband (90 Hz)", () => {
    const hp = makeHighpassIr(null, 90, { taps: 2000 });
    const db = frequencyResponse(hp, grid, { normalizeBand: [400, 2000] });
    expect(dbAt(grid, db, 40)).toBeLessThan(-15); // deep low-end cut
    expect(Math.abs(dbAt(grid, db, 800))).toBeLessThan(1.5); // passband intact
  });

  it("higher cutoff cuts more low end", () => {
    const g = grid;
    const low60 = dbAt(
      g,
      frequencyResponse(makeHighpassIr(null, 60, { taps: 2000 }), g, {
        normalizeBand: [400, 2000],
      }),
      50,
    );
    const low120 = dbAt(
      g,
      frequencyResponse(makeHighpassIr(null, 120, { taps: 2000 }), g, {
        normalizeBand: [400, 2000],
      }),
      50,
    );
    expect(low120).toBeLessThan(low60);
  });

  it("more stages = steeper slope", () => {
    const oct = (stages: number): number => {
      const g = logGrid(20, 20000, 400);
      const db = frequencyResponse(highpassImpulse(200, 44100, Math.SQRT1_2, stages, 4000), g, {
        normalizeBand: [800, 3000],
      });
      return dbAt(g, db, 100) - dbAt(g, db, 200); // drop across one octave below cutoff
    };
    expect(oct(2)).toBeLessThan(oct(1) - 4); // 2 stages noticeably steeper
  });

  it("convolving with a delta is identity", () => {
    const out = convolve([1], [1, 2, 3, 4], 10);
    expect([...out]).toEqual([1, 2, 3, 4]);
  });
});

describe("floatToPcm (WAV export)", () => {
  it("peak-normalizes to full 16-bit scale", () => {
    const pcm = floatToPcm([0, 0.5, -0.25], 1);
    expect(Math.max(...[...pcm].map(Math.abs))).toBeGreaterThan(32000);
  });
});
