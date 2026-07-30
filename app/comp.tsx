/**
 * Compressor — the deep compressor page, LIVE: each control sends its captured param over MIDI
 * (Threshold = the COMP knob 0x0A; Ratio/Output/Attack/Release = 0x19–0x1c; Auto Gain/Lookahead =
 * 0x32/0x33). Every control reads from pedalStore.values (the single
 * source of truth), so physical-knob notifies and preset recalls update the page live. The dynamics
 * graph, shared with the Gate section on this page, is drawn from those same values: the compressor is
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
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";
import { PARAMS, type ParamId } from "../src/protocol/params";
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
  // Every control reads from pedalStore.values (the single source of truth) via its own selector, so
  // preset recalls and physical-knob notifies update the page live and a save captures what's shown.
  // Gate/comp are store-backed via PARAMS (Threshold = comp 0x0a, Ratio = ratio 0x19, …).
  const baseline = useStore(pedalStore, (s) => s.baseline);
  const threshold = useStore(pedalStore, (s) => s.values.comp) ?? 64;
  const ratio = useStore(pedalStore, (s) => s.values.ratio) ?? 64;
  const compOutput = useStore(pedalStore, (s) => s.values.compOutput) ?? 64;
  const compAttack = useStore(pedalStore, (s) => s.values.compAttack) ?? 64;
  const compRelease = useStore(pedalStore, (s) => s.values.compRelease) ?? 64;
  const softClip = useStore(pedalStore, (s) => s.values.softClip) ?? 127;
  const gateThreshold = useStore(pedalStore, (s) => s.values.gateThreshold) ?? 64;
  const gateRatioVal = useStore(pedalStore, (s) => s.values.gateRatio) ?? 64;
  const gateAttack = useStore(pedalStore, (s) => s.values.gateAttack) ?? 0;
  const gateRelease = useStore(pedalStore, (s) => s.values.gateRelease) ?? 64;
  const autoGain = (useStore(pedalStore, (s) => s.values.autoGain) ?? 0) > 0;
  const lookahead = (useStore(pedalStore, (s) => s.values.lookahead) ?? 0) > 0;

  // Knob onChange gives an absolute 0–127; send it live (index → liveSetId inside sendParam) and
  // record it in the store for read-back/ghost. One helper for every store-backed control.
  const setP = (id: ParamId) => (v: number) => {
    sendParam(PARAMS[id].paramId ?? 0, v);
    pedalStore.getState().setValueLocal(id, v);
  };
  const toggleP = (id: ParamId) => (on: boolean) => setP(id)(on ? 1 : 0);

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
  const gt = gateThresholdDb(gateThreshold);
  const gateParams = gt === null ? undefined : { thresholdDb: gt, ratio: gateRatio(gateRatioVal) };

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
            onChange={setP("comp")}
          />
          <Knob
            label="Ratio"
            value={ratio}
            ghost={baseline.ratio}
            display={`${compRatio(ratio).toFixed(1)}:1`}
            onChange={setP("ratio")}
          />
          <Knob
            label="Output"
            value={compOutput}
            ghost={baseline.compOutput}
            display={`${compOutputDb(compOutput).toFixed(0)}dB`}
            onChange={setP("compOutput")}
          />
          <Knob
            label="Attack"
            value={compAttack}
            ghost={baseline.compAttack}
            display={`${compAttackMs(compAttack).toFixed(0)}ms`}
            onChange={setP("compAttack")}
          />
          <Knob
            label="Release"
            value={compRelease}
            ghost={baseline.compRelease}
            display={`${compReleaseMs(compRelease).toFixed(0)}ms`}
            onChange={setP("compRelease")}
          />
          <Knob
            label="Soft Clip"
            value={softClip}
            ghost={baseline.softClip}
            display={`${rawToPct(softClip)}%`}
            onChange={setP("softClip")}
          />
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <ToggleRow label="AUTO GAIN" value={autoGain} onChange={toggleP("autoGain")} />
          <ToggleRow label="LOOKAHEAD" value={lookahead} onChange={toggleP("lookahead")} />
        </View>
      </View>

      <View style={card}>
        <Text style={sectionLabel}>GATE / EXPANDER</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
          <Knob
            label="Threshold"
            value={gateThreshold}
            ghost={baseline.gateThreshold}
            display={gateThresholdLabel(gateThreshold)}
            onChange={setP("gateThreshold")}
          />
          <Knob
            label="Ratio"
            value={gateRatioVal}
            ghost={baseline.gateRatio}
            display={`${gateRatio(gateRatioVal).toFixed(1)}:1`}
            onChange={setP("gateRatio")}
          />
          <Knob
            label="Attack"
            value={gateAttack}
            ghost={baseline.gateAttack}
            display={`${rawToPct(gateAttack)}%`}
            onChange={setP("gateAttack")}
          />
          <Knob
            label="Release"
            value={gateRelease}
            ghost={baseline.gateRelease}
            display={`${gateReleaseMs(gateRelease).toFixed(0)} ms`}
            onChange={setP("gateRelease")}
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
