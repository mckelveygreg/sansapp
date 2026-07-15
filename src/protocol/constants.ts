/**
 * Device constants for the Tech 21 SansAmp Programmable Bass Driver DI Elite.
 *
 * SysEx prefix, preset-blob layout, and enum orderings (which index maps to which amp/effect/IR)
 * are all confirmed against hardware and the factory preset data.
 *
 * Framework-free: no React/React Native imports.
 */

// --- SysEx framing (prefix F0 00 51 21, confirmed throughout captured traffic) ---
export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
/** Tech 21 manufacturer id (3-byte). */
export const MANUFACTURER_ID: readonly number[] = Object.freeze([0x00, 0x51, 0x21]);
export const SYSEX_PREFIX = Uint8Array.of(SYSEX_START, 0x00, 0x51, 0x21);

// --- Preset blob layout (confirmed against 128 factory .dat files, all 256 bytes) ---
export const PRESET_SIZE = 256;
/** Bytes 0..1 are a constant version/header. */
export const PRESET_HEADER = Uint8Array.of(0x01, 0x00);
export const NAME_OFFSET = 0x02;
export const NAME_LENGTH = 32; // bytes 0x02..0x21, space-padded ASCII
/** Active parameter bytes observed varying across factory presets: 0x22..0x6B. */
export const PARAM_REGION_START = 0x22;
export const PARAM_REGION_END = 0x6c; // exclusive
/** Bytes 0x6C..0xBF are zero in all factory presets (reserved / user-IR area). */
export const RESERVED_REGION_START = 0x6c;
export const RESERVED_REGION_END = 0xc0; // exclusive
/** Selected-IR name string, e.g. "VT_SPKR", "PARA_SPKR" (empty when unused). */
export const IR_NAME_OFFSET = 0xc0;
export const IR_NAME_LENGTH = 32; // bytes 0xC0..0xDF
/** IR data/levels tail, present only for IR-using presets. */
export const IR_TAIL_OFFSET = 0xe0;
export const IR_TAIL_END = 0x100; // exclusive

// --- Preset banking (from manual) ---
export const PRESET_SLOT_COUNT = 128; // Studio mode slots (1..128)
export const PERFORMANCE_SLOTS = 3; // Performance mode presets 1..3

/**
 * Amp models, in the desktop editor's on-screen grid order (row-major), confirmed against hardware.
 */
// The 10 amp models in EliteControl's on-screen grid order (row-major), confirmed 2026-07-05.
// (amp-blond.png / amp-leeds.png ship in the app resources but aren't exposed by the pedal.)
export const AMP_MODELS: readonly string[] = Object.freeze([
  "Bass Driver",
  "VT Bass",
  "Para Driver",
  "1970s",
  "1980s",
  "Flip",
  "VT Stack",
  "Blackface",
  "British",
  "Shred",
]);

/** Ambience/reverb engines — confirmed from the EliteControl AMBIENCE panel (2026-07-05). */
export const AMBIENCE_ENGINES: readonly string[] = Object.freeze([
  "Room",
  "Hall",
  "Spring",
  "Plate",
  "Chorus Verb",
  "Echo",
  "Echo Verb",
]);

// (FACTORY_IRS removed — cab names now come from reading the pedal, not a shipped list. The pedal's
// factory cab labels live in the desktop app's Resources/irs/ if ever needed for reference.)
