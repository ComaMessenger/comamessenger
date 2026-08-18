# ADR-0007: Redis как координационный, а не долговечный слой

- Статус: принято
- Дата: 2026-08-19

## Контекст

Coma уже хранит доменное состояние и журнал доставки в PostgreSQL. Такой дизайн обеспечивает транзакционность сообщения и события, восстановление после перезапуска и resume WebSocket по `seq`, но один только polling PostgreSQL создаёт лишнюю задержку и нагрузку. Кроме того, presence, typing и распределённые rate limits требуют общего краткоживущего состояния при нескольких экземплярах Core.

Нужно добавить Redis без второго источника истины, двойной записи долговечных событий и обязательного сложного брокера.

## Решение

### Поддерживаемая топология

- Redis Open Source 8.x входит в стандартный Docker Compose начиная с инкремента 2.2a. Release bundle фиксирует конкретную версию образа, а не плавающий `latest`.
- Core получает адрес через `REDIS_URL`. Внешний Redis поддерживается наравне со встроенным контейнером.
- Режим без Redis допустим только для single-core development/recovery и должен быть включён явно. Официальная production Compose-топология включает Redis.
- Горизонтальный запуск нескольких Core считается поддерживаемым только после phase 7 load/failure tests.

### Граница ответственности

PostgreSQL остаётся единственным источником истины для:

- сообщений, реакций, тредов, read markers и drafts;
- membership, permissions, sessions и API keys;
- durable `events`, audit и фоновых jobs;
- unread, который может кэшироваться, но всегда пересчитывается из PostgreSQL.

Redis используется только для:

- wake-up сигнала экземплярам Core после commit durable event;
- fan-out краткоживущих `typing`, `presence` и streaming-delta сигналов;
- TTL-состояния presence/typing и распределённых rate limits;
- короткоживущих кэшей, для которых определены TTL, invalidation и восстановление из PostgreSQL.

В Redis не хранятся message body, файлы, долговечный checkpoint клиента или единственная копия какого-либо пользовательского состояния. Backup Redis не требуется.

### Durable realtime

1. Core в одной транзакции записывает доменное изменение и `events` в PostgreSQL.
2. Только после успешного commit он публикует компактный сигнал `{org_id, high_watermark}` в Redis Pub/Sub.
3. Каждый Core по сигналу будит локальный dispatcher, который читает разрешённые события из PostgreSQL и двигает in-process hub.
4. Периодический PostgreSQL polling остаётся recovery path при потерянном сигнале, разрыве Redis или рестарте подписчика.

Dispatcher хранит только watermark, а не загружает все события в память. Каждая WebSocket-сессия читает диапазон `(last_seq, high_watermark]` ограниченными батчами; размер ограничен `WS_MAX_UNACKED_EVENTS`, `WS_MAX_QUEUED_EVENTS` и `WS_MAX_QUEUED_BYTES`. После ACK берётся следующий батч. Один сигнал поэтому не превращает импорт или всплеск агентских ответов в неограниченную выборку на каждой реплике.

Wake-up коалесцируются в коротком окне `EVENT_WAKE_COALESCE`: несколько local/Redis сигналов приводят к одной проверке PostgreSQL watermark. Окно ограничивает частоту запросов при burst, но не заменяет настраиваемый `EVENT_POLL_INTERVAL` fallback.

Redis Pub/Sub имеет семантику at-most-once, поэтому его сообщение является только подсказкой «проверь durable log». Потеря и повтор wake-up одинаково безопасны. Публичные REST/WS гарантии остаются определёнными ADR-0006.

Redis Streams сейчас не используются: они создали бы второй durable log, отдельные retention/ACK/recovery правила и проблему согласования с PostgreSQL. Индексатор, push, обработка файлов и агенты сначала используют PostgreSQL event log/River. К Streams или отдельному брокеру возвращаемся только после benchmark, доказавшего недостаточность этого пути, а не из-за самого факта появления новых consumers.

### Отказы и эксплуатация

- Недоступность Redis не отклоняет уже валидированную durable-команду и не откатывает PostgreSQL commit.
- При runtime-сбое Core переходит на PostgreSQL polling; ephemeral typing/presence могут временно исчезнуть, что допустимо.

Для ephemeral операций политика иная, чем для durable команд: при `REDIS_MODE=required` недоступность Redis даёт non-fatal WS error `service_unavailable` и операция не публикуется. Это fail-closed, потому что локальный fan-out при нескольких Core создал бы расходящееся presence/typing state и обошёл бы распределённый rate limit. Durable message/read/draft транзакции от Redis не зависят и продолжают доставляться PostgreSQL polling-ом.
- Некорректная конфигурация выявляется при старте. Потеря соединения после старта отражается как degraded dependency, но не делает весь мессенджер недоступным.
- После reconnect подписчик не пытается воспроизвести пропущенный Pub/Sub: dispatcher сверяет watermark с PostgreSQL.
- Ключи имеют versioned namespace `coma:v1:*`, обязательный TTL и не содержат message body, access tokens или другие секреты.
- Redis запускается без требования к persistence; memory policy и лимит памяти задаются deployment-профилем для краткоживущих данных.

### Код и наблюдаемость

- Не вводится универсальный `EventBus` или общий cache repository. Реализуется маленький конкретный Redis coordinator вокруг фактических операций Pub/Sub и TTL.
- Метрики различают publish/subscription errors, reconnects, fallback polls, wake-up latency, key count и memory pressure.
- Dispatcher отдельно считает и логирует `local_commit`, `redis` и `polling_fallback` triggers, а также число коалесцированных wake-up. Падение Redis должно быть видно как рост доли fallback polling до пользовательских жалоб.
- Обязательны тесты потерянного/повторного сигнала, отключения Redis во время трафика, reconnect и нескольких Core.

## Последствия

- В стандартной установке появляется один дополнительный лёгкий процесс и соответствующая эксплуатационная зависимость.
- Realtime реагирует на commit быстрее и получает понятный путь к нескольким Core.
- Корректность сообщений, idempotency и resume не зависят от сохранности Redis.
- Мы сознательно не используем Redis как универсальное хранилище «потому что он уже есть».

## Ссылки

- [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/) — at-most-once и отсутствие replay.
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/) — persistence, acknowledgements и consumer groups, которые сейчас дублировали бы PostgreSQL event log.
- [Redis licensing](https://redis.io/legal/licenses/) — Redis 8 доступен в том числе под AGPLv3.
- [ADR-0006: надёжная доставка сообщений и realtime](0006-messaging-delivery-and-realtime.md).
