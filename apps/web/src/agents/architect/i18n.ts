import { defineCatalog } from "../../i18n/catalog";

/* The agent Architect: conversation and passport (phase 5.3 I). */
export const architectCatalog = defineCatalog(
  {
    architectCreate: "Создать с Архитектором",
    architectEditExisting: "Изменить через Архитектора",
    architectTitle: "Архитектор агентов",
    architectLead: "Собирает агента из разговора",
    architectLeadExisting: "Правит черновик «{name}»",
    architectRestart: "Начать заново",
    architectBack: "К агентам",
    architectThinking: "Архитектор думает…",
    architectInputLabel: "Ваш ответ",
    architectInputPlaceholder: "Или напишите свой ответ…",
    architectSend: "Отправить",
    architectYou: "Вы",
    architectQuestionsLeft:
      "{count, plural, =0 {Вопросов больше не будет — Архитектор соберёт черновик} one {Остался # уточняющий вопрос} few {Осталось # уточняющих вопроса} other {Осталось # уточняющих вопросов}}",
    architectAssumptions: "Что я предположил сам",
    architectExamplesTitle: "Проверка на примерах",
    architectExamplesHint:
      "Проверка идёт в песочнице: в чат ничего не отправится, пока вы не опубликуете агента.",
    architectExpectation: "Хороший ответ: {text}",
    architectCheck: "Проверить",
    architectChecking: "Проверяю…",
    architectOpenBuilder: "Открыть в конструкторе",
    architectNoConnectionTitle: "Сначала подключите модель",
    architectNoConnectionText:
      "Архитектор разговаривает через языковую модель пространства. Подключите её один раз — потом она же будет работать в агентах.",
    architectNoConnectionAction: "Перейти к подключениям",
    architectNoConnectionAsk:
      "Подключения настраивает администратор интеграций. Попросите его подключить модель.",
    architectModelError:
      "Модель не ответила. Сообщение не потерялось — отправьте его ещё раз.",
    architectBudgetError:
      "Достигнут лимит расходов Архитектора. Попробуйте позже.",
    architectBusyError: "Архитектор ещё отвечает на предыдущее сообщение.",
    architectExpired:
      "Разговор устарел: прошли сутки без сообщений. Черновик сохранён — начните новый разговор.",
    architectClosed: "Разговор закончен.",
    architectRetry: "Повторить",
    architectDataNote:
      "Разговор, названия чатов и коллекций уходят в модель подключения «{name}».",
    architectUsage: "Разговор стоил {cost}",
    passportTitle: "Паспорт агента",
    passportLead: "Здесь ровно то, что записано в черновике",
    passportEmpty: "Архитектор спросит об этом",
    passportWho: "Кто он",
    passportKnows: "Что знает",
    passportCan: "Что умеет",
    passportWhen: "Когда включается",
    passportWhere: "Где работает",
    passportModel: "Модель и данные",
    passportOnlyReads: "Только читает переписку своих чатов",
    passportKnowledge: "База знаний: {names}",
    passportHiddenItems:
      "{count, plural, one {и ещё # недоступный вам} few {и ещё # недоступных вам} other {и ещё # недоступных вам}}",
    passportModelText: "Подключение «{name}» · {model}",
    passportApprovalNeeded:
      "Перед публикацией подтвердите в конструкторе, что данные можно отправлять во внешнюю модель.",
    passportApproved: "Передача данных во внешнюю модель подтверждена.",
    passportRights:
      "Права выведены из задачи: агент может только то, что перечислено выше. Опубликовать его может только человек — в конструкторе.",
    passportToggle: "Паспорт агента",
    passportProgress: "Заполнено {done} из {total}",
  },
  {
    architectCreate: "Create with the Architect",
    architectEditExisting: "Change with the Architect",
    architectTitle: "Agent Architect",
    architectLead: "Builds an agent from a conversation",
    architectLeadExisting: "Editing the draft of “{name}”",
    architectRestart: "Start over",
    architectBack: "To agents",
    architectThinking: "The Architect is thinking…",
    architectInputLabel: "Your answer",
    architectInputPlaceholder: "Or write your own answer…",
    architectSend: "Send",
    architectYou: "You",
    architectQuestionsLeft:
      "{count, plural, =0 {No more questions — the Architect will assemble the draft} one {# clarifying question left} other {# clarifying questions left}}",
    architectAssumptions: "What I assumed myself",
    architectExamplesTitle: "Check on examples",
    architectExamplesHint:
      "The check runs in a sandbox: nothing is sent to chats until you publish the agent.",
    architectExpectation: "A good answer: {text}",
    architectCheck: "Check",
    architectChecking: "Checking…",
    architectOpenBuilder: "Open in the builder",
    architectNoConnectionTitle: "Connect a model first",
    architectNoConnectionText:
      "The Architect talks through the workspace language model. Connect it once — agents will use the same connection.",
    architectNoConnectionAction: "Go to connections",
    architectNoConnectionAsk:
      "Connections are set up by the integrations administrator. Ask them to connect a model.",
    architectModelError:
      "The model did not answer. Your message is kept — send it again.",
    architectBudgetError:
      "The Architect's spending limit was reached. Try again later.",
    architectBusyError:
      "The Architect is still answering the previous message.",
    architectExpired:
      "The conversation has expired after a day without messages. The draft is saved — start a new conversation.",
    architectClosed: "The conversation is over.",
    architectRetry: "Retry",
    architectDataNote:
      "The conversation and the names of chats and collections go to the model of the “{name}” connection.",
    architectUsage: "This conversation cost {cost}",
    passportTitle: "Agent passport",
    passportLead: "Exactly what is saved in the draft",
    passportEmpty: "The Architect will ask about it",
    passportWho: "Who it is",
    passportKnows: "What it knows",
    passportCan: "What it can do",
    passportWhen: "When it starts",
    passportWhere: "Where it works",
    passportModel: "Model and data",
    passportOnlyReads: "Only reads the conversation in its chats",
    passportKnowledge: "Knowledge base: {names}",
    passportHiddenItems:
      "{count, plural, one {and # more not available to you} other {and # more not available to you}}",
    passportModelText: "Connection “{name}” · {model}",
    passportApprovalNeeded:
      "Before publishing, confirm in the builder that data may be sent to an external model.",
    passportApproved: "Sending data to the external model is confirmed.",
    passportRights:
      "Rights follow from the task: the agent can do only what is listed above. Only a person can publish it, in the builder.",
    passportToggle: "Agent passport",
    passportProgress: "{done} of {total} filled in",
  },
);
