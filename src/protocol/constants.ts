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

// --- Protocol version (byte 6 of every framed message) ---
// Byte 6 is the pedal's firmware version × 10, NOT a fixed marker: firmware 1.0 uses 0x0A, 1.1 uses
// 0x0B and 1.2 uses 0x0C. EliteControl displays it as `version/10` with one decimal, warns "please
// upgrade" below 0x0A, and "editor out of date" above 0x77 — so it reads the byte as a number, and
// both ends must agree on it. EliteControl itself is pinned to one version per release (1.0 → 0x0A,
// 1.1 → 0x0B, 1.2 → 0x0C) and rejects the others; SansApp instead negotiates, so one build talks to
// all three.
//
// The pedal is equally strict in the other direction: it compares byte 6 for equality *before* it
// reads the command byte, and a mismatch is dropped silently — no reply, no error. So sending the
// wrong version doesn't degrade, it goes completely quiet, which is why the handshake probes.
/** Firmware 1.0. */
export const PROTOCOL_V1_0 = 0x0a;
/** Firmware 1.1. */
export const PROTOCOL_V1_1 = 0x0b;
/** Firmware 1.2. */
export const PROTOCOL_V1_2 = 0x0c;
/** Tried first on connect; DeviceSession falls back to the other candidates, then latches whatever
 * version the pedal actually replies with. */
export const DEFAULT_PROTOCOL_VERSION = PROTOCOL_V1_2;
/** Versions the connect handshake probes, in order — newest first, so current hardware connects on
 * the first try and older pedals cost one timeout each (once: the session caches what answered). */
export const PROTOCOL_VERSIONS: readonly number[] = Object.freeze([
  PROTOCOL_V1_2,
  PROTOCOL_V1_1,
  PROTOCOL_V1_0,
]);
/** Accepted range on decode, matching EliteControl's own window (it rejects <0x0A and >0x77). Being
 * permissive here means a future firmware keeps talking to us instead of going silent. */
export const MIN_PROTOCOL_VERSION = PROTOCOL_V1_0;
export const MAX_PROTOCOL_VERSION = 0x77;

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
 * The 10 amp models in the desktop editor's on-screen grid order (row-major), confirmed against
 * hardware (2026-07-05).
 */
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
