/**
 * Backup / restore glue: read all presets off the pedal into a `.p3b` (EliteControl-compatible),
 * and restore a `.p3b` back to the pedal. Uses the framework-free bundle codec + the session.
 * RN app surface.
 */
import { readAllPresets } from "../device/library";
import type { DeviceSession } from "../device/session";
import { concatSysEx, parseBundle, restorePlan } from "../protocol/bundle";
import { encode } from "../protocol/messages";
import { buildIrUpload } from "../protocol/irEncode";
import { saveAndShare } from "./exportFile";
import { uploadIr } from "./irUpload";

/** Read all 128 presets and export them as a `.p3b` (shared via the OS sheet). Returns the count. */
export async function exportPresetsBundle(
  session: DeviceSession,
  onProgress?: (done: number) => void,
): Promise<number> {
  const all = await readAllPresets(session, onProgress);
  const parts = all.map(({ slot, preset }) =>
    encode({ kind: "presetDump", slot, blob: preset.raw, checksumOk: true }),
  );
  await saveAndShare("SansApp-backup.p3b", concatSysEx(parts), "application/octet-stream");
  return all.length;
}

/** Export a single preset as a one-preset `.p3b` (shared via the OS sheet). */
export async function exportPreset(session: DeviceSession, slot: number): Promise<void> {
  const preset = await session.readPreset(slot);
  const bytes = concatSysEx([
    encode({ kind: "presetDump", slot, blob: preset.raw, checksumOk: true }),
  ]);
  await saveAndShare(`SansApp-preset-${slot + 1}.p3b`, bytes, "application/octet-stream");
}

/** Write a preset from a `.p3b` (first dump) or a raw 256-byte `.dat` into `slot`. */
export async function importPresetInto(
  session: DeviceSession,
  slot: number,
  fileBytes: Uint8Array,
): Promise<void> {
  let blob: Uint8Array | undefined;
  if (fileBytes[0] === 0xf0) {
    const dump = parseBundle(fileBytes).messages.find((m) => m.kind === "presetDump");
    if (dump?.kind === "presetDump") blob = dump.blob;
  } else if (fileBytes.length >= 256) {
    blob = fileBytes.subarray(0, 256);
  }
  if (!blob) throw new Error("No preset found in that file");
  await session.writePreset(slot, blob);
}

export interface RestoreResult {
  presets: number;
  irs: number;
}

/** Restore a `.p3b`: preset dumps become writes; each user-IR is re-uploaded (acked) via uploadIr. */
export async function restoreBundle(
  session: DeviceSession,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreResult> {
  const plan = restorePlan(parseBundle(bytes));
  let presets = 0;
  let irs = 0;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    if ("irFrames" in step) {
      await uploadIr(session, step.irFrames);
      irs++;
    } else {
      await session.writePreset(step.slot, step.blob);
      presets++;
    }
    onProgress?.(i + 1, plan.length);
  }
  return { presets, irs };
}

/**
 * GENERATE a custom IR from float samples and upload it to one of the pedal's 8 IR slots (7/8 are writable), live over
 * MIDI — no EliteControl, no WAV round-trip. This is the phone-side custom-IR path unlocked by
 * implementing the encoding (src/protocol/irEncode, docs/PROTOCOL.md): e.g. a brick-wall
 * high-pass cab from IR Studio goes straight onto the pedal. `samples` are the IR (≈2400, [-1,1]).
 *
 * ✅ HARDWARE-VERIFIED 2026-07-15: uploaded a marker IR to slot 3 and read it straight back. The slot
 * is addressed in the upload's 5-byte header `[0x02, slot-1, 00 15 61]` (same scheme as the `05 69`
 * read selector), the packed `.dat` is followed by the 14-bit checksum trailer (see
 * {@link irWireTrailer}) the pedal validates, and `save` commits it (`0x12=7F`). We also select it
 * live (`0x0E`) so it's audible immediately. ⚠ REMAINING: makeup gain is off for real cabs (playback
 * LEVEL only — see irEncode.ts), and the pedal's IR playback sample-rate is a calibration constant.
 */
export async function uploadCustomIr(
  session: DeviceSession,
  samples: ArrayLike<number>,
  name: string,
  opts: { slot?: 7 | 8; save?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<void> {
  const { slot = 7, save = true, onProgress } = opts;
  // Slots 1–6 are factory — custom IRs only ever go to the user slots 7/8, at header (0x02, slot-1).
  const frames = buildIrUpload(samples, name, [0x02, (slot - 1) & 0x7f]);
  await uploadIr(session, frames, { activateValue: Math.min(127, slot * 16), save, onProgress });
}
