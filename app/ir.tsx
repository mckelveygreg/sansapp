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
import { radius, theme } from "../src/components/theme";
import { blendIr, cascadeIr, generateIr, type IrGenKind } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { uploadCustomIr } from "../src/midi/bundleIo";
import { pickFileBytes, saveAndShare } from "../src/midi/exportFile";
import { loadIrCache, saveIrCache } from "../src/midi/irCache";
import { USER_IR_SLOTS, readIrSlot } from "../src/midi/irRead";
import { sendParam } from "../src/midi/liveParam";
import { getSession, pedalStore } from "../src/midi/pedal";
import {
  USER_IR_GAIN,
  USER_IR_GAIN_DB_RANGE,
  USER_IR_MODE,
  gainDbToValue,
} from "../src/protocol/params";
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

// The pedal plays its 2400-sample IRs at a fixed rate we haven't pinned exactly (calibration TODO);
// a nominal rate keeps the curve SHAPE right (x-axis Hz labels are approximate).
const PEDAL_IR_RATE = 88200;
const curveOf = (ir: Float64Array): number[] =>
  frequencyResponse(ir, GRID, { sampleRate: PEDAL_IR_RATE, normalizeBand: [700, 1400] });
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

const ROW_H = 40;
const MIC_ROWS = IR_SLOTS + 1; // Off + 1..8

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
}: {
  names: Record<number, string>;
  value: number;
  onChange: (v: number) => void;
  onSelect: (pos: number) => void;
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
          return (
            <Pressable
              key={pos}
              onPress={() => onSelect(pos)}
              style={{
                height: ROW_H,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 10,
                borderBottomWidth: 1,
                borderBottomColor: theme.panelEdge,
                backgroundColor: active ? `${theme.accent}22` : "transparent",
              }}
            >
              <Text style={{ color: theme.textDim, width: 22, fontVariant: ["tabular-nums"] }}>
                {pos === 0 ? "—" : pos}
              </Text>
              <Text style={{ color: active ? theme.text : theme.textDim, flex: 1, fontSize: 14 }}>
                {label}
              </Text>
              {pos >= 7 ? (
                <Text style={{ color: theme.amber, fontSize: 10, letterSpacing: 1 }}>USER</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Linear blend of two dB curves (either may be null = not pulled). */
function blendDb(
  a: readonly number[] | null,
  b: readonly number[] | null,
  f: number,
): number[] | null {
  if (!a && !b) return null;
  if (!a) return b!.slice();
  if (!b) return a.slice();
  return a.map((v, i) => v * (1 - f) + b[i]! * f);
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
    const hit = pulled[pos];
    setStatus(pos === 0 ? "Off (flat)." : hit ? `Cab ${pos}: ${hit.name}` : `Slot ${pos}.`);
  }

  // The blended curve at the current mic position (interpolated between the two neighbouring cabs).
  const stackDb = useMemo(() => {
    if (morph <= 0) return FLAT_DB.slice();
    const rf = morph / 16;
    const lo = Math.floor(rf);
    const hi = Math.min(8, Math.ceil(rf));
    const dbAt = (pos: number) => (pos <= 0 ? FLAT_DB : (pulled[pos]?.db ?? null));
    return blendDb(dbAt(lo), dbAt(hi), rf - lo);
  }, [morph, pulled]);

  const stackCurves: IrCurve[] = [
    ...Object.values(pulled).map((p) => ({
      db: p.db,
      color: theme.textDim,
      width: 1,
      opacity: 0.22,
    })),
    ...(stackDb ? [{ db: stackDb, color: theme.accent, width: 2.6 }] : []),
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
  const [gainDbs, setGainDbs] = useState<Record<number, number>>({ 7: 0, 8: 0 });
  const [modes, setModes] = useState<Record<number, boolean>>({ 7: false, 8: false });
  const presetRaw = useStore(pedalStore, (s) => s.raw);
  // Reflect the LOADED preset's REAL per-slot IR mode (stored in the preset blob at USER_IR_MODE
  // paramId + 0x22 = 0x4a/0x4b) instead of always starting OFF. 0 = the factory cab, 1 = your uploaded
  // user IR. Re-syncs whenever a different preset loads (its blob changes).
  useEffect(() => {
    if (presetRaw) {
      setModes({
        7: (presetRaw[USER_IR_MODE[7]! + 0x22] ?? 0) > 0,
        8: (presetRaw[USER_IR_MODE[8]! + 0x22] ?? 0) > 0,
      });
    }
  }, [presetRaw]);

  const setGain = (slot: 7 | 8, db: number) => {
    const clamped = Math.max(-USER_IR_GAIN_DB_RANGE, Math.min(USER_IR_GAIN_DB_RANGE, db));
    setGainDbs((g) => ({ ...g, [slot]: clamped }));
    sendParam(USER_IR_GAIN[slot]!, gainDbToValue(clamped));
  };
  const setMode = (slot: 7 | 8, on: boolean) => {
    setModes((m) => ({ ...m, [slot]: on }));
    sendParam(USER_IR_MODE[slot]!, on ? 1 : 0);
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
    if (!session) {
      setStatus("Connect to the pedal first.");
      return;
    }
    try {
      setStatus(`Uploading IR to slot ${uploadSlot}…`);
      await uploadCustomIr(session, craft, irName().slice(0, 32), { slot: uploadSlot, save: true });
      // Refresh the uploaded slot so the stack shows its new name + curve immediately.
      const fresh = await readIrSlot(session, uploadSlot);
      if (fresh) {
        const samples = Float64Array.from(fresh.samples);
        setPulled((p) => {
          const merged = {
            ...p,
            [uploadSlot]: {
              name: fresh.name || slotFallback(uploadSlot),
              ir: samples,
              db: curveOf(samples),
            },
          };
          persist(merged); // keep the cache in sync with the newly-uploaded slot
          return merged;
        });
      }
      setStatus(`Uploaded "${irName()}" → slot ${uploadSlot} (saved & refreshed).`);
    } catch (e) {
      setStatus(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
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
          names={Object.fromEntries(Object.entries(pulled).map(([k, v]) => [k, v.name]))}
          value={morph}
          onChange={setBlendValue}
          onSelect={selectSlot}
        />

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
              curves={[{ db: craftDb, color: theme.amber, width: 2.6 }]}
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
                  label={pulled[s]?.name ? `${s}: ${pulled[s]!.name}` : `Slot ${s}`}
                  active={uploadSlot === s}
                  onPress={() => setUploadSlot(s as 7 | 8)}
                />
              ))}
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>
                  SLOT {uploadSlot} CAB · THIS PRESET
                </Text>
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700" }}>
                  {modes[uploadSlot]
                    ? "Your custom IR"
                    : `Factory · ${uploadSlot === 7 ? "Voice 12L" : "Brit V30"}`}
                </Text>
              </View>
              <Switch
                value={modes[uploadSlot] ?? false}
                onValueChange={(v) => setMode(uploadSlot, v)}
                trackColor={{ false: theme.panelEdge, true: theme.accent }}
                thumbColor="#fff"
              />
            </View>
            <Stepper
              label={`SLOT ${uploadSlot} GAIN`}
              value={`${(gainDbs[uploadSlot] ?? 0) > 0 ? "+" : ""}${(gainDbs[uploadSlot] ?? 0).toFixed(1)} dB`}
              onStep={(d) => setGain(uploadSlot, (gainDbs[uploadSlot] ?? 0) + d)}
            />
            <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
              Slots 7 & 8 each hold BOTH a factory cab and your uploaded cab. This switch picks
              which one this preset plays — off = factory (
              {uploadSlot === 7 ? "Voice 12L" : "Brit V30"}), on = your custom IR. Uploading only
              replaces your custom cab; the factory cab always comes back when the switch is off.
            </Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={onUpload}
                style={{
                  flex: 1,
                  backgroundColor: theme.accent,
                  padding: 14,
                  borderRadius: radius,
                  alignItems: "center",
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
