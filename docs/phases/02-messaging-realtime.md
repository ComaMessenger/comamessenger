# Фаза 2. Сообщения и realtime

## Цель

Сделать надёжное ядро переписки: сообщения, reply, треды, реакции, unread, черновики и доставку событий с восстановлением после разрыва соединения. В конце фазы два API-клиента могут полноценно общаться без web-интерфейса.

## В scope

- создание, редактирование и мягкое удаление текстовых сообщений;
- идемпотентность отправки через `client_msg_id`;
- Telegram-style reply и отдельные треды;
- реакции, закрепление и пересылка сообщений;
- read markers, unread и mentions;
- синхронизируемые черновики;
- WebSocket auth, события, heartbeat, backpressure и resume;
- временные presence/typing events;
- транзакционный durable event log;
- интеграционные и нагрузочные тесты realtime.

## Вне scope

- вложения и link previews;
- полнотекстовый поиск;
- push notifications;
- агентский runtime и streaming LLM tokens;
- Redis и multi-node fan-out — интерфейс закладывается, реализация остаётся in-process/Postgres;
- форматирование сверх согласованного markdown-подмножества.

## Пользовательские сценарии

- Пользователь отправляет сообщение и безопасно повторяет запрос после timeout без дубля.
- Второй участник получает сообщение по WebSocket и видит последовательный порядок событий.
- После отключения клиент возобновляет поток с `last_seq` либо получает `resync_required`.
- Пользователь отвечает цитатой в основной ленте или открывает отдельный тред.
- Участник помечает видимое сообщение прочитанным; unread уменьшается на всех его устройствах.
- Member группового чата пишет сообщения, а member канала получает `forbidden`; owner/admin канала может публиковать и отвечать в тредах.
- Черновик, созданный на одном устройстве, появляется на другом.

## Технические задачи

### Сообщения

- [ ] Создать миграции `messages`, `message_revisions`, `threads`, `thread_followers`, `reactions`, `pins`, `forwards` либо согласованное представление пересылок.
- [ ] Ввести серверный порядок сообщений, независимый от клиентского ID и часов клиента.
- [ ] Сделать `(actor_id, client_msg_id)` уникальным и возвращать исходный результат при повторе.
- [ ] Валидировать максимальный размер body, пустые сообщения и допустимое markdown-подмножество.
- [ ] Санитизировать render output; хранить исходный текст и формат отдельно.
- [ ] При мягком удалении сохранять связи reply/thread и безопасную системную заглушку.
- [ ] Сохранять историю редакций для аудита.

### Reply и треды

- [ ] Проверять, что `reply_to_id` доступен актору и относится к тому же chat.
- [ ] Лениво создавать thread для root message в конкурентно-безопасной транзакции.
- [ ] Запретить вложенные thread roots, сохранив возможность `reply_to_id` внутри треда.
- [ ] Автоматически подписывать автора root, ответивших и упомянутых согласно настройкам.
- [ ] Реализовать follow/unfollow и отдельный список followed/unread threads.
- [ ] Применять channel posting policy как к основной ленте, так и к thread replies.

### События и WebSocket

- [ ] Создать `events` и писать изменение доменных таблиц + durable event в одной транзакции.
- [ ] Публиковать committed events в in-process broker; не отправлять неподтверждённые транзакции.
- [ ] Реализовать WS-команды `auth`, `resume`, `subscribe_active`, `typing`, `presence`, `ping/pong`.
- [ ] Фильтровать каждое событие по текущему membership и правам получателя.
- [ ] Ограничить исходящий буфер; при переполнении закрывать соединение с кодом, допускающим resume.
- [ ] Реализовать retention event log и ответ `resync_required`, если требуемая дельта удалена.
- [ ] Разделить durable events и ephemeral typing/presence: последние не пишутся в основную таблицу событий.

### Read state и unread

- [ ] Создать `chat_reads` и `thread_reads` с серверным sequence marker.
- [ ] Считать unread только по доступным, не удалённым сообщениям после marker.
- [ ] Отдельно рассчитывать mentions/unread threads.
- [ ] Сделать read marker монотонным: старое устройство не может сдвинуть его назад.
- [ ] Публиковать read event другим сессиям того же пользователя без раскрытия его лишним участникам.

### Реакции, typing, presence и drafts

- [ ] Обеспечить уникальность реакции `(message_id, actor_id, emoji)`.
- [ ] Ограничить частоту typing/presence и их TTL.
- [ ] Не считать агента или фоновые соединения автоматически online без выбранной политики.
- [ ] Создать upsert/delete API черновиков с optimistic version или `updated_at` conflict rule.

## Контракты и данные

Основные endpoints:

```text
GET    /api/v1/chats/:id/messages
POST   /api/v1/chats/:id/messages
PATCH  /api/v1/messages/:id
DELETE /api/v1/messages/:id
POST   /api/v1/messages/:id/reactions
DELETE /api/v1/messages/:id/reactions/:emoji
POST   /api/v1/messages/:id/pin
DELETE /api/v1/messages/:id/pin
POST   /api/v1/messages/:id/thread
GET    /api/v1/threads
GET    /api/v1/threads/:id/messages
PUT    /api/v1/threads/:id/follow
DELETE /api/v1/threads/:id/follow
POST   /api/v1/chats/:id/read
POST   /api/v1/threads/:id/read
PUT    /api/v1/drafts/:chat_id
GET    /api/v1/events?since=:seq
WS     /api/v1/ws
```

- Durable envelope: `{type, seq, occurred_at, actor_id, chat_id?, data}`.
- Ephemeral envelope не имеет durable `seq` и не используется для resume.
- Pagination cursor основан на серверном порядке, а не на предоставленном клиентом UUID или `client_msg_id`.
- Клиент подтверждает последний применённый durable `seq`, а не просто последний полученный пакет.

## Критерии приёмки

- 100 повторов одного `client_msg_id` создают одно сообщение и одно `message.created` событие.
- События становятся видны только после commit и имеют строгий порядок внутри организации.
- После разрыва клиент получает все пропущенные durable events без дублей на уровне состояния.
- Пользователь без membership не может получить body сообщения через REST, WS, reply preview или thread endpoint.
- Read marker не откатывается назад при конкуренции устройств.
- Member канала не может отправить сообщение обходом UI ни в ленту, ни в тред.
- Медленный WS-клиент отключается контролируемо и затем восстанавливается через resume.

## Проверка качества

- Интеграционные тесты транзакционности message + event.
- Property/concurrency tests для идемпотентности, thread creation и read markers.
- Тесты reconnect до/после commit, повторной доставки и `resync_required`.
- Security-тесты membership filtering для REST, WS и long-poll.
- Нагрузочный профиль: 2 000 WS и целевой поток 200 сообщений/с на согласованной машине; результаты сохраняются как benchmark report.
- Тесты markdown/XSS, oversized payload и rate limiting typing.

## Риски и открытые вопросы

- До миграции решить конкретную модель серверного порядка: event sequence на сообщении или отдельный chat sequence.
- Уточнить UX пересылки: snapshot исходного текста или ссылка на оригинал с проверкой доступа.
- Зафиксировать retention durable events и поведение full resync.
- Решить, кто видит read receipts: только сам пользователь или также другие участники.

## Definition of Done

- Все REST/WS контракты описаны и сгенерированы из protocol package.
- API-only end-to-end сценарий двух пользователей проходит автоматически.
- Reconnect, authorization и concurrency тесты зелёные.
- Нагрузочный отчёт подтверждает целевую планку либо содержит согласованное изменение цели.
- Web-фаза может строить интерфейс без изменения базовой семантики сообщений.
