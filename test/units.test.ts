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

  it("parametric EQ: the pedal's /128 scale puts the noon detent exactly on centre", () => {
    // gain = 24x − 12 with x = r/128: exactly 0 dB at 64 — the whole point of issue #15
    expect(eqGainDb(64)).toBe(0);
    expect(eqGainDb(0)).toBe(-12);
    expect(eqGainDb(127)).toBe(11.8125); // 24·(127/128) − 12: travel tops out shy of +12
    // Low/High freq are linear in x (all values dyadic → exact)
    expect(EQ_BANDS.low.freq(0)).toBe(40);
    expect(EQ_BANDS.low.freq(64)).toBe(120);
    expect(EQ_BANDS.low.freq(127)).toBe(198.75);
    expect(EQ_BANDS.high.freq(0)).toBe(1000);
    expect(EQ_BANDS.high.freq(64)).toBe(4500);
    expect(EQ_BANDS.high.freq(127)).toBe(7945.3125);
    // Mid is the asymmetric bipolar sweep — exactly 500 Hz at the detent, 300 Hz of travel below
    // it vs 1500 above
    expect(EQ_BANDS.mid.freq(64)).toBe(500);
    expect(EQ_BANDS.mid.freq(0)).toBe(200);
    expect(EQ_BANDS.mid.freq(127)).toBe(1976.5625);
    // Low/Mid Q are exponential, exactly 1.0 at the detent
    expect(EQ_BANDS.low.q(0)).toBe(0.5);
    expect(EQ_BANDS.low.q(64)).toBe(1);
    expect(EQ_BANDS.low.q(127)).toBeCloseTo(1.978, 3);
    expect(EQ_BANDS.mid.q(0)).toBe(0.25);
    expect(EQ_BANDS.mid.q(64)).toBe(1);
    expect(EQ_BANDS.mid.q(127)).toBeCloseTo(3.914, 3);
    // High's Q read-out stays screenshot-calibrated (/127, endpoints inclusive): the hardware law
    // switches taper on the gain knob's sign, which a one-knob display can't express
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
