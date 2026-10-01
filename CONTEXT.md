# Context

Glossary for sansApp. Terms only — no implementation detail, no decisions. Decisions live in
`docs/adr/`.

## Live state

The pedal's current parameter values — what you are hearing right now. Held in the pedal's RAM and
**not readable over the wire**: no command returns it, and Tech 21's own editor cannot see it either.
An editor learns live state only by being attached while it changes (the pedal notifies every knob
turn), or by asking the pedal to write it down — see **Read from Pedal**.

## Stored preset

The parameter values written to the pedal's flash for a numbered slot. This is what any editor sees
when it reads a preset, and it is what a preset returns to when recalled. It can differ from **live
state** for as long as the player has turned knobs without saving.

## Unsaved pedal edits

The divergence between **live state** and the **stored preset** of the slot the pedal is sitting on.
Created by turning knobs at the pedal. Lost on a preset change or a power cycle. Invisible to an
editor that was not attached when they happened.

Distinct from the app's own unsaved edits (the `•` beside the preset name), which are changes made
_in the app_ and not yet saved. Both are "unsaved", but one originates at the pedal and one in the
app.

## Unsaved-edits guard

The confirmation raised before a preset change while the app is holding unsaved edits — save them,
discard them, or stay. It guards the app's edits only: **unsaved pedal edits** are invisible to it,
and no **stored preset** is ever at risk from switching away.

A guard the player can lower. Experimenting means throwing sounds away on purpose, and a guard that
cannot be lowered is friction rather than safety.

_Avoid_: "unsaved-changes guard" — "changes" reads as either side's edits, and this one only ever
sees the app's.

## Read from Pedal

The user-initiated action that recovers **live state** into the app. Named for its direction:
pedal → app. Deliberately **not** called "sync", which hides direction in an app that both reads and
writes.

## Launder

To read **live state** by asking the pedal to write it to flash and echo the result, then putting the
slot back. The pedal's own save command is the only thing that will report live state, so the value
comes back by way of somewhere it was never meant to be — hence the name. The mechanism behind
**Read from Pedal**; see `docs/adr/0001`.

## Freshness

How much the app can claim about its own values: _known good_ while it has been continuously attached
since **live state** was last established (a recall, a preset change at the pedal, or a **Read from
Pedal**), and _may be stale_ otherwise. A statement about the app's knowledge, never a claim that
anything is wrong — the app cannot detect drift. Scoped to sounding parameters; the tuner is changed
by footswitch with nothing on the wire, so it can never be claimed either way.

## Sound

The current live patch as the app presents it — the values on screen, whether or not they match any
**stored preset**. Pre-existing app vocabulary ("if the current sound has unsaved edits").

## Active slot

The preset number the pedal is currently sitting on. The one piece of live information the pedal
_will_ report, which is why the app can always show the right preset number even when the values
beside it may be stale.

## Stage

The app's performance surface: a grid of fixed positions holding **the set**, for picking a sound between
songs. Recall-only — none of the library's management operations reach it.

_Avoid_: "Live", or "Live Mode", for this surface. **Live state** already means the pedal's current
parameter values, and the two senses would appear on screen at the same time.

## The set

The handful of presets a player has chosen for performance, each occupying a position on **Stage**. The
position is part of it: a set is arranged, not filtered, and a position a player has learned stays where
they put it — so removing one leaves its place empty rather than closing the gap.

A set is exactly as many positions as **Stage** shows at once — never scrolled or paged, since a place
that scrolls is no longer a place. It belongs to the app, not to a pedal: one set, used with whichever
pedal is attached, so a spare pedal restored from the same backup answers the same positions.

_Avoid_: "favourites" — it names a flag on a preset, and the set is positions, not flags.

## Set entry

A **slot** placed at a position in **the set**. It refers to the slot number, never to the sound stored
there: overwrite, swap, import or restore slot 5 and the entry is still slot 5, now showing whatever
slot 5 holds. A slot appears in the set at most once.

## Performance presets

Programs 1–3 — the three presets the footswitches reach in the pedal's Performance mode. Not a separate
bank, and not part of **the set**: a fact about the hardware that any slot listing can mark.

## Library

All 128 **stored presets** as the app lists them, in slot order: the whole bank, where presets are managed —
copied, renamed, exported, overwritten. Distinct from **the set**, which is chosen out of it and only
recalled. Pre-existing code vocabulary (`src/device/library.ts`).
