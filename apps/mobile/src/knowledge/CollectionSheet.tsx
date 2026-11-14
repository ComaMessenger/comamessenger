import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AlertTriangle, Check, Hash, Info } from "lucide-react-native";
import {
  embeddingNoticeKey,
  embeddingOptionKey,
  knowledgeCollectionErrorKey,
  knowledgeCollectionForm,
  knowledgeCollectionPayload,
  knowledgeCollectionValid,
  knowledgeConnectionChanged,
  knowledgeEmbeddingConnectionsKey,
  type KnowledgeCollection,
  type KnowledgeCollectionForm,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { chatTitle } from "@/chats/ChatRow";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { Notice } from "@/ui/Notice";
import { PageSheet } from "@/ui/PageSheet";
import { ChoiceRow, Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { HeaderAction } from "./HeaderAction";

/** Creates a collection, or edits one: name, description, access, embeddings. */
export function CollectionSheet({
  visible,
  collection,
  onClose,
  onSaved,
}: {
  visible: boolean;
  /** Absent when creating a collection. */
  collection?: KnowledgeCollection;
  onClose(): void;
  onSaved(collection: KnowledgeCollection): void;
}) {
  // Every opening starts from the saved collection again.
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (visible) setSession((value) => value + 1);
  }, [visible]);
  return (
    <CollectionForm
      key={session}
      visible={visible}
      collection={collection}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function CollectionForm({
  visible,
  collection,
  onClose,
  onSaved,
}: {
  visible: boolean;
  collection?: KnowledgeCollection;
  onClose(): void;
  onSaved(collection: KnowledgeCollection): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const [form, setForm] = useState<KnowledgeCollectionForm>(() =>
    knowledgeCollectionForm(collection),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connections = useQuery({
    queryKey: knowledgeEmbeddingConnectionsKey,
    queryFn: () => api.knowledgeEmbeddingConnections(),
    staleTime: 30_000,
    enabled: visible,
  });
  const update = (change: Partial<KnowledgeCollectionForm>) =>
    setForm((current) => ({ ...current, ...change }));

  const chats = useMemo(() => {
    const known = Object.values(chatMap)
      .filter((chat) => chat.kind !== "direct" && !chat.archived_at)
      .map((chat) => ({ id: chat.id, name: chatTitle(chat, t("kbNoName")) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const knownIDs = new Set(known.map((chat) => chat.id));
    const unknown = (collection?.chat_ids ?? [])
      .filter((id) => !knownIDs.has(id))
      .map((id) => ({ id, name: t("kbChatUnknown") }));
    return [...known, ...unknown];
  }, [chatMap, collection?.chat_ids, t]);

  const selected = connections.data?.find(
    (connection) => connection.id === form.connectionID,
  );
  const valid = knowledgeCollectionValid(form);
  const noticeKey = embeddingNoticeKey(selected);

  async function save() {
    if (!valid) {
      const key = knowledgeCollectionErrorKey(form);
      setError(key ? t(key) : "");
      return;
    }
    setPending(true);
    setError("");
    try {
      const payload = knowledgeCollectionPayload(form);
      onSaved(
        collection
          ? await api.updateKnowledgeCollection(collection.id, payload)
          : await api.createKnowledgeCollection(payload),
      );
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  return (
    <PageSheet
      visible={visible}
      title={
        collection ? t("kbCollectionDialogEdit") : t("kbCollectionDialogCreate")
      }
      onClose={onClose}
      testID="kb-collection-sheet"
      trailing={
        <HeaderAction
          testID="kb-collection-save"
          label={collection ? t("kbSave") : t("kbCreate")}
          pending={pending}
          disabled={!valid}
          onPress={() => void save()}
        />
      }
    >
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <TextField
          testID="kb-collection-name"
          label={t("kbCollectionName")}
          value={form.name}
          maxLength={120}
          placeholder={t("kbCollectionNamePlaceholder")}
          onChangeText={(name) => update({ name })}
          autoFocus={!collection}
          returnKeyType="next"
        />
        <TextField
          testID="kb-collection-description"
          label={t("kbCollectionDescription")}
          hint={t("kbCollectionDescriptionHint")}
          value={form.description}
          maxLength={2000}
          multiline
          onChangeText={(description) => update({ description })}
        />
        <SettingsGroup title={t("kbAccessTitle")}>
          <AccessOption
            testID="kb-access-organization"
            label={t("kbAccessOrganization")}
            hint={t("kbAccessOrganizationHint")}
            selected={form.access === "organization"}
            onPress={() => update({ access: "organization" })}
          />
          <Divider />
          <AccessOption
            testID="kb-access-chats"
            label={t("kbAccessChatsOption")}
            hint={t("kbAccessChatsHint")}
            selected={form.access === "chats"}
            onPress={() => update({ access: "chats" })}
          />
        </SettingsGroup>
        {form.access === "chats" ? (
          <SettingsGroup
            title={`${t("kbChatsPick")} · ${t("kbChatsSelected", { count: form.chatIDs.length })}`}
          >
            {chats.length === 0 ? (
              <Text tone="muted" size={14} style={styles.note}>
                {t("kbChatsNone")}
              </Text>
            ) : (
              chats.map((chat, index) => {
                const checked = form.chatIDs.includes(chat.id);
                return (
                  <View key={chat.id}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      testID={`kb-chat-${chat.name}`}
                      accessibilityRole="checkbox"
                      accessibilityLabel={chat.name}
                      accessibilityState={{ checked }}
                      onPress={() =>
                        update({
                          chatIDs: checked
                            ? form.chatIDs.filter((id) => id !== chat.id)
                            : [...form.chatIDs, chat.id],
                        })
                      }
                      style={({ pressed }) => [
                        styles.check,
                        pressed && { backgroundColor: theme.surfaceSelected },
                      ]}
                    >
                      <View
                        style={[
                          styles.box,
                          checked
                            ? {
                                backgroundColor: theme.primary,
                                borderColor: theme.primary,
                              }
                            : { borderColor: theme.borderStrong },
                        ]}
                      >
                        {checked ? (
                          <Check size={14} strokeWidth={2.6} color={theme.onPrimary} />
                        ) : null}
                      </View>
                      <Hash size={16} color={theme.muted} />
                      <Text size={16} numberOfLines={1} style={styles.flex}>
                        {chat.name}
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            )}
          </SettingsGroup>
        ) : null}
        <SettingsGroup
          title={t("kbEmbeddingTitle")}
          hint={
            knowledgeConnectionChanged(collection, form)
              ? t("kbEmbeddingReindex")
              : undefined
          }
        >
          {connections.isPending ? (
            <ActivityIndicator style={styles.note} color={theme.muted} />
          ) : (
            <>
              <ChoiceRow
                testID="kb-embedding-none"
                label={t("kbEmbeddingNone")}
                selected={!form.connectionID}
                onPress={() => update({ connectionID: "" })}
              />
              {(connections.data ?? []).map((connection) => (
                <View key={connection.id}>
                  <Divider />
                  <ChoiceRow
                    label={t(embeddingOptionKey(connection), {
                      name: connection.name,
                      model: connection.embedding_model,
                    })}
                    selected={form.connectionID === connection.id}
                    onPress={() => update({ connectionID: connection.id })}
                  />
                </View>
              ))}
            </>
          )}
        </SettingsGroup>
        <View
          accessibilityRole={selected ? "alert" : undefined}
          style={[
            styles.notice,
            {
              backgroundColor: selected ? theme.warningSoft : theme.sidebar,
              borderColor: theme.border,
            },
          ]}
        >
          {selected ? (
            <AlertTriangle size={18} color={theme.warning} />
          ) : (
            <Info size={18} color={theme.muted} />
          )}
          <Text size={14} style={styles.flex}>
            {t(noticeKey, {
              name: selected?.name ?? "",
              model: selected?.embedding_model ?? "",
            })}
            {!selected &&
            connections.isSuccess &&
            connections.data.length === 0
              ? ` ${t("kbEmbeddingEmpty")}`
              : ""}
          </Text>
        </View>
        {error ? <Notice title={error} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
    </PageSheet>
  );
}

function AccessOption({
  label,
  hint,
  selected,
  onPress,
  testID,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onPress(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={`${label}. ${hint}`}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.check,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <View
        style={[
          styles.radio,
          { borderColor: selected ? theme.primary : theme.borderStrong },
        ]}
      >
        {selected ? (
          <View style={[styles.dot, { backgroundColor: theme.primary }]} />
        ) : null}
      </View>
      <View style={styles.flex}>
        <Text size={16}>{label}</Text>
        <Text tone="muted" size={13.5}>
          {hint}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    padding: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[5],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  note: { padding: spacing[4] },
  check: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  notice: {
    flexDirection: "row",
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
