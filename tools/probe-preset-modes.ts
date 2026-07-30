/**
 * READ-ONLY: scan all 128 presets and report each one's per-slot IR Mode (blob 0x4a/0x4b) + the
 * user-IR region (0x6c..0xbf), to see how IR Mode is used across the bank and whether any preset points
 * slot 7/8 to a non-default user-IR index. SAFE: hello + block reads + 05 40 preset reads only.
 *   ELITE_PORT="WIDI" npx tsx tools/probe-preset-modes.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { DeviceSession } from "../src/device/session";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const SUMMARY = "captures/preset-modes.json";
const hex = (n: number) => n.toString(16).padStart(2, "0");

async function main(): Promise<void> {
  const io = openMidi(PORT);
  // WIDI/BLE default: 150 ms send pacing (0 disables it) + a generous read timeout for the scan.
  const session = new DeviceSession(io, 6000, 0, 150);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log("✓ ready — scanning 128 presets…\n");

  const rows: { slot: number; name: string; m7: number; m8: number; userRegion: string }[] = [];
  let mode7on = 0;
  let mode8on = 0;
  let readFails = 0;
  for (let slot = 0; slot < 128; slot++) {
    try {
      const p = await session.readPreset(slot);
      const raw = p.raw;
      const m7 = raw[0x4a] ?? 0;
      const m8 = raw[0x4b] ?? 0;
      const region = [...raw.subarray(0x6c, 0xc0)];
      const nonZero = region.some((v) => v !== 0);
      if (m7) mode7on++;
      if (m8) mode8on++;
      rows.push({
        slot,
        name: p.name.trim(),
        m7,
        m8,
        userRegion: nonZero ? region.map(hex).join(" ") : "(all zero)",
      });
      if (m7 || m8 || nonZero) {
        console.log(
          `  ${slot + 1}: "${p.name.trim()}" mode7=${m7} mode8=${m8}${nonZero ? " userRegion≠0" : ""}`,
        );
      }
    } catch {
      readFails++;
    }
  }
  mkdirSync("captures", { recursive: true });
  const summary = {
    scanned: rows.length,
    readFails,
    mode7on,
    mode8on,
    presetsWithUserRegion: rows.filter((r) => r.userRegion !== "(all zero)").length,
    userModePresets: rows.filter((r) => r.m7 || r.m8),
  };
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  console.log(
    `\n✓ scanned ${rows.length} (${readFails} read fails). mode7 ON in ${mode7on}, mode8 ON in ${mode8on}.`,
  );
  console.log(`  presets with a non-zero user-IR region: ${summary.presetsWithUserRegion}`);
  console.log(`  summary → ${SUMMARY}`);
  session.disconnect();
}

main().catch((e) => {
  console.error("scan failed:", (e as Error).message);
  process.exit(1);
});
