import { describe, expect, it } from "vitest";
import {
  AMP_APPLY_FIXED,
  AMP_BUNDLE_OFFSETS,
  AMP_BUNDLES,
  ampApplyExtras,
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

  it("changing a character byte falls back to the Buzz tag, else null", () => {
    const blob = applyAmpBundle(new Uint8Array(256), "VT Bass"); // Buzz 63
    blob[AMP_BUNDLE_OFFSETS[2]!] = 120; // break Punch so no template matches
    expect(detectAmpModel(blob)).toBe("VT Bass"); // Buzz 63 tag still catches it
    blob[AMP_BUNDLE_OFFSETS[1]!] = 111; // now Buzz=111 too — no tag
    expect(detectAmpModel(blob)).toBeNull();
  });

  it("tags the tweaked factory Para Driver / VT Bass presets via the Buzz fallback", () => {
    // Real factory bytes: neither preset's full voicing matches its namesake template.
    const paraDriver = new Uint8Array(256); // preset 3 char = (buzz 62, punch 86, pF 100, pQ 64)
    [0x24, 0x25, 0x2d, 0x4f].forEach((o, i) => (paraDriver[o] = [62, 86, 100, 64][i]!));
    expect(detectAmpModel(paraDriver)).toBe("Para Driver"); // Buzz 62 → Para Driver

    const vtBassDi = new Uint8Array(256); // preset 2 char = (buzz 63, punch 15, pF 64, pQ 90)
    [0x24, 0x25, 0x2d, 0x4f].forEach((o, i) => (vtBassDi[o] = [63, 15, 64, 90][i]!));
    expect(detectAmpModel(vtBassDi)).toBe("VT Bass"); // Buzz 63 → VT Bass

    const neutralDi = new Uint8Array(256); // the DI default (64,64,65,64) → no model
    [0x24, 0x25, 0x2d, 0x4f].forEach((o, i) => (neutralDi[o] = [64, 64, 65, 64][i]!));
    expect(detectAmpModel(neutralDi)).toBeNull();
  });

  it("apply always live-sets Buzz Q = 64 and Crunch Q = 0 (PROTOCOL-MAP §5)", () => {
    expect(AMP_APPLY_FIXED).toEqual([
      { index: 0x2c, value: 64 }, // Buzz Q
      { index: 0x2e, value: 0 }, // Crunch Q
    ]);
    for (const name of Object.keys(AMP_BUNDLES)) {
      const extras = ampApplyExtras(name);
      expect(extras).toContainEqual({ index: 0x2c, value: 64 });
      expect(extras).toContainEqual({ index: 0x2e, value: 0 });
    }
  });

  it("apply forces Mid (0x0c) = 0 for VT Bass & Para Driver only", () => {
    for (const name of ["VT Bass", "Para Driver"]) {
      expect(ampApplyExtras(name)).toContainEqual({ index: 0x0c, value: 0 });
    }
    for (const name of ["Bass Driver", "1970s", "British", "Shred", "Blackface"]) {
      expect(ampApplyExtras(name).some((e) => e.index === 0x0c)).toBe(false);
    }
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
