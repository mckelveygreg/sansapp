/** expo-router root layout: tab group + deep pages. RN app surface (tsconfig.json). */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../src/components/theme";

// Knob-heavy deep pages are pushed as CARDS with the swipe gesture OFF — a modal's swipe-down-to-
// dismiss (and a card's edge-swipe-back) both fight a vertical knob drag, closing the page instead
// of changing the value. Cards show a header back button to close. Non-knob utility pages stay
// modals (swipe-to-dismiss is fine there).
const KNOB_PAGES: Record<string, string> = {
  amp: "Amp",
  eq: "Parametric EQ",
  comp: "Compressor",
  gate: "Gate & Master Level",
  filter: "Auto Filter",
  ambience: "Ambience",
  chorus: "Chorus",
  ir: "IR Studio",
};
const MODAL_PAGES: Record<string, string> = {
  connect: "Connect",
  device: "Device Settings",
  backup: "Backup & Restore",
  diagnostics: "MIDI Log",
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.panel },
          headerTintColor: theme.text,
          contentStyle: { backgroundColor: theme.bg },
          // Show only the ‹ chevron on deep-page back buttons — otherwise iOS labels it with the
          // previous route's name, which is the "(tabs)" group (looks buggy). Minimal = icon only.
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {Object.entries(KNOB_PAGES).map(([name, title]) => (
          <Stack.Screen key={name} name={name} options={{ title, gestureEnabled: false }} />
        ))}
        {Object.entries(MODAL_PAGES).map(([name, title]) => (
          <Stack.Screen key={name} name={name} options={{ title, presentation: "modal" }} />
        ))}
        {/* Recipes + Help are scroll-only reference pages (no knobs) — normal cards, swipe-back OK. */}
        <Stack.Screen name="recipes" options={{ title: "Recipes" }} />
        <Stack.Screen name="help" options={{ title: "Help" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
