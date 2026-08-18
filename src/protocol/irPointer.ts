/**
 * The per-preset user-IR pointer: which stored IR record a preset's slot 7/8 plays.
 *
 * Each preset carries two `(MSB, LSB)` pairs in its blob — one per user slot — and together they form
 * a single **14-bit flash record number**, `(MSB << 7) | LSB`. There is one base and one stride, so the
 * MSB is not a "bank" so much as the high bits of a record number (firmware-confirmed; see
 * `sansApp_lab/docs/FIRMWARE-DISASM.md` §13 and `PROTOCOL-MAP.md` §6a):
 *
 * - records **0–127** — the per-preset IR-7 store (one private record per program)
 * - records **128–255** — the per-preset IR-8 store
 * - records **256–263** — the shared 8-entry library, the only records readable as "slots 1–8"
 *
 * ## Why this module exists: the mode byte alone decides whether the pointer is loaded
 *
 * Confirmed by static RE of the recall/load path (lab #55). With **IR Mode off** the pointer is never
 * even read — the *selector* (`0x0E`) picks a factory-region record. With **IR Mode on** the pedal
 * fetches whatever record the pointer names, and it applies **no bounds check**.
 *
 * That makes an out-of-range pointer dangerous the moment the mode is turned on. 27 factory presets
 * ship carrying the unused default pair `(64, 64)` = record 8256, whose page address
 * `8256 · 10 + 1152 = 83712` **truncates to 16 bits** → 18176 → byte `0x470000`: arbitrary flash,
 * convolved as int8 samples with whatever the bytes at record offset 2 mean as a gain field. The
 * output level is unpredictable, not merely wrong.
 *
 * As shipped those presets are safe, because a factory preset has its mode on only when its MSB is 2.
 * The hazard is **app-induced** — it needs something to turn the mode on without fixing the pointer.
 * So every path that enables a user slot must consult {@link readIrPointer} first and refuse when the
 * pointer is {@link IrPointerKind} `"invalid"`. See `app/ir.tsx`'s mode toggle.
 *
 * A private pointer (MSB 0/1) is a legitimate, firmware-supported configuration — it is what
 * `uploadCustomIr` creates — so its *address* is in range and this classifier calls it `"private"`
 * rather than `"invalid"`.
 *
 * ⚠️ **`"private"` does not mean "safe to enable".** Being in range says nothing about whether
 * anything was ever stored there, and an upload that fails partway can leave a pointer naming a record
 * that was never written (issue #95). Enabling that aims the pedal at erased flash — `0xFF` samples
 * with a gain field of ≈2.0, the same hazard class disclosed as #72. This was once trusted because
 * whether an unwritten record is distinguishable on read was open; **lab #60 closed it** — it is, and
 * {@link probeIrRecord} is the test. So a private pointer must be *probed* before its slot is enabled,
 * never trusted on its address alone. `app/ir.tsx`'s mode toggle does exactly that.
 */

/** Blob offsets of each user slot's IR record pair, `[MSB, LSB]` — bytes 0x57–0x5A. */
export const IR_PAIR_BLOB_OFFSET = { 7: [0x57, 0x58], 8: [0x59, 0x5a] } as const;

/** The user slots — the only two with a per-preset pointer. Slots 1–6 are plain library cabs. */
export type UserIrSlot = keyof typeof IR_PAIR_BLOB_OFFSET;

/** MSB of a pointer into the shared library, and the number of records in it (256–263). */
const LIBRARY_MSB = 2;
const LIBRARY_RECORDS = 8;

/**
 * What a pointer refers to:
 * - `library` — one of the 8 shared records. Readable over `05 69`, always safe to play.
 * - `private` — this preset's own record in the per-preset store. Safe to play; may be unwritten.
 * - `invalid` — not a real IR record. Playing it convolves arbitrary flash. Never enable it.
 */
export type IrPointerKind = "library" | "private" | "invalid";

export interface IrPointer {
  readonly msb: number;
  readonly lsb: number;
  /** The 14-bit flash record number the pair encodes. */
  readonly record: number;
  readonly kind: IrPointerKind;
}

/** Classify a raw pair. Exported for tests and for callers holding a pair but no blob. */
export function classifyIrPointer(msb: number, lsb: number): IrPointerKind {
  if (msb === 0 || msb === 1) return "private";
  if (msb === LIBRARY_MSB) return lsb < LIBRARY_RECORDS ? "library" : "invalid";
  return "invalid";
}

/**
 * Read a slot's pointer out of a preset blob, or null if the blob is missing/too short.
 *
 * `blob` is the preset's own 256-byte dump (`pedalStore.raw`). Note this reads what the preset
 * *stores*; the pedal reloads exactly these bytes into the live params on every recall, so for a
 * freshly-loaded preset the two agree.
 */
export function readIrPointer(
  blob: Uint8Array | null | undefined,
  slot: UserIrSlot,
): IrPointer | null {
  if (!blob) return null;
  const [msbOff, lsbOff] = IR_PAIR_BLOB_OFFSET[slot];
  const msb = blob[msbOff];
  const lsb = blob[lsbOff];
  if (msb === undefined || lsb === undefined) return null;
  return { msb, lsb, record: (msb << 7) | lsb, kind: classifyIrPointer(msb, lsb) };
}
