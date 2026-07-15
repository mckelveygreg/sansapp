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

/** Best-guess current amp model from a blob, or null if none match. */
export function detectAmpModel(blob: Uint8Array): string | null {
  for (const [name, vals] of Object.entries(AMP_BUNDLES)) {
    if (AMP_BUNDLE_OFFSETS.every((o, i) => blob[o] === vals[i])) return name;
  }
  return null;
}
