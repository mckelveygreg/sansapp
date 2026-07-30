import { describe, expect, it } from "vitest";
import {
  AMBIENCE_PARAMS,
  AUTO_FILTER_PARAMS,
  CHORUS_PARAMS,
  PARAM_IDS,
  PARAMS,
  liveSetId,
} from "../src/protocol/params";

describe("param registry", () => {
  it("has the paramIds confirmed from live capture", () => {
    const expected: Record<string, number> = {
      // main panel
      drive: 0x05,
      low: 0x06,
      mid: 0x0c,
      high: 0x07,
      presence: 0x04,
      comp: 0x0a,
      level: 0x00,
      // red zone
      preamp: 0x01,
      freq: 0x0d, // parametric Mid Filter freq (Mid Shift)
      ambiance: 0x08,
      ratio: 0x19, // comp ratio (Compressor block)
      // Deep-param wire ids, confirmed against the parameter map + hardware. See docs/PARAM-MAP.md.
      filter: 0x3d,
      q: 0x2f, // mid Q
      chorus: 0x42,
      blend: 0x47,
    };
    for (const [id, pid] of Object.entries(expected)) {
      expect(PARAMS[id as keyof typeof PARAMS].paramId).toBe(pid);
    }
  });

  it("deep-param wire ids obey blobOffset − paramId == 0x22 (confirmed against the parameter map + hardware, 2026-07-14)", () => {
    // The main panel and the deep params share the same rule; a deep id off by +4 was the bug.
    const deep = [
      "q",
      "ratio",
      "filter",
      "chorus",
      "blend",
      "lowQ",
      "highQ",
      "lowFreq",
      "highFreq",
      "chorusModFreq",
      "chorusModDepth",
      "chorusDelaySize",
      "chorusFeedback",
    ] as const;
    for (const id of deep) {
      const p = PARAMS[id];
      expect(p.paramId, `${id}: blob 0x${p.blobOffset.toString(16)}`).toBe(p.blobOffset - 0x22);
    }
  });

  it("models IR mode/gain, Preset Level, and Buzz/Crunch Q at blob = paramId + 0x22 (§3/§5)", () => {
    const expected: Record<string, [number, number]> = {
      irMode7: [0x28, 0x4a],
      irMode8: [0x29, 0x4b],
      irGain7: [0x2a, 0x4c],
      irGain8: [0x2b, 0x4d],
      presetLevel: [0x40, 0x62],
      buzzQ: [0x2c, 0x4e],
      crunchQ: [0x2e, 0x50],
    };
    for (const [id, [pid, blob]] of Object.entries(expected)) {
      const p = PARAMS[id as keyof typeof PARAMS];
      expect([p.paramId, p.blobOffset], id).toEqual([pid, blob]);
      expect(p.blobOffset - (p.paramId ?? 0), id).toBe(0x22);
    }
  });

  it("has unique blob offsets and unique paramIds", () => {
    const offsets = PARAM_IDS.map((id) => PARAMS[id].blobOffset);
    expect(new Set(offsets).size).toBe(offsets.length);
    const paramIds = PARAM_IDS.map((id) => PARAMS[id].paramId).filter((v) => v !== undefined);
    expect(new Set(paramIds).size).toBe(paramIds.length);
  });

  it("chorus wire ids match PROTOCOL-MAP §3 (issue #40 — verified, not mismapped)", () => {
    // Derived from observing EliteControl: On 0x41, Level 0x42, Mod Freq 0x43, Mod Depth 0x44, Delay
    // Size 0x45, Feedback 0x46 — each a deep param whose live-SET id = index + 4.
    expect(CHORUS_PARAMS).toEqual({
      on: 0x41,
      level: 0x42,
      modFreq: 0x43,
      modDepth: 0x44,
      delaySize: 0x45,
      feedback: 0x46,
    });
    // The blob offsets follow the +0x22 rule and the live-set ids the +4 rule (deep range).
    expect([PARAMS.chorusOn.blobOffset, PARAMS.chorus.blobOffset]).toEqual([0x63, 0x64]);
    expect(Object.values(CHORUS_PARAMS).map(liveSetId)).toEqual([
      0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
    ]);
  });

  it("ambience Decay/Time map to Reverb Decay Time / Room Size (issue #38, from observing EliteControl)", () => {
    // EliteControl's ShowAmbience page builds DECAY on index 0x11 (Reverb Decay Time) and TIME on
    // index 0x10 (Reverb Room Size) — same knob constructor whose LEVEL knob uses index 0x08. The
    // nearby 0x14 (Fbk Delay Size) only moves the feedback repeats, so it isn't the Time control.
    expect(AMBIENCE_PARAMS).toEqual({ level: 0x08, decay: 0x11, time: 0x10 });
    expect([PARAMS.ambienceDecay.paramId, PARAMS.ambienceTime.paramId]).toEqual([0x11, 0x10]);
    expect([PARAMS.ambienceDecay.blobOffset, PARAMS.ambienceTime.blobOffset]).toEqual([0x33, 0x32]);
    // live-set ids (index+4, deep range): Decay 0x11→0x15, Time 0x10→0x14 — what EliteControl sends.
    expect([liveSetId(0x11), liveSetId(0x10)]).toEqual([0x15, 0x14]);
  });

  it("auto-filter maps to the 4 real params (issue #41, from observing EliteControl)", () => {
    // Observed in EliteControl (Room Size = 0x10 validates the indexing): 0x3c enable (default 0,
    // range 0..1 — a real toggle), 0x3d Level (default 64, 0..127, BIPOLAR Bypass at 64), 0x3e AF
    // Attack, 0x3f AF Release. No cutoff/resonance param exists.
    expect(PARAMS.autoFilterOn.paramId).toBe(0x3c);
    expect(AUTO_FILTER_PARAMS).toEqual({ level: 0x3d, attack: 0x3e, release: 0x3f });
    expect([
      PARAMS.filter.paramId,
      PARAMS.filterAttack.paramId,
      PARAMS.filterRelease.paramId,
    ]).toEqual([0x3d, 0x3e, 0x3f]);
    // live-set ids (index+4, deep range): 0x3c→0x40, 0x3d→0x41, 0x3e→0x42, 0x3f→0x43.
    expect([0x3c, 0x3d, 0x3e, 0x3f].map(liveSetId)).toEqual([0x40, 0x41, 0x42, 0x43]);
  });

  it("deep-param blob offsets recovered 2026-07-07 form contiguous blocks", () => {
    // Recovered by correlating deep setParam values against 05 20 edit-buffer blobs.
    // EQ Q block (mid/low/high consecutive):
    expect([PARAMS.q.blobOffset, PARAMS.lowQ.blobOffset, PARAMS.highQ.blobOffset]).toEqual([
      0x51, 0x52, 0x53,
    ]);
    // Chorus block (level → feedback consecutive):
    expect([
      PARAMS.chorus.blobOffset,
      PARAMS.chorusModFreq.blobOffset,
      PARAMS.chorusModDepth.blobOffset,
      PARAMS.chorusDelaySize.blobOffset,
      PARAMS.chorusFeedback.blobOffset,
    ]).toEqual([0x64, 0x65, 0x66, 0x67, 0x68]);
    // EQ Low/High freq:
    expect([PARAMS.lowFreq.blobOffset, PARAMS.highFreq.blobOffset]).toEqual([0x6a, 0x6b]);
  });
});
