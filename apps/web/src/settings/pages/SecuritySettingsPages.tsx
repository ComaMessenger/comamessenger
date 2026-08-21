import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, Session, User } from "@comamessenger/core";
import { History, KeyRound, MonitorSmartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Badge, Button, Field, SelectField } from "../../ui";
import {
  SettingsAccessDenied,
  SettingsSection,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { canAccessSettingsPage } from "../registry";
import { sessionLabel } from "../sessionLabel";
import { describeAudit } from "../auditDescriptions";

export function SecuritySettingsPage({
  api,
  user,
  navigate,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  onUserUpdated(user: User): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
    enabled: !user.must_change_password,
  });
  const [message, setMessage] = useState("");
  const [revokedIDs, setRevokedIDs] = useState<Set<string>>(() => new Set());
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailPending, setEmailPending] = useState(false);
  const confirmationStarted = useRef(false);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get(
      "email_token",
    );
    if (!token || confirmationStarted.current) return;
    confirmationStarted.current = true;
    setEmailPending(true);
    void api
      .confirmEmail({ token })
      .then((updated) => {
        onUserUpdated(updated);
        setMessage(t("emailChanged"));
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch((cause) => setMessage(messageOf(cause)))
      .finally(() => setEmailPending(false));
  }, [api, onUserUpdated, t]);
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
  async function changePassword() {
    if (!currentPassword || !newPassword || newPassword !== confirmPassword)
      return;
    setMessage("");
    setPasswordPending(true);
    try {
      await api.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      const updated = await api.me();
      onUserUpdated(updated);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await query.refetch();
      setMessage(t("passwordChanged"));
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setPasswordPending(false);
    }
  }
  async function changeEmail() {
    if (!newEmail || !emailPassword) return;
    setMessage("");
    setEmailPending(true);
    try {
      const result = await api.changeEmail({
        new_email: newEmail,
        current_password: emailPassword,
      });
      setNewEmail("");
      setEmailPassword("");
      if (result.user) {
        onUserUpdated(result.user);
        setMessage(t("emailChanged"));
      } else {
        setMessage(t("emailConfirmationSent"));
      }
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setEmailPending(false);
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
        {!user.must_change_password && (
          <SettingsSection title={t("changeEmail")} description={user.email}>
            <div className="settings-form-grid">
              <Field
                label={t("newEmail")}
                name="new-email"
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
              <Field
                label={t("currentPassword")}
                name="email-current-password"
                type="password"
                autoComplete="current-password"
                value={emailPassword}
                onChange={(event) => setEmailPassword(event.target.value)}
              />
            </div>
            <Button
              variant="primary"
              disabled={emailPending || !newEmail || !emailPassword}
              onClick={() => void changeEmail()}
            >
              {emailPending ? t("saving") : t("changeEmail")}
            </Button>
          </SettingsSection>
        )}
        <SettingsSection
          title={t("changePassword")}
          description={
            user.must_change_password
              ? t("passwordChangeRequiredHint")
              : t("changePasswordHint")
          }
          icon={<KeyRound />}
        >
          <div className="settings-form-grid">
            <Field
              label={t("currentPassword")}
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <Field
              label={t("newPassword")}
              name="new-password"
              type="password"
              minLength={10}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <Field
              label={t("confirmNewPassword")}
              name="confirm-new-password"
              type="password"
              minLength={10}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
          {confirmPassword && newPassword !== confirmPassword && (
            <small className="settings-error">{t("passwordsDoNotMatch")}</small>
          )}
          <Button
            variant="primary"
            disabled={
              passwordPending ||
              !currentPassword ||
              newPassword.length < 10 ||
              newPassword !== confirmPassword
            }
            onClick={() => void changePassword()}
          >
            <KeyRound />
            {passwordPending ? t("saving") : t("changePassword")}
          </Button>
        </SettingsSection>
        {!user.must_change_password && (
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
                        : sessionLabel(session.user_agent, t("unknownDevice"))}
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
        )}
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
  const { t, i18n } = useTranslation();
  const allowed = canAccessSettingsPage(user, "audit");
  const [category, setCategory] = useState("");
  const [actorID, setActorID] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [afterID, setAfterID] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ["organization-audit", category, actorID, from, to, afterID],
    queryFn: () =>
      api.organizationAudit({
        category: category || undefined,
        actor_id: actorID || undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        after_id: afterID || undefined,
      }),
    enabled: allowed,
    placeholderData: (previous) => previous,
  });
  const changeFilter = (change: () => void) => {
    change();
    setAfterID("");
    setHistory([]);
  };
  const actors = Array.from(
    new Map(
      (query.data?.events ?? [])
        .filter((entry) => entry.actor_id)
        .map((entry) => [
          entry.actor_id!,
          entry.actor_name || t("systemActor"),
        ]),
    ),
  );
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
            <div className="audit-filters">
              <SelectField
                label={t("auditCategory")}
                name="audit-category"
                value={category}
                onChange={(event) =>
                  changeFilter(() => setCategory(event.target.value))
                }
              >
                <option value="">{t("auditCategoryAll")}</option>
                {[
                  "organization",
                  "members",
                  "invitations",
                  "security",
                  "chats",
                  "infrastructure",
                ].map((value) => (
                  <option key={value} value={value}>
                    {t(`auditCategory_${value}`)}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={t("auditActor")}
                name="audit-actor"
                value={actorID}
                onChange={(event) =>
                  changeFilter(() => setActorID(event.target.value))
                }
              >
                <option value="">{t("auditActorAll")}</option>
                {actors.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </SelectField>
              <Field
                label={t("auditFrom")}
                name="audit-from"
                type="date"
                value={from}
                onChange={(event) =>
                  changeFilter(() => setFrom(event.target.value))
                }
              />
              <Field
                label={t("auditTo")}
                name="audit-to"
                type="date"
                value={to}
                onChange={(event) =>
                  changeFilter(() => setTo(event.target.value))
                }
              />
            </div>
            <div className="audit-list">
              {(query.data?.events ?? []).map((entry) => (
                <article key={entry.id}>
                  <span>
                    <strong>{describeAudit(entry, i18n.language)}</strong>
                    <small>
                      {t(`auditCategory_${entry.category}`)} ·{" "}
                      {entry.actor_role
                        ? t(
                            entry.actor_role === "owner"
                              ? "roleOwner"
                              : entry.actor_role === "admin"
                                ? "roleAdmin"
                                : "roleMember",
                          )
                        : t("systemActor")}
                    </small>
                  </span>
                  <time>{new Date(entry.created_at).toLocaleString()}</time>
                </article>
              ))}
            </div>
            {(query.data?.events.length ?? 0) === 0 && (
              <p className="settings-empty">{t("auditEmpty")}</p>
            )}
            <div className="audit-pagination">
              <Button
                size="sm"
                disabled={history.length === 0}
                onClick={() => {
                  const previous = [...history];
                  setAfterID(previous.pop() ?? "");
                  setHistory(previous);
                }}
              >
                {t("previousPage")}
              </Button>
              <Button
                size="sm"
                disabled={!query.data?.next_after_id}
                onClick={() => {
                  setHistory((value) => [...value, afterID]);
                  setAfterID(query.data?.next_after_id ?? "");
                }}
              >
                {t("nextPage")}
              </Button>
            </div>
          </SettingsSection>
        </div>
      )}
    </SettingsShell>
  );
}
