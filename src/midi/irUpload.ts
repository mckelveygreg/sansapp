/**
 * Replay a captured user-IR upload to the pedal. The pedal accepts an IR as a chunked SysEx
 * sequence — `05 60` begin, nine `05 65` chunks, `05 66` end — and acks the begin (`05 63`) and
 * the end (`05 61`). This sends those verbatim frames in order, pacing the chunks and waiting for
 * each ack, so the app can push an IR (e.g. an HPF'd factory cab) onto the pedal from our own code.
 *
 * `frames` are the verbatim SysEx sequence to send — from {@link buildIrUpload} (a generated custom
 * IR) or a captured upload (.p3b). Framework-free; used by the app and by tools/upload-ir.ts.
 */
import type { DeviceSession } from "../device/session";
import { encode } from "../protocol/messages";

const BEGIN_ACK = 0x63; // pedal acks 05 60 begin with 05 63 00 F7
const END_ACK = 0x61; //   pedal acks 05 66 end   with 05 61 F7
const IR_SELECT = 0x0e; // continuous IR select/morph: slot N ≈ N*16 (8 slots → 16..127)
const IR_GAIN_A = 0x39; // user-IR gain params EliteControl sends after an import (0 = 0 dB)
const IR_GAIN_B = 0x3a;
const SAVE_COMMIT = 0x12; // setParam 0x12 = 127 = commit/persist (EliteControl's SAVE; pedal echoes a preset dump)

export interface IrUploadOptions {
  /** Delay between data chunks (ms). EliteControl paces ~100 ms; 80 is safe over BLE. */
  chunkDelayMs?: number;
  /** How long to wait for each ack before failing. */
  ackTimeoutMs?: number;
  /**
   * After upload, make the IR the active one by sending IR-select (`0x0E`) with this value
   * (EliteControl does this on import; the app sends slot·16 for the chosen 1..8 slot) + reset its
   * gain. Omit to just store it in the slot without switching to it.
   */
  activateValue?: number;
  /**
   * After upload, persist the IR to non-volatile memory (EliteControl's SAVE = setParam `0x12`=127;
   * the pedal echoes a preset dump to confirm). Without this the IR is only live until power-cycle.
   */
  save?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Upload one captured IR. `frames` is the verbatim SysEx sequence: `[begin, ...chunks, end]`
 * (≥ 3 frames). Resolves once the pedal acks the end; rejects on a missing ack.
 */
export async function uploadIr(
  session: DeviceSession,
  frames: Uint8Array[],
  opts: IrUploadOptions = {},
): Promise<void> {
  const { chunkDelayMs = 80, ackTimeoutMs = 4000, activateValue, save, onProgress } = opts;
  if (frames.length < 3) throw new Error("IR upload needs begin + ≥1 chunk + end");
  const begin = frames[0]!;
  const end = frames[frames.length - 1]!;
  const chunks = frames.slice(1, -1);
  const total = frames.length;
  let done = 0;

  const waitAck = (code: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`IR upload: no ack 0x${code.toString(16)} within ${ackTimeoutMs}ms`));
      }, ackTimeoutMs);
      const off = session.onMessage((m) => {
        if (m.kind === "writeAck" && m.code === code) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });

  // Subscribe for the begin-ack *before* sending, so we can't miss a fast reply.
  const beginAck = waitAck(BEGIN_ACK);
  session.sendRaw(begin);
  onProgress?.(++done, total);
  await beginAck;

  for (const chunk of chunks) {
    session.sendRaw(chunk);
    onProgress?.(++done, total);
    await delay(chunkDelayMs);
  }

  const endAck = waitAck(END_ACK);
  session.sendRaw(end);
  onProgress?.(++done, total);
  await endAck;

  // Optionally switch the pedal to the just-uploaded IR (matches EliteControl's post-import step),
  // so it's immediately active rather than only sitting in the slot.
  if (activateValue !== undefined) {
    const activate = [
      [IR_SELECT, activateValue],
      [IR_GAIN_A, 0],
      [IR_GAIN_B, 0],
    ] as const;
    // Gap these like the chunk stream — over BLE the pedal silently drops fire-and-forget sends that
    // land in one connection interval, so an ungapped IR-select + 2 gains loses most of the burst.
    for (let i = 0; i < activate.length; i++) {
      if (i > 0) await delay(chunkDelayMs);
      const [param, value] = activate[i]!;
      session.sendRaw(encode({ kind: "setParam", param, value }));
    }
  }

  // Persist to non-volatile memory (EliteControl's SAVE). The pedal confirms by echoing a preset
  // dump; wait for it (best-effort — the commit is fire-and-forget on the wire).
  if (save) {
    const confirmed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, ackTimeoutMs);
      const off = session.onMessage((m) => {
        if (m.kind === "presetDump") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    session.sendRaw(encode({ kind: "setParam", param: SAVE_COMMIT, value: 0x7f }));
    await confirmed;
  }
}
