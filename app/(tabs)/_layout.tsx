/** Bottom tab bar. RN app surface (tsconfig.json). */
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { theme } from "../../src/components/theme";

type IoniconName = keyof typeof Ionicons.glyphMap;

const icon =
  (name: IoniconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} color={color} size={size} />
  );

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.panel },
        headerTintColor: theme.text,
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
