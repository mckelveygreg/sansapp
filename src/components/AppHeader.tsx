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

/**
 * Shown beside the preset name when the app can't claim its values are what the pedal is playing —
 * on a fresh connect, and after any link drop. Deliberately a question mark, not a warning: the app
 * cannot detect drift, so this is about what it *knows*, never a claim that something is wrong. Tapping
 * it goes to the Connection screen, where Read from Pedal explains itself and can settle the question.
 */
function FreshnessMark() {
  const stale = useStore(pedalStore, (s) => s.freshness) === "stale";
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  if (!stale || !ready) return null;
  return (
    <Link href="/connect" asChild>
      <Pressable
        hitSlop={8}
        style={{ paddingHorizontal: 2 }}
        accessibilityRole="button"
        accessibilityLabel="Values may be stale — read from the pedal"
      >
        <Ionicons name="help-circle-outline" size={15} color={theme.amber} />
      </Pressable>
    </Link>
  );
}

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
        style={{ color: theme.text, fontSize: 15, fontWeight: "800", maxWidth: 110, marginLeft: 4 }}
      >
        {name ?? "SansApp"}
        {dirty ? <Text style={{ color: theme.accent }}> •</Text> : null}
      </Text>
      <FreshnessMark />
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
