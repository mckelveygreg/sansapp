/**
 * GainStaging — an honest, at-a-glance estimate of how hard the drive-side gains are stacking into
 * breakup. NOT a measurement: the pedal's distortion isn't calibrated, so this is a heuristic guide
 * (Drive-weighted, with Pre-Amp compounding it and Buzz adding fizz) to keep clean tones clean and
 * to gauge how dirty a patch gets. Framework-light (plain Views); reads live from the store values.
 */
import { Text, View } from "react-native";
import type { ParamId } from "../protocol/params";
import { radius, theme } from "./theme";

const EDGE = "#c9c24a"; // yellow — between clean green and amber

interface Zone {
  max: number;
  label: string;
  color: string;
  hint: string;
}
const ZONES: readonly Zone[] = [
  { max: 0.22, label: "Clean", color: theme.green, hint: "Plenty of headroom." },
  { max: 0.45, label: "Edge of breakup", color: EDGE, hint: "Light grit starting to bloom." },
  { max: 0.72, label: "Crunchy", color: theme.amber, hint: "Driven — clear, present grit." },
  { max: 1.01, label: "Dirty", color: theme.accent, hint: "Heavy — gains stacked hot." },
];

/** Heuristic 0..1 "grit" from the drive-side controls. Drive is the dirt knob; Pre-Amp drives it
 *  harder (so they compound); Buzz adds high-frequency fizz. Guide only — not measured. */
function gritEstimate(values: Readonly<Partial<Record<ParamId, number>>>): number {
  const n = (id: ParamId) => Math.min(1, Math.max(0, (values[id] ?? 0) / 127));
  const drive = n("drive");
  const preamp = n("preamp");
  const buzz = n("buzz");
  return Math.min(1, 0.5 * drive + 0.32 * preamp + 0.18 * buzz + 0.25 * drive * preamp);
}

export function GainStaging({ values }: { values: Readonly<Partial<Record<ParamId, number>>> }) {
  const g = gritEstimate(values);
  const zone = ZONES.find((z) => g < z.max) ?? ZONES[ZONES.length - 1]!;
  const drive = (values.drive ?? 0) / 127;
  const preamp = (values.preamp ?? 0) / 127;
  // A specific nudge when the two big gains are both hot (the classic stacking case).
  const stackNote = drive > 0.6 && preamp > 0.6 ? " Pre-Amp and Drive are both hot." : "";

  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
        gap: 10,
      }}
    >
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}
      >
        <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5, fontSize: 13 }}>
          GAIN STAGING
        </Text>
        <Text style={{ color: zone.color, fontWeight: "700", fontSize: 13 }}>{zone.label}</Text>
      </View>

      {/* Track with zone-boundary ticks + a fill up to the estimate, coloured by the current zone. */}
      <View
        style={{
          height: 10,
          borderRadius: 5,
          backgroundColor: theme.bg,
          borderWidth: 1,
          borderColor: theme.panelEdge,
          overflow: "hidden",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.round(g * 100)}%`,
            backgroundColor: zone.color,
            opacity: 0.85,
          }}
        />
        {ZONES.slice(0, -1).map((z) => (
          <View
            key={z.max}
            style={{
              position: "absolute",
              left: `${Math.round(z.max * 100)}%`,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: theme.panelEdge,
            }}
          />
        ))}
      </View>

      <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
        {zone.hint}
        {stackNote} Estimated from your gain settings — a guide, not a measurement.
      </Text>
    </View>
  );
}
