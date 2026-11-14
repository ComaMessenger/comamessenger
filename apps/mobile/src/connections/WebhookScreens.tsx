import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { History, KeyRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  validWebhookRate,
  webhookURL,
  type IntegrationWebhook,
  type IntegrationWebhookWithSecret,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsScreen, settingsContent } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PageSheet } from "@/ui/PageSheet";
import {
  ActionRow,
  Divider,
  GroupBody,
  InfoRow,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import {
  dateTime,
  errorText,
  useConnectionsAccess,
  useStore,
  useWebhooks,
  webhooksKey,
} from "./data";
import { CodeValue, CopyRow, SecretOnce } from "./Secrets";

function RateField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  const invalid = value !== "" && !validWebhookRate(Number(value));
  return (
    <TextField
      testID="webhook-rate"
      label={t("connWebhookRate")}
      keyboardType="number-pad"
      placeholder="60"
      value={value}
      onChangeText={(text) => onChange(text.replace(/\D/g, ""))}
      error={invalid ? t("connWebhookRateInvalid") : undefined}
      hint={t("connWebhookRateHint")}
    />
  );
}

/** «Новый вебхук»: name and description; the secret is shown once after. */
export function WebhookCreateScreen() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const store = useStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rate, setRate] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<IntegrationWebhookWithSecret | null>(
    null,
  );
  const rateOK = rate === "" || validWebhookRate(Number(rate));

  async function save() {
    setPending(true);
    setError("");
    try {
      const result = await api.createIntegrationWebhook({
        name: name.trim(),
        description: description.trim(),
        enabled: true,
        // Released for agents separately, on the webhook screen (as on the web).
        agent_use_allowed: false,
        ...(rate ? { rate_limit_per_minute: Number(rate) } : {}),
      });
      store.webhook(result);
      setCreated(result);
    } catch (cause) {
      setError(errorText(cause, "webhook"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen
      title={created ? created.name : t("connWebhookNew")}
      testID="connections-webhook-new"
      allowed={access.manage}
    >
      {created ? (
        <SecretOnce
          url={webhookURL(api.apiURL, created.id)}
          secret={created.secret}
          onDone={() => {
            const id = created.id;
            setCreated(null);
            router.replace(`/settings/connections/integrations/webhooks/${id}`);
          }}
        />
      ) : (
        <>
          <SettingsGroup hint={t("connWebhookCreateHint")}>
            <GroupBody>
              <TextField
                testID="webhook-name"
                label={t("connWebhookName")}
                maxLength={120}
                value={name}
                onChangeText={setName}
              />
              <TextField
                testID="webhook-description"
                label={t("connWebhookDescription")}
                multiline
                maxLength={500}
                value={description}
                onChangeText={setDescription}
              />
              <RateField value={rate} onChange={setRate} />
            </GroupBody>
          </SettingsGroup>
          {error ? <Notice title={error} /> : null}
          <Button
            testID="webhook-save"
            label={t("save")}
            pending={pending}
            disabled={!name.trim() || !rateOK}
            onPress={() => void save()}
          />
        </>
      )}
    </SettingsScreen>
  );
}

/** One incoming webhook: address, secret, rules, journal, edit, delete. */
export function WebhookScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const access = useConnectionsAccess();
  const webhooks = useWebhooks();
  const hook = webhooks.data?.find((item) => item.id === id);
  return (
    <SettingsScreen
      title={hook?.name ?? t("connWebhooksTitle")}
      subtitle={hook?.description || undefined}
      testID="connections-webhook"
      allowed={access.manage}
      query={webhooks}
    >
      {hook ? (
        <WebhookDetails hook={hook} />
      ) : (
        <Notice tone="neutral" title={t("connNotFound")} />
      )}
    </SettingsScreen>
  );
}

type Busy = "rule" | "rotate" | "save" | "delete" | null;

function WebhookDetails({ hook }: { hook: IntegrationWebhook }) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const store = useStore();
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [secret, setSecret] = useState<string | null>(null);
  const [journal, setJournal] = useState(false);
  const [name, setName] = useState(hook.name);
  const [description, setDescription] = useState(hook.description);
  const [rate, setRate] = useState(String(hook.rate_limit_per_minute));
  const url = webhookURL(api.apiURL, hook.id);
  const change = {
    ...(name.trim() !== hook.name ? { name: name.trim() } : {}),
    ...(description.trim() !== hook.description
      ? { description: description.trim() }
      : {}),
    ...(Number(rate) !== hook.rate_limit_per_minute
      ? { rate_limit_per_minute: Number(rate) }
      : {}),
  };
  const dirty = Object.keys(change).length > 0;
  const valid = Boolean(name.trim()) && validWebhookRate(Number(rate));

  async function act<T extends IntegrationWebhook>(
    kind: NonNullable<Busy>,
    action: () => Promise<T>,
  ): Promise<T | null> {
    setBusy(kind);
    setResult(null);
    try {
      const updated = await action();
      store.webhook(updated);
      return updated;
    } catch (cause) {
      setResult({ ok: false, text: errorText(cause, "webhook") });
      return null;
    } finally {
      setBusy(null);
    }
  }

  function rotate() {
    Alert.alert(t("connWebhookRotateTitle"), t("connWebhookRotateText"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("connWebhookRotateConfirm"),
        style: "destructive",
        onPress: async () => {
          const rotated = await act("rotate", () =>
            api.rotateIntegrationWebhookSecret(hook.id),
          );
          if (rotated) setSecret(rotated.secret);
        },
      },
    ]);
  }

  async function save() {
    const updated = await act("save", () =>
      api.updateIntegrationWebhook(hook.id, change),
    );
    if (updated) setResult({ ok: true, text: t("connSaved") });
  }

  function remove() {
    if (hook.trigger_count > 0) {
      Alert.alert(t("connWebhookDeleteBlocked"));
      return;
    }
    Alert.alert(
      t("connDeleteTitle", { name: hook.name }),
      t("connWebhookDeleteText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: async () => {
            setBusy("delete");
            try {
              await api.deleteIntegrationWebhook(hook.id);
              store.remove(webhooksKey, hook.id);
              router.back();
            } catch (cause) {
              setResult({ ok: false, text: errorText(cause, "webhook") });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  if (secret)
    return (
      <SecretOnce url={url} secret={secret} onDone={() => setSecret(null)} />
    );

  return (
    <View style={styles.stack}>
      <SettingsGroup hint={t("connWebhookSigning")}>
        <GroupBody>
          <CodeValue
            label={t("connWebhookURL")}
            value={url}
            testID="webhook-url"
          />
        </GroupBody>
        <Divider />
        <CopyRow
          testID="webhook-copy-url"
          label={t("connWebhookCopyURL")}
          text={url}
        />
        <Divider />
        <InfoRow
          testID="webhook-secret-hint"
          label={t("connWebhookSecret")}
          value={hook.secret_hint}
        />
        <Divider />
        <ActionRow
          testID="webhook-rotate"
          icon={KeyRound}
          label={t("connWebhookRotate")}
          pending={busy === "rotate"}
          disabled={busy !== null}
          onPress={rotate}
        />
      </SettingsGroup>
      {result && (
        <Notice tone={result.ok ? "success" : "danger"} title={result.text} />
      )}

      <SettingsGroup>
        <SwitchRow
          testID="webhook-enabled"
          label={t("connEnabled")}
          value={hook.enabled}
          disabled={busy !== null}
          onChange={(enabled) =>
            void act("rule", () =>
              api.updateIntegrationWebhook(hook.id, { enabled }),
            )
          }
        />
        <Divider />
        <SwitchRow
          testID="webhook-agent-use"
          label={t("connWebhookAgentUse")}
          hint={t("connWebhookAgentUseHint")}
          value={hook.agent_use_allowed ?? false}
          disabled={busy !== null}
          onChange={(agent_use_allowed) =>
            void act("rule", () =>
              api.updateIntegrationWebhook(hook.id, { agent_use_allowed }),
            )
          }
        />
        <Divider />
        <InfoRow
          label={t("connWebhookTriggers")}
          value={String(hook.trigger_count)}
        />
        <Divider />
        <InfoRow
          label={t("connWebhookLastReceived")}
          value={
            hook.last_received_at
              ? dateTime(hook.last_received_at)
              : t("connWebhookNever")
          }
        />
        {hook.rejected_count > 0 && (
          <>
            <Divider />
            <InfoRow
              label={t("connWebhookRejected")}
              value={t("connWebhookRejectedSummary", {
                count: hook.rejected_count,
                code: hook.last_rejected_code,
              })}
            />
          </>
        )}
        <Divider />
        <NavRow
          testID="webhook-journal"
          icon={History}
          label={t("connWebhookJournal")}
          onPress={() => setJournal(true)}
        />
      </SettingsGroup>

      <SettingsGroup title={t("connEdit")}>
        <GroupBody>
          <TextField
            testID="webhook-name"
            label={t("connWebhookName")}
            maxLength={120}
            value={name}
            onChangeText={setName}
          />
          <TextField
            label={t("connWebhookDescription")}
            multiline
            maxLength={500}
            value={description}
            onChangeText={setDescription}
          />
          <RateField value={rate} onChange={setRate} />
        </GroupBody>
      </SettingsGroup>
      <Button
        testID="webhook-update"
        label={t("connSave")}
        pending={busy === "save"}
        disabled={!dirty || !valid || busy !== null}
        onPress={() => void save()}
      />
      <SettingsGroup
        hint={
          hook.trigger_count > 0 ? t("connWebhookDeleteBlocked") : undefined
        }
      >
        <ActionRow
          testID="webhook-delete"
          tone="danger"
          label={t("connWebhookDelete")}
          pending={busy === "delete"}
          disabled={busy !== null || hook.trigger_count > 0}
          onPress={remove}
        />
      </SettingsGroup>
      {journal && (
        <JournalSheet hook={hook} onClose={() => setJournal(false)} />
      )}
    </View>
  );
}

function JournalSheet({
  hook,
  onClose,
}: {
  hook: IntegrationWebhook;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const theme = useTheme();
  const deliveries = useQuery({
    queryKey: ["integration-webhook-deliveries", hook.id],
    queryFn: () => api.integrationWebhookDeliveries(hook.id),
  });
  const items = deliveries.data ?? [];
  return (
    <PageSheet
      visible
      testID="webhook-journal-sheet"
      title={t("connWebhookJournalTitle", { name: hook.name })}
      onClose={onClose}
    >
      <ScrollView contentContainerStyle={settingsContent}>
        {deliveries.isError && deliveries.data === undefined ? (
          <Notice
            title={errorText(deliveries.error, "webhook")}
            actionLabel={t("retry")}
            onAction={() => void deliveries.refetch()}
          />
        ) : deliveries.isPending ? null : items.length === 0 ? (
          <Notice tone="neutral" title={t("connWebhookJournalEmpty")} />
        ) : (
          <SettingsGroup>
            {items.map((delivery, index) => (
              <View key={delivery.id}>
                {index > 0 && <Divider />}
                <View style={styles.delivery} accessible>
                  <View style={styles.deliveryHead}>
                    <Text
                      weight="semibold"
                      size={14}
                      style={{
                        color:
                          delivery.status === "accepted"
                            ? theme.successText
                            : theme.danger,
                      }}
                    >
                      {t(`connDelivery_${delivery.status}`)}
                    </Text>
                    <Text tone="muted" size={13}>
                      {dateTime(delivery.received_at)}
                    </Text>
                  </View>
                  <Text size={14}>
                    {[
                      delivery.event_type || "—",
                      delivery.status === "accepted"
                        ? t("connWebhookRuns", { count: delivery.runs_created })
                        : delivery.error_code,
                    ].join(" · ")}
                  </Text>
                </View>
              </View>
            ))}
          </SettingsGroup>
        )}
      </ScrollView>
    </PageSheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[5] },
  delivery: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
  },
  deliveryHead: { flexDirection: "row", justifyContent: "space-between" },
});
