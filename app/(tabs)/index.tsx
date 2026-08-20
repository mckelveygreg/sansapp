/**
 * Editor screen — the hybrid knob panel bound to the tested store/session core.
 * RN app surface (tsconfig.json), not the Node core.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KnobScroll } from "../../src/components/KnobScroll";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { ToneShaper } from "../../src/components/ToneShaper";
import { KnobPanel } from "../../src/components/KnobPanel";
import { ReadFromPedalOffer } from "../../src/components/ReadFromPedal";
import { Section } from "../../src/components/Section";
import { SectionBar } from "../../src/components/SectionBar";
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
  // The pedal ignores parameter writes while an exclusive operation owns the link (an IR transfer, a
  // Read from Pedal), so the knobs go dead rather than lying about what they're doing.
  const linkBusy = useStore(pedalStore, (s) => s.linkBusy);
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);
  // The loaded preset's blob: the Tone Shaper's cab overlay reads THIS preset's IR-record pointers
  // out of it, rather than showing whatever cab was last pulled (sansapp#68).
  const raw = useStore(pedalStore, (s) => s.raw);
  const [error, setError] = useState<string | null>(null);
  const ready = connection === "ready";
  const editable = ready && !linkBusy;

  // Clear a stale connect error the moment we're actually connected — no matter how the connection
  // was (re)established (this screen, the Connect modal, or a reconnect). Fixes the banner lingering
  // after a successful reconnect.
  useEffect(() => {
    if (ready) setError(null);
  }, [ready]);

  async function onConnect() {
    try {
      setError(null);
      await connectPedal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <KnobScroll
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}
    >
      {/* Preset stepping lives in the persistent header transport now (works from every screen). */}
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

      <ReadFromPedalOffer />

      <SectionBar />

      <View style={{ gap: 16 }}>
        <Section title="TONE SHAPER">
          <ToneShaper values={values} raw={raw} />
        </Section>
        <Section title="PREAMP · EQ">
          <KnobPanel
            ids={PREAMP}
            values={values}
            baseline={baseline}
            onChange={setValue}
            disabled={!editable}
          />
        </Section>
        <Section title="MIX · OUTPUT">
          <KnobPanel
            ids={OUTPUT}
            values={values}
            baseline={baseline}
            onChange={setValue}
            disabled={!editable}
          />
        </Section>
        <Section title="RED ZONE" accent>
          <KnobPanel
            ids={RED_ZONE}
            values={values}
            baseline={baseline}
            onChange={setValue}
            disabled={!editable}
          />
        </Section>
      </View>
    </KnobScroll>
  );
}
