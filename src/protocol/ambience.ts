/**
 * Ambience type = a profile of 10 params. Derived from observing EliteControl (2026-07-15): picking
 * an ambience type LIVE-SETS these 10 params (`05 50`) from a per-type table — it does NOT write the
 * edit buffer, does NOT commit, and does NOT touch "Reverb Mode" (0x39). The 7 types (Room…Echo Verb)
 * are all this same mechanism; 0x13 "Reverb Extension Factor" (2–5) is the coarse family selector and
 * the other 9 params differentiate within it. Values below are index-aligned to AMBIENCE_ENGINES and
 * exactly match EliteControl's profile table. Framework-free.
 *
 * A blob write to the edit buffer (0x7F) would not stick — the pedal discards 0x7F writes — which is
 * why the type is applied by live-set rather than a buffer patch.
 */

/** The 10 param WIRE indices an ambience type live-sets (set-id = index+4 via liveSetId). */
export const AMBIENCE_PROFILE_WIRES = [
  0x10, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x3a, 0x3b,
] as const;

/** Blob offsets of those 10 params (wire + 0x22) — for reading a type back off a loaded preset. */
export const AMBIENCE_BUNDLE_OFFSETS = AMBIENCE_PROFILE_WIRES.map((w) => w + 0x22);

/** Per-type values for AMBIENCE_PROFILE_WIRES (index = AMBIENCE_ENGINES index). */
export const AMBIENCE_BUNDLES: readonly (readonly number[])[] = [
  [47, 20, 3, 49, 127, 93, 127, 15, 0, 0], // Room
  [64, 8, 2, 64, 127, 64, 64, 20, 4, 127], // Hall
  [109, 100, 2, 71, 127, 73, 26, 23, 26, 0], // Spring
  [86, 120, 2, 127, 127, 45, 127, 42, 4, 127], // Plate
  [74, 84, 4, 52, 0, 0, 127, 0, 67, 60], // Chorus Verb
  [64, 64, 5, 0, 127, 64, 127, 15, 0, 0], // Echo
  [64, 70, 5, 0, 127, 32, 127, 10, 0, 0], // Echo Verb
];

/**
 * Bake a type's 10 profile bytes into a copy of `blob` — for saving a type INTO a preset blob
 * (writePreset to a slot). Live audio changes go through the live-set path (setAmbienceType), which
 * is what actually sticks; this is only for the persist-to-slot path.
 */
export function applyAmbienceBundle(blob: Uint8Array, typeIndex: number): Uint8Array {
  const vals = AMBIENCE_BUNDLES[typeIndex];
  if (!vals) return blob.slice();
  const next = blob.slice();
  AMBIENCE_BUNDLE_OFFSETS.forEach((o, i) => {
    next[o] = vals[i]! & 0x7f;
  });
  return next;
}

/**
 * Best-guess current ambience type from a preset blob, or -1 if nothing is close. NEAREST match
 * (not exact): some of these offsets are per-engine ADJUSTABLE params, so a strict match misses real
 * presets. The engines differ by several bytes, so a small tolerance can't cross-identify them.
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
