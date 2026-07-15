/**
 * ble-midi — Bluetooth-LE MIDI device discovery + connection.
 *
 * ANDROID ONLY. Android's `MidiManager.getDevices()` does NOT enumerate BLE-MIDI peripherals
 * (e.g. the CME WIDI Jack) until the app scans for them and opens one via
 * `MidiManager.openBluetoothDevice()`. This module supplies that missing scan + open step; once a
 * device is opened it becomes visible to the Web MIDI polyfill (`@motiz88/react-native-midi`) and
 * the rest of the app's MIDI stack. USB MIDI already works without this module.
 *
 * iOS and web are intentional no-ops: iOS connects BLE-MIDI through CoreMIDI's system
 * Bluetooth-MIDI pairing sheet (no custom central needed), so on those platforms
 * `scanForMidiDevices` resolves `[]`, `connectBluetoothMidi` resolves `false`, and `isSupported()`
 * returns `false`.
 *
 * PERMISSIONS: the JS caller must request the Android runtime permissions BEFORE calling scan /
 * connect — `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` on API 31+, `ACCESS_FINE_LOCATION` on API <= 30 —
 * via React Native's `PermissionsAndroid`. The native side still fails gracefully (rejects with
 * code `E_PERMISSION`) if a permission is missing.
 */
import { requireOptionalNativeModule } from "expo";

export interface BleMidiDevice {
  address: string;
  name: string;
}

interface BleMidiNativeModule {
  isSupported: () => boolean;
  scanForMidiDevices: (timeoutMs: number) => Promise<BleMidiDevice[]>;
  connectBluetoothMidi: (address: string) => Promise<boolean>;
}

// `requireOptionalNativeModule` (not `requireNativeModule`) so the web bundle — which has no native
// module registered — receives `null` instead of throwing at import time. On iOS/Android the native
// module is always present; the guards below therefore only matter on web.
const BleMidi = requireOptionalNativeModule<BleMidiNativeModule>("BleMidi");

/** True on Android; false on iOS/web (CoreMIDI / the browser handle BLE MIDI there). */
export function isSupported(): boolean {
  return BleMidi?.isSupported() ?? false;
}

/**
 * Scan for BLE peripherals advertising the MIDI GATT service and resolve the discovered adapters.
 * Resolves an empty array on iOS/web. Rejects on Android with a coded error (e.g. `E_BT_DISABLED`,
 * `E_PERMISSION`) when scanning cannot start.
 */
export function scanForMidiDevices(timeoutMs: number): Promise<BleMidiDevice[]> {
  return BleMidi ? BleMidi.scanForMidiDevices(timeoutMs) : Promise.resolve([]);
}

/**
 * Open a discovered BLE-MIDI device so it becomes an enumerable MIDI port. Resolves `true` once the
 * device is opened, `false` on iOS/web. Rejects on Android with a coded error on failure.
 */
export function connectBluetoothMidi(address: string): Promise<boolean> {
  return BleMidi ? BleMidi.connectBluetoothMidi(address) : Promise.resolve(false);
}
