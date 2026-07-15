/**
 * Ambience type = a bundle of preset-blob bytes (there's no single "type" index). Selecting a type
 * in EliteControl rewrites these offsets via a `05 20` edit-buffer write. Captured 2026-07-05, one
 * type at a time; rows are index-aligned to AMBIENCE_ENGINES (Room…Echo Verb). To apply a type:
 * read the edit buffer, patch these bytes, write it back. Framework-free.
 *
 * Re-validated 2026-07-08 by a clean per-engine proxy pass (docs/CAPTURE-PLAYBOOK.md → selector
 * session): the identity bytes below (0x32–0x3A, 0x5C, 0x5D) matched these values exactly for all 7
 * engines. Also observed: offset 0x5E flips 0→1 on the first engine select — the "ambience engaged"
 * flag — so applyAmbienceBundle sets it too, otherwise selecting a type on a preset whose ambience
 * was off would be silent.
 */

/** Blob offsets that define the ambience type/voicing. */
export const AMBIENCE_BUNDLE_OFFSETS = [
  0x32, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x5c, 0x5d, 0x5f,
] as const;

/** Per-type values at AMBIENCE_BUNDLE_OFFSETS (index = AMBIENCE_ENGINES index). */
export const AMBIENCE_BUNDLES: readonly (readonly number[])[] = [
  [47, 20, 3, 49, 127, 93, 127, 15, 0, 0, 34], // Room
  [64, 8, 2, 64, 127, 64, 64, 20, 4, 127, 34], // Hall
  [109, 100, 2, 71, 127, 73, 26, 23, 26, 0, 34], // Spring
  [86, 120, 2, 127, 127, 45, 127, 42, 4, 127, 34], // Plate
  [74, 84, 4, 52, 0, 0, 127, 0, 67, 60, 34], // Chorus Verb
  [64, 64, 5, 0, 127, 64, 127, 15, 0, 0, 34], // Echo
  [64, 70, 5, 0, 127, 32, 127, 10, 0, 0, 34], // Echo Verb
];

/** Return a copy of `blob` with the ambience-type bytes set for `typeIndex`. */
export function applyAmbienceBundle(blob: Uint8Array, typeIndex: number): Uint8Array {
  const vals = AMBIENCE_BUNDLES[typeIndex];
  if (!vals) return blob.slice();
  const next = blob.slice();
  AMBIENCE_BUNDLE_OFFSETS.forEach((o, i) => {
    next[o] = vals[i]! & 0x7f;
  });
  next[0x5e] = 1; // engage the ambience block (observed 0→1 on engine select, 2026-07-08)
  return next;
}

/**
 * Best-guess current ambience type from a blob, or -1 if nothing is close. Uses NEAREST match, not
 * exact: some of these offsets are per-engine ADJUSTABLE params (e.g. 0x32 was read back at 69 where
 * the Echo Verb default is 64), so a strict match returned -1 on real presets and the picker showed
 * nothing selected. The engines differ from each other by several bytes, so a small tolerance can't
 * cross-identify them.
 */
export function detectAmbienceType(blob: Uint8Array): number {
  let best = -1;
  let bestMiss = Infinity;
  for (let t = 0; t < AMBIENCE_BUNDLES.length; t++) {
    const bundle = AMBIENCE_BUNDLES[t]!;
    let miss = 0;
    for (let i = 0; i < AMBIENCE_BUNDLE_OFFSETS.length; i++) {
      if (blob[AMBIENCE_BUNDLE_OFFSETS[i]!] !== bundle[i]) miss++;
    }
    if (miss < bestMiss) {
      bestMiss = miss;
      best = t;
    }
  }
  return bestMiss <= 2 ? best : -1;
}
