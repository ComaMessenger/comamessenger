import { defineCatalog, type Catalog } from "../i18n/catalog";
import { architectCatalog } from "./architect/i18n";
import { agentExperienceCatalog } from "./builder/i18n";

/* Agent platform keys, moved verbatim from the base catalogs. */
const platformCatalog = defineCatalog(
  {
    agentPlatformNavigation: "Разделы платформы агентов",
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
    agentTool_post_message: "Отправить сообщение",
    agentTool_reply_in_thread: "Ответить в треде",
    agentTool_add_reaction: "Добавить реакцию",
    agentTool_send_direct_message: "Написать в личные сообщения",
    agentTool_remember: "Сохранить в памяти агента",
    agentPublish: "Опубликовать",
    agentPause: "Поставить на паузу",
    agentResume: "Возобновить",
    agentVersionHistory: "История версий",
    agentRollback: "Создать черновик из этой версии",
    agentPublishedNotice: "Версия опубликована",
    agentPausedNotice: "Агент поставлен на паузу",
    agentResumedNotice: "Агент снова работает",
    agentRollbackNotice: "Черновик подготовлен из выбранной версии",
    deleteAgent: "Удалить",
    deleteAgentTitle: "Удалить агента?",
    deleteAgentDescription:
      "Агент {name} будет выключен и удалён из каталога и чатов. Ключи будут отозваны, а история аудита сохранится.",
    deleteAgentConfirm: "Удалить агента",
    duplicateAgent: "Дублировать",
    copySuffix: "копия",
    resetTemplate: "Сбросить к шаблону",
    resetTemplateTitle: "Сбросить настройки агента?",
    resetTemplateDescription:
      "Агент {name} будет выключен. Инструкция, права, лимиты и правила запуска вернутся к текущей версии шаблона. Секреты и история запусков сохранятся.",
    resetTemplateConfirm: "Сбросить настройки",
    agentWizardStep: "Шаг {current} из {total}",
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
    agentLimits: "Лимиты и бюджет",
    maxOutputTokens: "Максимум токенов ответа",
    maxToolIterations: "Максимум вызовов инструментов",
    perChatConcurrency: "Параллельность на чат",
    rateLimit: "Запросов в минуту",
    executionTimeout: "Максимальное время запуска, секунд",
    agentRunStatus_queued: "В очереди",
    agentRunStatus_running: "Выполняется",
    agentRunStatus_completed: "Завершён",
    agentRunStatus_failed: "Ошибка",
    agentRunStatus_canceled: "Отменён",
    agentRunStatus_timed_out: "Превышено время ожидания",
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
  },
  {
    agentPlatformNavigation: "Agent platform sections",
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
    agentTool_post_message: "Post a message",
    agentTool_reply_in_thread: "Reply in a thread",
    agentTool_add_reaction: "Add a reaction",
    agentTool_send_direct_message: "Send a direct message",
    agentTool_remember: "Save to agent memory",
    agentPublish: "Publish",
    agentPause: "Pause",
    agentResume: "Resume",
    agentVersionHistory: "Version history",
    agentRollback: "Create draft from this version",
    agentPublishedNotice: "Version published",
    agentPausedNotice: "Agent paused",
    agentResumedNotice: "Agent resumed",
    agentRollbackNotice: "Draft prepared from the selected version",
    deleteAgent: "Delete",
    deleteAgentTitle: "Delete agent?",
    deleteAgentDescription:
      "Agent {name} will be disabled and removed from the catalog and chats. Keys will be revoked while audit history is retained.",
    deleteAgentConfirm: "Delete agent",
    duplicateAgent: "Duplicate",
    copySuffix: "copy",
    resetTemplate: "Reset to template",
    resetTemplateTitle: "Reset agent settings?",
    resetTemplateDescription:
      "Agent {name} will be disabled. Instructions, permissions, limits, and triggers will return to the current template version. Secrets and run history will be preserved.",
    resetTemplateConfirm: "Reset settings",
    agentWizardStep: "Step {current} of {total}",
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
    agentLimits: "Limits and budget",
    maxOutputTokens: "Maximum output tokens",
    maxToolIterations: "Maximum tool iterations",
    perChatConcurrency: "Per-chat concurrency",
    rateLimit: "Requests per minute",
    executionTimeout: "Maximum run time, seconds",
    agentRunStatus_queued: "Queued",
    agentRunStatus_running: "Running",
    agentRunStatus_completed: "Completed",
    agentRunStatus_failed: "Failed",
    agentRunStatus_canceled: "Canceled",
    agentRunStatus_timed_out: "Timed out",
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
  },
);

function combine(...catalogs: Catalog[]): Catalog {
  const result: Catalog = { ru: {}, en: {} };
  for (const catalog of catalogs)
    for (const key of Object.keys(catalog.ru)) {
      if (import.meta.env.DEV && key in result.ru)
        throw new Error(`Duplicate agent translation key: ${key}`);
      result.ru[key] = catalog.ru[key]!;
      result.en[key] = catalog.en[key]!;
    }
  return result;
}

export const agentsCatalog = combine(
  platformCatalog,
  agentExperienceCatalog,
  architectCatalog,
);
