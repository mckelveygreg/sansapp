/**
 * Drive character → response curve. The Elite's drive voicing is three real biquads, separate from
 * the tone stack (eq.ts): Buzz (a 200 Hz low shelf), Punch (a swept peaking bell, run twice) and
 * Crunch (a 2500 Hz peaking bell, run twice — this is the front-panel Presence control). Summing
 * their magnitude responses is the amp's "voice print". Every filter comes from the hardware-verified
 * model in eliteFilters.ts, so this is the same curve the pedal produces. Framework-free.
 *
 * Two things the curve makes visible that a centred-knob assumption gets wrong: Buzz's unity point is
 * up at value ~73 (a centred Buzz is about a 3 dB cut), and Crunch cannot cut — value 0 is exactly
 * flat, and it only ever lifts. Pre-Amp and Drive are deliberately absent: they set level and
 * saturation, not frequency, so they do not shape this response.
 */
import type { Biquad } from "./biquad";
import { cascadeResponseDb } from "./biquad";
import { ELITE_SAMPLE_RATE, eliteFilterBiquads } from "./eliteFilters";

/** Live drive-character knob values, each raw 0..127. Freq/Q knobs default to the noon detent. */
export interface DriveKnobs {
  /** Buzz gain (0x02). Its 200 Hz shelf is fixed; there is no Buzz frequency knob. */
  buzz: number;
  /** Buzz width (Buzz Q, 0x2c). */
  buzzQ?: number;
  /** Punch gain (0x03). */
  punch: number;
  /** Punch centre-frequency sweep (0x0b). */
  punchFreq?: number;
  /** Punch width (Punch Q, 0x2d). */
  punchQ?: number;
  /** The front-panel Presence knob (0x04) — it is the pedal's Crunch filter, fixed at 2500 Hz. */
  presence: number;
  /** Crunch width (Crunch Q, 0x2e). */
  crunchQ?: number;
}

const NOON = 64;

/** The drive character as the pedal's cascade: Buzz + Punch ×2 + Crunch ×2. */
export function driveFilters(k: DriveKnobs): Biquad[] {
  return [
    ...eliteFilterBiquads("buzz", k.buzz, NOON, k.buzzQ ?? NOON),
    ...eliteFilterBiquads("punch", k.punch, k.punchFreq ?? NOON, k.punchQ ?? NOON),
    ...eliteFilterBiquads("crunch", k.presence, NOON, k.crunchQ ?? NOON),
  ];
}

/** Drive-character magnitude response (dB) across `grid`, for the voice-print display. Evaluated at
 * the pedal's own 44.1 kHz — the model's trig quantisation is tied to that rate. */
export function driveResponse(k: DriveKnobs, grid: readonly number[]): number[] {
  return cascadeResponseDb(driveFilters(k), grid, ELITE_SAMPLE_RATE);
}
