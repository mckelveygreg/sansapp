/**
 * On-device verification for the tuner (MUTE / BYPASS) path — above all the one check that decides
 * whether `writePreset`'s save self-heal is sound, answered in bytes rather than by ear.
 *
 *   npx tsx tools/tuner-check.ts --yes               # byte-level only, no listening, no prompts
 *   npx tsx tools/tuner-check.ts --yes --listen      # + the by-ear steps (needs a real terminal)
 *   npx tsx tools/tuner-check.ts --yes --slot 118
 *   ELITE_PORT="USB MIDI Driver" npx tsx tools/tuner-check.ts --yes
 *
 * It drives the REAL `DeviceSession` methods the app ships — `setTunerMode` and `writePreset` with its
 * self-heal — so a pass here is a pass for the app, not for a hand-built approximation of it.
 *
 * The default run needs no ears and no input: the save hazard is entirely byte-level (ask for Level
 * 100 with the tuner engaged, read the slot back, look at the byte). `--listen` adds the questions
 * only a human can answer — is it muted, is bypass dry — and those are STEP-DRIVEN: one wire event,
 * then it waits. Timed countdowns are what made the first tuner probe on this pedal ambiguous.
 *
 * ⚠ WRITES to the scratch slot (hence `--yes`). It is stashed to disk FIRST and restored at the end,
 * and the tuner is always left Off — including after a failure.
 */
import type { Interface } from "node:readline/promises";
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceSession } from "../src/device/session";
import { PARAMS, TUNER_BLOB_OFFSET } from "../src/protocol/params";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const LEVEL = PARAMS.level.blobOffset;
/** The Level we ask the pedal to save. Loud enough that a zero is unmistakable, not a rail. */
const TEST_LEVEL = 100;
const BACKUP_DIR = "captures";

/**
 * Bytes a save is OBSERVED to rewrite, so a restore can't be checked against them.
 *
 * - `0xC0`–`0xCF` — the cab-name string. Observed 2026-08-12: writing a blob back byte-for-byte came
 *   back with this field replaced by the pedal's LIVE cab name. It is genuinely per-preset (two
 *   presets sharing IR pointer `[2,4]` report different names here), so the pedal is overwriting it
 *   from its working state at save time, not deriving it from the record. Display only — pointer,
 *   IR Mode and blend all survive.
 * - `0x57`–`0x5A` — the user-IR pointer pair, repointed by the documented copy-on-save-as when the
 *   save target differs from the program the pedal is parked on (docs/PROTOCOL.md).
 */
const SAVE_REWRITES: readonly [number, number][] = [
  [0xc0, 0xcf],
  [0x57, 0x5a],
];

const has = (flag: string) => process.argv.includes(flag);
const WANT_LISTEN = has("--listen");
const CONFIRMED = has("--yes");

const slotArg = process.argv.indexOf("--slot");
/** 1-based on the command line and in the pedal's display; 0-based on the wire. */
const SCRATCH = (slotArg > 0 ? Number(process.argv[slotArg + 1]) : 120) - 1;

// Created lazily: constructing it up front against a closed stdin (a piped shell) closes it
// immediately, and the first question then dies with ERR_USE_AFTER_CLOSE.
let rl: Interface | null = null;
async function askYesNo(q: string): Promise<boolean> {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${q} [y/n]: `);
  return answer.trim().toLowerCase().startsWith("y");
}
const step = (n: string, what: string) => console.log(`\n── ${n} ─── ${what}`);
const verdict = (pass: boolean, line: string) =>
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${line}`);

/**
 * Save `backup` with Level {@link TEST_LEVEL} and the given tuner byte, and return the Level the slot
 * actually holds afterwards — flash is the only authority, so it is re-read rather than trusted from
 * the echo.
 */
async function savedLevelFor(
  session: DeviceSession,
  slot: number,
  backup: Uint8Array,
  tunerByte: number,
): Promise<number | undefined> {
  const blob = backup.slice();
  blob[LEVEL] = TEST_LEVEL;
  blob[TUNER_BLOB_OFFSET] = tunerByte;
  await session.writePreset(slot, blob);
  return (await session.readPreset(slot)).raw[LEVEL];
}

/** Differing byte offsets, excluding the ones a save is known to rewrite. */
function unexpectedDiffs(sent: Uint8Array, got: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] === got[i]) continue;
    if (SAVE_REWRITES.some(([lo, hi]) => i >= lo && i <= hi)) continue;
    out.push(i);
  }
  return out;
}

async function main(): Promise<void> {
  if (!Number.isInteger(SCRATCH) || SCRATCH < 0 || SCRATCH > 0x7d) {
    throw new Error(`--slot must be 1..126 (got ${SCRATCH + 1})`);
  }
  if (!CONFIRMED) {
    console.log(
      `This saves over preset ${SCRATCH + 1} (backed up to ${BACKUP_DIR}/ and restored afterwards) and\n` +
        `briefly mutes the pedal. Re-run with --yes to go ahead, or --slot N to use a different slot.`,
    );
    process.exitCode = 1;
    return;
  }
  if (WANT_LISTEN && !process.stdin.isTTY) {
    throw new Error(
      "--listen needs a real terminal to ask you questions (stdin isn't a TTY here). Run it directly " +
        "in a shell, or drop --listen for the byte-level checks, which need no input.",
    );
  }

  const io = openMidi(PORT);
  // 4 s timeout + 150 ms send pacing: the app's own BLE settings. No heartbeat — a probe firing into a
  // step you're listening to is exactly the ambiguity this tool exists to avoid.
  const session = new DeviceSession(io, 4000, 0, 150);
  console.log(`connecting over "${PORT}"…`);
  await session.connect();
  console.log(`✓ handshake complete — firmware ${session.firmwareVersion ?? "?"}`);

  // The active slot is byte 0 of settings block 0. Every tuner write is nudged with a read of THIS
  // slot — a read doesn't move the pedal, and it's the least surprising dump to ask for.
  const settings = await session.readBlock(0x55, 0);
  const active = settings[0];
  if (active === undefined || active >= 128) throw new Error("couldn't read the active slot");
  console.log(`✓ pedal is sitting on preset ${active + 1} (nudges will read that slot)`);
  if (!WANT_LISTEN)
    console.log("  (byte-level run — pass --listen in a real terminal for the ear checks)");

  let backup: Uint8Array | null = null;
  try {
    // ── 1. Back up the scratch slot before anything destructive ──────────────────────────────────
    step("1", `backing up the scratch slot (preset ${SCRATCH + 1})`);
    const before = await session.readPreset(SCRATCH);
    mkdirSync(BACKUP_DIR, { recursive: true });
    const path = join(BACKUP_DIR, `tuner-check-slot${SCRATCH + 1}.bin`);
    writeFileSync(path, before.raw);
    backup = before.raw;
    console.log(
      `✓ preset ${SCRATCH + 1} "${before.name.trim()}" (Level ${before.raw[LEVEL]}) → ${path}`,
    );

    // ── 2. The by-ear steps, only when asked for ─────────────────────────────────────────────────
    if (WANT_LISTEN) {
      step("2", "bare tuner write, NO nudge — nothing should happen");
      session.setLiveParam(0x38, 1); // Mute, unpaired on purpose
      await new Promise((r) => setTimeout(r, 400));
      verdict(
        await askYesNo("Play something. Is the signal STILL AUDIBLE? (expect yes)"),
        "the write alone does nothing (recorded, not applied)",
      );

      step("3", "the nudge — a read of the active slot drains and applies the pending Mute");
      await session.readPreset(active);
      verdict(
        await askYesNo("Is the signal MUTED now, with a note on the pedal's display?"),
        "the nudge applies a pending mode",
      );

      step("3b", "setTunerMode(0) — the app's own path, clearing it again");
      await session.setTunerMode(0, active);
      verdict(await askYesNo("Is the signal BACK?"), "setTunerMode(0) clears an engaged tuner");

      step("3c", "setTunerMode(2) — Bypass, which should be audibly DRY, not silent");
      await session.setTunerMode(2, active);
      verdict(
        await askYesNo("Dry signal — amp/drive/cab out of circuit (NOT silence)?"),
        "mode 2 is a genuine channel bypass",
      );
      await session.setTunerMode(0, active);
    }

    // ── 4. The save hazard, and the one byte that prevents it ────────────────────────────────────
    // Settled on hardware 2026-08-12: the hazard is real (a BARE commit with the tuner engaged
    // persists Level 0), but the `05 20` stage refreshes the pedal's live param array from the blob,
    // so the save reads the BLOB's tuner byte. writePreset forces that byte to 0, which makes the
    // silent save unreachable. Both halves are checked here — the protection, and that it isn't
    // vacuous.
    step("4", "the save hazard — engage Mute, then save through the real writePreset");
    await session.setTunerMode(1, active);
    console.log("✓ tuner engaged (Mute) — a bare commit would now persist Level 0");
    console.log(
      `  note: a save PARKS the pedal on its target, so it will land on preset ${SCRATCH + 1}.`,
    );

    const engagedSave = await savedLevelFor(session, SCRATCH, backup, 0);
    verdict(
      engagedSave === TEST_LEVEL,
      engagedSave === TEST_LEVEL
        ? "an engaged tuner can't silence a staged save (the stage refreshes the tuner byte)"
        : `flash came back at Level ${engagedSave} — the stage did NOT protect the save`,
    );

    step("4b", "a blob that CLAIMS Mute — the corruption a pedal-side save leaves behind");
    await session.setTunerMode(0, active);
    const corruptSave = await savedLevelFor(session, SCRATCH, backup, 1);
    const storedTuner = (await session.readPreset(SCRATCH)).raw[TUNER_BLOB_OFFSET];
    verdict(
      corruptSave === TEST_LEVEL && storedTuner === 0,
      corruptSave === TEST_LEVEL && storedTuner === 0
        ? "writePreset strips the blob's tuner byte, so a corrupted preset is repaired, not propagated"
        : `Level ${corruptSave}, stored tuner byte ${storedTuner} — the sanitisation isn't holding`,
    );

    // ── 5. The outcome that matters, if you're listening ─────────────────────────────────────────
    // Outcome, not mechanism: the save also PARKS the pedal on its target, and a park may itself
    // reload the tuner byte from the preset. Both roads lead to "not silent", which is the thing that
    // must hold — the app may never leave the player muted by a save they asked for.
    if (WANT_LISTEN) {
      step("5", "the outcome that matters — a save must not leave you silent");
      verdict(
        await askYesNo(`Is the signal AUDIBLE (preset ${SCRATCH + 1}'s sound), untouched by you?`),
        "a save with the tuner engaged doesn't leave the player muted",
      );

      step("6", "recall clears the tuner — the app's only resync");
      const parked = (await session.readBlock(0x55, 0))[0] ?? SCRATCH;
      await session.setTunerMode(1, parked);
      await askYesNo("Muted? Now press the CHANNEL FOOTSWITCH to change preset, then answer");
      verdict(
        await askYesNo("Did the signal come back on its own (the recall cleared the tuner)?"),
        "a preset change clears the pedal's tuner — resetting the app's mirror there is honest",
      );
    }
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
    if (backup) {
      try {
        await session.writePreset(SCRATCH, backup);
        const check = await session.readPreset(SCRATCH);
        const diffs = unexpectedDiffs(backup, check.raw);
        console.log(
          diffs.length === 0
            ? `✓ preset ${SCRATCH + 1} restored (Level ${check.raw[LEVEL]}); the cab-name field is the` +
                ` pedal's to rewrite`
            : `⚠ preset ${SCRATCH + 1} differs at ${diffs.map((d) => `0x${d.toString(16)}`).join(", ")}` +
                ` — its original is at ${BACKUP_DIR}/tuner-check-slot${SCRATCH + 1}.bin`,
        );
      } catch (e) {
        console.log(
          `⚠ restore FAILED (${e instanceof Error ? e.message : e}) — preset ${SCRATCH + 1} is at Level ` +
            `${TEST_LEVEL}; its original is at ${BACKUP_DIR}/tuner-check-slot${SCRATCH + 1}.bin`,
        );
      }
    }
    rl?.close();
    session.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  rl?.close();
  process.exit(1);
});
