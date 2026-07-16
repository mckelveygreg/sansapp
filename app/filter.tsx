/**
 * Auto Filter — the pedal's envelope filter (auto-wah, Mu-Tron III style): a resonant peak that
 * SWEEPS up as you dig in and falls on release. The pedal's ENTIRE auto-filter surface is: a master
 * enable (0x3c), Level = sweep depth (0x3d, the red-zone FILTER knob), and Attack/Release timing
 * (0x3e/0x3f). There is no cutoff/resonance param (confirmed by RE). All store-backed now, so every
 * control reads back from the preset and shows the amber ghost.
 *
 * The graph shows the sweep band (Level sets its top freq + resonance). Attack/Release are timing,
 * so they don't move a static frequency curve — that's expected, not a bug. RN surface.
 */
import { useMemo } from "react";
import { Link } from "expo-router";
import { Switch, Text, useWindowDimensions, View } from "react-native";
import { KnobScroll } from "../src/components/KnobScroll";
import { useStore } from "zustand";
import { IrGraph } from "../src/components/IrGraph";
import type { IrCurve } from "../src/components/IrGraph";
import { Knob } from "../src/components/Knob";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
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

  const q = 1.6 + (level / 127) * 4;
  const restHz = 180;
  const openHz = Math.round(restHz * 2 ** (1.3 + (level / 127) * 3));
  const { closed, open } = useMemo(
    () => ({ closed: wahCurve(restHz, q), open: wahCurve(openHz, q) }),
    [q, openHz],
  );
  const curves: IrCurve[] = [
    { db: closed, color: theme.textDim, width: 1.6, opacity: 0.7 },
    { db: open, color: theme.amber, width: 2.6, fillFrom: closed, fillColor: theme.amber },
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
          resonant peak sweeps ≈ {restHz} →{" "}
          {openHz >= 1000 ? `${(openHz / 1000).toFixed(1)}k` : openHz} Hz with your dynamics
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
          />
          <Knob
            label="Attack"
            value={attack}
            ghost={baseline.filterAttack}
            display={`${filterTimePct(attack)}%`}
            onChange={setP("filterAttack")}
          />
          <Knob
            label="Release"
            value={release}
            ghost={baseline.filterRelease}
            display={`${filterTimePct(release)}%`}
            onChange={setP("filterRelease")}
          />
        </View>
      </View>

      <FootNote>
        Live over MIDI when connected. The toggle engages the auto-wah; Level (the FILTER knob) is
        the sweep depth (bipolar −100…+100% with Bypass at centre); Attack/Release set the sweep
        speed. To clean up muddy lows instead, use the high-pass in{" "}
        <Link href="/ir" style={{ color: theme.accent }}>
          IR Studio
        </Link>
        . The sweep drawing is illustrative; the % values are hardware-calibrated.
      </FootNote>
    </KnobScroll>
  );
}
