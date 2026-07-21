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
import { dynamicsStore } from "./dynamics";

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
  /** The loaded preset's values — the baseline to compare against (per-knob "changed" + ghost). */
  baseline: Partial<Record<ParamId, number>>;
  /**
   * The last-loaded preset's original 256-byte blob — the base to overlay when SAVING the current
   * sound, so bytes the app doesn't model (IR data + name, expander, tuner, reserved regions) survive.
   * null until the first load. (We build the save blob from this + live values, like EliteControl —
   * the pedal has no 0x7F edit buffer to read back.)
   */
  raw: Uint8Array | null;
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
    raw?: Uint8Array | null,
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
    baseline: {},
    raw: null,
    dirty: false,
    log: [],

    setConnection: (connection) => set({ connection }),
    setLayer: (layer) => set({ layer }),
    loadPreset: (slot, values, name = null, raw = null) =>
      set((s) => ({
        slot,
        name,
        values: { ...values },
        baseline: { ...values },
        raw, // base blob for save-from-state; null (e.g. demo mode) disables the overlay save
        dirty: false,
        names: slot != null && name != null ? { ...s.names, [slot]: name } : s.names,
      })),
    setNames: (names) => set({ names }),
    setValueLocal: (id, value) =>
      set((s) => ({ values: { ...s.values, [id]: value }, dirty: true })),
    noteExternal: (id, value) => set((s) => ({ values: { ...s.values, [id]: value } })),
    pushLog: (line) => set((s) => ({ log: [...s.log.slice(-(LOG_CAP - 1)), line] })),
    clearLog: () => set({ log: [] }),
    markSaved: () => set((s) => ({ dirty: false, baseline: { ...s.values } })),
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

/**
 * Mirror the deep params that the shared dynamics/ambience stores hold, from a decoded preset — so
 * recall/connect show the preset's real gate/comp/ambience values instead of stale carry-over. These
 * are now decoded ParamIds, so their ghost/baseline comes from the pedal store automatically.
 */
function syncDeepStores(preset: Preset): void {
  const v = preset.values;
  dynamicsStore.getState().patch({
    gateThreshold: v.gateThreshold,
    gateRatio: v.gateRatio,
    gateRelease: v.gateRelease,
    compOutput: v.compOutput,
    compAttack: v.compAttack,
    compRelease: v.compRelease,
    autoGain: v.autoGain > 0,
    lookahead: v.lookahead > 0,
  });
  ambienceStore.getState().patch({
    decay: v.ambienceDecay,
    time: v.ambienceTime,
    type: detectAmbienceType(preset.raw),
  });
}

/** Wire a DeviceSession's events into the store and return UI-facing actions. */
export function bindSession(session: DeviceSession, store: PedalStoreApi): PedalController {
  store.getState().setConnection(session.state); // seed current state (may already be connected)

  // Re-read the pedal's current preset into the store WITHOUT changing the pedal — used on connect
  // and whenever the pedal changes preset on its own (below).
  const loadCurrent = async (): Promise<Preset> => {
    // There is NO live "edit buffer" — 0x7F is just program 127 (binary-confirmed via EliteControl RE).
    // The current sound = the pedal's ACTIVE program, whose slot is byte 0 of settings block 0. Read
    // THAT program for its values, name, AND base blob (stashed for save-from-state). Only if the slot
    // is unknown (settings read failed) do we fall back to a raw 0x7F read.
    let slot: number | null = null;
    try {
      const settings = await session.readBlock(0x55, 0);
      const s = settings[0];
      if (s !== undefined && s < 128) slot = s;
    } catch {
      // no settings block — leave slot unknown
    }
    let preset: Preset;
    try {
      preset = slot != null ? await session.readPreset(slot) : await session.readEditBuffer();
    } catch {
      // The active slot's dump dropped (flaky BLE). Fall back to a 0x7F read so the editor is still
      // populated instead of aborting the whole connect with a blank screen + a null base blob.
      preset = await session.readEditBuffer();
    }
    const name = preset.name?.trim() || null;
    store.getState().loadPreset(slot, preset.values, name, preset.raw);
    syncDeepStores(preset);
    store.getState().pushLog(`● loaded current preset${slot != null ? ` (${slot + 1})` : ""}`);
    return preset;
  };

  let reloading = false; // avoid overlapping reloads from repeated slot notifications
  const unsubs = [
    session.onState((s) => store.getState().setConnection(s)),
    // The pedal changes preset on its own (footswitch) → it pushes the full 05 41 dump. Apply it
    // INSTANTLY (number + name + every knob/deep param), exactly like EliteControl. This is the
    // primary path; the heartbeat slot-check below is only a backstop for a dropped BLE push.
    session.onPushedPreset((slot, preset) => {
      store.getState().loadPreset(slot, preset.values, preset.name?.trim() || null, preset.raw);
      syncDeepStores(preset);
      store.getState().pushLog(`⤺ pedal → preset ${slot + 1}: ${preset.name.trim()}`);
    }),
    session.onSlotChange((slot) => {
      if (slot === store.getState().slot || reloading) return;
      reloading = true; // dropped push? re-read the now-current preset
      void loadCurrent().finally(() => {
        reloading = false;
      });
    }),
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
      store.getState().loadPreset(slot, preset.values, preset.name?.trim() || null, preset.raw);
      syncDeepStores(preset); // gate/comp/ambience deep params, from this preset's real values
      store.getState().pushLog(`▶ recalled ${slot}: ${preset.name}`);
      return preset;
    },
    loadCurrent,
    dispose() {
      for (const u of unsubs) u();
    },
  };
}
