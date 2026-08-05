/**
 * AmpVoicePrint — the amp's drive character as a real frequency response. It sums the pedal's three
 * drive biquads from the hardware-verified model (src/dsp/drive.ts): Buzz (a 200 Hz low shelf),
 * Punch (a swept bell, run twice) and Crunch (a 2500 Hz bell run twice — the front-panel Presence
 * knob). The curve is the one the pedal actually produces, so Buzz's off-centre unity point (~value
 * 73 — a centred Buzz is a ~3 dB cut) and Crunch's boost-only behaviour (value 0 is flat, it can
 * never cut) are both visible in the shape. It is drawn as a filled, presence-tinted area to stay
 * visually distinct from the EQ page's plain tone-curve line. react-native-svg so it works everywhere.
 */
import { useMemo, useState } from "react";
import { View } from "react-native";
import { driveResponse } from "../dsp/drive";
import { logGrid } from "../dsp/ir";
import type { ParamId } from "../protocol/params";
import { IrGraph } from "./IrGraph";
import { mixHex, radius, theme, toneColors } from "./theme";

const GRID = logGrid(30, 18000, 150);
const ZERO = GRID.map(() => 0); // the 0 dB baseline the fill shades to
const H = 160;
const PAD = 8;

/** Warm amber (low Presence) → hot near-white (high Presence): the shared drive-domain gradient. */
function presenceColor(p: number): string {
  return mixHex(toneColors.drive.from, toneColors.drive.to, p / 127);
}

export function AmpVoicePrint({ values }: { values: Readonly<Partial<Record<ParamId, number>>> }) {
  const [boxW, setBoxW] = useState(0);
  const v = (id: ParamId): number => values[id] ?? 64;

  const db = useMemo(
    () =>
      driveResponse(
        {
          buzz: v("buzz"),
          buzzQ: v("buzzQ"),
          punch: v("punch"),
          punchFreq: v("punchFreq"),
          punchQ: v("punchQ"),
          presence: v("presence"),
          crunchQ: v("crunchQ"),
        },
        GRID,
      ),
    [values],
  );
  const color = presenceColor(v("presence"));

  return (
    <View
      onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}
      style={{
        backgroundColor: theme.bg,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: PAD,
      }}
    >
      {boxW > 0 ? (
        <IrGraph
          grid={GRID}
          curves={[{ db, color, width: 2.2, fillFrom: ZERO, fillColor: color }]}
          width={boxW - PAD * 2}
          height={H}
          dbTop={15}
          dbBot={-15}
          fitData
        />
      ) : null}
    </View>
  );
}
