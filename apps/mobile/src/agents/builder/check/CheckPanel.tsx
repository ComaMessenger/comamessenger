import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  chatName,
  checkBlockers,
  customExampleCount,
  draftChatIDs,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { Divider, GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { Chip, ChipRow } from "../controls";
import { CheckResult, useAgentCheck } from "./CheckResult";

/**
 * «Проверка»: ready examples of the role, the answer of the draft in a dry
 * run and a human trace. Nothing is sent to chats.
 */
export function CheckPanel() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  const { agent, recipe, chats, draft, blockers } = builder;
  const check = useAgentCheck(agent);
  const ids = draftChatIDs(draft);
  const agentChats = chats.filter((chat) => ids.includes(chat.id));
  const [chatID, setChatID] = useState("");
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const selectedChat =
    agentChats.find((chat) => chat.id === chatID) ?? agentChats[0];
  const blocking = blockers.filter((blocker) =>
    checkBlockers.has(blocker.key),
  );
  const examples = recipe
    ? recipe.checks
    : Array.from({ length: customExampleCount }, (_, index) => ({
        prompt: t(`agentExample_custom_${index + 1}`),
        expectations: [] as string[],
      }));
  const expected = examples.find(
    (example) => example.prompt === prompt,
  )?.expectations;

  async function start() {
    if (!selectedChat || !prompt.trim()) return;
    if (!(await builder.flush())) return;
    await check.start(selectedChat.id, prompt.trim());
  }

  if (!builder.access.canBuild)
    return (
      <SettingsGroup title={t("agentCheckTitle")}>
        <GroupBody>
          <Text tone="muted" size={15}>
            {t("agentCheckNoRights")}
          </Text>
        </GroupBody>
      </SettingsGroup>
    );

  return (
    <SettingsGroup title={t("agentCheckTitle")} hint={t("agentCheckLead")}>
      <GroupBody>
        <Text weight="medium" size={14}>
          {t("agentCheckExamples")}
        </Text>
        <ChipRow>
          {examples.map((example, index) => (
            <Chip
              key={example.prompt}
              testID={`agent-check-example-${index}`}
              label={example.prompt}
              selected={prompt === example.prompt}
              onPress={() => setPrompt(example.prompt)}
            />
          ))}
        </ChipRow>
        {expected && expected.length > 0 ? (
          <View style={styles.expect}>
            <Text weight="medium" size={14}>
              {t("agentCheckExpect")}
            </Text>
            {expected.map((line) => (
              <Text key={line} tone="muted" size={14}>
                • {line}
              </Text>
            ))}
          </View>
        ) : null}
        <TextField
          testID="agent-check-message"
          label={t("agentCheckMessage")}
          value={prompt}
          multiline
          placeholder={t("agentCheckMessagePlaceholder")}
          onChangeText={setPrompt}
        />
      </GroupBody>
      {agentChats.length > 1 ? (
        <>
          <Divider />
          <NavRow
            label={t("agentCheckChat")}
            value={selectedChat ? chatName(selectedChat) : ""}
            onPress={() => setPicking(true)}
          />
        </>
      ) : null}
      <GroupBody>
        {selectedChat && agentChats.length === 1 ? (
          <Text tone="muted" size={14}>
            {t("agentCheckInChat", { chat: chatName(selectedChat) })}
          </Text>
        ) : null}
        {blocking.length > 0 ? (
          <Notice
            tone="neutral"
            title={t("agentCheckNeeds")}
            hint={blocking
              .map((blocker) => t(`agentBlocker_${blocker.key}`))
              .join("\n")}
          />
        ) : null}
        {check.pending ? (
          <View style={styles.row}>
            <Text
              tone="muted"
              size={15}
              style={styles.grow}
              accessibilityLiveRegion="polite"
            >
              {t("agentCheckThinking")}
            </Text>
            <Button
              variant="ghost"
              label={t("agentCheckStop")}
              onPress={check.stop}
            />
          </View>
        ) : (
          <Button
            testID="agent-check-run"
            variant="secondary"
            label={check.run ? t("agentCheckAgain") : t("agentCheckRun")}
            disabled={blocking.length > 0 || !prompt.trim() || !selectedChat}
            onPress={() => void start()}
          />
        )}
        {check.error ? <Notice title={check.error} /> : null}
        {check.run ? <CheckResult run={check.run} chat={selectedChat} /> : null}
      </GroupBody>
      <PickerSheet
        visible={picking}
        title={t("agentCheckChat")}
        value={selectedChat?.id ?? ""}
        options={agentChats.map((chat) => ({
          value: chat.id,
          label: chatName(chat),
        }))}
        onSelect={setChatID}
        onClose={() => setPicking(false)}
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  expect: { gap: spacing[1] },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  grow: { flex: 1 },
});
