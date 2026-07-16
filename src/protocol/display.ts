/**
 * Human-readable knob readouts for the generic KnobPanel (editor + Red Zone). Uses the calibrated
 * formatters in units.ts where we have them — EQ gain (dB), the parametric Mid's Freq/Q, the
 * compressor Ratio, and the Auto-Filter's centre "Bypass" detent — and falls back to a raw percent
 * for the controls whose taper isn't calibrated yet. Framework-free; display-only (the wire value is
 * always the raw 0–127 byte). Deep pages format their own params directly against units.ts.
 */
import type { ParamId } from "./params";
import { compRatio, EQ_BANDS, eqGainDb, filterLevelLabel } from "./units";

const pct = (raw: number): string => `${Math.round((raw / 127) * 100)}%`;
const hz = (h: number): string =>
  h >= 1000 ? `${(h / 1000).toFixed(1)} kHz` : `${Math.round(h)} Hz`;

/** Readout string for a knob's raw 0–127 value (calibrated unit, "Bypass", or raw %). */
export function displayFor(id: ParamId, raw: number): string {
  switch (id) {
    case "low":
    case "mid":
    case "high": {
      const db = eqGainDb(raw);
      return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
    }
    case "freq":
      return hz(EQ_BANDS.mid.freq(raw));
    case "q":
      return `Q ${EQ_BANDS.mid.q(raw).toFixed(1)}`;
    case "ratio":
      return `${compRatio(raw).toFixed(1)}:1`;
    case "filter": // Auto-Filter Level — reads "Bypass" at the centre detent (raw 64)
      return filterLevelLabel(raw);
    default:
      return pct(raw);
  }
}
