# Опенсорсный лёгкий корпоративный мессенджер с agent-first архитектурой

> Статус: исходное продуктовое и архитектурное ТЗ. Детализация работ ведётся отдельными документами в [`phases/`](phases/), а принятые сквозные решения — в [`decisions/`](decisions/).

Рабочее позиционирование: "Mattermost, который весит как один бинарник, ощущается как Telegram и в который агенты встроены на уровне протокола, а не как боты сбоку".

---

## 0. Принципы и границы

### Принципы

1. **Agent-first.** Агент и человек - один и тот же тип сущности `actor`. Всё, что может человек в чате (писать, читать, реагировать, открывать треды, грузить файлы), может агент с теми же правами и ограничениями.
2. **Event-sourced ядро.** Каждое действие = событие. UI, агенты, поиск, аудит, пуши - все потребители одного потока событий.
3. **Один бинарник + Postgres как источник истины.** Никаких Elasticsearch, Kafka или RabbitMQ в базовой поставке. Redis входит в стандартную topology только как disposable coordination/ephemeral слой (см. ADR-0007).
4. **Telegram UX, Slack модель.** Реплаи и треды - разные вещи и живут одновременно.
5. **Опенсорс по-настоящему.** Собственные агенты и клиенты используют только публичный API. Ничего привилегированного.

### Не делаем в v1

- Звонки, видео, screen share
- E2E-шифрование (убивает агентов и поиск; делаем TLS + at-rest)
- Федерацию между инстансами
- Мультитенант (один инстанс = одна организация)
- Плагины в UI, кастомные темы
- Гостевые аккаунты, общие чаты и каналы с другими компаниями

---

## 1. Продуктовый скоуп MVP

### Must have

- Организация, пользователи, приглашения по ссылке/почте
- Пространства общения: личные чаты (DM), групповые чаты и каналы
- Чат: все участники могут писать; канал: писать могут владелец и администраторы, остальные читают и реагируют
- Сообщения: текст (markdown-подмножество), вложения, ссылки с превью
- **Reply** (Telegram-style): цитата в основной ленте, свайп на мобилке, клик на цитату скроллит к оригиналу
- **Thread** (Slack/Pachca-style): отдельная ветка с собственным unread, списком участников, follow/unfollow, отдельная вкладка "Треды"
- Реакции emoji с группировкой и списком кто поставил
- Редактирование, удаление, закрепление, пересылка
- Упоминания @user, @all, @here, @agent
- Непрочитанные: счётчики по чатам, каналам и тредам, "прочитано до" на уровне сообщения
- Поиск по сообщениям и файлам
- Пуши (web push, APNs, FCM)
- Черновики, синхронизация между устройствами
- Статус присутствия (online/away/offline), typing
- Профиль, аватар, тайм-зона
- Роли: owner, admin, member; в чате или канале — owner/admin/member
- Агенты: регистрация, подписки на события, инструменты, права, вызов из UI

### Should have (v1.1)

- Кастомные эмодзи
- Голосовые сообщения (запись + транскрипт агентом)
- Задачи из сообщения (как в Pachca)
- Опросы
- SSO через OIDC (Keycloak, Google, Azure AD)
- Экспорт данных, retention policy

### Could have (позже)

- Кружки (видео-сообщения)
- Папки чатов
- Гости и внешние чаты/каналы

---

## 2. Архитектурные решения

Формат: вопрос, варианты, решение, почему.

### 2.1 Монолит или сервисы

Решение: **модульный монолит на Go** плюс **отдельный agent runtime на TypeScript**.

- Ядро (auth, чаты и каналы, сообщения, WS, события, файлы, поиск, права) - один Go-бинарник с внутренними модулями и чёткими интерфейсами.
- Agent runtime - отдельный процесс/контейнер, общается с ядром только через публичный API + event stream. Это и доказательство честности архитектуры, и возможность писать AI-часть в экосистеме, где она богаче.
- Никаких gRPC между "микросервисами" в v1.

### 2.2 Стек ядра

- Go 1.26.5+, стандартный `net/http` + `chi` для роутинга
- Postgres 16 через `pgx` (без ORM; `sqlc` для типобезопасных запросов, `goose` или `atlas` для миграций)
- WebSocket: `github.com/coder/websocket`
- Очереди/фон: `river` (Postgres-backed); появление отдельного broker должно быть доказано benchmark
- Redis 8: Pub/Sub wake-up после commit, presence/typing TTL и распределённые rate limits; не источник истины и не durable event log
- Логи `slog`, метрики Prometheus, трейсы OpenTelemetry
- Конфиг: env + один `config.yaml`

### 2.3 Стек agent runtime

- Node.js 22 + TypeScript
- Vercel AI SDK или прямые SDK провайдеров (Anthropic, OpenAI, локальные через OpenAI-совместимый API)
- MCP SDK для инструментов
- Общается с ядром: REST для действий, WS/SSE для потока событий
- Хранит собственную память агентов в том же Postgres (отдельная схема `agents`) или в SQLite при standalone-запуске

### 2.4 Стек клиентов

- Web: React 19 + TypeScript + Vite, TanStack Query/Router, Zustand или Jotai для локального состояния, виртуализация списка сообщений (TanStack Virtual)
- Desktop: Tauri 2 поверх web-клиента (лёгкий, нативные пуши, трей)
- Mobile: React Native (Expo) с Reanimated + Gesture Handler для свайп-реплая; общий core (API-клиент, стор, парсинг markdown) в отдельном пакете монорепы
- Монорепа: pnpm workspaces + Turborepo: `packages/protocol`, `packages/core`, `apps/web`, `apps/mobile`, `apps/desktop`, `apps/agent-runtime`

### 2.5 Идентификаторы

- Все primary/foreign keys доменных сущностей — **UUIDv7** в нативном типе Postgres `uuid`; UUID генерирует Go-сервер.
- Клиент генерирует отдельный UUID `client_msg_id` для идемпотентности отправки и optimistic UI.
- Порядок сообщений, unread и resume определяется серверными sequence numbers, а не UUID.

### 2.6 Реалтайм и доставка

Вопрос: как доставлять события клиентам и агентам надёжно, с переподключениями и мультиустройствами.

Решение:

- Один WS на клиент. Подписки на чаты управляются сервером (клиент получает всё, к чему у него есть доступ, плюс отдельно "активный чат" для typing/presence).
- Каждое событие имеет монотонный `seq` в рамках организации. Он выделяется увеличением `organizations.event_seq` внутри той же транзакции, а не PostgreSQL sequence. Клиент хранит применённый `last_seq`; при реконнекте сервер отдаёт доступную дельту либо требует full resync.
- Fan-out фазы 2: in-process hub, Redis Pub/Sub wake-up и polling committed events из Postgres как fallback. Wake-up коалесцируются, а WebSocket-сессии читают backlog ограниченными батчами.
- Пуши через `river` job при отсутствии активной сессии у пользователя.
- Backpressure: если клиент не читает, буфер ограничен, при переполнении - разрыв и resume.

### 2.7 Транзакционный журнал событий

- Таблица `events(org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data, occurred_at)` с routing metadata и минимальной immutable дельтой для удаляемых actions. Это не источник истины (истина в нормализованных таблицах), а лог для доставки, resume, агентов и вебхуков.
- Транзакция: пишем в нормализованную таблицу и в `events` одной транзакцией, потом публикуем в память.
- Типы долговечных событий: `message.created/updated/deleted/pinned/unpinned`, `reaction.added/removed`, `thread.followed/unfollowed`, `chat.*`, `member.*`, `read.marked`, `agent.invoked`, `agent.replied`, `file.uploaded`.
- `typing`, `presence`, streaming-дельты и другие краткоживущие сигналы передаются отдельно и не попадают в durable event log.
- Retention `events` по умолчанию: 72 часа и минимум последние 100 000 событий организации. Долговечный аудит хранится отдельно от delivery log.

### 2.8 Чаты, каналы, сообщения, реплаи и треды

Вопрос: как совместить Telegram-реплай и Slack-тред в одной модели.

Решение:

- Общая сущность `chats` имеет `kind`: `direct`, `group` или `channel`. Для `group` пишут все участники; для `channel` — только owner/admin. Видимость (`public`/`private`) задаётся независимо от типа.
- В канале обычные участники могут читать и реагировать, но не могут отправлять сообщения ни в основную ленту, ни в треды. Если позже понадобятся комментарии к публикациям, они будут добавлены как отдельный режим.
- `messages.reply_to_id` - реплай. Сообщение остаётся в основной ленте чата или канала, отображается с цитатой.
- `messages.thread_root_id` указывает на root message; отдельная сущность `threads` не создаётся. Ответы в треде не показываются в основной ленте. В канале создавать сообщения в тредах могут только owner/admin.
- Внутри треда тоже можно делать реплай (`reply_to_id` + `thread_root_id` одновременно).
- ID корневого сообщения является стабильным ID треда с первого ответа.
- Отдельный экран "Треды": все треды, на которые подписан пользователь, с непрочитанными.
- Подписка на тред: автор рута, все ответившие, упомянутые; unfollow вручную.

### 2.9 Непрочитанные

- `chat_reads(user_id, chat_id, last_read_seq, last_read_at)` и `thread_reads(user_id, thread_root_id, ...)`.
- Сообщение получает серверный `created_seq`, совпадающий с последовательностью события создания. Счётчик = число доступных сообщений после `last_read_seq`; клиентский ID и часы устройства не участвуют в порядке.
- Счётчики можно кэшировать в памяти/Redis и инвалидировать событиями. Отдельно хранится/вычисляется флаг "есть упоминание".
- Пометка прочитанным - явное событие с клиента (видимость последнего сообщения на экране), не по факту открытия.
- Read marker монотонный: запоздавшее устройство не может сдвинуть его назад.

### 2.10 Редактирование и удаление

- Мягкое удаление (`deleted_at`), контент затирается, метаданные остаются для целостности тредов и реплаев.
- История правок в `message_revisions` доступна аудиту. Автор редактирует и удаляет свои сообщения без временного окна; owner/admin может удалить любое сообщение.

### 2.11 Реакции

- `reactions(message_id, actor_id, emoji, created_at)` с уникальным индексом по тройке. Агрегат считаем в запросе или денормализуем в `messages.reactions_summary jsonb` при высокой нагрузке.
- Emoji хранится как shortcode; кастомные - `:custom:name:` со ссылкой на файл организации.

### 2.12 Файлы

- Хранилище: любое S3-совместимое object storage (AWS S3, Yandex Object Storage, Selectel, MinIO и другие) или локальный диск для маленьких инсталляций.
- S3-провайдер задаётся конфигурацией: `endpoint`, `region`, `bucket`, `access_key`, `secret_key`, `prefix`, TLS и `force_path_style`. MinIO используется только как локальный провайдер по умолчанию в docker-compose.
- В БД хранится стабильный `storage_key`, а не URL провайдера. Это позволяет менять endpoint и выдавать временные ссылки без миграции записей.
- Загрузка: клиент запрашивает presigned URL, грузит напрямую, потом создаёт сообщение с `file_ids`. Для локального режима - upload через ядро. CORS, multipart upload и presigned download проверяются контрактными тестами минимум на MinIO и одном внешнем S3-провайдере.
- Превью картинок/видео и извлечение текста из PDF/docx - фоновые job'ы. Извлечённый текст индексируется в поиск и доступен агентам.
- Лимиты размеров и типов - в конфиге организации.

### 2.13 Поиск

- Postgres FTS (`tsvector` с конфигурацией под русский + английский) для сообщений и извлечённого текста файлов.
- `pgvector` для семантического поиска и RAG агентов. Эмбеддинги считаются агентским рантаймом (провайдер настраиваемый), пишутся в `message_embeddings`.
- Фильтры: чат/канал, автор, дата, тип (файл/ссылка), в тредах/без.
- Соблюдение прав: поиск всегда через join с membership.

### 2.14 Аутентификация

- Email + пароль (argon2id), magic link, позже OIDC.
- Сессии: refresh-токен в httpOnly cookie (web) / secure storage (mobile), короткоживущий access JWT для WS и API. Ротация refresh, список активных сессий, отзыв.
- Для агентов: API-ключи с scopes, привязанные к actor'у типа agent, отзыв, ротация.
- 2FA (TOTP) в v1.1.

### 2.15 Авторизация и права

- Роли организации: owner, admin, member. Роли в чате или канале: owner, admin, member.
- Проверка прав в одном месте (пакет `authz`), все хендлеры вызывают `authz.Can(actor, action, resource)`.
- Агенты: те же роли + **scopes на уровне API-ключа** (`messages:read`, `messages:write`, `files:read`, `chats:join`, ...) + список чатов и каналов, куда агент добавлен. Агент не видит ничего за пределами своего membership.
- Право писать в основную ленту канала проверяется серверным `authz`: API-ключ или прямой HTTP-запрос не могут обойти режим read-only для участников.
- Аудит-лог действий админов и агентов.

### 2.16 Агентская платформа (ключевой раздел, подробно в п. 5)

- Актор типа `agent` с профилем, аватаром, описанием, владельцем.
- Регистрация через админку или API: имя, endpoint (для внешних) или конфиг (для встроенного рантайма), scopes, триггеры.
- Триггеры: упоминание, ключевые слова/regex, любое сообщение в чате, расписание (cron), системные события, ручной вызов из UI (кнопка/slash-команда).
- Инструменты агента = публичный API, обёрнутый в MCP-совместимый tool set.
- Отображение в UI: "агент печатает", стриминг ответа, отметка "ответ агента", кнопки-действия под сообщением, возможность попросить агента в треде.

### 2.17 Провайдеры LLM

- Абстракция провайдера в agent runtime; поддержка Anthropic, OpenAI, OpenAI-совместимых (Ollama, vLLM, локальные), Yandex/Sber при желании.
- Ключи провайдеров хранятся в ядре зашифрованно (AES-GCM, ключ из env), выдаются рантайму по запросу.
- Лимиты расходов на организацию и на агента, учёт токенов в таблице `agent_usage`.

### 2.18 Мультитенант

- v1: один инстанс = одна организация, но `org_id` есть во всех таблицах с первого дня, чтобы не переписывать схему.

### 2.19 Масштабирование

- Целевая планка v1: 500 пользователей и 2000 WS на одном инстансе с 1 vCPU/1 GB.
- Путь роста: несколько реплик ядра за балансировщиком; sticky WS не нужен благодаря resume по seq. Redis Pub/Sub будит все реплики, а каждая сверяет свой watermark с Postgres. Multi-core становится поддерживаемым только после измерений phase 7. Postgres масштабируется вертикально, затем read replicas используются для поиска/истории.

### 2.20 Деплой

- `docker compose up`: ядро, Postgres, Redis, MinIO; agent-runtime включается profile. Redis disposable и не входит в backup contract.
- Одиночный бинарник с флагом `--sqlite` для демо/личного использования (позже; сначала только Postgres).
- Helm-чарт после стабилизации.
- Автомиграции при старте (с флагом отключения).

### 2.21 Наблюдаемость

- Prometheus-метрики: WS-соединения, событий/сек, latency отправки, размер очередей, ошибки провайдеров LLM.
- Структурные логи, request-id, actor-id.
- OpenTelemetry-трейсы опционально.
- Health/ready эндпоинты.

### 2.22 Безопасность

- TLS-терминация снаружи (Caddy в compose даёт авто-HTTPS).
- Rate limiting по IP и по actor'у.
- CSP, санитизация markdown на сервере и клиенте.
- Антивирус для файлов опционально (ClamAV).
- Секреты только через env/секрет-менеджер, никогда в БД открытым текстом.
- Регулярный `govulncheck`, `npm audit` в CI.

### 2.23 Протокол и версионирование

- REST `/api/v1/...` + WS `/ws`. Одна OpenAPI-спека, из неё генерятся TS-клиент и Go-серверные типы (`oapi-codegen`).
- WS-сообщения: JSON-конверты `{type, seq?, data}`. Позже можно MessagePack.
- Семвер API, breaking changes только в v2.

### 2.24 Локализация

- UI: i18n с русским и английским с первого дня.
- Сервер: сообщения об ошибках кодами, а не текстом.

---

## 3. Схема данных (ядро)

```
organizations(id, name, slug, event_seq bigint, settings jsonb, created_at)

actors(id, org_id, type enum(user|agent), display_name, handle, avatar_file_id,
       status, tz, created_at, deleted_at)

users(actor_id pk, email, password_hash, email_verified_at, last_seen_at, prefs jsonb)

agents(actor_id pk, owner_actor_id, kind enum(builtin|external), endpoint_url,
       config jsonb, scopes text[], triggers jsonb, enabled bool)

api_keys(id, actor_id, key_hash, scopes text[], last_used_at, expires_at, revoked_at)

sessions(id, user_id, refresh_hash, device jsonb, created_at, expires_at, revoked_at)

chats(id, org_id, kind enum(direct|group|channel), visibility enum(private|public),
      name, topic, created_by, archived_at, last_message_at, settings jsonb)

chat_members(chat_id, actor_id, role enum(owner|admin|member), joined_at,
             notify_level, muted_until)

messages(id, org_id, chat_id, thread_root_id null, reply_to_id null, actor_id,
         client_msg_id, type enum(text|system|file|agent), body text, body_format,
         attachments jsonb, mentions actor_id[], edited_at, deleted_at,
         version int, pinned_at, created_seq bigint, created_at)
  unique (actor_id, client_msg_id)
  index (chat_id, created_seq) where thread_root_id is null
  index (thread_root_id, created_seq)

message_revisions(id, message_id, body, edited_at, edited_by)

thread_followers(thread_root_id, actor_id, followed_at)

reactions(message_id, actor_id, emoji, created_at) unique

chat_reads(actor_id, chat_id, last_read_seq, last_read_at)
thread_reads(actor_id, thread_root_id, last_read_seq, last_read_at)

files(id, org_id, uploader_id, storage_key, name, mime, size, sha256,
      preview_key, extracted_text, created_at)

drafts(actor_id, chat_id, thread_root_id null, body, version, updated_at)

events(org_id, seq, type, actor_id, chat_id null, subject_id,
       audience_actor_id null, exclude_session_id null, data jsonb, occurred_at)
       primary key (org_id, seq)

push_subscriptions(id, user_id, platform, token, created_at)

audit_log(id, org_id, actor_id, action, target, meta jsonb, created_at)

message_embeddings(message_id, model, embedding vector)
agent_usage(id, agent_id, provider, model, input_tokens, output_tokens, cost, created_at)
agent_memory(agent_id, key, value jsonb, updated_at)   -- в схеме agents
```

---

## 4. API

### REST (основное)

```
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
GET    /me
GET    /chats                          список чатов и каналов с unread
POST   /chats                          {kind: direct|group|channel, visibility, name, member_ids}
GET    /chats/:id/messages?before=&after=&limit=
POST   /chats/:id/messages             {client_msg_id, body, reply_to_id?, thread_root_id?, file_ids?}
PATCH  /messages/:id
DELETE /messages/:id
POST   /messages/:id/reactions         {emoji}
DELETE /messages/:id/reactions/:emoji
GET    /messages/:root_id/thread       получить тред
GET    /threads?followed=1&unread=1
POST   /chats/:id/read                 {last_read_seq}
POST   /files/presign | POST /files
GET    /search?q=&chat=&from=&type=
GET    /agents | POST /agents | PATCH /agents/:id
POST   /agents/:id/invoke              ручной вызов с контекстом
GET    /events?since=seq               резервный long-poll
```

### WebSocket

Клиент -> сервер: `auth{access_token,last_seq}`, `ack{seq}`, `subscribe_active{chat_id}`, `typing`, `presence`.
Сервер -> клиент: `hello{current_seq,min_retained_seq,...}`, durable events, `resync_required`.

Полный контракт, backpressure и close codes: [`protocols/realtime-v1.md`](protocols/realtime-v1.md). Архитектурные гарантии: [ADR-0006](decisions/0006-messaging-delivery-and-realtime.md).

### Оптимистичный UI

Клиент генерирует `client_msg_id`, сразу рисует временное сообщение, а после ответа связывает его с серверным UUIDv7. При ошибке сообщение помечается как неотправленное с безопасным повтором того же `client_msg_id`.

---

## 5. Агентская платформа

### 5.1 Жизненный цикл

1. Админ создаёт агента: имя, аватар, описание, тип (встроенный/внешний), scopes, триггеры, чаты и каналы.
2. Ядро выдаёт API-ключ (для внешнего) или конфиг встроенному рантайму.
3. Рантайм подключается к WS ядра как actor-агент, получает поток событий по своим чатам и каналам.
4. Триггер срабатывает -> рантайм собирает контекст -> вызывает LLM с инструментами -> действия идут через публичный API -> ответ стримится в чат.

### 5.2 Триггеры (в `agents.triggers`)

```json
[
  { "type": "mention" },
  { "type": "keyword", "pattern": "релиз|деплой", "chats": ["..."] },
  { "type": "every_message", "chats": ["..."] },
  { "type": "schedule", "cron": "0 9 * * 1-5", "chat": "..." },
  { "type": "event", "event": "member.joined" },
  { "type": "command", "name": "/summary" }
]
```

### 5.3 Инструменты (MCP tools над публичным API)

`get_chat_messages`, `get_thread`, `search_messages`, `post_message`, `reply_in_thread`, `add_reaction`, `get_file_text`, `list_members`, `create_chat`, `remember`/`recall` (память агента), `ask_user` (кнопки под сообщением), плюс возможность подключать внешние MCP-серверы (календарь, таск-трекер, git) в конфиг агента.

### 5.4 Контекст и память

- Контекстное окно: последние N сообщений чата/канала/треда + результаты поиска по запросу + записи из `agent_memory`.
- Долгая память: key-value + семантическая через pgvector.
- Политика приватности: агент видит только чаты и каналы, где он member; для DM с агентом - только этот DM.

### 5.5 UX агентов

- @упоминание с автодополнением, иконка агента.
- Индикатор "агент думает/печатает", стриминг токенами через WS (`message.streaming` события с дельтами, финальный `message.created`).
- Кнопки под сообщением агента (`actions`), нажатие = событие `agent.action` обратно рантайму.
- Кнопка "Спросить агента" в контексте треда: краткое содержание, ответ по треду.
- Страница агента: описание, что умеет, статистика, расход токенов.

### 5.6 Встроенные агенты в v1 (демонстрация)

- **Summarizer**: /summary в чате, канале или треде, ежедневный дайджест по расписанию.
- **Q&A по истории**: отвечает на вопросы по сообщениям и файлам организации через RAG.
- **Onboarding**: приветствует новых, отвечает на вопросы по базе знаний (файлы канала #handbook).

### 5.7 Внешние агенты и SDK

- Документированный HTTP+WS протокол, OpenAPI.
- SDK на TS и Python (тонкие обёртки), пример на 50 строк "агент, который отвечает на упоминания".
- Реестр примеров агентов в отдельном репозитории.

---

## 6. Клиенты

### 6.1 Web

- Лейаут: сайдбар (чаты, каналы, личные, треды, агенты), центр (лента), правая панель (тред/профиль/поиск).
- Виртуализированная лента с бесконечной прокруткой в обе стороны, якорь на последнем прочитанном.
- Реплай: hover-кнопка и Ctrl+R; тред: hover-кнопка "Открыть тред".
- Composer: markdown-подмножество, упоминания, вложения drag-and-drop, черновики.
- Клавиатурная навигация как в Telegram Desktop.

### 6.2 Mobile

- Свайп вправо на сообщении = реплай (Reanimated + Gesture Handler), с хаптиком.
- Long-press = меню (реакция, тред, копировать, переслать, закрепить).
- Треды: отдельная вкладка внизу.
- Пуши: FCM/APNs через Expo или нативно.
- Офлайн: кэш последних сообщений по чатам и каналам, очередь отправки.

### 6.3 Desktop

- Tauri оборачивает web, добавляет трей, бейдж, нативные уведомления, автообновление.

---

## 7. Пошаговый план

### [Фаза 0. Подготовка (неделя 1)](phases/00-preparation.md)

- [x] Название, лицензия и публичный репозиторий
- [x] Монорепа: `core/` (Go), `packages/protocol`, `apps/web`, `apps/agent-runtime`; mobile позже
- [x] CI: lint, test, build, кодоген, Compose smoke и docker-образы
- [x] ADR-папка с решениями из раздела 2
- [x] Docker Compose для разработки: Postgres 16 + pgvector и MinIO; reverse proxy перенесён в production-фазу
- [x] OpenAPI-скелет и кодоген Go/TypeScript

### [Фаза 1. Ядро: данные и auth (недели 2-3)](phases/01-core-auth.md)

- [x] Миграции по схеме п. 3
- [x] Модуль `authz`
- [x] Bootstrap, логин, refresh, сессии, приглашения
- [x] Организация, актор, профиль
- [x] Чаты и каналы: CRUD, membership, видимость и серверная проверка права публикации
- [ ] Тесты интеграционные на реальном Postgres (testcontainers)

### [Фаза 2. Сообщения и реалтайм (недели 4-6)](phases/02-messaging-realtime.md)

- [ ] Отправка/редактирование/удаление сообщений, идемпотентность по `client_msg_id`
- [ ] Таблица `events`, транзакционная запись, in-process pub/sub
- [ ] WS-сервер: auth, resume по seq, backpressure, heartbeat
- [ ] Реплаи, треды, подписки на треды
- [ ] Реакции
- [ ] Прочитанное и счётчики
- [ ] Typing, presence
- [ ] Черновики
- [ ] Нагрузочный тест: 2000 WS, 200 msg/s на одном инстансе

### [Фаза 3. Web-клиент MVP (недели 5-8, параллельно)](phases/03-web-client.md)

- [x] Auth-экраны, онбординг организации
- [ ] Contract gate: chat summaries, actors directory, message jump, chat/member events и push API
- [ ] Общие `packages/tokens` и platform-neutral client engine без React imports
- [ ] Сайдбар, лента с виртуализацией, composer
- [ ] Responsive phone flow: крупные chat cards, avatars, chips «Все / Личные / Групповые», chat и thread screens
- [ ] Реплаи, треды (правая панель + вкладка "Треды"), реакции
- [ ] Unread, упоминания, пуш через web push
- [ ] Поиск (после Фазы 4)
- [ ] i18n RU/EN

### [Фаза 3.1. Навигация и настройки](phases/03.1-navigation-settings.md)

- [x] Нижний Web tabbar на phone: чаты, треды, важные, участники и `Ещё`
- [x] Route-based базовые страницы профиля и пространства вместо dialogs
- [x] Сессии и безопасность аккаунта
- [x] Участники, приглашения и organization policies
- [x] Кастомизация логотипа, favicon и accent color
- [x] Настройка bundled/external S3 и SMTP без раскрытия secrets клиенту
- [x] Серверные connection tests и журнал административного аудита

### [Фаза 4. Файлы и поиск (недели 8-9)](phases/04-files-search.md)

- [ ] Presigned upload в MinIO/S3, локальный режим
- [ ] Превью, извлечение текста в фоне (`river`)
- [ ] FTS, фильтры, права в поиске
- [ ] pgvector + таблица эмбеддингов (заполняет рантайм)

### [Фаза 5. Агентская платформа (недели 9-12)](phases/05-agent-platform.md)

- [ ] Актор-агент, API-ключи, scopes, аудит
- [ ] Триггеры, событие `agent.invoked`, стриминг `message.streaming`
- [ ] Agent runtime на TS: подключение к WS, диспетчер триггеров, MCP-инструменты над API, абстракция провайдеров, лимиты, учёт токенов
- [ ] Три встроенных агента из п. 5.6
- [ ] UI: страница агентов, создание, настройка триггеров, кнопки-действия, индикаторы
- [ ] Пример внешнего агента на TS и Python + документация протокола

### [Фаза 6. Мобильный клиент (недели 12-16)](phases/06-mobile.md)

- [ ] Expo-проект, общий core-пакет
- [ ] Лента, свайп-реплай, long-press меню, треды-вкладка
- [ ] Пуши, офлайн-кэш
- [ ] TestFlight / internal testing

### [Фаза 7. Продакшен-готовность (недели 16-18)](phases/07-production-readiness.md)

- [ ] Docker-compose "одной командой", документация установки
- [ ] Метрики, health, бэкапы, retention
- [ ] Rate limiting, CSP, security-ревью
- [ ] Desktop через Tauri
- [ ] Первые пилоты у 2-3 команд, сбор обратной связи

### [Фаза 8. Публичный релиз v1.0](phases/08-public-release.md)

- [ ] Лендинг, демо-инстанс, видео с агентами в действии
- [ ] Публикация на GitHub, Product Hunt, Habr, HN
- [ ] Roadmap публично, шаблоны issue, CONTRIBUTING

---

## 8. Опенсорс и продукт

- **Лицензии:** `AGPL-3.0-only` для `core/` и `apps/agent-runtime/`; `Apache-2.0` для клиентов, протокола, SDK, примеров, deployment assets и документации. Карта лицензий закреплена в ADR-0002 и корневом `LICENSE`.
- **Монетизация (потом):** managed-хостинг, enterprise-фичи (SSO/SCIM, аудит-экспорт, SLA), маркетплейс агентов.
- **Сообщество:** публичный roadmap, Discussions, канал для объявлений и чат сообщества в самом мессенджере (dogfooding), еженедельные релизы на старте.
- **Документация:** Docusaurus/Starlight; разделы: установка, концепции (реплай vs тред, агенты), API, гайд по агентам, ADR.

---

## 9. Риски и как их гасить

| Риск                                                  | Митигация                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Скорость разработки на Go ниже, чем в привычном стеке | Ядро минимально, вся "умная" часть в TS-рантайме; кодоген из OpenAPI                                 |
| Клиенты съедают больше времени, чем бэк               | Сначала только web; mobile после стабилизации протокола; общий core-пакет                            |
| Агенты дороги и непредсказуемы                        | Лимиты токенов, дефолт на дешёвые модели, явный вызов по умолчанию, "every_message" только осознанно |
| Корп не доверяет незнакомому продукту                 | Self-hosted, аудит-лог, права агентов, честная документация безопасности                             |
| Расползание скоупа                                    | Список "не делаем в v1" в README, любая фича проходит через issue с обоснованием                     |
| Реалтайм ломается на реконнектах                      | seq + resume с первого дня, интеграционные тесты на обрывы                                           |

---

## 10. Открытые продуктовые вопросы

1. Markdown-подмножество: какое именно (CommonMark без таблиц? mentions-синтаксис?).
2. Expo или bare React Native.
3. Какие три встроенных агента реально показывают ценность именно твоей целевой аудитории.
4. Первые пилотные команды: кто и когда.
