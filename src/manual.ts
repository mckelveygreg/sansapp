/**
 * Offline owner's-manual access.
 *
 * We deliberately do NOT bundle Tech 21's copyrighted PDF in the app or the repo (same rule that
 * keeps their images/fonts/IRs/presets out). Instead the app ships only the public URL and fetches
 * the PDF from Tech 21's own server on demand, caching it on-device for offline use — personal use
 * of the manual for a pedal the owner has. Not affiliated with or endorsed by Tech 21.
 *
 * RN app surface (uses expo-file-system / expo-sharing via dynamic import).
 */
import { Platform } from "react-native";

export const MANUAL_URL = "https://www.tech21nyc.com/wp-content/uploads/2026/06/PBDR_EL_OM2.pdf";
const MANUAL_FILE = "PBDR_EL_OM2.pdf"; // == the URL basename, so File.downloadFileAsync lands here

async function locate() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const dir = new Directory(Paths.document, "manual");
  return { dir, file: new File(dir, MANUAL_FILE), File };
}

/** Local file URI if the manual has already been downloaded, else null (always null on web). */
export async function manualLocalUri(): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    const { file } = await locate();
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/** Download the manual from Tech 21 for offline use; returns the local file URI. */
export async function downloadManual(): Promise<string> {
  const { dir, file, File } = await locate();
  try {
    dir.create();
  } catch {
    // directory already exists
  }
  const out = await File.downloadFileAsync(MANUAL_URL, dir);
  return out.uri ?? file.uri;
}

/** Open the downloaded PDF via the share sheet (Quick Look / Books / Files). */
export async function openManual(uri: string): Promise<void> {
  const Sharing = await import("expo-sharing");
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Owner's manual" });
  }
}
