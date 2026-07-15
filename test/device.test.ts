import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol/messages";
import { readAllPresets } from "../src/device/library";
import { PedalModel } from "../src/device/pedalModel";
import { DeviceSession } from "../src/device/session";
import { createLoopback, type MidiIO } from "../src/device/transport";
import { PC_MAP_BLOCK, SETTINGS_BLOCK, withPcMap, withSetting } from "../src/protocol/settings";

/** Wire a pure PedalModel to the device side of a loopback pair. */
function wireModel(io: MidiIO, model: PedalModel): void {
  io.onMessage((bytes) => {
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply));
  });
}

function makePresets(): Uint8Array[] {
  return Array.from({ length: 128 }, (_, i) => {
    const b = new Uint8Array(256);
    b[0] = 0x01;
    b[0x27] = i & 0x7f; // distinctive per-slot byte (Drive offset)
    return b;
  });
}

describe("DeviceSession ↔ PedalModel", () => {
  it("connects, reads, recalls, and writes with an ack", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    wireModel(devIO, model);
    const session = new DeviceSession(appIO, 500);

    await session.connect();
    expect(session.state).toBe("ready");
    expect(model.connected).toBe(true);

    const p5 = await session.readPreset(5);
    expect(p5.raw[0x27]).toBe(5);

    const p9 = await session.recallPreset(9);
    expect(p9.raw[0x27]).toBe(9);
    expect(model.editBuffer[0x27]).toBe(9); // recall loaded it into the edit buffer

    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    blob[0x27] = 0x42;
    await session.writePreset(3, blob); // resolves only when the ack arrives
    expect(model.presets[3]![0x27]).toBe(0x42);
  });

  it("reads and writes config/data blocks (settings + PC map)", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    // an unwritten block reads back as zeros
    const before = await session.readBlock(0x55, SETTINGS_BLOCK);
    expect(before.every((b) => b === 0)).toBe(true);

    // write the settings block (one flag on) and the PC map, then read them back
    const settings = withSetting(new Uint8Array(256), 3, 1);
    await session.writeBlock(0x52, SETTINGS_BLOCK, settings); // resolves on the 05 53 ack
    const pcMap = withPcMap(
      new Uint8Array(256),
      Array.from({ length: 128 }, (_, i) => i),
    );
    await session.writeBlock(0x52, PC_MAP_BLOCK, pcMap);

    expect([...(await session.readBlock(0x55, SETTINGS_BLOCK))]).toEqual([...settings]);
    expect((await session.readBlock(0x55, PC_MAP_BLOCK))[5]).toBe(5);
  });

  it("surfaces paramNotify with the mapped control id", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    wireModel(devIO, model);
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    const events: unknown[] = [];
    session.onParamNotify((e) => events.push(e));
    devIO.send(encode({ kind: "paramNotify", param: 0x05, value: 0x33 })); // Drive
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ paramId: "drive", param: 0x05, value: 0x33 }]);
  });

  it("reads the whole 128-slot library with progress", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    let lastDone = 0;
    const all = await readAllPresets(session, (done) => {
      lastDone = done;
    });
    expect(all).toHaveLength(128);
    expect(lastDone).toBe(128);
    expect(all[7]!.preset.raw[0x27]).toBe(7); // slot 7's distinctive byte
  });

  it("times out on a read before the handshake (pedal ignores it)", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 80);
    await expect(session.readPreset(0)).rejects.toThrow(/timeout/);
  });
});
