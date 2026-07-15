/**
 * Chorus — the pedal's chorus effect, LIVE over MIDI. Params (wire ids corrected 2026-07-14):
 * Level 0x42, Mod Freq 0x43, Mod Depth 0x44, Delay Size 0x45, Feedback 0x46 (CHORUS_PARAMS); their preset
 * blob offsets were recovered (chorus block 0x64–0x68), so all five read live from the store and
 * reflect the loaded preset. Ranges from EliteControl's readouts: Mod Freq 0–6 Hz, Depth/Delay/Level
 * 0–100 %, Feedback −100…+100 %. Adjusting a knob sends it to the pedal + updates the store.
 */
import { View } from "react-native";
import { useStore } from "zustand";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";
import { CHORUS_PARAMS, type ParamId } from "../src/protocol/params";

const pct = (v: number) => `${Math.round((v / 127) * 100)}%`;
const bipolarPct = (v: number) => {
  const n = Math.round((v / 127) * 200 - 100);
  return `${n > 0 ? "+" : ""}${n}%`;
};

const CONTROLS: ReadonlyArray<{
  storeId: ParamId;
  param: number;
  label: string;
  fmt: (v: number) => string;
}> = [
  {
    storeId: "chorusModFreq",
    param: CHORUS_PARAMS.modFreq,
    label: "MOD FREQ",
    fmt: (v) => `${((v / 127) * 6).toFixed(2)} Hz`,
  },
  { storeId: "chorusModDepth", param: CHORUS_PARAMS.modDepth, label: "MOD DEPTH", fmt: pct },
  { storeId: "chorusDelaySize", param: CHORUS_PARAMS.delaySize, label: "DELAY SIZE", fmt: pct },
  { storeId: "chorusFeedback", param: CHORUS_PARAMS.feedback, label: "FEEDBACK", fmt: bipolarPct },
  {
    storeId: "chorus",
    param: CHORUS_PARAMS.level,
    label: "LEVEL",
    fmt: (v) => (v === 0 ? "Bypass" : pct(v)),
  },
];

export default function Chorus() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);

  // Send live + update the store so the editor stays in sync.
  const set = (storeId: ParamId, param: number) => (val: number) => {
    sendParam(param, val);
    pedalStore.getState().setValueLocal(storeId, val);
  };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        The pedal&apos;s chorus — modulation, delay size, feedback, and level.
      </IntroNote>

      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 16,
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-around",
          rowGap: 20,
        }}
      >
        {CONTROLS.map((c) => {
          const v = values[c.storeId] ?? 64;
          return (
            <Knob
              key={c.storeId}
              label={c.label}
              value={v}
              ghost={baseline[c.storeId]}
              display={c.fmt(v)}
              onChange={set(c.storeId, c.param)}
            />
          );
        })}
      </View>
    </KnobScroll>
  );
}
