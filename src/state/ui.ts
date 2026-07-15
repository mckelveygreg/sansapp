/**
 * Transient UI-interaction state (not pedal state) — a vanilla zustand store so it's usable outside
 * React (e.g. the Knob's PanResponder callbacks). Currently just `adjusting`: true while a knob is
 * being dragged, so the surrounding KnobScroll disables scrolling and a vertical drag changes the
 * value instead of scrolling the page.
 */
import { createStore } from "zustand/vanilla";

interface UiState {
  /** True while any knob is mid-drag. */
  adjusting: boolean;
  setAdjusting: (adjusting: boolean) => void;
}

export const uiStore = createStore<UiState>((set) => ({
  adjusting: false,
  setAdjusting: (adjusting) => set({ adjusting }),
}));
