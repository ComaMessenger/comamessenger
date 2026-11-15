import { useMessenger } from "../shell/MessengerContext";
import type { OrgStructure } from "@comamessenger/core";
import { useOrgAvailable, useOrgStructure } from "./useOrg";

/**
 * The structure for @department in a composer: null on servers without
 * org_structure, so department tokens stay plain mentions there.
 */
export function useMentionStructure(): OrgStructure | null {
  const { api } = useMessenger();
  const available = useOrgAvailable();
  const org = useOrgStructure(api);
  return available ? (org.data ?? null) : null;
}

// "N people notified" is shown to the author only and only in this
// session of the feed: messages with departments sent from this tab.
const sentWithDepartments = new Set<string>();

export function noteDepartmentSend(
  clientMsgID: string,
  departmentIDs: readonly string[] | undefined,
) {
  if (departmentIDs?.length) sentWithDepartments.add(clientMsgID);
}

export function sentWithDepartmentsHere(clientMsgID: string | undefined) {
  return Boolean(clientMsgID && sentWithDepartments.has(clientMsgID));
}
