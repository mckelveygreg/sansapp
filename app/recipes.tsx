/**
 * Recipes — a tone cookbook: curated dial-in starting points for specific songs/sounds, mapped to
 * this pedal's own controls. Meant to be read on the phone at the studio — get close with these,
 * then tune by ear. Each recipe has an "Apply to pedal" button that live-sets the settings onto the
 * pedal's current sound (it does NOT overwrite any saved slot until you Save). A few settings with
 * no MIDI-addressable control are listed as "set by hand". RN app surface.
 */
import { Redirect } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useStore } from "zustand";
import { radius, theme } from "../src/components/theme";
import { FEATURES } from "../src/config/features";
import { getSession, pedalStore, setAmbienceType } from "../src/midi/pedal";
import { AMBIENCE_ENGINES } from "../src/protocol/constants";
import {
  AMBIENCE_PARAMS,
  AUTO_FILTER_PARAMS,
  CHORUS_PARAMS,
  PARAMS,
  PARAM_IDS,
  liveSetId,
  type ParamId,
} from "../src/protocol/params";

/** A machine-applyable value: the raw wire param id (0x05 etc.) and the 0–127 byte to send. */
interface Apply {
  param: number;
  raw: number;
}
interface Setting {
  control: string;
  value: string;
  /** Present when this control can be pushed to the pedal live; absent → "set by hand". */
  apply?: Apply;
  /** Ambience engine to select (index into AMBIENCE_ENGINES) — applied via setAmbienceType (live-set). */
  applyEngine?: number;
}
interface Section {
  title: string;
  detail?: string;
  settings?: Setting[];
}
interface Recipe {
  id: string;
  name: string;
  artist: string;
  summary: string;
  sections: Section[];
}

// Raw wire param ids (the `05 50 0A <param> <val>` byte) used by these recipes. DERIVED from the
// single source of truth in params.ts — do NOT hardcode; a hardcoded copy would drift from the
// registry. See docs/PARAM-MAP.md.
const wire = (id: ParamId) => PARAMS[id].paramId!;
const P = {
  presence: wire("presence"), // 0x04
  drive: wire("drive"), // 0x05
  low: wire("low"), // 0x06
  high: wire("high"), // 0x07
  mid: wire("mid"), // 0x0c
  blend: wire("blend"), // 0x47
  ambienceLevel: AMBIENCE_PARAMS.level, // 0x08
  ambienceTime: AMBIENCE_PARAMS.time, // 0x10 (Reverb Room Size)
  ambienceDecay: AMBIENCE_PARAMS.decay, // 0x11 (Reverb Decay Time)
  filterLevel: AUTO_FILTER_PARAMS.level, // 0x3d
  filterAttack: AUTO_FILTER_PARAMS.attack, // 0x3e
  filterRelease: AUTO_FILTER_PARAMS.release, // 0x3f
  chorusLevel: CHORUS_PARAMS.level, // 0x42
  chorusModFreq: CHORUS_PARAMS.modFreq, // 0x43
  chorusModDepth: CHORUS_PARAMS.modDepth, // 0x44
  chorusFeedback: CHORUS_PARAMS.feedback, // 0x46
} as const;

const RECIPES: Recipe[] = [
  {
    id: "them-changes",
    name: "Them Changes",
    artist: "Thundercat",
    summary:
      "The record is a round, dark, layered clean+driven tone — the filter isn't the star. Use Drive + Blend for the body, and the Auto Filter for the funky auto-wah quack (the live / Bootsy side that your MXR envelope filter covered).",
    sections: [
      {
        title: "Body (the record)",
        detail:
          "Round and dark, with grit from the preamp and clean low end blended underneath. Flats or tapewound strings get you most of the way.",
        settings: [
          { control: "Drive", value: "6.5", apply: { param: P.drive, raw: 83 } },
          { control: "Blend", value: "~65% (favor driven)", apply: { param: P.blend, raw: 83 } },
          { control: "Low", value: "6.5", apply: { param: P.low, raw: 83 } },
          { control: "Mid", value: "5.0", apply: { param: P.mid, raw: 64 } },
          { control: "High", value: "4.0", apply: { param: P.high, raw: 51 } },
          { control: "Presence", value: "3.0 (dark)", apply: { param: P.presence, raw: 38 } },
        ],
      },
      {
        title: "The quack (Auto Filter)",
        detail: "The funky envelope auto-wah — what your MXR Bass Envelope Filter was doing.",
        settings: [
          {
            control: "Auto Filter · Level",
            value: "+50% (up-sweep side)",
            apply: { param: P.filterLevel, raw: 95 },
          },
          {
            control: "Auto Filter · Attack",
            value: "~15% (fast, snappy)",
            apply: { param: P.filterAttack, raw: 19 },
          },
          {
            control: "Auto Filter · Release",
            value: "~40% (staccato reset)",
            apply: { param: P.filterRelease, raw: 51 },
          },
        ],
      },
      {
        title: "Technique",
        detail:
          "There's no sensitivity knob — your right hand is the sensitivity. Play firm, even, muted/staccato plucks so each note re-triggers the sweep; dig in for a bigger quack, ease off to tuck it back.",
      },
    ],
  },
  {
    id: "red-room",
    name: "Red Room",
    artist: "Hiatus Kaiyote",
    summary:
      "Warm, dreamy, mostly-clean jazz bass. The 'lush' is really the vintage voicing + layered basses (and tape echo) — not chorus. Nail the warm core first, then add space with Echo Verb (the closest thing to Bender's Space Echo); a whisper of chorus is optional extra width.",
    sections: [
      {
        title: "Core voicing (do this first)",
        detail:
          "Round, warm, mid-present, clean — this is where the vibe lives. Effects are seasoning.",
        settings: [
          { control: "Drive", value: "2.5 (clean)", apply: { param: P.drive, raw: 32 } },
          { control: "Blend", value: "~90%", apply: { param: P.blend, raw: 114 } },
          { control: "Low", value: "6.5 (round)", apply: { param: P.low, raw: 83 } },
          { control: "Mid", value: "5.5 (present)", apply: { param: P.mid, raw: 70 } },
          { control: "High", value: "4.5", apply: { param: P.high, raw: 57 } },
          {
            control: "Presence",
            value: "2.5 (smooth, no clank)",
            apply: { param: P.presence, raw: 32 },
          },
        ],
      },
      {
        title: "Ambient space — Echo Verb (the faithful route)",
        detail:
          "Bender's signature space is a Roland Space Echo (tape echo). The Elite's Echo Verb type — tape-style repeats plus a reverb tail — is the closest match, and since Ambience is one effect at a time, this beats plain reverb here. (Simpler alternative: Room reverb, ~20% Level / ~30% Decay.)",
        settings: [
          {
            control: "Ambience · Type",
            value: "Echo Verb",
            applyEngine: AMBIENCE_ENGINES.indexOf("Echo Verb"),
          },
          {
            control: "Ambience · Time",
            value: "~40% (≈200 ms)",
            apply: { param: P.ambienceTime, raw: 51 },
          },
          {
            control: "Ambience · Level",
            value: "~22%",
            apply: { param: P.ambienceLevel, raw: 28 },
          },
          {
            control: "Ambience · Decay",
            value: "~35% (a few soft repeats)",
            apply: { param: P.ambienceDecay, raw: 44 },
          },
        ],
      },
      {
        title: "Optional: subtle chorus",
        detail:
          "Extra width if you want it — but the echo is the authentic move. Keep it barely-there; you'd miss it if it were off. (To skip it, pull Chorus Level to 0 after applying.)",
        settings: [
          { control: "Chorus · Level", value: "~20%", apply: { param: P.chorusLevel, raw: 25 } },
          {
            control: "Chorus · Mod Freq",
            value: "~0.75 Hz (slow)",
            apply: { param: P.chorusModFreq, raw: 16 },
          },
          {
            control: "Chorus · Mod Depth",
            value: "~15% (shallow)",
            apply: { param: P.chorusModDepth, raw: 19 },
          },
          {
            control: "Chorus · Feedback",
            value: "0% (center)",
            apply: { param: P.chorusFeedback, raw: 64 },
          },
        ],
      },
      {
        title: "Notes",
        detail:
          "The echo (Space Echo) is the documented Bender ingredient; the layered-bass width + warm voicing do the rest, with chorus just an optional stand-in. Ambience is one effect at a time — pick Echo Verb OR Room, not both. Keep everything light so the low end stays anchored (don't push Chorus past ~35% or the echo Level/Decay too high).",
      },
    ],
  },
];

// Reverse map raw wire id → ParamId, so applying a recipe also updates the on-screen editor knobs
// (and marks the buffer dirty) for controls that have a store-backed ParamId.
const PARAM_BY_WIRE: Partial<Record<number, ParamId>> = {};
for (const id of PARAM_IDS) {
  const pid = PARAMS[id].paramId;
  if (pid !== undefined) PARAM_BY_WIRE[pid] = id;
}

const card = {
  backgroundColor: theme.panel,
  borderColor: theme.panelEdge,
  borderWidth: 1,
  borderRadius: radius,
  padding: 16,
} as const;

export default function Recipes() {
  // Personal, in-progress feature — off in the public app. Reachable only when the flag is set;
  // otherwise redirect out so even a direct deep link (sansapp://recipes) lands on the editor.
  if (!FEATURES.recipes) return <Redirect href="/" />;
  return <RecipesScreen />;
}

function RecipesScreen() {
  const connection = useStore(pedalStore, (s) => s.connection);
  const ready = connection === "ready";
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);

  function apply(recipe: Recipe) {
    const all = recipe.sections.flatMap((s) => s.settings ?? []);
    const applyable = all.filter((s) => s.apply);
    const engines = all.filter((s) => s.applyEngine !== undefined);
    const manual = all
      .filter((s) => !s.apply && s.applyEngine === undefined)
      .map((s) => `${s.control} = ${s.value}`);
    Alert.alert(
      `Apply “${recipe.name}”?`,
      "This sets the pedal's live sound (the edit buffer). It won't overwrite any saved preset until you Save.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Apply",
          onPress: () => {
            void (async () => {
              const session = getSession();
              if (!session) {
                setResult({ id: recipe.id, text: "Not connected — connect to the pedal first." });
                return;
              }
              // A recipe applies onto the CURRENT sound. There is no live edit buffer to pre-flight —
              // 0x7F is just program 127 (confirmed), so the old readEditBuffer() pulled the
              // wrong preset and added a flaky heavy BLE read. Require a loaded preset from the store
              // instead (the same snapshot save/amp use).
              if (!pedalStore.getState().raw) {
                setResult({
                  id: recipe.id,
                  text: "No preset loaded yet — recall a preset on the pedal first, then apply.",
                });
                return;
              }
              // Apply engine changes BEFORE the params: selecting a type live-sets the engine's full
              // 10-param profile, which overlaps some recipe params (ambience Level/Time/Decay). Run
              // the engine first so the recipe's own values land last and win. Await each so its paced
              // profile sends finish before the params (no fire-and-forget race).
              let engineFailed = false;
              for (const s of engines) {
                try {
                  await setAmbienceType(s.applyEngine!);
                } catch {
                  engineFailed = true;
                }
              }
              // Live-set the params PACED so BLE doesn't drop the burst (the pedal drops fire-and-
              // forget sends that land in one connection interval). sendParam mapped through liveSetId
              // (deep params set on index+4); do the same here so the on-wire ids are identical.
              await session.setParamsPaced(
                applyable.map((s) => ({
                  param: liveSetId(s.apply!.param),
                  value: s.apply!.raw & 0x7f,
                })),
              );
              // Reflect into the editor knobs (not on the wire). Every applied param — ambience
              // Decay/Time (0x11/0x10) included — has a store-backed ParamId now, so one
              // setValueLocal per control keeps the editor + save state in sync.
              for (const s of applyable) {
                if (!s.apply) continue;
                const id = PARAM_BY_WIRE[s.apply.param];
                if (id) pedalStore.getState().setValueLocal(id, s.apply.raw);
              }
              const n = applyable.length + (engineFailed ? 0 : engines.length);
              const warn = engineFailed
                ? " (couldn't set the ambience engine — set its Type by hand)"
                : "";
              setResult({
                id: recipe.id,
                text: manual.length
                  ? `Applied ${n} settings${warn}. Set by hand: ${manual.join("; ")}.`
                  : `Applied ${n} settings to the edit buffer${warn}. Tweak by ear, then Save it to a slot.`,
              });
            })();
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
        Starting points for dialing in specific tones on this pedal. Tap “Apply to pedal” to load
        one into the live edit buffer, then tune by ear — the numbers point at the app&apos;s knobs.
      </Text>

      {RECIPES.map((r) => (
        <View key={r.id} style={card}>
          <Text style={{ color: theme.text, fontSize: 19, fontWeight: "800" }}>{r.name}</Text>
          <Text style={{ color: theme.accent, fontSize: 13, fontWeight: "600", marginTop: 2 }}>
            {r.artist}
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            {r.summary}
          </Text>

          <Pressable
            onPress={() => apply(r)}
            disabled={!ready}
            style={{
              marginTop: 14,
              backgroundColor: ready ? theme.accent : theme.bg,
              borderColor: ready ? theme.accent : theme.panelEdge,
              borderWidth: 1,
              borderRadius: radius,
              paddingVertical: 11,
              alignItems: "center",
              opacity: ready ? 1 : 0.6,
            }}
          >
            <Text
              style={{ color: ready ? "#fff" : theme.textDim, fontWeight: "800", fontSize: 14 }}
            >
              {ready ? "Apply to pedal" : "Connect to apply"}
            </Text>
          </Pressable>

          {result?.id === r.id ? (
            <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 8 }}>
              {result.text}
            </Text>
          ) : null}

          {r.sections.map((s) => (
            <View key={s.title} style={{ marginTop: 16, gap: 6 }}>
              <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
                {s.title}
              </Text>
              {s.detail ? (
                <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
                  {s.detail}
                </Text>
              ) : null}
              {s.settings?.map((st) => (
                <View
                  key={st.control}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingVertical: 3,
                    borderBottomColor: theme.panelEdge,
                    borderBottomWidth: 1,
                  }}
                >
                  <Text style={{ color: theme.textDim, fontSize: 13 }}>
                    {st.control}
                    {st.apply || st.applyEngine !== undefined ? "" : "  ·  by hand"}
                  </Text>
                  <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
                    {st.value}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
