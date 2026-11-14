import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  organizationFingerprint,
  organizationUpdate,
  reconcileOrganizationDraft,
  type OrganizationSettings,
} from "@comamessenger/core";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { useAutosave } from "./useAutosave";

export const organizationKey = ["organization-settings"] as const;

/** Workspace settings and an editable copy of them. */
export function useOrganizationDraft(enabled: boolean) {
  const { api } = useSignedIn();
  const query = useQuery({
    queryKey: organizationKey,
    queryFn: () => api.organization(),
    enabled,
  });
  const [draft, setDraft] = useState<OrganizationSettings | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);
  return { query, draft, setDraft };
}

/**
 * Autosave of the given workspace fields, as on the web: the whole settings
 * object goes with its version; edits made during a save survive it. A
 * changed name or accent refreshes the public branding the app shows.
 */
export function useOrganizationAutosave(
  fields: readonly (keyof OrganizationSettings)[],
  enabled: boolean,
  /** An invalid draft is held back until it is valid again. */
  valid: (value: OrganizationSettings) => boolean = () => true,
) {
  const { api } = useSignedIn();
  const { refreshBranding, updateUser } = useSession();
  const queryClient = useQueryClient();
  const { query, draft, setDraft } = useOrganizationDraft(enabled);
  const [fingerprint] = useState(() => organizationFingerprint(fields));
  const onSaved = useCallback(
    (updated: OrganizationSettings, snapshot: OrganizationSettings) => {
      setDraft((current) =>
        reconcileOrganizationDraft(current, updated, snapshot, fingerprint),
      );
      queryClient.setQueryData(organizationKey, updated);
      if (fields.includes("name") || fields.includes("accent_color")) {
        refreshBranding();
        void api
          .me()
          .then(updateUser)
          .catch(() => undefined);
      }
    },
    [
      api,
      fields,
      fingerprint,
      queryClient,
      refreshBranding,
      setDraft,
      updateUser,
    ],
  );
  const autosave = useAutosave({
    value: enabled && draft && valid(draft) ? draft : null,
    fingerprint,
    save: (snapshot) => api.updateOrganization(organizationUpdate(snapshot)),
    onSaved,
  });
  return { query, draft, setDraft, autosave };
}
