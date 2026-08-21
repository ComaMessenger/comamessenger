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
  "agent.create",
  "agent.update",
  "agent.delete",
  "agent.key.create",
  "agent.key.revoke",
  "agent.settings.update",
  "agent.provider_credential.update",
  "agent.mcp_server.create",
  "agent.mcp_server.update",
  "agent.mcp_server.delete",
  "agent.trigger.create",
  "agent.trigger.update",
  "agent.trigger.delete",
  "agent.run.invoke",
  "agent.run.cancel",
  "agent.tool.call",
  "agent.tool.confirmation.request",
  "agent.tool.confirmation.approve",
  "agent.tool.confirmation.deny",
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
  "agent.create": "создал(а) агента {{target}}",
  "agent.update": "изменил(а) агента {{target}}",
  "agent.delete": "удалил(а) агента {{target}}",
  "agent.key.create": "создал(а) ключ агента {{target}}",
  "agent.key.revoke": "отозвал(а) ключ агента {{target}}",
  "agent.settings.update": "изменил(а) общие настройки агентов",
  "agent.provider_credential.update":
    "обновил(а) данные провайдера агента {{target}}",
  "agent.mcp_server.create": "добавил(а) MCP-сервер агента",
  "agent.mcp_server.update": "изменил(а) MCP-сервер агента",
  "agent.mcp_server.delete": "удалил(а) MCP-сервер агента",
  "agent.trigger.create": "создал(а) триггер агента {{target}}",
  "agent.trigger.update": "изменил(а) триггер агента {{target}}",
  "agent.trigger.delete": "удалил(а) триггер агента {{target}}",
  "agent.run.invoke": "запустил(а) агента {{target}}",
  "agent.run.cancel": "остановил(а) агента {{target}}",
  "agent.tool.call": "вызвал(а) инструмент агента {{target}}",
  "agent.tool.confirmation.request":
    "запросил(а) подтверждение действия агента {{target}}",
  "agent.tool.confirmation.approve":
    "одобрил(а) действие агента {{target}}",
  "agent.tool.confirmation.deny":
    "отклонил(а) действие агента {{target}}",
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
  "agent.create": "created agent {{target}}",
  "agent.update": "updated agent {{target}}",
  "agent.delete": "deleted agent {{target}}",
  "agent.key.create": "created a key for agent {{target}}",
  "agent.key.revoke": "revoked a key for agent {{target}}",
  "agent.settings.update": "changed global agent settings",
  "agent.provider_credential.update":
    "updated provider credentials for agent {{target}}",
  "agent.mcp_server.create": "added an agent MCP server",
  "agent.mcp_server.update": "updated an agent MCP server",
  "agent.mcp_server.delete": "removed an agent MCP server",
  "agent.trigger.create": "created a trigger for agent {{target}}",
  "agent.trigger.update": "updated a trigger for agent {{target}}",
  "agent.trigger.delete": "removed a trigger from agent {{target}}",
  "agent.run.invoke": "started agent {{target}}",
  "agent.run.cancel": "stopped agent {{target}}",
  "agent.tool.call": "called a tool for agent {{target}}",
  "agent.tool.confirmation.request":
    "requested confirmation for agent action {{target}}",
  "agent.tool.confirmation.approve": "approved agent action {{target}}",
  "agent.tool.confirmation.deny": "denied agent action {{target}}",
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
