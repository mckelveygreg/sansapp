/**
 * Restore the factory IRs to library slots 7 & 8 (Voice 12L / Brit V30) from EliteControl's bundled
 * WAVs, over WIDI. The lab-upload testing overwrote these user-writable slots; a factory reset doesn't
 * restore the IR library, so ~91 presets that use slot 7 were left playing a test cab.
 *
 *   ELITE_PORT="WIDI" npx tsx tools/restore-factory-ir.ts
 *
 * WRITES ONLY slots 7 and 8 (header [0x02,0x06]/[0x02,0x07]) — never 1-6 or presets. Reads each slot
 * before and after to verify. Fidelity caveat: the app's upload preserves the IR shape but its makeup
 * gain + playback-rate aren't calibrated to EliteControl, so level/pitch may differ slightly from
 * factory (use EliteControl's Import for byte-exact). The WAVs are NOT copied into the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { DeviceSession } from "../src/device/session";
import { uploadIr } from "../src/midi/irUpload";
import { readIr } from "../src/midi/irRead";
import { buildIrUpload } from "../src/protocol/irEncode";
import { decodeWav } from "../src/protocol/wav";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const IR_DIR =
  "/Users/greg/code/personal/pbdr_el_app/Tech21_PBDR_EL_Control_MAC.app/Contents/Resources/irs";
const RESTORE: { slot: 7 | 8; file: string; name: string }[] = [
  { slot: 7, file: `${IR_DIR}/07-Voice 12L.wav`, name: "Voice 12L" },
  { slot: 8, file: `${IR_DIR}/08-Brit V30.wav`, name: "Brit V30" },
];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(session: DeviceSession, tries = 5): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await session.connect();
      return;
    } catch (e) {
      console.log(`  handshake attempt ${i + 1} failed (${(e as Error).message}) — retrying…`);
      await delay(800);
    }
  }
  throw new Error("could not connect (WIDI flaky?)");
}

async function main(): Promise<void> {
  for (const r of RESTORE)
    if (!existsSync(r.file)) throw new Error(`missing factory WAV: ${r.file}`);

  const io = openMidi(PORT);
  const session = new DeviceSession(io, 5000);
  console.log(`connecting to "${PORT}"…`);
  await connectWithRetry(session);
  console.log(`✓ connected — state=${session.state}\n`);

  for (const { slot, file, name } of RESTORE) {
    const [a, b] = [0x02, slot - 1];
    const before = await readIr(session, a, b, 6000);
    console.log(`slot ${slot}: overwriting "${before?.name.trim() ?? "(empty)"}"`);

    const { samples: pcm, sampleRate } = decodeWav(new Uint8Array(readFileSync(file)));
    const floats = Array.from(pcm, (s) => s / 32768);
    console.log(`  uploading "${name}" (${floats.length} samp @ ${sampleRate} Hz)…`);
    // Same as uploadCustomIr (bundleIo), but low-level so tsx doesn't transitively pull in RN:
    // header [0x02, slot-1], activate the slot live, save to non-volatile.
    const frames = buildIrUpload(floats, name, [0x02, (slot - 1) & 0x7f]);
    await uploadIr(session, frames, {
      activateValue: Math.min(127, slot * 16),
      save: true,
      onProgress: (d, t) => process.stdout.write(`\r    frame ${d}/${t}`),
    });
    process.stdout.write("\n");
    await delay(600);

    const after = await readIr(session, a, b, 6000);
    const ok = after?.name.trim() === name;
    console.log(
      `  slot ${slot} now: "${after?.name.trim() ?? "(read failed)"}" ${after?.samples.length ?? 0} samp ${ok ? "✓" : "⚠ name mismatch"}\n`,
    );
  }

  session.disconnect();
  console.log("✓ restore complete — slots 7 & 8 rewritten with the factory cabs.");
  console.log(
    "  (Recall a preset to reset the live IR selection. For byte-exact factory bytes, re-import via EliteControl.)",
  );
}

main().catch((e) => {
  console.error("restore failed:", (e as Error).message);
  process.exit(1);
});
