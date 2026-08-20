/**
 * **Read from Pedal** — recover the unsaved tweaks a player made at the pedal.
 *
 * The pedal's live parameter state is write-only over the wire: no command returns it, and Tech 21's
 * own editor has the identical blind spot. What *does* work is a **bare save command with no
 * preceding stage** — the pedal then builds its flash blob from the live array and echoes it back. So
 * this reads live state by asking the pedal to write it down, and puts the slot back afterwards.
 *
 * **A reader who finds a "read" performing two flash writes will assume it is a bug. It is not.**
 * See `docs/adr/0001-read-live-state-by-laundering-through-flash.md` for why there is no alternative,
 * what was rejected, and the consequences. The sequence:
 *
 * 1. Force the tuner Off — committing with it engaged zeroes the *live* Level, so the echo would
 *    report a dead rig as truth. The app can't read tuner state, so it makes the precondition true.
 * 2. Re-read the active slot's stored blob. This is the backup, and the read must succeed.
 * 3. Bare-commit to the **active** slot. Its echo is live state. (The active slot, deliberately: a
 *    save to any other slot moves the pedal's active program there, switching the rig mid-session.)
 * 4. Restore the slot from step 2's blob, and verify it by reading it back.
 * 5. **Re-apply** the captured values as live params. Not optional: the `05 20` stage inside step 4
 *    refreshes the pedal's live array from the blob, so without this the feature audibly destroys the
 *    very tweaks it was invoked to recover.
 *
 * Steps 1–3 abort on failure and the caller just sees a throw — the pedal is left as it was (a step-3
 * commit that never confirmed is undone first, because it may nonetheless have landed). Once the
 * capture is in hand the operation is committed: it never throws after that, and reports what went
 * wrong in {@link ReadFromPedalResult.problem} while still handing back the values it recovered.
 *
 * Framework-free: no React/React Native imports.
 */

import { PARAM_REGION_START } from "../protocol/constants";
import {
  LIVE_PARAM_LAST_INDEX,
  TUNER_PARAM,
  USER_IR_ADDRESS_PARAMS,
  liveSetId,
} from "../protocol/params";
import { SETTINGS_BLOCK } from "../protocol/settings";
import { MAX_WRITABLE_SLOT, withTunerCleared, type DeviceSession } from "./session";

/**
 * Minimum gap between the re-apply's live sets. **Load-bearing** — at 30 ms the hardware run silently
 * dropped 2–3 of 69 writes, and a different 2–3 on a re-run; at 120 ms it dropped none across two
 * runs. Fire-and-forget `05 50` sends are lossy over BLE and the losses move around, so this is a
 * margin, not a fixed collision being dodged. The pedal does NOT acknowledge our live sets (0 echoes
 * for 68 writes), so the spacing IS the guarantee — the alternative was a third flash write to check.
 */
const REAPPLY_GAP_MS = 120;

/**
 * Quiet window after the restore's commit before the re-apply's first send. Without it the earliest
 * live sets were swallowed: they land in the same BLE connection interval as the commit that
 * immediately precedes them.
 */
const REAPPLY_SETTLE_MS = 800;

/**
 * Params never re-applied, settled by two hardware runs:
 *
 * - **{@link TUNER_PARAM}** — writing it would mute or bypass the rig.
 * - **{@link USER_IR_ADDRESS_PARAMS}** — the user-IR address words take the pedal's special
 *   addressing path; blind-writing them would repoint which IR record a preset owns.
 *
 * Nothing else is excluded. IR select (`0x0E`) was held back on the first run as a precaution and
 * then cleared: it round-trips, and the address words provably don't move when it does — so changing
 * the cab at the pedal is recovered like any other tweak. (`0x4A`–`0x4D` are commands — preset
 * up/down, save, red zone — and fall outside the blob's param range, so the range itself excludes
 * them.)
 */
const REAPPLY_EXCLUDED: readonly number[] = Object.freeze([TUNER_PARAM, ...USER_IR_ADDRESS_PARAMS]);

/** The 69 param indices Read from Pedal re-applies — every stored param but {@link REAPPLY_EXCLUDED}. */
export const REAPPLY_PARAM_INDICES: readonly number[] = Object.freeze(
  Array.from({ length: LIVE_PARAM_LAST_INDEX + 1 }, (_, i) => i).filter(
    (i) => !REAPPLY_EXCLUDED.includes(i),
  ),
);

export type ReadFromPedalStage = "tuner" | "backup" | "capture" | "restore" | "reapply" | "done";

export interface ReadFromPedalProgress {
  stage: ReadFromPedalStage;
  /** Params re-applied so far during the `reapply` stage; 0 elsewhere. */
  done: number;
  /** Params to re-apply during the `reapply` stage; 0 elsewhere. */
  total: number;
}

export interface ReadFromPedalOptions {
  /** Gap between re-apply sends. Defaults to {@link REAPPLY_GAP_MS}; the session's own transport
   * pacing still applies as a floor. Tests pass 0. */
  gapMs?: number;
  /** Settle window before the re-apply. Defaults to {@link REAPPLY_SETTLE_MS}; tests pass 0. */
  settleMs?: number;
  onProgress?: (progress: ReadFromPedalProgress) => void;
}

export interface ReadFromPedalResult {
  /** The program the pedal was sitting on — where the launder happened. */
  slot: number;
  /** The pedal's own blob built from LIVE state: what the player is actually hearing. */
  live: Uint8Array;
  /** The slot's stored blob, read immediately before the launder. If {@link restored} is false, this
   * is what a retry writes back — keep it. */
  stored: Uint8Array;
  /** The stored blob was written back AND read back matching what the pedal said it saved. */
  restored: boolean;
  /** Every re-applied param reached the wire. The pedal doesn't acknowledge live sets, so this means
   * "sent at the proven spacing", not "confirmed" — see {@link REAPPLY_GAP_MS}. */
  reapplied: boolean;
  /** What went wrong after the capture, phrased for a person, or null. */
  problem: string | null;
}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The pedal's active program — byte 0 of data block 0, the one live value it will report. */
async function activeSlot(session: DeviceSession): Promise<number> {
  const settings = await session.readBlock(0x55, SETTINGS_BLOCK);
  const slot = settings[0];
  if (slot === undefined) throw new Error("The pedal didn't report which preset it's on.");
  if (slot > MAX_WRITABLE_SLOT) {
    throw new Error(
      `Read from Pedal needs a numbered preset it can write back — the pedal is on program ${slot + 1}. Recall a preset first.`,
    );
  }
  return slot;
}

/**
 * Put the slot back and prove it — also the one-tap retry when a Read from Pedal's own restore failed
 * and the caller kept the backup. One retry, since a BLE commit can drop.
 *
 * The proof reads the slot back and compares it to **the blob we meant to write**, tuner byte cleared
 * (`writePreset` zeroes it, and that is the only difference it is allowed to introduce). Deliberately
 * NOT compared against the write's own echo: if the stage were lost, the pedal would build that echo
 * from its live array, echo and read-back would agree, and the check would pass while the slot still
 * held the player's live values — exactly the case this exists to catch.
 *
 * It is strict, so it can report a false failure — restoring a backup while the pedal has since been
 * parked on a *different* program lets the save repoint a user-IR pointer, which is a legitimate
 * difference this will still flag. A false failure only costs the user a retry; a false success would
 * leave their preset overwritten and say it was fine.
 */
export async function restoreStoredPreset(
  session: DeviceSession,
  slot: number,
  stored: Uint8Array,
): Promise<{ ok: boolean; problem: string | null }> {
  const expected = withTunerCleared(stored);
  let problem: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await session.writePreset(slot, stored);
      const back = await session.readPreset(slot);
      if (sameBytes(back.raw, expected)) return { ok: true, problem: null };
      problem = `preset ${slot + 1} didn't read back as written`;
    } catch (e) {
      problem = message(e);
    }
  }
  return { ok: false, problem };
}

/**
 * Run the whole sequence. Throws — having written nothing — if the tuner write, the active-slot read
 * or the backup read fails. After the capture it always resolves; check
 * {@link ReadFromPedalResult.problem}.
 */
export async function readFromPedal(
  session: DeviceSession,
  opts: ReadFromPedalOptions = {},
): Promise<ReadFromPedalResult> {
  const { gapMs = REAPPLY_GAP_MS, settleMs = REAPPLY_SETTLE_MS, onProgress } = opts;
  // The pedal ignores parameter writes during an IR transfer and crowding its flash write is the
  // historical brick vector — so refuse rather than half-run.
  if (session.linkBusy) {
    throw new Error("The pedal is busy with an IR transfer — try again once it finishes.");
  }
  const report = (stage: ReadFromPedalStage, done = 0, total = 0): void =>
    onProgress?.({ stage, done, total });

  // withBusy, not withExclusive: this sequence goes THROUGH the request queue, which chaining on it
  // would deadlock. It still suspends the heartbeat, which is the protection that matters here.
  return session.withBusy(async () => {
    report("tuner");
    await session.forceTunerOff();

    report("backup");
    const slot = await activeSlot(session);
    const stored = (await session.readPreset(slot)).raw;

    report("capture");
    let live: Uint8Array;
    try {
      live = await session.commitLive(slot);
    } catch (e) {
      // A commit that never confirmed may still have LANDED — the echo is what dropped, and from
      // here we can't tell which. So put the slot back before giving up, rather than risk walking
      // away from a preset quietly holding what the player was playing.
      const undo = await restoreStoredPreset(session, slot, stored);
      throw new Error(
        undo.ok
          ? `Couldn't read what the pedal is playing (${message(e)}). Preset ${slot + 1} is untouched.`
          : `Couldn't read what the pedal is playing (${message(e)}), and preset ${slot + 1} may have been left holding it (${undo.problem}).`,
        { cause: e },
      );
    }
    // ⚠️ From here the slot holds live values. Everything below runs to completion, errors and all.

    report("restore");
    const restore = await restoreStoredPreset(session, slot, stored);
    let problem = restore.problem;

    // Re-apply even when the restore failed: a restore that got as far as its `05 20` stage has
    // already reverted the pedal's live array, and we can't tell from here how far it got.
    const total = REAPPLY_PARAM_INDICES.length;
    report("reapply", 0, total);
    let reapplied = false;
    try {
      await delay(settleMs);
      for (let i = 0; i < total; i++) {
        const index = REAPPLY_PARAM_INDICES[i]!;
        await session.setParamsPaced(
          [{ param: liveSetId(index), value: live[PARAM_REGION_START + index]! }],
          gapMs,
        );
        report("reapply", i + 1, total);
      }
      reapplied = true;
    } catch (e) {
      problem ??= `couldn't put the pedal back to what you were hearing (${message(e)})`;
    }

    report("done");
    return { slot, live, stored, restored: restore.ok, reapplied, problem };
  });
}
