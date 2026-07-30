/**
 * Backup & Restore — export all presets to a `.p3b` (byte-compatible with EliteControl's
 * "Export All Presets") and restore one back to the pedal. RN app surface.
 */
import { Link } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useStore } from "zustand";
import { radius, theme } from "../src/components/theme";
import { exportPresetsBundle, restoreBundle } from "../src/midi/bundleIo";
import { pickFileBytes } from "../src/midi/exportFile";
import { getSession, pedalStore } from "../src/midi/pedal";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 16,
        gap: 10,
      }}
    >
      <Text style={{ color: theme.text, fontWeight: "700" }}>{title}</Text>
      {children}
    </View>
  );
}

function Button({
  label,
  color,
  disabled,
  onPress,
}: {
  label: string;
  color: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? theme.panelEdge : color,
        padding: 13,
        borderRadius: radius,
        alignItems: "center",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text style={{ color: "#fff", fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

export default function Backup() {
  const connection = useStore(pedalStore, (s) => s.connection);
  const ready = connection === "ready";
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onExport() {
    const session = getSession();
    if (!session) return;
    setBusy(true);
    setMsg("Reading presets… 0/128");
    try {
      const n = await exportPresetsBundle(session, (done) =>
        setMsg(`Reading presets… ${done}/128`),
      );
      setMsg(`Exported ${n} presets to SansApp-backup.p3b`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onRestore() {
    Alert.alert(
      "Restore presets?",
      "This overwrites the presets on your pedal with the ones in the file. This can't be undone — back up first.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Restore", style: "destructive", onPress: () => void doRestore() },
      ],
    );
  }

  async function doRestore() {
    const session = getSession();
    if (!session) return;
    setBusy(true);
    setMsg("Choosing file…");
    try {
      const picked = await pickFileBytes();
      if (!picked) {
        setMsg(null);
        return;
      }
      setMsg(`Restoring ${picked.name}…`);
      const r = await restoreBundle(session, picked.bytes, (done, total) =>
        setMsg(`Restoring… ${done}/${total}`),
      );
      setMsg(
        `Restored ${r.presets} presets${r.irs ? ` + ${r.irs} IRs` : ""}` +
          (r.failed ? ` · ${r.failed} failed — reconnect and restore again to retry` : "") +
          (r.skipped ? ` · ${r.skipped} skipped (not a writable slot)` : ""),
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
        Save every preset to a `.p3b` file you can keep, share, or import in EliteControl — and
        restore one back to the pedal. Same format as the desktop editor's Export/Import All
        Presets.
      </Text>

      {!ready ? (
        <Link href="/connect" asChild>
          <Pressable
            style={{
              backgroundColor: theme.panel,
              borderColor: theme.amber,
              borderWidth: 1,
              borderRadius: radius,
              padding: 14,
            }}
          >
            <Text style={{ color: theme.text }}>Connect to the pedal first →</Text>
          </Pressable>
        </Link>
      ) : null}

      <Card title="Back up">
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
          Reads all 128 presets and exports a `.p3b`. IRs are a shared library on the pedal, not
          part of a preset — browse, design and upload them on the IR page.
        </Text>
        <Button
          label="Export all presets (.p3b)"
          color={theme.green}
          disabled={!ready || busy}
          onPress={onExport}
        />
      </Card>

      <Card title="Restore">
        <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
          Writes presets from a `.p3b` back to the pedal (and replays any IR data the file
          contains). Overwrites current presets.
        </Text>
        <Button
          label="Restore from .p3b…"
          color={theme.accent}
          disabled={!ready || busy}
          onPress={onRestore}
        />
      </Card>

      {msg ? (
        <Text style={{ color: theme.textDim, fontSize: 12, textAlign: "center" }}>{msg}</Text>
      ) : null}
    </ScrollView>
  );
}
