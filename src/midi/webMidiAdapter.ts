/**
 * Adapts a Web MIDI API `MIDIAccess` (from `@motiz88/react-native-midi` on device, or a
 * real browser) to our framework-free {@link MidiIO}. This is the only device-specific
 * seam — everything above it (session, store) is transport-agnostic and unit-tested.
 *
 * Request access with SysEx enabled: `requestMIDIAccess({ sysex: true })`.
 *
 * NOTE: part of the RN app surface — typechecked via tsconfig.json (needs DOM/WebMIDI
 * lib types), not the Node core config.
 */

import type { MidiIO } from "../device/transport";

export const DEFAULT_PORT_MATCH = "USB MIDI Driver"; // the MD1 enumerates as this; WIDI Jack shows its own name

// Tried in order by autodetect: Bluetooth (WIDI Jack) first, then the wired MD1 interface.
const PORT_CANDIDATES = ["WIDI", "USB MIDI Driver", "MD1"] as const;

type MidiPortLike = { name?: string | null };

function findByName<T extends MidiPortLike>(map: Iterable<T>, substr: string): T | undefined {
  const want = substr.toLowerCase();
  for (const port of map) if (port.name?.toLowerCase().includes(want)) return port;
  return undefined;
}

/** Wire a specific input+output pair into our transport-agnostic MidiIO. */
function bindPorts(input: MIDIInput, output: MIDIOutput): MidiIO {
  const listeners = new Set<(b: Uint8Array) => void>();
  const onMidi = (e: MIDIMessageEvent) => {
    if (!e.data) return;
    const bytes = new Uint8Array(e.data);
    for (const cb of listeners) cb(bytes);
  };
  input.addEventListener("midimessage", onMidi);
  void input.open?.();
  void output.open?.();

  return {
    send: (bytes) => output.send(bytes),
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => {
      input.removeEventListener("midimessage", onMidi);
      listeners.clear();
    },
  };
}

/**
 * Build a MidiIO bound to the first input+output whose name matches `portMatch`
 * (case-insensitive). Returns null if a matching pair isn't present.
 */
export function midiIOFromWebMidi(
  access: MIDIAccess,
  portMatch = DEFAULT_PORT_MATCH,
): MidiIO | null {
  const input = findByName(access.inputs.values(), portMatch);
  const output = findByName(access.outputs.values(), portMatch);
  if (!input || !output) return null;
  return bindPorts(input, output);
}

/**
 * Find the pedal without a hint: try the known interface names (WIDI Jack, MD1) in order, then fall
 * back to the first available input+output pair. Returns the MidiIO plus the chosen port name.
 */
export function midiIOAutodetect(access: MIDIAccess): { io: MidiIO; name: string } | null {
  for (const candidate of PORT_CANDIDATES) {
    const input = findByName(access.inputs.values(), candidate);
    const output = findByName(access.outputs.values(), candidate);
    if (input && output) return { io: bindPorts(input, output), name: input.name ?? candidate };
  }
  const input = access.inputs.values().next().value as MIDIInput | undefined;
  const output = access.outputs.values().next().value as MIDIOutput | undefined;
  if (input && output) return { io: bindPorts(input, output), name: input.name ?? "MIDI port" };
  return null;
}

const portNames = (ports: Iterable<{ name?: string | null }>) =>
  [...ports].map((p) => p.name ?? "(unnamed)");

/** List available MIDI port names (for a connection picker UI). */
export function listPortNames(access: MIDIAccess): { inputs: string[]; outputs: string[] } {
  return { inputs: portNames(access.inputs.values()), outputs: portNames(access.outputs.values()) };
}
