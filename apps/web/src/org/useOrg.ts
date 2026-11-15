import { useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  APIError,
  createMessengerStore,
  fetchOrgStructure,
  orgKeys,
  orgStructureAvailable,
  uniquePeople,
  type ActorSummary,
  type MessengerAPI,
  type OrgStructure,
} from "@comamessenger/core";
import { MessengerContext } from "../shell/MessengerContext";
import i18n from "../i18n";

// Settings pages also render without the messenger context (tests): an
// empty store keeps the hook order the same and announces no features.
const emptyStore = createMessengerStore();
const noFeatures: readonly string[] = [];

/** HelloFrame.features of the current connection; empty before hello. */
export function useServerFeatures(): readonly string[] {
  const context = useContext(MessengerContext);
  const features = useStore(
    context?.store ?? emptyStore,
    (state) => state.features,
  );
  return context ? features : noFeatures;
}

/** The server announced org_structure: show everything of wave 2. */
export function useOrgAvailable(): boolean {
  return orgStructureAvailable(useServerFeatures());
}

/**
 * GET /org kept in the query cache under orgKeys.all. The cached version
 * goes as If-None-Match, so a 304 keeps the same object and memoised views
 * stay. Read only on servers announcing org_structure.
 */
export function useOrgStructure(api: MessengerAPI, enabled = true) {
  const available = useOrgAvailable();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: orgKeys.all,
    queryFn: () =>
      fetchOrgStructure(
        api,
        queryClient.getQueryData<OrgStructure>(orgKeys.all),
      ),
    enabled: available && enabled,
    // Screens read it again when opened (decision on lost events).
    staleTime: 5_000,
  });
}

/** After a write: read the structure again (304 when nothing changed). */
export function useOrgRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orgKeys.all });
}

export const allActorsKey = ["actors", "all"] as const;

/**
 * Every person and agent of the workspace, all pages read. The org screens
 * need everyone at once (groups, counts, cards); a pilot space has dozens of
 * people.
 */
export function useAllActors(api: MessengerAPI, enabled = true) {
  return useQuery({
    queryKey: allActorsKey,
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const actors: ActorSummary[] = [];
      let after = "";
      for (let page = 0; page < 50; page += 1) {
        const result = await api.actors("", after);
        actors.push(...result.actors);
        if (!result.next_after_id) break;
        after = result.next_after_id;
      }
      return uniquePeople(actors);
    },
  });
}

/** id → person, for names in cards and the tree. */
export function useActorMap(actors: readonly ActorSummary[] | undefined) {
  return useMemo(
    () => new Map((actors ?? []).map((actor) => [actor.actor_id, actor])),
    [actors],
  );
}

/** The text of an org write error: the specific codes, else the generic one. */
export function orgErrorText(cause: unknown): string {
  if (cause instanceof APIError) {
    const keys: Record<string, string> = {
      org_name_taken: "orgErrorNameTaken",
      org_cycle: "orgErrorCycle",
      org_depth_exceeded: "orgErrorDepth",
      org_limit_reached: "orgErrorLimit",
      org_version_conflict: "orgErrorConflict",
      department_not_found: "orgErrorDepartmentGone",
      position_not_found: "orgErrorPositionGone",
      department_chat_exists: "orgErrorChatExists",
      department_chat_invalid: "orgErrorChatInvalid",
      org_invalid: "orgErrorInvalid",
      rate_limited: "errorRateLimited",
      forbidden: "orgErrorForbidden",
    };
    const key = keys[cause.code];
    if (key) return i18n.t(key);
    if (cause.status === 403) return i18n.t("orgErrorForbidden");
    if (cause.status === 501) return i18n.t("orgErrorUnavailable");
  }
  return cause instanceof Error && cause.message
    ? cause.message
    : i18n.t("errorNetwork");
}

/**
 * Hand-off from a card's "Edit" to the settings page: the department to
 * open there. Read once by WorkspaceOrgPage.
 */
let pendingEditor: string | null = null;
export function openOrgEditor(departmentID: string | null) {
  pendingEditor = departmentID;
}
export function takeOrgEditor(): string | null {
  const value = pendingEditor;
  pendingEditor = null;
  return value;
}
