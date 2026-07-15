/**
 * Save a generated file (e.g. an IR .wav) and offer the OS share sheet (native) or a browser
 * download (web). Import likewise works on native (document picker) and web (file input) — the
 * IR-design → EliteControl-Import loop is easiest in the web build on the Mac. RN surface.
 */
import { Platform } from "react-native";

/** Write `bytes` to a cache file named `name` and open the share sheet. Returns the file URI. */
export async function saveAndShare(
  name: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  if (Platform.OS === "web") {
    // Browser download: Blob → temporary <a download>.
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return url;
  }
  const { File, Paths } = await import("expo-file-system");
  const Sharing = await import("expo-sharing");
  const file = new File(Paths.cache, name);
  try {
    file.create({ overwrite: true });
  } catch {
    // already exists — write() overwrites its contents
  }
  file.write(bytes);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: name });
  }
  return file.uri;
}

/** Let the user pick a file and return its bytes, or null if cancelled. */
export async function pickFileBytes(): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (Platform.OS === "web") {
    // Browser file input.
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".wav,.p3b,.dat,audio/wav";
      input.addEventListener("change", () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        void f.arrayBuffer().then((buf) => resolve({ name: f.name, bytes: new Uint8Array(buf) }));
      });
      input.click();
    });
  }
  const DocumentPicker = await import("expo-document-picker");
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  if (res.canceled || res.assets.length === 0) return null;
  const asset = res.assets[0]!;
  const { File } = await import("expo-file-system");
  const buf = await new File(asset.uri).arrayBuffer();
  return { name: asset.name, bytes: new Uint8Array(buf) };
}
