import { describe, expect, it } from "vitest";
import {
  compAttackMs,
  compOutputDb,
  compRatio,
  compReleaseMs,
  compThresholdDb,
  compThresholdLabel,
  eqGainDb,
  filterLevelLabel,
  filterLevelPct,
  gateReleaseMs,
  filterTimePct,
  fmtHz,
  sweepFreqHz,
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

  // Same reading session as the compressor's Release, same answer to the decimal: the gate's Release
  // shares both the range and the square law. Read off EliteControl 1.2, 2026-08-17.
  it("gate Release follows the same square taper — noon is 261.4 ms, not the log 101.8", () => {
    expect(gateReleaseMs(0)).toBeCloseTo(10.0, 1);
    expect(gateReleaseMs(64)).toBeCloseTo(261.4, 1);
    expect(gateReleaseMs(127)).toBeCloseTo(1000.0, 1);
    expect(gateReleaseMs(64)).not.toBeCloseTo(101.8, 0);
  });

  // Attack is NOT asserted at noon on purpose. The same session read it as 261.4 ms, which lies
  // outside the 1–100 ms range units.ts records — so the endpoints themselves are in dispute and a
  // midpoint assertion would bake in whichever guess we made. Only the endpoints we still believe
  // are pinned, so this test fails loudly if someone quietly changes the range without a reading.
  it("compressor Attack keeps its disputed 1–100 ms endpoints until they are re-read", () => {
    expect(compAttackMs(0)).toBeCloseTo(1, 5);
    expect(compAttackMs(127)).toBeCloseTo(100, 5);
  });

  it("compressor ratio + threshold sit near noon at their EliteControl mid read-outs", () => {
    // full-panel screenshot: ratio 10.6:1 and threshold −30 dB both near knob centre
    expect(compRatio(64)).toBeCloseTo(10.6, 1);
    expect(compThresholdDb(64)!).toBeCloseTo(-30, 0);
  });

  // Read off EliteControl 1.2 beside a real pedal, 2026-08-17 (sansapp#47 item 4). The endpoints
  // alone can't pin a taper — 10 and 1000 are the same under all three candidate laws — so the noon
  // reading is the assertion that matters, and it is what caught the app under-reading Release by
  // 2.6× through the middle of its travel.
  it("compressor Release follows a square taper — 10 / 261.4 / 1000 ms", () => {
    expect(compReleaseMs(0)).toBeCloseTo(10.0, 1);
    expect(compReleaseMs(64)).toBeCloseTo(261.4, 1);
    expect(compReleaseMs(127)).toBeCloseTo(1000.0, 1);
    // The two laws it is not: linear noon = 505 ms, log noon = 101.8 ms.
    expect(compReleaseMs(64)).not.toBeCloseTo(505, 0);
    expect(compReleaseMs(64)).not.toBeCloseTo(101.8, 0);
  });

  // The protocol map said 1–16:1 and 50–5000 ms. The pedal says otherwise on both counts, so the
  // screenshot calibration wins and the map's numbers are retired rather than reconciled.
  it("compressor Ratio keeps the screenshot endpoints the protocol map disputed", () => {
    expect(compRatio(127)).toBeCloseTo(20, 5); // not 16:1
    expect(compReleaseMs(0)).toBeCloseTo(10, 5); // not 50 ms
    expect(compReleaseMs(127)).toBeCloseTo(1000, 5); // not 5000 ms
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
    // gain = 24x − 12 with x = r/128: exactly 0 dB at 64 — the whole point of issue #15.
    // (The band freq/Q tapers live in src/dsp/eliteFilters.ts and are golden-tested there.)
    expect(eqGainDb(64)).toBe(0);
    expect(eqGainDb(0)).toBe(-12);
    expect(eqGainDb(127)).toBe(11.8125); // 24·(127/128) − 12: travel tops out shy of +12
    // Punch/Mid's shared sweep is asymmetric bipolar — exactly 500 Hz at the detent, 300 Hz of
    // travel below it vs 1500 above
    expect(sweepFreqHz(64)).toBe(500);
    expect(sweepFreqHz(0)).toBe(200);
    expect(sweepFreqHz(127)).toBe(1976.5625);
  });

  it("fmtHz matches EliteControl's style", () => {
    expect(fmtHz(200)).toBe("200");
    expect(fmtHz(500)).toBe("500");
    expect(fmtHz(2000)).toBe("2.0k");
    expect(fmtHz(8000)).toBe("8.0k");
  });
});
