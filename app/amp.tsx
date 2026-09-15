/**
 * Amp — the AMPLIFIER page. An "amp model" is a recipe: it writes 7 voicing bytes (Pre-Amp, Drive,
 * Presence + the hidden Buzz/Punch/Punch-Freq/Punch-Q) plus a few fixed extras. It does NOT write the
 * preset's output level — see ampApplySets. This page exposes all of them
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
  AMP_BUNDLES,
  ampApplyIsNoop,
  ampApplySets,
  bundleMatches,
  detectAmpModel,
  hasAmpBundle,
  readAmpBundle,
} from "../src/protocol/amp";
import { AMP_MODELS } from "../src/protocol/constants";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { getSession, pedalStore } from "../src/midi/pedal";
import { type AmpPreset, loadAmpPresets, saveAmpPresets } from "../src/midi/ampPresets";
import { PARAM_IDS, PARAMS, liveSetId, type ParamId } from "../src/protocol/params";

// Wire INDEX (paramId) → registry id, so an apply can record every param it live-sets in the store.
const PARAM_BY_INDEX = new Map<number, ParamId>();
for (const id of PARAM_IDS) {
  const raw = PARAMS[id].paramId;
  if (raw !== undefined) PARAM_BY_INDEX.set(raw, id);
}

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
  edited,
  dim,
  accent,
  disabled,
  onPress,
  onLongPress,
}: {
  label: string;
  active: boolean;
  /**
   * Active, but the voicing has been moved off this model — drawn outlined rather than filled, with
   * the reason spelled out. A filled chip promises "you are on this"; only an unedited match can.
   */
  edited?: boolean;
  dim?: boolean;
  accent?: boolean;
  /** No pedal: selecting a model can't apply, but a long-press (delete a saved amp) still can. */
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const filled = active && !edited;
  const border = active ? theme.accent : accent ? theme.amber : theme.panelEdge;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={edited ? `${label}, edited` : label}
      style={{
        paddingHorizontal: 13,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: 96,
        alignItems: "center",
        opacity: disabled || dim ? 0.5 : 1,
        borderColor: border,
        backgroundColor: filled ? theme.accent : theme.panel,
      }}
    >
      <Text
        style={{
          color: filled ? "#fff" : active ? theme.accent : theme.textDim,
          fontSize: 13,
          fontWeight: active ? "600" : "400",
        }}
      >
        {label}
      </Text>
      {edited ? (
        <Text style={{ color: theme.textDim, fontSize: 10, marginTop: 1 }}>edited</Text>
      ) : null}
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
  // `edited` is the honest half: the name says which model the voicing came FROM, and `edited` says
  // the knobs have since moved off it — so tapping that same chip is not the no-op the filled
  // highlight used to imply. Both halves come from ampApplySets, so they describe one apply.
  const active = useMemo<{ name: string; edited: boolean } | null>(() => {
    const blob = new Uint8Array(0x63);
    for (const { id } of AMP_KNOBS) blob[PARAMS[id].blobOffset] = (values[id] ?? 0) & 0x7f;
    const custom = customs.find((c) => bundleMatches(blob, c.bytes));
    const name = custom ? custom.name : detectAmpModel(blob);
    if (name == null) return null;
    const bytes = custom ? custom.bytes : (AMP_BUNDLES[name] ?? []);
    const valueAt = (index: number) => {
      const id = PARAM_BY_INDEX.get(index);
      return id ? values[id] : undefined;
    };
    return { name, edited: bytes.length > 0 && !ampApplyIsNoop(name, bytes, valueAt) };
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
    // Every param this apply sets, keyed by wire INDEX (== paramId). Defined once in the protocol
    // layer so the highlight above and this apply can never describe different things again — and so
    // Preset Level stays out of it: it's a per-preset output level, not part of the amp's identity.
    const sets = ampApplySets(name, vals);
    // Reflect into the store immediately (local, no wire) so the UI updates at once AND a later SAVE
    // records what the pedal is now playing (Buzz Q / Crunch Q / Mid included) instead of the loaded
    // preset's old bytes. Preset Level is left alone, so the preset keeps the level you set.
    for (const { index, value } of sets) {
      const id = PARAM_BY_INDEX.get(index);
      if (id) pedalStore.getState().setValueLocal(id, value);
    }
    // Live-set PACED (index→set-id via liveSetId, same wire ids sendParam produces) so BLE doesn't
    // silently drop the burst — the pedal drops fire-and-forget sends that land in one connection
    // interval (same reason setAmbienceType paces its profile sends). Surface a send failure honestly.
    try {
      await session.setParamsPaced(
        sets.map(({ index, value }) => ({ param: liveSetId(index), value })),
      );
      setStatus(`Applied "${name}".`);
    } catch (e) {
      setStatus(`Apply failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function saveCurrent() {
    // Snapshot the CURRENT voicing from the store — the pedal has no live edit buffer (0x7F is just
    // program 127), so a read there would grab the wrong preset's Preset-Level byte. Overlay the
    // store's live values onto the loaded preset's base blob (same base a save uses), then read the
    // amp bundle bytes off that.
    const st = pedalStore.getState();
    if (!st.raw) {
      setStatus("Load a preset first, then save its amp.");
      return;
    }
    const raw = st.raw.slice();
    for (const { id } of AMP_KNOBS) raw[PARAMS[id].blobOffset] = (st.values[id] ?? 0) & 0x7f;
    if (st.values.presetLevel !== undefined) {
      raw[PARAMS.presetLevel.blobOffset] = st.values.presetLevel & 0x7f;
    }
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
              active={active?.name === name}
              edited={active?.name === name && active.edited}
              dim={!hasAmpBundle(name)}
              disabled={!ready}
              onPress={() => void applyBundle(name, AMP_BUNDLES[name] ?? [])}
            />
          ))}
        </View>

        {active?.edited ? (
          <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
            This preset is voiced from {active.name}, but its knobs have been moved off it. Tapping{" "}
            {active.name} again resets the whole voicing to the factory recipe — it won&apos;t give
            you this sound back.
          </Text>
        ) : null}

        {customs.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {customs.map((c) => (
              <Chip
                key={c.name}
                label={c.name}
                active={active?.name === c.name}
                edited={active?.name === c.name && active.edited}
                accent
                disabled={!ready}
                onPress={() => void applyBundle(c.name, c.bytes)}
                onLongPress={() => deleteCustom(c.name)}
              />
            ))}
          </View>
        ) : null}

        <Pressable
          onPress={saveCurrent}
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
          The drive character&apos;s real frequency response: Buzz&apos;s 200 Hz shelf, Punch&apos;s
          swept bell, and Crunch (the Presence knob) at 2500 Hz, summed exactly as the pedal builds
          them. A centred Buzz is a slight cut — its unity point is up near ¾ — and Crunch only ever
          lifts. Pre-Amp and Drive set level and saturation, not tone, so they don&apos;t move the
          curve.
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
              disabled={!ready}
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
