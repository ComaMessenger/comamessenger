# Фаза 8. Публичный релиз v1.0

## Цель

Опубликовать устойчивый open-source продукт с понятным позиционированием, проверяемой установкой, прозрачной лицензией и маршрутом для пользователей и контрибьюторов. Релиз считается завершённым не после объявления, а после успешных внешних установок и обработки первой обратной связи.

## В scope

- финальное название, бренд и проверка домена/trademark рисков;
- лицензии ядра, SDK, клиентов и third-party notices;
- публичный GitHub repository, release artifacts и container images;
- документация установки, обновления, backup, API и агентов;
- landing page, screenshots, короткое demo и demo instance;
- CONTRIBUTING, Code of Conduct, issue/PR templates и roadmap;
- vulnerability disclosure и supported versions;
- миграционные guides из Mattermost/Slack/Pachca только для реально поддержанных данных;
- анонсы в выбранных сообществах;
- release monitoring, triage и patch-release процесс.

## Вне scope

- платный managed hosting;
- enterprise sales/SLA и закрытые enterprise-функции;
- обещание feature parity с Mattermost или Pachca;
- маркетплейс агентов;
- массовая миграция неподдерживаемых форматов;
- публикация непроверенных сравнительных заявлений.

## Пользовательские сценарии

- Незнакомый администратор понимает назначение продукта и запускает его по quickstart.
- Команда до установки видит поддерживаемые функции, ограничения и hardware requirements.
- Разработчик находит архитектуру, локальный setup, contribution workflow и API examples.
- Security researcher понимает, куда приватно сообщить об уязвимости.
- Пользователь обновляется с v1.0.0 на patch release по документированной процедуре.
- Автор внешнего агента запускает SDK example против собственного instance.

## Технические задачи

### Лицензирование и governance

- [x] Утвердить лицензию ядра и совместимые лицензии SDK/клиентов (ADR-0002).
- [ ] Добавить LICENSE, NOTICE/third-party attribution и SPDX metadata.
- [ ] Описать governance, maintainers, decision process и release cadence.
- [ ] Опубликовать Code of Conduct и CONTRIBUTING.
- [ ] Указать границы trademark/branding для форков.

### Release artifacts

- [ ] Создать signed Git tag и immutable release artifacts.
- [ ] Опубликовать multi-architecture container images с semver и digest references.
- [ ] Приложить Compose bundle, checksums, SBOM, signatures и release notes.
- [ ] Проверить quickstart именно на опубликованных artifacts, а не на локальной ветке.
- [ ] Опубликовать compatibility matrix браузеров, мобильных/desktop клиентов, Postgres и S3 providers.

### Документация

- [ ] Quickstart «до первого сообщения» с ожидаемым временем и troubleshooting.
- [ ] Production install, TLS, external Postgres/S3, backups, upgrades и monitoring.
- [ ] User guide: чаты против каналов, reply против thread, permissions, notifications и search.
- [ ] Admin guide: users, agents, limits, retention, audit и security.
- [ ] Developer guide: architecture, ADR, local setup, OpenAPI/WS, SDK и agent tutorial.
- [ ] Перечислить честные v1 limitations и «не делаем» без скрытых требований к SaaS.

### Демонстрация и запуск

- [ ] Пересобрать первый экран README: короткая ценность, воспроизводимый quickstart и актуальная GIF/короткое видео реального продукта.
- [ ] Подготовить seed workspace, демонстрирующий chat, read-only channel, thread, search, files и агента.
- [ ] Записать короткий reproducible demo без недоступных функций.
- [ ] Подготовить screenshots light/dark и mobile/desktop с обезличенными данными.
- [ ] Развернуть ограниченный demo instance с reset, rate limits и abuse controls.
- [ ] Опубликовать landing page с одной основной ценностью и прямой ссылкой на self-host quickstart.

### Сообщество и поддержка релиза

- [ ] Настроить issue forms для bug, feature, security redirect и installation help.
- [ ] Создать public roadmap и метки good first issue/help wanted.
- [ ] Вести сообщество проекта в собственной Coma-инсталляции как dogfooding, сохраняя доступный резервный канал для инцидентов.
- [ ] Подготовить каналы обратной связи и triage rotation на первые недели.
- [ ] Подготовить 90-дневный launch calendar и последовательно анонсировать релиз на GitHub, Habr, HN/Product Hunt и профильных self-hosted сообществах только после готовности support capacity.
- [ ] Собирать opt-in installation/version metrics либо использовать privacy-preserving ручную обратную связь.

## Контракты и данные

- Semantic Versioning применяется к серверу, API и release bundle; совместимость клиентов документируется отдельно.
- Breaking API changes запрещены в `/api/v1` без заранее объявленного migration path.
- Published image digest и checksum являются источником проверки artifact integrity.
- Demo instance не содержит production secrets и регулярно сбрасывает пользовательские данные.
- Telemetry отсутствует по умолчанию либо включается только явно и документированно.

## Критерии приёмки

- Минимум два внешних человека, не участвовавших в разработке, проходят quickstart без устных подсказок.
- Опубликованные images и Compose поднимаются на поддерживаемой чистой системе.
- Все ссылки документации, examples и команды проходят автоматическую или release-check проверку.
- Репозиторий содержит license, security policy, contribution guide и supported versions.
- Demo показывает только реально доступные в release функции.
- На момент объявления нет открытых critical/P0 и известных невыполненных migration/backup blockers.

## Проверка качества

- Release candidate freeze и полный regression suite.
- Fresh install/upgrade/restore из опубликованного candidate artifact.
- Link checker, docs code snippets tests и SDK example smoke tests.
- Проверка security headers/rate limits/demo reset.
- Ручной review marketing claims против фактической feature matrix.
- После релиза — ежедневный triage первой недели и заранее готовая patch procedure.

## Риски и открытые вопросы

- Финальное позиционирование должно отличать продукт без обещания полного клона Pachca/Mattermost.
- Смешанная лицензия требует аккуратной маркировки новых каталогов и проверки при переносе кода через лицензионную границу.
- Публичный demo требует отдельной abuse/threat модели и операционного владельца.
- Нужно заранее определить, какие миграции из других мессенджеров реально поддерживаются в v1.
- Каналы анонса выбираются по готовности сопровождения, а не только охвату.

## Definition of Done

- v1.0 tag, images, Compose, SBOM, signatures и документация опубликованы и взаимно согласованы.
- Независимый quickstart пройден успешно.
- Support/triage/security процессы активны.
- Public roadmap отражает фактическое состояние после релиза.
- Первые внешние установки подтверждены, критические проблемы либо закрыты patch release, либо имеют публичный workaround.
