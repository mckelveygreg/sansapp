import { Text, View } from "react-native";
import type { ConnectionState } from "../device/session";
import { theme } from "./theme";

const LABEL: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  ready: "Connected",
};

const COLOR: Record<ConnectionState, string> = {
  disconnected: theme.textDim,
  connecting: theme.amber,
  ready: theme.green,
};

/** Small status chip with a colored dot. */
export function ConnectionPill({ state }: { state: ConnectionState }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLOR[state] }} />
      <Text style={{ color: theme.text, fontSize: 12 }}>{LABEL[state]}</Text>
    </View>
  );
}
