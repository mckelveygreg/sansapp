/**
 * Shared ambience deep-control state (Decay + Time, raw 0–127) so the Ambience page and a recipe
 * Apply stay in sync. These two are send-only params (`05 50`) whose blob offsets aren't mapped yet,
 * so — like the dynamics store — they're live display values, not read back from the pedal/preset.
 * (Ambience Level is the main AMBIANCE knob (param 0x08) and lives in the pedal store as `ambiance`.)
 */
import { createStore } from "zustand/vanilla";

interface AmbienceValues {
  /** Engine index into AMBIENCE_ENGINES, or -1 = custom/none. Set from the recalled preset's blob. */
  type: number;
  decay: number;
  time: number;
}

interface AmbienceStore extends AmbienceValues {
  patch: (p: Partial<AmbienceValues>) => void;
}

export const ambienceStore = createStore<AmbienceStore>((set) => ({
  type: 1, // Hall
  decay: 57,
  time: 93,
  patch: (p) => set(p),
}));
