/** Bottom tab bar. RN app surface (tsconfig.json). */
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { View, type ColorValue } from "react-native";
import { HeaderConnection, TransportTitle } from "../../src/components/AppHeader";
import { theme } from "../../src/components/theme";
import { TunerBar } from "../../src/components/TunerBar";

type IoniconName = keyof typeof Ionicons.glyphMap;

const icon =
  (name: IoniconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} color={color} size={size} />
  );

export default function TabsLayout() {
  return (
    <Tabs
      // The MUTE/BYPASS bar, pinned between the header and the screen on EVERY tab: screenLayout wraps
      // each tab's scene, and the navigator renders that scene below the header. Both of the bar's uses
      // are cross-tab (bypass while editing, mute while browsing presets) and the header is already full.
      screenLayout={({ children }) => (
        <View style={{ flex: 1 }}>
          <TunerBar />
          {children}
        </View>
      )}
      screenOptions={{
        headerStyle: { backgroundColor: theme.panel },
        headerTintColor: theme.text,
        // Persistent header: preset transport (prev/next + 7-seg + name) as the title + connection
        // pill on the right, on every tab.
        headerTitle: () => <TransportTitle />,
        headerTitleAlign: "left",
        headerRight: () => <HeaderConnection />,
        sceneStyle: { backgroundColor: theme.bg },
        tabBarStyle: { backgroundColor: theme.panel, borderTopColor: theme.panelEdge },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textDim,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Editor", tabBarIcon: icon("options-outline") }}
      />
      <Tabs.Screen
        name="presets"
        options={{ title: "Presets", tabBarIcon: icon("list-outline") }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: icon("settings-outline") }}
      />
    </Tabs>
  );
}
