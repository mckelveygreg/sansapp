/**
 * KnobScroll — a ScrollView for knob-bearing screens that stops scrolling the moment a knob is
 * grabbed. The Knob sets `uiStore.adjusting` on touch-down (see Knob.tsx); while that's true this
 * disables scroll, so a vertical drag on a knob changes its value instead of scrolling the page.
 * Forwards all ScrollView props; `scrollEnabled` is forced off during a drag.
 */
import { ScrollView, type ScrollViewProps } from "react-native";
import { useStore } from "zustand";
import { uiStore } from "../state/ui";

export function KnobScroll(props: ScrollViewProps) {
  const adjusting = useStore(uiStore, (s) => s.adjusting);
  return <ScrollView {...props} scrollEnabled={!adjusting} />;
}
