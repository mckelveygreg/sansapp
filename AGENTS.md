# AGENTS.md — working in the SansApp repo

Guidance for AI coding agents (and humans) contributing to SansApp. Read this before making changes.
It applies to the whole repo. (Claude Code, Cursor, etc. read this file automatically.)

## What this is

SansApp is a free, open-source mobile editor for the Tech 21 SansAmp Programmable Bass Driver DI
Elite — an independent **interoperability** project. It speaks the pedal's MIDI protocol, documented
by observing a pedal the author owns. It ships **no Tech 21 code, artwork, fonts, or preset data.**

## The rules that matter (enforced)

1. **Run the gate before every change is done:** `npm run check` (lint + format + typecheck of the
   core and the app + tests + [Fallow](https://fallow.tools)). It must be green. Same as CI.
2. **Keep the core framework-free.** Nothing in `src/protocol/`, `src/device/`, `src/dsp/`,
   `src/state/`, or `src/ui/` may import `react` / `react-native` / `expo` (oxlint enforces this).
   That's what lets the Node tools, the tests, and the web build reuse the same tested code.
3. **No barrel files.** No `index.ts` re-export hubs — import directly from the module that defines
   the symbol.
4. **Tooling is oxc**, not ESLint/Prettier: `npm run lint`, `npm run format`. Don't add ESLint/Prettier.
5. **Never commit Tech 21 material** — their binary, images, fonts, IR `.wav`s, or factory preset
   data. Real/personal presets, `.dat`/`.syx`/`.p3b` files, and raw `captures/` are git-ignored;
   commit only scrubbed/synthetic fixtures (`*.json`).
6. **Tone:** this is interoperability. Describe **observed** protocol behavior; don't frame the work
   as attacking or defeating the manufacturer's software. No "crack", no re-hosted binaries, no
   decompilation write-ups in the repo.
7. **No EAS / paid cloud build.** Releases use local fastlane (`docs/RELEASE.md`).

## Layout

- `src/protocol/` — SysEx codec, 256-byte preset codec, **parameter registry (`params.ts`)**,
  settings / PC-map / `.p3b` / IR / WAV codecs. Framework-free.
- `src/dsp/` — FFT, biquads, IR frequency-response, filter/IR generators. Framework-free.
- `src/device/` — transport, session/handshake, sync engine, librarian, pedal model. Framework-free.
- `src/state/`, `src/ui/` — zustand store + knob math. Framework-free.
- `app/`, `src/components/`, `src/midi/` — the Expo / React Native surface.
- `tools/` — `emulate`, `probe`, `capture`, `replay`, `send`, `ports`, `ble-check` (Node dev harness).
- `docs/` — `PROTOCOL.md` (protocol reference), `PARAM-MAP.md`, `HARDWARE.md`, `RELEASE.md`,
  `CAPTURE-PLAYBOOK.md`.

## Where the protocol "truth" lives

`src/protocol/params.ts` is the single source of truth for parameter ids/offsets; the emulator
derives from it. `docs/PARAM-MAP.md` (the human-readable map) and `docs/PROTOCOL.md` (transport +
message vocabulary) are maintained **by hand** alongside it — keep them in sync. If you change a
mapping, update `params.ts`, update `docs/PARAM-MAP.md` to match, and add/adjust a test.

## Developing without hardware

- `npm run emulate` runs a software pedal on virtual MIDI ports — build and test the whole protocol
  path with no pedal.
- Most work needs no device: the codec, DSP, state, and session engine are unit-tested in Node.
- With a real Elite: `npm run probe` (read-only validation), `npm run capture` (log MIDI for a
  protocol-observation issue — see `docs/CAPTURE-PLAYBOOK.md`).

## Contributing flow

Small, focused PRs. Sign commits `-s` (DCO). The highest-value contribution is a **protocol
observation** from your own Elite — see [CONTRIBUTING.md](CONTRIBUTING.md). Licensing terms are there
too (GPL-3.0 out, Apache-2.0 in).
