import { useCallback, useRef, useState } from "react";
import { Alert, Platform, type GestureResponderEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { Clock } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  resolvedMentionActorIDs,
  scheduledMobile,
  type ChatMember,
  type CreateScheduledMessageRequest,
} from "@comamessenger/core";
import type { ComposerAction } from "@/conversation/ComposerSheet";
import { useWhen } from "./clock";
import { ScheduleSheet } from "./ScheduleSheet";
import { SendOptionsMenu, type SendMode } from "./SendOptionsMenu";
import { scheduledErrorKey, useScheduledActions } from "./useScheduled";

/** What the composer holds right now. */
export type ComposerDraft = {
  /** Encoded body with structured mentions. */
  body: string;
  replyToID?: string;
  fileIDs: string[];
  /** Files still uploading: nothing can be sent or scheduled yet. */
  uploading: boolean;
};

const noop = () => undefined;

/**
 * Sending later and without sound from the composer: the long press menu on
 * the send button, the «Schedule» tile of the "+" sheet and the time sheet.
 * The draft is cleared only after the server accepted the message, so
 * nothing typed is lost offline; a repeated attempt of the same request
 * reuses its idempotency key and cannot schedule it twice.
 */
export function useScheduleComposer({
  chatID,
  threadRootID,
  members,
  draft,
  onScheduled,
  onSilent,
  onNotice,
}: {
  chatID: string;
  threadRootID: string | null;
  members: ChatMember[];
  draft(): ComposerDraft;
  /** The server accepted it: clear the composer and say when it goes. */
  onScheduled(notice: string): void;
  /** «Send without sound»: the ordinary send with the quiet flag. */
  onSilent(): void;
  onNotice(text: string): void;
}) {
  const { t } = useTranslation();
  const when = useWhen();
  const { create } = useScheduledActions(noop);
  const [menuAnchor, setMenuAnchor] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);

  const ready = useCallback(() => {
    const current = draft();
    return (
      !current.uploading &&
      (Boolean(current.body.trim()) || current.fileIDs.length > 0)
    );
  }, [draft]);

  /** Long press on the send button. */
  const openOptions = useCallback(
    (event?: GestureResponderEvent) => {
      if (!ready()) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setMenuAnchor(event?.nativeEvent?.pageY ?? null);
      setMenuOpen(true);
    },
    [ready],
  );

  const openSheet = useCallback(() => {
    if (!ready()) {
      onNotice(t("scheduledEmptyDraft"));
      return;
    }
    setSheetOpen(true);
  }, [onNotice, ready, t]);

  const pick = useCallback(
    (mode: SendMode) => {
      setMenuOpen(false);
      if (mode === "silent") {
        onSilent();
        return;
      }
      // iOS cannot present a second modal while the menu is still fading out.
      setTimeout(() => setSheetOpen(true), Platform.OS === "ios" ? 350 : 0);
    },
    [onSilent],
  );

  const schedule = useCallback(
    async (at: Date) => {
      if (pendingRef.current) return;
      const current = draft();
      const body = current.body.trim();
      if ((!body && !current.fileIDs.length) || current.uploading) {
        setSheetOpen(false);
        onNotice(t("scheduledEmptyDraft"));
        return;
      }
      const request: Omit<CreateScheduledMessageRequest, "client_msg_id"> = {
        body,
        body_format: "markdown",
        send_at: at.toISOString(),
        ...(current.replyToID ? { reply_to_id: current.replyToID } : {}),
        ...(threadRootID ? { thread_root_id: threadRootID } : {}),
        ...(current.fileIDs.length ? { file_ids: current.fileIDs } : {}),
        // @here means who is online when it is sent; that is unknown now.
        mentioned_actor_ids: resolvedMentionActorIDs(body, members, {}),
      };
      const signature = scheduledMobile.requestSignature(request);
      const clientMsgID =
        attempt.current?.signature === signature
          ? attempt.current.id
          : crypto.randomUUID();
      attempt.current = { signature, id: clientMsgID };
      pendingRef.current = true;
      setPending(true);
      try {
        await create(chatID, { ...request, client_msg_id: clientMsgID });
        attempt.current = null;
        setSheetOpen(false);
        onScheduled(t("scheduledCreated", { when: when(at, new Date()) }));
      } catch (cause) {
        Alert.alert(
          t(
            scheduledErrorKey(scheduledMobile.errorKind(cause), {
              composing: true,
            }),
          ),
        );
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      chatID,
      create,
      draft,
      members,
      onNotice,
      onScheduled,
      t,
      threadRootID,
      when,
    ],
  );

  /** The tile of the "+" sheet. */
  const action: ComposerAction = {
    key: "schedule",
    label: t("scheduledAction"),
    icon: Clock,
    accent: true,
    onPress: openSheet,
  };

  const layer = (
    <>
      <SendOptionsMenu
        visible={menuOpen}
        anchorY={menuAnchor}
        onPick={pick}
        onClose={() => setMenuOpen(false)}
      />
      <ScheduleSheet
        visible={sheetOpen}
        title={t("scheduledSendLater")}
        pending={pending}
        onConfirm={(at) => void schedule(at)}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );

  return { openOptions, action, layer };
}
