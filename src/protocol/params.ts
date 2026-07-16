/**
 * Parameter registry — the single source of truth that the codec, UI, docs, and
 * emulator all derive from.
 *
 * blobOffsets confirmed by correlating a saved preset against the live `05 50` setParam stream:
 * edit N knobs, save, then for each paramId find the changed byte whose value == the knob's final
 * value. The main panel is a contiguous block: `blob offset == paramId + 0x22` (0x22..0x2F, paramId
 * 0x00..0x0D). The same rule holds for the deep params too. See docs/PARAM-MAP.md for the full map.
 *
 * Framework-free: no React/React Native imports.
 */

export type ParamGroup = "preamp" | "tone" | "dynamics" | "redzone" | "ambience" | "level" | "ir";
export type ParamKind = "continuous" | "enum" | "toggle";

export interface ParamDef {
  /** Stable id used as the key in Preset.values and everywhere in code. */
  readonly id: string;
  /** Label as printed on the pedal / shown in the UI. */
  readonly label: string;
  readonly group: ParamGroup;
  readonly kind: ParamKind;
  /** Raw wire range. 7-bit confirmed from factory .dat analysis (all bytes <= 0x7F). */
  readonly min: number;
  readonly max: number;
  /** Byte offset within the 256-byte preset blob. Confirmed against hardware. */
  readonly blobOffset: number;
  /**
   * Parameter id used in live `05 51 0A <paramId> <value>` messages (live capture).
   * Distinct from `blobOffset` (the two addressing schemes differ). All 15 confirmed.
   */
  readonly paramId?: number;
  /** Whether the blob offset/semantics have been verified against the real device. */
  readonly confirmed: boolean;
  /** For enum params, the option labels (index = wire value). */
  readonly enumLabels?: readonly string[];
}

function knob(
  id: string,
  label: string,
  group: ParamGroup,
  blobOffset: number,
  paramId?: number,
  confirmed = false,
): ParamDef {
  return {
    id,
    label,
    group,
    kind: "continuous",
    min: 0,
    max: 127,
    blobOffset,
    paramId,
    confirmed,
  };
}

/**
 * Main panel + Red Zone continuous controls. All confirmed against hardware; see docs/PARAM-MAP.md.
 */
export const PARAMS = {
  // Main panel — contiguous block: blobOffset == paramId + 0x22.
  level: knob("level", "Level", "level", 0x22, 0x00, true),
  preamp: knob("preamp", "Preamp", "redzone", 0x23, 0x01, true),
  presence: knob("presence", "Presence", "tone", 0x26, 0x04, true),
  drive: knob("drive", "Drive", "preamp", 0x27, 0x05, true),
  low: knob("low", "Low", "tone", 0x28, 0x06, true),
  high: knob("high", "High", "tone", 0x29, 0x07, true),
  ambiance: knob("ambiance", "Ambiance", "ambience", 0x2a, 0x08, true),
  comp: knob("comp", "Comp", "dynamics", 0x2c, 0x0a, true),
  mid: knob("mid", "Mid", "tone", 0x2e, 0x0c, true),
  // Parametric Mid Filter (deep page): MID knob = Gain (0x0c above), Freq/Q below.
  freq: knob("freq", "Freq", "redzone", 0x2f, 0x0d, true),
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // Deep-param controls. Each wire id is the pedal's own parameter index (the same index the
  // desktop editor uses), confirmed against hardware; the ids satisfy blobOffset − wireId = 0x22,
  // the same rule as the main panel. Blob offsets are the read-back positions. See docs/PARAM-MAP.md.
  q: knob("q", "Q", "redzone", 0x51, 0x2f, true), // mid Q
  // ratio (compressor) = 0x19. The COMPRESSOR block is 0x19-0x1c — its Ratio sweeps 1:1→20:1
  // (compression), vs the separate Expander block's 1:1→1:16 (downward expansion). See COMP_PARAMS.
  ratio: knob("ratio", "Ratio", "dynamics", 0x3b, 0x19, true),
  filter: knob("filter", "Filter", "redzone", 0x5f, 0x3d, true),
  chorus: knob("chorus", "Chorus", "ambience", 0x64, 0x42, true),
  blend: knob("blend", "Blend", "preamp", 0x69, 0x47, true),
  lowQ: knob("lowQ", "Low Q", "tone", 0x52, 0x30, true),
  highQ: knob("highQ", "High Q", "tone", 0x53, 0x31, true),
  lowFreq: knob("lowFreq", "Low Freq", "tone", 0x6a, 0x48, true),
  highFreq: knob("highFreq", "High Freq", "tone", 0x6b, 0x49, true),
  chorusModFreq: knob("chorusModFreq", "Chorus Mod Freq", "ambience", 0x65, 0x43, true),
  chorusModDepth: knob("chorusModDepth", "Chorus Mod Depth", "ambience", 0x66, 0x44, true),
  chorusDelaySize: knob("chorusDelaySize", "Chorus Delay Size", "ambience", 0x67, 0x45, true),
  chorusFeedback: knob("chorusFeedback", "Chorus Feedback", "ambience", 0x68, 0x46, true),
  // Deep params now read back from presets. blobOffset = wireId + 0x22 — binary-confirmed 2026-07-15
  // two ways: EliteControl's 05 41 decode loop applies body[0x22+k] to param k for k=0x00..0x49, and
  // a 128-preset oracle places every known toggle at its predicted +0x22 offset. Previously these
  // were send-only (didn't reset on preset change, no ghost). gateRatio's wire id (0x1d, Expander
  // Ratio) is inferred; its offset follows the same rule regardless.
  gateThreshold: knob("gateThreshold", "Gate Threshold", "dynamics", 0x2b, 0x09, true),
  gateRatio: knob("gateRatio", "Gate Ratio", "dynamics", 0x3f, 0x1d, true),
  gateRelease: knob("gateRelease", "Gate Release", "dynamics", 0x49, 0x27, true),
  compOutput: knob("compOutput", "Comp Output", "dynamics", 0x3c, 0x1a, true),
  compAttack: knob("compAttack", "Comp Attack", "dynamics", 0x3d, 0x1b, true),
  compRelease: knob("compRelease", "Comp Release", "dynamics", 0x3e, 0x1c, true),
  autoGain: knob("autoGain", "Auto Gain", "dynamics", 0x54, 0x32, true),
  lookahead: knob("lookahead", "Look-ahead", "dynamics", 0x55, 0x33, true),
  ambienceDecay: knob("ambienceDecay", "Ambience Decay", "ambience", 0x37, 0x15, true),
  ambienceTime: knob("ambienceTime", "Ambience Time", "ambience", 0x36, 0x14, true),
  // Amp-voicing params — the "hidden" bytes an amp-model bundle sets besides Pre-Amp/Drive/Presence.
  // Exposed so the amp models become re-voiceable starting points. Ranges uncalibrated (shown raw %).
  buzz: knob("buzz", "Buzz", "preamp", 0x24, 0x02, true),
  punch: knob("punch", "Punch", "preamp", 0x25, 0x03, true),
  punchFreq: knob("punchFreq", "Punch Freq", "preamp", 0x2d, 0x0b, true),
  punchQ: knob("punchQ", "Punch Q", "preamp", 0x4f, 0x2d, true),
  // IR select/morph — the continuous 0x0E value the IR page's mic rides (0 = Off/flat, ~16·n = cab
  // n, values between blend neighbours). Store-backed so the IR stack reflects the LOADED preset's
  // cab instead of a guess. blobOffset 0x30 = wire 0x0e + 0x22; confirmed against the 128-preset bank.
  irBlend: knob("irBlend", "IR", "ir", 0x30, 0x0e, true),
} as const satisfies Record<string, ParamDef>;

export type ParamId = keyof typeof PARAMS;

export const PARAM_IDS = Object.keys(PARAMS) as ParamId[];

/**
 * Map a parameter's iPlug INDEX (== its `05 51` notify id, what we store as `paramId`) to the wire
 * id the pedal expects in a live `05 50` SET message. Binary RE of EliteControl (const map at
 * 0x10013517c, 2026-07-15): indices 0x00–0x0F set on the same id (identity — the shallow main-panel
 * knobs), but the deep range 0x10–0x4D sets on **index + 4**. So Blend (index 0x47) is set via 0x4B,
 * not 0x47 (0x47 is only its notify id; setting 0x47 actually hits chorus-mod — the old "blend moved
 * the chorus" bug). The notify/read path stays on the index; only the write path uses this.
 * NOTE: needs on-device confirmation (send 0x4B for Blend) — the RE proves what EliteControl SENDS.
 */
export const liveSetId = (index: number): number =>
  index >= 0x10 && index <= 0x4d ? index + 4 : index;

/**
 * Deep Compressor-page paramIds (the `05 50` param byte). The main-panel **COMP knob (0x0A) is the
 * compressor THRESHOLD**; Ratio/Output Gain/Attack/Release are the Compressor block (0x19-0x1c);
 * Auto Gain/Lookahead are toggles. Ratio 0x19 sweeps 1:1→20:1 (compression) — distinct from the
 * separate Expander block (0x1d-0x20, 1:1→1:16 downward expansion). Units in units.ts: Ratio 1–20:1,
 * Output −30…+18 dB, Attack 1–100 ms, Release 10–1000 ms, Threshold Bypass→−60 dB.
 */
export const COMP_PARAMS = {
  threshold: 0x0a,
  ratio: 0x19,
  outputGain: 0x1a,
  attack: 0x1b,
  release: 0x1c,
  autoGain: 0x32,
  lookahead: 0x33,
} as const;

/**
 * Deep Auto-Filter-page paramIds. The red-zone **FILTER knob is the filter Level (0x3d)**; Attack
 * (0x3e) and Release (0x3f) are contiguous with it.
 */
export const AUTO_FILTER_PARAMS = {
  level: 0x3d,
  attack: 0x3e,
  release: 0x3f,
} as const;

/**
 * Deep Chorus-page paramIds. The Chorus knob is the chorus **Level (0x42)**; the deep panel adds the
 * rest. Ranges: Mod Freq 0–6 Hz, Mod Depth/Delay Size/Level 0–100 %, Feedback −100…+100 % (bipolar).
 */
export const CHORUS_PARAMS = {
  level: 0x42,
  modFreq: 0x43,
  modDepth: 0x44,
  delaySize: 0x45,
  feedback: 0x46,
} as const;

/**
 * Deep Ambience-page paramIds. The **AMBIANCE knob (0x08) is Level**; Decay = 0x15; Time = 0x14
 * (Echo / Echo Verb only). Selecting an ambience *type* also rewrites a small block of blob offsets
 * (0x32, 0x34–0x3A, 0x5C/0x5D/0x5F); those aren't individually labelled yet (roadmap).
 */
export const AMBIENCE_PARAMS = {
  level: 0x08,
  decay: 0x15,
  time: 0x14,
} as const;

/**
 * Gate / expander (on the Dynamics page, with the compressor). Threshold 0x09 (confirmed), Release 0x27
 * (Gate Release), and the gate's ratio stage maps to the Expander Ratio (0x1d — inferred). Master
 * Level is the main output level (0x00). Ranges: Threshold Bypass then ≈−90…−30 dB, Ratio 1–10:1,
 * Release 10–1000 ms. Read back from the preset via the PARAMS entries above (gateThreshold /
 * gateRatio / gateRelease, blobOffset = wireId + 0x22); the ratio wire id (0x1d) is inferred — if
 * the gate misbehaves, please open a protocol-observation issue.
 */
export const GATE_PARAMS = {
  threshold: 0x09,
  ratio: 0x1d, // inferred (Expander Ratio)
  release: 0x27,
} as const;

/**
 * 3-band parametric EQ (Low / Mid / High), each with Gain / Freq / Q — captured 2026-07-05 by
 * sweeping every band's deep page. Gain = the main-panel LOW/MID/HIGH knob (0x06/0x0C/0x07); Freq
 * and Q are deep params (the Q ids are consecutive 0x33/0x34/0x35). Display ranges + tapers are in
 * src/protocol/units.ts (EQ_BANDS): Low freq 40–200 Hz linear, Mid 200–2000 Hz log, High 1–8 kHz
 * linear; Q 0.5–2.0 on Low/Mid but 0.1–1.4 on High; gain ±12 dB on all three.
 */
// Gains are the main-panel LOW/MID/HIGH knobs (0x06/0x0c/0x07); mid freq is "Mid Shift" (0x0d).
export const PARAMETRIC_EQ = {
  low: { gain: 0x06, freq: 0x48, q: 0x30 },
  mid: { gain: 0x0c, freq: 0x0d, q: 0x2f },
  high: { gain: 0x07, freq: 0x49, q: 0x31 },
} as const;

/**
 * A few notes on the fuller parameter map (docs/PARAM-MAP.md):
 *
 * - 0x2f is "Mid Q" (mapped as `q` / eq.mid.q) — a real control.
 * - 0x13 is "Reverb Extension Factor" (2–5 semitones).
 * - 0x35–0x38 are the "User IR 7/8 Preset" addressing params for the writable IR slots.
 * - Deep reverb engine (0x10–0x18, 0x39–0x3b), Expander block (0x1e–0x20), Buzz/Punch/Crunch (+Qs),
 *   AnalogSim / Soft Clipping / Anti-aliasing / Clean Input, Tuner (0x34), Preset Level (0x40) are
 *   real params SansApp doesn't expose yet (roadmap). Full table + names in docs/PARAM-MAP.md.
 */

/**
 * The pedal's red "shift" footswitch — it flips the physical knobs between their primary and
 * alternate (Red Zone) functions. Reported as a pedal→app paramNotify ONLY (`05 51 0A 4D <1|0>`,
 * 1 = Red Zone layer engaged, 0 = primary). Confirmed 2026-07-07 by isolated presses (clean,
 * reproducible on/off toggling). It shares raw id 0x4d with High-EQ Freq, but High Freq is set-only
 * (app→pedal, no echo) and has no physical knob, so a NOTIFY of 0x4d is unambiguously the footswitch.
 */
export const KNOB_LAYER_NOTIFY_PARAM = 0x4d;

/**
 * Per-USER-IR makeup gain, sent live (`05 50`): `0x2a` = slot 7, `0x2b` = slot 8 (the two "User IR
 * Gain" params). Range 0–127 maps **linearly to ±{@link USER_IR_GAIN_DB_RANGE} dB**:
 * `dB = value/127·24 − 12` (so 0 → −12, 127 → +12, ~63.5 → 0). ±12 dB confirmed against the desktop
 * editor's readout (knob rails read 12.00 / −12.00 dB); the scale is linear (not logarithmic).
 */
export const USER_IR_GAIN: Record<number, number> = { 7: 0x2a, 8: 0x2b };
/**
 * Per-USER-IR "IR Mode" ENABLE toggle (the on/off switch next to each user slot in EliteControl):
 * `0x28` = slot 7, `0x29` = slot 8. **PER-PRESET** — stored in the preset blob at `paramId + 0x22`
 * (0x4a / 0x4b), CONFIRMED by the .p3b (slot-7 mode is ON in 91 of 128 presets, OFF in 37). OFF = the
 * preset uses its normal IR; ON = it uses the custom IR in that user slot. So the IR data is a global
 * library, but each preset opts in/out via this toggle — that's the per-preset behaviour.
 */
export const USER_IR_MODE: Record<number, number> = { 7: 0x28, 8: 0x29 };
export const USER_IR_GAIN_DB_RANGE = 12; // ± dB at the rails (0..127 linear) — CONFIRMED
/** dB (−12..+12) → the 0..127 wire value for {@link USER_IR_GAIN} (clamped). */
export const gainDbToValue = (db: number): number => {
  const clamped = Math.max(-USER_IR_GAIN_DB_RANGE, Math.min(USER_IR_GAIN_DB_RANGE, db));
  return Math.round(((clamped + USER_IR_GAIN_DB_RANGE) / (2 * USER_IR_GAIN_DB_RANGE)) * 127);
};
