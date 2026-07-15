import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { radius, theme } from "./theme";

/** A labeled panel that groups related controls (e.g. "PREAMP · EQ"). */
export function Section({
  title,
  accent = false,
  children,
}: {
  title: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: accent ? theme.accent : theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
        gap: 12,
      }}
    >
      <Text
        style={{
          color: accent ? theme.accent : theme.textDim,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 2,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
