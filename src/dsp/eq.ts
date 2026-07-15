/**
 * Pedal tone-stack → response curve. Builds the SansAmp Elite's EQ as a filter cascade and
 * evaluates its magnitude response for the tone graph. Framework-free.
 *
 * The Elite's Low/Mid/High are a 3-band semi-parametric EQ (each with its own Gain/Freq/Q — see the
 * deep filter pages). Modelled as the classic SansAmp active-EQ topology: Low shelf · parametric Mid
 * bell · High shelf, plus a fixed Presence high shelf; each band's Q sets its slope/width. Band
 * ranges and tapers are the hardware-measured values in src/protocol/units.ts (EQ_BANDS/eqGainDb),
 * calibrated 2026-07-05. Per-band Freq/Q default to noon (64) when the caller only has the gains.
 */
import { EQ_BANDS, eqGainDb } from "../protocol/units";
import type { Biquad } from "./biquad";
import { cascadeResponseDb, highShelf, lowShelf, peaking } from "./biquad";

/** Live EQ knob values, each raw 0..127 (64 ≈ centre/flat). */
export interface EqKnobs {
  low: number;
  mid: number;
  high: number;
  presence: number;
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

const PRESENCE_HZ = 6000;
const NOON = 64;

export function eqFilters(eq: EqKnobs, sampleRate = 44100): Biquad[] {
  return [
    lowShelf(
      EQ_BANDS.low.freq(eq.lowFreq ?? NOON),
      sampleRate,
      EQ_BANDS.low.q(eq.lowQ ?? NOON),
      eqGainDb(eq.low),
    ),
    peaking(EQ_BANDS.mid.freq(eq.freq), sampleRate, EQ_BANDS.mid.q(eq.q), eqGainDb(eq.mid)),
    highShelf(
      EQ_BANDS.high.freq(eq.highFreq ?? NOON),
      sampleRate,
      EQ_BANDS.high.q(eq.highQ ?? NOON),
      eqGainDb(eq.high),
    ),
    highShelf(PRESENCE_HZ, sampleRate, Math.SQRT1_2, eqGainDb(eq.presence)),
  ];
}

/** Tone-stack magnitude response (dB) across `grid`, for the EQ curve display. */
export function eqResponse(eq: EqKnobs, grid: readonly number[], sampleRate = 44100): number[] {
  return cascadeResponseDb(eqFilters(eq, sampleRate), grid, sampleRate);
}
