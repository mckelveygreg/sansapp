/**
 * DeviceSession — drives the pedal over a {@link MidiIO}: runs the connect handshake,
 * reads/recalls/writes presets, sends live parameter edits, and surfaces incoming
 * notifications. Pure and framework-free so it runs on the phone, in Node, and in tests.
 */

import { PARAM_IDS, PARAMS, liveSetId } from "../protocol/params";
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

// A slot write is STAGED by `05 20` then persisted by the `05 50 0A 12 <slot>` commit; the pedal echoes
// a `05 41 <slot>` dump on success. Over BLE that fire-and-forget commit can drop (write staged, never
// persisted — the copy/save-didn't-stick bug), so writePreset awaits the echo and re-sends the commit
// up to this many times before giving up.
const COMMIT_ATTEMPTS = 3;

// The heartbeat skips its probe if we sent anything within this window — recent traffic already
// proves the link is alive, and probing mid-burst (e.g. a run of setParam knob-moves saturating the
// BLE TX) can time out and cause a FALSE disconnect. Must be < the heartbeat interval.
const HEARTBEAT_QUIET_MS = 2500;

// A send() throw only counts as a real disconnect if the link has ALSO been silent (no reply) this
// long. Over BLE a lone throw is often a transient CoreMIDI destination drop under a heavy read burst
// (e.g. the IR refresh) that recovers on its own — while replies are still arriving we ride it out.
// Sustained silence + a failing send = the port is genuinely gone.
const LINK_SILENCE_MS = 2500;

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
  private readonly slotCbs = new Set<(slot: number) => void>();
  private readonly pushedPresetCbs = new Set<(slot: number, preset: Preset) => void>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private hbFails = 0;
  /** Wall-clock ms of the last outbound send — the heartbeat treats recent traffic as "link alive". */
  private lastSendAt = 0;
  /** Wall-clock ms of the last message RECEIVED. Recent replies prove the link is alive even when an
   * individual send throws (a transient CoreMIDI drop under a heavy read burst) — see onSendFailure. */
  private lastReceiveAt = 0;
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
  /** Backstop: the pedal's active slot, polled by the heartbeat (catches a dropped preset push). */
  onSlotChange(cb: (slot: number) => void): () => void {
    this.slotCbs.add(cb);
    return () => this.slotCbs.delete(cb);
  }
  /**
   * The pedal changed preset on its OWN (footswitch): it pushes an unsolicited `05 41` full preset
   * dump, and this fires INSTANTLY with the decoded preset — the same mechanism EliteControl uses.
   */
  onPushedPreset(cb: (slot: number, preset: Preset) => void): () => void {
    this.pushedPresetCbs.add(cb);
    return () => this.pushedPresetCbs.delete(cb);
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
    // Map index → live-set wire id (deep params set on index+4). Notify path keeps the raw index.
    this.send({ kind: "setParam", param: liveSetId(raw), value: value & 0x7f });
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
    const s = slot & 0x7f;
    // Stage the blob; the pedal acks with 05 21.
    await this.request(
      { kind: "writePreset", slot: s, blob, checksumOk: true },
      (m) => m.kind === "writeAck",
    );
    // Commit it: `05 50 0A 12 <slot>` (value == destination slot — byte-for-byte EliteControl's Save,
    // confirmed against captures/elite-save.jsonl; NOT a param write). On success the pedal echoes a
    // `05 41 <slot>` dump — await that as CONFIRMATION and re-send the commit if it doesn't arrive.
    // EliteControl fires-and-forgets over its reliable USB link; over BLE the commit can silently drop,
    // leaving the write staged but never persisted (the copy/save-didn't-stick bug). Throws — leaving
    // the slot unchanged, since an uncommitted write is discarded — if the pedal never confirms.
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      try {
        await this.request(
          { kind: "setParam", param: 0x12, value: s },
          (m) => m.kind === "presetDump" && m.slot === s,
        );
        return;
      } catch {
        // No echo — the commit likely dropped over BLE; re-send it (committing twice is idempotent).
      }
    }
    throw new Error(`preset ${s + 1} save not confirmed by the pedal`);
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

  /** Send a pre-encoded SysEx message verbatim (e.g. an IR read/upload chunk). */
  sendRaw(bytes: Uint8Array): void {
    this.rawSend(bytes);
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
    // unsub()/io.close() can throw on an already-dead port (BLE drop). Guard them so disconnect() is
    // safe to call from send()'s error path — it must never throw back into a UI event handler.
    try {
      this.unsub();
    } catch {
      /* already torn down */
    }
    try {
      this.io.close();
    } catch {
      /* port already gone */
    }
    this.setState("disconnected");
  }

  private handleIncoming(m: PedalMessage): void {
    this.lastReceiveAt = Date.now(); // any reply proves the link is alive (see onSendFailure)
    let matched = false;
    for (const p of this.pending) {
      if (p.match(m)) {
        clearTimeout(p.timer);
        this.pending.delete(p);
        p.resolve(m);
        matched = true;
        break;
      }
    }
    // An UNSOLICITED preset dump = the pedal changed preset by itself (footswitch). It pushes the
    // full `05 41` dump — the same thing EliteControl reacts to — so apply it instantly. (A dump we
    // requested matches a pending read above, so it never reaches here.)
    if (!matched && m.kind === "presetDump" && m.checksumOk) {
      try {
        const preset = decodePreset(m.blob);
        for (const cb of this.pushedPresetCbs) cb(m.slot, preset);
      } catch {
        // ignore a malformed push
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
    const run = async () => {
      // Pace the read off the LAST outbound byte on the wire. Over BLE the pedal drops a reply-
      // expecting read that arrives in the same connection interval as a preceding fire-and-forget
      // send (the hello, the 0x5B control, a setParam knob-move, or a writePreset commit) — those
      // sends bypass this queue, so a read fired right behind one never gets a reply and rejects with
      // "timeout awaiting reply to <kind>". Waiting out the remainder of sendGapMs since the last send
      // guarantees the read lands in a fresh interval. The hello→read case was verified on hardware
      // (2026-07-14); generalizing it here also covers the every-connect edit-buffer read
      // (connect→loadCurrent) and the back-to-back writePreset commits in copy/swapPresets. Request→
      // request is already paced by the prior round-trip, so this adds nothing there. sendGapMs=0
      // (tests, wired USB tools) skips it entirely — no BLE connection-interval batching to dodge.
      if (this.sendGapMs > 0) {
        const sinceSend = Date.now() - this.lastSendAt;
        if (sinceSend < this.sendGapMs) await this.delay(this.sendGapMs - sinceSend);
      }
      return new Promise<PedalMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(entry);
          reject(new Error(`timeout awaiting reply to ${out.kind}`));
        }, this.timeoutMs);
        const entry: Pending = { match, resolve, reject, timer };
        this.pending.add(entry);
        this.send(out);
      });
    };
    const result = this.queue.then(run, run); // chain after the previous request settles
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private send(m: Exclude<PedalMessage, { kind: "unknown" }>): void {
    this.rawSend(encode(m));
  }

  /**
   * The single low-level write. Stamps lastSendAt (so the heartbeat backs off during a send burst —
   * including the IR read/upload stream, which goes through the public sendRaw) and routes a
   * torn-down-port throw through onSendFailure. Both send() and sendRaw() funnel here so they can't
   * drift in their failure/back-off handling.
   */
  private rawSend(bytes: Uint8Array): void {
    this.lastSendAt = Date.now();
    try {
      this.io.send(bytes);
    } catch {
      this.onSendFailure();
    }
  }

  /**
   * A send threw: io.send couldn't reach the MIDI port (InvalidStateError, or "destination not found"
   * from the patched native module). Over BLE this is often a TRANSIENT CoreMIDI drop under a heavy
   * read burst (e.g. the IR refresh) that recovers on its own — so a single throw must NOT tear down
   * the session (doing so mid-IR-refresh killed the link and blanked the remaining slots). Only
   * disconnect when the link has ALSO gone silent (no reply within LINK_SILENCE_MS): a genuinely dead
   * port fails every send AND stops replying. A real drop is still caught within ~one heartbeat, while
   * a transient during active traffic (replies still arriving) is ridden out. disconnect() (via the
   * state teardown) is hardened not to throw, so this never crashes the caller.
   */
  private onSendFailure(): void {
    if (Date.now() - this.lastReceiveAt >= LINK_SILENCE_MS) this.setState("disconnected");
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
    // Recent outbound traffic = link alive. setParam knob-moves are fire-and-forget (no pending
    // entry), so a burst wouldn't be caught by the check above; probing into that saturated TX can
    // time out and falsely disconnect. Skip this tick — the traffic itself is the liveness proof.
    if (Date.now() - this.lastSendAt < HEARTBEAT_QUIET_MS) return;
    try {
      const settings = await this.readBlock(0x55, 0);
      this.hbFails = 0;
      // block0[0] = the pedal's active preset slot. Report it so the app notices when the pedal
      // changes preset on its own (footswitch). Listeners de-dupe against what they're showing.
      const slot = settings[0];
      if (slot !== undefined && slot < 128) for (const cb of this.slotCbs) cb(slot);
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
