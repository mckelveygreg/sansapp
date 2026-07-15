/**
 * Knob — a dark, pedal-style rotary control: a tick ring that fills toward the value,
 * a dial with a needle, a centered readout, a value bubble + press-scale while dragging,
 * and haptic detents on device. Plain RN Views + PanResponder + the pure knobMath.
 *
 * Optional `display` overrides the numeric readout (for calibrated units like "−30 dB"). Optional
 * `onPress` makes a tap (as opposed to a drag) open a deep-edit page — signalled by a small chevron
 * badge so the knob visibly advertises "there's more here". Part of the RN app surface.
 */
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { PanResponder, Platform, Text, View } from "react-native";
import { uiStore } from "../state/ui";
import { KNOB_SWEEP_DEG, dragToValue, toDisplay, valueToAngle } from "../ui/knobMath";
import { theme } from "./theme";

export interface KnobProps {
  label: string;
  value: number; // 0..127
  onChange: (value: number) => void;
  size?: number;
  /** Override the readout with a preformatted string (e.g. calibrated units). */
  display?: string;
  /** If set, a tap (not a drag) calls this — used to open a deep-edit page. Shows a chevron badge. */
  onPress?: () => void;
  /** The preset's baseline value; when it differs from `value`, shows a ghost tick + amber label. */
  ghost?: number;
}

const TICKS = 11;
const TAP_SLOP = 5; // px of movement below which a gesture counts as a tap, not a drag

/** Fire a haptic on device only (no-op / swallowed on web). */
const haptic = (fn: () => Promise<unknown>) => {
  if (Platform.OS !== "web") void fn().catch(() => {});
};

export function Knob({ label, value, onChange, size = 84, display, onPress, ghost }: KnobProps) {
  const startValue = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const moved = useRef(false);
  const longFired = useRef(false);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);

  const responder = useRef(
    PanResponder.create({
      // Claim the touch at the capture phase so a parent ScrollView never gets it first, and never
      // hand it back once grabbed. Belt-and-suspenders with KnobScroll (which also hard-disables
      // scrolling via uiStore.adjusting while dragging) so a knob drag adjusts, never scrolls.
      onStartShouldSetPanResponderCapture: () => true,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        startValue.current = valueRef.current;
        moved.current = false;
        longFired.current = false;
        setActive(true);
        uiStore.getState().setAdjusting(true); // lock the surrounding KnobScroll
        haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
        // Long-press (hold, no drag) on a knob that's moved off its preset → snap back to the preset.
        longTimer.current = setTimeout(() => {
          const g = ghostRef.current;
          if (!moved.current && g != null && g !== valueRef.current) {
            longFired.current = true;
            onChange(g); // revert this knob (also sends live to the pedal)
            haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
          }
        }, 500);
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dy) <= TAP_SLOP && Math.abs(g.dx) <= TAP_SLOP) return; // ignore jitter / taps
        moved.current = true;
        if (longTimer.current) {
          clearTimeout(longTimer.current);
          longTimer.current = null;
        }
        const next = dragToValue(startValue.current, g.dy);
        if (Math.round(toDisplay(next)) !== Math.round(toDisplay(valueRef.current))) {
          haptic(() => Haptics.selectionAsync());
        }
        onChange(next);
      },
      onPanResponderRelease: () => {
        setActive(false);
        uiStore.getState().setAdjusting(false);
        if (longTimer.current) {
          clearTimeout(longTimer.current);
          longTimer.current = null;
        }
        if (longFired.current) {
          longFired.current = false;
          return; // the long-press already reverted; don't also treat it as a tap
        }
        if (!moved.current && onPress) onPress(); // tap → open deep page
      },
      onPanResponderTerminate: () => {
        setActive(false);
        uiStore.getState().setAdjusting(false);
        if (longTimer.current) {
          clearTimeout(longTimer.current);
          longTimer.current = null;
        }
      },
    }),
  ).current;

  const angle = valueToAngle(value);
  const dial = size * 0.66;
  const readout = display ?? toDisplay(value).toFixed(1);
  // Ghost = the preset's value for this knob. When the live value has moved off it, mark the knob
  // "changed" (amber label) and show a faint tick where the preset was — the delta at a glance.
  const changed = ghost != null && value !== ghost;
  const ghostAngle = ghost != null ? valueToAngle(ghost) : null;

  return (
    <View style={{ alignItems: "center", width: size + 14 }}>
      {active ? (
        <View
          style={{
            position: "absolute",
            top: -30,
            zIndex: 10,
            backgroundColor: theme.accent,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>{readout}</Text>
        </View>
      ) : null}

      <View
        {...responder.panHandlers}
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ scale: active ? 1.08 : 1 }],
        }}
      >
        {onPress ? (
          <View
            style={{
              position: "absolute",
              top: 0,
              right: 6,
              zIndex: 5,
              backgroundColor: theme.panel,
              borderColor: theme.accent,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 4,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: theme.accent, fontSize: 9, fontWeight: "800" }}>›</Text>
          </View>
        ) : null}

        {Array.from({ length: TICKS }, (_, i) => {
          const tickAngle = -KNOB_SWEEP_DEG / 2 + (i / (TICKS - 1)) * KNOB_SWEEP_DEG;
          const lit = angle >= tickAngle - 0.01;
          return (
            <View
              key={i}
              style={{
                position: "absolute",
                width: size,
                height: size,
                alignItems: "center",
                transform: [{ rotate: `${tickAngle}deg` }],
              }}
            >
              <View
                style={{
                  width: 2,
                  height: 7,
                  borderRadius: 1,
                  backgroundColor: lit ? theme.accent : theme.knobEdge,
                }}
              />
            </View>
          );
        })}

        {changed && ghostAngle != null ? (
          <View
            style={{
              position: "absolute",
              width: size,
              height: size,
              alignItems: "center",
              transform: [{ rotate: `${ghostAngle}deg` }],
            }}
          >
            <View
              style={{ width: 3, height: 9, borderRadius: 1.5, backgroundColor: theme.amber }}
            />
          </View>
        ) : null}

        <View
          style={{
            width: dial,
            height: dial,
            borderRadius: dial / 2,
            backgroundColor: theme.knob,
            borderWidth: 1,
            borderColor: active ? theme.accent : theme.knobEdge,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              position: "absolute",
              width: dial,
              height: dial,
              alignItems: "center",
              transform: [{ rotate: `${angle}deg` }],
            }}
          >
            <View
              style={{
                width: 3,
                height: dial * 0.42,
                borderRadius: 2,
                backgroundColor: theme.accent,
                marginTop: 4,
              }}
            />
          </View>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              color: theme.text,
              fontSize: 13,
              fontWeight: "700",
              maxWidth: dial * 0.86,
              textAlign: "center",
            }}
          >
            {readout}
          </Text>
        </View>
      </View>

      <Text
        style={{
          color: changed ? theme.amber : theme.textDim,
          fontSize: 11,
          marginTop: 6,
          letterSpacing: 1,
        }}
      >
        {changed ? `${label.toUpperCase()} •` : label.toUpperCase()}
      </Text>
    </View>
  );
}
