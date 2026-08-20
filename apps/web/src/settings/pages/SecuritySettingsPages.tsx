import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, Session, User } from "@comamessenger/core";
import { History, KeyRound, MonitorSmartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Badge, Button } from "../../ui";
import {
  SettingsAccessDenied,
  SettingsSection,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { canAccessSettingsPage } from "../registry";

export function SecuritySettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
  });
  const [message, setMessage] = useState("");
  const [revokedIDs, setRevokedIDs] = useState<Set<string>>(() => new Set());
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  async function revoke(session: Session) {
    setPendingSession(session.id);
    try {
      await api.revokeSession(session.id);
      setRevokedIDs((current) => new Set(current).add(session.id));
      await query.refetch();
      setMessage(t("sessionRevoked"));
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setPendingSession(null);
    }
  }
  async function revokeOthers() {
    setPendingSession("others");
    try {
      await api.revokeOtherSessions();
      setRevokedIDs((current) => {
        const next = new Set(current);
        for (const session of query.data ?? [])
          if (!session.current) next.add(session.id);
        return next;
      });
      await query.refetch();
      setMessage(t("otherSessionsRevoked"));
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setPendingSession(null);
    }
  }
  const activeSessions = (query.data ?? []).filter(
    (session) =>
      !session.revoked_at &&
      !revokedIDs.has(session.id) &&
      Date.parse(session.expires_at) > Date.now(),
  );
  return (
    <SettingsShell
      user={user}
      active="security"
      title={t("securitySettings")}
      navigate={navigate}
    >
      <div className="settings-page__body">
        <SettingsSection
          title={t("activeSessions")}
          description={t("activeSessionsHint")}
          icon={<MonitorSmartphone />}
        >
          <div className="session-list">
            {activeSessions.map((session) => (
              <article key={session.id} className="session-card">
                <MonitorSmartphone />
                <span>
                  <strong>
                    {session.current
                      ? t("currentSession")
                      : session.user_agent || t("unknownDevice")}
                  </strong>
                  <small>
                    {new Date(session.last_seen_at).toLocaleString()} ·{" "}
                    {session.ip_address || t("unknownAddress")}
                  </small>
                </span>
                {session.current ? (
                  <Badge tone="primary">{t("current")}</Badge>
                ) : (
                  <Button
                    size="sm"
                    disabled={pendingSession !== null}
                    onClick={() => void revoke(session)}
                  >
                    {t("revoke")}
                  </Button>
                )}
              </article>
            ))}
          </div>
          <Button
            disabled={
              pendingSession !== null ||
              activeSessions.every((session) => session.current)
            }
            onClick={() => void revokeOthers()}
          >
            <KeyRound />
            {t("logoutOtherDevices")}
          </Button>
        </SettingsSection>
        <span className="settings-success">{message}</span>
      </div>
    </SettingsShell>
  );
}

export function AuditSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "audit");
  const query = useQuery({
    queryKey: ["organization-audit"],
    queryFn: () => api.organizationAudit(),
    enabled: allowed,
  });
  return (
    <SettingsShell
      user={user}
      active="audit"
      title={t("auditSettings")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : (
        <div className="settings-page__body">
          <SettingsSection
            title={t("auditLog")}
            description={t("auditLogHint")}
            icon={<History />}
          >
            <div className="audit-list">
              {(query.data?.events ?? []).map((entry) => (
                <article key={entry.id}>
                  <span>
                    <strong>{entry.action}</strong>
                    <small>
                      {entry.actor_name || t("systemActor")} ·{" "}
                      {entry.target_type}
                    </small>
                  </span>
                  <time>{new Date(entry.created_at).toLocaleString()}</time>
                </article>
              ))}
            </div>
          </SettingsSection>
        </div>
      )}
    </SettingsShell>
  );
}
