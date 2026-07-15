/**
 * EqCurve — a live tone-stack graph driven by the current EQ knob values. Reuses IrGraph;
 * the curve updates as Low/Mid/High/Freq/Q change. (Presence is a preamp voicing control, not a
 * measured EQ shelf, so it's not drawn here — it lives on the Amp page.) Sizes to its actual
 * container via onLayout (it lives inside a padded Section, so a window-width guess overflowed).
 */
import { useState } from "react";
import { View } from "react-native";
import { eqResponse } from "../dsp/eq";
import { logGrid } from "../dsp/ir";
import type { ParamId } from "../protocol/params";
import { IrGraph } from "./IrGraph";
import { radius, theme } from "./theme";

const GRID = logGrid(30, 18000, 140);
const PAD = 8;

export function EqCurve({ values }: { values: Readonly<Partial<Record<ParamId, number>>> }) {
  const [boxW, setBoxW] = useState(0);
  const v = (id: ParamId) => values[id] ?? 64;
  const db = eqResponse(
    {
      low: v("low"),
      mid: v("mid"),
      high: v("high"),
      freq: v("freq"),
      q: v("q"),
    },
    GRID,
  );
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
          curves={[{ db, color: theme.amber, width: 2.4 }]}
          width={boxW - PAD * 2 - 2}
          height={132}
          dbTop={15}
          dbBot={-15}
        />
      ) : null}
    </View>
  );
}
