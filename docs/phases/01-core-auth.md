# Фаза 1. Ядро, пользователи и чаты

## Цель

Реализовать безопасную основу одного организационного пространства: первоначальную настройку, пользователей, сессии, приглашения, профили, чаты, каналы и централизованную авторизацию. Сообщения и realtime в этой фазе не реализуются.

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

- [ ] Создать миграции `organizations`, `actors`, `users`, `sessions`, `invitations`, `chats`, `chat_members`, `audit_log`.
- [ ] Добавить ограничения на уникальность email/handle внутри организации.
- [ ] Обеспечить единственность direct chat для пары пользователей через нормализованный pair key или отдельную таблицу участников direct chat.
- [ ] Запретить `visibility=public` для `kind=direct` на уровне БД и домена.
- [ ] Гарантировать хотя бы одного owner организации и owner для группового чата/канала.

### Bootstrap и auth

- [ ] Реализовать одноразовый bootstrap endpoint, доступный только до создания организации.
- [ ] Хэшировать пароль Argon2id с параметрами из конфигурации и безопасными лимитами входа.
- [ ] Выдавать короткоживущий access token и ротируемый refresh token.
- [ ] Для web хранить refresh token в `HttpOnly`, `Secure`, `SameSite` cookie; в БД хранить только hash.
- [ ] Обнаруживать повторное использование старого refresh token и отзывать цепочку сессии.
- [ ] Реализовать logout текущей сессии, logout всех сессий и список устройств.
- [ ] Добавить rate limiting на bootstrap, login, refresh и invitation acceptance.

### Приглашения и пользователи

- [ ] Создавать одноразовые invitation tokens с TTL, ролью и автором приглашения.
- [ ] Реализовать acceptance flow без раскрытия существования чужих email.
- [ ] Подготовить интерфейс email sender и dev-реализацию, выводящую ссылку в защищённый локальный sink.
- [ ] Реализовать чтение и изменение собственного профиля.
- [ ] Реализовать деактивацию пользователя с отзывом сессий без физического удаления истории.

### Чаты, каналы и права

- [ ] Реализовать CRUD для `group` и `channel`, создание/получение `direct`.
- [ ] Реализовать добавление, удаление и изменение роли участника.
- [ ] Для public group/channel разрешить обнаружение и самостоятельное вступление согласно настройкам.
- [ ] Для private group/channel требовать invitation/member action.
- [ ] Централизовать проверки в `authz.Can(actor, action, resource)`.
- [ ] Ввести отдельные действия `chat.read`, `chat.manage`, `member.manage`, `message.publish`, `thread.reply`.
- [ ] Для `kind=channel` разрешать `message.publish` и `thread.reply` только owner/admin.
- [ ] Записывать административные изменения в `audit_log`.

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
GET    /api/v1/chats/:id
PATCH  /api/v1/chats/:id
DELETE /api/v1/chats/:id
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
