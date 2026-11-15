import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ChevronLeft } from "lucide-react-native";
import {
  activeAway,
  awayDraftFromStatus,
  awayDraftProblem,
  awayEndOfDay,
  awayKeys,
  awayKindEmoji,
  awayKindTitle,
  awayKinds,
  awayLimits,
  awayPresets,
  awayStartOfDay,
  customStatusDraft,
  customStatusExpiries,
  customStatusExpiryLabelKeys,
  customStatusLimits,
  customStatusPresets,
  customStatusProblem,
  emptyAwayDraft,
  statusSheetSections,
  toSetAwayInput,
  toSetStatusInput,
  withAwayKind,
  withAwayPreset,
  withDefaultAutoreply,
  type AwayDraft,
  type CustomStatusDraft,
  type StatusSheetSection,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { Avatar } from "@/ui/Avatar";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { calendarLocale } from "@/requests/locale";
import {
  Chip,
  SectionLabel,
  Segmented,
  ToggleRow,
  WideButton,
} from "@/requests/parts";
import { PersonRow, SearchField } from "@/people/PersonRow";
import { DateTimeRow } from "./DateTimeRow";
import { shortName, substituteChips, lastEmoji } from "./model";
import {
  awayErrorText,
  awayProblemText,
  useAwayAvailable,
  useMyAway,
  useSelfAway,
  useWorkspacePeople,
} from "./useAway";

/** Emoji of «Свой статус» besides the quick statuses. */
const statusEmoji = [
  "🙂",
  "💬",
  "📅",
  "🏠",
  "🚆",
  "🍽",
  "🎧",
  "🤒",
  "🏝",
  "🎓",
  "🔨",
  "☕",
];

/**
 * «Статус» from «Ещё» (decision 13): «Отсутствую» as in the prototype's
 * phone A — the kind tiles, «С», «До», the auto-reply with what colleagues
 * will see, «Вместо меня», «Не присылать уведомления», «Сохранить» and
 * «Снять» — and «Свой статус» as on the web: an emoji, a text and when it
 * resets. Without actor_away on the server only «Свой статус» is there.
 */
export function StatusSheet({
  visible,
  onClose,
  onNotice,
}: {
  visible: boolean;
  onClose(): void;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const awayOn = useAwayAvailable();
  const sections = statusSheetSections(awayOn);
  const [section, setSection] = useState<StatusSheetSection>(sections[0]!);
  const [picking, setPicking] = useState(false);
  const mine = useMyAway(visible);
  const [clear, setClear] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!visible) return;
    setSection(sections[0]!);
    setPicking(false);
    // Opened again: the first section, the form not the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const away = section === "away";
  return (
    <BottomSheet
      visible={visible}
      title={picking ? t("awaySubstitute") : t("statusTitle")}
      action={
        away && !picking && mine.data && clear
          ? { label: t("awayClear"), onPress: clear }
          : undefined
      }
      onClose={onClose}
      testID="status-sheet"
    >
      {sections.length > 1 && !picking ? (
        <View style={styles.tabs}>
          <Segmented<StatusSheetSection>
            testID="status-tab"
            value={section}
            options={sections.map((value) => ({
              value,
              label: t(value === "away" ? "statusTabAway" : "statusTabCustom"),
            }))}
            onChange={setSection}
          />
        </View>
      ) : null}
      {visible && away ? (
        <AwaySection
          picking={picking}
          onPicking={setPicking}
          onClear={setClear}
          onDone={(text) => {
            onClose();
            onNotice(text);
          }}
        />
      ) : null}
      {visible && !away ? (
        <CustomSection
          onDone={(text) => {
            onClose();
            onNotice(text);
          }}
        />
      ) : null}
    </BottomSheet>
  );
}

function AwaySection({
  picking,
  onPicking,
  onClear,
  onDone,
}: {
  picking: boolean;
  onPicking(value: boolean): void;
  /** Hands «Снять» to the header while a status is saved. */
  onClear(clear: (() => void) | null): void;
  onDone(text: string): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const locale = calendarLocale(i18n.language);
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const { store } = useMessenger();
  const queryClient = useQueryClient();
  const mine = useMyAway();
  const everyone = useWorkspacePeople();
  const chats = useStore(store, (state) => state.chats);
  const [opened] = useState(() => new Date());
  const [draft, setDraft] = useState<AwayDraft | null>(null);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState("");
  const [startCustom, setStartCustom] = useState(false);
  const [endCustom, setEndCustom] = useState(false);

  const nameOf = (actorID: string | null) =>
    actorID ? (everyone.byID.get(actorID)?.display_name ?? null) : null;

  // The form opens on the saved status, or a fresh vacation.
  useEffect(() => {
    if (draft || mine.isLoading) return;
    const start = mine.data
      ? awayDraftFromStatus(mine.data)
      : withDefaultAutoreply(emptyAwayDraft(opened), null, opened, locale);
    setDraft(start);
    setStartCustom(
      start.startsAt !== null && start.startsAt.getTime() > opened.getTime(),
    );
    setEndCustom(start.endsAt !== null && start.endsPreset === null);
  }, [draft, locale, mine.data, mine.isLoading, opened]);

  // A typed auto-reply stays; the default one follows the substitute's name
  // once the directory has it.
  const substituteName = draft ? nameOf(draft.substituteID) : null;
  useEffect(() => {
    setDraft((current) =>
      current
        ? withDefaultAutoreply(current, substituteName, new Date(), locale)
        : current,
    );
  }, [locale, substituteName]);

  function change(next: AwayDraft) {
    setDraft(
      withDefaultAutoreply(
        next,
        nameOf(next.substituteID),
        new Date(),
        locale,
      ),
    );
    setError("");
  }

  async function settle() {
    void queryClient.invalidateQueries({ queryKey: awayKeys.all(user.id) });
    void queryClient.invalidateQueries({ queryKey: ["actors"] });
    updateUser(await api.me());
  }

  async function clear() {
    setPending("clear");
    setError("");
    try {
      await api.clearAway();
      queryClient.setQueryData(awayKeys.mine(user.id), null);
      store.getState().setAwayOverride(user.id, null);
      await settle();
      onDone(t("awayCleared"));
    } catch (cause) {
      setError(awayErrorText(t, cause));
    } finally {
      setPending(null);
    }
  }
  useEffect(() => {
    onClear(mine.data ? () => () => void clear() : null);
    return () => onClear(null);
    // `clear` reads the latest state through its closure on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data]);

  if (mine.isError)
    return (
      <Text tone="danger" size={14} style={styles.state}>
        {awayErrorText(t, mine.error)}
      </Text>
    );
  if (!draft)
    return (
      <View style={styles.state}>
        <ActivityIndicator color={theme.muted} />
        <Text tone="muted" size={14}>
          {t("awayLoading")}
        </Text>
      </View>
    );

  const now = new Date();
  const problem = awayDraftProblem(draft, now, user.id);
  const shownProblem = touched ? problem : null;
  const wholeDays = draft.kind === "vacation";
  const presets = awayPresets(draft.kind, opened, {
    startsAt: draft.startsAt,
    locale,
  });
  const chosen = draft.substituteID
    ? { actorID: draft.substituteID, name: nameOf(draft.substituteID) ?? "" }
    : null;
  const chips = substituteChips(Object.values(chats), {
    selfID: user.id,
    chosen,
  });

  async function save() {
    if (!draft) return;
    setTouched(true);
    if (problem) return;
    setPending("save");
    setError("");
    try {
      const saved = await api.setAway(toSetAwayInput(draft, new Date()));
      queryClient.setQueryData(awayKeys.mine(user.id), saved);
      await settle();
      onDone(t("awaySaved"));
    } catch (cause) {
      setError(awayErrorText(t, cause));
    } finally {
      setPending(null);
    }
  }

  if (picking)
    return (
      <SubstitutePicker
        onBack={() => onPicking(false)}
        onPick={(actorID) => {
          change({ ...draft, substituteID: actorID });
          onPicking(false);
        }}
      />
    );

  const lastDay = draft.endsAt
    ? new Date(draft.endsAt.getTime() - 60_000)
    : null;

  return (
    <View testID="away-form">
      <View style={styles.kinds} accessibilityRole="radiogroup">
        {awayKinds.map((kind) => {
          const on = draft.kind === kind;
          return (
            <Pressable
              key={kind}
              testID={`away-kind-${kind}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={awayKindTitle(kind, locale)}
              onPress={() => {
                setEndCustom(false);
                change(withAwayKind(draft, kind, new Date()));
              }}
              style={[
                styles.kind,
                {
                  borderColor: on ? theme.primary : theme.border,
                  backgroundColor: on ? theme.primarySoft : theme.surface,
                },
              ]}
            >
              <Text size={18} allowFontScaling={false}>
                {awayKindEmoji[kind]}
              </Text>
              <Text weight="semibold" size={15} numberOfLines={1}>
                {awayKindTitle(kind, locale)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {draft.kind === "other" ? (
        <>
          <SectionLabel>{t("awayLabelLabel")}</SectionLabel>
          <TextInput
            testID="away-label"
            value={draft.label}
            onChangeText={(label) => change({ ...draft, label })}
            placeholder={t("awayLabelPlaceholder")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("awayLabelLabel")}
            maxLength={awayLimits.labelMaxLength}
            selectionColor={theme.primary}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              styles.input,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor:
                  shownProblem?.field === "label"
                    ? theme.danger
                    : theme.borderStrong,
              },
            ]}
          />
        </>
      ) : null}

      <SectionLabel>{t("awayFromLabel")}</SectionLabel>
      <View style={styles.chips}>
        <Chip
          testID="away-from-now"
          label={t("awayFromNow")}
          selected={!startCustom}
          onPress={() => {
            setStartCustom(false);
            change({ ...draft, startsAt: null });
          }}
        />
        <Chip
          testID="away-from-other"
          label={t("awayFromOther")}
          selected={startCustom}
          onPress={() => {
            setStartCustom(true);
            if (!draft.startsAt || draft.startsAt <= opened)
              change({
                ...draft,
                startsAt: awayStartOfDay(
                  new Date(opened.getTime() + 24 * 60 * 60_000),
                ),
              });
          }}
        />
      </View>
      {startCustom && draft.startsAt ? (
        <DateTimeRow
          testID="away-from-date"
          value={draft.startsAt}
          dateOnly={wholeDays}
          minimum={opened}
          maximum={new Date(opened.getTime() + awayLimits.startHorizonMs)}
          onChange={(value) =>
            change({
              ...draft,
              startsAt: wholeDays ? awayStartOfDay(value) : value,
            })
          }
        />
      ) : null}

      <SectionLabel>{t("awayUntilLabel")}</SectionLabel>
      <View style={styles.chips}>
        {presets.map((preset) => (
          <Chip
            key={preset.id}
            testID={`away-until-${preset.id}`}
            label={preset.label}
            selected={!endCustom && draft.endsPreset === preset.id}
            onPress={() => {
              setEndCustom(false);
              change(withAwayPreset(draft, preset));
            }}
          />
        ))}
        <Chip
          testID="away-until-other"
          label={t("awayUntilOther")}
          selected={endCustom || (!draft.endsPreset && Boolean(draft.endsAt))}
          onPress={() => {
            setEndCustom(true);
            const base = draft.startsAt ?? opened;
            change({
              ...draft,
              endsPreset: null,
              endsAt:
                draft.endsAt ??
                awayEndOfDay(new Date(base.getTime() + 24 * 60 * 60_000)),
            });
          }}
        />
      </View>
      {(endCustom || !draft.endsPreset) && draft.endsAt && lastDay ? (
        <DateTimeRow
          testID="away-until-date"
          value={wholeDays ? lastDay : draft.endsAt}
          dateOnly={wholeDays}
          minimum={draft.startsAt ?? opened}
          maximum={
            new Date(
              (draft.startsAt ?? opened).getTime() + awayLimits.maxLengthMs,
            )
          }
          onChange={(value) =>
            change({
              ...draft,
              endsPreset: null,
              endsAt: wholeDays ? awayEndOfDay(value) : value,
            })
          }
        />
      ) : null}
      {shownProblem &&
      (shownProblem.field === "endsAt" || shownProblem.field === "startsAt") ? (
        <Text tone="danger" size={13} style={styles.error}>
          {awayProblemText(t, shownProblem)}
        </Text>
      ) : null}

      <View style={styles.gap} />
      <ToggleRow
        testID="away-autoreply"
        label={t("awayAutoreply")}
        hint={t("awayAutoreplyHint")}
        value={draft.autoreplyEnabled}
        onChange={(autoreplyEnabled) => change({ ...draft, autoreplyEnabled })}
      />
      {draft.autoreplyEnabled ? (
        <>
          <TextInput
            testID="away-autoreply-text"
            value={draft.autoreplyText}
            onChangeText={(autoreplyText) =>
              change({ ...draft, autoreplyText, autoreplyEdited: true })
            }
            accessibilityLabel={t("awayAutoreplyText")}
            maxLength={awayLimits.autoreplyMaxLength}
            multiline
            selectionColor={theme.primary}
            maxFontSizeMultiplier={maxTextScale}
            style={[
              styles.input,
              styles.autoreply,
              {
                color: theme.foreground,
                backgroundColor: theme.surface,
                borderColor:
                  shownProblem?.field === "autoreply"
                    ? theme.danger
                    : theme.borderStrong,
              },
            ]}
          />
          {draft.autoreplyText.trim() ? (
            <View style={styles.preview}>
              <View
                testID="away-autoreply-preview"
                style={[
                  styles.previewBubble,
                  {
                    backgroundColor: theme.canvas,
                    borderColor: theme.borderStrong,
                  },
                ]}
              >
                <View style={styles.previewName}>
                  <Text weight="semibold" size={12.5} numberOfLines={1}>
                    {user.display_name}
                  </Text>
                  <View
                    style={[
                      styles.autoTag,
                      { backgroundColor: theme.surfaceSelected },
                    ]}
                  >
                    <Text weight="bold" size={10.5} tone="muted">
                      {t("autoReplyTag")}
                    </Text>
                  </View>
                </View>
                <Text size={14.5}>{draft.autoreplyText.trim()}</Text>
              </View>
              <Text tone="muted" size={12.5}>
                {t("awayAutoreplyPreview")}
              </Text>
            </View>
          ) : null}
          {shownProblem?.field === "autoreply" ? (
            <Text tone="danger" size={13} style={styles.error}>
              {awayProblemText(t, shownProblem)}
            </Text>
          ) : null}
        </>
      ) : null}

      <SectionLabel>{t("awaySubstitute")}</SectionLabel>
      <View style={styles.chips}>
        {chips.map((chip, index) => (
          <Chip
            key={chip.actorID}
            testID={`away-substitute-${index}`}
            label={shortName(chip.name) || chip.name}
            selected={draft.substituteID === chip.actorID}
            onPress={() => change({ ...draft, substituteID: chip.actorID })}
          />
        ))}
        <Chip
          testID="away-substitute-none"
          label={t("awaySubstituteNone")}
          selected={!draft.substituteID}
          onPress={() => change({ ...draft, substituteID: null })}
        />
        <Chip
          testID="away-substitute-choose"
          label={t("awaySubstituteChoose")}
          onPress={() => onPicking(true)}
        />
      </View>
      <Text tone="muted" size={12.5} style={styles.hint}>
        {t("awaySubstituteHint")}
      </Text>
      {shownProblem?.field === "substitute" ? (
        <Text tone="danger" size={13} style={styles.error}>
          {awayProblemText(t, shownProblem)}
        </Text>
      ) : null}

      <View style={styles.gap} />
      <ToggleRow
        testID="away-mute"
        label={t("awayMute")}
        hint={t("awayMuteHint")}
        value={draft.mutePush}
        onChange={(mutePush) => change({ ...draft, mutePush })}
      />
      {shownProblem?.field === "label" ? (
        <Text tone="danger" size={13} style={styles.error}>
          {awayProblemText(t, shownProblem)}
        </Text>
      ) : null}
      {error ? (
        <Text tone="danger" size={13} style={styles.error}>
          {error}
        </Text>
      ) : null}
      <WideButton
        testID="away-save"
        label={t("awaySave")}
        pending={pending === "save"}
        disabled={pending !== null || (touched && Boolean(problem))}
        onPress={() => void save()}
        style={styles.save}
      />
    </View>
  );
}

/** «Выбрать…» of «Вместо меня»: anyone active in the workspace, but agents. */
function SubstitutePicker({
  onBack,
  onPick,
}: {
  onBack(): void;
  onPick(actorID: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const everyone = useWorkspacePeople();
  const [query, setQuery] = useState("");
  const people = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return everyone.people.filter(
      (person) =>
        person.type === "user" &&
        person.actor_id !== user.id &&
        (!needle ||
          person.display_name.toLocaleLowerCase().includes(needle) ||
          person.handle.toLocaleLowerCase().includes(needle)),
    );
  }, [everyone.people, query, user.id]);
  return (
    <View testID="away-substitute-picker">
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        style={styles.back}
        hitSlop={8}
      >
        <ChevronLeft size={18} color={theme.primary} />
        <Text tone="primary" weight="semibold" size={15}>
          {t("statusTitle")}
        </Text>
      </Pressable>
      <SearchField
        testID="away-substitute-search"
        value={query}
        onChange={setQuery}
        placeholder={t("awaySubstituteSearch")}
      />
      {everyone.loading && !people.length ? (
        <ActivityIndicator color={theme.muted} style={styles.state} />
      ) : (
        <View>
          {people.slice(0, 100).map((item, index) => (
            <PersonRow
              key={item.actor_id}
              testID={`away-substitute-row-${index}`}
              person={item}
              onPress={() => onPick(item.actor_id)}
            />
          ))}
          {people.length === 0 ? (
            <Text tone="muted" size={14} style={styles.state}>
              {t("awaySubstituteEmpty")}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

function CustomSection({ onDone }: { onDone(text: string): void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const selfAway = useSelfAway();
  const [draft, setDraft] = useState<CustomStatusDraft>(() =>
    customStatusDraft(user),
  );
  const [other, setOther] = useState("");
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState("");
  const hasStatus = Boolean(user.status_text || user.status_emoji);
  const problem = customStatusProblem(draft);
  const awayNow = activeAway(selfAway, new Date());

  async function run(kind: "save" | "clear", action: () => Promise<unknown>) {
    setPending(kind);
    setError("");
    try {
      await action();
      updateUser(await api.me());
      onDone(t(kind === "save" ? "statusSaved" : "statusCleared"));
    } catch {
      setError(t("statusSaveFailed"));
    } finally {
      setPending(null);
    }
  }

  const emojis = [
    ...new Set([
      ...customStatusPresets.map((preset) => preset.emoji),
      ...statusEmoji,
    ]),
  ];

  return (
    <View testID="status-custom">
      {awayNow ? (
        <View style={[styles.note, { backgroundColor: theme.warningSoft }]}>
          <Text size={13}>{t("statusCustomWhileAway")}</Text>
        </View>
      ) : null}
      <View style={styles.customRow}>
        <View
          style={[
            styles.emojiNow,
            { backgroundColor: theme.surfaceSelected },
          ]}
          accessible
          accessibilityLabel={t("statusEmoji")}
        >
          <Text size={22} allowFontScaling={false}>
            {draft.emoji || "🙂"}
          </Text>
        </View>
        <TextInput
          testID="status-text"
          value={draft.text}
          onChangeText={(text) => setDraft((current) => ({ ...current, text }))}
          placeholder={t("statusPlaceholder")}
          placeholderTextColor={theme.muted}
          accessibilityLabel={t("statusText")}
          maxLength={customStatusLimits.textMaxLength}
          selectionColor={theme.primary}
          maxFontSizeMultiplier={maxTextScale}
          style={[
            styles.input,
            styles.grow,
            {
              color: theme.foreground,
              backgroundColor: theme.surface,
              borderColor: problem ? theme.danger : theme.borderStrong,
            },
          ]}
        />
      </View>
      <Text tone="muted" size={12} style={styles.counter}>
        {`${[...draft.text].length} / ${customStatusLimits.textMaxLength}`}
      </Text>
      <View style={styles.emojis} accessibilityRole="radiogroup">
        {emojis.map((emoji, index) => {
          const on = draft.emoji === emoji;
          return (
            <Pressable
              key={emoji}
              testID={`status-emoji-${index}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={emoji}
              onPress={() =>
                setDraft((current) => ({ ...current, emoji: on ? "" : emoji }))
              }
              style={[
                styles.emoji,
                {
                  backgroundColor: on ? theme.primarySoft : theme.surface,
                  borderColor: on ? theme.primary : theme.border,
                },
              ]}
            >
              <Text size={20} allowFontScaling={false}>
                {emoji}
              </Text>
            </Pressable>
          );
        })}
        <TextInput
          testID="status-emoji-other"
          value={other}
          onChangeText={(value) => {
            const emoji = lastEmoji(value);
            setOther(emoji);
            if (emoji) setDraft((current) => ({ ...current, emoji }));
          }}
          placeholder="＋"
          placeholderTextColor={theme.muted}
          accessibilityLabel={t("statusEmojiOther")}
          selectionColor={theme.primary}
          style={[
            styles.emoji,
            styles.emojiInput,
            { color: theme.foreground, borderColor: theme.border },
          ]}
        />
      </View>

      <SectionLabel>{t("statusQuick")}</SectionLabel>
      {customStatusPresets.map((preset) => (
        <Pressable
          key={preset.labelKey}
          testID={`status-preset-${preset.labelKey}`}
          accessibilityRole="button"
          onPress={() =>
            setDraft({
              emoji: preset.emoji,
              text: t(preset.labelKey),
              expiry: preset.expiry,
            })
          }
          style={({ pressed }) => [
            styles.preset,
            pressed && { backgroundColor: theme.surfaceSelected },
          ]}
        >
          <Text size={18} allowFontScaling={false}>
            {preset.emoji}
          </Text>
          <Text size={15} style={styles.grow}>
            {t(preset.labelKey)}
          </Text>
          <Text tone="muted" size={13}>
            {t(preset.durationKey)}
          </Text>
        </Pressable>
      ))}

      <SectionLabel>{t("statusReset")}</SectionLabel>
      <View style={styles.chips}>
        {customStatusExpiries.map((expiry) => (
          <Chip
            key={expiry}
            testID={`status-expiry-${expiry}`}
            label={t(customStatusExpiryLabelKeys[expiry])}
            selected={draft.expiry === expiry}
            onPress={() => setDraft((current) => ({ ...current, expiry }))}
          />
        ))}
      </View>
      {error ? (
        <Text tone="danger" size={13} style={styles.error}>
          {error}
        </Text>
      ) : null}
      <WideButton
        testID="status-save"
        label={t("statusSave")}
        pending={pending === "save"}
        disabled={pending !== null || Boolean(problem)}
        onPress={() =>
          void run("save", () =>
            api.setStatus(toSetStatusInput(draft, new Date())),
          )
        }
        style={styles.save}
      />
      {hasStatus ? (
        <WideButton
          testID="status-clear"
          variant="secondary"
          label={t("statusClear")}
          pending={pending === "clear"}
          disabled={pending !== null}
          onPress={() => void run("clear", () => api.clearStatus())}
          style={styles.second}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { marginBottom: spacing[2] },
  state: {
    alignItems: "center",
    gap: spacing[2],
    paddingVertical: spacing[6],
    textAlign: "center",
  },
  // `.q3`: tiles in two columns.
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // `.qo`: 14 radius, 10×12 padding.
  kind: {
    flexBasis: "47%",
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  input: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.regular,
    fontSize: 15.5,
  },
  autoreply: { minHeight: 64, marginTop: 6, textAlignVertical: "top" },
  preview: { gap: 4, marginTop: 8 },
  previewBubble: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: radius.bubble,
    paddingHorizontal: 11,
    paddingVertical: 7,
    gap: 2,
    alignSelf: "flex-start",
    maxWidth: "90%",
  },
  previewName: { flexDirection: "row", alignItems: "center", gap: 5 },
  autoTag: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  hint: { marginTop: 6 },
  gap: { height: 10 },
  error: { marginTop: 6 },
  save: { marginTop: 16 },
  second: { marginTop: 8 },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 36,
    marginBottom: 4,
  },
  grow: { flex: 1, minWidth: 0 },
  note: { borderRadius: 12, padding: 10, marginBottom: 10 },
  customRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  emojiNow: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  counter: { textAlign: "right", marginTop: 4 },
  emojis: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  emoji: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiInput: {
    textAlign: "center",
    fontSize: 20,
    padding: 0,
  },
  preset: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 4,
  },
});
