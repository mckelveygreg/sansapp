/**
 * Bring a Bluetooth-MIDI pedal adapter (the CME WIDI Jack) online as a MIDI port before we enumerate.
 *
 * Web/default: no-op — the browser handles Web-Bluetooth-MIDI itself, and iOS/CoreMIDI exposes a
 * BLE-MIDI device once it's paired in the system sheet. Only Android needs an explicit scan + open
 * (see `bleMidi.native.ts`), because `android.media.midi` doesn't list BLE peripherals until opened.
 */
export async function ensureBluetoothMidi(
  _nameHint = "WIDI",
  _timeoutMs = 4000,
): Promise<string | null> {
  return null;
}
