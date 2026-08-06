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

import { PRESET_SIZE, PRESET_SLOT_COUNT } from "../protocol/constants";
import type { PedalMessage } from "../protocol/messages";

const EDIT_BUFFER_SLOT = 0x7f;

// Per-preset user-IR fields (PROTOCOL.md): the flat 14-bit IR record pair (MSB, LSB) at blob bytes
// 0x57/0x58 (slot 7) and 0x59/0x5A (slot 8), the per-slot enable at 0x4A/0x4B, and each slot's
// private-record bank (record = bank·128 + program).
const IR_SLOTS = [
  { pairMsb: 0x57, pairLsb: 0x58, mode: 0x4a, bank: 0x00 },
  { pairMsb: 0x59, pairLsb: 0x5a, mode: 0x4b, bank: 0x01 },
] as const;

export class PedalModel {
  readonly presets: Uint8Array[];
  editBuffer: Uint8Array;
  /** The program the pedal is sitting on (recall sets it; a save parks on its target). */
  currentSlot = 0;
  /** Config/data blocks the app has written (keyed `blockCode:index`), for read-back. */
  private readonly blocks = new Map<string, Uint8Array>();
  /** A read (05 40) only succeeds once the connect handshake has run. */
  connected = false;

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
  }

  private blobFor(slot: number): Uint8Array {
    return slot >= 0x7e ? this.editBuffer : (this.presets[slot] ?? this.editBuffer);
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
        return [
          {
            kind: "block",
            blockCode,
            index: msg.index,
            data: stored ? stored.slice() : new Uint8Array(PRESET_SIZE),
            checksumOk: true,
          },
        ];
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
        }
        return [{ kind: "presetDump", slot: msg.slot, blob: blob.slice(), checksumOk: true }];
      }
      case "writePreset": {
        // 0x7E/0x7F are NOT numbered slots: the pedal DISCARDS an edit-buffer stage (05 20 0A 7F) yet
        // still acks it 05 21 (confirmed — every such write in captures/m1-live.jsonl is acked). So
        // accept the frame, change nothing for the special slots, and ack like hardware.
        if (msg.slot < 0x7e && msg.slot < this.presets.length)
          this.presets[msg.slot] = msg.blob.slice();
        return [{ kind: "writeAck", code: 0x21 }];
      }
      case "setParam": {
        // 0x12 = <slot> is the SAVE-to-slot command (a reserved command id, NOT a param): the pedal
        // persists the staged slot and echoes a 05 41 <slot> dump (confirmed via captures/elite-save.
        // jsonl). 0x12 = 0x7F is the same command aimed at program 127 (INIT) — EliteControl's IR
        // import sends it while sitting there, making it a no-op re-save; we echo the
        // program-127 dump. Every other setParam is live-only: no reply.
        if (msg.param === 0x12) {
          // Saving to a DIFFERENT program repoints each ENABLED user-IR slot with a private record
          // pointer (pair MSB ≤ 1) at the target's own record — the copy-on-save-as that hands a
          // per-preset IR over (derived from the factory bank's 10/10 record==program correlation +
          // EliteControl's captured import; on-device verification pending). Record CONTENTS aren't
          // modeled — only the pointer rewrite the app verifies from the save echo.
          const saved = msg.value < 0x7e ? this.presets[msg.value] : undefined;
          if (saved && this.currentSlot !== msg.value) {
            for (const s of IR_SLOTS) {
              if (saved[s.pairMsb]! <= 0x01 && saved[s.mode] !== 0) {
                saved[s.pairMsb] = s.bank;
                saved[s.pairLsb] = msg.value & 0x7f;
              }
            }
          }
          this.currentSlot = msg.value; // the save parks the pedal on its target program
          const blob = this.blobFor(msg.value);
          return [{ kind: "presetDump", slot: msg.value, blob: blob.slice(), checksumOk: true }];
        }
        return [];
      }
      // hello handled; control/paramNotify/dumps: no reply
      default:
        return [];
    }
  }
}

export { EDIT_BUFFER_SLOT };
