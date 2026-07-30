# PBDR Elite MIDI protocol notes

Independent interoperability notes for the **Tech 21 SansAmp Programmable Bass Driver DI Elite**,
documented by observing the pedal's own MIDI and its factory data, for a device the author owns.
Nothing here is copied from Tech 21; it is observed behavior. This document is the durable artifact —
the app may come and go.

**Legend:** ✅ confirmed from data · 🤔 hypothesis (to verify in live capture) · ❓ unknown.

## Transport

- Pedal MIDI ports: **3.5 mm TRS Type A**, MIDI IN + MIDI OUT. ✅
- Ships with the **MD1 "MIDI Driver"** — a class-compliant USB‑C ↔ dual‑3.5 mm interface;
  on macOS it enumerates via CoreMIDI as `USB MIDI Driver` with no driver install. ✅
- MIDI IN accepts **Program Change** (OMNI by default) for preset recall. ✅ (manual)
- Continuous Controllers are **user-assignable**, so there is no fixed factory CC map. ✅ (manual)
- Editor↔pedal deep editing uses **SysEx**. ✅ (SysEx prefix, below)
- **Bluetooth confirmed** ✅ (2026-07-05): via a **CME WIDI Jack** the entire protocol runs over
  BLE MIDI — handshake, all 128 preset reads (checksums valid, byte-identical to the wired mirror),
  and the write+ack path, including the 267-byte long-SysEx dumps. Read round-trip ~250 ms, write
  ~210 ms over BLE. See `docs/HARDWARE.md`; test with `npm run probe` / `npm run ble-check`.

## SysEx framing ✅

```
F0   00 51 21   <command> [data …]   F7
^start  ^Tech 21 mfr id   ^body       ^end
```

Every message shares the shape `05 <sub> 0A <args…>` (`0x05` = "data" command, `0x0A` = fixed
marker). Big payloads carry a 256-byte body + a 2-byte 14-bit checksum. **100% of the captured
device SysEx decodes** (`test/messages.test.ts`). Full vocabulary (`src/protocol/messages.ts`):

| Dir       | Bytes                        | Meaning                                                                                                                                                                   |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app→pedal | `05 5F 0A`                   | **hello** — first thing the editor sends on connect ✅                                                                                                                    |
| app→pedal | `05 6A 0A <i>`               | request config block → pedal replies `05 6B …` ✅                                                                                                                         |
| app→pedal | `05 55 0A <i>`               | request data block → pedal replies `05 52 …` ✅                                                                                                                           |
| app→pedal | `05 5B 0A`                   | control, no reply (role 🤔)                                                                                                                                               |
| app→pedal | `05 40 0A <slot>`            | **read** preset → pedal replies `05 41 …` ✅                                                                                                                              |
| app→pedal | `05 23 0A <slot>`            | **recall** preset (loads it) → pedal replies `05 41 …` ✅                                                                                                                 |
| app→pedal | `05 50 0A <param> <value>`   | **set param** (the editor's live edit command) ✅                                                                                                                         |
| app→pedal | `05 20 0A <slot> <256> <ck>` | **write preset** → pedal acks `05 21` ✅                                                                                                                                  |
| pedal→app | `05 21 F7`                   | **write ack** (2-byte, no marker) ✅                                                                                                                                      |
| pedal→app | `05 51 0A <param> <value>`   | **param notify** (physical knob moved) ✅                                                                                                                                 |
| pedal→app | `05 41 0A <slot> <256> <ck>` | **preset dump** ✅                                                                                                                                                        |
| both      | `05 52 0A <i> <256> <ck>`    | data block — **bidirectional**: pedal reply _and_ app **settings write**; block `0x00` = Special Page Functions (P1–P9) as boolean bytes, block `0x02` = PC→preset map ✅ |
| both      | `05 6B 0A <i> <256> <ck>`    | config block (mostly text/space); app can write it too ✅                                                                                                                 |

The **hello** has two observed forms: the app sends the 3-byte `05 5F 0A`; the real pedal's dominant
reply on the wire is the **marker-less `05 5F F7`** — both decode as hello. Every other 2-byte body
`05 <sub> F7` is an **ack**: `05 21` (preset write), `05 53` (block write). The codec decodes all of
these; `decode()` never throws (unknown input → `{ kind: "unknown" }`).

**Additional message subs** (observed in captures; handled in the app but not part of the core
handshake):

| Bytes                          | Meaning                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `05 60 / 65 / 66 0A …`         | **user-IR upload** — begin / data-chunk / end (see [IR handling](#ir-handling-)) ✅ |
| `05 63 00 F7`, `05 61 F7`      | pedal **acks** an IR-upload begin (`63`) and end (`61`) ✅                          |
| `05 69 0A <a> <b>`             | **read an IR** back off the pedal → a `05 60/65/66` stream ✅                       |
| `05 56 0A <mode>` → `05 57 F7` | **factory reset** (mode 0 All / 1 Presets / 2 Settings) — destructive ✅            |
| `05 5A 0A`                     | no-arg control; seen triggering a **resync** (block + preset re-read) ✅            |

**Connect handshake** (captured, in order): `hello 5F` → `6A 00`→`6B` → `55 0F`→`52` → `55 03`→`52`
→ `55 00`→`52` → `control 5B` → `40 00`→`41` (reads preset 0). The emulator (`tools/emulate.ts`)
implements this.

### Two wire ids per control: read vs write differ ✅

Every parameter has one **index** (its identity). That index is what the pedal **notifies/reads** on
(`05 51`, and the read-back position in a preset dump). But the **live-set** id — the `<param>` byte
in an `05 50` set — is _not_ always the index:

- indices **`0x00`–`0x0F`** (the shallow main-panel knobs) set on the **same id** (identity);
- indices **`0x10`–`0x4D`** (the deep range) set on **index + 4**.

So Blend (index `0x47`) must be _set_ via `0x4B`; sending a set to `0x47` actually hits chorus-mod
(the old "Blend moved the chorus" bug). The notify/read path always uses the index. `liveSetId()` in
`params.ts` encodes this; it was the root cause of "reads back but won't write" for Blend, Auto
Filter, and the other deep controls.

**Param ids** (the `<param>` byte in `05 50/51`), mapped by turning each physical knob:

| Knob  | id     |     | Knob     | id                      |
| ----- | ------ | --- | -------- | ----------------------- |
| Drive | `0x05` |     | Presence | `0x04`                  |
| Low   | `0x06` |     | Blend    | `0x47` (set via `0x4B`) |
| Mid   | `0x0C` |     | Comp     | `0x0A`                  |
| High  | `0x07` |     | Level    | `0x00`                  |

**Red Zone controls** — these read/notify on the index; a live edit sets on index + 4:

| Ctrl   | index  | set id |     | Ctrl     | index  | set id |
| ------ | ------ | ------ | --- | -------- | ------ | ------ |
| Preamp | `0x01` | `0x01` |     | Ambiance | `0x08` | `0x08` |
| Filter | `0x3D` | `0x41` |     | Chorus   | `0x42` | `0x46` |
| Freq   | `0x0D` | `0x0D` |     | Ratio    | `0x19` | `0x1D` |
| Q      | `0x2F` | `0x33` |     |          |        |        |

(The earlier notes listed these as `0x41`/`0x46`/`0x1D`/`0x33` — those are the **set** ids, not the
indices; the +4 rule reconciles the two.)

**3-band parametric EQ (deep pages)** ✅: Low/Mid/High each have Gain/Freq/Q. Gain = the main
LOW/MID/HIGH knob; Freq/Q are deep params. `PARAMETRIC_EQ` in `params.ts`.

| Band | Gain   | Freq   | Q      | Freq range (taper) | Q range |
| ---- | ------ | ------ | ------ | ------------------ | ------- |
| Low  | `0x06` | `0x48` | `0x30` | 40–200 Hz (linear) | 0.5–2.0 |
| Mid  | `0x0C` | `0x0D` | `0x2F` | 200–2000 Hz (log)  | 0.5–2.0 |
| High | `0x07` | `0x49` | `0x31` | 1–8 kHz (linear)   | 0.1–1.4 |

Gain is **±12 dB** on all three. The app models the EQ as Low shelf · Mid bell · High shelf (classic
SansAmp topology); shelf-vs-bell isn't confirmed from a curve. Modelled in `src/dsp/eq.ts`; live on
the **Parametric EQ** screen (`app/eq.tsx`). Note **High Freq (index `0x49`) is set on `0x4D`** (the
+4 rule) — and `0x4D` is also the red-shift footswitch's notify id. Since High Freq has no physical
knob, a _notify_ of `0x4D` is unambiguously the footswitch, never High Freq.

**Compressor (deep page)** ✅: the main-panel **COMP knob (`0x0A`) is the compressor _threshold_**;
Ratio/Output/Attack/Release form a contiguous block, plus two toggles. `COMP_PARAMS` in `params.ts`.

| Control   | id     |     | Control   | id           |
| --------- | ------ | --- | --------- | ------------ |
| Threshold | `0x0A` |     | Release   | `0x1C`       |
| Ratio     | `0x19` |     | Auto Gain | `0x32` (0/1) |
| Output    | `0x1A` |     | Lookahead | `0x33` (0/1) |
| Attack    | `0x1B` |     |           |              |

The Compressor block (`0x19`–`0x1C`) Ratio sweeps 1:1→20:1 (compression); the separate **Expander
block** (`0x1D`–`0x20`, 1:1→1:16 downward expansion) supplies the noise **gate**'s ratio. **Unit
calibration** ✅ (read from EliteControl at each extreme + noon): Threshold `−0.5…−60 dB` linear
(raw 0 = Bypass); Ratio `1.0…20.0:1` linear; Output `−30…+18 dB` linear; Attack `1…100 ms` **log**;
Release `10…1000 ms` **log**. In `src/protocol/units.ts`.

**Ambience (deep page)** ✅: the main **AMBIANCE knob (`0x08`) is Level**; **Decay = `0x11`** (Reverb
Decay Time), **Time = `0x10`** (Reverb Room Size) — Echo / Echo Verb only. Types (from the panel):
Room, Hall, Spring, Plate, Chorus Verb, Echo, Echo Verb (no "Arena"). Selecting a **type live-sets a
bundle of 10 params** (indices `0x10, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x3A, 0x3B`) — it
does **not** write Reverb Mode (`0x39`) or the edit buffer. `AMBIENCE_BUNDLES` in
`src/protocol/ambience.ts`, `AMBIENCE_PARAMS` in `params.ts`.

**Auto Filter (deep page)** ✅: an **Enable** toggle (`0x3C`, defaults OFF); the red-zone **FILTER
knob (`0x3D`) is the filter _Level_**; **Attack = `0x3E`, Release = `0x3F`** (contiguous, panel
order). `AUTO_FILTER_PARAMS` in `params.ts`. **The FILTER is an envelope _auto-wah_** — Tech 21
documents it as "similar to the Mu-Tron III" (a resonant filter whose peak sweeps with playing
dynamics), distinct from a high-pass (which the pedal has no dedicated control for — use a custom IR).
Level = sweep depth/sensitivity, Attack/Release = envelope timing. **Unit calibration** ✅: Level is
**bipolar −100…+100 %** with the centre detent (raw 64) reading Bypass; Attack/Release are `0…100 %`
linear. In `src/protocol/units.ts`.

**Amp model & ambience type = live-set bundles, not index bytes** (from the app): neither is stored
as a single index. Selecting one **live-sets a bundle of individual params** via `05 50`. The amp
bundle is 8 voicing bytes at blob offsets `0x23, 0x24, 0x25, 0x26, 0x27, 0x2D, 0x4F, 0x62`
(`0x23/26/27` = preamp/presence/drive); every apply also live-sets **Buzz Q = 64** and **Crunch Q =
0**, and VT Bass / Para Driver additionally force **Mid → 0**. `AMP_BUNDLES` / `AMP_APPLY_FIXED` in
`src/protocol/amp.ts` — **all 10** models captured in one clean pass, anchor-verified. The pedal has
**10 amps** (Bass Driver, VT Bass, Para Driver, 1970s, 1980s, Flip, VT Stack, Blackface, British,
Shred) — **not 12**. The pedal **discards** edit-buffer (`05 20` to `0x7F`) writes, so the live-set
path is the one that sticks; a save then bakes the bytes into the preset blob. **IR select** is a
single param `0x0E`, value = IR number × 16 (SansAmp → `0x10`, Concert 2×15 → `0x50`) 🤔. Param
`0x13` = Reverb Extension Factor (range 2–5, the coarse ambience-family selector).

**Checksum** ✅: trailing 2 bytes of any 256-byte payload = the **14-bit sum** of those 256 bytes
(hi7 then lo7); e.g. sum 5711 → `2C 4F`. `checksum14()`. All 15 main/Red-Zone param ids, the
write-preset (`0x20`) and settings-write (`05 52`) commands are captured.

## Preset blob layout ✅

Each preset is a **256-byte** blob, identical on the wire and in EliteControl's `.dat` files.
Verified by byte-exact round-trip across all 128 factory presets (`test/preset.test.ts`) and by
cross-preset variance analysis.

| Offset | Len | Field                 | Notes                                                                                         |
| ------ | --- | --------------------- | --------------------------------------------------------------------------------------------- |
| `0x00` | 2   | Header/version        | constant `01 00` ✅                                                                           |
| `0x02` | 32  | Preset name           | space-padded ASCII (names live app-side; pedal shows only the slot number) ✅                 |
| `0x22` | ~   | Parameter block       | 7-bit bytes (all ≤ `0x7F`); active/varying `0x22`–`0x6B` ✅. Per-param offsets ✅ (see below) |
| `0x57` | 4   | IR pointer pairs      | two `(bank, index)` pairs — the per-preset IR7 / IR8 pointers; default `[64, 64]` ✅          |
| `0x6C` | 84  | Reserved              | `00` in every factory preset ✅                                                               |
| `0xC0` | 32  | User-IR name field    | space-padded ASCII, e.g. `VT_SPKR`, `PARA_SPKR`, `Limey5`; empty when unused ✅               |
| `0xE0` | 32  | IR data / levels tail | present only for IR-using presets ✅                                                          |

The **IR pointer pairs at `0x57`–`0x5A`** (observed in preset dumps): two `(bank, index)` pairs. The
per-preset IR **Mode** toggle chooses whether a preset uses bank 0/1 (its own per-preset IR7/IR8) or
bank 2 (the shared library); the factory bundle defaults both to `[64, 64]`. These are the read-back
positions of the "User IR 7/8 Preset (MSB/LSB)" params (indices `0x35`–`0x38`, blob offset = index +
`0x22`).

### Reads, edits & save semantics ✅/🤔

Probed directly against the pedal:

- **Reads (`05 40`) require the connect handshake first** ✅ — before `hello → blocks → 5B`, the
  pedal ignores `05 40`; after, it answers reads for any slot (0–127) and `0x7E`/`0x7F`.
- **`setParam` (`05 50`) changes the live sound but is _not_ reflected in read-backs** ✅ — reading a
  slot before/after a `05 50` is identical, and there's no auto-dump. So the editor keeps its own
  working copy of the blob (as EliteControl does), sends `05 50` for live audio, and builds a full
  blob from that working copy when it saves.
- **`0x7F` is program 127, not a magic "edit buffer."** Live-setting via `05 50` is how the sound
  changes; there is no `05 20` staging step that persists. **A save is:** build the 256-byte blob
  from the app's current state → `05 20` write it to the destination slot (acked `05 21`) → commit
  with **`05 50 0A 12 <slot>`** (`0x12` is a reserved SAVE-to-slot command id, `<value>` = the
  destination slot) → the pedal echoes a `05 41 <slot>` dump as confirmation (the app awaits it and
  re-sends the commit if it drops over BLE). `writePreset()` in `src/device/session.ts` rejects
  slots above `0x7D` — never save to `0x7E`/`0x7F`, because `0x12 = 0x7F` jumps the pedal to program 128. (The one observed exception is EliteControl's **captured IR import**, which does send
  `05 50 0A 12 7F` to commit an edit-buffer IR; its on-device semantics there are still being
  clarified — see [IR handling](#ir-handling-).)

**Blob offsets** ✅ were mapped by correlating each `paramId` in the captured `05 50` stream against
the byte that changed in EliteControl's saved `.dat`. The rule is uniform: **`blobOffset == index +
0x22`** — the main panel is the contiguous block `0x22`–`0x2F` ← index `0x00`–`0x0D`, and every deep
param follows the same rule (confirmed two ways: EliteControl's `05 41` decode loop maps `body[0x22 +
k]` → param `k` for `k = 0x00..0x49`, and a 128-preset oracle places every known toggle at its
predicted offset).

| Knob     | index  | offset |     | Knob     | index  | offset |
| -------- | ------ | ------ | --- | -------- | ------ | ------ |
| Level    | `0x00` | `0x22` |     | Comp     | `0x0A` | `0x2C` |
| Preamp   | `0x01` | `0x23` |     | Mid Freq | `0x0D` | `0x2F` |
| Presence | `0x04` | `0x26` |     | Mid      | `0x0C` | `0x2E` |
| Drive    | `0x05` | `0x27` |     | Ratio    | `0x19` | `0x3B` |
| Low      | `0x06` | `0x28` |     | Filter   | `0x3D` | `0x5F` |
| High     | `0x07` | `0x29` |     | Chorus   | `0x42` | `0x64` |
| Ambiance | `0x08` | `0x2A` |     | Blend    | `0x47` | `0x69` |

**Deep sub-params** (read back on the EQ / Chorus deep pages), same `index + 0x22` rule:

| Deep param | index  | offset |     | Deep param        | index  | offset |
| ---------- | ------ | ------ | --- | ----------------- | ------ | ------ |
| Mid Q      | `0x2F` | `0x51` |     | Chorus Mod Freq   | `0x43` | `0x65` |
| Low Q      | `0x30` | `0x52` |     | Chorus Mod Depth  | `0x44` | `0x66` |
| High Q     | `0x31` | `0x53` |     | Chorus Delay Size | `0x45` | `0x67` |
| Low Freq   | `0x48` | `0x6A` |     | Chorus Feedback   | `0x46` | `0x68` |
| High Freq  | `0x49` | `0x6B` |     |                   |        |        |

The compressor block, gate/expander, Auto-Filter Attack/Release, Ambience Decay/Time, IR Mode/Gain
toggles, and Preset Level are all mapped the same way — see `docs/PARAM-MAP.md` and `params.ts`.

## Config / data blocks ✅ (read live, 2026-07-03)

Read straight off the pedal via `tools/dump-blocks.ts` (config `05 6A`→`6B`, data `05 55`→`52`):

| Block           | Contents                                                                            |
| --------------- | ----------------------------------------------------------------------------------- |
| data `0x00`     | **Settings** — Special Page Functions as boolean bytes (`7f 00 00 01 …`) ✅         |
| data `0x01`     | **MIDI CC map** — 8 params → CC# (Drive/Low/Mid/High/Reverb/Gate/Filter/Level) ✅   |
| data `0x02`     | **128-entry PC → preset map** (identity `00 01 … 7F`) ✅                            |
| data `0x03`     | 256 B, 128 byte-pairs: even ~`0x2d` (flat), odd high-entropy — NOT a curve; role ❓ |
| data `0x0F`     | mostly zero, sparse ❓                                                              |
| data `0x10`     | a **preset blob** alias (`01 00 "Bass Driver" …`) ✅                                |
| config `0x6B/0` | 256 spaces — a blank text field (device label?) ❓                                  |

All checksums valid. Codec: `src/protocol/settings.ts`; session `readBlock`/`writeBlock`.

### Settings block 0 — byte map ✅ (2026-07-04)

Derived by capturing EliteControl change each Special Page Function + the settings screenshot. Two
anchors make it solid: **Tuner Frequency** `[8]` with **Hz = byte + 428** (12→440, the standard
reference; 17→445), and **Tuner Detune** `[10]` = `0/1/2` = none/b/bb.

| Byte   | Function            | Encoding                            | Confidence |
| ------ | ------------------- | ----------------------------------- | ---------- |
| `[0]`  | Current preset slot | 0–127 (loadCurrent)                 | strong     |
| `[8]`  | Tuner Frequency     | Hz = byte + 428                     | strong     |
| `[10]` | Tuner Detune        | 0=none 1=b 2=bb                     | strong     |
| `[5]`  | MIDI Channel        | raw channel # (0=OMNI)              | strong     |
| `[7]`  | Disengage All Pots  | 1 = disengaged (`[15]` its inverse) | strong     |
| `[1]`  | Patch Offset        | 0=1–128, 1=0–127                    | good       |
| `[17]` | MIDI Mapping        | 0/1                                 | good       |
| `[2]`  | Safe Level Mode     | 0/1                                 | good       |
| `[9]`  | MIDI CC Mode        | 0/1                                 | good       |
| `[16]` | Cabinet Bypass      | 0/1                                 | tentative  |
| `?`    | Preset Protection   | byte not isolated                   | ❓         |

> ⚠ **`[0]` is the pedal's current preset slot** (0–127), not a marker — `loadCurrent()` uses it to
> show the active preset on connect. The remaining single-byte functions still want a clean
> one-at-a-time re-capture before a write is fully trusted.

## Other observed messages

- **`05 56 0A <mode>` → `05 57 F7` = FACTORY RESET** ✅ (2026-07-06): **mode 0 = All, 1 = Presets,
  2 = Settings**; pedal acks `05 57`. ⚠ Destructive: Presets/All wipe stored presets.
- **`05 69 0A <a> <b>` → `05 60`/`05 65`/`05 66` stream** ✅ (2026-07-06): a **read** that returns
  data in the packed IR-chunk format (EliteControl reads the current IR this way).
- **`05 5A 0A` → (no reply)** ✅ (2026-07-04): a no-arg control, like `05 5B`. Seen followed by a
  full block+preset **re-read**, so likely a **resync/refresh** trigger.
- **Scratch/staging slots**: reads to slots `0x7D`, `0x7E`, `0x7F` (program 127) all answer — the
  desktop editor stages edits across these. The app never _saves_ to `0x7E`/`0x7F` (see above).

## IR handling ✅

The pedal has **8 cab (IR) slots**, read off the pedal at bank `a = 0x02`, `b = 0..7`
(`src/midi/irRead.ts`). The per-preset param `0x0E` selects (and morphs between) them:

- **Slots 1–6 are fixed factory cabs** (SansAmp, Fliptop, VT 8x10, Cali 2x15, Concert 2x15, Htke
  4x10). The app never writes them.
- **Slots 7 & 8 are user-pair slots.** Each pairs a **factory cab** (Voice 12L / Brit V30) with a
  **user IR**, and a **per-preset "IR Mode" toggle** (`0x28` slot 7, `0x29` slot 8; blob `0x4a`/
  `0x4b`) chooses which one plays. Each also has a **per-slot gain** (`0x2a`/`0x2b`, 0–127 ↦ ±12 dB
  linear). Uploading a custom IR fills the _user_ half — it does **not** overwrite the factory cab;
  flip IR Mode back to hear the factory cab again.

The IR library is a **global** store (a marker written to a slot survived a preset change); each
preset just points at a slot and carries its own IR-Mode/gain. Saving a preset (`05 20`) does not
carry sample data.

**User-IR upload transport** — a chunked, 7-bit-packed SysEx sequence, byte-faithful to
EliteControl's own **Import** (`src/midi/irUpload.ts`):

```
1. set the User-IR address FIRST   05 50 0A 39 <bank>   05 50 0A 3A <index>   (slot 7)
2. upload the edit-buffer IR        05 60 0A 00 7F 00 15 61 <packed…>   begin   → ack 05 63 00 F7
                                    05 65 0A <256 packed> ×9            chunks
                                    05 66 0A <remainder>                end     → ack 05 61 F7
3. persist                          05 50 0A 12 7F                      SAVE    → pedal echoes 05 41
```

The upload targets the **edit-buffer IR** via the header `[0x00, 0x7F]` (bank 0, index 0x7F), and the
**address set-ids are `0x39`/`0x3A` for slot 7** and **`0x3B`/`0x3C` for slot 8** (slot 8 follows the
+4 rule and is **inferred — pending a hardware capture**). The persist step `05 50 0A 12 7F` is the
one observed use of `0x12 = 0x7F` (see [save semantics](#reads-edits--save-semantics-)); on device it
commits the imported IR. The app confirm-retries this SAVE (a silently-dropped commit over BLE would
lose the IR while the UI says "saved").

> ⚠ **Do not write the raw IR-library bank directly** (`05 60` header `[0x02, slot-1]`). An earlier
> version did, and it could leave the pedal unable to finish the next connect handshake — a brick
> that persisted across a power-cycle and needed a factory reset (issue #37). The edit-buffer import
> above is the safe, proven path.

The payload is the **time-domain `.dat`, 7-bit packed**, with a 5-byte header (target slot) and a
3-byte trailer (`00` + a 14-bit sum of the packed bytes). The `.dat` is `01 00` · gain (u16) ·
32-byte name · 2400 × int8 samples. The app generates and uploads custom IRs directly
(`src/protocol/irEncode.ts`, `src/midi/irUpload.ts`) — verified end-to-end on hardware over
Bluetooth — so **you can bake a high-pass into a cab and drop a standalone HPF pedal.** IR Studio
also exports a WAV. Verified on the Brit V30 factory cab: an 80 Hz 4th-order high-pass adds 21.4 dB
of cut at 40 Hz with the passband preserved to 0.00 dB (`app/ir.tsx`, `test/ir-studio.test.ts`).

The desktop editor's **MID FILTER** panel confirms Mid = a **parametric peak** (Gain dB · Frequency
Hz · Quality) — validates `src/dsp/eq.ts` (one capture: Gain −3.7 dB, 410 Hz, Q 1.1).

## `.p3b` bundle (export/backup) ✅ (2026-07-04)

EliteControl's **"export all presets and IRs"** writes a `.p3b` file that is simply a **concatenated
SysEx stream** — no container, no header. A real export decoded **100%** with our codec
(`bundle.ts`): **128 preset dumps (`05 41`)** + the user-IR upload sequences (`05 60`/`05 65`/
`05 66`). So the app can **read, write, and restore `.p3b`** byte-compatibly with EliteControl: back
up / share the whole pedal, and push user IRs by replaying their upload messages. Restore = each
`05 41` → a `05 20` write to its slot (slots above `0x7D` are skipped); IR chunks replayed as-is.
Codec + `restorePlan()` in `src/protocol/bundle.ts`.

## Program Change / banking ✅ (manual: PBDR_EL_OM2.pdf, read 2026-07-08)

- Two **front-panel modes**, but ONE storage area. **Performance mode = quick footswitch access to
  programs 1–3** (factory: SansAmp Bass Driver DI / VT Bass DI / Para Driver DI); **Studio mode =
  all 128 programs**. The 3 Performance presets **ARE programs 1–3** — not a separate bank. So over
  MIDI there is nothing mode-specific: Program Change `n` recalls program `n`, and our slots 0–2 are
  the Performance presets. Factory layout: 01–03 perf, 04–09 misc, 10–19 crispy, 20–29 crunchy,
  30–39 dirty, 40–49 effects, 50 & 100 bypass, 51–128 neutral.
- **Mode switch is a physical action** (footswitches Left+Right together) — no MIDI command for it in
  the manual. **Save is footswitch-only too**: Performance = tweak knobs → Save **once**; Studio =
  Save **twice**. The app doesn't press Save; it stores by writing the blob (`05 20`) to the slot and
  committing (`05 50 0A 12 <slot>`), which persists regardless of pedal mode.
- Red/Tuner footswitch: in **Performance** mode it toggles the preset's built-in chorus/filter; in
  **Studio** mode it engages the **Red Zone** editing layer (our `05 51 0A 4D` notify); hold in
  either mode = tuner (tuner emits nothing over MIDI).
- A `1–128` vs `0–127` offset option and optional PC→preset mapping table exist. 🤔 encoding.

## Selector encoding: amp model / ambience type / IR ✅

- **IR select = live param `0x0E`** (`05 50`) — a continuous 0–127 morph; the 8 factory IRs sit at
  raw `16/32/48/64/80/96/112/127`. Settable directly, like any knob.
- **Amp model and ambience type are param bundles, not a single index.** The app applies one by
  **live-setting each param in the bundle** (`05 50`, mapping index → set-id via the +4 rule) — the
  amp bundle plus its fixed Buzz Q / Crunch Q (and Mid → 0 for VT Bass / Para Driver); the ambience
  bundle of 10 params. **The pedal discards edit-buffer (`05 20` to `0x7F`) writes**, so the app does
  no edit-buffer write anywhere — the live-set path is what changes the sound, and a save bakes the
  resulting bytes into the preset blob.
- Clean, _labelled_ per-engine ambience bundles were captured one at a time; a couple of profile
  bytes are not yet individually named (see open questions).

## Real-hardware validation ✅ (2026-07-03)

The framework-free codec + `DeviceSession` were run directly against the pedal over the MD1
(`tools/probe-hardware.ts`, READ-ONLY — hello, block requests, `05 40` reads only):

- Connect **handshake completes** against real hardware → state `ready`.
- **All 128 stored presets read; 128/128 checksums valid.**
- **128/128 wire blobs are byte-identical to EliteControl's `.dat` mirror** on disk — proves the
  256-byte preset codec + 14-bit checksum + SysEx framing are byte-perfect vs the device.
- Handshake returns 4 blocks, all checksums OK: `6B` idx 0 (spaces/text), `52` idx `0F` (zeros),
  `52` idx 3 (binary — role ❓), `52` idx 0 = **the settings block** (matches the documented P1–P9
  layout).

## Resolved ✅

Handshake + checksum; `setParam`/`recall`/`read`/`write` (`0x20`) commands; the numbered-slot
**save** (`05 20` write + `05 50 0A 12 <slot>` commit + `05 41` echo); `paramNotify`; preset-dump
framing; **all 15 knob param ids** (8 main + 7 Red Zone) and the read-vs-write (+4) rule; blob
offsets for every mapped param (`= index + 0x22`); the **settings write** command (`05 52` block
write, ack `05 53`); amp/ambience selection = live-set param bundles; IR select = param `0x0E`;
user-IR upload transport + payload.

## Open questions ❓

1. **Expression-pedal / footswitch / jack configuration** (`0x6D`–`0x96`): PEDAL1/2, SWITCHA/B 1/2,
   JACK 1/2 — enums + controller assignments, observed but not labelled.
2. **MIDI / global config** (`0x59`–`0x64`): the param↔settings-block-byte mapping for Define
   Mapping, Thru, Patch Offset, CC Mode/Channel, Pot Display, Tuner Freq/Detune, Cabinet Bypass, Safe
   Level — do a clean one-at-a-time P1→P9 pass to label each byte.
3. **Data block `0x03`** — 128 byte-pairs, role unknown.
4. Role of the no-arg **`05 5B`** control message.
5. **Reverb Mode `0x39`** — a 0–4 Room/Hall/Arena/Spring/Plate selector the ambience picker does
   _not_ use; when (if ever) it applies is unclear.
6. **IR playback rate & gain** — pin the exact playback sample rate so a designed high-pass corner
   lands on an exact Hz, and calibrate custom-IR loudness against the factory cabs.

New protocol findings should ship with a scrubbed capture fixture and a decode/round-trip test under
`test/` (rising-coverage ratchet); see `docs/CAPTURE-PLAYBOOK.md`.
