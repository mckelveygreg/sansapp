import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/protocol/hex";
import { checksum14, decode, encode, type PedalMessage } from "../src/protocol/messages";

/** decode(hex) must equal `expected`, and re-encoding must reproduce the exact bytes. */
function roundTrip(hex: string, expected: PedalMessage) {
  const msg = decode(hexToBytes(hex));
  expect(msg).toEqual(expected);
  if (msg.kind !== "unknown") expect(bytesToHex(encode(msg))).toBe(hex);
}

describe("sysex messages (all confirmed from live capture)", () => {
  it("app→pedal commands", () => {
    roundTrip("F0 00 51 21 05 50 0A 05 28 F7", { kind: "setParam", param: 0x05, value: 0x28 });
    roundTrip("F0 00 51 21 05 23 0A 00 F7", { kind: "recallPreset", slot: 0 });
    roundTrip("F0 00 51 21 05 40 0A 00 F7", { kind: "requestPreset", slot: 0 });
    roundTrip("F0 00 51 21 05 55 0A 0F F7", { kind: "requestBlock", reqCode: 0x55, index: 0x0f });
    roundTrip("F0 00 51 21 05 6A 0A 00 F7", { kind: "requestBlock", reqCode: 0x6a, index: 0x00 });
    roundTrip("F0 00 51 21 05 5F 0A F7", { kind: "hello" });
    roundTrip("F0 00 51 21 05 5B 0A F7", { kind: "control", code: 0x5b });
  });

  it("pedal→app paramNotify", () => {
    roundTrip("F0 00 51 21 05 51 0A 05 3E F7", { kind: "paramNotify", param: 0x05, value: 0x3e });
  });

  it("writeAck (05 21, no marker) — pedal's ack of a write", () => {
    roundTrip("F0 00 51 21 05 21 F7", { kind: "writeAck", code: 0x21 });
  });

  it("decodes the marker-less hello (05 5F F7) the real pedal sends", () => {
    // The pedal's dominant hello is marker-less (05 5F F7); the app's own hello is the 3-byte
    // 05 5F 0A. BOTH must decode as hello. A genuine 2-byte ack (05 21) stays a writeAck.
    expect(decode(hexToBytes("F0 00 51 21 05 5F F7"))).toEqual({ kind: "hello" });
    expect(decode(hexToBytes("F0 00 51 21 05 5F 0A F7"))).toEqual({ kind: "hello" });
    expect(decode(hexToBytes("F0 00 51 21 05 21 F7"))).toEqual({ kind: "writeAck", code: 0x21 });
  });

  it("round-trips a presetDump and validates its checksum", () => {
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    for (let i = 0x22; i < 0x6c; i++) blob[i] = (i * 3) & 0x7f;
    const bytes = encode({ kind: "presetDump", slot: 0x7e, blob, checksumOk: true });
    const back = decode(bytes);
    expect(back.kind).toBe("presetDump");
    if (back.kind === "presetDump") {
      expect(back.slot).toBe(0x7e);
      expect(back.checksumOk).toBe(true);
      expect(back.blob).toEqual(blob);
      expect(encode(back)).toEqual(bytes);
    }
  });

  it("round-trips a writePreset (0x20 — the save/write command)", () => {
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    for (let i = 0x22; i < 0x6c; i++) blob[i] = (i * 2) & 0x7f;
    const bytes = encode({ kind: "writePreset", slot: 0x7f, blob, checksumOk: true });
    expect(bytes[5]).toBe(0x20); // sub-command
    const back = decode(bytes);
    expect(back.kind).toBe("writePreset");
    if (back.kind === "writePreset") {
      expect(back.slot).toBe(0x7f);
      expect(back.checksumOk).toBe(true);
      expect(back.blob).toEqual(blob);
      expect(encode(back)).toEqual(bytes);
    }
  });

  it("round-trips a data block (0x52)", () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => (i * 5) & 0x7f);
    const bytes = encode({ kind: "block", blockCode: 0x52, index: 0x0f, data, checksumOk: true });
    const back = decode(bytes);
    expect(back.kind).toBe("block");
    if (back.kind === "block") {
      expect(back.blockCode).toBe(0x52);
      expect(back.index).toBe(0x0f);
      expect(back.checksumOk).toBe(true);
      expect(back.data).toEqual(data);
    }
  });

  it("computes and flags the 14-bit checksum", () => {
    expect(checksum14(Uint8Array.of(1, 1, 1, 1, 1))).toEqual([0, 5]);
    expect(checksum14(Uint8Array.of(200))).toEqual([1, 72]);
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    const bad = encode({ kind: "presetDump", slot: 0, blob, checksumOk: true }).slice();
    bad[bad.length - 2] = (bad[bad.length - 2]! ^ 0x01) & 0x7f;
    const m = decode(bad);
    if (m.kind === "presetDump") expect(m.checksumOk).toBe(false);
    else throw new Error("expected presetDump");
  });

  it("returns unknown (never throws) for malformed or foreign sysex", () => {
    expect(decode(hexToBytes("F0 00 51 21 05 99 0A F7")).kind).toBe("unknown"); // unknown sub
    expect(decode(hexToBytes("F0 43 10 F7")).kind).toBe("unknown"); // not Tech 21
  });
});

// Every Tech 21 SysEx message in the real capture must decode (no "unknown").
const CAPTURE = "captures/m1-live.jsonl";
describe.skipIf(!existsSync(CAPTURE))("live capture decode coverage (local only)", () => {
  it("decodes 100% of captured device sysex", () => {
    const sysex = readFileSync(CAPTURE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { bytes?: string })
      .filter((r) => r.bytes?.startsWith("F0 00 51 21"))
      .map((r) => hexToBytes(r.bytes!));
    expect(sysex.length).toBeGreaterThan(100);
    const unknown = sysex.filter((b) => decode(b).kind === "unknown");
    expect(unknown.map((b) => bytesToHex(b).slice(0, 20))).toEqual([]); // names any stragglers
    // every preset/block checksum in the capture is valid
    for (const b of sysex) {
      const m = decode(b);
      if (m.kind === "presetDump" || m.kind === "block") expect(m.checksumOk).toBe(true);
    }
  });
});
