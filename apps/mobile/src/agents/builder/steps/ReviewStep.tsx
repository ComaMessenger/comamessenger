import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Cloud, Eye, Plug, Settings2, Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatName,
  type AgentBuilderStep,
  type AgentLlmConnection,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { openWebClient } from "@/lib/web";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { PickerSheet } from "@/ui/PickerSheet";
import {
  ActionRow,
  Divider,
  InfoRow,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { CheckPanel } from "../check/CheckPanel";
import { Note } from "../controls";
import { agentBuilderPaths, useCollections } from "../data";
import { BlockerList, LoosenedSheet, usePublishState } from "../publish";
import { StepScreen } from "../StepScreen";

/**
 * Step 6: the model and what leaves the workspace for it (web block
 * «Модель»), what still stops the publish, the check and the publish itself.
 */
export function ReviewStep() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  const { agent, access, pending } = builder;
  const publish = usePublishState();
  const open = (step: AgentBuilderStep) => {
    builder.clearMessages();
    router.setParams({ step });
  };
  return (
    <StepScreen
      step="review"
      title={t("agentStepReview")}
      lead={t("agentStepReviewLead")}
      next={
        <Button
          testID="agent-publish"
          label={t("agentPublish")}
          pending={pending === "publish"}
          disabled={publish.disabled}
          accessibilityHint={publish.reason ?? undefined}
          onPress={() => void builder.publish()}
        />
      }
    >
      {agent.kind === "builtin" ? <ModelSection /> : null}
      {publish.reason ? (
        <Text tone="muted" size={14} testID="agent-publish-reason">
          {publish.reason}
        </Text>
      ) : (
        <BlockerList onOpen={open} />
      )}
      <CheckPanel />
      <SettingsGroup>
        {access.canPublish &&
        agent.operational_status === "active" &&
        !builder.dirty ? (
          <>
            <ActionRow
              testID="agent-pause"
              label={t("agentPause")}
              tone="default"
              pending={pending === "pause"}
              disabled={Boolean(pending)}
              onPress={() => void builder.pause()}
            />
            <Divider />
          </>
        ) : null}
        {access.canPublish &&
        agent.operational_status === "paused" &&
        !builder.dirty ? (
          <>
            <ActionRow
              testID="agent-resume"
              label={t("agentResume")}
              pending={pending === "resume"}
              disabled={Boolean(pending) || builder.blockers.length > 0}
              onPress={() => void builder.resume()}
            />
            <Divider />
          </>
        ) : null}
        {access.canBuild ? (
          <>
            <NavRow
              testID="agent-open-architect"
              icon={Sparkles}
              label={t("architectEditExisting")}
              onPress={() =>
                void builder.flush().then((saved) => {
                  if (saved)
                    router.push(agentBuilderPaths.editArchitect(agent.id));
                })
              }
            />
            <Divider />
          </>
        ) : null}
        <NavRow
          testID="agent-open-advanced"
          icon={Settings2}
          label={t("agentAdvancedTitle")}
          hint={t("agentAdvancedLead")}
          onPress={() => router.push(agentBuilderPaths.advanced(agent.id))}
        />
      </SettingsGroup>
      <LoosenedSheet />
    </StepScreen>
  );
}

function healthTone(connection: AgentLlmConnection) {
  if (!connection.enabled) return "agentModelDisabled";
  return `agentModelHealth_${connection.health_status}`;
}

/**
 * The workspace model connection and, in one explicit sentence, what leaves
 * the workspace for the external model.
 */
function ModelSection() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const builder = useAgentBuilder();
  const { draft, connections, chats, capabilities, access, update } = builder;
  const [choosing, setChoosing] = useState(false);
  const enabled = connections.filter((connection) => connection.enabled);
  const current = connections.find(
    (connection) => connection.id === draft.llm_connection_id,
  );
  const collections = useCollections(
    (draft.knowledge_collection_ids ?? []).length > 0,
  );
  const editable = access.canBuild;
  const choose = (connection: AgentLlmConnection | undefined) =>
    update((value) => ({
      ...value,
      llm_connection_id: connection?.id ?? "",
      provider: connection?.provider ?? value.provider,
      endpoint_url: connection ? "" : value.endpoint_url,
      model: connection?.default_model || value.model || "",
    }));
  const chatNames = draft.chat_ids
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat) => chat !== undefined)
    .map((chat) => `«${chatName(chat)}»`);
  const collectionNames = (draft.knowledge_collection_ids ?? []).map(
    (id) =>
      `«${collections.data?.find((item) => item.id === id)?.name ?? t("agentKnowledgeUnavailable")}»`,
  );
  const parts = [
    chatNames.length
      ? t("agentDataChats", { chats: chatNames.join(", ") })
      : t("agentDataNoChats"),
    capabilities.sources.includes("files") ? t("agentDataFiles") : "",
    capabilities.sources.includes("members") ? t("agentDataMembers") : "",
    collectionNames.length
      ? t("agentDataKnowledge", { collections: collectionNames.join(", ") })
      : "",
  ].filter(Boolean);

  return (
    <SettingsGroup title={t("agentBlockModel")} hint={t("agentBlockModelHint")}>
      {enabled.length === 0 && !current ? (
        <>
          <View style={styles.missing}>
            <Plug size={20} color={theme.muted} />
            <View style={styles.grow}>
              <Text size={16} weight="medium">
                {t("agentModelMissing")}
              </Text>
              <Text tone="muted" size={13.5}>
                {access.canIntegrate
                  ? t("agentModelMissingHint")
                  : t("agentModelMissingAskAdmin")}
              </Text>
            </View>
          </View>
          {access.canIntegrate ? (
            <>
              <Divider />
              <ActionRow
                label={t("agentModelConnect")}
                onPress={() =>
                  void openWebClient(api.apiURL, "/agents/connections")
                }
              />
            </>
          ) : null}
        </>
      ) : (
        <NavRow
          testID="agent-model-connection"
          icon={Cloud}
          label={current?.name ?? t("agentModelChoose")}
          hint={current ? t("agentModelExternal") : undefined}
          value={current ? t(healthTone(current)) : undefined}
          disabled={!editable}
          onPress={() => setChoosing(true)}
        />
      )}
      {current && draft.model ? (
        <>
          <Divider />
          <InfoRow label={t("model")} value={draft.model} />
        </>
      ) : null}
      <Divider />
      <SwitchRow
        testID="agent-data-consent"
        label={t("agentDataConsent")}
        hint={t("agentDataConsentHint")}
        value={draft.external_data_sharing_approved}
        disabled={!editable}
        onChange={(value) => update({ external_data_sharing_approved: value })}
      />
      <Divider />
      <View style={styles.sentence}>
        <Note icon={<Eye size={16} color={theme.muted} />}>
          {t("agentDataSentence", { parts: parts.join("; ") })}
        </Note>
      </View>
      <PickerSheet
        visible={choosing}
        title={t("agentModelConnection")}
        value={draft.llm_connection_id ?? ""}
        options={enabled.map((connection) => ({
          value: connection.id,
          label: connection.name,
        }))}
        onSelect={(id) => choose(enabled.find((item) => item.id === id))}
        onClose={() => setChoosing(false)}
        testID="agent-model-picker"
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  missing: {
    flexDirection: "row",
    gap: spacing[3],
    alignItems: "center",
    padding: spacing[4],
  },
  sentence: { padding: spacing[3] },
  grow: { flex: 1 },
});
