import { defineCatalog } from "../i18n/catalog";

/* Agent platform keys, moved verbatim from the base catalogs. */
export const agentsCatalog = defineCatalog(
  {
    agentPlatformHint:
      "Создавайте, проверяйте и наблюдайте за агентами в одном рабочем разделе.",
    agentPlatformNavigation: "Разделы платформы агентов",
    agentDetailNavigation: "Настройка агента",
    agentTab_overview: "Обзор",
    agentTab_sandbox: "Песочница",
    agentTab_approvals: "Подтверждения",
    agentTab_runs: "Запуски",
    agentTab_connections: "Подключения",
    agentTab_activity: "Активность",
    agentTab_behavior: "Поведение",
    agentTab_knowledge: "Знания",
    agentTab_automations: "Автоматизации",
    agentTab_test: "Проверка",
    agentTab_settings: "Настройки",
    agentConnectionsTitle: "Подключения LLM",
    agentConnectionsDescription:
      "Один раз подключите провайдера и используйте его в нескольких агентах без копирования ключей.",
    agentConnectionAdd: "Добавить подключение",
    agentConnectionChoose: "Выберите подключение",
    agentConnectionChooseLater: "Подключить позже",
    agentUsesWorkspaceConnection:
      "Ключ провайдера хранится в подключении пространства и не дублируется в агенте.",
    agentConnectionsEmpty: "Подключений пока нет",
    agentConnectionsEmptyHint:
      "Добавьте OpenAI, Anthropic или совместимый локальный сервер.",
    agentConnectionCreateTitle: "Новое подключение",
    agentConnectionCreateDescription:
      "Ключ будет зашифрован на сервере и не вернётся в браузер после сохранения.",
    agentConnectionSecurityHint:
      "Агенты получают доступ к ключу только во время выполнения запроса.",
    agentConnectionModelUnset: "модель не выбрана",
    agentConnectionHealth_untested: "Не проверено",
    agentConnectionHealth_healthy: "Работает",
    agentConnectionHealth_unhealthy: "Ошибка",
    agentProvider_openai: "OpenAI",
    agentProvider_anthropic: "Anthropic",
    "agentProvider_openai-compatible": "OpenAI-совместимый",
    defaultModel: "Модель по умолчанию",
    agentActivityTitle: "Активность агентов",
    agentActivityDescription:
      "История запусков и ошибок сгруппирована по агентам, чтобы быстрее находить причину.",
    agentMetricPublished: "Опубликовано агентов",
    agentMetricTestRuns: "Тестовых запусков",
    agentMetricTestFailures: "Ошибок в тестах",
    agentMetricTimeToTest: "До первого теста",
    agentMetricTimeToPublish: "До первой публикации",
    agentKnowledgeTitle: "Знания и источники",
    agentKnowledgeDescription:
      "Управляйте данными, на которые агент может опираться в ответах.",
    agentKnowledgeEmpty: "Источники ещё не подключены",
    agentKnowledgeEmptyHint:
      "В следующих срезах здесь появятся чаты, файлы и управляемые базы знаний.",
    agentApprovalsTitle: "Действия на подтверждение",
    agentApprovalsHint:
      "Агент не выполнит эти действия, пока администратор явно их не одобрит.",
    agentApprovalsEmpty: "Нет действий, ожидающих подтверждения.",
    agentTool_post_message: "Отправить сообщение",
    agentTool_reply_in_thread: "Ответить в треде",
    agentTool_add_reaction: "Добавить реакцию",
    agentTool_remember: "Сохранить в памяти агента",
    agentReadiness: "Готовность",
    agentReadinessState_draft: "Черновик",
    agentReadinessState_needs_setup: "Нужна настройка",
    agentReadinessState_ready: "Можно включать",
    agentReadinessState_active: "Работает",
    agentReadinessState_paused: "На паузе",
    agentReadinessState_error: "Требует внимания",
    agentLifecycleTitle: "Публикация и версии",
    agentLifecycleDescription:
      "Черновик можно проверять и менять без влияния на работающего агента.",
    agentDraftVersion: "Черновик v{version}",
    agentPublishedVersion: "Опубликована v{version}",
    agentNeverPublished: "Ещё не публиковался",
    agentPublish: "Опубликовать",
    agentPause: "Поставить на паузу",
    agentResume: "Возобновить",
    agentVersionHistory: "История версий",
    agentRollback: "Создать черновик из этой версии",
    agentPublishedNotice: "Версия опубликована",
    agentPausedNotice: "Агент поставлен на паузу",
    agentResumedNotice: "Агент снова работает",
    agentRollbackNotice: "Черновик подготовлен из выбранной версии",
    needsSetup: "Нужна настройка",
    agentReadiness_chat_required: "Выберите хотя бы один доступный чат.",
    agentReadiness_runtime_key_required:
      "Создайте ключ для системы выполнения.",
    agentReadiness_provider_model_required: "Укажите провайдера и модель.",
    agentReadiness_provider_credential_required:
      "Добавьте ключ LLM-провайдера.",
    agentReadiness_llm_connection_required: "Выберите подключение LLM.",
    agentReadiness_llm_connection_unavailable:
      "Выбранное подключение LLM отключено или удалено.",
    agentReadiness_external_data_approval_required:
      "Подтвердите передачу данных внешнему провайдеру.",
    agentReadiness_trigger_required: "Добавьте хотя бы одно правило запуска.",
    agentSandboxTitle: "Песочница",
    agentSandboxHint:
      "Проверьте инструкцию и доступный контекст до включения автоматических запусков.",
    sandboxPrompt: "Тестовый запрос",
    sandboxPromptPlaceholder: "Например: составь сводку последних решений",
    agentSandboxRun: "Запустить проверку",
    agentSandboxStarting: "Запускаем…",
    agentSandboxResult: "Результат проверки",
    agentTestVersion: "Версия",
    agentTestModel: "Провайдер и модель",
    agentTestTokens: "Токены: вход / выход",
    agentTestCost: "Оценка стоимости",
    agentTestWrites: "Запись данных",
    agentTestWritesBlocked:
      "Заблокирована сервером; показан только предпросмотр",
    agentSaved: "Агент сохранён",
    deleteAgent: "Удалить",
    deleteAgentTitle: "Удалить агента?",
    deleteAgentDescription:
      "Агент {name} будет выключен и удалён из каталога и чатов. Ключи будут отозваны, а история аудита сохранится.",
    deleteAgentConfirm: "Удалить агента",
    createAgent: "Создать агента",
    agentsEmptyTitle: "Создайте первого агента",
    agentsEmptyHint: "Мастер поможет настроить задачу, доступ и запуск.",
    duplicateAgent: "Дублировать",
    agentDuplicated: "Копия создана выключенной и открыта для проверки.",
    copySuffix: "копия",
    resetTemplate: "Сбросить к шаблону",
    resetTemplateTitle: "Сбросить настройки агента?",
    resetTemplateDescription:
      "Агент {name} будет выключен. Инструкция, права, лимиты и правила запуска вернутся к текущей версии шаблона. Секреты и история запусков сохранятся.",
    resetTemplateConfirm: "Сбросить настройки",
    templateResetDone:
      "Настройки и правила запуска восстановлены из новой версии шаблона. Агент выключен до проверки.",
    agentWizardStep: "Шаг {current} из {total}",
    agentWizardTitle: "Новый агент",
    agentWizardPurpose: "Что должен делать агент?",
    agentWizardPurposeHint:
      "Выберите готовый сценарий или начните со своей инструкции.",
    agentWizardAccess: "Где агент сможет работать?",
    agentWizardIdentityRequired: "Укажите имя и адрес агента.",
    agentWizardHandleGenerated:
      "Технический адрес будет создан автоматически. Его можно изменить позже в настройках.",
    agentWizardSources: "Источники",
    agentWizardSourcesHint:
      "Выберите, откуда агент получает контекст, и отдельно укажите место результата.",
    agentWizardDestination: "Куда отправлять результат",
    agentWizardChooseDestination: "Выберите чат",
    agentWizardRecipeDetails: "Как должен работать агент?",
    agentWizardRecipeHint_summarizer:
      "Настройте формат сводки и понятный способ запуска.",
    agentWizardRecipeHint_qa:
      "Определите поведение при отсутствии подтверждённого ответа.",
    agentWizardRecipeHint_onboarding:
      "Выберите тон общения и момент знакомства с новым участником.",
    agentWizardRecipeHint_custom:
      "Опишите результат и ограничения обычным языком.",
    agentWizardInstructions: "Инструкция агенту",
    agentWizardInstructionsRequired: "Опишите, что должен делать агент.",
    agentWizardFallback: "Если ответа нет в источниках",
    agentWizardFallbackDefault:
      "Скажи, что подтверждённого ответа нет, и предложи обратиться к человеку.",
    agentWizardTone: "Тон общения",
    agentWizardToneFriendly: "Дружелюбный",
    agentWizardToneConcise: "Краткий",
    agentWizardToneFormal: "Деловой",
    agentWizardCitations: "Показывать источники",
    agentWizardCitationsHint:
      "Ответ должен ссылаться на сообщения и файлы, на которых он основан.",
    agentWizardInstructionCitations:
      "Всегда указывай идентификаторы сообщений и файлов, подтверждающих результат.",
    agentWizardInstructionFallback: "Если подтверждения нет: {fallback}",
    agentWizardInstructionTone: "Используй тон общения: {tone}.",
    agentWizardLaunch_manual: "Только вручную",
    agentWizardLaunch_mention: "По упоминанию",
    agentWizardLaunch_command: "По команде",
    agentWizardLaunch_schedule: "По расписанию",
    agentWizardLaunch_member_join: "При вступлении участника",
    agentWizardLaunchHint_manual: "Запуск из Test Studio или карточки агента",
    agentWizardLaunchHint_mention: "Когда агента упомянули в доступном чате",
    agentWizardLaunchHint_command:
      "Когда сообщение начинается с заданной команды",
    agentWizardLaunchHint_schedule: "Регулярно в заданное местное время",
    agentWizardLaunchHint_member_join:
      "После добавления нового участника в пространство",
    agentWizardCommand: "Команда после символа /",
    agentWizardScheduleTime: "Время запуска",
    agentWizardConnection: "Подключение и политика данных",
    agentWizardConnectionHint:
      "Выберите модель пространства. Без подключения черновик сохранится, но его нельзя будет опубликовать.",
    agentWizardExternalData: "Разрешить передачу данных модели",
    agentWizardExternalDataHint:
      "Выбранные сообщения и файлы могут быть отправлены внешнему LLM-провайдеру.",
    agentWizardReview: "Проверьте границы агента",
    agentWizardReviewHint:
      "После создания откроется безопасный тест. Рабочая версия не запустится до публикации.",
    agentWizardTask: "Задача",
    agentWizardWhen: "Запуск",
    agentWizardSafeStart:
      "Автоматические действия начнутся только после завершения настройки и включения агента.",
    agentTemplateShort_summarizer: "Сводки решений и следующих шагов",
    agentTemplateShort_qa: "Ответы со ссылками на историю и файлы",
    agentTemplateShort_onboarding: "Помощь новым участникам пространства",
    agentTemplateShort_custom: "Своя инструкция и ручной запуск",
    agentTemplate_custom: "Новый агент",
    agentTemplate_summarizer: "Сводки",
    agentTemplate_qa: "Ответы по истории",
    agentTemplate_onboarding: "Адаптация",
    agentTemplateDescription_summarizer:
      "Составляй краткие сводки чатов и тредов: решения, открытые вопросы и следующие действия. Ссылайся на сообщения и не выдумывай факты.",
    agentTemplateDescription_qa:
      "Отвечай по доступной истории пространства и извлечённому содержимому файлов. Сначала ищи источники, ссылайся на них и отделяй факты от выводов.",
    agentTemplateDescription_onboarding:
      "Помогай новым участникам освоиться: объясняй устройство пространства по доступной истории и файлам, указывай источники и не раскрывай закрытые чаты.",
    agentIdentity: "Профиль и модель",
    agentIdentityHint: "Публичный профиль агента и его основная инструкция.",
    agentAdvanced: "Расширенные настройки",
    agentAdvancedHint:
      "Провайдер, технические разрешения, бюджет и ограничения выполнения.",
    agentProviderSettings: "Модель и передача данных",
    agentProviderSettingsHint:
      "Эти параметры нужны для собственного или нестандартного LLM-подключения.",
    agentInstructions: "Инструкция агента",
    agentEnabled: "Агент включён",
    agentEnabledHint:
      "Правила запуска и новые запуски работают только у включённого агента.",
    externalDataSharing: "Разрешить передачу данных провайдеру",
    externalDataSharingHint:
      "Без этого система выполнения не отправит сообщения и файлы внешней языковой модели.",
    agentPermissions: "Разрешения",
    agentPermissionsHint:
      "Итоговый доступ ограничен этими разрешениями, ключом API и участием агента в чатах.",
    agentChats: "Доступные чаты",
    agentChatsHint:
      "Агент видит только чаты, в которых он является участником.",
    agentLimits: "Лимиты и бюджет",
    agentLimitsHint:
      "Ограничения проверяются до обращения к внешнему провайдеру.",
    dailyBudget: "Дневной бюджет, в долларах",
    monthlyBudget: "Месячный бюджет, в долларах",
    maxOutputTokens: "Максимум токенов ответа",
    maxToolIterations: "Максимум вызовов инструментов",
    perChatConcurrency: "Параллельность на чат",
    rateLimit: "Запросов в минуту",
    executionTimeout: "Максимальное время запуска, секунд",
    agentUsage: "Использование",
    agentUsageHint: "Сводка стоимости, токенов и запусков за период по UTC.",
    agentTriggers: "Правила запуска",
    agentTriggersHint:
      "Запускайте агента по упоминаниям, командам, ключевым словам, событиям или расписанию.",
    agentTrigger_manual: "Только вручную",
    agentTrigger_mention: "Упоминание агента",
    agentTrigger_command: "Команда",
    agentTrigger_keyword: "Ключевое слово",
    agentTrigger_every_message: "Каждое сообщение",
    agentTrigger_schedule: "Расписание",
    agentTrigger_event: "Событие пространства",
    agentTriggerMentionHint: "Срабатывает при упоминании агента",
    agentTriggerEveryMessageHint: "Срабатывает на каждое новое сообщение",
    agentTriggerEventHint: "Настроенное событие пространства",
    agentRuns: "История запусков",
    agentRunsHint: "Статус, идентификатор запроса, ошибки и детали запуска.",
    agentRunStatus_queued: "В очереди",
    agentRunStatus_running: "Выполняется",
    agentRunStatus_completed: "Завершён",
    agentRunStatus_failed: "Ошибка",
    agentRunStatus_canceled: "Отменён",
    agentRunStatus_timed_out: "Превышено время ожидания",
    runStatus: "Статус запуска",
    correlationID: "Идентификатор запроса",
    agentRunError_provider_credential_missing:
      "Не добавлен ключ LLM-провайдера. Откройте «Подключения» и добавьте его.",
    agentRunError_external_data_sharing_required:
      "Передача данных провайдеру не разрешена. Включите её в расширенных настройках.",
    agentRunError_budget_exceeded:
      "Исчерпан бюджет агента. Увеличьте лимит или дождитесь нового периода.",
    agentRunError_agent_provider_rate_limited:
      "Слишком много обращений к модели. Запуск можно повторить позже.",
    agentRunError_provider_retryable:
      "Провайдер временно недоступен. Система попробует ещё раз.",
    agentRunError_provider_output_truncated:
      "Ответ модели не поместился в лимит. Увеличьте максимум токенов.",
    agentRunError_tool_iteration_limit:
      "Агент сделал слишком много шагов с инструментами. Проверьте инструкцию или лимит.",
    agentRunError_empty_provider_output:
      "Модель вернула пустой ответ. Проверьте модель и инструкцию.",
    agentRunError_run_timeout:
      "Агент не успел завершить работу. Увеличьте максимальное время запуска.",
    agentRunError_lease_expired:
      "Среда выполнения потеряла запуск. Проверьте её подключение.",
    agentRunError_run_canceled: "Запуск был отменён.",
    agentRunError_unknown:
      "Запуск завершился с ошибкой. Откройте аудит или повторите после проверки подключения.",
    agentCredentials: "Ключи и учётные данные",
    agentCredentialsHint:
      "Ключ провайдера хранится зашифрованным; ключ среды выполнения показывается только один раз.",
    providerKey: "API-ключ провайдера",
    createRuntimeKey: "Создать ключ среды выполнения",
    createWorkspaceWorkerKey: "Создать ключ worker пространства",
    workspaceWorkerKeyHint:
      "Один такой ключ позволяет среде выполнения обслуживать всех агентов пространства. Действия всё равно ограничены настройками и активным запуском каждого агента.",
    copySecretNow: "Скопируйте секрет сейчас — повторно он не показывается.",
    agentScope_chats_read: "Чтение списка чатов",
    agentScope_messages_read: "Чтение сообщений",
    agentScope_messages_write: "Отправка сообщений",
    agentScope_reactions_write: "Добавление реакций",
    agentScope_files_read: "Чтение файлов",
    agentScope_search_read: "Поиск по пространству",
    agentScope_members_read: "Чтение списка участников",
    agentScope_memory_read: "Чтение памяти агента",
    agentScope_memory_write: "Запись в память агента",
    agentScope_runtime_execute: "Запуск агента",
    agentScope_runtime_worker: "Запуск агентов пространства",
    agentTemplateChatRequired:
      "Для встроенного агента выберите хотя бы один чат.",
  },
  {
    agentPlatformHint:
      "Create, test, and observe agents in one dedicated workspace.",
    agentPlatformNavigation: "Agent platform sections",
    agentDetailNavigation: "Agent configuration",
    agentTab_overview: "Overview",
    agentTab_sandbox: "Sandbox",
    agentTab_approvals: "Approvals",
    agentTab_runs: "Runs",
    agentTab_connections: "Connections",
    agentTab_activity: "Activity",
    agentTab_behavior: "Behavior",
    agentTab_knowledge: "Knowledge",
    agentTab_automations: "Automations",
    agentTab_test: "Test",
    agentTab_settings: "Settings",
    agentConnectionsTitle: "LLM connections",
    agentConnectionsDescription:
      "Connect a provider once and reuse it across agents without copying credentials.",
    agentConnectionAdd: "Add connection",
    agentConnectionChoose: "Select a connection",
    agentConnectionChooseLater: "Connect later",
    agentUsesWorkspaceConnection:
      "The provider key is stored in the workspace connection and is not duplicated in this agent.",
    agentConnectionsEmpty: "No connections yet",
    agentConnectionsEmptyHint:
      "Add OpenAI, Anthropic, or an OpenAI-compatible local server.",
    agentConnectionCreateTitle: "New connection",
    agentConnectionCreateDescription:
      "The key is encrypted on the server and is never returned to the browser after saving.",
    agentConnectionSecurityHint:
      "Agents can access the key only while executing a provider request.",
    agentConnectionModelUnset: "model not selected",
    agentConnectionHealth_untested: "Untested",
    agentConnectionHealth_healthy: "Healthy",
    agentConnectionHealth_unhealthy: "Error",
    agentProvider_openai: "OpenAI",
    agentProvider_anthropic: "Anthropic",
    "agentProvider_openai-compatible": "OpenAI-compatible",
    defaultModel: "Default model",
    agentActivityTitle: "Agent activity",
    agentActivityDescription:
      "Runs and errors are grouped by agent so you can find the cause faster.",
    agentMetricPublished: "Published agents",
    agentMetricTestRuns: "Test runs",
    agentMetricTestFailures: "Failed tests",
    agentMetricTimeToTest: "Time to first test",
    agentMetricTimeToPublish: "Time to first publish",
    agentKnowledgeTitle: "Knowledge and sources",
    agentKnowledgeDescription:
      "Manage the data an agent is allowed to use in its answers.",
    agentKnowledgeEmpty: "No sources connected yet",
    agentKnowledgeEmptyHint:
      "Chats, files, and managed knowledge bases will appear here in the next slices.",
    agentApprovalsTitle: "Actions awaiting approval",
    agentApprovalsHint:
      "The agent will not execute these actions until an administrator explicitly approves them.",
    agentApprovalsEmpty: "No actions are awaiting approval.",
    agentTool_post_message: "Post a message",
    agentTool_reply_in_thread: "Reply in a thread",
    agentTool_add_reaction: "Add a reaction",
    agentTool_remember: "Save to agent memory",
    agentReadiness: "Readiness",
    agentReadinessState_draft: "Draft",
    agentReadinessState_needs_setup: "Needs setup",
    agentReadinessState_ready: "Ready to enable",
    agentReadinessState_active: "Running",
    agentReadinessState_paused: "Paused",
    agentReadinessState_error: "Needs attention",
    agentLifecycleTitle: "Publishing and versions",
    agentLifecycleDescription:
      "You can test and edit a draft without changing the running agent.",
    agentDraftVersion: "Draft v{version}",
    agentPublishedVersion: "Published v{version}",
    agentNeverPublished: "Not published yet",
    agentPublish: "Publish",
    agentPause: "Pause",
    agentResume: "Resume",
    agentVersionHistory: "Version history",
    agentRollback: "Create draft from this version",
    agentPublishedNotice: "Version published",
    agentPausedNotice: "Agent paused",
    agentResumedNotice: "Agent resumed",
    agentRollbackNotice: "Draft prepared from the selected version",
    needsSetup: "Needs setup",
    agentReadiness_chat_required: "Select at least one accessible chat.",
    agentReadiness_runtime_key_required: "Create a runtime key.",
    agentReadiness_provider_model_required: "Choose a provider and model.",
    agentReadiness_provider_credential_required: "Add an LLM provider key.",
    agentReadiness_llm_connection_required: "Select an LLM connection.",
    agentReadiness_llm_connection_unavailable:
      "The selected LLM connection is disabled or missing.",
    agentReadiness_external_data_approval_required:
      "Approve sharing data with the external provider.",
    agentReadiness_trigger_required: "Add at least one trigger.",
    agentSandboxTitle: "Sandbox",
    agentSandboxHint:
      "Test instructions and accessible context before enabling automatic triggers.",
    sandboxPrompt: "Test prompt",
    sandboxPromptPlaceholder: "For example: summarize the latest decisions",
    agentSandboxRun: "Run test",
    agentSandboxStarting: "Starting…",
    agentSandboxResult: "Test result",
    agentTestVersion: "Version",
    agentTestModel: "Provider and model",
    agentTestTokens: "Tokens: input / output",
    agentTestCost: "Estimated cost",
    agentTestWrites: "Data writes",
    agentTestWritesBlocked: "Blocked by the server; preview only",
    agentSaved: "Agent saved",
    deleteAgent: "Delete",
    deleteAgentTitle: "Delete agent?",
    deleteAgentDescription:
      "Agent {name} will be disabled and removed from the catalog and chats. Keys will be revoked while audit history is retained.",
    deleteAgentConfirm: "Delete agent",
    createAgent: "Create agent",
    agentsEmptyTitle: "Create your first agent",
    agentsEmptyHint:
      "The wizard will guide you through task, access, and launch.",
    duplicateAgent: "Duplicate",
    agentDuplicated: "A disabled copy was created and opened for review.",
    copySuffix: "copy",
    resetTemplate: "Reset to template",
    resetTemplateTitle: "Reset agent settings?",
    resetTemplateDescription:
      "Agent {name} will be disabled. Instructions, permissions, limits, and triggers will return to the current template version. Secrets and run history will be preserved.",
    resetTemplateConfirm: "Reset settings",
    templateResetDone:
      "Settings and triggers were restored from a new template version. The agent is disabled until reviewed.",
    agentWizardStep: "Step {current} of {total}",
    agentWizardTitle: "New agent",
    agentWizardPurpose: "What should the agent do?",
    agentWizardPurposeHint:
      "Choose a ready-made workflow or start with your own instructions.",
    agentWizardAccess: "Where can the agent work?",
    agentWizardIdentityRequired: "Enter the agent name and handle.",
    agentWizardHandleGenerated:
      "The technical handle is generated automatically and can be changed later in settings.",
    agentWizardSources: "Sources",
    agentWizardSourcesHint:
      "Choose where the agent gets context and select the result destination separately.",
    agentWizardDestination: "Result destination",
    agentWizardChooseDestination: "Choose a chat",
    agentWizardRecipeDetails: "How should the agent work?",
    agentWizardRecipeHint_summarizer:
      "Configure the digest format and a clear launch method.",
    agentWizardRecipeHint_qa:
      "Define what happens when no grounded answer is available.",
    agentWizardRecipeHint_onboarding:
      "Choose the voice and when to greet a new member.",
    agentWizardRecipeHint_custom:
      "Describe the desired result and boundaries in plain language.",
    agentWizardInstructions: "Agent instructions",
    agentWizardInstructionsRequired: "Describe what the agent should do.",
    agentWizardFallback: "When the sources do not contain an answer",
    agentWizardFallbackDefault:
      "Say that no grounded answer was found and suggest contacting a person.",
    agentWizardTone: "Voice",
    agentWizardToneFriendly: "Friendly",
    agentWizardToneConcise: "Concise",
    agentWizardToneFormal: "Professional",
    agentWizardCitations: "Show sources",
    agentWizardCitationsHint:
      "The response must cite the messages and files it is based on.",
    agentWizardInstructionCitations:
      "Always include the message and file identifiers that support the result.",
    agentWizardInstructionFallback: "When evidence is unavailable: {fallback}",
    agentWizardInstructionTone: "Use this voice: {tone}.",
    agentWizardLaunch_manual: "Manual only",
    agentWizardLaunch_mention: "On mention",
    agentWizardLaunch_command: "On command",
    agentWizardLaunch_schedule: "On schedule",
    agentWizardLaunch_member_join: "When a member joins",
    agentWizardLaunchHint_manual: "Run from Test Studio or the agent card",
    agentWizardLaunchHint_mention:
      "When the agent is mentioned in an accessible chat",
    agentWizardLaunchHint_command:
      "When a message begins with the configured command",
    agentWizardLaunchHint_schedule: "Run regularly at the selected local time",
    agentWizardLaunchHint_member_join:
      "After a new member is added to the workspace",
    agentWizardCommand: "Command after /",
    agentWizardScheduleTime: "Run time",
    agentWizardConnection: "Connection and data policy",
    agentWizardConnectionHint:
      "Choose a workspace model. A draft can be saved without one, but it cannot be published.",
    agentWizardExternalData: "Allow data sharing with the model",
    agentWizardExternalDataHint:
      "Selected messages and files may be sent to the external LLM provider.",
    agentWizardReview: "Review the agent boundaries",
    agentWizardReviewHint:
      "A safe test opens next. The working version cannot run until it is published.",
    agentWizardTask: "Task",
    agentWizardWhen: "Launch",
    agentWizardSafeStart:
      "Automatic actions start only after setup is complete and you enable the agent.",
    agentTemplateShort_summarizer: "Summaries of decisions and next actions",
    agentTemplateShort_qa: "Answers grounded in history and files",
    agentTemplateShort_onboarding: "Guidance for new workspace members",
    agentTemplateShort_custom: "Custom instructions and manual runs",
    agentTemplate_custom: "New agent",
    agentTemplate_summarizer: "Summarizer",
    agentTemplate_qa: "History Q&A",
    agentTemplate_onboarding: "Onboarding",
    agentTemplateDescription_summarizer:
      "Summarize chats and threads with decisions, open questions, and next actions. Cite messages and never invent facts.",
    agentTemplateDescription_qa:
      "Answer from accessible workspace history and extracted file contents. Search first, cite sources, and distinguish evidence from inference.",
    agentTemplateDescription_onboarding:
      "Help new members get oriented using accessible history and files, cite sources, and never expose private chats.",
    agentIdentity: "Profile and model",
    agentIdentityHint:
      "The agent's public identity and trusted runtime instruction.",
    agentAdvanced: "Advanced settings",
    agentAdvancedHint:
      "Provider, technical permissions, budgets, and execution limits.",
    agentProviderSettings: "Model and data sharing",
    agentProviderSettingsHint:
      "Use these options for self-hosted or non-standard LLM connections.",
    agentInstructions: "Agent instruction",
    agentEnabled: "Agent enabled",
    agentEnabledHint:
      "New triggers and runs are allowed only while the agent is enabled.",
    externalDataSharing: "Allow provider data sharing",
    externalDataSharingHint:
      "Without this, runtime will not send messages or files to an external LLM.",
    agentPermissions: "Scopes",
    agentPermissionsHint:
      "Effective access is the intersection of these scopes, API key and membership.",
    agentChats: "Accessible chats",
    agentChatsHint: "The agent can see only chats where it is a member.",
    agentLimits: "Limits and budget",
    agentLimitsHint: "Limits are enforced before an external provider call.",
    dailyBudget: "Daily budget, USD",
    monthlyBudget: "Monthly budget, USD",
    maxOutputTokens: "Maximum output tokens",
    maxToolIterations: "Maximum tool iterations",
    perChatConcurrency: "Per-chat concurrency",
    rateLimit: "Requests per minute",
    executionTimeout: "Maximum run time, seconds",
    agentUsage: "Usage",
    agentUsageHint: "UTC summary of cost, tokens and runs.",
    agentTriggers: "Triggers",
    agentTriggersHint:
      "Events, commands, mentions and schedules run durably and idempotently.",
    agentTrigger_manual: "Manual only",
    agentTrigger_mention: "Agent mention",
    agentTrigger_command: "Command",
    agentTrigger_keyword: "Keyword",
    agentTrigger_every_message: "Every message",
    agentTrigger_schedule: "Schedule",
    agentTrigger_event: "Workspace event",
    agentTriggerMentionHint: "Runs when the agent is mentioned",
    agentTriggerEveryMessageHint: "Runs for every new message",
    agentTriggerEventHint: "Configured workspace event",
    agentRuns: "Run history",
    agentRunsHint: "Status, correlation ID, errors and technical run details.",
    agentRunStatus_queued: "Queued",
    agentRunStatus_running: "Running",
    agentRunStatus_completed: "Completed",
    agentRunStatus_failed: "Failed",
    agentRunStatus_canceled: "Canceled",
    agentRunStatus_timed_out: "Timed out",
    runStatus: "Run status",
    correlationID: "Correlation ID",
    agentRunError_provider_credential_missing:
      "No LLM provider key is configured. Add one under Connections.",
    agentRunError_external_data_sharing_required:
      "Provider data sharing is disabled. Enable it under Advanced settings.",
    agentRunError_budget_exceeded:
      "The agent budget is exhausted. Increase the limit or wait for the next period.",
    agentRunError_agent_provider_rate_limited:
      "The model is receiving too many requests. Try the run again later.",
    agentRunError_provider_retryable:
      "The provider is temporarily unavailable. The system will retry.",
    agentRunError_provider_output_truncated:
      "The response exceeded the output limit. Increase maximum output tokens.",
    agentRunError_tool_iteration_limit:
      "The agent used too many tool steps. Review its instructions or limit.",
    agentRunError_empty_provider_output:
      "The model returned an empty response. Check the model and instructions.",
    agentRunError_run_timeout:
      "The agent did not finish in time. Increase the maximum run time.",
    agentRunError_lease_expired:
      "The runtime lost this run. Check its connection.",
    agentRunError_run_canceled: "The run was canceled.",
    agentRunError_unknown:
      "The run failed. Check the audit log or retry after checking the connection.",
    agentCredentials: "Keys and credential",
    agentCredentialsHint:
      "Provider key is encrypted; runtime API keys are shown once.",
    providerKey: "Provider API key",
    createRuntimeKey: "Create runtime key",
    createWorkspaceWorkerKey: "Create workspace worker key",
    workspaceWorkerKeyHint:
      "One key lets the runtime serve every agent in this workspace. Each action remains limited by the target agent settings and its active run.",
    copySecretNow: "Copy the secret now — it cannot be shown again.",
    agentScope_chats_read: "Read chat list",
    agentScope_messages_read: "Read messages",
    agentScope_messages_write: "Send messages",
    agentScope_reactions_write: "Add reactions",
    agentScope_files_read: "Read files",
    agentScope_search_read: "Search workspace",
    agentScope_members_read: "Read member list",
    agentScope_memory_read: "Read agent memory",
    agentScope_memory_write: "Write agent memory",
    agentScope_runtime_execute: "Run agent",
    agentScope_runtime_worker: "Run workspace agents",
    agentTemplateChatRequired: "Select at least one chat for a built-in agent.",
  },
);
