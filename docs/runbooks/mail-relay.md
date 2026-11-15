# Почтовый сервис Coma (mail-relay)

Сервис отправляет письма установок Coma через HTTP API RuSender
([ADR-0013](../decisions/0013-mail-relay.md), [фаза 7.1](../phases/07.1-mail-relay.md)).
Его эксплуатирует проект Coma на `https://mail.coma-chat.com`. Обычная установка его
не запускает: она шлёт письма через него или через свой SMTP.

## Что сервис хранит и видит

- `mail_installations`: id установки, SHA-256 ключа, публичный адрес установки,
  состояние, лимит, IP регистрации.
- `mail_sends` (30 дней): тип письма, HMAC адреса получателя, id письма у RuSender,
  статус. Адреса открытым текстом и содержимое писем не хранятся.
- `mail_suppressions`: HMAC адресов после жалобы, жёсткого отказа или отписки.
- В журнал не попадают ключи, адреса, ссылки и тексты писем. В nginx журнал доступа
  выключен: в пути вебхука лежит секрет.

## Настройка

| Переменная                          | Назначение                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `MAIL_RELAY_DATABASE_URL`           | Своя база PostgreSQL сервиса; таблицы создаются при старте.                       |
| `MAIL_RELAY_LISTEN`                 | Адрес, по умолчанию `:8091`. TLS завершает nginx.                                 |
| `MAIL_RELAY_TRUSTED_PROXY_CIDRS`    | Прокси, чьему `X-Forwarded-For` верить для лимита регистраций по IP.              |
| `RUSENDER_API_KEY_FILE`             | Файл с токеном RuSender `rs_ck_v1_…`, право только `email.send`.                  |
| `RUSENDER_KEY_ID`                   | Необязательно: числовой id ключа отправки (бейдж «ID …» на карточке ключа).       |
| `RUSENDER_API_URL`                  | Необязательно, по умолчанию `https://api.rusender.ru`.                            |
| `MAIL_RELAY_HASH_SECRET_FILE`       | 32+ случайных символа: HMAC адресов. Смена обнуляет лимиты и список отписок.      |
| `MAIL_RELAY_WEBHOOK_SECRET_FILE`    | 24+ случайных символа: секрет в пути вебхука RuSender. Пусто — вебхуки выключены. |
| `MAIL_RELAY_FROM_ADDRESS`           | Отправитель, по умолчанию `no-reply@coma-chat.com`.                               |
| `MAIL_RELAY_ALLOW_INSECURE_ORIGINS` | Только для локальной проверки: принимает `http://` и внутренние адреса установок. |

Вместо `*_FILE` можно передать значение в переменной без суффикса (`RUSENDER_API_KEY`),
но в продакшене — только файлы вне git.

### С Compose-профилем

`deploy/compose.yaml` содержит профиль `mail-relay`: отдельная база
`coma_mail_relay` в общем PostgreSQL и сервис на `127.0.0.1:8091`.

1. Создать каталог секретов вне git, например `/opt/coma-secrets/mail-relay`, и
   положить три файла, читаемые uid `65532`:

   ```sh
   install -d -m 700 /opt/coma-secrets/mail-relay
   # токен RuSender копируется из кабинета, в терминал и журнал не выводится
   install -m 400 -o 65532 /path/to/token /opt/coma-secrets/mail-relay/rusender-api-key
   openssl rand -hex 32 | install -m 400 -o 65532 /dev/stdin /opt/coma-secrets/mail-relay/hash-secret
   openssl rand -hex 24 | install -m 400 -o 65532 /dev/stdin /opt/coma-secrets/mail-relay/webhook-secret
   ```

2. В `.env` сервера: `MAIL_RELAY_SECRETS_DIR=/opt/coma-secrets/mail-relay`,
   при необходимости `RUSENDER_KEY_ID` и `MAIL_RELAY_DATABASE_URL` с паролем базы.
3. DNS: A-запись `mail.coma-chat.com` на сервер, сертификат Let's Encrypt.
4. nginx: `deploy/nginx/mail-relay.conf.example`, заменить `__RELAY_DOMAIN__` и
   `__CERT_NAME__`. Он перезаписывает `X-Forwarded-For`, а
   `TRUSTED_PROXY_CIDRS` говорит сервису, какому прокси верить.
5. Запуск: `docker compose --env-file .env -f deploy/compose.yaml --profile mail-relay up -d --build mail-relay`.
   `deploy/deploy.sh` пересобирает сервис вместе с Core, если задан
   `MAIL_RELAY_SECRETS_DIR`.
6. Проверка: `curl -fsS https://mail.coma-chat.com/healthz` отвечает `204`.

### Кабинет RuSender

1. Домен `coma-chat.com` подтверждён (SPF `include:rsndr.ru`, DKIM
   `mdmdmail._domainkey`, DMARC). Статусы — «Отправители → Домены → Проверить».
2. API-ключ с правом только `email.send` («Интеграции → API»).
   Ключ отправки домена («Транзакционные отправки», карточка `coma-chat.com`) должен
   быть в статусе «Активен». Иначе RuSender отвечает `422 SENDING_KEY_NOT_ACTIVE`, а
   сервис — `502 provider_unavailable`. Так было при проверке 2026-11-16: и без
   `keyId`, и с `keyId` из файла владельца.
3. Вебхук: «Интеграции → Webhooks → Создать», адрес
   `https://mail.coma-chat.com/v1/webhooks/rusender/<содержимое webhook-secret>`, группа
   событий «Транзакционные письма — подробные». Без вебхука не работают отписки,
   учёт жалоб и автоматическая приостановка.
4. Тариф: бесплатно 100 писем в месяц на весь аккаунт. Когда квота кончается,
   RuSender отвечает `PAYMENT_REQUIRED`, сервис — `503 provider_quota`, установки
   повторяют позже.

## API

| Запрос                           | Результат                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/installations`         | `{app_url}` → `201 {installation_id, key, challenge, status}`; 5 в час на IP. |
| `POST /v1/installations/verify`  | Bearer → сервис читает `{app_url}/api/v1/mail-relay/challenge` → `200`.       |
| `GET /v1/quota`                  | Bearer → `{status, daily_limit, used, per_recipient_limit, window_hours}`.    |
| `POST /v1/messages`              | Bearer + `Idempotency-Key` → `202`; коды ошибок — в плане фазы 7.1.           |
| `POST /v1/webhooks/rusender/{s}` | События RuSender → `204`; неверный секрет — `404`.                            |
| `GET /healthz`                   | `204`.                                                                        |

## Лимиты

Окно — скользящие 24 часа. На получателя от одной установки — 6 писем (приглашений 2,
сбросов 3, подтверждений 3, дайджестов 2), на адрес от всех установок — 10. На
установку — 100 писем в первые 14 дней, затем 500; приглашений на новые адреса —
30, затем 150. Лимит установки считается по её хосту: перерегистрация его не
обнуляет.

## Операции

```sh
# в контейнере сервиса или с тем же MAIL_RELAY_DATABASE_URL
docker compose -f deploy/compose.yaml --profile mail-relay exec mail-relay /mail-relay installations
docker compose -f deploy/compose.yaml --profile mail-relay exec mail-relay /mail-relay revoke <id> "жалобы на спам"
docker compose -f deploy/compose.yaml --profile mail-relay exec mail-relay /mail-relay restore <id>
docker compose -f deploy/compose.yaml --profile mail-relay exec mail-relay /mail-relay set-limit <id> 2000
docker compose -f deploy/compose.yaml --profile mail-relay exec mail-relay /mail-relay set-limit <id> default
```

- `installations` показывает хост, состояние, причину, лимит, письма за сутки, отказы
  и жалобы за 7 дней.
- `revoke` останавливает установку и запрещает новые регистрации её хоста.
  Автоматически сервис приостанавливает хост при 3 жалобах за 7 дней или при доле
  жёстких отказов выше 10 % (от 30 писем). `restore` возвращает одну установку;
  если у хоста их несколько, восстановить нужную (обычно последнюю).
- Недоступность сервиса задерживает письма. Установки держат их в очереди (не
  дольше срока ссылки) и повторяют с тем же `Idempotency-Key`, поэтому дублей нет.
- Ротация токена RuSender: «Ротировать токен» в кабинете, заменить файл
  `rusender-api-key`, перезапустить сервис.
- Ротация секрета вебхука: новый файл `webhook-secret`, перезапуск, новый адрес в
  кабинете RuSender.

## Локальная проверка

```sh
docker run -d --name coma-mail-relay-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55492:5432 postgres:17-alpine
MAIL_RELAY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55492/postgres?sslmode=disable \
RUSENDER_API_KEY_FILE=/path/to/token MAIL_RELAY_HASH_SECRET=$(openssl rand -hex 32) \
MAIL_RELAY_ALLOW_INSECURE_ORIGINS=true go run ./core/cmd/mail-relay
```

Установке нужен адрес, по которому сервис прочитает challenge. Для живого письма
без установки достаточно зарегистрироваться, отдать challenge с любого локального
HTTP-сервера и отправить `POST /v1/messages`.
