/**
 * Build the 256-byte preset blob for the CURRENT sound from the app's OWN state — the way EliteControl
 * does it (serialize its in-memory model), NOT by reading the pedal's 0x7F. Observing EliteControl
 * confirmed the pedal has no live "edit buffer": 0x7F is just program 127, so reading it to "save the
 * current sound" grabs the wrong preset (this was the "patch 128 landed in slot 1" bug). Instead we
 * overlay the app's modeled param values onto a base blob (the last-loaded preset's raw), preserving
 * every unmodeled byte (IR data + name, expander, tuner, reserved regions, …).
 *
 * Every modeled parameter — the gate/comp block and ambience decay/time included — is read from
 * `values` (pedalStore's single source of truth). `ambienceType` is the ONE piece of non-parameter
 * state: pass the engine index to re-bake its canonical 10-byte profile (only when the user actually
 * picked a type this session), or null to preserve the base blob's profile bytes as-is. Result is
 * exactly 256 bytes; the SysEx encoder adds the 14-bit checksum.
 *
 * Framework-free: no React/React Native imports.
 */
import { applyAmbienceBundle } from "./ambience";
import type { ParamId } from "./params";
import { decodePreset, encodePreset } from "./preset";

export function buildPresetBlob(
  base: Uint8Array,
  values: Partial<Record<ParamId, number>>,
  name: string,
  ambienceType: number | null,
): Uint8Array {
  // Bake the ambience TYPE's 10-byte profile FIRST when a type was applied this session: ambienceTime
  // (blob 0x32 = Reverb Room Size) is one of the profile offsets and is overlaid from `values` just
  // below, so order matters (the Time knob value wins over the type default). ambienceDecay (blob
  // 0x33 = Reverb Decay Time) sits outside the profile. null → keep the base blob's profile bytes.
  const withAmb =
    ambienceType != null && ambienceType >= 0
      ? applyAmbienceBundle(base, ambienceType)
      : base.slice();
  const decoded = decodePreset(withAmb);
  // Start from the base's full value set (so no modeled param is undefined), then overlay the app's
  // live values — the single source of truth for every modeled param (gate/comp/ambience included).
  const merged = { ...decoded.values, ...values } as Record<ParamId, number>;
  // Keep the base's IR name byte-exact (encodePreset's "changed?" guard leaves 0xc0..0xdf untouched).
  return encodePreset({ name, irName: decoded.irName, values: merged, raw: withAmb });
}
