import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol/messages";
import { PedalModel } from "../src/device/pedalModel";
import { DeviceSession } from "../src/device/session";
import { createLoopback, type MidiIO } from "../src/device/transport";
import { AMBIENCE_BUNDLES } from "../src/protocol/ambience";
import { PROTOCOL_V1_0, PROTOCOL_V1_1, PROTOCOL_V1_2 } from "../src/protocol/constants";
import { PARAMS, TUNER_BLOB_OFFSET } from "../src/protocol/params";
import { ambienceStore } from "../src/state/ambience";
import { applyAmbienceType, bindSession, createPedalStore } from "../src/state/store";
import { angleToValue, dragToValue, toDisplay, valueToAngle } from "../src/ui/knobMath";

function wireModel(io: MidiIO, model: PedalModel, version?: number): void {
  io.onMessage((bytes) => {
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply, version));
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

  it("firmware 1.1 red footswitch toggle mirrors the Red Zone effect enables (chorus + filter)", async () => {
    // Firmware 1.1 turned the red footswitch into an effects toggle: the pedal force-sets Auto
    // Filter enable (0x3c) and Chorus enable (0x41) to 1/0 but notifies ONLY `05 51 0B 4D <1|0>`.
    // The app must mirror both flags off that one notify or its toggles (and the next save-from-
    // state) keep the pre-toggle values.
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(), PROTOCOL_V1_1);
    const session = new DeviceSession(appIO, 500);
    await session.connect(); // loopback model replies with the fw 1.1 version byte → firmware = 1.1
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().firmware).toBe(1.1);

    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 1 }, PROTOCOL_V1_1)); // engaged
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.chorusOn).toBe(1);
    expect(store.getState().values.autoFilterOn).toBe(1);
    expect(store.getState().dirty).toBe(false); // pedal-initiated, not a local edit

    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 0 }, PROTOCOL_V1_1)); // off
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.chorusOn).toBe(0);
    expect(store.getState().values.autoFilterOn).toBe(0);
    ctl.dispose();
  });

  it("a pedal preset push repairs a Red Zone mirror the long-hold left stale (both directions)", async () => {
    // The red switch's LONG-HOLD (footswitch tuner-engage) runs the same Red-Zone toggle twice — once
    // with the 0x4d notify, once silently on its way into the tuner — so the pedal reverts and the app
    // is left holding the announced half. Symmetric: a hold begun with the Red Zone engaged notifies
    // 4d=0 and then silently turns both flags back ON. Nothing announces the revert and nothing reads
    // live params back, so the ONLY repair is a preset change: it reloads the pedal's live array from
    // the blob and pushes that blob unsolicited. This pins that repair — loadPreset must keep
    // re-sourcing `values` wholesale from the pushed blob, never merge over the stale mirror.
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(), PROTOCOL_V1_1);
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().firmware).toBe(1.1);

    const push = async (autoFilter: number, chorus: number, slot: number): Promise<void> => {
      const blob = new Uint8Array(256);
      blob[0] = 0x01;
      blob[PARAMS.autoFilterOn.blobOffset] = autoFilter;
      blob[PARAMS.chorusOn.blobOffset] = chorus;
      devIO.send(encode({ kind: "presetDump", slot, blob, checksumOk: true }, PROTOCOL_V1_1));
      await new Promise((r) => setTimeout(r, 10));
    };

    // Long-hold from Red Zone OFF: notified 4d=1 → the app mirrors both flags on, the pedal reverted
    // them to 0 in silence. Exiting the tuner with the channel footswitch pushes the dump.
    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 1 }, PROTOCOL_V1_1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.autoFilterOn).toBe(1); // stale — the pedal has 0
    await push(0, 0, 11);
    expect(store.getState().slot).toBe(11);
    expect(store.getState().values.autoFilterOn).toBe(0);
    expect(store.getState().values.chorusOn).toBe(0);
    expect(store.getState().dirty).toBe(false); // repaired state is not an unsaved edit

    // Long-hold from Red Zone ON: notified 4d=0 → the app mirrors both flags off while the pedal
    // silently turned them back on. The same push repairs it in that direction too.
    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 0 }, PROTOCOL_V1_1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().values.chorusOn).toBe(0); // stale — the pedal has 1
    await push(1, 1, 12);
    expect(store.getState().values.autoFilterOn).toBe(1);
    expect(store.getState().values.chorusOn).toBe(1);
    ctl.dispose();
  });

  it("reconciles the Red Zone claim from a loaded preset's own values, in both directions (fw 1.1)", async () => {
    // The pedal re-derives its Red Zone state at the end of every preset load — engaged if ANY of Auto
    // Filter / Chorus / Ambiance is non-zero (RED_ZONE_STATE_PARAMS) — so a preset load is the one
    // moment the app can know the state exactly instead of trusting a 0x4d notify that a long-hold may
    // have silently undone. Both corrections below are ones the notify alone can never make.
    // Pinned to firmware 1.1: 1.2 drops Ambiance from the OR (covered by the next test).
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(), PROTOCOL_V1_1);
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().firmware).toBe(1.1);

    const push = async (ambiance: number, autoFilter: number, chorus: number): Promise<void> => {
      const blob = new Uint8Array(256);
      blob[0] = 0x01;
      blob[PARAMS.ambiance.blobOffset] = ambiance;
      blob[PARAMS.autoFilterOn.blobOffset] = autoFilter;
      blob[PARAMS.chorusOn.blobOffset] = chorus;
      devIO.send(encode({ kind: "presetDump", slot: 3, blob, checksumOk: true }, PROTOCOL_V1_1));
      await new Promise((r) => setTimeout(r, 10));
    };

    // Stale "primary" → engaged. AMBIANCE ALONE engages the Red Zone on the pedal, and it is not one of
    // the params the footswitch force-sets, so on an ambience-bearing preset the pedal comes up engaged
    // (red LED lit) with no wire event ever saying so. Before the reconcile the app claimed "primary"
    // here — and the player's next stomp DISengages, which is baffling unless the state is shown.
    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 0 }, PROTOCOL_V1_1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("primary");
    await push(34, 0, 0);
    expect(store.getState().layer).toBe("red");
    expect(store.getState().dirty).toBe(false); // reconciled state is not an unsaved edit
    // Display only: the reconcile must never fabricate effect flags (that would corrupt the next save).
    expect(store.getState().values.autoFilterOn).toBe(0);
    expect(store.getState().values.chorusOn).toBe(0);

    // Stale "red" → primary. A long-hold from the engaged side announces 4d=1 and then silently
    // reverts; the load re-derives from all three params and clears the claim.
    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 1 }, PROTOCOL_V1_1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("red");
    await push(0, 0, 0);
    expect(store.getState().layer).toBe("primary");

    // Each of the other two engages it on its own too.
    await push(0, 1, 0);
    expect(store.getState().layer).toBe("red");
    await push(0, 0, 1);
    expect(store.getState().layer).toBe("red");

    // And the notify still wins AFTER a load — the reconcile is a load-time correction, not a mirror
    // that overrides live footswitch traffic.
    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 0 }, PROTOCOL_V1_1));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("primary");
    ctl.dispose();
  });

  it("on firmware 1.2, Ambiance alone no longer reads as Red Zone engaged", async () => {
    // Firmware 1.2 removed Ambiance from the derivation the pedal runs at the end of a preset load, so
    // the app's reconcile has to follow the connected pedal's version. Same bytes, same code path, one
    // version byte apart — the ambience-bearing preset that reads "red" on 1.1 must read "primary" here,
    // and the two params the footswitch force-sets must still engage it.
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(), PROTOCOL_V1_2);
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().firmware).toBe(1.2);

    const push = async (ambiance: number, autoFilter: number, chorus: number): Promise<void> => {
      const blob = new Uint8Array(256);
      blob[0] = 0x01;
      blob[PARAMS.ambiance.blobOffset] = ambiance;
      blob[PARAMS.autoFilterOn.blobOffset] = autoFilter;
      blob[PARAMS.chorusOn.blobOffset] = chorus;
      devIO.send(encode({ kind: "presetDump", slot: 3, blob, checksumOk: true }, PROTOCOL_V1_2));
      await new Promise((r) => setTimeout(r, 10));
    };

    await push(34, 0, 0); // the 1.1 first-press trap: gone on 1.2
    expect(store.getState().layer).toBe("primary");
    await push(127, 0, 0); // and not a threshold effect — Ambiance is simply out of the set
    expect(store.getState().layer).toBe("primary");

    await push(0, 1, 0);
    expect(store.getState().layer).toBe("red");
    await push(0, 0, 1);
    expect(store.getState().layer).toBe("red");
    await push(34, 1, 0); // Ambiance neither adds to nor cancels the other two
    expect(store.getState().layer).toBe("red");
    ctl.dispose();
  });

  it("an app-initiated recall reconciles the Red Zone claim too (fw 1.1)", async () => {
    const presets = Array.from({ length: 128 }, (_, i) => {
      const b = new Uint8Array(256);
      b[0] = 0x01;
      b[PARAMS.ambiance.blobOffset] = i === 9 ? 40 : 0; // only slot 9 carries any Ambiance
      return b;
    });
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(presets), PROTOCOL_V1_1);
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    await ctl.recall(9);
    expect(store.getState().layer).toBe("red"); // the pedal derived the same thing from the same bytes
    await ctl.recall(10);
    expect(store.getState().layer).toBe("primary");
    ctl.dispose();
  });

  it("firmware 1.0 red footswitch notify does NOT touch the effect enables (layer shift only)", async () => {
    // On firmware 1.0 the red switch never force-set 0x3c/0x41, so a 1.0-versioned 0x4d notify must
    // leave the effect toggles alone — mirroring there would corrupt state on old pedals.
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(), PROTOCOL_V1_0);
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().firmware).toBe(1.0);

    devIO.send(encode({ kind: "paramNotify", param: 0x4d, value: 1 }, PROTOCOL_V1_0));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().layer).toBe("red"); // the layer still tracks
    expect(store.getState().values.chorusOn).toBeUndefined();
    expect(store.getState().values.autoFilterOn).toBeUndefined();
    ctl.dispose();
  });
});

describe("tuner mirror (MUTE / BYPASS)", () => {
  it("mirrors the mode the session put on the wire, and never as a preset value", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().tuner).toBe(0); // default: Off

    await session.setTunerMode(2, 0);
    expect(store.getState().tuner).toBe(2);
    // The tuner is NOT a modeled param: it must not reach values (a save would then bake it into the
    // user's preset) and it isn't an edit of the sound.
    expect(Object.keys(store.getState().values)).not.toContain("tuner");
    expect(store.getState().dirty).toBe(false);
    ctl.dispose();
  });

  it("resets the mirror to Off when the PEDAL changes preset (footswitch push)", async () => {
    // A recall reloads the live param array from the preset, tuner byte included, so the pedal really
    // is Off after a preset change — and disengaging the tuner with the channel footswitch pushes an
    // unsolicited dump. That push is the resync for the dangerous direction (app says bypassed, signal
    // is live).
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    await session.setTunerMode(1, 0);
    expect(store.getState().tuner).toBe(1);

    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    devIO.send(encode({ kind: "presetDump", slot: 11, blob, checksumOk: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().slot).toBe(11);
    expect(store.getState().tuner).toBe(0);
    ctl.dispose();
  });

  it("resets the mirror to Off when the APP recalls a preset", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    await session.setTunerMode(2, 0);
    await ctl.recall(4);
    expect(store.getState().tuner).toBe(0);
    ctl.dispose();
  });

  it("tracks the exclusive-link window so the bar can disable during an IR transfer", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel());
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);
    expect(store.getState().linkBusy).toBe(false);

    await session.withExclusive(async () => {
      expect(store.getState().linkBusy).toBe(true);
    });
    expect(store.getState().linkBusy).toBe(false);
    ctl.dispose();
  });

  it("adopts a preset's OWN tuner byte on recall, not a hopeful zero", async () => {
    // A preset saved AT THE PEDAL with the tuner engaged stores 1 or 2, and recalling it genuinely
    // engages the tuner — the pedal reloads its live tuner from that byte. Assuming Off would put the
    // mirror wrong in the dangerous direction, on the one preset where it matters.
    const [appIO, devIO] = createLoopback();
    const presets = Array.from({ length: 128 }, () => {
      const b = new Uint8Array(256);
      b[0] = 0x01;
      return b;
    });
    presets[9]![TUNER_BLOB_OFFSET] = 1; // slot 10 recalls muted
    wireModel(devIO, new PedalModel(presets));
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    const store = createPedalStore();
    const ctl = bindSession(session, store);

    await ctl.recall(9);
    expect(store.getState().tuner).toBe(1);
    await ctl.recall(8); // an ordinary preset clears it again
    expect(store.getState().tuner).toBe(0);
    ctl.dispose();
  });
});

describe("ambience type → store single source of truth", () => {
  it("applyAmbienceType marks dirty + writes the modeled profile params into pedalStore.values", () => {
    const store = createPedalStore();
    applyAmbienceType(store, 2); // Spring — its wire-0x10 (ambienceTime) bundle value is 109
    expect(ambienceStore.getState().type).toBe(2);
    expect(ambienceStore.getState().typeDirty).toBe(true);
    // ambienceTime (wire 0x10) is the one profile param that IS modeled — it lands in values + dirty,
    // so a save captures the type the user is hearing (the old code left it stale → the "Spring saved
    // as 51" bug).
    expect(store.getState().values.ambienceTime).toBe(AMBIENCE_BUNDLES[2]![0]);
    expect(store.getState().dirty).toBe(true);
  });

  it("applyAmbienceType ignores an out-of-range type", () => {
    const store = createPedalStore();
    applyAmbienceType(store, 99);
    expect(store.getState().dirty).toBe(false);
  });

  it("markSaved clears dirty, adopts the written base blob, and clears the ambience typeDirty flag", () => {
    const store = createPedalStore();
    applyAmbienceType(store, 2); // sets dirty + typeDirty
    expect(store.getState().dirty).toBe(true);
    const written = new Uint8Array(256);
    written[0] = 0x42;
    store.getState().markSaved(written);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().raw).toBe(written); // saved blob becomes the base for the next save
    expect(ambienceStore.getState().typeDirty).toBe(false);
  });
});
