import { describe, expect, it } from "vitest";
import { type IrRecordState, probeIrRecord } from "../src/midi/irRead";
import {
  IR_DAT_SIZE,
  buildIrUploadFromDat,
  encodeIrDat,
  toInt8Samples,
} from "../src/protocol/irEncode";
import type { PedalMessage } from "../src/protocol/messages";

const realDat = encodeIrDat(toInt8Samples([1, 0.5, -0.25]), "RealCab");
/** What an ERASED record streams back: the pedal serves the address, the bytes are all 0xFF. */
const erasedDat = new Uint8Array(IR_DAT_SIZE).fill(0xff);

/**
 * Minimal session covering only what {@link probeIrRecord} touches: a `05 69` read and the stream that
 * comes back. `answer` picks which of the three hardware behaviours to imitate.
 */
class ProbeSession {
  readonly protocolVersion = 0x0a;
  reads: [number, number][] = [];
  private cbs = new Set<(m: PedalMessage) => void>();
  constructor(private readonly answer: "real" | "erased" | "silent") {}
  onMessage(cb: (m: PedalMessage) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  sendRaw(b: Uint8Array) {
    if (b[5] !== 0x69) return;
    const a = b[7]!;
    const c = b[8]!;
    this.reads.push([a, c]);
    if (this.answer === "silent") return;
    const dat = (this.answer === "real" ? realDat : erasedDat).slice();
    const frames = buildIrUploadFromDat(dat, [a, c], this.protocolVersion);
    queueMicrotask(() => {
      for (const f of frames) for (const cb of this.cbs) cb({ kind: "unknown", data: f });
    });
  }
}

const probe = (answer: "real" | "erased" | "silent"): Promise<IrRecordState> =>
  probeIrRecord(new ProbeSession(answer) as never, 1, 4, 50);

describe("probeIrRecord — the written/unwritten test the pointer guard needs", () => {
  it("reports `written` when the record decodes", async () => {
    expect(await probe("real")).toBe("written");
  });

  // The case that makes issue #95 reachable. Hardware-proved on firmware 1.2 (lab #60): the pedal
  // serves a never-written private address with the IDENTICAL 11-frame envelope a real record uses, so
  // only decoding tells them apart — 2436 bytes of 0xFF fails irStreamToDat's `01 00` magic.
  it("reports `unwritten` when the pedal answers with erased flash", async () => {
    expect(await probe("erased")).toBe("unwritten");
  });

  // Must stay distinct from `unwritten`: a link hiccup must not be reported as "nothing is stored
  // there", or the guard would advise uploading over a cab the user already has.
  it("reports `unreadable` when no stream comes back", async () => {
    expect(await probe("silent")).toBe("unreadable");
  });

  it("addresses the record as a flat 14-bit (MSB, LSB) pair", async () => {
    const s = new ProbeSession("real");
    await probeIrRecord(s as never, 1, 4, 50);
    expect(s.reads).toEqual([[1, 4]]);
  });
});
