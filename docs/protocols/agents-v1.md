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

`run.input` для event trigger содержит `event_seq`, `event_type`, `subject_id`, `message_body`, `source_chat_id`, `thread_root_id`, `trigger_type`; для command также `command` и `command_arguments`. Schedule-run содержит `scheduled_for`, `since_last_run`, `chat_id` и `timezone`.

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

## Provider gateway

Runtime отправляет vendor request без секрета в `POST /api/v1/agent-runtime/provider/chat`. Core проверяет активный run и lease, разрешение на внешнюю передачу данных, provider rate limit и бюджет, подставляет выбранные на сервере model/max output и только затем открывает upstream SSE. Provider credential никогда не возвращается runtime API.

Core наблюдает usage в SSE и записывает каждую фактически начатую provider-операцию независимо от финального состояния run. Для моделей из встроенной pricing-таблицы стоимость вычисляется по токенам; неизвестные OpenAI-compatible модели получают явно помеченную оценочную стоимость до появления настроенного тарифа.

## Compatibility

- Новые optional поля добавляются без смены версии.
- Удаление/переименование операций, enum-значений или обязательных полей требует `agents-v2`.
- SDK обязан принимать неизвестные поля и неизвестные error codes, сохраняя default-deny для неизвестных write operations.
