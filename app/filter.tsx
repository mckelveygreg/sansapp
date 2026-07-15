/**
 * Auto Filter — the pedal's envelope filter: an auto-wah (Tech 21 documents it as "similar to the
 * Mu-Tron III"). A resonant filter whose peak SWEEPS up as you dig in and falls on release — it
 * makes the vocal "wah/quack", it does NOT clean up mud (use the high-pass in IR Studio for that).
 *
 * LIVE: Level = the red-zone FILTER knob (0x3d); Attack/Release = 0x3e/0x3f (corrected 2026-07-14).
 * The graph shows the filter at the bottom and top of its sweep (shaded band = where the resonant
 * peak travels); Attack/Release set how fast it opens/closes. Raw 0–127 on the wire. RN surface.
 */
import { useMemo, useState } from "react";
import { Link } from "expo-router";
import { Text, useWindowDimensions, View } from "react-native";
import { KnobScroll } from "../src/components/KnobScroll";
import { useStore } from "zustand";
import { IrGraph } from "../src/components/IrGraph";
import type { IrCurve } from "../src/components/IrGraph";
import { Knob } from "../src/components/Knob";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { generateIr } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { AUTO_FILTER_PARAMS } from "../src/protocol/params";
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
  // Level = the red-zone FILTER knob (param 0x41 = PARAMS.filter, store-backed) — read from the pedal
  // store so it reflects recall/Apply. Attack/Release are send-only (no read-back), kept local.
  const level = useStore(pedalStore, (s) => s.values.filter) ?? 64;
  const [attack, setAttack] = useState(30);
  const [release, setRelease] = useState(40);

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

  // Level writes to the pedal store (source of truth); Attack/Release are local send-only.
  const onLevel = (v: number) => {
    sendParam(AUTO_FILTER_PARAMS.level, v);
    pedalStore.getState().setValueLocal("filter", v);
  };
  const set = (setter: (v: number) => void, param: number) => (v: number) => {
    setter(v);
    sendParam(param, v);
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
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12 }}>
          <Knob label="Level" value={level} display={filterLevelLabel(level)} onChange={onLevel} />
          <Knob
            label="Attack"
            value={attack}
            display={`${filterTimePct(attack)}%`}
            onChange={set(setAttack, AUTO_FILTER_PARAMS.attack)}
          />
          <Knob
            label="Release"
            value={release}
            display={`${filterTimePct(release)}%`}
            onChange={set(setRelease, AUTO_FILTER_PARAMS.release)}
          />
        </View>
      </View>

      <FootNote>
        Live over MIDI when connected (Level = the FILTER knob, bipolar −100…+100% with Bypass at
        centre; Attack/Release set the sweep speed). To clean up muddy lows instead, use the
        high-pass in{" "}
        <Link href="/ir" style={{ color: theme.accent }}>
          IR Studio
        </Link>
        . The sweep drawing is illustrative; the % values are hardware-calibrated.
      </FootNote>
    </KnobScroll>
  );
}
