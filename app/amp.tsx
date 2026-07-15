/**
 * Amp — the AMPLIFIER (amp-model) selector. Selecting an amp applies its captured bundle LIVE
 * (read edit buffer → patch → 05 20 write). Everything cab/IR (select, blend, design, upload, gain)
 * lives on the dedicated IR page (/ir) — this tab is ONLY the amp voicing, so there's exactly one
 * place to adjust each thing (no Amp/IR crossover). RN app surface.
 */
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { radius, theme } from "../src/components/theme";
import { applyAmpBundle, detectAmpModel, hasAmpBundle } from "../src/protocol/amp";
import { AMP_MODELS } from "../src/protocol/constants";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { getSession, pedalStore } from "../src/midi/pedal";
import { PARAMS, type ParamId } from "../src/protocol/params";

const EDIT = 0x7f;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({
  label,
  active,
  dim,
  onPress,
}: {
  label: string;
  active: boolean;
  dim?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 13,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: 96,
        alignItems: "center",
        opacity: dim ? 0.5 : 1,
        borderColor: active ? theme.accent : theme.panelEdge,
        backgroundColor: active ? theme.accent : theme.panel,
      }}
    >
      <Text style={{ color: active ? "#fff" : theme.textDim, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function Amp() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const [amp, setAmp] = useState(0);
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);
  // Pre-Amp / Drive / Presence are live, preset-synced params — send + mirror into the store.
  const set = (id: ParamId, wire: number) => (v: number) => {
    sendParam(wire, v);
    pedalStore.getState().setValueLocal(id, v);
  };

  useEffect(() => {
    if (!ready) return;
    const session = getSession();
    if (!session) return;
    let live = true;
    void session
      .readEditBuffer()
      .then((buf) => {
        const name = detectAmpModel(buf.raw);
        const idx = name ? AMP_MODELS.indexOf(name) : -1;
        if (live && idx >= 0) setAmp(idx);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready]);

  async function selectAmp(i: number) {
    setAmp(i);
    const name = AMP_MODELS[i]!;
    const session = getSession();
    if (!session || !hasAmpBundle(name)) return;
    try {
      const buf = await session.readEditBuffer();
      await session.writePreset(EDIT, applyAmpBundle(buf.raw, name));
    } catch {
      // not connected / write failed — selection stays local
    }
  }

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 20 }}>
      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.amber,
          borderWidth: 1,
          borderRadius: radius,
          padding: 12,
        }}
      >
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
          {ready ? "Amp models apply live over MIDI. " : "Connect to control the pedal. "}
          Cabs & IRs — select, blend, design and upload — live on the{" "}
          <Link href="/ir" style={{ color: theme.accent }}>
            IR page
          </Link>
          .
        </Text>
      </View>

      <Section title="AMPLIFIER">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {AMP_MODELS.map((name, i) => (
            <Chip
              key={name}
              label={name}
              active={i === amp}
              dim={!hasAmpBundle(name)}
              onPress={() => void selectAmp(i)}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 6 }}>
          <Knob
            label="Pre-Amp"
            value={values.preamp ?? 64}
            ghost={baseline.preamp}
            display={`${rawToPct(values.preamp ?? 64)}%`}
            onChange={set("preamp", PARAMS.preamp.paramId ?? 0x01)}
          />
          <Knob
            label="Drive"
            value={values.drive ?? 64}
            ghost={baseline.drive}
            display={`${rawToPct(values.drive ?? 64)}%`}
            onChange={set("drive", PARAMS.drive.paramId ?? 0x05)}
          />
          <Knob
            label="Presence"
            value={values.presence ?? 64}
            ghost={baseline.presence}
            display={`${rawToPct(values.presence ?? 64)}%`}
            onChange={set("presence", PARAMS.presence.paramId ?? 0x04)}
          />
        </View>
      </Section>
    </KnobScroll>
  );
}
