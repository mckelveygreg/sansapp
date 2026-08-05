/**
 * dB-axis window fitting for the response graphs. No rendering, no React — unit-tested in Node
 * and used by the RN IrGraph component. The EQ tone charts opt in so extreme settings (e.g. a
 * maxed High cut, a −24 dB double shelf) grow the scale instead of flat-lining at the window edge;
 * the IR plots keep their fixed window, since an IR's low-end rolloff dives past any useful scale.
 */

export interface DbWindow {
  dbTop: number;
  dbBot: number;
}

/** Expand a minimum window so every curve fits with 1 dB of headroom. Each edge snaps outward to
 * a 3 dB step, so the scale holds still while a knob sweeps within a step, and never shrinks
 * inside the given minimum. NaNs are ignored (IrGraph floors them to the bottom edge). */
export function fitDbWindow(
  curves: readonly (readonly number[])[],
  minTop: number,
  minBot: number,
): DbWindow {
  let hi = -Infinity;
  let lo = Infinity;
  for (const db of curves)
    for (const v of db) {
      if (Number.isNaN(v)) continue;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
  return {
    dbTop: hi + 1 > minTop ? Math.ceil((hi + 1) / 3) * 3 : minTop,
    dbBot: lo - 1 < minBot ? Math.floor((lo - 1) / 3) * 3 : minBot,
  };
}
