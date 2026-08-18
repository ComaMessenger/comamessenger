# Диагностика realtime

## Быстрая последовательность

1. Проверить `/healthz`, `/readyz` и доступность PostgreSQL.
2. Посмотреть structured logs `websocket connected/disconnected`, `dispatch_trigger`, `event_lag`, `queued_events`, `queued_bytes`, `unacked_events`.
3. Сравнить `RedisWakeups`, `RedisThrottled`, `SignalPolls` и `FallbackPolls` в shutdown/metrics snapshot. Рост доли `polling_fallback` означает, что Redis недоступен или Pub/Sub reconnect нестабилен; durable delivery при этом должна продолжаться.
4. Проверить `LiveBatches`, `LiveEvents`, saturation DB pool и `pg_stat_activity`. Live path должен выполнять batch hydration, а per-session `Replay` — только backlog/reconnect. Возврат к повторной hydration является регрессией ADR-0008.
5. Разделить причины отключения: `4001` — auth expired/revoked, `4008` — slow consumer/ACK timeout, `4009` — checkpoint старше retention, `1012` — restart.
6. При `no buffer space available`/`ENOBUFS` проверить, что `WS_MAX_CONCURRENT_WRITES` не завышен относительно default 8; изменение требует повторного benchmark.

## Redis outage

Redis хранит только wake-up hints и TTL-state typing/presence. При outage:

- REST durable commands продолжают коммититься в PostgreSQL;
- WebSocket durable events сходятся через `EVENT_POLL_INTERVAL`;
- typing/presence fail closed с non-fatal `service_unavailable`;
- после reconnect подписчик снова принимает hints, дубли безопасны;
- message body, access/refresh tokens и invitation tokens в Redis отсутствуют.

Если Redis publisher создаёт burst, Core принимает Redis wake не чаще одного раза за 50 ms и увеличивает `RedisThrottled`; local commit wake не throttled.

## Retention и resume

Worker запускает sweep сразу после старта и затем каждые `EVENT_RETENTION_INTERVAL`. Он удаляет батчами `EVENT_RETENTION_BATCH_SIZE` только события, которые одновременно старше `EVENT_RETENTION` и находятся ниже floor `EVENT_RETENTION_MIN_COUNT`. Доменные `messages` не удаляются. Клиент с более старым checkpoint получает `4009/resync_required` и должен загрузить snapshot через REST.

## Безопасные настройки

- публиковать Core, Web и MinIO только на loopback; наружу выставлять Nginx;
- задать `TRUSTED_PROXY_CIDRS` только адресами реально используемых reverse proxy;
- не увеличивать `WS_MAX_PENDING_CONNECTIONS`, queue и frame limits без повторного load test;
- генерировать отдельный случайный `REDIS_EPHEMERAL_SIGNING_KEY` длиной не менее 32 bytes и одинаково задавать его всем Core;
- не логировать raw invitation URL; checked-in Nginx template отключает access log для accept route;
- после logout/revoke убедиться, что связанные WebSocket закрыты с `4001`.
