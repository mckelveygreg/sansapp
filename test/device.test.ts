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

  it("paces a reply-expecting read behind a fire-and-forget send (BLE anti-drop)", async () => {
    // Over BLE the pedal drops a read that lands in the same connection interval as a preceding
    // fire-and-forget send (setParam knob-move, hello, 0x5B, writePreset commit) — those bypass the
    // request queue. request() must wait out sendGapMs since the last send so the read reaches the
    // wire in a fresh interval. Regression guard for the connect→loadCurrent edit-buffer timeout.
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    const recv: { kind: string; t: number }[] = [];
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      recv.push({ kind: m.kind, t: Date.now() });
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const GAP = 50;
    const session = new DeviceSession(appIO, 1000, 0, GAP); // sendGapMs = 50

    await session.connect();
    recv.length = 0; // ignore handshake traffic; focus on the send→read collision below

    session.setParam("drive", 42); // fire-and-forget, bypasses the request queue
    const p = await session.readPreset(7); // must NOT collide with the setParam above
    expect(p.raw[0x27]).toBe(7);

    const sent = recv.find((r) => r.kind === "setParam");
    const read = recv.find((r) => r.kind === "requestPreset");
    expect(sent && read).toBeTruthy();
    // Without the pacing this gap is ~0 (both fire in adjacent microtasks) and the read would be
    // dropped on real hardware; with it, the read waits out (most of) the send gap.
    expect(read!.t - sent!.t).toBeGreaterThanOrEqual(GAP - 10);
  });

  it("rides out a transient send failure while replies are still arriving (no disconnect)", async () => {
    // Regression: an IR refresh's read burst can trip a transient CoreMIDI destination drop; a lone
    // send throw must NOT tear down the session when the link is provably alive (recent replies).
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 500, 5000, 0);
    await session.connect(); // handshake replies set "last received" ≈ now
    expect(session.state).toBe("ready");

    const realSend = appIO.send;
    appIO.send = () => {
      throw new Error("destination not found"); // simulate a transient port drop
    };
    session.setParam("drive", 42); // fire-and-forget → send() throws → onSendFailure
    expect(session.state).toBe("ready"); // tolerated: we just received, so the link is alive
    appIO.send = realSend;
  });

  it("setParamsPaced fires every param (masked), gapped so BLE doesn't drop the burst", async () => {
    // The 10-param ambience profile lost most sends when fired back-to-back — the pedal drops
    // fire-and-forget sends that land in one BLE connection interval. setParamsPaced gaps them by
    // sendGapMs (the same pacing connect() uses). Verify each param reaches the wire, value masked
    // to 7 bits, and consecutive sends are separated by ~sendGapMs (not adjacent microtasks).
    const [appIO, devIO] = createLoopback();
    const seen: { param: number; value: number; t: number }[] = [];
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "setParam") seen.push({ param: m.param, value: m.value, t: Date.now() });
    });
    const GAP = 20;
    const session = new DeviceSession(appIO, 1000, 0, GAP); // sendGapMs = GAP

    const sets = [
      { param: 0x14, value: 47 },
      { param: 0x16, value: 0x85 }, // > 0x7f → masked to 0x05
      { param: 0x17, value: 3 },
    ];
    await session.setParamsPaced(sets);
    await new Promise((r) => setTimeout(r, 5)); // flush the last loopback microtask

    expect(seen.map((s) => ({ param: s.param, value: s.value }))).toEqual([
      { param: 0x14, value: 47 },
      { param: 0x16, value: 0x05 },
      { param: 0x17, value: 3 },
    ]);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.t - seen[i - 1]!.t).toBeGreaterThanOrEqual(GAP - 10);
    }
  });
});
