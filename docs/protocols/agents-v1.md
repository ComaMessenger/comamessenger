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
| `mcp_redirect_refused`          | MCP-сервер ответил перенаправлением | указать конечный адрес          |
| `tool_iteration_limit`          | Исчерпан loop tools                 | завершить с диагностикой        |

Неизвестные ошибки нормализуются в безопасный code без provider body, URL, headers и credentials.

## Sandbox

Run с `input.sandbox=true` и `input.publish=false` выполняет обычный контекст/tool loop, но не создаёт сообщение. Предпросмотр возвращается в `result_summary.preview`. Это позволяет проверить поведение до включения triggers.

Шаги run'а читаются через `GET /api/v1/agent-runs/{run_id}/tool-calls` (любое право `agents.*` на просмотр): имя tool'а, режим, статус, время. В `dry_run` write-tool не выполняется, но записывается как шаг с `dry_run=true` — по нему проверка в конструкторе показывает, что агент сделал бы.

## Подтверждения write-tools

Runtime передаёт UUID provider tool call как `tool_call_id` и не передаёт флаг `confirmed`. Для write-tool, которому политика версии агента (см. ниже) назначила `confirm`, core валидирует run, lease, scope, JSON Schema и сохраняет неизменяемый pending-запрос; HTTP `202` означает, что side effect ещё не выполнялся. Повтор `(organization, run_id, tool_call_id)` с теми же аргументами возвращает тот же запрос, а попытка изменить tool или аргументы отклоняется.

Менеджер агента видит очередь в разделе «Агенты → Подтверждения» и вызывает approve/deny API. При approve core повторно проверяет текущий allowlist агента и membership через доменный handler, выполняет сохранённые аргументы ровно в рамках этого confirmation и пишет решение/результат в аудит. Повторное решение и истёкший запрос возвращают conflict. Tool validation/authorization errors возвращаются модели как безопасный `tool_result`, чтобы один неверный вызов не обрывал весь run.

Начиная с фазы 5.3 у pending-подтверждения в run'е с чатом появляется карточка в этом чате (`card_message_id`). Кнопки «Approve»/«Deny» на ней вызывают тот же approve/deny с тем же правом `agents.approve` и аудитом; решение из раздела «Подтверждения» закрывает карточку. Карточка показывает значения аргументов только если tool работает в том же чате; для `send_direct_message` и записи в другой чат видно лишь имя tool'а, детали — в общей очереди. Публикация карточки — best effort: если агент не может писать в чат, очередь остаётся единственным местом решения. Истёкшее подтверждение помечается на карточке при следующем нажатии.

### Политика подтверждений версии агента (фаза 5.3, миграция 00049)

Что ждёт человека, решает версия агента, а не глобальный флаг. `confirmation_policy` черновика — объект `{tool: "auto" | "confirm"}` для каждого встроенного write-tool: `post_message`, `reply_in_thread`, `add_reaction`, `post_card`, `update_card`, `start_collection`, `schedule_followup`, `remember`, `send_direct_message`. Запрос может назвать только меняемые tools; ответ называет все с режимом, который core применяет. Умолчания нового агента: личные сообщения (`send_direct_message`) — `confirm`, публикация в свои чаты, карточки, сборы, отложенный запуск, реакции и заметки — `auto`. Агенты, созданные до 00049, и версии без поля сохраняют прежнее поведение: `confirm` для `post_message`, `reply_in_thread`, `add_reaction`, `remember`, `send_direct_message`, `auto` для интерактивных tools (так же восстанавливает откат на старую версию).

Нижняя граница, которую сборщик ослабить не может:

- оператор сервера задаёт `AGENT_TOOLS_REQUIRE_CONFIRMATION` (через запятую) — эти tools всегда `confirm`, агент получает их в `confirmation_locked`, явная попытка поставить им `auto` отклоняется `422`;
- для внешних систем — `writes_require_confirmation` подключения: при нём каждая запись ждёт человека, что бы ни было в привязке. Привязка `mcp_bindings[]` получила необязательный `confirmation_policy` по tools; без записи действует `require_write_confirmation` привязки (по умолчанию `true`). Runtime получает итоговый режим в `tool_confirmation` и только помечает tool в описании для модели; решение принимает core при `POST /agent-runtime/mcp-tool-calls`.

Кто может ослаблять: черновик правит `agents.build`, но в силу политика вступает только публикацией (`agents.publish`). `PATCH /agents/{id}` с `enabled` теперь тоже требует `agents.publish` — раньше сборщик мог опубликовать черновик в обход права. Каждая публикация пишет в аудит `agent.confirmation_policy.publish` с действующей политикой, привязками и списком `loosened` — tools, которые перестали ждать человека.

После решения человека core ставит run-продолжение того же агента в чате исходного run'а: `input = {trigger_type: "confirmation", confirmation_id, original_run_id, tool_name, status: "completed" | "failed" | "denied", error_code?, result?}`. `result` — ответ tool'а (встроенного или MCP) до 16 КБ, иначе `result_truncated: true`. Продолжение идемпотентно по подтверждению и не создаётся для приостановленного или удалённого агента и для run'а без чата.

### Тон, инструкции и роли чатов

- `tone`: `""` (без указаний), `concise`, `friendly`, `formal`. Core добавляет строку о тоне в инструкции сам.
- `instructions` агента — итоговая доверенная конфигурация для модели: задача, строка тона и строки о чатах, где агент только читает или только пишет. Runtime кладёт её в `<agent_configuration>` вместо `description`; dry-run получает её в `agent_config.instructions`. Участник без прав управления видит инструкции без строк о чатах.
- `read_chat_ids` (откуда агент берёт историю) и `write_chat_ids` (куда пишет) делят `chat_ids`; чат может быть в обоих списках, `chat_ids` — их объединение. Хранятся ограничения (`read_only_chat_ids`, `write_only_chat_ids`), поэтому агенты до 00049 и клиенты, которые шлют только `chat_ids`, работают как раньше: новые чаты читаются и пишутся. Core проверяет роли при каждом вызове tool: чтение (`get_chat_messages`, `get_thread`, `get_reactions`, `list_members`, `search_messages` с фильтрацией выдачи) запрещено в чатах «только пишет» (`chat_write_only`), запись (`post_message`, `reply_in_thread`, `post_card`, `update_card`, `add_reaction`, `start_collection`, `schedule_followup`) — в чатах «только читает» (`chat_read_only`). Создание сообщения агентом в чате «только читает» запрещено и в сервисе сообщений, включая итоговую публикацию run'а; runtime в этом случае завершает run без сообщения (`result_summary.publish_skipped`).

### Почему агент написал сообщение

Сообщение агента содержит необязательный `agent_provenance = {run_id, trigger, trigger_label?}`. `trigger`: `manual`, `mention`, `command`, `keyword`, `every_message`, `schedule`, `event`, `webhook`, `followup`, `message_action`, `collection`, `confirmation`. `trigger_label` — короткая строка из настроек правила: `/команда`, время расписания с часовым поясом, ключевые слова, типы событий, название вебхука. Содержимое вебхука, заметка отложенного запуска и текст других чатов в `agent_provenance` не попадают. Web и mobile показывают строку «почему» под сообщением.

### Точная ссылка на фрагмент

Источник `kind: "document"` в блоках принимает `chunk_id` фрагмента из `search_knowledge`; core проверяет, что фрагмент принадлежит документу, и сам заполняет `position`. Страница документа подсвечивает фрагмент по `chunk_id`; если документ переиндексирован — фрагмент на той же позиции, содержащий цитату, затем поиск по цитате (для старых сообщений), затем позицию.

### Лента запусков пространства

`GET /api/v1/agent-runs?cursor=&limit=&agent_id=` (право `agents.observe`) отдаёт запуски всех агентов пространства, новые сначала, страницами до 200; `next_cursor` продолжает выдачу. Вебхуки пространства (`GET /integrations/webhooks`) теперь видят и сборщики агентов — без подсказки секрета и данных об отклонённых запросах, — чтобы выбрать вебхук для правила.

### Правила запуска и черновик

Правила (`agent_triggers`) пока применяются сразу после сохранения, мимо публикации. План перевода в версию: таблица `agent_draft_triggers` (копия правил черновика) и ключ `triggers` в `agent_versions.config`; API правил пишет в черновик, `publishDraft` заменяет действующие правила (`superseded_at`) правилами черновика и пересчитывает `next_run_at`, откат готовит черновик с правилами версии, dry-run берёт правила черновика; `readiness`/`trigger_required` считается по правилам черновика. Существующие правила копируются в первый черновик миграцией; `agent_runs.trigger_id` продолжает указывать на конкретную строку правила, поэтому история запусков не теряется.

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

Для раздела «Активность» открытые опросы и ожидающие продолжения читаются через `GET /api/v1/agents/response-collections` и `GET /api/v1/agents/followups` (право `agents.observe`, фильтры `status` и `agent_id`, до 50 записей). Опрос отдаётся счётчиками ответивших и ожидаемых без списка людей, продолжение — без сохранённого `context`.

### Личные сообщения

`send_direct_message` пишет человеку в личный чат с агентом (создаётся при первом сообщении). Получатель должен состоять хотя бы в одном общем чате с агентом; лимит — 10 сообщений одному человеку за сутки от одного агента.

## База знаний (`search_knowledge`)

Инструмент `search_knowledge` требует scope `knowledge:read` и ищет только в коллекциях, привязанных к версии агента (`knowledge_collection_ids` черновика или опубликованной версии). Набор коллекций фиксируется в `agent_runs.agent_config` при постановке run'а в очередь, поэтому dry-run черновика ищет по коллекциям черновика, а откат версии возвращает её привязки. Коллекция с доступом `chats` видна агенту только в run'ах из выбранных чатов. Агент без привязки не видит ни одной коллекции, даже открытой всем участникам.

Ответ содержит `fragments[]` с `chunk_id`, `document_id`, `document_title`, `collection`, `section` (путь заголовков), `position` (номер фрагмента в документе) и `text`; пустой список и `found=false` означают, что в базе знаний ответа нет. Каждый выданный фрагмент записывается в `agent_run_knowledge_chunks` с привязкой к `agent_tool_calls.id`; список доступен через `GET /api/v1/knowledge/runs/{run_id}/fragments` и остаётся после удаления документа (с `available=false`).

## Интеграции пространства (фаза 5.3, пакет H)

### MCP-подключения

MCP-сервер внешней системы — подключение пространства (`/api/v1/integrations/mcp-connections`, право `integrations.manage`). Сборщики агентов без `integrations.manage` видят список, но вместо адреса — только хост, без маски ключа. Заголовки шифруются на сервере и не возвращаются в браузер; в ответах есть `headers_configured` и маска `secret_hint` с последними четырьмя символами (короткие значения не показываются).

Политику подключения задаёт только `integrations.manage`: `agent_use_allowed` (по умолчанию выключено — подключение нельзя назначить агенту), `writes_require_confirmation` (по умолчанию включено — каждое изменяющее действие ждёт решения человека, что бы ни было в привязке) и `assignable_tools` (какие инструменты можно выдавать агентам; `null` — все из каталога). Агенту подключение назначается полем `mcp_bindings` черновика: `[{connection_id, allowed_tools, require_write_confirmation}]`; отсутствие `require_write_confirmation` значит `true`. Привязка может политику только ужесточить: инструменты вне `assignable_tools` и, когда каталог известен, вне каталога сервера отклоняются при сохранении черновика; Core повторно применяет политику при каждом вызове, поэтому её изменение действует и на уже опубликованные версии. Публикация копирует привязки в агента и в конфигурацию версии, откат возвращает их, dry-run берёт привязки черновика из снимка `agent_runs.agent_config.mcp_bindings`. Секрет в строки агента не копируется.

`POST /api/v1/agent-runtime/mcp-servers` отдаёт runtime расшифрованные заголовки только для подключений, привязанных к версии run'а, и только включённых. Поля `allow_private_network` и `allowed_private_cidrs` передают runtime внутренние диапазоны, в которые может разрешиться адрес. Адрес каждого подключения проверяется заново при использовании (в том числе перенесённых из `agent_mcp_servers`); не прошедшее проверку подключение runtime не получает. Удалить подключение, которое использует хотя бы один черновик или опубликованная версия, нельзя (`409 integration_in_use`): его отключают (`enabled=false`) или отвязывают `POST …/detach` со списком затронутых агентов из `GET …/usage`; другой список даёт `409 integration_usage_changed`.

Режим вызова определяет Core, а не runtime: после проверки связи (`POST …/test`, только `initialize` и `tools/list`) инструмент считается чтением, только если сервер объявил `readOnlyHint: true`; инструмента нет в каталоге — вызов запрещён. Пока каталога нет, любой вызов — запись; исключение — подключения, перенесённые из `agent_mcp_servers`, где до первой успешной проверки действует классификация runtime. Смена схемы, хоста или порта сбрасывает каталог и, если новые заголовки не переданы, удаляет сохранённые (`last_error_code=credentials_required`). Runtime всегда передаёт `arguments`; если запись требует подтверждения, а аргументов нет, Core отвечает `422`. Запись с подтверждением не выполняется runtime'ом: `POST /api/v1/agent-runtime/mcp-tool-calls` отвечает `202` и `confirmation`, Core создаёт подтверждение (`tool_name = mcp__<имя>__<tool>`, `required_scope = mcp:<connection_id>`) и после одобрения сам вызывает инструмент, повторно проверяя опубликованные привязки и политику подключения. Вызов идёт в собственном контексте с таймаутом: закрытая вкладка одобряющего его не отменяет. В dry-run запись возвращает `preview=true` и внешнего вызова нет.

Старый API `/api/v1/agents/{id}/mcp-servers` остаётся представлением совместимости над подключениями и привязками; запись через него требует ещё и `integrations.manage`. Миграция `00047` копирует `agent_mcp_servers` в подключения с теми же id, таблицу не меняет.

### Проверка адресов

Core проверяет адрес при сохранении и каждый IP, к которому подключается (DNS rebinding не обходит проверку), запрещает redirects и прокси окружения. Внутренние адреса (loopback, RFC 1918, CGNAT, ULA, имена `localhost`/`.local`/`.internal`/однословные) и plain HTTP доступны, только если согласны двое: оператор сервера перечислил адрес в `INTEGRATIONS_ALLOWED_PRIVATE_TARGETS` (CIDR, IP или `host:port`; по умолчанию пусто — внутренние адреса закрыты) и администратор пространства включил у подключения `allow_private_network`. Иначе сохранение отклоняется с сообщением, что адрес нужно попросить у оператора. Link-local, адреса метаданных облака (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `168.63.129.16`, `192.0.0.192`, `fd00:ec2::254`, `metadata.google.internal`…), multicast и unspecified запрещены всегда, в том числе внутри IPv4-mapped, IPv4-compatible, NAT64 и 6to4. Runtime применяет ту же политику (`mcp_endpoint_forbidden`).

### Табличный источник (`query_table`)

Инструмент `query_table` (scope `tables:read`) читает CSV и XLSX из коллекций базы знаний, привязанных к версии агента, по тем же правилам видимости, что `search_knowledge`. Без `document_id` возвращает `tables[]` (документ, лист, столбцы, число строк). С `document_id` возвращает строки: `filters[]` по столбцам (`equals`, `not_equals`, `contains`, `starts_with`, `empty`, `not_empty`, `gte`, `lte`; без учёта регистра, числа сравниваются как числа), `columns[]`, `limit` до 200, `offset`. Строки хранятся в `knowledge_table_rows` и заменяются при переиндексации; документы, проиндексированные до `00047`, заполняются при первом обращении. Документ вне привязанных коллекций выглядит как несуществующий (`error: table_not_found`). Даты XLSX возвращаются в ISO 8601.

### Входящие вебхуки

Вебхук пространства (`/api/v1/integrations/webhooks`) — публичный адрес `POST /api/v1/hooks/{webhook_id}` с собственным секретом (показывается один раз, ротация `…/rotate-secret`). Запрос подписывается: `X-Coma-Timestamp` (unix-секунды, ±5 минут), `X-Coma-Delivery` (уникальный id), необязательный `X-Coma-Event`, `X-Coma-Signature: sha256=<hex HMAC-SHA256(секрет, "<timestamp>.<delivery>.<тело>")>`. Тело — JSON-объект не больше `max_body_bytes`. Повтор принятого `delivery` ответ `200 duplicate` без новых run'ов. Размер, заголовки, время и подпись проверяются до всего остального: запросы без верной подписи не расходуют `rate_limit_per_minute` вебхука и не попадают в журнал — Core только увеличивает счётчик `rejected_count` и ограничивает такие запросы с одного адреса (≈30 в минуту, затем `429` до обращения к базе). Лимит вебхука считает только подписанные доставки (`429`). Журнал (`…/deliveries`) содержит только подписанные доставки — статус, размер и SHA-256 тела, не дольше 30 дней и не больше 1000 строк на вебхук (периодическая очистка); само тело не хранится.

Триггер агента `type=webhook` с `config {webhook_id, chat_id, event_types?}` ставит run в очередь в той же транзакции, что и запись журнала. Полезная нагрузка попадает в `input.external_event.payload` рядом с `trust: "untrusted_data"`; runtime передаёт весь `input` модели внутри `<run_input untrusted="true">`, поэтому текст из внешней системы остаётся данными, а не инструкциями.

## Provider gateway

Runtime отправляет vendor request без секрета в `POST /api/v1/agent-runtime/provider/chat`. Core проверяет активный run и lease, разрешение на внешнюю передачу данных, provider rate limit и бюджет, подставляет выбранные на сервере model/max output и только затем открывает upstream SSE. Provider credential никогда не возвращается runtime API.

Core наблюдает usage в SSE и записывает каждую фактически начатую provider-операцию независимо от финального состояния run. Для моделей из встроенной pricing-таблицы стоимость вычисляется по токенам; неизвестные OpenAI-compatible модели получают явно помеченную оценочную стоимость до появления настроенного тарифа.

## SDK и локальная разработка

Пакет `@comamessenger/agent-sdk` предоставляет `AgentClient`, `RuntimeSocket`, `runWorker`, `defineAgent`, `MockProvider` и контекст `onRun(ctx)` с helpers `tool`, `thread`, `command`, `sinceLastRun`, `stream`. CLI `coma-agent dev` может через публичный admin API создать external agent, вывести runtime key один раз, включить агента только после успешной выдачи ключа и горячо перечитывать ESM recipe. `coma-agent simulate mention|command|schedule` ставит обычный run в очередь; отдельного привилегированного test endpoint нет.

Минимальные scopes выводятся из объявленных recipe tools. Неизвестный tool не расширяет allowlist автоматически. Для повторного запуска используется сохранённый `COMA_AGENT_API_KEY`; admin access token нельзя передавать worker-процессу.

## Масштабирование dispatcher

Несколько core-реплик делят event и schedule triggers по стабильному PostgreSQL hash `agent_id`. У каждой реплики задаются `AGENT_TRIGGER_SHARD_INDEX` от `0` до `COUNT-1` и одинаковый `AGENT_TRIGGER_SHARD_COUNT` (1–1024). Значение по умолчанию `0/1`. Перекрывающиеся или пропущенные индексы являются ошибкой deployment-конфигурации, а уникальные ограничения run'ов остаются последним барьером идемпотентности.

MCP runtime разрешает только HTTPS, запрещает redirects и локальные/private literal hostnames (кроме диапазонов `allowed_private_cidrs`, см. «Проверка адресов»). DNS lookup выполняется транспортом при установлении соединения и возвращает только public IP; выбранный адрес закрепляется за сокетом, поэтому повторное DNS-разрешение между проверкой и connect отсутствует.

## Compatibility

- Новые optional поля добавляются без смены версии.
- Удаление/переименование операций, enum-значений или обязательных полей требует `agents-v2`.
- SDK обязан принимать неизвестные поля и неизвестные error codes, сохраняя default-deny для неизвестных write operations.
