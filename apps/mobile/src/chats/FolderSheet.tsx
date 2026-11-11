import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatAvatarSource,
  folderChatLimit,
  folderColorToken,
  folderColors,
  folderNameMaxLength,
  sortChats,
  type Chat,
  type ChatFolder,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { ChatAvatar } from "./ChatAvatar";
import { chatTitle } from "./ChatRow";
import { featuredFolderIconCount, folderIcons } from "./folderIcons";

const kindLabel: Record<Chat["kind"], string> = {
  direct: "kindDirect",
  group: "kindGroup",
  channel: "kindChannel",
};

/**
 * Creates or edits a chat folder in the web format: name, colour, icon and
 * chats picked by hand. The web has no automatic rules, so neither does this.
 */
export function FolderSheet({
  visible,
  folder,
  initialChatIDs = [],
  onClose,
  onSave,
}: {
  visible: boolean;
  /** The folder being edited; a new folder when absent. */
  folder?: ChatFolder;
  /** Chats ticked in a new folder. */
  initialChatIDs?: string[];
  onClose(): void;
  onSave(folder: ChatFolder): Promise<void>;
}) {
  return (
    <FolderSheetBody
      // Fresh state for every opening.
      key={visible ? (folder?.id ?? "new") : "closed"}
      visible={visible}
      folder={folder}
      initialChatIDs={initialChatIDs}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

function FolderSheetBody({
  visible,
  folder,
  initialChatIDs,
  onClose,
  onSave,
}: {
  visible: boolean;
  folder?: ChatFolder;
  initialChatIDs: string[];
  onClose(): void;
  onSave(folder: ChatFolder): Promise<void>;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { store, pinnedChatIDs } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState<ChatFolder["color"]>(
    folder?.color ?? "blue",
  );
  const [icon, setIcon] = useState<ChatFolder["icon"]>(
    folder?.icon ?? "folder",
  );
  const [selected, setSelected] = useState<string[]>(
    folder?.chat_ids ?? initialChatIDs,
  );
  const [allIcons, setAllIcons] = useState(
    // An icon from the hidden part stays visible when editing.
    folderIcons.findIndex((option) => option.id === folder?.icon) >=
      featuredFolderIconCount,
  );
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(false);
  const accent = theme[folderColorToken(color)];

  const chats = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    // Chats already in the folder come first so they are easy to untick.
    const inFolder = new Set(folder?.chat_ids ?? initialChatIDs);
    return sortChats(Object.values(chatMap), pinnedChatIDs)
      .filter(
        (chat) =>
          !needle ||
          chatTitle(chat, t("directChat")).toLocaleLowerCase().includes(needle),
      )
      .sort(
        (left, right) =>
          Number(inFolder.has(right.id)) - Number(inFolder.has(left.id)),
      );
  }, [chatMap, folder, initialChatIDs, pinnedChatIDs, query, t]);

  const icons = allIcons
    ? folderIcons
    : folderIcons.slice(0, featuredFolderIconCount);

  function toggle(chatID: string) {
    setSelected((items) => {
      if (items.includes(chatID)) return items.filter((id) => id !== chatID);
      if (items.length >= folderChatLimit) {
        Alert.alert(t("folderChatLimit", { limit: folderChatLimit }));
        return items;
      }
      return [...items, chatID];
    });
  }

  async function save() {
    setPending(true);
    try {
      await onSave({
        id: folder?.id ?? Crypto.randomUUID(),
        name: name.trim(),
        icon,
        color,
        chat_ids: selected,
      });
      onClose();
    } catch {
      Alert.alert(t("actionFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <BottomSheet
      visible={visible}
      testID="folder-sheet"
      title={folder ? t("editFolder") : t("newFolder")}
      action={{
        label: t("done"),
        disabled: !name.trim() || pending,
        onPress: () => void save(),
      }}
      onClose={onClose}
    >
      <TextInput
        testID="folder-name"
        maxFontSizeMultiplier={maxTextScale}
        value={name}
        onChangeText={setName}
        maxLength={folderNameMaxLength}
        autoFocus={!folder}
        placeholder={t("folderNamePlaceholder")}
        placeholderTextColor={theme.subtle}
        accessibilityLabel={t("folderName")}
        selectionColor={theme.primary}
        returnKeyType="done"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.field,
          {
            color: theme.foreground,
            borderColor: focused ? theme.primary : theme.borderStrong,
            backgroundColor: theme.surface,
          },
        ]}
      />

      <Label>{t("folderColor")}</Label>
      <View style={styles.swatches} accessibilityRole="radiogroup">
        {folderColors.map((value) => {
          const active = value === color;
          const swatch = theme[folderColorToken(value)];
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              accessibilityLabel={t("folderColorOption", {
                color: t(
                  `color${value.charAt(0).toUpperCase()}${value.slice(1)}`,
                ),
              })}
              hitSlop={4}
              onPress={() => setColor(value)}
              style={[
                styles.swatchRing,
                { borderColor: active ? swatch : "transparent" },
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: swatch }]}>
                {active && <Check size={16} strokeWidth={2.6} color="#fff" />}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Label>{t("folderIcon")}</Label>
      <View style={styles.icons} accessibilityRole="radiogroup">
        {icons.map((option) => {
          const active = option.id === icon;
          const Glyph = option.icon;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              accessibilityLabel={t(option.labelKey)}
              onPress={() => setIcon(option.id)}
              style={[
                styles.icon,
                {
                  backgroundColor: active
                    ? theme.surfaceSelected
                    : "transparent",
                  borderColor: active ? accent : "transparent",
                },
              ]}
            >
              <Glyph size={20} color={active ? accent : theme.muted} />
            </Pressable>
          );
        })}
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => setAllIcons((value) => !value)}
        style={styles.more}
      >
        {allIcons ? (
          <ChevronUp size={16} color={theme.primary} />
        ) : (
          <ChevronDown size={16} color={theme.primary} />
        )}
        <Text size={14} weight="semibold" tone="primary">
          {allIcons
            ? t("folderFewerIcons")
            : t("folderMoreIcons", {
                count: folderIcons.length - featuredFolderIconCount,
              })}
        </Text>
      </Pressable>

      <Label>{t("folderChatsCount", { count: selected.length })}</Label>
      <View style={[styles.search, { backgroundColor: theme.surfaceSelected }]}>
        <Search size={18} color={theme.muted} />
        <TextInput
          maxFontSizeMultiplier={maxTextScale}
          value={query}
          onChangeText={setQuery}
          placeholder={t("folderFindChat")}
          placeholderTextColor={theme.muted}
          accessibilityLabel={t("folderFindChat")}
          selectionColor={theme.primary}
          clearButtonMode="while-editing"
          style={[styles.searchInput, { color: theme.foreground }]}
        />
      </View>
      {chats.map((chat, index) => {
        const checked = selected.includes(chat.id);
        const title = chatTitle(chat, t("directChat"));
        const agent =
          chat.kind === "direct" && chat.direct_peer?.type === "agent";
        return (
          <Pressable
            key={chat.id}
            testID={`folder-chat-${index}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel={title}
            onPress={() => toggle(chat.id)}
            style={({ pressed }) => [
              styles.option,
              pressed && { opacity: 0.7 },
            ]}
          >
            <ChatAvatar
              name={title}
              seed={chat.avatar_seed || chat.id}
              size={36}
              shape={chat.kind === "direct" ? "circle" : "square"}
              agent={agent && !(chat.direct_peer?.avatar_version ?? 0)}
              glyph={chat.kind === "channel" ? "#" : undefined}
              {...chatAvatarSource(chat)}
            />
            <View style={styles.grow}>
              <Text size={15} numberOfLines={1}>
                {title}
              </Text>
              <Text size={13} tone="muted" numberOfLines={1}>
                {agent ? t("agent") : t(kindLabel[chat.kind])}
              </Text>
            </View>
            <View
              style={[
                styles.check,
                checked
                  ? {
                      backgroundColor: theme.primary,
                      borderColor: theme.primary,
                    }
                  : { borderColor: theme.borderStrong },
              ]}
            >
              {checked && (
                <Check size={14} strokeWidth={2.6} color={theme.onPrimary} />
              )}
            </View>
          </Pressable>
        );
      })}
    </BottomSheet>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text tone="muted" weight="semibold" size={12} style={styles.label}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.field { height: 44px; border-radius: 12px; padding: 0 13px }`.
  field: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 13,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  // Prototype: `.lbl { font-size: 12px; uppercase; margin: 14px 0 7px }`.
  label: {
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 7,
  },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  swatchRing: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  icons: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 40,
    alignSelf: "flex-start",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 15,
    paddingVertical: 0,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 50,
    paddingVertical: 7,
  },
  grow: { flex: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
});
