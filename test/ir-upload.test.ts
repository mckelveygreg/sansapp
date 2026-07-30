import { describe, expect, it } from "vitest";
import { decode } from "../src/protocol/messages";
import type { PedalMessage } from "../src/protocol/messages";
import { irAddrSetIds, uploadIr } from "../src/midi/irUpload";

// Minimal fake session: records sends and auto-acks begin (05 60→05 63) and end (05 66→05 61), and
// echoes a preset dump on the SAVE (setParam 0x12→05 41), like the real pedal. Only the surface
// uploadIr uses (sendRaw + onMessage).
class FakeSession {
  sent: number[][] = [];
  times: number[] = []; // wall-clock ms per send, so a test can assert the sends are gapped
  private cbs = new Set<(m: PedalMessage) => void>();
  ackEnd = true;
  ackBegin = true;
  ackSave = true; // when false, the pedal never echoes the 05 41 on the SAVE (dropped over BLE)
  onMessage(cb: (m: PedalMessage) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  // uploadIr runs inside session.withExclusive; a passthrough is all the fake needs.
  withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  private emit(m: PedalMessage) {
    for (const cb of this.cbs) cb(m);
  }
  sendRaw(b: Uint8Array) {
    this.sent.push([...b]);
    this.times.push(Date.now());
    const sub = b[5];
    if (sub === 0x60 && this.ackBegin)
      queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x63 }));
    if (sub === 0x66 && this.ackEnd)
      queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x61 }));
    // SAVE (05 50 0A 12 7F) → the pedal echoes a preset dump.
    if (sub === 0x50 && b[7] === 0x12 && this.ackSave)
      queueMicrotask(() =>
        this.emit({ kind: "presetDump", slot: 0x7f, blob: new Uint8Array(256), checksumOk: true }),
      );
  }
}

const frame = (sub: number) =>
  Uint8Array.from([0xf0, 0x00, 0x51, 0x21, 0x05, sub, 0x0a, 0x00, 0xf7]);
const upload = [frame(0x60), ...Array.from({ length: 9 }, () => frame(0x65)), frame(0x66)];

describe("uploadIr", () => {
  it("sets the User-IR preset address, then sends begin, all chunks, end in order", async () => {
    const s = new FakeSession();
    const seen: number[] = [];
    // biome: cast fake to the session shape uploadIr needs
    await uploadIr(s as never, upload, { chunkDelayMs: 0, onProgress: (d) => seen.push(d) });
    // 2 preset-address setParams (0x39, 0x3A) precede the 11 upload frames.
    expect(s.sent).toHaveLength(13);
    expect(s.sent.slice(0, 2).map((f) => decode(Uint8Array.from(f)))).toEqual([
      { kind: "setParam", param: 0x39, value: 0x00 }, // address MSB — matches EliteControl's import
      { kind: "setParam", param: 0x3a, value: 0x7f }, // address LSB = 0x7F (was wrongly 0 — issue #37)
    ]);
    const up = s.sent.slice(2);
    expect(up[0]![5]).toBe(0x60); // begin first
    expect(up.at(-1)![5]).toBe(0x66); // end last
    expect(up.slice(1, -1).every((f) => f[5] === 0x65)).toBe(true); // 9 chunks
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // progress 1..total (upload frames)
  });

  it("skips the preset address when presetAddress is null (capture replay)", async () => {
    const s = new FakeSession();
    await uploadIr(s as never, upload, { chunkDelayMs: 0, presetAddress: null });
    expect(s.sent).toHaveLength(11); // just the 11 upload frames, no 0x39/0x3A
    expect(s.sent[0]![5]).toBe(0x60);
  });

  it("SAVE sends 05 50 0A 12 7F and resolves on the pedal's preset-dump echo", async () => {
    const s = new FakeSession();
    await uploadIr(s as never, upload, { chunkDelayMs: 0, save: true });
    // last send is the SAVE commit (EliteControl's persist)
    expect(decode(Uint8Array.from(s.sent.at(-1)!))).toEqual({
      kind: "setParam",
      param: 0x12,
      value: 0x7f,
    });
    // a single confirmed SAVE: the frame goes out exactly once
    expect(s.sent.filter((f) => f[5] === 0x50 && f[7] === 0x12)).toHaveLength(1);
  });

  it("re-sends the SAVE up to 3× and throws if the pedal never confirms it (item 5)", async () => {
    // A silently-dropped SAVE means the IR is gone on power-cycle while the UI says "saved". The
    // confirm loop mirrors writePreset: re-send the SAME frame, await the 05 41 echo, throw if none.
    const s = new FakeSession();
    s.ackSave = false; // pedal never echoes the save
    await expect(
      uploadIr(s as never, upload, { chunkDelayMs: 0, ackTimeoutMs: 15, save: true }),
    ).rejects.toThrow(/save not confirmed/i);
    // the save frame (05 50 0A 12 7F) was re-sent SAVE_ATTEMPTS = 3 times before giving up
    expect(s.sent.filter((f) => f[5] === 0x50 && f[7] === 0x12)).toHaveLength(3);
  });

  it("rejects if the end is never acked", async () => {
    const s = new FakeSession();
    s.ackEnd = false;
    await expect(
      uploadIr(s as never, upload, { chunkDelayMs: 0, ackTimeoutMs: 30 }),
    ).rejects.toThrow(/no ack/);
  });

  it("best-effort sends the end frame on a mid-transfer failure (clean abort, issue #37)", async () => {
    const s = new FakeSession();
    s.ackBegin = false; // begin never acked → fail before the end is sent
    await expect(
      uploadIr(s as never, upload, { chunkDelayMs: 0, ackTimeoutMs: 20 }),
    ).rejects.toThrow(/no ack/);
    // The transfer must not be left half-open: an 05 66 end frame was sent to close it.
    expect(s.sent.some((f) => f[5] === 0x66)).toBe(true);
  });

  it("throws on a too-short sequence before sending anything", async () => {
    const s = new FakeSession();
    await expect(uploadIr(s as never, [frame(0x60)], {})).rejects.toThrow(/begin/);
    expect(s.sent).toHaveLength(0); // aborted pre-flight — nothing went to the pedal
  });

  it("rejects a malformed frame sequence (wrong sub-code) before sending", async () => {
    const s = new FakeSession();
    const bad = [frame(0x60), frame(0x51), frame(0x66)]; // middle is not a 05 65 chunk
    await expect(uploadIr(s as never, bad, {})).rejects.toThrow(/chunk/);
    expect(s.sent).toHaveLength(0);
  });

  it("gaps the chunk sends so BLE doesn't drop the burst", async () => {
    const s = new FakeSession();
    const GAP = 20;
    await uploadIr(s as never, upload, { chunkDelayMs: GAP, presetAddress: null });
    // sent[0]=begin, sent[1]=chunk1 (fired right after the begin-ack, no delay), then each following
    // send is gapped by ~GAP: chunk2..chunk9 and the end frame.
    for (let i = 2; i < s.times.length; i++) {
      expect(s.times[i]! - s.times[i - 1]!).toBeGreaterThanOrEqual(GAP - 10);
    }
  });

  it("addresses the right User-IR slot before the upload (slot 7 = 0x39/0x3A, slot 8 = 0x3B/0x3C)", async () => {
    // The IR data always lands in the edit-buffer IR [0x00,0x7F]; only the preset-ADDRESS set-ids
    // differ per slot. Slot 7 is byte-faithful to an EliteControl capture; slot 8 (0x3B/0x3C) is a
    // +4-rule inference from the User-IR7/8 Preset indices 0x35–0x38 (§3), NOT yet hardware-verified.
    expect(irAddrSetIds(7)).toEqual([0x39, 0x3a]);
    expect(irAddrSetIds(8)).toEqual([0x3b, 0x3c]);
    for (const slot of [7, 8] as const) {
      const s = new FakeSession();
      const [msb, lsb] = irAddrSetIds(slot);
      await uploadIr(s as never, upload, {
        chunkDelayMs: 0,
        presetAddress: [0x00, 0x7f],
        addrSetIds: irAddrSetIds(slot),
      });
      expect(s.sent.slice(0, 2).map((f) => decode(Uint8Array.from(f)))).toEqual([
        { kind: "setParam", param: msb, value: 0x00 },
        { kind: "setParam", param: lsb, value: 0x7f },
      ]);
    }
  });
});
