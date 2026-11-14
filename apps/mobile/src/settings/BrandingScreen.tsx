import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ImageIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  canAccessSettingsPage,
  organizationFields,
  validHexColor,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { pickSquareImage, uploadImage, ImageTooLarge } from "@/files/images";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { ActionRow, Divider, GroupBody, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { AutosaveStatus } from "./AutosaveStatus";
import { SettingsScreen } from "./SettingsScreen";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { useOrganizationAutosave } from "./organization";

/** The server keeps branding images up to 512 KB. */
const brandingMaxBytes = 512 * 1024;

/** Accent presets: the brand blue and the folder palette of the tokens. */
const presets = [
  "#174586",
  "#2F6FCA",
  "#7456C9",
  "#2B7754",
  "#AC5A25",
  "#AE457B",
  "#227770",
  "#C43245",
];

type Asset = "logo" | "favicon";

/**
 * Workspace look: logo, favicon and accent colour. Images are picked on the
 * phone, cropped square and scaled down to fit the server's limit.
 */
export function BrandingScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { refreshBranding } = useSession();
  const allowed = canAccessSettingsPage(user, "customization");
  const { query, draft, setDraft, autosave } = useOrganizationAutosave(
    organizationFields.branding,
    allowed,
    (value) => validHexColor(value.accent_color),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(() => Date.now());

  async function upload(kind: Asset) {
    setBusy(kind);
    try {
      const image = await pickSquareImage({
        maxSide: kind === "logo" ? 512 : 64,
        png: kind === "favicon",
      });
      if (!image) return;
      await uploadImage(
        api,
        `/api/v1/organization/branding/${kind}`,
        image,
        brandingMaxBytes,
      );
      await done();
      Alert.alert(t("assetSaved"));
    } catch (cause) {
      Alert.alert(
        cause instanceof ImageTooLarge
          ? t("brandingTooLarge")
          : messageOf(cause),
      );
    } finally {
      setBusy(null);
    }
  }

  function remove(kind: Asset) {
    Alert.alert(
      t(kind === "logo" ? "removeLogoConfirm" : "removeFaviconConfirm"),
      undefined,
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("remove"),
          style: "destructive",
          onPress: () => {
            setBusy(`${kind}-remove`);
            void api
              .deleteBrandingAsset(kind)
              .then(done)
              .catch((cause) => Alert.alert(messageOf(cause)))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  async function done() {
    setVersion(Date.now());
    await query.refetch();
    refreshBranding();
  }

  const accentValid = draft ? validHexColor(draft.accent_color) : true;
  return (
    <SettingsScreen
      title={t("branding")}
      allowed={allowed}
      query={query}
      testID="settings-branding-screen"
    >
      {draft && (
        <>
          <AutosaveStatus {...autosave} onRetry={autosave.retry} />
          {(["logo", "favicon"] as const).map((kind) => {
            const present =
              kind === "logo" ? draft.has_logo : draft.has_favicon;
            return (
              <SettingsGroup
                key={kind}
                title={t(
                  kind === "logo" ? "workspaceLogo" : "workspaceFavicon",
                )}
                hint={t(
                  kind === "logo"
                    ? "workspaceLogoHint"
                    : "workspaceFaviconHint",
                )}
              >
                <View style={styles.asset}>
                  <View
                    style={[
                      styles.preview,
                      {
                        backgroundColor: theme.surfaceSelected,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    {present ? (
                      <Image
                        testID={`branding-${kind}-image`}
                        accessibilityLabel={t(
                          kind === "logo"
                            ? "workspaceLogo"
                            : "workspaceFavicon",
                        )}
                        source={{
                          uri: `${api.apiURL}/api/v1/branding/${kind}?v=${version}`,
                        }}
                        style={styles.image}
                        contentFit="contain"
                      />
                    ) : (
                      <ImageIcon size={28} color={theme.subtle} />
                    )}
                  </View>
                  <Text tone="muted" size={14} style={styles.grow}>
                    {present ? t("assetPresent") : t("assetMissing")}
                  </Text>
                </View>
                <Divider />
                <ActionRow
                  testID={`branding-${kind}-upload`}
                  label={present ? t("replaceImage") : t("upload")}
                  pending={busy === kind}
                  disabled={busy !== null && busy !== kind}
                  onPress={() => void upload(kind)}
                />
                {present && (
                  <>
                    <Divider />
                    <ActionRow
                      testID={`branding-${kind}-remove`}
                      tone="danger"
                      label={t("remove")}
                      pending={busy === `${kind}-remove`}
                      disabled={busy !== null && busy !== `${kind}-remove`}
                      onPress={() => remove(kind)}
                    />
                  </>
                )}
              </SettingsGroup>
            );
          })}

          <SettingsGroup title={t("accentColor")} hint={t("accentColorHint")}>
            <GroupBody>
              <View
                style={styles.swatches}
                accessibilityRole="radiogroup"
                accessibilityLabel={t("accentColor")}
              >
                {presets.map((color) => {
                  const selected =
                    draft.accent_color.toUpperCase() === color.toUpperCase();
                  return (
                    <Pressable
                      key={color}
                      testID={`accent-${color.slice(1)}`}
                      accessibilityRole="radio"
                      accessibilityLabel={color}
                      accessibilityState={{ checked: selected }}
                      onPress={() =>
                        setDraft({ ...draft, accent_color: color })
                      }
                      style={[
                        styles.swatch,
                        {
                          backgroundColor: color,
                          borderColor: selected
                            ? theme.foreground
                            : "transparent",
                        },
                      ]}
                    />
                  );
                })}
              </View>
              <TextField
                testID="accent-hex"
                label={t("hexColor")}
                value={draft.accent_color}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={7}
                onChangeText={(value) =>
                  setDraft({
                    ...draft,
                    accent_color: (value.startsWith("#")
                      ? value
                      : `#${value}`
                    ).toUpperCase(),
                  })
                }
                error={accentValid ? undefined : t("fieldHexColor")}
              />
              <View
                style={[
                  styles.sample,
                  { backgroundColor: theme.surfaceSelected },
                ]}
              >
                <WorkspaceLogo name={user.organization_name} size={40} />
                <View
                  style={[
                    styles.sampleButton,
                    {
                      backgroundColor: accentValid
                        ? draft.accent_color
                        : theme.border,
                    },
                  ]}
                >
                  <Text weight="semibold" size={15} style={styles.onAccent}>
                    {t("previewAction")}
                  </Text>
                </View>
              </View>
            </GroupBody>
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  asset: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
  },
  preview: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  image: { width: 64, height: 64 },
  grow: { flex: 1 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: spacing[3] },
  swatch: { width: 40, height: 40, borderRadius: 20, borderWidth: 3 },
  sample: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.md,
  },
  sampleButton: {
    minHeight: 40,
    paddingHorizontal: spacing[4],
    borderRadius: radius.button,
    justifyContent: "center",
  },
  onAccent: { color: "#FFFFFF" },
});
