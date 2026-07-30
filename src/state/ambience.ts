/**
 * Ambience TYPE selection state — the one piece of ambience state that ISN'T a wire parameter. `type`
 * is the detected engine (index into AMBIENCE_ENGINES, -1 = custom/none) shown as the highlighted
 * button; `typeDirty` records that the user PICKED a type this session, so a save re-bakes that type's
 * canonical 10-param profile (otherwise the base blob's hand-tuned profile bytes are preserved).
 * Level/Decay/Time are real parameters and live in pedalStore.values (ambiance/ambienceDecay/
 * ambienceTime), read back from the preset like every other knob.
 */
import { createStore } from "zustand/vanilla";

interface AmbienceTypeState {
  /** Detected engine index into AMBIENCE_ENGINES, or -1 for custom/none. Set from the recalled blob. */
  type: number;
  /** The user applied a type this session → a save re-bakes its canonical profile. */
  typeDirty: boolean;
}

interface AmbienceStore extends AmbienceTypeState {
  patch: (p: Partial<AmbienceTypeState>) => void;
}

export const ambienceStore = createStore<AmbienceStore>((set) => ({
  type: 1, // Hall
  typeDirty: false,
  patch: (p) => set(p),
}));
