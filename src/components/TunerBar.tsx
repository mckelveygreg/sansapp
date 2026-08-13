/**
 * TunerBar — the slim MUTE / BYPASS strip that sits under the header on every tab.
 *
 * Both buttons drive one pedal param (the Tuner, 0 Off / 1 Mute / 2 Bypass) but they get a button
 * each, not a three-way segmented control: the two uses are rapid and repeated — BYPASS for A/B'ing
 * your gain staging against the dry signal, MUTE for swapping instruments — and a shared
 * `OFF | MUTE | BYPASS` control makes you move between two targets to go there-and-back. Tapping the
 * lit one returns to Off; tapping the other switches straight across (they're mutually exclusive on
 * the pedal, so BYPASS while muted is one write, not a second toggle).
 *
 * It lives under the header rather than in it because the header is already full (transport + preset
 * name + connection pill) and because both uses cut across tabs — you want bypass while editing AND
 * while flipping through presets.
 *
 * The state shown is **what the app last asked for**. The pedal never reports its tuner, so there's no
 * readback to reconcile against; that's acceptable here because the feedback channel is your ears —
 * nobody stares at a button to find out whether the signal stopped. The mirror self-heals on any
 * preset change (see store.ts resetTunerMirror). RN app surface.
 */
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import { pedalStore, setTunerMode } from "../midi/pedal";
import type { TunerMode } from "../protocol/params";
import { theme } from "./theme";

const MODES: { mode: Exclude<TunerMode, 0>; label: string }[] = [
  { mode: 1, label: "MUTE" },
  { mode: 2, label: "BYPASS" },
];

export function TunerBar() {
  const tuner = useStore(pedalStore, (s) => s.tuner);
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const slot = useStore(pedalStore, (s) => s.slot);
  const linkBusy = useStore(pedalStore, (s) => s.linkBusy);
  const [pending, setPending] = useState(false);

  // The nudge is a read of the active slot, so an unknown slot has nothing to nudge with. linkBusy =
  // an IR transfer owns the link, and the pedal SILENTLY skips a tuner change during one — better a
  // visibly dead button than one that lies. `pending` covers the ~254 ms the pedal takes to drain the
  // nudge dump: without it a double-tap queues two round-trips behind each other.
  const enabled = ready && slot != null && !linkBusy && !pending;

  const press = (mode: Exclude<TunerMode, 0>) => {
    const next: TunerMode = tuner === mode ? 0 : mode;
    if (Platform.OS !== "web") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    setPending(true);
    void setTunerMode(next)
      .catch((e: unknown) => {
        // The mirror keeps the requested mode (see pedal.ts) — log why it may not have taken.
        const msg = e instanceof Error ? e.message : String(e);
        pedalStore.getState().pushLog(`⚠ tuner change may not have taken: ${msg}`);
      })
      .finally(() => setPending(false));
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: theme.panel,
        borderBottomWidth: 1,
        borderBottomColor: theme.panelEdge,
      }}
    >
      {MODES.map(({ mode, label }) => {
        const on = tuner === mode;
        return (
          <Pressable
            key={label}
            onPress={() => press(mode)}
            disabled={!enabled}
            hitSlop={6}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 5,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: on ? theme.accent : theme.panelEdge,
              backgroundColor: on ? theme.accent : theme.knob,
              opacity: enabled || on ? 1 : 0.4,
            }}
          >
            <Text
              style={{
                color: on ? theme.bg : theme.textDim,
                fontSize: 11,
                fontWeight: "800",
                letterSpacing: 1.2,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
      <Text
        numberOfLines={1}
        style={{ color: theme.textDim, fontSize: 11, flex: 1, textAlign: "right" }}
      >
        {tunerCaption(tuner, { ready, linkBusy })}
      </Text>
    </View>
  );
}

/**
 * The caption to the right of the buttons. When a mode is engaged it points at the pedal: both modes
 * put the tuner on the pedal's own 7-segment display (mode 2 is a bypass AND a tuner at once), and the
 * pitch is never transmitted, so the reading is only ever over there.
 */
function tunerCaption(tuner: TunerMode, link: { ready: boolean; linkBusy: boolean }): string {
  if (link.linkBusy) return "IR transfer — tuner locked";
  if (!link.ready) return "";
  if (tuner === 1) return "muted · tuner on the pedal";
  if (tuner === 2) return "bypassed · tuner on the pedal";
  return "";
}
