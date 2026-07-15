/**
 * Shared dynamics state for the unified transfer graph on the Compressor and Gate pages — but ONLY
 * the send-only params that aren't read back from a preset: the gate (threshold/ratio/release), the
 * compressor's output/attack/release, and the auto-gain/look-ahead toggles. These are live display
 * values, not synced from the pedal.
 *
 * The compressor's Threshold (param 0x0a) and Ratio (0x1d) are NOT here — they're store-backed
 * (PARAMS.comp / PARAMS.ratio, decoded from the preset), so both pages read them from `pedalStore`
 * and write them back there. Keeping them out of this store avoids a stale duplicate.
 */
import { createStore } from "zustand/vanilla";

interface DynamicsValues {
  gateThreshold: number;
  gateRatio: number;
  gateRelease: number;
  compOutput: number;
  compAttack: number;
  compRelease: number;
  autoGain: boolean;
  lookahead: boolean;
}

interface DynamicsStore extends DynamicsValues {
  patch: (p: Partial<DynamicsValues>) => void;
  /** Reset to defaults — called on preset recall so a previous preset's tweaks don't carry over. */
  reset: () => void;
}

const DEFAULTS: DynamicsValues = {
  gateThreshold: 24,
  gateRatio: 53,
  gateRelease: 8,
  compOutput: 32,
  compAttack: 20,
  compRelease: 48,
  autoGain: true,
  lookahead: false,
};

export const dynamicsStore = createStore<DynamicsStore>((set) => ({
  ...DEFAULTS,
  patch: (p) => set(p),
  // These send-only params aren't read back from the preset; resetting on recall at least keeps them
  // from bleeding across presets (they open from defaults — see the Gate/Comp page footnotes).
  reset: () => set(DEFAULTS),
}));
