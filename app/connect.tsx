/** Connection screen — connect + hardware guidance. RN app surface. */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useStore } from "zustand";
import { ConnectionPill } from "../src/components/ConnectionPill";
import { radius, theme } from "../src/components/theme";
import { connectPedal, disconnectPedal, loadDemoState, pedalStore } from "../src/midi/pedal";

export default function Connect() {
  const connection = useStore(pedalStore, (s) => s.connection);
  const [error, setError] = useState<string | null>(null);
  // sansapp://connect?auto=1 connects on open — a Shortcuts-friendly quick-connect, and what
  // tools/screenshots.ts uses to drive the app. ?demo=1 loads synthetic state (no hardware) so the
  // UI can be previewed and screenshotted without a pedal.
  const { auto, demo } = useLocalSearchParams<{ auto?: string; demo?: string }>();

  async function onConnect() {
    try {
      setError(null);
      await connectPedal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (demo === "1") loadDemoState();
    else if (auto === "1") void onConnect();
  }, [auto, demo]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700" }}>Connection</Text>
        <ConnectionPill state={connection} />
      </View>

      <Pressable
        onPress={onConnect}
        disabled={connection === "connecting"}
        style={{
          backgroundColor: theme.green,
          padding: 14,
          borderRadius: radius,
          alignItems: "center",
          flexDirection: "row",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {connection === "connecting" ? <ActivityIndicator color="#fff" /> : null}
        <Text style={{ color: "#fff", fontWeight: "700" }}>
          {connection === "ready"
            ? "Reconnect"
            : connection === "connecting"
              ? "Connecting…"
              : "Connect to pedal"}
        </Text>
      </Pressable>
      {error ? <Text style={{ color: theme.accent }}>{error}</Text> : null}

      {connection === "ready" ? (
        <Pressable
          onPress={disconnectPedal}
          style={{
            borderColor: theme.panelEdge,
            borderWidth: 1,
            padding: 12,
            borderRadius: radius,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.textDim }}>Disconnect</Text>
        </Pressable>
      ) : null}

      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
          gap: 8,
        }}
      >
        <Text style={{ color: theme.text, fontWeight: "600" }}>How to connect</Text>
        <Text style={{ color: theme.textDim, lineHeight: 20 }}>
          • Bluetooth: cable a CME WIDI Jack (25TRS35) to the pedal's MIDI IN/OUT. On iPhone, pair
          it in the CME WIDI app or GarageBand first; on Android, just tap Connect and allow the
          Bluetooth permission.{"\n"}• Wired: the pedal's MD1 USB interface via a USB-C/Lightning
          adapter (iPhone or Android).{"\n"}Then tap Connect — it finds the WIDI Jack or MD1
          automatically, handshakes, and loads the current preset.
        </Text>
      </View>

      <Pressable onPress={() => router.push("/help")} style={{ alignItems: "center", padding: 8 }}>
        <Text style={{ color: theme.accent, fontWeight: "700" }}>Open the full guide →</Text>
      </Pressable>
    </ScrollView>
  );
}
