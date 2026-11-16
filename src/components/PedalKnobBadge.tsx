/**
 * PedalKnobBadge — a small read-only tag on whichever band the pedal's physical MID / FREQ / Q knobs
 * drive right now. The pedal re-picks that band from the live Buzz value on every knob scan (lab#82,
 * see panelMidBand): Buzz 62/63 → the Amp page's Punch band, anything else → the EQ page's Mid band.
 * Nothing on the pedal (or in the desktop editor) shows this, so the badge moves with Buzz instead.
 */
import { Text, View } from "react-native";
import { theme } from "./theme";

export function PedalKnobBadge({ knobs = "MID / FREQ / Q" }: { knobs?: string }) {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`The pedal's ${knobs} knobs control this band`}
      style={{
        alignSelf: "flex-start",
        borderWidth: 1,
        borderColor: theme.accent,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
      }}
    >
      <Text style={{ color: theme.accent, fontSize: 10, fontWeight: "700", letterSpacing: 1 }}>
        PEDAL KNOB · {knobs}
      </Text>
    </View>
  );
}
