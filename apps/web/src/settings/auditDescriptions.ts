import type { AuditPage } from "@comamessenger/core";

export type AuditEntry = AuditPage["events"][number];

export const auditActions = [
  "organization.bootstrap",
  "organization.settings.update",
  "organization.branding.update",
  "organization.branding.delete",
  "organization.infrastructure.update",
  "organization.member.update",
  "organization.member.permissions.update",
  "organization.ownership.transfer",
  "invitation.create",
  "invitation.accept",
  "invitation.revoke",
  "invitation.rotate",
  "member.email.change",
  "member.email.change.request",
  "member.password.change",
  "member.password_change.require",
  "member.password_reset.issue",
  "member.password_reset.complete",
  "chat.create",
  "chat.update",
  "chat.archive",
  "chat.join",
  "chat.member.add",
  "chat.member.update",
  "chat.member.remove",
  "message.moderate.delete",
] as const;

const ru: Record<(typeof auditActions)[number], string> = {
  "organization.bootstrap": "создал(а) пространство",
  "organization.settings.update": "изменил(а) настройки пространства",
  "organization.branding.update": "обновил(а) оформление пространства",
  "organization.branding.delete": "удалил(а) элемент оформления",
  "organization.infrastructure.update": "обновил(а) подключения",
  "organization.member.update": "изменил(а) участника {{target}}",
  "organization.member.permissions.update":
    "изменил(а) права участника {{target}}",
  "organization.ownership.transfer":
    "передал(а) роль главного администратора {{target}}",
  "invitation.create": "создал(а) приглашение для {{target}}",
  "invitation.accept": "принял(а) приглашение",
  "invitation.revoke": "отозвал(а) приглашение для {{target}}",
  "invitation.rotate": "выпустил(а) новую ссылку для {{target}}",
  "member.email.change": "изменил(а) свой email",
  "member.email.change.request": "запросил(а) смену email",
  "member.password.change": "изменил(а) свой пароль",
  "member.password_change.require": "потребовал(а) сменить пароль у {{target}}",
  "member.password_reset.issue": "выпустил(а) сброс пароля для {{target}}",
  "member.password_reset.complete": "завершил(а) сброс пароля",
  "chat.create": "создал(а) чат {{target}}",
  "chat.update": "изменил(а) чат {{target}}",
  "chat.archive": "архивировал(а) чат {{target}}",
  "chat.join": "вступил(а) в чат {{target}}",
  "chat.member.add": "добавил(а) {{target}} в чат",
  "chat.member.update": "изменил(а) роль {{target}} в чате",
  "chat.member.remove": "удалил(а) {{target}} из чата",
  "message.moderate.delete": "удалил(а) чужое сообщение",
};

const en: Record<(typeof auditActions)[number], string> = {
  "organization.bootstrap": "created the workspace",
  "organization.settings.update": "changed workspace settings",
  "organization.branding.update": "updated workspace appearance",
  "organization.branding.delete": "removed an appearance asset",
  "organization.infrastructure.update": "updated connections",
  "organization.member.update": "changed member {{target}}",
  "organization.member.permissions.update":
    "changed permissions for {{target}}",
  "organization.ownership.transfer": "transferred ownership to {{target}}",
  "invitation.create": "created an invitation for {{target}}",
  "invitation.accept": "accepted an invitation",
  "invitation.revoke": "revoked the invitation for {{target}}",
  "invitation.rotate": "issued a new invitation link for {{target}}",
  "member.email.change": "changed their email",
  "member.email.change.request": "requested an email change",
  "member.password.change": "changed their password",
  "member.password_change.require":
    "required {{target}} to change their password",
  "member.password_reset.issue": "issued a password reset for {{target}}",
  "member.password_reset.complete": "completed a password reset",
  "chat.create": "created chat {{target}}",
  "chat.update": "changed chat {{target}}",
  "chat.archive": "archived chat {{target}}",
  "chat.join": "joined chat {{target}}",
  "chat.member.add": "added {{target}} to a chat",
  "chat.member.update": "changed {{target}}'s chat role",
  "chat.member.remove": "removed {{target}} from a chat",
  "message.moderate.delete": "deleted another member's message",
};

const fieldLabels: Record<string, { ru: string; en: string }> = {
  name: { ru: "Название", en: "Name" },
  slug: { ru: "Адрес", en: "Slug" },
  invitation_default_role: { ru: "Роль приглашения", en: "Invitation role" },
  invitation_ttl_hours: { ru: "Срок приглашения", en: "Invitation lifetime" },
  default_timezone: { ru: "Часовой пояс", en: "Time zone" },
  allow_member_invitations: {
    ru: "Приглашения участников",
    en: "Member invitations",
  },
  allow_public_chat_creation: { ru: "Публичные чаты", en: "Public chats" },
  allow_channel_creation: { ru: "Создание каналов", en: "Channel creation" },
  accent_color: { ru: "Акцентный цвет", en: "Accent color" },
  permissions: { ru: "Разрешения", en: "Permissions" },
};

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  return String(value ?? "—");
}

export function describeAudit(entry: AuditEntry, locale: string): string {
  const language = locale.startsWith("ru") ? "ru" : "en";
  const actor = entry.actor_name || (language === "ru" ? "Система" : "System");
  const target = entry.target_name || entry.target_id || "—";
  const templates = language === "ru" ? ru : en;
  const action = entry.action as keyof typeof templates;
  const phrase = (templates[action] ?? entry.action).replace(
    "{{target}}",
    target,
  );
  const changeLines = Object.entries(entry.changes ?? {}).flatMap(
    ([field, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const change = raw as { from?: unknown; to?: unknown };
      const label = fieldLabels[field]?.[language] ?? field;
      return [`${label}: ${valueText(change.from)} → ${valueText(change.to)}`];
    },
  );
  return `${actor} ${phrase}${changeLines.length ? `. ${changeLines.join("; ")}` : ""}`;
}
