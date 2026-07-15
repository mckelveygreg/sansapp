/**
 * Amp model = a bundle of preset-blob bytes (no single index — selecting an amp in EliteControl
 * rewrites these offsets via a `05 20` edit-buffer write). To apply: read the edit buffer, patch
 * these bytes, write it back. Framework-free.
 *
 * Captured 2026-07-05 in one clean, unbroken single-capture pass, verified against 3 anchors
 * (Blackface/1980s/Shred). All 10 amps mapped. (An earlier pass was corrupted by duplicate capture instance
 * instances returning stale reads — discarded.)
 */

/** Blob offsets that define the amp voicing (preamp/presence/drive + 5 more). */
export const AMP_BUNDLE_OFFSETS = [0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x4f, 0x62] as const;

/** Per-model values at AMP_BUNDLE_OFFSETS, keyed by AMP_MODELS name. */
export const AMP_BUNDLES: Readonly<Record<string, readonly number[]>> = {
  "Bass Driver": [20, 64, 9, 59, 15, 75, 95, 127],
  "VT Bass": [26, 63, 64, 64, 20, 65, 64, 0],
  "Para Driver": [10, 62, 64, 0, 25, 8, 80, 127],
  "1970s": [20, 64, 14, 34, 20, 23, 64, 127],
  "1980s": [25, 58, 5, 21, 25, 60, 43, 127],
  Flip: [20, 64, 31, 17, 10, 86, 60, 127],
  "VT Stack": [20, 70, 28, 21, 15, 60, 63, 127],
  Blackface: [22, 64, 0, 36, 22, 64, 67, 127],
  British: [61, 27, 77, 67, 96, 39, 80, 14],
  Shred: [61, 43, 105, 67, 96, 40, 27, 14],
};

/** Whether we have a captured bundle for `ampName`. */
export const hasAmpBundle = (ampName: string): boolean => ampName in AMP_BUNDLES;

/** Return a copy of `blob` with the amp-model bytes set for `ampName` (unchanged if uncaptured). */
export function applyAmpBundle(blob: Uint8Array, ampName: string): Uint8Array {
  const vals = AMP_BUNDLES[ampName];
  if (!vals) return blob.slice();
  const next = blob.slice();
  AMP_BUNDLE_OFFSETS.forEach((o, i) => {
    next[o] = vals[i]! & 0x7f;
  });
  return next;
}

/**
 * The voicing-character bytes (indices into a bundle: Buzz, Punch, Punch-Freq, Punch-Q) that
 * identify an amp model. Pre-Amp/Drive/Presence are front-panel knobs a preset tweaks on top, and
 * Preset Level is a per-preset output level — none are part of the model's identity, so we match on
 * the character alone. Every factory bundle is unique on these four (British vs Shred differ ONLY
 * here), so a loaded preset still fingerprints back to the amp it was voiced from even after edits.
 */
const CHARACTER_IDX = [1, 2, 5, 6] as const;

/**
 * EliteControl's fallback when no template matches exactly: the Buzz byte alone tags the Para/VT
 * "clean DI" family. Binary RE of SelectAmpMode's fallback (EliteControl.arm64 @0x1000c380c) — Buzz
 * 62 → Para Driver, 63 → VT Bass, anything else → no highlight. This is why the factory "Para
 * Driver"/"VT Bass DI" presets, whose full voicing is tweaked away from the model template, still
 * light up the right amp. Collision-free: Buzz 62 only occurs in Para Driver, 63 only in VT Bass.
 */
const BUZZ_OFFSET = AMP_BUNDLE_OFFSETS[1]!; // 0x24
const BUZZ_TAG: Readonly<Record<number, string>> = { 62: "Para Driver", 63: "VT Bass" };

/**
 * The amp model a blob is voiced from, mirroring EliteControl's preset→model read-back: first an
 * exact character-byte match against the 10 templates, then the Buzz-byte fallback. Null if neither.
 */
export function detectAmpModel(blob: Uint8Array): string | null {
  for (const [name, vals] of Object.entries(AMP_BUNDLES)) {
    if (CHARACTER_IDX.every((i) => blob[AMP_BUNDLE_OFFSETS[i]!] === vals[i])) return name;
  }
  return BUZZ_TAG[blob[BUZZ_OFFSET]!] ?? null;
}

/** The current amp-voicing bytes (at AMP_BUNDLE_OFFSETS) — for saving a custom amp. */
export function readAmpBundle(blob: Uint8Array): number[] {
  return AMP_BUNDLE_OFFSETS.map((o) => blob[o]!);
}

/** Apply an explicit amp-voicing byte set (e.g. a saved custom) onto a blob. */
export function applyAmpBundleBytes(blob: Uint8Array, bytes: readonly number[]): Uint8Array {
  const next = blob.slice();
  AMP_BUNDLE_OFFSETS.forEach((o, i) => {
    if (bytes[i] !== undefined) next[o] = bytes[i]! & 0x7f;
  });
  return next;
}

/**
 * Does the blob's voicing exactly match `bytes` (a saved custom)? Compares the 7 voicing bytes but
 * ignores Preset Level (the trailing offset) — that's a per-preset output level, not part of the
 * amp's identity, so a custom stays "active" across presets with different levels.
 */
export function bundleMatches(blob: Uint8Array, bytes: readonly number[]): boolean {
  return AMP_BUNDLE_OFFSETS.slice(0, -1).every((o, i) => blob[o] === bytes[i]);
}
