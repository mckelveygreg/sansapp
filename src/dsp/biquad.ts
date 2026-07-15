/**
 * RBJ biquad coefficients + analytic magnitude response. Used to draw the pedal's tone
 * (EQ) curve directly from parameter values — no FFT needed for parametric filters, the
 * transfer function is evaluated in closed form. Framework-free.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Shared RBJ intermediates: linear gain √, cos(w0), and alpha. */
function terms(fc: number, sampleRate: number, q: number, gainDb: number) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  return { A, cw: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) };
}

export function peaking(fc: number, sampleRate: number, q: number, gainDb: number): Biquad {
  const { A, cw, alpha } = terms(fc, sampleRate, q, gainDb);
  return norm(1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A);
}

export function lowShelf(fc: number, sampleRate: number, q: number, gainDb: number): Biquad {
  const { A, cw, alpha } = terms(fc, sampleRate, q, gainDb);
  const tsa = 2 * Math.sqrt(A) * alpha;
  return norm(
    A * (A + 1 - (A - 1) * cw + tsa),
    2 * A * (A - 1 - (A + 1) * cw),
    A * (A + 1 - (A - 1) * cw - tsa),
    A + 1 + (A - 1) * cw + tsa,
    -2 * (A - 1 + (A + 1) * cw),
    A + 1 + (A - 1) * cw - tsa,
  );
}

export function highShelf(fc: number, sampleRate: number, q: number, gainDb: number): Biquad {
  const { A, cw, alpha } = terms(fc, sampleRate, q, gainDb);
  const tsa = 2 * Math.sqrt(A) * alpha;
  return norm(
    A * (A + 1 + (A - 1) * cw + tsa),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - tsa),
    A + 1 - (A - 1) * cw + tsa,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - tsa,
  );
}

export function lowpass(fc: number, sampleRate: number, q: number): Biquad {
  const { cw, alpha } = terms(fc, sampleRate, q, 0);
  return norm((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
}

export function highpass(fc: number, sampleRate: number, q: number): Biquad {
  const { cw, alpha } = terms(fc, sampleRate, q, 0);
  return norm((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
}

export function notch(fc: number, sampleRate: number, q: number): Biquad {
  const { cw, alpha } = terms(fc, sampleRate, q, 0);
  return norm(1, -2 * cw, 1, 1 + alpha, -2 * cw, 1 - alpha);
}

function runBiquad(bq: Biquad, x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const xn = x[n]!;
    const yn = bq.b0 * xn + bq.b1 * x1 + bq.b2 * x2 - bq.a1 * y1 - bq.a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    y[n] = yn;
  }
  return y;
}

/** Time-domain impulse response of a biquad cascade (a delta run through each), `length` taps. */
export function impulseResponse(filters: readonly Biquad[], length: number): Float64Array {
  let sig: Float64Array = new Float64Array(length);
  sig[0] = 1;
  for (const bq of filters) sig = runBiquad(bq, sig);
  return sig;
}

/** Magnitude (dB) of one biquad at frequency `f`. */
export function magnitudeDb(bq: Biquad, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  // e^{-jw} = cw - j·sw ; e^{-2jw} = cos2w - j·sin2w
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const numRe = bq.b0 + bq.b1 * cw + bq.b2 * c2;
  const numIm = -(bq.b1 * sw + bq.b2 * s2);
  const denRe = 1 + bq.a1 * cw + bq.a2 * c2;
  const denIm = -(bq.a1 * sw + bq.a2 * s2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return 20 * Math.log10((num + 1e-12) / (den + 1e-12));
}

/** Summed magnitude (dB) of a filter cascade across `freqs`. */
export function cascadeResponseDb(
  filters: readonly Biquad[],
  freqs: readonly number[],
  sampleRate = 44100,
): number[] {
  return freqs.map((f) => filters.reduce((sum, bq) => sum + magnitudeDb(bq, f, sampleRate), 0));
}
