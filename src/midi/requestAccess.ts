/**
 * Returns a Web MIDI `MIDIAccess`. On web / desktop Chrome this uses the browser's
 * `navigator.requestMIDIAccess`. For a native iOS/Android device build, add
 * `requestAccess.native.ts` that re-exports from `@motiz88/react-native-midi` — Metro
 * picks the platform file automatically. (Kept web-first so the app renders + connects
 * in a browser for development.)
 */
export function requestMIDIAccess(options?: MIDIOptions): Promise<MIDIAccess> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (nav?.requestMIDIAccess) return nav.requestMIDIAccess(options);
  return Promise.reject(
    new Error(
      "Web MIDI unavailable here — on device, use the native build (@motiz88/react-native-midi).",
    ),
  );
}
