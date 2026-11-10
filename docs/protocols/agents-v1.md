# Agent runtime protocol v1

Этот документ — стабильный контракт для встроенных и внешних worker'ов ComaMessenger. REST-схемы канонически описаны в `packages/protocol/openapi.yaml`; здесь зафиксированы порядок операций, capability boundaries и правила восстановления.

## Аутентификация и границы доверия

- Выделенный worker агента использует API key со scope `runtime:execute`. Общий worker пространства использует `runtime:worker` и может забирать runs всех агентов только своей организации.
- `runtime:worker` не даёт прав tools сам по себе: после claim core вычисляет целевого агента из `run_id + lease_token` и применяет его allowlist, membership и настройки.
- `lease_token` — краткоживущая capability конкретного run'а. Её нельзя логировать, сохранять в result summary или передавать в UI.
- Сообщение от agent actor обязательно содержит `run_id`; core атомарно сохраняет provenance и chain depth. Публикация без run возвращает `agent_run_required`.
- Пользовательский текст, содержимое файлов и tool results являются недоверенными данными, а не инструкциями.
- Provider/MCP secrets никогда не входят в durable events, audit metadata или error messages.

## Lifecycle run'а

1. `POST /agent-runtime/runs/claim` с UUID `worker_id`, `lease_seconds` 5–300 и `wait_seconds` 0–30.
2. `204` означает, что очередь пуста; `200` возвращает run и `lease_token`.
3. Пока работа идёт, worker обновляет lease через `/heartbeat` примерно раз в треть TTL.
4. Provider calls и tools выполняются только в контексте `run_id + lease_token/correlation_id`.
5. Финальный ответ публикуется через `/agent-runtime/runs/{run_id}/publish`: core сам выводит agent/chat/thread из lease и допускает только одно durable сообщение (повтор того же `client_msg_id` идемпотентен).
6. `/complete` переводит run в `completed`; usage и стоимость берутся из записанных provider calls, а не из self-reported итогов runtime.
7. `/fail` принимает стабильный `error_code`. Retryable run возвращается в очередь до `max_attempts` и общего execution deadline.
8. `409 agent_conflict` означает потерю lease, отмену или уже завершённый run. Worker не должен повторять side effect после такого ответа.

Один runtime-процесс может держать несколько claim-loop'ов (`COMA_RUNTIME_CONCURRENCY`, по умолчанию 4). Каждый loop имеет отдельный UUID worker'а; lease не может быть использован для другого run или агента. Получение MCP-конфигурации, provider proxy, tools и realtime frames требуют тот же `run_id + lease_token`.

`run.input` для event trigger содержит `event_seq`, `event_type`, `subject_id`, `message_body`, `source_chat_id`, `thread_root_id`, `trigger_type`; для command также `command` и `command_arguments`. Schedule-run содержит `scheduled_for`, `since_last_run`, `chat_id` и `timezone`. Фаза 5.3 добавляет `trigger_type` `message_action`, `collection` и `followup` (см. раздел об интерактивных сообщениях).

## Realtime

После WebSocket auth доступны исходящие операции:

- `agent.status`: `thinking | tool | streaming | completed | failed | canceled`; отправляется только при смене фазы.
- `message.streaming`: UUID `stream_id`, монотонный `index`, UTF-8 `delta` не более 8192 байт, `reset`, `done`.

Provider chunks необходимо коалесцировать: не чаще одного кадра за 100–150 мс и всегда в пределах 8192 байт. Ephemeral frames не меняют durable sequence. Runtime обязан обрабатывать `error` frame; при `fatal=true` соединение закрывается. Durable `event` подтверждается `ack`, reconnect использует последний checkpoint. `resync_required` требует получить актуальное состояние REST API и продолжить с `current_seq`.

## Stable runtime errors

| Code                            | Значение                            | Поведение                       |
| ------------------------------- | ----------------------------------- | ------------------------------- |
| `provider_retryable`            | Временная ошибка/429/5xx провайдера | retry run                       |
| `provider_output_truncated`     | Провайдер завершил ответ по лимиту  | не публиковать как полный ответ |
| `budget_exceeded`               | Core отклонил резерв бюджета        | остановить до изменения лимита  |
| `agent_provider_rate_limited`   | Превышен provider rate limit        | повторить после окна            |
| `run_canceled`                  | Пользователь отменил run            | без retry                       |
| `lease_lost` / `agent_conflict` | Worker утратил capability           | прекратить side effects         |
| `mcp_endpoint_forbidden`        | HTTP/private/local MCP endpoint     | исправить подключение           |
| `tool_iteration_limit`          | Исчерпан loop tools                 | завершить с диагностикой        |

Неизвестные ошибки нормализуются в безопасный code без provider body, URL, headers и credentials.

## Sandbox

Run с `input.sandbox=true` и `input.publish=false` выполняет обычный контекст/tool loop, но не создаёт сообщение. Предпросмотр возвращается в `result_summary.preview`. Это позволяет проверить поведение до включения triggers.

## Подтверждения write-tools

Runtime передаёт UUID provider tool call как `tool_call_id` и не передаёт флаг `confirmed`. Для write-tool core валидирует run, lease, scope, JSON Schema и сохраняет неизменяемый pending-запрос; HTTP `202` означает, что side effect ещё не выполнялся. Повтор `(organization, run_id, tool_call_id)` с теми же аргументами возвращает тот же запрос, а попытка изменить tool или аргументы отклоняется.

Менеджер агента видит очередь в разделе «Агенты → Подтверждения» и вызывает approve/deny API. При approve core повторно проверяет текущий allowlist агента и membership через доменный handler, выполняет сохранённые аргументы ровно в рамках этого confirmation и пишет решение/результат в аудит. Повторное решение и истёкший запрос возвращают conflict. Tool validation/authorization errors возвращаются модели как безопасный `tool_result`, чтобы один неверный вызов не обрывал весь run.

Начиная с фазы 5.3 у pending-подтверждения в run'е с чатом появляется карточка в этом чате (`card_message_id`). Кнопки «Approve»/«Deny» на ней вызывают тот же approve/deny с тем же правом `agents.approve` и аудитом; решение из раздела «Подтверждения» закрывает карточку. Карточка показывает значения аргументов только если tool работает в том же чате; для `send_direct_message` и записи в другой чат видно лишь имя tool'а, детали — в общей очереди. Публикация карточки — best effort: если агент не может писать в чат, очередь остаётся единственным местом решения. Истёкшее подтверждение помечается на карточке при следующем нажатии.

## Интерактивные сообщения, опросы и отложенный запуск (фаза 5.3)

### Инструменты

| Tool                  | Режим | Scope                  | Подтверждение                 |
| --------------------- | ----- | ---------------------- | ----------------------------- |
| `post_card`           | write | `messages:interactive` | нет                           |
| `update_card`         | write | `messages:interactive` | нет                           |
| `get_reactions`       | read  | `messages:read`        | —                             |
| `start_collection`    | write | `messages:interactive` | нет                           |
| `get_collection`      | read  | `messages:interactive` | —                             |
| `schedule_followup`   | write | `followups:write`      | нет                           |
| `send_direct_message` | write | `messages:write`       | по общей политике write-tools |

Интерактивные tools не ждут подтверждения: их ограничивают отдельные scopes и серверные лимиты. `dry_run` для всех write-tools возвращает только `{dry_run, would_execute, arguments}` — карточки, опросы, напоминания, личные сообщения и follow-up не создаются.

`post_card` принимает `blocks` (`MessageBlocks`, `version: 1`). Если `body` пуст, Core генерирует текстовый fallback из карточки. Агент не может задать `binding` и `responses` — это состояние сервера. `update_card` заменяет карточку своего сообщения, сохраняя ответы у кнопок с тем же `id`; без `body` fallback пересчитывается. Ссылки в `sources` и `allowed.actor_ids` проверяются по видимости автору.

### Кнопки

- `limit: "per_actor"` — каждый допущенный участник нажимает один раз; `limit: "single"` — первое нажатие закрывает кнопку для всех.
- `group` — кнопки одной группы образуют один выбор на человека («могу / не могу»).
- `allowed` — список actor, ролей в чате, ролей в пространстве или прав; без него нажать может любой активный человек — участник чата. API-ключи агентов нажимать не могут.
- Нажатие ставит run агента-автора: `input = {trigger_type: "message_action", message_id, action_id, actor_id, chat_id, thread_root_id, responded_at, card_title}`. Run создаётся только у включённого агента и идемпотентен по ответу.

### Сбор ответов

`start_collection` фиксирует целевое сообщение, способ ответа (`reaction` — реакция, `action` — кнопка собственной карточки, `reply` — ответ в треде или reply на сообщение), фильтр `match` (emoji или id кнопок), ожидаемых людей (`expected_actor_ids` или `expect_all_members` — все люди чата, кроме автора сообщения), срок, напоминания (`remind_every_seconds` ≥ 300, `max_reminders` ≤ 5, `reminder_channel: thread | direct`, `reminder_text`) и получателя итога (`report_chat_id`, `report_in_thread`). Список ожидаемых фиксируется при старте.

Core сам считает ответивших по текущим реакциям, нажатиям и ответам; снятая реакция снова делает человека ожидающим. Фоновый worker (каждые 5 секунд):

- закрывает опрос со статусом `completed`, когда ответили все, или `expired` после срока, и ставит run агента в чат итога: `input = {trigger_type: "collection", reason, collection_id, message_id, responded, pending_actor_ids, expected_actor_ids, note, ...}`;
- отправляет напоминание от имени агента: в тред с упоминанием ожидающих или личным сообщением со ссылкой на исходное сообщение.

Ограничения напоминаний на стороне сервера: тихие часы 21:00–08:00 по часовому поясу получателя (напоминание переносится на конец окна), не больше `max_reminders` на человека в одном опросе и не больше 6 напоминаний одному человеку за сутки от всех агентов. Пауза агента отменяет напоминания (возобновление их не восстанавливает), опрос продолжает считать ответы. Удаление агента отменяет опрос. Откат версии агента начатый опрос не отменяет. Не больше 20 открытых опросов на агента.

### Отложенный запуск

`schedule_followup` сохраняет продолжение с `at` или `delay_seconds` (от 1 минуты до 30 дней), чатом (по умолчанию — чат текущего run), `note` и `context` (JSON-объект до 16 КиБ). Повтор того же `tool_call_id` возвращает тот же follow-up. Запись хранится в PostgreSQL и переживает рестарт Core. В срок worker ставит run с `input = {trigger_type: "followup", followup_id, scheduled_for, source_run_id, note, context, chat_id, thread_root_id}` и тем же chain depth, что у исходного run.

Статусы: `pending → dispatched`; `canceled` с причиной `agent_paused` / `agent_deleted` (пауза и удаление отменяют ожидающие follow-up сразу); `skipped` с причиной `budget_exceeded` (дневной или месячный бюджет уже исчерпан) или `agent_unavailable` (агент вышел из чата, подключение выключено). Не больше 50 ожидающих follow-up на агента.

### Личные сообщения

`send_direct_message` пишет человеку в личный чат с агентом (создаётся при первом сообщении). Получатель должен состоять хотя бы в одном общем чате с агентом; лимит — 10 сообщений одному человеку за сутки от одного агента.

## Provider gateway

Runtime отправляет vendor request без секрета в `POST /api/v1/agent-runtime/provider/chat`. Core проверяет активный run и lease, разрешение на внешнюю передачу данных, provider rate limit и бюджет, подставляет выбранные на сервере model/max output и только затем открывает upstream SSE. Provider credential никогда не возвращается runtime API.

Core наблюдает usage в SSE и записывает каждую фактически начатую provider-операцию независимо от финального состояния run. Для моделей из встроенной pricing-таблицы стоимость вычисляется по токенам; неизвестные OpenAI-compatible модели получают явно помеченную оценочную стоимость до появления настроенного тарифа.

## SDK и локальная разработка

Пакет `@comamessenger/agent-sdk` предоставляет `AgentClient`, `RuntimeSocket`, `runWorker`, `defineAgent`, `MockProvider` и контекст `onRun(ctx)` с helpers `tool`, `thread`, `command`, `sinceLastRun`, `stream`. CLI `coma-agent dev` может через публичный admin API создать external agent, вывести runtime key один раз, включить агента только после успешной выдачи ключа и горячо перечитывать ESM recipe. `coma-agent simulate mention|command|schedule` ставит обычный run в очередь; отдельного привилегированного test endpoint нет.

Минимальные scopes выводятся из объявленных recipe tools. Неизвестный tool не расширяет allowlist автоматически. Для повторного запуска используется сохранённый `COMA_AGENT_API_KEY`; admin access token нельзя передавать worker-процессу.

## Масштабирование dispatcher

Несколько core-реплик делят event и schedule triggers по стабильному PostgreSQL hash `agent_id`. У каждой реплики задаются `AGENT_TRIGGER_SHARD_INDEX` от `0` до `COUNT-1` и одинаковый `AGENT_TRIGGER_SHARD_COUNT` (1–1024). Значение по умолчанию `0/1`. Перекрывающиеся или пропущенные индексы являются ошибкой deployment-конфигурации, а уникальные ограничения run'ов остаются последним барьером идемпотентности.

MCP runtime разрешает только HTTPS, запрещает redirects и локальные/private literal hostnames. DNS lookup выполняется транспортом при установлении соединения и возвращает только public IP; выбранный адрес закрепляется за сокетом, поэтому повторное DNS-разрешение между проверкой и connect отсутствует.

## Compatibility

- Новые optional поля добавляются без смены версии.
- Удаление/переименование операций, enum-значений или обязательных полей требует `agents-v2`.
- SDK обязан принимать неизвестные поля и неизвестные error codes, сохраняя default-deny для неизвестных write operations.
