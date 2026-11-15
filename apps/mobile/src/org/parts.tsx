import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ChevronRight, Network, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { APIError } from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import i18n from "@/i18n";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/*
 * Pieces of the org screens, drawn after the «Оргструктура» tab of
 * design/prototypes/workplace: the department square (`.dsq`), the «рук.»
 * and «совм.» tags (`.lead`), the info groups of a card (`.igrp`, `.gh`,
 * `.kv`) and the action tiles under its head (`.iacts`).
 */

/** The department square: the org icon on the soft primary fill. */
export function DepartmentIcon({ size = 30 }: { size?: 30 | 36 | 72 }) {
  const theme = useTheme();
  const big = size === 72;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.square,
        {
          width: size,
          height: size,
          borderRadius: big ? 24 : size === 36 ? 12 : 10,
          backgroundColor: theme.primarySoft,
        },
      ]}
    >
      <Network size={big ? 34 : 16} color={theme.primary} />
    </View>
  );
}

/** «рук.» or «совм.» next to a name. */
export function OrgTag({ kind }: { kind: "lead" | "additional" }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={t(
        kind === "lead" ? "orgLeadTagLabel" : "orgAdditionalTagLabel",
      )}
      style={[styles.tag, { backgroundColor: theme.primarySoft }]}
    >
      <Text size={10.5} weight="bold" style={{ color: theme.primary }}>
        {t(kind === "lead" ? "orgLeadTag" : "orgAdditionalTag")}
      </Text>
    </View>
  );
}

/** A white group of a card between hairlines, with an optional heading. */
export function InfoGroup({
  title,
  action,
  children,
  testID,
}: {
  title?: string;
  /** A link on the right of the heading, e.g. «Все». */
  action?: { label: string; onPress(): void; testID?: string };
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.group,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      {title ? (
        <View style={styles.heading}>
          <Text
            tone="muted"
            size={13}
            weight="semibold"
            accessibilityRole="header"
            style={styles.grow}
          >
            {title}
          </Text>
          {action ? (
            <Pressable
              testID={action.testID}
              accessibilityRole="button"
              hitSlop={10}
              onPress={action.onPress}
            >
              <Text tone="primary" size={13} weight="semibold">
                {action.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A row of a card group: picture, title with a caption, chevron. */
export function KVRow({
  leading,
  title,
  caption,
  onPress,
  first,
  testID,
  hint,
  trailing,
}: {
  leading?: ReactNode;
  title: ReactNode;
  caption?: string;
  onPress?(): void;
  /** No line above: the first row of a group or right under its heading. */
  first?: boolean;
  testID?: string;
  hint?: string;
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityHint={hint}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.kv,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.border,
        },
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      {leading}
      <View style={styles.grow}>
        {typeof title === "string" ? (
          <Text size={15} numberOfLines={2}>
            {title}
          </Text>
        ) : (
          title
        )}
        {caption ? (
          <Text tone="muted" size={12.5} numberOfLines={2}>
            {caption}
          </Text>
        ) : null}
      </View>
      {trailing}
      {onPress ? <ChevronRight size={18} color={theme.muted} /> : null}
    </Pressable>
  );
}

export type ActionTile = {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress(): void;
  testID?: string;
  busy?: boolean;
};

/** The action tiles under the head of a card (`.iacts`), up to four. */
export function ActionTiles({ actions }: { actions: ActionTile[] }) {
  const theme = useTheme();
  if (!actions.length) return null;
  return (
    <View style={styles.tiles}>
      {actions.map(({ key, label, icon: Icon, onPress, testID, busy }) => (
        <Pressable
          key={key}
          testID={testID}
          accessibilityRole="button"
          accessibilityState={{ busy: Boolean(busy) }}
          disabled={busy}
          onPress={onPress}
          style={({ pressed }) => [
            styles.tile,
            {
              backgroundColor: pressed
                ? theme.surfaceHover
                : theme.surfaceSelected,
            },
            busy && styles.busy,
          ]}
        >
          <Icon size={20} color={theme.primary} />
          <Text
            size={12}
            numberOfLines={1}
            style={[styles.tileLabel, { color: theme.primary }]}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Text of a failed org write: the known codes in words, else the shared one. */
export function orgErrorText(cause: unknown): string {
  if (cause instanceof APIError) {
    const key = (
      {
        org_name_taken: "orgErrorNameTaken",
        org_cycle: "orgErrorCycle",
        org_depth_exceeded: "orgErrorDepth",
        org_limit_reached: "orgErrorLimit",
        org_version_conflict: "orgErrorConflict",
        department_chat_exists: "orgErrorChatExists",
        department_chat_invalid: "orgErrorChatInvalid",
        org_invalid: "orgErrorInvalid",
      } as Record<string, string>
    )[cause.code];
    if (key) return i18n.t(key);
  }
  return messageOf(cause);
}

const styles = StyleSheet.create({
  square: { alignItems: "center", justifyContent: "center" },
  // Prototype: `.lead { font-size: 10.5px; border-radius: 6px; padding: 1px 6px }`.
  tag: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  // Prototype: `.igrp { border-top/bottom: 1px; margin-top: 10px }`.
  group: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
  },
  // Prototype: `.gh { padding: 11px 14px 4px; font-size: 13px }`.
  heading: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 11,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  // Prototype: `.kv { gap: 12px; padding: 10px 14px }`.
  kv: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 52,
  },
  grow: { flex: 1, minWidth: 0 },
  // Prototype: `.iacts { gap: 8px; padding: 4px 14px 14px }`.
  tiles: {
    flexDirection: "row",
    gap: 8,
    paddingTop: 4,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  tile: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    paddingTop: 9,
    paddingBottom: 8,
    borderRadius: radius.button,
    minHeight: 56,
  },
  tileLabel: { paddingHorizontal: 4 },
  busy: { opacity: 0.6 },
});
