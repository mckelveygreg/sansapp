/**
 * Upload a captured user-IR to the pedal by replaying its 05 60/65/66 sequence — proving the app
 * can push an IR (e.g. an HPF'd factory cab) to the pedal from our own code, no EliteControl.
 * Reads captures/hpf-cab-uploads.json (Tech21-derived, gitignored — local only).
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/upload-ir.ts [index]
 *
 * Protocol (observed): 05 60 begin → pedal ack 05 63; nine 05 65 chunks; 05 66 end → ack 05 61.
 */
import { readFileSync } from "node:fs";
import { DeviceSession } from "../src/device/session";
import { uploadIr } from "../src/midi/irUpload";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI Jack Bluetooth";
const which = Number(process.argv[2] ?? 7); // default: Brit V30 (index 7)

const hexToBytes = (s: string) => Uint8Array.from(s.split(" ").map((h) => parseInt(h, 16)));

async function main() {
  const packs: { name: string; frames: string[] }[] = JSON.parse(
    readFileSync("captures/hpf-cab-uploads.json", "utf8"),
  );
  const pack = packs[which]!;
  console.log(`uploading "${pack.name}" (${pack.frames.length} frames) via ${PORT}`);

  const io = openMidi(PORT);
  const session = new DeviceSession(io, 4000);
  await session.connect();
  console.log(`connected — state ${session.state}`);

  await uploadIr(session, pack.frames.map(hexToBytes), {
    presetAddress: null, // the captured frames are self-contained; don't inject address bytes
    save: true, // persist to non-volatile (EliteControl's SAVE)
    onProgress: (d, t) => process.stdout.write(`\r  frame ${d}/${t}`),
  });

  await new Promise((r) => setTimeout(r, 300));
  io.close();
  console.log(`\n✓ "${pack.name}" uploaded — the pedal accepted it.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
