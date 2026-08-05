/**
 * The Elite's own tone/drive filter model. Maps the wire values (0..127) of the six character/EQ
 * controls — Buzz, Punch, Crunch, Low, Mid, High — to the exact biquads the pedal designs, so the
 * app can draw the same curve the hardware produces. Golden-tested against a hardware-verified
 * fixture (test/fixtures/eliteFilters.golden.json). Framework-free.
 *
 * The value scale is x = value/128 (NOT /127): x is exactly 0.5 at value 64, which is what puts
 * 0.00 dB and the 500 Hz Punch/Mid centre exactly on the detent. x' = 2x − 1 is the bipolar form.
 *
 * Two deliberate departures from the plain RBJ cookbook, both observed on the pedal:
 *  - the shelf slope term is √(2A)·alpha, not the cookbook's 2·√A·alpha (√2 narrower);
 *  - at or above 200 Hz, sin/cos come from a 32768-step quarter-wave table, quantising the corner
 *    frequency to 44100/32768 ≈ 1.346 Hz steps. Only Low (40..199 Hz) gets the exact path.
 */
import { sweepFreqHz } from "../protocol/units";
import type { Biquad } from "./biquad";
import { highShelfFromTerms, lowShelfFromTerms, peakingFromTerms } from "./biquad";

/** The pedal's DSP runs at 44.1 kHz; pass this to cascadeResponseDb when plotting these filters. */
export const ELITE_SAMPLE_RATE = 44100;

export type EliteFilterControl = "buzz" | "punch" | "crunch" | "low" | "mid" | "high";
export type EliteFilterShape = "lowShelf" | "highShelf" | "peaking";

export interface EliteFilterDesign {
  shape: EliteFilterShape;
  /** dB the designer receives, per-band trim included — this is what sets A = 10^(dB/40). */
  gainDb: number;
  freqHz: number;
  /** Q the designer receives, per-band trim included — this is what sets alpha = sin(w)/(2Q). */
  q: number;
  /** 2 = the pedal runs the same biquad twice (12 dB/oct skirts, magnitude response squared). */
  cascade: 1 | 2;
}

const norm = (value: number): number => value / 128;
const bipolar = (value: number): number => 2 * norm(value) - 1;

/** One control's designer arguments from its three wire values (0..127 each; Buzz and Crunch
 * have no frequency knob and ignore `freqValue`). */
export function designEliteFilter(
  control: EliteFilterControl,
  gainValue: number,
  freqValue: number,
  qValue: number,
): EliteFilterDesign {
  switch (control) {
    case "buzz":
      // Asymmetric on purpose: a centred Buzz is a ~3 dB cut, unity is up at value ~73.
      return {
        shape: "lowShelf",
        gainDb: 42 * norm(gainValue) - 24,
        freqHz: 200,
        q: 0.5 * 2 ** (1.5 * bipolar(qValue)),
        cascade: 1,
      };
    case "punch": {
      const gainDb = 24 * norm(gainValue) - 12;
      const xq = bipolar(Math.max(qValue, 16)); // the pedal floors Punch's Q byte at 16
      return {
        shape: "peaking",
        gainDb,
        freqHz: sweepFreqHz(freqValue),
        q: 2 ** ((gainDb >= 0 ? 2 : 4) * xq),
        cascade: 2,
      };
    }
    case "crunch":
      // 12x with no −12 offset: boost-only, exactly flat at value 0 — a presence lift, never a cut.
      return {
        shape: "peaking",
        gainDb: 12 * norm(gainValue),
        freqHz: 2500,
        q: 2 ** (2 * bipolar(qValue)),
        cascade: 2,
      };
    case "low": {
      // Asymmetric voicing: a cut tilts the whole band away (shelf), a boost is a focused bell.
      const gainDb = 24 * norm(gainValue) - 12;
      const freqHz = 40 + 160 * norm(freqValue);
      const baseQ = 2 ** bipolar(qValue);
      return gainDb < 0
        ? { shape: "lowShelf", gainDb, freqHz, q: 0.99 * baseQ, cascade: 1 }
        : { shape: "peaking", gainDb, freqHz, q: baseQ, cascade: 1 };
    }
    case "mid":
      return {
        shape: "peaking",
        gainDb: 24 * norm(gainValue) - 12,
        freqHz: sweepFreqHz(freqValue),
        q: 2 ** (2 * bipolar(qValue)),
        cascade: 1,
      };
    case "high": {
      const gainDb = 24 * norm(gainValue) - 12;
      const freqHz = 1000 + 7000 * norm(freqValue);
      // The ×3 exponent on the cut side is gated on the raw gain byte, not the computed dB.
      const baseQ = 2 ** ((gainValue < 64 ? 3 : 1) * (1.95 * norm(qValue) - 1));
      return gainDb >= 0
        ? { shape: "peaking", gainDb: 0.75 * gainDb, freqHz, q: 0.6 * baseQ, cascade: 2 }
        : { shape: "highShelf", gainDb, freqHz, q: 0.7 * baseQ, cascade: 2 };
    }
  }
}

const clampQ15 = (v: number): number => Math.max(-32768, Math.min(32767, v));
const asInt16 = (v: number): number => ((v & 0xffff) << 16) >> 16;

/** Quarter-wave sine kernel: y/32768 spans [0, π/2), result in Q15. */
const q15QuarterSin = (y: number): number =>
  clampQ15(Math.round(32768 * Math.sin(((Math.PI / 2) * y) / 32768)));

const q15QuarterCos = (y: number): number =>
  clampQ15(Math.round(32768 * Math.cos(((Math.PI / 2) * y) / 32768)));

/** sin(2π·idx/32768) in Q15 by quadrant reduction over the quarter-wave kernel. */
function q15Sin(idx: number): number {
  if (idx < 0x2000) return q15QuarterSin(asInt16(idx * 4));
  if (idx === 0x2000) return 0x7fff; // sin(π/2) = 1.0; idx*4 would wrap int16
  if (idx < 0x6000) return -q15QuarterSin(asInt16(idx * 4));
  return q15QuarterSin(asInt16(idx * 4));
}

function q15Cos(idx: number): number {
  if (idx < 0x2000) return q15QuarterCos(asInt16(idx * 4));
  if (idx < 0x6000) return -q15QuarterCos(asInt16(idx * 4));
  return q15QuarterCos(asInt16(idx * 4));
}

/** The designer's two trig paths, split at 200 Hz: exact below (Low is the only taker), the
 * Q15 table — with its 1.346 Hz frequency quantisation — at or above. */
function designerSinCos(freqHz: number): [s: number, c: number] {
  if (freqHz < 200) {
    const w = (2 * Math.PI * freqHz) / ELITE_SAMPLE_RATE;
    return [Math.sin(w), Math.cos(w)];
  }
  const idx = Math.trunc((freqHz * 32768) / ELITE_SAMPLE_RATE);
  return [q15Sin(idx) / 32768, q15Cos(idx) / 32768];
}

/** One second-order section, designed exactly the pedal's way. Apply it `cascade` times. */
export function eliteFilterBiquad({ shape, gainDb, freqHz, q }: EliteFilterDesign): Biquad {
  const [s, c] = designerSinCos(freqHz);
  const alpha = (0.5 / q) * s;
  const A = 10 ** (gainDb / 40);
  if (shape === "peaking") return peakingFromTerms(A, c, alpha);
  const beta = Math.SQRT2 * Math.sqrt(A) * alpha; // the Elite's shelf slope term: √(2A)·alpha
  return shape === "lowShelf" ? lowShelfFromTerms(A, c, beta) : highShelfFromTerms(A, c, beta);
}

/** A control's complete filter as a cascade (`cascade` copies of the same section), ready for
 * cascadeResponseDb / impulseResponse. */
export function eliteFilterBiquads(
  control: EliteFilterControl,
  gainValue: number,
  freqValue: number,
  qValue: number,
): Biquad[] {
  const design = designEliteFilter(control, gainValue, freqValue, qValue);
  const bq = eliteFilterBiquad(design);
  return design.cascade === 2 ? [bq, bq] : [bq];
}
