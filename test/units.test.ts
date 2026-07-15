import { describe, expect, it } from "vitest";
import {
  compAttackMs,
  compOutputDb,
  compRatio,
  compReleaseMs,
  compThresholdDb,
  compThresholdLabel,
  eqGainDb,
  EQ_BANDS,
  filterLevelLabel,
  filterLevelPct,
  filterTimePct,
  fmtHz,
} from "../src/protocol/units";

describe("unit calibration (measured vs EliteControl)", () => {
  it("compressor endpoints", () => {
    expect(compThresholdDb(0)).toBeNull();
    expect(compThresholdDb(1)).toBeCloseTo(-0.5, 5);
    expect(compThresholdDb(127)).toBeCloseTo(-60, 5);
    expect(compThresholdLabel(0)).toBe("Bypass");
    expect(compRatio(0)).toBeCloseTo(1);
    expect(compRatio(127)).toBeCloseTo(20);
    expect(compOutputDb(0)).toBeCloseTo(-30);
    expect(compOutputDb(127)).toBeCloseTo(18);
    expect(compAttackMs(0)).toBeCloseTo(1);
    expect(compAttackMs(127)).toBeCloseTo(100);
    expect(compReleaseMs(0)).toBeCloseTo(10);
    expect(compReleaseMs(127)).toBeCloseTo(1000);
  });

  it("compressor ratio + threshold sit near noon at their EliteControl mid read-outs", () => {
    // full-panel screenshot: ratio 10.6:1 and threshold −30 dB both near knob centre
    expect(compRatio(64)).toBeCloseTo(10.6, 1);
    expect(compThresholdDb(64)!).toBeCloseTo(-30, 0);
  });

  it("auto filter: bipolar level with centre bypass, 0–100% times", () => {
    expect(filterLevelPct(0)).toBe(-100);
    expect(filterLevelPct(127)).toBe(100);
    expect(filterLevelLabel(64)).toBe("Bypass");
    expect(filterLevelLabel(127)).toBe("100%");
    expect(filterTimePct(0)).toBe(0);
    expect(filterTimePct(127)).toBe(100);
  });

  it("parametric EQ bands: gain ±12, per-band freq taper + Q range", () => {
    expect(eqGainDb(0)).toBeCloseTo(-12);
    expect(eqGainDb(127)).toBeCloseTo(12);
    // Low freq linear (noon 120); Mid freq log (noon ≈ 632, hit ~500 at the user's mid); High linear (noon 4.5k)
    expect(EQ_BANDS.low.freq(0)).toBeCloseTo(40);
    expect(EQ_BANDS.low.freq(127)).toBeCloseTo(200);
    expect(EQ_BANDS.low.freq(64)).toBeCloseTo(120.6, 0);
    expect(EQ_BANDS.mid.freq(0)).toBeCloseTo(200);
    expect(EQ_BANDS.mid.freq(127)).toBeCloseTo(2000);
    expect(EQ_BANDS.high.freq(0)).toBeCloseTo(1000);
    expect(EQ_BANDS.high.freq(127)).toBeCloseTo(8000);
    expect(EQ_BANDS.high.freq(64)).toBeCloseTo(4527, -1);
    // High band's Q range differs from Low/Mid
    expect(EQ_BANDS.low.q(0)).toBeCloseTo(0.5);
    expect(EQ_BANDS.low.q(127)).toBeCloseTo(2.0);
    expect(EQ_BANDS.high.q(0)).toBeCloseTo(0.1);
    expect(EQ_BANDS.high.q(127)).toBeCloseTo(1.4);
  });

  it("fmtHz matches EliteControl's style", () => {
    expect(fmtHz(200)).toBe("200");
    expect(fmtHz(500)).toBe("500");
    expect(fmtHz(2000)).toBe("2.0k");
    expect(fmtHz(8000)).toBe("8.0k");
  });
});
