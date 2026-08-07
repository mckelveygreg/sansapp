/**
 * Backup / restore glue: read all presets off the pedal into a `.p3b` (EliteControl-compatible),
 * and restore a `.p3b` back to the pedal. Uses the framework-free bundle codec + the session.
 * RN app surface.
 */
import { readAllPresets } from "../device/library";
import type { DeviceSession } from "../device/session";
import { concatSysEx, parseBundle, restorePlan } from "../protocol/bundle";
import { encode } from "../protocol/messages";
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
  /** Steps that failed to confirm (e.g. a dropped commit echo) and were skipped, so a whole restore
   * isn't aborted by one bad write. */
  failed: number;
  /** Preset dumps refused for a non-writable slot (0x7E/0x7F — e.g. a captured edit-buffer dump). */
  skipped: number;
}

/** Restore a `.p3b`: preset dumps become writes; each user-IR is re-uploaded (acked) via uploadIr. */
export async function restoreBundle(
  session: DeviceSession,
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreResult> {
  const bundle = parseBundle(bytes);
  const plan = restorePlan(bundle);
  // restorePlan drops dumps for the non-writable slots 0x7E/0x7F (a captured edit-buffer dump would
  // otherwise save-to-program-128); count them so the UI can report what wasn't restored.
  const skipped = bundle.messages.filter((m) => m.kind === "presetDump" && m.slot > 0x7d).length;
  let presets = 0;
  let irs = 0;
  let failed = 0;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    try {
      if ("irFrames" in step) {
        await uploadIr(session, step.irFrames);
        irs++;
      } else {
        await session.writePreset(step.slot, step.blob);
        presets++;
      }
    } catch {
      // One step failed to confirm (e.g. a commit echo dropped over BLE, or a transient write error).
      // Skip it and keep restoring the rest — a 128-preset restore shouldn't abort on a single hiccup.
      failed++;
    }
    onProgress?.(i + 1, plan.length);
  }
  return { presets, irs, failed, skipped };
}
