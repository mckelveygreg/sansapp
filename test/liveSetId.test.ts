import { describe, expect, it } from "vitest";
import { liveSetId, PARAMS } from "../src/protocol/params";

// Binary-RE'd rule (EliteControl const map @0x10013517c): live-set wire id == iPlug index for the
// shallow range 0x00-0x0F, but index+4 for the deep range 0x10-0x4D. The notify/read path keeps the
// raw index; only the SET path maps through liveSetId.
describe("liveSetId — index → live-set wire id", () => {
  it("is identity for the shallow main-panel knobs (0x00-0x0F)", () => {
    for (const idx of [0x00, 0x01, 0x05, 0x08, 0x0a, 0x0c, 0x0d, 0x0f]) {
      expect(liveSetId(idx)).toBe(idx);
    }
  });

  it("adds 4 across the deep range (0x10-0x4D)", () => {
    expect(liveSetId(0x10)).toBe(0x14);
    expect(liveSetId(0x3d)).toBe(0x41); // Auto-Filter Level
    expect(liveSetId(0x47)).toBe(0x4b); // Blend (the reported bug — notify 0x47, set 0x4b)
    expect(liveSetId(0x48)).toBe(0x4c); // Low Freq
    expect(liveSetId(0x49)).toBe(0x4d); // High Freq
    expect(liveSetId(0x4d)).toBe(0x51);
  });

  it("leaves ids outside 0x10-0x4D untouched (reserved / jump-table range)", () => {
    expect(liveSetId(0x4e)).toBe(0x4e);
    expect(liveSetId(0x12)).not.toBe(0x12); // sanity: 0x12 IS in-range (+4) — not a command here
  });

  it("resolves Blend's set id from its stored index", () => {
    expect(PARAMS.blend.paramId).toBe(0x47);
    expect(liveSetId(PARAMS.blend.paramId!)).toBe(0x4b);
  });
});
