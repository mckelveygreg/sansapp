/**
 * Persist the IRs pulled off the pedal so the IR page doesn't re-read them (a slow BLE round-trip
 * per slot) on every visit. Stored as JSON in the app's document directory; factory slots (1–6)
 * never change and user slots (7/8) are re-saved after an upload. RN app surface (expo-file-system).
 */
import { Platform } from "react-native";

const FILE = "ir-cache.json";
const VERSION = 1;

/** slot → cab name + impulse samples in [-1, 1] (the pedal's 2400-sample IR). */
type IrSlots = Record<number, { name: string; samples: Float64Array }>;

interface CacheFile {
  version: number;
  slots: Record<number, { name: string; samples: number[] }>;
}

/** Save the pulled IRs. Best-effort; no-op on web. */
export async function saveIrCache(slots: IrSlots): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const data: CacheFile = { version: VERSION, slots: {} };
    for (const [pos, s] of Object.entries(slots)) {
      data.slots[Number(pos)] = { name: s.name, samples: Array.from(s.samples) };
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

/** Load cached IRs, or null if none / unreadable / stale version. No-op on web. */
export async function loadIrCache(): Promise<IrSlots | null> {
  if (Platform.OS === "web") return null;
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as CacheFile;
    if (parsed.version !== VERSION || !parsed.slots) return null;
    const out: IrSlots = {};
    for (const [pos, s] of Object.entries(parsed.slots)) {
      out[Number(pos)] = { name: s.name, samples: Float64Array.from(s.samples) };
    }
    return out;
  } catch {
    return null;
  }
}
