/**
 * Raw wire value (0–127) → human display units for the deep-page controls.
 *
 * Two calibration sources, and the denominator differs between them — don't unify it:
 *
 *  - **Hardware-model tapers** (the 3-band parametric EQ) follow the pedal's own filter maths
 *    (src/dsp/eliteFilters.ts, golden-tested against the pedal). The pedal normalises a wire value
 *    as x = value/128, so the noon detent (64) sits exactly on centre — 0.00 dB, 500 Hz, Q 1.0 —
 *    and the top of travel (127) stops just shy of the nominal maximum.
 *
 *  - **Screenshot-calibrated tapers** (compressor, gate, auto-filter) were read off EliteControl's
 *    own displays at each control's extremes on 2026-07-05 (plus a noon point where the taper is
 *    non-linear, to tell linear from log). They divide by 127 so both endpoints land exactly on the
 *    displayed extremes. Leave these at /127: their laws aren't hardware-verified, and the protocol
 *    map already disagrees with two of them (see the compressor note below).
 *
 * Framework-free — no react/expo imports. What reaches the pedal is always the raw 0–127 byte;
 * these are display-only.
 */

// Screenshot-calibrated helpers: 0..127 maps onto [lo, hi] inclusive.
const lin = (r: number, lo: number, hi: number): number => lo + (r / 127) * (hi - lo);
const logMap = (r: number, lo: number, hi: number): number => lo * (hi / lo) ** (r / 127);
// Hardware-model helpers: x = value/128 (exactly 0.5 at 64), x' = 2x − 1 (bipolar, 0 at 64).
const lin128 = (r: number, lo: number, hi: number): number => lo + (r / 128) * (hi - lo);
const bipolar = (r: number): number => 2 * (r / 128) - 1;

/* ── Compressor ─────────────────────────────────────────────────────────────── */
// Endpoints below are screenshot-calibrated; the protocol map disagrees on Ratio (16:1) and Release
// (50–5000 ms) — pending re-verification against the pedal.
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

/* ── Gate (noise gate, on the Dynamics page) ─────────────────────────────────── */
// Threshold: Bypass at raw 0, then ≈ −99 … −30 dB (EliteControl min/mid/max read-outs 2026-07-14:
// raw≈64 → −64.5, max → −30; the low end is extrapolated from those anchors).
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
// Hardware-model tapers, matching src/dsp/eliteFilters.ts: gain is 24x − 12 on every band
// (−12 … +11.8 dB, exactly 0 at 64); Low/High freq are linear in x; Low/Mid Q are exponential
// (exactly 1.0 at 64). Only High's Q display is still screenshot-calibrated — the hardware law
// switches taper on the sign of the *gain* knob (a different param), which a one-knob display
// can't express; it joins the shared filter model when the tone chart moves onto it.
export const eqGainDb = (r: number): number => lin128(r, -12, 12);

/** Punch and Mid's shared centre-frequency sweep — deliberately asymmetric (300 Hz of travel below
 * the detent, 1500 above, so the knob feels centred): 200 … 1977 Hz, exactly 500 Hz at 64. */
export const sweepFreqHz = (r: number): number => {
  const xp = bipolar(r);
  return 500 + xp * (xp < 0 ? 300 : 1500);
};

export const EQ_BANDS = {
  low: { freq: (r: number) => lin128(r, 40, 200), q: (r: number) => 2 ** bipolar(r) },
  mid: { freq: sweepFreqHz, q: (r: number) => 2 ** (2 * bipolar(r)) },
  high: { freq: (r: number) => lin128(r, 1000, 8000), q: (r: number) => lin(r, 0.1, 1.4) },
} as const;

/** Format a frequency the way EliteControl does: "200", "500", "2.0k", "8.0k". */
export const fmtHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(Math.round(hz));
