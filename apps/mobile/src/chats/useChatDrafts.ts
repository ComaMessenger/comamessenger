import { useEffect, useState } from "react";
import { draftStorage } from "@/lib/database";
import { subscribeDrafts } from "@/lib/drafts";

/** Unsent composer text by chat, kept current while the list is mounted. */
export function useChatDrafts(): Record<string, string> {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const load = () =>
      void draftStorage
        .chatDrafts()
        .then((next) => {
          if (active) setDrafts(next);
        })
        .catch(() => undefined);
    load();
    const unsubscribe = subscribeDrafts(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return drafts;
}
