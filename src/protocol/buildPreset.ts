/**
 * Build the 256-byte preset blob for the CURRENT sound from the app's OWN state — the way EliteControl
 * does it (serialize its in-memory model), NOT by reading the pedal's 0x7F. Binary RE (EliteControl)
 * confirmed the pedal has no live "edit buffer": 0x7F is just program 127, so reading it to "save the
 * current sound" grabs the wrong preset (this was the "patch 128 landed in slot 1" bug). Instead we
 * overlay the app's modeled param values onto a base blob (the last-loaded preset's raw), preserving
 * every unmodeled byte (IR data + name, expander, tuner, reserved regions, …).
 *
 * Deep params live OUTSIDE pedalStore.values: the gate/comp block is in the dynamics store and
 * ambience decay/time + type in the ambience store (the deep-edit pages write only there). They're
 * merged over `values` here. Result is exactly 256 bytes; the SysEx encoder adds the 14-bit checksum.
 *
 * Framework-free: no React/React Native imports.
 */
import { applyAmbienceBundle } from "./ambience";
import type { ParamId } from "./params";
import { decodePreset, encodePreset } from "./preset";

export interface DynamicsSnapshot {
  gateThreshold: number;
  gateRatio: number;
  gateRelease: number;
  compOutput: number;
  compAttack: number;
  compRelease: number;
  autoGain: boolean;
  lookahead: boolean;
}

export interface AmbienceSnapshot {
  /** Index into AMBIENCE_ENGINES, or -1 for custom/unknown (leaves the base blob's profile as-is). */
  type: number;
  decay: number;
  time: number;
}

export function buildPresetBlob(
  base: Uint8Array,
  values: Partial<Record<ParamId, number>>,
  name: string,
  dyn: DynamicsSnapshot,
  amb: AmbienceSnapshot,
): Uint8Array {
  // Bake the ambience TYPE's 10-byte profile FIRST — two of its offsets (0x36/0x37) are the
  // ambienceTime/Decay params overlaid just below, so order matters. type < 0 keeps the base profile.
  const withAmb = amb.type >= 0 ? applyAmbienceBundle(base, amb.type) : base.slice();
  const decoded = decodePreset(withAmb);
  // Start from the base's full value set (so no modeled param is undefined), overlay the app's live
  // edits, then the deep-store params (which the edit pages keep only in dynamics/ambience stores).
  const merged = { ...decoded.values, ...values } as Record<ParamId, number>;
  merged.gateThreshold = dyn.gateThreshold;
  merged.gateRatio = dyn.gateRatio;
  merged.gateRelease = dyn.gateRelease;
  merged.compOutput = dyn.compOutput;
  merged.compAttack = dyn.compAttack;
  merged.compRelease = dyn.compRelease;
  merged.autoGain = dyn.autoGain ? 1 : 0;
  merged.lookahead = dyn.lookahead ? 1 : 0;
  merged.ambienceDecay = amb.decay;
  merged.ambienceTime = amb.time;
  // Keep the base's IR name byte-exact (encodePreset's "changed?" guard leaves 0xc0..0xdf untouched).
  return encodePreset({ name, irName: decoded.irName, values: merged, raw: withAmb });
}
