import { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { Lock, LockOpen, Megaphone, Users } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  APIError,
  chatNameMaxBytes,
  createChatRequest,
  newChatProblem,
  type ActorSummary,
  type NewChatDraft,
  type NewChatKind,
  type NewChatProblem,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { messageOf } from "@/lib/errors";
import i18n from "@/i18n";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { PeoplePicker } from "@/people/PeoplePicker";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { SwitchRow } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";

const problemKeys: Record<NewChatProblem, string> = {
  nameRequired: "chatNameRequired",
  nameTooLong: "chatNameTooLong",
  topicTooLong: "chatTopicTooLong",
};

/**
 * Why the server refused to create the chat. A plain member may create a
 * channel or an open group only when the workspace allows it; the setting
 * is visible to administrators only, so the refusal is the first sign.
 */
export function createFailure(cause: unknown, draft: NewChatDraft): string {
  if (cause instanceof APIError && cause.status === 403) {
    if (draft.kind === "channel") return i18n.t("channelCreateForbidden");
    if (draft.open) return i18n.t("openGroupForbidden");
  }
  return messageOf(cause);
}

/** Group or channel kind as a radio card, as in the web dialog. */
function KindOption({
  icon: Icon,
  label,
  hint,
  selected,
  onPress,
  testID,
}: {
  icon: typeof Users;
  label: string;
  hint: string;
  selected: boolean;
  onPress(): void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${label}. ${hint}`}
      onPress={onPress}
      style={[
        styles.kind,
        {
          backgroundColor: selected ? theme.primarySoft : theme.surface,
          borderColor: selected ? theme.primary : theme.border,
        },
      ]}
    >
      <Icon size={20} color={selected ? theme.primary : theme.muted} />
      <Text weight="semibold" size={15}>
        {label}
      </Text>
      <Text tone="muted" size={12.5}>
        {hint}
      </Text>
    </Pressable>
  );
}

/**
 * New group or channel in two steps: choose people (optional), then name,
 * description and openness. Creates the chat and opens it.
 */
export function NewGroupScreen({ initialKind }: { initialKind: NewChatKind }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const [step, setStep] = useState<"members" | "details">("members");
  const [kind, setKind] = useState<NewChatKind>(initialKind);
  const [members, setMembers] = useState<ActorSummary[]>([]);
  const [name, setName] = useState("");
  const topicInput = useRef<TextInput>(null);
  const [topic, setTopic] = useState("");
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const draft: NewChatDraft = {
    kind,
    name,
    topic,
    open,
    memberIDs: members.map((actor) => actor.actor_id),
  };
  const problem = newChatProblem(draft);

  // Android «back» on the details step returns to the people, as the header does.
  useEffect(() => {
    if (step !== "details") return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setStep("members");
        return true;
      },
    );
    return () => subscription.remove();
  }, [step]);
  const channel = kind === "channel";

  async function create() {
    setTouched(true);
    if (problem || pending) return;
    setPending(true);
    setError("");
    try {
      const chat = await api.createChat(createChatRequest(draft, user.id));
      store.setState((state) => ({
        chats: { ...state.chats, [chat.id]: chat },
      }));
      scheduleReload();
      // The new chat replaces both steps; «back» returns to the chat list.
      router.dismissAll();
      router.push(`/chat/${chat.id}`);
    } catch (cause) {
      setError(createFailure(cause, draft));
      setPending(false);
    }
  }

  const title = channel ? t("newChannel") : t("newGroup");

  if (step === "members")
    return (
      <SafeAreaView
        testID="new-group-members"
        edges={["bottom"]}
        style={[styles.screen, { backgroundColor: theme.surface }]}
      >
        <ScreenHeader
          backTestID="new-group-back"
          title={title}
          subtitle={
            members.length
              ? t("chosenPeople", { count: members.length })
              : t("addPeopleOptional")
          }
          trailing={
            <Pressable
              testID="new-group-next"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setStep("details")}
              style={styles.headerAction}
            >
              <Text weight="semibold" size={16} tone="primary">
                {t("next")}
              </Text>
            </Pressable>
          }
        />
        <PeoplePicker
          testID="new-group-picker"
          selected={members}
          onChange={setMembers}
        />
      </SafeAreaView>
    );

  const visibilityTitle = channel
    ? open
      ? t("openChannel")
      : t("privateChannel")
    : open
      ? t("openGroup")
      : t("privateGroup");
  const visibilityHint = channel
    ? open
      ? t("openChannelHint")
      : t("privateChannelHint")
    : open
      ? t("openGroupHint")
      : t("privateGroupHint");
  const nameError = touched && problem && problem !== "topicTooLong";

  return (
    <SafeAreaView
      testID="new-group-details"
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        backTestID="new-group-details-back"
        title={title}
        subtitle={
          members.length
            ? t("chosenPeople", { count: members.length })
            : t("onlyYou")
        }
        onBack={() => setStep("members")}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.grow}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          // Any drag of the form puts the keyboard away and uncovers «Create».
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.form}
        >
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("chatKind")}
            style={styles.kinds}
          >
            <KindOption
              testID="kind-group"
              icon={Users}
              label={t("group")}
              hint={t("groupHint")}
              selected={!channel}
              onPress={() => setKind("group")}
            />
            <KindOption
              testID="kind-channel"
              icon={Megaphone}
              label={t("channel")}
              hint={t("channelHint")}
              selected={channel}
              onPress={() => setKind("channel")}
            />
          </View>
          <TextField
            testID="new-group-name"
            label={t("chatName")}
            value={name}
            onChangeText={setName}
            autoFocus
            maxLength={chatNameMaxBytes}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => topicInput.current?.focus()}
            error={nameError ? t(problemKeys[problem]) : undefined}
          />
          <TextField
            ref={topicInput}
            testID="new-group-topic"
            label={t("chatTopic")}
            hint={t("optional")}
            value={topic}
            onChangeText={setTopic}
            multiline
            error={
              touched && problem === "topicTooLong"
                ? t(problemKeys.topicTooLong)
                : undefined
            }
          />
          <View
            style={[
              styles.visibility,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            <View style={styles.visibilityHead}>
              {open ? (
                <LockOpen size={20} color={theme.muted} />
              ) : (
                <Lock size={20} color={theme.muted} />
              )}
              <View style={styles.grow}>
                <SwitchRow
                  label={visibilityTitle}
                  value={open}
                  onChange={setOpen}
                />
              </View>
            </View>
            <Text tone="muted" size={13.5} style={styles.visibilityHint}>
              {visibilityHint}
            </Text>
          </View>
          {error ? <Notice title={error} /> : null}
          <Button
            testID="new-group-create"
            label={channel ? t("createChannel") : t("createGroup")}
            pending={pending}
            onPress={() => void create()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  headerAction: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    paddingHorizontal: spacing[2],
  },
  form: { padding: spacing[4], gap: spacing[4] },
  kinds: { flexDirection: "row", gap: spacing[3] },
  kind: {
    flex: 1,
    gap: 4,
    padding: spacing[3],
    borderRadius: radius.lg,
    borderWidth: 1.5,
  },
  visibility: { borderRadius: radius.lg, borderWidth: 1, overflow: "hidden" },
  visibilityHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing[4],
  },
  visibilityHint: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
});
