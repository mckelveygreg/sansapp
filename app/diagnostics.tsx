/** MIDI log / diagnostics — the store's rolling message log. RN app surface. */
import { Pressable, ScrollView, Text, View } from "react-native";
import { useStore } from "zustand";
import { radius, theme } from "../src/components/theme";
import { pedalStore } from "../src/midi/pedal";

export default function Diagnostics() {
  const log = useStore(pedalStore, (s) => s.log);

  return (
    <View style={{ flex: 1, padding: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <Text style={{ color: theme.textDim, fontSize: 13 }}>
          {log.length} message{log.length === 1 ? "" : "s"}
        </Text>
        <Pressable
          onPress={() => pedalStore.getState().clearLog()}
          disabled={log.length === 0}
          style={{
            borderColor: theme.panelEdge,
            borderWidth: 1,
            borderRadius: radius,
            paddingHorizontal: 12,
            paddingVertical: 6,
            opacity: log.length ? 1 : 0.5,
          }}
        >
          <Text style={{ color: theme.textDim }}>Clear</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {log.length === 0 ? (
          <Text style={{ color: theme.textDim }}>
            No MIDI activity yet. Connect and move a knob on the pedal.
          </Text>
        ) : (
          [...log].reverse().map((line, i) => (
            <Text
              key={`${i}-${line}`}
              style={{
                color: theme.textDim,
                fontFamily: "monospace",
                fontSize: 12,
                paddingVertical: 2,
              }}
            >
              {line}
            </Text>
          ))
        )}
      </ScrollView>
    </View>
  );
}
