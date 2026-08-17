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
 *
 * Everything on this page is keyed by IR **record** number, not by mic-stack position. A preset's rows
 * 7/8 play whatever record ITS OWN pointer names, so `src/protocol/irSelect.ts` turns each position into
 * a record for this preset (the same selector the editor's Tone Shaper uses) and `src/midi/irCache.ts`
 * is keyed to match. Keying by position was sansapp#68: one preset's uploaded cab drawn on every other.
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
import { IR_READ_AB, USER_IR_SLOTS, readIr } from "../src/midi/irRead";
import { sendParam } from "../src/midi/liveParam";
import { getController, getSession, pedalCacheKey, pedalStore } from "../src/midi/pedal";
import { buildPresetBlob } from "../src/protocol/buildPreset";
import { readIrPointer } from "../src/protocol/irPointer";
import {
  LIBRARY_RECORD_BASE,
  type IrSource,
  type UserIrModes,
  irCurveAt,
  irSourceAt,
  libraryRecordAt,
} from "../src/protocol/irSelect";
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

// The two writable USER slots (7/8) each hold BOTH a factory cab and a per-preset custom IR; the
// preset's per-slot IR Mode toggle (irMode7/irMode8) picks which one plays. Which record each position
// resolves to — and whether that record is what's playing or the library's copy of an unreadable
// factory cab — is src/protocol/irSelect.ts's job, shared with the editor's Tone Shaper.
const IR_MODE_ID = { 7: "irMode7", 8: "irMode8" } as const satisfies Record<number, ParamId>;
const IR_GAIN_ID = { 7: "irGain7", 8: "irGain8" } as const satisfies Record<number, ParamId>;

/**
 * Row labels for positions 1–8: the name carried by the record each position resolves to, read off the
 * pedal at record offset +4 by the pull. No hardcoded cab names — the pedal keys IRs by record where
 * the deleted `FACTORY_IR_NAME` keyed them by position, which mislabelled every preset whose slot-7
 * pointer named anything but record 262 (88 of the 128 factory presets point at 260 `Concert 2x15`).
 *
 * An unread record has no name, so the row falls back to a generic `IR n` — the same thing positions
 * 1–6 have always shown before a pull. A record's stored name can be empty-string rather than absent,
 * so the fallback is deliberately on falsiness.
 */
const slotNames = (
  sources: readonly (IrSource | null)[],
  pulled: Record<number, Pulled>,
): Record<number, string> => {
  const out: Record<number, string> = {};
  for (let pos = 1; pos <= IR_SLOTS; pos++) {
    const src = sources[pos - 1];
    out[pos] = (src ? pulled[src.record]?.name : undefined) || slotFallback(pos);
  }
  return out;
};

const haptic = (fn: () => Promise<unknown>) => {
  if (Platform.OS !== "web") void fn().catch(() => {});
};

interface Cab {
  ir: Float64Array;
  rate: number;
  name: string;
}
/** One IR read off the pedal. Every map of these on this page is keyed by IR **record** number, never
 * by selector position — see src/midi/irCache.ts's header for why that distinction is the bug fix. */
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
    pedalCacheKey(), // tag the file with the pedal these records came from
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
  /** IR record → what we read there. Record-keyed (see {@link Pulled}). */
  const [pulled, setPulled] = useState<Record<number, Pulled>>({});
  const [pulling, setPulling] = useState(false);
  const [pullProg, setPullProg] = useState<{ done: number; total: number } | null>(null);
  // IR position (0x0E) is store-backed — the mic reflects the LOADED preset's cab, not a guess.
  const morph = useStore(pedalStore, (s) => s.values.irBlend) ?? 0;
  // The loaded preset's blob carries its own slot 7/8 IR-record pointers (blob 0x57–0x5A), which is
  // how each row knows which record THIS preset plays rather than showing the last one pulled.
  const raw = useStore(pedalStore, (s) => s.raw);
  // Per-USER-slot IR Mode + makeup gain are store-backed too, so they reflect the LOADED preset (the
  // display gating below reads them) and an edit routes through the local-edit path (dirty + save).
  const irMode7 = (useStore(pedalStore, (s) => s.values.irMode7) ?? 0) > 0;
  const irMode8 = (useStore(pedalStore, (s) => s.values.irMode8) ?? 0) > 0;
  const irGain7 = useStore(pedalStore, (s) => s.values.irGain7);
  const irGain8 = useStore(pedalStore, (s) => s.values.irGain8);
  const gainDbOf = (slot: 7 | 8): number => {
    const wire = slot === 7 ? irGain7 : irGain8;
    return wire === undefined ? 0 : valueToGainDb(wire);
  };
  const modes: UserIrModes = useMemo(() => ({ 7: irMode7, 8: irMode8 }), [irMode7, irMode8]);

  // Which record each of the eight rows resolves to for THIS preset — the shared selector, also used
  // by the editor's Tone Shaper. Everything below (labels, curves, the faint stack) reads from here, so
  // the page can't drift back into treating a position as if it were a record.
  const stackSources = useMemo(
    () => Array.from({ length: IR_SLOTS }, (_, i) => irSourceAt(raw, i + 1, modes)),
    [raw, modes],
  );
  const names = slotNames(stackSources, pulled);

  // Load cached curves on mount so we don't re-read the pedal every visit — Refresh re-pulls.
  useEffect(() => {
    void (async () => {
      const cached = await loadIrCache(pedalCacheKey());
      if (!cached) return;
      const next: Record<number, Pulled> = {};
      for (const [record, s] of Object.entries(cached)) {
        next[Number(record)] = { name: s.name, ir: s.samples, db: curveOf(s.samples) };
      }
      if (Object.keys(next).length > 0) {
        setPulled(next);
        setStatus(`Loaded ${Object.keys(next).length} cached cabs — Refresh to re-read the pedal.`);
      }
    })();
  }, []);

  /**
   * What a Pull reads. THE READ TRIGGER, decided in lab #58: reads stay explicit and user-initiated
   * (this button), never automatic. A `05 69` read is a ~3 s exclusive BLE window, so reading on every
   * recall would make preset browsing sluggish and reading on page-open would fire an unsolicited
   * multi-second burst mid-browse — the traffic pattern that has historically dropped the link.
   *
   * The targets are the eight library records 256–263 (the factory copies the rows proxy from) plus any
   * record the LOADED preset's enabled user slots point at, which is the only way a private per-preset
   * record's real curve enters the cache without an upload having just crafted it.
   */
  function pullTargets(): { record: number; a: number; b: number }[] {
    const out: { record: number; a: number; b: number }[] = [];
    for (let pos = 1; pos <= IR_SLOTS; pos++) {
      const [a, b] = IR_READ_AB[pos]!;
      out.push({ record: libraryRecordAt(pos), a, b });
    }
    for (const slot of USER_IR_SLOTS) {
      const src = irSourceAt(raw, slot, modes);
      if (src?.kind !== "played" || out.some((t) => t.record === src.record)) continue;
      out.push({ record: src.record, a: src.record >> 7, b: src.record & 0x7f });
    }
    return out;
  }

  async function pullFromPedal() {
    if (!getSession()) {
      setStatus("Connect to the pedal first.");
      return;
    }
    const targets = pullTargets();
    setPulling(true);
    setPullProg({ done: 0, total: targets.length });
    setStatus("Reading IRs from the pedal…");
    const next: Record<number, Pulled> = {};
    let lostLink = false;
    for (const [i, t] of targets.entries()) {
      // Re-fetch each read: if the link drops mid-read the session is nulled — bail instead of
      // hammering a dead session and silently blanking the remaining records.
      const session = getSession();
      if (!session) {
        lostLink = true;
        break;
      }
      const ir = await readIr(session, t.a, t.b);
      if (ir) {
        const samples = Float64Array.from(ir.samples);
        next[t.record] = { name: ir.name, ir: samples, db: curveOf(samples) };
      }
      setPullProg({ done: i + 1, total: targets.length });
      // Pace the reads so the back-to-back burst doesn't saturate the BLE TX (which was tripping a
      // transient drop). The reads bypass the request queue, so they aren't otherwise paced.
      if (i + 1 < targets.length) await new Promise((r) => setTimeout(r, 120));
    }
    // A full pull REPLACES the records it targeted (one that read empty is now genuinely empty) while
    // KEEPING records it never asked about — other presets' private IRs are still valid for them. A
    // pull cut short by a link loss also keeps the targets it never got to.
    const kept = { ...pulled };
    if (!lostLink) for (const t of targets) delete kept[t.record];
    const result = { ...kept, ...next };
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
    setStatus(pos === 0 ? "Off (flat)." : `Cab ${pos}: ${names[pos]}`);
  }

  // The blended curve at the current mic position (interpolated between the two neighbouring cabs),
  // through the shared selector: each endpoint is looked up by the RECORD this preset plays there. An
  // unread record answers null, so the graph draws nothing rather than another preset's cab.
  const stackDb = useMemo(
    () =>
      cabResponseAt(
        morph,
        irCurveAt(raw, modes, (r) => pulled[r]?.db),
        FLAT_DB,
      ),
    [morph, pulled, raw, modes],
  );

  // One faint curve per row — the records the eight rows currently resolve to, deduplicated. Keyed by
  // record, so a cache that has accumulated other presets' private IRs doesn't clutter the graph.
  const stackCurves: IrCurve[] = [
    ...[...new Set(stackSources.map((s) => s?.record))]
      .map((r) => (r === undefined ? undefined : pulled[r]?.db))
      .filter((db): db is number[] => db !== undefined)
      .map((db) => ({ db, color: toneColors.cab, width: 1, opacity: 0.22 })),
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
    // Turning a user slot ON makes the pedal fetch whatever record this preset's pointer names, with no
    // bounds check of its own — so an out-of-range pointer would convolve arbitrary flash at an
    // unpredictable level. 27 factory presets carry the unused default pair (64,64) = record 8256, which
    // is exactly that case; they are harmless only while their mode stays off. Refuse instead of
    // enabling. See {@link readIrPointer}. Turning a slot OFF is always safe — the pointer stops being
    // read at all — so the guard is one-directional.
    if (on) {
      const ptr = readIrPointer(pedalStore.getState().raw, slot);
      if (ptr?.kind === "invalid") {
        setStatus(
          `Slot ${slot} has no IR stored for this preset (record ${ptr.record}) — upload one first. ` +
            `Enabling it would play unstored data at an unpredictable level.`,
        );
        return;
      }
    }
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
  // The Studio preview is normalized to its own PEAK, not to the 700–1400 Hz reference band the
  // mic-stack rows use. That band is right for comparing speaker cabs, which all have energy there.
  // A crafted filter need not: a low-pass cornered below 700 Hz has that whole band inside its
  // STOPBAND, so referencing it lifted the passband far above 0 dB and pinned the lows to the top of
  // the graph — the preview was unreadable for exactly the filter it exists to preview (reported on
  // hardware 2026-08-17). Referencing the peak reads as "attenuation from the loudest point", which
  // is meaningful for every shape offered here.
  //
  // Safe to differ from the rows: this graph draws a single curve on its own axes, so the two scales
  // are never compared. It is display-only either way — the samples uploaded to the pedal are `craft`
  // itself, untouched by any of this.
  const craftDb = useMemo(
    () => frequencyResponse(craft, GRID, { sampleRate: rate, normalizePeak: true }),
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

  function useCabFromPedal(record: number, label: string) {
    const hit = pulled[record];
    if (!hit) {
      setStatus(`Pull the pedal first to load ${label}.`);
      return;
    }
    setCabA({ ir: hit.ir, rate: PEDAL_IR_RATE, name: hit.name || label });
    setCabB(null);
    setShowStudio(true);
    setStatus(`Loaded "${hit.name || label}" into the Studio — bake a filter, then upload.`);
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
      const { pointerConfirmed, otherSlotSurvived, otherSlot } = await uploadCustomIr(
        session,
        craft,
        irName().slice(0, 32),
        { slot: uploadSlot, program, blob },
      );
      // The save-as parks the pedal on the destination program; recall it so the app state reloads
      // from the SAVED preset (slot enabled, IR selected, pointer repointed) and nothing reads dirty.
      // It also tells us WHICH record the preset ended up pointing at, which is the cache key below.
      let recalled = false;
      try {
        const ctl = getController();
        if (ctl) {
          await ctl.recall(program);
          recalled = true;
        }
      } catch {
        /* recall is best-effort — if it drops, the preset is already saved; recall manually */
      }
      // THE INVALIDATION RULE (lab #58). An upload rewrites a record in place, so a record-keyed cache
      // can hold stale samples under a perfectly correct key. An upload only ever writes PRIVATE
      // records (banks 0/1 → below LIBRARY_RECORD_BASE; bank 2 is read-only to this app), so dropping
      // every private entry is sufficient and can't discard a library read. Then re-file the crafted
      // samples under the record the SAVED preset now points at — read from the recalled blob, so a
      // recall that failed files nothing rather than guessing. We never read the record back over MIDI:
      // a heavy read burst right after an upload is exactly the flaky BLE traffic to avoid.
      const samples = Float64Array.from(craft);
      const saved = recalled ? readIrPointer(pedalStore.getState().raw, uploadSlot) : null;
      const playedRecord = saved && saved.kind !== "invalid" ? saved.record : undefined;
      setPulled((p) => {
        const kept: Record<number, Pulled> = {};
        for (const [k, v] of Object.entries(p)) {
          if (Number(k) >= LIBRARY_RECORD_BASE) kept[Number(k)] = v;
        }
        if (playedRecord !== undefined) {
          kept[playedRecord] = { name: irName().slice(0, 32), ir: samples, db: curveOf(samples) };
        }
        persist(kept); // keep the on-disk cache in step with the newly-written flash
        return kept;
      });
      // The other slot losing its IR is worse news than the uploaded slot's pointer being unconfirmed,
      // so it wins the status line — it means something the user already had is gone, rather than
      // something they just made being fragile.
      setStatus(
        !otherSlotSurvived
          ? `Uploaded "${irName()}" → slot ${uploadSlot} of preset ${program + 1}, but slot ` +
              `${otherSlot}'s custom IR did NOT survive the save — re-upload it. Please report this.`
          : pointerConfirmed
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
          names={names}
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
          Rows 7 & 8 are yours: the switch picks this preset&apos;s own uploaded cab (on) or the
          factory cab (off), and the dB trims your cab&apos;s level. Each row is named by whatever
          the pedal has there, so flipping the switch renames the row. An upload only replaces your
          cab for THIS preset; the factory one always returns when the switch is off.
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
            {/* The eight rows' own records, not every record the cache happens to hold — a
                record-keyed cache also carries other presets' private IRs, which don't belong here. */}
            {stackSources.some((s) => s && pulled[s.record]) ? (
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
              >
                <Text style={{ color: theme.textDim, fontSize: 12 }}>Or a pulled cab:</Text>
                {stackSources.map((src, i) => {
                  const record = src?.record;
                  if (record === undefined || !pulled[record]) return null;
                  const label = names[i + 1] ?? slotFallback(i + 1);
                  return (
                    <Chip
                      key={i + 1}
                      label={label}
                      active={cabA?.name === (pulled[record].name || label)}
                      onPress={() => useCabFromPedal(record, label)}
                    />
                  );
                })}
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
                  label={`${s}: ${names[s] ?? slotFallback(s)}`}
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
