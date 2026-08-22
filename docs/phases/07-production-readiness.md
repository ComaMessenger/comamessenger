# Фаза 7. Production readiness

## Цель

Сделать self-hosted установку предсказуемой, обновляемой, наблюдаемой и восстанавливаемой. В конце фазы пилотная команда может развернуть систему через Docker Compose, подключить внешний Postgres/S3, настроить HTTPS и выполнить проверенное резервное восстановление.

## В scope

- production Docker images и versioned Compose bundle;
- reverse proxy/TLS reference configuration;
- встроенный local storage volume, внешние Postgres и S3-compatible services;
- миграции, rolling-compatible upgrade policy и rollback procedure;
- backup/restore Postgres и object storage metadata/process;
- Prometheus metrics, structured logs и optional OpenTelemetry;
- health/readiness, resource limits и graceful shutdown;
- security hardening, dependency/image scanning и SBOM;
- rate limits, headers/CSP, audit и secret handling review;
- retention/cleanup jobs;
- нагрузочные, soak и failure tests;
- Tauri desktop wrapper;
- пилоты у 2–3 команд и исправление release blockers.

## Вне scope

- Helm chart и Kubernetes operator;
- unattended auto-update/Watchtower по умолчанию и self-update бинарника с повышенными правами;
- active-active multi-region;
- федерация и multi-tenant SaaS control plane;
- enterprise SSO/SCIM/DLP, если не будет отдельного решения;
- гарантированный zero-downtime для любых breaking migration;
- публичный marketplace.

## Пользовательские сценарии

- Администратор заполняет `.env`, запускает versioned Compose и проходит web bootstrap.
- Администратор подключает AWS/Selectel/Yandex S3 или MinIO без изменения приложения.
- Перед обновлением администратор видит release notes, совместимость и шаги backup.
- После потери сервера организация восстанавливает Postgres и файлы по проверенной инструкции.
- Оператор видит деградацию WS, очередей, S3 или LLM provider в метриках и логах.
- Desktop-пользователь устанавливает лёгкий клиент, получает notifications/tray/badge и обновления согласованным способом.

## Технические задачи

### Packaging и deployment

- [ ] Создать минимальные multi-stage images с non-root user и pinned base digests/versions.
- [ ] Публиковать GHCR images с immutable semver/digest references; плавающий tag не использовать как единственную production-инструкцию.
- [ ] Подготовить `compose.yaml`, `.env.example`, default local file volume и profiles для external/bundled S3-compatible storage, Postgres, Redis и agent runtime.
- [x] Добавить неразрушающий генератор `.env`: независимые installation secrets, mode `0600`, автоматический скрытый runtime worker, идемпотентное создание и ротация его ключа без показа в UI.
- [ ] Добавить Caddy reference config с HTTPS, WebSocket timeouts и upload limits.
- [ ] Не публиковать admin services и Postgres/MinIO наружу по умолчанию.
- [ ] Добавить startup validation обязательных секретов, public URLs и storage connectivity.
- [ ] Зафиксировать persistent volumes и ownership/permissions.

### Обновления и миграции

- [ ] Ввести version metadata build/commit/schema и endpoint диагностики для admin.
- [ ] Проверять совместимость app/schema до принятия трафика.
- [ ] Разделять expand/migrate/contract для несовместимых больших изменений.
- [ ] Документировать поддерживаемые пути обновления и emergency rollback.
- [ ] Документировать ручной `docker compose pull && docker compose up -d` с обязательным backup gate и release notes; автоматическое обновление остаётся осознанным выбором администратора.
- [ ] Запретить автоматическое разрушительное downgrade схемы.
- [ ] Проверять upgrade на копии production-like dataset.
- [ ] Добавить отключаемую проверку доступной версии без отправки стабильного instance ID; installation telemetry проектировать отдельно и только opt-in.

### Backup и retention

- [ ] Создать документированные команды backup/restore Postgres.
- [ ] Описать согласованность БД и object storage, orphan/missing object reconciliation.
- [ ] Автоматизировать проверку backup integrity и периодический restore drill.
- [ ] Реализовать retention для event log, audit, agent runs, revisions, uploads и deleted files.
- [ ] Метрики cleanup jobs и безопасные batch limits.

### Наблюдаемость

- [ ] Метрики HTTP/WS, connection count, message/event latency, reconnect, queue depth, job failures, S3 и LLM calls.
- [ ] Структурные логи с request/actor/run correlation IDs и redaction PII/secrets.
- [ ] Optional OpenTelemetry traces без обязательного внешнего collector.
- [ ] Составить dashboard и alert recommendations с понятными thresholds.
- [ ] Различить liveness/readiness/dependency degradation; краткий сбой LLM не должен выключать мессенджер.

### Security и supply chain

- [ ] Провести threat modeling и security review auth, WS, files, agents и deployment defaults.
- [ ] Добавить `govulncheck`, JS dependency audit, secret scan и container scan в CI.
- [ ] Генерировать SBOM и provenance/signatures для release artifacts.
- [ ] Проверить CSP, CORS, CSRF, SSRF через link preview/S3 endpoints, rate limits и secure headers.
- [ ] Ограничить network egress agent runtime/document processors где возможно.
- [ ] Подготовить `SECURITY.md`, disclosure process и supported versions policy.

### Надёжность и масштабирование

- [ ] Повторить целевой load test на release-like deployment.
- [ ] Провести soak test 24–72 часа с reconnect, messages, uploads и jobs.
- [ ] Проверить restart core/Postgres/S3/runtime и восстановление клиентов.
- [ ] Проверить Redis Pub/Sub fan-out на нескольких Core, bounded batch replay, coalescing и PostgreSQL polling fallback; только после этого объявлять multi-core поддерживаемым.
- [ ] Документировать capacity guide для CPU/RAM/Postgres connections/storage.

### Desktop и пилоты

- [ ] Упаковать web в Tauri с deep links, tray, badge и native notifications.
- [ ] Настроить signed internal builds и безопасный update channel либо документированный manual update.
- [ ] Подготовить pilot checklist, feedback channel и severity definitions.
- [ ] Провести пилоты 2–3 команд, исправить P0/P1 и задокументировать известные ограничения.

## Контракты и данные

- Release bundle содержит versioned Compose, env reference, migration compatibility и checksums.
- Admin diagnostics не раскрывает secrets и чувствительные provider URLs/credentials.
- Backup contract включает базу, object storage и master encryption key; потеря ключа явно обозначается как невосстановимая.
- Retention policies имеют dry-run/metrics и консервативные defaults.
- Multi-replica считается поддерживаемым только после теста fan-out/resume; иначе документация фиксирует single-core topology.
- Redis не входит в backup: после его полной потери durable state восстанавливается из PostgreSQL, а ephemeral state создаётся заново.

## Критерии приёмки

- Чистая production-like VM разворачивает систему по документации без изменения исходников.
- Установка работает без S3 на local volume, а optional S3 profile — с MinIO и минимум одним внешним S3-compatible provider.
- Backup восстанавливается в отдельное окружение, пользователи входят и открывают выборочные сообщения/файлы.
- Обновление с предыдущей release candidate версии сохраняет данные и имеет проверенную процедуру отката приложения.
- Перезапуск core не создаёт дубли сообщений и клиенты восстанавливаются через resume/full resync.
- Security scanners не содержат необработанных critical/high release blockers.
- Пилотные команды не имеют открытых P0/P1 проблем перед фазой публичного релиза.

## Проверка качества

- Fresh install, upgrade и restore E2E на чистой VM/CI environment.
- Load, soak, chaos/failure injection для core/Postgres/S3/Redis/runtime.
- Security review и проверка безопасных deployment defaults.
- Проверка SBOM, signatures, image architectures и non-root execution.
- Desktop smoke tests на Windows/macOS/Linux в поддерживаемой матрице.
- Pilot acceptance checklist и сбор anonymized/opt-in telemetry либо ручных метрик.

## Риски и открытые вопросы

- Определить RPO/RTO reference targets без обещаний enterprise SLA.
- Выбрать registry, signing и desktop update distribution.
- Уточнить минимальные hardware requirements на результатах нагрузочных тестов.
- Согласовать, какие данные считаются PII и как они редактируются в diagnostic bundles.

## Definition of Done

- Install, upgrade, backup и restore проверены не только документом, но и выполненным rehearsal.
- Release images воспроизводимы, просканированы и сопровождаются SBOM/checksums.
- Метрики и runbooks позволяют диагностировать основные виды отказов.
- Security review закрыт либо оставшиеся риски явно приняты и опубликованы.
- Пилоты подтвердили готовность к публичной beta/v1.
