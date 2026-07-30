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

// The highest writable stored-preset slot. 0x7E/0x7F are NOT numbered slots: staging to 0x7F is
// discarded by the pedal, and the save command `05 50 0A 12 7F` saves-to/jumps-to program 128
// (PROTOCOL-MAP §1). writePreset rejects anything above this.
const MAX_WRITABLE_SLOT = 0x7d;

// A live-set knob/mic drag can emit ~60 moves/s. The pedal drops fire-and-forget sends that land in
// one BLE connection interval, so we COALESCE per param: at most one wire message per param per this
// window, always carrying the LATEST value (leading + trailing edge) so the final value can't be lost.
const LIVE_THROTTLE_MS = 40;

// How long a timed-out request's identity is remembered. A BLE reply can arrive AFTER its request
// timed out (round-trips exceed the 4 s timeout); within this window an unmatched presetDump matching
// a dead request is a LATE REPLY (dropped), not an unsolicited footswitch push — see handleIncoming.
const TOMBSTONE_MS = 10_000;

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

/** Identity of a request that timed out; a late reply matching it is dropped (see handleIncoming). */
interface Tombstone {
  match: (m: PedalMessage) => boolean;
  expiresAt: number;
}

/** Per-param coalescing state for the live-set throttle (setLiveParam). */
interface LiveParam {
  /** Latest requested value. */
  value: number;
  /** Last value actually put on the wire (−1 = none yet). */
  sent: number;
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
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
  /** Timed-out requests, kept ~TOMBSTONE_MS so a late reply isn't mistaken for a footswitch push. */
  private readonly tombstones: Tombstone[] = [];
  /** Per-param live-set coalescing state (keyed by the wire set-id). */
  private readonly liveParams = new Map<number, LiveParam>();
  /** True while a withExclusive block owns the link — the heartbeat probe suspends for its duration. */
  private exclusive = false;

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
      // was "Live Edit Mode" — but in the set/command space 0x13 is a reserved command id, not a
      // parameter write (the Reverb Extension Factor sets on 0x17), so that emitted a stray command
      // on every connect.
      this.setState("ready");
    } catch (e) {
      this.setState("disconnected");
      throw e;
    }
  }

  /** Read a stored preset (or slot 0x7F = program 127, which doesn't track live edits) without
   * changing the active one. */
  async readPreset(slot: number): Promise<Preset> {
    // Require checksumOk: a corrupted dump must NOT resolve the read. Worst case a corrupt 256-byte
    // block is decoded, one byte flipped, and the WHOLE block written back — the config-block brick.
    const reply = await this.request(
      { kind: "requestPreset", slot },
      (m) => m.kind === "presetDump" && m.slot === slot && m.checksumOk,
    );
    if (reply.kind !== "presetDump") throw new Error("unexpected reply");
    return decodePreset(reply.blob);
  }

  /** Recall (load) a preset into the pedal's active/edit buffer. */
  async recallPreset(slot: number): Promise<Preset> {
    const reply = await this.request(
      { kind: "recallPreset", slot },
      (m) => m.kind === "presetDump" && m.slot === slot && m.checksumOk,
    );
    if (reply.kind !== "presetDump") throw new Error("unexpected reply");
    return decodePreset(reply.blob);
  }

  /** Live parameter edit (audible immediately; not persisted until a write). Coalesced per param. */
  setParam(paramId: ParamId, value: number): void {
    const raw = PARAMS[paramId].paramId;
    if (raw === undefined) return;
    // Map index → live-set wire id (deep params set on index+4). Notify path keeps the raw index.
    this.setLiveParam(liveSetId(raw), value);
  }

  /**
   * Coalesced live-set: send at most one `05 50` per param per LIVE_THROTTLE_MS, always emitting the
   * LATEST value (leading + trailing edge). A knob/mic drag emits per-move sends up to ~60/s; the pedal
   * drops same-interval bursts, and a dropped FINAL move would leave pedal ≠ store (and a later save
   * would persist a value the user isn't hearing). UI/store updates stay instant — this only shapes the
   * wire, and distinct params never block each other (separate windows). `param` is the already
   * live-set-mapped wire id (liveParam.ts / setParam both map before calling here).
   */
  setLiveParam(param: number, value: number): void {
    const v = value & 0x7f;
    let e = this.liveParams.get(param);
    if (!e) {
      e = { value: v, sent: -1, lastSentAt: 0 };
      this.liveParams.set(param, e);
    }
    e.value = v;
    if (e.timer) return; // a window is open — the latest value is recorded; it flushes on close
    const sinceLast = Date.now() - e.lastSentAt;
    if (sinceLast >= LIVE_THROTTLE_MS) {
      this.emitLive(param, e); // leading edge: send now
      e.timer = setTimeout(() => this.flushLive(param), LIVE_THROTTLE_MS);
    } else {
      // Inside the previous window: hold and flush the latest value when it closes (trailing edge).
      e.timer = setTimeout(() => this.flushLive(param), LIVE_THROTTLE_MS - sinceLast);
    }
  }

  private emitLive(param: number, e: LiveParam): void {
    e.sent = e.value;
    e.lastSentAt = Date.now();
    this.send({ kind: "setParam", param, value: e.value });
  }

  private flushLive(param: number): void {
    const e = this.liveParams.get(param);
    if (!e) return;
    e.timer = undefined;
    // Trailing edge: send only if a newer value arrived during the window; otherwise close (the next
    // call starts a fresh leading edge). This guarantees the FINAL value is always on the wire.
    if (e.value !== e.sent) {
      this.emitLive(param, e);
      e.timer = setTimeout(() => this.flushLive(param), LIVE_THROTTLE_MS);
    }
  }

  /**
   * Fire a batch of live-set params, gapped by sendGapMs so BLE doesn't drop the burst (the pedal
   * silently drops fire-and-forget sends landing in one connection interval — same reason connect()
   * paces its sends). A single setParam is fine; a rapid run like the 10-param ambience profile loses
   * most messages without this gap. `param` is the already-live-set-mapped wire id.
   */
  async setParamsPaced(sets: readonly { param: number; value: number }[]): Promise<void> {
    for (let i = 0; i < sets.length; i++) {
      if (i === 0) {
        // Pace the FIRST send off the last outbound byte too (exactly like request()) — otherwise the
        // batch boundary lands in the same BLE connection interval as whatever preceded it (e.g.
        // setAmbienceType's 10th send right before recipes fires this) and the pedal drops it.
        if (this.sendGapMs > 0) {
          const sinceSend = Date.now() - this.lastSendAt;
          if (sinceSend < this.sendGapMs) await this.delay(this.sendGapMs - sinceSend);
        }
      } else {
        await this.delay(this.sendGapMs);
      }
      this.send({ kind: "setParam", param: sets[i]!.param, value: sets[i]!.value & 0x7f });
    }
  }

  /**
   * Write a full preset blob to a numbered slot, then persist with the save command
   * `05 50 0A 12 <slot>` and await the pedal's `05 41` echo. Never 0x7F — the pedal treats
   * `0x12=0x7F` as save-to-program-128.
   */
  async writePreset(slot: number, blob: Uint8Array): Promise<void> {
    // Reject the special/edit-buffer slots (0x7E/0x7F): a `05 20` stage to 0x7F is discarded, and the
    // save `05 50 0A 12 7F` jumps to program 128. Guards a captured edit-buffer dump (`05 41 7F …`) in
    // a .p3b from walking through restorePlan into a save-to-128.
    if (slot > MAX_WRITABLE_SLOT) {
      throw new Error(
        `invalid preset slot 0x${slot.toString(16)} — 0x7E/0x7F are not writable slots`,
      );
    }
    const s = slot & 0x7f;
    // Stage the blob; the pedal acks with 05 21 (match that specific code — a concurrent raw op's
    // begin-ack 0x63 is also a writeAck and must NOT satisfy this).
    await this.request(
      { kind: "writePreset", slot: s, blob, checksumOk: true },
      (m) => m.kind === "writeAck" && m.code === 0x21,
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
    // Require checksumOk: a corrupt block must not resolve the read (see readPreset — this is the
    // config-block brick vector: edit a byte of a corrupt block, write the whole thing back).
    const reply = await this.request(
      { kind: "requestBlock", reqCode, index },
      (m) => m.kind === "block" && m.blockCode === replyCode && m.index === index && m.checksumOk,
    );
    if (reply.kind !== "block") throw new Error("unexpected reply");
    return reply.data;
  }

  /** Write a config/data block back to the pedal; awaits the block ack (05 53). */
  async writeBlock(blockCode: number, index: number, data: Uint8Array): Promise<void> {
    // Match the specific block-ack code 0x53 — any other writeAck (e.g. an IR begin-ack 0x63 from a
    // concurrent raw op) must not satisfy this.
    await this.request(
      { kind: "block", blockCode, index, data, checksumOk: true },
      (m) => m.kind === "writeAck" && m.code === 0x53,
    );
  }

  /** Send a pre-encoded SysEx message verbatim (e.g. an IR read/upload chunk). */
  sendRaw(bytes: Uint8Array): void {
    this.rawSend(bytes);
  }

  /**
   * Run `fn` with EXCLUSIVE access to the link: it chains on the request queue (so no queued request —
   * e.g. a heartbeat block-read — interleaves) AND suspends the heartbeat probe for its duration. The
   * raw IR read/upload streams bypass the queue with direct sendRaw + onMessage taps: a probe firing
   * INTO a passive multi-second receive stream garbles slots / false-disconnects mid-pull, and crowding
   * the pedal's IR flash write is the historical brick vector. The quiet timer is reset on exit so the
   * next heartbeat doesn't immediately probe the tail of the stream.
   */
  withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.exclusive = true;
      try {
        return await fn();
      } finally {
        this.exclusive = false;
        this.lastSendAt = Date.now(); // recent activity — keep the heartbeat backed off one more window
      }
    };
    const result = this.queue.then(run, run); // chain after the previous queued op settles
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The RN MIDI polyfill sends fire-and-forget and swallows its native Promise rejection; the sansApp
   * patch re-surfaces it (globalThis.__midiSendError) and the app routes it here, so an async
   * "destination not found" reaches the same fast-disconnect logic as a synchronous send throw instead
   * of only being noticed ~one heartbeat later. On-device verification pending.
   */
  noteSendError(): void {
    this.onSendFailure();
  }

  /** Read slot 0x7F (program 127; does not track live edits). */
  readEditBuffer(): Promise<Preset> {
    return this.readPreset(EDIT_BUFFER_SLOT);
  }

  disconnect(): void {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
    // Cancel any pending trailing live-set sends and drop stale tombstones — the port is going away.
    for (const e of this.liveParams.values()) if (e.timer) clearTimeout(e.timer);
    this.liveParams.clear();
    this.tombstones.length = 0;
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
      // …UNLESS it's a LATE reply to a read that already timed out (BLE round-trips can exceed the
      // timeout). Applying it would "switch" the app to a preset the pedal never moved to — wiping the
      // dirty flag + editor state. A live tombstone identifies it; drop it (and don't fan it out).
      if (this.consumeTombstone(m)) return;
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
   * Prune expired tombstones and, if `m` satisfies a live one, consume it and return true (this is a
   * late reply to a timed-out request, not new pedal state). See TOMBSTONE_MS / handleIncoming.
   */
  private consumeTombstone(m: PedalMessage): boolean {
    const now = Date.now();
    let hit = false;
    for (let i = this.tombstones.length - 1; i >= 0; i--) {
      const t = this.tombstones[i]!;
      if (t.expiresAt <= now) {
        this.tombstones.splice(i, 1); // expired
      } else if (!hit && t.match(m)) {
        this.tombstones.splice(i, 1); // consume once
        hit = true;
      }
    }
    return hit;
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
          // Remember this dead request briefly: over BLE a reply can still arrive after the timeout.
          // Without the tombstone, handleIncoming would mistake a late presetDump for a footswitch push.
          this.tombstones.push({ match, expiresAt: Date.now() + TOMBSTONE_MS });
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
    if (this.state !== "ready" || this.pending.size > 0 || this.exclusive) return;
    // Recent traffic in EITHER direction = link alive, so skip this probe. Outbound: setParam
    // knob-moves and IR sends are fire-and-forget (no pending entry) — probing into that saturated TX
    // can time out and falsely disconnect. Inbound: a passive IR receive stream (also no pending
    // entry) proves the link without a probe. The traffic itself is the liveness proof.
    if (Date.now() - Math.max(this.lastSendAt, this.lastReceiveAt) < HEARTBEAT_QUIET_MS) return;
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
