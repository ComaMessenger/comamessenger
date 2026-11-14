import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  reconcileOrganizationDraft,
  type MessengerAPI,
  type OrganizationSettings,
} from "@comamessenger/core";

export { organizationUpdate } from "@comamessenger/core";

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

export function useDraftReconciler(
  setDraft: Dispatch<SetStateAction<OrganizationSettings | null>>,
  fingerprint: (value: OrganizationSettings) => string,
) {
  return useCallback(
    (updated: OrganizationSettings, snapshot: OrganizationSettings) => {
      setDraft((current) =>
        reconcileOrganizationDraft(current, updated, snapshot, fingerprint),
      );
    },
    [fingerprint, setDraft],
  );
}
