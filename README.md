# SansApp

**A free, open-source mobile editor for the Tech 21 SansAmp Programmable Bass Driver DI
Elite.** _SansAmp, sans app._

Tech 21 ships a great preamp pedal with deep MIDI editing — but the editor is desktop-only
(Mac/Windows). If you gig or practice with just a phone, you're stuck. SansApp puts a full
editor in your pocket: tweak every knob, browse and design cabs, and manage all 128 presets,
over MIDI (Bluetooth or wired).

> **Unofficial.** SansApp is an independent, community project — **not affiliated with,
> authorized, or endorsed by Tech 21 USA, Inc.** "SansAmp", "Bass Driver", and "Tech 21" are
> trademarks of their owner, used here only nominatively to describe compatibility. The name
> "SansApp" is parody. SansApp speaks the pedal's MIDI protocol, documented by observing a pedal
> the author owns; it includes **no Tech 21 code, artwork, fonts, or preset data.**

## Using SansApp

1. **Connect.** Pair a Bluetooth MIDI adapter (a **CME WIDI Jack** is recommended — see
   [Hardware](#hardware)) to your phone once via the CME WIDI app or GarageBand, then open SansApp
   and tap **Connect**. A USB adapter (the pedal's MD1) also works. The pill up top shows the live
   connection state.
2. **Edit live.** The **Editor** has every control on one screen — Drive/EQ, Mix/Output, and the
   red **Red Zone** functions — plus a live EQ tone graph and the current preset name/number. Turn a
   knob and the pedal responds immediately. Tap a knob's ▸ chevron to jump to its deep page
   (Compressor, Auto Filter, Ambience, Chorus, parametric EQ, Gate & Master Level, Amp).
3. **Cabs & IRs.** The **IR page** pulls your pedal's own cabs and shows each one's real frequency
   curve. Design a custom cab — high-pass a cab (drop the HPF pedal!), blend two, or build a filter
   from scratch — and upload it straight to a user slot over MIDI, with its own gain and a per-preset
   on/off. (Details in [How cabs work](#how-cabs-work).)
4. **Presets.** Step through all 128, recall any of them, and see what's changed.
5. **Back up & restore.** Export every preset to a `.p3b` file you can keep, share, or open in the
   desktop editor — and restore one back. Same format the desktop editor uses.

## Features

- **Full editor** — all knobs on one page (main + Red Zone), a live EQ tone graph, and preset
  name/number with a dirty indicator.
- **Deep pages** — Compressor, Auto Filter, Ambience, Chorus, 3-band parametric EQ, Gate & Master
  Level, and Amp models — with hardware-calibrated units and live graphs.
- **All 10 amp models + 7 ambience types**, applied live.
- **IR page** — pull the pedal's cabs with real curves, select/blend live, and **design and upload
  custom cabs** (high-pass, shelves, tilt, notch, or a 2-cab blend) to a user slot, each with a
  ±12 dB gain and a per-preset enable toggle. Export a WAV too if you want a copy.
- **Presets** — recall and step through all 128.
- **Backup / restore / share** — `.p3b` bundles, byte-compatible with the desktop editor.
- **Connection** — Bluetooth MIDI (CME WIDI Jack) or USB (MD1), auto-detected.

Under the hood: a framework-free protocol + DSP core (used by the app, the Node tools, and the
tests), a live connection/session engine validated against a software pedal emulator, and quality
gates in CI (oxc lint/format, `tsc`, ~110 vitest tests, and [Fallow](https://fallow.tools) for dead
code / cycles / duplication).

## How cabs work

The pedal has **8 cab (IR) slots**: 1–6 are the fixed factory cabs, and **7–8 are writable**. The
cab _data_ in a slot is shared across presets; each preset chooses which slot it uses (and, for the
two writable slots, a per-preset on/off). So uploading a custom cab to slot 7 or 8 replaces that
shared cab — and every preset with that slot enabled will use it. SansApp shows you what's in each
slot (pull first) so you know before you overwrite.

## Hardware

Bluetooth via a **CME WIDI Jack** (`25TRS35` bundle, ~$60) is the recommended connection; a wired
path (the pedal's MD1 USB adapter) works too. Full cabling guide: **[docs/HARDWARE.md](docs/HARDWARE.md)**.

**Platforms:** iOS is the primary, tested target. **Android** (both Bluetooth and USB MIDI) has
landed and is ready for community testing — see [docs/HARDWARE.md](docs/HARDWARE.md#android). If you
have an Elite and an Android phone, we'd love a report.

## Develop (core — Node 20+)

```sh
npm install
npm run check      # the full gate: lint + format + typecheck + test + fallow
npm test           # vitest (framework-free core: protocol, DSP, codec, state)
npm run fallow     # codebase intelligence: dead code, cycles, duplication
npm run emulate    # software pedal on virtual MIDI ports — build with no hardware
npm run probe      # read-only hardware check: read all 128 presets, verify checksums
npm run capture    # log MIDI between the desktop editor and the pedal (protocol notes)
```

Nothing under `src/protocol/`, `src/device/`, or `src/dsp/` imports React — so the same tested core
runs on the phone, in the Node tools, and in a web build.

## Run the app

```sh
npm install
npm run web             # renders in the browser via react-native-web (fastest to iterate)
npm run ports           # list CoreMIDI endpoints (find the WIDI Jack / MD1 name)
npm run ble-check       # Bluetooth latency + non-destructive write-path test
npm run ios:device      # LOCAL development build → installs to a tethered iPhone (no cloud)
npm run android         # LOCAL development build → installs to a connected Android device/emulator
npm run start           # Metro for the dev build (hot-reload JS + native MIDI)
```

**Expo Go won't work** — it can't load the `@motiz88/react-native-midi` native module. You need a
**local development build**: `npm run ios:device` compiles a binary on your Mac (no cloud, no EAS)
and installs it to a USB-tethered iPhone; after that `npm run start` gives hot reload _with_ native
MIDI. (First device build: set your Apple team once via `open ios/SansApp.xcworkspace` → Signing &
Capabilities.) Web uses the browser's Web MIDI (Chrome/Edge). See [docs/HARDWARE.md](docs/HARDWARE.md)
for pairing the WIDI Jack.

Shipping to the App Store is a plain [fastlane](https://fastlane.tools) setup (no EAS / paid
service) — see **[docs/RELEASE.md](docs/RELEASE.md)**.

## How it works

- `src/protocol/` — framework-free SysEx codec, 256-byte preset codec, parameter registry,
  settings/PC-map/`.p3b` codecs, IR + WAV codecs.
- `src/dsp/` — framework-free FFT, biquads, IR frequency-response, high-pass/EQ/IR generators.
- `src/device/` — transport abstraction, session/handshake, sync engine, librarian, pedal model.
- `src/state/`, `src/ui/` — framework-free zustand store + knob math (unit-tested in Node).
- `app/`, `src/components/`, `src/midi/` — the React Native surface (Expo).
- `tools/` — `emulate`, `probe`, `capture`, `replay`, `send`, `ports`, `ble-check`: the dev and
  hardware harness.
- `docs/` — **[PROTOCOL.md](docs/PROTOCOL.md)** (the MIDI protocol reference),
  [PARAM-MAP.md](docs/PARAM-MAP.md), [HARDWARE.md](docs/HARDWARE.md), [RELEASE.md](docs/RELEASE.md).

## Contributing

Contributions welcome — especially **protocol observations** from your own Elite. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

**GPL-3.0-only.** This keeps SansApp free and open for players forever — any distributed fork must
also be open source. See [LICENSE](LICENSE) and the contribution terms in
[CONTRIBUTING.md](CONTRIBUTING.md).
