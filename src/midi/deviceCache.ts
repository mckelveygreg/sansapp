/**
 * Persistent per-pedal cache of the preset bank: slot→name plus the per-preset checksums those names
 * were read at. Preset names live inside each preset's blob, so reading all 128 is a ~35 s Bluetooth
 * pull — we cache them so the Presets list is populated instantly on launch (and offline), and cache
 * the checksums so the next connect can re-read only the slots that actually changed
 * (src/protocol/identity.ts).
 *
 * Keyed by the pedal's SERIAL so two pedals never inherit each other's names, with `lastSerial`
 * recording which one to hydrate from at launch — before any pedal is connected there's nothing else
 * to go on. RN app surface (expo-file-system); no-op on web.
 */
import { Platform } from "react-native";

const FILE = "preset-names.json";
const VERSION = 2;

/** Cache key for a pedal whose serial couldn't be read (blank field, or a failed handshake read). */
export const UNIDENTIFIED_SERIAL = "unidentified";

export interface DeviceCacheEntry {
  /** slot → preset name, as last read off this pedal. */
  names: Record<number, string>;
  /** slot → the 14-bit preset checksum at that read; a slot missing here is always re-read. */
  checksums: Record<number, number>;
}

export interface DeviceCache {
  /** The pedal this app talked to most recently — what launch hydrates from. */
  lastSerial: string | null;
  devices: Record<string, DeviceCacheEntry>;
}

interface CacheFile extends DeviceCache {
  version: number;
}

/** A v1 file: one global slot→name map, written before the cache was keyed per pedal. */
interface CacheFileV1 {
  version: 1;
  names: Record<number, string>;
}

const empty = (): DeviceCache => ({ lastSerial: null, devices: {} });

export const emptyEntry = (): DeviceCacheEntry => ({ names: {}, checksums: {} });

/**
 * Read the cache file. A v1 file (global names, no serial) is carried over under
 * {@link UNIDENTIFIED_SERIAL} rather than discarded — the app only ever spoke to one pedal then, so
 * those names are that pedal's, and the first connect that reads a real serial re-keys them.
 */
export async function loadDeviceCache(): Promise<DeviceCache> {
  if (Platform.OS === "web") return empty();
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as CacheFile | CacheFileV1;
    if (parsed.version === 1) {
      const names = (parsed as CacheFileV1).names;
      if (typeof names !== "object" || !names) return empty();
      return {
        lastSerial: UNIDENTIFIED_SERIAL,
        devices: { [UNIDENTIFIED_SERIAL]: { names, checksums: {} } },
      };
    }
    const file = parsed as CacheFile;
    if (file.version !== VERSION || typeof file.devices !== "object" || !file.devices) {
      return empty();
    }
    return { lastSerial: file.lastSerial ?? null, devices: file.devices };
  } catch {
    return empty();
  }
}

/** Persist the whole cache. Best-effort; no-op on web. */
async function saveDeviceCache(cache: DeviceCache): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(
      new TextEncoder().encode(JSON.stringify({ version: VERSION, ...cache } satisfies CacheFile)),
    );
  } catch {
    // a write failure just means the bank isn't cached this time
  }
}

/**
 * Merge one pedal's entry into the stored cache and mark it as the pedal to hydrate from next launch.
 * Read-modify-write so a second pedal's entry survives.
 */
export async function saveDeviceEntry(serial: string, entry: DeviceCacheEntry): Promise<void> {
  const cache = await loadDeviceCache();
  cache.devices[serial] = entry;
  cache.lastSerial = serial;
  await saveDeviceCache(cache);
}

/**
 * Re-key an entry cached before the pedal's serial was known. Called on the first connect that reads a
 * real serial: without it the carried-over v1 names would sit under {@link UNIDENTIFIED_SERIAL}
 * forever and be re-pulled once per pedal identified.
 */
export async function adoptUnidentifiedEntry(serial: string): Promise<void> {
  if (serial === UNIDENTIFIED_SERIAL) return;
  const cache = await loadDeviceCache();
  const orphan = cache.devices[UNIDENTIFIED_SERIAL];
  if (!orphan || cache.devices[serial]) return; // nothing to adopt, or this pedal already has its own
  cache.devices[serial] = orphan;
  delete cache.devices[UNIDENTIFIED_SERIAL];
  cache.lastSerial = serial;
  await saveDeviceCache(cache);
}
