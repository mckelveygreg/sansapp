/**
 * IrGraph — a frequency-response plot (log-frequency x, dB y) for impulse responses.
 * Presentational: pass a shared `grid` (Hz) and one or more `curves` of dB values.
 * Renders with react-native-svg so it works on iOS, Android, and web.
 */
import { G, Line, Path, Svg, Text as SvgText } from "react-native-svg";
import { fitDbWindow } from "../ui/graphWindow";
import { theme } from "./theme";

export interface IrCurve {
  /** dB value per grid frequency (same length as `grid`). */
  db: readonly number[];
  color: string;
  width?: number;
  opacity?: number;
  /** SVG dash pattern (e.g. "6 4") — a conditional/level-gated stage, vs the solid static ones. */
  dash?: string;
  /** When set, shade the area between this curve and `db` (e.g. the removed low end). */
  fillFrom?: readonly number[];
  fillColor?: string;
}

interface IrGraphProps {
  grid: readonly number[];
  curves: readonly IrCurve[];
  width: number;
  height: number;
  fMin?: number;
  fMax?: number;
  dbTop?: number;
  dbBot?: number;
  /** Treat dbTop/dbBot as a minimum window and expand it so no curve clips (see fitDbWindow).
   * Off by default: the IR plots want their fixed window. */
  fitData?: boolean;
}

const PAD = { l: 38, r: 10, t: 12, b: 22 };
const FREQ_LINES: { f: number; label?: string }[] = [
  { f: 30, label: "30" },
  { f: 50 },
  { f: 100, label: "100" },
  { f: 200 },
  { f: 300, label: "300" },
  { f: 500 },
  { f: 1000, label: "1k" },
  { f: 2000 },
  { f: 3000, label: "3k" },
  { f: 5000 },
  { f: 10000, label: "10k" },
];

export function IrGraph({
  grid,
  curves,
  width,
  height,
  fMin = 30,
  fMax = 18000,
  dbTop: minTop = 12,
  dbBot: minBot = -42,
  fitData = false,
}: IrGraphProps) {
  const { dbTop, dbBot } = fitData
    ? fitDbWindow(
        curves.flatMap((c) => (c.fillFrom ? [c.db, c.fillFrom] : [c.db])),
        minTop,
        minBot,
      )
    : { dbTop: minTop, dbBot: minBot };
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const lminF = Math.log(fMin);
  const lmaxF = Math.log(fMax);
  const x = (f: number) => {
    const lf = Number.isFinite(Math.log(f)) ? Math.log(f) : lminF;
    return PAD.l + ((lf - lminF) / (lmaxF - lminF)) * innerW;
  };
  // NaN would emit "NaN" into the SVG path string and hard-crash RNSVG on iOS — floor it.
  const y = (db: number) => {
    const c = Number.isNaN(db) ? dbBot : Math.max(dbBot, Math.min(dbTop, db));
    return PAD.t + ((dbTop - c) / (dbTop - dbBot)) * innerH;
  };

  const linePath = (db: readonly number[]) =>
    db
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(grid[i]!).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(" ");

  const areaPath = (top: readonly number[], bot: readonly number[]) => {
    const up = top.map(
      (v, i) => `${i === 0 ? "M" : "L"}${x(grid[i]!).toFixed(1)} ${y(v).toFixed(1)}`,
    );
    const down: string[] = [];
    for (let i = bot.length - 1; i >= 0; i--)
      down.push(`L${x(grid[i]!).toFixed(1)} ${y(bot[i]!).toFixed(1)}`);
    return `${up.join(" ")} ${down.join(" ")} Z`;
  };

  const dbLines: number[] = [];
  for (let db = Math.floor(dbTop / 12) * 12; db >= Math.ceil(dbBot / 12) * 12; db -= 12)
    dbLines.push(db);

  return (
    <Svg width={width} height={height}>
      <G>
        {dbLines.map((db) => (
          <G key={`db${db}`}>
            <Line
              x1={PAD.l}
              y1={y(db)}
              x2={width - PAD.r}
              y2={y(db)}
              stroke={db === 0 ? theme.panelEdge : "#212126"}
              strokeWidth={1}
            />
            <SvgText x={PAD.l - 6} y={y(db) + 3} fill={theme.textDim} fontSize={9} textAnchor="end">
              {db > 0 ? `+${db}` : `${db}`}
            </SvgText>
          </G>
        ))}
        {FREQ_LINES.map(({ f, label }) => (
          <G key={`f${f}`}>
            <Line
              x1={x(f)}
              y1={PAD.t}
              x2={x(f)}
              y2={height - PAD.b}
              stroke={label ? "#26262c" : "#1b1b20"}
              strokeWidth={1}
            />
            {label ? (
              <SvgText
                x={x(f)}
                y={height - PAD.b + 12}
                fill={theme.textDim}
                fontSize={9}
                textAnchor="middle"
              >
                {label}
              </SvgText>
            ) : null}
          </G>
        ))}
      </G>

      {curves.map((c, i) =>
        c.fillFrom ? (
          <Path
            key={`fill${i}`}
            d={areaPath(c.fillFrom, c.db)}
            fill={c.fillColor ?? c.color}
            opacity={0.14}
          />
        ) : null,
      )}
      {curves.map((c, i) => (
        <Path
          key={`line${i}`}
          d={linePath(c.db)}
          fill="none"
          stroke={c.color}
          strokeWidth={c.width ?? 2}
          strokeOpacity={c.opacity ?? 1}
          strokeDasharray={c.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}
