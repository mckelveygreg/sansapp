/**
 * CompCurve — the dynamics transfer graph (input dB → output dB), matching EliteControl: a 1:1
 * reference, the GATE on the lower-left (left dot = gate threshold, segment angle = gate ratio), and
 * the COMPRESSOR on the upper-right (right dot = comp threshold, segment angle = comp ratio). Updates
 * live as either page's knobs change. react-native-svg.
 */
import { Circle, G, Line, Path, Svg, Text as SvgText } from "react-native-svg";
import { type CompParams, dynamicsOutDb, type GateParams } from "../dsp/comp";
import { theme } from "./theme";

const MIN = -90;
const MAX = 0;
const PAD = { l: 34, r: 10, t: 10, b: 22 };
const LINES = [-80, -60, -40, -20, 0];

export function CompCurve({
  comp,
  gate,
  width,
  height,
}: {
  comp: CompParams;
  gate?: GateParams;
  width: number;
  height: number;
}) {
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const fin = (v: number, lo: number, hi: number) =>
    Number.isNaN(v) ? lo : Math.max(lo, Math.min(hi, v));
  const x = (dB: number) => PAD.l + ((fin(dB, MIN, MAX) - MIN) / (MAX - MIN)) * innerW;
  // NaN in a path string hard-crashes RNSVG on iOS — floor non-finite values.
  const y = (dB: number) => PAD.t + ((MAX - fin(dB, MIN, MAX)) / (MAX - MIN)) * innerH;

  const STEPS = 90;
  const pts: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const inDb = MIN + (i / STEPS) * (MAX - MIN);
    pts.push(
      `${i === 0 ? "M" : "L"}${x(inDb).toFixed(1)} ${y(dynamicsOutDb(inDb, comp, gate)).toFixed(1)}`,
    );
  }

  const gateActive = gate !== undefined && gate.ratio > 1 && gate.thresholdDb > MIN;

  return (
    <Svg width={width} height={height}>
      <G>
        {LINES.map((v) => (
          <G key={v}>
            <Line
              x1={x(v)}
              y1={PAD.t}
              x2={x(v)}
              y2={height - PAD.b}
              stroke="#212126"
              strokeWidth={1}
            />
            <Line
              x1={PAD.l}
              y1={y(v)}
              x2={width - PAD.r}
              y2={y(v)}
              stroke="#212126"
              strokeWidth={1}
            />
            <SvgText
              x={x(v)}
              y={height - PAD.b + 12}
              fill={theme.textDim}
              fontSize={9}
              textAnchor="middle"
            >
              {v}
            </SvgText>
            <SvgText x={PAD.l - 5} y={y(v) + 3} fill={theme.textDim} fontSize={9} textAnchor="end">
              {v}
            </SvgText>
          </G>
        ))}
      </G>
      {/* 1:1 reference */}
      <Line
        x1={x(MIN)}
        y1={y(MIN)}
        x2={x(MAX)}
        y2={y(MAX)}
        stroke={theme.panelEdge}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      {/* transfer curve */}
      <Path
        d={pts.join(" ")}
        fill="none"
        stroke={theme.accent}
        strokeWidth={2.4}
        strokeLinejoin="round"
      />
      {/* gate threshold dot (lower-left) */}
      {gateActive ? (
        <Circle
          cx={x(gate.thresholdDb)}
          cy={y(dynamicsOutDb(gate.thresholdDb, comp, gate))}
          r={4}
          fill={theme.amber}
        />
      ) : null}
      {/* comp threshold dot (upper-right) */}
      <Circle
        cx={x(comp.thresholdDb)}
        cy={y(dynamicsOutDb(comp.thresholdDb, comp, gate))}
        r={4}
        fill={theme.amber}
      />
    </Svg>
  );
}
