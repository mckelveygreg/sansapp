/**
 * READ-ONLY IR probe (WIDI/BLE). Maps the pedal's IR index space to settle the open questions from the
 * EliteControl binary RE: where do the FACTORY cabs live (is there a pedal-readable factory bank?), how
 * many custom banks are there, and where is a preset's per-slot user-IR index stored in its blob?
 *
 *   ELITE_PORT="WIDI" npx tsx tools/probe-ir.ts
 *
 * SAFE: sends ONLY hello + block requests + 05 40 preset reads + 05 69 IR reads. NEVER writes, uploads,
 * recalls, sets params, or sends 05 6A (bank-select, which could change pedal state). Nothing it does
 * alters the pedal's IRs/presets/settings.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DeviceSession } from "../src/device/session";
import { readIr } from "../src/midi/irRead";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const OUT = "captures/ir-probe.jsonl";
const SUMMARY =
  "/private/tmp/claude-501/-Users-greg-code-personal-pbdr-el-app/b3375f42-fcf9-4da2-a6e8-3305580325fa/scratchpad/ir-probe-summary.json";
const READ_TIMEOUT = 6000; // the 11-frame 05 60/65/66 stream takes ~3s+ over WIDI; 2500 cut it off
const PACE_MS = 160;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

interface Hit {
  a: number;
  b: number;
  index: number;
  name: string;
  samples: number;
  gain: number;
}

async function connectWithRetry(session: DeviceSession, tries = 4): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await session.connect();
      return;
    } catch (e) {
      console.log(`  handshake attempt ${i + 1} failed (${(e as Error).message}) — retrying…`);
      await delay(800);
    }
  }
  throw new Error("could not complete the handshake after retries (WIDI flaky?)");
}

/** readIr with one retry on null, so a flaky-link miss isn't misread as an empty slot. */
async function probe(session: DeviceSession, a: number, b: number): Promise<Hit | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ir = await readIr(session, a, b, READ_TIMEOUT);
    if (ir) {
      return {
        a,
        b,
        index: (a << 7) | b,
        name: ir.name.trim(),
        samples: ir.samples.length,
        gain: ir.gain,
      };
    }
    await delay(PACE_MS);
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync("captures", { recursive: true });
  writeFileSync(OUT, "");
  const log = (rec: unknown) => appendFileSync(OUT, `${JSON.stringify(rec)}\n`);

  const io = openMidi(PORT);
  const session = new DeviceSession(io, 4000);
  console.log(`connecting to "${PORT}"…`);
  await connectWithRetry(session);
  console.log(`✓ handshake — state=${session.state}`);

  // --- Active preset: capture IR-mode (0x4a/0x4b) + the user-IR region (0x6C..0xBF) to locate the
  // per-preset user-IR index the binary RE said lives there. Read-only.
  let activeSlot: number | null = null;
  try {
    const settings = await session.readBlock(0x55, 0);
    const s = settings[0];
    if (s !== undefined && s < 128) activeSlot = s;
  } catch {
    /* ignore */
  }
  let activeReport: Record<string, unknown> = { activeSlot };
  if (activeSlot != null) {
    try {
      const p = await session.readPreset(activeSlot);
      const raw = p.raw;
      activeReport = {
        activeSlot,
        name: p.name.trim(),
        irMode7: raw[0x4a],
        irMode8: raw[0x4b],
        irGain7: raw[0x4c],
        irGain8: raw[0x4d],
        userIrRegion_6c_bf: [...raw.subarray(0x6c, 0xc0)].map(hex).join(" "),
      };
    } catch (e) {
      activeReport.presetReadError = (e as Error).message;
    }
  }
  console.log("active preset:", JSON.stringify(activeReport, null, 2));
  log({ kind: "active", ...activeReport });

  // --- Index sweep. banks a=0x00..0x08 (the "Custom Bank 1-8 + Factory Bank" enum has 9 values),
  // b=0x00..0x07 (8 entries/bank) + a=0x02 b=0x08..0x0f to check past the known 8 slots.
  const targets: [number, number][] = [];
  for (let a = 0x00; a <= 0x08; a++) for (let b = 0x00; b <= 0x07; b++) targets.push([a, b]);
  for (let b = 0x08; b <= 0x0f; b++) targets.push([0x02, b]);

  console.log(`\nsweeping ${targets.length} IR indices (read-only)…`);
  const hits: Hit[] = [];
  for (const [a, b] of targets) {
    const hit = await probe(session, a, b);
    if (hit) {
      hits.push(hit);
      console.log(
        `  ${hex(a)},${hex(b)} (idx ${hit.index}) → "${hit.name}" ${hit.samples} smp gain=${hit.gain}`,
      );
    } else {
      console.log(`  ${hex(a)},${hex(b)} · empty`);
    }
    log({ kind: "probe", a, b, index: (a << 7) | b, hit: hit ?? null });
    await delay(PACE_MS);
  }

  const summary = {
    port: PORT,
    active: activeReport,
    totalProbed: targets.length,
    hitCount: hits.length,
    hits,
    banks: [...new Set(hits.map((h) => h.a))].sort((x, y) => x - y).map(hex),
  };
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  console.log(`\n✓ ${hits.length}/${targets.length} indices returned an IR.`);
  console.log(`  banks (distinct 'a'): ${summary.banks.join(", ")}`);
  console.log(`  summary → ${SUMMARY}`);

  session.disconnect();
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exit(1);
});
