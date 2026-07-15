/**
 * DeviceSession — drives the pedal over a {@link MidiIO}: runs the connect handshake,
 * reads/recalls/writes presets, sends live parameter edits, and surfaces incoming
 * notifications. Pure and framework-free so it runs on the phone, in Node, and in tests.
 */

import { PARAM_IDS, PARAMS } from "../protocol/params";
import type { ParamId } from "../protocol/params";
import { decode, encode } from "../protocol/messages";
import type { PedalMessage } from "../protocol/messages";
import { decodePreset } from "../protocol/preset";
import type { Preset } from "../protocol/preset";
import { SysExReassembler } from "./transport";
import type { MidiIO } from "./transport";

export type ConnectionState = "disconnected" | "connecting" | "ready";

export interface ParamNotifyEvent {
  /** Mapped control id, or null if the raw param byte isn't in the registry yet. */
  paramId: ParamId | null;
  param: number;
  value: number;
}

const EDIT_BUFFER_SLOT = 0x7f;

const PARAM_BY_RAW = new Map<number, ParamId>();
for (const id of PARAM_IDS) {
  const raw = PARAMS[id].paramId;
  if (raw !== undefined) PARAM_BY_RAW.set(raw, id);
}

interface Pending {
  match: (m: PedalMessage) => boolean;
  resolve: (m: PedalMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeviceSession {
  state: ConnectionState = "disconnected";

  private readonly reasm = new SysExReassembler();
  private readonly unsub: () => void;
  private readonly pending = new Set<Pending>();
  private readonly stateCbs = new Set<(s: ConnectionState) => void>();
  private readonly paramCbs = new Set<(e: ParamNotifyEvent) => void>();
  private readonly msgCbs = new Set<(m: PedalMessage) => void>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private hbFails = 0;
  /** Serializes reply-expecting requests so only one round-trip is on the wire at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: MidiIO,
    private readonly timeoutMs = 2000,
    /** If > 0, poll the pedal every N ms once ready and drop to disconnected when the link dies. */
    private readonly heartbeatMs = 0,
    /** Gap between fire-and-forget handshake sends, so BLE doesn't drop them (0 = no pacing; the
     * app sets ~150 for Bluetooth, tests/USB tools leave it 0). */
    private readonly sendGapMs = 0,
  ) {
    this.unsub = io.onMessage((raw) => this.reasm.push(raw, (m) => this.handleIncoming(decode(m))));
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
  onParamNotify(cb: (e: ParamNotifyEvent) => void): () => void {
    this.paramCbs.add(cb);
    return () => this.paramCbs.delete(cb);
  }
  onMessage(cb: (m: PedalMessage) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }

  /** Run the connect handshake: hello → config/data blocks → control(5B). */
  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      this.send({ kind: "hello" });
      // Pace the handshake for BLE. Over the WIDI/Bluetooth link the pedal drops a read that arrives
      // in the same connection interval as the hello (verified 2026-07-14: back-to-back hello+read
      // timed out, the same read with a gap replied instantly). Fire-and-forget sends need this gap;
      // the awaited block reads below are naturally paced by their round-trips.
      await this.delay(this.sendGapMs);
      await this.request(
        { kind: "requestBlock", reqCode: 0x6a, index: 0 },
        (m) => m.kind === "block" && m.blockCode === 0x6b,
      );
      for (const index of [0x0f, 0x03, 0x00]) {
        await this.delay(this.sendGapMs);
        await this.request(
          { kind: "requestBlock", reqCode: 0x55, index },
          (m) => m.kind === "block" && m.blockCode === 0x52 && m.index === index,
        );
      }
      await this.delay(this.sendGapMs);
      this.send({ kind: "control", code: 0x5b });
      // Deliberately send NOTHING else. An earlier build sent `setParam 0x13 = 1` on a hypothesis it
      // was "Live Edit Mode" — but 0x13 is the Reverb Extension Factor (docs/PROTOCOL.md), so that
      // write silently changed a reverb setting (and possibly toggled a mode) on every connect.
      this.setState("ready");
    } catch (e) {
      this.setState("disconnected");
      throw e;
    }
  }

  /** Read a stored preset (or the edit buffer, slot 0x7F) without changing the active one. */
  async readPreset(slot: number): Promise<Preset> {
    const reply = await this.request(
      { kind: "requestPreset", slot },
      (m) => m.kind === "presetDump" && m.slot === slot,
    );
    if (reply.kind !== "presetDump") throw new Error("unexpected reply");
    return decodePreset(reply.blob);
  }

  /** Recall (load) a preset into the pedal's active/edit buffer. */
  async recallPreset(slot: number): Promise<Preset> {
    const reply = await this.request(
      { kind: "recallPreset", slot },
      (m) => m.kind === "presetDump" && m.slot === slot,
    );
    if (reply.kind !== "presetDump") throw new Error("unexpected reply");
    return decodePreset(reply.blob);
  }

  /** Live parameter edit (audible immediately; not persisted until a write). */
  setParam(paramId: ParamId, value: number): void {
    const raw = PARAMS[paramId].paramId;
    if (raw === undefined) return;
    this.send({ kind: "setParam", param: raw, value: value & 0x7f });
  }

  /**
   * Write a full preset blob to a slot (0x7F = edit buffer); awaits the pedal's ack, then COMMITS.
   *
   * The pedal only STAGES a `05 20` write — it acks it but discards it unless a commit follows:
   * `setParam 0x12 = <slot>` (0x7F commits the edit buffer, making an engine/type change live; a
   * numbered slot persists the save). Without the commit, writes silently vanish. Discovered
   * 2026-07-08 by capturing an EliteControl Save.
   */
  async writePreset(slot: number, blob: Uint8Array): Promise<void> {
    await this.request(
      { kind: "writePreset", slot, blob, checksumOk: true },
      (m) => m.kind === "writeAck",
    );
    // Commit ONLY when saving to a numbered slot. The edit buffer (0x7F) must NOT be committed:
    // setParam 0x12=127 makes the pedal jump to "program 128" and dump the working sound. Edit-buffer
    // writes take effect live with no commit — this matches EliteControl (its edit-buffer writes
    // have no 0x12; only its slot Save does).
    if ((slot & 0x7f) !== EDIT_BUFFER_SLOT) {
      this.send({ kind: "setParam", param: 0x12, value: slot & 0x7f });
    }
  }

  /**
   * Read a config/data block. `reqCode` 0x55 → data block (reply 0x52), 0x6A → config block
   * (reply 0x6B). Used for the pedal's global settings (data block 0) and PC map (block 2).
   */
  async readBlock(reqCode: number, index: number): Promise<Uint8Array> {
    const replyCode = reqCode === 0x6a ? 0x6b : 0x52;
    const reply = await this.request(
      { kind: "requestBlock", reqCode, index },
      (m) => m.kind === "block" && m.blockCode === replyCode && m.index === index,
    );
    if (reply.kind !== "block") throw new Error("unexpected reply");
    return reply.data;
  }

  /** Write a config/data block back to the pedal; awaits the block ack (05 53). */
  async writeBlock(blockCode: number, index: number, data: Uint8Array): Promise<void> {
    await this.request(
      { kind: "block", blockCode, index, data, checksumOk: true },
      (m) => m.kind === "writeAck",
    );
  }

  /** Send a pre-encoded SysEx message verbatim (e.g. replaying an IR-upload chunk on restore). */
  sendRaw(bytes: Uint8Array): void {
    this.io.send(bytes);
  }

  /** Read the live edit buffer. */
  readEditBuffer(): Promise<Preset> {
    return this.readPreset(EDIT_BUFFER_SLOT);
  }

  disconnect(): void {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
    this.unsub();
    this.io.close();
    this.setState("disconnected");
  }

  private handleIncoming(m: PedalMessage): void {
    for (const p of this.pending) {
      if (p.match(m)) {
        clearTimeout(p.timer);
        this.pending.delete(p);
        p.resolve(m);
        break;
      }
    }
    if (m.kind === "paramNotify") {
      const ev: ParamNotifyEvent = {
        paramId: PARAM_BY_RAW.get(m.param) ?? null,
        param: m.param,
        value: m.value,
      };
      for (const cb of this.paramCbs) cb(ev);
    }
    for (const cb of this.msgCbs) cb(m);
  }

  /**
   * Serialize every request onto a single queue — one round-trip on the wire at a time. The pedal
   * (especially over BLE) can't handle overlapping SysEx reads/writes; concurrent requests (e.g. the
   * heartbeat colliding with a preset read) caused "timeout awaiting reply". Fire-and-forget sends
   * (setParam) bypass this — they expect no reply.
   */
  private request(
    out: Exclude<PedalMessage, { kind: "unknown" }>,
    match: (m: PedalMessage) => boolean,
  ): Promise<PedalMessage> {
    const run = () =>
      new Promise<PedalMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(entry);
          reject(new Error(`timeout awaiting reply to ${out.kind}`));
        }, this.timeoutMs);
        const entry: Pending = { match, resolve, reject, timer };
        this.pending.add(entry);
        this.send(out);
      });
    const result = this.queue.then(run, run); // chain after the previous request settles
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private send(m: Exclude<PedalMessage, { kind: "unknown" }>): void {
    this.io.send(encode(m));
  }

  private delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  /**
   * Liveness probe: BLE/CoreMIDI rarely reports a clean disconnect, so once ready we quietly ping the
   * pedal on a timer. Skips when a request is already in flight (traffic = alive). Two misses in a row
   * (≈2 intervals) → we've lost the link; flip to disconnected so the UI stops showing a stale
   * "connected" dot. Only runs when constructed with heartbeatMs > 0 (the app; not tests/tools).
   */
  private async heartbeat(): Promise<void> {
    if (this.state !== "ready" || this.pending.size > 0) return;
    try {
      await this.readBlock(0x55, 0);
      this.hbFails = 0;
    } catch {
      if (++this.hbFails >= 2) {
        this.hbFails = 0;
        this.setState("disconnected");
      }
    }
  }

  private setState(s: ConnectionState): void {
    if (s === this.state) return;
    this.state = s;
    if (s === "ready" && this.heartbeatMs > 0) {
      this.hbFails = 0;
      this.heartbeatTimer ??= setInterval(() => void this.heartbeat(), this.heartbeatMs);
    } else if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const cb of this.stateCbs) cb(s);
  }
}
