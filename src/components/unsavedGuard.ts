/**
 * Recall a preset, but if the current sound has unsaved edits (`pedalStore.dirty`), first confirm with
 * the user: Save & switch (persist the edits to the current slot, then recall), Discard (recall now,
 * losing the edits), or Stay (cancel). Switching presets recalls a new one on the pedal, which replaces
 * the live edit buffer — so without this guard, in-progress edits vanish with no warning.
 *
 * The guard can be lowered (Settings → Behaviour): experimenting means throwing sounds away on
 * purpose, and being asked every time is friction rather than safety. Lowered, a preset change
 * discards the edits without asking — but says so in the log.
 *
 * No-ops when not connected. If the Save fails (e.g. the pedal doesn't confirm the write), we surface
 * the error and DON'T switch — so a failed save can't silently drop the edits.
 */
import { Alert, type AlertButton } from "react-native";
import { getController, pedalStore, saveCurrentTo } from "../midi/pedal";
import { getPrefs } from "../midi/prefs";

export function recallWithUnsavedGuard(target: number): void {
  const controller = getController();
  if (!controller) return;
  // A failed recall must NOT leave the UI silently on the old preset. Retry once (a BLE recall echo
  // can drop transiently), then surface the failure — same affordance the Save path uses below.
  const doRecall = (): void =>
    void controller
      .recall(target)
      .catch(() => controller.recall(target))
      .catch((e: unknown) =>
        Alert.alert("Couldn't switch presets", e instanceof Error ? e.message : String(e)),
      );

  const st = pedalStore.getState();
  if (!st.dirty) {
    doRecall();
    return;
  }

  const cur = st.slot;
  const label = st.name?.trim() || (cur != null ? `Preset ${cur + 1}` : "this preset");

  // Guard lowered: switch now and let the edits go, which is what was asked for. Not silent, though —
  // the log is what turns "the app ate my sound" into something anyone can diagnose afterwards.
  if (!getPrefs().unsavedGuard) {
    st.pushLog(`✂ discarded unsaved edits to ${label} → preset ${target + 1}`);
    doRecall();
    return;
  }

  const buttons: AlertButton[] = [{ text: "Stay", style: "cancel" }];
  // Only offer Save when we know which slot the edits belong to.
  if (cur != null) {
    buttons.push({
      text: "Save & switch",
      onPress: () =>
        void saveCurrentTo(cur)
          .then(doRecall)
          .catch((e: unknown) =>
            Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e)),
          ),
    });
  }
  buttons.push({ text: "Discard", style: "destructive", onPress: doRecall });

  Alert.alert("Unsaved changes", `You've edited ${label}. Switch presets anyway?`, buttons);
}
