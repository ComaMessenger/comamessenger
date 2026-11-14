import i18n from "@/i18n";

/**
 * Strings of «Модели» and «Интеграции». Their own catalog (as on the web,
 * `agents/connections/i18n.ts`), added to the app's resources on import;
 * keys already in `i18n/ru.ts` and `en.ts` win.
 */
export const connectionsRu = {
  connModels: "Модели",
  connModelsHint: "Подключения к языковым моделям для агентов.",
  connIntegrations: "Интеграции",
  connIntegrationsHint: "Внешние системы и вебхуки для агентов.",

  // Model connections
  connModelsLead:
    "Агенты обращаются к модели через подключение пространства. Ключ хранится на сервере в зашифрованном виде и в телефон не возвращается.",
  connModelsEmpty: "Подключений пока нет",
  connModelsEmptyHint:
    "Добавьте подключение к OpenAI, Anthropic или OpenAI-совместимому шлюзу — без него агенты не смогут отвечать.",
  connModelsEmptyReadOnly:
    "Подключения добавляет администратор с правом «Интеграции».",
  connModelAdd: "Добавить подключение",
  connModelNew: "Новое подключение",
  connModelName: "Название",
  connModelNamePlaceholder: "Например, Основной шлюз",
  connProvider: "Провайдер",
  connProvider_openai: "OpenAI",
  connProvider_anthropic: "Anthropic",
  "connProvider_openai-compatible": "OpenAI-совместимый",
  connEndpoint: "Адрес API",
  connEndpointHint:
    "Адрес OpenAI-совместимого API, обычно заканчивается на /v1.",
  connEndpointProblem_required: "Укажите адрес.",
  connEndpointProblem_invalid:
    "Нужен полный адрес вида https://api.example.com/v1.",
  connEndpointProblem_scheme: "Адрес должен начинаться с https:// или http://.",
  connEndpointProblem_credentials:
    "Уберите из адреса логин, пароль и часть после #: ключ вводится отдельно.",
  connEndpointProblem_metadata:
    "Адреса метаданных облака закрыты всегда: сервер их не примет.",
  connEndpointProblem_internal:
    "Это внутренний адрес или http. Включите «Система во внутренней сети» — и сервер примет его, только если оператор внёс адрес в INTEGRATIONS_ALLOWED_PRIVATE_TARGETS.",
  connDefaultModel: "Модель по умолчанию",
  connDefaultModelHint:
    "Её получат новые агенты на этом подключении, например gpt-4o-mini.",
  connModelUnset: "модель не выбрана",
  connApiKey: "API-ключ",
  connApiKeyNew: "Новый API-ключ",
  connApiKeyKeep: "Оставьте пустым, чтобы не менять",
  connApiKeyHint:
    "Ключ шифруется на сервере и больше не показывается — только его последние символы.",
  connPaste: "Вставить",
  connPasteHint: "Вставить ключ из буфера обмена",
  connPasted: "Вставлено: {mask}",
  connPasteEmpty: "В буфере обмена нет текста.",
  connKey: "Ключ",
  connStatus: "Состояние",
  connHealth_untested: "Не проверено",
  connHealth_healthy: "Работает",
  connHealth_unhealthy: "Ошибка",
  connDisabled: "Выключено",
  connTestedAt: "Проверено {time}",
  connNeverTested: "Ещё не проверялось",
  connTest: "Проверить подключение",
  connTestOk: "Подключение работает",
  connTestFailed: "Подключение не работает",
  connEnabled: "Включено",
  connEnabledHint: "Выключенное подключение нельзя выбрать для агента.",
  connUsage: "Используют",
  connUsageNone: "Не используется",
  connUsageAgents:
    "{count, plural, one {# агент} few {# агента} many {# агентов} other {# агента}}",
  connUsageCollections:
    "{count, plural, one {# коллекция базы знаний} few {# коллекции базы знаний} many {# коллекций базы знаний} other {# коллекции базы знаний}}",
  connEdit: "Изменить",
  connSave: "Сохранить изменения",
  connSaved: "Изменения сохранены",
  connEmbeddingModel: "Модель эмбеддингов",
  connEmbeddingModelHint:
    "Для поиска по базе знаний, например text-embedding-3-small. Пусто — эмбеддинги выключены.",
  connEmbeddingConsent: "Разрешить передавать текст документов",
  connEmbeddingConsentHint:
    "Для эмбеддингов текст документов базы знаний уходит провайдеру. Без согласия поиск по смыслу не работает.",
  connModelSecurity:
    "Ключ проверяется сервером при первой проверке подключения; перенаправления запрещены.",
  connDelete: "Удалить подключение",
  connDeleteTitle: "Удалить «{name}»?",
  connDeleteText:
    "Агенты больше не смогут его выбрать. Это действие не отменить.",
  connDeleteBlockedTitle: "Подключение используется",
  connDeleteBlockedText:
    "Его используют: {usage}. Сервер не удалит подключение, пока оно выбрано у агентов или в базе знаний. Можно выключить его — агенты перестанут к нему обращаться.",
  connDisableInstead: "Выключить",
  connNotFound: "Не найдено — возможно, его уже удалили.",
  connReadOnly: "Менять подключения может администратор с правом «Интеграции».",

  // Integrations
  connIntegrationsLead:
    "Подключите учётную систему или другой сервис один раз и выдайте агентам только нужные действия.",
  connMcpTitle: "Внешние системы (MCP)",
  connMcpHint:
    "Учётная система, запись на приём, CRM — через MCP-сервер. Ключи хранятся на сервере и не попадают в агентов.",
  connMcpEmpty: "Внешние системы не подключены",
  connMcpAdd: "Подключить систему",
  connMcpNew: "Новая внешняя система",
  connMcpName: "Короткое имя",
  connMcpNameHint:
    "Латиница в нижнем регистре, цифры, дефис. Агент увидит действия как mcp__имя__действие.",
  connMcpNameInvalid:
    "Только a–z, 0–9, «-» и «_», с буквы или цифры, до 40 символов.",
  connMcpDescription: "Что это за система",
  connMcpEndpoint: "Адрес MCP-сервера",
  connMcpHeaderName: "Заголовок авторизации",
  connMcpHeaderValue: "Значение заголовка",
  connMcpHeaderValueHint:
    "Например, Bearer и токен. Шифруется и больше не показывается.",
  connMcpNoSecret: "без ключа",
  connMcpPrivate: "Система во внутренней сети",
  connMcpPrivateHint:
    "Внутренние адреса и http работают, только если оператор сервера внёс адрес в список INTEGRATIONS_ALLOWED_PRIVATE_TARGETS. Адреса метаданных облака закрыты всегда.",
  connMcpAgentUse: "Разрешить агентам",
  connMcpAgentUseHint:
    "Пока выключено, подключение нельзя выбрать в конструкторе агента.",
  connMcpWrites: "Изменения только с подтверждением",
  connMcpWritesHint:
    "Каждое действие, которое меняет данные, ждёт решения человека — даже если в агенте выбрано «сам».",
  connMcpSecurity:
    "Адрес проверяется при сохранении и при каждом подключении; перенаправления запрещены. Смена хоста или порта стирает сохранённый ключ.",
  connMcpTools: "Действия",
  connMcpToolsHint:
    "Выключенное действие нельзя выдать агенту. Проверьте связь, чтобы обновить список.",
  connMcpToolsUnknown: "Проверьте связь, чтобы получить список действий.",
  connMcpToolRead: "чтение",
  connMcpToolWrite: "изменяет данные",
  connMcpReplaceHeaders: "Заменить ключ",
  connMcpReplaceHeadersHint:
    "Новые заголовок и значение заменят сохранённые. Пустое значение удалит ключ.",
  connMcpDropsSecret:
    "Вы меняете хост или порт: сохранённый ключ сотрётся. Введите новый ключ или проверьте адрес.",
  connMcpTimeout: "Ожидание ответа, мс",
  connMcpMaxOutput: "Предел ответа, КБ",
  connMcpLimitsHint: "От 100 до 120 000 мс и от 1 до 4096 КБ.",
  connMcpDetach: "Отвязать от агентов",
  connMcpDetachTitle: "Отвязать «{name}»",
  connMcpDetachText:
    "Эти агенты перестанут видеть действия системы — и в опубликованной версии, и в черновике. Само подключение останется.",
  connMcpDetachConfirm:
    "Отвязать от {count, plural, one {# агента} few {# агентов} many {# агентов} other {# агента}}",
  connMcpDetachPublished: "опубликован",
  connMcpDetachDraft: "черновик",
  connMcpDetachEmpty: "Подключение уже никто не использует.",
  connMcpDelete: "Удалить подключение",
  connMcpDeleteText: "Агенты больше не смогут его выбрать. Ключ будет удалён.",
  connMcpDeleteBlocked:
    "Подключение используют агенты. Сначала отвяжите его от агентов.",
  connTablesTitle: "Таблицы",
  connTablesHint:
    "Если расписание ведётся в таблице, загрузите её в базу знаний (XLSX или CSV) — агент прочитает её без подключения. Таблицу выбирают в конструкторе агента.",
  connTablesOpenKnowledge: "Открыть базу знаний",

  // Webhooks
  connWebhooksTitle: "Входящие вебхуки",
  connWebhooksHint:
    "Внешняя система сообщает о событии — например, «слот освободился» — и запускает агента. Каждый запрос подписан.",
  connWebhooksEmpty: "Вебхуков пока нет",
  connWebhookAdd: "Создать вебхук",
  connWebhookNew: "Новый вебхук",
  connWebhookCreateHint:
    "После создания вы один раз увидите секрет для подписи запросов.",
  connWebhookName: "Название",
  connWebhookDescription: "Что сообщает система",
  connWebhookRate: "Запросов в минуту",
  connWebhookRateHint: "От 1 до 6000. Лишние запросы сервер отклоняет.",
  connWebhookRateInvalid: "Нужно целое число от 1 до 6000.",
  connWebhookURL: "Адрес для внешней системы",
  connWebhookCopyURL: "Копировать адрес",
  connWebhookSecret: "Секрет подписи",
  connWebhookCopySecret: "Копировать секрет",
  connWebhookCopyWarnTitle: "Скопировать секрет?",
  connWebhookCopyWarnText:
    "Секрет попадёт в буфер обмена, откуда его могут прочитать другие приложения и ваши устройства с общим буфером. Вставьте его в настройки внешней системы и сразу скопируйте что-нибудь другое.",
  connCopy: "Копировать",
  connCopied: "Скопировано",
  connWebhookSecretOnce: "Сохраните секрет",
  connWebhookSecretOnceHint:
    "Секрет показывается один раз. Передайте его администратору внешней системы.",
  connWebhookSecretSaved: "Я сохранил секрет",
  connWebhookSigning:
    "Заголовки: X-Coma-Timestamp (unix-время), X-Coma-Delivery (уникальный id), X-Coma-Event (тип события), X-Coma-Signature: sha256=HMAC-SHA256(секрет, «время.id.тело»).",
  connWebhookRotate: "Выпустить новый секрет",
  connWebhookRotateTitle: "Выпустить новый секрет?",
  connWebhookRotateText:
    "Старый секрет перестанет работать сразу: внешняя система получит отказ, пока в ней не заменят секрет.",
  connWebhookRotateConfirm: "Выпустить",
  connWebhookAgentUse: "Разрешить агентам запускаться",
  connWebhookAgentUseHint:
    "Только после этого сборщики агентов увидят вебхук и смогут запускать агента по его событиям.",
  connWebhookTriggers: "Запусков агентов",
  connWebhookLastReceived: "Последнее событие",
  connWebhookNever: "ещё не было",
  connWebhookRejected: "Отклонено без подписи",
  connWebhookRejectedSummary: "{count}, последняя причина: {code}",
  connWebhookJournal: "Журнал",
  connWebhookJournalTitle: "Журнал «{name}»",
  connWebhookJournalEmpty: "Событий ещё не было.",
  connDelivery_accepted: "принято",
  connDelivery_rejected: "отклонено",
  connWebhookRuns: "запусков: {count}",
  connWebhookDelete: "Удалить вебхук",
  connWebhookDeleteText:
    "Внешняя система больше не сможет присылать события на этот адрес.",
  connWebhookDeleteBlocked:
    "Вебхук запускает агентов. Сначала уберите эти автоматизации или выключите вебхук.",

  // Health errors (last_error_code) and refusals
  connectionErrorUnauthorized: "Ключ не подошёл: провайдер отказал в доступе.",
  connectionErrorForbidden: "У ключа нет прав на этот запрос.",
  connectionErrorRateLimited:
    "Провайдер ограничил частоту запросов. Повторите позже.",
  connectionErrorNetwork: "Не удалось связаться с сервером по этому адресу.",
  connectionErrorTimeout: "Сервер не ответил вовремя.",
  connectionErrorCredentialsRequired:
    "Адрес изменился, и сохранённый ключ стёрт. Укажите новый ключ.",
  connectionErrorEndpointForbidden:
    "Адрес закрыт сетевыми ограничениями сервера. Для внутренних систем нужен список INTEGRATIONS_ALLOWED_PRIVATE_TARGETS.",
  connectionErrorRedirect:
    "Сервер ответил перенаправлением, а перенаправления запрещены. Укажите конечный адрес.",
  connectionErrorTooLarge: "Ответ сервера больше допустимого предела.",
  connectionErrorProvider: "Сервер ответил ошибкой.",
  connectionErrorUnknown: "Проверка не прошла.",
  connErrorCode: "Код: {code}",
  connectionUsageChanged:
    "Список агентов изменился. Проверьте его ещё раз и повторите.",
  modelConnectionInUse:
    "Подключение используют агенты или база знаний. Выключите его или выберите у них другое.",
  mcpConnectionInUse:
    "Подключение используют агенты. Отключите его или отвяжите от агентов.",
  webhookInUse:
    "Вебхук запускает агентов. Сначала уберите эти автоматизации или выключите вебхук.",
  mcpPrivateTargetNotAllowed:
    "Это внутренний адрес. Сервер примет его, только если оператор внесёт адрес в INTEGRATIONS_ALLOWED_PRIVATE_TARGETS, а у подключения включено «Система во внутренней сети».",
  mcpEndpointRejected:
    "Сервер не принял адрес или поля. Проверьте адрес (https, без логина и пароля), имя и ключ.",
  modelConnectionInvalid:
    "Сервер не принял подключение. Проверьте адрес, модель и ключ; название должно быть уникальным.",
};

export const connectionsEn: Record<keyof typeof connectionsRu, string> = {
  connModels: "Models",
  connModelsHint: "Language model connections for agents.",
  connIntegrations: "Integrations",
  connIntegrationsHint: "External systems and webhooks for agents.",

  connModelsLead:
    "Agents reach a model through a workspace connection. The key is stored encrypted on the server and never comes back to the phone.",
  connModelsEmpty: "No connections yet",
  connModelsEmptyHint:
    "Add a connection to OpenAI, Anthropic or an OpenAI-compatible gateway — agents cannot answer without one.",
  connModelsEmptyReadOnly:
    "Connections are added by an administrator with the Integrations permission.",
  connModelAdd: "Add connection",
  connModelNew: "New connection",
  connModelName: "Name",
  connModelNamePlaceholder: "For example, Main gateway",
  connProvider: "Provider",
  connProvider_openai: "OpenAI",
  connProvider_anthropic: "Anthropic",
  "connProvider_openai-compatible": "OpenAI-compatible",
  connEndpoint: "API address",
  connEndpointHint:
    "Address of the OpenAI-compatible API, usually ending in /v1.",
  connEndpointProblem_required: "Enter the address.",
  connEndpointProblem_invalid:
    "Enter a full address such as https://api.example.com/v1.",
  connEndpointProblem_scheme:
    "The address must start with https:// or http://.",
  connEndpointProblem_credentials:
    "Remove the login, password and the part after # from the address: the key goes in its own field.",
  connEndpointProblem_metadata:
    "Cloud metadata addresses are always blocked: the server will refuse it.",
  connEndpointProblem_internal:
    "This is an internal address or plain http. Turn on “System in the internal network” — the server accepts it only if the operator lists it in INTEGRATIONS_ALLOWED_PRIVATE_TARGETS.",
  connDefaultModel: "Default model",
  connDefaultModelHint:
    "New agents on this connection get it, e.g. gpt-4o-mini.",
  connModelUnset: "model not selected",
  connApiKey: "API key",
  connApiKeyNew: "New API key",
  connApiKeyKeep: "Leave empty to keep the current key",
  connApiKeyHint:
    "The key is encrypted on the server and never shown again — only its last characters.",
  connPaste: "Paste",
  connPasteHint: "Paste the key from the clipboard",
  connPasted: "Pasted: {mask}",
  connPasteEmpty: "The clipboard has no text.",
  connKey: "Key",
  connStatus: "Status",
  connHealth_untested: "Untested",
  connHealth_healthy: "Healthy",
  connHealth_unhealthy: "Error",
  connDisabled: "Disabled",
  connTestedAt: "Tested {time}",
  connNeverTested: "Not tested yet",
  connTest: "Test connection",
  connTestOk: "The connection works",
  connTestFailed: "The connection does not work",
  connEnabled: "Enabled",
  connEnabledHint: "A disabled connection cannot be chosen for an agent.",
  connUsage: "Used by",
  connUsageNone: "Not used",
  connUsageAgents: "{count, plural, one {# agent} other {# agents}}",
  connUsageCollections:
    "{count, plural, one {# knowledge collection} other {# knowledge collections}}",
  connEdit: "Edit",
  connSave: "Save changes",
  connSaved: "Changes saved",
  connEmbeddingModel: "Embedding model",
  connEmbeddingModelHint:
    "For knowledge base search, e.g. text-embedding-3-small. Empty turns embeddings off.",
  connEmbeddingConsent: "Allow sending document text",
  connEmbeddingConsentHint:
    "Embeddings send the text of knowledge base documents to the provider. Semantic search does not work without consent.",
  connModelSecurity:
    "The server checks the key on the first connection test; redirects are refused.",
  connDelete: "Delete connection",
  connDeleteTitle: "Delete “{name}”?",
  connDeleteText:
    "Agents will no longer be able to choose it. This cannot be undone.",
  connDeleteBlockedTitle: "The connection is in use",
  connDeleteBlockedText:
    "Used by: {usage}. The server keeps a connection that agents or the knowledge base have chosen. You can disable it — agents stop calling it.",
  connDisableInstead: "Disable",
  connNotFound: "Not found — it may have been deleted.",
  connReadOnly:
    "Connections are changed by an administrator with the Integrations permission.",

  connIntegrationsLead:
    "Connect an accounting system or another service once and give agents only the actions they need.",
  connMcpTitle: "External systems (MCP)",
  connMcpHint:
    "Accounting, booking, CRM — through an MCP server. Keys stay on the server and are never copied into agents.",
  connMcpEmpty: "No external systems connected",
  connMcpAdd: "Connect a system",
  connMcpNew: "New external system",
  connMcpName: "Short name",
  connMcpNameHint:
    "Lowercase Latin letters, digits, hyphen. The agent sees actions as mcp__name__action.",
  connMcpNameInvalid:
    "Only a–z, 0–9, “-” and “_”, starting with a letter or digit, up to 40 characters.",
  connMcpDescription: "What this system is",
  connMcpEndpoint: "MCP server address",
  connMcpHeaderName: "Authorization header",
  connMcpHeaderValue: "Header value",
  connMcpHeaderValueHint:
    "For example, Bearer and a token. Encrypted and never shown again.",
  connMcpNoSecret: "no key",
  connMcpPrivate: "System in the internal network",
  connMcpPrivateHint:
    "Internal addresses and http work only if the server operator lists the address in INTEGRATIONS_ALLOWED_PRIVATE_TARGETS. Cloud metadata addresses are always blocked.",
  connMcpAgentUse: "Allow agents",
  connMcpAgentUseHint:
    "While off, the connection cannot be chosen in the agent builder.",
  connMcpWrites: "Changes only with approval",
  connMcpWritesHint:
    "Every action that changes data waits for a person's decision — even if the agent is set to act on its own.",
  connMcpSecurity:
    "The address is checked when saved and on every connection; redirects are refused. Changing the host or port erases the stored key.",
  connMcpTools: "Actions",
  connMcpToolsHint:
    "A disabled action cannot be given to an agent. Test the connection to refresh the list.",
  connMcpToolsUnknown: "Test the connection to load its actions.",
  connMcpToolRead: "read",
  connMcpToolWrite: "changes data",
  connMcpReplaceHeaders: "Replace the key",
  connMcpReplaceHeadersHint:
    "The new header and value replace the stored ones. An empty value removes the key.",
  connMcpDropsSecret:
    "You are changing the host or port: the stored key will be erased. Enter a new key or check the address.",
  connMcpTimeout: "Response timeout, ms",
  connMcpMaxOutput: "Response limit, KB",
  connMcpLimitsHint: "From 100 to 120,000 ms and from 1 to 4096 KB.",
  connMcpDetach: "Detach from agents",
  connMcpDetachTitle: "Detach “{name}”",
  connMcpDetachText:
    "These agents lose the system's actions in both the published version and the draft. The connection itself stays.",
  connMcpDetachConfirm:
    "Detach from {count, plural, one {# agent} other {# agents}}",
  connMcpDetachPublished: "published",
  connMcpDetachDraft: "draft",
  connMcpDetachEmpty: "No agent uses the connection any more.",
  connMcpDelete: "Delete connection",
  connMcpDeleteText:
    "Agents will no longer be able to choose it. The key is deleted.",
  connMcpDeleteBlocked:
    "Agents use this connection. Detach it from the agents first.",
  connTablesTitle: "Tables",
  connTablesHint:
    "If the schedule lives in a spreadsheet, upload it to the knowledge base (XLSX or CSV) — the agent reads it without a connection. The table is chosen in the agent builder.",
  connTablesOpenKnowledge: "Open the knowledge base",

  connWebhooksTitle: "Incoming webhooks",
  connWebhooksHint:
    "An external system reports an event — say, “a slot became free” — and starts an agent. Every request is signed.",
  connWebhooksEmpty: "No webhooks yet",
  connWebhookAdd: "Create webhook",
  connWebhookNew: "New webhook",
  connWebhookCreateHint: "After creation you will see the signing secret once.",
  connWebhookName: "Name",
  connWebhookDescription: "What the system reports",
  connWebhookRate: "Requests per minute",
  connWebhookRateHint: "From 1 to 6000. The server rejects the rest.",
  connWebhookRateInvalid: "Enter a whole number from 1 to 6000.",
  connWebhookURL: "Address for the external system",
  connWebhookCopyURL: "Copy address",
  connWebhookSecret: "Signing secret",
  connWebhookCopySecret: "Copy secret",
  connWebhookCopyWarnTitle: "Copy the secret?",
  connWebhookCopyWarnText:
    "The secret goes to the clipboard, where other apps and your devices sharing the clipboard can read it. Paste it into the external system's settings and copy something else right away.",
  connCopy: "Copy",
  connCopied: "Copied",
  connWebhookSecretOnce: "Save the secret",
  connWebhookSecretOnceHint:
    "The secret is shown only once. Hand it to the administrator of the external system.",
  connWebhookSecretSaved: "I saved the secret",
  connWebhookSigning:
    "Headers: X-Coma-Timestamp (unix time), X-Coma-Delivery (unique id), X-Coma-Event (event type), X-Coma-Signature: sha256=HMAC-SHA256(secret, “time.id.body”).",
  connWebhookRotate: "Issue a new secret",
  connWebhookRotateTitle: "Issue a new secret?",
  connWebhookRotateText:
    "The old secret stops working at once: the external system is refused until its secret is replaced.",
  connWebhookRotateConfirm: "Issue",
  connWebhookAgentUse: "Let agents start on it",
  connWebhookAgentUseHint:
    "Only then do agent builders see the webhook and start an agent on its events.",
  connWebhookTriggers: "Agent starts",
  connWebhookLastReceived: "Last event",
  connWebhookNever: "none yet",
  connWebhookRejected: "Rejected without signature",
  connWebhookRejectedSummary: "{count}, last reason: {code}",
  connWebhookJournal: "Journal",
  connWebhookJournalTitle: "“{name}” journal",
  connWebhookJournalEmpty: "No events yet.",
  connDelivery_accepted: "accepted",
  connDelivery_rejected: "rejected",
  connWebhookRuns: "runs: {count}",
  connWebhookDelete: "Delete webhook",
  connWebhookDeleteText:
    "The external system will no longer be able to post events to this address.",
  connWebhookDeleteBlocked:
    "Agents start on this webhook. Remove those automations or disable the webhook first.",

  connectionErrorUnauthorized: "The key was refused by the provider.",
  connectionErrorForbidden: "The key has no rights for this request.",
  connectionErrorRateLimited:
    "The provider is limiting requests. Try again later.",
  connectionErrorNetwork: "Could not reach the server at this address.",
  connectionErrorTimeout: "The server did not answer in time.",
  connectionErrorCredentialsRequired:
    "The address changed and the stored key was erased. Enter a new key.",
  connectionErrorEndpointForbidden:
    "The server's network rules block this address. Internal systems need INTEGRATIONS_ALLOWED_PRIVATE_TARGETS.",
  connectionErrorRedirect:
    "The server answered with a redirect, and redirects are refused. Enter the final address.",
  connectionErrorTooLarge: "The server's answer exceeds the limit.",
  connectionErrorProvider: "The server answered with an error.",
  connectionErrorUnknown: "The test failed.",
  connErrorCode: "Code: {code}",
  connectionUsageChanged:
    "The list of agents changed. Review it again and retry.",
  modelConnectionInUse:
    "Agents or the knowledge base use this connection. Disable it or choose another one there.",
  mcpConnectionInUse:
    "Agents use this connection. Disable it or detach it from the agents.",
  webhookInUse:
    "Agents start on this webhook. Remove those automations or disable the webhook first.",
  mcpPrivateTargetNotAllowed:
    "This is an internal address. The server accepts it only if the operator lists it in INTEGRATIONS_ALLOWED_PRIVATE_TARGETS and the connection is marked “System in the internal network”.",
  mcpEndpointRejected:
    "The server refused the address or fields. Check the address (https, no login or password), the name and the key.",
  modelConnectionInvalid:
    "The server refused the connection. Check the address, model and key; the name must be unique.",
};

i18n.addResourceBundle("ru", "translation", connectionsRu, true, false);
i18n.addResourceBundle("en", "translation", connectionsEn, true, false);
