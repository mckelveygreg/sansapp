/**
 * Raw wire value (0–127) → human display units for the deep-page controls.
 *
 * Calibrated 2026-07-05 by reading EliteControl's own displays at each control's extremes (plus a
 * noon point where the taper is non-linear, to tell linear from log). Framework-free — no
 * react/expo imports. What reaches the pedal is always the raw 0–127 byte; these are display-only.
 */

const lin = (r: number, lo: number, hi: number): number => lo + (r / 127) * (hi - lo);
const logMap = (r: number, lo: number, hi: number): number => lo * (hi / lo) ** (r / 127);

/* ── Compressor ─────────────────────────────────────────────────────────────── */
// Threshold: knob fully down (raw 0) reads "Bypass"; raw 1 = −0.5 dB … raw 127 = −60.0 dB (linear).
export const compThresholdDb = (r: number): number | null =>
  r <= 0 ? null : -0.5 + ((r - 1) / 126) * (-60 - -0.5);
export const compThresholdLabel = (r: number): string => {
  const db = compThresholdDb(r);
  return db === null ? "Bypass" : `${db.toFixed(1)} dB`;
};
export const compRatio = (r: number): number => lin(r, 1, 20); // 1.0:1 … 20.0:1
export const compOutputDb = (r: number): number => lin(r, -30, 18); // −30.0 … +18.0 dB
export const compAttackMs = (r: number): number => logMap(r, 1, 100); // 1 … 100 ms (log)
export const compReleaseMs = (r: number): number => logMap(r, 10, 1000); // 10 … 1000 ms (log)

/* ── Gate (noise gate, on the Gate & Master Level page) ──────────────────────── */
// Captured 2026-07-08: Threshold raw 0 = Bypass, then ≈−90…−30 dB (−30 max + Bypass floor confirmed
// from the min/max screenshots; low end estimated). Ratio 1–10:1 linear; Release 10–1000 ms log.
// Bypass at raw 0, then ≈ −99 … −30 dB (EliteControl min/mid/max read-outs 2026-07-14: raw≈64 → −64.5,
// max → −30; the low end is extrapolated from those anchors).
export const gateThresholdDb = (r: number): number | null => (r <= 0 ? null : lin(r, -99, -30));
export const gateThresholdLabel = (r: number): string => {
  const db = gateThresholdDb(r);
  return db === null ? "Bypass" : `${db.toFixed(1)} dB`;
};
export const gateRatio = (r: number): number => lin(r, 1, 10); // 1.0:1 … 10.0:1
export const gateReleaseMs = (r: number): number => logMap(r, 10, 1000); // 10 … 1000 ms (log)

/* ── Auto Filter (envelope wah) ──────────────────────────────────────────────── */
// Level is bipolar −100 … +100 %, with the centre detent (raw 64) reading "Bypass".
export const filterLevelPct = (r: number): number => Math.round(lin(r, -100, 100));
export const filterLevelLabel = (r: number): string =>
  r === 64 ? "Bypass" : `${filterLevelPct(r)}%`;
export const filterTimePct = (r: number): number => Math.round(lin(r, 0, 100)); // attack & release

/* ── 3-band parametric EQ ────────────────────────────────────────────────────── */
// Gain is ±12 dB on every band; freq taper + Q range differ per band (measured, see table).
export const eqGainDb = (r: number): number => lin(r, -12, 12);
export const EQ_BANDS = {
  low: { freq: (r: number) => lin(r, 40, 200), q: (r: number) => lin(r, 0.5, 2.0) },
  mid: { freq: (r: number) => logMap(r, 200, 2000), q: (r: number) => lin(r, 0.5, 2.0) },
  high: { freq: (r: number) => lin(r, 1000, 8000), q: (r: number) => lin(r, 0.1, 1.4) },
} as const;

/** Format a frequency the way EliteControl does: "200", "500", "2.0k", "8.0k". */
export const fmtHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(Math.round(hz));
