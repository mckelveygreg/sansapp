/**
 * Android: scan for a BLE-MIDI adapter (the WIDI Jack) and open it so it enumerates as a MIDI port.
 *
 * `android.media.midi` doesn't list BLE peripherals until the app opens them, so we scan for the
 * MIDI GATT service and call the pedal's `openBluetoothDevice` path via the local `ble-midi` module.
 * On iOS this returns null immediately (CoreMIDI + the system pairing sheet handle BLE). It never
 * throws — a failure (no permission, Bluetooth off, nothing found) just leaves the wired USB path.
 */
import { PermissionsAndroid, Platform } from "react-native";
import { connectBluetoothMidi, isSupported, scanForMidiDevices } from "../../modules/ble-midi";

/** Resolve `fallback` if `p` doesn't settle within `ms` — the native connect has no timeout of its
 * own, so a peripheral that never fires its opened-callback would otherwise hang the connect flow. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function requestBlePermissions(): Promise<boolean> {
  const api =
    typeof Platform.Version === "number"
      ? Platform.Version
      : Number.parseInt(String(Platform.Version), 10);
  const perms =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(perms);
  return perms.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
}

export async function ensureBluetoothMidi(
  nameHint = "WIDI",
  timeoutMs = 4000,
): Promise<string | null> {
  if (Platform.OS !== "android" || !isSupported()) return null;
  try {
    if (!(await requestBlePermissions())) return null;
    const devices = await scanForMidiDevices(timeoutMs);
    if (devices.length === 0) return null;
    const want = nameHint.toLowerCase();
    const pick = devices.find((d) => d.name?.toLowerCase().includes(want)) ?? devices[0]!;
    const ok = await withTimeout(connectBluetoothMidi(pick.address), 8000, false);
    return ok ? pick.name || pick.address : null;
  } catch {
    return null;
  }
}
