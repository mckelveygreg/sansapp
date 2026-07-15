/**
 * `.p3b` bundle codec. EliteControl's export/backup file is just a concatenated stream of SysEx
 * messages — 128 preset dumps (`05 41`) plus any user-IR upload sequences (`05 60`/`05 65`/`05 66`).
 * Because it's plain SysEx, we can read, write, and restore it with the existing codec — enabling
 * full backup/restore/share that's byte-compatible with EliteControl, and letting us push IRs to
 * the pedal by *replaying* their upload messages verbatim (no need to decode the IR encoding).
 * Framework-free.
 */
import { decode } from "./messages";
import type { PedalMessage } from "./messages";

const IR_UPLOAD_SUBS = new Set([0x60, 0x65, 0x66]);

/** Split a raw SysEx stream into individual F0…F7 messages. */
export function splitSysEx(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start >= 0) {
      out.push(bytes.subarray(start, i + 1));
      start = -1;
    }
  }
  return out;
}

/** Concatenate messages back into a single stream (verbatim reassembly). */
export function concatSysEx(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Bundle {
  /** Decoded view of each message (IR-upload chunks decode as `unknown`). */
  readonly messages: PedalMessage[];
  /** Original per-message bytes — replay these verbatim to restore to the pedal. */
  readonly raw: Uint8Array[];
}

export function parseBundle(bytes: Uint8Array): Bundle {
  const raw = splitSysEx(bytes);
  return { messages: raw.map(decode), raw };
}

const isIrUploadChunk = (m: Uint8Array): boolean =>
  m.length >= 6 && m[4] === 0x05 && IR_UPLOAD_SUBS.has(m[5]!);

export interface BundleStats {
  total: number;
  presets: number;
  irUploadChunks: number;
}

export function bundleStats(bundle: Bundle): BundleStats {
  return {
    total: bundle.messages.length,
    presets: bundle.messages.filter((m) => m.kind === "presetDump").length,
    irUploadChunks: bundle.raw.filter(isIrUploadChunk).length,
  };
}

/**
 * Build the steps that restore a bundle: each preset dump becomes a `{slot, blob}` write (`05 20`),
 * and each user-IR upload becomes one `{irFrames}` group (its `05 60` begin + `05 65` chunks +
 * `05 66` end) so the caller can replay it with acks via uploadIr. A new `05 60` starts a fresh
 * group, so multiple IRs in one bundle stay separate.
 */
export type RestoreStep = { slot: number; blob: Uint8Array } | { irFrames: Uint8Array[] };

export function restorePlan(bundle: Bundle): RestoreStep[] {
  const plan: RestoreStep[] = [];
  let irFrames: Uint8Array[] = [];
  const flush = () => {
    if (irFrames.length) {
      plan.push({ irFrames });
      irFrames = [];
    }
  };
  for (let i = 0; i < bundle.messages.length; i++) {
    const raw = bundle.raw[i]!;
    if (isIrUploadChunk(raw)) {
      if (raw[5] === 0x60) flush(); // begin → new upload
      irFrames.push(raw);
    } else {
      flush();
      const m = bundle.messages[i]!;
      if (m.kind === "presetDump") plan.push({ slot: m.slot, blob: m.blob });
    }
  }
  flush();
  return plan;
}
