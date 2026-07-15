/**
 * Gate & Master Level — behind EliteControl's LEVEL knob. MAIN LEVEL = the master output (param
 * 0x00 = "level", store-backed). The noise GATE is live: Threshold 0x09; Ratio 0x1d (Expander Ratio,
 * inferred); Release 0x27 (Gate Release). Wire ids corrected 2026-07-14 from the parameter-map + hardware confirmation — the
 * old 0x29/0x2b were IR Mode / User IR Gain (see docs/PROTOCOL.md); the gate ids still want a
 * capture to confirm. The dynamics graph is shared with the Compressor page — the gate is its lower-left
 * segment (left dot = gate threshold, angle = gate ratio). RN app surface.
 */
import { Text, useWindowDimensions, View } from "react-native";
import { useStore } from "zustand";
import { CompCurve } from "../src/components/CompCurve";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";
import { GATE_PARAMS, PARAMS } from "../src/protocol/params";
import { dynamicsStore } from "../src/state/dynamics";
import {
  compRatio,
  compThresholdDb,
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
  gap: 12,
} as const;
const sectionLabel = { color: theme.accent, fontWeight: "700", letterSpacing: 1 } as const;

export default function Gate() {
  const { width } = useWindowDimensions();
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const level = useStore(pedalStore, (s) => s.values.level) ?? 64;
  const baseline = useStore(pedalStore, (s) => s.baseline);
  const d = useStore(dynamicsStore, (s) => s);
  // Comp threshold/ratio for the shared graph are store-backed (read from the pedal store).
  const compThreshold = useStore(pedalStore, (s) => s.values.comp) ?? 64;
  const compRatioRaw = useStore(pedalStore, (s) => s.values.ratio) ?? 64;

  const setLevel = (v: number) => {
    sendParam(PARAMS.level.paramId ?? 0, v);
    pedalStore.getState().setValueLocal("level", v);
  };
  const setG =
    (key: "gateThreshold" | "gateRatio" | "gateRelease", param: number) => (v: number) => {
      sendParam(param, v);
      dynamicsStore.getState().patch({ [key]: v });
    };

  // Shared dynamics-graph params (gate here + comp from the pedal store).
  const compThr = compThresholdDb(compThreshold);
  const compBase = {
    thresholdDb: compThr ?? 0,
    ratio: compThr === null ? 1 : compRatio(compRatioRaw),
    kneeDb: 6,
  };
  const compParams = { ...compBase, makeupDb: 0 }; // graph shows the compression shape, not make-up
  const gt = gateThresholdDb(d.gateThreshold);
  const gateParams = gt === null ? undefined : { thresholdDb: gt, ratio: gateRatio(d.gateRatio) };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        Master output level and the noise gate — the panel behind EliteControl&apos;s LEVEL knob.
      </IntroNote>

      <GraphCard>
        <CompCurve comp={compParams} gate={gateParams} width={width - 32 - 18} height={180} />
      </GraphCard>

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

      <View style={card}>
        <Text style={sectionLabel}>GATE</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <Knob
            label="Threshold"
            value={d.gateThreshold}
            ghost={baseline.gateThreshold}
            display={gateThresholdLabel(d.gateThreshold)}
            onChange={setG("gateThreshold", GATE_PARAMS.threshold)}
          />
          <Knob
            label="Ratio"
            value={d.gateRatio}
            ghost={baseline.gateRatio}
            display={`${gateRatio(d.gateRatio).toFixed(1)}:1`}
            onChange={setG("gateRatio", GATE_PARAMS.ratio)}
          />
          <Knob
            label="Release"
            value={d.gateRelease}
            ghost={baseline.gateRelease}
            display={`${gateReleaseMs(d.gateRelease).toFixed(1)} ms`}
            onChange={setG("gateRelease", GATE_PARAMS.release)}
          />
        </View>
      </View>

      <FootNote>
        Live over MIDI — Main Level is the master output; the Gate cleans up hiss/noise below its
        Threshold (the lower-left of the graph). Calibrated to EliteControl&apos;s read-outs (the
        Threshold low end is an estimate); read back from the preset, so a moved knob shows the
        amber ghost of its saved value.
      </FootNote>
    </KnobScroll>
  );
}
