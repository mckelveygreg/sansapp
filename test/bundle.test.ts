import { describe, expect, it } from "vitest";
import { encode } from "../src/protocol/messages";
import {
  bundleStats,
  concatSysEx,
  parseBundle,
  restorePlan,
  splitSysEx,
} from "../src/protocol/bundle";

const irChunk = (sub: number, ...data: number[]) =>
  Uint8Array.of(0xf0, 0x00, 0x51, 0x21, 0x05, sub, 0x0a, ...data, 0xf7);

// A synthetic .p3b: two preset dumps + a 3-message IR upload sequence (05 60/65/66).
function makeBundle(): Uint8Array {
  const preset = (slot: number, mark: number) => {
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    blob[0x27] = mark;
    return encode({ kind: "presetDump", slot, blob, checksumOk: true });
  };
  return concatSysEx([
    preset(0, 11),
    preset(1, 22),
    irChunk(0x60, 0x01, 0x7f, 0x00),
    irChunk(0x65, 0x10, 0x20, 0x30),
    irChunk(0x66, 0x40),
  ]);
}

describe(".p3b bundle codec", () => {
  it("splits and reassembles a SysEx stream losslessly", () => {
    const bytes = makeBundle();
    const parts = splitSysEx(bytes);
    expect(parts).toHaveLength(5);
    expect([...concatSysEx(parts)]).toEqual([...bytes]);
  });

  it("parses presets and counts IR-upload chunks", () => {
    const bundle = parseBundle(makeBundle());
    const stats = bundleStats(bundle);
    expect(stats.total).toBe(5);
    expect(stats.presets).toBe(2);
    expect(stats.irUploadChunks).toBe(3);
    expect(bundle.messages[0]!.kind).toBe("presetDump");
  });

  it("builds a restore plan: presets → writes, IR chunks → one grouped upload", () => {
    const plan = restorePlan(parseBundle(makeBundle()));
    expect(plan).toHaveLength(3); // 2 presets + 1 grouped IR upload
    const p0 = plan[0] as { slot: number; blob: Uint8Array };
    expect(p0.slot).toBe(0);
    expect(p0.blob[0x27]).toBe(11);
    // the three IR chunks (60/65/66) collapse into one {irFrames} upload group
    const ir = plan[2] as { irFrames: Uint8Array[] };
    expect(ir.irFrames).toHaveLength(3);
    expect(ir.irFrames[0]![5]).toBe(0x60); // begin
    expect(ir.irFrames[2]![5]).toBe(0x66); // end
  });

  it("skips a dump for a non-writable slot (a captured 05 41 7F edit-buffer dump)", () => {
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    const bytes = concatSysEx([
      encode({ kind: "presetDump", slot: 0, blob, checksumOk: true }),
      encode({ kind: "presetDump", slot: 0x7f, blob, checksumOk: true }), // edit buffer → must be skipped
      encode({ kind: "presetDump", slot: 5, blob, checksumOk: true }),
    ]);
    const plan = restorePlan(parseBundle(bytes));
    expect(plan.map((s) => ("slot" in s ? s.slot : -1))).toEqual([0, 5]); // 0x7F dropped, not a save-to-128
  });

  it("tolerates junk between messages", () => {
    const bytes = makeBundle();
    const noisy = Uint8Array.of(0x00, 0x99, ...bytes, 0x00);
    expect(bundleStats(parseBundle(noisy)).presets).toBe(2);
  });
});
