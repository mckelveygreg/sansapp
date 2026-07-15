/**
 * SysEx message codec for the PBDR Elite.
 *
 * `decode` NEVER throws — unrecognized input returns `{ kind: "unknown" }`.
 *
 * All messages share the frame `F0 00 51 21  05 <sub> 0A  <args…>  F7` (`0x05` = "data"
 * command, `0x0A` = fixed marker). Big payloads (presets and data blocks) carry a
 * 256-byte body plus a 2-byte 14-bit checksum. Everything below is CONFIRMED from live
 * capture unless noted.
 *
 *   app → pedal                         pedal → app (reply / notify)
 *   05 5F 0A            hello           —
 *   05 6A 0A <i>        req config      05 6B 0A <i> <256> <ck>   configBlock
 *   05 55 0A <i>        req data block  05 52 0A <i> <256> <ck>   dataBlock
 *   05 5B 0A            control (role?) —
 *   05 40 0A <slot>     read preset     05 41 0A <slot> <256> <ck> presetDump
 *   05 23 0A <slot>     recall preset   05 41 0A <slot> <256> <ck> presetDump
 *   05 50 0A <p> <v>    set param       (no echo)
 *   05 20 0A <slot> <256> <ck>  write preset    05 21 F7                  writeAck
 *   05 52 0A <i> <256> <ck>  WRITE data block    05 53 F7                  blockAck
 *   05 6B 0A <i> <256> <ck>  WRITE config block  05 53 F7                  blockAck
 *   —                                   05 51 0A <p> <v>          paramNotify (physical knob)
 *
 * blockAck (05 53 F7, 2-byte no marker) pairs 1:1 with each app block write, exactly like
 * 05 21 acks a 05 20 preset write. Both decode as { kind: "writeAck", code }.
 *
 * Note: reads (05 40) only work after the connect handshake (hello → blocks → 5B).
 * setParam (05 50) changes the live sound but is NOT reflected in read-backs.
 * The data/config block opcodes (05 52 / 05 6B) are BIDIRECTIONAL: the pedal sends them
 * as replies, and the app sends them to WRITE settings. Special Page Functions (P1–P9)
 * live as boolean bytes in data block index 0x00 (confirmed: toggling them re-sends the
 * whole block with one byte flipped). Encode either via { kind: "block", blockCode, index,
 * data }. Block index 0x02 = the MIDI Program-Change → preset map (identity 00 01 02 …).
 *
 * Framework-free: no React/React Native imports.
 */

import { MANUFACTURER_ID, PRESET_SIZE, SYSEX_END, SYSEX_PREFIX, SYSEX_START } from "./constants";

// sub-command bytes (body[1])
const SET_PARAM = 0x50;
const PARAM_NOTIFY = 0x51;
const RECALL_PRESET = 0x23;
const READ_PRESET = 0x40;
const PRESET_DUMP = 0x41;
const WRITE_PRESET = 0x20;
const REQ_DATA_BLOCK = 0x55;
const DATA_BLOCK = 0x52;
const REQ_CONFIG_BLOCK = 0x6a;
const CONFIG_BLOCK = 0x6b;
const HELLO = 0x5f;
const CONTROL_5B = 0x5b;
const IR_UPLOAD_BEGIN_ACK = 0x63; // 05 63 00 F7 — pedal's ack of an IR-upload begin (05 60)

const MARKER = 0x0a;
const BLOCK_BODY_LEN = 4 + PRESET_SIZE + 2; // sub,marker-pos,index + 256 + 2 checksum

export type PedalMessage =
  // app → pedal
  | { kind: "hello" }
  | { kind: "control"; code: number }
  | { kind: "writeAck"; code: number } // 05 21 F7 (no marker) — pedal's ack of a 0x20 write
  | { kind: "setParam"; param: number; value: number }
  | { kind: "recallPreset"; slot: number }
  | { kind: "requestPreset"; slot: number }
  | { kind: "requestBlock"; reqCode: number; index: number }
  | { kind: "writePreset"; slot: number; blob: Uint8Array; checksumOk: boolean }
  // pedal → app
  | { kind: "paramNotify"; param: number; value: number }
  | { kind: "presetDump"; slot: number; blob: Uint8Array; checksumOk: boolean }
  | { kind: "block"; blockCode: number; index: number; data: Uint8Array; checksumOk: boolean }
  | { kind: "unknown"; data: Uint8Array };

/** 14-bit sum of `bytes`, returned as [high7, low7] — the preset/block checksum. */
export function checksum14(bytes: Uint8Array): [number, number] {
  let s = 0;
  for (const b of bytes) s += b;
  return [(s >> 7) & 0x7f, s & 0x7f];
}

/** True if `data` is a complete Tech 21 SysEx message for this device. */
export function isPedalSysEx(data: Uint8Array): boolean {
  return (
    data.length >= 7 &&
    data[0] === SYSEX_START &&
    data[1] === MANUFACTURER_ID[0] &&
    data[2] === MANUFACTURER_ID[1] &&
    data[3] === MANUFACTURER_ID[2] &&
    data[4] === 0x05 && // "data" command
    data[data.length - 1] === SYSEX_END
  );
}

export function decode(data: Uint8Array): PedalMessage {
  if (!isPedalSysEx(data)) return { kind: "unknown", data: data.slice() };
  const body = data.subarray(4, data.length - 1); // 05 <sub> [0A <args…>]
  const sub = body[1]!;
  const len = body.length;

  if (len === 2) return { kind: "writeAck", code: sub }; // 05 <code> F7 (no marker) — e.g. 05 21
  // IR-upload begin ack is 05 63 00 F7 (a zero arg, not the 0x0A marker) — treat as an ack too.
  if (len === 3 && sub === IR_UPLOAD_BEGIN_ACK) return { kind: "writeAck", code: sub };
  if (body[2] !== MARKER) return { kind: "unknown", data: data.slice() };
  if (len === 5 && sub === SET_PARAM) return { kind: "setParam", param: body[3]!, value: body[4]! };
  if (len === 5 && sub === PARAM_NOTIFY)
    return { kind: "paramNotify", param: body[3]!, value: body[4]! };
  if (len === 4 && sub === RECALL_PRESET) return { kind: "recallPreset", slot: body[3]! };
  if (len === 4 && sub === READ_PRESET) return { kind: "requestPreset", slot: body[3]! };
  if (len === 4 && (sub === REQ_DATA_BLOCK || sub === REQ_CONFIG_BLOCK))
    return { kind: "requestBlock", reqCode: sub, index: body[3]! };
  if (len === 3 && (sub === HELLO || sub === CONTROL_5B))
    return sub === HELLO ? { kind: "hello" } : { kind: "control", code: sub };

  if (
    len === BLOCK_BODY_LEN &&
    (sub === PRESET_DUMP || sub === WRITE_PRESET || sub === DATA_BLOCK || sub === CONFIG_BLOCK)
  ) {
    const payload = body.slice(4, 4 + PRESET_SIZE);
    const [hi, lo] = checksum14(payload);
    const checksumOk = body[4 + PRESET_SIZE] === hi && body[5 + PRESET_SIZE] === lo;
    if (sub === PRESET_DUMP)
      return { kind: "presetDump", slot: body[3]!, blob: payload, checksumOk };
    if (sub === WRITE_PRESET)
      return { kind: "writePreset", slot: body[3]!, blob: payload, checksumOk };
    return { kind: "block", blockCode: sub, index: body[3]!, data: payload, checksumOk };
  }

  return { kind: "unknown", data: data.slice() };
}

export function encode(msg: Exclude<PedalMessage, { kind: "unknown" }>): Uint8Array {
  switch (msg.kind) {
    case "hello":
      return frame([0x05, HELLO, MARKER]);
    case "control":
      return frame([0x05, msg.code & 0x7f, MARKER]);
    case "writeAck":
      return frame([0x05, msg.code & 0x7f]);
    case "setParam":
      return frame([0x05, SET_PARAM, MARKER, msg.param & 0x7f, msg.value & 0x7f]);
    case "paramNotify":
      return frame([0x05, PARAM_NOTIFY, MARKER, msg.param & 0x7f, msg.value & 0x7f]);
    case "recallPreset":
      return frame([0x05, RECALL_PRESET, MARKER, msg.slot & 0x7f]);
    case "requestPreset":
      return frame([0x05, READ_PRESET, MARKER, msg.slot & 0x7f]);
    case "requestBlock":
      return frame([0x05, msg.reqCode & 0x7f, MARKER, msg.index & 0x7f]);
    case "presetDump": {
      const [hi, lo] = checksum14(msg.blob);
      return frame([0x05, PRESET_DUMP, MARKER, msg.slot & 0x7f, ...msg.blob, hi, lo]);
    }
    case "writePreset": {
      const [hi, lo] = checksum14(msg.blob);
      return frame([0x05, WRITE_PRESET, MARKER, msg.slot & 0x7f, ...msg.blob, hi, lo]);
    }
    case "block": {
      const [hi, lo] = checksum14(msg.data);
      return frame([0x05, msg.blockCode & 0x7f, MARKER, msg.index & 0x7f, ...msg.data, hi, lo]);
    }
  }
}

/** Wrap a body (command + data bytes) in the SysEx prefix and terminator. */
function frame(body: readonly number[]): Uint8Array {
  return Uint8Array.of(...SYSEX_PREFIX, ...body, SYSEX_END);
}
