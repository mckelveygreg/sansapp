/**
 * Raw wire value (0–127) → human display units for the deep-page controls.
 *
 * Two calibration sources, and the denominator differs between them — don't unify it:
 *
 *  - **Hardware-model tapers** (EQ gain, the Punch/Mid frequency sweep) follow the pedal's own
 *    filter maths (src/dsp/eliteFilters.ts, golden-tested against the pedal). The pedal normalises
 *    a wire value as x = value/128, so the noon detent (64) sits exactly on centre — 0.00 dB,
 *    500 Hz — and the top of travel (127) stops just shy of the nominal maximum. Every OTHER EQ
 *    taper (band freq/Q, the boost/cut shape switching) lives in eliteFilters.ts itself: derive
 *    read-outs from designEliteFilter, so each law has exactly one home.
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
/** Square taper — same endpoints as {@link lin}, but the midpoint sits a quarter of the way up. */
const sqMap = (r: number, lo: number, hi: number): number => lo + (hi - lo) * (r / 127) ** 2;
// Hardware-model helpers: x = value/128 (exactly 0.5 at 64), x' = 2x − 1 (bipolar, 0 at 64).
const lin128 = (r: number, lo: number, hi: number): number => lo + (r / 128) * (hi - lo);
const bipolar = (r: number): number => 2 * (r / 128) - 1;

/* ── Compressor ─────────────────────────────────────────────────────────────── */
// Verified against EliteControl 1.2 on hardware, 2026-08-17 (sansapp#47 item 4), settling the
// disagreement recorded here: the **screenshot calibration was right about the endpoints** and the
// protocol map's Ratio 16:1 / Release 50–5000 ms are both wrong — drop them, don't average them.
//
// Release also turned out to be the wrong *shape*, which only a third reading could catch. Reading
// min / noon / max gave 10.0 / 261.4 / 1000.0 ms, and 261.4 is neither the linear midpoint (505) nor
// the log one (101.8): it is `10 + 990·(64/127)² = 261.43`. Fitting an exponent through all three
// points gives 2.0001, so the taper is a plain square, and the app had been under-reading Release
// across the whole middle of its travel. Endpoints agreeing is exactly why this went unnoticed —
// a two-point calibration cannot tell these three laws apart.
// Threshold: knob fully down (raw 0) reads "Bypass"; raw 1 = −0.5 dB … raw 127 = −60.0 dB (linear).
export const compThresholdDb = (r: number): number | null =>
  r <= 0 ? null : -0.5 + ((r - 1) / 126) * (-60 - -0.5);
export const compThresholdLabel = (r: number): string => {
  const db = compThresholdDb(r);
  return db === null ? "Bypass" : `${db.toFixed(1)} dB`;
};
export const compRatio = (r: number): number => lin(r, 1, 20); // 1.0:1 … 20.0:1 (hardware-confirmed)
export const compOutputDb = (r: number): number => lin(r, -30, 18); // −30.0 … +18.0 dB
// Endpoints re-read off EliteControl 1.2 on 2026-08-17: **10 … 100 ms**, so the old 1 ms minimum was
// wrong by a decade and the app read Attack far too fast at the bottom of its travel.
//
// ⚠️ The TAPER is still unconfirmed, and one earlier reading in that session is known bad: Attack's
// noon was reported as 261.4 ms, which cannot be true of a 10–100 ms control at all. Do not treat
// that number as evidence about Attack.
//
// Left on the log law rather than moved to sqMap with the two Release controls, because here the two
// are nearly indistinguishable — noon is 31.9 ms under log and 32.9 ms under square, diverging by at
// most 4.5 ms anywhere in the travel. That closeness cuts both ways: it is weak grounds to switch,
// and it caps the cost of being wrong at a few ms of display error. One noon reading decides it.
export const compAttackMs = (r: number): number => logMap(r, 10, 100); // 10 … 100 ms (taper unconfirmed)
export const compReleaseMs = (r: number): number => sqMap(r, 10, 1000); // 10 … 1000 ms (hardware-confirmed)

/* ── Gate (noise gate, on the Dynamics page) ─────────────────────────────────── */
// Threshold: Bypass at raw 0, then ≈ −99 … −30 dB (EliteControl min/mid/max read-outs 2026-07-14:
// raw≈64 → −64.5, max → −30; the low end is extrapolated from those anchors).
export const gateThresholdDb = (r: number): number | null => (r <= 0 ? null : lin(r, -99, -30));
export const gateThresholdLabel = (r: number): string => {
  const db = gateThresholdDb(r);
  return db === null ? "Bypass" : `${db.toFixed(1)} dB`;
};
export const gateRatio = (r: number): number => lin(r, 1, 10); // 1.0:1 … 10.0:1
// The noon reading came back 261.4 ms (EliteControl 1.2, 2026-08-17) — the square prediction to the
// decimal, not the log one's 101.8. Same law as the compressor's Release, same endpoints.
export const gateReleaseMs = (r: number): number => sqMap(r, 10, 1000); // 10 … 1000 ms (hardware-confirmed)

/* ── Auto Filter (envelope wah) ──────────────────────────────────────────────── */
// Level is bipolar −100 … +100 %, with the centre detent (raw 64) reading "Bypass".
export const filterLevelPct = (r: number): number => Math.round(lin(r, -100, 100));
export const filterLevelLabel = (r: number): string =>
  r === 64 ? "Bypass" : `${filterLevelPct(r)}%`;
export const filterTimePct = (r: number): number => Math.round(lin(r, 0, 100)); // attack & release

/* ── 3-band parametric EQ ────────────────────────────────────────────────────── */
// Hardware-model tapers shared with src/dsp/eliteFilters.ts. Only the two laws that other code
// needs directly live here; every band freq/Q taper is in eliteFilters.ts (designEliteFilter).
// Gain is 24x − 12 on every band: −12 … +11.8 dB, exactly 0 at 64.
export const eqGainDb = (r: number): number => lin128(r, -12, 12);

/** Punch and Mid's shared centre-frequency sweep — deliberately asymmetric (300 Hz of travel below
 * the detent, 1500 above, so the knob feels centred): 200 … 1977 Hz, exactly 500 Hz at 64. */
export const sweepFreqHz = (r: number): number => {
  const xp = bipolar(r);
  return 500 + xp * (xp < 0 ? 300 : 1500);
};

/** Format a frequency the way EliteControl does: "200", "500", "2.0k", "8.0k". */
export const fmtHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(Math.round(hz));
