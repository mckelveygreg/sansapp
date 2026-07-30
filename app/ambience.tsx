/**
 * Ambience — pick the reverb/echo TYPE and adjust its Level / Decay / Time, all in one place.
 *
 * Type selection LIVE-SETS the type's 10-param profile on the pedal (no edit-buffer write) and marks
 * it dirty so a save re-bakes it. Deep controls are live params read from pedalStore.values: Level =
 * the AMBIANCE knob (0x08), Decay = 0x11 (Reverb Decay Time), Time = 0x10 (Reverb Room Size, Echo /
 * Echo Verb only) — wire ids derived from observing EliteControl (issue #38). RN app surface.
 */
import { Pressable, Text, View } from "react-native";
import { KnobScroll } from "../src/components/KnobScroll";
import { useStore } from "zustand";
import { Knob } from "../src/components/Knob";
import { FootNote, IntroNote } from "../src/components/panels";
import { radius, theme } from "../src/components/theme";
import { AMBIENCE_ENGINES } from "../src/protocol/constants";
import { AMBIENCE_PARAMS } from "../src/protocol/params";
import { rawToPct, sendParam } from "../src/midi/liveParam";
import { pedalStore, setAmbienceType } from "../src/midi/pedal";
import { ambienceStore } from "../src/state/ambience";

const ms = (r: number) => Math.round((r / 127) * 533);
const isEcho = (t: number) => AMBIENCE_ENGINES[t]?.startsWith("Echo");

export default function Ambience() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  // Level/Decay/Time all read from pedalStore.values (synced from the loaded preset, updated by
  // physical-knob notifies) — NOT from a re-read of the pedal's edit buffer, which is stale and
  // caused the "flash to the last-set value" on preset change. Level = the AMBIANCE knob (0x08),
  // Decay = ambienceDecay (0x11), Time = ambienceTime (0x10). Only the highlighted TYPE is separate.
  const type = useStore(ambienceStore, (s) => s.type);
  const level = useStore(pedalStore, (s) => s.values.ambiance) ?? 64;
  const decay = useStore(pedalStore, (s) => s.values.ambienceDecay) ?? 64;
  const time = useStore(pedalStore, (s) => s.values.ambienceTime) ?? 64;
  const baseline = useStore(pedalStore, (s) => s.baseline);

  function selectType(i: number) {
    // Patches the store optimistically (instant highlight, even when disconnected), then paces the
    // type's 10 profile params onto the wire when connected. Fire-and-forget: don't block the tap.
    void setAmbienceType(i);
  }

  const onLevel = (v: number) => {
    sendParam(AMBIENCE_PARAMS.level, v);
    pedalStore.getState().setValueLocal("ambiance", v);
  };
  const onDecay = (v: number) => {
    sendParam(AMBIENCE_PARAMS.decay, v);
    pedalStore.getState().setValueLocal("ambienceDecay", v);
  };
  const onTime = (v: number) => {
    sendParam(AMBIENCE_PARAMS.time, v);
    pedalStore.getState().setValueLocal("ambienceTime", v);
  };

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <IntroNote ready={ready}>The reverb/echo effect.</IntroNote>

      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>TYPE</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {AMBIENCE_ENGINES.map((name, i) => {
            const active = i === type;
            return (
              <Pressable
                key={name}
                onPress={() => selectType(i)}
                style={{
                  paddingHorizontal: 13,
                  paddingVertical: 9,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: active ? theme.accent : theme.panelEdge,
                  backgroundColor: active ? theme.accent : theme.panel,
                }}
              >
                <Text style={{ color: active ? "#fff" : theme.textDim, fontSize: 13 }}>{name}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 16,
          gap: 16,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12 }}>
          <Knob
            label="Level"
            value={level}
            ghost={baseline.ambiance}
            display={`${rawToPct(level)}%`}
            onChange={onLevel}
          />
          <Knob
            label="Decay"
            value={decay}
            ghost={baseline.ambienceDecay}
            display={`${rawToPct(decay)}%`}
            onChange={onDecay}
          />
          {isEcho(type) ? (
            <Knob
              label="Time"
              value={time}
              ghost={baseline.ambienceTime}
              display={`${ms(time)}ms`}
              onChange={onTime}
            />
          ) : null}
        </View>
      </View>

      <FootNote>
        Level = the AMBIANCE knob. Time only applies to Echo / Echo Verb. Displayed %/ms are
        approximate pending unit calibration.
      </FootNote>
    </KnobScroll>
  );
}
