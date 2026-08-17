/**
 * READ-ONLY audit of every per-preset user-IR pointer on the pedal, and the state of each record
 * they name.
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/ir-audit.ts
 *
 * Answers "what is actually in my pedal's user IR slots?" — which presets point at a PRIVATE record,
 * whether that record holds a real IR or is empty, and which of them have IR Mode on (i.e. are being
 * played rather than merely referenced).
 *
 * Why it exists: a preset's pointer being pre-wired is NOT evidence that the record behind it was
 * ever written. Reading the pointer tells you the address; only reading the record tells you whether
 * there is an IR there. Enabling a slot whose record is empty points the pedal at unstored data
 * (see src/protocol/irPointer.ts).
 *
 * SAFE: handshake, `05 40` preset reads and `05 69` IR reads only. No writes, no recalls, no param
 * sets — it cannot change a single byte on the pedal. As with the other probes the sub-commands are
 * fixed, so nothing here can reach the 0x77/0x78/0x79 flash transport (lab #29).
 */
import { DeviceSession } from "../src/device/session";
import { decodeIrDat } from "../src/protocol/irEncode";
import { IR_PAIR_BLOB_OFFSET, classifyIrPointer } from "../src/protocol/irPointer";
import { readIrDat } from "../src/midi/irRead";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const MODE_OFFSET = { 7: 0x4a, 8: 0x4b } as const;

interface Ref {
  program: number;
  slot: 7 | 8;
  msb: number;
  lsb: number;
  record: number;
  kind: string;
  modeOn: boolean;
}

/** What a record turned out to hold. */
type RecordState =
  | { state: "ir"; name: string; gain: number; distinct: number; rms: number }
  | { state: "empty"; notFf: number; total: number }
  | { state: "noreply" };

async function inspect(session: DeviceSession, msb: number, lsb: number): Promise<RecordState> {
  const dat = await readIrDat(session, msb, lsb, 8000);
  if (dat) {
    const { name, gain, samples } = decodeIrDat(dat);
    const uniq = new Set<number>();
    let sumSq = 0;
    for (const s of samples) {
      uniq.add(s);
      sumSq += s * s;
    }
    return {
      state: "ir",
      name,
      gain,
      distinct: uniq.size,
      rms: Math.sqrt(sumSq / samples.length),
    };
  }
  return { state: "noreply" };
}

async function main(): Promise<void> {
  const io = openMidi(PORT);
  const session = new DeviceSession(io, 8000, 0, 150);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(`✓ ready — firmware ${(session.protocolVersion / 10).toFixed(1)}\n`);

  console.log("reading all 128 presets…");
  const refs: Ref[] = [];
  for (let program = 0; program < 128; program++) {
    let blob: Uint8Array;
    try {
      blob = (await session.readPreset(program)).raw;
    } catch (e) {
      console.log(`  program ${program}: read FAILED — ${(e as Error).message}`);
      continue;
    }
    for (const slot of [7, 8] as const) {
      const [mOff, lOff] = IR_PAIR_BLOB_OFFSET[slot];
      const msb = blob[mOff]!;
      const lsb = blob[lOff]!;
      const kind = classifyIrPointer(msb, lsb);
      if (kind === "private") {
        refs.push({
          program,
          slot,
          msb,
          lsb,
          record: (msb << 7) | lsb,
          kind,
          modeOn: blob[MODE_OFFSET[slot]] !== 0,
        });
      }
    }
  }

  console.log(`\n${refs.length} preset slot(s) point at a PRIVATE record.\n`);
  if (refs.length === 0) {
    session.disconnect();
    return;
  }

  // One read per distinct record — several presets can name the same one.
  const unique = [...new Map(refs.map((r) => [r.record, r])).values()];
  console.log(`reading ${unique.length} distinct record(s)…\n`);
  const states = new Map<number, RecordState>();
  for (const r of unique) states.set(r.record, await inspect(session, r.msb, r.lsb));

  console.log("preset  slot  record  mode  state");
  console.log("------  ----  ------  ----  ---------------------------------------------");
  let empty = 0;
  let live = 0;
  for (const r of refs) {
    const s = states.get(r.record)!;
    const desc =
      s.state === "ir"
        ? `IR "${s.name}" gain ${s.gain.toFixed(3)}, ${s.distinct} distinct, rms ${s.rms.toFixed(4)}`
        : "EMPTY — no IR stored at this record";
    if (s.state !== "ir") {
      empty++;
      if (r.modeOn) live++;
    }
    console.log(
      `${String(r.program + 1).padStart(6)}  ${String(r.slot).padStart(4)}  ` +
        `${String(r.record).padStart(6)}  ${(r.modeOn ? "ON" : "off").padStart(4)}  ${desc}`,
    );
  }

  console.log(
    `\n${refs.length - empty} slot(s) reference a real IR; ${empty} reference an EMPTY record.`,
  );
  if (live > 0) {
    console.log(
      `\n🔴 ${live} preset slot(s) have IR Mode ON while pointing at an EMPTY record — the pedal is\n` +
        `   being asked to play unstored data on those presets. Worth fixing before playing them.`,
    );
  } else if (empty > 0) {
    console.log(
      `\n✓ None of the empty ones have IR Mode on, so nothing is currently playing unstored data.\n` +
        `  They are only a hazard if a slot gets switched on without an upload first.`,
    );
  }
  session.disconnect();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("audit failed:", (e as Error).message);
  process.exit(1);
});
