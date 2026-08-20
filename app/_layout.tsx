/** expo-router root layout: tab group + deep pages. RN app surface (tsconfig.json). */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HeaderConnection, TransportTitle } from "../src/components/AppHeader";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { ReadFromPedalOverlay } from "../src/components/ReadFromPedal";
import { theme } from "../src/components/theme";

// Knob-heavy deep pages are pushed as CARDS with the swipe gesture OFF — a modal's swipe-down-to-
// dismiss (and a card's edge-swipe-back) both fight a vertical knob drag, closing the page instead
// of changing the value. Cards show a header back button to close. Non-knob utility pages stay
// modals (swipe-to-dismiss is fine there).
const KNOB_PAGES: Record<string, string> = {
  amp: "Amp",
  eq: "Parametric EQ",
  comp: "Dynamics",
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
      <ErrorBoundary>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.panel },
            headerTintColor: theme.text,
            contentStyle: { backgroundColor: theme.bg },
            // Show only the ‹ chevron on deep-page back buttons — otherwise iOS labels it with the
            // previous route's name, which is the "(tabs)" group (looks buggy). Minimal = icon only.
            headerBackButtonDisplayMode: "minimal",
            // Deep pages keep their own title; the connection pill rides along on the right so link
            // status shows everywhere. ((tabs) sets headerShown:false — its header carries preset + pill.)
            headerRight: () => <HeaderConnection />,
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {Object.entries(KNOB_PAGES).map(([name, title]) => (
            <Stack.Screen
              key={name}
              name={name}
              options={{
                title,
                gestureEnabled: false,
                // Knob pages show the preset transport in place of a text title, so you can step
                // presets without leaving the page. (The native ‹ back + connection pill flank it.)
                headerTitle: () => <TransportTitle />,
                headerTitleAlign: "left",
              }}
            />
          ))}
          {Object.entries(MODAL_PAGES).map(([name, title]) => (
            <Stack.Screen key={name} name={name} options={{ title, presentation: "modal" }} />
          ))}
          {/* Recipes + Help are scroll-only reference pages (no knobs) — normal cards, swipe-back OK. */}
          <Stack.Screen name="recipes" options={{ title: "Recipes" }} />
          <Stack.Screen name="help" options={{ title: "Help" }} />
        </Stack>
        {/* Above the whole stack: Read from Pedal must hold the app for its ~10 s, wherever it was
            started from and whatever the user navigates to. */}
        <ReadFromPedalOverlay />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
