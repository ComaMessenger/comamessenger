import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  chatTaskSections,
  type ChatMember,
  type TaskViewer,
} from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useNow } from "@/scheduled/clock";
import { SmallButton } from "@/requests/parts";
import { TaskRow, type TaskRowMessage } from "./TaskRow";

/**
 * The tasks of the chat under the slot (decision 18, prototype `.drop`):
 * «На вас» with a red line, then «Остальные»; «Все задачи чата» and
 * «+ Задача» at the bottom. A tap on a row leads to its card in the feed.
 * Drawn over the feed under a dim that folds it back.
 */
export function ChatTasksDrop({
  tasks,
  viewer,
  members,
  canCreate,
  onOpenTask,
  onAll,
  onNew,
  onClose,
  onNotice,
}: {
  tasks: readonly TaskRowMessage[];
  viewer: TaskViewer;
  members: readonly ChatMember[];
  canCreate: boolean;
  onOpenTask(messageID: string): void;
  onAll(): void;
  onNew(): void;
  onClose(): void;
  onNotice?(text: string): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const now = useNow(60_000);
  const { mine, others } = chatTaskSections(tasks, viewer, now);
  return (
    <View style={StyleSheet.absoluteFill} testID="chat-tasks-drop">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("taskListClose")}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
      />
      <View
        accessibilityViewIsModal
        accessibilityLabel={t("taskListTitle")}
        style={[
          styles.drop,
          { backgroundColor: theme.surface, borderBottomColor: theme.border },
        ]}
      >
        <ScrollView style={styles.scroll} bounces={false}>
          {mine.length > 0 ? (
            <>
              <Text
                weight="semibold"
                size={12}
                style={[styles.section, { color: theme.danger }]}
              >
                {t("taskListMine", { count: mine.length }).toLocaleUpperCase()}
              </Text>
              {mine.map((row, index) => (
                <TaskRow
                  key={row.message.id}
                  testID={`drop-mine-${index}`}
                  message={row.message}
                  viewer={viewer}
                  members={members}
                  mine
                  onOpen={() => onOpenTask(row.message.id)}
                  onNotice={onNotice}
                />
              ))}
            </>
          ) : null}
          {others.length > 0 ? (
            <>
              <Text
                tone="muted"
                weight="semibold"
                size={12}
                style={styles.section}
              >
                {t("taskListOthers", {
                  count: others.length,
                }).toLocaleUpperCase()}
              </Text>
              {others.map((row, index) => (
                <TaskRow
                  key={row.message.id}
                  testID={`drop-other-${index}`}
                  message={row.message}
                  viewer={viewer}
                  members={members}
                  onOpen={() => onOpenTask(row.message.id)}
                  onNotice={onNotice}
                />
              ))}
            </>
          ) : null}
          {!mine.length && !others.length ? (
            <Text tone="muted" size={14} style={styles.empty}>
              {t("taskListEmpty")}
            </Text>
          ) : null}
        </ScrollView>
        <View style={styles.foot}>
          <View style={styles.grow}>
            <SmallButton
              testID="drop-all"
              label={t("taskListAll")}
              onPress={onAll}
            />
          </View>
          {canCreate ? (
            <View style={styles.grow}>
              <SmallButton
                testID="drop-new"
                variant="primary"
                icon={<Plus size={15} color={theme.onPrimary} />}
                label={t("taskListNew")}
                onPress={onNew}
              />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype `.drop`: max 400 high, rounded bottom corners, a shadow.
  drop: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  scroll: { maxHeight: 400 },
  // `.tsec`: 12px, 600, uppercase, padding 12px 16px 7px.
  section: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 7 },
  empty: { textAlign: "center", padding: 20 },
  // `.dfoot`: gap 8px, padding 10px 14px 12px.
  foot: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
  },
  grow: { flex: 1 },
});
