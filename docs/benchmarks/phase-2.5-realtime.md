# Phase 2.5 realtime benchmark

Дата: 2026-08-19. Результат: 2 000 WebSocket и 200 сообщений/с прошли с полной доставкой после batch live fan-out, принятого в [ADR-0008](../decisions/0008-live-fanout-capacity.md).

## Окружение

- MacBook Pro 2021, Apple M1 Pro, 10 CPU cores, 16 GB RAM;
- macOS 26.4.1, Docker Engine 29.1.2;
- PostgreSQL 16 (`pgvector/pgvector:pg16`), `max_connections=100`, `shared_buffers=128MB`;
- Core DB pool: 10 соединений;
- один процесс Core/test harness, одна организация, один chat;
- 2 000 настоящих loopback WebSocket; один actor/session специально изолирует стоимость широкого fan-out от auth/bootstrap;
- 200 конкурентных durable message commands, запланированных с интервалом 5 ms за одну секунду;
- `WS_MAX_CONCURRENT_WRITES=8`, live batch 256, queue 256 events / 1 MiB;
- Redis не участвует в data path этого прогона: local wake и Redis hint приводят к одинаковой PostgreSQL batch hydration.

Воспроизведение:

```bash
cd core
COMA_RUN_LOAD_TEST=1 \
TEST_DATABASE_URL='postgres://comamessenger:comamessenger@127.0.0.1:55433/postgres?sslmode=disable' \
/usr/bin/time -l go test ./internal/realtime -run '^TestRealtimeLoadProfile$' -count=1 -v -timeout=90s
```

## Сравнение

| Метрика                          |    До: per-session Replay | После: batch live fan-out |
| -------------------------------- | ------------------------: | ------------------------: |
| WebSocket connected              |             2 000 / 2 000 |             2 000 / 2 000 |
| Время установления соединений    |                   3,766 s |                   3,355 s |
| Message commands                 |   200 committed, 0 failed |   200 committed, 0 failed |
| Command latency p50 / p95 / p99  |        761 / 912 / 990 ms |      367 / 718 / 2 018 ms |
| Ожидаемые deliveries             |                   400 000 |                   400 000 |
| Deliveries                       |  335 316 за 20 s (83,83%) |            400 000 (100%) |
| Delivery latency p50 / p95 / p99 | 7,376 / 18,369 / 19,985 s |   1,211 / 1,532 / 1,607 s |
| Disconnects под нагрузкой        |                         0 |                         0 |
| Queue remaining                  |             64 684 frames |                         0 |
| DB pool peak                     |                   10 / 10 |                   10 / 10 |
| PostgreSQL lock waiters peak     |                         0 |                         1 |
| Core heap peak                   |                  162,8 MB |                  180,3 MB |
| Core process max RSS             |                  292,3 MB |                  314,8 MB |
| PostgreSQL snapshot              |      151,9% CPU, 92,8 MiB |       34,2% CPU, 88,2 MiB |
| Redis snapshot                   |         0,2% CPU, 8,2 MiB |         3,7% CPU, 8,5 MiB |
| Dispatcher live hydration        |        per-session Replay |   13 batches / 200 events |
| Wall / user / system CPU         |   29,29 / 19,43 / 20,01 s |     10,66 / 8,37 / 6,73 s |

CPU/RAM контейнеров — моментальный snapshot во время активного прогона, не интеграл. Command p99 имеет ожидаемую вариативность из-за 200 конкурентных транзакций, которые сериализуют sequence организации; все команды уложились в timeout и не задержали полную доставку.

## Вывод

Множитель «число WebSocket × PostgreSQL Replay» устранён: 200 событий гидратированы в 13 запросах, сериализованы один раз и доставлены 400 000 раз как готовые bytes. PostgreSQL перестал быть bottleneck live fan-out, memory осталась bounded, disconnect causes пусты, ACK/resume и актуальная membership-проверка сохранены.

Следующим ограничением стал сетевой write scheduling одной реплики. Значения выше являются capacity baseline, а не обещанным SLA для любой машины. Изменение `WS_MAX_CONCURRENT_WRITES`, размеров очередей, batch size или multi-core topology требует повторить тот же тест и failure suite.
