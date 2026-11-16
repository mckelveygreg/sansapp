# PBDR Elite parameter map

Parameter reference for the SansAmp Programmable Bass Driver DI Elite. Each **wire id** is the
device's own parameter index — the byte carried in `05 51` (notify) and preset read-backs, with no
translation. The **panel knob** column names the knob printed on the pedal (and in the owner's
manual) that sends each id; `(RZ)` marks a Red Zone function. The **editor label** column is the
desktop editor's name, which often differs from the panel's (its "Punch" is the panel **Mid**, its
"Crunch" the panel **Presence**). The right column is how SansApp exposes each one. SansApp's ids and
labels follow the panel names.

The **wire ids** of all of SansApp's active mappings are **confirmed against hardware** (every id
verified by sending it and by watching the pedal's own notifications). **Which panel knob** sends an
id is a separate claim: `✓` = that knob's notify has been observed on hardware, `†` = attributed
from the owner's manual and the desktop editor's names but not yet observed. Ids with no panel knob
(e.g. the editor-only Parametric Mid `0x0c`/`0x0d`/`0x2f`, Buzz) are reachable only from an editor.
The Red Zone **Q** knob is unresolved: it was seen sending `0x2f` on firmware ≤ 1.1, but `0x2d`
(Mid Q) would pair it with FREQ (`0x0b`); SansApp keeps it on `0x2f` until that is re-checked on
firmware 1.2.

A control's **live-set id differs from its wire id
across the deep range**: indices `0x10`–`0x4D` are _set_ on wire id + 4 (see `liveSetId` in
`params.ts`), while the table below lists the notify/read ids. `0x4D` as a _notify_ is the pedal's
Red/Tuner footswitch — but it is also **High Freq's live-set id** (High Freq's own wire id is `0x49`).
On **firmware 1.1** that footswitch is an effects toggle (the owner's manual: "it engages your
pre-programmed effect"): engaging/disengaging it sets **Auto Filter enable (`0x3c`) and Chorus enable
(`0x41`) to 1/0 on the pedal** — with the ambience/reverb block following the same toggle audibly —
but the only message sent is the `0x4D <1|0>` notify itself, so SansApp mirrors both enables off that
notify (`RED_ZONE_TOGGLE_PARAMS` in `params.ts`). Firmware 1.0's switch only switched the knob bank.

The pedal also **derives** that Red Zone state for itself at the end of every preset load, as
`0x3c || 0x41 || 0x08` — Auto Filter enable **or** Chorus enable **or Ambiance** — engaged if any is
non-zero (`RED_ZONE_STATE_PARAMS` / `redZoneEngagedFor`). Two consequences worth knowing. First, a
preset load is the one moment the state is knowable without wire evidence, so SansApp reconciles its
indicator there rather than letting the notify drift. Second, **Ambiance is in that OR but is not one
of the params the footswitch force-sets**, so a preset carrying any Ambiance loads with the Red Zone
already engaged (red LED lit) and the _first_ press of the red switch **dis**engages — notifying
`4D 0` and forcing Auto Filter + Chorus off. It toggles normally after that. The state is not
re-derived once loaded: the footswitch overwrites it directly, so this holds at load time only.

⚠️ **Firmware 1.2 changed this derivation to `0x3c || 0x41`** — Ambiance no longer participates, so
the derived set now equals the set the footswitch force-sets and the first-press surprise above is
gone. The rule is therefore version-dependent: use `redZoneStateParamsFor(firmware)` rather than the
`RED_ZONE_STATE_PARAMS` constant, which stays the ≤ 1.1 set because that is the safe assumption when
the version is not yet known. This is the only known behavioural difference between 1.1 and 1.2;
everything else in 1.2 is the version byte itself.

`*` = ambience time/decay are engine-specific (captured on Echo / Echo Verb); other engines reuse
those indices for different controls.

|      wire | panel knob              | editor label                   | SansApp                                                                                                                                                             |
| --------: | ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|      0x00 | LEVEL ✓                 | Level                          | `level` / eq master                                                                                                                                                 |
|      0x01 | PREAMP (RZ) ✓           | Gain                           | `preamp`                                                                                                                                                            |
|      0x02 |                         | Buzz                           | `buzz` (amp page)                                                                                                                                                   |
|      0x03 | **MID** ✓               | Punch                          | `mid` "Mid" (editor + amp page)                                                                                                                                     |
|      0x04 | PRESENCE ✓              | Crunch                         | `presence`                                                                                                                                                          |
|      0x05 | DRIVE ✓                 | Drive                          | `drive`                                                                                                                                                             |
|      0x06 | LOW ✓                   | Low                            | `low` / eq.low.gain                                                                                                                                                 |
|      0x07 | HIGH ✓                  | High                           | `high` / eq.high.gain                                                                                                                                               |
|      0x08 | AMBIANCE (RZ) †         | Reverb                         | `ambiance` / amb.level                                                                                                                                              |
|      0x09 |                         | Gate                           | gate.threshold                                                                                                                                                      |
|      0x0a | COMP ✓                  | Dynamics                       | `comp` "Comp" (compressor threshold)                                                                                                                                |
|      0x0b | **FREQ** (RZ) ✓         | Punch Freq                     | `midFreq` "Mid Freq" (editor Red Zone + amp page)                                                                                                                   |
|      0x0c | — (editor-only)         | Mid                            | `paraMid` "Parametric Mid" / eq.paraMid.gain                                                                                                                        |
|      0x0d | — (editor-only)         | Mid Shift                      | `paraMidFreq` / eq.paraMid.freq                                                                                                                                     |
|      0x0e |                         | IR                             | `irBlend` — IR select/blend (0x0E)                                                                                                                                  |
|      0x0f |                         | AnalogSim                      | _roadmap_                                                                                                                                                           |
|      0x10 |                         | Reverb Room Size               | amb.time\*                                                                                                                                                          |
|      0x11 |                         | Reverb Decay Time              | amb.decay\*                                                                                                                                                         |
|      0x12 |                         | Reverb Diffusion               | _roadmap_                                                                                                                                                           |
|      0x13 |                         | Reverb Extension Factor        | _roadmap_ (ambience-family selector, 2–5)                                                                                                                           |
|      0x14 |                         | Reverb Fbk. Delay Size         | — (unexposed)                                                                                                                                                       |
|      0x15 |                         | Reverb Fbk. Filter             | — (unexposed)                                                                                                                                                       |
|      0x16 |                         | Reverb Fbk. Damper Factor      | _roadmap_                                                                                                                                                           |
|      0x17 |                         | Reverb LP Filter               | _roadmap_                                                                                                                                                           |
|      0x18 |                         | Reverb HP Filter               | _roadmap_                                                                                                                                                           |
|      0x19 | RATIO (RZ) †            | Compressor Ratio               | `ratio` / comp.ratio                                                                                                                                                |
|      0x1a |                         | Compressor Output Gain         | comp.outputGain                                                                                                                                                     |
|      0x1b |                         | Compressor Attack              | comp.attack                                                                                                                                                         |
|      0x1c |                         | Compressor Release             | comp.release                                                                                                                                                        |
|      0x1d |                         | Expander Ratio                 | gate.ratio (inferred)                                                                                                                                               |
|      0x1e |                         | Expander Output Gain           | _roadmap_                                                                                                                                                           |
|      0x1f |                         | Expander Attack                | _roadmap_                                                                                                                                                           |
|      0x20 |                         | Expander Release               | _roadmap_                                                                                                                                                           |
|      0x21 |                         | Soft Clipping                  | `softClip` (dynamics). When on, also engages a level-gated HF smoother: −24 dB high shelf at 8 kHz (Q 0.5) while program level is above ≈ −49 dBFS, flat in silence |
|      0x22 |                         | AnalogSim Gain                 | _roadmap_                                                                                                                                                           |
|      0x23 |                         | Anti-aliasing Filter           | _roadmap_                                                                                                                                                           |
|      0x24 |                         | Clean Input Level              | _roadmap_                                                                                                                                                           |
|      0x25 |                         | Compressor Ratio               | —                                                                                                                                                                   |
|      0x26 |                         | Gate Attack                    | `gateAttack` / gate.attack                                                                                                                                          |
|      0x27 |                         | Gate Release                   | gate.release                                                                                                                                                        |
|      0x28 |                         | IR Mode (slot 7)               | `irMode7` (IR page)                                                                                                                                                 |
|      0x29 |                         | IR Mode (slot 8)               | `irMode8` (IR page)                                                                                                                                                 |
|      0x2a |                         | User IR Gain (slot 7)          | `irGain7` (IR page, ±12 dB)                                                                                                                                         |
|      0x2b |                         | User IR Gain (slot 8)          | `irGain8` (IR page, ±12 dB)                                                                                                                                         |
|      0x2c |                         | Buzz Q                         | `buzzQ` (amp page)                                                                                                                                                  |
|      0x2d | Q (RZ)? — unresolved    | Punch Q                        | `midQ` "Mid Q" (amp page)                                                                                                                                           |
|      0x2e |                         | Crunch Q                       | `presenceQ` "Presence Q" (amp page)                                                                                                                                 |
|      0x2f | Q (RZ)? — seen fw ≤ 1.1 | Mid Q                          | `paraMidQ` / eq.paraMid.q; drives the editor Red Zone "Q" (`RED_ZONE_Q`)                                                                                            |
|      0x30 |                         | Low Q                          | `lowQ` / eq.low.q                                                                                                                                                   |
|      0x31 |                         | High Q                         | `highQ` / eq.high.q                                                                                                                                                 |
|      0x32 |                         | Auto Gain                      | comp.autoGain                                                                                                                                                       |
|      0x33 |                         | Lookahead                      | comp.lookahead                                                                                                                                                      |
|      0x34 |                         | Tuner                          | MUTE / BYPASS bar — `setTunerMode` (0 Off/1 Mute/2 Bypass; live-only, never in the blob)                                                                            |
|      0x35 |                         | User IR7 Preset MSB            | — (IR-upload address)                                                                                                                                               |
|      0x36 |                         | User IR7 Preset LSB            | — (IR-upload address)                                                                                                                                               |
|      0x37 |                         | User IR8 Preset MSB            | — (IR-upload address)                                                                                                                                               |
|      0x38 |                         | User IR8 Preset LSB            | — (IR-upload address)                                                                                                                                               |
|      0x39 |                         | Reverb Mode                    | _roadmap_                                                                                                                                                           |
|      0x3a |                         | Reverb Modulation Depth        | _roadmap_ (set by ambience type)                                                                                                                                    |
|      0x3b |                         | Reverb Modulation Rate         | _roadmap_ (set by ambience type)                                                                                                                                    |
|      0x3c |                         | Auto-Filter Enable             | `autoFilterOn`                                                                                                                                                      |
|      0x3d | FILTER (RZ) †           | Auto-Filter Level              | `filter` / af.level                                                                                                                                                 |
|      0x3e |                         | AF. Attack                     | af.attack                                                                                                                                                           |
|      0x3f |                         | AF. Release                    | af.release                                                                                                                                                          |
|      0x40 |                         | Preset Level                   | `presetLevel` (per-preset output; persisted)                                                                                                                        |
|      0x41 |                         | Chorus On                      | `chorusOn`                                                                                                                                                          |
|      0x42 | CHORUS (RZ) ✓           | Chorus Level                   | `chorus` / chorus.level                                                                                                                                             |
|      0x43 |                         | Chorus Mod Freq                | chorusModFreq                                                                                                                                                       |
|      0x44 |                         | Chorus Mod Depth               | chorusModDepth                                                                                                                                                      |
|      0x45 |                         | Chorus Delay Size              | chorusDelaySize                                                                                                                                                     |
|      0x46 |                         | Chorus Feedback                | chorusFeedback                                                                                                                                                      |
|      0x47 | BLEND †                 | Blend Level                    | `blend` (set via 0x4B)                                                                                                                                              |
|      0x48 |                         | Low Freq                       | `lowFreq` / eq.low.freq                                                                                                                                             |
|      0x49 |                         | High Freq                      | `highFreq` / eq.high.freq (set via 0x4D)                                                                                                                            |
|      0x4a |                         | — (unused)                     | —                                                                                                                                                                   |
|      0x4b |                         | — (unused)                     | —                                                                                                                                                                   |
|      0x4c |                         | — (unused)                     | —                                                                                                                                                                   |
|      0x4d | Red/Tuner footswitch ✓  | — (see note)                   | Red/Tuner footswitch notify (fw 1.1: toggles `autoFilterOn` + `chorusOn`, see header note); also High Freq's live-set id                                            |
|      0x4e |                         | Compression                    | — (global, observed min 64)                                                                                                                                         |
|      0x4f |                         | Scroll                         | — (observed max 109)                                                                                                                                                |
|      0x50 |                         | — (unused)                     | —                                                                                                                                                                   |
|      0x51 |                         | — (unused)                     | —                                                                                                                                                                   |
|      0x52 |                         | IR                             | — (dup of 0x0E)                                                                                                                                                     |
|      0x56 |                         | Custom IR Bank                 | — (enum 0–8: 8 custom + Factory)                                                                                                                                    |
| 0x59–0x64 |                         | MIDI / global config           | — (observed only): Define Mapping, MIDI Thru, Patch Offset, CC Mode/Channel, Pot Display, Tuner Freq/Detune, Cabinet Bypass, Safe Level, …                          |
| 0x6d–0x96 |                         | Expr pedal / footswitch / jack | — (observed only): PEDAL1/2, SWITCHA/B 1/2, JACK 1/2 — enums + controller assignments                                                                               |
