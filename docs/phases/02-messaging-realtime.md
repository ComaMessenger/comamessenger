# Фаза 2. Надёжные сообщения и realtime

## Цель

Построить проверяемое ядро переписки, в котором два API-клиента безопасно обмениваются сообщениями, переживают timeout, повторы запросов, разрыв WebSocket и перезапуск Core без потери закоммиченных данных и без дублей в пользовательском состоянии.

Архитектурные гарантии закреплены в [ADR-0006](../decisions/0006-messaging-delivery-and-realtime.md), роль Redis — в [ADR-0007](../decisions/0007-redis-coordination.md), wire contract — в [Realtime protocol v1](../protocols/realtime-v1.md).

## В scope

- создание, получение, редактирование и мягкое удаление текстовых сообщений;
- идемпотентность команд через `client_msg_id`;
- единый серверный порядок durable events организации;
- reply и треды, где root message является идентификатором треда;
- реакции, закрепление и snapshot-пересылка;
- собственные read markers, unread, mentions и followed threads;
- синхронизируемые drafts;
- WebSocket auth, resume, ACK, heartbeat и backpressure;
- ephemeral typing/presence;
- Redis Pub/Sub как быстрый wake-up поверх durable event log и Redis TTL-state для ephemeral функций;
- durable event log как transactional outbox;
- failure, integration, concurrency и load tests.

## Вне scope

- вложения, link previews и полнотекстовый поиск;
- Web Push и Notification permission UI — они входят в фазу 3;
- чужие read receipts вида «прочитано Алисой»;
- offline cache/outbox браузера — контракт задаётся здесь, реализация входит в фазу 3;
- Redis Streams, Kafka, NATS, поддерживаемый multi-node fan-out и несколько экземпляров Core;
- универсальный EventBus, repository interface на каждую таблицу и таблица online deliveries;
- форматирование сверх согласованного markdown-подмножества.

## Инварианты

1. Доменная запись и durable event либо коммитятся вместе, либо не видны вовсе.
2. Один `(actor_id, client_msg_id)` создаёт не более одного сообщения и одного `message.created`.
3. Durable event может быть доставлен повторно; клиентское состояние от этого не меняется повторно.
4. `created_seq` сообщения равен `seq` его `message.created`.
5. Sequence организации монотонен по commit-порядку durable-мутаций.
6. Read marker и ACK никогда не двигаются назад.
7. Пользователь без актуального membership не получает body через REST, backlog, live WS, reply preview или thread endpoint.
8. Участник канала без `message.publish`/`thread.reply` не пишет ни в ленту, ни в тред.
9. Потеря in-memory hub не приводит к потере committed event.
10. ACK означает применение event клиентом, но не прочтение сообщения пользователем.
11. Потеря, повтор или задержка Redis-сигнала не влияет на сохранность и порядок durable events.

## Пользовательские сценарии

- Пользователь повторяет отправку после timeout и получает одно сообщение.
- Второй участник получает новое сообщение по WebSocket без ручного обновления.
- После offline клиент продолжает поток с checkpoint или выполняет явный full resync.
- WebSocket-событие, пришедшее раньше HTTP-ответа, объединяется с optimistic message.
- Пользователь отвечает цитатой в ленте либо ведёт отдельный тред.
- Read marker, reaction и draft синхронизируются между устройствами одного пользователя.
- Медленный клиент отключается контролируемо и возвращается без потери состояния.

## План реализации

Каждый инкремент должен быть отдельно deployable и завершаться документацией, миграцией, тестами и наблюдаемыми метриками. Следующий инкремент не начинается с обходом незакрытых correctness-дефектов предыдущего.

### Инкремент 2.0 — contracts freeze

- [x] Зафиксировать delivery semantics, sequence, retention и продуктовые defaults в ADR-0006.
- [x] Зафиксировать auth/hello/event/ACK/resync frames, close codes и failure matrix.
- [x] Добавить versioned JSON schemas в protocol package и сгенерировать Go/TypeScript-типы.
- [x] Описать REST error codes: `idempotency_conflict`, `version_conflict`, `forbidden`, `rate_limited`.
- [x] Зафиксировать лимиты body, batch, frame и WebSocket connections в конфигурации.

Готово, когда контрактные fixtures одинаково читаются Go и TypeScript и breaking change определяется CI.

### Инкремент 2.1 — durable message core

- [x] Добавить `organizations.event_seq`.
- [x] Создать `messages` с UUIDv7, `client_msg_id`, `created_seq`, `reply_to_id`, `thread_root_id`, `version`, edit/delete timestamps и уникальностью `(actor_id, client_msg_id)`.
- [x] Создать `events` с primary key `(org_id, seq)` и минимальными routing fields.
- [x] Реализовать короткую транзакцию: lock организации → authz → idempotency check → allocate seq → message → event → chat summary → commit.
- [x] Возвращать исходный результат точного повтора и `409` при несовпадающем payload.
- [x] Реализовать cursor pagination по `created_seq`, отдельно для ленты и треда.
- [x] Реализовать PATCH с `expected_version`, `message_revisions` и идемпотентный soft DELETE.
- [x] Валидировать размер body и формат; sanitization делать на render boundary, не теряя исходный текст.
- [x] Централизованно применять `message.publish` и `thread.reply` из `internal/authz`.

Готово, когда два REST-клиента создают и читают сообщения, а конкурентные повторы не создают дубли.

### Инкремент 2.2 — durable realtime

- [x] Подключить `github.com/coder/websocket` и реализовать `/api/v1/ws`.
- [x] Реализовать first-frame auth, Origin check, frame limits и connection limits.
- [x] Реализовать конкретные `eventlog.Store`, polling dispatcher и in-process `realtime.Hub` без общего EventBus interface.
- [x] Регистрировать live queue до чтения high watermark и корректно склеивать backlog/live.
- [x] Фильтровать replay и live delivery по актуальному membership.
- [x] Реализовать ACK window, bounded queue, единственный data writer и `4008 slow_consumer`.
- [x] Реализовать Ping/Pong, deadlines, graceful shutdown и reconnect close codes.
- [x] Реализовать `resync_required` при checkpoint старше retention.
- [x] Добавить структурированные operational signals для connection lifecycle, queue bytes/events, unacked window, event lag, reconnect reason и dispatch latency; Prometheus exporter остаётся в фазе 7.

Готово, когда reconnect до/после commit и падение после commit до wake-up проходят автоматически.

### Инкремент 2.2a — Redis coordination foundation

- [x] Добавить Redis Open Source 8.x в development/production Compose с healthcheck, memory limit/policy и без требования к persistence.
- [x] Добавить `REDIS_URL`, connect/operation timeouts, versioned key/channel namespace и явный single-core disabled mode.
- [x] Реализовать маленький конкретный Redis coordinator без универсального `EventBus`/cache abstraction.
- [x] После PostgreSQL commit публиковать только `{org_id, high_watermark}`; не помещать message body или durable payload в Pub/Sub.
- [x] На каждом Core принимать сигнал, будить локальный dispatcher и читать события из PostgreSQL от собственного watermark.
- [x] Коалесцировать burst local/Redis сигналов в окне `EVENT_WAKE_COALESCE`, выполняя одну проверку watermark вместо запроса на каждый PUBLISH.
- [x] Читать backlog каждой WebSocket-сессии только ограниченными батчами с backpressure/ACK между батчами; не загружать весь диапазон до high watermark в память.
- [x] Сохранить периодический PostgreSQL polling как fallback при lost Pub/Sub, reconnect и runtime outage Redis.
- [x] Не блокировать durable-команду из-за publish error после commit; отражать Redis как degraded dependency и логировать/измерять fallback.
- [x] Разделить counters/log fields для `local_commit`, `redis` и `polling_fallback`, включая число коалесцированных wake-up.
- [x] Добавить integration tests на duplicate/lost wake-up, отключение Redis под трафиком и восстановление подписки.

Готово, когда Redis ускоряет доставку, но его остановка не теряет закоммиченные события, не создаёт дубли и не нарушает resume.

### Инкремент 2.3 — replies, threads и message actions

- [x] Проверять, что `reply_to_id` и `thread_root_id` существуют, доступны и принадлежат тому же chat.
- [x] Использовать root message ID как thread ID; не создавать таблицу `threads`.
- [x] Запретить вложенные thread roots, разрешив `reply_to_id` внутри треда.
- [ ] Создать `thread_followers`; автоматически подписывать автора root, ответивших и упомянутых.
- [ ] Реализовать follow/unfollow и список followed/unread threads.
- [ ] Создать `reactions` с уникальностью `(message_id, actor_id, emoji)` и PUT/DELETE API.
- [ ] Реализовать pins и snapshot-forward с source attribution.
- [x] Проверить channel posting policy для ленты и тредов.

Готово, когда reply/thread различаются на уровне API, а конкурентные follow/reaction операции идемпотентны.

### Инкремент 2.4 — user state и ephemeral realtime

- [ ] Создать `chat_reads` и thread read state, используя root message ID.
- [ ] Делать read marker монотонным и публиковать его только другим сессиям того же actor.
- [ ] Рассчитывать unread по доступным сообщениям после marker; mentions и unread threads считать отдельно.
- [ ] Создать versioned drafts с upsert/delete и actor-only events.
- [ ] Реализовать `subscribe_active`, typing и presence без durable event log.
- [ ] Хранить межпроцессные presence/typing leases в Redis с TTL; локальный in-memory режим допустим только при явно отключённом Redis и одном Core.
- [ ] Ввести распределённые rate limits для ephemeral operations и документировать fail-open/fail-closed policy по типу лимита.
- [ ] Не считать фоновые или агентские соединения online без отдельной presence policy.

Готово, когда два устройства одного пользователя сходятся по read state/draft, а потеря typing events безвредна.

### Инкремент 2.5 — hardening и benchmark

- [ ] Реализовать retention worker: 72 часа и минимум 100 000 последних events организации.
- [ ] Провести API-only end-to-end сценарий двух пользователей.
- [ ] Провести failure suite и security regression.
- [ ] Проверить Redis outage/reconnect, рост fallback polling load и отсутствие message body/secrets в Redis.
- [ ] Провести benchmark 2 000 WebSocket и 200 сообщений/с на согласованной машине.
- [ ] Сохранить конфигурацию машины, p50/p95/p99 latency, CPU, RAM, DB locks, queue depth и disconnect causes.
- [ ] Обновить runbook диагностики realtime и документировать найденные пределы.

Готово, когда целевая нагрузка подтверждена либо ограничение измерено и принято отдельным ADR.

## Контракты и данные

Основные endpoints:

```text
GET    /api/v1/chats/:id/messages
POST   /api/v1/chats/:id/messages
PATCH  /api/v1/messages/:id
DELETE /api/v1/messages/:id
PUT    /api/v1/messages/:id/reactions/:emoji
DELETE /api/v1/messages/:id/reactions/:emoji
PUT    /api/v1/messages/:id/pin
DELETE /api/v1/messages/:id/pin
GET    /api/v1/threads
GET    /api/v1/messages/:root_id/thread
PUT    /api/v1/messages/:root_id/thread/follow
DELETE /api/v1/messages/:root_id/thread/follow
POST   /api/v1/chats/:id/read
POST   /api/v1/messages/:root_id/thread/read
PUT    /api/v1/drafts/:chat_id
DELETE /api/v1/drafts/:chat_id
GET    /api/v1/events?since=:seq
WS     /api/v1/ws
```

Минимальная конфигурация Redis: `REDIS_URL`, connect/operation timeouts, namespace и явный disabled mode. Отсутствие Redis не меняет REST/WS schema.

Минимальные таблицы появляются по инкрементам:

```text
organizations.event_seq
messages
message_revisions
events
thread_followers
reactions
message_pins
chat_reads
thread_reads
drafts
```

Таблиц `threads`, `forwards`, `message_deliveries` и второй outbox нет. Forward хранится как message snapshot с source attribution.

## Структура кода

Ориентир, а не требование создать пустые слои заранее:

```text
core/internal/message/service.go
core/internal/eventlog/store.go
core/internal/realtime/hub.go
core/internal/realtime/connection.go
core/internal/coordination/redis.go
core/internal/http/messages.go
core/internal/http/realtime.go
```

SQL остаётся рядом с владеющим модулем и следует текущему стилю pgx. Интерфейс выделяется только на реальной границе или при появлении второй реализации.

## Проверка качества

### Обязательные integration/concurrency tests

- 100 конкурентных запросов с одним `client_msg_id` → одна message row и один event.
- Повтор ID с другим payload → `409`, исходная запись неизменна.
- Event не виден до commit; rollback не расходует логический `event_seq`.
- `created_seq` совпадает с `message.created.seq`.
- Edit с устаревшей version конфликтует, DELETE безопасно повторяется.
- Read marker и ACK не откатываются при гонке устройств.

### Обязательные realtime/failure tests

- backlog и live event на границе high watermark не теряются и не меняются местами;
- повторная доставка не создаёт дубль состояния;
- reconnect до commit, после commit и после получения event;
- Core завершается после DB commit, но до hub wake-up;
- Redis Pub/Sub теряет или дублирует wake-up, а dispatcher всё равно сходится к PostgreSQL watermark;
- Redis отключается и возвращается во время трафика без отказа durable-команд;
- slow consumer получает `4008` и успешно resume;
- старый checkpoint получает `4009/resync_required`;
- revoked membership блокирует REST, backlog и live body;
- channel member не обходит запрет публикации через thread endpoint.

### Security и limits

- Origin allowlist, истёкший token, oversized frame/body и malformed JSON;
- connection/typing/message rate limits;
- reply/forward preview не раскрывает приватный оригинал;
- метрики и логи не содержат access token и message body.

## Критерии приёмки

- Закоммиченное сообщение доступно через REST после любого перезапуска Core.
- Повтор команды и события не создаёт повторного пользовательского эффекта.
- Два API-клиента последовательно обмениваются сообщениями через REST + WebSocket.
- Восстановление выбирает resume либо явный full resync, но не молча теряет дельту.
- Никакой endpoint или event path не обходит текущий membership/authz.
- Медленный клиент не создаёт неограниченный рост памяти Core.
- Web-фаза может реализовать optimistic UI и IndexedDB outbox без изменения семантики API.

## Риски и контроль

| Риск | Контроль |
|---|---|
| `organizations.event_seq` становится bottleneck | короткая транзакция, lock metrics и benchmark перед усложнением |
| гонка backlog/live теряет event | register-before-watermark алгоритм и barrier tests |
| событие раскрывает старый body после revoke | минимальный event log, актуальная hydration и membership filtering |
| медленный клиент расходует память | bounded queue/window, ACK timeout, controlled disconnect |
| Redis становится скрытым источником истины | только IDs/watermarks/TTL, PostgreSQL fallback и failure tests |
| слишком ранняя абстракция скрывает транзакцию | concrete services и SQL рядом с модулем |
| retention ломает давно offline клиент | явный resync contract и snapshot checkpoints |

## Definition of Done

- Инкременты 2.0–2.5, включая 2.2a, закрыты без пропущенных correctness-тестов.
- REST/WS schemas и сгенерированные Go/TypeScript-типы синхронизированы.
- API-only end-to-end, failure suite, authorization и concurrency tests зелёные.
- Benchmark report сохранён и объясняет достигнутые пределы.
- ADR, protocol, OpenAPI и фактическое поведение не противоречат друг другу.
- Следующая web-фаза не требует изменения базовой семантики сообщений, retry, resume или read state.
