/**
 * App-wide pedal singleton: one store + session/controller shared across screens.
 * Lives in src/ (not app/) so expo-router doesn't scan it as a route.
 */
import { DeviceSession } from "../device/session";
import { AMBIENCE_BUNDLES, AMBIENCE_PROFILE_WIRES } from "../protocol/ambience";
import { liveSetId, type TunerMode } from "../protocol/params";
import { buildPresetBlob } from "../protocol/buildPreset";
import { encodePreset, withName } from "../protocol/preset";
import { ambienceStore } from "../state/ambience";
import {
  DEMO_AMBIENCE_TYPE,
  DEMO_NAME,
  DEMO_NAMES,
  DEMO_SLOT,
  DEMO_VALUES,
} from "../state/demoState";
import { ensureBluetoothMidi } from "./bleMidi";
import { loadNameCache, saveNameCache } from "./nameCache";
import { requestMIDIAccess } from "./requestAccess";
import { listPortNames, midiIOAutodetect, midiIOFromWebMidi } from "./webMidiAdapter";
import {
  applyAmbienceType,
  bindSession,
  createPedalStore,
  type PedalController,
} from "../state/store";

declare global {
  /** Set by connectPedal; the patched RN MIDI polyfill calls it when a fire-and-forget send rejects
   * (its native rejection is otherwise swallowed). Routes into the session's fast-disconnect path. */
  // eslint-disable-next-line no-var
  var __midiSendError: ((err: unknown) => void) | undefined;
}

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
  // Tear down any existing session FIRST. A second connect while a session is live (Reconnect while
  // ready, an `auto=1` deep link, a double-tap in the pre-connecting window) would otherwise leave TWO
  // sessions on one MIDIInput — double listeners, two request queues colliding, and the OLD session's
  // eventual disconnect handler tearing down the NEW one (the module refs point at the successor).
  teardownSession();
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
  const newSession = new DeviceSession(found.io, 4000, 5000, 150);
  session = newSession;
  controller = bindSession(newSession, pedalStore);
  // The RN MIDI polyfill sends fire-and-forget and swallows its native send rejection; the sansApp
  // patch re-surfaces it via this global hook so an async "destination not found" reaches THIS session's
  // fast-disconnect path instead of only being caught ~one heartbeat later. Reset on every connect and
  // cleared on teardown, so it always points at the live session. On-device verification pending.
  globalThis.__midiSendError = () => newSession.noteSendError();
  // Symmetric teardown: a DROPPED link (heartbeat detects it → state "disconnected") must release the
  // session/controller just like the manual Disconnect button does — otherwise a stale controller keeps
  // sending into a now-closed CoreMIDI port and HARD-CRASHES the app (native force-unwrap). bindSession's
  // own onState (which sets the store's connection flag) is registered first, so it runs before this.
  // Guard on identity: only the CURRENTLY-active session may trigger teardown — a superseding
  // connectPedal has already replaced the module refs, and this now-stale handler must not kill it.
  newSession.onState((s) => {
    if (s === "disconnected" && session === newSession) teardownSession();
  });
  await newSession.connect();
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
  globalThis.__midiSendError = undefined; // stop routing polyfill send-errors into a dead session
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
  ambienceStore.getState().patch({ type: DEMO_AMBIENCE_TYPE, typeDirty: false });
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
  const amb = ambienceStore.getState();
  // Re-bake the ambience profile ONLY if the user picked a type this session; otherwise preserve the
  // base blob's profile bytes (a hand-tuned reverb must not be normalized back to canonical defaults).
  const blob = buildPresetBlob(st.raw, st.values, st.name ?? "", amb.typeDirty ? amb.type : null);
  await session.writePreset(slot, blob);
  cacheName(slot, st.name ?? "");
  // Clear the dirty/baseline ("changed" ghost) ONLY when we saved to the CURRENTLY-LOADED slot — then
  // the working sound really is the saved state. Passing `blob` adopts it as the new base so a re-save
  // preserves the just-written bytes (incl. a baked profile). Saving the current sound to a DIFFERENT
  // slot leaves the loaded preset's edits unsaved to ITS slot, so the dirty state must stand (otherwise
  // the unsaved-changes guard would let the user switch away and silently lose them).
  if (slot === st.slot) pedalStore.getState().markSaved(blob);
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

const TUNER_LOG_LABEL = ["off", "mute", "bypass"] as const;

/**
 * Set the pedal's tuner: 0 Off, 1 Mute, 2 Bypass — the MUTE/BYPASS bar's action.
 *
 * Nudges with a read of the ACTIVE slot, so it needs a known slot (the bar disables itself until the
 * app knows which preset the pedal is on). The store's mirror is set from the session's own wire write,
 * so it holds the REQUESTED mode even if the nudge round-trip then fails: the write is fire-and-forget,
 * and a write that landed will be applied by any later dump — assuming it took is the safe assumption,
 * assuming it didn't is the one that leaves the user staring at an "Off" button with no signal.
 *
 * Optimistic and wire-free with no session (demo mode), like setAmbienceType.
 */
export async function setTunerMode(mode: TunerMode): Promise<void> {
  const { slot } = pedalStore.getState();
  if (!session) {
    pedalStore.getState().setTuner(mode); // demo/disconnected: mirror only, nothing to send
    return;
  }
  if (slot == null) throw new Error("Recall a preset first — the tuner needs a known active slot");
  await session.setTunerMode(mode, slot);
  pedalStore.getState().pushLog(`🔇 tuner → ${TUNER_LOG_LABEL[mode]}`);
}

/**
 * Switch the ambience type (Room…Echo Verb, index into AMBIENCE_ENGINES). Like EliteControl, we
 * LIVE-SET the type's 10 profile params (05 50 each) — no edit-buffer write, no commit; a blob write
 * to 0x7F doesn't stick. The 10 sends are PACED (setParamsPaced) so BLE doesn't silently drop the
 * burst — the same reason connect() gaps its fire-and-forget sends.
 */
export async function setAmbienceType(index: number): Promise<void> {
  const vals = AMBIENCE_BUNDLES[index];
  if (!vals) return;
  // Optimistic (even when disconnected): mark the type dirty + push the modeled profile params
  // (ambienceTime) into pedalStore.values so a later save captures the type the user is hearing.
  applyAmbienceType(pedalStore, index);
  if (!session) return;
  await session.setParamsPaced(
    AMBIENCE_PROFILE_WIRES.map((wire, i) => ({ param: liveSetId(wire), value: vals[i]! & 0x7f })),
  );
  pedalStore.getState().pushLog(`🌫 ambience type → ${index}`);
}
