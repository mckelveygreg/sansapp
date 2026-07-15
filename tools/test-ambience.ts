/**
 * Diagnose HOW to switch the ambience engine on real hardware. Tries three mechanisms and reports
 * which actually changes the read-back:
 *   [A] write the edit buffer directly (05 20 0A 7F)
 *   [B] write a numbered scratch slot (05 20 0A n) + read it back
 *   [C] recall that scratch slot (05 23) + read the edit buffer
 * Backs up + restores the scratch slot.
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/test-ambience.ts   # phone app + EliteControl closed
 */
import { DeviceSession } from "../src/device/session";
import {
  AMBIENCE_BUNDLE_OFFSETS,
  applyAmbienceBundle,
  detectAmbienceType,
} from "../src/protocol/ambience";
import { AMBIENCE_ENGINES } from "../src/protocol/constants";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI Jack Bluetooth";
const SCRATCH = 120; // program 121 (neutral range)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (b: Uint8Array) => AMBIENCE_BUNDLE_OFFSETS.map((o) => b[o]).join(",");
const name = (t: number) => (t < 0 ? "custom/none" : AMBIENCE_ENGINES[t]);

async function main(): Promise<void> {
  const io = openMidi(PORT);
  const s = new DeviceSession(io, 4000);
  await s.connect();
  console.log(`handshake: ${s.state}`);
  const target = AMBIENCE_ENGINES.indexOf("Echo Verb");

  const a0 = (await s.readEditBuffer()).raw;
  console.log(`\n[A] edit-buffer write (0x7F)`);
  console.log(`  before: ${name(detectAmbienceType(a0))} [${show(a0)}]`);
  await s.writePreset(0x7f, applyAmbienceBundle(a0, target));
  await sleep(400);
  const a1 = (await s.readEditBuffer()).raw;
  console.log(
    `  after:  ${name(detectAmbienceType(a1))} [${show(a1)}]  ${detectAmbienceType(a1) === target ? "✓" : "✗ NO CHANGE"}`,
  );

  const backup = (await s.readPreset(SCRATCH)).raw.slice();
  console.log(`\n[B] numbered-slot write (scratch ${SCRATCH + 1})`);
  await s.writePreset(SCRATCH, applyAmbienceBundle(backup, target));
  await sleep(300);
  const b1 = (await s.readPreset(SCRATCH)).raw;
  console.log(
    `  slot read: ${name(detectAmbienceType(b1))} [${show(b1)}]  ${detectAmbienceType(b1) === target ? "✓ landed" : "✗"}`,
  );

  console.log(`\n[C] recall scratch → read edit buffer`);
  await s.recallPreset(SCRATCH);
  await sleep(400);
  const c1 = (await s.readEditBuffer()).raw;
  console.log(
    `  edit buffer: ${name(detectAmbienceType(c1))} [${show(c1)}]  ${detectAmbienceType(c1) === target ? "✓ recall makes it live" : "✗"}`,
  );

  await s.writePreset(SCRATCH, backup);
  console.log(`\nrestored scratch ${SCRATCH + 1}`);
  io.close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
