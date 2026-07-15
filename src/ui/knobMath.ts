/**
 * Pure knob geometry + interaction math. No rendering, no React — so it's unit-tested
 * in Node and reused by the RN Knob component (which draws) and by tests.
 */

/** A knob sweeps 270° total, from -135° (min) to +135° (max). */
export const KNOB_SWEEP_DEG = 270;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Map a raw value (min..max) to a needle angle in degrees (-sweep/2 .. +sweep/2). */
export function valueToAngle(value: number, min = 0, max = 127, sweep = KNOB_SWEEP_DEG): number {
  const t = (clamp(value, min, max) - min) / (max - min);
  return -sweep / 2 + t * sweep;
}

/** Inverse of {@link valueToAngle}; returns a rounded value. */
export function angleToValue(angle: number, min = 0, max = 127, sweep = KNOB_SWEEP_DEG): number {
  const t = clamp((angle + sweep / 2) / sweep, 0, 1);
  return Math.round(min + t * (max - min));
}

export interface DragOpts {
  min?: number;
  max?: number;
  /** Vertical pixels of drag for a full min→max sweep (smaller = more sensitive). */
  pixelsForFullSweep?: number;
}

/** Vertical relative drag → new value (dragging up increases). Clamped + rounded. */
export function dragToValue(startValue: number, dyPixels: number, opts: DragOpts = {}): number {
  const { min = 0, max = 127, pixelsForFullSweep = 200 } = opts;
  const delta = (-dyPixels / pixelsForFullSweep) * (max - min);
  return Math.round(clamp(startValue + delta, min, max));
}

/** Display a raw 0..127 value on a 0..10 knob scale (one decimal). */
export function toDisplay(value: number, min = 0, max = 127): number {
  return Math.round(((clamp(value, min, max) - min) / (max - min)) * 100) / 10;
}
