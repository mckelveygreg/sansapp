/**
 * Amp — the AMPLIFIER page. An "amp model" is a recipe: it writes 8 voicing bytes (Pre-Amp, Drive,
 * Presence + the hidden Buzz/Punch/Punch-Freq/Punch-Q + a level-match). This page exposes all of them
 * as live knobs so the factory models are re-voiceable starting points — and lets you SAVE the
 * current voicing as your own custom amp (persisted, shown beside the factory models). Cabs/IRs live
 * on the dedicated IR page. RN app surface.
 */
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import { AmpVoicePrint } from "../src/components/AmpVoicePrint";
import { GainStaging } from "../src/components/GainStaging";
import { Knob } from "../src/components/Knob";
import { KnobScroll } from "../src/components/KnobScroll";
import { radius, theme } from "../src/components/theme";
import {
  AMP_BUNDLE_OFFSETS,
  AMP_BUNDLES,
  bundleMatches,
  detectAmpModel,
  hasAmpBundle,
  readAmpBundle,
} from "../src/protocol/amp";
import { AMP_MODELS } from "../src/protocol/constants";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { getSession, pedalStore } from "../src/midi/pedal";
import { type AmpPreset, loadAmpPresets, saveAmpPresets } from "../src/midi/ampPresets";
import { PARAMS, liveSetId, type ParamId } from "../src/protocol/params";

// The store-backed knobs an amp bundle drives (Preset Level 0x40 is level-match, not a knob here).
const AMP_KNOBS: { id: ParamId; label: string }[] = [
  { id: "preamp", label: "Pre-Amp" },
  { id: "drive", label: "Drive" },
  { id: "presence", label: "Presence" },
  { id: "buzz", label: "Buzz" },
  { id: "punch", label: "Punch" },
  { id: "punchFreq", label: "Punch Freq" },
  { id: "punchQ", label: "Punch Q" },
];

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
  accent,
  onPress,
  onLongPress,
}: {
  label: string;
  active: boolean;
  dim?: boolean;
  accent?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const border = active ? theme.accent : accent ? theme.amber : theme.panelEdge;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={{
        paddingHorizontal: 13,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: 96,
        alignItems: "center",
        opacity: dim ? 0.5 : 1,
        borderColor: border,
        backgroundColor: active ? theme.accent : theme.panel,
      }}
    >
      <Text style={{ color: active ? "#fff" : theme.textDim, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export default function Amp() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const values = useStore(pedalStore, (s) => s.values);
  const baseline = useStore(pedalStore, (s) => s.baseline);
  const [customs, setCustoms] = useState<AmpPreset[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  // Which model/custom the live voicing matches — derived from the store, so it's correct on the
  // first render after a preset loads AND updates the moment a knob moves. A saved custom (exact
  // voicing) wins over the looser factory character-match it may be built on.
  const active = useMemo<string | null>(() => {
    const blob = new Uint8Array(0x63);
    for (const { id } of AMP_KNOBS) blob[PARAMS[id].blobOffset] = (values[id] ?? 0) & 0x7f;
    const custom = customs.find((c) => bundleMatches(blob, c.bytes));
    return custom ? custom.name : detectAmpModel(blob);
  }, [values, customs]);

  const set = (id: ParamId, wire: number) => (v: number) => {
    sendParam(wire, v);
    pedalStore.getState().setValueLocal(id, v);
  };

  useEffect(() => {
    void loadAmpPresets().then(setCustoms);
  }, []);

  // Apply an amp model/custom by LIVE-SETTING its bundle params (05 50 each, index→set-id via
  // liveSetId) — the write path that actually sticks. An edit-buffer write is discarded by the pedal
  // (same bug the ambience type had). Then reflect the values into the knobs/store.
  async function applyBundle(name: string, vals: readonly number[]) {
    const session = getSession();
    if (!session) {
      setStatus("Connect to apply an amp.");
      return;
    }
    if (!vals.length) {
      setStatus(`No captured bundle for "${name}".`);
      return;
    }
    // Reflect the bundle into the knobs/store immediately (local, no wire), so the UI updates at once.
    const byOffset = new Map<number, number>(
      AMP_BUNDLE_OFFSETS.map((off, i) => [off, vals[i] ?? 0]),
    );
    for (const { id } of AMP_KNOBS) {
      const v = byOffset.get(PARAMS[id].blobOffset);
      if (v !== undefined) pedalStore.getState().setValueLocal(id, v);
    }
    // Live-set the bundle PACED (index→set-id via liveSetId, same wire ids sendParam produces) so BLE
    // doesn't silently drop the ~8-param burst — the pedal drops fire-and-forget sends that land in
    // one connection interval (same reason setAmbienceType paces its profile sends).
    await session.setParamsPaced(
      AMP_BUNDLE_OFFSETS.map((off, i) => ({
        param: liveSetId(off - 0x22),
        value: (vals[i] ?? 0) & 0x7f,
      })),
    );
    setStatus(`Applied "${name}".`);
  }

  async function saveCurrent() {
    const session = getSession();
    if (!session) {
      setStatus("Connect to save the current amp.");
      return;
    }
    try {
      const buf = await session.readEditBuffer();
      // The edit-buffer read doesn't reflect live knob tweaks, so overlay the store's live values
      // before snapshotting the bundle — otherwise we'd save the preset's original amp, not yours.
      const raw = buf.raw.slice();
      for (const { id } of AMP_KNOBS) raw[PARAMS[id].blobOffset] = (values[id] ?? 0) & 0x7f;
      const bytes = readAmpBundle(raw);
      const doSave = (name: string) => {
        const next = [...customs.filter((c) => c.name !== name), { name, bytes }];
        setCustoms(next); // `active` re-derives from the store and lights up the new custom
        void saveAmpPresets(next);
        setStatus(`Saved "${name}".`);
      };
      const fallback = `My Amp ${customs.length + 1}`;
      if (Platform.OS === "ios") {
        Alert.prompt(
          "Save custom amp",
          "Name this amp voicing:",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Save",
              onPress: (name?: string) => {
                const n = name?.trim();
                if (n) doSave(n);
              },
            },
          ],
          "plain-text",
          fallback,
        );
      } else {
        doSave(fallback);
      }
    } catch {
      setStatus("Couldn't read the current amp.");
    }
  }

  function deleteCustom(name: string) {
    Alert.alert(`Delete "${name}"?`, "Remove this saved amp voicing.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const next = customs.filter((c) => c.name !== name);
          setCustoms(next); // `active` re-derives; a deleted custom simply stops matching
          void saveAmpPresets(next);
        },
      },
    ]);
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
          Each model is a recipe for the knobs below — tweak them, then Save your own. Cabs & IRs
          are on the{" "}
          <Link href="/ir" style={{ color: theme.accent }}>
            IR page
          </Link>
          .
        </Text>
      </View>

      <Section title="AMPLIFIER">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {AMP_MODELS.map((name) => (
            <Chip
              key={name}
              label={name}
              active={active === name}
              dim={!hasAmpBundle(name)}
              onPress={() => void applyBundle(name, AMP_BUNDLES[name] ?? [])}
            />
          ))}
        </View>

        {customs.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {customs.map((c) => (
              <Chip
                key={c.name}
                label={c.name}
                active={active === c.name}
                accent
                onPress={() => void applyBundle(c.name, c.bytes)}
                onLongPress={() => deleteCustom(c.name)}
              />
            ))}
          </View>
        ) : null}

        <Pressable
          onPress={() => void saveCurrent()}
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 13,
            paddingVertical: 9,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.panelEdge,
            borderStyle: "dashed",
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 13, fontWeight: "600" }}>
            ＋ Save current amp…
          </Text>
        </Pressable>
        {customs.length > 0 ? (
          <Text style={{ color: theme.textDim, fontSize: 11 }}>
            Long-press a saved amp to delete it.
          </Text>
        ) : null}
      </Section>

      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 16,
          gap: 18,
        }}
      >
        <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5, fontSize: 13 }}>
          VOICE PRINT
        </Text>
        <AmpVoicePrint values={values} />
        <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
          An artistic read of the drive character — not measured Hz. Pre-Amp = height, Drive squares
          the peaks, Buzz = fizz, Presence = colour; Punch = line weight, Punch Freq = oscillation
          spacing, Punch Q = fill.
        </Text>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "space-around",
            rowGap: 18,
          }}
        >
          {AMP_KNOBS.map(({ id, label }) => (
            <Knob
              key={id}
              label={label}
              value={values[id] ?? 64}
              ghost={baseline[id]}
              display={`${rawToPct(values[id] ?? 64)}%`}
              onChange={set(id, PARAMS[id].paramId ?? 0)}
            />
          ))}
        </View>
        <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
          Pre-Amp / Drive / Presence are the front-panel controls; Buzz / Punch / Punch Freq / Punch
          Q are the hidden voicing an amp model sets (ranges uncalibrated, shown as raw %).
        </Text>
      </View>

      <GainStaging values={values} />

      {status ? (
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>{status}</Text>
      ) : null}
    </KnobScroll>
  );
}
