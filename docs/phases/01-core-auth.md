# Фаза 1. Ядро, пользователи и чаты

## Цель

Реализовать безопасную основу одного организационного пространства: первоначальную настройку, пользователей, сессии, приглашения, профили, чаты, каналы и централизованную авторизацию. Сообщения и realtime в этой фазе не реализуются.

## Статус на 18 августа 2026

Два вертикальных инкремента реализованы и проходят автоматический API smoke-test на чистом Compose:

- одноразовый bootstrap организации и owner;
- Argon2id, короткоживущий JWT access token, opaque refresh cookie, rotation и обнаружение reuse с отзывом всей session family;
- login, logout, профиль, список и отзыв сессий;
- одноразовые приглашения с TTL и acceptance flow; в development ссылка возвращается только авторизованному owner/admin;
- создание и membership-filtered чтение групповых чатов, каналов и дедуплицированных direct chats;
- UUIDv7, базовая матрица `authz`, audit событий bootstrap/invitation/chat;
- ограничения Postgres на один organization, private direct и наличие последнего активного owner;
- изменение и архивирование групповых чатов/каналов; архивированные сущности исключаются из активного списка;
- список, добавление, удаление и роли участников с защитой последнего owner;
- обнаружение публичных чатов и каналов и самостоятельное вступление;
- минимальный web-flow: bootstrap, login, acceptance приглашения, sidebar, создание чата/канала и public directory;
- OpenAPI 0.2.0 и синхронный Go/TypeScript-кодоген.

Следующий инкремент этой же фазы: список пользователей, деактивация с отзывом сессий, production email transport, UI управления участниками и интеграционные тесты конкурентных транзакций. После него начинаем фазу 2 — сообщения и realtime.

## В scope

- bootstrap первой организации и owner-пользователя;
- вход по email/паролю, refresh rotation, logout и управление сессиями;
- приглашения по одноразовой ссылке и подготовленный email transport;
- акторы типов `user` и `agent`, при этом создание агентов откладывается до фазы 5;
- профили, аватары-заглушки, handle, timezone;
- личные чаты, групповые чаты и каналы;
- public/private visibility для групп и каналов;
- membership и роли owner/admin/member;
- единый модуль `authz` и audit log для административных действий;
- REST API и интеграционные тесты на реальном Postgres.

## Вне scope

- magic link, OIDC, 2FA и восстановление пароля через email;
- сообщения, треды, реакции и WebSocket;
- гостевые аккаунты и несколько организаций в одном инстансе;
- сложные политики доступа, SCIM, LDAP и DLP;
- пользовательская загрузка аватаров в S3 — до фазы файлов используется generated avatar.

## Пользовательские сценарии

- При первом открытии администратор создаёт организацию и owner-аккаунт; повторный bootstrap невозможен.
- Owner создаёт приглашение, новый пользователь принимает его и входит в организацию.
- Пользователь создаёт групповой чат, добавляет участников и меняет название.
- Admin создаёт публичный или приватный канал и назначает другого администратора.
- Два пользователя получают один и тот же direct chat независимо от того, кто начал диалог.
- Member не может изменить роли, архивировать чужой чат или получить private chat без membership.

## Технические задачи

### Данные и доменная модель

- [x] Создать миграции `organizations`, `actors`, `users`, `sessions`, `invitations`, `chats`, `chat_members`, `audit_log`.
- [x] Добавить ограничения на уникальность email/handle внутри организации.
- [x] Обеспечить единственность direct chat для пары пользователей через нормализованный pair key или отдельную таблицу участников direct chat.
- [x] Запретить `visibility=public` для `kind=direct` на уровне БД и домена.
- [x] Гарантировать хотя бы одного owner организации и owner для группового чата/канала.

### Bootstrap и auth

- [x] Реализовать одноразовый bootstrap endpoint, доступный только до создания организации.
- [x] Хэшировать пароль Argon2id с параметрами из конфигурации и безопасными лимитами входа.
- [x] Выдавать короткоживущий access token и ротируемый refresh token.
- [x] Для web хранить refresh token в `HttpOnly`, `Secure`, `SameSite` cookie; в БД хранить только hash.
- [x] Обнаруживать повторное использование старого refresh token и отзывать цепочку сессии.
- [ ] Реализовать logout текущей сессии, logout всех сессий и список устройств.
- [x] Добавить rate limiting на bootstrap, login, refresh и invitation acceptance.

### Приглашения и пользователи

- [x] Создавать одноразовые invitation tokens с TTL, ролью и автором приглашения.
- [x] Реализовать acceptance flow без раскрытия существования чужих email.
- [ ] Подготовить интерфейс email sender и dev-реализацию, выводящую ссылку в защищённый локальный sink.
- [x] Реализовать чтение и изменение собственного профиля.
- [ ] Реализовать деактивацию пользователя с отзывом сессий без физического удаления истории.

### Чаты, каналы и права

- [x] Реализовать CRUD для `group` и `channel`, создание/получение `direct`.
- [x] Реализовать добавление, удаление и изменение роли участника.
- [x] Для public group/channel разрешить обнаружение и самостоятельное вступление согласно настройкам.
- [x] Для private group/channel требовать invitation/member action.
- [ ] Централизовать проверки в `authz.Can(actor, action, resource)`.
- [x] Ввести отдельные действия `chat.read`, `chat.manage`, `member.manage`, `message.publish`, `thread.reply`.
- [x] Для `kind=channel` разрешать `message.publish` и `thread.reply` только owner/admin.
- [x] Записывать административные изменения в `audit_log`.

## Контракты и данные

Основные endpoints:

```text
GET    /api/v1/bootstrap/status
POST   /api/v1/bootstrap
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/me
PATCH  /api/v1/me
GET    /api/v1/sessions
DELETE /api/v1/sessions/:id
POST   /api/v1/invitations
POST   /api/v1/invitations/:token/accept
GET    /api/v1/chats
POST   /api/v1/chats
GET    /api/v1/chats/discover
GET    /api/v1/chats/:id
PATCH  /api/v1/chats/:id
DELETE /api/v1/chats/:id
POST   /api/v1/chats/:id/join
GET    /api/v1/chats/:id/members
POST   /api/v1/chats/:id/members
PATCH  /api/v1/chats/:id/members/:actor_id
DELETE /api/v1/chats/:id/members/:actor_id
```

- Все ID — выбранный единый формат из ADR; клиент не определяет серверное время создания.
- `chats.kind`: `direct | group | channel`.
- `chats.visibility`: `private | public`; direct всегда private.
- Архивация предпочтительнее физического удаления чата.
- Membership проверяется в каждом list/get endpoint, а не только при записи.

## Критерии приёмки

- Bootstrap можно успешно выполнить один раз; повтор возвращает стабильную ошибку.
- Пароль и refresh token никогда не сохраняются и не логируются в открытом виде.
- После ротации refresh token старый токен не создаёт новую сессию.
- Private chat/channel отсутствует в ответах пользователя без membership.
- Обычный member не может повысить свою роль или писать в канал на уровне `authz`.
- Пара пользователей всегда получает один direct chat без дублей при конкурентных запросах.
- Деактивированный пользователь теряет доступ, но его actor остаётся доступен для будущей истории сообщений.

## Проверка качества

- Table-driven unit tests для матрицы ролей и действий.
- Интеграционные тесты auth, refresh reuse, приглашений и конкурентного создания direct chat.
- Тесты SQL constraints и rollback транзакций membership.
- Проверка IDOR: доступ к private chat по известному ID запрещён.
- Проверка CSRF-модели refresh/logout и cookie flags.
- Негативные тесты rate limits и истёкших/повторно использованных invitation tokens.

## Риски и открытые вопросы

- Использовать UUIDv7 и Postgres `uuid` согласно ADR-0003; порядок сообщений не связывать с ID.
- Уточнить, может ли group/channel иметь нескольких owner либо только одного.
- Решить, доступно ли самостоятельное вступление в public channel или требуется подтверждение.
- Определить политику смены email и полноценного password recovery для последующей фазы.

## Definition of Done

- Миграции применяются на чистой и существующей базе.
- Все endpoints внесены в OpenAPI, generated clients обновлены.
- Матрица authz покрыта тестами и используется всеми handlers.
- Сценарии bootstrap → invite → login → create chat/channel проходят end-to-end через API.
- В документации нет неразрешённых расхождений между `chat`, `group`, `channel` и `direct`.
