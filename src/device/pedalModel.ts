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

export class PedalModel {
  readonly presets: Uint8Array[];
  editBuffer: Uint8Array;
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
        if (msg.kind === "recallPreset") this.editBuffer = blob.slice();
        return [{ kind: "presetDump", slot: msg.slot, blob: blob.slice(), checksumOk: true }];
      }
      case "writePreset": {
        if (msg.slot >= 0x7e) this.editBuffer = msg.blob.slice();
        else if (msg.slot < this.presets.length) this.presets[msg.slot] = msg.blob.slice();
        return [{ kind: "writeAck", code: 0x21 }];
      }
      case "setParam": {
        // 0x12 = <slot> is the SAVE commit — the real pedal persists the staged slot and echoes a
        // 05 41 <slot> dump (confirmed via captures/elite-save.jsonl). Every other setParam is
        // live-only: no reply, not reflected in reads.
        if (msg.param === 0x12) {
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
