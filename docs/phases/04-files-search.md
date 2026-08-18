# Фаза 4. Файлы и поиск

## Цель

Добавить безопасный обмен файлами и поиск по сообщениям/извлечённому содержимому без обязательных Elasticsearch, Kafka или отдельной файловой платформы. Развёртывание должно работать с MinIO локально и с основными S3-совместимыми провайдерами в production.

## В scope

- абстракция local/S3-compatible object storage;
- AWS S3, Yandex Object Storage, Selectel и MinIO через единый драйвер;
- direct upload/download по presigned URLs;
- multipart upload для больших файлов;
- метаданные, checksum, quotas и безопасные имена;
- фоновые jobs через Postgres-backed очередь;
- preview изображений и базовое извлечение текста из PDF/DOCX/TXT;
- Postgres FTS для русского и английского;
- поиск по сообщениям и файлам с фильтрами и обязательной проверкой membership;
- UI загрузки, вложений, preview и результатов поиска;
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
- Получатель открывает вложение по временной ссылке, не получая прямых credentials хранилища.
- После смены S3 endpoint старые записи продолжают открываться, потому что БД хранит object key, а не URL.
- Пользователь ищет фразу по сообщениям и тексту документов с фильтрами по chat, автору, дате и типу.
- Пользователь без доступа к private chat не видит ни результат, ни snippet, ни факт существования файла.

## Технические задачи

### Object storage

- [ ] Определить интерфейс `Put/PresignPut/PresignGet/Head/Delete` без AWS-специфичных типов в доменном слое.
- [ ] Реализовать S3-compatible adapter с `endpoint`, `region`, `bucket`, `prefix`, TLS и `force_path_style`.
- [ ] Реализовать local filesystem adapter для небольших инсталляций с теми же правилами object keys.
- [ ] Генерировать object keys на сервере; не использовать исходное имя файла как путь.
- [ ] Хранить credentials только в secrets/env и никогда не отдавать их клиенту.
- [ ] Настроить ограниченные по TTL presigned URLs и точный Content-Type/size policy.
- [ ] Реализовать multipart initiate/sign parts/complete/abort и сборку брошенных upload sessions.
- [ ] Подготовить provider contract suite для MinIO и выбранного внешнего S3 endpoint.

### Метаданные и безопасность файлов

- [ ] Создать `files`, `file_uploads`, связи message-files и статусы `pending|ready|failed|deleted`.
- [ ] Валидировать лимиты размера, число файлов, MIME по содержимому и запрещённые расширения.
- [ ] Рассчитывать/проверять SHA-256 там, где провайдер позволяет надёжную сверку.
- [ ] Не разрешать прикрепить `file_id`, который загрузил другой actor или который недоступен в текущем chat.
- [ ] Удалять незавершённые и неприкреплённые uploads после TTL.
- [ ] Добавить безопасные `Content-Disposition`, CSP и запрет inline для опасных типов.
- [ ] Оставить расширение для ClamAV как отключаемый processor hook.

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
```

- `files` хранит `storage_driver`, `bucket`, `storage_key`, `name`, `mime`, `size`, `sha256`, `status` и производные metadata.
- Полный provider URL не является частью долгоживущей модели.
- Создание сообщения принимает только `file_ids` со статусом `ready` либо использует явно документированный pending flow.
- Search response содержит ограниченный snippet и ссылки на `chat_id/message_id/thread_root_id`.

## Критерии приёмки

- Один и тот же build работает с MinIO, AWS-compatible virtual-host style и провайдером, требующим custom endpoint/path style.
- Credentials S3 отсутствуют в browser network/logs и сгенерированном frontend bundle.
- Пользователь не может скачать файл по известному ID после потери membership.
- Брошенный multipart upload очищается и не создаёт постоянный orphan object.
- Edit/delete сообщения корректно обновляет или удаляет его поисковое представление.
- Результаты private chat не появляются в count, snippet или timing-visible post-filter для постороннего пользователя.
- Русские и английские тестовые запросы находят ожидаемые формы слов с документированными ограничениями.

## Проверка качества

- Contract tests storage adapter на MinIO и минимум одном реальном S3-compatible провайдере перед релизом.
- Интеграционные тесты presign, multipart, abort, expiry и cleanup.
- Security-тесты path traversal, content sniffing, oversized archive/document и IDOR.
- Тесты idempotency/retry фоновых processors.
- Search relevance fixture для RU/EN и permission matrix.
- Нагрузочные тесты параллельных загрузок и поиска на целевом объёме данных.

## Риски и открытые вопросы

- Selectel/Yandex/AWS отличаются CORS, checksum и addressing; contract suite должна отражать поддерживаемое подмножество.
- До реализации определить максимальный размер обычной и multipart загрузки.
- Выбрать библиотеки безопасного извлечения PDF/DOCX и модель изоляции processor.
- Решить retention удалённых файлов и момент физического удаления object.
- Уточнить, нужен ли semantic search пользователю напрямую или только агентам.

## Definition of Done

- MinIO работает из Compose, внешний S3 подключается только конфигурацией.
- Upload/download/search сценарии доступны через web и покрыты E2E.
- Permissions проверяются до выдачи metadata, URL и search snippets.
- Фоновые jobs наблюдаемы, повторяемы и не блокируют API-процесс.
- Документация содержит таблицу проверенных S3-провайдеров и особенности настройки.
