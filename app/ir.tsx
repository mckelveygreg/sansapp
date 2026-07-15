/**
 * IR page — one place for cabs. Pull the pedal's own factory + user IRs (05 69), show their real
 * curves, and select any of them live (0x0E). Then design a custom IR, three combinable ways:
 *   • Filter-only: high/low-pass, shelves, tilt, notch — the filter IS the IR.
 *   • Cab-based: take a pulled cab (or a loaded WAV), optionally blend a second, and bake the
 *     filter (e.g. a high-pass) INTO it.
 * The point of the last one: a real cab with a built-in high-pass, so you can drop the HPF pedal.
 *
 * Upload the result straight to a user slot (7/8) over MIDI — the IR encoding is verified
 * (src/protocol/irEncode), so no EliteControl / WAV round-trip is needed. We never ship Tech 21's
 * IRs: every curve here is read off the user's own pedal.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, useWindowDimensions, View } from "react-native";
import { IrGraph } from "../src/components/IrGraph";
import type { IrCurve } from "../src/components/IrGraph";
import { radius, theme } from "../src/components/theme";
import { blendIr, cascadeIr, generateIr, type IrGenKind } from "../src/dsp/generators";
import { frequencyResponse, logGrid } from "../src/dsp/ir";
import { useStore } from "zustand";
import { uploadCustomIr } from "../src/midi/bundleIo";
import { pickFileBytes, saveAndShare } from "../src/midi/exportFile";
import { USER_IR_SLOTS, readIrSlot } from "../src/midi/irRead";
import { sendParam } from "../src/midi/liveParam";
import { getSession, pedalStore } from "../src/midi/pedal";
import {
  USER_IR_GAIN,
  USER_IR_GAIN_DB_RANGE,
  USER_IR_MODE,
  gainDbToValue,
} from "../src/protocol/params";
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
const TAPS = 1000;

// The pedal exposes 8 IR slots (bank 0x02, b=0..7) — HARDWARE-CONFIRMED 2026-07-15 (see irRead.ts):
// 1–6 are FACTORY cabs, 7–8 are the USER slots (the only place custom IRs may be uploaded, each with
// its own gain). Before a pull we don't know a slot's name, so we label it generically; the pulled
// IR's own stored name (e.g. "SA_SPKR") wins once read.
const IR_SLOTS = 8;
// 1–6 are fixed factory cabs; the two writable slots are USER_IR_SLOTS (7/8). Note: 7/8 are NOT empty
// "user" scratch — most factory presets point their IR select at slot 7, so many presets share a cab
// there. Overwriting a writable slot changes the cab for every preset that uses it.
const slotFallback = (pos: number) => `IR ${pos}`;

interface Cab {
  ir: Float64Array;
  rate: number;
  name: string;
}

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

export default function IrStudio() {
  const { width } = useWindowDimensions();
  const [kind, setKind] = useState<IrGenKind>("highpass");
  const [fc, setFc] = useState(80);
  const [gainDb, setGainDb] = useState(6);
  const [qi, setQi] = useState(1);
  const [stages, setStages] = useState(2);
  const [cabA, setCabA] = useState<Cab | null>(null);
  const [cabB, setCabB] = useState<Cab | null>(null);
  const [blend, setBlend] = useState(50); // % toward cab B
  const [applyFilter, setApplyFilter] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const [pulled, setPulled] = useState<
    Record<number, { name: string; db: number[]; ir: Float64Array }>
  >({});
  const [pulling, setPulling] = useState(false);
  const [browse, setBrowse] = useState<number | null>(null);
  const [uploadSlot, setUploadSlot] = useState<7 | 8>(7);
  // Per-user-slot live gain (0x2a/0x2b), tracked in dB (−12..+12; ±12 confirmed). Sent as the 0..127
  // wire value. Local state — the pedal doesn't read it back cheaply.
  const [gainDbs, setGainDbs] = useState<Record<number, number>>({ 7: 0, 8: 0 });
  const setGain = (slot: 7 | 8, db: number) => {
    const clamped = Math.max(-USER_IR_GAIN_DB_RANGE, Math.min(USER_IR_GAIN_DB_RANGE, db));
    setGainDbs((g) => ({ ...g, [slot]: clamped }));
    sendParam(USER_IR_GAIN[slot]!, gainDbToValue(clamped));
  };
  // Per-preset "IR Mode" toggle (0x28/0x29): ON = this preset uses the slot's custom IR, OFF = its
  // normal IR. Live param, saved into the preset on the pedal's next save.
  const [modes, setModes] = useState<Record<number, boolean>>({ 7: false, 8: false });
  const setMode = (slot: 7 | 8, on: boolean) => {
    setModes((m) => ({ ...m, [slot]: on }));
    sendParam(USER_IR_MODE[slot]!, on ? 1 : 0);
  };

  // The pedal plays its 2400-sample IRs at a fixed rate we haven't pinned exactly (calibration TODO);
  // use a nominal rate so the pulled curve's SHAPE is right (x-axis Hz labels are approximate).
  const PEDAL_IR_RATE = 88200;
  // Pull every cab off the pedal (05 69) and compute its real curve — no shipped Tech 21 IRs.
  async function pullFromPedal() {
    const session = getSession();
    if (!session) {
      setStatus("Connect to the pedal first.");
      return;
    }
    setPulling(true);
    setStatus("Reading IRs from the pedal…");
    const next: Record<number, { name: string; db: number[]; ir: Float64Array }> = {};
    for (let pos = 1; pos <= IR_SLOTS; pos++) {
      const ir = await readIrSlot(session, pos);
      if (ir) {
        const samples = Float64Array.from(ir.samples);
        const db = frequencyResponse(samples, GRID, {
          sampleRate: PEDAL_IR_RATE,
          normalizeBand: [700, 1400],
        });
        next[pos] = { name: ir.name || slotFallback(pos), ir: samples, db };
      }
    }
    setPulled(next);
    setPulling(false);
    const n = Object.keys(next).length;
    setStatus(
      n ? `Pulled ${n} IR${n > 1 ? "s" : ""} from the pedal.` : "No IRs read (check the slot map).",
    );
  }

  // Select a cab live on the pedal (IR-select 0x0E, continuous: pos·16, 8→127). If we've pulled that
  // slot's IR, also load it as the design source so you can high-pass/blend it and re-upload.
  function selectSlot(pos: number) {
    sendParam(0x0e, Math.min(127, pos * 16));
    setBrowse(pos);
    const hit = pulled[pos];
    if (pos === 0) {
      setStatus("Selected Off (flat).");
      return;
    }
    if (hit) {
      setCabA({ ir: hit.ir, rate: PEDAL_IR_RATE, name: hit.name });
      setCabB(null);
      setStatus(
        `Selected "${hit.name}" — loaded as the cab source below. High-pass it, then upload.`,
      );
    } else {
      setStatus(`Selected slot ${pos}. Pull from pedal to load it as a design source.`);
    }
  }

  const def = TYPES.find((t) => t.kind === kind)!;
  const q = Q_STEPS[qi]!;
  // Design (and plot) the filter at the loaded cab's sample rate — factory cabs are 48 kHz, so a
  // filter designed at the 44.1 kHz default would land its corner ~8.8% high once baked into a
  // 48 kHz IR. No cab loaded → filter-only export defaults to 44.1 kHz.
  const rate = cabA?.rate ?? 44100;

  const filterIr = useMemo(
    () => generateIr(kind, { fc, gainDb, q, stages, taps: TAPS, sampleRate: rate }),
    [kind, fc, gainDb, q, stages, rate],
  );

  // Result = [cab A, or A⇄B blend, or (no cab) the filter itself] with the filter optionally baked in.
  const result = useMemo(() => {
    let base: Float64Array | null = null;
    if (cabA && cabB) base = blendIr(cabA.ir, cabB.ir, blend / 100);
    else if (cabA) base = cabA.ir;
    if (!base) return filterIr; // filter-only mode
    return applyFilter ? cascadeIr(base, filterIr, TAPS) : Float64Array.from(base);
  }, [cabA, cabB, blend, applyFilter, filterIr]);

  const db = useMemo(
    () => frequencyResponse(result, GRID, { sampleRate: rate, normalizeBand: [700, 1400] }),
    [result, rate],
  );
  // Amber = the IR you're designing. If a pulled pedal cab is selected, overlay its real curve (dim).
  const browsed = browse != null ? pulled[browse] : undefined;
  const curves: IrCurve[] = browsed
    ? [
        { db: browsed.db, color: theme.textDim, width: 1.6 },
        { db, color: theme.amber, width: 2.6 },
      ]
    : [{ db, color: theme.amber, width: 2.6 }];
  const graphW = width - 32 - 18;

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

  function irName() {
    const tag = cabA ? cabA.name : kind;
    const suffix = applyFilter || !cabA ? `-${kind}${fc}Hz` : "";
    return `SansApp-${tag}${suffix}`.replace(/\s+/g, "_");
  }

  async function onExport() {
    try {
      await saveAndShare(`${irName()}.wav`, encodeWav(floatToPcm(result), rate), "audio/wav");
      setStatus(`Exported ${irName()}.wav`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  // Generate + upload this IR straight to the pedal over MIDI — no EliteControl, no WAV round-trip.
  // Unlocked by implementing the IR encoding + wire checksum (src/protocol/irEncode). Hardware-verified:
  // the upload lands in the chosen library slot (addressed in the frame header). Uploading OVERWRITES
  // that slot's IR.
  async function onUpload() {
    const session = getSession();
    if (!session) {
      setStatus("Connect to the pedal first.");
      return;
    }
    try {
      setStatus(`Uploading IR to slot ${uploadSlot}…`);
      await uploadCustomIr(session, result, irName().slice(0, 32), {
        slot: uploadSlot,
        save: true,
      });
      setStatus(`Uploaded "${irName()}" → IR slot ${uploadSlot} (saved).`);
    } catch (e) {
      setStatus(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stepFc = (d: number) =>
    setFc((v) => Math.round(Math.max(30, Math.min(8000, v * 2 ** (d / 6)))));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
        Pull your pedal's own cabs to browse and audition them, or design a new IR below — bake a
        high-pass into a cab, blend two cabs, or build a filter from scratch — then upload it to one
        of the pedal's IR slots (7/8 writable) over MIDI. The graph is the real response.
      </Text>

      {/* CABS — pulled from the pedal (we never ship Tech 21's IRs) */}
      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
          gap: 10,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>
            CABS ON PEDAL
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
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip label="Off" active={browse === 0} onPress={() => selectSlot(0)} />
          {Array.from({ length: IR_SLOTS }, (_, i) => i + 1).map((pos) => (
            <Chip
              key={pos}
              label={pulled[pos]?.name ?? slotFallback(pos)}
              active={browse === pos}
              onPress={() => selectSlot(pos)}
            />
          ))}
        </View>
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
          {ready
            ? Object.keys(pulled).length
              ? "Tap a cab to load it on the pedal — its real curve overlays the graph below, and it becomes the design source."
              : "Pull to read each cab off the pedal and show its real curve (nothing is shipped with the app). Tap a slot to select it live."
            : "Connect to the pedal to pull and audition its cabs."}
        </Text>
      </View>

      {/* CAB SOURCE */}
      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
          gap: 10,
        }}
      >
        <Text style={{ color: theme.text, fontWeight: "700", letterSpacing: 0.5 }}>CAB SOURCE</Text>
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
        {cabA && cabB ? (
          <Stepper
            label="BLEND A↔B"
            value={`${100 - blend}% / ${blend}%`}
            onStep={(d) => setBlend((v) => Math.max(0, Math.min(100, v + d * 10)))}
          />
        ) : null}
        {cabA ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch
              value={applyFilter}
              onValueChange={setApplyFilter}
              trackColor={{ false: theme.panelEdge, true: theme.accent }}
              thumbColor="#fff"
            />
            <Text style={{ color: theme.textDim, fontSize: 12 }}>
              Bake the filter below into the cab
            </Text>
          </View>
        ) : (
          <Text style={{ color: theme.textDim, fontSize: 12 }}>
            No cab loaded — the filter below is the IR. Load a cab to high-pass/blend it instead.
          </Text>
        )}
      </View>

      {/* GRAPH */}
      <View
        style={{
          backgroundColor: theme.bg,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 8,
        }}
      >
        <IrGraph grid={GRID} curves={curves} width={graphW} height={190} dbTop={18} dbBot={-42} />
      </View>

      {/* FILTER */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {TYPES.map((t) => (
          <Chip
            key={t.kind}
            label={t.label}
            active={t.kind === kind}
            onPress={() => setKind(t.kind)}
          />
        ))}
      </View>
      <View
        style={{
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
          gap: 14,
        }}
      >
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
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>Q</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {Q_STEPS.map((qq, i) => (
                <Chip key={qq} label={qq.toFixed(1)} active={i === qi} onPress={() => setQi(i)} />
              ))}
            </View>
          </View>
        ) : null}
        {def.slope ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>SLOPE</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Chip label="12 dB/oct" active={stages === 1} onPress={() => setStages(1)} />
              <Chip label="24 dB/oct" active={stages === 2} onPress={() => setStages(2)} />
            </View>
          </View>
        ) : null}
      </View>

      {/* Custom IRs only go to the two WRITABLE slots (7/8); 1–6 are fixed factory cabs. Each writable
          slot has its own live gain (0x2a/0x2b), shown in dB (±12, confirmed). */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>UPLOAD TO</Text>
        {USER_IR_SLOTS.map((s) => (
          <Chip
            key={s}
            label={pulled[s]?.name ? `${s}: ${pulled[s]!.name}` : `Slot ${s}`}
            active={uploadSlot === s}
            onPress={() => setUploadSlot(s)}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: theme.textDim, fontSize: 12, letterSpacing: 1 }}>
          USE SLOT {uploadSlot} (this preset)
        </Text>
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
        Slots 7 & 8 hold custom cabs shared across presets; the toggle above is per-preset — off
        uses this preset's normal IR, on uses the custom cab. Uploading replaces the shared cab
        data.
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
          <Text style={{ color: "#fff", fontWeight: "700" }}>
            Upload to pedal ▸ slot {uploadSlot}
          </Text>
        </Pressable>
        <Pressable
          onPress={onExport}
          style={{
            flex: 1,
            backgroundColor: theme.panel,
            borderColor: theme.panelEdge,
            borderWidth: 1,
            padding: 14,
            borderRadius: radius,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.text, fontWeight: "700" }}>Export .wav</Text>
        </Pressable>
      </View>
      {status ? (
        <Text style={{ color: theme.textDim, fontSize: 12, textAlign: "center" }}>{status}</Text>
      ) : null}

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
          {TAPS}-tap IR. To HPF one of your cabs: Pull from pedal → tap the cab (loads it as the
          source) → High-pass → set the frequency → pick a target slot → Upload. Export .wav if
          you'd rather keep a copy. Below ~45 Hz the tap budget limits steepness.
        </Text>
      </View>
    </ScrollView>
  );
}
