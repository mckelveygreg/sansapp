/**
 * Auto Filter — the pedal's envelope filter (auto-wah, Mu-Tron III style): a resonant peak that
 * SWEEPS up as you dig in and falls on release. Derived from observing EliteControl (issue #41):
 * the auto-filter's ENTIRE surface is four params — a master enable (0x3c, a real 0..1 toggle),
 * Level (0x3d, default 64, range 0..127 — **BIPOLAR, Bypass at centre**), and Attack/Release timing
 * (0x3e/0x3f). There is NO cutoff/resonance param (the "Filter Cutoff/Resonance" strings in
 * EliteControl are a generic MIDI/mod table, not pedal params). All store-backed.
 *
 * Level's SIGN is the sweep DIRECTION (above centre = up-wah, below = reverse/down-wah) and its
 * magnitude the depth — read off the factory presets (Reverse Funk sits below centre; WakaWaka/Funk
 * above). The pedal has NO sweep-frequency control (all factory wah presets leave the EQ neutral), so
 * the graph draws direction + depth from Level and Bypass = flat. Attack/Release are timing, so they
 * don't move a static frequency curve — expected, not a bug. RN surface.
 */
import { useMemo } from "react";
import { Switch, Text, useWindowDimensions, View } from "react-native";
import { KnobScroll } from "../src/components/KnobScroll";
import { useStore } from "zustand";
import { IrGraph } from "../src/components/IrGraph";
import type { IrCurve } from "../src/components/IrGraph";
import { Knob } from "../src/components/Knob";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme, toneColors } from "../src/components/theme";
import { generateIr } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { PARAMS, type ParamId } from "../src/protocol/params";
import { filterLevelLabel, filterTimePct } from "../src/protocol/units";
import { sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";

const GRID = logGrid(30, 18000, 150);

// A resonant low-pass IR whose peak sits at `fc` (the auto-wah's instantaneous filter).
const wahCurve = (fc: number, q: number) =>
  frequencyResponse(generateIr("lowpass", { fc, q, stages: 1, taps: 2000 }), GRID, {
    normalizeBand: [50, 110],
  });

export default function AutoFilter() {
  const { width } = useWindowDimensions();
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const level = useStore(pedalStore, (s) => s.values.filter) ?? 64;
  const attack = useStore(pedalStore, (s) => s.values.filterAttack) ?? 64;
  const release = useStore(pedalStore, (s) => s.values.filterRelease) ?? 64;
  const on = (useStore(pedalStore, (s) => s.values.autoFilterOn) ?? 0) > 0;
  const baseline = useStore(pedalStore, (s) => s.baseline);

  // Level (0x3d) is BIPOLAR — raw 64 = Bypass (no sweep). Its SIGN is the sweep DIRECTION and its
  // magnitude the intensity: ABOVE centre = normal up-wah, BELOW centre = reverse/down-wah. Derived
  // from observing EliteControl (default 64, 0..127) + the factory presets — "Reverse Funk" sits at
  // 53 (below centre) while "WakaWaka"/"Funk" sit at 92/81 (above). There is NO sweep-frequency param
  // (all 4 factory wah presets leave the Mid/EQ neutral at 64) — the range is fixed in the pedal DSP.
  const depth = Math.abs(level - 64) / 63; // 0 at Bypass … 1 at ±100%
  const up = level >= 64; // ≥ centre = up-wah; below = reverse (down) wah
  const q = 1.4 + depth * 3.6;
  const loHz = 180;
  const hiHz = Math.round(loHz * 2 ** (depth * 3.3)); // == loHz (flat) at Bypass
  // Resting (idle) vs dug-in ("swept") peak: an up-wah opens upward, a reverse-wah closes downward.
  const restingHz = up ? loHz : hiHz;
  const sweptHz = up ? hiHz : loHz;
  const { resting, swept } = useMemo(
    () => ({ resting: wahCurve(restingHz, q), swept: wahCurve(sweptHz, q) }),
    [q, restingHz, sweptHz],
  );
  const curves: IrCurve[] = [
    { db: resting, color: theme.textDim, width: 1.6, opacity: 0.7 },
    {
      db: swept,
      color: toneColors.autoFilter,
      width: 2.6,
      fillFrom: resting,
      fillColor: toneColors.autoFilter,
    },
  ];

  // Store-backed: send the live edit (index → liveSetId inside sendParam) + record it for read-back.
  const setP = (id: ParamId) => (v: number) => {
    sendParam(PARAMS[id].paramId ?? 0, v);
    pedalStore.getState().setValueLocal(id, v);
  };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        An envelope auto-wah (Mu-Tron III style): a resonant peak that sweeps up as you dig in and
        falls back on release — that vocal "wah/quack".
      </IntroNote>

      <GraphCard>
        <IrGraph
          grid={GRID}
          curves={curves}
          width={width - 32 - 18}
          height={190}
          dbTop={15}
          dbBot={-45}
        />
        <Text style={{ color: theme.textDim, fontSize: 11, textAlign: "center", marginTop: 4 }}>
          {level === 64
            ? "Level at Bypass (centre) — turn UP for an up-wah, DOWN for a reverse wah"
            : `${up ? "up-wah — peak sweeps UP" : "reverse wah — peak sweeps DOWN"} as you dig in (range is fixed)`}
        </Text>
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
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
            AUTO FILTER
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>
              {on ? "ON" : "OFF"}
            </Text>
            <Switch
              value={on}
              disabled={!ready}
              onValueChange={(v) => setP("autoFilterOn")(v ? 1 : 0)}
              trackColor={{ false: theme.panelEdge, true: theme.accent }}
              thumbColor="#fff"
            />
          </View>
        </View>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 12,
            opacity: on ? 1 : 0.45,
          }}
        >
          <Knob
            label="Level"
            value={level}
            ghost={baseline.filter}
            display={filterLevelLabel(level)}
            onChange={setP("filter")}
            disabled={!ready}
          />
          <Knob
            label="Attack"
            value={attack}
            ghost={baseline.filterAttack}
            display={`${filterTimePct(attack)}%`}
            onChange={setP("filterAttack")}
            disabled={!ready}
          />
          <Knob
            label="Release"
            value={release}
            ghost={baseline.filterRelease}
            display={`${filterTimePct(release)}%`}
            onChange={setP("filterRelease")}
            disabled={!ready}
          />
        </View>
      </View>

      <FootNote>
        Turn the toggle ON, then move Level OFF its centre. Level is bipolar (Bypass at centre):
        turn it UP for a normal up-wah, DOWN for a reverse (down) wah — the further from centre, the
        deeper the sweep. There is no sweep-frequency control; that range is fixed in the pedal (the
        factory wah presets all leave the EQ neutral). Attack/Release set the envelope feel (how
        fast the quack opens/closes). Factory starting points: WakaWaka = Level +45%, slow attack;
        Funk = +28%, snappy attack; Reverse Funk = −17%, fast release. The % values are
        hardware-calibrated.
      </FootNote>
    </KnobScroll>
  );
}
