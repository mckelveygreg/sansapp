import { router } from "expo-router";
import { View } from "react-native";
import { PARAMS, type ParamId } from "../protocol/params";
import { gap } from "./theme";
import { Knob } from "./Knob";

export interface KnobPanelProps {
  ids: ParamId[];
  values: Partial<Record<ParamId, number>>;
  /** Preset baseline per knob — drives each Knob's "changed" highlight + ghost tick. */
  baseline: Partial<Record<ParamId, number>>;
  onChange: (id: ParamId, value: number) => void;
}

// Knobs that have a deep-edit page: tapping the knob opens it (the Knob shows a chevron badge).
// Every knob whose section has a deep page is listed; drive/presence/blend/preamp have no deep
// page (no chevron). Keep in sync with the KNOB_PAGES routes in app/_layout.tsx.
const DEEP_LINK: Partial<Record<ParamId, string>> = {
  comp: "/comp",
  ratio: "/comp",
  filter: "/filter",
  ambiance: "/ambience",
  chorus: "/chorus",
  level: "/gate", // "/gate" is the Gate & Master Level page
  low: "/eq",
  mid: "/eq",
  high: "/eq",
  freq: "/eq",
  q: "/eq",
};

/** A wrapping grid of knobs bound to `values` — used by the editor and Red Zone screens. */
export function KnobPanel({ ids, values, baseline, onChange }: KnobPanelProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap, justifyContent: "center" }}>
      {ids.map((id) => {
        const href = DEEP_LINK[id];
        return (
          <Knob
            key={id}
            label={PARAMS[id].label}
            value={values[id] ?? 64}
            ghost={baseline[id]}
            onChange={(v) => onChange(id, v)}
            onPress={href ? () => router.push(href) : undefined}
          />
        );
      })}
    </View>
  );
}
