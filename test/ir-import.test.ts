import { describe, expect, it } from "vitest";
import { uploadCustomIr } from "../src/midi/irImport";
import {
  IR_DAT_SIZE,
  buildIrUploadFromDat,
  encodeIrDat,
  irStreamToDat,
  toInt8Samples,
} from "../src/protocol/irEncode";
import { IR_PAIR_BLOB_OFFSET, classifyIrPointer, readIrPointer } from "../src/protocol/irPointer";
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

/** One `05 50` param write, as it appears in {@link FakeSession.timeline}. */
const setLabel = (param: number, value: number) =>
  `set:0x${param.toString(16)}=0x${value.toString(16).padStart(2, "0")}`;

/**
 * Fake session covering the full surface uploadCustomIr touches: recallPreset, the raw IR streams
 * (acks begin/end, answers 05 69 record reads with `backupDat`), the save echo, setParamsPaced, and
 * writePreset (echoing either the pedal's derived repoint or the staged bytes unchanged).
 *
 * The failure knobs — `answerReads`, `corruptReads`, `unackedBegin`, `answerSaves`, `commitFails`,
 * `echoMangle` — are what let the auto-enable safety property be checked on the paths that ABORT
 * rather than on the happy path; see the "auto-enable safety" block at the bottom of this file.
 */
class FakeSession {
  readonly protocolVersion = 0x0a;
  /** Coarse op log to assert ORDER across the different call kinds. */
  ops: string[] = [];
  /**
   * Everything in `ops` PLUS every individual `05 50` param write, in strict wire order — so the live
   * IR-record pointer writes (set-ids 0x39/0x3A for slot 7, 0x3B/0x3C for slot 8) and the live IR Mode
   * enables (0x2C/0x2D) can be ordered against each other. `ops` stays coarse so its exact-sequence
   * assertions remain readable.
   */
  timeline: string[] = [];
  raw: Uint8Array[] = [];
  paced: { param: number; value: number }[][] = [];
  written: { slot: number; blob: Uint8Array }[] = [];
  /** Echoes writePreset actually returned — i.e. the saves the pedal CONFIRMED. */
  echoed: Uint8Array[] = [];
  /** When true, the save echo repoints the slot pair at (bank, program) — the copy-on-save-as. */
  repointOnSave = true;
  /** When false, a 05 69 record read gets no reply (times out). */
  answerReads = true;
  /** When true, a 05 69 read replies with a stream that doesn't decode to a valid `.dat`. */
  corruptReads = false;
  /** `"<msb>,<lsb>"` of an upload whose `05 60` begin gets no ack — a transfer that fails in flight. */
  unackedBegin: string | null = null;
  /** When false, the import's SAVE (`05 50 0A 12 7F`) is never echoed, so uploadIr gives up. */
  answerSaves = true;
  /** When true, writePreset takes the staged blob and then fails to commit it. */
  commitFails = false;
  /** Rewrite the save echo — used to pin what `pointerConfirmed` actually verifies. */
  echoMangle?: (echo: Uint8Array) => Uint8Array;
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
  /** Log a coarse op — into both logs, so `timeline` is a strict superset of `ops`. */
  private mark(op: string) {
    this.ops.push(op);
    this.timeline.push(op);
  }
  async recallPreset(slot: number) {
    this.mark(`recall:${slot}`);
    return { raw: new Uint8Array(256), values: {}, name: "INIT" };
  }
  async setParamsPaced(sets: { param: number; value: number }[]) {
    this.mark(`paced:${sets.map((s) => `${s.param}=${s.value}`).join(",")}`);
    for (const s of sets) this.timeline.push(setLabel(s.param, s.value));
    this.paced.push(sets);
  }
  async writePreset(slot: number, blob: Uint8Array): Promise<Uint8Array> {
    // Faithful to DeviceSession.writePreset, which rejects BEFORE sending anything: 0x7E/0x7F are not
    // numbered slots (a `05 20` stage to 0x7F is discarded and the commit jumps to program 128).
    if (slot > 0x7d) {
      throw new Error(
        `invalid preset slot 0x${slot.toString(16)} — 0x7E/0x7F are not writable slots`,
      );
    }
    this.mark(`write:${slot}`);
    this.written.push({ slot, blob: blob.slice() });
    if (this.commitFails) throw new Error(`preset ${slot + 1} save not confirmed by the pedal`);
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
    const reply = this.echoMangle ? this.echoMangle(echo) : echo;
    this.echoed.push(reply.slice());
    return reply;
  }
  sendRaw(b: Uint8Array) {
    this.raw.push(b.slice());
    const sub = b[5];
    if (sub === 0x60) {
      const target = `${b[7]},${b[8]}`;
      this.mark(`begin:[${target}]`);
      if (target !== this.unackedBegin) {
        queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x63 }));
      }
    }
    if (sub === 0x66) queueMicrotask(() => this.emit({ kind: "writeAck", code: 0x61 }));
    if (sub === 0x50) {
      const param = b[7]!;
      const value = b[8]!;
      // SAVE (05 50 0A 12 7F) → the pedal echoes the program-127 dump.
      if (param === 0x12) {
        this.mark(`save:${value}`);
        if (this.answerSaves) {
          queueMicrotask(() =>
            this.emit({
              kind: "presetDump",
              slot: 0x7f,
              blob: new Uint8Array(256),
              checksumOk: true,
            }),
          );
        }
      } else {
        this.timeline.push(setLabel(param, value));
      }
    }
    // 05 69 record read → stream the backup IR back as raw frames (decoded kind "unknown").
    if (sub === 0x69) {
      this.mark(`read:[${b[7]},${b[8]}]`);
      if (!this.answerReads) return;
      const dat = backupDat.slice();
      if (this.corruptReads) dat[0] = 0x99; // breaks irStreamToDat's magic check → readIrDat null
      const frames = buildIrUploadFromDat(dat, [b[7]!, b[8]!], this.protocolVersion);
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

  // The mirror of the test above, and the one that was missing. Uploading to slot 8 while slot 7
  // holds the preset's own private IR is the ORDER A REAL USER HITS — slot 7 is the default, so it
  // gets filled first and slot 8 second. Reported from hardware 2026-08-17: the slot-8 upload wiped
  // slot 7's cab.
  it("backs up slot 7 when the upload targets slot 8 (the order a user actually fills them)", async () => {
    const s = new FakeSession();
    // Destination preset already has a private slot-7 IR: pair7 = (0, 9), mode7 on.
    const blob = presetBlob({ 0x57: 0x00, 0x58: 0x09, 0x4a: 1 });
    await uploadCustomIr(s as never, [1], "MyCab", { slot: 8, program: 9, blob, ...fast });
    expect(s.ops).toEqual([
      "recall:127",
      "read:[0,9]", // slot 7's record, read back before anything is written
      "begin:[0,127]", // re-uploaded into program 127's slot-7 record
      "begin:[1,127]", // then the slot-8 import proper
      "save:127",
      "paced:45=1,44=0",
      "write:9",
    ]);
    // Slot 7's own pair/mode reach the staged blob untouched, so the pedal's save-as repoints it at
    // the preset's own record instead of dropping it.
    const staged = s.written[0]!.blob;
    expect([staged[0x57], staged[0x58], staged[0x4a]]).toEqual([0x00, 0x09, 1]);
  });

  // The condition is the POINTER, not the pointer AND the mode. A private pointer means the record
  // belongs to this preset; backing it up when it turns out not to have needed it costs one record
  // round-trip, while skipping one that did need it destroys a user's IR. Not comparable — so the
  // cheap direction is the one we take when unsure.
  it("backs up an other slot pointing at this preset's own record even if its mode byte reads off", async () => {
    // Program 9, slot 7's own record is 0·128 + 9 = 9. That is the record the save-as overwrites, so
    // its contents are at risk whatever the (app-supplied, staleable) mode byte currently says.
    const s = new FakeSession();
    const blob = presetBlob({ 0x57: 0x00, 0x58: 0x09, 0x4a: 0 }); // own record, mode OFF
    await uploadCustomIr(s as never, [1], "MyCab", { slot: 8, program: 9, blob, ...fast });
    expect(s.ops).toContain("read:[0,9]");
    expect(s.ops).toContain("begin:[0,127]");
  });

  it("does NOT read record 0 on a blank preset — a zeroed pair is not evidence of an IR", async () => {
    // (0,0) is indistinguishable from a real pointer to record 0, so the own-record clause must not
    // fire for a program that isn't 0. Otherwise every blank preset pays a ~3 s read.
    const s = new FakeSession();
    await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 8,
      program: 9,
      blob: presetBlob(),
      ...fast,
    });
    expect(s.ops.filter((o) => o.startsWith("read:"))).toEqual([]);
  });

  it("reports otherSlotSurvived=false when the echo shows the other slot disabled", async () => {
    const s = new FakeSession();
    s.echoMangle = (echo) => {
      echo[0x4a] = 0; // the pedal came back with slot 7 switched off
      return echo;
    };
    const blob = presetBlob({ 0x57: 0x00, 0x58: 0x09, 0x4a: 1 });
    const r = await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 8,
      program: 9,
      blob,
      ...fast,
    });
    expect(r.otherSlotSurvived).toBe(false);
    expect(r.otherSlot).toBe(7);
  });

  it("reports otherSlotSurvived=true on a clean save, and when there was nothing to lose", async () => {
    const withIr = new FakeSession();
    const r1 = await uploadCustomIr(withIr as never, [1], "MyCab", {
      slot: 8,
      program: 9,
      blob: presetBlob({ 0x57: 0x00, 0x58: 0x09, 0x4a: 1 }),
      ...fast,
    });
    expect(r1.otherSlotSurvived).toBe(true);

    const empty = new FakeSession();
    const r2 = await uploadCustomIr(empty as never, [1], "MyCab", {
      slot: 8,
      program: 9,
      blob: presetBlob(), // slot 7 never had a private IR
      ...fast,
    });
    expect(r2.otherSlotSurvived).toBe(true);
  });

  it("skips the backup when the other slot points at the library (MSB 2) or its mode is off", async () => {
    for (const ir of [
      { 0x59: 0x02, 0x5a: 0x04, 0x4b: 1 }, // library pointer — nothing private to lose
      // Private pointer, slot disabled, AND aimed at a record that isn't this preset's own (slot 8's
      // own record for program 5 is 1·128 + 5 = 133 = (0x01, 0x05), not (0x01, 0x09)). Nothing the
      // save-as will overwrite, so there is nothing to preserve.
      { 0x59: 0x01, 0x5a: 0x09, 0x4b: 0 },
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

// ---------------------------------------------------------------------------------------------------
// Auto-enable safety (lab #61 item 3)
//
// `uploadCustomIr` is the ONE remaining path that turns a user IR slot on without going through
// app/ir.tsx's guarded toggle, and it was only ever argued safe "by construction" because it sets the
// pointer in the same operation. These tests turn that argument into a property:
//
//   uploadCustomIr must never leave the pedal with IR Mode enabled for a slot whose pointer does not
//   name a real, just-written record.
//
// Why it matters (src/protocol/irPointer.ts): with the mode OFF the pointer is never read; with it ON
// the pedal fetches whatever record the pointer names and applies NO bounds check. The default pair
// (64, 64) carried by 27 factory presets is record 8256, whose page address truncates to byte
// 0x470000 — arbitrary flash, convolved at an unpredictable level.
//
// The property has two independent halves and both are checked below:
//   LIVE  — every wire-level enable is preceded by pointer writes naming the committed record.
//   SAVED — the pointer and the enable reach the destination preset in ONE 256-byte write, so the
//           persisted preset cannot carry "mode on + stale pointer" either.
// ---------------------------------------------------------------------------------------------------

/** Live-set ids of the IR Mode enables — index 0x28/0x29 + 4 (see liveSetId). */
const MODE_SET_ID = { 7: 0x2c, 8: 0x2d } as const;
/** Live-set ids of the IR record pointer (MSB, LSB) — indices 0x35–0x38 + 4, i.e. irAddrSetIds. */
const PTR_SET_ID = { 7: [0x39, 0x3a], 8: [0x3b, 0x3c] } as const;
/** Blob offsets of the per-slot IR Mode enable (params 0x28/0x29 at +0x22). */
const MODE_BLOB_OFFSET = { 7: 0x4a, 8: 0x4b } as const;
/** Private-record bank per slot: `record = bank·128 + program`. */
const BANK = { 7: 0x00, 8: 0x01 } as const;

/** The pointer the pedal would load at timeline position `at`: the last live MSB/LSB write before it. */
function pointerAt(s: FakeSession, slot: 7 | 8, at: number): { msb?: number; lsb?: number } {
  const [msbId, lsbId] = PTR_SET_ID[slot];
  const out: { msb?: number; lsb?: number } = {};
  for (let i = 0; i < at; i++) {
    const m = /^set:0x([0-9a-f]+)=0x([0-9a-f]+)$/.exec(s.timeline[i]!);
    if (!m) continue;
    const param = parseInt(m[1]!, 16);
    const value = parseInt(m[2]!, 16);
    if (param === msbId) out.msb = value;
    if (param === lsbId) out.lsb = value;
  }
  return out;
}

/**
 * Assert the LIVE half of the property over a whole recorded session, and return how many times the
 * slot was enabled. At EVERY enable the pointer must already name `bank·128 + 127` — the scratch
 * record this import writes — and that record must already have been uploaded AND committed to flash
 * (`begin` + the import's `0x12 = 0x7F` save both precede the enable).
 */
function enablesPairedWithRecord(s: FakeSession, slot: 7 | 8): number {
  const bank = BANK[slot];
  const at = s.timeline.flatMap((e, i) => (e === setLabel(MODE_SET_ID[slot], 1) ? [i] : []));
  for (const i of at) {
    // The enable must be preceded by pointer writes naming the record this import uploaded.
    const ptr = pointerAt(s, slot, i);
    expect(ptr).toEqual({ msb: bank, lsb: 0x7f });
    expect(classifyIrPointer(ptr.msb!, ptr.lsb!)).toBe("private");
    const before = s.timeline.slice(0, i);
    expect(before).toContain(`begin:[${bank},127]`);
    expect(before).toContain("save:127");
  }
  return at.length;
}

describe("uploadCustomIr auto-enable safety", () => {
  it("enables the slot only after its pointer names the record AND the record is committed", async () => {
    for (const slot of [7, 8] as const) {
      const s = new FakeSession();
      await uploadCustomIr(s as never, [1], "MyCab", {
        slot,
        program: 5,
        blob: presetBlob(),
        ...fast,
      });
      expect(enablesPairedWithRecord(s, slot)).toBe(1);
      // …and nothing touched the mode byte at all before that point.
      const enable = s.timeline.indexOf(setLabel(MODE_SET_ID[slot], 1));
      const prefix = `set:0x${MODE_SET_ID[slot].toString(16)}=`;
      expect(s.timeline.slice(0, enable).filter((e) => e.startsWith(prefix))).toEqual([]);
    }
  });

  it("rewrites a (64,64) default pointer even when the caller already staged the mode ON", async () => {
    for (const slot of [7, 8] as const) {
      const [msbOff, lsbOff] = IR_PAIR_BLOB_OFFSET[slot];
      const modeOff = MODE_BLOB_OFFSET[slot];
      // Exactly the blob app/ir.tsx hands over when uploading onto one of the 27 factory presets that
      // carry the unused default pair: onUpload forces irMode<slot> = 1, while the pointer bytes are
      // NOT modeled params so encodePreset copies them straight out of pedalStore.raw. If this module
      // ever stopped rewriting the pair, the upload would PERSIST mode-on + record 8256.
      const blob = presetBlob({ [msbOff]: 64, [lsbOff]: 64, [modeOff]: 1 });
      expect(readIrPointer(blob, slot)).toMatchObject({ record: 8256, kind: "invalid" });
      const s = new FakeSession();
      await uploadCustomIr(s as never, [1], "MyCab", { slot, program: 5, blob, ...fast });
      // Pointer and enable land in ONE 256-byte write, so "mode on + record 8256" is not even
      // representable in what gets saved.
      const staged = s.written[0]!.blob;
      expect(readIrPointer(staged, slot)).toMatchObject({ msb: BANK[slot], lsb: 0x7f });
      expect(readIrPointer(staged, slot)?.kind).toBe("private");
      expect(staged[modeOff]).toBe(1);
      expect([...staged].flatMap((v, i) => (v === blob[i] ? [] : [i]))).toEqual([msbOff, lsbOff]);
      expect(enablesPairedWithRecord(s, slot)).toBe(1);
    }
  });

  it("scopes itself to its own slot — the other slot's pointer/mode bytes pass through", async () => {
    // Slot 8 left enabled on the (64,64) default. uploadCustomIr owns slot 7 only: it neither breaks
    // nor repairs slot 8's pointer, and it has nothing private to back up. Not reachable from the app
    // today (a factory preset has its mode on only when its MSB is 2, and ir.tsx's toggle refuses an
    // `invalid` pointer); repointing it instead of passing it through is lab #57's design question.
    const s = new FakeSession();
    const blob = presetBlob({ 0x59: 64, 0x5a: 64, 0x4b: 1 });
    await uploadCustomIr(s as never, [1], "MyCab", { slot: 7, program: 5, blob, ...fast });
    expect(s.ops.filter((o) => o.startsWith("read:"))).toEqual([]);
    const staged = s.written[0]!.blob;
    expect([staged[0x59], staged[0x5a], staged[0x4b]]).toEqual([64, 64, 1]);
    // The live side is still made safe: slot 8 is switched OFF, and slot 7's enable is paired.
    expect(s.paced[0]).toEqual([
      { param: 0x2c, value: 1 },
      { param: 0x2d, value: 0 },
    ]);
    expect(enablesPairedWithRecord(s, 7)).toBe(1);
  });

  it("a confirmed save leaves the preset pointing at its OWN private record", async () => {
    const s = new FakeSession();
    const r = await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 7,
      program: 5,
      blob: presetBlob(),
      ...fast,
    });
    expect(r.pointerConfirmed).toBe(true);
    // What the `05 41` echo proves: the copy-on-save-as ran, so preset 5 plays record 5, not the
    // shared scratch record — and the pointer classifies `private`, never `invalid`.
    expect(readIrPointer(s.echoed[0]!, 7)).toEqual({ msb: 0, lsb: 5, record: 5, kind: "private" });
    expect(s.echoed[0]![0x4a]).toBe(1);
  });

  it("an UNconfirmed save still leaves the preset on a real record — the one just uploaded", async () => {
    const s = new FakeSession();
    s.repointOnSave = false;
    const r = await uploadCustomIr(s as never, [1], "MyCab", {
      slot: 7,
      program: 5,
      blob: presetBlob(),
      ...fast,
    });
    // pointerConfirmed=false is a durability warning, NOT a safety one: the saved pair is
    // (0, 0x7F) = record 127, the record this import just wrote. Fragile (the next import overwrites
    // it) but never arbitrary flash — which is why the caller only warns instead of rolling back.
    expect(r.pointerConfirmed).toBe(false);
    expect(readIrPointer(s.echoed[0]!, 7)).toEqual({
      msb: 0,
      lsb: 0x7f,
      record: 127,
      kind: "private",
    });
  });

  for (const c of [
    {
      what: "the pedal reports the slot still disabled",
      mangle: (e: Uint8Array) => {
        e[0x4a] = 0;
        return e;
      },
    },
    {
      what: "the echo still shows the (64,64) default pointer",
      mangle: (e: Uint8Array) => {
        e[0x57] = 64;
        e[0x58] = 64;
        return e;
      },
    },
    {
      // Only the MSB is wrong, so the LSB alone would read as a successful repoint — (64, 5) is
      // record 8197, `invalid`. Both halves of the pair have to be checked.
      what: "the echo's pointer MSB is not the private bank",
      mangle: (e: Uint8Array) => {
        e[0x57] = 64;
        return e;
      },
    },
    { what: "the echo is short or garbled", mangle: (e: Uint8Array) => e.slice(0, 255) },
  ]) {
    it(`does not confirm the pointer when ${c.what}`, async () => {
      const s = new FakeSession();
      s.echoMangle = c.mangle;
      const r = await uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 5,
        blob: presetBlob(),
        ...fast,
      });
      expect(r.pointerConfirmed).toBe(false);
    });
  }

  // Every way the import can abort. In all of them the slot must never have been enabled at all —
  // no live enable on the wire and nothing staged to the destination preset.
  for (const c of [
    {
      what: "the caller's blob is not 256 bytes",
      arm: () => {},
      opts: { blob: new Uint8Array(255) },
      throws: /256/,
    },
    {
      what: "the other slot's backup read times out",
      arm: (s: FakeSession) => {
        s.answerReads = false;
      },
      opts: { blob: presetBlob({ 0x59: 0x01, 0x5a: 0x09, 0x4b: 1 }) },
      throws: /back up/i,
    },
    {
      what: "the other slot's backup read comes back garbled",
      arm: (s: FakeSession) => {
        s.corruptReads = true;
      },
      opts: { blob: presetBlob({ 0x59: 0x01, 0x5a: 0x09, 0x4b: 1 }) },
      throws: /back up/i,
    },
    {
      what: "the other slot's re-upload is never acked",
      arm: (s: FakeSession) => {
        s.unackedBegin = "1,127";
      },
      opts: { blob: presetBlob({ 0x59: 0x01, 0x5a: 0x09, 0x4b: 1 }) },
      throws: /no ack/i,
    },
    {
      what: "the IR upload itself is never acked",
      arm: (s: FakeSession) => {
        s.unackedBegin = "0,127";
      },
      opts: {},
      throws: /no ack/i,
    },
    {
      what: "the pedal never confirms the IR save",
      arm: (s: FakeSession) => {
        s.answerSaves = false;
      },
      opts: {},
      throws: /save not confirmed/i,
    },
  ]) {
    it(`never enables the slot when ${c.what}`, async () => {
      const s = new FakeSession();
      c.arm(s);
      await expect(
        uploadCustomIr(s as never, [1], "MyCab", {
          slot: 7,
          program: 5,
          blob: presetBlob(),
          ...c.opts,
          ...fast,
        }),
      ).rejects.toThrow(c.throws);
      expect(enablesPairedWithRecord(s, 7)).toBe(0);
      // Not even a value-0 write: no mode traffic for EITHER slot, so whatever the recall of program
      // 127 left enabled is what stays enabled.
      expect(s.timeline.filter((e) => /^set:0x2[cd]=/.test(e))).toEqual([]);
      expect(s.written).toEqual([]);
      expect(s.echoed).toEqual([]);
    });
  }

  it("a half-written record is never played: the pointer moves, the mode does not", async () => {
    const s = new FakeSession();
    s.unackedBegin = "0,127";
    await expect(
      uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 5,
        blob: presetBlob(),
        ...fast,
      }),
    ).rejects.toThrow(/no ack/i);
    // The live pointer DID move to record 127 before the transfer died, so that record may now hold a
    // partial write. Per lab #55 the mode byte alone decides whether the pointer is ever read — and
    // this path never writes it, so the pedal keeps playing whatever it was playing.
    expect(s.timeline).toContain(setLabel(0x39, 0x00));
    expect(s.timeline).toContain(setLabel(0x3a, 0x7f));
    expect(s.timeline.filter((e) => e.startsWith("set:0x2c="))).toEqual([]);
  });

  it("a failed save-as leaves the live enable paired with the record it uploaded", async () => {
    const s = new FakeSession();
    s.commitFails = true;
    await expect(
      uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 5,
        blob: presetBlob(),
        ...fast,
      }),
    ).rejects.toThrow(/not confirmed/i);
    // This is the one abort that happens AFTER the enable, so it is the sharpest test of the property:
    // the enable is still paired with record 127, which the import committed to flash two steps
    // earlier. Nothing is persisted (an uncommitted stage is discarded), so no preset is left bad.
    expect(enablesPairedWithRecord(s, 7)).toBe(1);
    expect(s.echoed).toEqual([]);
    expect(readIrPointer(s.written[0]!.blob, 7)?.kind).toBe("private");
  });

  it("a destination program the pedal cannot save to aborts without a false confirmation", async () => {
    const s = new FakeSession();
    // 0x7F is not a numbered slot, so DeviceSession.writePreset rejects it before sending anything.
    // That upstream rejection is also what keeps `pointerConfirmed` honest: the staged LSB is 0x7F
    // too, so with program 0x7F an echo that was NEVER repointed would satisfy
    // `echo[lsb] === (program & 0x7f)` and report a copy-on-save-as that did not happen.
    await expect(
      uploadCustomIr(s as never, [1], "MyCab", {
        slot: 7,
        program: 0x7f,
        blob: presetBlob(),
        ...fast,
      }),
    ).rejects.toThrow(/not writable/i);
    expect(s.written).toEqual([]);
    expect(s.echoed).toEqual([]);
    expect(enablesPairedWithRecord(s, 7)).toBe(1); // the live enable is still paired and safe
  });
});
