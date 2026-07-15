/** Settings / about. RN app surface. */
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { radius, theme } from "../../src/components/theme";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
        gap: 6,
      }}
    >
      <Text style={{ color: theme.text, fontWeight: "600" }}>{title}</Text>
      {children}
    </View>
  );
}

function LinkRow({
  href,
  icon,
  label,
}: {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <Link href={href} asChild>
      <Pressable
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
        }}
      >
        <Ionicons name={icon} color={theme.textDim} size={20} />
        <Text style={{ color: theme.text, flex: 1 }}>{label}</Text>
        <Ionicons name="chevron-forward" color={theme.textDim} size={18} />
      </Pressable>
    </Link>
  );
}

export default function Settings() {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      {/* Tone/effect pages now live in the editor's section bar. Settings keeps device + data. */}
      <LinkRow href="/connect" icon="bluetooth-outline" label="Connection" />
      <LinkRow href="/device" icon="construct-outline" label="Device Settings" />
      <LinkRow href="/backup" icon="save-outline" label="Backup & Restore" />
      <LinkRow href="/diagnostics" icon="pulse-outline" label="MIDI Log" />
      <LinkRow href="/help" icon="help-circle-outline" label="Help & Guide" />
      <Card title="SansApp">
        <Text style={{ color: theme.textDim, lineHeight: 20 }}>
          A free, open-source editor for the SansAmp Programmable Bass Driver DI Elite. Tweak your
          tone from your phone. GPL-3.0.
        </Text>
      </Card>
      <Card title="Unofficial">
        <Text style={{ color: theme.textDim, lineHeight: 20 }}>
          Not affiliated with, authorized, or endorsed by Tech 21 USA, Inc. "SansAmp", "Bass
          Driver", and "Tech 21" are trademarks of their owner, used only to describe compatibility.
        </Text>
      </Card>
      <Card title="Version">
        <Text style={{ color: theme.textDim }}>1.0.0 · edit live over MIDI (USB or Bluetooth)</Text>
      </Card>
    </ScrollView>
  );
}
