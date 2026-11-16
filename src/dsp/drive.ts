/**
 * Drive stage → response curve. The Elite's drive stage is three real biquads, separate from the
 * tone stack (eq.ts): Buzz (an editor-only 200 Hz low shelf), the panel **Mid** (a swept peaking
 * bell, run twice — the desktop editor calls it "Punch") and the panel **Presence** (a 2500 Hz
 * peaking bell, run twice — the desktop editor's "Crunch"). Summing their magnitude responses is the
 * amp's "voice print". Every filter comes from the hardware-verified
 * model in eliteFilters.ts, so this is the same curve the pedal produces. Framework-free.
 *
 * Two things the curve makes visible that a centred-knob assumption gets wrong: Buzz's unity point is
 * up at value ~73 (a centred Buzz is about a 3 dB cut), and Presence cannot cut — value 0 is exactly
 * flat, and it only ever lifts. Preamp and Drive are deliberately absent: they set level and
 * saturation, not frequency, so they do not shape this response.
 */
import type { Biquad } from "./biquad";
import { cascadeResponseDb } from "./biquad";
import { ELITE_SAMPLE_RATE, eliteFilterBiquads } from "./eliteFilters";

/** Live drive-stage knob values, each raw 0..127. Freq/Q knobs default to the noon detent. */
export interface DriveKnobs {
  /** Buzz gain (0x02). Its 200 Hz shelf is fixed; there is no Buzz frequency knob. */
  buzz: number;
  /** Buzz width (Buzz Q, 0x2c). */
  buzzQ?: number;
  /** The panel Mid knob (0x03; the desktop editor's "Punch"). */
  mid: number;
  /** Mid's centre-frequency sweep — the panel's Red Zone FREQ knob (0x0b). */
  midFreq?: number;
  /** Mid width (Mid Q, 0x2d). */
  midQ?: number;
  /** The panel Presence knob (0x04; the desktop editor's "Crunch"), fixed at 2500 Hz. */
  presence: number;
  /** Presence width (Presence Q, 0x2e). */
  presenceQ?: number;
}

const NOON = 64;

/** The drive stage as the pedal's cascade: Buzz + Mid ×2 + Presence ×2. */
export function driveFilters(k: DriveKnobs): Biquad[] {
  return [
    ...eliteFilterBiquads("buzz", k.buzz, NOON, k.buzzQ ?? NOON),
    ...eliteFilterBiquads("punch", k.mid, k.midFreq ?? NOON, k.midQ ?? NOON),
    ...eliteFilterBiquads("crunch", k.presence, NOON, k.presenceQ ?? NOON),
  ];
}

/** Drive-stage magnitude response (dB) across `grid`, for the voice-print display. Evaluated at
 * the pedal's own 44.1 kHz — the model's trig quantisation is tied to that rate. */
export function driveResponse(k: DriveKnobs, grid: readonly number[]): number[] {
  return cascadeResponseDb(driveFilters(k), grid, ELITE_SAMPLE_RATE);
}
