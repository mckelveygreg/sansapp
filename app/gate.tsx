/**
 * Master Level — the master output level (param 0x00), the panel behind EliteControl's LEVEL knob.
 * The noise gate / expander moved to the Dynamics page (it shares that page's transfer graph), so
 * this page is just the master output now. RN app surface.
 */
import { Text, View } from "react-native";
import { useStore } from "zustand";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { FootNote, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";
import { PARAMS } from "../src/protocol/params";

const card = {
  backgroundColor: theme.panel,
  borderColor: theme.panelEdge,
  borderWidth: 1,
  borderRadius: radius,
  padding: 16,
  gap: 12,
} as const;
const sectionLabel = { color: theme.accent, fontWeight: "700", letterSpacing: 1 } as const;

export default function MasterLevel() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const level = useStore(pedalStore, (s) => s.values.level) ?? 64;
  const baseline = useStore(pedalStore, (s) => s.baseline);

  const setLevel = (v: number) => {
    sendParam(PARAMS.level.paramId ?? 0, v);
    pedalStore.getState().setValueLocal("level", v);
  };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        Master output level — the panel behind EliteControl&apos;s LEVEL knob.
      </IntroNote>

      <View style={{ ...card, alignItems: "center" }}>
        <Text style={sectionLabel}>MAIN LEVEL</Text>
        <Knob
          label="Level"
          value={level}
          ghost={baseline.level}
          display={`${rawToPct(level)}%`}
          onChange={setLevel}
        />
      </View>

      <FootNote>
        Live over MIDI — the pedal&apos;s master output. The noise gate / expander now lives on the
        Dynamics page (tap the Comp knob), where it shares the compression transfer graph.
      </FootNote>
    </KnobScroll>
  );
}
