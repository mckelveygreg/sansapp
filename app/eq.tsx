/**
 * Parametric EQ — the Elite's 3-band Low/Mid/High EQ, each with Gain/Freq/Q, LIVE over MIDI.
 * Gain = the main LOW/MID/HIGH knob (0x06/0x0C/0x07); Freq/Q are the deep params (wire ids corrected
 * 2026-07-14): low 0x48/0x30, mid 0x0D/0x2f, high 0x49/0x31. The graph is the combined tone response; ranges/tapers are the
 * hardware-calibrated values in src/protocol/units.ts. All bands read live from the store (so they
 * reflect the loaded preset and match the editor's tone chart); adjusting a control sends it to the
 * pedal. RN app surface.
 */
import { Text, useWindowDimensions, View } from "react-native";
import { KnobScroll } from "../src/components/KnobScroll";
import { useStore } from "zustand";
import { IrGraph } from "../src/components/IrGraph";
import { Knob } from "../src/components/Knob";
import { FootNote, GraphCard, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { eqResponse } from "../src/dsp/eq";
import { logGrid } from "../src/dsp/ir";
import { PARAMETRIC_EQ, type ParamId } from "../src/protocol/params";
import { EQ_BANDS, eqGainDb, fmtHz } from "../src/protocol/units";
import { sendParam } from "../src/midi/liveParam";
import { pedalStore } from "../src/midi/pedal";

const GRID = logGrid(30, 18000, 150);

const BANDS = [
  { key: "low", label: "LOW", ids: PARAMETRIC_EQ.low, band: EQ_BANDS.low },
  { key: "mid", label: "MID", ids: PARAMETRIC_EQ.mid, band: EQ_BANDS.mid },
  { key: "high", label: "HIGH", ids: PARAMETRIC_EQ.high, band: EQ_BANDS.high },
] as const;

// Every EQ control maps to a preset-synced store ParamId (blob offsets recovered 2026-07-07).
const STORE_ID: Record<string, ParamId> = {
  lowGain: "low",
  lowFreq: "lowFreq",
  lowQ: "lowQ",
  midGain: "mid",
  midFreq: "freq",
  midQ: "q",
  highGain: "high",
  highFreq: "highFreq",
  highQ: "highQ",
};

export default function ParametricEq() {
  const { width } = useWindowDimensions();
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  // All nine controls read live from the store (synced from the loaded preset), so the screen and
  // its graph reflect the pedal's actual values and match the editor's tone chart.
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);

  const read = (key: string): number => values[STORE_ID[key]!] ?? 64;
  const ghostOf = (key: string): number | undefined => baseline[STORE_ID[key]!];
  // Knob onChange gives an absolute 0–127; send it live and update the store so the editor's knobs +
  // tone chart stay in sync.
  const set = (key: string, param: number) => (val: number) => {
    sendParam(param, val);
    pedalStore.getState().setValueLocal(STORE_ID[key]!, val);
  };

  const db = eqResponse(
    {
      low: read("lowGain"),
      mid: read("midGain"),
      high: read("highGain"),
      freq: read("midFreq"),
      q: read("midQ"),
      lowFreq: read("lowFreq"),
      lowQ: read("lowQ"),
      highFreq: read("highFreq"),
      highQ: read("highQ"),
    },
    GRID,
  );

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>
        The 3-band parametric EQ. Each band sweeps its own centre frequency and width.
      </IntroNote>

      <GraphCard>
        <IrGraph
          grid={GRID}
          curves={[{ db, color: theme.amber, width: 2.4 }]}
          width={width - 32 - 18}
          height={170}
          dbTop={15}
          dbBot={-15}
        />
      </GraphCard>

      {BANDS.map((b) => (
        <View
          key={b.key}
          style={{
            backgroundColor: theme.panel,
            borderColor: theme.panelEdge,
            borderWidth: 1,
            borderRadius: radius,
            padding: 16,
            gap: 14,
          }}
        >
          <Text style={{ color: theme.accent, fontWeight: "700", letterSpacing: 1 }}>
            {b.label}
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            <Knob
              label="Gain"
              value={read(`${b.key}Gain`)}
              ghost={ghostOf(`${b.key}Gain`)}
              display={`${eqGainDb(read(`${b.key}Gain`)).toFixed(0)}dB`}
              onChange={set(`${b.key}Gain`, b.ids.gain)}
            />
            <Knob
              label="Freq"
              value={read(`${b.key}Freq`)}
              ghost={ghostOf(`${b.key}Freq`)}
              display={fmtHz(b.band.freq(read(`${b.key}Freq`)))}
              onChange={set(`${b.key}Freq`, b.ids.freq)}
            />
            <Knob
              label="Q"
              value={read(`${b.key}Q`)}
              ghost={ghostOf(`${b.key}Q`)}
              display={b.band.q(read(`${b.key}Q`)).toFixed(1)}
              onChange={set(`${b.key}Q`, b.ids.q)}
            />
          </View>
        </View>
      ))}

      <FootNote>
        Live over MIDI when connected. All bands reflect the loaded preset and are calibrated to
        EliteControl&apos;s read-outs. The curve is a representative model (Low/High as shelves, Mid
        as a bell) — the exact filter shapes aren&apos;t measured.
      </FootNote>
    </KnobScroll>
  );
}
