# Фаза 5. Агентская платформа

## Цель

Сделать агента полноценным actor с теми же границами доступа, что и у человека, и доказать публичность платформы: встроенный runtime и внешние агенты работают только через документированные API, WebSocket events и MCP-compatible tools.

## В scope

- actor типа `agent`, профиль, owner, enabled state и membership;
- API keys со scopes, channel/chat restrictions, rotation и revocation;
- TypeScript agent runtime как отдельный процесс;
- провайдеры OpenAI, Anthropic и OpenAI-compatible через единый интерфейс;
- triggers: mention, command, keyword, every-message, schedule и system event;
- tools над публичным API и подключение внешних MCP servers;
- context assembly, short-term context, key-value и vector memory;
- streaming ответа и agent status в web UI;
- token/cost limits, usage accounting и защита от циклов;
- встроенные Summarizer, Q&A по истории и Onboarding;
- минимальные TS/Python SDK examples для внешнего агента.

## Вне scope

- визуальный no-code builder сложных агентских workflow;
- marketplace и установка стороннего кода внутрь core;
- автономный доступ агента к чатам без membership;
- общий shared memory между организациями;
- гарантия поддержки каждого LLM/MCP provider;
- обучение или fine-tuning моделей.

## Пользовательские сценарии

- Admin создаёт агента, выбирает разрешённые чаты, scopes и trigger, затем явно включает его.
- Пользователь упоминает агента в доступном чате и получает streaming-ответ с понятной отметкой авторства.
- Агент отвечает в треде, ищет историю и читает файл только если его actor имеет соответствующие права.
- Admin отзывает API key или выключает агента, после чего новые события и действия немедленно запрещаются.
- Организация задаёт месячный/дневной лимит, и runtime прекращает дорогие вызовы до превышения бюджета.
- Внешний разработчик запускает пример агента без приватных endpoints.

## Технические задачи

### Модель и безопасность агента

- [x] Создать `agents`, `api_keys`, `agent_usage`, `agent_memory`, `agent_runs`, `agent_triggers` либо согласованную нормализованную модель.
- [x] Хранить API keys только как hash; показывать plaintext один раз при создании.
- [x] Пересекать actor permissions, API-key scopes и chat membership при каждом действии.
- [x] Записывать tool calls, administrative changes и чувствительные агентские действия в audit log без сохранения provider secrets.
- [x] Зашифровать provider credentials envelope encryption/AES-GCM с master key из environment или внешнего secret store.
- [x] Реализовать rotation/revocation ключей без рестарта core.
- [x] Добавить rate limits по agent, key, provider и organization.

### Runtime и triggers

- [x] Создать runtime connection manager с WS resume и checkpoint durable seq.
- [x] Сделать trigger dispatcher идемпотентным по `(agent_id, event_seq, trigger_id)`.
- [x] Игнорировать собственные ответы агента по умолчанию и ограничить chain depth для предотвращения agent loops.
- [x] Реализовать mention, command, keyword/regex, every-message и event triggers.
- [x] Реализовать schedule trigger через durable scheduler/job, учитывающий timezone и missed runs policy.
- [x] Вводить per-chat concurrency и очередь, чтобы сообщения не переставлялись непредсказуемо.
- [x] Поддержать cancel/timeout/retry с явным состоянием run.

### LLM providers и context

- [x] Определить provider interface для chat/stream/tools/usage без протекания vendor-specific объектов.
- [x] Реализовать адаптеры OpenAI, Anthropic и OpenAI-compatible endpoint.
- [x] Собирать контекст только через доступные публичные read APIs/search.
- [x] Ограничивать размер контекста, количество search/tool iterations и max output tokens.
- [x] Реализовать key-value memory и vector retrieval с namespace по organization/agent.
- [x] Помечать untrusted message/file content и защищать system/tool policy от prompt injection.
- [x] Не передавать содержимое внешнему provider без явной конфигурации организации.

### Tools и MCP

- [x] Реализовать tools `get_chat_messages`, `get_thread`, `search_messages`, `post_message`, `reply_in_thread`, `add_reaction`, `get_file_text`, `list_members`, `remember`, `recall`.
- [x] Валидировать аргументы tools по JSON Schema и применять те же authz/scopes, что и REST.
- [x] Добавить allowlist внешних MCP servers, timeout, output size limits и redaction секретов.
- [x] Разделить read и write tools; потенциально значимые действия могут требовать configurable user confirmation.
- [x] Записывать correlation IDs run → provider call → tool call → message.

### Streaming и Web UI

- [x] Добавить ephemeral `agent.status` и `message.streaming` deltas с финальным durable `message.created`.
- [x] Определить поведение reconnect: partial stream не считается финальным сообщением и может быть восстановлен/заменён.
- [ ] Создать каталог агентов, страницу агента, форму создания, scopes, memberships, triggers и usage.
- [ ] Показывать «агент думает», streaming, ошибку/cancel и ссылку на run details для admin.
- [x] Отмечать все сообщения агента визуально и в доступном текстовом представлении.

### Встроенные агенты и SDK

- [ ] Summarizer: ручная команда по chat/thread и scheduled digest.
- [ ] Q&A: retrieval по доступным сообщениям/файлам с цитатами на источники внутри мессенджера.
- [ ] Onboarding: greeting по member event и ответы по выбранному knowledge chat/channel.
- [ ] Создать минимальные TS/Python examples: connect, resume, react to mention, post reply.
- [ ] Проверить, что examples используют только опубликованные OpenAPI/WS contracts.

## Контракты и данные

Основные endpoints/events:

```text
GET    /api/v1/agents
POST   /api/v1/agents
GET    /api/v1/agents/:id
PATCH  /api/v1/agents/:id
POST   /api/v1/agents/:id/keys
DELETE /api/v1/agents/:id/keys/:key_id
POST   /api/v1/agents/:id/invoke
GET    /api/v1/agents/:id/runs
GET    /api/v1/agents/:id/usage
GET    /api/v1/agents/:id/triggers
POST   /api/v1/agents/:id/triggers
PATCH  /api/v1/agents/:id/triggers/:trigger_id
DELETE /api/v1/agents/:id/triggers/:trigger_id
GET    /api/v1/agents/:id/provider-credentials
PUT    /api/v1/agents/:id/provider-credentials
GET    /api/v1/agents/:id/mcp-servers
POST   /api/v1/agents/:id/mcp-servers
PATCH  /api/v1/agents/:id/mcp-servers/:server_id
DELETE /api/v1/agents/:id/mcp-servers/:server_id
POST   /api/v1/agent-runtime/runs/claim
GET    /api/v1/agent-runtime/mcp-servers
POST   /api/v1/agent-runtime/mcp-tool-calls
POST   /api/v1/agent-runtime/mcp-tool-calls/:call_id/finish
POST   /api/v1/agent-runtime/provider-calls
POST   /api/v1/agent-runtime/provider-calls/:call_id/finish

agent.invoked
agent.run.started
agent.run.completed
agent.run.failed
agent.status
message.streaming
```

- Durable final message создаётся core через публичный message endpoint.
- Streaming delta не является источником истины и может быть отброшена при reconnect.
- `agent.status` и `message.streaming` принимаются только от API key с `runtime:execute`, привязываются к активному run и повторно проверяют membership/chat/thread. Deltas имеют монотонный index, bounded payload и TTL; web игнорирует переставленные/повторные deltas и очищает partial state по TTL, terminal frame или при reconnect. Финальный `message.created` остаётся единственным durable результатом.
- Provider key никогда не входит в event payload, run logs или browser/admin API; runtime-only `no-store` endpoint доступен только API key самого агента.
- Секретные MCP headers шифруются отдельным AEAD domain и возвращаются только runtime-ключу самого агента через `no-store`; admin API показывает лишь факт их настройки. Runtime запрещает redirects, не включает неразрешённые tools, ограничивает каждый ответ по времени и размеру и наружу возвращает только стабильные redacted error codes.
- MCP tools с `annotations.readOnlyHint=true` считаются read; остальные считаются write. При `require_write_confirmation=true` write tools не передаются автономной модели, а core дополнительно отклоняет попытку начать такой вызов без разрешённой политики. Каждый MCP-вызов записывается и аудируется с run correlation ID.
- Usage сохраняет provider/model/tokens/cost/currency и источник расчёта стоимости.
- Memory key/value и pgvector embedding используют составную границу `(organization, agent, namespace, key)`; vector recall требует совпадающий embedding model и размерность, а raw embedding не возвращается в tool output.
- Перед provider call runtime атомарно резервирует оценочную стоимость под advisory lock; дневной и месячный лимиты учитывают завершённый usage и незавершённые reservations, поэтому конкурентные runs не обходят budget gate.

## Критерии приёмки

- Агент без membership не получает событие, search result, file text или thread content закрытого чата.
- Scope `messages:read` не позволяет вызвать write tool даже при ошибке runtime.
- Revoked key прекращает работать без рестарта и не может возобновить WS.
- Повторная доставка одного event не запускает второй run.
- Сообщения двух агентов не создают бесконечный trigger loop.
- Streaming корректно завершается одним durable message; после reconnect UI не оставляет вечную «печать».
- Каждый встроенный агент демонстрирует ценность на seed dataset и предоставляет ссылки на использованные внутренние источники, где применимо.
- Внешний sample agent выполняет тот же сценарий без приватного доступа.

## Проверка качества

- Permission matrix tests: actor role × membership × API scope × tool.
- Replay/idempotency tests triggers и scheduler.
- Adversarial prompt-injection fixtures из сообщений и файлов.
- Тесты timeout, provider 429/5xx, partial stream, tool failure и cancellation.
- Cost-limit tests до вызова и при конкурентных runs.
- E2E: создать агента → упомянуть → tool call → streaming → final message → revoke.
- Проверка отсутствия секретов в логах, событиях, traces и admin UI.

## Риски и открытые вопросы

- Выбрать первый production provider set и политику передачи корпоративных данных наружу.
- Определить, какие write tools требуют подтверждения пользователя по умолчанию.
- Зафиксировать модель стоимости для OpenAI-compatible endpoints без публичного прайса.
- Решить, хранить ли полные prompts/responses для диагностики или только redacted metadata.
- Уточнить sandbox/изоляцию для внешних MCP servers; core не должен исполнять произвольный plugin code.

## Definition of Done

- Runtime можно отключить, не нарушив работу обычного мессенджера.
- Встроенные и внешние агенты используют одинаковые публичные контракты.
- Permissions, budget, loop prevention и secret handling покрыты автоматическими тестами.
- Три демонстрационных агента работают через web UI на RU/EN сценариях.
- API/SDK документация позволяет создать минимального внешнего агента без чтения исходников core.
