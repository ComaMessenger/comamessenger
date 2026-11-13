import { memo, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Check, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { ActorSummary } from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { ChatAvatar } from "@/chats/ChatAvatar";
import type { Presence } from "@/ui/Avatar";
import { Text, fonts, maxTextScale } from "@/ui/Text";

type PersonLike = Pick<
  ActorSummary,
  | "actor_id"
  | "display_name"
  | "handle"
  | "title"
  | "type"
  | "avatar_version"
  | "status_emoji"
>;

export function presenceLabelKey(presence: Presence | undefined) {
  return presence === "online"
    ? "online"
    : presence === "away"
      ? "presenceAway"
      : "presenceOffline";
}

/** Small «Агент» pill next to a name. */
export function AgentTag() {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={[styles.tag, { backgroundColor: theme.primarySoft }]}>
      <Text size={11} weight="semibold" style={{ color: theme.primary }}>
        {t("agent")}
      </Text>
    </View>
  );
}

/**
 * A person or an agent in a list: avatar (circle, as in the prototype) with
 * the online dot, name, job title or handle. With `selected` set the row is a
 * checkbox of a multi-select picker.
 */
export const PersonRow = memo(function PersonRow({
  person,
  presence,
  meta,
  selected,
  busy,
  trailing,
  onPress,
  onLongPress,
  testID,
  hint,
}: {
  person: PersonLike;
  presence?: Presence;
  /** Replaces the job title line, e.g. the role in a chat. */
  meta?: string;
  selected?: boolean;
  busy?: boolean;
  trailing?: ReactNode;
  onPress?(): void;
  onLongPress?(): void;
  testID?: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const agent = person.type === "agent";
  const checkable = selected !== undefined;
  const line = meta ?? (person.title || `@${person.handle}`);
  const state = agent ? undefined : presence;
  const label = [
    person.display_name,
    agent ? t("agent") : null,
    line,
    state === "online" ? t("online") : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      testID={testID}
      accessibilityRole={checkable ? "checkbox" : "button"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={
        checkable ? { checked: selected, busy } : { busy: Boolean(busy) }
      }
      disabled={!onPress && !onLongPress}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <ChatAvatar
        name={person.display_name}
        seed={person.actor_id}
        actorID={person.actor_id}
        avatarVersion={person.avatar_version}
        size={44}
        shape="circle"
        agent={agent}
        online={state === "online"}
        ringColor={theme.surface}
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            weight="semibold"
            size={15.5}
            numberOfLines={1}
            style={styles.shrink}
          >
            {person.display_name}
          </Text>
          {agent ? <AgentTag /> : null}
          {person.status_emoji ? (
            <Text size={14} accessibilityElementsHidden>
              {person.status_emoji}
            </Text>
          ) : null}
        </View>
        <Text tone="muted" size={13.5} numberOfLines={1}>
          {line}
        </Text>
      </View>
      {busy ? <ActivityIndicator color={theme.muted} /> : trailing}
      {checkable ? (
        <View
          style={[
            styles.check,
            selected
              ? { backgroundColor: theme.primary, borderColor: theme.primary }
              : { borderColor: theme.borderStrong },
          ]}
        >
          {selected ? (
            <Check size={14} strokeWidth={2.6} color={theme.onPrimary} />
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
});

/** Rounded search field under a header, as in the chat list. */
export function SearchField({
  value,
  onChange,
  placeholder,
  testID,
  autoFocus,
}: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  testID?: string;
  autoFocus?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.search, { backgroundColor: theme.surfaceSelected }]}>
      <Search size={18} color={theme.muted} />
      <TextInput
        testID={testID}
        maxFontSizeMultiplier={maxTextScale}
        value={value}
        onChangeText={onChange}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        accessibilityLabel={placeholder}
        selectionColor={theme.primary}
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={[styles.input, { color: theme.foreground }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.row { gap: 12px; padding: 9px 14px }`.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minHeight: 60,
  },
  body: { flex: 1, minWidth: 0 },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  tag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  // Prototype: `.search { margin: 0 14px 10px; height: 38px; border-radius: 12px }`.
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 38,
    marginHorizontal: 14,
    marginVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 15,
    paddingVertical: 8,
  },
});
