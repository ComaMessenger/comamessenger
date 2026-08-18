# ADR-0006: надёжная доставка сообщений и realtime

- Статус: принято
- Дата: 2026-08-18

## Контекст

Сообщение проходит через HTTP-запрос, транзакцию PostgreSQL, realtime-доставку и локальное состояние клиента. На каждом участке возможны timeout, повтор запроса, разрыв соединения или перезапуск Core. Система не должна создавать дубли, терять закоммиченные изменения или раскрывать содержимое чатов после отзыва доступа.

При этом базовая self-hosted поставка должна оставаться модульным монолитом без Kafka, NATS и абстракций под реализации, которых ещё нет. Redis принят отдельным [ADR-0007](0007-redis-coordination.md) только как координационный и краткоживущий слой.

## Решение

### Гарантии

- PostgreSQL является единственным источником истины.
- Команды изменения состояния идут через REST. WebSocket переносит серверные события и краткоживущие сигналы.
- Транспорт событий имеет семантику **at least once**: повторная доставка допустима.
- Доменные изменения имеют семантику **effectively once** благодаря idempotency key, уникальным ограничениям и идемпотентным клиентским reducers.
- HTTP `2xx` подтверждает сохранение команды. WebSocket ACK подтверждает только применение durable events конкретной сессией. Read marker является отдельным пользовательским действием.
- Обещание exactly-once delivery не даётся.

### Серверный порядок

У организации есть поле `event_seq bigint not null default 0`. Каждая durable-мутация в своей короткой транзакции:

1. проверяет текущие membership и permissions;
2. проверяет идемпотентность команды;
3. атомарно увеличивает `organizations.event_seq`;
4. записывает доменную сущность и `events` с полученным `seq`;
5. коммитит транзакцию;
6. после commit неблокирующе будит realtime dispatcher.

Обычный PostgreSQL sequence не используется как логический порядок: `nextval` не откатывается и не задаёт порядок commit. Единый sequence организации является порядком всех durable events. Пропуски между сообщениями одного чата нормальны.

`messages.created_seq` совпадает с `seq` события `message.created` и используется для pagination и read markers.

### Идемпотентность команд

Клиент создаёт `client_msg_id` один раз на логическую отправку. Для сообщений действует уникальность `(actor_id, client_msg_id)`.

- Повтор с тем же ID и тем же каноническим payload возвращает исходный результат.
- Повтор с тем же ID, но другим chat, body, format, reply или thread root возвращает `409 idempotency_conflict`.
- Timeout означает неизвестный результат, поэтому клиент повторяет тот же запрос с тем же ID.
- Редактирование использует `expected_version`, удаление идемпотентно, реакции моделируются как PUT/DELETE, read marker увеличивается через `GREATEST`.

### Durable event log

Таблица `events` одновременно является журналом восстановления и transactional outbox. Отдельная outbox-таблица не создаётся.

Событие хранит routing metadata и идентификатор изменённой сущности, но не становится второй копией всей доменной модели. При доставке сервер строит разрешённое представление по актуальному состоянию и текущему membership.

In-process hub и Redis не являются источниками истины. Потерянный wake-up, разрыв Redis или перезапуск Core компенсируются периодическим чтением committed events из PostgreSQL.

### WebSocket и восстановление

- Один WebSocket на клиентскую сессию.
- Первым frame клиент отправляет `auth` с access token и последним применённым `last_seq`.
- Сервер сначала фиксирует live-подключение и high watermark, затем отдаёт backlog `(last_seq, high_watermark]`, после чего продолжает live-поток.
- Клиент применяет события идемпотентно и сохраняет checkpoint только после изменения локального cache.
- Сервер ограничивает очередь и число неподтверждённых событий. Медленный клиент отключается и восстанавливается через resume.
- Durable events имеют `seq`; typing и presence не имеют `seq`, не подтверждаются и не восстанавливаются.
- `subscribe_active` влияет только на typing, presence и подавление уведомлений. Durable события, необходимые для списка чатов и unread, не зависят от активного чата.

Точный wire contract, лимиты и close codes определены в [`../protocols/realtime-v1.md`](../protocols/realtime-v1.md).

### Retention и full resync

По умолчанию сохраняются события за последние 72 часа и не менее последних 100 000 событий организации. Событие удаляется, только если оно одновременно старше временного окна и находится ниже количественного порога.

Если `last_seq` старше доступной истории, сервер возвращает `resync_required` с текущим high watermark. Клиент заново получает chats, unread и нужную историю, атомарно устанавливает checkpoint и переподключается.

### Минимальная модель

- Отдельная таблица `threads` не создаётся: ID root message является ID треда, ответы содержат `thread_root_id`.
- `reply_to_id` остаётся независимым от `thread_root_id` и обозначает цитируемое сообщение.
- `message_revisions` появляется вместе с редактированием.
- `reactions`, `chat_reads`, `thread_followers` и `drafts` добавляются только в инкрементах соответствующих функций.
- Таблица online deliveries и отдельные repositories/interfaces для каждой таблицы не создаются.
- Конкретные `eventlog.Store` и `realtime.Hub` предпочтительнее общего `EventBus` до появления второй реализации.

### Продуктовые правила v1

- Другие участники не видят персональные read receipts; пользователь синхронизирует только собственный read state между сессиями.
- Автор может редактировать и мягко удалять свои сообщения без временного окна. Owner/admin чата может удалить любое сообщение. Ревизии доступны только аудиту.
- Пересылка создаёт независимый snapshot с атрибуцией источника на момент пересылки. Удаление оригинала не удаляет копию.
- Browser Push по умолчанию показывает отправителя и чат; body preview включается пользователем.
- Notification permission запрашивается только после явного действия пользователя и только когда service worker и доставка уже готовы.

### Масштабирование

В фазе 2 официально поддерживается один экземпляр Core. Цель — 2 000 WebSocket-соединений и 200 сообщений/с на согласованной машине.

Redis Pub/Sub добавляется в инкременте 2.2a как быстрый wake-up поверх PostgreSQL event log и основа для ephemeral state. Multi-node topology остаётся неподдерживаемой до phase 7; NATS, Kafka и PostgreSQL LISTEN/NOTIFY не добавляются. REST/WS-контракты и durable event log от Redis не зависят.

## Последствия

- Закоммиченное сообщение восстанавливается даже при падении Core между commit и realtime-публикацией.
- Сбой Redis может увеличить задержку до следующего PostgreSQL poll и временно убрать ephemeral signals, но не теряет durable event.
- Повтор HTTP-команды или WebSocket-события безопасен и ожидаем.
- Единый sequence упрощает resume, unread и диагностику, но сериализует короткий участок durable-мутаций организации; ограничение проверяется нагрузочным тестом.
- Клиент обязан иметь idempotent reducer и долговечный checkpoint.
- Горизонтальное масштабирование сознательно отложено, но не требует изменения публичного протокола.

## Ссылки

- [PostgreSQL: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html) — `nextval` не откатывается и не подходит для gapless/commit ordering.
- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455) — framing, Ping/Pong и close semantics.
- [MDN: WebSocket.bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount) — наблюдаемая очередь браузерного WebSocket не заменяет серверный backpressure.
- [MDN: Notification.requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static) — permission flow после пользовательского действия.
- [`coder/websocket`](https://github.com/coder/websocket) — выбранная Go-реализация WebSocket.
- [ADR-0007](0007-redis-coordination.md) — роль Redis, режим деградации и отказ от второго durable log.
