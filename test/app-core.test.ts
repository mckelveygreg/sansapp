import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol/messages";
import { PedalModel } from "../src/device/pedalModel";
import { DeviceSession } from "../src/device/session";
import { createLoopback, type MidiIO } from "../src/device/transport";
import { bindSession, createPedalStore } from "../src/state/store";
import { angleToValue, dragToValue, toDisplay, valueToAngle } from "../src/ui/knobMath";

function wireModel(io: MidiIO, model: PedalModel): void {
  io.onMessage((bytes) => {
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply));
  });
}

describe("knob math", () => {
  it("maps value↔angle across the 270° sweep", () => {
    expect(valueToAngle(0)).toBe(-135);
    expect(valueToAngle(127)).toBe(135);
    expect(Math.abs(valueToAngle(63.5))).toBeLessThan(0.001); // center
    expect(angleToValue(-135)).toBe(0);
    expect(angleToValue(135)).toBe(127);
  });

  it("drags up to increase, clamps at the rails", () => {
    // pixelsForFullSweep=127 → 1px == 1 unit; drag up 50px from 20 → 70
    expect(dragToValue(20, -50, { pixelsForFullSweep: 127 })).toBe(70);
    expect(dragToValue(64, 1000)).toBe(0); // far down → min
    expect(dragToValue(64, -100000)).toBe(127); // far up → max
  });

  it("displays 0..127 on a 0..10 scale", () => {
    expect(toDisplay(0)).toBe(0);
    expect(toDisplay(127)).toBe(10);
  });
});

describe("pedal store + controller", () => {
  it("recall loads values; local edits set dirty and reach the device", async () => {
    const [appIO, devIO] = createLoopback();
    const presets = Array.from({ length: 128 }, (_, i) => {
      const b = new Uint8Array(256);
      b[0] = 0x01;
      b[0x27] = i & 0x7f; // Drive offset
      return b;
    });
    const model = new PedalModel(presets);
    wireModel(devIO, model);
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    const store = createPedalStore();
    const ctl = bindSession(session, store);

    // connection state propagated
    expect(store.getState().connection).toBe("ready");

    await ctl.recall(7);
    expect(store.getState().slot).toBe(7);
    expect(store.getState().values.drive).toBe(7); // Drive offset 0x27 = 7 for slot 7
    expect(store.getState().dirty).toBe(false);

    // a local edit marks dirty and is sent live (no throw = reached transport)
    ctl.setValue("drive", 100);
    expect(store.getState().values.drive).toBe(100);
    expect(store.getState().dirty).toBe(true);

    ctl.dispose();
  });

  it("reflects an external (physical knob) change without setting dirty", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    bindSession(session, store);

    devIO.send(encode({ kind: "paramNotify", param: 0x05, value: 0x40 })); // physical Drive
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.drive).toBe(0x40);
    expect(store.getState().dirty).toBe(false); // external change isn't a local edit
  });

  it("physical AMBIANCE knob (0x08) updates values.ambiance — the deep page's Level (issue #39)", async () => {
    // The Ambience deep page renders `pedalStore.values.ambiance`, so a physical-knob notify for wire
    // 0x08 must land there live. Confirmed on hardware the pedal emits `05 51 0A 08 <v>` for that knob
    // (captures/settings-map.jsonl); this locks the app half of the round-trip.
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    devIO.send(encode({ kind: "paramNotify", param: 0x08, value: 56 })); // physical AMBIANCE knob
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.ambiance).toBe(56);
    expect(store.getState().dirty).toBe(false);
    ctl.dispose();
  });

  it("tracks the knob layer from the 0x4d footswitch notify (and never as a knob value)", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    expect(store.getState().layer).toBe("primary"); // default

    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 1 })); // red SHIFT engaged
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("red");
    expect(store.getState().values.highFreq).toBeUndefined(); // 0x4d must NOT jog High Freq
    expect(store.getState().dirty).toBe(false);

    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 0 })); // back to primary
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("primary");
    ctl.dispose();
  });
});
