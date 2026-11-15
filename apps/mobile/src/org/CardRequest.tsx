import { useEffect, useState } from "react";
import { Alert } from "react-native";
import {
  type ChatMember,
  type OrgStructure,
  type RequestDraftAudience,
} from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useMessenger } from "@/messenger/MessengerProvider";
import { withCache } from "@/messenger/cache";
import { openDirectChat } from "@/people/openDirect";
import { RequestSheet } from "@/requests/RequestSheet";
import { useSignedIn } from "@/session/SessionProvider";
import { afterSheetCloses } from "@/ui/MenuSheet";
import { RequestChatPicker, type RequestChatChoice } from "./RequestChatPicker";

/**
 * «Запрос» of a department or a person card: first where to ask, then the
 * request form with the addressee already set (the department, or the one
 * person). A person without a direct chat gets one.
 */
export function CardRequest({
  visible,
  audience,
  structure,
  departmentChatID,
  onClose,
}: {
  visible: boolean;
  audience: RequestDraftAudience;
  structure: OrgStructure;
  departmentChatID?: string | null;
  onClose(): void;
}) {
  const { api } = useSignedIn();
  const { store, scheduleReload } = useMessenger();
  const [target, setTarget] = useState<{
    chatID: string;
    members: ChatMember[];
  } | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (visible) {
      setTarget(null);
      setPicking(true);
    }
  }, [visible]);

  async function pick(choice: RequestChatChoice) {
    setPicking(false);
    try {
      const chatID =
        choice.kind === "chat"
          ? choice.chat.id
          : await openDirectChat(api, store, choice.actorID);
      if (choice.kind === "direct") scheduleReload();
      const members =
        choice.kind === "chat"
          ? choice.members
          : await withCache(`members:${chatID}`, () => api.members(chatID));
      afterSheetCloses(() => setTarget({ chatID, members }));
    } catch (cause) {
      Alert.alert(messageOf(cause));
      onClose();
    }
  }

  return (
    <>
      <RequestChatPicker
        visible={visible && picking}
        audience={audience}
        structure={structure}
        departmentChatID={departmentChatID}
        onClose={() => {
          setPicking(false);
          onClose();
        }}
        onPick={(choice) => void pick(choice)}
      />
      {target ? (
        <RequestSheet
          visible={visible && !picking}
          chatID={target.chatID}
          members={target.members}
          audience={audience}
          onClose={() => {
            setTarget(null);
            onClose();
          }}
          onNotice={(text) => Alert.alert(text)}
        />
      ) : null}
    </>
  );
}
