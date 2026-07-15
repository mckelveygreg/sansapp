import { describe, expect, it } from "vitest";
import type { PedalMessage } from "../src/protocol/messages";
import { uploadIr } from "../src/midi/irUpload";

// Minimal fake session: records sends and auto-acks begin (05 60→05 63) and end (05 66→05 61),
// like the real pedal. Only the surface uploadIr uses (sendRaw + onMessage).
class FakeSession {
  sent: number[][] = [];
  private cbs = new Set<(m: PedalMessage) => void>();
  ackEnd = true;
  onMessage(cb: (m: PedalMessage) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  private emit(m: PedalMessage) {
    for (const cb of this.cbs) cb(m);
  }
  sendRaw(b: Uint8Array) {
    this.sent.push([...b]);
    const sub = b[5];
    if (sub === 0x60) queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x63 }));
    if (sub === 0x66 && this.ackEnd)
      queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x61 }));
  }
}

const frame = (sub: number) =>
  Uint8Array.from([0xf0, 0x00, 0x51, 0x21, 0x05, sub, 0x0a, 0x00, 0xf7]);
const upload = [frame(0x60), ...Array.from({ length: 9 }, () => frame(0x65)), frame(0x66)];

describe("uploadIr", () => {
  it("sends begin, all chunks, end in order and resolves on acks", async () => {
    const s = new FakeSession();
    const seen: number[] = [];
    // biome: cast fake to the session shape uploadIr needs
    await uploadIr(s as never, upload, { chunkDelayMs: 0, onProgress: (d) => seen.push(d) });
    expect(s.sent).toHaveLength(11);
    expect(s.sent[0]![5]).toBe(0x60); // begin first
    expect(s.sent.at(-1)![5]).toBe(0x66); // end last
    expect(s.sent.slice(1, -1).every((f) => f[5] === 0x65)).toBe(true); // 9 chunks
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // progress 1..total
  });

  it("rejects if the end is never acked", async () => {
    const s = new FakeSession();
    s.ackEnd = false;
    await expect(
      uploadIr(s as never, upload, { chunkDelayMs: 0, ackTimeoutMs: 30 }),
    ).rejects.toThrow(/no ack/);
  });

  it("throws on a too-short sequence", async () => {
    const s = new FakeSession();
    await expect(uploadIr(s as never, [frame(0x60)], {})).rejects.toThrow(/begin/);
  });
});
