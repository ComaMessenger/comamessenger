import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  ChevronRight,
  LayoutTemplate,
  MessagesSquare,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatName,
  createAgentProblem,
  newAgentRequest,
  triggersToLocalize,
  type AgentRecipe,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { Divider, GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { ChatPickerSheet } from "./ChatPickerSheet";
import {
  agentBuilderPaths,
  agentKeys,
  useAgentAccess,
  useChats,
  useConnections,
  useRecipes,
  useTimezone,
} from "./data";

function Way({
  icon: Icon,
  title,
  hint,
  onPress,
  testID,
  accent = false,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  onPress(): void;
  testID: string;
  accent?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.way,
        {
          backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
          borderColor: accent ? theme.primary : theme.border,
        },
      ]}
    >
      <View
        style={[
          styles.wayIcon,
          { backgroundColor: accent ? theme.primarySoft : theme.sidebar },
        ]}
      >
        <Icon size={22} color={accent ? theme.primary : theme.foreground} />
      </View>
      <View style={styles.grow}>
        <Text size={16.5} weight="semibold">
          {title}
        </Text>
        <Text tone="muted" size={14}>
          {hint}
        </Text>
      </View>
      <ChevronRight size={20} color={theme.subtle} />
    </Pressable>
  );
}

/**
 * «Создать агента»: by talking to the Architect (the main way), from a
 * ready role of the pilot, or step by step by hand.
 */
export function CreateAgentScreen() {
  const { t } = useTranslation();
  const access = useAgentAccess();
  return (
    <SettingsScreen
      title={t("agentCreateNew")}
      allowed={access.canBuild}
      testID="agent-create-screen"
    >
      <Text tone="muted" size={15}>
        {t("agentCreateWaysLead")}
      </Text>
      <Way
        testID="agent-create-architect"
        accent
        icon={Sparkles}
        title={t("agentCreateWithArchitect")}
        hint={t("agentCreateWithArchitectHint")}
        onPress={() => router.push(agentBuilderPaths.architect)}
      />
      <Way
        testID="agent-create-template"
        icon={LayoutTemplate}
        title={t("agentCreateFromTemplate")}
        hint={t("agentCreateFromTemplateHint")}
        onPress={() => router.push(agentBuilderPaths.templates)}
      />
      <Way
        testID="agent-create-manual"
        icon={Wrench}
        title={t("agentBuildManually")}
        hint={t("agentCreateManualHint")}
        onPress={() => router.push(agentBuilderPaths.template("custom"))}
      />
    </SettingsScreen>
  );
}

/** Ready roles from Core (the pilot recipes), each with its typical request. */
export function TemplatesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const access = useAgentAccess();
  const recipes = useRecipes();
  return (
    <SettingsScreen
      title={t("agentCreateFromTemplate")}
      allowed={access.canBuild}
      query={recipes}
      testID="agent-templates-screen"
    >
      <Text tone="muted" size={15}>
        {t("agentTemplatesLead")}
      </Text>
      {(recipes.data ?? []).map((recipe) => (
        <Pressable
          key={recipe.id}
          testID={`agent-template-${recipe.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${recipe.name}. ${recipe.summary}`}
          onPress={() => router.push(agentBuilderPaths.template(recipe.id))}
          style={({ pressed }) => [
            styles.recipe,
            {
              backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
              borderColor: theme.border,
            },
          ]}
        >
          <View style={styles.recipeHead}>
            <Text size={16.5} weight="semibold" style={styles.grow}>
              {recipe.name}
            </Text>
            <ChevronRight size={20} color={theme.subtle} />
          </View>
          <Text tone="muted" size={14}>
            {recipe.summary}
          </Text>
          {recipe.example ? (
            <View style={[styles.example, { backgroundColor: theme.sidebar }]}>
              <MessagesSquare size={14} color={theme.muted} />
              <Text size={13.5} style={styles.grow} numberOfLines={2}>
                «{recipe.example}»
              </Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </SettingsScreen>
  );
}

/**
 * A new draft: a role's preview (what it does, how it starts, what it still
 * needs), its name and first chat. A role needs a chat now; a custom agent
 * may choose it later. The builder opens right after.
 */
export function NewAgentScreen({ recipeID }: { recipeID: string }) {
  const { t, i18n } = useTranslation();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const access = useAgentAccess();
  const recipes = useRecipes();
  const connections = useConnections();
  const chats = useChats();
  const timezone = useTimezone();
  const custom = recipeID === "custom";
  const recipe: AgentRecipe | null = custom
    ? null
    : (recipes.data?.find((item) => item.id === recipeID) ?? null);
  const [name, setName] = useState<string | null>(null);
  const [chatID, setChatID] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const chosen = chats.find((chat) => chat.id === chatID);
  const shownName = name ?? recipe?.name ?? "";

  async function create() {
    setError("");
    const problem = createAgentProblem({ name: shownName, chatID, recipe });
    if (problem) {
      setError(t(problem));
      return;
    }
    setPending(true);
    try {
      const created = await api.createAgent(
        newAgentRequest({
          recipe,
          name: shownName,
          chatID,
          connections: connections.data ?? [],
          locale: i18n.resolvedLanguage ?? i18n.language,
        }),
      );
      if (recipe) {
        const triggers = await api.agentTriggers(created.id);
        await Promise.all(
          triggersToLocalize(triggers, timezone).map((trigger) =>
            api.updateAgentTrigger(created.id, trigger.id, { timezone }),
          ),
        );
      }
      await queryClient.invalidateQueries({ queryKey: agentKeys.agents });
      router.replace(agentBuilderPaths.edit(created.id));
      router.push(agentBuilderPaths.step(created.id, "role"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const missing = !custom && recipes.isSuccess && !recipe;
  return (
    <SettingsScreen
      title={
        recipe
          ? t("agentCreateTitle", { role: recipe.name })
          : t("agentCreateTitleCustom")
      }
      allowed={access.canBuild}
      query={custom ? connections : [recipes, connections]}
      testID="agent-new-screen"
    >
      {missing ? (
        <Notice title={t("agentTemplateMissing")} />
      ) : (
        <>
          {recipe ? (
            <SettingsGroup title={t("agentTemplatePreview")}>
              <GroupBody>
                <Text size={15.5}>{recipe.summary}</Text>
                {recipe.example ? (
                  <Text tone="muted" size={14}>
                    {t("agentTemplateExample", { text: recipe.example })}
                  </Text>
                ) : null}
              </GroupBody>
              {recipe.triggers.length > 0 ? (
                <>
                  <Divider />
                  <GroupBody>
                    <Text weight="semibold" size={14}>
                      {t("agentRecipeHowTitle")}
                    </Text>
                    {recipe.triggers.map((trigger) => (
                      <Text key={trigger.summary} tone="muted" size={14}>
                        • {trigger.summary}
                      </Text>
                    ))}
                  </GroupBody>
                </>
              ) : null}
              {recipe.needs.length > 0 ? (
                <>
                  <Divider />
                  <GroupBody>
                    <Text weight="semibold" size={14}>
                      {t("agentTemplateNeeds")}
                    </Text>
                    {recipe.needs.map((need) => (
                      <Text key={need.kind} tone="muted" size={14}>
                        • {need.label}
                        {need.required
                          ? ""
                          : ` · ${t("agentRecipeNeedOptional")}`}
                      </Text>
                    ))}
                  </GroupBody>
                </>
              ) : null}
            </SettingsGroup>
          ) : (
            <Text tone="muted" size={15}>
              {t("agentCreateLead")}
            </Text>
          )}
          <SettingsGroup>
            <GroupBody>
              <TextField
                testID="agent-create-name"
                label={t("agentCreateName")}
                value={shownName}
                placeholder={t("agentCreateNamePlaceholder")}
                onChangeText={(value) => {
                  setName(value);
                  setError("");
                }}
              />
            </GroupBody>
            <Divider />
            <NavRow
              testID="agent-create-chat"
              label={t("agentCreateChat")}
              value={
                chosen
                  ? chatName(chosen)
                  : recipe
                    ? t("agentChooseChat")
                    : t("agentCreateChatLater")
              }
              onPress={() => setPicking(true)}
            />
          </SettingsGroup>
          <Text tone="muted" size={13.5}>
            {t("agentCreateSafe")}
          </Text>
          {error ? <Notice title={error} /> : null}
          <Button
            testID="agent-create-submit"
            label={t("agentCreateSubmit")}
            pending={pending}
            onPress={() => void create()}
          />
        </>
      )}
      <ChatPickerSheet
        visible={picking}
        single
        title={t("agentCreateChat")}
        chats={chats}
        exclude={[]}
        onClose={() => setPicking(false)}
        onDone={([id]) => {
          setChatID(id ?? "");
          setError("");
        }}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  way: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  wayIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  recipe: {
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing[2],
  },
  recipeHead: { flexDirection: "row", alignItems: "center" },
  example: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    padding: spacing[2],
    borderRadius: radius.md,
  },
  grow: { flex: 1 },
});
