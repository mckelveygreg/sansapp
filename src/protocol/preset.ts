/**
 * Preset blob codec — decode/encode the 256-byte format used by the pedal and,
 * byte-for-byte, by the official EliteControl `.dat` files.
 *
 * Contract: `encodePreset(decodePreset(b))` deep-equals `b` for any valid blob.
 * This holds regardless of how complete `PARAMS` is, because `raw` is the source
 * of truth and only known param offsets + changed name strings are overlaid.
 *
 * Framework-free: no React/React Native imports.
 */

import { IR_NAME_LENGTH, IR_NAME_OFFSET, NAME_LENGTH, NAME_OFFSET, PRESET_SIZE } from "./constants";
import { PARAM_IDS, PARAMS } from "./params";
import type { ParamId } from "./params";

export interface Preset {
  readonly name: string;
  /** Selected-IR name string (empty when the preset uses no named IR). */
  readonly irName: string;
  readonly values: Readonly<Record<ParamId, number>>;
  /** The full original 256 bytes; source of truth for byte-exact round-trips. */
  readonly raw: Uint8Array;
}

function readString(raw: Uint8Array, off: number, len: number): string {
  let end = off + len;
  while (end > off) {
    const c = raw[end - 1]!;
    if (c === 0x20 || c === 0x00) end--;
    else break;
  }
  let s = "";
  for (let i = off; i < end; i++) {
    const c = raw[i]!;
    if (c === 0x00) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function writeString(buf: Uint8Array, off: number, len: number, s: string): void {
  for (let i = 0; i < len; i++) {
    buf[off + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0x20; // factory pads with spaces
  }
}

function clamp7(v: number): number {
  return v < 0 ? 0 : v > 127 ? 127 : v | 0;
}

export function decodePreset(blob: Uint8Array): Preset {
  if (blob.length !== PRESET_SIZE) {
    throw new RangeError(`preset must be ${PRESET_SIZE} bytes, got ${blob.length}`);
  }
  const raw = blob.slice();
  const values = {} as Record<ParamId, number>;
  for (const id of PARAM_IDS) values[id] = raw[PARAMS[id].blobOffset]!;
  return {
    name: readString(raw, NAME_OFFSET, NAME_LENGTH),
    irName: readString(raw, IR_NAME_OFFSET, IR_NAME_LENGTH),
    values,
    raw,
  };
}

export function encodePreset(preset: Preset): Uint8Array {
  const buf = preset.raw.slice();
  for (const id of PARAM_IDS) buf[PARAMS[id].blobOffset] = clamp7(preset.values[id]);
  // Only rewrite a name region if it actually changed, so an unmodified preset
  // round-trips to identical bytes (avoids space-vs-NUL padding drift).
  if (readString(buf, NAME_OFFSET, NAME_LENGTH) !== preset.name) {
    writeString(buf, NAME_OFFSET, NAME_LENGTH, preset.name);
  }
  if (readString(buf, IR_NAME_OFFSET, IR_NAME_LENGTH) !== preset.irName) {
    writeString(buf, IR_NAME_OFFSET, IR_NAME_LENGTH, preset.irName);
  }
  return buf;
}

/** Immutable update of a single parameter. */
export function withValue(preset: Preset, id: ParamId, value: number): Preset {
  return { ...preset, values: { ...preset.values, [id]: clamp7(value) } };
}

/** Immutable rename. */
export function withName(preset: Preset, name: string): Preset {
  return { ...preset, name };
}
