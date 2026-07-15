// iOS connects BLE-MIDI peripherals through CoreMIDI's system Bluetooth-MIDI pairing sheet, so no
// custom Core Bluetooth central is needed here. These functions exist only to satisfy the shared JS
// API and are intentional no-ops on iOS: scanning resolves an empty list, connecting resolves false,
// and isSupported() reports false so callers fall back to the CoreMIDI path.
import ExpoModulesCore

public class BleMidiModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BleMidi")

    Function("isSupported") {
      false
    }

    AsyncFunction("scanForMidiDevices") { (timeoutMs: Int) -> [[String: String]] in
      []
    }

    AsyncFunction("connectBluetoothMidi") { (address: String) -> Bool in
      false
    }
  }
}
