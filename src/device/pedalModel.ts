/**
 * Pure, framework-free model of the pedal's request/reply behavior — the shared
 * "brain" behind the emulator and the integration tests. Given a decoded incoming
 * message, returns the messages the real pedal would send back.
 *
 * Mirrors the captured behavior: reads require a prior connect handshake; writes are
 * acked; setParam is live-only (no reply, not reflected in reads).
 *
 * Framework-free: no React/React Native imports.
 */

import { PARAM_REGION_START, PRESET_SIZE, PRESET_SLOT_COUNT } from "../protocol/constants";
import { checksum14 } from "../protocol/messages";
import type { PedalMessage } from "../protocol/messages";
import { CHECKSUM_TABLE_BLOCK, SERIAL_BLOCK, SERIAL_OFFSET } from "../protocol/identity";
import { SETTINGS_BLOCK } from "../protocol/settings";
import {
  LIVE_PARAM_LAST_INDEX,
  PARAMS,
  TUNER_PARAM,
  type TunerMode,
  liveSetId,
  liveSetIndex,
} from "../protocol/params";

const EDIT_BUFFER_SLOT = 0x7f;

/** Size of the pedal's live parameter array, indices 0x00..{@link LIVE_PARAM_LAST_INDEX}. */
const LIVE_PARAM_COUNT = LIVE_PARAM_LAST_INDEX + 1;

/** The serial the emulated pedal reports — the observed shape, with no real unit's digits. */
const EMULATED_SERIAL = "ELITE-PDL-01012026-000000";

/** Live-set wire id of the Tuner param (index 0x34 → set-id 0x38). */
const TUNER_SET_ID = liveSetId(TUNER_PARAM);
/** The live param the save path zeroes when the tuner is engaged (the silent-preset hazard). */
const LEVEL_INDEX = PARAMS.level.blobOffset - PARAM_REGION_START;

/** Coerce a wire byte to a tuner mode (the pedal's param is a 3-position 0..2 value). */
const clampTuner = (v: number | undefined): TunerMode =>
  (v ?? 0) > 2 ? 0 : ((v ?? 0) as TunerMode);

// Per-preset user-IR fields (PROTOCOL.md): the flat 14-bit IR record pair (MSB, LSB) at blob bytes
// 0x57/0x58 (slot 7) and 0x59/0x5A (slot 8), the per-slot enable at 0x4A/0x4B, and each slot's
// private-record bank (record = bank·128 + program).
const IR_SLOTS = [
  { pairMsb: 0x57, pairLsb: 0x58, mode: 0x4a, bank: 0x00 },
  { pairMsb: 0x59, pairLsb: 0x5a, mode: 0x4b, bank: 0x01 },
] as const;

export class PedalModel {
  readonly presets: Uint8Array[];
  /**
   * The pedal's working copy of the current program — everything a saved blob carries that ISN'T a
   * parameter (name, IR name, the user-IR pointers, the reserved regions). A recall loads it; a
   * `05 20` stage replaces it. The parameter bytes of a save come from {@link live}, not from here.
   */
  editBuffer: Uint8Array;
  /**
   * The pedal's LIVE parameter array (indices 0x00..0x49) — what you are hearing. Written by every
   * `05 50` live set, reloaded wholesale by a recall and by a stage, and **write-only over the wire**:
   * no read command returns it. A preset read serves flash, which is exactly why unsaved on-pedal
   * tweaks are invisible to an editor (docs/adr/0001).
   */
  readonly live = new Uint8Array(LIVE_PARAM_COUNT);
  /** The program the pedal is sitting on (recall sets it; a save parks on its target). */
  currentSlot = 0;
  /** Config/data blocks the app has written (keyed `blockCode:index`), for read-back. */
  private readonly blocks = new Map<string, Uint8Array>();
  /** A read (05 40) only succeeds once the connect handshake has run. */
  connected = false;
  /**
   * The tuner value the pedal has RECORDED (its live param array): a `05 50 .. 38 <mode>` write lands
   * here immediately, and a recall reloads it from the preset's own byte. Distinct from {@link tuner}
   * — the recorded value is what the SAVE path reads when it decides whether to zero Level.
   */
  tunerWritten: TunerMode = 0;
  /**
   * The APPLIED tuner mode (0 Off / 1 Mute / 2 Bypass) — what the pedal is audibly doing. The tuner's
   * own param handler does nothing at write time; the applier runs from the tail of the staged-SysEx
   * TX drain, so the applied mode only catches up with {@link tunerWritten} when a dump-producing
   * command runs. That is why every app tuner write has to be paired with its own nudge.
   */
  tuner: TunerMode = 0;

  constructor(presets?: Uint8Array[]) {
    this.presets =
      presets?.map((p) => p.slice()) ??
      Array.from({ length: PRESET_SLOT_COUNT }, (_, i) => {
        const b = new Uint8Array(PRESET_SIZE);
        b[0] = 0x01;
        b[2] = 0x41 + (i % 26); // a placeholder 'A'..'Z' name
        return b;
      });
    this.editBuffer = this.presets[0]?.slice() ?? new Uint8Array(PRESET_SIZE);
    this.loadLive(this.editBuffer); // powers up sitting on program 1, live == what it stores
  }

  private blobFor(slot: number): Uint8Array {
    return slot >= 0x7e ? this.editBuffer : (this.presets[slot] ?? this.editBuffer);
  }

  /**
   * Push a blob's parameter bytes into the live array — what the pedal does on a recall AND on a
   * `05 20` stage (the stage case was proved by the tuner experiments: the STAGED blob's tuner byte,
   * not the footswitch, decides whether the following save silences the preset).
   */
  private loadLive(blob: Uint8Array): void {
    for (let i = 0; i < LIVE_PARAM_COUNT; i++) this.live[i] = blob[PARAM_REGION_START + i] ?? 0;
    this.tunerWritten = clampTuner(this.live[TUNER_PARAM]);
  }

  /**
   * The blob a save writes to flash: the working copy with every parameter byte taken from the LIVE
   * array. With a stage first the two agree, so this reproduces the staged blob; with a **bare**
   * commit it is the pedal's own report of live state — the whole basis of Read from Pedal.
   */
  private buildLiveBlob(): Uint8Array {
    const blob = this.editBuffer.slice();
    for (let i = 0; i < LIVE_PARAM_COUNT; i++) blob[PARAM_REGION_START + i] = this.live[i]!;
    return blob;
  }

  /**
   * A data block the app hasn't written, as the real pedal serves it. Two of the three the connect
   * handshake reads carry real content on hardware, so a model that answered zeros made the emulator
   * look like a pedal with no serial and an all-zero checksum table:
   *
   * - `0x0F` — the serial number field (synthetic here; the real one is per unit)
   * - `0x03` — the per-preset checksum table, derived live from this model's own presets so it stays
   *   truthful as writes land
   *
   * Everything else is zeros, matching what `tools/dump-blocks.ts` read off the pedal.
   */
  private synthesizeBlock(blockCode: number, index: number): Uint8Array {
    const block = new Uint8Array(PRESET_SIZE);
    if (blockCode !== 0x52) return block;
    if (index === SERIAL_BLOCK) {
      block.fill(0x20, SERIAL_OFFSET); // space-padded ASCII field
      for (let i = 0; i < EMULATED_SERIAL.length; i++) {
        block[SERIAL_OFFSET + i] = EMULATED_SERIAL.charCodeAt(i);
      }
      return block;
    }
    if (index === CHECKSUM_TABLE_BLOCK) {
      this.presets.forEach((blob, slot) => {
        const [hi, lo] = checksum14(blob);
        block[slot * 2] = hi;
        block[slot * 2 + 1] = lo;
      });
      return block;
    }
    return block;
  }

  /**
   * A staged dump just went out, so the applier at the tail of the drain runs: the recorded tuner
   * value becomes the audible one. Every dump-producing command is a nudge — including one for an
   * unrelated slot, which is why a tuner write left unpaired is a landmine.
   */
  private drainStagedDump(): void {
    this.tuner = this.tunerWritten;
  }

  /** Handle one incoming message; return zero or more reply messages. */
  handle(msg: PedalMessage): Array<Exclude<PedalMessage, { kind: "unknown" }>> {
    switch (msg.kind) {
      case "hello":
        this.connected = true;
        return [];
      case "requestBlock": {
        // reply code: 0x55→0x52 (data), 0x6A→0x6B (config)
        const blockCode = msg.reqCode === 0x55 ? 0x52 : 0x6b;
        const stored = this.blocks.get(`${blockCode}:${msg.index}`);
        const data = stored ? stored.slice() : this.synthesizeBlock(blockCode, msg.index);
        // Byte 0 of data block 0 is the ACTIVE PROGRAM, hand-patched from RAM on every read — the one
        // live value the pedal exposes anywhere (docs/adr/0001). Patch it whether the block came from
        // flash or from what the app wrote, exactly as the firmware does.
        if (blockCode === 0x52 && msg.index === SETTINGS_BLOCK) data[0] = this.currentSlot & 0x7f;
        return [{ kind: "block", blockCode, index: msg.index, data, checksumOk: true }];
      }
      case "block": {
        // app writing a config/data block (settings, PC map); store it and ack (05 53)
        this.blocks.set(`${msg.blockCode}:${msg.index}`, msg.data.slice());
        return [{ kind: "writeAck", code: 0x53 }];
      }
      case "requestPreset":
      case "recallPreset": {
        if (!this.connected) return []; // reads ignored before handshake
        const blob = this.blobFor(msg.slot);
        if (msg.kind === "recallPreset") {
          this.editBuffer = blob.slice();
          this.currentSlot = msg.slot;
          // A recall reloads the whole live param array from the preset, tuner byte included — so it
          // silently returns the tuner to whatever the PRESET stores (0 in practice). Confirmed by ear
          // on hardware: every preset change is a free escape hatch from a stuck mute.
          this.loadLive(blob);
        }
        const dump: Exclude<PedalMessage, { kind: "unknown" }> = {
          kind: "presetDump",
          slot: msg.slot,
          blob: blob.slice(),
          checksumOk: true,
        };
        this.drainStagedDump(); // the dump is the nudge: a pending tuner write becomes audible here
        return [dump];
      }
      case "writePreset": {
        // 0x7E/0x7F are NOT numbered slots: the pedal DISCARDS an edit-buffer stage (05 20 0A 7F) yet
        // still acks it 05 21 (confirmed — every such write in captures/m1-live.jsonl is acked). So
        // accept the frame, change nothing for the special slots, and ack like hardware.
        //
        // A stage does NOT persist: it loads the blob into the pedal's working state and the
        // `05 50 .. 12 <slot>` commit is what writes flash. It REFRESHES the live param array from the
        // blob, tuner byte included — proved on hardware: staging a blob whose 0x56 said Mute made the
        // following save zero Level even with the pedal's own tuner off, and staging one that said Off
        // protected the save from a tuner that WAS engaged. So the staged blob, not the footswitch,
        // decides the save's behaviour.
        if (msg.slot < 0x7e) {
          this.editBuffer = msg.blob.slice();
          this.loadLive(msg.blob);
        }
        return [{ kind: "writeAck", code: 0x21 }];
      }
      case "setParam": {
        // 0x12 = <slot> is the SAVE-to-slot command (a reserved command id, NOT a param): the pedal
        // persists the staged slot and echoes a 05 41 <slot> dump (confirmed via captures/elite-save.
        // jsonl). 0x12 = 0x7F is the same command aimed at program 127 (INIT) — EliteControl's IR
        // import sends it while sitting there, making it a no-op re-save; we echo the
        // program-127 dump. Every other setParam is live-only: no reply.
        if (msg.param === 0x12) {
          // The save copier reads the RECORDED tuner byte and, when it is non-zero, forces the live
          // Level param to 0 before writing the array to flash — so a save with the tuner engaged
          // persists that preset SILENT, with no error. Verified at instruction level.
          if (this.tunerWritten !== 0) this.live[LEVEL_INDEX] = 0;
          // The blob is built from the LIVE array — with no preceding stage that means live state
          // reaches flash, which is how Read from Pedal gets its answer (docs/adr/0001).
          const blob = this.buildLiveBlob();
          // Saving to a DIFFERENT program repoints each ENABLED user-IR slot with a private record
          // pointer (pair MSB ≤ 1) at the target's own record — the copy-on-save-as that hands a
          // per-preset IR over (derived from the factory bank's 10/10 record==program correlation +
          // EliteControl's captured import; on-device verification pending). Record CONTENTS aren't
          // modeled — only the pointer rewrite the app verifies from the save echo.
          if (this.currentSlot !== msg.value) {
            for (const s of IR_SLOTS) {
              if (blob[s.pairMsb]! <= 0x01 && blob[s.mode] !== 0) {
                blob[s.pairMsb] = s.bank;
                blob[s.pairLsb] = msg.value & 0x7f;
              }
            }
          }
          if (msg.value < 0x7e && msg.value < this.presets.length) this.presets[msg.value] = blob;
          this.currentSlot = msg.value; // the save parks the pedal on its target program
          const echo: Exclude<PedalMessage, { kind: "unknown" }> = {
            kind: "presetDump",
            slot: msg.value,
            blob: blob.slice(),
            checksumOk: true,
          };
          this.drainStagedDump(); // the echo is a dump: it also applies a pending tuner write
          return [echo];
        }
        // Every other live set lands in the live param array. 0x10/0x11/0x13 map to indices
        // 0x4A/0x4B/0x4D — commands (preset up/down, red zone), not stored params — so they fall
        // outside the array and change nothing here.
        const index = liveSetIndex(msg.param);
        if (index <= LIVE_PARAM_LAST_INDEX) this.live[index] = msg.value & 0x7f;
        // The Tuner (index 0x34, set-id 0x38) records its value immediately but is only APPLIED by the
        // next staged dump — see `tuner` / `drainStagedDump`.
        if (msg.param === TUNER_SET_ID) this.tunerWritten = clampTuner(msg.value);
        return [];
      }
      // hello handled; control/paramNotify/dumps: no reply
      default:
        return [];
    }
  }
}

export { EDIT_BUFFER_SLOT };
