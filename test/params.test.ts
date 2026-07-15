import { describe, expect, it } from "vitest";
import { PARAM_IDS, PARAMS } from "../src/protocol/params";

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
      ratio: 0x19, // comp ratio, corrected from 0x1d (Expander) → 0x19 (Compressor block)
      // Deep-param wire ids corrected −4 from the parameter-map + hardware confirmation (2026-07-14). See ELITECONTROL-RE.md.
      filter: 0x3d, // was 0x41
      q: 0x2f, // mid Q, was 0x33
      chorus: 0x42, // was 0x46
      blend: 0x47, // was 0x4b
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

  it("has unique blob offsets and unique paramIds", () => {
    const offsets = PARAM_IDS.map((id) => PARAMS[id].blobOffset);
    expect(new Set(offsets).size).toBe(offsets.length);
    const paramIds = PARAM_IDS.map((id) => PARAMS[id].paramId).filter((v) => v !== undefined);
    expect(new Set(paramIds).size).toBe(paramIds.length);
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
