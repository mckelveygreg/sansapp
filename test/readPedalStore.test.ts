/**
 * The Read from Pedal UI state machine — what the screens actually read. Driven through a stub
 * controller so the failure shapes (a refused run, a failed restore, the kept backup) are exercised
 * without a pedal; `readFromPedal.test.ts` covers the wire sequence itself.
 */
import { describe, expect, it } from "vitest";
import type { ReadFromPedalResult } from "../src/device/readFromPedal";
import type { PedalController } from "../src/state/store";
import {
  createReadPedalStore,
  retryPendingRestore,
  runReadFromPedal,
  visibleNotice,
} from "../src/state/readPedal";

const result = (over: Partial<ReadFromPedalResult> = {}): ReadFromPedalResult => ({
  slot: 3,
  live: new Uint8Array(256),
  stored: Uint8Array.from({ length: 256 }, (_, i) => i & 0x7f),
  restored: true,
  reapplied: true,
  problem: null,
  redZoneNeedsPress: null,
  ...over,
});

function stubController(over: Partial<PedalController> = {}): PedalController {
  return {
    setValue: () => {},
    recall: () => Promise.reject(new Error("not used")),
    loadCurrent: () => Promise.reject(new Error("not used")),
    readLive: () => Promise.resolve(result()),
    restoreBackup: () => Promise.resolve(),
    dispose: () => {},
    ...over,
  };
}

describe("readPedalStore", () => {
  it("clears the offer and reports no problem on a clean run", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(stubController(), store);
    expect(store.getState()).toMatchObject({
      running: false,
      progress: null,
      problem: null,
      pendingRestore: null,
      offerDismissed: true,
    });
  });

  it("keeps the backup when the restore failed, so the user can put their preset back", async () => {
    const store = createReadPedalStore();
    const failed = result({ restored: false, problem: "preset 4 didn't read back as written" });
    await runReadFromPedal(stubController({ readLive: () => Promise.resolve(failed) }), store);

    expect(store.getState().problem).toBe("preset 4 didn't read back as written");
    expect(store.getState().pendingRestore).toEqual({ slot: 3, stored: failed.stored });

    let wrote: [number, Uint8Array] | null = null;
    await retryPendingRestore(
      stubController({
        restoreBackup: (slot, stored) => {
          wrote = [slot, stored];
          return Promise.resolve();
        },
      }),
      store,
    );
    expect(wrote).toEqual([3, failed.stored]);
    expect(store.getState().pendingRestore).toBeNull();
    expect(store.getState().problem).toBeNull();
  });

  it("keeps the backup when the retry ALSO fails", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ restored: false })) }),
      store,
    );
    await retryPendingRestore(
      stubController({ restoreBackup: () => Promise.reject(new Error("still no")) }),
      store,
    );
    expect(store.getState().pendingRestore).not.toBeNull();
    expect(store.getState().problem).toBe("still no");
    expect(store.getState().running).toBe(false);
  });

  it("a later run on another preset neither clears nor overwrites the backup still owed", async () => {
    const store = createReadPedalStore();
    const owed = result({ slot: 5, restored: false });
    await runReadFromPedal(stubController({ readLive: () => Promise.resolve(owed) }), store);
    expect(store.getState().pendingRestore?.slot).toBe(5);

    // A clean run on preset 4 settles nothing about preset 6's overwritten slot…
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ slot: 3 })) }),
      store,
    );
    expect(store.getState().pendingRestore?.slot).toBe(5);
    // …and neither does a failing one — the older backup is the one still owed.
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ slot: 3, restored: false })) }),
      store,
    );
    expect(store.getState().pendingRestore?.slot).toBe(5);

    // Only a run that puts preset 6 back clears it.
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ slot: 5 })) }),
      store,
    );
    expect(store.getState().pendingRestore).toBeNull();
  });

  it("surfaces a refusal, and leaves nothing pending — the pedal was never written", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(
      stubController({
        readLive: () => Promise.reject(new Error("The pedal is busy with an IR transfer")),
      }),
      store,
    );
    expect(store.getState().problem).toMatch(/IR transfer/);
    expect(store.getState().pendingRestore).toBeNull();
    expect(store.getState().offerDismissed).toBe(false); // still worth offering
  });

  it("won't start a second run on top of one in flight", async () => {
    const store = createReadPedalStore();
    let calls = 0;
    let finish = (): void => {};
    const controller = stubController({
      readLive: () => {
        calls++;
        return new Promise<ReadFromPedalResult>((r) => (finish = () => r(result())));
      },
    });
    const first = runReadFromPedal(controller, store);
    await runReadFromPedal(controller, store);
    expect(calls).toBe(1);
    finish();
    await first;
    expect(store.getState().running).toBe(false);
  });

  it("a new connection re-offers but never drops a backup still owed to the user", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ restored: false })) }),
      store,
    );
    store.getState().newConnection();
    expect(store.getState().offerDismissed).toBe(false);
    expect(store.getState().pendingRestore).not.toBeNull();
  });

  it("carries the Red Zone advisory through to the screens, and resets it on the next run", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ redZoneNeedsPress: "engage" })) }),
      store,
    );
    expect(store.getState().redZoneNeedsPress).toBe("engage");

    await runReadFromPedal(stubController(), store); // a clean run owes nothing
    expect(store.getState().redZoneNeedsPress).toBeNull();
  });

  it("clears a dismissal when a new run starts — the notice was about the last one", async () => {
    const store = createReadPedalStore();
    await runReadFromPedal(
      stubController({ readLive: () => Promise.resolve(result({ redZoneNeedsPress: "engage" })) }),
      store,
    );
    store.getState().dismissNotice();
    expect(store.getState().noticeDismissed).toBe(true);

    await runReadFromPedal(
      stubController({
        readLive: () => Promise.resolve(result({ redZoneNeedsPress: "disengage" })),
      }),
      store,
    );
    expect(store.getState().noticeDismissed).toBe(false);
    expect(visibleNotice(store.getState()).redZone).toBe("disengage");
  });
});

describe("visibleNotice", () => {
  const base = {
    problem: null as string | null,
    redZoneNeedsPress: null as null | "engage" | "disengage",
    noticeDismissed: false,
    pendingRestore: null as { slot: number; stored: Uint8Array } | null,
  };

  it("shows what the last run reported", () => {
    expect(visibleNotice({ ...base, problem: "nope", redZoneNeedsPress: "engage" })).toEqual({
      problem: "nope",
      redZone: "engage",
    });
  });

  it("hides both once dismissed, when nothing is owed", () => {
    expect(
      visibleNotice({
        ...base,
        problem: "nope",
        redZoneNeedsPress: "engage",
        noticeDismissed: true,
      }),
    ).toEqual({ problem: null, redZone: null });
  });

  it("keeps a failure on screen while a backup is still owed, dismissed or not", () => {
    // The notice carries the only control that puts the preset back, so dismissing must not orphan it.
    const pending = { slot: 2, stored: new Uint8Array(8) };
    expect(
      visibleNotice({
        ...base,
        problem: "didn't read back",
        noticeDismissed: true,
        pendingRestore: pending,
      }),
    ).toEqual({ problem: "didn't read back", redZone: null });
  });
});
