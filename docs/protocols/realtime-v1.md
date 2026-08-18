# Realtime protocol v1

Этот документ фиксирует контракт между Core и клиентами для фазы 2. Он дополняет [ADR-0006](../decisions/0006-messaging-delivery-and-realtime.md). Машиночитаемый wire contract хранится в [`packages/protocol/schemas/realtime/v1.schema.json`](../../packages/protocol/schemas/realtime/v1.schema.json), подключается к OpenAPI и генерирует Go/TypeScript-типы и общие fixtures.

## 1. Термины и гарантии

- **Command** — REST-запрос, изменяющий состояние.
- **Durable event** — закоммиченное событие с sequence number, доступное для resume.
- **Ephemeral event** — typing/presence-сигнал без хранения и resume.
- **Checkpoint** — максимальный непрерывный `seq`, который клиент применил к локальному состоянию и сохранил.
- **ACK** — подтверждение checkpoint конкретным WebSocket-соединением; это не read receipt.

Сервер может повторно доставить durable event. Клиент не должен предполагать exactly-once delivery.

## 2. REST-команды и повторы

### Создание сообщения

```json
POST /api/v1/chats/{chat_id}/messages
{
  "client_msg_id": "0198...",
  "body": "Привет",
  "body_format": "plain",
  "reply_to_id": null,
  "thread_root_id": null
}
```

Успешный ответ всегда содержит серверные `id`, `created_seq`, `version` и исходный `client_msg_id`. Идемпотентный повтор возвращает тот же ресурс и не создаёт новое событие.

`client_msg_id` сравнивается вместе с каноническими полями команды. Несовпадение возвращает:

```json
{
  "code": "idempotency_conflict",
  "message": "client_msg_id is already used for another command",
  "request_id": "0198..."
}
```

### Стабильные error codes фазы 2

- `idempotency_conflict` — idempotency key уже связан с другой командой;
- `version_conflict` — `expected_version` устарел;
- `forbidden` — у actor нет текущего membership или permission;
- `message_not_found` — сообщение отсутствует либо недоступно actor;
- `payload_too_large` — body или frame превышает настроенный предел;
- `unsupported_format` — `body_format` не поддерживается;
- `rate_limited` — превышен лимит, при возможности сервер отдаёт `Retry-After`.

Полный enum, включая auth/chat ошибки предыдущей фазы, находится в `components.schemas.ErrorCode` OpenAPI.

### Retry policy клиента

| Результат                  | Действие                                      |
| -------------------------- | --------------------------------------------- |
| HTTP `2xx`                 | принять серверный результат                   |
| timeout / network error    | повторить с тем же idempotency key            |
| `429`                      | учесть `Retry-After`, затем повторить         |
| `5xx`                      | повторить с exponential backoff и full jitter |
| обычный `4xx`              | не повторять автоматически                    |
| `409 idempotency_conflict` | прекратить повторы и показать ошибку клиента  |

Начальная задержка — 500 мс, верхняя граница — 30 секунд. После стабильного успешного обмена backoff сбрасывается.

Редактирование передаёт `expected_version`. Конфликт версии возвращает `409 version_conflict` и актуальную версию ресурса. DELETE повторяем и считаем успешным, если ресурс уже был мягко удалён.

## 3. Установка WebSocket-соединения

Endpoint: `GET /api/v1/ws`, только `wss` вне development. Сервер проверяет `Origin` по `PUBLIC_APP_URL`, ограничивает размер frame и не принимает bearer token в query string.

В течение 5 секунд после upgrade клиент отправляет:

```json
{
  "op": "auth",
  "request_id": "0198...",
  "access_token": "...",
  "last_seq": 1842
}
```

`last_seq=0` означает отсутствие checkpoint. После проверки сервер отвечает:

```json
{
  "op": "hello",
  "request_id": "0198...",
  "connection_id": "0198...",
  "current_seq": 1901,
  "min_retained_seq": 1200,
  "heartbeat_interval_ms": 25000,
  "ack_interval_ms": 1000,
  "ack_batch_size": 50,
  "max_unacked_events": 128
}
```

Ошибка auth закрывает соединение кодом `4001`. Истёкший access token обновляется обычным auth flow, после чего клиент создаёт новое соединение с прежним checkpoint.

## 4. Durable events

Envelope:

```json
{
  "op": "event",
  "seq": 1901,
  "type": "message.created",
  "occurred_at": "2026-08-18T12:00:00Z",
  "actor_id": "0198...",
  "chat_id": "0198...",
  "subject_id": "0198...",
  "data": {}
}
```

Обязательные поля: `op`, `seq`, `type`, `occurred_at`, `actor_id`, `subject_id`. `chat_id` присутствует у chat-scoped events. `data` содержит разрешённое клиентское представление или минимальную дельту, определённую схемой конкретного типа.

Фаза 2 вводит типы:

- `message.created`, `message.updated`, `message.deleted`;
- `reaction.added`, `reaction.removed`;
- `thread.followed`, `thread.unfollowed`;
- `read.marked` — доставляется только другим сессиям того же actor;
- `draft.updated`, `draft.deleted` — доставляются только тому же actor;
- необходимые `chat.*` и `member.*` события фазы 1 для корректного обновления permissions и membership.

Unknown event type игнорируется по содержимому, но его `seq` всё равно считается применённым после безопасного обновления checkpoint. Удаление обязательного поля или изменение его смысла требует новой версии протокола.

## 5. Resume без гонки backlog/live

Сервер выполняет подключение в следующем порядке:

1. аутентифицирует actor и фиксирует его текущий доступ;
2. регистрирует bounded live queue соединения;
3. читает текущий high watermark организации;
4. отдаёт разрешённые события `(last_seq, high_watermark]` по возрастанию `seq`;
5. удерживает live events, пришедшие во время backlog;
6. отбрасывает из live queue события `seq <= high_watermark`;
7. продолжает live delivery строго по `seq`.

Фильтрация выполняется по актуальному membership. Утрата доступа не должна раскрывать body через backlog. Адресное событие удаления участника может быть доставлено ему, чтобы клиент немедленно удалил недоступный chat из cache.

Клиент:

1. отбрасывает `seq <= checkpoint`;
2. при ожидаемом следующем `seq` идемпотентно применяет событие;
3. сохраняет новый checkpoint после обновления cache;
4. периодически отправляет ACK.

Отсутствие chat-scoped события между двумя seq не считается разрывом: глобальная последовательность содержит события, которые могут быть не видны конкретному actor. Сервер доставляет поток с монотонно растущими, но не обязательно соседними seq.

## 6. ACK и backpressure

```json
{
  "op": "ack",
  "seq": 1901
}
```

Клиент отправляет ACK после 50 применённых событий или через 1 секунду, что наступит раньше. ACK монотонный. Он управляет памятью и диагностикой соединения, но не удаляет durable events и не меняет unread.

На соединение действуют обе границы:

- не более 256 queued events или 1 MiB сериализованных данных;
- не более 128 отправленных, но не подтверждённых durable events.

При переполнении, ACK timeout или невозможности сохранить порядок сервер закрывает соединение `4008 slow_consumer`. Клиент восстанавливается с сохранённого checkpoint.

### Лимиты по умолчанию

| Переменная                                  |  Значение | Назначение                                 |
| ------------------------------------------- | --------: | ------------------------------------------ |
| `MESSAGE_MAX_BODY_BYTES`                    |    65 536 | максимальный UTF-8 body сообщения          |
| `MESSAGE_MAX_PAGE_SIZE`                     |       100 | максимальная страница истории              |
| `WS_AUTH_TIMEOUT`                           |        5s | время на первый auth frame                 |
| `WS_MAX_FRAME_BYTES`                        |   262 144 | максимальный входящий/исходящий JSON frame |
| `WS_MAX_CONNECTIONS_PER_ACTOR`              |        10 | защита от неограниченных вкладок/устройств |
| `WS_MAX_QUEUED_EVENTS`                      |       256 | число событий в outbound queue             |
| `WS_MAX_QUEUED_BYTES`                       | 1 048 576 | байтовый предел outbound queue             |
| `WS_MAX_UNACKED_EVENTS`                     |       128 | окно отправленных durable events           |
| `WS_ACK_INTERVAL` / `WS_ACK_BATCH_SIZE`     |   1s / 50 | частота клиентского ACK                    |
| `WS_ACK_TIMEOUT`                            |       30s | предел ожидания продвижения ACK            |
| `WS_HEARTBEAT_INTERVAL` / `WS_PONG_TIMEOUT` | 25s / 10s | проверка живости соединения                |
| `EVENT_POLL_INTERVAL`                       |     200ms | recovery polling committed events          |
| `EVENT_RETENTION`                           |       72h | временное окно delivery log                |
| `EVENT_RETENTION_MIN_COUNT`                 |   100 000 | минимальный хвост событий организации      |

Зависимые значения валидируются при старте Core: например, unacked window не может быть больше event queue, а Pong timeout должен быть короче heartbeat interval.

## 7. Heartbeat и закрытие

Core отправляет WebSocket Ping каждые 25 секунд и ожидает Pong не более 10 секунд. Reader и writer имеют deadlines, а на соединение работает ровно один writer goroutine.

| Код    | Причина                   | Поведение клиента                         |
| ------ | ------------------------- | ----------------------------------------- |
| `1000` | нормальное закрытие       | переподключаться только при необходимости |
| `1008` | protocol/policy violation | не повторять без исправления запроса      |
| `1012` | restart Core              | переподключиться с jitter                 |
| `4001` | auth failed/expired       | refresh, затем reconnect                  |
| `4008` | slow consumer             | reconnect с checkpoint                    |
| `4009` | history unavailable       | выполнить full resync                     |

Reconnect использует full jitter от 500 мс до 30 секунд и сбрасывает backoff после стабильного соединения.

## 8. Full resync

Если `last_seq < min_retained_seq`, сервер до обычного event stream отправляет:

```json
{
  "op": "resync_required",
  "current_seq": 250000,
  "min_retained_seq": 150000,
  "reason": "event_history_expired"
}
```

Затем соединение закрывается кодом `4009`. Клиент:

1. сохраняет локальный outbox и drafts;
2. получает snapshot списка chats и unread;
3. заново получает историю открытых экранов;
4. атомарно устанавливает checkpoint в `current_seq` snapshot;
5. подключается снова с этим checkpoint.

## 9. Ephemeral operations

Активный экран:

```json
{ "op": "subscribe_active", "chat_id": "0198...", "thread_root_id": null }
```

Typing:

```json
{ "op": "typing", "chat_id": "0198...", "thread_root_id": null, "active": true }
```

Presence activity:

```json
{ "op": "presence", "state": "active" }
```

Серверная presence-дельта содержит `actor_id`, вычисленное состояние `online|away|offline` и `expires_at`.

Typing/presence проверяются по membership, ограничиваются rate limit и TTL, могут теряться и не влияют на correctness. `subscribe_active` используется только для ephemeral routing и подавления push в активном экране.

## 10. Failure matrix

| Сбой                                  | Ожидаемый результат                                   |
| ------------------------------------- | ----------------------------------------------------- |
| timeout до отправки HTTP body         | повтор того же `client_msg_id` создаёт одно сообщение |
| timeout после DB commit               | повтор возвращает уже созданное сообщение             |
| Core упал после commit до wake-up     | dispatcher находит событие polling-ом после запуска   |
| WS event пришёл раньше HTTP response  | optimistic item объединяется по `client_msg_id`       |
| event доставлен повторно              | reducer не создаёт второе состояние                   |
| disconnect во время backlog           | следующий resume начинается с сохранённого checkpoint |
| membership отозван во время reconnect | недоступное содержимое не попадает в backlog          |
| клиент не читает socket               | bounded queue закрывает соединение `4008`             |
| checkpoint старше retention           | клиент получает `resync_required` и snapshot          |

## 11. Версионирование

В v1 envelope расширяется только новыми необязательными полями и новыми event types. Breaking change требует нового endpoint или согласованного protocol version в auth/hello.

`pnpm generate` детерминированно собирает JSON Schema в committed OpenAPI bundle, генерирует TypeScript и типизированные fixtures. `oapi-codegen` генерирует Go-модели из того же bundle. CI повторяет генерацию, проверяет чистый diff, валидирует общие JSON fixtures исходной схемой и декодирует их generated Go types.
