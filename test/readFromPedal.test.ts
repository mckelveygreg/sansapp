/**
 * Read from Pedal — recovering the pedal's unsaved on-pedal tweaks by asking it to write live state
 * down, then putting the slot back (docs/adr/0001).
 *
 * The emulator models the mechanism the feature rides on: a live parameter array that a `05 50` write
 * lands in, a bare commit that builds its flash blob from that array, and a `05 20` stage that
 * refreshes it (which is why step 5, the re-apply, exists at all).
 */
import { describe, expect, it } from "vitest";
import { PedalModel } from "../src/device/pedalModel";
import { DeviceSession } from "../src/device/session";
import {
  REAPPLY_PARAM_INDICES,
  readFromPedal,
  type ReadFromPedalProgress,
} from "../src/device/readFromPedal";
import { createLoopback, type MidiIO } from "../src/device/transport";
import { decode, encode } from "../src/protocol/messages";
import { PARAM_REGION_START } from "../src/protocol/constants";
import { TUNER_PARAM, USER_IR_ADDRESS_PARAMS, liveSetId } from "../src/protocol/params";

function wireModel(io: MidiIO, model: PedalModel): void {
  io.onMessage((bytes) => {
    for (const reply of model.handle(decode(bytes))) io.send(encode(reply));
  });
}

function makePresets(): Uint8Array[] {
  return Array.from({ length: 128 }, (_, i) => {
    const b = new Uint8Array(256);
    b[0] = 0x01;
    b[0x27] = i & 0x7f; // distinctive per-slot Drive byte
    b[PARAM_REGION_START] = 64; // Level
    return b;
  });
}

/** A connected session on a model already sitting on `slot`. */
async function attach(slot: number): Promise<{ model: PedalModel; session: DeviceSession }> {
  const [appIO, devIO] = createLoopback();
  const model = new PedalModel(makePresets());
  wireModel(devIO, model);
  const session = new DeviceSession(appIO, 500);
  await session.connect();
  await session.recallPreset(slot);
  return { model, session };
}

/** Turn knobs at the pedal: live sets that never touch flash. */
async function tweakAtPedal(
  session: DeviceSession,
  tweaks: readonly (readonly [number, number])[],
): Promise<void> {
  await session.setParamsPaced(tweaks.map(([idx, value]) => ({ param: liveSetId(idx), value })));
}

const P = (blob: Uint8Array, index: number): number => blob[PARAM_REGION_START + index]!;
// `restore` zeroes the verify's own settle/backoff too — without it every failing-restore case below
// pays VERIFY_SETTLE_MS twice, which cost the suite ~11 s.
const FAST = { gapMs: 0, settleMs: 0, restore: { settleMs: 0, backoffMs: 0 } };

describe("readFromPedal", () => {
  it("recovers live state, puts the slot back, and leaves the pedal hearing the tweaks", async () => {
    const { model, session } = await attach(3);
    const stored = model.presets[3]!.slice();
    await tweakAtPedal(session, [
      [0x00, 100], // Level
      [0x05, 90], // Drive
      [0x47, 17], // Blend — a deep param, set on 0x4B
    ]);

    const result = await readFromPedal(session, FAST);

    expect(result.slot).toBe(3);
    expect(result.problem).toBeNull();
    expect(result.restored).toBe(true);
    expect(result.reapplied).toBe(true);
    // 1. the captured blob is what the player is hearing, not what slot 3 stores
    expect(P(result.live, 0x00)).toBe(100);
    expect(P(result.live, 0x05)).toBe(90);
    expect(P(result.live, 0x47)).toBe(17);
    expect(P(stored, 0x05)).toBe(3);
    // 2. the slot is byte-exactly back
    expect([...model.presets[3]!]).toEqual([...stored]);
    // 3. and so is the sound — the re-apply undid what the restore's stage reverted
    expect(model.live[0x00]).toBe(100);
    expect(model.live[0x05]).toBe(90);
    expect(model.live[0x47]).toBe(17);
  });

  it("forces the tuner Off, so an engaged tuner can't report a dead rig as the truth", async () => {
    // The pedal zeroes the LIVE Level before building a commit's blob when its tuner is engaged, and
    // it never reports tuner state — so the app makes the precondition true instead of trusting a
    // mirror. Without the force, the captured Level here would be 0 and the player's Level lost.
    const { model, session } = await attach(3);
    await tweakAtPedal(session, [[0x00, 100]]);
    model.tunerWritten = 1; // the player stomped the tuner at the pedal; nothing said so on the wire
    model.tuner = 1;

    const result = await readFromPedal(session, FAST);

    expect(P(result.live, 0x00)).toBe(100);
    expect(model.tunerWritten).toBe(0);
  });

  it("never re-applies the tuner or the user-IR address words", async () => {
    const { session } = await attach(3);
    const sets: number[] = [];
    // Spy on every live set the operation puts on the wire.
    const original = session.setParamsPaced.bind(session);
    session.setParamsPaced = async (batch, minGapMs) => {
      for (const s of batch) sets.push(s.param);
      return original(batch, minGapMs);
    };

    await readFromPedal(session, FAST);

    for (const index of [TUNER_PARAM, ...USER_IR_ADDRESS_PARAMS]) {
      // The tuner's set-id IS sent once — as the forced Off — but never carrying a captured value.
      const sent = sets.filter((p) => p === liveSetId(index));
      if (index === TUNER_PARAM) expect(sent).toHaveLength(1);
      else expect(sent).toHaveLength(0);
    }
    expect(REAPPLY_PARAM_INDICES).toHaveLength(69); // the count the hardware run proved (69/69)
    expect(REAPPLY_PARAM_INDICES).toContain(0x0e); // IR select IS recovered — settled on hardware
  });

  it("reports progress through the stages, counting the re-applied params", async () => {
    const { session } = await attach(3);
    const seen: ReadFromPedalProgress[] = [];

    await readFromPedal(session, { ...FAST, onProgress: (p) => seen.push(p) });

    expect(seen.map((p) => p.stage).filter((s, i, a) => s !== a[i - 1])).toEqual([
      "tuner",
      "backup",
      "capture",
      "restore",
      "reapply",
      "done",
    ]);
    const reapply = seen.filter((p) => p.stage === "reapply");
    expect(reapply.at(-1)).toEqual({
      stage: "reapply",
      done: REAPPLY_PARAM_INDICES.length,
      total: REAPPLY_PARAM_INDICES.length,
    });
  });

  it("refuses while an IR transfer owns the link", async () => {
    const { session } = await attach(3);
    let release = (): void => {};
    const held = session.withExclusive(() => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 0)); // withExclusive chains on the queue — let it take
    expect(session.linkBusy).toBe(true);
    await expect(readFromPedal(session, FAST)).rejects.toThrow(/IR transfer/);
    release();
    await held;
  });

  it("refuses on a program the pedal won't let us write back (above 0x7D)", async () => {
    const { model, session } = await attach(3);
    model.currentSlot = 0x7f; // sitting on program 128 (INIT)
    await expect(readFromPedal(session, FAST)).rejects.toThrow(/128/);
  });

  it("aborts before writing anything if the backup read fails", async () => {
    const { model, session } = await attach(3);
    const stored = model.presets[3]!.slice();
    await tweakAtPedal(session, [[0x05, 90]]);
    session.readPreset = () => Promise.reject(new Error("timeout awaiting reply to requestPreset"));

    await expect(readFromPedal(session, FAST)).rejects.toThrow(/timeout/);
    expect([...model.presets[3]!]).toEqual([...stored]); // nothing was committed
    expect(model.live[0x05]).toBe(90); // and the player's tweak is untouched
  });

  it("still returns the captured values, and re-applies them, when the restore fails", async () => {
    const { model, session } = await attach(3);
    const stored = model.presets[3]!.slice();
    await tweakAtPedal(session, [[0x05, 90]]);
    session.writePreset = () =>
      Promise.reject(new Error("preset 4 save not confirmed by the pedal"));

    const result = await readFromPedal(session, FAST);

    expect(P(result.live, 0x05)).toBe(90); // the recovery itself worked — don't throw it away
    expect(result.restored).toBe(false);
    expect(result.problem).toMatch(/preset 4/);
    expect([...result.stored]).toEqual([...stored]); // the backup is kept, for a one-tap retry
    expect(model.live[0x05]).toBe(90); // re-apply ran regardless: a partial restore reverts live
  });

  it("undoes a capture whose commit never confirmed — it may still have landed", async () => {
    const { model, session } = await attach(3);
    const stored = model.presets[3]!.slice();
    await tweakAtPedal(session, [[0x05, 90]]);
    // The commit reaches the pedal and writes flash; only its echo is lost, so the session gives up.
    const realCommit = session.commitLive.bind(session);
    session.commitLive = async (slot) => {
      await realCommit(slot);
      throw new Error(`preset ${slot + 1} save not confirmed by the pedal`);
    };

    await expect(readFromPedal(session, FAST)).rejects.toThrow(/is untouched/);
    expect([...model.presets[3]!]).toEqual([...stored]); // the player's preset is back
  });

  it("catches a restore whose stage was lost, even though the pedal's echo agrees with flash", async () => {
    // The failure the verify exists for: the `05 20` stage is acked but never applied, so the commit
    // builds its blob from the LIVE array. The echo and the read-back then agree perfectly — and both
    // are the player's live values, not their preset. Verifying against the echo would call this a
    // success and walk away from an overwritten preset.
    const [appIO, devIO] = createLoopback();
    const model = new PedalModel(makePresets());
    let swallowStage = false;
    devIO.onMessage((bytes) => {
      const m = decode(bytes);
      if (swallowStage && m.kind === "writePreset") {
        devIO.send(encode({ kind: "writeAck", code: 0x21 })); // acked, but nothing applied
        return;
      }
      for (const reply of model.handle(m)) devIO.send(encode(reply));
    });
    const session = new DeviceSession(appIO, 500);
    await session.connect();
    await session.recallPreset(3);
    await tweakAtPedal(session, [[0x05, 90]]);
    swallowStage = true;

    const result = await readFromPedal(session, FAST);

    expect(result.restored).toBe(false);
    expect(result.problem).toMatch(/didn't read back as written/);
    expect(model.presets[3]![0x27]).toBe(90); // and indeed: the slot really is holding live state
  });

  it("flags a restore that doesn't read back", async () => {
    const { model, session } = await attach(3);
    const realRead = session.readPreset.bind(session);
    let reads = 0;
    session.readPreset = async (slot) => {
      const p = await realRead(slot);
      if (++reads === 1) return p; // the backup read is honest
      const corrupt = p.raw.slice();
      corrupt[0x27] ^= 0xff; // …the verify read comes back wrong
      return { ...p, raw: corrupt };
    };

    const result = await readFromPedal(session, FAST);

    expect(result.restored).toBe(false);
    expect(result.problem).toMatch(/preset 4/);
    expect(model.presets[3]).toBeDefined();
  });

  it("names the bytes that disagreed, so a mismatch is diagnosable after the fact", async () => {
    // The whole point: before this, a mismatch collapsed to a boolean and the failure told nobody
    // which byte moved — leaving a real hardware failure impossible to diagnose.
    const { session } = await attach(3);
    const realRead = session.readPreset.bind(session);
    let reads = 0;
    session.readPreset = async (slot) => {
      const p = await realRead(slot);
      if (++reads === 1) return p; // the backup read is honest
      const corrupt = p.raw.slice();
      corrupt[0x27] = (p.raw[0x27]! ^ 0xff) & 0x7f;
      return { ...p, raw: corrupt };
    };

    const result = await readFromPedal(session, FAST);

    expect(result.restored).toBe(false);
    expect(result.problem).toMatch(/1 byte differs: 0x27 want [0-9a-f]+ got [0-9a-f]+/);
  });

  it("survives a single stale verify read — the second attempt settles and passes", async () => {
    // A read that answers from before the commit landed returns the laundered live blob, which looks
    // exactly like the failure the verify hunts for. One of those must not doom the restore.
    const { session } = await attach(3);
    await tweakAtPedal(session, [[0x05, 90]]);
    const realRead = session.readPreset.bind(session);
    let reads = 0;
    session.readPreset = async (slot) => {
      const p = await realRead(slot);
      if (++reads !== 2) return p; // 1 = backup, 2 = first verify, 3 = the retry's verify
      const stale = p.raw.slice();
      stale[0x27] = 90; // what the launder left in the slot a moment earlier
      return { ...p, raw: stale };
    };

    const result = await readFromPedal(session, FAST);

    expect(result.restored).toBe(true);
    expect(result.problem).toBeNull();
    expect(reads).toBe(3); // it really did take the retry
  });

  it("asks for a footswitch press when the Red Zone can't survive the restore", async () => {
    // The stored preset has every Red Zone param at 0, so the restore's stage makes the pedal derive
    // *disengaged* — while the player had Auto Filter on. 0x4d is notify-only, so all we can do is say.
    const { session } = await attach(3);
    await tweakAtPedal(session, [[0x3c, 1]]);

    const result = await readFromPedal(session, FAST);

    expect(P(result.live, 0x3c)).toBe(1);
    expect(P(result.stored, 0x3c)).toBe(0);
    expect(result.redZoneNeedsPress).toBe("engage");
  });

  it("says nothing about the Red Zone when it lands the same either way", async () => {
    const { session } = await attach(3);
    await tweakAtPedal(session, [[0x05, 90]]);

    const result = await readFromPedal(session, FAST);

    expect(result.redZoneNeedsPress).toBeNull();
  });
});
