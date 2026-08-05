/**
 * Pedal tone-stack → response curve. Builds the SansAmp Elite's EQ exactly the way the pedal does —
 * every filter comes from the hardware-verified model in eliteFilters.ts — and evaluates the
 * cascade's magnitude response for the tone graphs. Framework-free.
 *
 * The shapes are not fixed: Low and High switch on the sign of the gain (a cut is a shelf, a boost
 * is a peaking bell), and High runs its section twice. Mid is a peaking bell on the asymmetric
 * 200–1977 Hz sweep. Presence is the pedal's Crunch filter: a peaking bell fixed at 2500 Hz,
 * cascaded ×2, and boost-only — value 0 is flat and it can never cut. With every knob at the 64
 * detent the whole cascade is exactly flat.
 */
import type { Biquad } from "./biquad";
import { cascadeResponseDb } from "./biquad";
import { ELITE_SAMPLE_RATE, eliteFilterBiquads } from "./eliteFilters";

/** Live EQ knob values, each raw 0..127 (64 = centre/flat). */
export interface EqKnobs {
  low: number;
  mid: number;
  high: number;
  /** Presence (0..127) — the Crunch bell. Optional: an overlay for the OVERALL tone chart; omit it
   * on the Parametric EQ page, which shows only the 3 adjustable bands. */
  presence?: number;
  /** Presence width (Crunch Q, 0..127); defaults to noon when omitted. */
  presenceQ?: number;
  /** Parametric mid centre-frequency knob (0..127). */
  freq: number;
  /** Parametric mid width knob (0..127). */
  q: number;
  /** Low/High band Freq + Q (0..127); default to noon when omitted. */
  lowFreq?: number;
  lowQ?: number;
  highFreq?: number;
  highQ?: number;
}

const NOON = 64;

export function eqFilters(eq: EqKnobs): Biquad[] {
  const filters = [
    ...eliteFilterBiquads("low", eq.low, eq.lowFreq ?? NOON, eq.lowQ ?? NOON),
    ...eliteFilterBiquads("mid", eq.mid, eq.freq, eq.q),
    ...eliteFilterBiquads("high", eq.high, eq.highFreq ?? NOON, eq.highQ ?? NOON),
  ];
  // Presence is a preamp voicing control, not one of the 3 EQ bands — only overlay it when the
  // caller asks for the overall tone (the editor chart). The Parametric EQ page omits it, so its
  // graph is flat when the bands are flat.
  if (eq.presence !== undefined) {
    filters.push(...eliteFilterBiquads("crunch", eq.presence, NOON, eq.presenceQ ?? NOON));
  }
  return filters;
}

/** Tone-stack magnitude response (dB) across `grid`, for the EQ curve display. Evaluated at the
 * pedal's own 44.1 kHz — the model's trig quantisation is tied to that rate. */
export function eqResponse(eq: EqKnobs, grid: readonly number[]): number[] {
  return cascadeResponseDb(eqFilters(eq), grid, ELITE_SAMPLE_RATE);
}
