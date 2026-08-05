import { describe, expect, it, vi } from "vitest";
import { decode, encode, sysexVersion } from "../src/protocol/messages";
import { PROTOCOL_V1_0, PROTOCOL_V1_1 } from "../src/protocol/constants";
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
    await session.writePreset(3, blob); // resolves only after the stage ack + the save-echo commit
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

// ── Firmware-version negotiation (byte 6) ───────────────────────────────────────────────────────
// Firmware 1.1 changed byte 6 from 0x0A to 0x0B and the pedal answers only its own version, so a
// build pinned to one version goes silent against the other. These prove one SansApp build talks to
// both: it probes, then mirrors whatever version the pedal replies in.

/** Wire a model that IGNORES any message not in `version` — how the real pedal behaves. */
function wireModelAtVersion(io: MidiIO, model: PedalModel, version: number): void {
  io.onMessage((bytes) => {
    if (sysexVersion(bytes) !== version) return; // wrong firmware version: pedal stays silent
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply, version));
  });
}

describe("protocol version negotiation", () => {
  it("connects to a firmware 1.1 pedal and reports 1.1", async () => {
    const [appIO, devIO] = createLoopback();
    wireModelAtVersion(devIO, new PedalModel(makePresets()), PROTOCOL_V1_1);
    const session = new DeviceSession(appIO, 300);

    await session.connect();
    expect(session.state).toBe("ready");
    expect(session.firmwareVersion).toBe(1.1);
    expect(session.protocolVersion).toBe(PROTOCOL_V1_1);
  });

  it("falls back and connects to a firmware 1.0 pedal, then speaks 1.0", async () => {
    const [appIO, devIO] = createLoopback();
    wireModelAtVersion(devIO, new PedalModel(makePresets()), PROTOCOL_V1_0);
    const session = new DeviceSession(appIO, 300);
    const seen: number[] = [];
    session.onFirmwareVersion((v) => seen.push(v));

    await session.connect();
    expect(session.state).toBe("ready");
    expect(session.firmwareVersion).toBe(1.0);
    expect(session.protocolVersion).toBe(PROTOCOL_V1_0);
    expect(seen).toEqual([1.0]);

    // and everything AFTER the handshake keeps using 1.0 — a read must still round-trip
    const p5 = await session.readPreset(5);
    expect(p5.raw[0x27]).toBe(5);
  });

  it("outbound sends carry the negotiated version byte", async () => {
    const [appIO, devIO] = createLoopback();
    wireModelAtVersion(devIO, new PedalModel(makePresets()), PROTOCOL_V1_0);
    const sent: Uint8Array[] = [];
    devIO.onMessage((b) => sent.push(b.slice()));
    const session = new DeviceSession(appIO, 300);
    await session.connect();

    session.setLiveParam(0x05, 0x28);
    await new Promise((r) => setTimeout(r, 80));
    const setParams = sent.filter((b) => b[5] === 0x50);
    expect(setParams.length).toBeGreaterThan(0);
    expect(setParams.every((b) => b[6] === PROTOCOL_V1_0)).toBe(true);
  });
});

// ── FIX BATCH 3: session/BLE lifecycle hardening ────────────────────────────────────────────────

/** A 256-byte preset blob with a distinctive Drive byte. */
function buildBlob(mark: number): Uint8Array {
  const b = new Uint8Array(256);
  b[0] = 0x01;
  b[0x27] = mark & 0x7f;
  return b;
}

/** A `05 41` preset dump for `slot` with a deliberately CORRUPTED checksum. */
function corruptDump(slot: number): Uint8Array {
  const good = encode({ kind: "presetDump", slot, blob: buildBlob(slot), checksumOk: true });
  const bad = good.slice();
  bad[bad.length - 2] = (bad[bad.length - 2]! ^ 0x7f) & 0x7f; // flip the low checksum byte
  return bad;
}

/** An IO that records the setParams put on the wire (for the live-throttle tests). */
function recordSetParams(): { io: MidiIO; sent: { param: number; value: number }[] } {
  const sent: { param: number; value: number }[] = [];
  const io: MidiIO = {
    send: (b) => {
      const m = decode(b);
      if (m.kind === "setParam") sent.push({ param: m.param, value: m.value });
    },
    onMessage: () => () => {},
    close: () => {},
  };
  return { io, sent };
}

describe("DeviceSession hardening (batch 3)", () => {
  // ── item 2: slot validation ──
  it("writePreset rejects the special/edit-buffer slots 0x7E/0x7F", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    await expect(session.writePreset(0x7f, buildBlob(1))).rejects.toThrow(/not writable/i);
    await expect(session.writePreset(0x7e, buildBlob(1))).rejects.toThrow(/not writable/i);
    // a normal slot still writes and commits
    await session.writePreset(0x7d, buildBlob(0x42));
  });

  // ── item 3a: reply integrity (checksum required) ──
  it("a corrupt preset dump does NOT resolve the read (checksum required)", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "requestPreset") {
        devIO.send(corruptDump(m.slot)); // bad-checksum dump — must be ignored
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 60);
    await session.connect();
    await expect(session.readPreset(3)).rejects.toThrow(/timeout/);
  });

  // ── item 3b: writeAck code correlation ──
  it("writePreset stage ignores a non-0x21 writeAck (a stray IR begin-ack 0x63)", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "writePreset") {
        devIO.send(encode({ kind: "writeAck", code: 0x63 })); // wrong ack code
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 60);
    await session.connect();
    await expect(session.writePreset(3, buildBlob(0x42))).rejects.toThrow(/timeout/);
  });

  it("writeBlock ignores a non-0x53 writeAck", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "block") {
        devIO.send(encode({ kind: "writeAck", code: 0x21 })); // a preset-write ack, not a block ack
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 60);
    await session.connect();
    await expect(session.writeBlock(0x52, SETTINGS_BLOCK, new Uint8Array(256))).rejects.toThrow(
      /timeout/,
    );
  });

  // ── item 3c: late-reply tombstone ──
  it("drops a LATE reply to a timed-out read instead of firing a footswitch push", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "requestPreset") {
        // reply AFTER the read has already timed out (BLE round-trip > timeout)
        setTimeout(
          () =>
            devIO.send(
              encode({
                kind: "presetDump",
                slot: m.slot,
                blob: buildBlob(m.slot),
                checksumOk: true,
              }),
            ),
          60,
        );
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 30); // 30 ms timeout < 60 ms late reply
    await session.connect();
    const pushes: number[] = [];
    session.onPushedPreset((slot) => pushes.push(slot));
    await expect(session.readPreset(7)).rejects.toThrow(/timeout/);
    await new Promise((r) => setTimeout(r, 90)); // let the late reply arrive
    expect(pushes).toEqual([]); // recognized as a dead request, NOT a preset switch
  });

  it("still applies a genuine unsolicited footswitch push (no tombstone)", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 200);
    await session.connect();
    const pushes: number[] = [];
    session.onPushedPreset((slot) => pushes.push(slot));
    devIO.send(encode({ kind: "presetDump", slot: 9, blob: buildBlob(9), checksumOk: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(pushes).toEqual([9]);
  });

  // ── item 4: withExclusive ──
  it("withExclusive serializes exclusive ops and keeps queued requests from interleaving", async () => {
    const [appIO, devIO] = createLoopback();
    wireModel(devIO, new PedalModel(makePresets()));
    const session = new DeviceSession(appIO, 500);
    await session.connect();

    const order: string[] = [];
    const p1 = session.withExclusive(async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("A-end");
    });
    const p2 = session.withExclusive(async () => {
      order.push("B-start");
      order.push("B-end");
    });
    const p3 = session.readPreset(1).then(() => order.push("read"));
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end", "read"]);
  });

  it("suspends the heartbeat while an exclusive op holds the link, and resumes after", async () => {
    vi.useFakeTimers();
    try {
      const [appIO, devIO] = createLoopback();
      const model = new PedalModel(makePresets());
      const blockReads: number[] = [];
      devIO.onMessage((bytes) => {
        const m = decode(bytes);
        if (m.kind === "requestBlock") blockReads.push(Date.now());
        for (const reply of model.handle(m)) devIO.send(encode(reply));
      });
      const session = new DeviceSession(appIO, 500, 50); // heartbeat every 50 ms
      await session.connect();
      const afterConnect = blockReads.length;

      let release!: () => void;
      const ex = session.withExclusive(() => new Promise<void>((r) => (release = r)));
      await Promise.resolve(); // let withExclusive's body start (exclusive = true)

      await vi.advanceTimersByTimeAsync(4000); // past the quiet window + many heartbeat ticks
      expect(blockReads.length).toBe(afterConnect); // heartbeat suspended — no probe fired

      release();
      await ex;
      await vi.advanceTimersByTimeAsync(4000); // link idle again → heartbeat resumes and probes
      expect(blockReads.length).toBeGreaterThan(afterConnect);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── item 6: live-param coalescing ──
  it("coalesces live-param drags to the trailing value (leading + trailing edge)", () => {
    vi.useFakeTimers();
    try {
      const { io, sent } = recordSetParams();
      const session = new DeviceSession(io, 500);
      session.setLiveParam(0x14, 10);
      session.setLiveParam(0x14, 11);
      session.setLiveParam(0x14, 12); // final
      expect(sent).toEqual([{ param: 0x14, value: 10 }]); // only the leading edge so far
      vi.advanceTimersByTime(60); // > LIVE_THROTTLE_MS
      expect(sent).toEqual([
        { param: 0x14, value: 10 },
        { param: 0x14, value: 12 }, // trailing edge always carries the FINAL value
      ]);
      vi.advanceTimersByTime(60);
      expect(sent).toHaveLength(2); // nothing pending → no extra sends
    } finally {
      vi.useRealTimers();
    }
  });

  it("live-param: distinct params don't block each other; a single value is always sent", () => {
    vi.useFakeTimers();
    try {
      const { io, sent } = recordSetParams();
      const session = new DeviceSession(io, 500);
      session.setLiveParam(0x14, 1);
      session.setLiveParam(0x16, 0x85); // masked to 0x05
      expect(sent).toEqual([
        { param: 0x14, value: 1 },
        { param: 0x16, value: 0x05 },
      ]); // both leading, independent, masked
      vi.advanceTimersByTime(60);
      expect(sent).toHaveLength(2); // neither had a newer value → no trailing sends
    } finally {
      vi.useRealTimers();
    }
  });

  // ── item 7: setParamsPaced leading gap ──
  it("setParamsPaced paces its FIRST send off the last outbound byte", async () => {
    const [appIO, devIO] = createLoopback();
    const recv: { kind: string; t: number }[] = [];
    devIO.onMessage((bytes) => recv.push({ kind: decode(bytes).kind, t: Date.now() }));
    const GAP = 40;
    const session = new DeviceSession(appIO, 1000, 0, GAP);
    session.sendRaw(encode({ kind: "control", code: 0x5b })); // stamps lastSendAt
    const t0 = Date.now();
    await session.setParamsPaced([
      { param: 0x14, value: 1 },
      { param: 0x16, value: 2 },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    const first = recv.find((r) => r.kind === "setParam");
    expect(first).toBeTruthy();
    expect(first!.t - t0).toBeGreaterThanOrEqual(GAP - 10); // first send waited out the gap
  });

  // ── item 8: librarian retry ──
  it("readAllPresets retries a slot whose first read times out", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    let dropped = false;
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "requestPreset" && m.slot === 0 && !dropped) {
        dropped = true; // swallow the first read of slot 0 → it times out → retry
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 60);
    await session.connect();
    const all = await readAllPresets(session);
    expect(all).toHaveLength(128);
    expect(all[0]!.preset.raw[0x27]).toBe(0); // slot 0 recovered on the retry
  });

  it("readAllPresets gives up after the retries if a slot never replies", async () => {
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (m.kind === "requestPreset" && m.slot === 0) return; // slot 0 never replies
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 40);
    await session.connect();
    await expect(readAllPresets(session)).rejects.toThrow(/timeout/);
  });
});

// ── FIX BATCH 5: PedalModel fidelity to observed hardware behavior ────────────────────────────────

describe("PedalModel behavior (batch 5)", () => {
  it("echoes a 05 41 dump when the app SAVES a numbered slot (setParam 0x12 = <slot>)", () => {
    const model = new PedalModel(makePresets());
    const staged = new Uint8Array(256);
    staged[0] = 0x01;
    staged[0x27] = 0x55;
    model.handle({ kind: "writePreset", slot: 3, blob: staged, checksumOk: true });
    const replies = model.handle({ kind: "setParam", param: 0x12, value: 3 });
    expect(replies).toHaveLength(1);
    const echo = replies[0]!;
    expect(echo.kind).toBe("presetDump");
    if (echo.kind === "presetDump") {
      expect(echo.slot).toBe(3);
      expect(echo.blob[0x27]).toBe(0x55); // the just-staged blob
    }
  });

  it("models save-to-program-128 for setParam 0x12 = 0x7F (echoes a slot 0x7F dump)", () => {
    const model = new PedalModel(makePresets());
    const replies = model.handle({ kind: "setParam", param: 0x12, value: 0x7f });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.kind).toBe("presetDump");
    if (replies[0]!.kind === "presetDump") expect(replies[0]!.slot).toBe(0x7f);
  });

  it("every other setParam is live-only (no reply)", () => {
    const model = new PedalModel(makePresets());
    expect(model.handle({ kind: "setParam", param: 0x05, value: 0x40 })).toEqual([]);
  });

  it("acks a config/data block WRITE with 05 53", () => {
    const model = new PedalModel(makePresets());
    const replies = model.handle({
      kind: "block",
      blockCode: 0x52,
      index: 0,
      data: new Uint8Array(256),
      checksumOk: true,
    });
    expect(replies).toEqual([{ kind: "writeAck", code: 0x53 }]);
  });

  it("DISCARDS a 0x7F edit-buffer write but still acks 05 21 (matches hardware)", () => {
    const model = new PedalModel(makePresets());
    const before = model.editBuffer.slice();
    const blob = new Uint8Array(256);
    blob[0] = 0x01;
    blob[0x27] = 0x7a;
    const replies = model.handle({ kind: "writePreset", slot: 0x7f, blob, checksumOk: true });
    expect(replies).toEqual([{ kind: "writeAck", code: 0x21 }]);
    expect([...model.editBuffer]).toEqual([...before]); // the stage was discarded — nothing changed
  });

  it("still writes a numbered slot (0x7D) on a writePreset", () => {
    const model = new PedalModel(makePresets());
    const blob = new Uint8Array(256);
    blob[0x27] = 0x66;
    model.handle({ kind: "writePreset", slot: 0x7d, blob, checksumOk: true });
    expect(model.presets[0x7d]![0x27]).toBe(0x66);
  });
});
