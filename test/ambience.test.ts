import { describe, expect, it } from "vitest";
import {
  AMBIENCE_BUNDLE_OFFSETS,
  AMBIENCE_BUNDLES,
  applyAmbienceBundle,
  detectAmbienceType,
} from "../src/protocol/ambience";
import { AMBIENCE_ENGINES } from "../src/protocol/constants";

describe("ambience type bundles", () => {
  it("has one bundle per engine, each sized to the offset list", () => {
    expect(AMBIENCE_BUNDLES).toHaveLength(AMBIENCE_ENGINES.length);
    for (const b of AMBIENCE_BUNDLES) expect(b).toHaveLength(AMBIENCE_BUNDLE_OFFSETS.length);
  });

  it("applies a type's bytes and leaves the rest of the blob alone", () => {
    const base = new Uint8Array(256).fill(9);
    const hall = applyAmbienceBundle(base, 1); // Hall
    AMBIENCE_BUNDLE_OFFSETS.forEach((o, i) => expect(hall[o]).toBe(AMBIENCE_BUNDLES[1]![i]));
    // a byte not in the bundle is untouched
    expect(hall[0x10]).toBe(9);
    expect(base[AMBIENCE_BUNDLE_OFFSETS[0]!]).toBe(9); // source not mutated
  });

  it("round-trips through detect", () => {
    for (let t = 0; t < AMBIENCE_ENGINES.length; t++) {
      expect(detectAmbienceType(applyAmbienceBundle(new Uint8Array(256), t))).toBe(t);
    }
  });
});
