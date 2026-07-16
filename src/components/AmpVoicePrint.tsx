/**
 * AmpVoicePrint — an artistic "voice print" of the amp's drive character, drawn as one oscillating
 * wave. NOT a measured response: the pedal's real filter frequencies live in its DSP, so nothing
 * here claims Hz. Each knob maps to a visible trait instead — Pre-Amp = height, Drive = saturation
 * (squares the peaks), Buzz = high-frequency fizz, Presence = colour (warm → hot), Punch = line
 * weight, Punch Freq = oscillation spacing (spread ↔ tight), Punch Q = fullness of the fill body.
 * The curve is static (recomputed as the knobs move); react-native-svg so it works everywhere.
 */
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Line, Path, Svg } from "react-native-svg";
import type { ParamId } from "../protocol/params";
import { radius, theme } from "./theme";

const SAMPLES = 200;
const H = 150;
const PAD = 8;
const TOP = 12;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Warm theme amber (low presence) → hot near-white (high presence). */
function presenceColor(p: number): string {
  const r = Math.round(208 + (255 - 208) * p);
  const g = Math.round(160 + (252 - 160) * p);
  const b = Math.round(58 + (235 - 58) * p);
  return `rgb(${r},${g},${b})`;
}

export function AmpVoicePrint({ values }: { values: Readonly<Partial<Record<ParamId, number>>> }) {
  const [boxW, setBoxW] = useState(0);
  const innerW = Math.max(0, boxW - PAD * 2);

  const shape = useMemo(() => {
    const n = (id: ParamId) => clamp((values[id] ?? 64) / 127, 0, 1);
    const preamp = n("preamp");
    const drive = n("drive");
    const presence = n("presence");
    const buzz = n("buzz");
    const punch = n("punch");
    const punchFreq = n("punchFreq");
    const punchQ = n("punchQ");

    const W = Math.max(1, innerW);
    const MID = H / 2;
    const cycles = 1.5 + punchFreq * 5; // Punch Freq → oscillation spacing (spread .. tight)
    const amp = 0.2 + preamp * 0.8; // Pre-Amp → height
    const g = 1 + drive * 8; // Drive → saturation
    const norm = Math.tanh(g * 0.85 + 0.15);

    let d = `M0 ${MID}`;
    for (let i = 0; i <= SAMPLES; i++) {
      const x = (i / SAMPLES) * W;
      const t = (i / SAMPLES) * cycles * 2 * Math.PI;
      let y = Math.sin(t) * amp;
      y = Math.tanh(y * g) / norm; // soft → hard clip
      y += buzz * 0.13 * Math.sin(t * 19); // Buzz → HF fizz
      y = clamp(y, -1.15, 1.15);
      const py = MID - y * (MID - TOP);
      d += ` L${x.toFixed(1)} ${py.toFixed(1)}`;
    }
    return {
      line: d,
      fill: `${d} L${W.toFixed(1)} ${MID} Z`,
      strokeWidth: 1.6 + punch * 5, // Punch → line weight
      fillOpacity: 0.05 + punchQ * 0.5, // Punch Q → fullness of the body
      color: presenceColor(presence), // Presence → colour
    };
  }, [values, innerW]);

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
      {innerW > 0 ? (
        <Svg width={innerW} height={H}>
          <Line x1={0} y1={H / 2} x2={innerW} y2={H / 2} stroke={theme.panelEdge} strokeWidth={1} />
          <Path d={shape.fill} fill={shape.color} opacity={shape.fillOpacity} />
          <Path
            d={shape.line}
            fill="none"
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            strokeLinejoin="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}
