/**
 * Editor screen — the hybrid knob panel bound to the tested store/session core.
 * RN app surface (tsconfig.json), not the Node core.
 */
import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KnobScroll } from "../../src/components/KnobScroll";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { ConnectionPill } from "../../src/components/ConnectionPill";
import { EqCurve } from "../../src/components/EqCurve";
import { KnobPanel } from "../../src/components/KnobPanel";
import { Section } from "../../src/components/Section";
import { SectionBar } from "../../src/components/SectionBar";
import { SevenSegment } from "../../src/components/SevenSegment";
import { radius, theme } from "../../src/components/theme";
import type { ParamId } from "../../src/protocol/params";
import { connectPedal, getController, pedalStore } from "../../src/midi/pedal";

const PREAMP: ParamId[] = ["drive", "low", "mid", "high", "presence"];
const OUTPUT: ParamId[] = ["comp", "blend", "level"];
// The pedal's red-SHIFT "Red Zone" layer functions. On hardware these share the physical knobs with
// the primary controls (toggled by the footswitch); the app has no such constraint, so we just show
// them all — as their own red-accented section rather than a separate, stripped-down tab.
const RED_ZONE: ParamId[] = ["preamp", "filter", "freq", "q", "ambiance", "chorus", "ratio"];

const setValue = (id: ParamId, v: number) => getController()?.setValue(id, v);

export default function Editor() {
  const insets = useSafeAreaInsets();
  const connection = useStore(pedalStore, (s) => s.connection);
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);
  const slot = useStore(pedalStore, (s) => s.slot);
  const name = useStore(pedalStore, (s) => s.name);
  const dirty = useStore(pedalStore, (s) => s.dirty);
  const [error, setError] = useState<string | null>(null);
  const ready = connection === "ready";

  async function onConnect() {
    try {
      setError(null);
      await connectPedal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Step to the previous/next preset (wraps 1↔128) and recall it on the pedal.
  const go = (d: number) => getController()?.recall(((((slot ?? 0) + d) % 128) + 128) % 128);

  return (
    <KnobScroll
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <SevenSegment text={slot != null ? String(slot + 1).padStart(3, " ") : "---"} />
          <View>
            <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>
              {name ?? (slot != null ? `Preset ${slot + 1}` : "SansApp")}
              {dirty ? <Text style={{ color: theme.accent }}> •</Text> : null}
            </Text>
            <Text style={{ color: theme.textDim, fontSize: 12 }}>
              {slot != null ? `Preset ${slot + 1} · Bass Driver DI Elite` : "Bass Driver DI Elite"}
            </Text>
          </View>
        </View>
        <Link href="/connect" asChild>
          <Pressable>
            <ConnectionPill state={connection} />
          </Pressable>
        </Link>
      </View>

      {ready ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            onPress={() => go(-1)}
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: radius,
              borderWidth: 1,
              borderColor: theme.panelEdge,
              backgroundColor: theme.panel,
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.text, fontWeight: "700" }}>‹ Prev preset</Text>
          </Pressable>
          <Pressable
            onPress={() => go(1)}
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: radius,
              borderWidth: 1,
              borderColor: theme.panelEdge,
              backgroundColor: theme.panel,
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.text, fontWeight: "700" }}>Next preset ›</Text>
          </Pressable>
        </View>
      ) : null}

      {!ready ? (
        <Pressable
          onPress={onConnect}
          style={{
            backgroundColor: theme.green,
            padding: 14,
            borderRadius: radius,
            alignItems: "center",
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "700" }}>
            {connection === "connecting" ? "Connecting…" : "Connect to pedal"}
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={{ color: theme.accent }}>{error}</Text> : null}

      <SectionBar />

      <View style={{ gap: 16, opacity: ready ? 1 : 0.55 }}>
        <Section title="TONE">
          <EqCurve values={values} />
        </Section>
        <Section title="PREAMP · EQ">
          <KnobPanel ids={PREAMP} values={values} baseline={baseline} onChange={setValue} />
        </Section>
        <Section title="MIX · OUTPUT">
          <KnobPanel ids={OUTPUT} values={values} baseline={baseline} onChange={setValue} />
        </Section>
        <Section title="RED ZONE" accent>
          <KnobPanel ids={RED_ZONE} values={values} baseline={baseline} onChange={setValue} />
        </Section>
      </View>
    </KnobScroll>
  );
}
