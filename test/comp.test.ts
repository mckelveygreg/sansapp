import { describe, expect, it } from "vitest";
import { compressorCurve, compressorOutDb, dynamicsOutDb, gainReductionDb } from "../src/dsp/comp";

const P = { thresholdDb: -30, ratio: 4, kneeDb: 0 };

describe("compressor transfer curve", () => {
  it("is unity below threshold", () => {
    expect(compressorOutDb(-50, P)).toBeCloseTo(-50, 6);
    expect(gainReductionDb(-50, P)).toBeCloseTo(0, 6);
  });

  it("compresses by the ratio above threshold", () => {
    // 20 dB over threshold at 4:1 → 5 dB over → output -25
    expect(compressorOutDb(-10, P)).toBeCloseTo(-25, 6);
    expect(gainReductionDb(-10, P)).toBeCloseTo(-15, 6);
  });

  it("output gain shifts the whole curve up", () => {
    expect(compressorOutDb(-50, { ...P, makeupDb: 6 })).toBeCloseTo(-44, 6);
  });

  it("dynamics: gate expands below its threshold, unity between, comp above", () => {
    const comp = { thresholdDb: -20, ratio: 4, kneeDb: 0 };
    const gate = { thresholdDb: -60, ratio: 5 };
    expect(dynamicsOutDb(-40, comp, gate)).toBeCloseTo(-40, 6); // between → unity
    expect(dynamicsOutDb(-70, comp, gate)).toBeCloseTo(-110, 6); // below gate → -60 + (-10)*5
    expect(dynamicsOutDb(0, comp, gate)).toBeCloseTo(-15, 6); // above comp → -20 + 20/4
    expect(dynamicsOutDb(-70, comp, { thresholdDb: -60, ratio: 1 })).toBeCloseTo(-70, 6); // ratio 1 = off
  });

  it("soft knee is monotonic and passes through near the corners", () => {
    const soft = { thresholdDb: -30, ratio: 4, kneeDb: 12 };
    const curve = compressorCurve([-60, -50, -40, -30, -20, -10, 0], soft);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    expect(compressorOutDb(-50, soft)).toBeCloseTo(-50, 1); // well below knee → unity
  });
});
