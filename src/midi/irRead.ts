/**
 * Read an IR back OFF the pedal (`05 69 0A <a> <b>` → a `05 60`/`05 65`/`05 66` stream, same packed
 * form as an upload). Decodes via the verified codec (src/protocol/irEncode). Lets the app pull the
 * user's OWN IRs and show their real frequency curves — so we never ship Tech 21's copyrighted IRs.
 * Confirmed in captures: `05 69 0A 02 00` → `05 60 0A 02 00 00 15 61 …`.
 */
import type { DeviceSession } from "../device/session";
import { SYSEX_PREFIX } from "../protocol/constants";
import { type DecodedIr, decodeIrStream } from "../protocol/irEncode";

/**
 * `(a, b)` selector for each IR slot (1-indexed). Hardware-confirmed 2026-07-15: the pedal has 8 IR
 * slots at bank `a=0x02`, `b=0..7`. Slots 1–6 are FACTORY cabs; 7–8 are the USER-pair slots (each
 * pairs a factory cab with a user IR, selected per-preset by the IR Mode toggle). The slots are a
 * GLOBAL library (a marker written to slot 3 survived a preset change); the per-preset `0x0E`
 * selection picks which cab a preset uses. Reading the bank (here) is safe; never WRITE it directly
 * from the app — uploads go through the edit-buffer import (see irUpload.ts / issue #37).
 */
export const IR_READ_AB: Record<number, [number, number]> = {
  1: [0x02, 0x00],
  2: [0x02, 0x01],
  3: [0x02, 0x02],
  4: [0x02, 0x03],
  5: [0x02, 0x04],
  6: [0x02, 0x05],
  7: [0x02, 0x06],
  8: [0x02, 0x07],
};
/** The two user-writable IR slots (1–6 are factory — never upload there). */
export const USER_IR_SLOTS = [7, 8] as const;

/**
 * Send `05 69 0A a b` and decode the IR the pedal streams back. Resolves null on timeout/failure.
 * The reply is an 11-frame `05 60/65/66` stream (~2.7 kB); over BLE (WIDI) it takes ~3 s+, so the
 * timeout is generous — 4000 ms was cutting the stream off before its `05 66` end (false-empty reads,
 * confirmed by a read-only hardware probe 2026-07-17).
 */
export function readIr(
  session: DeviceSession,
  a: number,
  b: number,
  timeoutMs = 6000,
): Promise<DecodedIr | null> {
  // Run inside an exclusive window: the read is a raw send + onMessage tap that bypasses the request
  // queue, so a heartbeat block-read (or any queued request) firing INTO this passive multi-second
  // receive stream would garble it — false-empty slots / a false disconnect mid-pull.
  return session.withExclusive(
    () =>
      new Promise((resolve) => {
        const packed: number[] = [];
        let started = false;
        const finish = (v: DecodedIr | null) => {
          clearTimeout(timer);
          off();
          resolve(v);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        const off = session.onMessage((m) => {
          if (m.kind !== "unknown") return;
          const d = m.data;
          if (d[4] !== 0x05) return;
          const sub = d[5];
          if (sub === 0x60) {
            started = true;
            packed.push(...d.subarray(7, -1)); // includes the 5-byte header <a><b>00 15 61
          } else if (started && sub === 0x65) {
            packed.push(...d.subarray(7, -1));
          } else if (started && sub === 0x66) {
            packed.push(...d.subarray(7, -1));
            finish(decodeIrStream(Uint8Array.from(packed)));
          }
        });
        session.sendRaw(Uint8Array.of(...SYSEX_PREFIX, 0x05, 0x69, 0x0a, a & 0x7f, b & 0x7f, 0xf7));
      }),
  );
}

/** Read the IR in slot 1..8 using {@link IR_READ_AB} (null for an out-of-range slot). */
export function readIrSlot(session: DeviceSession, slot: number): Promise<DecodedIr | null> {
  const ab = IR_READ_AB[slot];
  return ab ? readIr(session, ab[0], ab[1]) : Promise.resolve(null);
}
