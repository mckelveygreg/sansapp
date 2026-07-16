/**
 * Compressor — the deep compressor page, LIVE: each control sends its captured param over MIDI
 * (Threshold = the COMP knob 0x0A; Ratio/Output/Attack/Release = 0x19–0x1c; Auto Gain/Lookahead =
 * 0x32/0x33 — wire ids corrected 2026-07-14). The dynamics graph is shared with the Gate page
 * (via dynamicsStore): the compressor is
 * the upper-right (right dot = threshold, angle = ratio); the gate is the lower-left. RN app surface.
 *
 * Displayed units are hardware-calibrated (src/protocol/units.ts, measured against EliteControl):
 * Threshold −0.5…−60 dB (Bypass at the floor), Ratio 1–20:1, Output −30…+18 dB, Attack 1–100 ms,
 * Release 10–1000 ms.
 */
import { Switch, Text, useWindowDimensions, View } from "react-native";
import { useStore } from "zustand";
import { CompCurve } from "../src/components/CompCurve";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";
import { COMP_PARAMS, GATE_PARAMS } from "../src/protocol/params";
import { dynamicsStore } from "../src/state/dynamics";
import {
  compAttackMs,
  compOutputDb,
  compRatio,
  compReleaseMs,
  compThresholdDb,
  compThresholdLabel,
  gateRatio,
  gateReleaseMs,
  gateThresholdDb,
  gateThresholdLabel,
} from "../src/protocol/units";

const card = {
  backgroundColor: theme.panel,
  borderColor: theme.panelEdge,
  borderWidth: 1,
  borderRadius: radius,
  padding: 16,
  gap: 16,
} as const;
const sectionLabel = { color: theme.accent, fontWeight: "700", letterSpacing: 1 } as const;

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.panelEdge, true: theme.accent }}
        thumbColor="#fff"
      />
      <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>{label}</Text>
    </View>
  );
}

export default function Compressor() {
  const { width } = useWindowDimensions();
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const d = useStore(dynamicsStore, (s) => s);
  // Threshold (0x0a) and Ratio (0x19) are store-backed (PARAMS.comp / PARAMS.ratio). Output/Attack/
  // Release live in dynamicsStore for the shared graph but are now read back from the preset too
  // (synced on recall), so every knob reflects the loaded preset and shows the ghost via baseline.
  const threshold = useStore(pedalStore, (s) => s.values.comp) ?? 64;
  const ratio = useStore(pedalStore, (s) => s.values.ratio) ?? 64;
  const baseline = useStore(pedalStore, (s) => s.baseline);

  // Knob onChange gives an absolute 0–127; send it live + update the shared dynamics store.
  const set = (key: "compOutput" | "compAttack" | "compRelease", param: number) => (v: number) => {
    sendParam(param, v);
    dynamicsStore.getState().patch({ [key]: v });
  };
  // Threshold/Ratio write to the pedal store (source of truth) so every screen + save stays in sync.
  const setThreshold = (v: number) => {
    sendParam(COMP_PARAMS.threshold, v);
    pedalStore.getState().setValueLocal("comp", v);
  };
  const setRatio = (v: number) => {
    sendParam(COMP_PARAMS.ratio, v);
    pedalStore.getState().setValueLocal("ratio", v);
  };
  const toggle = (key: "autoGain" | "lookahead", param: number) => (on: boolean) => {
    sendParam(param, on ? 1 : 0);
    dynamicsStore.getState().patch({ [key]: on });
  };
  // The gate/expander shares this page's dynamics graph (its lower-left segment), so its knobs live
  // here too — one "Dynamics" page. Store-backed via dynamicsStore, same as the compressor knobs.
  const setGate =
    (key: "gateThreshold" | "gateRatio" | "gateRelease", param: number) => (v: number) => {
      sendParam(param, v);
      dynamicsStore.getState().patch({ [key]: v });
    };

  // Transfer-curve params — the graph shows the pure compression SHAPE. Make-up/output is a vertical
  // level shift, not part of the shape, so it's excluded (makeupDb 0); ratio then only bends the
  // above-threshold segment about the threshold dot. Bypass (threshold floor) → flat 1:1.
  const thresholdDb = compThresholdDb(threshold);
  const compParams = {
    thresholdDb: thresholdDb ?? 0,
    ratio: thresholdDb === null ? 1 : compRatio(ratio),
    kneeDb: 6,
    makeupDb: 0,
  };
  const gt = gateThresholdDb(d.gateThreshold);
  const gateParams = gt === null ? undefined : { thresholdDb: gt, ratio: gateRatio(d.gateRatio) };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        Dynamics — compressor + noise gate on one input→output transfer curve (dashed = 1:1). The
        compressor is the upper-right; the gate / expander the lower-left.
      </IntroNote>

      <GraphCard>
        <CompCurve comp={compParams} gate={gateParams} width={width - 32 - 18} height={190} />
      </GraphCard>

      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 16,
          gap: 16,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12 }}>
          <Knob
            label="Threshold"
            value={threshold}
            ghost={baseline.comp}
            display={compThresholdLabel(threshold)}
            onChange={setThreshold}
          />
          <Knob
            label="Ratio"
            value={ratio}
            ghost={baseline.ratio}
            display={`${compRatio(ratio).toFixed(1)}:1`}
            onChange={setRatio}
          />
          <Knob
            label="Output"
            value={d.compOutput}
            ghost={baseline.compOutput}
            display={`${compOutputDb(d.compOutput).toFixed(0)}dB`}
            onChange={set("compOutput", COMP_PARAMS.outputGain)}
          />
          <Knob
            label="Attack"
            value={d.compAttack}
            ghost={baseline.compAttack}
            display={`${compAttackMs(d.compAttack).toFixed(0)}ms`}
            onChange={set("compAttack", COMP_PARAMS.attack)}
          />
          <Knob
            label="Release"
            value={d.compRelease}
            ghost={baseline.compRelease}
            display={`${compReleaseMs(d.compRelease).toFixed(0)}ms`}
            onChange={set("compRelease", COMP_PARAMS.release)}
          />
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <ToggleRow
            label="AUTO GAIN"
            value={d.autoGain}
            onChange={toggle("autoGain", COMP_PARAMS.autoGain)}
          />
          <ToggleRow
            label="LOOKAHEAD"
            value={d.lookahead}
            onChange={toggle("lookahead", COMP_PARAMS.lookahead)}
          />
        </View>
      </View>

      <View style={card}>
        <Text style={sectionLabel}>GATE / EXPANDER</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <Knob
            label="Threshold"
            value={d.gateThreshold}
            ghost={baseline.gateThreshold}
            display={gateThresholdLabel(d.gateThreshold)}
            onChange={setGate("gateThreshold", GATE_PARAMS.threshold)}
          />
          <Knob
            label="Ratio"
            value={d.gateRatio}
            ghost={baseline.gateRatio}
            display={`${gateRatio(d.gateRatio).toFixed(1)}:1`}
            onChange={setGate("gateRatio", GATE_PARAMS.ratio)}
          />
          <Knob
            label="Release"
            value={d.gateRelease}
            ghost={baseline.gateRelease}
            display={`${gateReleaseMs(d.gateRelease).toFixed(0)} ms`}
            onChange={setGate("gateRelease", GATE_PARAMS.release)}
          />
        </View>
      </View>

      <FootNote>
        Live over MIDI when connected. Units are calibrated to EliteControl&apos;s read-outs.
        Compressor (upper-right of the graph) tames peaks above its Threshold; the Gate/Expander
        (lower-left) cleans up hiss below its. Master output Level is on the editor (Output).
      </FootNote>
    </KnobScroll>
  );
}
