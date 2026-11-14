import { View } from "react-native";
import { router } from "expo-router";
import { Cable, Plus, Webhook } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Notice } from "@/ui/Notice";
import {
  ActionRow,
  Divider,
  GroupBody,
  NavRow,
  SettingsGroup,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import {
  healthText,
  useConnectionsAccess,
  useMcpConnections,
  useWebhooks,
} from "./data";

function host(endpoint: string) {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(endpoint)?.[1] ?? endpoint;
}

/**
 * «Настройки → Интеграции»: MCP connections of external systems, signed
 * incoming webhooks (administrators only) and where spreadsheets go.
 */
export function IntegrationsScreen() {
  const { t } = useTranslation();
  const access = useConnectionsAccess();
  const mcp = useMcpConnections();
  const webhooks = useWebhooks();
  const connections = mcp.data ?? [];
  const hooks = webhooks.data ?? [];
  return (
    <SettingsScreen
      title={t("connIntegrations")}
      testID="connections-integrations"
      allowed={access.viewIntegrations}
      query={access.manage ? [mcp, webhooks] : mcp}
    >
      <Text tone="muted" size={14}>
        {t("connIntegrationsLead")}
      </Text>
      <SettingsGroup title={t("connMcpTitle")} hint={t("connMcpHint")}>
        {connections.length === 0 ? (
          <GroupBody>
            <Notice
              tone="neutral"
              title={t("connMcpEmpty")}
              hint={t("connTablesHint")}
            />
          </GroupBody>
        ) : (
          connections.map((item, index) => (
            <View key={item.id}>
              {index > 0 && <Divider />}
              <NavRow
                testID={`mcp-${item.name}`}
                icon={Cable}
                label={item.name}
                hint={item.description || host(item.endpoint_url)}
                value={healthText(item)}
                onPress={() =>
                  router.push(
                    `/settings/connections/integrations/mcp/${item.id}`,
                  )
                }
              />
            </View>
          ))
        )}
        {access.manage && (
          <>
            <Divider />
            <ActionRow
              testID="mcp-add"
              icon={Plus}
              label={t("connMcpAdd")}
              onPress={() =>
                router.push("/settings/connections/integrations/mcp/new")
              }
            />
          </>
        )}
      </SettingsGroup>

      {access.manage && (
        <SettingsGroup
          title={t("connWebhooksTitle")}
          hint={t("connWebhooksHint")}
        >
          {hooks.length === 0 ? (
            <GroupBody>
              <Notice tone="neutral" title={t("connWebhooksEmpty")} />
            </GroupBody>
          ) : (
            hooks.map((item, index) => (
              <View key={item.id}>
                {index > 0 && <Divider />}
                <NavRow
                  testID={`webhook-${item.name}`}
                  icon={Webhook}
                  label={item.name}
                  hint={item.description || undefined}
                  value={item.enabled ? t("connEnabled") : t("connDisabled")}
                  onPress={() =>
                    router.push(
                      `/settings/connections/integrations/webhooks/${item.id}`,
                    )
                  }
                />
              </View>
            ))
          )}
          <Divider />
          <ActionRow
            testID="webhook-add"
            icon={Plus}
            label={t("connWebhookAdd")}
            onPress={() =>
              router.push("/settings/connections/integrations/webhooks/new")
            }
          />
        </SettingsGroup>
      )}

      {connections.length > 0 && (
        <SettingsGroup title={t("connTablesTitle")}>
          <GroupBody>
            <Text tone="muted" size={14}>
              {t("connTablesHint")}
            </Text>
          </GroupBody>
        </SettingsGroup>
      )}
    </SettingsScreen>
  );
}
