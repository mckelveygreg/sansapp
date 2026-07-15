import { describe, expect, it } from "vitest";
import {
  AMP_BUNDLE_OFFSETS,
  AMP_BUNDLES,
  applyAmpBundle,
  bundleMatches,
  detectAmpModel,
  hasAmpBundle,
  readAmpBundle,
} from "../src/protocol/amp";

// Offset positions that are NOT part of a model's voicing identity: Pre-Amp(0), Presence(3),
// Drive(4) are front-panel knobs a preset tweaks; Preset Level(7) is a per-preset output level.
const NON_IDENTITY_IDX = [0, 3, 4, 7] as const;

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

  it("each model's voicing character is unique, so detect is unambiguous", () => {
    const fingerprints = new Set(
      Object.values(AMP_BUNDLES).map((v) => [v[1], v[2], v[5], v[6]].join(",")),
    );
    expect(fingerprints.size).toBe(Object.keys(AMP_BUNDLES).length);
  });

  it("still detects a model after Pre-Amp/Drive/Presence/Level are tweaked (the real bug)", () => {
    // A saved preset keeps the model's character but dials its own front-panel + level. Detection
    // must fingerprint back to the base amp, not fail because the non-identity bytes moved.
    for (const name of Object.keys(AMP_BUNDLES)) {
      const blob = applyAmpBundle(new Uint8Array(256), name);
      for (const i of NON_IDENTITY_IDX) blob[AMP_BUNDLE_OFFSETS[i]!] ^= 0x1f; // stay within 7-bit
      expect(detectAmpModel(blob)).toBe(name);
    }
  });

  it("changing a character byte drops the match to a different model or null", () => {
    const blob = applyAmpBundle(new Uint8Array(256), "VT Bass");
    blob[AMP_BUNDLE_OFFSETS[1]!] = 111; // no model has Buzz=111
    expect(detectAmpModel(blob)).toBeNull();
  });

  it("bundleMatches keys on voicing, ignoring the per-preset Preset Level", () => {
    const blob = applyAmpBundle(new Uint8Array(256), "Flip");
    const saved = readAmpBundle(blob); // a custom = these 8 bytes
    blob[AMP_BUNDLE_OFFSETS[7]!] = (saved[7]! + 40) & 0x7f; // different preset level
    expect(bundleMatches(blob, saved)).toBe(true);
    blob[AMP_BUNDLE_OFFSETS[4]!] = (saved[4]! + 10) & 0x7f; // but a Drive change breaks it
    expect(bundleMatches(blob, saved)).toBe(false);
  });
});
