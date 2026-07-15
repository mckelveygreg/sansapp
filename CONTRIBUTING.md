# Contributing to sansApp

Thanks for helping put a great pedal's editor in players' pockets. 🎸

## Ways to help

- **Protocol observations** — the most valuable contribution. If you own an Elite, capture
  traffic (see [docs/CAPTURE-PLAYBOOK.md](docs/CAPTURE-PLAYBOOK.md)) and open a
  _protocol observation_ issue with your firmware version, a hex snippet, what you did, and a
  repro recipe. Every confirmed message becomes a fixture and a row in
  [docs/PROTOCOL.md](docs/PROTOCOL.md).
- **Code** — the app (Expo/React Native), the sync engine, UI, tests.
- **Docs & hardware notes** — known-good cables/adapters, gotchas.

> Using an AI coding assistant? Point it at **[AGENTS.md](AGENTS.md)** — it captures the build gate,
> the framework-free core rule, and the repo conventions.

## Ground rules

- **No Tech 21 assets.** Never commit their images, fonts (e.g. `ni7seg.ttf`), IR `.wav` files,
  the EliteControl binary, or factory preset data. Original artwork only. Real/personal preset
  `.dat` files and raw `captures/` are git-ignored — commit only **scrubbed** fixtures.
- **Keep the core framework-free.** Nothing in `src/protocol/`, `src/device/`, or `src/dsp/` may
  import `react`/`react-native`/`expo` (enforced by oxlint) — that's what lets the Node tools,
  tests, and a future web build reuse it. No barrel/`index.ts` re-export files — import directly.
- **Tooling is oxc.** Run **`npm run check`** before a PR — the full gate (lint · format ·
  `typecheck` core · `typecheck:app` · tests · fallow), same as CI.

## Licensing of contributions (please read)

sansApp is distributed under **GPL-3.0-only**. To keep the project able to stay free _and_ to let
the maintainer offer a commercial license if the manufacturer ever wants one (rather than someone
else quietly closing a fork), contributions are accepted under the following inbound terms:

> By submitting a contribution, you license your contribution to the project and its maintainer
> under the **Apache License 2.0**, and you agree the project may distribute it under
> **GPL-3.0-only** (and that the maintainer may offer it under separate commercial terms).

This is an asymmetric grant — some contributors prefer strict inbound=outbound GPL, and that's a
fair critique; we've chosen this deliberately to prevent a closed-source capture of the work. If
that's a dealbreaker for you, let's talk in an issue before you invest time. Sign off commits with
`git commit -s` (DCO) to affirm you have the right to contribute the code.
