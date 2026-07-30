/**
 * Device Settings — the pedal's Special Page Functions, matching EliteControl's layout.
 *
 * Byte→function map (src/protocol/settings.ts) was documented from a capture on
 * 2026-07-04. When connected, this reads the pedal's settings block on mount and writes changes
 * back (05 52 block write → 05 53 ack) — modifying only the changed byte so unknown bytes are
 * preserved. RN app surface.
 */
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useStore } from "zustand";
import { radius, theme } from "../src/components/theme";
import { downloadManual, manualLocalUri, MANUAL_URL, openManual } from "../src/manual";
import {
  SETTINGS_BLOCK,
  SPECIAL_FUNCTIONS,
  TUNER_DETUNE,
  tunerHz,
  withSetting,
  type SpecialFunction,
} from "../src/protocol/settings";
import { getSession, pedalStore } from "../src/midi/pedal";

function Row({
  label,
  desc,
  tentative,
  children,
}: {
  label: string;
  desc: string;
  tentative?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontWeight: "600" }}>
          {label}
          {tentative ? <Text style={{ color: theme.amber }}> ?</Text> : null}
        </Text>
        <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 2 }}>{desc}</Text>
      </View>
      {children}
    </View>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ false: theme.panelEdge, true: theme.accent }}
      thumbColor="#ffffff"
    />
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: 8,
      }}
    >
      {options.map((opt, i) => {
        const active = i === value;
        return (
          <Text
            key={opt}
            onPress={() => onChange(i)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              color: active ? "#fff" : theme.textDim,
              backgroundColor: active ? theme.accent : "transparent",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {opt}
          </Text>
        );
      })}
    </View>
  );
}

function Stepper({
  value,
  min,
  max,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const step = (d: number) => onChange(Math.max(min, Math.min(max, value + d)));
  const Btn = ({ label, d }: { label: string; d: number }) => (
    <Pressable
      onPress={() => step(d)}
      style={{
        width: 34,
        height: 34,
        borderRadius: 8,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.text, fontSize: 18 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Btn label="−" d={-1} />
      <Text
        style={{ color: theme.text, width: 62, textAlign: "center", fontVariant: ["tabular-nums"] }}
      >
        {format(value)}
      </Text>
      <Btn label="+" d={1} />
    </View>
  );
}

/** Owner's-manual card: fetch Tech 21's public PDF on demand + cache it on-device for offline use. */
function ManualCard() {
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const web = Platform.OS === "web";

  useEffect(() => {
    void manualLocalUri().then(setUri);
  }, []);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      setUri(await downloadManual());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const primary = web
    ? { label: "Open official manual", onPress: () => void Linking.openURL(MANUAL_URL) }
    : uri
      ? { label: "Open manual", onPress: () => void openManual(uri) }
      : { label: busy ? "Downloading…" : "Download for offline", onPress: () => void download() };

  return (
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
      <View>
        <Text style={{ color: theme.text, fontWeight: "700" }}>Owner&apos;s Manual</Text>
        <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 2, lineHeight: 17 }}>
          {web
            ? "Opens Tech 21's official PDF."
            : uri
              ? "Saved on this device for offline use."
              : "Fetches Tech 21's official PDF and saves it on-device for offline use."}
        </Text>
      </View>
      <Pressable
        onPress={primary.onPress}
        disabled={busy}
        style={{
          backgroundColor: theme.accent,
          borderRadius: radius,
          paddingVertical: 11,
          alignItems: "center",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>{primary.label}</Text>
      </Pressable>
      {!web && uri ? (
        <Pressable onPress={() => void download()} disabled={busy}>
          <Text style={{ color: theme.textDim, fontSize: 12, textAlign: "center" }}>
            Re-download
          </Text>
        </Pressable>
      ) : null}
      {err ? <Text style={{ color: theme.amber, fontSize: 12 }}>{err}</Text> : null}
      <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 15 }}>
        Hosted by Tech 21. sansApp is unofficial and not affiliated with or endorsed by Tech 21.
      </Text>
    </View>
  );
}

// Initial values from the captured settings block (final state).
const INITIAL: Record<string, number> = {
  patchOffset: 1,
  midiMapping: 1,
  midiThru: 1,
  midiCcMode: 0, // off4, off by default
  safeLevelMode: 0, // off17, off by default
  disengagePots: 1,
  presetProtection: 0,
  cabinetBypass: 1,
  midiChannel: 2,
  tunerFreq: 0x11,
  tunerDetune: 2,
};

export default function Device() {
  const ready = useStore(pedalStore, (s) => s.connection) === "ready";
  const [vals, setVals] = useState<Record<string, number>>(INITIAL);
  const [status, setStatus] = useState<string | null>(null);
  // The pedal's current settings block (256 B). A write sends the WHOLE block, so we start from
  // the real one and change a single byte — never clobbering the bytes we don't understand.
  const block = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (!ready) return;
    const session = getSession();
    if (!session) return;
    let live = true;
    void session
      .readBlock(0x55, SETTINGS_BLOCK)
      .then((b) => {
        if (!live) return;
        block.current = b;
        setVals(Object.fromEntries(SPECIAL_FUNCTIONS.map((fn) => [fn.id, b[fn.offset] ?? 0])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready]);

  const set = (fn: SpecialFunction, v: number) => {
    const prevVal = vals[fn.id] ?? 0;
    const prevBlock = block.current;
    setVals((s) => ({ ...s, [fn.id]: v }));
    if (!ready || !prevBlock) return;
    const session = getSession();
    if (!session) return;
    const next = withSetting(prevBlock, fn.offset, v);
    block.current = next; // optimistic — each further toggle builds on this
    setStatus(null);
    void session.writeBlock(0x52, SETTINGS_BLOCK, next).catch((e: unknown) => {
      // The write failed — REVERT the optimistic block byte + UI. Otherwise the local block silently
      // diverges from the pedal and every later toggle compounds the change onto bytes it never took.
      block.current = prevBlock;
      setVals((s) => ({ ...s, [fn.id]: prevVal }));
      setStatus(`Couldn't save "${fn.label}" — ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const control = (fn: SpecialFunction): ReactNode => {
    const v = vals[fn.id] ?? 0;
    if (fn.kind === "toggle")
      return <Toggle value={v !== 0} onChange={(on) => set(fn, on ? 1 : 0)} />;
    if (fn.kind === "channel")
      return (
        <Stepper
          value={v}
          min={0}
          max={16}
          format={(n) => (n === 0 ? "OMNI" : `Ch ${n}`)}
          onChange={(n) => set(fn, n)}
        />
      );
    if (fn.kind === "tunerFreq")
      return (
        <Stepper
          value={v}
          min={2}
          max={22}
          format={(n) => `${tunerHz(n)} Hz`}
          onChange={(n) => set(fn, n)}
        />
      );
    return <Segmented options={TUNER_DETUNE} value={v} onChange={(n) => set(fn, n)} />;
  };

  const descOf = (fn: SpecialFunction): string =>
    fn.kind === "toggle" && fn.options
      ? `${fn.options[0]} / ${fn.options[1]}`
      : `mapped byte ${fn.offset}`;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <ManualCard />

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
          The pedal's Special Page Functions.{" "}
          {ready
            ? "Live — changes write to the pedal (only the changed byte; the rest of the block is preserved)."
            : "Connect to read and write these."}
        </Text>
      </View>

      {status ? (
        <Text style={{ color: theme.amber, fontSize: 12, lineHeight: 18 }}>{status}</Text>
      ) : null}

      {SPECIAL_FUNCTIONS.map((fn) => (
        <Row
          key={fn.id}
          label={fn.label}
          desc={descOf(fn)}
          tentative={fn.confidence === "tentative"}
        >
          {control(fn)}
        </Row>
      ))}
    </ScrollView>
  );
}
