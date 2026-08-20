/**
 * Config-block helpers for the pedal's global settings ("Special Page Functions"), which live
 * in DATA blocks (05 52). The write is `05 52 0A <index> <256> <ck>` (see messages.ts); the
 * pedal acks `05 53`.
 *
 *   block 0x00  Special Page Functions — one byte per function (see SPECIAL_FUNCTIONS)
 *   block 0x01  MIDI CC map (8 params → CC number: Drive/Low/Mid/High/Reverb/Gate/Filter/Level)
 *   block 0x02  128-entry Program-Change → preset map (identity by default)
 *
 * Byte→function map derived (2026-07-04) by capturing EliteControl change each row + the
 * settings screenshot. Two anchors make it solid: tuner frequency byte 12→17 with Hz = byte+428
 * (baseline 440 Hz → 445 Hz), and tuner detune 0→1→2 = none/b/bb. Confidence per entry below.
 * Framework-free.
 */

export const SETTINGS_BLOCK = 0x00;
export const CC_MAP_BLOCK = 0x01;
export const PC_MAP_BLOCK = 0x02;
export const BLOCK_SIZE = 256;

/**
 * block0[0] is **the pedal's ACTIVE PROGRAM**, patched from RAM on every read — the only live value
 * anywhere in the read surface (docs/adr/0001), which is why the app can always show the right preset
 * number while the values beside it may be stale. It was once modelled here as a constant `0x7F`
 * marker; the captured dump that came from simply had the pedal sitting on program 128 at the time.
 * There is nothing to export: `session.readBlock(0x55, SETTINGS_BLOCK)[0]` is the whole interface.
 */

export type SettingKind = "toggle" | "channel" | "tunerFreq" | "tunerDetune";

export interface SpecialFunction {
  readonly offset: number;
  readonly id: string;
  readonly label: string;
  readonly kind: SettingKind;
  /** For a toggle: option labels [offValue=0, onValue=1]. */
  readonly options?: readonly [string, string];
  readonly confidence: "strong" | "good" | "tentative";
}

/** Special Page Functions in the pedal's settings block (data block 0). */
export const SPECIAL_FUNCTIONS: readonly SpecialFunction[] = [
  {
    offset: 1,
    id: "patchOffset",
    label: "Patch Offset",
    kind: "toggle",
    options: ["1–128", "0–127"],
    confidence: "good",
  },
  {
    // Confirmed 2026-07-07 by two clean single-toggle captures (Safe Level Mode toggled first each
    // time; offset 17 flipped).
    offset: 17,
    id: "safeLevelMode",
    label: "Safe Level Mode",
    kind: "toggle",
    options: ["Off", "On"],
    confidence: "strong",
  },
  {
    // Confirmed 2026-07-07 (clean single-toggle capture): MIDI Thru = offset 2.
    offset: 2,
    id: "midiThru",
    label: "MIDI Thru",
    kind: "toggle",
    options: ["Disabled", "Enabled"],
    confidence: "strong",
  },
  {
    // MIDI Mapping = offset 3, by elimination: the two clean 2026-07-07 captures pinned Safe Level
    // Mode = offset 17 and MIDI CC Mode = offset 4, leaving offset 3 (a real toggle, default 1) as
    // the only home for the remaining name "MIDI Mapping".
    offset: 3,
    id: "midiMapping",
    label: "MIDI Mapping",
    kind: "toggle",
    options: ["Disabled", "Enabled"],
    confidence: "good",
  },
  {
    // Confirmed 2026-07-07 by a clean capture: MIDI CC Mode toggled ON, the CC map (data block 1)
    // adjusted, then OFF — offset 4 flipped each time. When on, the per-parameter CC numbers live in
    // data block 1.
    offset: 4,
    id: "midiCcMode",
    label: "MIDI CC Mode",
    kind: "toggle",
    options: ["Disabled", "Enabled"],
    confidence: "strong",
  },
  {
    // Confirmed 2026-07-06 by a clean single-toggle capture: byte 7 = disengaged flag (1=disengaged),
    // with byte 15 as its inverse (engaged flag). A correct write must set both (see withDisengagePots).
    offset: 7,
    id: "disengagePots",
    label: "Disengage All Pots",
    kind: "toggle",
    options: ["Engaged", "Disengaged"],
    confidence: "strong",
  },
  {
    // Confirmed 2026-07-07: offset 9 = Preset Protection.
    offset: 9,
    id: "presetProtection",
    label: "Preset Protection",
    kind: "toggle",
    options: ["Off", "On"],
    confidence: "strong",
  },
  {
    // Confirmed 2026-07-07.
    offset: 16,
    id: "cabinetBypass",
    label: "Cabinet Bypass",
    kind: "toggle",
    options: ["Off", "On"],
    confidence: "strong",
  },
  { offset: 5, id: "midiChannel", label: "MIDI Channel", kind: "channel", confidence: "strong" },
  { offset: 8, id: "tunerFreq", label: "Tuner Frequency", kind: "tunerFreq", confidence: "strong" },
  {
    offset: 10,
    id: "tunerDetune",
    label: "Tuner Detune",
    kind: "tunerDetune",
    confidence: "strong",
  },
] as const;

/** Offsets touched by a special function (superset used by tests / raw inspection). */
export const SPECIAL_FN_OFFSETS = SPECIAL_FUNCTIONS.map((f) => f.offset);

/** Tuner reference frequency is stored as (Hz − 428): 12 → 440 Hz, 17 → 445 Hz. */
export const TUNER_HZ_BASE = 428;
export const tunerHz = (byte: number): number => byte + TUNER_HZ_BASE;
export const tunerHzToByte = (hz: number): number => hz - TUNER_HZ_BASE;

/** Tuner detune steps (flats). */
export const TUNER_DETUNE = ["none", "b", "bb", "bbb"] as const;

export function isSettingOn(block: Uint8Array, offset: number): boolean {
  return (block[offset] ?? 0) !== 0;
}

/** Return a copy of `block` with the byte at `offset` set to `value` (0/1 for a toggle). */
export function withSetting(block: Uint8Array, offset: number, value: number): Uint8Array {
  const next = block.slice();
  next[offset] = value & 0x7f;
  return next;
}

/** Byte 15 mirrors Disengage Pots inversely (1 = engaged); the pedal expects both bytes set. */
export const DISENGAGE_POTS_INVERSE_OFFSET = 15;

/** Return a copy of settings block 0 with the paired disengage-pots flags set correctly. */
export function withDisengagePots(block: Uint8Array, disengaged: boolean): Uint8Array {
  const next = block.slice();
  next[7] = disengaged ? 1 : 0;
  next[DISENGAGE_POTS_INVERSE_OFFSET] = disengaged ? 0 : 1;
  return next;
}

/** The 128-entry Program-Change → preset map from block 2. */
export function parsePcMap(block: Uint8Array): number[] {
  return [...block.subarray(0, 128)];
}

/** Return a copy of block 2 with a new PC→preset map (values masked to 7-bit). */
export function withPcMap(block: Uint8Array, map: readonly number[]): Uint8Array {
  const next = block.slice();
  for (let i = 0; i < Math.min(128, map.length); i++) next[i] = map[i]! & 0x7f;
  return next;
}
