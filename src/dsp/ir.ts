/**
 * Impulse-response → frequency-response for the IR graph. An IR is just a short impulse the pedal
 * convolves with your signal; its "graph" is the FFT magnitude of that impulse. Framework-free.
 */
import { magnitudeSpectrum } from "./fft";

const FFT_SIZE = 16384;

/** A log-spaced frequency grid (inclusive of both ends). */
export function logGrid(fMin: number, fMax: number, points: number): number[] {
  const lmin = Math.log(fMin);
  const lmax = Math.log(fMax);
  return Array.from({ length: points }, (_, i) =>
    Math.exp(lmin + ((lmax - lmin) * i) / (points - 1)),
  );
}

export interface ResponseOptions {
  sampleRate?: number;
  /** Fractional-octave smoothing width, e.g. 1/6. Larger = smoother. */
  octaveFraction?: number;
  /** Normalize so the median across this band reads 0 dB. Set null to skip. */
  normalizeBand?: readonly [number, number] | null;
  /**
   * Normalize so the curve's own PEAK reads 0 dB, and everything else reads as attenuation below it.
   * Takes precedence over {@link normalizeBand}.
   *
   * Use this when the curve has no guaranteed energy in any fixed reference band — a crafted filter,
   * as opposed to a speaker cab. Band-normalizing a low-pass whose corner sits below the band means
   * referencing its own stopband, which lifts the passband far above 0 dB.
   */
  normalizePeak?: boolean;
}

/**
 * Frequency response of an impulse response, in dB, sampled on `grid` and smoothed by a
 * fractional octave (cab-plot style). Defaults: 44.1 kHz, 1/6-octave, normalized to 200–4000 Hz.
 */
export function frequencyResponse(
  samples: ArrayLike<number>,
  grid: readonly number[],
  opts: ResponseOptions = {},
): number[] {
  const sampleRate = opts.sampleRate ?? 44100;
  const octaveFraction = opts.octaveFraction ?? 1 / 6;
  const normalizeBand = opts.normalizeBand === undefined ? [200, 4000] : opts.normalizeBand;

  const mag = magnitudeSpectrum(samples, FFT_SIZE);
  const half = mag.length;
  const db = new Float64Array(half);
  // Floor non-finite magnitudes (a degenerate IR can yield NaN/Inf) so db is always finite —
  // a NaN here would propagate to the SVG graph and crash RNSVG on iOS.
  for (let i = 0; i < half; i++) {
    const m = Number.isFinite(mag[i]!) ? mag[i]! : 0;
    db[i] = 20 * Math.log10(m + 1e-9);
  }

  const binHz = sampleRate / FFT_SIZE;
  const spread = 2 ** octaveFraction;
  const out = grid.map((fc) => {
    const i0 = Math.max(1, Math.floor(fc / spread / binHz));
    const i1 = Math.min(half - 1, Math.ceil((fc * spread) / binHz));
    if (i1 < i0) return db[Math.min(half - 1, Math.max(1, Math.round(fc / binHz)))]!;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += db[i]!;
    return sum / (i1 - i0 + 1);
  });

  if (opts.normalizePeak) {
    const peak = out.reduce((m, v) => (v > m ? v : m), -Infinity);
    return Number.isFinite(peak) ? out.map((v) => v - peak) : out;
  }
  if (normalizeBand) {
    const [lo, hi] = normalizeBand;
    // .filter() returns a fresh array, so sorting it in place is safe — and Array.prototype.sort
    // (unlike the ES2023 copy variant) exists in Hermes, RN's engine. See test/hermes-safety.test.ts.
    const band = out.filter((_, k) => grid[k]! >= lo && grid[k]! <= hi).sort((a, b) => a - b);
    const median = band.length ? band[band.length >> 1]! : 0;
    return out.map((v) => v - median);
  }
  return out;
}
