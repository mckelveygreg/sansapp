# PBDR Elite MIDI protocol notes

Independent interoperability notes for the **Tech 21 SansAmp Programmable Bass Driver
DI Elite**, documented by observing the pedal's own MIDI and its factory data, for a device the author owns. Nothing here is copied from Tech 21;
it is observed behavior. This document is the durable artifact â the app may come and go.

**Legend:** â confirmed from data Â· ð¤ hypothesis (to verify in live capture) Â· â unknown.

## Transport

- Pedal MIDI ports: **3.5 mm TRS Type A**, MIDI IN + MIDI OUT. â
- Ships with the **MD1 "MIDI Driver"** â a class-compliant USBâC â dualâ3.5 mm interface;
  on macOS it enumerates via CoreMIDI as `USB MIDI Driver` with no driver install. â
- MIDI IN accepts **Program Change** (OMNI by default) for preset recall. â (manual)
- Continuous Controllers are **user-assignable**, so there is no fixed factory CC map. â (manual)
- Editorâpedal deep editing uses **SysEx**. â (SysEx prefix, below)
- **Bluetooth confirmed** â (2026-07-05): via a **CME WIDI Jack** the entire protocol runs over
  BLE MIDI â handshake, all 128 preset reads (checksums valid, byte-identical to the wired mirror),
  and the write+ack path, including the 267-byte long-SysEx dumps. Read round-trip ~250 ms, write
  ~210 ms over BLE. See `docs/HARDWARE.md`; test with `npm run probe` / `npm run ble-check`.

## SysEx framing â

```
F0   00 51 21   <command> [data â¦]   F7
^start  ^Tech 21 mfr id   ^body       ^end
```

Every message shares the shape `05 <sub> 0A <argsâ¦>` (`0x05` = "data" command, `0x0A` = fixed
marker). Big payloads carry a 256-byte body + a 2-byte 14-bit checksum. **100% of the captured
device SysEx decodes** (`test/messages.test.ts`). Full vocabulary (`src/protocol/messages.ts`):

| Dir       | Bytes                        | Meaning                                                                                                                                                                  |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| appâpedal | `05 5F 0A`                   | **hello** â first thing the editor sends on connect â                                                                                                                    |
| appâpedal | `05 6A 0A <i>`               | request config block â pedal replies `05 6B â¦` â                                                                                                                        |
| appâpedal | `05 55 0A <i>`               | request data block â pedal replies `05 52 â¦` â                                                                                                                          |
| appâpedal | `05 5B 0A`                   | control, no reply (role ð¤)                                                                                                                                              |
| appâpedal | `05 40 0A <slot>`            | **read** preset â pedal replies `05 41 â¦` â                                                                                                                             |
| appâpedal | `05 23 0A <slot>`            | **recall** preset (loads it) â pedal replies `05 41 â¦` â                                                                                                                |
| appâpedal | `05 50 0A <param> <value>`   | **set param** (the editor's live edit command) â                                                                                                                         |
| appâpedal | `05 20 0A <slot> <256> <ck>` | **write preset** â pedal acks `05 21` â                                                                                                                                  |
| pedalâapp | `05 21 F7`                   | **write ack** (2-byte, no marker) â                                                                                                                                      |
| pedalâapp | `05 51 0A <param> <value>`   | **param notify** (physical knob moved) â                                                                                                                                 |
| pedalâapp | `05 41 0A <slot> <256> <ck>` | **preset dump** â                                                                                                                                                        |
| both      | `05 52 0A <i> <256> <ck>`    | data block â **bidirectional**: pedal reply _and_ app **settings write**; block `0x00` = Special Page Functions (P1âP9) as boolean bytes, block `0x02` = PCâpreset map â |
| both      | `05 6B 0A <i> <256> <ck>`    | config block (mostly text/space); app can write it too â frame                                                                                                           |

**Connect handshake** (captured, in order): `hello 5F` â `6A 00`â`6B` â `55 0F`â`52` â `55 03`â`52`
â `55 00`â`52` â `control 5B` â `40 00`â`41` (reads preset 0). The emulator (`tools/emulate.ts`)
implements this.

**Param ids** (the `<param>` byte in `05 50/51`), mapped by turning each physical knob; a different
address space from the blob offset. Note Blend's outlier id `0x47`.

| Knob  | id     |     | Knob     | id     |
| ----- | ------ | --- | -------- | ------ |
| Drive | `0x05` |     | Presence | `0x04` |
| Low   | `0x06` |     | Blend    | `0x47` |
| Mid   | `0x0C` |     | Comp     | `0x0A` |
| High  | `0x07` |     | Level    | `0x00` |

**Red Zone param ids** (engage Red Zone, turn each knob):

| Ctrl   | id     |     | Ctrl     | id     |
| ------ | ------ | --- | -------- | ------ |
| Preamp | `0x01` |     | Ambiance | `0x08` |
| Filter | `0x41` |     | Chorus   | `0x46` |
| Freq   | `0x0D` |     | Ratio    | `0x1D` |
| Q      | `0x33` |     |          |        |

**3-band parametric EQ (deep pages)** â (2026-07-05): Low/Mid/High each have Gain/Freq/Q. Gain =
the main LOW/MID/HIGH knob; Freq/Q are deep params (the Q ids are consecutive `0x33`/`0x34`/`0x35`).
`PARAMETRIC_EQ` in `params.ts`.

| Band | Gain   | Freq   | Q      | Freq range (taper) | Q range |
| ---- | ------ | ------ | ------ | ------------------ | ------- |
| Low  | `0x06` | `0x4C` | `0x34` | 40â200 Hz (linear) | 0.5â2.0 |
| Mid  | `0x0C` | `0x0D` | `0x33` | 200â2000 Hz (log)  | 0.5â2.0 |
| High | `0x07` | `0x4D` | `0x35` | 1â8 kHz (linear)   | 0.1â1.4 |

Gain is **Â±12 dB** on all three. (Mid Freq/Q blob offsets are `0x2F`/`0x51`; this corrected the
earlier physical-pass guess of Freq `0x0B` / Q `0x31` and resolved the old Q/Blend confusion â Q is
`0x33`, not `0x31`. Blend still unconfirmed â its sweeps emitted `0x4B`.) The app models the EQ as
Low shelf Â· Mid bell Â· High shelf (classic SansAmp topology); shelf-vs-bell isn't confirmed from a
curve. Modelled in `src/dsp/eq.ts`; live on the **Parametric EQ** screen (`app/eq.tsx`).

**Compressor (deep page) param ids** â (2026-07-05): the main-panel **COMP knob (`0x0A`) is the
compressor _threshold_**; the rest form a contiguous block plus two toggles:

| Control   | id     |     | Control   | id           |
| --------- | ------ | --- | --------- | ------------ |
| Threshold | `0x0A` |     | Release   | `0x20`       |
| Ratio     | `0x1D` |     | Auto Gain | `0x36` (0/1) |
| Output    | `0x1E` |     | Lookahead | `0x37` (0/1) |
| Attack    | `0x1F` |     |           |              |

`COMP_PARAMS` in `params.ts`; the Compressor page sends these live. **Unit calibration** â
(2026-07-05, read from EliteControl at each extreme + noon): Threshold `â0.5â¦â60 dB` linear (raw 0 =
Bypass); Ratio `1.0â¦20.0:1` linear; Output `â30â¦+18 dB` linear; Attack `1â¦100 ms` **log**; Release
`10â¦1000 ms` **log**. In `src/protocol/units.ts`.

**Ambience (deep page) param ids** â (2026-07-05): the main **AMBIANCE knob (`0x08`) is Level**;
**Decay = `0x15`**, **Time = `0x14`** (Echo / Echo Verb only). Types (from the panel): Room, Hall,
Spring, Plate, Chorus Verb, Echo, Echo Verb (no "Arena"). Selecting a **type is a param bundle** â
blob offsets `0x32`, `0x34`â`0x3A`, `0x5C`, `0x5D`, `0x5F`. **All 7 captured** (labelled, one at a
time) â `AMBIENCE_BUNDLES` in `src/protocol/ambience.ts`; the Ambience screen applies a type by
reading the edit buffer, patching those bytes, and writing it back (`05 20` to `0x7F`).
`AMBIENCE_PARAMS` in `params.ts`.

**Auto Filter (deep page) param ids** â (2026-07-05): the red-zone **FILTER knob (`0x41`) is the
filter _Level_**; **Attack = `0x42`, Release = `0x43`** (contiguous, panel order). `AUTO_FILTER_PARAMS`
in `params.ts`; the Auto Filter page sends these live. **The FILTER is an envelope _auto-wah_** â
Tech 21 documents it as "similar to the Mu-Tron III" (a resonant filter whose peak sweeps with
playing dynamics), distinct from a high-pass (which the pedal has no dedicated control for â use a
custom IR). Level = sweep depth/sensitivity, Attack/Release = envelope timing. **Unit calibration**
â (2026-07-05): Level is **bipolar â100â¦+100 %** with the centre detent (raw 64) reading Bypass;
Attack/Release are `0â¦100 %` linear. In `src/protocol/units.ts`.

**Selectors** (from the app): the **amp model** and **reverb/ambience type** are **not** stored
as an index â selecting one rewrites a _bundle_ of param bytes via a `05 20` edit-buffer write.
**Amp bundle** = 8 bytes at offsets `0x23, 0x24, 0x25, 0x26, 0x27, 0x2D, 0x4F, 0x62` (`0x23/26/27`
= preamp/presence/drive; the amp sets a base voicing). Captured 2026-07-05: `AMP_BUNDLES` in
`src/protocol/amp.ts` â **all 10** models, in one clean single-capture pass, anchor-verified. The
pedal has **10 amps** (Bass Driver, VT Bass, Para Driver, 1970s, 1980s, Flip, VT Stack, Blackface,
British, Shred) â **not 12**; `amp-blond.png`/`amp-leeds.png` ship in resources but aren't exposed.
Apply = read edit buffer, patch, write back (like ambience). â  Capture gotcha: **run exactly one
capture tool** â duplicate capture instances (same virtual-port name) return stale reads and mislabel
bundles; a mid-capture reconnect shifts the writeâclick alignment. **IR select** _is_ a single param
`0x0E`, value = IR number Ã 16 (SansAmp â `0x10`, Concert 2Ã15 â `0x50`) ð¤. Param `0x13` = Reverb Extension Factor (2–5 semitones).

**Checksum** â: trailing 2 bytes of any 256-byte payload = the **14-bit sum** of those 256 bytes
(hi7 then lo7); e.g. sum 5711 â `2C 4F`. `checksum14()`. Slots `0x7E`/`0x7F` in dumps â edit
buffers. Remaining unknowns: Q/Blend blob offsets, the exact settings-byte labels, and the `5B`
role. (Write-preset `0x20`, all 15 Red Zone/main param ids, and the settings write command via
`05 52` are now captured.)

## Preset blob layout â

Each preset is a **256-byte** little blob, identical on the wire and in EliteControl's
`.dat` files. Verified by byte-exact round-trip across all 128 factory presets
(`test/preset.test.ts`) and by cross-preset variance analysis.

| Offset | Len | Field                 | Notes                                                                                        |
| ------ | --- | --------------------- | -------------------------------------------------------------------------------------------- |
| `0x00` | 2   | Header/version        | constant `01 00` â                                                                           |
| `0x02` | 32  | Preset name           | space-padded ASCII (names live app-side; pedal shows only the slot number) â                 |
| `0x22` | ~   | Parameter block       | 7-bit bytes (all â¤ `0x7F`); active/varying `0x22`â`0x6B` â. Per-param offsets â (see below) |
| `0x6C` | 84  | Reserved              | `00` in every factory preset (likely user-IR area) â                                         |
| `0xC0` | 32  | Selected-IR name      | space-padded ASCII, e.g. `VT_SPKR`, `PARA_SPKR`, `Limey5`; empty when unused â               |
| `0xE0` | 32  | IR data / levels tail | present only for IR-using presets â                                                          |

Notable fixed bytes inside the param block (constant across all 128 factory presets, so
**not** per-preset knobs): `0x40=64`, `0x43/44/45=64` (centered bipolar controls?),
`0x3D=15 0x3E=18 0x3F=103 0x41=9 0x42=18 0x47=57 0x48=10`. Many `0x40` (=64) values
elsewhere are center detents for bipolar knobs. â

### Reads, edits & buffer semantics â/ð¤

Probed directly against the pedal (`autonomous, edit-buffer only`):

- **Reads (`05 40`) require the connect handshake first** â â before `hello â blocks â 5B`, the
  pedal ignores `05 40`; after, it answers reads for any slot (0â127) and `0x7E`/`0x7F`.
- **`setParam` (`05 50`) changes the live sound but is _not_ reflected in read-backs** â â reading
  `0x7F` before/after a `05 50` is identical, and there's no auto-dump. So the editor must keep its
  own working copy of the blob (as EliteControl does), send `05 50` for live audio, and `05 20` to
  persist.
- **`05 20` writes are acked with `05 21`** â, but a write to `0x7F` didn't change what reading
  `0x7F` returns â so `0x7E`/`0x7F` read semantics vs the write target need more study ð¤. Writing
  to a stored slot (0â127) was **not** tested (would overwrite real presets).
- **Blob offsets mapped via EliteControl's `.dat` save** â (2026-07-03). Since `05 50` isn't
  reflected in reads, the winning method was: edit many knobs in EliteControl, let it **save**
  (it writes a 256-byte `.dat` reflecting the full edit state â the app's own model, _not_ a
  `05 20` to the pedal, which never fired), then for each `paramId` in the captured `05 50`
  stream find the changed blob byte whose value equals that knob's final value. The main panel
  is a **contiguous block: `blobOffset == paramId + 0x22`** (`0x22`â`0x2F` â paramId `0x00`â`0x0D`),
  every edited byte matching exactly. Effect-region knobs are scattered and mapped individually.

  | Knob     | paramId | offset |     | Knob     | paramId | offset |
  | -------- | ------- | ------ | --- | -------- | ------- | ------ |
  | Level    | `0x00`  | `0x22` |     | Comp     | `0x0A`  | `0x2C` |
  | Preamp   | `0x01`  | `0x23` |     | Mid Freq | `0x0D`  | `0x2F` |
  | Presence | `0x04`  | `0x26` |     | Mid      | `0x0C`  | `0x2E` |
  | Drive    | `0x05`  | `0x27` |     | Ratio    | `0x1D`  | `0x3B` |
  | Low      | `0x06`  | `0x28` |     | Filter   | `0x41`  | `0x5F` |
  | High     | `0x07`  | `0x29` |     | Chorus   | `0x46`  | `0x64` |
  | Ambiance | `0x08`  | `0x2A` |     | Blend    | `0x4B`  | `0x69` |

  All 15 above confirmed. Main panel is the proven contiguous block `blobOffset == paramId + 0x22`.

  **Deep sub-params** â blob offsets recovered 2026-07-07 by correlating deep `05 50` setParam values
  against EliteControl's `05 20` edit-buffer blobs, validated by contiguous blocks:

  | Deep param | paramId | offset |     | Deep param        | paramId | offset |
  | ---------- | ------- | ------ | --- | ----------------- | ------- | ------ |
  | Mid Q      | `0x33`  | `0x51` |     | Chorus Mod Freq   | `0x47`  | `0x65` |
  | Low Q      | `0x34`  | `0x52` |     | Chorus Mod Depth  | `0x48`  | `0x66` |
  | High Q     | `0x35`  | `0x53` |     | Chorus Delay Size | `0x49`  | `0x67` |
  | Low Freq   | `0x4C`  | `0x6A` |     | Chorus Feedback   | `0x4A`  | `0x68` |
  | High Freq  | `0x4D`  | `0x6B` |     |                   |         |        |

  These are decoded from presets (EQ + Chorus deep pages read them back). Note `0x4D` (High Freq,
  set-only) shares its raw id with the red "shift" footswitch's `05 51` notify â the app ignores the
  notify so a footswitch press can't jog High Freq.

  **Still unmapped** (didn't correlate â need a targeted capture): Comp outputGain/attack/release/
  autoGain/lookahead, Auto Filter attack/release, Ambience decay/time, IR select `0x0E` (candidate
  blob `0x30`, ~94%, unconfirmed). Also `0x13` = Reverb Extension Factor.

- Amp/ambience selection = param **bundles** (no index); IR select = param `0x0E`. â/ð¤

## Config / data blocks â (read live, 2026-07-03)

Read straight off the pedal via `tools/dump-blocks.ts` (config `05 6A`â`6B`, data `05 55`â`52`):

| Block           | Contents                                                                           |
| --------------- | ---------------------------------------------------------------------------------- |
| data `0x00`     | **Settings** â Special Page Functions as boolean bytes (`7f 00 00 01 â¦`) â        |
| data `0x01`     | **MIDI CC map** â 8 params â CC# (Drive/Low/Mid/High/Reverb/Gate/Filter/Level) â   |
| data `0x02`     | **128-entry PC â preset map** (identity `00 01 â¦ 7F`) â                           |
| data `0x03`     | 256 B, 128 byte-pairs: even ~`0x2d` (flat), odd high-entropy â NOT a curve; role â |
| data `0x0F`     | mostly zero, sparse â                                                              |
| data `0x10`     | a **preset blob** alias (`01 00 "Bass Driver" â¦`) â                               |
| config `0x6B/0` | 256 spaces â a blank text field (device label?) â                                  |

All checksums valid. Codec: `src/protocol/settings.ts`; session `readBlock`/`writeBlock`.

### Settings block 0 â byte map â (2026-07-04)

Derived by capturing EliteControl change each Special Page Function + the settings screenshot.
Byte `[0]=0x7F` marker, `[6]=0x02` and `[11..13]=0x40` constant. Two anchors make it solid:
**Tuner Frequency** `[8]` with **Hz = byte + 428** (12â440, the standard reference; 17â445), and
**Tuner Detune** `[10]` = `0/1/2` = none/b/bb.

| Byte   | Function           | Encoding               | Confidence |
| ------ | ------------------ | ---------------------- | ---------- |
| `[8]`  | Tuner Frequency    | Hz = byte + 428        | strong     |
| `[10]` | Tuner Detune       | 0=none 1=b 2=bb        | strong     |
| `[5]`  | MIDI Channel       | raw channel # (0=OMNI) | strong     |
| `[4]`  | Disengage All Pots | 0/1                    | strong     |
| `[1]`  | Patch Offset       | 0=1â128, 1=0â127       | good       |
| `[17]` | MIDI Mapping       | 0/1                    | good       |
| `[2]`  | Safe Level Mode    | 0/1                    | good       |
| `[7]`  | MIDI Thru          | 0/1                    | good       |
| `[9]`  | MIDI CC Mode       | 0/1                    | good       |
| `[16]` | Cabinet Bypass     | 0/1                    | tentative  |
| `?`    | Preset Protection  | byte not isolated      | â          |

> â  **Corrections (2026-07-06, clean single-toggle capture).** The table above came from a muddled
> multi-toggle pass and has errors. Confirmed clean:
>
> - **`[0]` = the pedal's current preset slot** (0â127), NOT a `0x7F` marker (the old `0x7F` was just
>   preset 127 being loaded). `loadCurrent()` uses this to show the active preset on connect.
> - **Disengage All Pots = `[7]`** (1 = disengaged), with **`[15]` its inverse** (engaged flag) â a
>   correct write sets both (`withDisengagePots`). This means the old `[7]=MIDI Thru` / `[4]=Disengage`
>   rows are wrong; the whole map needs a clean one-at-a-time re-capture before trusting a write.

## Other observed messages

- **`05 56 0A <mode>` â `05 57 F7` = FACTORY RESET** â (2026-07-06): **mode 0 = All, 1 = Presets,
  2 = Settings**; pedal acks `05 57`. (Corrects the earlier "editor mode / commit" guess â confirmed
  by capturing all three Reset-to-Factory buttons.) â  Destructive: Presets/All wipe stored presets.
- **`05 69 0A <a> <b>` â `05 60`/`05 65`/`05 66` stream** â (2026-07-06): a **read** that returns
  data in the packed IR-chunk format (EliteControl reads the current IR this way).
- **`05 5A 0A` â (no reply)** â (2026-07-04): a no-arg control, like `05 5B`. Seen followed by a
  full block+preset **re-read**, so likely a **resync/refresh** trigger.
- **Multiple scratch buffers**: reads/writes to slots `0x7D`, `0x7E` ("inbetween"), `0x7F` (edit
  buffer) all work â the editor stages edits across these before a save.

## IR handling â

The pedal has **8 cab (IR) slots** (`0x0E` selects among them, continuous / morphable): **Off,
1â6 factory** (SansAmp, Fliptop, VT 8x10, Cali 2x15, Concert 2x15, Htke 4x10), and **7â8 writable**.
The cab data in a slot is a global library entry (shared across presets); each preset stores which
slot it uses. For the two writable slots there is also a **per-preset "IR Mode" enable** (`0x28`
slot 7, `0x29` slot 8; preset blob `0x4a`/`0x4b`) and a **per-slot gain** (`0x2a`/`0x2b`, 0â127 â¦
Â±12 dB). Saving a preset (`05 20`) does not carry sample data.

**User-IR upload transport** â a chunked, 7-bit-packed SysEx sequence:

```
appâpedal  05 60 0A <a> <b> 00 15 61 <packedâ¦>   begin (5-byte header = target slot + first chunk)
                                                  â pedal acks 05 63 00 F7
appâpedal  05 65 0A <256 packed> Ã9               data chunks (~100 ms apart)
appâpedal  05 66 0A <remainder>                   final chunk â pedal acks 05 61 F7
appâpedal  05 50 0A 12 7F                         SAVE/commit â pedal echoes a preset dump â
```

The payload is the **time-domain `.dat`, 7-bit packed**, with a 5-byte header carrying the target
slot (`<a> <b> 00 15 61`) and a **3-byte trailer** (`00` + a 14-bit sum of the packed bytes, split
MSB-first). The `.dat` is `01 00` Â· gain (u16) Â· 32-byte name Â· 2400 Ã int8 samples. `0x12`=127
persists the slot to non-volatile memory (the pedal confirms with a `05 41` dump). The app generates
and uploads custom IRs directly over MIDI (`src/protocol/irEncode.ts`, `src/midi/irUpload.ts`) â
verified end-to-end on hardware over Bluetooth â so **you can bake a high-pass into a cab and drop a
standalone HPF pedal.** IR Studio also exports a WAV if you want a copy. Verified on the Brit V30
factory cab: an 80 Hz 4th-order high-pass adds 21.4 dB of cut at 40 Hz with the passband preserved
to 0.00 dB (`app/ir.tsx`, `test/ir-studio.test.ts`).

The main-view IR graph is labelled **"CLICK HERE TO EDIT IMPULSE RESPONSE"** â clicking opens
EliteControl's IR chooser/editor (the list above + response view). The **MID FILTER** panel
confirms Mid = a **parametric peak** (Gain dB Â· Frequency Hz Â· Quality) â validates `src/dsp/eq.ts`
(e.g. one capture: Gain â3.7 dB, 410 Hz, Q 1.1 â useful for calibrating the freq/Q knob mapping).

## `.p3b` bundle (export/backup) â (2026-07-04)

EliteControl's **"export all presets and IRs"** writes a `.p3b` file that is simply a **concatenated
SysEx stream** â no container, no header. A real export decoded **100%** with our codec (`bundle.ts`):
**128 preset dumps (`05 41`)** + the user-IR upload sequences (`05 60`/`05 65`/`05 66`). So the app
can **read, write, and restore `.p3b`** byte-compatibly with EliteControl: back up / share the whole
pedal, and **push user IRs by replaying their upload messages verbatim** â the app can also generate them directly (see "IR handling"). Restore = each `05 41` â a `05 20` write to its slot; IR chunks replayed
as-is. Codec + `restorePlan()` in `src/protocol/bundle.ts`.

## Program Change / banking â (manual: PBDR_EL_OM2.pdf, read 2026-07-08)

- Two **front-panel modes**, but ONE storage area. **Performance mode = quick footswitch access to
  programs 1â3** (factory: SansAmp Bass Driver DI / VT Bass DI / Para Driver DI); **Studio mode =
  all 128 programs**. The 3 Performance presets **ARE programs 1â3** â not a separate bank. So over
  MIDI there is nothing mode-specific: Program Change `n` recalls program `n`, and our slots 0â2 are
  the Performance presets. Factory layout: 01â03 perf, 04â09 misc, 10â19 crispy, 20â29 crunchy,
  30â39 dirty, 40â49 effects, 50 & 100 bypass, 51â128 neutral.
- **Mode switch is a physical action** (footswitches Left+Right together) â no MIDI command for it in
  the manual. **Save is footswitch-only too**: Performance = tweak knobs â Save **once**; Studio =
  Save **twice** (once selects a destination for move/copy, twice commits). The app doesn't press
  Save; it stores by writing the blob (`05 20`) to the slot, which persists regardless of pedal mode.
- Red/Tuner footswitch: in **Performance** mode it toggles the preset's built-in chorus/filter; in
  **Studio** mode it engages the **Red Zone** editing layer (our `05 51 0A 4D` notify); hold in
  either mode = tuner (tuner emits nothing over MIDI).
- A `1â128` vs `0â127` offset option and optional PCâpreset mapping table exist. ð¤ encoding.

## Selector encoding: ambience engine / amp model / IR â (proxy capture 2026-07-08)

Captured EliteControl over the WIDI bridge while clicking each selector
(`captures/selectors.jsonl`, analyzed with `replay --summary` / `--blobdiff`):

- **IR select = live param `0x0e`** (`05 50`) â a continuous 0â127 morph; the 8 factory IRs sit at
  raw `16/32/48/64/80/96/112/127`. Settable directly, like any knob.
- **Ambience engine and amp model are NOT single params.** Selecting one makes EliteControl rewrite
  the **edit buffer** â `05 20 0A 7F <256> <ck>` (all 18 selector writes targeted slot `0x7F`) â with
  that engine/model's byte _bundle_:
  - Ambience engine bundle: blob offsets `0x32, 0x34â0x3A, 0x5Câ0x5E`.
  - Amp model bundle: blob offsets `0x23â0x27, 0x2D, 0x4F, 0x62` (picking a model also loads its
    default preamp/presence/drive voicing).
  - No clean "type index" byte â the engine/model is defined by the whole coefficient bundle.
- **Implication:** to set an engine/model from the app, overlay the target bundle onto the current
  edit buffer and write `0x7F`. Clean, _labelled_ per-engine bundles still need one marker-tagged
  pass (this capture's ambience click order was ambiguous â no markers, plus a HallâRoom detour).
- Deep-knob param ids reconfirmed live: Gate Threshold `0x09`, Comp Ratio `0x1d`, Filter Attack
  `0x42`, Ambience Decay `0x15`. `0x13` = Reverb Extension Factor.

## Real-hardware validation â (2026-07-03)

The framework-free codec + `DeviceSession` were run directly against the pedal over the MD1
(`tools/probe-hardware.ts`, READ-ONLY â hello, block requests, `05 40` reads only):

- Connect **handshake completes** against real hardware â state `ready`.
- **All 128 stored presets read; 128/128 checksums valid.**
- **128/128 wire blobs are byte-identical to EliteControl's `.dat` mirror** on disk â proves the
  256-byte preset codec + 14-bit checksum + SysEx framing are byte-perfect vs the device.
- Handshake returns 4 blocks, all checksums OK: `6B` idx 0 (spaces/text), `52` idx `0F` (zeros),
  `52` idx 3 (binary: `2d 69 2e 56 32 1a 2f 35 â¦` â role â), `52` idx 0 = **the settings block**,
  live dump `7f 00 00 01 00 00 02 00 0c 00 00 40 40 40 00 00 â¦` (matches the documented P1âP9 layout).

This is a remote-verification result.

## Resolved â

Handshake + checksum; `setParam`/`recall`/`read`/**`write`(0x20)** commands; `paramNotify`;
preset-dump framing; **all 15 knob param ids** (8 main + 7 Red Zone); edit buffer = slot `0x7F`;
blob offsets for 13/15 knobs (main panel `= paramId + 0x22`); the **settings write** command
(`05 52` block write, ack `05 53`); amp/reverb selection = param bundles (no index); IR select =
param `0x0E`. Wire preset dumps carry the name bytes (full 256 B).

## Open questions â

1. Blob offsets for the last two knobs, **Q (`0x31`) and Blend (`0x47`)** â not moved in the
   2026-07-03 capture. Move both in EliteControl, let it save, re-run the `.dat`â`05 50`
   correlation. (Method + all other offsets: resolved above.)
2. Exact **IR-select** encoding beyond Ã16, and how the IR **name/data** (`0xC0`/`0xE0`) update.
3. ~~Contents/meaning of the `0x52` data blocks and the settings write command.~~ **Mechanism
   RESOLVED** â (2026-07-03): the `05 52`/`05 6B` block opcodes are **bidirectional** â the app
   **writes settings** by sending the whole block back, `05 52 0A <index> <256> <ck14>` (same
   checksum as presets; verified). Each **Special Page Function is one boolean byte in data
   block index `0x00`** â toggling a setting in EliteControl re-sends block 0 with a single byte
   flipped 0â1. Boolean bytes observed flipping (payload offsets): **1, 3, 10, 16, 17** (plus
   fixed structure: `[0]=0x7F`, `[6]=0x02`, `[7]=0x01`, `[8]=0x0C`, `[11..13]=0x40 0x40 0x40`).
   Block index `0x02` = the **MIDI Program-Change â preset map** (captured as identity `00 01 02
03 â¦`). **Still open:** the exact P#âbyte label map (the capture toggled several at once
   without a recorded order) â do a clean one-at-a-time P1âP9 pass to label each byte.
4. Role of the no-arg `05 5B 0A` control message; and whether `0x20` to a slot `< 0x7E`
   persistently saves (untested â avoid overwriting real slots).
5. User-IR **upload**: RESOLVED. Both the transport (`05 60`/`05 65`/`05 66`, 7-bit packed) and the payload are known: the payload is the time-domain `.dat` (2436 B = `01 00` . gain(u16) . 32-byte name . 2400 x int8 samples), packed with a slot-addressed 5-byte header and a 2-byte checksum trailer. The app generates and uploads custom IRs directly (see "IR handling" above and `src/protocol/irEncode.ts`). Remaining nicety: pin the exact playback sample rate so a designed high-pass corner lands on an exact Hz (the app uses a nominal rate; it is within a few percent on hardware).

Each answer should land with a linked capture fixture under `src/protocol/fixtures/`.
