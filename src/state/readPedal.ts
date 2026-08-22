/**
 * UI-facing state for **Read from Pedal** — the action that recovers the player's unsaved on-pedal
 * tweaks (`src/device/readFromPedal.ts`, docs/adr/0001). A vanilla zustand store plus the two actions
 * the screens call, kept framework-free so the whole flow is unit-testable in Node.
 *
 * The operation takes ~10 s and writes to the player's current preset, so the state it exposes is
 * mostly about being honest while that happens: a stage-by-stage progress read-out, a problem that
 * STICKS until it is dealt with, and — if the restore failed — the backup blob kept for a one-tap
 * retry so the user is never left with their own preset overwritten and no way back.
 */
import { createStore } from "zustand/vanilla";
import type { ReadFromPedalProgress, ReadFromPedalResult } from "../device/readFromPedal";
import type { PedalController } from "./store";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A backup a failed restore left un-written, kept so the user can retry putting their preset back. */
interface PendingRestore {
  slot: number;
  stored: Uint8Array;
}

interface ReadPedalState {
  running: boolean;
  /** Where the operation is now; null when idle. */
  progress: ReadFromPedalProgress | null;
  /** What went wrong, for the user. Persists until the next run or a successful retry clears it. */
  problem: string | null;
  /** Set when the restore failed — the slot's stored preset is NOT back on the pedal yet. */
  pendingRestore: PendingRestore | null;
  /**
   * Whether the fresh-connect banner has been dismissed for this connection. It is an *offer*, never
   * a claim that anything is wrong — the app cannot detect drift (see `Freshness`) — so dismissing it
   * is final until the next connect.
   */
  offerDismissed: boolean;
  /**
   * Set when the last run left the pedal's Red Zone the opposite of what the player had. Advisory, not
   * a failure: it asks for one footswitch press. See `ReadFromPedalResult.redZoneNeedsPress` — the app
   * physically cannot set this state, so telling the player is the whole remedy.
   */
  redZoneNeedsPress: null | "engage" | "disengage";
  /**
   * The notice has been acknowledged and should stop being shown. Deliberately **separate from
   * clearing `pendingRestore`**: a dismissed notice must never discard the only copy of someone's
   * preset, so the backup outlives the banner and stays offered while it exists.
   */
  noticeDismissed: boolean;

  dismissOffer: () => void;
  dismissNotice: () => void;
  /**
   * A new connection: re-offer, and drop the previous link's in-flight state.
   *
   * A **pending restore is deliberately kept**. The likeliest reason a restore failed at all is that
   * the link died mid-operation, so a reconnect is exactly when the user comes back to retry — and
   * dropping the backup here would leave their preset overwritten with no way back. (The retry is
   * user-initiated and names the preset, so plugging a *different* pedal in first is visible rather
   * than silent.)
   */
  newConnection: () => void;
}

/** A store instance. One is shared app-wide ({@link readPedalStore}); tests make their own. */
export function createReadPedalStore() {
  return createStore<ReadPedalState>((set) => ({
    running: false,
    progress: null,
    problem: null,
    pendingRestore: null,
    offerDismissed: false,
    redZoneNeedsPress: null,
    noticeDismissed: false,

    dismissOffer: () => set({ offerDismissed: true }),
    dismissNotice: () => set({ noticeDismissed: true }),
    newConnection: () => set({ running: false, progress: null, offerDismissed: false }),
  }));
}

export const readPedalStore = createReadPedalStore();

/** Just the fields {@link visibleNotice} needs, so callers can pass a slice or a whole state. */
export type NoticeInput = Pick<
  ReadPedalState,
  "problem" | "redZoneNeedsPress" | "noticeDismissed" | "pendingRestore"
>;

/**
 * What the surfaces should actually show. Lives here rather than in the component so the rule has one
 * home and can be tested without a renderer.
 *
 * A dismissed notice hides — **except** while a backup is still owed, because the failure notice
 * carries the only control that can put the preset back. Dismissing must never orphan someone's
 * preset, so a pending restore outranks the dismissal.
 */
export function visibleNotice(s: NoticeInput): {
  problem: string | null;
  redZone: null | "engage" | "disengage";
} {
  const hide = s.noticeDismissed && !s.pendingRestore;
  return {
    problem: hide ? null : s.problem,
    redZone: s.noticeDismissed ? null : s.redZoneNeedsPress,
  };
}

export type ReadPedalStoreApi = ReturnType<typeof createReadPedalStore>;

/**
 * Run Read from Pedal and record what happened. Resolves either way — the screens read the store
 * rather than catching. A failure before the pedal was written (no preset, a dead link, a busy IR
 * transfer) leaves nothing to clean up; a failed restore parks the backup in `pendingRestore`.
 */
export async function runReadFromPedal(
  controller: PedalController,
  store: ReadPedalStoreApi = readPedalStore,
): Promise<void> {
  if (store.getState().running) return;
  // A fresh run earns a fresh notice: whatever the user dismissed last time was about the last run.
  store.setState({
    running: true,
    problem: null,
    progress: null,
    redZoneNeedsPress: null,
    noticeDismissed: false,
  });
  try {
    const result = await controller.readLive({
      onProgress: (progress) => store.setState({ progress }),
    });
    store.setState({
      problem: result.problem,
      redZoneNeedsPress: result.redZoneNeedsPress,
      pendingRestore: nextPending(store.getState().pendingRestore, result),
      offerDismissed: true, // the offer has been taken; don't keep asking
    });
  } catch (e) {
    store.setState({ problem: message(e) });
  } finally {
    store.setState({ running: false, progress: null });
  }
}

/**
 * What is still owed to the user after a run. A run only settles the slot it touched: succeeding on
 * preset 6 says nothing about a backup still owed for preset 5, and failing on 6 must not overwrite
 * it either — the OLDEST unresolved backup is the one whose preset is still sitting overwritten, so
 * it wins. (The same slot failing twice is a no-op: the two backups are the same bytes.)
 */
function nextPending(
  current: PendingRestore | null,
  result: ReadFromPedalResult,
): PendingRestore | null {
  if (!result.restored) return current ?? { slot: result.slot, stored: result.stored };
  return current && current.slot !== result.slot ? current : null;
}

/** Retry the restore a failed run left pending — put the player's preset back. */
export async function retryPendingRestore(
  controller: PedalController,
  store: ReadPedalStoreApi = readPedalStore,
): Promise<void> {
  const pending = store.getState().pendingRestore;
  if (!pending || store.getState().running) return;
  store.setState({ running: true });
  try {
    await controller.restoreBackup(pending.slot, pending.stored);
    store.setState({ pendingRestore: null, problem: null });
  } catch (e) {
    store.setState({ problem: message(e) });
  } finally {
    store.setState({ running: false });
  }
}
