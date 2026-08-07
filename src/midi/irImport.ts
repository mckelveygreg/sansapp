/**
 * Custom-IR import: generate an IR from float samples and hand it to ONE preset, using the pedal's
 * own per-preset IR mechanism — live over MIDI, no EliteControl, no WAV round-trip.
 *
 * How the pedal models user IRs (observed via EliteControl captures + the factory preset bank):
 *
 * - Every preset stores, per user slot (7/8), a flat 14-bit IR RECORD pointer — `(MSB << 7) | LSB`,
 *   blob bytes 0x57/0x58 (slot 7) and 0x59/0x5A (slot 8). MSB 2 = the shared library (`05 69` bank
 *   `0x02`); MSB 0/1 = a PRIVATE per-preset record, `record = bank·128 + program` with bank 0 for
 *   slot 7 and bank 1 for slot 8. All ten factory presets carrying a private pointer follow that
 *   rule exactly (record == program), which pins the scheme.
 * - Program 127 (`INIT`) is a scratch preset; records 127 (bank 0) and 255 (bank 1) are ITS private
 *   records. EliteControl's captured import (captures/ir-save.jsonl) works entirely there: with the
 *   pedal ON program 127, it points the slot-7 pair at record 127 (`0x39=0`, `0x3A=0x7F`), uploads
 *   into record 127 (begin header `[0x00, 0x7F]`), and saves (`0x12 = 0x7F`).
 * - THE SAVE IS THE HAND-OFF. Saving to a DIFFERENT program `P` while a user slot is enabled and
 *   privately pointed copies the current program's private record into `P`'s own record and repoints
 *   `P`'s pair at it — a copy-on-save-as, and exactly how the factory presets with private IRs were
 *   authored. Saving to the program you are already on skips the copy (which is what makes
 *   EliteControl's import — save target == current == 127 — a safe no-op).
 *
 * ⚠ ORDERING (the import-ordering defect this module fixes): uploading while sitting on a working preset
 * `W` and then saving `0x12 = 0x7F` is NOT a no-op — current (`W`) ≠ target (127), so the pedal
 * copies `W`'s record OVER record 127, i.e. over the IR just uploaded. The import MUST recall
 * program 127 first, exactly as EliteControl does.
 *
 * ⚠ Slot 8 (`[0x01, 0x7F]` → record 255, pair set-ids 0x3B/0x3C) follows the confirmed record
 * scheme but has never been captured from EliteControl — only slot 7 is byte-faithful to a capture.
 *
 * Framework-free (no React/React Native): usable from the app and the Node tools.
 */
import type { DeviceSession } from "../device/session";
import { buildIrUpload, buildIrUploadFromDat } from "../protocol/irEncode";
import { liveSetId } from "../protocol/params";
import { irAddrSetIds, uploadIr } from "./irUpload";
import { readIrDat } from "./irRead";

/** Program 127 — the pedal's `INIT` scratch preset, EliteControl's import staging ground. */
const INIT_PROGRAM = 0x7f;

/** Private-record bank per user slot: `record = bank·128 + program`. */
const IR_BANK = { 7: 0x00, 8: 0x01 } as const;

/** Preset-blob offsets of the per-slot IR record pair `(MSB, LSB)` — bytes 0x57–0x5A. */
const PAIR_OFFSET = { 7: [0x57, 0x58], 8: [0x59, 0x5a] } as const;

/** Preset-blob offsets of the per-slot IR Mode enable (params 0x28/0x29 at +0x22). */
const MODE_OFFSET = { 7: 0x4a, 8: 0x4b } as const;

/** IR Mode enable param indices (live-set via {@link liveSetId}: 0x28→0x2C, 0x29→0x2D). */
const MODE_INDEX = { 7: 0x28, 8: 0x29 } as const;

const otherSlot = (slot: 7 | 8): 7 | 8 => (slot === 7 ? 8 : 7);

export interface CustomIrUploadResult {
  /**
   * True when the save echo shows the destination preset's pair repointed at its OWN private record
   * (`(bank, program)`) with the slot enabled — the pedal confirmed the copy-on-save-as. False means
   * the preset was still saved, but its pointer references program 127's scratch record, which the
   * NEXT import will overwrite — surface it so the flow can be verified on-device.
   */
  pointerConfirmed: boolean;
}

export interface CustomIrUploadOptions {
  /** Which user-IR slot of the preset receives the IR. Default 7. */
  slot?: 7 | 8;
  /** Destination program (0-based, ≤ 0x7D) whose preset the IR is handed to via the save-as. */
  program: number;
  /**
   * The 256-byte preset blob to save to `program` — the caller's current sound (buildPresetBlob).
   * The slot's pair + mode bytes are overridden here; everything else is saved as passed.
   */
  blob: Uint8Array;
  /** Progress over the upload frames (both uploads when a backup pre-copy runs). */
  onProgress?: (done: number, total: number) => void;
  /** Delay between upload data chunks (ms) — see {@link uploadIr}. */
  chunkDelayMs?: number;
  /** How long to wait for each upload ack (ms) — see {@link uploadIr}. */
  ackTimeoutMs?: number;
}

/**
 * Upload `samples` as a custom IR and hand it to `program`'s user slot, via EliteControl's captured
 * import + the pedal's copy-on-save-as:
 *
 *   1. recall program 127 (the ordering fix — the import's save must be a no-op copy),
 *   2. upload into program 127's private record for the slot (`[bank, 0x7F]`),
 *   3. enable the slot (live) and save the caller's blob to `program` — the pedal copies the record
 *      into `program`'s own private record and repoints the preset's pair at it.
 *
 * The pedal is left ON `program` (the save parks it there); the caller should recall `program` to
 * refresh its own state from the saved preset.
 *
 * If the destination blob has the OTHER slot enabled on a private record, that record's content is
 * first read back and re-uploaded into program 127's other-slot record (byte-faithful), so the
 * save-as copy for that slot re-writes the preset's own IR instead of replacing it with stale
 * scratch data. Throws — with nothing saved — if that backup read fails.
 */
export async function uploadCustomIr(
  session: DeviceSession,
  samples: ArrayLike<number>,
  name: string,
  opts: CustomIrUploadOptions,
): Promise<CustomIrUploadResult> {
  const { slot = 7, program, blob, onProgress, chunkDelayMs, ackTimeoutMs } = opts;
  if (blob.length !== 256) throw new Error("preset blob must be 256 bytes");
  const bank = IR_BANK[slot];
  const target = [bank, INIT_PROGRAM] as const;

  // 1. Recall program 127 FIRST (the import-ordering fix): the import below ends in `0x12 = 0x7F`,
  // which is only a safe no-op when the pedal is already on 127 — from any other program it copies
  // that program's record over the freshly-uploaded one.
  await session.recallPreset(INIT_PROGRAM);

  // 2. If the destination preset actively uses a private IR on the OTHER slot, back it up into
  // program 127's other-slot record before anything is saved: the save-as in step 4 copies BOTH
  // enabled slots from program 127's records, and the other slot's scratch record holds stale data.
  const other = otherSlot(slot);
  const [oMsbOff, oLsbOff] = PAIR_OFFSET[other];
  const oMsb = blob[oMsbOff]!;
  const oLsb = blob[oLsbOff]!;
  const otherIsPrivate = oMsb <= 0x01 && blob[MODE_OFFSET[other]] !== 0;
  // Both uploads report through one progress range (11 frames each).
  const totalFrames = otherIsPrivate ? 22 : 11;
  let framesDone = 0;
  const progress = onProgress
    ? () => {
        framesDone++;
        onProgress(framesDone, totalFrames);
      }
    : undefined;
  if (otherIsPrivate) {
    // ackTimeoutMs doubles as the whole-stream read timeout when given (tests/tools); the default
    // stays readIrDat's generous 6 s — a full record stream over BLE takes ~3 s+.
    const dat = await readIrDat(session, oMsb, oLsb, ackTimeoutMs);
    if (!dat) {
      throw new Error(
        `couldn't back up the preset's slot-${other} IR (record read failed) — nothing was saved`,
      );
    }
    await uploadIr(
      session,
      buildIrUploadFromDat(dat, [IR_BANK[other], INIT_PROGRAM], session.protocolVersion),
      { presetAddress: null, onProgress: progress, chunkDelayMs, ackTimeoutMs },
    );
  }

  // 3. The import proper, byte-faithful to EliteControl's captured sequence: point the slot's pair
  // at program 127's record, upload into it, and persist with the (now no-op) `0x12 = 0x7F` save.
  const frames = buildIrUpload(samples, name, target, session.protocolVersion);
  await uploadIr(session, frames, {
    presetAddress: target,
    addrSetIds: irAddrSetIds(slot),
    save: true,
    onProgress: progress,
    chunkDelayMs,
    ackTimeoutMs,
  });

  // 4. Hand the IR to the destination preset. Enable the slot both LIVE and in the staged blob (the
  // save-time copy is gated on the slot being enabled; covering both states costs nothing), disable
  // the other slot LIVE only (program 127's own state must not trigger a copy the destination
  // preset didn't ask for — its real enable is whatever `blob` carries), then save. The pedal
  // copies record(bank·128 + 127) → record(bank·128 + program) and repoints the pair.
  await session.setParamsPaced([
    { param: liveSetId(MODE_INDEX[slot]), value: 1 },
    { param: liveSetId(MODE_INDEX[other]), value: 0 },
  ]);
  const staged = blob.slice();
  const [pMsbOff, pLsbOff] = PAIR_OFFSET[slot];
  staged[pMsbOff] = bank;
  staged[pLsbOff] = INIT_PROGRAM;
  staged[MODE_OFFSET[slot]] = 1;
  const echo = await session.writePreset(program, staged);

  // The echo is the pedal's view of the saved preset: a repointed pair == the copy-on-save-as ran.
  const pointerConfirmed =
    echo.length === 256 &&
    echo[pMsbOff] === bank &&
    echo[pLsbOff] === (program & 0x7f) &&
    echo[MODE_OFFSET[slot]] !== 0;
  return { pointerConfirmed };
}
