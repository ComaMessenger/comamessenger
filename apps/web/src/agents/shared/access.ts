import type { User } from "@comamessenger/core";
import { hasPermission } from "../../settings/registry";

export type AgentAccess = {
  canBuild: boolean;
  canPublish: boolean;
  canApprove: boolean;
  canObserve: boolean;
  canIntegrate: boolean;
  /** knowledge.manage: may create collections in the Knowledge base. */
  canManageKnowledge: boolean;
  /** Any agent permission opens the platform. */
  allowed: boolean;
};

export function agentAccess(user: User): AgentAccess {
  const canBuild = hasPermission(user, "agents.build");
  const canPublish = hasPermission(user, "agents.publish");
  const canApprove = hasPermission(user, "agents.approve");
  const canObserve = hasPermission(user, "agents.observe");
  const canIntegrate = hasPermission(user, "integrations.manage");
  return {
    canBuild,
    canPublish,
    canApprove,
    canObserve,
    canIntegrate,
    canManageKnowledge: hasPermission(user, "knowledge.manage"),
    allowed: canBuild || canPublish || canApprove || canObserve || canIntegrate,
  };
}
