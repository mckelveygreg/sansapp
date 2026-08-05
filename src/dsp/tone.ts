/**
 * Combined tone view — the pedal's static tone stages on one axis. The drive voicing (drive.ts)
 * and the tone stack (eq.ts) are linear filter cascades in series, so their dB responses add;
 * the master curve is that sum, evaluated from the same hardware-verified model. Presence belongs
 * to the drive stage (it IS the Crunch filter), so the EQ component here is the 3-band stack
 * alone — nothing is counted twice.
 *
 * The cab is deliberately NOT summed into the master: an IR curve is FFT-normalized to a band
 * (relative dB) at a nominal sample rate (approximate x-axis), unlike the exact absolute-dB model
 * curves — adding it would contaminate the master with an approximation. It overlays as a shape
 * instead, and the helpers here (cabCurveDb, cabResponseAt) give every page the one display
 * convention. Framework-free.
 */
import type { DriveKnobs } from "./drive";
import { driveResponse } from "./drive";
import type { EqKnobs } from "./eq";
import { eqResponse } from "./eq";
import { frequencyResponse } from "./ir";

/** Every knob that moves the static tone: the 3-band EQ (with its deep Freq/Q trims) plus the
 * drive voicing. Presence lives on the drive side (it's the Crunch filter), so the EQ overlay
 * fields are dropped — the drive stage owns that bell. */
export type ToneKnobs = Omit<EqKnobs, "presence" | "presenceQ"> & DriveKnobs;

export interface ToneResponse {
  /** The 3-band tone stack alone (no Presence — that's in `drive`). */
  eq: number[];
  /** The drive voicing: Buzz + Punch ×2 + Crunch ×2 (Crunch = the Presence knob). */
  drive: number[];
  /** The summed static tone: `eq + drive`, pointwise. */
  master: number[];
}

/** The combined static tone response across `grid`: both stages from the pedal's own filter
 * model, plus their sum (in-series linear filters — the dB curves add). */
export function toneResponse(k: ToneKnobs, grid: readonly number[]): ToneResponse {
  const eq = eqResponse(
    {
      low: k.low,
      mid: k.mid,
      high: k.high,
      freq: k.freq,
      q: k.q,
      lowFreq: k.lowFreq,
      lowQ: k.lowQ,
      highFreq: k.highFreq,
      highQ: k.highQ,
    },
    grid,
  );
  const drive = driveResponse(k, grid);
  return { eq, drive, master: eq.map((v, i) => v + drive[i]!) };
}

// The pedal plays its 2400-sample IRs at a fixed rate we haven't pinned exactly (calibration
// TODO); a nominal rate keeps the curve SHAPE right (x-axis Hz labels are approximate).
export const PEDAL_IR_RATE = 88200;

/** Display curve of a pulled pedal IR: 1/6-octave smoothed, normalized so the 700–1400 Hz band
 * reads 0 dB. Relative dB by construction — see the module header for why it's never summed. */
export function cabCurveDb(ir: ArrayLike<number>, grid: readonly number[]): number[] {
  return frequencyResponse(ir, grid, { sampleRate: PEDAL_IR_RATE, normalizeBand: [700, 1400] });
}

/** Linear blend of two dB curves; a missing (null) side falls back to the known one, and both
 * missing means the blend is unknowable. */
export function blendDb(
  a: readonly number[] | null,
  b: readonly number[] | null,
  f: number,
): number[] | null {
  if (!a && !b) return null;
  if (!a) return b!.slice();
  if (!b) return a.slice();
  return a.map((v, i) => v * (1 - f) + b[i]! * f);
}

/**
 * The active cab curve at an IR-select (0x0E) position: 0 is Off (flat), slot n sits at n·16,
 * and values between morph the two neighbouring cabs linearly — the same rule the pedal applies.
 * `dbAt` answers slots 1–8 with the slot's curve or null when it's unknown (not pulled, or a
 * user slot playing its unreadable factory cab); null when the position is entirely unknown.
 */
export function cabResponseAt(
  morph: number,
  dbAt: (slot: number) => readonly number[] | null,
  flat: readonly number[],
): number[] | null {
  if (morph <= 0) return flat.slice();
  const rf = morph / 16;
  const lo = Math.floor(rf);
  const hi = Math.min(8, Math.ceil(rf));
  const curveAt = (pos: number) => (pos <= 0 ? flat : dbAt(pos));
  return blendDb(curveAt(lo), curveAt(hi), rf - lo);
}
