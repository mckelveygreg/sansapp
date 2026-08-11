/**
 * IR page — impulse responses, two layers:
 *
 *   1. IMPULSE RESPONSE (always on): pull the pedal's own 8 cabs (05 69), then drag the microphone
 *      up/down the stack to blend between them LIVE (the continuous 0x0E morph) — like EliteControl.
 *      The graph shows the blended response; every faint curve is one of your pulled cabs.
 *   2. CRAFT A CUSTOM IR (optional Studio): take a pulled cab or a loaded WAV, optionally blend a
 *      second and bake a filter (e.g. a high-pass) into it, then UPLOAD it to a user slot (7/8) over
 *      MIDI. This is the part you're crafting, so it needs an upload; the encoding is verified
 *      (src/protocol/irEncode) — no EliteControl / WAV round-trip.
 *
 * We never ship Tech 21's IRs: every curve here is read off the user's own pedal.
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  PanResponder,
  Platform,
  Pressable,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useStore } from "zustand";
import { IrGraph } from "../src/components/IrGraph";
import type { IrCurve } from "../src/components/IrGraph";
import { KnobScroll } from "../src/components/KnobScroll";
import { radius, theme, toneColors } from "../src/components/theme";
import { blendIr, cascadeIr, generateIr, type IrGenKind } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { PEDAL_IR_RATE, cabCurveDb, cabResponseAt } from "../src/dsp/tone";
import { pickFileBytes, saveAndShare } from "../src/midi/exportFile";
import { loadIrCache, saveIrCache } from "../src/midi/irCache";
import { uploadCustomIr } from "../src/midi/irImport";
import { USER_IR_SLOTS, readIrSlot } from "../src/midi/irRead";
import { sendParam } from "../src/midi/liveParam";
import { getController, getSession, pedalStore } from "../src/midi/pedal";
import { buildPresetBlob } from "../src/protocol/buildPreset";
import {
  PARAMS,
  USER_IR_GAIN_DB_RANGE,
  gainDbToValue,
  valueToGainDb,
  type ParamId,
} from "../src/protocol/params";
import { ambienceStore } from "../src/state/ambience";
import { uiStore } from "../src/state/ui";
import { decodeWav, encodeWav, floatToPcm } from "../src/protocol/wav";

interface TypeDef {
  kind: IrGenKind;
  label: string;
  gain: boolean;
  q: boolean;
  slope: boolean;
}
const TYPES: readonly TypeDef[] = [
  { kind: "highpass", label: "High-pass", gain: false, q: true, slope: true },
  { kind: "lowpass", label: "Low-pass", gain: false, q: true, slope: true },
  { kind: "lowshelf", label: "Low shelf", gain: true, q: false, slope: false },
  { kind: "highshelf", label: "High shelf", gain: true, q: false, slope: false },
  { kind: "tilt", label: "Tilt", gain: true, q: false, slope: false },
  { kind: "notch", label: "Notch", gain: false, q: true, slope: false },
];
const Q_STEPS = [0.5, Math.SQRT1_2, 1, 2] as const;
const GRID = logGrid(30, 18000, 150);
const FLAT_DB: readonly number[] = GRID.map(() => 0);
const TAPS = 1000;

// The pedal exposes 8 IR slots (bank 0x02) — 1–6 factory, 7–8 the writable USER slots. Its live
// IR-select (0x0E) is CONTINUOUS: 0 = Off (flat), then it morphs between neighbouring cabs up to
// slot 8 at 127. So slot n sits at n·16 (clamped to 127), and values between blend two cabs.
const IR_SLOTS = 8;
const slotFallback = (pos: number) => `IR ${pos}`;
const slotToValue = (pos: number) => Math.min(127, pos * 16);

// The two writable USER slots (7/8) each hold BOTH a factory cab and an uploaded custom IR; the
// preset's per-slot IR Mode toggle (irMode7/irMode8) picks which one plays. When mode is OFF the pedal
// plays the factory cab — whose curve we can't read — so the stack must show the factory name and NOT
// present the pulled (user) cab as active. Slots 1–6 are plain factory cabs (always their pulled name).
const FACTORY_IR_NAME: Record<number, string> = { 7: "Voice 12L", 8: "Brit V30" };
const isUserSlot = (pos: number): boolean => pos >= 7;
const IR_MODE_ID = { 7: "irMode7", 8: "irMode8" } as const satisfies Record<number, ParamId>;
const IR_GAIN_ID = { 7: "irGain7", 8: "irGain8" } as const satisfies Record<number, ParamId>;

/** The label to show for a slot given its per-preset IR Mode: a user slot with the mode OFF reads as
 * its factory cab; otherwise the pulled cab name (falling back to a generic slot label). */
const slotDisplayName = (pos: number, userIrOn: boolean, pulledName?: string): string =>
  isUserSlot(pos) && !userIrOn
    ? `Factory · ${FACTORY_IR_NAME[pos] ?? slotFallback(pos)}`
    : (pulledName ?? slotFallback(pos));

const haptic = (fn: () => Promise<unknown>) => {
  if (Platform.OS !== "web") void fn().catch(() => {});
};

interface Cab {
  ir: Float64Array;
  rate: number;
  name: string;
}
interface Pulled {
  name: string;
  db: number[];
  ir: Float64Array;
}

// The pedal-IR display convention (nominal rate + normalize band) is shared with the editor's
// Tone Shaper — src/dsp/tone.ts owns it.
const curveOf = (ir: Float64Array): number[] => cabCurveDb(ir, GRID);
const persist = (map: Record<number, Pulled>): void =>
  void saveIrCache(
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [Number(k), { name: v.name, samples: v.ir }]),
    ),
  );

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.panelEdge,
        backgroundColor: active ? theme.accent : "transparent",
      }}
    >
      <Text style={{ color: active ? "#fff" : theme.textDim, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function Stepper({
  label,
  value,
  onStep,
}: {
  label: string;
  value: string;
  onStep: (dir: number) => void;
}) {
  const Btn = ({ t, d }: { t: string; d: number }) => (
    <Pressable
      onPress={() => onStep(d)}
      style={{
        width: 38,
        height: 38,
        borderRadius: 8,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.text, fontSize: 20 }}>{t}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Btn t="−" d={-1} />
        <Text
          style={{
            color: theme.text,
            width: 96,
            textAlign: "center",
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </Text>
        <Btn t="+" d={1} />
      </View>
    </View>
  );
}

const ROW_H = 46;
const MIC_ROWS = IR_SLOTS + 1; // Off + 1..8

/** Per-user-slot (7/8) inline controls: the IR Mode toggle + the ±12 dB User IR Gain, mirrored from
 * EliteControl's inline layout. Rendered on the slot's own row so the switch/gain sit with the cab. */
interface UserSlotControl {
  modeOn: boolean;
  gainDb: number;
  onToggle: (on: boolean) => void;
  onGainStep: (dir: number) => void;
}

/** Compact ±/value gain cell used inline on a user slot row. Greyed (non-interactive) when the slot's
 * user IR is off — the gain only affects the user cab, exactly as EliteControl greys it for a factory
 * slot. */
function GainCell({
  db,
  enabled,
  onStep,
}: {
  db: number;
  enabled: boolean;
  onStep: (d: number) => void;
}) {
  const col = enabled ? theme.text : theme.panelEdge;
  const Btn = ({ t, d }: { t: string; d: number }) => (
    <Pressable
      disabled={!enabled}
      onPress={() => onStep(d)}
      hitSlop={6}
      style={{
        width: 22,
        height: 26,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: enabled ? theme.panelEdge : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: col, fontSize: 16 }}>{t}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <Btn t="−" d={-1} />
      <Text
        style={{
          color: enabled ? theme.accent : theme.textDim,
          width: 52,
          textAlign: "center",
          fontSize: 12,
          fontVariant: ["tabular-nums"],
        }}
      >
        {`${db > 0 ? "+" : ""}${db.toFixed(1)}dB`}
      </Text>
      <Btn t="+" d={1} />
    </View>
  );
}

/**
 * The IMPULSE RESPONSE stack: rows Off/1..8 with a microphone you drag to blend between cabs live.
 * `value` is the 0x0E wire value (0..127); dragging maps the mic's Y to it and calls `onChange` so
 * the caller sends it live. Tapping a row snaps to that cab.
 */
function MicStack({
  names,
  value,
  onChange,
  onSelect,
  userControls,
}: {
  names: Record<number, string>;
  value: number;
  onChange: (v: number) => void;
  onSelect: (pos: number) => void;
  userControls?: Record<number, UserSlotControl>;
}) {
  const H = MIC_ROWS * ROW_H;
  const startVal = useRef(value);
  const valRef = useRef(value);
  valRef.current = value;
  const clampV = (v: number) => Math.max(0, Math.min(127, v));
  // rowFloat (0=Off … 8=slot 8) ↔ y (row centre) ↔ 0x0E value.
  const valToY = (v: number) => (v / 16) * ROW_H + ROW_H / 2;
  const yToVal = (y: number) =>
    clampV(Math.round(Math.max(0, Math.min(8, (y - ROW_H / 2) / ROW_H)) * 16));

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        startVal.current = valRef.current;
        uiStore.getState().setAdjusting(true);
        haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
      },
      onPanResponderMove: (_e, g) => {
        const next = yToVal(valToY(startVal.current) + g.dy);
        if (next !== valRef.current) {
          if (Math.round(next / 16) !== Math.round(valRef.current / 16)) {
            haptic(() => Haptics.selectionAsync());
          }
          onChange(next);
        }
      },
      onPanResponderRelease: () => uiStore.getState().setAdjusting(false),
      onPanResponderTerminate: () => uiStore.getState().setAdjusting(false),
    }),
  ).current;

  const micY = valToY(value);
  const nearest = Math.round(value / 16);

  return (
    <View style={{ flexDirection: "row" }}>
      {/* Left rail: a guide line + the draggable mic. */}
      <View {...responder.panHandlers} style={{ width: 46, height: H }}>
        <View
          style={{
            position: "absolute",
            left: 22,
            top: 0,
            width: 2,
            height: H,
            backgroundColor: theme.panelEdge,
          }}
        />
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: micY - 1,
            height: 2,
            backgroundColor: theme.accent,
            opacity: 0.5,
          }}
        />
        <View
          style={{
            position: "absolute",
            left: 6,
            top: micY - 15,
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: theme.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="mic" size={18} color="#fff" />
        </View>
      </View>
      {/* Rows */}
      <View style={{ flex: 1 }}>
        {Array.from({ length: MIC_ROWS }, (_, pos) => {
          const label = pos === 0 ? "Off — Flat Response" : (names[pos] ?? slotFallback(pos));
          const active = nearest === pos;
          const ctl = userControls?.[pos];
          const rowStyle = {
            height: ROW_H,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.panelEdge,
            backgroundColor: active ? `${theme.accent}22` : "transparent",
          } as const;
          // User slots (7/8): tappable name area + inline toggle/gain as SIBLINGS of the Pressable, so
          // touching the switch or the gain steppers doesn't also fire the row's select.
          if (ctl) {
            return (
              <View key={pos} style={rowStyle}>
                <Pressable
                  onPress={() => onSelect(pos)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}
                >
                  <Text style={{ color: theme.textDim, width: 14, fontVariant: ["tabular-nums"] }}>
                    {pos}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: active ? theme.text : theme.textDim,
                      fontSize: 13,
                      flexShrink: 1,
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
                <View
                  style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  <GainCell db={ctl.gainDb} enabled={ctl.modeOn} onStep={ctl.onGainStep} />
                  <Switch
                    value={ctl.modeOn}
                    onValueChange={ctl.onToggle}
                    trackColor={{ false: theme.panelEdge, true: theme.accent }}
                    thumbColor="#fff"
                    style={{ transform: [{ scale: 0.8 }] }}
                  />
                </View>
              </View>
            );
          }
          return (
            <Pressable key={pos} onPress={() => onSelect(pos)} style={rowStyle}>
              <Text style={{ color: theme.textDim, width: 22, fontVariant: ["tabular-nums"] }}>
                {pos === 0 ? "—" : pos}
              </Text>
              <Text style={{ color: active ? theme.text : theme.textDim, flex: 1, fontSize: 14 }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function IrStudio() {
  const { width } = useWindowDimensions();
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const [status, setStatus] = useState<string | null>(null);

  // --- IMPULSE RESPONSE (live blend) ---
  const [pulled, setPulled] = useState<Record<number, Pulled>>({});
  const [pulling, setPulling] = useState(false);
  const [pullProg, setPullProg] = useState<{ done: number; total: number } | null>(null);
  // IR position (0x0E) is store-backed — the mic reflects the LOADED preset's cab, not a guess.
  const morph = useStore(pedalStore, (s) => s.values.irBlend) ?? 0;
  // Per-USER-slot IR Mode + makeup gain are store-backed too, so they reflect the LOADED preset (the
  // display gating below reads them) and an edit routes through the local-edit path (dirty + save).
  const irMode7 = (useStore(pedalStore, (s) => s.values.irMode7) ?? 0) > 0;
  const irMode8 = (useStore(pedalStore, (s) => s.values.irMode8) ?? 0) > 0;
  const irGain7 = useStore(pedalStore, (s) => s.values.irGain7);
  const irGain8 = useStore(pedalStore, (s) => s.values.irGain8);
  const userModeOn = (pos: number): boolean => (pos === 7 ? irMode7 : pos === 8 ? irMode8 : true);
  const gainDbOf = (slot: 7 | 8): number => {
    const wire = slot === 7 ? irGain7 : irGain8;
    return wire === undefined ? 0 : valueToGainDb(wire);
  };

  // Load cached curves on mount so we don't re-read the pedal every visit — Refresh re-pulls.
  useEffect(() => {
    void (async () => {
      const cached = await loadIrCache();
      if (!cached) return;
      const next: Record<number, Pulled> = {};
      for (const [pos, s] of Object.entries(cached)) {
        next[Number(pos)] = { name: s.name, ir: s.samples, db: curveOf(s.samples) };
      }
      if (Object.keys(next).length > 0) {
        setPulled(next);
        setStatus(`Loaded ${Object.keys(next).length} cached cabs — Refresh to re-read the pedal.`);
      }
    })();
  }, []);

  async function pullFromPedal() {
    if (!getSession()) {
      setStatus("Connect to the pedal first.");
      return;
    }
    setPulling(true);
    setPullProg({ done: 0, total: IR_SLOTS });
    setStatus("Reading IRs from the pedal…");
    const next: Record<number, Pulled> = {};
    let lostLink = false;
    for (let pos = 1; pos <= IR_SLOTS; pos++) {
      // Re-fetch each slot: if the link drops mid-read the session is nulled — bail instead of
      // hammering a dead session and silently blanking the remaining slots.
      const session = getSession();
      if (!session) {
        lostLink = true;
        break;
      }
      const ir = await readIrSlot(session, pos);
      if (ir) {
        const samples = Float64Array.from(ir.samples);
        next[pos] = { name: ir.name || slotFallback(pos), ir: samples, db: curveOf(samples) };
      }
      setPullProg({ done: pos, total: IR_SLOTS });
      // Pace the reads so the back-to-back burst doesn't saturate the BLE TX (which was tripping a
      // transient drop). The reads bypass the request queue, so they aren't otherwise paced.
      if (pos < IR_SLOTS) await new Promise((r) => setTimeout(r, 120));
    }
    // A full pull REPLACES the cache (a slot that read empty is now genuinely empty). A pull cut short
    // by a link loss only read part of the slots, so MERGE over the existing cache — don't wipe the
    // slots we never got to.
    const result = lostLink ? { ...pulled, ...next } : next;
    setPulled(result);
    persist(result);
    setPulling(false);
    setPullProg(null);
    const n = Object.keys(next).length;
    setStatus(
      lostLink
        ? "Lost the pedal connection while reading — reconnect and try again."
        : n
          ? `Pulled ${n} IR${n > 1 ? "s" : ""} from the pedal.`
          : "No IRs read (check the slot map).",
    );
  }

  // Live blend: send 0x0E as the mic moves + record it in the store (source of truth for the stack).
  function setBlendValue(v: number) {
    sendParam(0x0e, v);
    pedalStore.getState().setValueLocal("irBlend", v);
  }
  function selectSlot(pos: number) {
    setBlendValue(slotToValue(pos));
    setStatus(
      pos === 0
        ? "Off (flat)."
        : `Cab ${pos}: ${slotDisplayName(pos, userModeOn(pos), pulled[pos]?.name)}`,
    );
  }

  // The blended curve at the current mic position (interpolated between the two neighbouring cabs). A
  // user slot with its IR Mode OFF plays the factory cab, whose curve we can't read — treat it as
  // unknown (null) so we never draw the pulled user IR as if it were the active sound.
  const stackDb = useMemo(() => {
    const dbAt = (pos: number) => {
      if ((pos === 7 && !irMode7) || (pos === 8 && !irMode8)) return null;
      return pulled[pos]?.db ?? null;
    };
    return cabResponseAt(morph, dbAt, FLAT_DB);
  }, [morph, pulled, irMode7, irMode8]);

  const stackCurves: IrCurve[] = [
    ...Object.values(pulled).map((p) => ({
      db: p.db,
      color: toneColors.cab,
      width: 1,
      opacity: 0.22,
    })),
    ...(stackDb ? [{ db: stackDb, color: toneColors.cab, width: 2.6 }] : []),
  ];

  // --- CRAFT A CUSTOM IR (Studio) ---
  const [showStudio, setShowStudio] = useState(false);
  const [kind, setKind] = useState<IrGenKind>("highpass");
  const [filterOn, setFilterOn] = useState(true);
  const [fc, setFc] = useState(80);
  const [gainDb, setGainDb] = useState(6);
  const [qi, setQi] = useState(1);
  const [stages, setStages] = useState(2);
  const [cabA, setCabA] = useState<Cab | null>(null);
  const [cabB, setCabB] = useState<Cab | null>(null);
  const [blend, setBlend] = useState(50);
  const [uploadSlot, setUploadSlot] = useState<7 | 8>(7);
  // IR Mode + gain are store-backed (irMode7/8, irGain7/8) — read above. Edits go through the standard
  // local-edit path (send live + setValueLocal), so the toggle/gain reflect the LOADED preset, set the
  // dirty flag, and a SAVE persists them (sendParam maps the index to the live-set id).
  const setGain = (slot: 7 | 8, db: number) => {
    const clamped = Math.max(-USER_IR_GAIN_DB_RANGE, Math.min(USER_IR_GAIN_DB_RANGE, db));
    const wire = gainDbToValue(clamped);
    const id = IR_GAIN_ID[slot];
    sendParam(PARAMS[id].paramId ?? 0, wire);
    pedalStore.getState().setValueLocal(id, wire);
  };
  const setMode = (slot: 7 | 8, on: boolean) => {
    const id = IR_MODE_ID[slot];
    sendParam(PARAMS[id].paramId ?? 0, on ? 1 : 0);
    pedalStore.getState().setValueLocal(id, on ? 1 : 0);
  };

  const def = TYPES.find((t) => t.kind === kind)!;
  const q = Q_STEPS[qi]!;
  const rate = cabA?.rate ?? 44100;
  const filterIr = useMemo(
    () => generateIr(kind, { fc, gainDb, q, stages, taps: TAPS, sampleRate: rate }),
    [kind, fc, gainDb, q, stages, rate],
  );
  const craft = useMemo(() => {
    let base: Float64Array | null = null;
    if (cabA && cabB) base = blendIr(cabA.ir, cabB.ir, blend / 100);
    else if (cabA) base = cabA.ir;
    if (!base) {
      if (!filterOn) {
        const flat = new Float64Array(TAPS);
        flat[0] = 1; // delta = flat response (no cab, no filter)
        return flat;
      }
      return filterIr;
    }
    return filterOn ? cascadeIr(base, filterIr, TAPS) : Float64Array.from(base);
  }, [cabA, cabB, blend, filterOn, filterIr]);
  const craftDb = useMemo(
    () => frequencyResponse(craft, GRID, { sampleRate: rate, normalizeBand: [700, 1400] }),
    [craft, rate],
  );

  async function loadCab(which: "A" | "B") {
    try {
      const picked = await pickFileBytes();
      if (!picked) return;
      const { samples, sampleRate } = decodeWav(picked.bytes);
      const ir = Float64Array.from(samples, (s) => s / 32768);
      const cab: Cab = { ir, rate: sampleRate, name: picked.name.replace(/\.[^.]+$/, "") };
      (which === "A" ? setCabA : setCabB)(cab);
      setStatus(`Loaded ${which === "A" ? "cab" : "2nd cab"}: ${cab.name}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  function useCabFromPedal(pos: number) {
    const hit = pulled[pos];
    if (!hit) {
      setStatus(`Pull the pedal first to load slot ${pos}.`);
      return;
    }
    setCabA({ ir: hit.ir, rate: PEDAL_IR_RATE, name: hit.name });
    setCabB(null);
    setShowStudio(true);
    setStatus(`Loaded "${hit.name}" into the Studio — bake a filter, then upload.`);
  }

  function irName() {
    const tag = cabA ? cabA.name : kind;
    const suffix = filterOn || !cabA ? `-${kind}${fc}Hz` : "";
    return `SansApp-${tag}${suffix}`.replace(/\s+/g, "_");
  }

  async function onExport() {
    try {
      await saveAndShare(`${irName()}.wav`, encodeWav(floatToPcm(craft), rate), "audio/wav");
      setStatus(`Exported ${irName()}.wav`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function onUpload() {
    const session = getSession();
    // An IR upload is a flash write on the pedal, not just a live param — starting one we can't
    // finish (a drop mid-transfer) leaves the pedal's transfer-busy flag set and its SysEx parser
    // wedged until the next hello clears it. Refuse to start unless the link is actually up and the
    // app is in the foreground to see it through.
    if (!session || !ready) {
      setStatus("Connect to the pedal first.");
      return;
    }
    if (AppState.currentState !== "active") {
      setStatus("Bring the app to the foreground before uploading an IR.");
      return;
    }
    const st = pedalStore.getState();
    const program = st.slot;
    if (program == null || !st.raw) {
      setStatus("Recall a preset first — the IR is uploaded into the current preset.");
      return;
    }
    try {
      setStatus(`Uploading IR to slot ${uploadSlot} of preset ${program + 1}…`);
      // The upload is a save of the current preset (the pedal hands a per-preset IR over via its
      // save-as — see irImport.ts), so the saved blob is the current sound exactly like the Save
      // button: current values over the loaded base, plus the uploaded slot enabled and the IR
      // select pointed at it so the preset comes back playing the new IR.
      const amb = ambienceStore.getState();
      const values = {
        ...st.values,
        [IR_MODE_ID[uploadSlot]]: 1,
        irBlend: slotToValue(uploadSlot),
      };
      const blob = buildPresetBlob(st.raw, values, st.name ?? "", amb.typeDirty ? amb.type : null);
      const { pointerConfirmed } = await uploadCustomIr(session, craft, irName().slice(0, 32), {
        slot: uploadSlot,
        program,
        blob,
      });
      // Reflect the just-uploaded IR into the stack directly from the crafted samples. We do NOT
      // read the slot back over MIDI here: a heavy read burst right after the upload is exactly the
      // kind of BLE traffic that's flaky. Show what we sent.
      const samples = Float64Array.from(craft);
      setPulled((p) => {
        const merged = {
          ...p,
          [uploadSlot]: {
            name: irName().slice(0, 32) || slotFallback(uploadSlot),
            ir: samples,
            db: curveOf(samples),
          },
        };
        persist(merged); // keep the cache in sync with the newly-uploaded IR
        return merged;
      });
      // The save-as parks the pedal on the destination program; recall it so the app state reloads
      // from the SAVED preset (slot enabled, IR selected, pointer repointed) and nothing reads dirty.
      try {
        await getController()?.recall(program);
      } catch {
        /* recall is best-effort — if it drops, the preset is already saved; recall manually */
      }
      setStatus(
        pointerConfirmed
          ? `Uploaded "${irName()}" → slot ${uploadSlot} and saved with preset ${program + 1}.`
          : `Uploaded "${irName()}" → slot ${uploadSlot} of preset ${program + 1} — saved, but the ` +
              `pedal didn't confirm the preset's own IR record; a later upload may replace it.`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A failed upload can leave the pedal's transfer-busy flag set, which wedges its SysEx parser
      // until the next hello clears it — a straight retry would send a second begin frame into that
      // and just wedge it again. Re-run the handshake before handing control back, so a manual retry
      // starts clean instead of blind.
      try {
        await session.connect();
        setStatus(`Upload failed (${msg}) — reconnected, safe to retry.`);
      } catch {
        setStatus(
          `Upload failed (${msg}) — lost the connection recovering; reconnect and try again.`,
        );
      }
    }
  }

  const stepFc = (d: number) =>
    setFc((v) => Math.round(Math.max(30, Math.min(8000, v * 2 ** (d / 6)))));
  const graphW = width - 32 - 18;
  const panel = {
    backgroundColor: theme.panel,
    borderColor: theme.panelEdge,
    borderWidth: 1,
    borderRadius: radius,
    padding: 14,
    gap: 12,
  } as const;

  return (
    <KnobScroll style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      {/* IMPULSE RESPONSE — live blend */}
      <View style={panel}>
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
            IMPULSE RESPONSE
          </Text>
          <Chip
            label={
              pulling ? "Reading…" : Object.keys(pulled).length ? "Refresh" : "Pull from pedal"
            }
            active={false}
            onPress={() => {
              if (!pulling) void pullFromPedal();
            }}
          />
        </View>

        {pulling ? (
          <View style={{ gap: 4 }}>
            <View
              style={{
                height: 6,
                backgroundColor: theme.panelEdge,
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: 6,
                  width: `${pullProg ? Math.round((pullProg.done / pullProg.total) * 100) : 0}%`,
                  backgroundColor: theme.accent,
                }}
              />
            </View>
            <Text style={{ color: theme.textDim, fontSize: 11 }}>
              Reading cab {pullProg?.done ?? 0} of {pullProg?.total ?? IR_SLOTS}…
            </Text>
          </View>
        ) : null}

        {Object.keys(pulled).length ? (
          <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
            Drag the mic to blend between cabs — it plays live on the pedal. Tap a row to jump to
            it.
          </Text>
        ) : (
          <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
            {ready
              ? "Pull to read each cab off the pedal (nothing is shipped with the app), then drag the mic to blend."
              : "Connect to the pedal to pull and blend its cabs."}
          </Text>
        )}

        <MicStack
          names={Object.fromEntries(
            Array.from({ length: IR_SLOTS }, (_, i) => i + 1).map((pos) => [
              pos,
              slotDisplayName(pos, userModeOn(pos), pulled[pos]?.name),
            ]),
          )}
          value={morph}
          onChange={setBlendValue}
          onSelect={selectSlot}
          userControls={{
            7: {
              modeOn: irMode7,
              gainDb: gainDbOf(7),
              onToggle: (v) => setMode(7, v),
              onGainStep: (d) => setGain(7, gainDbOf(7) + d),
            },
            8: {
              modeOn: irMode8,
              gainDb: gainDbOf(8),
              onToggle: (v) => setMode(8, v),
              onGainStep: (d) => setGain(8, gainDbOf(8) + d),
            },
          }}
        />
        <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
          Slots 7 & 8 are yours: the switch picks your uploaded cab (on) or the factory cab (off —
          Voice 12L / Brit V30), and the dB trims your cab's level. Uploading only replaces your
          cab; the factory one always returns when the switch is off.
        </Text>

        <View
          style={{
            backgroundColor: theme.bg,
            borderColor: theme.panelEdge,
            borderWidth: 1,
            borderRadius: radius,
            padding: 8,
          }}
        >
          <IrGraph
            grid={GRID}
            curves={stackCurves}
            width={graphW}
            height={190}
            dbTop={18}
            dbBot={-42}
          />
        </View>
      </View>

      {/* CRAFT A CUSTOM IR — optional Studio */}
      <Pressable
        onPress={() => setShowStudio((s) => !s)}
        style={{
          ...panel,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <View>
          <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
            CRAFT A CUSTOM IR
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 2 }}>
            Bake a filter into a cab, then upload to slot 7/8
          </Text>
        </View>
        <Ionicons
          name={showStudio ? "chevron-up" : "chevron-down"}
          size={20}
          color={theme.textDim}
        />
      </Pressable>

      {showStudio ? (
        <>
          {/* CAB SOURCE */}
          <View style={panel}>
            <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
              CAB SOURCE
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Chip
                label={cabA ? `Cab: ${cabA.name}` : "Load cab…"}
                active={!!cabA}
                onPress={() => void loadCab("A")}
              />
              <Chip
                label={cabB ? `2nd: ${cabB.name}` : "Load 2nd cab…"}
                active={!!cabB}
                onPress={() => void loadCab("B")}
              />
              {cabA || cabB ? (
                <Chip
                  label="Clear"
                  active={false}
                  onPress={() => {
                    setCabA(null);
                    setCabB(null);
                  }}
                />
              ) : null}
            </View>
            {Object.keys(pulled).length ? (
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
              >
                <Text style={{ color: theme.textDim, fontSize: 12 }}>Or a pulled cab:</Text>
                {Object.keys(pulled)
                  .map(Number)
                  .map((pos) => (
                    <Chip
                      key={pos}
                      label={pulled[pos]!.name}
                      active={cabA?.name === pulled[pos]!.name}
                      onPress={() => useCabFromPedal(pos)}
                    />
                  ))}
              </View>
            ) : null}
            {cabA && cabB ? (
              <Stepper
                label="BLEND A↔B"
                value={`${100 - blend}% / ${blend}%`}
                onStep={(d) => setBlend((v) => Math.max(0, Math.min(100, v + d * 10)))}
              />
            ) : null}
          </View>

          {/* FILTER — with an explicit Off */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label="Off" active={!filterOn} onPress={() => setFilterOn(false)} />
            {TYPES.map((t) => (
              <Chip
                key={t.kind}
                label={t.label}
                active={filterOn && t.kind === kind}
                onPress={() => {
                  setFilterOn(true);
                  setKind(t.kind);
                }}
              />
            ))}
          </View>
          {filterOn ? (
            <View style={panel}>
              <Stepper label="FREQUENCY" value={`${fc} Hz`} onStep={stepFc} />
              {def.gain ? (
                <Stepper
                  label="GAIN"
                  value={`${gainDb > 0 ? "+" : ""}${gainDb} dB`}
                  onStep={(d) => setGainDb((v) => Math.max(-12, Math.min(12, v + d)))}
                />
              ) : null}
              {def.q ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>Q</Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {Q_STEPS.map((qq, i) => (
                      <Chip
                        key={qq}
                        label={qq.toFixed(1)}
                        active={i === qi}
                        onPress={() => setQi(i)}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
              {def.slope ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>
                    SLOPE
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Chip label="12 dB/oct" active={stages === 1} onPress={() => setStages(1)} />
                    <Chip label="24 dB/oct" active={stages === 2} onPress={() => setStages(2)} />
                  </View>
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={{ color: theme.textDim, fontSize: 12 }}>
              Filter off — the cab is uploaded as-is (no baked filter).
            </Text>
          )}

          {/* CRAFT PREVIEW */}
          <View
            style={{
              backgroundColor: theme.bg,
              borderColor: theme.panelEdge,
              borderWidth: 1,
              borderRadius: radius,
              padding: 8,
            }}
          >
            <IrGraph
              grid={GRID}
              curves={[{ db: craftDb, color: toneColors.cab, width: 2.6 }]}
              width={graphW}
              height={170}
              dbTop={18}
              dbBot={-42}
            />
          </View>

          {/* UPLOAD */}
          <View style={panel}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>
                UPLOAD TO
              </Text>
              {USER_IR_SLOTS.map((s) => (
                <Chip
                  key={s}
                  label={`${s}: ${slotDisplayName(s, userModeOn(s), pulled[s]?.name)}`}
                  active={uploadSlot === s}
                  onPress={() => setUploadSlot(s as 7 | 8)}
                />
              ))}
            </View>
            <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
              Uploads into the current preset and saves it — slot {uploadSlot} switches on and the
              IR is selected, so the preset comes back playing your cab at factory level. Any other
              edits you have going are saved with it. Use the slot {uploadSlot} switch and dB up in
              the list to toggle factory vs. your cab and trim its level.
            </Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={onUpload}
                disabled={!ready}
                style={{
                  flex: 1,
                  backgroundColor: theme.accent,
                  padding: 14,
                  borderRadius: radius,
                  alignItems: "center",
                  opacity: ready ? 1 : 0.5,
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "700" }}>Upload ▸ slot {uploadSlot}</Text>
              </Pressable>
              <Pressable
                onPress={onExport}
                style={{
                  paddingHorizontal: 18,
                  justifyContent: "center",
                  borderColor: theme.panelEdge,
                  borderWidth: 1,
                  borderRadius: radius,
                }}
              >
                <Text style={{ color: theme.text, fontWeight: "700" }}>Export .wav</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : null}

      {status ? (
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>{status}</Text>
      ) : null}
    </KnobScroll>
  );
}
