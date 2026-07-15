# Capture playbook

Goal: document the pedal's MIDI dialect by logging the MIDI between the desktop editor (EliteControl) and the pedal, and by diffing preset files. All on a Mac with the
pedal's included **MD1** — no phone required.

## Setup

1. Connect the pedal to the Mac via the MD1 (USB‑C). Confirm it appears in
   **Audio MIDI Setup** as `USB MIDI Driver`.
2. Run the capture: `npm run capture`. It creates two virtual CoreMIDI ports
   (`sansApp Probe → Pedal`, `sansApp Probe ← Pedal`) and bridges them to the MD1,
   logging every message as JSONL under `captures/` with a live decode.
3. In EliteControl → **MIDI Device Settings**, select the two `sansApp Probe` ports as
   in/out. (Device selection is user-configurable — confirmed from the app's `settings.ini`.)
4. Type a note in the `capture` prompt before/after each action below to drop a `marker` line.

## Sessions (one JSONL each)

| #   | Session                                                            | What it should reveal                                |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| 00  | Launch + connect, then idle 60 s                                   | handshake, version exchange, any keepalive/polling   |
| 01  | Recall presets 1→5 in app, then from the pedal footswitch          | recall message + which direction broadcasts          |
| 02  | Sweep each knob min→max→min (mark each); also turn a physical knob | param message format, both directions, echo behavior |
| 03  | Save; save-as to another slot; rename-only save                    | save/write framing                                   |
| 04  | Trigger the bulk "Loading Presets…" path                           | 128-slot dump framing                                |
| 05  | Change amp model; change IR; blend IRs                             | amp/IR selector encoding + index order               |
| 06  | Change each effect/ambience engine + params                        | effect encoding                                      |
| 07  | MIDI mapping + global settings pages                               | CC/PC map, channel, thru                             |

## Offline (no MIDI)

- `09-diff-dats`: in EliteControl, save a preset, nudge **one** control one click, save to a new
  slot; diff the two `.dat` files → that byte is that control's `blobOffset`. Repeat per control
  to fill in `src/protocol/params.ts`. The 128 existing factory `.dat` files are immediate raw
  material for variance analysis.

## Mapping blob offsets (needs the pedal + physical knobs)

`setParam` (`05 50`) isn't reflected in read-backs, so offsets can't be probed by MIDI alone.
Instead, with the pedal connected (run the connect handshake first — hello → blocks → `5B`):

1. Read the edit buffer (`05 40 0A 7F`) → baseline blob.
2. Turn **one physical knob** a large amount.
3. Read the edit buffer again → diff vs baseline. The changed byte is that knob's `blobOffset`.
4. Repeat per knob (main + Red Zone). Record into `src/protocol/params.ts` (`confirmed: true`).

Alternatively, capture the official app's `05 20` blob writes while dragging each on-screen knob
and diff those. Drive is already confirmed at `0x27`.

## Selector + deep-param session (2026-07-08)

Goal: find the wire command EliteControl sends when you pick an **ambience engine**, **amp model**,
or **IR** — none are mapped yet, so the app can't set them and recipe **Apply** can't switch Ambience
to Echo Verb. Same in-line MIDI capture; the live console now prints `setParam 0xNN=V` inline.

1. `npm run capture -- captures/selectors.jsonl`
2. In EliteControl → MIDI Device Settings, pick the two `sansApp Probe` ports; let it connect to the
   pedal.
3. **Type the marker (Enter) in the capture prompt, THEN make the click** — one option at a time, in
   the exact order below (the order is what lets the analyzer see the index step 0,1,2,…):

Ambience engine (Ambience panel → type selector):

```
amb 0 room
amb 1 hall
amb 2 spring
amb 3 plate
amb 4 chorusverb
amb 5 echo
amb 6 echoverb
```

Amp model (amp grid, on-screen order):

```
amp 0 bassdriver   amp 1 vtbass   amp 2 paradriver   amp 3 1970s   amp 4 1980s
amp 5 flip   amp 6 vtstack   amp 7 blackface   amp 8 british   amp 9 shred
```

IR select (IR panel, factory order):

```
ir 0 sansamp   ir 1 fliptop   ir 2 vt8x10   ir 3 cali2x15
ir 4 concert2x15   ir 5 htke4x10   ir 6 voice12l   ir 7 britv30
```

Ctrl+C to stop, then analyze:

```
npm run replay -- --summary captures/selectors.jsonl
```

Read each window: the param that steps `0,1,2,…` across the ordered clicks is the selector. If a
window instead shows `writePreset ×N` with no clean stepping param, the change rewrites the edit
buffer — then diff the blobs to see which bytes each engine sets:

```
npm run replay -- --blobdiff captures/selectors.jsonl
```

**Deep-param blob offsets (task #32, optional add-on):** with EliteControl connected, drag ONE deep
knob a large amount (Comp Ratio, Filter Attack, Ambience Decay, Gate Threshold…), marking each;
EliteControl periodically writes the edit buffer (`05 20`). `--blobdiff` then reports the changed
offset per marker → fill into `src/protocol/params.ts` (`confirmed: true`).

Outcome: a single-param selector → add it to `params.ts` + the AMP/AMBIENCE/IR maps, wire a picker
into that page, and give recipes an `apply` spec for the type. A blob-bundle engine → set it by
writing the edit-buffer blob.

## Turning captures into tests

- `npm run replay -- --extract captures/00-*.jsonl --between "<marker A>" "<marker B>"` slices a
  fixture into `src/protocol/fixtures/`.
- Tests then enforce: (1) every fixture message decodes (rising coverage ratchet), and
  (2) `encode(decode(bytes)) === bytes` for every captured message + preset blob.
- **Fidelity gate (M2):** point EliteControl at `npm run emulate`. If the official app unlocks,
  loads presets, and edits without complaint, our dialect is faithful.

> Fixtures committed to the repo must be **scrubbed** (renamed, no personal data). Raw `captures/`
> and real `.dat` files are git-ignored.
