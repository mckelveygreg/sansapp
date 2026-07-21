/**
 * Persistent header pieces so "which preset / am I connected / move presets" work from every screen.
 * `TransportTitle` is the header title (prev/next around the 7-segment preset number + name + unsaved
 * dot) — used on the tabs AND the knob deep pages, so you can change presets without leaving a menu.
 * `HeaderConnection` is the header-right connection pill (tap → Connect), used across the app.
 */
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import { pedalStore } from "../midi/pedal";
import { ConnectionPill } from "./ConnectionPill";
import { SevenSegment } from "./SevenSegment";
import { theme } from "./theme";
import { recallWithUnsavedGuard } from "./unsavedGuard";

export function TransportTitle() {
  const slot = useStore(pedalStore, (s) => s.slot);
  const name = useStore(pedalStore, (s) => s.name);
  const dirty = useStore(pedalStore, (s) => s.dirty);
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  // Step only when connected and on a known slot; the unsaved-changes guard runs inside recall.
  const canStep = ready && slot != null;
  const go = (d: number) => recallWithUnsavedGuard(((((slot ?? 0) + d) % 128) + 128) % 128);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Pressable
        onPress={() => go(-1)}
        disabled={!canStep}
        hitSlop={10}
        style={{ opacity: canStep ? 1 : 0.25, padding: 2 }}
      >
        <Ionicons name="caret-back" size={22} color={theme.text} />
      </Pressable>
      <SevenSegment text={slot != null ? String(slot + 1).padStart(3, " ") : "---"} height={17} />
      <Pressable
        onPress={() => go(1)}
        disabled={!canStep}
        hitSlop={10}
        style={{ opacity: canStep ? 1 : 0.25, padding: 2 }}
      >
        <Ionicons name="caret-forward" size={22} color={theme.text} />
      </Pressable>
      <Text
        numberOfLines={1}
        style={{ color: theme.text, fontSize: 15, fontWeight: "800", maxWidth: 120, marginLeft: 4 }}
      >
        {name ?? "SansApp"}
        {dirty ? <Text style={{ color: theme.accent }}> •</Text> : null}
      </Text>
    </View>
  );
}

export function HeaderConnection() {
  const connection = useStore(pedalStore, (s) => s.connection);
  return (
    <Link href="/connect" asChild>
      <Pressable style={{ paddingHorizontal: 12 }} hitSlop={8}>
        <ConnectionPill state={connection} />
      </Pressable>
    </Link>
  );
}
