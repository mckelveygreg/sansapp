/**
 * App state — a framework-free zustand *vanilla* store plus a controller that binds it
 * to a DeviceSession. Kept out of React so it's unit-testable in Node; the RN app wraps
 * it with `useStore`.
 */

import { createStore } from "zustand/vanilla";
import type { ConnectionState, DeviceSession } from "../device/session";
import { detectAmbienceType } from "../protocol/ambience";
import { KNOB_LAYER_NOTIFY_PARAM, type ParamId } from "../protocol/params";
import type { Preset } from "../protocol/preset";
import { ambienceStore } from "./ambience";

/** Which physical-knob layer the pedal is on: primary, or the red "SHIFT" (Red Zone) layer. */
export type KnobLayer = "primary" | "red";

export interface PedalState {
  connection: ConnectionState;
  /** The pedal's active knob layer (tracked from the 0x4d footswitch notify + our own sets). */
  layer: KnobLayer;
  /** Active preset slot (null = the pedal's current/live edit buffer, slot unknown). */
  slot: number | null;
  /** Name of the currently-loaded preset / edit buffer (from its blob). */
  name: string | null;
  /** Cached slot→name map (from a library sync); survives tab navigation. */
  names: Record<number, string>;
  /** Current control values (from the recalled preset + live edits), keyed by ParamId. */
  values: Partial<Record<ParamId, number>>;
  /** Unsaved edits since the last recall/save. */
  dirty: boolean;
  /** Recent human-readable MIDI log lines (ring buffer). */
  log: string[];

  setConnection: (s: ConnectionState) => void;
  setLayer: (layer: KnobLayer) => void;
  loadPreset: (
    slot: number | null,
    values: Partial<Record<ParamId, number>>,
    name?: string | null,
  ) => void;
  setNames: (names: Record<number, string>) => void;
  setValueLocal: (id: ParamId, value: number) => void;
  noteExternal: (id: ParamId, value: number) => void;
  pushLog: (line: string) => void;
  clearLog: () => void;
  markSaved: () => void;
}

const LOG_CAP = 200;

export function createPedalStore() {
  return createStore<PedalState>((set) => ({
    connection: "disconnected",
    layer: "primary",
    slot: null,
    name: null,
    names: {},
    values: {},
    dirty: false,
    log: [],

    setConnection: (connection) => set({ connection }),
    setLayer: (layer) => set({ layer }),
    loadPreset: (slot, values, name = null) =>
      set((s) => ({
        slot,
        name,
        values: { ...values },
        dirty: false,
        names: slot != null && name != null ? { ...s.names, [slot]: name } : s.names,
      })),
    setNames: (names) => set({ names }),
    setValueLocal: (id, value) =>
      set((s) => ({ values: { ...s.values, [id]: value }, dirty: true })),
    noteExternal: (id, value) => set((s) => ({ values: { ...s.values, [id]: value } })),
    pushLog: (line) => set((s) => ({ log: [...s.log.slice(-(LOG_CAP - 1)), line] })),
    clearLog: () => set({ log: [] }),
    markSaved: () => set({ dirty: false }),
  }));
}

export type PedalStoreApi = ReturnType<typeof createPedalStore>;

export interface PedalController {
  setValue: (id: ParamId, value: number) => void;
  recall: (slot: number) => Promise<Preset>;
  /** Read the pedal's current edit buffer into the store WITHOUT changing the pedal (for connect). */
  loadCurrent: () => Promise<Preset>;
  dispose: () => void;
}

/** Wire a DeviceSession's events into the store and return UI-facing actions. */
export function bindSession(session: DeviceSession, store: PedalStoreApi): PedalController {
  store.getState().setConnection(session.state); // seed current state (may already be connected)
  const unsubs = [
    session.onState((s) => store.getState().setConnection(s)),
    session.onParamNotify((e) => {
      // The red "shift" footswitch reports as a 0x4d notify — same raw id as High-EQ Freq. Never
      // treat that notify as a knob change (High Freq is set-only; it never legitimately notifies),
      // or a red-button press would jog the High-Freq value.
      if (e.paramId && e.param !== KNOB_LAYER_NOTIFY_PARAM) {
        store.getState().noteExternal(e.paramId, e.value);
      }
      if (e.param === KNOB_LAYER_NOTIFY_PARAM) {
        store.getState().setLayer(e.value ? "red" : "primary");
        store.getState().pushLog(`🔴 knob layer → ${e.value ? "Red Zone" : "primary"}`);
      } else {
        store.getState().pushLog(`↩ param ${e.param.toString(16)} = ${e.value}`);
      }
    }),
  ];

  return {
    setValue(id, value) {
      store.getState().setValueLocal(id, value);
      session.setParam(id, value); // live audio
    },
    async recall(slot) {
      const preset = await session.recallPreset(slot);
      store.getState().loadPreset(slot, preset.values, preset.name?.trim() || null);
      // Ambience TYPE lives in the blob (a bundle, not a ParamId) — set it from the recalled preset
      // so the Ambience page reflects it (NOT from a re-read of the stale edit buffer).
      ambienceStore.getState().patch({ type: detectAmbienceType(preset.raw) });
      store.getState().pushLog(`▶ recalled ${slot}: ${preset.name}`);
      return preset;
    },
    async loadCurrent() {
      const preset = await session.readEditBuffer(); // 05 40 7F — read only, pedal unchanged
      // Settings block 0, byte 0 = the pedal's active preset slot (found 2026-07-06). Use it so we
      // show the real preset number, not "current". Falls back to null if the read fails.
      let slot: number | null = null;
      try {
        const settings = await session.readBlock(0x55, 0);
        const s = settings[0];
        if (s !== undefined && s < 128) slot = s;
      } catch {
        // no settings block — leave slot unknown
      }
      store.getState().loadPreset(slot, preset.values, preset.name?.trim() || null);
      ambienceStore.getState().patch({ type: detectAmbienceType(preset.raw) });
      store.getState().pushLog(`● loaded current preset${slot != null ? ` (${slot + 1})` : ""}`);
      return preset;
    },
    dispose() {
      for (const u of unsubs) u();
    },
  };
}
