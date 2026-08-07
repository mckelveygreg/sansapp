import { describe, expect, it } from "vitest";
import { uploadCustomIr } from "../src/midi/irImport";
import {
  IR_DAT_SIZE,
  buildIrUploadFromDat,
  encodeIrDat,
  irStreamToDat,
  toInt8Samples,
} from "../src/protocol/irEncode";
import { decode } from "../src/protocol/messages";
import type { PedalMessage } from "../src/protocol/messages";

// A distinctive backup IR `.dat` living in a preset's private record: the gain field is poked to a
// value irGain would never derive from these samples, so only a BYTE-FAITHFUL re-upload preserves it
// (a decode→re-encode round-trip through floats would rewrite it).
const backupDat = (() => {
  const dat = encodeIrDat(toInt8Samples([1, 0.5, -0.25]), "BackupCab");
  dat[2] = 0x34;
  dat[3] = 0x02;
  return dat;
})();

/**
 * Fake session covering the full surface uploadCustomIr touches: recallPreset, the raw IR streams
 * (acks begin/end, answers 05 69 record reads with `backupDat`), the save echo, setParamsPaced, and
 * writePreset (echoing either the pedal's derived repoint or the staged bytes unchanged).
 */
class FakeSession {
  readonly protocolVersion = 0x0a;
  /** Coarse op log to assert ORDER across the different call kinds. */
  ops: string[] = [];
  raw: Uint8Array[] = [];
  paced: { param: number; value: number }[][] = [];
  written: { slot: number; blob: Uint8Array }[] = [];
  /** When true, the save echo repoints the slot pair at (bank, program) — the copy-on-save-as. */
  repointOnSave = true;
  /** When false, a 05 69 record read gets no reply (times out). */
  answerReads = true;
  private cbs = new Set<(m: PedalMessage) => void>();
  onMessage(cb: (m: PedalMessage) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  private emit(m: PedalMessage) {
    for (const cb of this.cbs) cb(m);
  }
  async recallPreset(slot: number) {
    this.ops.push(`recall:${slot}`);
    return { raw: new Uint8Array(256), values: {}, name: "INIT" };
  }
  async setParamsPaced(sets: { param: number; value: number }[]) {
    this.ops.push(`paced:${sets.map((s) => `${s.param}=${s.value}`).join(",")}`);
    this.paced.push(sets);
  }
  async writePreset(slot: number, blob: Uint8Array): Promise<Uint8Array> {
    this.ops.push(`write:${slot}`);
    this.written.push({ slot, blob: blob.slice() });
    const echo = blob.slice();
    if (this.repointOnSave) {
      for (const s of [
        { pairMsb: 0x57, pairLsb: 0x58, mode: 0x4a, bank: 0x00 },
        { pairMsb: 0x59, pairLsb: 0x5a, mode: 0x4b, bank: 0x01 },
      ]) {
        if (echo[s.pairMsb]! <= 0x01 && echo[s.mode] !== 0) {
          echo[s.pairMsb] = s.bank;
          echo[s.pairLsb] = slot & 0x7f;
        }
      }
    }
    return echo;
  }
  sendRaw(b: Uint8Array) {
    this.raw.push(b.slice());
    const sub = b[5];
    if (sub === 0x60) this.ops.push(`begin:[${b[7]},${b[8]}]`);
    if (sub === 0x69) this.ops.push(`read:[${b[7]},${b[8]}]`);
    if (sub === 0x60) queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x63 }));
    if (sub === 0x66) queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x61 }));
    // SAVE (05 50 0A 12 7F) → the pedal echoes the program-127 dump.
    if (sub === 0x50 && b[7] === 0x12) {
      this.ops.push(`save:${b[8]}`);
      queueMicrotask(() =>
        this.emit({ kind: "presetDump", slot: 0x7f, blob: new Uint8Array(256), checksumOk: true }),
      );
    }
    // 05 69 record read → stream the backup IR back as raw frames (decoded kind "unknown").
    if (sub === 0x69 && this.answerReads) {
      const frames = buildIrUploadFromDat(backupDat, [b[7]!, b[8]!], this.protocolVersion);
      queueMicrotask(() => {
        for (const f of frames) this.emit({ kind: "unknown", data: f });
      });
    }
  }
}

/** A destination-preset blob; `ir` pokes the user-IR pair/mode bytes. */
function presetBlob(ir: Partial<Record<number, number>> = {}): Uint8Array {
  const b = new Uint8Array(256);
  b[0] = 0x01;
  b[0x27] = 0x42; // distinctive non-IR byte — must be staged unchanged
  for (const [off, v] of Object.entries(ir)) b[Number(off)] = v!;
  return b;
}

const fast = { chunkDelayMs: 0, ackTimeoutMs: 200 } as const;
const setParams = (s: FakeSession) =>
  s.raw.filter((f) => f[5] === 0x50).map((f) => decode(f)) as Extract<
    PedalMessage,
    { kind: "setParam" }
  >[];

describe("uploadCustomIr (per-preset import via copy-on-save-as)", () => {
  it("recalls program 127 BEFORE any wire traffic, then imports, then saves to the program", async () => {
    const s = new FakeSession();
    await uploadCustomIr(s as never, [1, 0.5], "MyCab", {
      slot: 7,
      program: 5,
      blob: presetBlob(),
      ...fast,
    });
    // The import-ordering fix: the import's save (0x12=0x7F) is only a no-op on program 127.
    expect(s.ops[0]).toBe("recall:127");
    // Then: upload into record 127 ([0,127]), the no-op save, the mode gates, the save-as.
    expect(s.ops).toEqual([
      "recall:127",
      "begin:[0,127]",
      "save:127",
      "paced:44=1,45=0",
      "write:5",
    ]);
  });

  it("slot 7: pair set-ids 0x39/0x3A = (0, 0x7F); stages pair+mode into the blob, others untouched", async () => {
    const s = new FakeSession();
    const blob = presetBlob();
    await uploadCustomIr(s as never, [1], "MyCab", { slot: 7, program: 5, blob, ...fast });
    const addr = setParams(s).filter((m) => m.param === 0x39 || m.param === 0x3a);
    expect(addr).toEqual([
      { kind: "setParam", param: 0x39, value: 0x00 },
      { kind: "setParam", param: 0x3a, value: 0x7f },
    ]);
    const staged = s.written[0]!.blob;
    expect(s.written[0]!.slot).toBe(5);
    expect([staged[0x57], staged[0x58], staged[0x4a]]).toEqual([0x00, 0x7f, 1]); // pair→record 127, mode on
    // Everything else is saved exactly as passed (the caller's sound).
    const expected = blob.slice();
    expected[0x57] = 0x00;
    expected[0x58] = 0x7f;
    expected[0x4a] = 1;
    expect(staged).toEqual(expected);
  });

  it("slot 8: uploads into record 255 ([1, 0x7F]) with set-ids 0x3B/0x3C and stages pair8/mode8", async () => {
    const s = new FakeSession();
    await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 8,
      program: 9,
      blob: presetBlob(),
      ...fast,
    });
    expect(s.ops).toContain("begin:[1,127]"); // bank 1: record = 128 + 127
    const addr = setParams(s).filter((m) => m.param === 0x3b || m.param === 0x3c);
    expect(addr).toEqual([
      { kind: "setParam", param: 0x3b, value: 0x01 },
      { kind: "setParam", param: 0x3c, value: 0x7f },
    ]);
    // Mode gates: slot 8's enable (0x29 → live 0x2D) on, slot 7's (0x28 → 0x2C) off.
    expect(s.paced[0]).toEqual([
      { param: 0x2d, value: 1 },
      { param: 0x2c, value: 0 },
    ]);
    const staged = s.written[0]!.blob;
    expect([staged[0x59], staged[0x5a], staged[0x4b]]).toEqual([0x01, 0x7f, 1]);
  });

  it("confirms the pointer when the save echo shows the pair repointed at (bank, program)", async () => {
    const s = new FakeSession();
    const r = await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 7,
      program: 5,
      blob: presetBlob(),
      ...fast,
    });
    expect(r.pointerConfirmed).toBe(true);
  });

  it("reports pointerConfirmed=false when the echo still shows the scratch record (0x7F)", async () => {
    const s = new FakeSession();
    s.repointOnSave = false;
    const r = await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 7,
      program: 5,
      blob: presetBlob(),
      ...fast,
    });
    expect(r.pointerConfirmed).toBe(false);
  });

  it("backs up the OTHER slot's private IR byte-faithfully before saving (both slots survive)", async () => {
    const s = new FakeSession();
    // Destination preset already has a private slot-8 IR: pair8 = (1, 9), mode8 on.
    const blob = presetBlob({ 0x59: 0x01, 0x5a: 0x09, 0x4b: 1 });
    await uploadCustomIr(s as never, [1], "MyCab", { slot: 7, program: 9, blob, ...fast });
    // It read the record pair8 points at, re-uploaded it into program 127's slot-8 record ([1,127]),
    // and only THEN ran the slot-7 import + save-as.
    expect(s.ops).toEqual([
      "recall:127",
      "read:[1,9]",
      "begin:[1,127]",
      "begin:[0,127]",
      "save:127",
      "paced:44=1,45=0",
      "write:9",
    ]);
    // The re-upload is byte-faithful: the poked gain field survives (no decode→re-encode).
    const backupBegin = s.raw.findIndex((f) => f[5] === 0x60 && f[7] === 0x01);
    const backupFrames: Uint8Array[] = [];
    for (let i = backupBegin; i < s.raw.length; i++) {
      const sub = s.raw[i]![5];
      if (sub !== 0x60 && sub !== 0x65 && sub !== 0x66) break;
      backupFrames.push(Uint8Array.from(s.raw[i]!.subarray(7, -1)));
      if (sub === 0x66) break;
    }
    const roundTripped = irStreamToDat(Uint8Array.from(backupFrames.flatMap((f) => [...f])));
    expect(roundTripped).toHaveLength(IR_DAT_SIZE);
    expect(roundTripped).toEqual(backupDat);
    // The staged blob keeps the preset's OWN slot-8 pair/mode — the pedal repoints it at save.
    const staged = s.written[0]!.blob;
    expect([staged[0x59], staged[0x5a], staged[0x4b]]).toEqual([0x01, 0x09, 1]);
  });

  it("skips the backup when the other slot points at the library (MSB 2) or its mode is off", async () => {
    for (const ir of [
      { 0x59: 0x02, 0x5a: 0x04, 0x4b: 1 }, // library pointer — nothing private to lose
      { 0x59: 0x01, 0x5a: 0x09, 0x4b: 0 }, // private pointer but the slot is disabled
    ]) {
      const s = new FakeSession();
      await uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 5,
        blob: presetBlob(ir),
        ...fast,
      });
      expect(s.ops.filter((o) => o.startsWith("read:"))).toEqual([]);
      expect(s.ops.filter((o) => o.startsWith("begin:"))).toEqual(["begin:[0,127]"]);
    }
  });

  it("throws — with nothing saved — when the other slot's backup read fails", async () => {
    const s = new FakeSession();
    s.answerReads = false;
    const blob = presetBlob({ 0x59: 0x01, 0x5a: 0x09, 0x4b: 1 });
    await expect(
      uploadCustomIr(s as never, [1], "MyCab", { slot: 7, program: 9, blob, ...fast }),
    ).rejects.toThrow(/back up/i);
    expect(s.written).toEqual([]); // no save-as ran
    expect(s.ops.filter((o) => o.startsWith("begin:"))).toEqual([]); // no upload either
  });

  it("rejects a non-256-byte preset blob up front", async () => {
    const s = new FakeSession();
    await expect(
      uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 5,
        blob: new Uint8Array(255),
        ...fast,
      }),
    ).rejects.toThrow(/256/);
    expect(s.ops).toEqual([]); // nothing reached the pedal
  });
});

describe("uploadCustomIr wire fidelity", () => {
  it("the main upload frames re-encode to a valid .dat carrying the crafted name", () => {
    // Sanity that the [bank, 0x7F] header framing matches the codec's round-trip expectations.
    const dat = encodeIrDat(toInt8Samples([1, 0.5]), "SansApp-test");
    const frames = buildIrUploadFromDat(dat, [0x00, 0x7f], 0x0a);
    const packed = Uint8Array.from(frames.flatMap((f) => [...f.subarray(7, -1)]));
    expect(packed[0]).toBe(0x00);
    expect(packed[1]).toBe(0x7f);
    expect(irStreamToDat(packed)).toEqual(dat);
  });
});
