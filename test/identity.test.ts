import { describe, expect, it } from "vitest";
import { PedalModel } from "../src/device/pedalModel";
import { DeviceSession } from "../src/device/session";
import { createLoopback, type MidiIO } from "../src/device/transport";
import { readPresets } from "../src/device/library";
import { PRESET_SIZE, PRESET_SLOT_COUNT } from "../src/protocol/constants";
import { checksum14, decode, encode } from "../src/protocol/messages";
import {
  CHECKSUM_TABLE_BLOCK,
  SERIAL_BLOCK,
  SERIAL_OFFSET,
  parseChecksumTable,
  parseSerial,
  presetChecksum,
  staleSlots,
} from "../src/protocol/identity";

/** Wire a pure PedalModel to the device side of a loopback pair. */
function wireModel(io: MidiIO, model: PedalModel): void {
  io.onMessage((bytes) => {
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply));
  });
}

/** A synthetic bank whose slots differ from each other, so their checksums differ too. */
function makePresets(): Uint8Array[] {
  return Array.from({ length: PRESET_SLOT_COUNT }, (_, i) => {
    const b = new Uint8Array(PRESET_SIZE);
    b[0] = 0x01;
    b[0x27] = i & 0x7f;
    b[0x28] = (i * 3) & 0x7f;
    return b;
  });
}

/** Build data block 0x0F the way the pedal presents it: all zero but the trailing ASCII serial field. */
function serialBlock(serial: string): Uint8Array {
  const block = new Uint8Array(PRESET_SIZE);
  block.fill(0x20, SERIAL_OFFSET); // space-padded field
  for (let i = 0; i < serial.length; i++) block[SERIAL_OFFSET + i] = serial.charCodeAt(i);
  return block;
}

/** Build data block 0x03: 128 (MSB, LSB) 7-bit pairs, one per slot. */
function checksumTableBlock(presets: readonly Uint8Array[]): Uint8Array {
  const block = new Uint8Array(PRESET_SIZE);
  presets.forEach((blob, slot) => {
    const [hi, lo] = checksum14(blob);
    block[slot * 2] = hi;
    block[slot * 2 + 1] = lo;
  });
  return block;
}

// A synthetic serial in the observed shape — never a real unit's digits (docs/PROTOCOL.md § 0x0F).
const SERIAL = "ELITE-PDL-01012026-000000";

describe("serial number (data block 0x0F)", () => {
  it("reads the space-padded ASCII field at 0xE0", () => {
    expect(parseSerial(serialBlock(SERIAL))).toBe(SERIAL);
  });

  it("is null for a blank field", () => {
    const block = new Uint8Array(PRESET_SIZE);
    block.fill(0x20, SERIAL_OFFSET);
    expect(parseSerial(block)).toBeNull();
    expect(parseSerial(new Uint8Array(PRESET_SIZE))).toBeNull(); // all zero
  });

  it("is null when the field isn't printable text", () => {
    const block = serialBlock(SERIAL);
    block[SERIAL_OFFSET + 3] = 0x7f; // not printable ASCII → not the field we expect
    expect(parseSerial(block)).toBeNull();
  });

  it("stops at a NUL as well as at the space padding", () => {
    const block = serialBlock(SERIAL);
    block[SERIAL_OFFSET + 9] = 0x00;
    expect(parseSerial(block)).toBe("ELITE-PDL");
  });
});

describe("per-preset checksum table (data block 0x03)", () => {
  it("decodes 128 slots as 14-bit MSB/LSB pairs", () => {
    const block = new Uint8Array(PRESET_SIZE);
    block[0] = 0x2d;
    block[1] = 0x69;
    block[254] = 0x01;
    block[255] = 0x02;
    const table = parseChecksumTable(block);
    expect(table).toHaveLength(PRESET_SLOT_COUNT);
    expect(table[0]).toBe((0x2d << 7) | 0x69);
    expect(table[127]).toBe((0x01 << 7) | 0x02);
  });

  it("matches the checksum each preset dump carries in its own trailer", () => {
    // The finding that makes the table useful: an entry is the same 14-bit sum the dump trailer holds,
    // so a cached blob can be checked against the table without re-reading the preset.
    const presets = makePresets();
    const table = parseChecksumTable(checksumTableBlock(presets));
    presets.forEach((blob, slot) => {
      const dump = encode({ kind: "presetDump", slot, blob, checksumOk: true });
      const trailer = (dump[dump.length - 3]! << 7) | dump[dump.length - 2]!;
      expect(presetChecksum(blob)).toBe(trailer);
      expect(table[slot]).toBe(trailer);
    });
  });
});

describe("staleSlots", () => {
  const table = [10, 20, 30, 40];

  it("returns only the slots whose checksum moved", () => {
    expect(staleSlots(table, { 0: 10, 1: 99, 2: 30, 3: 40 })).toEqual([1]);
  });

  it("treats a slot with no cached checksum as stale", () => {
    expect(staleSlots(table, { 0: 10, 2: 30 })).toEqual([1, 3]);
    expect(staleSlots(table, {})).toEqual([0, 1, 2, 3]);
  });

  it("returns nothing when the cache already matches", () => {
    expect(staleSlots(table, { 0: 10, 1: 20, 2: 30, 3: 40 })).toEqual([]);
  });
});

describe("DeviceSession identity (handshake blocks are kept)", () => {
  it("exposes the serial and checksum table the connect handshake read", async () => {
    const [appIO, devIO] = createLoopback();
    const presets = makePresets();
    const model = new PedalModel(presets);
    wireModel(devIO, model);
    const session = new DeviceSession(appIO, 500);

    // Seed the two blocks so the handshake's reads return them (the model stores written blocks).
    await session.writeBlock(0x52, SERIAL_BLOCK, serialBlock(SERIAL));
    await session.writeBlock(0x52, CHECKSUM_TABLE_BLOCK, checksumTableBlock(presets));

    expect(session.serial).toBeNull(); // nothing read yet
    await session.connect();

    expect(session.serial).toBe(SERIAL);
    expect(session.presetChecksums).toEqual(presets.map((b) => presetChecksum(b)));
  });

  it("the software pedal serves a serial and a live checksum table by default", async () => {
    // The emulator has to look like hardware here, or `npm run emulate` exercises a pedal with no
    // serial and an all-zero table — and the table has to follow writes, not be frozen at construction.
    const [appIO, devIO] = createLoopback();
    const presets = makePresets();
    wireModel(devIO, new PedalModel(presets));
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    expect(session.serial).toMatch(/^ELITE-PDL-\d{8}-\d{6}$/);
    expect(session.presetChecksums).toEqual(presets.map((b) => presetChecksum(b)));

    const blob = presets[7]!.slice();
    blob[0x28] = 0x7f;
    await session.writePreset(7, blob);
    const after = await session.readPresetChecksums();
    expect(after[7]).toBe(presetChecksum(blob));
  });

  it("a delta sync re-reads only the slots the table says changed", async () => {
    const [appIO, devIO] = createLoopback();
    const presets = makePresets();
    const model = new PedalModel(presets);
    wireModel(devIO, model);
    const session = new DeviceSession(appIO, 500);
    await session.writeBlock(0x52, CHECKSUM_TABLE_BLOCK, checksumTableBlock(presets));
    await session.connect();

    // Cache every slot's checksum, then pretend slots 2 and 70 were edited at the pedal.
    const cached: Record<number, number> = {};
    presets.forEach((b, slot) => (cached[slot] = presetChecksum(b)));
    cached[2] = 0;
    delete cached[70];

    const table = session.presetChecksums;
    expect(table).not.toBeNull();
    const stale = staleSlots(table!, cached);
    expect(stale).toEqual([2, 70]);

    const read = await readPresets(session, stale);
    expect(read.map((r) => r.slot)).toEqual([2, 70]);
    expect(read[0]!.preset.raw[0x27]).toBe(2);
    expect(read[1]!.preset.raw[0x27]).toBe(70);
  });

  it("refreshes the table on demand after a save", async () => {
    const [appIO, devIO] = createLoopback();
    const presets = makePresets();
    wireModel(devIO, new PedalModel(presets));
    const session = new DeviceSession(appIO, 500);
    await session.writeBlock(0x52, CHECKSUM_TABLE_BLOCK, checksumTableBlock(presets));
    await session.connect();

    const edited = presets.map((b) => b.slice());
    edited[5]![0x28] = 0x7f;
    await session.writeBlock(0x52, CHECKSUM_TABLE_BLOCK, checksumTableBlock(edited));

    const fresh = await session.readPresetChecksums();
    expect(fresh[5]).toBe(presetChecksum(edited[5]!));
    expect(session.presetChecksums![5]).toBe(fresh[5]); // the cached copy updated too
  });
});
