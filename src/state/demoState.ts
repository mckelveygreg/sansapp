/**
 * Synthetic "connected pedal" state for App Store screenshots and previewing the UI without
 * hardware. No real device is touched — this just seeds the stores with a plausible, good-looking
 * tone and a populated preset list.
 *
 * The data is entirely original/synthetic: the preset names are made up (NOT Tech 21 factory preset
 * names — the repo ships no manufacturer preset data), and the values are a hand-voiced "modern rock
 * bass" patch. Its voicing-character bytes match the VT Bass template so the Amp page fingerprints a
 * model, exactly as a real recalled preset would.
 *
 * Framework-free: no React / React Native / Expo imports (see AGENTS.md). Applied by
 * `loadDemoState()` in src/midi/pedal.ts.
 */
import type { ParamId } from "../protocol/params";

/** Active slot the demo poses as (0-based; shown as "Preset 4"). */
export const DEMO_SLOT = 3;
export const DEMO_NAME = "Studio Growl";

/** Raw 0–127 values for every parameter — a musical scooped-rock voicing (VT Bass character). */
export const DEMO_VALUES = {
  // Front panel
  level: 92,
  preamp: 72,
  drive: 45,
  presence: 80,
  comp: 55,
  ambiance: 34,
  // 3-band parametric EQ — boosted lows + air, gently scooped mids for a punchy modern tone.
  low: 84,
  lowFreq: 38,
  lowQ: 64,
  mid: 44,
  freq: 58,
  q: 70,
  high: 88,
  highFreq: 82,
  highQ: 60,
  // Amp voicing — buzz/punch/punchFreq/punchQ are the VT Bass character bytes (Amp page highlights it).
  buzz: 63,
  punch: 64,
  punchFreq: 65,
  punchQ: 64,
  // Blend (dry/wet) + IR cab
  blend: 104,
  irBlend: 32,
  // Compressor / gate
  ratio: 60,
  compOutput: 66,
  compAttack: 28,
  compRelease: 52,
  gateThreshold: 18,
  gateRatio: 50,
  gateRelease: 12,
  gateAttack: 14,
  autoGain: 1,
  lookahead: 0,
  softClip: 40,
  // Auto-filter (off by default)
  autoFilterOn: 0,
  filter: 40,
  filterAttack: 30,
  filterRelease: 42,
  // Ambience + chorus
  ambienceDecay: 60,
  ambienceTime: 90,
  chorus: 46,
  chorusModFreq: 40,
  chorusModDepth: 55,
  chorusDelaySize: 50,
  chorusFeedback: 30,
} satisfies Record<ParamId, number>;

/** Deep-store values that mirror the demo preset (the Dynamics/Ambience pages read these). */
export const DEMO_DYNAMICS = {
  gateThreshold: DEMO_VALUES.gateThreshold,
  gateRatio: DEMO_VALUES.gateRatio,
  gateRelease: DEMO_VALUES.gateRelease,
  compOutput: DEMO_VALUES.compOutput,
  compAttack: DEMO_VALUES.compAttack,
  compRelease: DEMO_VALUES.compRelease,
  autoGain: true,
  lookahead: false,
};

export const DEMO_AMBIENCE = {
  type: 1, // Hall
  decay: DEMO_VALUES.ambienceDecay,
  time: DEMO_VALUES.ambienceTime,
};

/** Slot→name map for a populated Presets list. All names are synthetic/original. */
export const DEMO_NAMES: Record<number, string> = {
  0: "Clean DI",
  1: "Fingerstyle Warmth",
  2: "Slap Attack",
  3: DEMO_NAME,
  4: "Vintage Flip",
  5: "Modern Punch",
  6: "Sub Bass",
  7: "Grindstone",
  8: "Motown Round",
  9: "Pick Bite",
  10: "Ambient Swell",
  11: "Reggae Dub",
  12: "Funk Envelope",
  13: "Stadium Rock",
  14: "Jazz Upright",
  15: "Synth Sustain",
};
