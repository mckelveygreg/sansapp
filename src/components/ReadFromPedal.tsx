/**
 * **Read from Pedal** UI — the action that recovers unsaved on-pedal tweaks into the app.
 *
 * Three pieces, all reading `readPedalStore`:
 *
 * - {@link ReadFromPedalCard} — the action itself, on the Connection screen. Its subtitle
 *   PERMANENTLY discloses that this briefly writes to the preset you're on; the first run also asks.
 * - {@link ReadFromPedalOffer} — the editor's banner. Normally a dismissible *offer* on a fresh
 *   connect — never a claim that anything is wrong, because the app cannot detect drift
 *   (docs/adr/0001) — but it turns into the outstanding-problem notice when there is one, so a run
 *   started from here can't fail silently once the overlay closes.
 * - {@link ReadFromPedalOverlay} — mounted at the root, it blocks the app for the ~10 s the operation
 *   takes. Interacting mid-run would fight the re-apply, which is putting the pedal back one param at
 *   a time.
 *
 * RN app surface.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import type { ReadFromPedalProgress } from "../device/readFromPedal";
import { getController, pedalStore } from "../midi/pedal";
import { loadPrefs, savePrefs } from "../midi/prefs";
import {
  readPedalStore,
  retryPendingRestore,
  runReadFromPedal,
  visibleNotice,
} from "../state/readPedal";
import { radius, theme } from "./theme";

const DISCLOSURE =
  "Turned knobs on the pedal without saving? This brings them into the app. The pedal won't report " +
  "what it's playing, so SansApp asks it to write the sound down — it briefly saves over the preset " +
  "you're on and puts it straight back. Takes about 10 seconds; leave the pedal alone while it runs.";

const STAGE_LABEL: Record<ReadFromPedalProgress["stage"], string> = {
  tuner: "Turning the tuner off…",
  backup: "Backing up your preset…",
  capture: "Reading what the pedal is playing…",
  restore: "Putting your preset back…",
  reapply: "Restoring your sound…",
  done: "Done",
};

function stageText(progress: ReadFromPedalProgress | null): string {
  if (!progress) return "Starting…";
  const label = STAGE_LABEL[progress.stage];
  return progress.stage === "reapply" && progress.total > 0
    ? `${label} ${progress.done}/${progress.total}`
    : label;
}

/** Ask once, the first time. Resolves false if the user backs out. */
function confirmFirstRun(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Read from Pedal",
      DISCLOSURE +
        "\n\nYour preset is read first and written back afterwards, and SansApp checks it landed.",
      [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "Read from Pedal", onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

/**
 * What the app actually knows, said plainly.
 *
 * The old wording asserted the preset "is still holding what you were playing" — which the verifier
 * cannot establish. A mismatched read-back also happens when the write landed fine and a byte the
 * pedal rewrites on save disagrees, or when the read raced the commit that preceded it. Both are
 * false alarms, and overstating them turned "one byte differed" into "your preset is gone".
 */
function problemText(problem: string, pending: { slot: number } | null): string {
  return pending
    ? `SansApp couldn't confirm preset ${pending.slot + 1} went back (${problem}). Your backup is safe — put it back below.`
    : problem;
}

/**
 * The Red Zone advisory. Not a failure and not retryable: `0x4d` is pedal→app only, so the app cannot
 * set this state and a footswitch press is the entire remedy.
 */
const RED_ZONE_TEXT: Record<"engage" | "disengage", string> = {
  engage: "Your Red Zone was on and came back off — press the red footswitch once to get it back.",
  disengage: "Your Red Zone came back on — press the red footswitch once to turn it off.",
};

/** Everything the three surfaces below share: whether the action can run, and how to start it. */
function useReadFromPedal() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const linkBusy = useStore(pedalStore, (s) => s.linkBusy);
  const running = useStore(readPedalStore, (s) => s.running);
  const problem = useStore(readPedalStore, (s) => s.problem);
  const pendingRestore = useStore(readPedalStore, (s) => s.pendingRestore);
  const redZoneNeedsPress = useStore(readPedalStore, (s) => s.redZoneNeedsPress);
  const noticeDismissed = useStore(readPedalStore, (s) => s.noticeDismissed);
  const dismissNotice = useStore(readPedalStore, (s) => s.dismissNotice);

  const start = useCallback(async () => {
    const controller = getController();
    if (!controller) return;
    const prefs = await loadPrefs();
    if (!prefs.readFromPedalConfirmed) {
      if (!(await confirmFirstRun())) return;
      void savePrefs({ readFromPedalConfirmed: true });
    }
    await runReadFromPedal(controller);
  }, []);

  const retry = useCallback(async () => {
    const controller = getController();
    if (controller) await retryPendingRestore(controller);
  }, []);

  // linkBusy covers our own run too (the operation takes the link), so `running` is only for labels.
  // Deliberately NOT gated on the store knowing a slot: the operation reads the active program from
  // the pedal itself, so it works — and corrects the store — even when a connect couldn't.
  const notice = visibleNotice({ problem, redZoneNeedsPress, noticeDismissed, pendingRestore });

  return {
    ready,
    canRun: ready && !linkBusy,
    running,
    problem: notice.problem,
    redZone: notice.redZone,
    // Nothing owed means the notice is safe to wave away; a parked backup keeps it on screen.
    canDismiss: !pendingRestore,
    dismissNotice,
    pendingRestore,
    start,
    retry,
  };
}

/** The action, on the Connection screen: button + permanent disclosure + any outstanding problem. */
export function ReadFromPedalCard() {
  const {
    ready,
    canRun,
    running,
    problem,
    redZone,
    canDismiss,
    dismissNotice,
    pendingRestore,
    start,
    retry,
  } = useReadFromPedal();
  if (!ready) return null;

  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: pendingRestore ? theme.accent : theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
        gap: 10,
      }}
    >
      <Text style={{ color: theme.text, fontWeight: "600" }}>Read from Pedal</Text>
      <Pressable
        onPress={() => void start()}
        disabled={!canRun}
        style={{
          borderColor: theme.green,
          borderWidth: 1,
          padding: 12,
          borderRadius: radius,
          alignItems: "center",
          flexDirection: "row",
          justifyContent: "center",
          gap: 8,
          opacity: canRun ? 1 : 0.4,
        }}
      >
        {running ? <ActivityIndicator color={theme.text} /> : null}
        <Text style={{ color: theme.text, fontWeight: "700" }}>
          {running ? "Reading…" : "Read from Pedal"}
        </Text>
      </Pressable>
      <Text style={{ color: theme.textDim, lineHeight: 20 }}>{DISCLOSURE}</Text>
      {problem ? (
        <Text style={{ color: theme.accent, lineHeight: 20 }}>
          {problemText(problem, pendingRestore)}
        </Text>
      ) : null}
      {redZone ? (
        <Text style={{ color: theme.amber, lineHeight: 20 }}>{RED_ZONE_TEXT[redZone]}</Text>
      ) : null}
      {(problem || redZone) && canDismiss ? (
        <Pressable onPress={dismissNotice} hitSlop={8} style={{ alignSelf: "flex-start" }}>
          <Text style={{ color: theme.textDim, fontWeight: "700" }}>Dismiss</Text>
        </Pressable>
      ) : null}
      {pendingRestore ? (
        <Pressable
          onPress={() => void retry()}
          disabled={running || !ready}
          style={{
            borderColor: theme.accent,
            borderWidth: 1,
            padding: 12,
            borderRadius: radius,
            alignItems: "center",
            opacity: running ? 0.4 : 1,
          }}
        >
          <Text style={{ color: theme.accent, fontWeight: "700" }}>
            Put preset {pendingRestore.slot + 1} back
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The shell both banner states share. */
function Banner({ accent, children }: { accent: boolean; children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: accent ? theme.accent : theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

/**
 * The editor's banner.
 *
 * Normally the fresh-connect **offer**: shown while the app can't claim to know what the pedal is
 * playing and the user hasn't waved it away, and phrased as "if you did", not "you have", because
 * nothing here can tell whether anything actually drifted.
 *
 * When a run left a problem behind it becomes that notice instead — a run can be started from this
 * banner, and once the blocking overlay closes this is the only thing on screen that could say the
 * preset wasn't put back. It is not dismissible while a restore is owed.
 */
export function ReadFromPedalOffer() {
  const {
    canRun,
    running,
    problem,
    redZone,
    canDismiss,
    dismissNotice,
    pendingRestore,
    start,
    retry,
  } = useReadFromPedal();
  const stale = useStore(pedalStore, (s) => s.freshness) === "stale";
  const dismissed = useStore(readPedalStore, (s) => s.offerDismissed);

  if (problem) {
    return (
      <Banner accent>
        <Ionicons name="alert-circle-outline" size={18} color={theme.accent} />
        <Text style={{ color: theme.accent, flex: 1, lineHeight: 18 }}>
          {problemText(problem, pendingRestore)}
        </Text>
        {pendingRestore ? (
          <Pressable onPress={() => void retry()} disabled={running} hitSlop={8}>
            <Text style={{ color: theme.accent, fontWeight: "700" }}>Retry</Text>
          </Pressable>
        ) : canDismiss ? (
          <Pressable onPress={dismissNotice} hitSlop={8}>
            <Text style={{ color: theme.textDim, fontWeight: "700" }}>Dismiss</Text>
          </Pressable>
        ) : null}
      </Banner>
    );
  }
  // Advisory only — no restore is owed, so it sits below the failure case and above the offer.
  if (redZone) {
    return (
      <Banner accent={false}>
        <Ionicons name="footsteps-outline" size={18} color={theme.amber} />
        <Text style={{ color: theme.textDim, flex: 1, lineHeight: 18 }}>
          {RED_ZONE_TEXT[redZone]}
        </Text>
        <Pressable onPress={dismissNotice} hitSlop={8}>
          <Text style={{ color: theme.textDim, fontWeight: "700" }}>OK</Text>
        </Pressable>
      </Banner>
    );
  }
  if (!stale || dismissed || !canRun) return null;

  return (
    <Banner accent={false}>
      <Ionicons name="help-circle-outline" size={18} color={theme.amber} />
      <Text style={{ color: theme.textDim, flex: 1, lineHeight: 18 }}>
        If you turned knobs on the pedal before connecting, SansApp can't see them. Read from Pedal
        brings them in.
      </Text>
      <Pressable onPress={() => void start()} disabled={running} hitSlop={8}>
        <Text style={{ color: theme.green, fontWeight: "700" }}>Read</Text>
      </Pressable>
      <Pressable
        onPress={() => readPedalStore.getState().dismissOffer()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <Ionicons name="close" size={18} color={theme.textDim} />
      </Pressable>
    </Banner>
  );
}

/**
 * Blocks the app while the operation runs. It re-applies 69 params one at a time over ~10 s; a knob
 * moved in the middle of that would be overwritten by the re-apply a moment later, with no sign of it.
 * Mounted at the root so it holds wherever the run was started from.
 */
export function ReadFromPedalOverlay() {
  const running = useStore(readPedalStore, (s) => s.running);
  const progress = useStore(readPedalStore, (s) => s.progress);
  return (
    <Modal visible={running} transparent animationType="fade" onRequestClose={() => {}}>
      <View
        style={{
          flex: 1,
          backgroundColor: "#000000cc",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
        }}
      >
        <View
          style={{
            backgroundColor: theme.panel,
            borderColor: theme.panelEdge,
            borderWidth: 1,
            borderRadius: radius,
            padding: 20,
            gap: 12,
            alignItems: "center",
            alignSelf: "stretch",
          }}
        >
          <ActivityIndicator color={theme.text} size="large" />
          <Text style={{ color: theme.text, fontWeight: "700" }}>Reading from the pedal</Text>
          <Text style={{ color: theme.textDim, textAlign: "center" }}>{stageText(progress)}</Text>
          <Text style={{ color: theme.textDim, textAlign: "center", fontSize: 12 }}>
            Leave the pedal alone until this finishes.
          </Text>
        </View>
      </View>
    </Modal>
  );
}
