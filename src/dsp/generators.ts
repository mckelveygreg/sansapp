/**
 * IR generators + combiners for the in-app "IR Studio": build parametric impulse responses
 * (high/low-pass, shelves, peak, notch, tilt) and blend or cascade them into a custom cab IR.
 * Reuses the biquad + convolution primitives. Framework-free; export via src/protocol/wav.ts.
 */
import { highpass, highShelf, impulseResponse, lowpass, lowShelf, notch, peaking } from "./biquad";
import { convolve } from "./hpf";

export type IrGenKind =
  | "highpass"
  | "lowpass"
  | "lowshelf"
  | "highshelf"
  | "peak"
  | "notch"
  | "tilt";

export interface IrGenParams {
  /** Corner / centre frequency (Hz). */
  fc: number;
  /** dB for shelves, peak and tilt. */
  gainDb?: number;
  q?: number;
  /** Cascade the same section N times for a steeper slope. */
  stages?: number;
  sampleRate?: number;
  taps?: number;
}

/** Generate a parametric impulse response. */
export function generateIr(kind: IrGenKind, p: IrGenParams): Float64Array {
  const sr = p.sampleRate ?? 44100;
  const q = p.q ?? Math.SQRT1_2;
  const g = p.gainDb ?? 0;
  const taps = p.taps ?? 1000;
  const stages = p.stages ?? 1;

  if (kind === "tilt") {
    // pivot at fc: lows down by g, highs up by g (negative g flips it)
    return impulseResponse([lowShelf(p.fc, sr, q, -g), highShelf(p.fc, sr, q, g)], taps);
  }

  const section = () => {
    switch (kind) {
      case "highpass":
        return highpass(p.fc, sr, q);
      case "lowpass":
        return lowpass(p.fc, sr, q);
      case "lowshelf":
        return lowShelf(p.fc, sr, q, g);
      case "highshelf":
        return highShelf(p.fc, sr, q, g);
      case "peak":
        return peaking(p.fc, sr, q, g);
      case "notch":
        return notch(p.fc, sr, q);
    }
  };
  return impulseResponse(Array.from({ length: stages }, section), taps);
}

/** Weighted blend of two IRs, aligned at tap 0: (1 − mix)·a + mix·b. */
export function blendIr(a: ArrayLike<number>, b: ArrayLike<number>, mix = 0.5): Float64Array {
  const n = Math.max(a.length, b.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (1 - mix) * (a[i] ?? 0) + mix * (b[i] ?? 0);
  return out;
}

/** Cascade (in series) two IRs = convolution, truncated to `taps`. */
export function cascadeIr(a: ArrayLike<number>, b: ArrayLike<number>, taps = 1000): Float64Array {
  return convolve(a, b, taps);
}
