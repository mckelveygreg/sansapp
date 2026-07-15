/**
 * Native (iOS/Android) MIDI access. Metro auto-picks this `.native.ts` over `requestAccess.ts`
 * on device, so app code just imports `./requestAccess`.
 *
 * `@motiz88/react-native-midi` is a Web MIDI API polyfill (an Expo module), so its
 * `requestMIDIAccess` has the same shape our `webMidiAdapter` already consumes — no other code
 * changes. Bluetooth adapters (the CME WIDI Jack) appear here by name once paired to the phone at
 * the OS level (via the CME WIDI app or GarageBand's Bluetooth-MIDI sheet); our adapter then matches
 * the port by name. Requires a native build (`expo prebuild` + `npm run ios`) — not Expo Go.
 */
import { requestMIDIAccess as nativeRequestMIDIAccess } from "@motiz88/react-native-midi";

// The polyfill's MIDIAccess is runtime-compatible with the DOM one our webMidiAdapter targets, but
// its .d.ts adds a required `receivedTime` on MIDIMessageEvent, so cast at this single seam.
export function requestMIDIAccess(options?: MIDIOptions): Promise<MIDIAccess> {
  return nativeRequestMIDIAccess(options) as unknown as Promise<MIDIAccess>;
}
