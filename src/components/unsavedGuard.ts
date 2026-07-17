/**
 * Recall a preset, but if the current sound has unsaved edits (`pedalStore.dirty`), first confirm with
 * the user: Save & switch (persist the edits to the current slot, then recall), Discard (recall now,
 * losing the edits), or Stay (cancel). Switching presets recalls a new one on the pedal, which replaces
 * the live edit buffer — so without this guard, in-progress edits vanish with no warning.
 *
 * No-ops when not connected. If the Save fails (e.g. the pedal doesn't confirm the write), we surface
 * the error and DON'T switch — so a failed save can't silently drop the edits.
 */
import { Alert, type AlertButton } from "react-native";
import { getController, pedalStore, saveCurrentTo } from "../midi/pedal";

export function recallWithUnsavedGuard(target: number): void {
  const controller = getController();
  if (!controller) return;
  const doRecall = (): void => void controller.recall(target).catch(() => {});

  const st = pedalStore.getState();
  if (!st.dirty) {
    doRecall();
    return;
  }

  const cur = st.slot;
  const label = st.name?.trim() || (cur != null ? `Preset ${cur + 1}` : "this preset");
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
