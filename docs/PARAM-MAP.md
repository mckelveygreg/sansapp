# PBDR Elite parameter map

Parameter reference for the SansAmp Programmable Bass Driver DI Elite. Each **wire id** is the
device's own parameter index — the byte carried in `05 50` (set) and `05 51` (notify) messages, with
no translation. The names in the middle column are the labels the desktop editor uses; the right
column is how SansApp exposes each one.

All of SansApp's active mappings are **confirmed against hardware** (every id verified by sending it
and by watching the pedal's own notifications). `0x4d` is **not** a parameter — it is only the pedal's
red-SHIFT footswitch notification. `*` = ambience decay/time are engine-specific (captured on the Echo
engine); other engines reuse those indices for different controls.

| wire | editor label              | SansApp                                                 |
| ---: | ------------------------- | ------------------------------------------------------- |
| 0x00 | Level                     | `level` / eq master                                     |
| 0x01 | Gain                      | `preamp`                                                |
| 0x02 | Buzz                      | _roadmap_                                               |
| 0x03 | Punch                     | _roadmap_                                               |
| 0x04 | Crunch                    | `presence`                                              |
| 0x05 | Drive                     | `drive`                                                 |
| 0x06 | Low                       | `low` / eq.low.gain                                     |
| 0x07 | High                      | `high` / eq.high.gain                                   |
| 0x08 | Reverb                    | `ambiance` / amb.level                                  |
| 0x09 | Gate                      | gate.threshold                                          |
| 0x0a | Dynamics                  | `comp` (threshold)                                      |
| 0x0b | Punch Freq                | _roadmap_                                               |
| 0x0c | Mid                       | `mid` / eq.mid.gain                                     |
| 0x0d | Mid Shift                 | `freq` / eq.mid.freq                                    |
| 0x0e | IR                        | IR select/blend (0x0E)                                  |
| 0x0f | AnalogSim                 | _roadmap_                                               |
| 0x10 | Reverb Room Size          | _roadmap_                                               |
| 0x11 | Reverb Decay Time         | _roadmap_                                               |
| 0x12 | Reverb Diffusion          | _roadmap_                                               |
| 0x13 | Reverb Extension Factor   | _roadmap_                                               |
| 0x14 | Reverb Fbk. Delay Size    | amb.time\*                                              |
| 0x15 | Reverb Fbk. Filter        | amb.decay\*                                             |
| 0x16 | Reverb Fbk. Damper Factor | _roadmap_                                               |
| 0x17 | Reverb LP Filter          | _roadmap_                                               |
| 0x18 | Reverb HP Filter          | _roadmap_                                               |
| 0x19 | Compressor Ratio          | `ratio` / comp.ratio                                    |
| 0x1a | Compressor Output Gain    | comp.outputGain                                         |
| 0x1b | Compressor Attack         | comp.attack                                             |
| 0x1c | Compressor Release        | comp.release                                            |
| 0x1d | Expander Ratio            | gate.ratio (inferred)                                   |
| 0x1e | Expander Output Gain      | _roadmap_                                               |
| 0x1f | Expander Attack           | _roadmap_                                               |
| 0x20 | Expander Release          | _roadmap_                                               |
| 0x21 | Soft Clipping             | _roadmap_                                               |
| 0x22 | AnalogSim Gain            | _roadmap_                                               |
| 0x23 | Anti-aliasing Filter      | _roadmap_                                               |
| 0x24 | Clean Input Level         | _roadmap_                                               |
| 0x25 | Compressor Ratio          | —                                                       |
| 0x26 | Gate Attack               | _roadmap_                                               |
| 0x27 | Gate Release              | gate.release                                            |
| 0x28 | IR Mode                   | —                                                       |
| 0x29 | IR Mode                   | —                                                       |
| 0x2a | User IR Gain              | —                                                       |
| 0x2b | User IR Gain              | —                                                       |
| 0x2c | Buzz Q                    | _roadmap_                                               |
| 0x2d | Punch Q                   | _roadmap_                                               |
| 0x2e | Crunch Q                  | _roadmap_                                               |
| 0x2f | Mid Q                     | `q` / eq.mid.q                                          |
| 0x30 | Low Q                     | `lowQ` / eq.low.q                                       |
| 0x31 | High Q                    | `highQ` / eq.high.q                                     |
| 0x32 | Auto Gain                 | comp.autoGain                                           |
| 0x33 | Lookahead                 | comp.lookahead                                          |
| 0x34 | Tuner                     | —                                                       |
| 0x35 | User IR7 Preset MSB       | —                                                       |
| 0x36 | User IR7 Preset           | —                                                       |
| 0x37 | User IR8 Preset MSB       | —                                                       |
| 0x38 | User IR8 Preset           | —                                                       |
| 0x39 | Reverb Mode               | _roadmap_                                               |
| 0x3a | Reverb Modulation Depth   | _roadmap_                                               |
| 0x3b | Reverb Modulation Rate    | _roadmap_                                               |
| 0x3c | AutoFiler Level           | —                                                       |
| 0x3d | AutoFiler Level           | `filter` / af.level                                     |
| 0x3e | AF. Attack                | af.attack                                               |
| 0x3f | AF. Release               | af.release                                              |
| 0x40 | Preset Level              | _roadmap_                                               |
| 0x41 | Chorus On                 | _roadmap_                                               |
| 0x42 | Chorus Level              | `chorus` / chorus.level                                 |
| 0x43 | Chorus Level              | chorusModFreq                                           |
| 0x44 | Chorus Level              | chorusModDepth                                          |
| 0x45 | Chorus Level              | chorusDelaySize                                         |
| 0x46 | Chorus Level              | chorusFeedback                                          |
| 0x47 | Blend Level               | `blend`                                                 |
| 0x48 | Low Freq                  | `lowFreq` / eq.low.freq                                 |
| 0x49 | High Freq                 | `highFreq` / eq.high.freq                               |
| 0x4a | — (unused)                | —                                                       |
| 0x4b | — (unused)                | —                                                       |
| 0x4c | — (unused)                | —                                                       |
| 0x4d | — (unused)                | red-SHIFT footswitch notify (`KNOB_LAYER_NOTIFY_PARAM`) |
| 0x4e | Compression               | —                                                       |
| 0x4f | Scroll                    | —                                                       |
| 0x50 | — (unused)                | —                                                       |
| 0x51 | — (unused)                | —                                                       |
| 0x52 | IR                        | —                                                       |
