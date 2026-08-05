import { describe, expect, it } from "vitest";
import { cascadeResponseDb } from "../src/dsp/biquad";
import {
  designEliteFilter,
  ELITE_SAMPLE_RATE,
  type EliteFilterControl,
  eliteFilterBiquad,
  eliteFilterBiquads,
} from "../src/dsp/eliteFilters";
import golden from "./fixtures/eliteFilters.golden.json";

// Regenerate the fixture from the lab oracle (selftest-gated):
//   python3 tools/re/gen_elitefilters_fixture.py > ../sansApp/test/fixtures/eliteFilters.golden.json
// The oracle designs in float64 like we do, so the only slack needed is libm ulp noise.
const expectClose = (got: number, want: number) => {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
};

const CONTROLS: EliteFilterControl[] = ["buzz", "punch", "crunch", "low", "mid", "high"];
const GRID = [20, 40, 80, 160, 200, 320, 500, 1000, 2000, 2500, 4000, 8000, 16000];

describe("eliteFilters golden fixture", () => {
  it("covers every control", () => {
    expect(new Set(golden.cases.map((c) => c.control))).toEqual(new Set(CONTROLS));
  });

  for (const c of golden.cases) {
    it(`${c.control} gain=${c.gainValue} freq=${c.freqValue} q=${c.qValue}`, () => {
      const design = designEliteFilter(
        c.control as EliteFilterControl,
        c.gainValue,
        c.freqValue,
        c.qValue,
      );
      expect(design.shape).toBe(c.shape);
      expect(design.cascade).toBe(c.cascade);
      expectClose(design.gainDb, c.gainDb);
      expectClose(design.freqHz, c.freqHz);
      expectClose(design.q, c.q);

      const bq = eliteFilterBiquad(design);
      expect(c.a[0]).toBe(1);
      expectClose(bq.b0, c.b[0]!);
      expectClose(bq.b1, c.b[1]!);
      expectClose(bq.b2, c.b[2]!);
      expectClose(bq.a1, c.a[1]!);
      expectClose(bq.a2, c.a[2]!);
    });
  }
});

describe("eliteFilters invariants", () => {
  it("gain is exactly 0 dB at value 64 for Punch/Low/Mid/High — the detent that pins the /128 scale", () => {
    for (const control of ["punch", "low", "mid", "high"] as const) {
      expect(designEliteFilter(control, 64, 64, 64).gainDb).toBe(0);
    }
  });

  it("Punch/Mid centre is exactly 500 Hz at value 64", () => {
    expect(designEliteFilter("punch", 96, 64, 64).freqHz).toBe(500);
    expect(designEliteFilter("mid", 96, 64, 64).freqHz).toBe(500);
  });

  it("Buzz is ~3 dB down at centre; unity lands between values 73 and 74, not 64", () => {
    expect(designEliteFilter("buzz", 64, 64, 64).gainDb).toBe(-3);
    expect(designEliteFilter("buzz", 73, 64, 64).gainDb).toBeLessThan(0);
    expect(designEliteFilter("buzz", 74, 64, 64).gainDb).toBeGreaterThan(0);
  });

  it("Crunch at value 0 is exactly flat", () => {
    const db = cascadeResponseDb(eliteFilterBiquads("crunch", 0, 64, 64), GRID, ELITE_SAMPLE_RATE);
    for (const v of db) expect(Math.abs(v)).toBeLessThanOrEqual(1e-9);
  });

  it("Crunch never cuts at any value", () => {
    for (let v = 0; v <= 127; v++) {
      expect(designEliteFilter("crunch", v, 64, 64).gainDb).toBeGreaterThanOrEqual(0);
    }
  });

  it("Punch's Q byte is floored at 16", () => {
    expect(designEliteFilter("punch", 96, 64, 0)).toEqual(designEliteFilter("punch", 96, 64, 16));
    expect(designEliteFilter("punch", 96, 64, 17)).not.toEqual(
      designEliteFilter("punch", 96, 64, 16),
    );
  });

  it("Low and High switch shape on the gain sign (shelf cut, bell boost)", () => {
    expect(designEliteFilter("low", 32, 64, 64).shape).toBe("lowShelf");
    expect(designEliteFilter("low", 96, 64, 64).shape).toBe("peaking");
    expect(designEliteFilter("high", 32, 64, 64).shape).toBe("highShelf");
    expect(designEliteFilter("high", 96, 64, 64).shape).toBe("peaking");
  });

  it("cascaded controls run the same section twice, doubling the dB", () => {
    for (const control of CONTROLS) {
      const biquads = eliteFilterBiquads(control, 96, 64, 64);
      expect(biquads).toHaveLength(designEliteFilter(control, 96, 64, 64).cascade);
      const total = cascadeResponseDb(biquads, GRID, ELITE_SAMPLE_RATE);
      const single = cascadeResponseDb([biquads[0]!], GRID, ELITE_SAMPLE_RATE);
      for (let i = 0; i < GRID.length; i++) {
        expectClose(total[i]!, biquads.length * single[i]!);
      }
    }
  });
});
