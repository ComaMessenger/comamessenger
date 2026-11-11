import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import {
  Ellipsis,
  MessageCircle,
  MessagesSquare,
  Star,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { totalUnread } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { countLabel } from "@/ui/CountBadge";
import { fonts } from "@/ui/Text";

function tabIcon(Icon: LucideIcon) {
  return function TabIcon({ color }: { color: ColorValue }) {
    return <Icon size={22} strokeWidth={1.8} color={String(color)} />;
  };
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const unread = useStore(store, (state) =>
    totalUnread(state.unread, state.chats),
  );
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.muted,
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 11 },
        tabBarBadgeStyle: {
          backgroundColor: theme.danger,
          color: "#ffffff",
          fontFamily: fonts.bold,
          fontSize: 10,
        },
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          borderTopWidth: 1,
          elevation: 0,
          shadowOpacity: 0,
        },
        sceneStyle: { backgroundColor: theme.surface },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabChats"),
          tabBarIcon: tabIcon(MessageCircle),
          tabBarBadge: unread > 0 ? countLabel(unread) : undefined,
          tabBarAccessibilityLabel:
            unread > 0
              ? `${t("tabChats")}, ${t("unreadCount", { count: unread })}`
              : t("tabChats"),
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
        name="important"
        options={{
          title: t("tabImportant"),
          tabBarIcon: tabIcon(Star),
          tabBarButtonTestID: "tab-important",
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
