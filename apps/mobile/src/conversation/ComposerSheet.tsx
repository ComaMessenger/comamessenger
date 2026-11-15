import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import * as LegacyLibrary from "expo-media-library/legacy";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  Camera,
  ChartNoAxesColumn,
  FileText,
  Image as ImageIcon,
  MessageCircleCheck,
  Sparkles,
  SquareCheck,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type {
  ComposerMenuGroup,
  ComposerMenuItemID,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Text } from "@/ui/Text";
import type { LocalFile } from "@/files/upload";
import { recentPhotoPlan } from "@/files/recentPhoto";

const icons: Record<ComposerMenuItemID, LucideIcon> = {
  photo: ImageIcon,
  camera: Camera,
  file: FileText,
  markdownFile: FileText,
  request: MessageCircleCheck,
  task: SquareCheck,
  poll: ChartNoAxesColumn,
  agent: Sparkles,
};

/** iOS cannot present a system picker while our sheet is still dismissing. */
const afterClose = Platform.OS === "ios" ? 400 : 0;

/**
 * The latest photos of the library, only when the person already let the
 * app read it: the app never asks for that here (the system picker needs
 * no permission), so without it the row is hidden.
 */
function useRecentPhotos(visible: boolean) {
  const [photos, setPhotos] = useState<LegacyLibrary.Asset[]>([]);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void (async () => {
      const permission = await MediaLibrary.getPermissionsAsync(false);
      if (!permission.granted || permission.accessPrivileges === "none") return;
      const page = await LegacyLibrary.getAssetsAsync({
        first: 4,
        mediaType: [LegacyLibrary.MediaType.photo],
        sortBy: [[LegacyLibrary.SortBy.creationTime, false]],
      });
      if (live) setPhotos(page.assets);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [visible]);
  return photos;
}

async function photoFile(asset: LegacyLibrary.Asset): Promise<LocalFile> {
  const info = await LegacyLibrary.getAssetInfoAsync(asset);
  const uri = info.localUri ?? asset.uri;
  const plan = recentPhotoPlan(asset.filename, `photo-${Date.now()}.jpg`);
  if (plan.reencode) {
    // Drawn upright with its real size, as the system picker hands it over.
    const image = await ImageManipulator.manipulate(uri).renderAsync();
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.9,
    });
    return {
      uri: saved.uri,
      name: plan.name,
      mime: plan.mime,
      size: new File(saved.uri).size,
      ...(saved.width > 0 && saved.height > 0
        ? { width: saved.width, height: saved.height }
        : {}),
    };
  }
  return {
    uri,
    name: plan.name,
    mime: plan.mime,
    size: new File(uri).size,
    ...(asset.width > 0 && asset.height > 0
      ? { width: asset.width, height: asset.height }
      : {}),
  };
}

/**
 * The «+» sheet of the composer, variant A of the prototype: the latest
 * photos and «Фото / Камера / Файл» on top, then «Попросить и поручить»
 * and «Агенты» as rows with a hint. The items and their rules come from
 * @comamessenger/core (composerMenu), shared with the web.
 */
export function ComposerSheet({
  visible,
  groups,
  onPick,
  onPhoto,
  onClose,
}: {
  visible: boolean;
  groups: ComposerMenuGroup[];
  onPick(id: ComposerMenuItemID): void;
  /** A photo from the row of latest ones. */
  onPhoto?(file: LocalFile): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const photos = useRecentPhotos(visible && Boolean(onPhoto));

  function choose(id: ComposerMenuItemID) {
    onClose();
    setTimeout(() => onPick(id), afterClose);
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      testID="composer-sheet"
      accessibilityLabel={t("composerMore")}
    >
      {photos.length > 0 && onPhoto ? (
        <View style={styles.photos}>
          {photos.map((asset) => (
            <Pressable
              key={asset.id}
              accessibilityRole="button"
              accessibilityLabel={t("composerRecentPhoto")}
              onPress={() => {
                onClose();
                void photoFile(asset)
                  .then(onPhoto)
                  .catch(() => undefined);
              }}
              style={[styles.photo, { backgroundColor: theme.surfaceSelected }]}
            >
              <Image
                source={{ uri: asset.uri }}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
      {groups.map((group) =>
        group.id === "attachments" ? (
          <View key={group.id} style={styles.attachments}>
            {group.items.map((item) => {
              const Icon = icons[item.id];
              return (
                <Pressable
                  key={item.id}
                  testID={`composer-action-${item.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t(item.labelKey)}
                  onPress={() => choose(item.id)}
                  style={({ pressed }) => [
                    styles.attachment,
                    {
                      backgroundColor: pressed
                        ? theme.surfaceHover
                        : theme.surfaceSelected,
                    },
                  ]}
                >
                  <Icon size={22} color={theme.foreground} />
                  <Text size={13}>{t(item.labelKey)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View key={group.id}>
            {group.labelKey ? (
              <Text
                tone="muted"
                weight="semibold"
                size={12}
                style={styles.label}
                accessibilityRole="header"
              >
                {t(group.labelKey).toLocaleUpperCase()}
              </Text>
            ) : null}
            {group.items.map((item) => {
              const Icon = icons[item.id];
              const agent = group.id === "agents";
              return (
                <Pressable
                  key={item.id}
                  testID={`composer-action-${item.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t(item.labelKey)}
                  accessibilityHint={item.hintKey ? t(item.hintKey) : undefined}
                  onPress={() => choose(item.id)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <View
                    style={[
                      styles.rowIcon,
                      {
                        backgroundColor: agent
                          ? theme.avatarSurface4
                          : theme.primarySoft,
                      },
                    ]}
                  >
                    <Icon
                      size={22}
                      color={agent ? theme.avatarForeground4 : theme.primary}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text size={15.5} weight="semibold">
                      {t(item.labelKey)}
                    </Text>
                    {item.hintKey ? (
                      <Text tone="muted" size={13} style={styles.hint}>
                        {t(item.hintKey)}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ),
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  // Prototype `.ph`: four squares, gap 4, radius 10, 14 below.
  photos: { flexDirection: "row", gap: 4, marginBottom: 14 },
  photo: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  // Prototype `.att3`: three tiles, gap 8, radius 16, padding 12/10.
  attachments: { flexDirection: "row", gap: 8 },
  attachment: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: 16,
  },
  // Prototype `.lbl`: 12px 600 uppercase, margin 14px 0 7px.
  label: { marginTop: 14, marginBottom: 7, letterSpacing: 0.5 },
  // Prototype `.arow`: gap 12, padding 8px 4px, radius 14; icon 42/14.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 14,
  },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0 },
  hint: { lineHeight: 17 },
});
