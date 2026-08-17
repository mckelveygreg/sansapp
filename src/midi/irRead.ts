/**
 * Read an IR back OFF the pedal (`05 69 0A <a> <b>` → a `05 60`/`05 65`/`05 66` stream, same packed
 * form as an upload). Decodes via the verified codec (src/protocol/irEncode). Lets the app pull the
 * user's OWN IRs and show their real frequency curves — so we never ship Tech 21's copyrighted IRs.
 * Confirmed in captures: `05 69 0A 02 00` → `05 60 0A 02 00 00 15 61 …`.
 */
import type { DeviceSession } from "../device/session";
import { SYSEX_PREFIX } from "../protocol/constants";
import { type DecodedIr, decodeIrStream, irStreamToDat } from "../protocol/irEncode";

/**
 * `(a, b)` selector for each IR slot (1-indexed). Hardware-confirmed 2026-07-15: the pedal has 8 IR
 * slots at bank `a=0x02`, `b=0..7`. The slots are a GLOBAL library (a marker written to slot 3 survived
 * a preset change); the per-preset `0x0E` selection picks which cab a preset uses.
 *
 * ⚠️ **All eight of these records are FACTORY cabs** — including 7 and 8. An earlier version of this
 * comment called 7–8 "the USER-pair slots" and that reading cost a factory cab: an experimental upload
 * to `[0x02, 0x06]` replaced cab 7 (`Voice 12L`) and it is not recoverable from the pedal. Audited
 * 2026-08-12 by reading all eight records and diffing them against the cab `.wav`s the desktop editor
 * ships: records 1–6 and 8 match their factory cab to within ±1 of int8 rounding; `[0x02, 0x06]` holds
 * a SansApp test IR instead.
 *
 * What "user slots 7/8" really means is the per-preset **override**: a preset can point slots 7/8 at a
 * PRIVATE record (bank `0x00`/`0x01`, indexed by program — see irImport.ts) instead of at the factory
 * cab, chosen by its IR Mode toggle. User IR data lives there, never here. Reading this bank is safe;
 * **never write it** — uploads go through the edit-buffer import (irUpload.ts / issue #37).
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
/** The two slots a preset may OVERRIDE with a private user record (never written in bank 0x02). */
export const USER_IR_SLOTS = [7, 8] as const;

/**
 * Send `05 69 0A a b` and collect the packed IR stream the pedal sends back (the concatenated
 * `05 60/65/66` bodies, WITH the 5-byte header). Resolves null on timeout/failure. The reply is an
 * 11-frame stream (~2.7 kB); over BLE (WIDI) it takes ~3 s+, so the timeout is generous — 4000 ms
 * was cutting the stream off before its `05 66` end (false-empty reads, confirmed by a read-only
 * hardware probe 2026-07-17). `(a, b)` is the flat 14-bit IR record selector (MSB, LSB) — the same
 * addressing as an upload header: the library slots are bank `a=0x02` ({@link IR_READ_AB}).
 */
export function readIrPacked(
  session: DeviceSession,
  a: number,
  b: number,
  timeoutMs = 6000,
): Promise<Uint8Array | null> {
  // Run inside an exclusive window: the read is a raw send + onMessage tap that bypasses the request
  // queue, so a heartbeat block-read (or any queued request) firing INTO this passive multi-second
  // receive stream would garble it — false-empty slots / a false disconnect mid-pull.
  return session.withExclusive(
    () =>
      new Promise((resolve) => {
        const packed: number[] = [];
        let started = false;
        const finish = (v: Uint8Array | null) => {
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
            finish(Uint8Array.from(packed));
          }
        });
        session.sendRaw(
          Uint8Array.of(
            ...SYSEX_PREFIX,
            0x05,
            0x69,
            session.protocolVersion,
            a & 0x7f,
            b & 0x7f,
            0xf7,
          ),
        );
      }),
  );
}

/** Read + decode the IR at record `(a, b)` (see {@link readIrPacked}). Null on timeout/failure. */
export async function readIr(
  session: DeviceSession,
  a: number,
  b: number,
  timeoutMs = 6000,
): Promise<DecodedIr | null> {
  const packed = await readIrPacked(session, a, b, timeoutMs);
  return packed ? decodeIrStream(packed) : null;
}

/**
 * Read the RAW 2436-byte `.dat` at record `(a, b)` — for a byte-faithful re-upload (the decoded form
 * loses the stored makeup-gain field on re-encode). Null on timeout or an invalid stream.
 */
export async function readIrDat(
  session: DeviceSession,
  a: number,
  b: number,
  timeoutMs = 6000,
): Promise<Uint8Array | null> {
  const packed = await readIrPacked(session, a, b, timeoutMs);
  return packed ? irStreamToDat(packed) : null;
}

/** Read the IR in slot 1..8 using {@link IR_READ_AB} (null for an out-of-range slot). */
export function readIrSlot(session: DeviceSession, slot: number): Promise<DecodedIr | null> {
  const ab = IR_READ_AB[slot];
  return ab ? readIr(session, ab[0], ab[1]) : Promise.resolve(null);
}
