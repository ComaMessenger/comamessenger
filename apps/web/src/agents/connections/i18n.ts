import { defineCatalog } from "../../i18n/catalog";

/* Workspace integrations: MCP connections and incoming webhooks (phase 5.3 H). */
export const integrationsCatalog = defineCatalog(
  {
    integrationsTitle: "Интеграции",
    integrationsDescription:
      "Подключите учётную систему или другой сервис один раз и выдайте агентам только нужные действия.",
    mcpConnectionsTitle: "Внешние системы (MCP)",
    mcpConnectionsDescription:
      "Учётная система, запись на приём, CRM — через MCP-сервер. Ключи хранятся на сервере и не попадают в агентов.",
    mcpConnectionAdd: "Подключить систему",
    mcpConnectionsEmpty: "Внешние системы не подключены",
    mcpConnectionsEmptyHint:
      "Если расписание ведётся в таблице, загрузите её в базу знаний — агент прочитает её без подключения.",
    mcpConnectionCreateTitle: "Новая внешняя система",
    mcpConnectionCreateDescription:
      "Адрес MCP-сервера и ключ доступа. Ключ шифруется и больше не показывается.",
    mcpConnectionName: "Короткое имя",
    mcpConnectionNameHint:
      "Латиница, цифры, дефис. Агент увидит действия как mcp__имя__действие.",
    mcpConnectionDescriptionField: "Что это за система",
    mcpConnectionEndpoint: "Адрес MCP-сервера",
    mcpConnectionHeaderName: "Заголовок авторизации",
    mcpConnectionHeaderValue: "Значение заголовка",
    mcpConnectionPrivate: "Система во внутренней сети",
    mcpConnectionPrivateHint:
      "Разрешает внутренние адреса (10.x, 192.168.x, localhost) и http. Адреса метаданных облака запрещены всегда.",
    mcpConnectionSecurityHint:
      "Адрес проверяется: без отметки «внутренняя сеть» внутренние и служебные адреса недоступны, перенаправления запрещены.",
    mcpConnectionSecret: "Ключ",
    mcpConnectionNoSecret: "без ключа",
    mcpConnectionTools: "Действия",
    mcpConnectionToolsUnknown:
      "Проверьте связь, чтобы получить список действий.",
    mcpToolRead: "чтение",
    mcpToolWrite: "изменяет данные",
    mcpConnectionAgents: "Агенты",
    mcpConnectionAgentCount:
      "{count, plural, one {# агент} few {# агента} many {# агентов} other {# агента}}",
    mcpConnectionUnused: "не используется",
    mcpConnectionLastTested: "Проверено",
    mcpConnectionError: "Ошибка: {code}",
    mcpConnectionDetach: "Отвязать от агентов",
    mcpConnectionDetachTitle: "Отвязать «{name}» от агентов",
    mcpConnectionDetachDescription:
      "Эти агенты перестанут видеть действия системы — и в опубликованной версии, и в черновике. Само подключение останется.",
    mcpConnectionDetachConfirm:
      "Отвязать от {count, plural, one {# агента} few {# агентов} many {# агентов} other {# агента}}",
    mcpConnectionDetachPublished: "опубликован",
    mcpConnectionDetachDraft: "черновик",
    mcpConnectionDeleteBlocked:
      "Подключение используют агенты. Отключите его или отвяжите от агентов.",
    webhooksTitle: "Входящие вебхуки",
    webhooksDescription:
      "Внешняя система сообщает о событии — например, «слот освободился» — и запускает агента. Каждый запрос подписан.",
    webhookAdd: "Создать вебхук",
    webhooksEmpty: "Вебхуков пока нет",
    webhooksEmptyHint:
      "Создайте вебхук, затем в автоматизациях агента выберите запуск «по вебхуку».",
    webhookCreateTitle: "Новый вебхук",
    webhookCreateDescription:
      "После создания вы один раз увидите секрет для подписи запросов.",
    webhookRateLimit: "Запросов в минуту",
    webhookURL: "Адрес для внешней системы",
    webhookSecret: "Секрет подписи",
    webhookSecretOnceTitle: "Сохраните секрет",
    webhookSecretOnceDescription:
      "Секрет показывается один раз. Передайте его администратору внешней системы.",
    webhookSigningHint:
      "Заголовки: X-Coma-Timestamp (unix-время), X-Coma-Delivery (уникальный id), X-Coma-Event (тип события), X-Coma-Signature: sha256=HMAC-SHA256(секрет, «время.id.тело»).",
    webhookSecretSaved: "Я сохранил секрет",
    webhookRotate: "Новый секрет",
    webhookTriggers: "Запусков агентов",
    webhookLastReceived: "Последнее событие",
    webhookNever: "ещё не было",
    webhookJournal: "Журнал",
    webhookJournalTitle: "Журнал «{name}»",
    webhookJournalEmpty: "Событий ещё не было.",
    webhookDelivery_accepted: "принято",
    webhookDelivery_rejected: "отклонено",
    webhookRunsCreated: "запусков: {count}",
    webhookDeleteBlocked:
      "Вебхук запускает агентов. Сначала уберите эти автоматизации или отключите вебхук.",
    webhookName: "Название",
    webhookDescriptionField: "Что сообщает система",
    integrationEnabled: "Включено",
    integrationDisabled: "Выключено",
    copy: "Копировать",
    copied: "Скопировано",
    agentScope_tables_read: "Чтение таблиц из базы знаний",
  },
  {
    integrationsTitle: "Integrations",
    integrationsDescription:
      "Connect an accounting system or another service once and give agents only the actions they need.",
    mcpConnectionsTitle: "External systems (MCP)",
    mcpConnectionsDescription:
      "Accounting, booking, CRM — through an MCP server. Keys stay on the server and are never copied into agents.",
    mcpConnectionAdd: "Connect a system",
    mcpConnectionsEmpty: "No external systems connected",
    mcpConnectionsEmptyHint:
      "If the schedule lives in a spreadsheet, upload it to the knowledge base — the agent reads it without a connection.",
    mcpConnectionCreateTitle: "New external system",
    mcpConnectionCreateDescription:
      "MCP server address and access key. The key is encrypted and never shown again.",
    mcpConnectionName: "Short name",
    mcpConnectionNameHint:
      "Latin letters, digits, hyphen. The agent sees actions as mcp__name__action.",
    mcpConnectionDescriptionField: "What this system is",
    mcpConnectionEndpoint: "MCP server address",
    mcpConnectionHeaderName: "Authorization header",
    mcpConnectionHeaderValue: "Header value",
    mcpConnectionPrivate: "System in the internal network",
    mcpConnectionPrivateHint:
      "Allows internal addresses (10.x, 192.168.x, localhost) and http. Cloud metadata addresses are always blocked.",
    mcpConnectionSecurityHint:
      "The address is checked: without “internal network” internal and service addresses are unreachable, redirects are refused.",
    mcpConnectionSecret: "Key",
    mcpConnectionNoSecret: "no key",
    mcpConnectionTools: "Actions",
    mcpConnectionToolsUnknown: "Test the connection to load its actions.",
    mcpToolRead: "read",
    mcpToolWrite: "changes data",
    mcpConnectionAgents: "Agents",
    mcpConnectionAgentCount: "{count, plural, one {# agent} other {# agents}}",
    mcpConnectionUnused: "not used",
    mcpConnectionLastTested: "Tested",
    mcpConnectionError: "Error: {code}",
    mcpConnectionDetach: "Detach from agents",
    mcpConnectionDetachTitle: "Detach “{name}” from agents",
    mcpConnectionDetachDescription:
      "These agents lose the system's actions in both the published version and the draft. The connection itself stays.",
    mcpConnectionDetachConfirm:
      "Detach from {count, plural, one {# agent} other {# agents}}",
    mcpConnectionDetachPublished: "published",
    mcpConnectionDetachDraft: "draft",
    mcpConnectionDeleteBlocked:
      "Agents use this connection. Disable it or detach it from the agents.",
    webhooksTitle: "Incoming webhooks",
    webhooksDescription:
      "An external system reports an event — say, “a slot became free” — and starts an agent. Every request is signed.",
    webhookAdd: "Create webhook",
    webhooksEmpty: "No webhooks yet",
    webhooksEmptyHint:
      "Create a webhook, then choose the “on webhook” start in the agent's automations.",
    webhookCreateTitle: "New webhook",
    webhookCreateDescription:
      "After creation you will see the signing secret once.",
    webhookRateLimit: "Requests per minute",
    webhookURL: "Address for the external system",
    webhookSecret: "Signing secret",
    webhookSecretOnceTitle: "Save the secret",
    webhookSecretOnceDescription:
      "The secret is shown only once. Hand it to the administrator of the external system.",
    webhookSigningHint:
      "Headers: X-Coma-Timestamp (unix time), X-Coma-Delivery (unique id), X-Coma-Event (event type), X-Coma-Signature: sha256=HMAC-SHA256(secret, “time.id.body”).",
    webhookSecretSaved: "I saved the secret",
    webhookRotate: "New secret",
    webhookTriggers: "Agent starts",
    webhookLastReceived: "Last event",
    webhookNever: "none yet",
    webhookJournal: "Journal",
    webhookJournalTitle: "“{name}” journal",
    webhookJournalEmpty: "No events yet.",
    webhookDelivery_accepted: "accepted",
    webhookDelivery_rejected: "rejected",
    webhookRunsCreated: "runs: {count}",
    webhookDeleteBlocked:
      "Agents start on this webhook. Remove those automations or disable the webhook first.",
    webhookName: "Name",
    webhookDescriptionField: "What the system reports",
    integrationEnabled: "Enabled",
    integrationDisabled: "Disabled",
    copy: "Copy",
    copied: "Copied",
    agentScope_tables_read: "Read tables from the knowledge base",
  },
);
