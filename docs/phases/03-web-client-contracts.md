# Phase 3.0: инвентаризация клиентских контрактов

Дата сверки: 2026-08-19. Gate закрыт по итогам фазы 3; источник истины — [OpenAPI](../../packages/protocol/openapi.yaml), [Realtime protocol v1](../protocols/realtime-v1.md) и текущая реализация Core.

Правило фазы: экран или действие попадает в инкремент только после появления server contract в `packages/protocol`, generated clients и integration test. Наличие таблицы или типа события без reachable endpoint/producer не считается готовым контрактом.

## Уже готово на сервере

| Возможность                    | Контракт                                       | Статус клиентского adapter |
| ------------------------------ | ---------------------------------------------- | -------------------------- |
| Bootstrap/login/refresh/logout | `/bootstrap`, `/auth/*`                        | готово                     |
| Profile и sessions             | `/me`, `/sessions`                             | готово                     |
| Invitations                    | create/accept                                  | готово                     |
| Chats/channels и membership    | `/chats`, discover/join, CRUD, members         | готово                     |
| История и отправка сообщений   | list/create/update/delete/context              | готово                     |
| Reactions, pins, forward       | message action endpoints                       | готово                     |
| Threads и follow               | thread history, followed list, follow/unfollow | готово                     |
| Unread и read markers          | `/unread`, chat/thread read                    | готово                     |
| Drafts                         | list/put/delete с version                      | готово                     |
| Durable/ephemeral realtime     | WS v1, ACK/resume, typing/presence             | готово                     |
| Web Push и preferences         | subscriptions, global/chat preferences         | готово                     |

Таким образом, message actions, thread follow и drafts не являются незакоммиченными предположениями: они уже входят в OpenAPI и проходят Core integration tests. Сообщения не должны ожидать появления нового backend API, кроме перечисленных ниже точечных пробелов.

## Закрытые контрактные пробелы

### 1. Chat summary для desktop и mobile sidebar

`Chat` и `GET /chats` теперь содержат закоммиченный summary contract:

- вычисленным display title для DM и non-DM;
- direct peer `{actor_id, display_name, handle}` либо эквивалентной безопасной проекцией;
- `last_activity_seq`, `last_message_at` и bounded last-message preview/tombstone;
- детерминированными avatar initials/color seed; file-backed avatar остаётся фазе 4;
- kind/role/visibility, достаточными для read-only channel UX.

Unread/mention counts остаются отдельным `/unread` snapshot и объединяются reducer-ом по `chat_id`.

### 2. Каталог участников

Создание DM/group, добавление участников и structured mention autocomplete используют typed paginated/searchable `GET /actors` с минимальной безопасной проекцией.

### 3. Targeted history window

`GET /messages/{message_id}/context` возвращает bounded window с membership checks и признаками продолжения в обе стороны.

### 4. Durable chat/member producers

`chat.Service` транзакционно пишет `chat.created/updated/archived` и `member.joined/updated/removed`, затем вызывает after-commit wake-up. Удалённый участник получает только адресованный revoke event без содержимого чата.

### 5. Preferences и Web Push

Push contract и worker реализованы:

- получение browser push public key/config;
- create/rotate/delete subscription, привязанной к actor/session/device;
- notify level/mute и privacy-preview preferences;
- серверная suppression policy для active chat/thread;
- безопасный payload и deep-link contract.

Push delivery начинается от committed durable event и retryable Postgres-backed job, а не напрямую от Redis Pub/Sub. Доставка идемпотентна на пару event/subscription, проверяет mute/mention policy в момент отправки и удаляет permanently invalid subscription после provider `404/410`. Redis active-screen lease может подавить лишний push, но не является источником notification correctness.

Permission UI можно проектировать раньше, но реальный browser prompt включается только после готового service worker, проверки поддержки и успешного server registration path.

## Не блокирует первые инкременты

- Аватары фазы 3 генерируются из initials и стабильного color seed; upload/file delivery остаются фазе 4.
- RU/EN locale и theme могут сначала храниться локально. Cross-device preference sync добавляется только после появления typed preferences contract.
- Search в Phase 3 фильтрует локально загруженные chat summaries; глобальный поиск остаётся фазе 4.

## Gate

- Каркас design system/router/i18n не зависит от новых server endpoints.
- Read-only mobile/desktop chat list начинается после Chat summary contract.
- Virtualized history может начаться на существующем `before_seq`; jump-to-message принимается только после targeted window.
- Realtime messages можно подключать на текущем WS; realtime sidebar ждёт durable chat/member producers.
- Composer/actions/drafts/threads используют уже готовые контракты после расширения `MessengerAPI`.
- Web Push ждёт полный пункт 5 и не реализуется через локальную имитацию.
