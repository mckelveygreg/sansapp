/**
 * RedZoneBadge — a read-only indicator for the pedal's Red Zone (the red "shift" footswitch's state),
 * riding in the {@link TunerBar} strip's status slot. RN app surface.
 *
 * It exists because the app holds a belief about the Red Zone that it cannot verify. The pedal reports
 * the switch as a single 0x4d notify and never reports the state again, so between a footswitch
 * long-hold — which announces a toggle it then silently undoes — and the next preset load, `layer` can
 * be wrong in either direction. Unshown, the app is wrong *silently* — and a save taken in that window
 * writes effect-enable flags the player never chose.
 *
 * The fix available to an app that must not write the switch back (its set-id is a command that also
 * repoints all eight physical knobs) is to make the claim checkable. The pedal lights its own red LED
 * in exactly this state, so a player glancing between the two can see a disagreement and clear it with
 * one stomp. Hence: no press handler, no confirmation, nothing to get wrong — a dot and a word.
 *
 * It is also the surface for a genuinely confusing piece of hardware behaviour **on firmware ≤ 1.1**.
 * There the pedal derives its Red Zone state from Auto Filter OR Chorus OR **Ambiance**, so almost any
 * ambience-bearing preset loads with the Red Zone already engaged and the next stomp *dis*engages it
 * (see RED_ZONE_STATE_PARAMS). Shown, that is merely surprising once; unshown, it looks like a broken
 * footswitch. Firmware 1.2 drops Ambiance from the derivation, so on 1.2 the badge is just a mirror —
 * still worth showing, because the 0x4d notify can still lie after a long-hold.
 *
 * Deliberately non-interactive, and dim rather than hidden when disengaged — an indicator that vanishes
 * can't be distinguished from an app that isn't tracking.
 */
import { Text, View } from "react-native";
import { useStore } from "zustand";
import { pedalStore } from "../midi/pedal";
import { theme } from "./theme";

export function RedZoneBadge() {
  const engaged = useStore(pedalStore, (s) => s.layer) === "red";
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";

  // Disconnected, `layer` is a leftover from a link that is gone — a claim with nothing behind it.
  if (!ready) return null;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={
        engaged
          ? "Red Zone engaged on the pedal — Auto Filter and Chorus are live"
          : "Red Zone not engaged on the pedal"
      }
      accessibilityHint="Shown only. Use the pedal's red footswitch to change it."
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: engaged ? theme.accent : theme.knobEdge,
          backgroundColor: engaged ? theme.accent : "transparent",
        }}
      />
      <Text
        style={{
          color: engaged ? theme.text : theme.textDim,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 1.2,
        }}
      >
        RED ZONE
      </Text>
    </View>
  );
}
