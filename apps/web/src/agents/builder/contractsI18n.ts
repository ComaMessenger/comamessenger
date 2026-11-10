import { defineCatalog } from "../../i18n/catalog";

/*
 * Builder contracts of phase 5.3: tone, «сам / после подтверждения» for each
 * action, external systems, reading and writing chats, spreadsheets, the
 * webhook rule and the instructions the model receives.
 */
export const builderContractsCatalog = defineCatalog(
  {
    agentTone: "Тон",
    agentTone_none: "Без указаний",
    agentTone_concise: "Коротко и по делу",
    agentTone_friendly: "Дружелюбно",
    agentTone_formal: "Официально",
    agentToneHint:
      "Сервер добавит строку о тоне в инструкции агента. Итоговый текст — в расширенных настройках.",

    agentModeChoice: "Режим действия «{action}»",
    agentAction_post: "Писать в свои чаты",
    agentAction_direct: "Писать людям в личные сообщения",
    agentAction_cards: "Публиковать и обновлять карточки",
    agentAction_collect: "Собирать ответы и напоминать",
    agentAction_followup: "Ставить себе отложенный запуск",
    agentAction_react: "Ставить реакции",
    agentAction_remember: "Сохранять заметки",
    agentActionAutoHint: "Сделает это сам, без вашего участия",
    agentActionConfirmHint:
      "Сначала спросит: в чате появится карточка, решение — в «Активности»",
    agentActionLockedServer:
      "На этом сервере действие всегда ждёт подтверждения: так настроил администратор",
    agentActionLockedConnection:
      "Подключение требует подтверждать изменения: так решил администратор интеграций",

    agentExternalTitle: "Внешние системы",
    agentExternalHint:
      "Подключения пространства, открытые для агентов. Выберите, что агенту можно делать",
    agentExternalAdd: "Подключить внешнюю систему",
    agentExternalChoose: "Выберите подключение",
    agentExternalRemove: "Отключить «{name}»",
    agentExternalMissing: "Подключение недоступно",
    agentExternalNoTools: "Администратор не открыл агентам ни одного действия этой системы.",
    agentExternalTool: "Разрешить «{tool}»",
    agentToolReads: "чтение",
    agentToolWrites: "изменяет данные",

    agentKnowsChatsHint:
      "Агент видит историю этих чатов. Писать туда он может, только если чат есть в «Где работает»",
    agentKnowsChatsAdd: "Добавить чат-источник",
    agentTables: "Таблицы из базы знаний",
    agentTablesList: "Читает: {names}",
    agentTablesNone: "В выбранных коллекциях нет таблиц CSV или XLSX",
    agentTablesAdd: "Добавить таблицу (например, расписание)",
    agentTablesChoose: "Выберите таблицу",
    agentTableOption: "{name} · {collection}",

    agentRuleType_webhook: "Когда внешняя система сообщает о событии",
    agentRuleTypeHint_webhook:
      "Учётная система присылает подписанное событие на вебхук пространства, и агент берётся за задачу.",
    agentRuleWebhook: "Вебхук",
    agentRuleWebhookChoose: "Выберите вебхук",
    agentRuleWebhookEvents: "Только события",
    agentRuleWebhookEventsHint: "Через запятую. Пусто — любое событие",
    agentRuleWebhookEventsPlaceholder: "slot.released",
    agentRuleWhen_webhook: "Когда «{system}» сообщает о событии",
    agentRuleWhen_webhookEvents: "Когда «{system}» сообщает о {events}",
    agentRuleWhen_webhookMissing: "Когда внешняя система сообщает о событии (вебхук недоступен)",
    agentRuleProblem_webhook: "Выберите вебхук.",
    agentRuleProblem_webhookChat: "Выберите чат, куда агент напишет.",
    agentRuleProblem_webhookEvents:
      "Названия событий — латиница, цифры и знаки . _ : -",

    agentInstructionsTitle: "Что получает модель",
    agentInstructionsLead:
      "Инструкции сохранённой версии: задача, тон и чаты, где агент только читает или только пишет. Сервер собирает их сам.",

    agentFeedMore: "Показать ещё",
    agentFeedDone_webhook: "отреагировал на событие внешней системы в «{chat}»",
    agentFeedDoneNoChat_webhook: "отреагировал на событие внешней системы",
    agentFeedDone_confirmation: "продолжил после решения человека в «{chat}»",
    agentFeedDoneNoChat_confirmation: "продолжил после решения человека",
    errorAgentNotReady:
      "Агент ещё не готов: выполните пункты из списка над конструктором.",
    agentLoosenedTitle: "Эти действия пойдут без подтверждения",
    agentLoosenedLead:
      "После публикации агент будет делать это сам, не спрашивая человека. Проверьте, что так и задумано.",
    agentLoosenedConfirm: "Понятно, опубликовать",
    agentLoosenedExternal: "«{tool}» во внешней системе «{connection}»",
  },
  {
    agentTone: "Tone",
    agentTone_none: "No preference",
    agentTone_concise: "Brief and to the point",
    agentTone_friendly: "Friendly",
    agentTone_formal: "Formal",
    agentToneHint:
      "The server adds a tone line to the agent instructions. See the final text in advanced settings.",

    agentModeChoice: "Mode of «{action}»",
    agentAction_post: "Write to its chats",
    agentAction_direct: "Write to people in direct messages",
    agentAction_cards: "Post and update cards",
    agentAction_collect: "Collect answers and remind",
    agentAction_followup: "Schedule its own later run",
    agentAction_react: "Add reactions",
    agentAction_remember: "Save notes",
    agentActionAutoHint: "Does it by itself, without you",
    agentActionConfirmHint:
      "Asks first: a card appears in the chat, the decision is in Activity",
    agentActionLockedServer:
      "On this server this action always waits for approval: set by the administrator",
    agentActionLockedConnection:
      "The connection requires approving changes: set by the integrations administrator",

    agentExternalTitle: "External systems",
    agentExternalHint:
      "Workspace connections released for agents. Choose what the agent may do",
    agentExternalAdd: "Connect an external system",
    agentExternalChoose: "Choose a connection",
    agentExternalRemove: "Disconnect «{name}»",
    agentExternalMissing: "Connection unavailable",
    agentExternalNoTools: "The administrator released no actions of this system to agents.",
    agentExternalTool: "Allow «{tool}»",
    agentToolReads: "reads",
    agentToolWrites: "changes data",

    agentKnowsChatsHint:
      "The agent sees the history of these chats. It can post there only if the chat is in «Where it works»",
    agentKnowsChatsAdd: "Add a source chat",
    agentTables: "Spreadsheets from the knowledge base",
    agentTablesList: "Reads: {names}",
    agentTablesNone: "The chosen collections have no CSV or XLSX spreadsheets",
    agentTablesAdd: "Add a spreadsheet (for example, a schedule)",
    agentTablesChoose: "Choose a spreadsheet",
    agentTableOption: "{name} · {collection}",

    agentRuleType_webhook: "When an external system reports an event",
    agentRuleTypeHint_webhook:
      "The accounting system sends a signed event to a workspace webhook, and the agent takes the task.",
    agentRuleWebhook: "Webhook",
    agentRuleWebhookChoose: "Choose a webhook",
    agentRuleWebhookEvents: "Only events",
    agentRuleWebhookEventsHint: "Comma-separated. Empty means any event",
    agentRuleWebhookEventsPlaceholder: "slot.released",
    agentRuleWhen_webhook: "When «{system}» reports an event",
    agentRuleWhen_webhookEvents: "When «{system}» reports {events}",
    agentRuleWhen_webhookMissing: "When an external system reports an event (webhook unavailable)",
    agentRuleProblem_webhook: "Choose a webhook.",
    agentRuleProblem_webhookChat: "Choose the chat the agent writes to.",
    agentRuleProblem_webhookEvents:
      "Event names use Latin letters, digits and . _ : -",

    agentInstructionsTitle: "What the model receives",
    agentInstructionsLead:
      "Instructions of the saved version: the task, the tone and the chats where the agent only reads or only writes. The server builds them.",

    agentFeedMore: "Show more",
    agentFeedDone_webhook: "reacted to an external system event in «{chat}»",
    agentFeedDoneNoChat_webhook: "reacted to an external system event",
    agentFeedDone_confirmation: "continued after a person's decision in «{chat}»",
    agentFeedDoneNoChat_confirmation: "continued after a person's decision",
    errorAgentNotReady:
      "The agent is not ready yet: complete the items listed above the builder.",
    agentLoosenedTitle: "These actions will run without approval",
    agentLoosenedLead:
      "After publishing, the agent does this by itself without asking a person. Check that this is intended.",
    agentLoosenedConfirm: "Understood, publish",
    agentLoosenedExternal: "«{tool}» in the external system «{connection}»",
  },
);
