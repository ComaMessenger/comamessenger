import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerAPI,
  OrganizationSettings,
  UpdateOrganizationSettingsRequest,
} from "@comamessenger/core";

export function useOrganizationDraft(api: MessengerAPI, enabled: boolean) {
  const query = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => api.organization(),
    enabled,
  });
  const [draft, setDraft] = useState<OrganizationSettings | null>(null);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  return { query, draft, setDraft };
}

export function organizationUpdate(
  value: OrganizationSettings,
): UpdateOrganizationSettingsRequest {
  return {
    name: value.name,
    slug: value.slug,
    expected_version: value.version,
    invitation_default_role: value.invitation_default_role,
    invitation_ttl_hours: value.invitation_ttl_hours,
    allow_public_chat_creation: value.allow_public_chat_creation,
    allow_channel_creation: value.allow_channel_creation,
    accent_color: value.accent_color,
  };
}

export function useDraftReconciler(
  setDraft: Dispatch<SetStateAction<OrganizationSettings | null>>,
  fingerprint: (value: OrganizationSettings) => string,
) {
  return useCallback(
    (updated: OrganizationSettings, snapshot: OrganizationSettings) => {
      setDraft((current) =>
        current && fingerprint(current) !== fingerprint(snapshot)
          ? { ...current, version: updated.version }
          : updated,
      );
    },
    [fingerprint, setDraft],
  );
}
