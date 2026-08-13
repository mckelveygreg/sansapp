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
   * Distinct from `blobOffset` (the two addressing schemes differ). All confirmed.
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
  freq: knob("freq", "Mid Freq", "redzone", 0x2f, 0x0d, true),
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // Deep-param controls. Each wire id is the pedal's own parameter index (the same index the
  // desktop editor uses), confirmed against hardware; the ids satisfy blobOffset − wireId = 0x22,
  // the same rule as the main panel. Blob offsets are the read-back positions. See docs/PARAM-MAP.md.
  q: knob("q", "Mid Q", "redzone", 0x51, 0x2f, true), // mid Q
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
  // Chorus master enable (PROTOCOL-MAP §3: idx 0x41, blob 0x63, live-set id 0x45). Store-backed so
  // the toggle reflects the loaded preset — if a preset has chorus OFF, none of the chorus knobs are
  // audible, which reads as "the chorus controls don't do anything" (issue #40).
  chorusOn: knob("chorusOn", "Chorus On", "ambience", 0x63, 0x41, true),
  // Deep params read back from presets. blobOffset = wireId + 0x22 — confirmed 2026-07-15 two ways:
  // EliteControl's 05 41 decode loop applies body[0x22+k] to param k for k=0x00..0x49, and a
  // 128-preset oracle places every known toggle at its predicted +0x22 offset. gateRatio's wire id
  // (0x1d, Expander Ratio) is inferred; its offset follows the same rule regardless.
  gateThreshold: knob("gateThreshold", "Gate Threshold", "dynamics", 0x2b, 0x09, true),
  gateRatio: knob("gateRatio", "Gate Ratio", "dynamics", 0x3f, 0x1d, true),
  gateRelease: knob("gateRelease", "Gate Release", "dynamics", 0x49, 0x27, true),
  compOutput: knob("compOutput", "Comp Output", "dynamics", 0x3c, 0x1a, true),
  compAttack: knob("compAttack", "Comp Attack", "dynamics", 0x3d, 0x1b, true),
  compRelease: knob("compRelease", "Comp Release", "dynamics", 0x3e, 0x1c, true),
  autoGain: knob("autoGain", "Auto Gain", "dynamics", 0x54, 0x32, true),
  lookahead: knob("lookahead", "Look-ahead", "dynamics", 0x55, 0x33, true),
  // Ambience Decay/Time wire ids, derived from observing EliteControl (issue #38): its ShowAmbience
  // page builds the DECAY knob on param index 0x11 (Reverb Decay Time) and the TIME knob on index
  // 0x10 (Reverb Room Size) — the same knob constructor whose LEVEL knob uses index 0x08, which pins
  // the reading. Room Size (0x10) drives the whole echo time; the nearby Fbk Delay Size (0x14) only
  // moves the later echoes, so it isn't the Time control. blobOffset = index + 0x22.
  ambienceDecay: knob("ambienceDecay", "Ambience Decay", "ambience", 0x33, 0x11, true),
  ambienceTime: knob("ambienceTime", "Ambience Time", "ambience", 0x32, 0x10, true),
  // Amp-voicing params — the "hidden" bytes an amp-model bundle sets besides Pre-Amp/Drive/Presence.
  // Exposed so the amp models become re-voiceable starting points. Ranges uncalibrated (shown raw %).
  buzz: knob("buzz", "Buzz", "preamp", 0x24, 0x02, true),
  punch: knob("punch", "Punch", "preamp", 0x25, 0x03, true),
  punchFreq: knob("punchFreq", "Punch Freq", "preamp", 0x2d, 0x0b, true),
  punchQ: knob("punchQ", "Punch Q", "preamp", 0x4f, 0x2d, true),
  // Buzz Q / Crunch Q — the remaining drive-character Qs (PROTOCOL-MAP §3, idx 0x2c/0x2e). An amp
  // model apply live-sets them to constants (Buzz Q = 64, Crunch Q = 0, §5); modeled so a SAVE after
  // an apply records those bytes instead of silently keeping the base preset's old Qs.
  buzzQ: knob("buzzQ", "Buzz Q", "preamp", 0x4e, 0x2c, true),
  crunchQ: knob("crunchQ", "Crunch Q", "preamp", 0x50, 0x2e, true),
  // IR select/morph — the continuous 0x0E value the IR page's mic rides (0 = Off/flat, ~16·n = cab
  // n, values between blend neighbours). Store-backed so the IR stack reflects the LOADED preset's
  // cab instead of a guess. blobOffset 0x30 = wire 0x0e + 0x22; confirmed against the 128-preset bank.
  irBlend: knob("irBlend", "IR", "ir", 0x30, 0x0e, true),
  // Per-USER-IR "IR Mode" ENABLE toggle + makeup gain (PROTOCOL-MAP §3, idx 0x28–0x2b). PER-PRESET:
  // stored in the blob at paramId + 0x22 (mode 0x4a/0x4b, gain 0x4c/0x4d), CONFIRMED by the .p3b
  // (slot-7 mode ON in 91 of 128 factory presets). Mode 0 = the factory cab, 1 = the uploaded user IR;
  // gain 0..127 ↔ ±12 dB linear (see gainDbToValue). Store-backed so the IR page reflects the LOADED
  // preset and a SAVE persists a toggle/gain edit instead of silently reverting it. Toggles follow the
  // chorusOn/autoFilterOn convention (modeled as continuous knobs, value 0/1).
  irMode7: knob("irMode7", "IR Mode 7", "ir", 0x4a, 0x28, true),
  irMode8: knob("irMode8", "IR Mode 8", "ir", 0x4b, 0x29, true),
  irGain7: knob("irGain7", "User IR Gain 7", "ir", 0x4c, 0x2a, true),
  irGain8: knob("irGain8", "User IR Gain 8", "ir", 0x4d, 0x2b, true),
  // Preset Level (PROTOCOL-MAP §3, idx 0x40) — a per-preset OUTPUT level an amp-model apply live-sets
  // (e.g. British = 14 vs Bass Driver = 127). Modeled so applying a model then SAVING records the new
  // level instead of the old byte — otherwise recall jumps in volume. Default 32; not yet a UI knob.
  presetLevel: knob("presetLevel", "Preset Level", "level", 0x62, 0x40, true),
  // Auto Filter extras (2026-07-15): a master enable toggle (0x3c, defaults OFF) plus Attack/
  // Release (0x3e/0x3f) — store-backed so they read back from the preset (Level is `filter` 0x3d).
  // The auto-filter has NO cutoff/resonance param; these are all it exposes over the wire.
  autoFilterOn: knob("autoFilterOn", "Auto Filter", "redzone", 0x5e, 0x3c, true),
  filterAttack: knob("filterAttack", "Filter Attack", "redzone", 0x60, 0x3e, true),
  filterRelease: knob("filterRelease", "Filter Release", "redzone", 0x61, 0x3f, true),
  // Dynamics extras (2026-07-15): output soft-clip (0x21) + the gate's own attack (0x26, completes
  // gate timing alongside gateRelease 0x27). Ranges uncalibrated on the pedal — shown as raw %.
  // Soft Clip also has a tone side: when on, the pedal smooths the clip's fizz with a level-gated
  // −24 dB / 8 kHz high shelf (dsp/tone.ts softClipShelfDb — drawn in the Tone Shaper).
  softClip: knob("softClip", "Soft Clip", "dynamics", 0x43, 0x21, true),
  gateAttack: knob("gateAttack", "Gate Attack", "dynamics", 0x48, 0x26, true),
} as const satisfies Record<string, ParamDef>;

export type ParamId = keyof typeof PARAMS;

export const PARAM_IDS = Object.keys(PARAMS) as ParamId[];

/**
 * Map a parameter's iPlug INDEX (== its `05 51` notify id, what we store as `paramId`) to the wire
 * id the pedal expects in a live `05 50` SET message. Indices 0x00–0x0F set on the same id (identity
 * — the shallow main-panel knobs); 0x10–0x49 set on **index + 4**. So Blend (index 0x47) is set via
 * 0x4B, not 0x47 (0x47 is only its notify id; setting 0x47 actually hits chorus-mod — the "blend
 * moved the chorus" bug). The notify/read path stays on the index; only the write path uses this.
 *
 * Indices **0x4A–0x4D wrap around to set-ids 0x10–0x13**, they do NOT continue the +4 run. Those four
 * were long assumed to be a gap, and the ids 0x10–0x13 to be "reserved commands" outside the
 * parameter space — the pedal's own firmware says otherwise. It carries a 78-entry set-id → index
 * table that is an exact bijection, and its last stanza maps 0x10–0x13 onto 0x4A–0x4D. The other 74
 * entries match the rule above exactly. That reconciles the save command: `05 50 <ver> 12 <slot>` is
 * not a special opcode, it is a plain set of index 0x4C, whose firmware handler persists to a slot.
 * (Derivation: sansApp_lab/docs/FIRMWARE-RE.md.)
 */
export const liveSetId = (index: number): number => {
  if (index >= 0x4a && index <= 0x4d) return index - 0x3a; // 0x4A..0x4D -> 0x10..0x13
  return index >= 0x10 && index <= 0x49 ? index + 4 : index;
};

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
  on: 0x41,
  level: 0x42,
  modFreq: 0x43,
  modDepth: 0x44,
  delaySize: 0x45,
  feedback: 0x46,
} as const;

/**
 * Deep Ambience-page paramIds (iPlug indices; sendParam maps them to the live-set wire via liveSetId).
 * The **AMBIANCE knob (0x08) is Level**; Decay = **0x11 (Reverb Decay Time)**; Time = **0x10 (Reverb
 * Room Size)**, Echo / Echo Verb only — derived from observing EliteControl's ShowAmbience page
 * (issue #38). Selecting an ambience *type* also rewrites a small block of blob offsets; those aren't
 * all individually labelled yet.
 */
export const AMBIENCE_PARAMS = {
  level: 0x08,
  decay: 0x11,
  time: 0x10,
} as const;

/**
 * Gate / expander (on the Dynamics page, with the compressor). Threshold 0x09 (confirmed), Release
 * 0x27 (Gate Release), and the gate's ratio stage maps to the Expander Ratio (0x1d — inferred).
 * Ranges: Threshold Bypass then ≈−90…−30 dB, Ratio 1–10:1, Release 10–1000 ms. Read back from the
 * preset via the PARAMS entries above (gateThreshold / gateRatio / gateRelease, blobOffset = wireId +
 * 0x22); the ratio wire id (0x1d) is inferred — if the gate misbehaves, please open a
 * protocol-observation issue.
 */
export const GATE_PARAMS = {
  threshold: 0x09,
  ratio: 0x1d, // inferred (Expander Ratio)
  release: 0x27,
} as const;

/**
 * 3-band parametric EQ (Low / Mid / High), each with Gain / Freq / Q — captured 2026-07-05 by
 * sweeping every band's deep page. Gain = the main-panel LOW/MID/HIGH knob (0x06/0x0C/0x07); Freq
 * and Q are deep params (the Q ids are consecutive 0x33/0x34/0x35). Display ranges + tapers come
 * from the pedal's own filter model, src/dsp/eliteFilters.ts (x = value/128): gain 24x − 12 dB on
 * all three; Low freq 40–199 Hz linear, Mid a bipolar 200–1977 Hz sweep centred at exactly 500 Hz,
 * High 1000–7945 Hz linear; Q exponential 0.5–2 (Low) / 0.25–3.9 (Mid), High's Q switching taper
 * (and the band its shape) on the sign of the gain — boosts are peaking bells, cuts shelves.
 */
export const PARAMETRIC_EQ = {
  low: { gain: 0x06, freq: 0x48, q: 0x30 },
  mid: { gain: 0x0c, freq: 0x0d, q: 0x2f },
  high: { gain: 0x07, freq: 0x49, q: 0x31 },
} as const;

/**
 * A few notes on the fuller parameter map (docs/PARAM-MAP.md):
 *
 * - 0x2f is "Mid Q" (mapped as `q` / eq.mid.q) — a real control.
 * - 0x13 is "Reverb Extension Factor" (2–5).
 * - 0x35–0x38 are the "User IR 7/8 Preset" addressing params for the writable IR slots.
 * - The deep reverb-engine params beyond Level/Decay/Time (0x12–0x18, 0x39–0x3b), the Expander block
 *   (0x1e–0x20), and AnalogSim / Anti-aliasing / Clean Input are real params SansApp doesn't expose
 *   yet (roadmap). Full table + names in docs/PARAM-MAP.md.
 */

/**
 * The Tuner param (index 0x34, live-set id 0x38 via {@link liveSetId}) — the pedal's tuner/mute
 * switch, which the app can drive: 0 = Off, 1 = Mute (silent, tuner on), 2 = Bypass (dry signal, amp
 * / drive / cab out of circuit, tuner still on). Both non-zero modes show the played note on the
 * PEDAL's own display (`-` when it hears nothing); the pitch is never transmitted, so the app can't
 * show it.
 *
 * Deliberately NOT a {@link PARAMS} entry, even though the preset blob carries it at 0x56:
 *
 * - It is transient performance state, not part of a saved sound. Registering it would put it in the
 *   modeled-params set, and every save-from-state would then write blob[0x56] — baking "muted" into
 *   the user's presets. Unmodeled bytes are copied from the base blob instead (see store.ts), which
 *   is exactly what's wanted.
 * - There is no read-back: a preset dump comes from flash, so blob[0x56] is the STORED byte, never
 *   the pedal's live tuner state, and the pedal emits no tuner notify. So it has no place in
 *   `values`, whose whole contract is "what the pedal is doing right now".
 *
 * See `DeviceSession.setTunerMode` for the write path (the write alone does nothing — it needs a
 * nudge) and docs/PROTOCOL.md.
 */
export const TUNER_PARAM = 0x34;

/**
 * Where a preset stores its own tuner byte (`TUNER_PARAM + 0x22`, the usual rule).
 *
 * It matters more than a transient param's stored copy should, because the pedal treats it as live
 * state twice over — both confirmed on hardware 2026-08-12:
 *
 * - **A recall reloads the live tuner from it**, so a preset holding a non-zero byte ENGAGES the tuner
 *   when you select it: the preset mutes your rig.
 * - **Staging a preset (`05 20`) refreshes the live param array from it**, and the save handler then
 *   reads that array to decide whether to force Level to 0. So a blob carrying a non-zero tuner byte
 *   makes the pedal silence the very save that persists it — the corruption propagates itself.
 *
 * Hence {@link DeviceSession.writePreset} forces this byte to 0 on every save. That is the whole
 * defence against the silent-save hazard, and it is a prevention rather than a detection.
 */
export const TUNER_BLOB_OFFSET = TUNER_PARAM + 0x22;

/** Tuner param values: Off / Mute / Bypass. See {@link TUNER_PARAM}. */
export type TunerMode = 0 | 1 | 2;

/** Coerce a stored/wire byte to a tuner mode; anything out of range reads as Off. */
export const asTunerMode = (v: number | undefined): TunerMode => (v === 1 || v === 2 ? v : 0);

/**
 * The pedal's red "shift" footswitch — it flips the physical knobs between their primary and
 * alternate (Red Zone) functions. Reported as a pedal→app paramNotify ONLY (`05 51 0A 4D <1|0>`,
 * 1 = Red Zone layer engaged, 0 = primary). Confirmed 2026-07-07 by isolated presses (clean,
 * reproducible on/off toggling). It shares raw id 0x4d with High-EQ Freq, but High Freq is set-only
 * (app→pedal, no echo) and has no physical knob, so a NOTIFY of 0x4d is unambiguously the footswitch.
 */
export const KNOB_LAYER_NOTIFY_PARAM = 0x4d;

/**
 * Firmware 1.1 made the red footswitch an effects toggle, not just a knob-layer shift: engaging it
 * turns the Red Zone effects ON and disengaging turns them OFF, by force-setting exactly these two
 * params — Auto Filter enable (0x3c) and Chorus enable (0x41) — to 1/0 on the pedal. (The audible
 * reverb/ambience drop rides the same toggle inside the DSP; there is no separate reverb-enable
 * param.) The pedal does NOT notify 0x3c/0x41 individually — the ONLY wire traffic is the 0x4d
 * notify above — so on firmware ≥ 1.1 the app mirrors both flags itself when it sees one, or its
 * toggles go stale.
 *
 * The version gate is the firmware's own: the footswitch handler takes an argument and skips both
 * force-sets when it is 0. Firmware 1.1's dispatcher passes 1, which is what turned the switch into
 * an effects toggle; 1.0 did not touch these params, so mirroring on a 1.0 pedal would corrupt state.
 *
 * ⚠️ **The mirror is PROVISIONAL in both directions — a long-hold silently undoes what it announced.**
 * The red switch's handler has two arms and they perform the *same* Red-Zone toggle (same state byte,
 * same two force-sets):
 *
 * - the **press** arm toggles, force-sets both flags, and notifies `05 51 0B 4D <new>`;
 * - the **hold** arm, reached when the hold deadline passes and the tuner is not already engaged,
 *   performs that identical toggle **again** and then engages the tuner — emitting nothing at all.
 *
 * So a long-hold (the footswitch tuner-engage) toggles the Red Zone TWICE, once announced and once
 * silently, and the two cancel: the pedal ends where it started while the app keeps the announced
 * half. It is symmetric — a hold begun with the Red Zone already engaged notifies `4d=0` and then
 * silently turns both flags back ON — so the ordinary `4d=0` on a short press is NOT evidence that
 * the off direction can be trusted.
 *
 * Nothing can be listened for (the hold arm and the tuner's mode cycling are wire-silent) and nothing
 * can be read back (the only command returning parameter state is the preset dump, and the pedal
 * sources that from flash — see {@link TUNER_BLOB_OFFSET}). The repair is a preset change: it reloads
 * the pedal's live array from the blob, and it pushes that blob unsolicited, so `onPushedPreset` →
 * `loadPreset` re-sources both flags from the pedal's own bytes. See the 0x4d handler in state/store.ts
 * for what that leaves exposed.
 */
export const RED_ZONE_TOGGLE_PARAMS: readonly ParamId[] = ["autoFilterOn", "chorusOn"];

/** First firmware version whose red footswitch force-sets {@link RED_ZONE_TOGGLE_PARAMS}. */
export const RED_ZONE_TOGGLE_MIN_FIRMWARE = 1.1;

/**
 * Per-USER-IR makeup gain scaling. The gain params themselves are the store-backed `irGain7`/`irGain8`
 * registry entries above (slot 7 = idx 0x2a, slot 8 = idx 0x2b); this is the wire↔dB conversion the IR
 * page uses. Range 0–127 maps **linearly to ±{@link USER_IR_GAIN_DB_RANGE} dB**: `dB = value/127·24 −
 * 12` (so 0 → −12, 127 → +12, ~63.5 → 0). ±12 dB confirmed against the desktop editor's readout (knob
 * rails read 12.00 / −12.00 dB); the scale is linear (not logarithmic).
 */
export const USER_IR_GAIN_DB_RANGE = 12; // ± dB at the rails (0..127 linear) — CONFIRMED
/** dB (−12..+12) → the 0..127 wire value (clamped). */
export const gainDbToValue = (db: number): number => {
  const clamped = Math.max(-USER_IR_GAIN_DB_RANGE, Math.min(USER_IR_GAIN_DB_RANGE, db));
  return Math.round(((clamped + USER_IR_GAIN_DB_RANGE) / (2 * USER_IR_GAIN_DB_RANGE)) * 127);
};
/** The 0..127 wire value → dB (−12..+12) — inverse of {@link gainDbToValue}. */
export const valueToGainDb = (value: number): number =>
  (value / 127) * (2 * USER_IR_GAIN_DB_RANGE) - USER_IR_GAIN_DB_RANGE;
