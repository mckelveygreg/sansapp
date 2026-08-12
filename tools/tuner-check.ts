/**
 * On-device verification for the tuner (MUTE / BYPASS) path — the one check that decides whether
 * `writePreset`'s save self-heal is sound, answered in bytes rather than by ear.
 *
 *   npx tsx tools/tuner-check.ts                     # WIDI Jack over Bluetooth, scratch slot 120
 *   npx tsx tools/tuner-check.ts --slot 118
 *   ELITE_PORT="USB MIDI Driver" npx tsx tools/tuner-check.ts
 *
 * It drives the REAL `DeviceSession` methods the app ships — `setTunerMode` and `writePreset`, with
 * its self-heal — so a pass here is a pass for the app, not for a hand-built approximation of it.
 *
 * STEP-DRIVEN ON PURPOSE: one wire event, then it stops and waits for you. Timed countdowns produced
 * an ambiguous result the first time this pedal's tuner was probed; a step you confirm cannot.
 *
 * ⚠ WRITES: step 4 saves to the scratch slot. It is read and stashed to disk FIRST, restored at the
 * end (verified by a read-back), and the tuner is always left Off — including after a failure.
 */
import { createInterface } from "node:readline/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceSession } from "../src/device/session";
import { PARAMS } from "../src/protocol/params";
import { decodePreset } from "../src/protocol/preset";
import { bytesToHex } from "../src/protocol/hex";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const LEVEL = PARAMS.level.blobOffset;
/** The Level we ask the pedal to save. Loud enough that a zero is unmistakable, not a rail. */
const TEST_LEVEL = 100;
const BACKUP_DIR = "captures";

const slotArg = process.argv.indexOf("--slot");
/** 1-based on the command line and in the pedal's display; 0-based on the wire. */
const SCRATCH = (slotArg > 0 ? Number(process.argv[slotArg + 1]) : 120) - 1;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => rl.question(`\n${q} `);
const step = (n: string, what: string) => console.log(`\n── ${n} ─── ${what}`);
const verdict = (pass: boolean, line: string) =>
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${line}`);

async function main(): Promise<void> {
  if (!Number.isInteger(SCRATCH) || SCRATCH < 0 || SCRATCH > 0x7d) {
    throw new Error(`--slot must be 1..126 (got ${SCRATCH + 1})`);
  }
  const io = openMidi(PORT);
  // 4 s timeout + 150 ms send pacing: the app's own BLE settings. No heartbeat — a probe firing into
  // a step you're listening to is exactly the ambiguity this tool exists to avoid.
  const session = new DeviceSession(io, 4000, 0, 150);
  const notices: string[] = [];
  session.onNotice((line) => notices.push(line));

  console.log(`connecting over "${PORT}"…`);
  await session.connect();
  console.log(`✓ handshake complete — firmware ${session.firmwareVersion ?? "?"}`);

  // The active slot is byte 0 of settings block 0. Every tuner write is nudged with a read of THIS
  // slot — a read doesn't move the pedal, and it's the least surprising dump to ask for.
  const settings = await session.readBlock(0x55, 0);
  const active = settings[0];
  if (active === undefined || active >= 128) throw new Error("couldn't read the active slot");
  console.log(`✓ pedal is sitting on preset ${active + 1} (nudges will read that slot)`);

  let restore: { blob: Uint8Array; path: string } | null = null;
  try {
    // ── 1. Back up the scratch slot before anything destructive ──────────────────────────────────
    step("1", `backing up the scratch slot (preset ${SCRATCH + 1})`);
    const before = await session.readPreset(SCRATCH);
    mkdirSync(BACKUP_DIR, { recursive: true });
    const path = join(BACKUP_DIR, `tuner-check-slot${SCRATCH + 1}.bin`);
    writeFileSync(path, before.raw);
    restore = { blob: before.raw, path };
    console.log(
      `✓ preset ${SCRATCH + 1} "${before.name.trim()}" (Level ${before.raw[LEVEL]}) → ${path}`,
    );
    const go = await ask(
      `Step 4 SAVES over preset ${SCRATCH + 1} and restores it afterwards. Type "go" to continue:`,
    );
    if (go.trim().toLowerCase() !== "go") {
      console.log("aborted — nothing was written.");
      return;
    }

    // ── 2. The write alone is inert ──────────────────────────────────────────────────────────────
    step("2", "bare tuner write, NO nudge — nothing should happen");
    session.setLiveParam(0x38, 1); // Mute, unpaired on purpose
    await new Promise((r) => setTimeout(r, 400));
    const inert = await ask("Play something. Is the signal STILL AUDIBLE? (expect yes) [y/n]:");
    verdict(
      inert.trim().toLowerCase().startsWith("y"),
      "the write alone does nothing (pending, not applied)",
    );

    // ── 3. The nudge applies it, and the real API round-trips ────────────────────────────────────
    step("3", "the nudge — a read of the active slot drains and applies the pending Mute");
    await session.readPreset(active);
    const muted = await ask("Is the signal MUTED now, with a note on the pedal's display? [y/n]:");
    verdict(muted.trim().toLowerCase().startsWith("y"), "the nudge applies a pending mode");

    step("3b", "setTunerMode(0) — the app's own path, clearing it again");
    await session.setTunerMode(0, active);
    const back = await ask("Is the signal BACK? [y/n]:");
    verdict(
      back.trim().toLowerCase().startsWith("y"),
      "setTunerMode(0) clears a pending/engaged tuner",
    );

    step("3c", "setTunerMode(2) — Bypass, which should be audibly DRY, not silent");
    await session.setTunerMode(2, active);
    const dry = await ask("Dry signal — amp/drive/cab out of circuit (NOT silence)? [y/n]:");
    verdict(dry.trim().toLowerCase().startsWith("y"), "mode 2 is a genuine channel bypass");
    await session.setTunerMode(0, active);

    // ── 4. THE LOAD-BEARING ONE: does the save self-heal actually work? ──────────────────────────
    step("4", "the save hazard — engage Mute, then save through the real writePreset");
    await session.setTunerMode(1, active);
    console.log("✓ tuner engaged (Mute) — the pedal will now zero Level as it saves");
    console.log(
      `  heads-up: a save PARKS the pedal on its target, so it will land on preset ${SCRATCH + 1}\n` +
        "  and you'll hear that preset's sound from here on. That's the pedal's own behaviour.",
    );

    const blob = before.raw.slice();
    blob[LEVEL] = TEST_LEVEL;
    notices.length = 0;
    let threw: string | null = null;
    let echoLevel: number | null = null;
    try {
      const echo = await session.writePreset(SCRATCH, blob);
      echoLevel = echo[LEVEL] ?? null;
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    // Flash is the only authority: re-read the slot rather than trusting the echo.
    const after = await session.readPreset(SCRATCH);
    const savedLevel = after.raw[LEVEL];

    console.log(`\n  asked to save Level  : ${TEST_LEVEL}`);
    console.log(`  save echo Level      : ${echoLevel ?? "— (threw)"}`);
    console.log(`  read back from flash : ${savedLevel}`);
    console.log(
      `  notice lines         : ${notices.length ? notices.map((l) => `\n    • ${l}`).join("") : "none"}`,
    );
    if (threw) console.log(`  writePreset threw    : ${threw}`);

    if (savedLevel === TEST_LEVEL && !threw) {
      verdict(
        true,
        "SELF-HEAL WORKS — the commit persists the staged blob, so clearing the tuner and re-saving is enough.",
      );
      if (notices.length !== 1) {
        console.log("  ⚠ but it should have said so exactly once — check the onNotice wiring.");
      }
    } else if (savedLevel === 0) {
      verdict(false, "SELF-HEAL CANNOT WORK AS BUILT — the slot is still at Level 0.");
      console.log(
        "  ⇒ the 0x12 commit merges the pedal's LIVE param array, so the first save's zeroed\n" +
          "    array[0x00] survives into the retry. Fix: live-set Level from the blob after clearing\n" +
          "    the tuner — but only on the save-current-sound path, never copy/rename (there the blob\n" +
          "    belongs to a different preset and the write would jog the audible level).",
      );
    } else {
      verdict(
        false,
        `unexpected Level ${savedLevel} — neither ${TEST_LEVEL} nor 0. Capture this and investigate.`,
      );
    }

    // ── 5. Is the tuner really off after the heal? ───────────────────────────────────────────────
    // Outcome, not mechanism: the save also PARKS the pedal on its target, and a park may itself
    // reload the tuner byte from the preset. Both roads lead to "not silent", which is the thing that
    // must hold — the app may never leave the player muted by a save they asked for.
    step("5", "the outcome that matters — a save must not leave you silent");
    const off = await ask(
      `Is the signal AUDIBLE (preset ${SCRATCH + 1}'s sound) without you touching the pedal? [y/n]:`,
    );
    verdict(
      off.trim().toLowerCase().startsWith("y"),
      "a save with the tuner engaged doesn't leave the player muted",
    );

    // ── 6. A preset change clears the tuner (the app's resync) ───────────────────────────────────
    // The pedal is parked on SCRATCH now, so nudge against that — a read of a slot the pedal is not
    // on would still work, but this keeps the tool honest about what it claims to be doing.
    const parked = (await session.readBlock(0x55, 0))[0] ?? SCRATCH;
    step("6", "recall clears the tuner — the app's only resync");
    await session.setTunerMode(1, parked);
    await ask("Muted? Now press the CHANNEL FOOTSWITCH to change preset, then press Enter:");
    const cleared = await ask(
      "Did the signal come back on its own (recall cleared the tuner)? [y/n]:",
    );
    verdict(
      cleared.trim().toLowerCase().startsWith("y"),
      "a preset change clears the pedal's tuner — so resetting the app's mirror there is honest",
    );
  } finally {
    // Always leave the pedal usable: tuner off, scratch slot as we found it.
    console.log("\n── cleanup ───");
    try {
      const now = await session.readBlock(0x55, 0);
      await session.setTunerMode(0, now[0] ?? active);
      console.log("✓ tuner set back to Off");
    } catch (e) {
      console.log(
        `⚠ couldn't clear the tuner (${e instanceof Error ? e.message : e}) — do it at the pedal`,
      );
    }
    if (restore) {
      try {
        await session.writePreset(SCRATCH, restore.blob);
        const check = await session.readPreset(SCRATCH);
        const same = bytesToHex(check.raw) === bytesToHex(restore.blob);
        console.log(
          same
            ? `✓ preset ${SCRATCH + 1} restored byte-for-byte`
            : `⚠ preset ${SCRATCH + 1} restore MISMATCHED — the backup is at ${restore.path}`,
        );
        if (!same) {
          const orig = decodePreset(readFileSync(restore.path));
          console.log(`  backup holds "${orig.name.trim()}" — restore it from the app if needed`);
        }
      } catch (e) {
        console.log(
          `⚠ restore FAILED (${e instanceof Error ? e.message : e}) — preset ${SCRATCH + 1} is at Level ` +
            `${TEST_LEVEL}; its original is at ${restore.path}`,
        );
      }
    }
    rl.close();
    session.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
