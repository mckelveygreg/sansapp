/**
 * App-wide pedal singleton: one store + session/controller shared across screens.
 * Lives in src/ (not app/) so expo-router doesn't scan it as a route.
 */
import { DeviceSession } from "../device/session";
import { AMBIENCE_BUNDLES, AMBIENCE_PROFILE_WIRES } from "../protocol/ambience";
import { encode } from "../protocol/messages";
import { liveSetId } from "../protocol/params";
import { buildPresetBlob } from "../protocol/buildPreset";
import { encodePreset, withName } from "../protocol/preset";
import { ambienceStore } from "../state/ambience";
import { dynamicsStore } from "../state/dynamics";
import {
  DEMO_AMBIENCE,
  DEMO_DYNAMICS,
  DEMO_NAME,
  DEMO_NAMES,
  DEMO_SLOT,
  DEMO_VALUES,
} from "../state/demoState";
import { ensureBluetoothMidi } from "./bleMidi";
import { loadNameCache, saveNameCache } from "./nameCache";
import { requestMIDIAccess } from "./requestAccess";
import { listPortNames, midiIOAutodetect, midiIOFromWebMidi } from "./webMidiAdapter";
import { bindSession, createPedalStore, type PedalController } from "../state/store";

export const pedalStore = createPedalStore();

// Persist the slot→name map so the Presets list is populated on launch (and offline), surviving
// restarts. Hydrate once at startup — any live read already in the store wins over the cache — then
// save (debounced) whenever the names map changes (syncNames, or a per-preset name learned on load).
void loadNameCache().then((cached) => {
  if (Object.keys(cached).length > 0) {
    pedalStore.getState().setNames({ ...cached, ...pedalStore.getState().names });
  }
});
let nameSaveTimer: ReturnType<typeof setTimeout> | undefined;
let lastNames = pedalStore.getState().names;
pedalStore.subscribe((s) => {
  if (s.names === lastNames) return;
  lastNames = s.names;
  clearTimeout(nameSaveTimer);
  nameSaveTimer = setTimeout(() => void saveNameCache(lastNames), 400);
});

let controller: PedalController | null = null;
let session: DeviceSession | null = null;

export const getController = (): PedalController | null => controller;
export const getSession = (): DeviceSession | null => session;

/**
 * Request MIDI access, find the pedal, run the handshake, load preset 1. With no `portMatch`, it
 * autodetects (WIDI Jack over Bluetooth, then the wired MD1, then the first available port).
 */
export async function connectPedal(portMatch?: string): Promise<void> {
  // Android: bring the WIDI Jack (BLE) online so it enumerates as a MIDI port. No-op on iOS/web and
  // for wired USB — best-effort, so a failure here still lets the wired MD1 be found below.
  await ensureBluetoothMidi(portMatch);
  const access = await requestMIDIAccess({ sysex: true });
  const found = portMatch
    ? { io: midiIOFromWebMidi(access, portMatch), name: portMatch }
    : midiIOAutodetect(access);
  if (!found?.io) {
    const seen = listPortNames(access).inputs.filter((n) => n !== "(unnamed)");
    throw new Error(
      seen.length
        ? `Pedal not found. MIDI ports seen: ${seen.join(", ")}. Pair the WIDI Jack (or plug in the MD1), then retry.`
        : "No MIDI ports found — pair the WIDI Jack (or plug in the MD1) and retry.",
    );
  }
  // 4 s timeout (BLE round-trips are slower), 5 s heartbeat (a dropped link shows as disconnected),
  // 150 ms handshake pacing (BLE drops back-to-back sends — verified on hardware 2026-07-14).
  session = new DeviceSession(found.io, 4000, 5000, 150);
  controller = bindSession(session, pedalStore);
  // Symmetric teardown: a DROPPED link (heartbeat detects it → state "disconnected") must release the
  // session/controller just like the manual Disconnect button does — otherwise a stale controller keeps
  // sending into a now-closed CoreMIDI port and HARD-CRASHES the app (native force-unwrap). bindSession's
  // own onState (which sets the store's connection flag) is registered first, so it runs before this.
  session.onState((s) => {
    if (s === "disconnected") teardownSession();
  });
  await session.connect();
  pedalStore.getState().pushLog(`🔌 connected via ${found.name}`);
  // Show the pedal's CURRENT tone (read-only) — do NOT recall a slot, which would change the pedal.
  // Best-effort: the session is already "ready", so a hiccup reading the current tone must NOT fail
  // the whole connection. Leave the user connected (they can recall a preset) instead of tearing down.
  try {
    await controller.loadCurrent();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pedalStore
      .getState()
      .pushLog(`⚠ connected, but couldn't read current tone (${msg}) — recall a preset`);
  }
}

/**
 * Release the session + controller and close the MIDI port. Idempotent. Used by BOTH the manual
 * Disconnect button and the dropped-link path (connectPedal's onState handler above), so a dead link
 * can never leave a live controller that sends into a closed port and crashes the app.
 */
function teardownSession(): void {
  const deadSession = session;
  const deadController = controller;
  // Null FIRST: disconnect() below re-fires "disconnected", which re-enters this via the onState
  // handler — with the refs already cleared, that re-entry is a harmless no-op.
  session = null;
  controller = null;
  deadSession?.disconnect(); // rejects pending + closes io; sets store "disconnected" if not already
  deadController?.dispose();
}

export function disconnectPedal(): void {
  teardownSession();
}

/**
 * Seed the stores with synthetic demo state (no hardware) — for App Store screenshots and previewing
 * the UI without a pedal. Reached via `sansapp://connect?demo=1`; never fires in normal use. There's
 * no controller, so knob edits are local-only (no MIDI). Disconnect returns to the real flow.
 */
export function loadDemoState(): void {
  const st = pedalStore.getState();
  st.loadPreset(DEMO_SLOT, DEMO_VALUES, DEMO_NAME);
  st.setNames({ ...st.names, ...DEMO_NAMES });
  dynamicsStore.getState().patch(DEMO_DYNAMICS);
  ambienceStore.getState().patch(DEMO_AMBIENCE);
  st.setConnection("ready");
  st.pushLog("● demo state loaded (no hardware)");
}

/** Update the cached slot→name map for one slot so the Presets list re-renders immediately. */
function cacheName(slot: number, name: string): void {
  const cur = pedalStore.getState().names;
  pedalStore.getState().setNames({ ...cur, [slot]: name.trim() || `Preset ${slot + 1}` });
}

/** Copy a preset's full blob from one slot to another (blob-level — no offset map needed). */
export async function copyPreset(from: number, to: number): Promise<void> {
  if (!session) throw new Error("Not connected");
  const preset = await session.readPreset(from);
  await session.writePreset(to, preset.raw);
  cacheName(to, preset.name);
  pedalStore.getState().pushLog(`⧉ copied ${from + 1} → ${to + 1}`);
}

/** Swap two presets — a safe "move" for organizing: neither slot's preset is lost. */
export async function swapPresets(a: number, b: number): Promise<void> {
  if (!session) throw new Error("Not connected");
  if (a === b) return;
  const pa = await session.readPreset(a);
  const pb = await session.readPreset(b);
  await session.writePreset(a, pb.raw);
  await session.writePreset(b, pa.raw);
  cacheName(a, pb.name);
  cacheName(b, pa.name);
  pedalStore.getState().pushLog(`⇄ swapped ${a + 1} ↔ ${b + 1}`);
}

/**
 * Save the pedal's current (edited) sound into a slot — built from the app's OWN state, exactly like
 * EliteControl. We do NOT read 0x7F: there is no live edit buffer; 0x7F is program 127, so reading it
 * saved the wrong preset (the "patch 128 landed in slot 1" bug). The blob overlays the live values +
 * deep params onto the last-loaded base blob (pedalStore.raw); writePreset commits it and confirms.
 */
export async function saveCurrentTo(slot: number): Promise<void> {
  if (!session) throw new Error("Not connected");
  const st = pedalStore.getState();
  if (!st.raw) throw new Error("No preset loaded yet — connect and load a preset first");
  const blob = buildPresetBlob(
    st.raw,
    st.values,
    st.name ?? "",
    dynamicsStore.getState(),
    ambienceStore.getState(),
  );
  await session.writePreset(slot, blob);
  cacheName(slot, st.name ?? "");
  // Clear the dirty/baseline ("changed" ghost) ONLY when we saved to the CURRENTLY-LOADED slot — then
  // the working sound really is the saved state. Saving the current sound to a DIFFERENT slot leaves
  // the loaded preset's edits unsaved to ITS slot, so the dirty state must stand (otherwise the
  // unsaved-changes guard would let the user switch away and silently lose them).
  if (slot === st.slot) pedalStore.getState().markSaved();
  pedalStore.getState().pushLog(`💾 saved current sound → ${slot + 1}`);
}

/** Rename a preset in place (reads its blob, rewrites only the name bytes). */
export async function renamePreset(slot: number, name: string): Promise<void> {
  if (!session) throw new Error("Not connected");
  const preset = await session.readPreset(slot);
  await session.writePreset(slot, encodePreset(withName(preset, name)));
  cacheName(slot, name);
  pedalStore.getState().pushLog(`✎ renamed ${slot + 1} → ${name.trim()}`);
}

/**
 * Switch the ambience type (Room…Echo Verb, index into AMBIENCE_ENGINES). Like EliteControl, we
 * LIVE-SET the type's 10 profile params (05 50 each) — no edit-buffer write, no commit. This is what
 * actually sticks; the old blob-write approach was silently discarded by the pedal.
 */
export function setAmbienceType(index: number): void {
  const vals = AMBIENCE_BUNDLES[index];
  if (!session || !vals) return;
  AMBIENCE_PROFILE_WIRES.forEach((wire, i) => {
    session!.sendRaw(encode({ kind: "setParam", param: liveSetId(wire), value: vals[i]! & 0x7f }));
  });
  ambienceStore.getState().patch({ type: index });
  pedalStore.getState().pushLog(`🌫 ambience type → ${index}`);
}
