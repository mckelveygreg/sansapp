import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, pack7bit, unpack7bit } from "../src/protocol/hex";

describe("hex + 7-bit packing", () => {
  it("formats and parses hex round-trip (spaced, comma, and packed forms)", () => {
    const b = Uint8Array.of(0xf0, 0x00, 0x51, 0x21, 0xf7);
    expect(bytesToHex(b)).toBe("F0 00 51 21 F7");
    expect(hexToBytes("F0 00 51 21 F7")).toEqual(b);
    expect(hexToBytes("f0,00,51,21,f7")).toEqual(b);
    expect(hexToBytes("F0005121F7")).toEqual(b);
  });

  it("throws on an invalid hex token", () => {
    expect(() => hexToBytes("F0 ZZ")).toThrow();
  });

  it("7-bit packs/unpacks arbitrary 8-bit data losslessly (all bytes <= 0x7F when packed)", () => {
    for (const len of [0, 1, 6, 7, 8, 14, 100, 257]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 200) & 0xff);
      const packed = pack7bit(data);
      expect(packed.every((x) => x <= 0x7f)).toBe(true);
      expect(unpack7bit(packed)).toEqual(data);
    }
  });
});
