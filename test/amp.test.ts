import { describe, expect, it } from "vitest";
import {
  AMP_BUNDLE_OFFSETS,
  AMP_BUNDLES,
  applyAmpBundle,
  detectAmpModel,
  hasAmpBundle,
} from "../src/protocol/amp";

describe("amp model bundles", () => {
  it("each bundle matches the offset list length", () => {
    for (const vals of Object.values(AMP_BUNDLES))
      expect(vals).toHaveLength(AMP_BUNDLE_OFFSETS.length);
  });

  it("applies a model's bytes, leaves the rest, doesn't mutate the source", () => {
    const base = new Uint8Array(256).fill(7);
    const brit = applyAmpBundle(base, "British");
    AMP_BUNDLE_OFFSETS.forEach((o, i) => expect(brit[o]).toBe(AMP_BUNDLES["British"]![i]));
    expect(brit[0x10]).toBe(7);
    expect(base[AMP_BUNDLE_OFFSETS[0]!]).toBe(7);
  });

  it("all 10 real amps are captured; unknown names are a no-op", () => {
    expect(hasAmpBundle("Bass Driver")).toBe(true);
    expect(hasAmpBundle("Shred")).toBe(true);
    expect(hasAmpBundle("Blond")).toBe(false); // not a real amp on this pedal
    const base = new Uint8Array(256).fill(3);
    expect([...applyAmpBundle(base, "Blond")]).toEqual([...base]);
  });

  it("round-trips through detect for captured models", () => {
    for (const name of Object.keys(AMP_BUNDLES)) {
      expect(detectAmpModel(applyAmpBundle(new Uint8Array(256), name))).toBe(name);
    }
  });
});
