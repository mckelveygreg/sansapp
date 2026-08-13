import { describe, expect, it } from "vitest";
import {
  IR_PAIR_BLOB_OFFSET,
  classifyIrPointer,
  readIrPointer,
  type UserIrSlot,
} from "../src/protocol/irPointer";

/** The guard's predicate, as `app/ir.tsx` applies it: refuse only a positively-invalid pointer. */
const canEnable = (blob: Uint8Array | null | undefined, slot: UserIrSlot): boolean =>
  readIrPointer(blob, slot)?.kind !== "invalid";

/** A 256-byte preset blob with slot 7's pair at 0x57/0x58 and slot 8's at 0x59/0x5A. */
function blobWithPairs(p7: [number, number], p8: [number, number] = [2, 0]): Uint8Array {
  const b = new Uint8Array(256);
  [b[0x57], b[0x58]] = p7;
  [b[0x59], b[0x5a]] = p8;
  return b;
}

describe("IR pointer classification", () => {
  it("treats the 8 shared-library records (MSB 2, LSB 0-7) as library", () => {
    for (let lsb = 0; lsb < 8; lsb++) expect(classifyIrPointer(2, lsb)).toBe("library");
  });

  it("treats MSB 0 and 1 as private per-preset records", () => {
    expect(classifyIrPointer(0, 10)).toBe("private"); // program 10's own IR-7 record
    expect(classifyIrPointer(1, 4)).toBe("private"); // program 4's IR-8 record (132 - 128)
    expect(classifyIrPointer(0, 0x7f)).toBe("private"); // record 127 = INIT's scratch
  });

  it("treats a library MSB with an out-of-range LSB as invalid", () => {
    expect(classifyIrPointer(2, 8)).toBe("invalid");
    expect(classifyIrPointer(2, 0x7f)).toBe("invalid");
  });

  it("treats any MSB above the library as invalid", () => {
    for (const msb of [3, 4, 63, 64, 0x7f]) expect(classifyIrPointer(msb, 0)).toBe("invalid");
  });
});

describe("the (64,64) arbitrary-flash hazard", () => {
  // 27 factory presets ship carrying this unused default pair. Record 8256's page address
  // 8256*10 + 1152 = 83712 truncates to 16 bits (18176 -> byte 0x470000): arbitrary flash.
  it("decodes the unused default pair to record 8256 and rejects it", () => {
    const ptr = readIrPointer(blobWithPairs([64, 64]), 7);
    expect(ptr).not.toBeNull();
    expect(ptr?.record).toBe(8256);
    expect(ptr?.kind).toBe("invalid");
  });

  it("refuses to enable a slot pointing at it", () => {
    expect(canEnable(blobWithPairs([64, 64]), 7)).toBe(false);
  });

  it("still allows the OTHER slot when only one pointer is bad", () => {
    const blob = blobWithPairs([64, 64], [2, 3]);
    expect(canEnable(blob, 7)).toBe(false);
    expect(canEnable(blob, 8)).toBe(true);
  });
});

describe("reading a pointer out of a preset blob", () => {
  it("reads each slot from its own offsets and composes the 14-bit record", () => {
    const blob = blobWithPairs([2, 4], [1, 4]);
    expect(readIrPointer(blob, 7)).toEqual({ msb: 2, lsb: 4, record: 260, kind: "library" });
    expect(readIrPointer(blob, 8)).toEqual({ msb: 1, lsb: 4, record: 132, kind: "private" });
  });

  it("uses the documented blob offsets", () => {
    expect(IR_PAIR_BLOB_OFFSET[7]).toEqual([0x57, 0x58]);
    expect(IR_PAIR_BLOB_OFFSET[8]).toEqual([0x59, 0x5a]);
  });

  it("returns null for a missing or too-short blob", () => {
    expect(readIrPointer(null, 7)).toBeNull();
    expect(readIrPointer(undefined, 7)).toBeNull();
    expect(readIrPointer(new Uint8Array(0x58), 7)).toBeNull(); // 0x58 is out of range
  });

  it("permits enabling when the pointer is unknown, so a missing base blob cannot break the toggle", () => {
    expect(canEnable(null, 7)).toBe(true);
    expect(canEnable(undefined, 8)).toBe(true);
  });

  it("permits both legitimate configurations: a library cab and a private per-preset record", () => {
    expect(canEnable(blobWithPairs([2, 4]), 7)).toBe(true);
    expect(canEnable(blobWithPairs([0, 10]), 7)).toBe(true);
  });
});
