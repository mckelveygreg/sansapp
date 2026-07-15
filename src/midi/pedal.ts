/**
 * App-wide pedal singleton: one store + session/controller shared across screens.
 * Lives in src/ (not app/) so expo-router doesn't scan it as a route.
 */
import { DeviceSession } from "../device/session";
import { applyAmbienceBundle, detectAmbienceType } from "../protocol/ambience";
import { encodePreset, withName } from "../protocol/preset";
import { ambienceStore } from "../state/ambience";
import { ensureBluetoothMidi } from "./bleMidi";
import { requestMIDIAccess } from "./requestAccess";
import { listPortNames, midiIOAutodetect, midiIOFromWebMidi } from "./webMidiAdapter";
import { bindSession, createPedalStore, type PedalController } from "../state/store";

export const pedalStore = createPedalStore();

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
  await session.connect();
  pedalStore.getState().pushLog(`🔌 connected via ${found.name}`);
  // Show the pedal's CURRENT tone (read-only) — do NOT recall a slot, which would change the pedal.
  await controller.loadCurrent();
}

export function disconnectPedal(): void {
  session?.disconnect(); // fires the disconnected state to the store
  controller?.dispose();
  controller = null;
  session = null;
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

/** Save the pedal's current (edited) sound — the live edit buffer — into a slot. */
export async function saveCurrentTo(slot: number): Promise<void> {
  if (!session) throw new Error("Not connected");
  const buf = await session.readEditBuffer(); // 05 40 7F — read only
  await session.writePreset(slot, buf.raw);
  cacheName(slot, buf.name);
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
 * Switch the ambience engine (Room…Echo Verb, index into AMBIENCE_ENGINES). There's no single "type"
 * param — like EliteControl, we overlay the engine's byte bundle onto the live edit buffer and write
 * it back (05 20 0A 7F).
 */
export async function setAmbienceType(index: number): Promise<void> {
  if (!session) throw new Error("Not connected");
  const buf = await session.readEditBuffer();
  await session.writePreset(0x7f, applyAmbienceBundle(buf.raw, index));
  // Read back to confirm the engine bundle actually landed in the edit buffer.
  const check = await session.readEditBuffer();
  if (detectAmbienceType(check.raw) !== index) {
    throw new Error("ambience engine write did not take");
  }
  ambienceStore.getState().patch({ type: index });
  pedalStore.getState().pushLog(`🌫 ambience type → ${index}`);
}
