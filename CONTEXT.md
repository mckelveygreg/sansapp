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
