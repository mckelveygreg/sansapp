/**
 * Persist the IRs pulled off the pedal so the IR page doesn't re-read them (a slow BLE round-trip
 * each) on every visit. Stored as JSON in the app's document directory. RN app surface
 * (expo-file-system).
 *
 * ## Keyed by RECORD number — never by selector position
 *
 * The pedal addresses an IR by a flat 14-bit **record** number (`readIr(session, msb, lsb)`), and a
 * preset's slot 7/8 plays whatever record *its own* pointer names — records 256–263 are the shared
 * library, 0–255 the private per-preset store at `bank·128 + program` (see
 * `src/protocol/irPointer.ts`; `src/protocol/irSelect.ts` maps a selector position to the record to
 * look up here).
 *
 * Keying by selector **position** instead was the cross-preset leak in sansapp#68: this file holds one
 * entry per position, global across presets, so whatever was last pulled into position 7 rendered on
 * every preset whose IR Mode 7 was on — one preset's uploaded cab shown on ~90 others. A record key
 * cannot alias two presets, because two presets with different IRs point at different records.
 *
 * (An earlier version of this note claimed the cache stays fresh because "factory slots (1–6) never
 * change and user slots (7/8) are re-saved after an upload". That was the position model. Records
 * 256–263 are indeed only rewritten by a Pull, but a private record's *number* outlives its contents —
 * see below.)
 *
 * ## Version 2 = the re-key, and there is no migration
 *
 * A v1 file's keys are positions 1–8, which are indistinguishable from records 1–8 — real private
 * records. So a v1 file cannot be reinterpreted, only discarded: {@link loadIrCache} already drops any
 * file whose `version` doesn't match, which costs the user one Pull.
 *
 * ## Staleness rule
 *
 * A record keeps its number when its contents are rewritten, so the right key can still hold the
 * wrong samples. Only an IR upload writes, and it only ever writes **private** records (banks 0/1 —
 * bank 2 is read-only to this app, see `irRead.ts`), and the uploader knows the samples it sent. So
 * the rule the IR page applies after an upload is: drop every private record from the cache, then
 * re-file the crafted samples under the record the saved preset now points at. Library records are
 * left alone.
 *
 * ## One pedal at a time
 *
 * Record numbers are only meaningful for the pedal they were pulled from — record 260 on another Elite
 * holds that pedal's cab. So the file records the OWNER's serial (`src/protocol/identity.ts`) and a load
 * for a different pedal discards it rather than showing the wrong cabs, costing one Pull. Unlike the
 * preset-name cache this keeps a single pedal's worth: 2,400 samples per record is far too big to hoard
 * a device map of.
 */
import { Platform } from "react-native";

const FILE = "ir-cache.json";
/** 2 = keyed by IR record number. 1 was keyed by selector position; see the module header. */
const VERSION = 2;

/** IR record number → cab name + impulse samples in [-1, 1] (the pedal's 2400-sample IR). */
type IrRecords = Record<number, { name: string; samples: Float64Array }>;

interface CacheFile {
  version: number;
  /** Serial of the pedal these records came from; absent in files written before it was recorded. */
  serial?: string | null;
  records: Record<number, { name: string; samples: number[] }>;
}

/** Save the pulled IRs, keyed by record, tagged with the pedal they came from. Best-effort; no-op on web. */
export async function saveIrCache(records: IrRecords, serial: string | null): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const data: CacheFile = { version: VERSION, serial, records: {} };
    for (const [record, s] of Object.entries(records)) {
      data.records[Number(record)] = { name: s.name, samples: Array.from(s.samples) };
    }
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(new TextEncoder().encode(JSON.stringify(data)));
  } catch {
    // a write failure just means the next visit re-pulls
  }
}

/**
 * Load cached IRs by record, or null if none / unreadable / stale version / another pedal's. Pass the
 * connected pedal's serial; null (nothing connected yet, or a pedal that didn't report one) accepts
 * whatever is cached — the same best-effort behavior as before serials were recorded.
 */
export async function loadIrCache(serial: string | null): Promise<IrRecords | null> {
  if (Platform.OS === "web") return null;
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as CacheFile;
    if (parsed.version !== VERSION || !parsed.records) return null;
    // Known to belong to a DIFFERENT pedal: its record numbers name that pedal's cabs, so showing them
    // here would be the cross-pedal version of the sansapp#68 leak. An untagged file is adopted.
    if (parsed.serial && serial && parsed.serial !== serial) return null;
    const out: IrRecords = {};
    for (const [record, s] of Object.entries(parsed.records)) {
      out[Number(record)] = { name: s.name, samples: Float64Array.from(s.samples) };
    }
    return out;
  } catch {
    return null;
  }
}
