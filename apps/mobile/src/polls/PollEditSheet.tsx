import { useEffect, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { useTranslation } from "react-i18next";
import {
  pollLimits,
  type ClientMessage,
  type MessagePoll,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text, fonts, maxTextScale } from "@/ui/Text";
import { WideButton } from "@/requests/parts";
import { pollErrorText } from "./format";

/**
 * «Изменить» of the author's own open poll (decision 12): only the
 * question changes (updatePoll), the card says «изм.». Options, settings
 * and the due date stay: people are voting for them.
 */
export function PollEditSheet({
  message,
  onClose,
  onNotice,
}: {
  message: (ClientMessage & { poll: MessagePoll }) | null;
  onClose(): void;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const id = message?.id;
  useEffect(() => {
    if (!message) return;
    setQuestion(message.poll.question);
    setError("");
    // Opened for another message: start from its question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const trimmed = question.trim();
  const tooLong = [...trimmed].length > pollLimits.questionMaxLength;
  const unchanged = !message || trimmed === message.poll.question;

  async function save() {
    if (!message || !trimmed || tooLong || unchanged) return;
    setPending(true);
    setError("");
    try {
      const updated = await api.updatePoll(message.id, {
        question: trimmed,
        expected_version: message.poll.version,
      });
      store.getState().reconcile({ ...updated, delivery: "sent" });
      onClose();
      onNotice(t("pollEditedToast"));
    } catch (cause) {
      setError(pollErrorText(t, cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <BottomSheet
      visible={message !== null}
      title={t("pollEditTitle")}
      onClose={onClose}
      testID="poll-edit"
    >
      <TextInput
        testID="poll-edit-question"
        value={question}
        onChangeText={setQuestion}
        accessibilityLabel={t("pollQuestionLabel")}
        selectionColor={theme.primary}
        maxLength={pollLimits.questionMaxLength}
        multiline
        autoFocus
        maxFontSizeMultiplier={maxTextScale}
        style={[
          styles.field,
          {
            color: theme.foreground,
            backgroundColor: theme.surface,
            borderColor: error || !trimmed ? theme.danger : theme.borderStrong,
          },
        ]}
      />
      <Text tone="muted" size={13} style={styles.hint}>
        {t("pollEditHint")}
      </Text>
      {error ? (
        <Text tone="danger" size={13} style={styles.hint}>
          {error}
        </Text>
      ) : null}
      <WideButton
        testID="poll-edit-save"
        label={t("pollEditSave")}
        pending={pending}
        disabled={!trimmed || tooLong || unchanged}
        onPress={() => void save()}
        style={styles.save}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: 72,
    maxHeight: 160,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingTop: 11,
    paddingBottom: 11,
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlignVertical: "top",
  },
  hint: { marginTop: 8 },
  save: { marginTop: 14 },
});
