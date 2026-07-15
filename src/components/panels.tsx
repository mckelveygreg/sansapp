/**
 * Shared panel primitives for the deep-effect pages (Comp, EQ, Filter, Ambience, Chorus). They were
 * each hand-rolling the same intro line, graph frame, and footnote card — this centralizes those so
 * the pages stay consistent and the layout lives in one place. RN app surface.
 */
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { radius, theme } from "./theme";

/** Dim intro line at the top of a deep page, with a connection-aware suffix. */
export function IntroNote({ ready, children }: { ready: boolean; children: ReactNode }) {
  return (
    <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
      {children}
      {ready ? " Controls are live." : " Connect to control the pedal."}
    </Text>
  );
}

/** Dark card that frames a graph (thin border, tight padding). */
export function GraphCard({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.bg,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 8,
      }}
    >
      {children}
    </View>
  );
}

/** Amber-bordered footnote card with dim explanatory text (accepts inline links). */
export function FootNote({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: theme.amber,
        borderWidth: 1,
        borderRadius: radius,
        padding: 12,
      }}
    >
      <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>{children}</Text>
    </View>
  );
}
