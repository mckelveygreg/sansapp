/**
 * High-pass-as-IR. A cabinet sim is a convolution, so a high-pass filter can be *baked into*
 * a custom IR: design a Butterworth high-pass, convolve its impulse with a cab IR, and keep
 * the first ~1000 taps. The result is one IR that voices the cab AND rolls off the lows.
 * Framework-free.
 *
 * Caveat: 1000 taps @ 44.1 kHz ≈ 23 ms, so usable resolution bottoms out near ~45 Hz —
 * cutoffs of 50–120 Hz are clean; an ultra-steep sub-40 Hz brick wall is not representable.
 */

const DEFAULT_TAPS = 1000;

/** RBJ biquad high-pass impulse response; `stages` cascaded 2nd-order sections (12 dB/oct each). */
export function highpassImpulse(
  fc: number,
  sampleRate = 44100,
  q = Math.SQRT1_2,
  stages = 2,
  length = DEFAULT_TAPS,
): Float64Array {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0;
  const b1 = -(1 + cw) / a0;
  const b2 = (1 + cw) / 2 / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;

  let sig = new Float64Array(length);
  sig[0] = 1;
  for (let s = 0; s < stages; s++) {
    const y = new Float64Array(length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let n = 0; n < length; n++) {
      const xn = sig[n]!;
      const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xn;
      y2 = y1;
      y1 = yn;
      y[n] = yn;
    }
    sig = y;
  }
  return sig;
}

/** Linear convolution of `a` and `b`, truncated to `maxLen` taps. */
export function convolve(a: ArrayLike<number>, b: ArrayLike<number>, maxLen: number): Float64Array {
  const out = new Float64Array(Math.min(maxLen, a.length + b.length - 1));
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    if (av === 0) continue;
    for (let j = 0; j < b.length && i + j < out.length; j++) out[i + j]! += av * b[j]!;
  }
  return out;
}

export interface HighpassIrOptions {
  sampleRate?: number;
  /** Filter resonance (0.707 = Butterworth). */
  q?: number;
  /** Cascaded 2nd-order sections; 2 ⇒ 24 dB/oct. */
  stages?: number;
  /** IR design length in taps (zero-padded to the pedal's full IR size on upload). */
  taps?: number;
}

/**
 * Bake a high-pass at `fc` into `cab` (or, if `cab` is null, return the high-pass impulse alone —
 * a near-flat IR that only rolls off the lows, for stacking on top of another cab).
 */
export function makeHighpassIr(
  cab: ArrayLike<number> | null,
  fc: number,
  opts: HighpassIrOptions = {},
): Float64Array {
  const taps = opts.taps ?? DEFAULT_TAPS;
  const hp = highpassImpulse(fc, opts.sampleRate, opts.q, opts.stages ?? 2, taps);
  return cab ? convolve(cab, hp, taps) : hp;
}
