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
 * **Known limitation — the Red Zone does not survive.** Step 4's stage is a preset load, and a load is
 * the one moment the pedal re-derives its Red Zone state, from the blob being loaded. Step 5 restores
 * the underlying enables but cannot restore that state: `0x4d` is pedal→app only, so no write for it
 * exists. Confirmed on hardware. There is no reordering that helps either — any load that would
 * re-derive the state overwrites the live array step 5 just rebuilt. So the sequence detects the
 * divergence and asks the player to stomp once; see {@link ReadFromPedalResult.redZoneNeedsPress}.
 *
 * Framework-free: no React/React Native imports.
 */

import { PARAM_REGION_START } from "../protocol/constants";
import {
  LIVE_PARAM_LAST_INDEX,
  PARAMS,
  TUNER_PARAM,
  USER_IR_ADDRESS_PARAMS,
  liveSetId,
  redZoneEngagedFor,
  redZoneStateParamsFor,
  type ParamId,
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
 * Quiet window after the restore's commit before the read-back that verifies it, and what each further
 * attempt adds on top.
 *
 * Borrowed from {@link REAPPLY_SETTLE_MS} rather than measured separately, because it is the same
 * hazard that constant exists for: traffic landing in the same BLE connection interval as the commit
 * it follows. The original loop had **no** window at all — it fired the read the instant `writePreset`
 * resolved, then retried immediately — so every attempt raced identically. That is the leading
 * explanation for a hardware run which reported four consecutive "didn't read back as written"
 * failures on a preset that then verified fine twice in a row: a read answered from before the commit
 * landed returns the laundered live blob, which is exactly what the check is looking for and exactly
 * what it must not see.
 *
 * ⚠️ **UNVERIFIED for this path.** The 800 ms is proven for live sets after a commit, not for a
 * read-back. If a mismatch recurs, the offsets now in {@link RestoreOutcome.diff} say what actually
 * differed — read those before adjusting this.
 */
const VERIFY_SETTLE_MS = REAPPLY_SETTLE_MS;
const VERIFY_BACKOFF_MS = 400;

/** Write-and-verify attempts before giving up and parking the backup for the user. */
const VERIFY_ATTEMPTS = 2;

/** How many differing offsets a problem string names before it says "and N more". */
const MAX_REPORTED_DIFFS = 4;

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
  /** Pacing for the restore's own verify — see {@link RestoreOptions}. Tests pass zeroes. */
  restore?: RestoreOptions;
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
  /**
   * The pedal's Red Zone ended up the opposite of what the player had, and **the app cannot put it
   * back** — so this asks them to stomp once. `"engage"` = they had it on and it came back off,
   * `"disengage"` = the reverse. Null when it matched, which is the common case.
   *
   * Why it can happen at all: the restore's `05 20` stage is a preset load, and a load is the one
   * moment the pedal re-derives this state — from the blob being loaded, i.e. the STORED preset. It is
   * never re-derived afterwards ({@link redZoneEngagedFor} documents exactly this). The re-apply then
   * moves `0x3c`/`0x41`/`0x08` to their live values but cannot move the state byte, because
   * `KNOB_LAYER_NOTIFY_PARAM` (`0x4d`) is pedal→app only: there is no write for it. On firmware ≤ 1.1
   * the audible ambience drop rides that byte inside the DSP, so a player who had the Red Zone engaged
   * loses their reverb even though `0x08` was re-applied correctly.
   *
   * A restore whose stage never landed leaves the state untouched, making this a false positive — but
   * the cost is one unnecessary footswitch press, against silently losing someone's reverb. Same trade
   * the restore verifier makes, for the same reason.
   */
  redZoneNeedsPress: null | "engage" | "disengage";
}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Offsets where a read-back disagrees with what we meant to write — the evidence a boolean comparison
 * throws away. A length mismatch reports every offset past the shorter blob, so the caller's count is
 * still meaningful.
 */
function byteDiff(got: Uint8Array, want: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) out.push(i);
  }
  return out;
}

/** A bounded, human-readable account of a read-back mismatch, for the problem string and the log. */
function describeDiff(got: Uint8Array, want: Uint8Array, offsets: readonly number[]): string {
  const hex = (v: number | undefined): string =>
    v === undefined ? "–" : v.toString(16).padStart(2, "0");
  const shown = offsets
    .slice(0, MAX_REPORTED_DIFFS)
    .map((i) => `0x${i.toString(16)} want ${hex(want[i])} got ${hex(got[i])}`)
    .join(", ");
  const more =
    offsets.length > MAX_REPORTED_DIFFS ? `, and ${offsets.length - MAX_REPORTED_DIFFS} more` : "";
  const len = got.length === want.length ? "" : ` (length ${got.length}, expected ${want.length})`;
  const count = offsets.length === 1 ? "1 byte differs" : `${offsets.length} bytes differ`;
  return `${count}${len}: ${shown}${more}`;
}

/**
 * The Red Zone params read out of a preset blob, in the shape {@link redZoneEngagedFor} wants — so the
 * pedal's derivation rule keeps exactly one home rather than being re-implemented here.
 */
function redZoneValues(
  blob: Uint8Array,
  firmware: number | null,
): Partial<Record<ParamId, number>> {
  const out: Partial<Record<ParamId, number>> = {};
  // ParamId is a NAME ("autoFilterOn"), not a wire id, so the blob index comes from each param's own
  // declared blobOffset — the map's single source for it — rather than any arithmetic here.
  for (const id of redZoneStateParamsFor(firmware)) {
    out[id] = blob[PARAMS[id].blobOffset] ?? 0;
  }
  return out;
}

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

/** Pacing for the restore's verify, so tests don't pay {@link VERIFY_SETTLE_MS} per attempt. */
export interface RestoreOptions {
  /** Quiet window after the commit, before the verifying read. Defaults to {@link VERIFY_SETTLE_MS};
   * tests pass 0. */
  settleMs?: number;
  /** Added to the window per further attempt. Defaults to {@link VERIFY_BACKOFF_MS}. */
  backoffMs?: number;
}

/** What a restore attempt ended up doing, and the evidence if it did not verify. */
export interface RestoreOutcome {
  /** The blob was written back AND read back matching, byte for byte, tuner byte aside. */
  ok: boolean;
  /** What went wrong, phrased for a person, or null. */
  problem: string | null;
  /** Blob offsets that disagreed on the last attempt. Empty when {@link ok}, or when the attempt threw
   * before a comparison happened. */
  diff: readonly number[];
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
 *
 * Because false failures are expected, a mismatch **keeps the evidence**: {@link RestoreOutcome.diff}
 * names the offsets that disagreed and the problem string quotes the first few. Before this, the
 * comparison collapsed to a boolean and a failure told nobody anything — which left a real hardware
 * failure undiagnosable and its cause a guess.
 */
export async function restoreStoredPreset(
  session: DeviceSession,
  slot: number,
  stored: Uint8Array,
  { settleMs = VERIFY_SETTLE_MS, backoffMs = VERIFY_BACKOFF_MS }: RestoreOptions = {},
): Promise<RestoreOutcome> {
  const expected = withTunerCleared(stored);
  let problem: string | null = null;
  let diff: readonly number[] = [];
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    try {
      await session.writePreset(slot, stored);
      // Let the commit clear the link before asking about it — see VERIFY_SETTLE_MS for why a read
      // fired too early can answer with the laundered blob and fail a restore that actually worked.
      await delay(settleMs + attempt * backoffMs);
      const back = await session.readPreset(slot);
      const offsets = byteDiff(back.raw, expected);
      if (offsets.length === 0) return { ok: true, problem: null, diff: [] };
      diff = offsets;
      problem = `preset ${slot + 1} didn't read back as written — ${describeDiff(back.raw, expected, offsets)}`;
    } catch (e) {
      problem = message(e);
      diff = [];
    }
  }
  return { ok: false, problem, diff };
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
  const {
    gapMs = REAPPLY_GAP_MS,
    settleMs = REAPPLY_SETTLE_MS,
    restore: restoreOpts,
    onProgress,
  } = opts;
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
      const undo = await restoreStoredPreset(session, slot, stored, restoreOpts);
      throw new Error(
        undo.ok
          ? `Couldn't read what the pedal is playing (${message(e)}). Preset ${slot + 1} is untouched.`
          : `Couldn't read what the pedal is playing (${message(e)}), and preset ${slot + 1} may have been left holding it (${undo.problem}).`,
        { cause: e },
      );
    }
    // ⚠️ From here the slot holds live values. Everything below runs to completion, errors and all.

    report("restore");
    const restore = await restoreStoredPreset(session, slot, stored, restoreOpts);
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

    // Whether the player has to stomp to get their Red Zone back — see
    // ReadFromPedalResult.redZoneNeedsPress. Derived from the two blobs we already hold, so it costs
    // no wire traffic; and it must be computed from `stored` (what the restore staged, and therefore
    // what the pedal derived from) against `live` (what the player actually had).
    const firmware = session.firmwareVersion;
    const wanted = redZoneEngagedFor(redZoneValues(live, firmware), firmware);
    const landed = redZoneEngagedFor(redZoneValues(stored, firmware), firmware);
    const redZoneNeedsPress = wanted === landed ? null : wanted ? "engage" : "disengage";

    report("done");
    return {
      slot,
      live,
      stored,
      restored: restore.ok,
      reapplied,
      problem,
      redZoneNeedsPress,
    };
  });
}
