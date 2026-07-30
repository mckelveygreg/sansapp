# Hardware & cabling

How to physically connect a phone to the SansAmp PBDR Elite.

## Recommended: Bluetooth (CME WIDI Jack)

The Elite has **3.5 mm TRS Type A** MIDI IN and OUT jacks. The tidiest wireless option:

- **Buy: CME WIDI Jack, the `25TRS35` cable bundle** (~$60; all WIDI Jack bundles are the
  same price — pick `25TRS35` because its cables end in 3.5 mm to match the pedal).
- One WIDI Jack is enough: the unit has **two 2.5 mm mini-TRS sockets** —
  - ▲ socket → pedal **MIDI OUT** (this also powers the WIDI Jack, and receives from the pedal)
  - ▼ socket → pedal **MIDI IN** (sends to the pedal)
- **Power:** parasitic from the pedal's MIDI OUT (needs 3.3–5 V). If the LED doesn't light,
  plug any USB‑C charger/power bank into the WIDI Jack's USB‑C port.
- **Type A/B switch:** the pedal is Type A. CME's cable is wired Type B, so if MIDI won't
  pass at first, flip the WIDI Jack's A/B slide switch (this is the documented fix).
- **First-time setup:** update the WIDI Jack firmware once with the free **CME WIDI** iPhone
  app (enables long-SysEx support). After that it appears as a normal Bluetooth MIDI device;
  the app pairs it via iOS's native BLE MIDI. Bulk operations are chunked + retried, so large
  preset syncs survive BLE.

> ⚠️ You cannot reuse the pedal's included 3.5 mm cables with the WIDI Jack — the WIDI end is
> 2.5 mm, which is why the `25TRS35` cable set is required.

### ✅ Confirmed working over Bluetooth (2026-07-05)

The full protocol runs over the WIDI Jack, verified from the Mac (WIDI paired via Audio MIDI
Setup → Bluetooth; the endpoint enumerates as `WIDI Jack Bluetooth`). Our `DeviceSession` +
codec, unchanged, ran end-to-end over BLE:

- **Handshake:** ~700 ms to `ready`.
- **Reads:** all **128 presets, 128/128 checksums valid, 128/128 byte-identical** to the desktop
  editor's `.dat` mirror — including the 267-byte long-SysEx preset dumps that truncate on
  cheaper BLE adapters. (`ELITE_PORT="WIDI Jack Bluetooth" npm run probe`.)
- **Latency** (`npm run ble-check`): 267-byte preset read round-trip **~250 ms** (min 237 / max
  269); the tool also fires one paced no-op `05 50` live-set to prove the send direction without
  changing pedal state. (An earlier write test measured the `05 20` write + `05 21` ack round-trip
  at **~210 ms**.) Live one-way `setParam` knob edits carry no reply, so they
  feel far snappier than the full-preset numbers — the ~250 ms only bears on bulk library sync
  (**measured ≈35 s** to read all 128, shown with a progress bar). The BLE link was stable across
  repeated full runs.

Tools for this: `npm run ports` (list CoreMIDI endpoints — find the WIDI name), `npm run probe`
(read-only full validation), `npm run ble-check` (latency + non-destructive send-path check).

## Wired fallback (optional)

Not required, but useful as insurance:

- **iPhone (Lightning):** Apple **Lightning-to-USB 3 Camera Adapter** (wall-powered) → the
  pedal's included **MD1** USB‑C interface → pedal. A plain USB‑C→Lightning charging cable
  will **not** work (no USB host mode).
- **iPhone/iPad (USB‑C):** USB‑C cable → MD1 → pedal.

## Android

Android support is newer than iOS and is at the community-testing stage — if you try it, please
report back with your phone model and Android version. Two ways to connect:

### USB (most reliable on Android)

USB‑C cable → the pedal's **MD1** interface → pedal. Android's MIDI service enumerates the
class‑compliant MD1 automatically. When you plug in, Android may prompt to let SansApp use the USB
device — allow it, then tap **Connect**. This is the most dependable path today.

### Bluetooth (CME WIDI Jack) — experimental

Same WIDI Jack + `25TRS35` cabling as [above](#recommended-bluetooth-cme-widi-jack). Unlike iOS
(where you pair the WIDI in a system sheet first), **on Android the app scans for the WIDI over
Bluetooth LE and opens it itself** — so grant the **Nearby devices / Bluetooth** permission when
prompted, then tap **Connect**. If the WIDI doesn't appear, fall back to USB and open an issue.

> Requires Android 6.0+ (USB MIDI); 8.0+ recommended for Bluetooth MIDI. The BLE path is the newest
> code in the app and hasn't been tested across many phones yet — expect rough edges.

## Development (no phone needed)

Protocol capture runs entirely on a Mac using the pedal's included **MD1** over USB and the
official EliteControl app — see [CAPTURE-PLAYBOOK.md](./CAPTURE-PLAYBOOK.md). The app can be
developed against the software emulator with no pedal at all (`npm run emulate`).
