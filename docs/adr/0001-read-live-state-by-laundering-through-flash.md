# Reading the pedal's live state requires writing to flash

The PBDR Elite's live parameter state — what you are hearing after turning knobs, before saving — is
**write-only over the wire**. No command returns it, and Tech 21's own EliteControl cannot see it
either (verified on hardware: it displays stale values after on-pedal tweaks). But a **bare save
command with no preceding stage** (`05 50 <ver> 12 <slot>`, omitting the usual `05 20`) makes the pedal
build its flash blob _from the live array_ and echo the result back. So "Read from Pedal" reads live
state by asking the pedal to write it down, then putting the slot back.

A reader who finds a _read_ action performing two flash writes will assume it is a bug. It is not.
There is no alternative. Every claim below is observed behaviour of the pedal, confirmed on hardware.

## Considered options

- **Read the live array directly** — there is no such command. Every read the pedal answers serves
  stored data: a data-block read returns a flash page, and a preset read returns the slot as saved.
  Exactly one live value is exposed anywhere in the read surface — settings block 0 byte 0, the
  active program — which is why an editor can always show the right preset number and not the values.
- **Launder through a dedicated scratch slot** — rejected. A save to a _non-active_ slot moves the
  pedal's active program onto that slot, so this would audibly switch the rig to a blank preset
  mid-session. Using the **active** slot avoids the switch entirely and restores byte-exactly.
- **Just save the tweaks** (skip the restore) — rejected as the default: the player has deliberately
  not saved. Possibly worth shipping later as its own explicit action.
- **Disclose staleness and do nothing** — the fallback if this mechanism ever proves unreliable.

## Consequences

- **The restore reverts the pedal's live state**, because a `05 20` stage refreshes the live array from
  the blob. The captured values must therefore be **re-applied** as live params afterwards, or the
  feature destroys the very tweaks it was invoked to recover. Re-apply is not optional.
- **The tuner must be forced Off before committing**, not merely checked. With the tuner engaged the
  pedal zeroes the _live_ Level as it builds the blob, so a commit in tuner mode silently kills the
  player's Level and the echo reports the damage as truth (observed on hardware 2026-08-12, and the
  same behaviour `writePreset` already defends against). The app cannot read tuner state, so it
  writes `05 50 <ver> 38 00` first and makes the precondition true.
- **Drift is undetectable.** Verifying that the app agrees with the pedal requires performing this
  operation, so it cannot run continuously. The app therefore tracks and displays whether its values
  are _known good_ or _may be stale_, and never claims to know which parameters drifted.
- There is a **~1–2 s interruption window** in which the stored preset holds live values. A crash there
  leaves the preset holding the player's own tweaks — benign, but a saved preset changed without being
  asked. Mitigated by re-reading the blob immediately beforehand and verifying the restore.
