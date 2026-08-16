/**
 * App state — a framework-free zustand *vanilla* store plus a controller that binds it
 * to a DeviceSession. Kept out of React so it's unit-testable in Node; the RN app wraps
 * it with `useStore`.
 */

import { createStore } from "zustand/vanilla";
import type { ConnectionState, DeviceSession } from "../device/session";
import { AMBIENCE_BUNDLES, AMBIENCE_PROFILE_WIRES, detectAmbienceType } from "../protocol/ambience";
import {
  KNOB_LAYER_NOTIFY_PARAM,
  PARAM_IDS,
  PARAMS,
  RED_ZONE_TOGGLE_MIN_FIRMWARE,
  RED_ZONE_TOGGLE_PARAMS,
  TUNER_BLOB_OFFSET,
  asTunerMode,
  redZoneEngagedFor,
  type ParamId,
  type TunerMode,
} from "../protocol/params";
import type { Preset } from "../protocol/preset";
import { ambienceStore } from "./ambience";

/** Which physical-knob layer the pedal is on: primary, or the red "SHIFT" (Red Zone) layer. */
export type KnobLayer = "primary" | "red";

export interface PedalState {
  connection: ConnectionState;
  /** The connected pedal's firmware version (1.0, 1.1, …), or null until it reports one. Read off
   * byte 6 of its messages — see docs/PROTOCOL.md. Drives the "firmware update available" notice. */
  firmware: number | null;
  /**
   * The pedal's active knob layer — its "Red Zone" state, shown by the RED ZONE indicator in the
   * app's tuner bar (src/components/RedZoneBadge.tsx).
   *
   * Two sources, in decreasing order of trust: **reconciled** from the loaded values on every preset
   * load (the pedal derives its own state the same way at the same moment — see
   * {@link redZoneEngagedFor}), then **tracked** from the 0x4d footswitch notify in between. The
   * notify is the weaker source: a long-hold announces a toggle it then silently undoes, so between
   * a hold and the next preset load this can be wrong in either direction. It is displayed rather
   * than acted on for exactly that reason — the app must never write the switch back.
   */
  layer: KnobLayer;
  /**
   * What the app last asked the pedal's tuner to be: 0 Off / 1 Mute / 2 Bypass — the MUTE/BYPASS bar's
   * state. **Optimistic**, and deliberately not part of `values`: the tuner has no notify and no
   * read-back, so there is nothing to reconcile against, and modelling it would make every save write
   * blob[0x56] (baking "muted" into the user's presets — see TUNER_PARAM). Set from the session's own
   * wire writes, and re-sourced from the preset's own tuner byte on every preset change — which is what
   * the pedal itself reloads from (see syncTunerFromPreset).
   */
  tuner: TunerMode;
  /**
   * True while an IR transfer (or another exclusive bulk op) owns the link. The pedal's tuner applier
   * is gated on "no transfer in progress", so a tuner change made now would be silently swallowed —
   * the bar disables itself rather than lie.
   */
  linkBusy: boolean;
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
  setFirmware: (firmware: number | null) => void;
  setLayer: (layer: KnobLayer) => void;
  setTuner: (tuner: TunerMode) => void;
  setLinkBusy: (linkBusy: boolean) => void;
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
  /** Mark the current sound saved: clears dirty + the ambience typeDirty flag, and (when the written
   * blob is passed) adopts it as the new base for the next save so a re-save preserves what was
   * persisted (e.g. a just-baked ambience profile). */
  markSaved: (raw?: Uint8Array | null) => void;
}

const LOG_CAP = 200;

export function createPedalStore() {
  return createStore<PedalState>((set) => ({
    connection: "disconnected",
    layer: "primary",
    tuner: 0,
    linkBusy: false,
    firmware: null,
    slot: null,
    name: null,
    names: {},
    values: {},
    baseline: {},
    raw: null,
    dirty: false,
    log: [],

    setConnection: (connection) => set({ connection }),
    setFirmware: (firmware) => set({ firmware }),
    setLayer: (layer) => set({ layer }),
    setTuner: (tuner) => set({ tuner }),
    setLinkBusy: (linkBusy) => set({ linkBusy }),
    loadPreset: (slot, values, name = null, raw = null) =>
      set((s) => ({
        slot,
        name,
        values: { ...values },
        baseline: { ...values },
        raw, // base blob for save-from-state; null (e.g. demo mode) disables the overlay save
        dirty: false,
        // Reconcile the Red Zone claim instead of letting it drift. The pedal re-derives its own Red
        // Zone state from the values it just loaded — engaged if ANY of Auto Filter / Chorus (and, on
        // firmware ≤ 1.1, Ambiance) is non-zero — as the last act of a preset load, so right here it
        // is knowable exactly rather than inferred from a footswitch notify we may have misread (see
        // RED_ZONE_STATE_PARAMS, and the 0x4d handler below for how the notify can lie). Doing it in
        // the action rather than at the three call sites means no path that lands a preset can forget.
        //
        // One caveat, deliberately accepted: loadCurrent() READS the pedal's active program without
        // recalling it, so there the derivation reproduces the state as of the pedal's last recall — a
        // stomp since then is not accounted for. That is still strictly better than the "primary"
        // default it replaces (which asserts the same thing with no evidence at all), and the whole
        // point of surfacing it is that a player can check it against the pedal's own red LED.
        layer: redZoneEngagedFor(values, s.firmware) ? "red" : "primary",
        names: slot != null && name != null ? { ...s.names, [slot]: name } : s.names,
      })),
    setNames: (names) => set({ names }),
    setValueLocal: (id, value) =>
      set((s) => ({ values: { ...s.values, [id]: value }, dirty: true })),
    noteExternal: (id, value) => set((s) => ({ values: { ...s.values, [id]: value } })),
    pushLog: (line) => set((s) => ({ log: [...s.log.slice(-(LOG_CAP - 1)), line] })),
    clearLog: () => set({ log: [] }),
    markSaved: (raw) => {
      ambienceStore.getState().patch({ typeDirty: false });
      set((s) => ({ dirty: false, baseline: { ...s.values }, raw: raw ?? s.raw }));
    },
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
 * Detect and set the ambience TYPE from a decoded preset, and clear typeDirty — the gate/comp/ambience
 * PARAMETERS all read back from pedalStore.values automatically (their ghost/baseline comes from
 * the pedal store), so the only non-parameter state to sync is the highlighted engine.
 */
function syncAmbienceType(preset: Preset): void {
  ambienceStore.getState().patch({ type: detectAmbienceType(preset.raw), typeDirty: false });
}

/**
 * Apply an ambience TYPE to the app stores — the store half of setAmbienceType (the wire half paces
 * the 10-param profile on the pedal). Marks `typeDirty` so a save re-bakes the type's canonical
 * profile, and pushes every profile param that IS a modeled value (currently only ambienceTime, wire
 * 0x10) through the local-edit path so it lands in pedalStore.values and marks the sound dirty. The
 * other profile bytes aren't modeled params — the save-time bundle bake (gated on typeDirty) carries
 * them. Framework-free so it's unit-testable in Node (mirrors the store-mutation flows in store.ts).
 */
export function applyAmbienceType(store: PedalStoreApi, index: number): void {
  const vals = AMBIENCE_BUNDLES[index];
  if (!vals) return;
  ambienceStore.getState().patch({ type: index, typeDirty: true });
  AMBIENCE_PROFILE_WIRES.forEach((wire, i) => {
    const id = PARAM_IDS.find((p) => PARAMS[p].paramId === wire);
    if (id) store.getState().setValueLocal(id, vals[i]! & 0x7f);
  });
}

/**
 * A preset change happened — adopt ITS tuner byte as the mirror.
 *
 * This is the resync for the one direction that matters: the app believing the signal is muted/bypassed
 * when it is actually live. The pedal reloads its whole live param array from the preset on every
 * recall, tuner byte included (confirmed by ear: a preset change is a free escape hatch from a stuck
 * mute), and disengaging the tuner with the channel footswitch pushes an unsolicited preset dump — so
 * the preset-change hooks fire on exactly the transition that clears it.
 *
 * Reading the byte rather than assuming 0 is what makes this firmware-exact instead of merely usual.
 * Presets store 0 in practice — but one saved AT THE PEDAL with the tuner engaged stores 1 or 2, and
 * recalling it genuinely engages the tuner. Assuming Off there would put the mirror wrong in the
 * dangerous direction, on the one preset where it matters.
 *
 * The other direction stays optimistic: a footswitch engaging the tuner is completely silent on the
 * wire, so nothing can tell the app about it. (The 0x4d notify is NOT that signal — a long-hold passes
 * through the Red Zone engage on its way to the tuner and emits a `4d=1` byte-identical to an ordinary
 * press, about a second BEFORE the tuner comes on. Clearing the mirror on 0x4d would clear it at the
 * exact moment the pedal is heading into Mute.)
 */
function syncTunerFromPreset(store: PedalStoreApi, raw: Uint8Array | null): void {
  const mode = asTunerMode(raw?.[TUNER_BLOB_OFFSET]);
  if (store.getState().tuner !== mode) store.getState().setTuner(mode);
}

/** Wire a DeviceSession's events into the store and return UI-facing actions. */
export function bindSession(session: DeviceSession, store: PedalStoreApi): PedalController {
  store.getState().setConnection(session.state); // seed current state (may already be connected)

  // Re-read the pedal's current preset into the store WITHOUT changing the pedal — used on connect
  // and whenever the pedal changes preset on its own (below).
  const loadCurrent = async (): Promise<Preset> => {
    // There is NO live "edit buffer" — 0x7F is just program 127 (confirmed by observing EliteControl).
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
    syncAmbienceType(preset);
    syncTunerFromPreset(store, preset.raw); // the backstop path follows a real preset change
    store.getState().pushLog(`● loaded current preset${slot != null ? ` (${slot + 1})` : ""}`);
    return preset;
  };

  let reloading = false; // avoid overlapping reloads from repeated slot notifications
  const unsubs = [
    session.onState((s) => {
      store.getState().setConnection(s);
      // A link that dies mid-IR-transfer never delivers the exclusive window's release (the controller
      // is disposed first), which would leave the tuner bar disabled forever. The disconnect is the
      // release.
      if (s === "disconnected") store.getState().setLinkBusy(false);
    }),
    session.onFirmwareVersion((firmware) => {
      store.getState().setFirmware(firmware);
      store.getState().pushLog(`pedal firmware ${firmware.toFixed(1)}`);
    }),
    // The pedal changes preset on its own (footswitch) → it pushes the full 05 41 dump. Apply it
    // INSTANTLY (number + name + every knob/deep param), exactly like EliteControl. This is the
    // primary path; the heartbeat slot-check below is only a backstop for a dropped BLE push.
    session.onPushedPreset((slot, preset) => {
      store.getState().loadPreset(slot, preset.values, preset.name?.trim() || null, preset.raw);
      syncAmbienceType(preset);
      syncTunerFromPreset(store, preset.raw); // the recall behind this push reloaded its tuner byte
      store.getState().pushLog(`⤺ pedal → preset ${slot + 1}: ${preset.name.trim()}`);
    }),
    session.onSlotChange((slot) => {
      if (slot === store.getState().slot || reloading) return;
      reloading = true; // dropped push? re-read the now-current preset
      void loadCurrent().finally(() => {
        reloading = false;
      });
    }),
    // The only tuner state the app can have is what it asked for — the pedal never reports the param.
    session.onTunerMode((mode) => store.getState().setTuner(mode)),
    session.onLinkBusy((busy) => store.getState().setLinkBusy(busy)),
    session.onParamNotify((e) => {
      // The red "shift" footswitch reports as a 0x4d notify. 0x4d is High Freq's live-set id, never
      // its notify id (High Freq notifies on 0x49), so a 0x4d notify is always the footswitch — never
      // a knob change; route it to the layer, not noteExternal.
      if (e.paramId && e.param !== KNOB_LAYER_NOTIFY_PARAM) {
        store.getState().noteExternal(e.paramId, e.value);
      }
      if (e.param === KNOB_LAYER_NOTIFY_PARAM) {
        const on = e.value ? 1 : 0;
        store.getState().setLayer(on ? "red" : "primary");
        // Firmware ≥ 1.1: this footswitch also toggles the Red Zone effects — the pedal force-sets
        // Auto Filter + Chorus enable to 1/0 WITHOUT notifying them (see RED_ZONE_TOGGLE_PARAMS).
        // Mirror them or the app's toggles go stale and the next save writes the old flags back.
        // The firmware version is known here: it's byte 6 of this very notify, latched before decode.
        //
        // ⚠️ The mirror is provisional, and knowingly so: a LONG-HOLD of this switch (the footswitch
        // tuner-engage) performs the very same Red-Zone toggle a SECOND time, silently, on its way
        // into the tuner — so the pedal ends where it started while we keep the announced half. It is
        // symmetric: a hold begun with the Red Zone engaged notifies 4d=0 and then silently turns both
        // flags back on. Neither an inferred fix nor a reconciliation can close that: the hold arm is
        // wire-silent (so waiting out the hold window learns nothing and would have to apply the
        // mirror anyway), and the pedal has no live-param read-back at all — a preset dump comes from
        // flash. So the exposure is bounded, not eliminated, by the repair below:
        //
        // A preset change reloads the pedal's live array from the blob AND pushes that blob
        // unsolicited, so onPushedPreset → loadPreset re-sources both flags from the pedal's own
        // bytes. Exiting the tuner with the channel footswitch IS a preset change, so the ordinary
        // gesture repairs itself. What remains exposed is a save (or a red-zone toggle in the UI)
        // taken between the long-hold and the next preset change/recall/reconnect: saveCurrentTo
        // builds the blob from `values`, so it would persist the announced half. Do NOT "fix" that by
        // writing the toggle back at the pedal — the red switch's set-id (0x13) is a command that also
        // repoints all eight physical knobs at the other knob bank.
        const fw = store.getState().firmware;
        if (fw !== null && fw >= RED_ZONE_TOGGLE_MIN_FIRMWARE) {
          for (const id of RED_ZONE_TOGGLE_PARAMS) store.getState().noteExternal(id, on);
          store
            .getState()
            .pushLog(`🔴 Red Zone ${on ? "ON" : "OFF"} → chorus + filter ${on ? "on" : "off"}`);
        } else {
          store.getState().pushLog(`🔴 knob layer → ${on ? "Red Zone" : "primary"}`);
        }
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
      syncAmbienceType(preset); // highlighted engine, from this preset's blob
      syncTunerFromPreset(store, preset.raw); // every recall reloads the tuner from the preset
      store.getState().pushLog(`▶ recalled ${slot}: ${preset.name}`);
      return preset;
    },
    loadCurrent,
    dispose() {
      for (const u of unsubs) u();
    },
  };
}
