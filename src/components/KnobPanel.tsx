import { router } from "expo-router";
import { View } from "react-native";
import { displayFor } from "../protocol/display";
import { PARAMS, type ParamId } from "../protocol/params";
import { gap } from "./theme";
import { Knob } from "./Knob";

export interface KnobPanelProps {
  ids: ParamId[];
  values: Partial<Record<ParamId, number>>;
  /** Preset baseline per knob — drives each Knob's "changed" highlight + ghost tick. */
  baseline: Partial<Record<ParamId, number>>;
  onChange: (id: ParamId, value: number) => void;
  /** No pedal connected: knobs render dimmed and inert (a tap still opens the deep page). */
  disabled?: boolean;
  /** Per-knob label overrides (e.g. the panel's bare "Q" in the Red Zone row). */
  labels?: Partial<Record<ParamId, string>>;
}

// Knobs that have a deep-edit page: tapping the knob opens it (the Knob shows a chevron badge).
// Rule: any knob that also appears on a deep page links to it. Preamp/Drive/Mid/Presence and Mid
// Freq/Q live on the Amp page (with the editor-only Buzz) — an amp model sets them; comp/ratio open
// Dynamics (comp + gate); the Parametric Mid opens the EQ page. Blend and Level have no deep page
// (Level is just the master output, edited here). Keep in sync with the KNOB_PAGES routes in
// app/_layout.tsx.
const DEEP_LINK: Partial<Record<ParamId, string>> = {
  preamp: "/amp",
  drive: "/amp",
  presence: "/amp",
  mid: "/amp",
  midFreq: "/amp",
  midQ: "/amp",
  comp: "/comp",
  ratio: "/comp",
  filter: "/filter",
  ambiance: "/ambience",
  chorus: "/chorus",
  low: "/eq",
  high: "/eq",
  paraMid: "/eq",
  paraMidFreq: "/eq",
  paraMidQ: "/eq",
};

/** A wrapping grid of knobs bound to `values` — used by the editor and Red Zone screens. */
export function KnobPanel({ ids, values, baseline, onChange, disabled, labels }: KnobPanelProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap, justifyContent: "center" }}>
      {ids.map((id) => {
        const href = DEEP_LINK[id];
        return (
          <Knob
            key={id}
            label={labels?.[id] ?? PARAMS[id].label}
            value={values[id] ?? 64}
            display={displayFor(id, values[id] ?? 64)}
            ghost={baseline[id]}
            onChange={(v) => onChange(id, v)}
            onPress={href ? () => router.push(href) : undefined}
            disabled={disabled}
          />
        );
      })}
    </View>
  );
}
