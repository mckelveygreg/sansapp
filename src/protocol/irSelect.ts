/**
 * The display side of the pedal's IR selector: which stored IR **record** backs each of the eight
 * IR-select positions, for the loaded preset.
 *
 * Every page that draws a cab curve or names a cab needs the same answer, so it is derived here once
 * instead of being hand-rolled per screen (`app/ir.tsx` and `src/components/ToneShaper.tsx` each had
 * their own copy, and the second inherited the first's bug — sansapp#68).
 *
 * ## The rule, from the firmware (lab #55, `docs/research/ir-display-truth-table.md`)
 *
 * The IR-select param `0x0E` is continuous: position `p` sits at `p·16` and values between morph the
 * two neighbouring positions ({@link ../dsp/tone.cabResponseAt} owns that blend). Each *endpoint*
 * resolves independently, and **the per-slot IR Mode byte alone** decides how:
 *
 * - positions **1–6**, and 7/8 with their mode **off** — the pedal plays a record in the
 *   **factory region** (page `(p−1)·10 + 928`), which **no wire command can read**. The only honest
 *   curve is the library's byte-identical copy of that cab, record `256 + (p − 1)`, shown as a
 *   **proxy** ({@link libraryRecordAt}).
 * - positions **7/8** with their mode **on** — the pedal plays whatever record *this preset's own*
 *   pointer names ({@link readIrPointer}), library or private. That record is readable over `05 69`,
 *   so its curve and its name are a real reading of what is playing.
 *
 * The pointer's MSB carries **no** display meaning: mode off → factory region whatever the MSB, mode
 * on → the pointed record whatever the MSB. Any rule of the shape "fall back when the MSB is/isn't 2"
 * is wrong in both directions.
 *
 * ## The pointer is derived, never modelled (lab #57)
 *
 * There is no `PARAMS` entry and no store field for the pointer: it is read out of the loaded preset's
 * own blob on demand ({@link readIrPointer} on `pedalStore.raw`). The store-sync invariant is unchanged
 * — *every `PARAMS` param renders from the store* — and this is the other half of it: **an addressing
 * value with no UI control of its own is derived from `raw` rather than modelled.** Registering it would
 * make it live-writable (its live-set ids `0x39`–`0x3C` are byte-identical to the ones a real repoint
 * uses) and authoritative over `raw` on save, handing three generic writers the ability to silently
 * repoint a preset at arbitrary flash — the hazard {@link ../protocol/irPointer} exists to prevent.
 * `buildPresetBlob` passes unmodelled bytes straight through, so deriving costs nothing on save.
 *
 * ## Why `kind` is on the result
 *
 * A proxy is not a reading. It is the right cab (measured byte-identical to the vendor's own WAV for
 * all eight, lab #62) but it comes from the writable library rather than from the region that is
 * actually playing, so a caller must be able to mark it as such rather than pass it off as measured.
 * How that mark should *look* is lab #62; this module only makes the distinction available.
 */
import { type UserIrSlot, readIrPointer } from "./irPointer";

/** The IR-select positions a preset can name: 1–8 (position 0 is Off / flat, no record at all). */
const IR_POSITIONS = 8;

/**
 * First record of the shared 8-entry library (records 256–263 = `05 69` bank `0x02`, `b` 0–7).
 * Everything below it is the private per-preset store — the only records this app ever writes.
 */
export const LIBRARY_RECORD_BASE = 256;

/**
 * The library record that mirrors the factory cab at IR-select position `pos` — the vendor's
 * `NN-Name.wav` numbering is the *position*, so the record is `256 + (pos − 1)`: 256 `SansAmp`
 * … 263 `Brit V30`. Reading it is exactly what `IR_READ_AB[pos] = [0x02, pos − 1]` already does.
 */
export function libraryRecordAt(pos: number): number {
  return LIBRARY_RECORD_BASE + pos - 1;
}

/**
 * Where a position's curve and name come from:
 * - `played` — the pedal plays this exact record, and it is readable. A real reading.
 * - `proxy` — the pedal plays the unreadable factory-region cab at this position; this is the
 *   library's copy of it. Right cab, but it must never be presented as a measurement.
 */
export type IrSourceKind = "played" | "proxy";

export interface IrSource {
  /** The 14-bit flash record whose samples and name describe this position. */
  readonly record: number;
  readonly kind: IrSourceKind;
}

/** The live per-slot IR Mode, as the *user* currently has it — not the blob's saved byte, which a
 * pending toggle has already diverged from. */
export type UserIrModes = Readonly<Record<UserIrSlot, boolean>>;

const userSlotAt = (pos: number): UserIrSlot | null => (pos === 7 || pos === 8 ? pos : null);

/**
 * The record backing IR-select position `pos` (1–8) for the preset whose blob is `blob`.
 *
 * Null means there is nothing honest to show: the position is out of range, or a user slot is on
 * while its pointer names no real record (an unrecalled preset, or the `(64,64)` sentinel 27 factory
 * presets carry). The library copy is deliberately **not** offered as a fallback there — with the
 * mode on, the factory cab is not what the pedal is playing.
 */
export function irSourceAt(
  blob: Uint8Array | null | undefined,
  pos: number,
  modes: UserIrModes,
): IrSource | null {
  if (!Number.isInteger(pos) || pos < 1 || pos > IR_POSITIONS) return null;
  const slot = userSlotAt(pos);
  if (slot && modes[slot]) {
    const ptr = readIrPointer(blob, slot);
    if (!ptr || ptr.kind === "invalid") return null;
    return { record: ptr.record, kind: "played" };
  }
  return { record: libraryRecordAt(pos), kind: "proxy" };
}

/**
 * The `dbAt` that {@link ../dsp/tone.cabResponseAt} wants, resolved through this preset's own
 * pointers: position → record → the caller's record-keyed curve cache.
 *
 * `dbOf` is looked up by **record**, never by position. That is the whole of the sansapp#68 fix: a
 * position key is global, so one preset's uploaded cab rendered on every other preset with the same
 * slot enabled, while a record key is per-preset by construction (a private record is
 * `bank·128 + program`). An unread record answers null — the caller draws nothing rather than
 * something else's cab.
 */
export function irCurveAt(
  blob: Uint8Array | null | undefined,
  modes: UserIrModes,
  dbOf: (record: number) => readonly number[] | null | undefined,
): (pos: number) => readonly number[] | null {
  return (pos) => {
    const src = irSourceAt(blob, pos, modes);
    return src ? (dbOf(src.record) ?? null) : null;
  };
}
