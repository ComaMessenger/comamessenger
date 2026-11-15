import { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  CalendarDays,
  ChevronRight,
  Search,
  UserRound,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  departmentPath,
  expandDepartment,
  expandPosition,
  formatTaskDue,
  orgIndex,
  orgKeys,
  orgStructureAvailable,
  taskDuePresets,
  taskLimits,
  type ChatMember,
  type OrgStructure,
  type TaskDraftAssignee,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { useClock } from "@/scheduled/clock";
import { combine, formatDate, formatTime } from "@/scheduled/format";
import { calendarLocale } from "@/requests/locale";
import { Chip } from "@/requests/parts";
import { TaskCheck } from "./parts";

/**
 * Fields of «Новая задача» and of the task screen, as on phone A of the
 * prototype: people of the chat as chips, the chat members to choose from,
 * departments and positions for a queue, the due date chips.
 */

/** People of the chat who may answer for a task: active people, no agents. */
export function taskPeople(members: readonly ChatMember[]): ChatMember[] {
  return members.filter((member) => member.type === "user");
}

/**
 * The org structure for «Отдел» and «Должность» (wave 2), read only when the
 * server has it. The same cache key as the rest of the app.
 */
export function useTaskOrg(enabled: boolean): OrgStructure | null {
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  const available = orgStructureAvailable(features) && enabled;
  const query = useQuery({
    queryKey: orgKeys.all,
    queryFn: async () => (await api.orgStructure()) as OrgStructure,
    enabled: available,
    staleTime: 60_000,
  });
  return available ? (query.data ?? null) : null;
}

/**
 * «Ответственный» as chips: the people the reader talks with in this chat
 * lately, «Я», the chosen one when it is not among them, and «Ещё…».
 */
export function PersonChips({
  chatID,
  members,
  value,
  testID,
  onChange,
  onMore,
}: {
  chatID: string;
  members: readonly ChatMember[];
  value: string | null;
  testID: string;
  onChange(actorID: string): void;
  onMore(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const feed = useStore(store, (state) => state.messages[chatID]);
  const people = useMemo(() => taskPeople(members), [members]);
  const shown = useMemo(() => {
    const ids: string[] = [];
    // The latest authors first: whom the reader talks with lately.
    for (const message of [...(feed ?? [])].reverse()) {
      if (ids.length >= 3) break;
      if (message.actor_id === user.id || ids.includes(message.actor_id))
        continue;
      if (people.some((member) => member.actor_id === message.actor_id))
        ids.push(message.actor_id);
    }
    for (const member of people) {
      if (ids.length >= 3) break;
      if (member.actor_id !== user.id && !ids.includes(member.actor_id))
        ids.push(member.actor_id);
    }
    if (value && value !== user.id && !ids.includes(value)) ids.push(value);
    return ids;
  }, [feed, people, user.id, value]);
  const memberOf = (id: string) =>
    people.find((member) => member.actor_id === id);
  return (
    <View style={styles.chips}>
      {shown.map((id) => {
        const member = memberOf(id);
        const name = member?.display_name ?? t("taskSomeone");
        return (
          <Chip
            key={id}
            testID={`${testID}-${member?.handle ?? id}`}
            label={name.split(/\s+/)[0] ?? name}
            selected={value === id}
            icon={
              <Avatar
                name={name}
                seed={id}
                size={22}
                actorID={id}
                avatarVersion={member?.avatar_version}
              />
            }
            onPress={() => onChange(id)}
          />
        );
      })}
      {people.some((member) => member.actor_id === user.id) ? (
        <Chip
          testID={`${testID}-me`}
          label={t("taskMe")}
          selected={value === user.id}
          icon={
            <Avatar
              name={user.display_name}
              seed={user.id}
              size={22}
              actorID={user.id}
              avatarVersion={user.avatar_version}
            />
          }
          onPress={() => onChange(user.id)}
        />
      ) : null}
      <Chip
        testID={`${testID}-more`}
        label={t("taskMorePeople")}
        icon={<UserRound size={16} color={theme.muted} />}
        onPress={onMore}
      />
    </View>
  );
}

/**
 * Members of the chat to choose one from, with a search; the sheet shows it
 * in place of the form. `none` adds «Без исполнителя» on top.
 */
export function MemberChoice({
  members,
  value,
  none,
  testID,
  onPick,
}: {
  members: readonly ChatMember[];
  value: string | null;
  /** The label of «nobody», for an item without an assignee. */
  none?: string;
  testID: string;
  onPick(actorID: string | null): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const [query, setQuery] = useState("");
  const people = useMemo(() => {
    const folded = query.trim().toLocaleLowerCase();
    return taskPeople(members).filter(
      (member) =>
        !folded ||
        member.display_name.toLocaleLowerCase().includes(folded) ||
        member.handle.toLocaleLowerCase().includes(folded),
    );
  }, [members, query]);
  return (
    <View testID={testID}>
      <View style={[styles.search, { backgroundColor: theme.surfaceSelected }]}>
        <Search size={17} color={theme.muted} />
        <TextInput
          testID={`${testID}-search`}
          value={query}
          onChangeText={setQuery}
          placeholder={t("taskPickerSearch")}
          placeholderTextColor={theme.muted}
          autoCorrect={false}
          selectionColor={theme.primary}
          maxFontSizeMultiplier={maxTextScale}
          style={[styles.searchInput, { color: theme.foreground }]}
        />
      </View>
      {none ? (
        <ChoiceLine
          testID={`${testID}-none`}
          label={none}
          selected={value === null}
          onPress={() => onPick(null)}
        />
      ) : null}
      {people.map((member) => (
        <ChoiceLine
          key={member.actor_id}
          testID={`${testID}-${member.handle}`}
          label={
            member.actor_id === user.id
              ? t("taskPickerMe", { name: member.display_name })
              : member.display_name
          }
          avatar={member}
          selected={value === member.actor_id}
          onPress={() => onPick(member.actor_id)}
        />
      ))}
      {people.length === 0 ? (
        <Text tone="muted" size={14} style={styles.empty}>
          {t("taskPickerEmpty")}
        </Text>
      ) : null}
    </View>
  );
}

function ChoiceLine({
  label,
  caption,
  avatar,
  selected,
  disabled,
  testID,
  onPress,
}: {
  label: string;
  caption?: string;
  avatar?: Pick<ChatMember, "actor_id" | "display_name" | "avatar_version">;
  selected: boolean;
  disabled?: boolean;
  testID?: string;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      accessibilityLabel={caption ? `${label}, ${caption}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.line,
        pressed && { backgroundColor: theme.surfaceSelected },
        disabled && styles.disabled,
      ]}
    >
      {avatar ? (
        <Avatar
          name={avatar.display_name}
          seed={avatar.actor_id}
          size={32}
          actorID={avatar.actor_id}
          avatarVersion={avatar.avatar_version}
        />
      ) : null}
      <View style={styles.grow}>
        <Text size={15.5} numberOfLines={1}>
          {label}
        </Text>
        {caption ? (
          <Text tone="muted" size={12.5} numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>
      <TaskCheck checked={selected} round size={22} label={label} disabled />
    </Pressable>
  );
}

/**
 * «Отдел» or «Должность» of the form: a list with a round check. A
 * department shows its path and how many of its people (with
 * subdepartments) are in this chat; a position how many holders are here.
 * The author counts too: a task may be put on oneself (the server agrees).
 */
export function GroupChoice({
  kind,
  assignee,
  structure,
  members,
  onChange,
}: {
  kind: "department" | "position";
  assignee: TaskDraftAssignee;
  structure: OrgStructure;
  members: readonly ChatMember[];
  onChange(assignee: TaskDraftAssignee): void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const index = orgIndex(structure);
    const options = {
      chatMemberIDs: taskPeople(members).map((member) => member.actor_id),
    };
    if (kind === "department")
      return index.order.map((department) => ({
        id: department.id,
        name: department.name,
        path: departmentPath(structure, department.id, { includeSelf: false }),
        count: expandDepartment(structure, department.id, options).inChat
          .length,
      }));
    return index.positionOrder.map((position) => ({
      id: position.id,
      name: position.name,
      path: "",
      count: expandPosition(structure, position.id, options).inChat.length,
    }));
  }, [kind, members, structure]);
  const chosen =
    assignee.kind === "department"
      ? assignee.departmentID
      : assignee.kind === "position"
        ? assignee.positionID
        : null;
  if (!rows.length)
    return (
      <Text tone="muted" size={14} style={styles.empty}>
        {t(kind === "department" ? "taskNoDepartments" : "taskNoPositions")}
      </Text>
    );
  return (
    <View testID={`task-group-${kind}`} style={styles.groups}>
      {rows.map((row) => (
        <ChoiceLine
          key={row.id}
          testID={`task-group-${kind}-${row.name}`}
          label={row.name}
          caption={[row.path, t("taskGroupInChat", { count: row.count })]
            .filter(Boolean)
            .join(" · ")}
          selected={chosen === row.id}
          onPress={() =>
            onChange(
              kind === "department"
                ? { kind: "department", departmentID: row.id }
                : { kind: "position", positionID: row.id },
            )
          }
        />
      ))}
    </View>
  );
}

/**
 * «Срок»: «Без срока», the preset chips with their dates («сегодня,
 * 18:00», «завтра, 12:00», «пн, 9:00») and «Другая дата» with the
 * system pickers.
 */
export function DueField({
  value,
  custom,
  now,
  testID,
  onChange,
}: {
  value: Date | null;
  /** The value came from «Другая дата», not a chip. */
  custom: boolean;
  now: Date;
  testID: string;
  onChange(at: Date | null, custom: boolean): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const scheme = useColorScheme();
  const clock = useClock();
  const locale = calendarLocale(i18n.language);
  const presets = useMemo(() => taskDuePresets(now), [now]);
  const presetChosen =
    !custom &&
    value !== null &&
    presets.some((preset) => preset.at.getTime() === value.getTime());
  const otherShown = value !== null && !presetChosen;

  function customStart() {
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    return value ?? tomorrow?.at ?? new Date(now.getTime() + 86_400_000);
  }

  function onPicked(part: "date" | "time") {
    return (event: DateTimePickerEvent, picked?: Date) => {
      if (event.type !== "set" || !picked) return;
      const base = customStart();
      onChange(
        part === "date" ? combine(picked, base) : combine(base, picked),
        true,
      );
    };
  }

  function openOtherDate() {
    const start = customStart();
    if (Platform.OS === "android")
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: now,
        maximumDate: new Date(now.getTime() + taskLimits.dueHorizonMs),
        onChange: (event, picked) => {
          if (event.type !== "set" || !picked) return;
          const day = combine(picked, start);
          DateTimePickerAndroid.open({
            value: day,
            mode: "time",
            is24Hour: !clock.hour12,
            onChange: (timeEvent, time) =>
              onChange(
                timeEvent.type === "set" && time ? combine(day, time) : day,
                true,
              ),
          });
        },
      });
    else onChange(start, true);
  }

  return (
    <>
      <View style={styles.chips}>
        {presets.map((preset) => (
          <Chip
            key={preset.id}
            testID={`${testID}-${preset.id}`}
            label={formatTaskDue(preset.at, now, locale)}
            selected={presetChosen && value?.getTime() === preset.at.getTime()}
            onPress={() => onChange(preset.at, false)}
          />
        ))}
        <Chip
          testID={`${testID}-none`}
          label={t("taskDueNone")}
          selected={value === null}
          onPress={() => onChange(null, false)}
        />
        <Chip
          testID={`${testID}-other`}
          label={
            otherShown && value
              ? formatTaskDue(value, now, locale)
              : t("taskDueOther")
          }
          selected={otherShown}
          icon={
            <CalendarDays
              size={15}
              color={otherShown ? theme.primary : theme.foreground}
            />
          }
          onPress={openOtherDate}
        />
      </View>
      {otherShown && value && Platform.OS === "ios" ? (
        <View
          style={[
            styles.iosRow,
            { borderColor: theme.primary, backgroundColor: theme.primarySoft },
          ]}
        >
          <DateTimePicker
            testID={`${testID}-date`}
            accessibilityLabel={t("scheduledPickDate")}
            value={value}
            mode="date"
            display="compact"
            minimumDate={now}
            maximumDate={new Date(now.getTime() + taskLimits.dueHorizonMs)}
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("date")}
          />
          <DateTimePicker
            testID={`${testID}-time`}
            accessibilityLabel={t("scheduledPickTime")}
            value={value}
            mode="time"
            display="compact"
            locale={clock.locale}
            accentColor={theme.primary}
            themeVariant={scheme === "dark" ? "dark" : "light"}
            onChange={onPicked("time")}
          />
        </View>
      ) : null}
      {otherShown && value && Platform.OS === "android" ? (
        <Text tone="muted" size={13} style={styles.caption}>
          {`${formatDate(value, now, clock)}, ${formatTime(value, clock)}`}
        </Text>
      ) : null}
    </>
  );
}

/** A row that leads to a choice: «Ответственный · Анна ›». */
export function ChoiceRow({
  label,
  value,
  testID,
  onPress,
}: {
  label: string;
  value: string;
  testID?: string;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceRow,
        {
          borderColor: theme.border,
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
        },
      ]}
    >
      <Text size={15} numberOfLines={1} style={styles.grow}>
        {value}
      </Text>
      <ChevronRight size={18} color={theme.muted} />
    </Pressable>
  );
}

export const fieldStyles = StyleSheet.create({
  // Prototype `.fi`: 1px border-strong, radius 14, 16px text.
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  title: { fontFamily: fonts.semibold },
  description: { minHeight: 56, maxHeight: 140, textAlignVertical: "top" },
  // `.pf`: an item line — a box, the text, the assignee button.
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  itemInput: {
    flex: 1,
    height: 38,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 14.5,
  },
  itemWho: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingLeft: 2,
  },
  error: { marginTop: 6 },
  caption: { marginTop: 6 },
});

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: spacing[2],
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingVertical: 0,
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  disabled: { opacity: 0.45 },
  empty: { textAlign: "center", paddingVertical: spacing[5] },
  groups: { marginTop: spacing[2] },
  iosRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing[2],
    paddingVertical: 4,
    gap: spacing[2],
    marginTop: spacing[2],
  },
  caption: { marginTop: 6 },
  choiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 13,
  },
});
