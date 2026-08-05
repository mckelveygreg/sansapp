import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/protocol/hex";
import {
  checksum14,
  decode,
  encode,
  isSupportedVersion,
  sysexVersion,
  type PedalMessage,
} from "../src/protocol/messages";
import { DEFAULT_PROTOCOL_VERSION, PROTOCOL_V1_0, PROTOCOL_V1_1 } from "../src/protocol/constants";

/**
 * decode(hex) must equal `expected`, and re-encoding IN THE SAME PROTOCOL VERSION must reproduce the
 * exact bytes. Byte 6 is the firmware version (0x0A = fw 1.0, 0x0B = fw 1.1), so it has to be fed
 * back into encode() — that pairing is exactly what DeviceSession does on the wire.
 */
function roundTrip(hex: string, expected: PedalMessage) {
  const bytes = hexToBytes(hex);
  const msg = decode(bytes);
  expect(msg).toEqual(expected);
  const version = sysexVersion(bytes) ?? DEFAULT_PROTOCOL_VERSION;
  if (msg.kind !== "unknown") expect(bytesToHex(encode(msg, version))).toBe(hex);
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

  // Byte 6 is the firmware version × 10, not a fixed marker: EliteControl 1.0 speaks 0x0A and 1.1
  // speaks 0x0B, each rejecting the other. SansApp reads both and answers in the pedal's version.
  it("decodes both firmware versions of the same message", () => {
    roundTrip("F0 00 51 21 05 51 0B 05 3E F7", { kind: "paramNotify", param: 0x05, value: 0x3e });
    roundTrip("F0 00 51 21 05 50 0B 05 28 F7", { kind: "setParam", param: 0x05, value: 0x28 });
    roundTrip("F0 00 51 21 05 5B 0B F7", { kind: "control", code: 0x5b });
  });

  it("encodes in the requested firmware version", () => {
    const set: PedalMessage = { kind: "setParam", param: 0x05, value: 0x28 };
    expect(bytesToHex(encode(set, PROTOCOL_V1_0))).toBe("F0 00 51 21 05 50 0A 05 28 F7");
    expect(bytesToHex(encode(set, PROTOCOL_V1_1))).toBe("F0 00 51 21 05 50 0B 05 28 F7");
    expect(bytesToHex(encode(set))).toBe(
      bytesToHex(encode(set, DEFAULT_PROTOCOL_VERSION)), // default = newest firmware
    );
  });

  it("reads the version byte and rejects out-of-range ones", () => {
    expect(sysexVersion(hexToBytes("F0 00 51 21 05 51 0A 05 3E F7"))).toBe(PROTOCOL_V1_0);
    expect(sysexVersion(hexToBytes("F0 00 51 21 05 51 0B 05 3E F7"))).toBe(PROTOCOL_V1_1);
    expect(sysexVersion(hexToBytes("F0 00 51 21 05 21 F7"))).toBeNull(); // short ack, no version
    // EliteControl's own window: below 0x0A it says "upgrade the pedal", above 0x77 "upgrade the editor"
    expect(isSupportedVersion(0x09)).toBe(false);
    expect(isSupportedVersion(0x78)).toBe(false);
    expect(decode(hexToBytes("F0 00 51 21 05 51 09 05 3E F7")).kind).toBe("unknown");
    // a FUTURE firmware inside the window still decodes — we don't go deaf on 1.2
    expect(decode(hexToBytes("F0 00 51 21 05 51 0C 05 3E F7"))).toEqual({
      kind: "paramNotify",
      param: 0x05,
      value: 0x3e,
    });
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
