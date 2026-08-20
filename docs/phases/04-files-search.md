# Фаза 4. Файлы и поиск

## Цель

Добавить безопасный обмен файлами, аватары и поиск по сообщениям/извлечённому содержимому без обязательных Elasticsearch, Kafka, S3 или отдельной файловой платформы. Небольшая self-hosted инсталляция получает встроенное local filesystem хранилище на persistent volume; внешний S3-compatible backend подключается конфигурацией без изменения API.

## В scope

- единый `storage.BlobStore` с local filesystem backend по умолчанию и S3-compatible backend;
- настраиваемая логическая квота встроенного хранилища (по умолчанию 2 GiB) и защита от заполнения диска;
- AWS S3, Yandex Object Storage, Selectel и MinIO через единый драйвер;
- direct upload/download по presigned URLs;
- multipart upload для больших файлов;
- метаданные, checksum, quotas и безопасные имена;
- фоновые jobs через Postgres-backed очередь;
- preview изображений и базовое извлечение текста из PDF/DOCX/TXT;
- Postgres FTS для русского и английского;
- поиск по сообщениям и файлам с фильтрами и обязательной проверкой membership;
- UI загрузки, вложений, preview и результатов поиска;
- аватары пользователей поверх того же `BlobStore`, с инициалами как fallback;
- схема pgvector и pipeline embeddings, но не обязательная генерация до агентской фазы.

## Вне scope

- совместное редактирование документов;
- OCR изображений, транскодирование видео и антивирус по умолчанию;
- публичные постоянные URL и анонимный доступ;
- cross-organization search;
- отдельный Elasticsearch/OpenSearch;
- полноценный RAG UX — он относится к фазе 5.

## Пользовательские сценарии

- Пользователь прикладывает файл, видит прогресс, отменяет или повторяет неудачную загрузку.
- Владелец небольшой инсталляции ничего не подключает: файлы сохраняются в выделенный volume на VPS в пределах настроенной квоты.
- Пользователь загружает PNG/JPEG/WebP-аватар, который виден только авторизованным участникам его пространства.
- Получатель открывает вложение по временной ссылке, не получая прямых credentials хранилища.
- После смены S3 endpoint старые записи продолжают открываться, потому что БД хранит object key, а не URL.
- Пользователь ищет фразу по сообщениям и тексту документов с фильтрами по chat, автору, дате и типу.
- Пользователь без доступа к private chat не видит ни результат, ни snippet, ни факт существования файла.

## Технические задачи

### Object storage

- [ ] Определить `storage.BlobStore` без AWS-специфичных типов; capability API различает streaming local upload и presigned/multipart S3 flow.
- [ ] Реализовать `LocalBlobStore` в выделенном каталоге (по умолчанию `/var/lib/coma/files`) на persistent volume; handler не знает физический backend.
- [ ] Для local backend писать во временный файл, проверять размер/checksum, делать `fsync` и атомарный `rename`; каталоги `0700`, blobs `0600`.
- [ ] Генерировать непрозрачные object keys на сервере и раскладывать их по shard-каталогам; пользовательское имя никогда не становится путём.
- [ ] Добавить `LOCAL_STORAGE_QUOTA_BYTES` (default 2 GiB), атомарное резервирование `used + reserved + incoming <= quota` и configurable minimum-free-space guard через `statfs`.
- [ ] При исчерпании квоты/диска отвечать `507 storage_full`, не нарушая сообщения, чтение и остальные функции Core.
- [ ] Реализовать S3-compatible adapter с `endpoint`, `region`, `bucket`, `prefix`, TLS и `force_path_style`.
- [ ] Хранить credentials только в secrets/env и никогда не отдавать их клиенту.
- [ ] Настроить ограниченные по TTL presigned URLs и точный Content-Type/size policy.
- [ ] Реализовать multipart initiate/sign parts/complete/abort и сборку брошенных upload sessions.
- [ ] Подготовить общий contract suite для LocalBlobStore, MinIO и выбранного внешнего S3 endpoint.
- [ ] Зафиксировать deployment invariant: local backend поддерживает один Core instance; multi-Core требует S3 или явно поддерживаемое shared storage.
- [ ] Сделать S3-compatible контейнер отдельным optional Compose profile, а не обязательной зависимостью default install.

### Метаданные и безопасность файлов

- [ ] Создать `files`, `file_uploads`, связи message-files и статусы `pending|ready|failed|deleted`.
- [ ] Хранить `storage_driver`, object key, размер, SHA-256 и MIME в БД; байты local backend не хранить в PostgreSQL.
- [ ] Атомарно учитывать `storage_used_bytes`/`storage_reserved_bytes`, освобождать reservation при abort/TTL и физическом удалении.
- [ ] Валидировать лимиты размера, число файлов, MIME по содержимому и запрещённые расширения.
- [ ] Рассчитывать/проверять SHA-256 там, где провайдер позволяет надёжную сверку.
- [ ] Не разрешать прикрепить `file_id`, который загрузил другой actor или который недоступен в текущем chat.
- [ ] Удалять незавершённые и неприкреплённые uploads после TTL.
- [ ] Добавить безопасные `Content-Disposition`, CSP и запрет inline для опасных типов.
- [ ] Оставить расширение для ClamAV как отключаемый processor hook.
- [ ] Добавить reconciliation job: orphan blobs, metadata без blob, зависшие reservations и расхождение фактического размера.

### Аватары

- [ ] `PUT/DELETE /me/avatar`; owner или admin с `members.manage` может заменить/удалить аватар участника.
- [ ] Разрешить только PNG/JPEG/WebP, сверять MIME по сигнатуре, ограничить исходник 512 KiB и запретить SVG.
- [ ] Хранить аватар как blob общего storage pipeline, а в actor — ссылку на file/blob metadata и `avatar_version`.
- [ ] `GET /actors/:id/avatar` требует Bearer auth и same-organization visibility; чужой и отсутствующий actor дают одинаковый 404.
- [ ] Web загружает blob через `MessengerAPI`, создаёт object URL в `apps/web`, инвалидирует его по `avatar_version` и отзывает при logout; `packages/core` не вызывает DOM API.

### Processing jobs

- [ ] Подключить River и транзакционно ставить jobs после перехода файла в `ready`.
- [ ] Реализовать idempotent processors для image preview и text extraction.
- [ ] Ограничить CPU, память, время и размер распакованного содержимого внешних файлов.
- [ ] Изолировать обработку потенциально опасных форматов и не выполнять макросы/embedded code.
- [ ] Хранить extracted text отдельно либо в `files.extracted_text` с версией extractor.
- [ ] Повторять transient failures с backoff, а permanent failure отображать без потери исходного файла.

### Поиск

- [ ] Создать search vectors для body сообщений и extracted text файлов.
- [ ] Выбрать стратегию RU/EN: несколько конфигураций или комбинированный индекс с `simple` fallback.
- [ ] Обновлять индекс при create/edit/delete сообщения и завершении extraction job.
- [ ] Реализовать cursor pagination и стабильное ранжирование.
- [ ] Применять membership/visibility в самом SQL query до limit, а не фильтровать результаты после выборки.
- [ ] Добавить фильтры `chat`, `author`, `from`, `to`, `type`, `in_thread`.
- [ ] Создать таблицу embeddings и интерфейс записи в неё для фазы 5 без обязательного внешнего API.

### Web UI

- [ ] Добавить drag-and-drop, file picker, progress, cancel/retry и preview before send.
- [ ] Отображать файл только после безопасного завершения upload handshake.
- [ ] Реализовать image preview, download и понятные состояния processing/failed.
- [ ] Добавить экран поиска с query syntax, фильтрами, snippets и переходом к сообщению.
- [ ] Корректно обрабатывать истёкший presigned URL повторным запросом, а не вечным broken link.

## Контракты и данные

Основные endpoints:

```text
POST   /api/v1/files/uploads
POST   /api/v1/files/uploads/:id/parts
POST   /api/v1/files/uploads/:id/complete
DELETE /api/v1/files/uploads/:id
GET    /api/v1/files/:id
GET    /api/v1/files/:id/download
GET    /api/v1/search
GET    /api/v1/actors/:id/avatar
PUT    /api/v1/me/avatar
DELETE /api/v1/me/avatar
```

- `files` хранит `storage_driver`, `bucket`, `storage_key`, `name`, `mime`, `size`, `sha256`, `status` и производные metadata.
- `organizations` или отдельный usage ledger хранит атомарные used/reserved counters и effective quota; квота не требует предварительно выделять файл на диске.
- Полный provider URL не является частью долгоживущей модели.
- Создание сообщения принимает только `file_ids` со статусом `ready` либо использует явно документированный pending flow.
- Search response содержит ограниченный snippet и ссылки на `chat_id/message_id/thread_root_id`.

## Критерии приёмки

- Чистая default Compose-инсталляция без S3 принимает файлы в persistent volume и не превышает quota 2 GiB.
- Один и тот же build переключается между local, MinIO, AWS-compatible virtual-host style и custom endpoint/path style конфигурацией.
- При свободном месте ниже safety threshold новая загрузка получает 507, а существующие сообщения и файлы продолжают читаться.
- Credentials S3 отсутствуют в browser network/logs и сгенерированном frontend bundle.
- Пользователь не может скачать файл по известному ID после потери membership.
- Брошенный multipart upload очищается и не создаёт постоянный orphan object.
- Edit/delete сообщения корректно обновляет или удаляет его поисковое представление.
- Результаты private chat не появляются в count, snippet или timing-visible post-filter для постороннего пользователя.
- Русские и английские тестовые запросы находят ожидаемые формы слов с документированными ограничениями.
- Аватар обновляется во всех видимых местах по `avatar_version`; SVG и MIME spoofing отклоняются, чужая организация получает 404.

## Проверка качества

- Contract tests storage adapter на local filesystem, MinIO и минимум одном реальном S3-compatible провайдере перед релизом.
- Интеграционные тесты presign, multipart, abort, expiry и cleanup.
- Security-тесты path traversal, content sniffing, oversized archive/document и IDOR.
- Тесты idempotency/retry фоновых processors.
- Search relevance fixture для RU/EN и permission matrix.
- Нагрузочные тесты параллельных загрузок и поиска на целевом объёме данных.
- Тесты конкурентного резервирования quota, disk-full, restart между temp-write/rename и reconciliation.

## Риски и открытые вопросы

- Local volume входит в backup вместе с PostgreSQL; runbook определяет согласованный snapshot, restore и reconciliation после восстановления.
- Selectel/Yandex/AWS отличаются CORS, checksum и addressing; contract suite должна отражать поддерживаемое подмножество.
- До реализации определить максимальный размер обычной и multipart загрузки.
- Выбрать библиотеки безопасного извлечения PDF/DOCX и модель изоляции processor.
- Решить retention удалённых файлов и момент физического удаления object.
- Уточнить, нужен ли semantic search пользователю напрямую или только агентам.

## Definition of Done

- Default Compose работает на local persistent volume с configurable quota; отдельный S3-сервис не обязателен.
- Optional S3-compatible Compose profile и внешний S3 подключаются конфигурацией того же `BlobStore`.
- Upload/download/search сценарии доступны через web и покрыты E2E.
- Аватары реализованы поверх общего storage pipeline, а не отдельной таблицы bytea.
- Permissions проверяются до выдачи metadata, URL и search snippets.
- Фоновые jobs наблюдаемы, повторяемы и не блокируют API-процесс.
- Документация содержит таблицу проверенных S3-провайдеров и особенности настройки.
