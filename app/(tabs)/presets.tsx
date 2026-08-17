/**
 * Preset browser — tap to recall; long-press for a menu: copy to another slot, export to a
 * `.p3b` file, or import a preset from a file. Sync names from the pedal. Blob-level (no offset
 * map needed). RN app surface (tsconfig.json), not the Node core.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useStore } from "zustand";
import { readAllPresets, readPresets } from "../../src/device/library";
import { radius, theme } from "../../src/components/theme";
import { recallWithUnsavedGuard } from "../../src/components/unsavedGuard";
import { exportPreset, importPresetInto } from "../../src/midi/bundleIo";
import { pickFileBytes } from "../../src/midi/exportFile";
import {
  cachedPresetChecksums,
  copyPreset,
  getSession,
  invalidateSlotChecksum,
  noteSlotChecksum,
  pedalStore,
  renamePreset,
  saveCurrentTo,
  swapPresets,
} from "../../src/midi/pedal";
import { presetChecksum, staleSlots } from "../../src/protocol/identity";
import { PRESET_SLOT_COUNT } from "../../src/protocol/constants";

export default function Presets() {
  const slot = useStore(pedalStore, (s) => s.slot);
  const connection = useStore(pedalStore, (s) => s.connection);
  const names = useStore(pedalStore, (s) => s.names); // cached in the store; survives tab switches
  const [progress, setProgress] = useState<number | null>(null);
  /** How many slots the sync in progress is reading — 128 for a full sync, fewer for a delta. */
  const [total, setTotal] = useState(PRESET_SLOT_COUNT);
  const [pending, setPending] = useState<{ kind: "copy" | "swap"; from: number } | null>(null);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const ready = connection === "ready";

  // Run a library op with a status message, catching errors into the same line.
  async function run(op: () => Promise<void>, okMsg: string) {
    try {
      await op();
      setMsg(okMsg);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function onLongPress(item: number) {
    if (!ready) return;
    Alert.alert(
      names[item] ? `Preset ${item + 1} · ${names[item]}` : `Preset ${item + 1}`,
      undefined,
      [
        { text: "Save current sound here…", onPress: () => confirmSave(item) },
        { text: "Rename…", onPress: () => doRename(item) },
        { text: "Copy to another slot…", onPress: () => setPending({ kind: "copy", from: item }) },
        {
          text: "Swap with another slot…",
          onPress: () => setPending({ kind: "swap", from: item }),
        },
        { text: "Export to file…", onPress: () => void doExport(item) },
        { text: "Import from file…", style: "destructive", onPress: () => void doImport(item) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  function confirmSave(item: number) {
    Alert.alert(
      "Save current sound?",
      `Overwrite slot ${item + 1} with the pedal's current (edited) sound?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          style: "destructive",
          onPress: () =>
            void run(() => saveCurrentTo(item), `Saved current sound → slot ${item + 1}`),
        },
      ],
    );
  }

  function doRename(item: number) {
    Alert.prompt(
      "Rename preset",
      `New name for slot ${item + 1}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rename",
          onPress: (text?: string) => {
            const name = text?.trim();
            if (name)
              void run(() => renamePreset(item, name), `Renamed slot ${item + 1} → ${name}`);
          },
        },
      ],
      "plain-text",
      names[item] ?? "",
    );
  }

  async function doExport(item: number) {
    const session = getSession();
    if (!session) return;
    try {
      setMsg(`Exporting preset ${item + 1}…`);
      await exportPreset(session, item);
      setMsg(`Exported preset ${item + 1}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function doImport(item: number) {
    Alert.alert("Import preset?", `Overwrite slot ${item + 1} with a preset from a file?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Choose file",
        style: "destructive",
        onPress: () => {
          void (async () => {
            const session = getSession();
            if (!session) return;
            try {
              const picked = await pickFileBytes();
              if (!picked) return;
              await importPresetInto(session, item, picked.bytes);
              invalidateSlotChecksum(item); // that slot's contents are no longer what we cached
              setMsg(`Imported ${picked.name} → slot ${item + 1}`);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            }
          })();
        },
      },
    ]);
  }

  const slots = Array.from({ length: 128 }, (_, i) => i).filter((i) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return String(i + 1).includes(q) || (names[i]?.toLowerCase().includes(q) ?? false);
  });

  /** Read every slot off the pedal and replace the cached names wholesale (~35 s over Bluetooth). */
  const fullSync = useCallback(async () => {
    const session = getSession();
    if (!session) return;
    setProgress(0);
    setTotal(PRESET_SLOT_COUNT);
    // try/finally so a mid-sync failure (a dropped BLE reply that even the per-slot retry can't
    // recover) can't wedge the button at "Reading… N/128" or leave `void fullSync()` rejecting
    // unhandled. The error surfaces on the status line; progress always clears.
    try {
      const all = await readAllPresets(session, (done) => setProgress(done));
      const map: Record<number, string> = {};
      for (const { slot: s, preset } of all) {
        map[s] = preset.name?.trim() || `Preset ${s + 1}`;
        noteSlotChecksum(s, presetChecksum(preset.raw));
      }
      pedalStore.getState().setNames(map); // cache in the store (shared with the Editor, across tabs)
      setMsg("Synced names from the pedal.");
    } catch (e) {
      setMsg(`Couldn't sync names — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
    }
  }, []);

  /**
   * Bring the cached names up to date using the pedal's own per-preset checksum table: one 256-byte
   * read says which slots changed since we cached them, and only those are re-read. A pedal whose bank
   * hasn't been touched costs a single read instead of 128 (~35 s over Bluetooth).
   *
   * Falls back to a full sync when the pedal didn't give us a table (a dropped or corrupt handshake
   * read) or when nothing is cached yet.
   */
  const deltaSync = useCallback(async () => {
    const session = getSession();
    if (!session) return;
    const table = session.presetChecksums;
    const cached = cachedPresetChecksums();
    if (!table || Object.keys(cached).length === 0) {
      await fullSync();
      return;
    }
    const stale = staleSlots(table, cached);
    if (stale.length === 0) return; // the cached bank already matches the pedal
    setProgress(0);
    setTotal(stale.length);
    try {
      const read = await readPresets(session, stale, (done) => setProgress(done));
      const map = { ...pedalStore.getState().names };
      for (const { slot: s, preset } of read) {
        map[s] = preset.name?.trim() || `Preset ${s + 1}`;
        noteSlotChecksum(s, presetChecksum(preset.raw));
      }
      pedalStore.getState().setNames(map);
      setMsg(
        `Updated ${stale.length} preset${stale.length === 1 ? "" : "s"} changed on the pedal.`,
      );
    } catch (e) {
      setMsg(`Couldn't update names — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
    }
  }, [fullSync]);

  // Reconcile with the pedal once per connection. This used to run only when NOTHING was cached, so a
  // preset renamed at the pedal showed its old name forever; the checksum table makes reconciling cheap
  // enough to do on every connect.
  const autoSynced = useRef(false);
  useEffect(() => {
    if (!ready) {
      autoSynced.current = false;
      return;
    }
    if (!autoSynced.current) {
      autoSynced.current = true;
      void deltaSync();
    }
  }, [ready, deltaSync]);

  function onRowPress(item: number) {
    if (pending == null) {
      // Guard the switch: if the current sound has unsaved edits, prompt Save / Discard / Stay first.
      recallWithUnsavedGuard(item);
      return;
    }
    const { kind, from } = pending;
    setPending(null);
    if (from === item) return;
    if (kind === "copy") {
      Alert.alert("Copy preset", `Overwrite slot ${item + 1} with preset ${from + 1}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Overwrite",
          style: "destructive",
          onPress: () => void run(() => copyPreset(from, item), `Copied ${from + 1} → ${item + 1}`),
        },
      ]);
    } else {
      Alert.alert("Swap presets", `Swap slot ${from + 1} with slot ${item + 1}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Swap",
          onPress: () =>
            void run(() => swapPresets(from, item), `Swapped ${from + 1} ↔ ${item + 1}`),
        },
      ]);
    }
  }

  return (
    <View style={{ flex: 1, padding: 12 }}>
      {pending != null ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: theme.panel,
            borderColor: theme.accent,
            borderWidth: 1,
            borderRadius: radius,
            padding: 12,
            marginBottom: 10,
          }}
        >
          <Text style={{ color: theme.text }}>
            {pending.kind === "copy" ? "Copying" : "Swapping"} preset {pending.from + 1} — tap a{" "}
            {pending.kind === "copy" ? "destination" : "slot to swap with"}
          </Text>
          <Pressable onPress={() => setPending(null)}>
            <Text style={{ color: theme.accent, fontWeight: "700" }}>✕</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={fullSync}
          disabled={!ready || progress != null}
          style={{
            backgroundColor: ready ? theme.panel : theme.bg,
            borderColor: theme.panelEdge,
            borderWidth: 1,
            borderRadius: radius,
            padding: 12,
            alignItems: "center",
            marginBottom: 10,
            opacity: ready ? 1 : 0.5,
          }}
        >
          <Text style={{ color: theme.text }}>
            {progress != null ? `Reading… ${progress}/${total}` : "Sync names from pedal"}
          </Text>
        </Pressable>
      )}

      {msg ? (
        <Text style={{ color: theme.textDim, fontSize: 12, marginBottom: 8 }}>{msg}</Text>
      ) : null}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by number or name…"
        placeholderTextColor={theme.textDim}
        style={{
          color: theme.text,
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          paddingHorizontal: 12,
          paddingVertical: 10,
          marginBottom: 10,
        }}
      />

      <Text style={{ color: theme.textDim, fontSize: 11, marginBottom: 8, lineHeight: 16 }}>
        Slots 1–3 (P1–P3) are your Performance-mode presets — the pedal&apos;s three footswitch
        programs. Long-press any slot to save the current sound here, rename, copy, or swap.
      </Text>

      <FlatList
        data={slots}
        keyExtractor={(n) => String(n)}
        ListEmptyComponent={
          <Text style={{ color: theme.textDim, textAlign: "center", marginTop: 24 }}>
            No presets match “{query}”.
          </Text>
        }
        renderItem={({ item }) => {
          const active = item === slot;
          const isSource = item === pending?.from;
          return (
            <Pressable
              onPress={() => onRowPress(item)}
              onLongPress={() => onLongPress(item)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 12,
                paddingHorizontal: 12,
                borderRadius: radius,
                backgroundColor: active || isSource ? theme.panel : "transparent",
                borderColor: isSource ? theme.accent : active ? theme.panelEdge : "transparent",
                borderWidth: 1,
              }}
            >
              <Text style={{ color: theme.textDim, width: 34, fontVariant: ["tabular-nums"] }}>
                {item + 1}
              </Text>
              {item < 3 ? (
                <View
                  style={{
                    backgroundColor: theme.accent,
                    borderRadius: 4,
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>
                    P{item + 1}
                  </Text>
                </View>
              ) : null}
              <Text style={{ color: theme.text, flex: 1 }}>{names[item] ?? "—"}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
