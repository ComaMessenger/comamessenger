import { Tabs } from "expo-router";
import { StyleSheet, View, type ColorValue } from "react-native";
import {
  Ellipsis,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { fonts } from "@/ui/Text";

function tabIcon(Icon: LucideIcon) {
  return function TabIcon({
    focused,
    color,
  }: {
    focused: boolean;
    color: ColorValue;
  }) {
    const theme = useTheme();
    return (
      <View
        style={[styles.pill, focused && { backgroundColor: theme.primarySoft }]}
      >
        <Icon size={24} color={String(color)} />
      </View>
    );
  };
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.muted,
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 12 },
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
        },
        sceneStyle: { backgroundColor: theme.canvas },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabChats"),
          tabBarIcon: tabIcon(MessageSquare),
          tabBarButtonTestID: "tab-chats",
        }}
      />
      <Tabs.Screen
        name="threads"
        options={{
          title: t("tabThreads"),
          tabBarIcon: tabIcon(MessagesSquare),
          tabBarButtonTestID: "tab-threads",
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t("tabMore"),
          tabBarIcon: tabIcon(Ellipsis),
          tabBarButtonTestID: "tab-more",
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  pill: {
    width: 56,
    height: 32,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
});
