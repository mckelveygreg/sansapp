/**
 * MIDI transport abstraction — a tiny, Web MIDI-shaped surface the session engine
 * talks to. Concrete adapters (RN CoreMIDI, Node @julusian/midi, an in-process
 * loopback for tests) all implement `MidiIO`.
 *
 * Framework-free: no React/React Native imports.
 */

export interface MidiIO {
  /** Send a complete MIDI message (a full SysEx incl. F0…F7). */
  send(bytes: Uint8Array): void;
  /** Subscribe to incoming complete messages. Returns an unsubscribe fn. */
  onMessage(cb: (bytes: Uint8Array) => void): () => void;
  close(): void;
}

/**
 * Reassembles SysEx that arrives fragmented (as it can over BLE MIDI). Feed raw
 * chunks; complete messages (F0…F7) and complete non-SysEx messages are emitted whole.
 */
export class SysExReassembler {
  private buf: number[] = [];

  push(chunk: Uint8Array, emit: (msg: Uint8Array) => void): void {
    for (const b of chunk) {
      if (b === 0xf0) {
        this.buf = [b];
      } else if (this.buf.length > 0) {
        this.buf.push(b);
        if (b === 0xf7) {
          emit(Uint8Array.from(this.buf));
          this.buf = [];
        }
      } else if (b < 0x80) {
        // stray data byte outside any message; ignore
      } else {
        emit(Uint8Array.of(b)); // a standalone status byte (e.g. real-time)
      }
    }
  }
}

/**
 * A pair of in-process endpoints wired to each other, for tests and for driving the
 * pure {@link PedalModel} without real MIDI. Delivery is async (microtask) to mimic
 * real hardware ordering. Returns `[a, b]`; bytes sent on `a` arrive at `b` and vice-versa.
 */
export function createLoopback(): [MidiIO, MidiIO] {
  const listeners: [Set<(b: Uint8Array) => void>, Set<(b: Uint8Array) => void>] = [
    new Set(),
    new Set(),
  ];
  const make = (self: 0 | 1): MidiIO => {
    const other = (self === 0 ? 1 : 0) as 0 | 1;
    return {
      send(bytes) {
        const copy = bytes.slice();
        queueMicrotask(() => {
          for (const cb of listeners[other]) cb(copy);
        });
      },
      onMessage(cb) {
        listeners[self].add(cb);
        return () => listeners[self].delete(cb);
      },
      close() {
        listeners[self].clear();
      },
    };
  };
  return [make(0), make(1)];
}
