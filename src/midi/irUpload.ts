/**
 * Replay a user-IR upload to the pedal, byte-faithful to EliteControl's own Import sequence
 * (captured in captures/ir-save.jsonl). The pedal accepts an IR as a chunked SysEx sequence —
 * `05 60` begin, nine `05 65` chunks, `05 66` end — and acks the begin (`05 63`) and the end
 * (`05 61`). EliteControl wraps that with:
 *
 *   1. set the User-IR preset address FIRST: `05 50 0A 39 00`, `05 50 0A 3A 7F` (before the upload),
 *   2. the `05 60/65/66` stream targeting the EDIT-BUFFER IR (header `[0x00,0x7F] 00 15 61`),
 *   3. persist: `05 50 0A 12 7F` (its SAVE; the pedal echoes a `05 41` preset dump).
 *
 * ⚠ WHY THIS EXACT ORDER/TARGET MATTERS (issue #37): the previous code wrote directly to the raw
 * IR-library bank (`05 60` header `[0x02, slot-1]`), sent the address bytes AFTER the upload, and
 * sent `0x3A=0` instead of `0x7F`. That diverges from every EliteControl import and could leave the
 * pedal unable to complete the next connect handshake ("timeout awaiting reply to requestBlock"),
 * persisting across a power-cycle — a brick that needed a factory reset. Matching EliteControl's
 * proven sequence avoids it. Do NOT reintroduce the direct-bank write without a fresh capture proving
 * the pedal reconnects afterwards.
 *
 * `frames` are the verbatim SysEx sequence to send — from {@link buildIrUpload} (a generated custom
 * IR, header `[0x00,0x7F]`) or a captured upload (.p3b). Framework-free; used by the app and tools.
 */
import type { DeviceSession } from "../device/session";
import { encode } from "../protocol/messages";

const BEGIN_ACK = 0x63; // pedal acks 05 60 begin with 05 63 00 F7
const END_ACK = 0x61; //   pedal acks 05 66 end   with 05 61 F7
const IR_ADDR_MSB = 0x39; // User-IR preset address MSB — EliteControl sets this before the upload
const IR_ADDR_LSB = 0x3a; // User-IR preset address LSB
const SAVE_COMMIT = 0x12; // setParam 0x12 = 0x7f = EliteControl's SAVE (pedal echoes a preset dump)
const SAVE_VALUE = 0x7f;
// Re-send the SAVE this many times, each awaiting the `05 41` echo, before giving up — mirrors
// DeviceSession.writePreset's commit loop. A silently-dropped SAVE over BLE means the IR is gone on
// the next power-cycle while the UI says "saved"; confirm it or throw.
const SAVE_ATTEMPTS = 3;
// Let the pedal finish committing the IR to flash before the SAVE — EliteControl (over reliable USB)
// leaves a gap here; over BLE, crowding the SAVE onto a still-in-progress flash write is exactly the
// kind of thing that corrupted a config block and bricked the connect. Wait it out.
const SETTLE_MS = 300;

export interface IrUploadOptions {
  /** Delay between data chunks (ms). EliteControl paces ~100 ms; 80 is safe over BLE. */
  chunkDelayMs?: number;
  /** How long to wait for each ack before failing. */
  ackTimeoutMs?: number;
  /**
   * The User-IR preset address (`0x39` MSB, `0x3A` LSB) set BEFORE the upload, matching EliteControl
   * (captured `[0x00, 0x7F]`). Pass `null` to skip (e.g. replaying a capture that already includes
   * these). Default `[0x00, 0x7F]`.
   */
  presetAddress?: readonly [number, number] | null;
  /**
   * The `05 50` SET-IDs used to send that preset address (MSB, LSB). Slot 7 = `[0x39, 0x3A]`
   * (byte-faithful to an EliteControl capture). Slot 8 = `[0x3B, 0x3C]` — a `+4`-rule inference from
   * the User-IR7/8 Preset indices 0x35–0x38 (§3), NOT yet hardware-verified. Default slot 7.
   */
  addrSetIds?: readonly [number, number];
  /**
   * After upload, persist to non-volatile memory (EliteControl's SAVE = setParam `0x12`=`0x7F`; the
   * pedal echoes a preset dump to confirm). Without this the IR is only live until power-cycle.
   */
  save?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * The `05 50` preset-address SET-IDs (MSB, LSB) that address a User-IR slot before an upload. Slot 7 =
 * `[0x39, 0x3A]` — byte-faithful to an EliteControl capture. Slot 8 = `[0x3B, 0x3C]` — a `+4`-rule
 * inference from the User-IR7/8 Preset indices 0x35–0x38 (PROTOCOL-MAP §3), NOT yet hardware-verified.
 */
export const irAddrSetIds = (slot: 7 | 8): readonly [number, number] =>
  slot === 8 ? [0x3b, 0x3c] : [IR_ADDR_MSB, IR_ADDR_LSB];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True if `frame` is a SysEx whose product-sub byte (index 5) equals `sub`. */
const isSub = (frame: Uint8Array, sub: number): boolean =>
  frame[0] === 0xf0 && frame[frame.length - 1] === 0xf7 && frame[4] === 0x05 && frame[5] === sub;

/**
 * Pre-flight structural check of the frames we're about to send. A malformed stream (wrong frame
 * order, a non-SysEx frame, a bad begin/end sub) is exactly what must never reach the pedal — abort
 * here, before a single byte goes out, rather than half-send something that wedges the device.
 */
function validateFrames(frames: Uint8Array[]): void {
  if (frames.length < 3) throw new Error("IR upload needs begin + ≥1 chunk + end");
  if (!isSub(frames[0]!, 0x60)) throw new Error("IR upload: first frame is not a 05 60 begin");
  if (!isSub(frames[frames.length - 1]!, 0x66))
    throw new Error("IR upload: last frame is not a 05 66 end");
  for (let i = 1; i < frames.length - 1; i++) {
    if (!isSub(frames[i]!, 0x65)) throw new Error(`IR upload: frame ${i} is not a 05 65 chunk`);
  }
}

/**
 * Upload one IR. `frames` is the verbatim SysEx sequence `[begin, ...chunks, end]` (≥ 3 frames).
 * Resolves once the pedal acks the end (and, if `save`, confirms the persist); rejects on a missing
 * ack. On ANY failure mid-transfer it best-effort sends the end frame so the pedal is never left
 * waiting for more chunks (a half-open transfer that won't service normal reads).
 */
export async function uploadIr(
  session: DeviceSession,
  frames: Uint8Array[],
  opts: IrUploadOptions = {},
): Promise<void> {
  const {
    chunkDelayMs = 80,
    ackTimeoutMs = 4000,
    presetAddress = [0x00, 0x7f],
    addrSetIds = [IR_ADDR_MSB, IR_ADDR_LSB],
    save,
    onProgress,
  } = opts;
  validateFrames(frames); // abort before sending anything (and before taking the exclusive slot)
  // Run the whole transfer inside an exclusive link window: begin/chunk/end and the SAVE bypass the
  // request queue (raw sends + onMessage taps), so a heartbeat block-read must not fire into the
  // stream — crowding the pedal's IR flash write is the historical brick vector (see the header note).
  // Exclusivity also suspends the heartbeat for the whole transfer + settle window.
  await session.withExclusive(async () => {
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

    // Address the User-IR slot BEFORE the upload — EliteControl sends the MSB then the LSB first (slot
    // 7 = set-ids 0x39/0x3A; slot 8 = 0x3B/0x3C). Paced so BLE doesn't drop the back-to-back sends.
    if (presetAddress) {
      session.sendRaw(
        encode({ kind: "setParam", param: addrSetIds[0], value: presetAddress[0] & 0x7f }),
      );
      await delay(chunkDelayMs);
      session.sendRaw(
        encode({ kind: "setParam", param: addrSetIds[1], value: presetAddress[1] & 0x7f }),
      );
      await delay(chunkDelayMs);
    }

    let endSent = false;
    try {
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
      endSent = true;
      onProgress?.(++done, total);
      await endAck;
    } catch (e) {
      // Failed mid-transfer (a dropped send or a missing ack). If we never sent the end frame, the
      // pedal is still waiting for more chunks — best-effort close the transfer so it isn't half-open.
      if (!endSent) {
        try {
          session.sendRaw(end);
        } catch {
          /* the port is already gone — nothing more we can do to close it cleanly */
        }
      }
      throw e;
    }

    if (save) {
      // Give the IR flash write time to settle before the SAVE (see SETTLE_MS).
      await delay(SETTLE_MS);
      // Confirm the SAVE with retries, mirroring DeviceSession.writePreset's commit loop: the
      // fire-and-forget SAVE can silently drop over BLE, leaving the IR gone on the next power-cycle
      // while the UI says "saved" (and the local IR cache poisoned). Re-send the SAME save frame up to
      // SAVE_ATTEMPTS times, each awaiting the pedal's `05 41` echo; throw if it never confirms.
      const saveFrame = encode({ kind: "setParam", param: SAVE_COMMIT, value: SAVE_VALUE });
      let confirmed = false;
      for (let attempt = 0; attempt < SAVE_ATTEMPTS && !confirmed; attempt++) {
        confirmed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            off();
            resolve(false);
          }, ackTimeoutMs);
          const off = session.onMessage((m) => {
            if (m.kind === "presetDump") {
              clearTimeout(timer);
              off();
              resolve(true);
            }
          });
          session.sendRaw(saveFrame);
        });
      }
      if (!confirmed) throw new Error("IR save not confirmed by the pedal");
    }
  });
}
